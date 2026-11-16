import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { Chain, Common, Hardfork } from '@ethereumjs/common';
import { EVM } from '@ethereumjs/evm';
import { Address, bytesToHex, hexToBytes } from '@ethereumjs/util';
import solc from 'solc';
import { DEFAULTS, RpcError, checkToken, probeHolder, supportsStateOverride } from '../scripts/check-transfer-safety.mjs';
import { SELECTORS, TRANSFER_TOPIC } from '../scripts/transfer-probe/probe-contract.mjs';

const TOKEN = '0x00000000000000000000000000000000000000aa';
const POOL = '0x00000000000000000000000000000000000000b1';
const WHALES = ['b2', 'b3', 'b4'].map((suffix) => `0x${suffix.padStart(40, '0')}`);
const fixtureSource = await fs.readFile(new URL('./fixtures/transfer-safety/ProbeToken.sol', import.meta.url), 'utf8');

function fixtureBytecode(mode) {
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'ProbeToken.sol': { content: fixtureSource.replace('MODE_VALUE', String(mode)) } },
    settings: {
      evmVersion: 'shanghai',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } },
    },
  })));
  assert.deepEqual(output.errors?.filter((error) => error.severity === 'error') ?? [], []);
  return hexToBytes(`0x${output.contracts['ProbeToken.sol'].ProbeToken.evm.deployedBytecode.object}`);
}

// Discovery is a fixture; eth_call executes the shipped probe and token bytecode in an EVM.
// Each call uses a fresh state, including nested overrides and token storage, just like eth_call.
function fixtureRpc(mode, participants = [POOL]) {
  const tokenCode = fixtureBytecode(mode);
  return async (method, params) => {
    if (method === 'eth_blockNumber') return '0x1000';
    if (method === 'eth_getLogs') {
      return participants.map((holder) => ({
        topics: [TRANSFER_TOPIC, `0x${'0'.repeat(64)}`, `0x${holder.slice(2).padStart(64, '0')}`],
      }));
    }
    assert.equal(method, 'eth_call');
    const [{ to, data }, , overrides = {}] = params;
    const evm = await EVM.create({ common: new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai }) });
    await evm.stateManager.putContractCode(Address.fromString(TOKEN), tokenCode);
    for (const [address, { code }] of Object.entries(overrides)) {
      await evm.stateManager.putContractCode(Address.fromString(address), hexToBytes(code));
    }
    const { execResult } = await evm.runCall({ to: Address.fromString(to), data: hexToBytes(data), gasLimit: 5_000_000n });
    if (execResult.exceptionError) {
      throw new RpcError(`eth_call: execution reverted: ${execResult.exceptionError.error}`, {
        code: 3, data: bytesToHex(execResult.returnValue),
      });
    }
    return bytesToHex(execResult.returnValue);
  };
}

test('compiled probe accepts ordinary ERC20 transfers and approvals with pre-existing recipient funds', async () => {
  const rpc = fixtureRpc(0);
  assert.equal(await supportsStateOverride(rpc), true);
  const result = await probeHolder(rpc, TOKEN, POOL, 1000n, '0x1000');
  assert.equal(result.status, 'safe', result.reason);
});

test('compiled probe rejects an extra debit from the pool while the recipient receives the full amount', async () => {
  const result = await probeHolder(fixtureRpc(1), TOKEN, POOL, 1000n, '0x1000');
  assert.equal(result.status, 'restricted', result.reason);
  assert.match(result.reason, /spent 505.*500/);
});

test('compiled probe rejects an extra sender debit on the transferFrom return leg', async () => {
  const result = await probeHolder(fixtureRpc(2), TOKEN, POOL, 1000n, '0x1000');
  assert.equal(result.status, 'restricted', result.reason);
  assert.match(result.reason, /spent 505.*500/);
});

test('compiled probe checks a taxed pool behind three larger fee-exempt wallets', async () => {
  const result = await checkToken(fixtureRpc(3, [POOL, ...WHALES]), { chainId: 8453, address: TOKEN }, {
    ...DEFAULTS, maxLogChunks: 1,
  });
  assert.equal(result.status, 'restricted', result.reason);
  assert.equal(result.probes.find((probe) => probe.holder === POOL)?.status, 'restricted');
  assert.ok(WHALES.every((holder) => result.probes.find((probe) => probe.holder === holder)?.status === 'safe'));
});

test('legacy two-word probe results cannot produce a safe result without sender debit measurements', async () => {
  const rpc = async (method, [{ data }]) => {
    assert.equal(method, 'eth_call');
    assert.ok(data.startsWith(SELECTORS.probeRoundTrip));
    return `0x${(500n).toString(16).padStart(64, '0').repeat(2)}`;
  };
  assert.equal((await probeHolder(rpc, TOKEN, POOL, 1000n, 'latest')).status, 'inconclusive');
});
