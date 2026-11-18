import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

test('explicit token chain IDs match their containing list', async () => {
  const directory = new URL('../tokenLists/', import.meta.url);
  const files = (await readdir(directory)).filter((name) => /^\d+\.json$/.test(name));
  assert.ok(files.length > 0);
  const mismatches = [];

  for (const file of files) {
    const chainId = Number(file.slice(0, -5));
    const tokens = JSON.parse(await readFile(new URL(file, directory), 'utf8'));
    assert.ok(Array.isArray(tokens), file);
    for (const token of tokens) {
      if (token.chainId !== undefined && token.chainId !== chainId) {
        mismatches.push({ file, address: token.address, declaredChainId: token.chainId });
      }
    }
  }

  assert.deepEqual(mismatches, [], 'Conflicting chain IDs prevent per-chain whitelist publication');
});
