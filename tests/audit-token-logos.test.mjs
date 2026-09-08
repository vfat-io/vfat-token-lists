import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { csvCell, groupCandidates, inspectImage, normalizeTokens, pixelDifference, prepareTokens, SIMILARITY_THRESHOLD } from '../scripts/audit-token-logos.mjs';

const address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const token = (chainId, symbol = 'ETH') => ({ chainId, address, symbol, decimals: 18 });

test('exports untrusted token names as CSV text rather than spreadsheet formulas', () => {
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell('Token "A", Inc.'), '"Token ""A"", Inc."');
  assert.equal(csvCell('ETH'), '"ETH"');
});

test('reports incomplete metadata without blocking valid tokens', () => {
  const { tokens, skipped } = prepareTokens([token(1), token(10, ''), null]);
  assert.equal(tokens.length, 1);
  assert.equal(skipped.length, 2);
  assert.equal(skipped[0].address, address);
  assert.throws(() => prepareTokens([token(1), token(1, 'WETH')]), /Conflicting metadata/);
});

test('keeps the same address on different chains and rejects conflicting token metadata', () => {
  const rows = normalizeTokens([token(10), token(1), { ...token(1), address: address.toUpperCase() }]);
  assert.deepEqual(rows.map((row) => row.chainId), [1, 10]);
  assert.equal(rows[0].address, address);
  assert.throws(() => normalizeTokens([token(1), token(1, 'WBTC')]), /Conflicting metadata/);
  assert.throws(() => normalizeTokens([{ ...token(1), address: '../bad' }]), /Invalid token/);
});

test('compares decoded imagery independently of image encoding and resolution', async () => {
  const small = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#2277ee' } }).png().toBuffer();
  const large = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#2277ee' } }).png().withMetadata().toBuffer();
  const other = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#ee3322' } }).png().toBuffer();
  const [a, b, c] = await Promise.all([small, large, other].map(inspectImage));
  assert.equal(pixelDifference(a.pixels, b.pixels), 0);
  assert.ok(pixelDifference(a.pixels, c.pixels) > SIMILARITY_THRESHOLD);
  assert.equal(a.hash, b.hash);
});

test('keeps wrapper symbols separate and retains ticker collisions for explicit review', () => {
  const logo = { pixels: Buffer.alloc(12, 100) };
  const rows = [
    { ...token(1), repo: logo }, { ...token(10), repo: logo },
    { ...token(1, 'WETH'), repo: logo }, { ...token(10, 'WETH'), repo: logo },
    { ...token(1, 'BTC'), name: 'Bitcoin', repo: logo },
    { ...token(369, 'BTC'), name: 'Bitcorn', repo: logo },
    { ...token(1, 'SINGLE'), repo: logo },
  ];
  const groups = groupCandidates(rows);
  assert.deepEqual(groups.map((group) => group.symbol).sort(), ['BTC', 'ETH', 'WETH']);
  assert.deepEqual(groups.find((group) => group.symbol === 'BTC').tokens.map((row) => row.name), ['Bitcoin', 'Bitcorn']);
  assert.ok(groups.every((group) => group.variantCount === 1));
});

test('uses live imagery for variants and falls back to GitHub after a failed live check', () => {
  const blue = { pixels: Buffer.alloc(12, 20) };
  const red = { pixels: Buffer.alloc(12, 200) };
  const rows = [
    { ...token(1), repo: blue, live: red },
    { ...token(10), repo: blue, live: { error: 'HTTP 404' } },
    { ...token(8453), repo: { error: 'missing' }, live: red },
  ];
  const [group] = groupCandidates(rows);
  assert.equal(group.variantCount, 2);
  assert.equal(rows[0].variant, rows[2].variant);
  assert.notEqual(rows[0].variant, rows[1].variant);
});
