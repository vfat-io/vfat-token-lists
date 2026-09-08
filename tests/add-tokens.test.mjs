import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';

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

test('repairs logos of listed tokens without changing their metadata', async (t) => {
  const cases = [
    { name: 'fills a missing logo' },
    { name: 'preserves an existing logo by default', existingLogo: true, invalidSource: true },
    { name: 'replaces an existing logo when forced', existingLogo: true, force: true },
    { name: 'preserves an existing logo when replacement fails', existingLogo: true, force: true, invalidSource: true },
    { name: 'reports a failed backfill', invalidSource: true },
    { name: 'does not backfill during a dry run', dryRun: true },
    { name: 'does not replace during a dry run', existingLogo: true, force: true, dryRun: true },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const rootDir = await createFixture();
      t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

      const address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
      const tokenListPath = path.join(rootDir, 'tokenLists', '1.json');
      const originalList = JSON.stringify([
        { chainId: 1, address: address.toUpperCase(), symbol: 'ORIGINAL', decimals: 6 },
      ]);
      await fs.writeFile(tokenListPath, originalList);

      const targetPath = path.join(rootDir, 'logos', '1', `${address}.png`);
      const originalLogo = await sharp({
        create: { width: 128, height: 128, channels: 4, background: '#000' },
      }).png().toBuffer();
      if (scenario.existingLogo) {
        await fs.writeFile(targetPath, originalLogo);
      }

      const sourcePath = path.join(rootDir, 'source.svg');
      await fs.writeFile(sourcePath, scenario.invalidSource ? 'invalid image' : SVG_LOGO);
      const inputPath = await writeInput(rootDir, [makeToken(1, address, 'CHANGED', sourcePath)]);
      const args = [scriptPath, '--input', inputPath];
      if (scenario.force) args.push('--force-logo');
      if (scenario.dryRun) args.push('--dry-run');

      const shouldWrite = (!scenario.existingLogo || scenario.force) && !scenario.dryRun;
      const shouldFail = shouldWrite && scenario.invalidSource;
      if (shouldFail) {
        await assert.rejects(execFileAsync(process.execPath, args, { cwd: rootDir }), (error) => {
          assert.match(error.stderr, /logo failed/);
          assert.match(error.stdout, /Added: 0/);
          assert.match(error.stdout, /Logos failed: 1/);
          return true;
        });
      } else {
        const { stdout } = await execFileAsync(process.execPath, args, { cwd: rootDir });
        assert.match(stdout, /Added: 0/);
        assert.match(stdout, new RegExp(`Logos written: ${shouldWrite ? 1 : 0}`));
      }

      assert.equal(await fs.readFile(tokenListPath, 'utf8'), originalList);
      if (shouldWrite && !shouldFail) {
        const { data, info } = await sharp(targetPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.equal(info.width, 128);
        assert.equal(info.height, 128);
        assert.equal(data.every((value) => value === 255), true);
      } else if (scenario.existingLogo) {
        assert.deepEqual(await fs.readFile(targetPath), originalLogo);
      } else {
        assert.equal(await pathExists(targetPath), false);
      }
      if (!shouldWrite || shouldFail) {
        assert.equal(await pathExists(sourcePath), true);
      }
    });
  }
});
