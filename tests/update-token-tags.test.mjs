import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../scripts/update-token-tags.mjs', import.meta.url));
const validatorPath = fileURLToPath(new URL('../scripts/validate-token-tags.mjs', import.meta.url));
const address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const otherAddress = '0x1111111111111111111111111111111111111111';
const source = 'https://issuer.example/contracts';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vfat-token-tags-'));
  await fs.mkdir(path.join(root, 'tokenLists'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function token(chainId, fields = {}) {
  return { chainId, address, symbol: 'TEST', decimals: 18, ...fields };
}

async function writeList(root, chainId, tokens) {
  await fs.writeFile(path.join(root, 'tokenLists', `${chainId}.json`), JSON.stringify(tokens, null, 2) + '\n');
}

async function readList(root, chainId) {
  return JSON.parse(await fs.readFile(path.join(root, 'tokenLists', `${chainId}.json`), 'utf8'));
}

async function run(root, updates, extra = []) {
  const input = path.join(root, 'updates.json');
  await fs.writeFile(input, JSON.stringify(updates));
  return execFileAsync(process.execPath, [scriptPath, '--input', input, ...extra], { cwd: root });
}

function update(fields = {}) {
  return { chainId: 1, address, tags: ['bluechip'], source, ...fields };
}

test('updates by chain and case-insensitive address while preserving unrelated metadata and tokens', async t => {
  const root = await fixture(t);
  const original = token(1, { defaultPrice: 1, evidence: { note: 'keep' }, tags: ['stablecoin'] });
  const other = token(1, { address: otherAddress, symbol: 'TEST' });
  await writeList(root, 1, [original, other]);
  await writeList(root, 10, [token(10)]);
  await run(root, [update({ address: address.toUpperCase().replace('0X', '0x'), tags: ['stock', 'bluechip', 'stock'] })]);
  assert.deepEqual(await readList(root, 1), [{ ...original, tags: ['bluechip', 'stock'] }, other]);
  assert.deepEqual(await readList(root, 10), [token(10)]);
});

test('validates every token match before writing any chain', async t => {
  const root = await fixture(t);
  await writeList(root, 1, [token(1)]);
  await writeList(root, 10, [token(10)]);
  await assert.rejects(run(root, [update(), update({ chainId: 10, address: otherAddress })]), /exactly one existing token/);
  assert.deepEqual(await readList(root, 1), [token(1)]);
  assert.deepEqual(await readList(root, 10), [token(10)]);
});

test('dry run leaves bytes unchanged and applying the same update twice is a no-op', async t => {
  const root = await fixture(t);
  await writeList(root, 1, [token(1)]);
  const file = path.join(root, 'tokenLists', '1.json');
  const before = await fs.readFile(file, 'utf8');
  const preview = await run(root, [update()], ['--dry-run']);
  assert.match(preview.stdout, /Would update: 1 tokens/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await run(root, [update()]);
  const applied = await fs.readFile(file, 'utf8');
  const repeated = await run(root, [update()]);
  assert.match(repeated.stdout, /Updated: 0 tokens/);
  assert.equal(await fs.readFile(file, 'utf8'), applied);
});

test('empty tags remove the optional field without removing the token', async t => {
  const root = await fixture(t);
  await writeList(root, 1, [token(1, { tags: ['bluechip'] })]);
  await run(root, [update({ tags: [] })]);
  assert.deepEqual(await readList(root, 1), [token(1)]);
});

test('reviewed updates can replace or remove invalid existing tags', async (t) => {
  const root = await fixture(t);
  const original = token(1, { defaultPrice: 1 });
  for (const existingTags of [['retired'], 'bluechip', null]) {
    for (const tags of [['bluechip'], []]) {
      await writeList(root, 1, [{ ...original, tags: existingTags }]);
      await run(root, [update({ tags })]);
      assert.deepEqual(await readList(root, 1), [
        tags.length > 0 ? { ...original, tags } : original,
      ]);
    }
  }
});

test('uses the chain filename for legacy entries that omit chainId without rewriting their metadata', async t => {
  const root = await fixture(t);
  const legacy = { address, symbol: 'TEST', decimals: 18 };
  await writeList(root, 1, [legacy]);
  await run(root, [update()]);
  assert.deepEqual(await readList(root, 1), [{ ...legacy, tags: ['bluechip'] }]);
});

test('rejects malformed updates, unknown tags, missing evidence and duplicate addresses without changing files', async t => {
  const root = await fixture(t);
  await writeList(root, 1, [token(1)]);
  const cases = [
    [[update({ tags: ['stablecoin', 'unknown'] })], /unknown tag/],
    [[update({ tags: 'bluechip' })], /must be an array/],
    [[update({ tags: ['__proto__'] })], /unknown tag/],
    [[update({ chainId: '1' })], /positive integer/],
    [[update({ chainId: 1.5 })], /positive integer/],
    [[update({ address: '../other.json' })], /invalid token address/],
    [[update({ source: undefined })], /evidence URL/],
    [[update({ source: 'file:///tmp/evidence' })], /evidence URL/],
    [[update(), update()], /duplicate update/],
    [[update({ expectedSymbol: 'WRONG' })], /expected symbol/],
  ];
  for (const [updates, error] of cases) {
    await assert.rejects(run(root, updates), error);
    assert.deepEqual(await readList(root, 1), [token(1)]);
  }
});

test('rejects ambiguous matches and entries recorded on a different chain', async t => {
  const root = await fixture(t);
  for (const tokens of [[token(1), token(1)], [token(10)]]) {
    await writeList(root, 1, tokens);
    await assert.rejects(run(root, [update()]), /exactly one existing token/);
    assert.deepEqual(await readList(root, 1), tokens);
  }
});

test('repository validator rejects unknown, duplicate and unsorted tags', async t => {
  const root = await fixture(t);
  for (const tags of [['unknown'], ['stock', 'stock'], ['stock', 'bluechip'], []]) {
    await writeList(root, 1, [token(1, { tags })]);
    await assert.rejects(execFileAsync(process.execPath, [validatorPath], { cwd: root }));
  }
  await writeList(root, 1, [token(1), token(1, { address: otherAddress, tags: ['bluechip', 'stock'] })]);
  const { stdout } = await execFileAsync(process.execPath, [validatorPath], { cwd: root });
  assert.match(stdout, /Validated tags on 1 tokens/);
});
