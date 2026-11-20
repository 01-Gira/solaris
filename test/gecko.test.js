import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchNewPools, fetchMultiPools, ApiError } from '../src/gecko.js';

const payload = JSON.parse(await readFile(new URL('../fixtures/gecko_new_pools_fixture.json', import.meta.url), 'utf8'));
const okFetch = async () => new Response(JSON.stringify(payload), { status: 200 });

test('new pools URL, source timestamps, hash and parser are populated', async () => {
  let url;
  const result = await fetchNewPools('https://api.geckoterminal.com/api/v2', 2, 1000, async u => {
    url = u; return okFetch();
  });
  assert.match(url, /\/networks\/solana\/new_pools\?page=2/);
  assert.equal(result.pools.length, 2);
  assert.equal(result.sha256.length, 64);
  assert.equal(result.page, 2);
  assert.ok(Date.parse(result.fetchedAt) >= Date.parse(result.startedAt));
});

test('multi pools URL used for bounded watchlist', async () => {
  let url;
  const result = await fetchMultiPools('https://api.geckoterminal.com/api/v2',
    ['11111111111111111111111111111111'], 1000, async u => { url = u; return okFetch(); });
  assert.match(url, /\/pools\/multi\/11111111111111111111111111111111\?/);
  assert.equal(result.page, 0);
});

test('429 honors retry-after and refuses bad payload', async () => {
  await assert.rejects(() => fetchNewPools('https://api.geckoterminal.com/api/v2', 1, 1000,
    async () => new Response('rate limit', { status: 429, headers: { 'retry-after': '120' } })),
    error => error instanceof ApiError && error.retryAfterMs === 120_000);
  await assert.rejects(() => fetchNewPools('https://api.geckoterminal.com/api/v2', 1, 1000,
    async () => new Response('not-json', { status: 200 })), /non-JSON/);
});

test('non-success HTTP never treated as empty set of pools', async () => {
  await assert.rejects(() => fetchNewPools('https://api.geckoterminal.com/api/v2', 1, 1000,
    async () => new Response('bad gateway', { status: 502 })), /HTTP 502/);
});

test('more than 30 watchlist addresses refused before external request', async () => {
  await assert.rejects(() => fetchMultiPools('https://api.geckoterminal.com/api/v2',
    Array.from({ length: 31 }, () => '11111111111111111111111111111111'), 1000), /1\.\.30/);
});
