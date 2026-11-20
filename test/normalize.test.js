import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeGeckoResponse, asDecimal, isSolanaAddress, venueFamily } from '../src/normalize.js';

const example = JSON.parse(await readFile(new URL('../fixtures/gecko_new_pools_fixture.json', import.meta.url), 'utf8'));

test('recognizes both SOL pool addresses and token mint addresses', () => {
  const { pools, malformed } = normalizeGeckoResponse(example);
  assert.equal(malformed.length, 0);
  assert.equal(pools.length, 2);
  assert.equal(pools[0].address, '11111111111111111111111111111111');
  assert.equal(pools[0].baseMint, '11111111111111111111111111111113');
  assert.equal(pools[0].quoteMint, 'So11111111111111111111111111111111111111112');
  assert.equal(pools[0].baseSymbol, 'DEMO');
  assert.equal(pools[0].family, 'pumpswap');
  assert.equal(pools[1].family, 'raydium');
});

test('parses price, liquidity, rolling volume, and txn counts without inventing fields', () => {
  const { pools } = normalizeGeckoResponse(example);
  const pool = pools[0];
  assert.equal(pool.priceUsd, '0.00001375');
  assert.equal(pool.liquidityUsd, '15234.56');
  assert.equal(pool.volumeM5Usd, '210.99');
  assert.equal(pool.volumeH24Usd, '10231.2');
  assert.equal(pool.buysM5, 3);
  assert.equal(pool.sellsM5, 1);
  assert.equal(pool.createdAt, '2026-11-20T08:00:00.000Z');
});

test('missing measurements stay NULL, never zero', () => {
  const modified = structuredClone(example);
  delete modified.data[0].attributes.transactions;
  delete modified.data[0].attributes.volume_usd;
  delete modified.data[0].attributes.base_token_price_usd;
  const { pools } = normalizeGeckoResponse(modified);
  assert.equal(pools[0].priceUsd, null);
  assert.equal(pools[0].buysM5, null);
  assert.equal(pools[0].volumeM5Usd, null);
});

test('invalid pool addresses rejected and accounted for', () => {
  const modified = structuredClone(example);
  modified.data.push({ id: 'invalid', attributes: { address: '<script>alert(1)</script>' } });
  const { pools, malformed } = normalizeGeckoResponse(modified);
  assert.equal(pools.length, 2);
  assert.equal(malformed.length, 1);
  assert.equal(isSolanaAddress('https://evil.invalid/'), false);
  assert.equal(isSolanaAddress('22222222222222222222222222222222'), false); // Valid alphabet, invalid decoded length.
});

test('empty data response allowed, malformed schema rejected', () => {
  assert.deepEqual(normalizeGeckoResponse({ data: [] }).pools, []);
  assert.throws(() => normalizeGeckoResponse({ error: 'rate limit' }), /data must be an array/);
});

test('decimal values do not allow negative, NaN or special strings', () => {
  assert.equal(asDecimal('0.000000001'), '0.000000001');
  assert.equal(asDecimal('1e-10'), '1e-10');
  assert.equal(asDecimal('-50'), null);
  assert.equal(asDecimal('NaN'), null);
  assert.equal(asDecimal(''), null);
  assert.equal(asDecimal('2; DROP TABLE pools'), null);
});

test('Dex family classifier includes target venues without dropping others', () => {
  assert.equal(venueFamily('pump-fun'), 'pumpfun');
  assert.equal(venueFamily('pumpswap'), 'pumpswap');
  assert.equal(venueFamily('raydium-clmm'), 'raydium');
  assert.equal(venueFamily('meteora-dlmm'), 'meteora');
  assert.equal(venueFamily('unknown-dex'), 'other');
});
