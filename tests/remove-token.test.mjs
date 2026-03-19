import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../scripts/remove-token.mjs', import.meta.url));

function makeToken(chainId, address, symbol) {
  return {
    chainId,
    address,
    symbol,
    decimals: 18,
  };
}

async function createFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfat-token-lists-'));
  await fs.mkdir(path.join(rootDir, 'tokenLists'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'logos', '1'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'logos', '10'), { recursive: true });
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

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

test('removes a token by address across all chains and deletes matching logos', async (t) => {
  const address = '0x1111111111111111111111111111111111111111';
  const rootDir = await createFixture();

  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  await writeTokenList(rootDir, 1, [
    makeToken(1, address, 'AAA'),
    makeToken(1, '0x2222222222222222222222222222222222222222', 'BBB'),
  ]);
  await writeTokenList(rootDir, 10, [makeToken(10, address, 'AAA')]);
  await fs.writeFile(path.join(rootDir, 'logos', '1', `${address}.png`), 'logo');
  await fs.writeFile(path.join(rootDir, 'logos', '10', `${address}.webp`), 'logo');

  const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--remove-address', address], {
    cwd: rootDir,
  });

  assert.match(stdout, /Removed: 2/);
  assert.deepEqual(await readTokenList(rootDir, 1), [
    makeToken(1, '0x2222222222222222222222222222222222222222', 'BBB'),
  ]);
  assert.deepEqual(await readTokenList(rootDir, 10), []);
  assert.equal(await pathExists(path.join(rootDir, 'logos', '1', `${address}.png`)), false);
  assert.equal(await pathExists(path.join(rootDir, 'logos', '10', `${address}.webp`)), false);
});

test('limits removal to one chain when --chain-id is provided', async (t) => {
  const address = '0x3333333333333333333333333333333333333333';
  const rootDir = await createFixture();

  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  await writeTokenList(rootDir, 1, [makeToken(1, address, 'AAA')]);
  await writeTokenList(rootDir, 10, [makeToken(10, address, 'AAA')]);
  await fs.writeFile(path.join(rootDir, 'logos', '1', `${address}.png`), 'logo');
  await fs.writeFile(path.join(rootDir, 'logos', '10', `${address}.png`), 'logo');

  const { stdout } = await execFileAsync(
    process.execPath,
    [scriptPath, '--remove-address', address, '--chain-id', '1'],
    { cwd: rootDir }
  );

  assert.match(stdout, /Chains touched: 1/);
  assert.deepEqual(await readTokenList(rootDir, 1), []);
  assert.deepEqual(await readTokenList(rootDir, 10), [makeToken(10, address, 'AAA')]);
  assert.equal(await pathExists(path.join(rootDir, 'logos', '1', `${address}.png`)), false);
  assert.equal(await pathExists(path.join(rootDir, 'logos', '10', `${address}.png`)), true);
});
