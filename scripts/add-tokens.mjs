import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import sharp from 'sharp';

dotenv.config({ path: path.join(process.cwd(), '.env') });

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
  console.log('Usage: node scripts/add-tokens.mjs --input tokens.json [options]');
  console.log('');
  console.log('Options:');
  console.log('  --input tokens.json');
  console.log('  --token-lists-dir tokenLists');
  console.log('  --logos-dir logos');
  console.log('  --size 128');
  console.log('  --format png');
  console.log('  --force-logo');
  console.log('  --dry-run');
}

function normalizeChainId(value) {
  const num = Number.parseInt(String(value), 10);
  return Number.isFinite(num) ? num : null;
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJsonFile(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
}

function requestBuffer(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error(`too many redirects for ${url}`));
      return;
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(new Error(`invalid URL: ${url}`));
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      parsed,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'vfat-token-lists/1.0',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).toString();
          requestBuffer(nextUrl, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        if (status !== 200) {
          res.resume();
          reject(new Error(`request failed (${status}) for ${url}`));
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );

    req.on('error', reject);
    req.end();
  });
}

function resolveLocalLogoPath(logoURI, baseDir) {
  if (logoURI.startsWith('http://') || logoURI.startsWith('https://')) {
    return null;
  }

  if (logoURI.startsWith('file://')) {
    return fileURLToPath(logoURI);
  }

  return path.isAbsolute(logoURI) ? logoURI : path.resolve(baseDir, logoURI);
}

async function readLogoBuffer(logoURI, baseDir) {
  const localPath = resolveLocalLogoPath(logoURI, baseDir);
  if (localPath) {
    return { buffer: await fs.readFile(localPath), localPath };
  }
  return { buffer: await requestBuffer(logoURI), localPath: null };
}

async function writeLogo(buffer, targetDir, targetPath, size, format) {
  let pipeline = sharp(buffer, { failOn: 'none' }).resize(size, size, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

  if (format === 'png') {
    pipeline = pipeline.png();
  } else if (format === 'webp') {
    pipeline = pipeline.webp();
  } else {
    pipeline = pipeline.jpeg({ quality: 92 });
  }

  const output = await pipeline.toBuffer();
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(targetPath, output);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const inputPath = args.input;
  if (!inputPath) {
    printUsage();
    throw new Error('--input is required');
  }
  const inputFilePath = path.resolve(inputPath);
  const inputDir = path.dirname(inputFilePath);

  const tokenListsDir = args['token-lists-dir'] || 'tokenLists';
  const logosDir = args['logos-dir'] || 'logos';
  const size = Number.parseInt(args.size || '128', 10);
  const format = String(args.format || 'png').toLowerCase();
  const forceLogo = Boolean(args['force-logo']);
  const dryRun = Boolean(args['dry-run']);

  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`invalid --size: ${args.size}`);
  }
  const allowedFormats = new Set(['png', 'jpg', 'jpeg', 'webp']);
  if (!allowedFormats.has(format)) {
    throw new Error(`invalid --format: ${format}`);
  }

  const input = await readJsonFile(inputFilePath);
  if (!Array.isArray(input)) {
    throw new Error('input JSON must be an array');
  }

  const tokensByChain = new Map();
  const seen = new Set();

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const chainId = normalizeChainId(entry.chainId);
    const address = typeof entry.address === 'string' ? entry.address.toLowerCase() : null;
    const symbol = typeof entry.symbol === 'string' ? entry.symbol : null;
    const logoURI = typeof entry.logoURI === 'string' ? entry.logoURI : null;
    const decimals = Number.isFinite(entry.decimals) ? entry.decimals : null;

    if (!chainId || !address || !symbol || !logoURI || decimals == null) {
      console.warn(`skip invalid token entry: ${JSON.stringify(entry)}`);
      continue;
    }

    const key = `${chainId}:${address}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const list = tokensByChain.get(chainId) || [];
    list.push({ chainId, address, symbol, decimals, logoURI });
    tokensByChain.set(chainId, list);
  }

  let added = 0;
  let logosWritten = 0;
  let logosSkipped = 0;
  let logosFailed = 0;

  for (const [chainId, tokens] of tokensByChain.entries()) {
    const tokenListPath = path.join(tokenListsDir, `${chainId}.json`);
    let existing = [];
    try {
      existing = await readJsonFile(tokenListPath);
      if (!Array.isArray(existing)) {
        existing = [];
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    const existingByAddress = new Map();
    for (const item of existing) {
      if (item && item.address) {
        existingByAddress.set(String(item.address).toLowerCase(), item);
      }
    }

    for (const token of tokens) {
      const existingToken = existingByAddress.get(token.address);
      if (existingToken) {
        console.warn(`token already exists for chain ${chainId}: ${token.address}`);
        continue;
      } else {
        const newToken = {
          chainId: token.chainId,
          address: token.address,
          symbol: token.symbol,
        };
        newToken.decimals = token.decimals;
        existing.push(newToken);
        added += 1;
      }

      const extension = format === 'jpeg' ? 'jpg' : format;
      const targetDir = path.join(logosDir, String(token.chainId));
      const targetPath = path.join(targetDir, `${token.address}.${extension}`);

      if (!forceLogo) {
        try {
          await fs.access(targetPath);
          logosSkipped += 1;
          continue;
        } catch (error) {
          // continue
        }
      }

      if (dryRun) {
        logosSkipped += 1;
        continue;
      }

      try {
        const { buffer, localPath } = await readLogoBuffer(token.logoURI, inputDir);
        await writeLogo(buffer, targetDir, targetPath, size, format);
        logosWritten += 1;

        if (localPath && !dryRun) {
          const repoRoot = process.cwd();
          const resolvedLocal = path.resolve(localPath);
          const resolvedTarget = path.resolve(targetPath);
          const repoPrefix = repoRoot.endsWith(path.sep) ? repoRoot : `${repoRoot}${path.sep}`;
          const isInRepo = resolvedLocal === repoRoot || resolvedLocal.startsWith(repoPrefix);
          if (isInRepo && resolvedLocal !== resolvedTarget) {
            try {
              await fs.unlink(resolvedLocal);
              console.log(`Removed source logo: ${localPath}`);
            } catch (error) {
              console.warn(`failed to remove source logo ${localPath}: ${error.message}`);
            }
          }
        }
      } catch (error) {
        logosFailed += 1;
        console.warn(`logo failed for ${token.address} on ${token.chainId}: ${error.message}`);
      }
    }

    if (!dryRun) {
      await writeJsonFile(tokenListPath, existing);
    }
  }

  console.log('Done');
  console.log(`Added: ${added}`);
  console.log(`Logos written: ${logosWritten}`);
  console.log(`Logos skipped: ${logosSkipped}`);
  console.log(`Logos failed: ${logosFailed}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
