// Simulates a real transfer of every token a change adds to tokenLists/, and fails when the
// token reverts or delivers less than was sent. Tokens like that (daily transfer caps,
// blacklists, fee-on-transfer, sell blocks) break every deposit, exit and swap through their
// pools, so they must not be listed.
//
// The check finds real holders from recent Transfer logs and, with an eth_call code state
// override, runs TransferProbe at each holder's address: move 50% of the holder's balance to a
// fresh address, then pull it back with approve + transferFrom. Nothing is sent on chain.
//
// RPC endpoints come from TRANSFER_PROBE_RPC_URLS (JSON object of chainId -> URL) or
// RPC_URL_<chainId>. A chain without an endpoint, or a token whose result cannot be measured,
// is reported as a warning and does not fail the check.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  OVERRIDE_SUPPORT_PROBE_ADDRESS,
  OVERRIDE_SUPPORT_SPENDER_ADDRESS,
  OVERRIDE_SUPPORT_VIA_ADDRESS,
  PROBE_RECIPIENT,
  PROBE_SPENDER,
  SELECTORS,
  TRANSFER_PROBE_MAGIC,
  TRANSFER_PROBE_RUNTIME_BYTECODE,
  TRANSFER_TOPIC,
} from './transfer-probe/probe-contract.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULTS = {
  probeBps: 5_000,
  toleranceBps: 10,
  logChunkBlocks: 2_000,
  maxLogChunks: 25,
  targetParticipants: 40,
  maxBalanceReads: 60,
  holdersToProbe: 3,
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const EXCLUDED_HOLDERS = new Set([
  ZERO_ADDRESS,
  '0x000000000000000000000000000000000000dead',
  PROBE_RECIPIENT,
  PROBE_SPENDER,
]);

// ---------- token list diff ----------

export function tokenKey(chainId, address) {
  return `${Number(chainId)}:${String(address).trim().toLowerCase()}`;
}

export function addedTokens(baseLists, headLists) {
  const baseKeys = new Set();
  // Some entries omit chainId; the file name (tokenLists/<chainId>.json) is the fallback.
  for (const [fileChainId, tokens] of Object.entries(baseLists)) {
    for (const token of tokens) {
      baseKeys.add(tokenKey(token.chainId ?? fileChainId, token.address));
    }
  }
  const added = new Map();
  for (const [fileChainId, tokens] of Object.entries(headLists)) {
    for (const token of tokens) {
      const chainId = Number(token.chainId ?? fileChainId);
      const key = tokenKey(chainId, token.address);
      if (!baseKeys.has(key) && !added.has(key)) {
        added.set(key, { chainId, address: String(token.address).toLowerCase(), symbol: token.symbol });
      }
    }
  }
  return [...added.values()];
}

async function git(rootDir, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: rootDir, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

async function readListsAtRef(rootDir, ref) {
  const names = (await git(rootDir, ['ls-tree', '--name-only', ref, 'tokenLists/']))
    .split('\n')
    .filter((name) => name.endsWith('.json'));
  const lists = {};
  for (const name of names) {
    const raw = await git(rootDir, ['show', `${ref}:${name}`]);
    lists[path.basename(name, '.json')] = JSON.parse(raw);
  }
  return lists;
}

async function readListsInWorkingTree(rootDir) {
  const dir = path.join(rootDir, 'tokenLists');
  const lists = {};
  for (const name of await fs.readdir(dir)) {
    if (name.endsWith('.json')) {
      lists[path.basename(name, '.json')] = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    }
  }
  return lists;
}

// ---------- JSON-RPC ----------

export class RpcError extends Error {
  constructor(message, { code, data, transport = false } = {}) {
    super(message);
    this.code = code;
    this.data = data;
    this.transport = transport;
  }
}

export function createRpc(url, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  let id = 0;
  return async function rpc(method, params) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RpcError(`${method}: ${error?.message ?? error}`, { transport: true });
    }
    if (!response.ok) {
      throw new RpcError(`${method}: HTTP ${response.status}`, { transport: true });
    }
    const body = await response.json();
    if (body.error) {
      throw new RpcError(`${method}: ${body.error.message ?? 'error'}`, {
        code: body.error.code,
        data: body.error.data,
      });
    }
    return body.result;
  };
}

export function isExecutionRevert(error) {
  if (!(error instanceof RpcError) || error.transport) {
    return false;
  }
  const message = String(error.message).toLowerCase();
  return error.code === 3 || message.includes('reverted') || /vm exception.*revert/.test(message);
}

// ---------- ABI helpers ----------

function word(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function addressWord(address) {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function decodeWords(hex) {
  const body = String(hex ?? '0x').replace(/^0x/, '');
  const words = [];
  for (let i = 0; i + 64 <= body.length; i += 64) {
    words.push(BigInt(`0x${body.slice(i, i + 64)}`));
  }
  return words;
}

function topicAddress(topic) {
  return `0x${String(topic).slice(-40)}`.toLowerCase();
}

// ---------- probe ----------

export async function supportsStateOverride(rpc) {
  try {
    const result = await rpc('eth_call', [
      {
        to: OVERRIDE_SUPPORT_PROBE_ADDRESS,
        data: SELECTORS.magicThrough + addressWord(OVERRIDE_SUPPORT_VIA_ADDRESS) + addressWord(OVERRIDE_SUPPORT_SPENDER_ADDRESS),
      },
      'latest',
      {
        [OVERRIDE_SUPPORT_PROBE_ADDRESS]: { code: TRANSFER_PROBE_RUNTIME_BYTECODE },
        [OVERRIDE_SUPPORT_VIA_ADDRESS]: { code: TRANSFER_PROBE_RUNTIME_BYTECODE },
        [OVERRIDE_SUPPORT_SPENDER_ADDRESS]: { code: TRANSFER_PROBE_RUNTIME_BYTECODE },
      },
    ]);
    return decodeWords(result)[0] === TRANSFER_PROBE_MAGIC;
  } catch {
    return false;
  }
}

async function balanceOf(rpc, token, holder, block) {
  const result = await rpc('eth_call', [{ to: token, data: SELECTORS.balanceOf + addressWord(holder) }, block]);
  const [balance] = decodeWords(result);
  if (balance === undefined) {
    throw new RpcError('balanceOf returned no data');
  }
  return balance;
}

// Recent Transfer participants, newest first, so a token with activity has candidate holders
// without needing an indexer. Pools and routers dominate this set, which is what we want.
export async function recentParticipants(rpc, token, latest, options = DEFAULTS) {
  const seen = new Set();
  let to = latest;
  for (let chunk = 0; chunk < options.maxLogChunks && to >= 0n; chunk += 1) {
    const from = to - BigInt(options.logChunkBlocks) + 1n > 0n ? to - BigInt(options.logChunkBlocks) + 1n : 0n;
    const logs = await rpc('eth_getLogs', [
      { address: token, topics: [TRANSFER_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` },
    ]);
    for (const log of [...logs].reverse()) {
      for (const topic of [log.topics?.[1], log.topics?.[2]]) {
        if (topic) {
          const address = topicAddress(topic);
          if (!EXCLUDED_HOLDERS.has(address) && address !== token) {
            seen.add(address);
          }
        }
      }
    }
    if (seen.size >= options.targetParticipants) {
      break;
    }
    to = from - 1n;
  }
  return [...seen].slice(0, options.maxBalanceReads);
}

export function classifyRoundTrip(amount, received, returned, toleranceBps) {
  const minReceived = amount - (amount * BigInt(toleranceBps)) / 10_000n;
  if (received < minReceived) {
    return { status: 'restricted', reason: `recipient received ${received} of ${amount} (fee-on-transfer or rebasing)` };
  }
  const minReturned = received - (received * BigInt(toleranceBps)) / 10_000n;
  if (returned < minReturned) {
    return { status: 'restricted', reason: `transferring back returned ${returned} of ${received} (sell-restricted)` };
  }
  return { status: 'safe', reason: 'full amount moved in both directions' };
}

export async function probeHolder(rpc, token, holder, balance, block, options = DEFAULTS) {
  let amount = (balance * BigInt(options.probeBps)) / 10_000n;
  if (amount === 0n) {
    amount = balance;
  }
  try {
    const result = await rpc('eth_call', [
      {
        to: holder,
        data:
          SELECTORS.probeRoundTrip +
          addressWord(token) +
          addressWord(PROBE_RECIPIENT) +
          addressWord(PROBE_SPENDER) +
          word(amount),
      },
      block,
      {
        [holder]: { code: TRANSFER_PROBE_RUNTIME_BYTECODE },
        [PROBE_RECIPIENT]: { code: TRANSFER_PROBE_RUNTIME_BYTECODE },
        [PROBE_SPENDER]: { code: TRANSFER_PROBE_RUNTIME_BYTECODE },
      },
    ]);
    const [received, returned] = decodeWords(result);
    if (received === undefined || returned === undefined) {
      return { status: 'inconclusive', reason: 'probe returned no data', holder, amount };
    }
    return { ...classifyRoundTrip(amount, received, returned, options.toleranceBps), holder, amount };
  } catch (error) {
    if (isExecutionRevert(error)) {
      const data = typeof error.data === 'string' ? ` (${error.data.slice(0, 74)})` : '';
      return { status: 'restricted', reason: `transfer reverted${data}`, holder, amount };
    }
    return { status: 'inconclusive', reason: error?.message ?? String(error), holder, amount };
  }
}

// Probes the largest few recent holders. One restricted result is enough to fail the token:
// a cap or blacklist only needs to hit one realistic transfer to break the pools.
export async function checkToken(rpc, token, options = DEFAULTS) {
  const address = token.address.toLowerCase();
  try {
    const latest = BigInt(await rpc('eth_blockNumber', []));
    const block = `0x${latest.toString(16)}`;
    const participants = await recentParticipants(rpc, address, latest, options);
    const balances = [];
    for (const holder of participants) {
      try {
        const balance = await balanceOf(rpc, address, holder, block);
        if (balance > 0n) {
          balances.push({ holder, balance });
        }
      } catch {
        // A holder whose balance cannot be read is simply not probed.
      }
    }
    balances.sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1));
    const selected = balances.slice(0, options.holdersToProbe);
    if (selected.length === 0) {
      return { status: 'inconclusive', reason: 'no holder with a balance found in recent Transfer logs', probes: [] };
    }
    const probes = [];
    for (const { holder, balance } of selected) {
      probes.push(await probeHolder(rpc, address, holder, balance, block, options));
    }
    const restricted = probes.find((probe) => probe.status === 'restricted');
    if (restricted) {
      return { status: 'restricted', reason: restricted.reason, probes };
    }
    if (probes.some((probe) => probe.status === 'safe')) {
      return { status: 'safe', reason: 'full amount moved in both directions', probes };
    }
    return { status: 'inconclusive', reason: probes[0].reason, probes };
  } catch (error) {
    return { status: 'inconclusive', reason: error?.message ?? String(error), probes: [] };
  }
}

// ---------- CLI ----------

export function rpcUrlsFromEnv(env = process.env) {
  const urls = {};
  if (env.TRANSFER_PROBE_RPC_URLS) {
    try {
      for (const [chainId, url] of Object.entries(JSON.parse(env.TRANSFER_PROBE_RPC_URLS))) {
        if (url) {
          urls[Number(chainId)] = String(url);
        }
      }
    } catch {
      console.log('::warning::TRANSFER_PROBE_RPC_URLS is not valid JSON; ignoring it');
    }
  }
  for (const [name, value] of Object.entries(env)) {
    const match = /^RPC_URL_(\d+)$/.exec(name);
    if (match && value) {
      urls[Number(match[1])] = value;
    }
  }
  return urls;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[arg.slice(2)] = true;
    } else {
      out[arg.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

function printUsage() {
  console.log('Usage: node scripts/check-transfer-safety.mjs --base <git-ref>');
  console.log('       node scripts/check-transfer-safety.mjs --chain-id 8453 --address 0x...');
  console.log('');
  console.log('Checks tokens added to tokenLists/ since <git-ref> (or one token) by simulating a');
  console.log('transfer from real holders. Exits 1 when a token is transfer-restricted.');
  console.log('RPC: TRANSFER_PROBE_RPC_URLS=\'{"8453":"https://..."}\' or RPC_URL_8453=https://...');
}

function isZeroRef(ref) {
  return /^0+$/.test(String(ref));
}

export async function main(argv = process.argv.slice(2), { env = process.env, rootDir, makeRpc = createRpc } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }
  const root = rootDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  let tokens;
  if (args.address) {
    tokens = [{ chainId: Number(args['chain-id']), address: String(args.address).toLowerCase(), symbol: '' }];
  } else if (args.base && typeof args.base === 'string') {
    if (isZeroRef(args.base)) {
      console.log('No base commit (new branch); nothing to compare.');
      return 0;
    }
    tokens = addedTokens(await readListsAtRef(root, args.base), await readListsInWorkingTree(root));
  } else {
    printUsage();
    return 2;
  }

  if (tokens.length === 0) {
    console.log('No tokens added; nothing to check.');
    return 0;
  }

  const urls = rpcUrlsFromEnv(env);
  const rpcs = new Map();
  let failures = 0;
  for (const token of tokens) {
    const label = token.symbol
      ? `${token.symbol} on chain ${token.chainId} (${token.address})`
      : `${token.address} on chain ${token.chainId}`;
    const url = urls[token.chainId];
    if (!url) {
      console.log(`::warning::Transfer safety not checked for ${label}: no RPC configured for chain ${token.chainId}`);
      continue;
    }
    if (!rpcs.has(token.chainId)) {
      const rpc = makeRpc(url);
      rpcs.set(token.chainId, { rpc, overrides: await supportsStateOverride(rpc) });
    }
    const { rpc, overrides } = rpcs.get(token.chainId);
    if (!overrides) {
      console.log(`::warning::Transfer safety not checked for ${label}: the chain ${token.chainId} RPC does not support eth_call state overrides`);
      continue;
    }
    const result = await checkToken(rpc, token);
    for (const probe of result.probes) {
      console.log(`  ${label}: holder ${probe.holder} amount ${probe.amount} -> ${probe.status}: ${probe.reason}`);
    }
    if (result.status === 'restricted') {
      failures += 1;
      console.log(`::error::${label} is transfer-restricted: ${result.reason}. Deposits, exits and swaps through its pools will fail; do not list it.`);
    } else if (result.status === 'inconclusive') {
      console.log(`::warning::Transfer safety inconclusive for ${label}: ${result.reason}`);
    } else {
      console.log(`${label}: transfers work`);
    }
  }
  return failures > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(2);
    },
  );
}
