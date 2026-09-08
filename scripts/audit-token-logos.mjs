import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const CDN = 'https://imagedelivery.net/tLQGX6fO2lhA7EXY2jvPQQ';
const PREVIEW_SIZE = 128;
const COMPARE_SIZE = 32;
export const SIMILARITY_THRESHOLD = 3;
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function tokenKey(token) {
  return `${token.chainId}:${token.address.toLowerCase()}`;
}

export function normalizeTokens(tokens) {
  if (!Array.isArray(tokens)) throw new Error('Token input must be an array');
  const result = new Map();
  for (const token of tokens) {
    if (!Number.isSafeInteger(token.chainId) || token.chainId <= 0 ||
        !/^0x[0-9a-f]{40}$/i.test(token.address) ||
        typeof token.symbol !== 'string' || !token.symbol ||
        !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) {
      throw new Error('Invalid token: expected chainId, EVM address, symbol and decimals');
    }
    const normalized = {
      chainId: token.chainId,
      address: token.address.toLowerCase(),
      symbol: token.symbol,
      decimals: token.decimals,
      name: typeof token.name === 'string' ? token.name : '',
    };
    const key = tokenKey(normalized);
    const previous = result.get(key);
    if (previous && (previous.symbol !== normalized.symbol || previous.decimals !== normalized.decimals)) {
      throw new Error(`Conflicting metadata for ${key}`);
    }
    result.set(key, normalized);
  }
  return [...result.values()].sort((a, b) => a.chainId - b.chainId || a.address.localeCompare(b.address));
}

export function prepareTokens(input) {
  if (!Array.isArray(input)) throw new Error('Token input must be an array');
  const valid = [];
  const skipped = [];
  for (const token of input) {
    try {
      valid.push(...normalizeTokens([token]));
    } catch (error) {
      skipped.push({ chainId: token?.chainId, address: token?.address, symbol: token?.symbol, error: 'Invalid token metadata' });
    }
  }
  return { tokens: normalizeTokens(valid), skipped };
}

export async function inspectImage(bytes) {
  const metadata = await sharp(bytes).metadata();
  const normalized = await sharp(bytes).resize(PREVIEW_SIZE, PREVIEW_SIZE, {
    fit: 'contain', background: '#00000000',
  }).ensureAlpha().png().toBuffer();
  const rgba = await sharp(normalized).raw().toBuffer();
  const pixels = await sharp(bytes).resize(COMPARE_SIZE, COMPARE_SIZE, {
    fit: 'contain', background: '#ffffff',
  }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
  return {
    pixels,
    preview: `data:image/png;base64,${normalized.toString('base64')}`,
    hash: hash(rgba),
    width: metadata.width,
    height: metadata.height,
  };
}

export function pixelDifference(a, b) {
  if (a.length !== b.length || a.length === 0) throw new Error('Incompatible image pixels');
  return a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;
}

export function groupCandidates(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const group = grouped.get(row.symbol) || { symbol: row.symbol, tokens: [], variants: [] };
    const displayed = row.live?.pixels ? row.live : row.repo;
    if (displayed?.pixels) {
      let variant = group.variants.findIndex((image) => pixelDifference(image.pixels, displayed.pixels) <= SIMILARITY_THRESHOLD);
      if (variant === -1) {
        variant = group.variants.length;
        group.variants.push(displayed);
      }
      row.variant = variant + 1;
    }
    group.tokens.push(row);
    grouped.set(row.symbol, group);
  }
  return [...grouped.values()].map((group) => ({
    symbol: group.symbol,
    chainCount: new Set(group.tokens.map((row) => row.chainId)).size,
    variantCount: group.variants.length,
    tokens: group.tokens,
  })).filter((group) => group.chainCount > 1)
    .sort((a, b) => b.variantCount - a.variantCount || b.tokens.length - a.tokens.length || a.symbol.localeCompare(b.symbol));
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--live', '--help'].includes(arg)) result[arg.slice(2)] = true;
    else if (['--input', '--symbols', '--output', '--chains'].includes(arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      result[arg.slice(2)] = argv[++i];
    } else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  return result;
}

async function readImage(file) {
  try {
    return await inspectImage(await fs.readFile(file));
  } catch (error) {
    return { error: error.code === 'ENOENT' ? 'missing' : 'invalid image' };
  }
}

async function getLiveImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return await inspectImage(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'timeout' : 'fetch or decode failed' };
  } finally {
    clearTimeout(timer);
  }
}

export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+@\-\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function withoutPixels(image) {
  if (!image) return undefined;
  const { pixels, ...rest } = image;
  return rest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm run audit-logos -- --output /tmp/logo-audit [--input tokens.json] [--symbols ETH,WETH,USDC] [--chains chains.json] [--live]');
    return;
  }
  if (!args.output) throw new Error('--output is required');
  if (args.live && typeof fetch !== 'function') throw new Error('--live requires Node 18 or newer');
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const listed = [];
  for (const file of (await fs.readdir(path.join(repoRoot, 'tokenLists'))).sort()) {
    if (/^\d+\.json$/.test(file)) listed.push(...JSON.parse(await fs.readFile(path.join(repoRoot, 'tokenLists', file), 'utf8')));
  }
  const input = args.input ? JSON.parse(await fs.readFile(args.input, 'utf8')) : listed;
  const symbols = args.symbols ? new Set(args.symbols.split(',')) : null;
  const prepared = prepareTokens(input);
  const tokens = prepared.tokens.filter((token) => !symbols || symbols.has(token.symbol));
  const crossChainSymbols = new Map();
  for (const token of tokens) {
    const chains = crossChainSymbols.get(token.symbol) || new Set();
    chains.add(token.chainId);
    crossChainSymbols.set(token.symbol, chains);
  }
  const rows = tokens.filter((token) => crossChainSymbols.get(token.symbol).size > 1);
  const listedKeys = new Set(listed.map(tokenKey));
  const chains = args.chains ? JSON.parse(await fs.readFile(args.chains, 'utf8')) : [];
  const chainNames = new Map(chains.map((chain) => [chain.chainId, chain.name || chain.chainName]));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  let next = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < rows.length) {
      const row = rows[next++];
      const logoPath = `logos/${row.chainId}/${row.address}.png`;
      row.chain = chainNames.get(row.chainId) || String(row.chainId);
      row.listed = listedKeys.has(tokenKey(row));
      row.cdnUrl = `${CDN}/${row.address}-${row.chainId}/public`;
      row.repo = await readImage(path.join(repoRoot, logoPath));
      if (row.repo.hash) {
        // Only committed, unchanged files can be used as reproducible export sources.
        try {
          const committed = execFileSync('git', ['show', `${commit}:${logoPath}`], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] });
          if (hash(committed) === hash(await fs.readFile(path.join(repoRoot, logoPath)))) {
            row.sourceUrl = `https://raw.githubusercontent.com/vfat-io/vfat-token-lists/${commit}/${logoPath}`;
          }
        } catch (error) {
          // The local preview still appears, but cannot be selected as a source.
        }
      }
      if (args.live) {
        row.live = await getLiveImage(row.cdnUrl);
        if (row.repo.pixels && row.live.pixels) {
          row.cdnDifference = pixelDifference(row.repo.pixels, row.live.pixels);
          row.cdnDrift = row.cdnDifference > SIMILARITY_THRESHOLD;
        }
      }
      completed++;
      if (completed % 100 === 0) console.log(`Compared ${completed}/${rows.length} tokens`);
    }
  }));
  const groups = groupCandidates(rows);
  const summary = {
    inputTokens: input.length,
    skippedInvalidTokens: prepared.skipped.length,
    comparedTokens: rows.length,
    groups: groups.length,
    groupsWithVisualDifferences: groups.filter((group) => group.variantCount > 1).length,
    repoMissing: rows.filter((row) => row.repo.error).length,
    liveUnavailable: args.live ? rows.filter((row) => row.live.error).length : null,
    cdnDrift: args.live ? rows.filter((row) => row.cdnDrift).length : null,
  };
  const report = {
    generatedAt: new Date().toISOString(), commit, live: Boolean(args.live),
    similarityThreshold: SIMILARITY_THRESHOLD, summary, skippedTokens: prepared.skipped,
    groups: groups.map((group) => ({ ...group, tokens: group.tokens.map((row) => ({
      ...row, repo: withoutPixels(row.repo), live: withoutPixels(row.live),
    })) })),
  };
  await fs.mkdir(args.output, { recursive: true });
  await fs.writeFile(path.join(args.output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const columns = ['symbol', 'name', 'chain', 'chainId', 'address', 'decimals', 'listed', 'variant', 'cdnDrift', 'cdnDifference', 'sourceUrl', 'cdnUrl'];
  const csv = [columns.map(csvCell).join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\n') + '\n';
  await fs.writeFile(path.join(args.output, 'tokens.csv'), csv);
  const template = await fs.readFile(new URL('./logo-audit.html', import.meta.url), 'utf8');
  const data = JSON.stringify(report).replaceAll('<', '\\u003c');
  await fs.writeFile(path.join(args.output, 'index.html'), template.replace('/* REPORT_DATA */null', () => data));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Open ${path.resolve(args.output, 'index.html')} to compare images and export selected logo alignments.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
