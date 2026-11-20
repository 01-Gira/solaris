import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getS1bConfig } from '../src/s1b/config.js';
import { parseLogsNotification, parseSignatureHistory, extractTokenBalanceChanges } from '../src/s1b/parse.js';
import { SolanaRpc, RpcError } from '../src/s1b/rpc.js';

const address = 'So11111111111111111111111111111111111111112';
const mint = 'So11111111111111111111111111111111111111112';
const sig = '3'.repeat(88);
const baseEnv = { DATABASE_URL: 'postgresql://x@db:5432/x', SOLANA_RPC_HTTP_URL: 'https://rpc.example.com/key', SOLANA_RPC_WS_URL: 'wss://rpc.example.com/ws' };

test('requires both provider RPC endpoints and db URL', () => {
  assert.throws(() => getS1bConfig({ DATABASE_URL: baseEnv.DATABASE_URL }), /SOLANA_RPC_HTTP_URL/);
  assert.throws(() => getS1bConfig({ ...baseEnv, SOLANA_RPC_WS_URL: 'ws://insecure' }), /wss:/);
  assert.throws(() => getS1bConfig({ ...baseEnv, SOLANA_RPC_HTTP_URL: 'http://insecure' }), /https:/);
  assert.equal(getS1bConfig(baseEnv).maxPools, 3);
});
test('rejects invalid limits before connecting', () => {
  assert.throws(() => getS1bConfig({ ...baseEnv, S1B_MAX_POOLS: '0' }), /S1B_MAX_POOLS/);
  assert.throws(() => getS1bConfig({ ...baseEnv, S1B_RPC_SPACING_MS: '10' }), /S1B_RPC_SPACING_MS/);
});
test('parses valid live logs, signature and slot', () => {
  const data = { method: 'logsNotification', params: { subscription: 7, result: { context: { slot: 123 }, value: { signature: sig, err: null, logs: ['Program log: ok'] } } } };
  assert.deepEqual(parseLogsNotification(data, new Map([[7, address]])), { poolAddress: address, signature: sig, slot: 123, error: null, logs: ['Program log: ok'], source: 'live' });
  assert.equal(parseLogsNotification(data, new Map()), null);
  assert.equal(parseLogsNotification({ ...data, params: { ...data.params, result: { ...data.params.result, context: { slot: -1 } } } }, new Map([[7, address]])), null);
});
test('backfill preserves canonical oldest to newest order', () => {
  const a = '3'.repeat(88), b = '4'.repeat(88);
  const rows = [{ signature: b, slot: 12, err: null }, { signature: a, slot: 11, err: { InstructionError: [0, 'custom'] } }];
  const parsed = parseSignatureHistory(rows, address);
  assert.equal(parsed[0].signature, a);
  assert.equal(parsed[1].signature, b);
  assert.equal(parsed[0].source, 'backfill');
});
test('records token account balance changes only, retaining base units exactly', () => {
  const tx = { meta: {
    preTokenBalances: [{ accountIndex: 5, mint, owner: address, uiTokenAmount: { amount: '900719925474099999', decimals: 9 } }],
    postTokenBalances: [{ accountIndex: 5, mint, owner: address, uiTokenAmount: { amount: '900719925474099000', decimals: 9 } }]
  } };
  const [x] = extractTokenBalanceChanges(tx);
  assert.equal(x.deltaRaw, '-999');
  assert.equal(x.pre, '900719925474099999');
  assert.equal(x.decimals, 9);
});
test('token account opens and closes are handled from zero', () => {
  const tx = { meta: { preTokenBalances: [], postTokenBalances: [{ accountIndex: 3, mint, uiTokenAmount: { amount: '12', decimals: 6 } }] } };
  assert.equal(extractTokenBalanceChanges(tx)[0].deltaRaw, '12');
});
test('missing tx meta yields no inferred trades or prices', () => {
  assert.deepEqual(extractTokenBalanceChanges({}), []);
});
test('RPC getTransaction requests parsed finalized transaction with v0 support', async () => {
  let payload;
  const rpc = new SolanaRpc('https://rpc.example.com', { spacingMs: 0, fetchImpl: async (_url, opts) => {
    payload = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: payload.id, result: null }) };
  } });
  await rpc.getTransaction(sig);
  assert.equal(payload.method, 'getTransaction');
  assert.equal(payload.params[1].commitment, 'finalized');
  assert.equal(payload.params[1].encoding, 'jsonParsed');
  assert.equal(payload.params[1].maxSupportedTransactionVersion, 0);
});
test('RPC HTTP 429 is preserved as a retriable error with a delay', async () => {
  const rpc = new SolanaRpc('https://rpc.example.com', { spacingMs: 0, fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '5' } }) });
  await assert.rejects(rpc.call('getSlot'), error => error instanceof RpcError && error.retryAfterMs >= 30000);
});
test('RPC error response rejects instead of silently treating as no event', async () => {
  const rpc = new SolanaRpc('https://rpc.example.com', { spacingMs: 0, fetchImpl: async () => ({ ok: true, json: async () => ({ error: { code: -32602 } }) }) });
  await assert.rejects(rpc.call('getSlot'), /RPC error -32602/);
});

test('S1b recovery audit persists a bounded history and records old-to-new event order', async () => {
  const { recoverPool } = await import('../src/s1b/worker.js');
  const a = '3'.repeat(88), b = '4'.repeat(88);
  const saved = [], finishes = [];
  const db = { query: async (sql, args) => {
    if (sql.includes('INSERT INTO onchain_recovery_audits')) return { rows: [{ id: 11 }] };
    if (sql.includes('INSERT INTO onchain_pool_events')) saved.push(args[1]);
    if (sql.includes('UPDATE onchain_recovery_audits')) finishes.push(args);
    return { rows: [] };
  } };
  const rpc = { getSignatures: async () => [{ signature: b, slot: 22 }, { signature: a, slot: 21 }] };
  const n = await recoverPool(db, rpc, address, null, 5);
  assert.equal(n, 2);
  assert.deepEqual(saved, [a, b]);
  assert.equal(finishes[0][1], 'seeded_limited');
  assert.match(finishes[0][3], /UNVERIFIED/);
});

test('S1b WebSocket uses one logsSubscribe mentions address and records a signature only when matched', async () => {
  const { createWsSession } = await import('../src/s1b/worker.js');
  class FakeWs extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    messages = [];
    constructor() { super(); FakeWs.instance = this; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(raw) {
      const req = JSON.parse(raw);
      this.messages.push(req);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: req.id, result: 99 }) })));
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
    notify(subscription, signature = sig) {
      const payload = { method: 'logsNotification', params: {
        subscription, result: { context: { slot: 100 }, value: { signature, err: null, logs: ['ok'] } }
      } };
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
    }
  }
  const received = [];
  const session = createWsSession('wss://example.invalid', { maxQueue: 20, WebSocketImpl: FakeWs, onEvent: async event => received.push(event) });
  await session.open;
  await session.subscribe(address);
  assert.equal(FakeWs.instance.messages[0].method, 'logsSubscribe');
  assert.deepEqual(FakeWs.instance.messages[0].params[0], { mentions: [address] });
  assert.equal(FakeWs.instance.messages[0].params[1].commitment, 'finalized');
  FakeWs.instance.notify(1000); // unknown subscription must not be misattributed
  FakeWs.instance.notify(99);
  await session.drain();
  assert.equal(received.length, 1);
  assert.equal(received[0].signature, sig);
  assert.equal(received[0].poolAddress, address);
  session.stop('test_done');
});
