import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeTags } from './token-tags.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/update-token-tags.mjs --input updates.json [--token-lists-dir tokenLists] [--dry-run]');
    return;
  }
  if (!args.input) {
    throw new Error('--input is required');
  }
  const input = JSON.parse(await fs.readFile(args.input, 'utf8'));
  const updates = validateUpdates(input);
  const plans = await prepareUpdates(updates, args['token-lists-dir'] || 'tokenLists');
  let changed = 0;
  for (const plan of plans) {
    for (const change of plan.changes) {
      console.log(`${change.chainId}:${change.address} ${change.symbol}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`);
      changed += 1;
    }
    if (!args['dry-run'] && plan.changes.length > 0) {
      await fs.writeFile(plan.filePath, JSON.stringify(plan.tokens, null, 2) + '\n');
    }
  }
  console.log(`${args['dry-run'] ? 'Would update' : 'Updated'}: ${changed} tokens across ${plans.filter(plan => plan.changes.length > 0).length} chains`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '--dry-run') {
      args[flag.slice(2)] = true;
    } else if (flag === '--input' || flag === '--token-lists-dir') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      args[flag.slice(2)] = value;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

function validateUpdates(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('input must be a nonempty array of token tag updates');
  }
  const seen = new Set();
  return input.map((entry, index) => {
    const context = `input[${index}]`;
    if (!entry || !Number.isSafeInteger(entry.chainId) || entry.chainId <= 0) {
      throw new Error(`${context}: chainId must be a positive integer`);
    }
    if (typeof entry.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(entry.address)) {
      throw new Error(`${context}: invalid token address`);
    }
    const address = entry.address.toLowerCase();
    const key = `${entry.chainId}:${address}`;
    if (seen.has(key)) {
      throw new Error(`${context}: duplicate update for ${key}`);
    }
    seen.add(key);
    if (typeof entry.source !== 'string' || !isSourceUrl(entry.source)) {
      throw new Error(`${context}: source must be an http(s) evidence URL`);
    }
    if (entry.expectedSymbol !== undefined && (typeof entry.expectedSymbol !== 'string' || !entry.expectedSymbol)) {
      throw new Error(`${context}: expectedSymbol must be a nonempty string`);
    }
    return { ...entry, address, tags: normalizeTags(entry.tags, `${context}.tags`) };
  });
}

function isSourceUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function prepareUpdates(updates, tokenListsDir) {
  const plans = new Map();
  for (const update of updates) {
    let plan = plans.get(update.chainId);
    if (!plan) {
      const filePath = path.join(tokenListsDir, `${update.chainId}.json`);
      const tokens = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (!Array.isArray(tokens)) {
        throw new Error(`${filePath}: token list must be an array`);
      }
      plan = { filePath, tokens, changes: [] };
      plans.set(update.chainId, plan);
    }
    const matches = plan.tokens.filter(token => token.address?.toLowerCase() === update.address);
    if (matches.length !== 1 || (matches[0].chainId !== undefined && matches[0].chainId !== update.chainId)) {
      throw new Error(`${update.chainId}:${update.address}: expected exactly one existing token on this chain`);
    }
    const token = matches[0];
    if (update.expectedSymbol !== undefined && update.expectedSymbol !== token.symbol) {
      throw new Error(`${update.chainId}:${update.address}: expected symbol ${update.expectedSymbol}, found ${token.symbol}`);
    }
    const before = token.tags === undefined ? [] : token.tags;
    const after = update.tags;
    if (JSON.stringify(before) === JSON.stringify(after) && (after.length > 0 || token.tags === undefined)) {
      continue;
    }
    plan.changes.push({ chainId: update.chainId, address: update.address, symbol: token.symbol, before, after });
    if (after.length > 0) {
      token.tags = after;
    } else {
      delete token.tags;
    }
  }
  return [...plans.values()];
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
