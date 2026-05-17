import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../scripts/add-tokens.mjs', import.meta.url));

const SVG_LOGO = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#fff"/></svg>';

function makeToken(chainId, address, symbol, logoURI) {
  return {
    chainId,
    address,
    symbol,
    decimals: 18,
    logoURI,
  };
}

async function createFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfat-token-lists-'));
  await fs.mkdir(path.join(rootDir, 'tokenLists'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'logos', '1'), { recursive: true });
  return rootDir;
}

async function writeTokenList(rootDir, chainId, tokens) {
  const filePath = path.join(rootDir, 'tokenLists', `${chainId}.json`);
  await fs.writeFile(filePath, JSON.stringify(tokens, null, 2) + '\n');
}

async function readTokenList(rootDir, chainId) {
  const filePath = path.join(rootDir, 'tokenLists', `${chainId}.json`);
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeInput(rootDir, tokens) {
  const filePath = path.join(rootDir, 'tokens.json');
  await fs.writeFile(filePath, JSON.stringify(tokens, null, 2) + '\n');
  return filePath;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

test('adds token only after writing its logo', async (t) => {
  const rootDir = await createFixture();
  const address = '0x1111111111111111111111111111111111111111';

  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  await writeTokenList(rootDir, 1, []);
  const sourceLogoPath = path.join(rootDir, 'source.svg');
  await fs.writeFile(sourceLogoPath, SVG_LOGO);
  const inputPath = await writeInput(rootDir, [makeToken(1, address, 'AAA', sourceLogoPath)]);

  const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--input', inputPath], { cwd: rootDir });

  assert.match(stdout, /Added: 1/);
  assert.match(stdout, /Logos written: 1/);
  assert.deepEqual(await readTokenList(rootDir, 1), [
    {
      chainId: 1,
      address,
      symbol: 'AAA',
      decimals: 18,
    },
  ]);
  assert.equal(await pathExists(path.join(rootDir, 'logos', '1', `${address}.png`)), true);
});

test('fails without adding token when logo cannot be resolved', async (t) => {
  const rootDir = await createFixture();
  const address = '0x2222222222222222222222222222222222222222';

  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  await writeTokenList(rootDir, 1, []);
  const missingLogoPath = path.join(rootDir, 'missing.png');
  const inputPath = await writeInput(rootDir, [makeToken(1, address, 'BBB', missingLogoPath)]);

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, '--input', inputPath], { cwd: rootDir }),
    (error) => {
      assert.match(error.stderr, /logo failed/);
      assert.match(error.stderr, /failed to add 1 token logo/);
      return true;
    }
  );

  assert.deepEqual(await readTokenList(rootDir, 1), []);
  assert.equal(await pathExists(path.join(rootDir, 'logos', '1', `${address}.png`)), false);
});

test('adds token when the target logo already exists', async (t) => {
  const rootDir = await createFixture();
  const address = '0x3333333333333333333333333333333333333333';

  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  await writeTokenList(rootDir, 1, []);
  await fs.writeFile(path.join(rootDir, 'logos', '1', `${address}.png`), 'existing');
  const inputPath = await writeInput(rootDir, [makeToken(1, address, 'CCC', path.join(rootDir, 'missing.png'))]);

  const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--input', inputPath], { cwd: rootDir });

  assert.match(stdout, /Added: 1/);
  assert.match(stdout, /Logos skipped: 1/);
  assert.deepEqual(await readTokenList(rootDir, 1), [
    {
      chainId: 1,
      address,
      symbol: 'CCC',
      decimals: 18,
    },
  ]);
});
