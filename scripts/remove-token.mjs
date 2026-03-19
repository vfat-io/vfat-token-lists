import fs from 'node:fs/promises';
import path from 'node:path';

const LOGO_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      continue;
    }

    const arg = raw.slice(2);
    const eqIndex = arg.indexOf('=');
    if (eqIndex !== -1) {
      const key = arg.slice(0, eqIndex);
      const value = arg.slice(eqIndex + 1);
      out[key] = value === '' ? true : value;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[arg] = true;
      continue;
    }

    out[arg] = next;
    i += 1;
  }
  return out;
}

function printUsage() {
  console.log('Usage: node scripts/remove-token.mjs --remove-address 0x... [options]');
  console.log('');
  console.log('Options:');
  console.log('  --remove-address 0x...');
  console.log('  --chain-id 1');
  console.log('  --token-lists-dir tokenLists');
  console.log('  --logos-dir logos');
  console.log('  --dry-run');
}

function normalizeChainId(value) {
  const num = Number.parseInt(String(value), 10);
  return Number.isFinite(num) ? num : null;
}

function normalizeAddress(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJsonFile(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
}

async function listChainIds(tokenListsDir) {
  const entries = await fs.readdir(tokenListsDir, { withFileTypes: true });
  const chainIds = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const chainId = normalizeChainId(path.basename(entry.name, '.json'));
    if (chainId) {
      chainIds.push(chainId);
    }
  }

  return chainIds.sort((a, b) => a - b);
}

async function removeTokenLogos(logosDir, chainId, address, dryRun) {
  let removed = 0;

  for (const extension of LOGO_EXTENSIONS) {
    const logoPath = path.join(logosDir, String(chainId), `${address}.${extension}`);
    try {
      await fs.access(logoPath);
    } catch (error) {
      continue;
    }

    if (!dryRun) {
      await fs.unlink(logoPath);
    }
    removed += 1;
  }

  return removed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const removeAddress = args['remove-address'];
  if (typeof removeAddress !== 'string') {
    printUsage();
    throw new Error('--remove-address is required');
  }

  const address = normalizeAddress(removeAddress);
  if (!address || !/^0x[0-9a-f]{40}$/.test(address)) {
    throw new Error(`invalid --remove-address: ${removeAddress}`);
  }

  const tokenListsDir = args['token-lists-dir'] || 'tokenLists';
  const logosDir = args['logos-dir'] || 'logos';
  const dryRun = Boolean(args['dry-run']);
  const chainIdArg = args['chain-id'];
  const chainId = chainIdArg == null ? null : normalizeChainId(chainIdArg);

  if (chainIdArg != null && chainId == null) {
    throw new Error(`invalid --chain-id: ${chainIdArg}`);
  }

  const chainIds = chainId ? [chainId] : await listChainIds(tokenListsDir);
  let removed = 0;
  let touchedChains = 0;
  let logosRemoved = 0;

  for (const currentChainId of chainIds) {
    const tokenListPath = path.join(tokenListsDir, `${currentChainId}.json`);
    let existing = [];
    try {
      existing = await readJsonFile(tokenListPath);
      if (!Array.isArray(existing)) {
        existing = [];
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    const filtered = existing.filter((item) => normalizeAddress(item?.address) !== address);
    const removedHere = existing.length - filtered.length;
    if (removedHere === 0) {
      continue;
    }

    if (!dryRun) {
      await writeJsonFile(tokenListPath, filtered);
    }

    removed += removedHere;
    touchedChains += 1;
    logosRemoved += await removeTokenLogos(logosDir, currentChainId, address, dryRun);
  }

  console.log('Done');
  console.log(`Removed: ${removed}`);
  console.log(`Chains touched: ${touchedChains}`);
  console.log(`Logos removed: ${logosRemoved}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
