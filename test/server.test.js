import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';

test('dashboard static routes served without database access', async () => {
  const server = await startServer({ query: async () => { throw new Error('db unavailable'); } },
    { port: 0, bindAddress: '127.0.0.1' });
  try {
    const port = server.address().port;
    const main = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(main.status, 200);
    assert.match(await main.text(), /New pool discovery/);
    const js = await fetch(`http://127.0.0.1:${port}/dashboard.js`);
    assert.equal(js.status, 200);
    const invalidPool = await fetch(`http://127.0.0.1:${port}/api/pools/bad/snapshots`);
    assert.equal(invalidPool.status, 400);
    const dbFail = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(dbFail.status, 500);
    const method = await fetch(`http://127.0.0.1:${port}/api/pools`, { method: 'POST' });
    assert.equal(method.status, 405);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
