import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  DEFAULTS,
  RpcError,
  addedTokens,
  checkToken,
  classifyRoundTrip,
  main,
  rpcUrlsFromEnv,
  supportsStateOverride,
} from '../scripts/check-transfer-safety.mjs';
import { PROBE_RECIPIENT, SELECTORS, TRANSFER_TOPIC } from '../scripts/transfer-probe/probe-contract.mjs';

const execFileAsync = promisify(execFile);

const TOKEN = '0x00000000000000000000000000000000000000aa';
const POOL = '0x00000000000000000000000000000000000000b1';
const USER = '0x00000000000000000000000000000000000000c2';

function word(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function topic(address) {
  return `0x${address.slice(2).padStart(64, '0')}`;
}

// A fake JSON-RPC node. `roundTrip(holder, amount)` decides what the probe does at each holder:
// return the balance deltas, or throw an RpcError to simulate a revert.
function fakeRpc({ balances, roundTrip, overrides = true, logs, read } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_blockNumber') {
      return '0x1000';
    }
    if (method === 'eth_getLogs') {
      return (
        logs ?? [
          { topics: [TRANSFER_TOPIC, topic(POOL), topic(USER)] },
          { topics: [TRANSFER_TOPIC, topic(USER), topic(POOL)] },
        ]
      );
    }
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      if (data.startsWith(SELECTORS.magicThrough)) {
        if (!overrides) {
          return '0x';
        }
        return `0x${word(0x5afe70be)}`;
      }
      if (data.startsWith(SELECTORS.balanceOf)) {
        const holder = `0x${data.slice(-40)}`;
        return `0x${word(balances?.[holder] ?? 0n)}`;
      }
      if (data.startsWith(SELECTORS.probeRoundTrip)) {
        const amount = BigInt(`0x${data.slice(-64)}`);
        const [received, returned, spent = amount, spentReturning = received] = roundTrip(to, amount);
        return `0x${word(received)}${word(returned)}${word(spent)}${word(spentReturning)}`;
      }
    }
    if (read) {
      return read(method, params);
    }
    throw new Error(`unexpected ${method}`);
  };
  rpc.calls = calls;
  return rpc;
}

test('addedTokens returns only tokens missing from the base lists', () => {
  const base = { 8453: [{ chainId: 8453, address: '0xAA', symbol: 'A' }] };
  const head = {
    8453: [
      { chainId: 8453, address: '0xaa', symbol: 'A' },
      { chainId: 8453, address: '0xBB', symbol: 'B' },
    ],
    1: [{ chainId: 1, address: '0xaa', symbol: 'A' }],
  };
  assert.deepEqual(addedTokens(base, head), [
    { chainId: 1, address: '0xaa', symbol: 'A' },
    { chainId: 8453, address: '0xbb', symbol: 'B' },
  ]);
});

test('addedTokens falls back to the file chain id for entries without one', () => {
  const base = { 146: [{ address: '0xAA', symbol: 'A' }] };
  const head = { 146: [{ address: '0xaa', symbol: 'A' }, { address: '0xbb', symbol: 'B' }] };
  assert.deepEqual(addedTokens(base, head), [{ chainId: 146, address: '0xbb', symbol: 'B' }]);
});

test('classifyRoundTrip flags short deliveries in either direction', () => {
  const classify = (received, returned) => classifyRoundTrip(1000n, {
    received, returned, spent: 1000n, spentReturning: received,
  }, 10).status;
  assert.equal(classify(1000n, 1000n), 'safe');
  assert.equal(classify(999n, 999n), 'safe');
  assert.equal(classify(990n, 990n), 'restricted');
  assert.equal(classify(1000n, 0n), 'restricted');
});

test('sender debits respect the tolerance on each leg with exact integer rounding', () => {
  const classify = (amount, spent, spentReturning) => classifyRoundTrip(amount, {
    received: amount, returned: amount, spent, spentReturning,
  }, 10).status;
  assert.equal(classify(1000n, 1001n, 1001n), 'safe');
  assert.equal(classify(1000n, 1002n, 1000n), 'restricted');
  assert.equal(classify(1000n, 1000n, 1002n), 'restricted');
  assert.equal(classify(5n, 6n, 5n), 'restricted');
  assert.equal(classify(5n, 5n, 6n), 'restricted');
  const large = 2n ** 200n;
  assert.equal(classify(large, large + large / 1000n, large), 'safe');
  assert.equal(classify(large, large + large / 1000n + 1n, large), 'restricted');
});

test('checkToken passes a token that moves the full amount', async () => {
  const rpc = fakeRpc({
    balances: { [POOL]: 1000n, [USER]: 10n },
    roundTrip: (_holder, amount) => [amount, amount],
  });
  const result = await checkToken(rpc, { chainId: 8453, address: TOKEN });
  assert.equal(result.status, 'safe');
  assert.equal(result.probes[0].holder, POOL);
  assert.equal(result.probes[0].amount, 500n);
});

test('checkToken fails when a transfer from any probed holder reverts', async () => {
  // A capped token: small transfers pass, the pool-sized one reverts (VCNT TransferTooLarge).
  const rpc = fakeRpc({
    balances: { [POOL]: 1000n, [USER]: 10n },
    roundTrip: (_holder, amount) => {
      if (amount > 6n) {
        throw new RpcError('eth_call: execution reverted', { code: 3, data: '0x1b97a875' });
      }
      return [amount, amount];
    },
  });
  const result = await checkToken(rpc, { chainId: 8453, address: TOKEN });
  assert.equal(result.status, 'restricted');
  assert.match(result.reason, /0x1b97a875/);
});

test('checkToken fails a fee-on-transfer token', async () => {
  const rpc = fakeRpc({
    balances: { [POOL]: 1000n },
    roundTrip: (_holder, amount) => [(amount * 99n) / 100n, (amount * 98n) / 100n],
  });
  const result = await checkToken(rpc, { chainId: 8453, address: TOKEN });
  assert.equal(result.status, 'restricted');
});

test('checkToken probes a smaller taxed pool even when three larger wallets transfer normally', async () => {
  const whales = ['b2', 'b3', 'b4'].map((suffix) => `0x${suffix.padStart(40, '0')}`);
  const rpc = fakeRpc({
    balances: { [POOL]: 1000n, ...Object.fromEntries(whales.map((holder) => [holder, 10_000n])) },
    logs: [POOL, ...whales].map((holder) => ({ topics: [TRANSFER_TOPIC, topic(USER), topic(holder)] })),
    roundTrip: (holder, amount) => holder === POOL ? [(amount * 99n) / 100n, amount] : [amount, amount],
  });
  const result = await checkToken(rpc, { chainId: 8453, address: TOKEN });
  assert.equal(result.status, 'restricted');
  assert.equal(result.probes.find((probe) => probe.holder === POOL)?.status, 'restricted');
  assert.ok(whales.every((holder) => result.probes.find((probe) => probe.holder === holder)?.status === 'safe'));
});

test('holder probing stays bounded by the existing participant limit', async () => {
  const holders = Array.from({ length: DEFAULTS.maxBalanceReads + 10 }, (_, i) =>
    `0x${(0x1000 + i).toString(16).padStart(40, '0')}`,
  );
  const rpc = fakeRpc({
    balances: Object.fromEntries(holders.map((holder) => [holder, 1000n])),
    logs: holders.map((holder) => ({ topics: [TRANSFER_TOPIC, topic(holder), topic(holder)] })),
    roundTrip: (_holder, amount) => [amount, amount],
  });
  const result = await checkToken(rpc, { chainId: 8453, address: TOKEN });
  assert.equal(result.status, 'safe');
  assert.equal(result.probes.length, DEFAULTS.maxBalanceReads);
});

test('checkToken is inconclusive on transport errors and when no holder is found', async () => {
  const failing = fakeRpc({
    balances: { [POOL]: 1000n },
    roundTrip: () => {
      throw new RpcError('eth_call: HTTP 502', { transport: true });
    },
  });
  assert.equal((await checkToken(failing, { chainId: 8453, address: TOKEN })).status, 'inconclusive');

  const empty = fakeRpc({ logs: [], roundTrip: () => [0n, 0n] });
  assert.equal((await checkToken(empty, { chainId: 8453, address: TOKEN })).status, 'inconclusive');
});

const POLYGON_AAVE = { chainId: 137, address: TOKEN };
const AAVE_POOL = '0x794a61358d6845594f94dc1db02a252b5b4814ad';
const AAVE_INDEX = 1235125837814019991654501472n;

function aaveRpc({ registeredToken = TOKEN, chain = '0x89', recipientScaled = 0n, balances = { [POOL]: 6n }, roundTrip }) {
  return fakeRpc({
    balances,
    roundTrip,
    read(method, params) {
      if (method === 'eth_chainId') {
        return chain;
      }
      assert.equal(method, 'eth_call');
      const [{ to, data }, block] = params;
      assert.equal(block, '0x1000');
      if (to === TOKEN && data === '0xb16a19de') {
        return topic(USER);
      }
      if (to === AAVE_POOL && data === '0xcff027d9' + topic(USER).slice(2)) {
        return topic(registeredToken);
      }
      if (to === AAVE_POOL && data === '0xd15e0053' + topic(USER).slice(2)) {
        return `0x${word(AAVE_INDEX)}`;
      }
      if (to === TOKEN && data === '0x1da24f3e' + topic(POOL).slice(2)) {
        return `0x${word(5)}`;
      }
      if (to === TOKEN && data === '0x1da24f3e' + topic(PROBE_RECIPIENT).slice(2)) {
        return `0x${word(recipientScaled)}`;
      }
      throw new Error(`unexpected eth_call for ${to}: ${data}`);
    },
  });
}

test('verified Polygon aToken must match rounding on all four balance deltas', async () => {
  // This existing recipient balance exercises different scaled amounts on send and return.
  const expected = [4n, 5n, 4n, 5n];
  const run = (deltas) => checkToken(aaveRpc({ recipientScaled: 4n, roundTrip: () => deltas }), POLYGON_AAVE);
  const result = await run(expected);
  assert.equal(result.status, 'safe');
  assert.match(result.probes[0].reason, /Aave scaled-balance rounding/);

  for (let i = 0; i < expected.length; i += 1) {
    const changed = [...expected];
    changed[i] += 1n;
    assert.equal((await run(changed)).status, 'restricted');
  }
});

test('Polygon token cannot claim Aave rounding by exposing the same token methods', async () => {
  const rpc = aaveRpc({ registeredToken: USER, roundTrip: () => [3n, 4n, 4n, 3n] });
  const result = await checkToken(rpc, POLYGON_AAVE);
  assert.equal(result.status, 'restricted');
  assert.match(result.reason, /sender-paid transfer fee/);
});

function revert(data) {
  throw new RpcError('eth_call: execution reverted', { code: 3, data });
}

test('known Polygon Aave collateral errors require another successful sampled holder', async () => {
  const collateralErrors = ['0x6679996d', '0x5b263df7'];
  for (const error of collateralErrors) {
    const rpc = aaveRpc({
      balances: { [POOL]: 6n, [USER]: 4n },
      roundTrip: (holder, amount) => holder === POOL ? revert(error) : [amount, amount],
    });
    const result = await checkToken(rpc, POLYGON_AAVE);
    assert.equal(result.status, 'safe');
    assert.deepEqual(result.probes.map(({ status }) => status), ['collateral-limited', 'safe']);
  }
  const rpc = aaveRpc({ roundTrip: () => revert(collateralErrors[0]) });
  assert.equal((await checkToken(rpc, POLYGON_AAVE)).status, 'restricted');
});

test('collateral reverts retain normal failure for an unverified token, wrong chain or unknown error', async () => {
  const collateralRevert = () => revert('0x6679996d');
  const cases = [
    { registeredToken: USER, roundTrip: collateralRevert },
    { chain: '0x1', roundTrip: collateralRevert },
    { roundTrip: () => revert('0x6679996d00') },
  ];
  for (const options of cases) {
    const result = await checkToken(aaveRpc(options), POLYGON_AAVE);
    assert.equal(result.status, 'restricted');
    assert.equal(result.probes[0].status, 'restricted');
  }
});

test('supportsStateOverride requires the probe magic value', async () => {
  assert.equal(await supportsStateOverride(fakeRpc({ roundTrip: () => [0n, 0n] })), true);
  assert.equal(await supportsStateOverride(fakeRpc({ overrides: false, roundTrip: () => [0n, 0n] })), false);
});

test('rpcUrlsFromEnv merges the JSON map and per-chain variables', () => {
  assert.deepEqual(
    rpcUrlsFromEnv({ TRANSFER_PROBE_RPC_URLS: '{"8453":"https://a","1":""}', RPC_URL_56: 'https://b' }),
    { 8453: 'https://a', 56: 'https://b' },
  );
});

async function gitFixture(baseTokens, headTokens) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vfat-transfer-safety-'));
  const run = (args) => execFileAsync('git', args, { cwd: root });
  await run(['init', '-q']);
  await run(['config', 'user.email', 'test@example.com']);
  await run(['config', 'user.name', 'test']);
  await fs.mkdir(path.join(root, 'tokenLists'));
  const listPath = path.join(root, 'tokenLists', '8453.json');
  await fs.writeFile(listPath, JSON.stringify(baseTokens));
  await run(['add', '.']);
  await run(['commit', '-qm', 'base']);
  await fs.writeFile(listPath, JSON.stringify(headTokens));
  return root;
}

async function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { code: await fn(), output: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

test('main fails when an added token is restricted and ignores tokens already listed', async () => {
  const listed = { chainId: 8453, address: '0x00000000000000000000000000000000000000dd', symbol: 'OLD' };
  const added = { chainId: 8453, address: TOKEN, symbol: 'CAP' };
  const root = await gitFixture([listed], [listed, added]);
  const probed = [];
  const makeRpc = () => {
    const rpc = fakeRpc({
      balances: { [POOL]: 1000n },
      roundTrip: () => {
        throw new RpcError('eth_call: execution reverted', { code: 3, data: '0x1b97a875' });
      },
    });
    return async (method, params) => {
      if (method === 'eth_getLogs') {
        probed.push(params[0].address);
      }
      return rpc(method, params);
    };
  };
  const { code, output } = await captureLog(() =>
    main(['--base', 'HEAD'], { rootDir: root, env: { RPC_URL_8453: 'http://fake' }, makeRpc }),
  );
  assert.equal(code, 1);
  assert.match(output, /::error::CAP on chain 8453/);
  assert.deepEqual([...new Set(probed)], [TOKEN]);
});

test('main warns but passes when no RPC is configured for the chain', async () => {
  const root = await gitFixture([], [{ chainId: 8453, address: TOKEN, symbol: 'NEW' }]);
  const { code, output } = await captureLog(() => main(['--base', 'HEAD'], { rootDir: root, env: {} }));
  assert.equal(code, 0);
  assert.match(output, /::warning::Transfer safety not checked for NEW/);
});
