import { parseLogsNotification, parseSignatureHistory, validPubkey } from './parse.js';
import { SolanaRpc } from './rpc.js';
import { SharedRpcPacer } from './rpc-pacer.js';
import {
  selectPools, latestSignature, recordEvent, setHealth, beginRecovery,
  finishRecovery, pendingSignatures, saveTransaction, markTransactionRetry, beginWatch, finishWatch
} from './store.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (kind, details = {}) => console.log(JSON.stringify({ kind: `s1b_${kind}`, at: new Date().toISOString(), ...details }));
const shortError = e => String(e?.message || e || 'unknown').replace(/(?:https?|wss?):\/\/\S+/g, '[redacted-rpc-url]').slice(0, 240);

export async function recoverPool(db, rpc, poolAddress, anchor, limit) {
  const auditId = await beginRecovery(db, poolAddress, anchor);
  let inserted = 0;
  let scanned = 0;
  try {
    let before;
    const seen = new Set();
    // Always bounded. A successful RPC response does not prove unbounded history coverage.
    while (scanned < limit) {
      const pageSize = Math.min(100, limit - scanned);
      const opts = { limit: pageSize, ...(before ? { before } : {}), ...(anchor ? { until: anchor } : {}) };
      const page = await rpc.getSignatures(poolAddress, opts);
      scanned += page.length;
      const parsed = parseSignatureHistory(page, poolAddress);
      for (const item of parsed) {
        if (!seen.has(item.signature)) {
          await recordEvent(db, item);
          seen.add(item.signature);
          inserted++;
        }
      }
      if (!page.length || page.length < pageSize) break;
      const oldest = page.at(-1)?.signature;
      if (!oldest || oldest === before) break;
      before = oldest;
    }
    // Never use a 'complete' state: index retention, provider gaps, and bounded scans remain possible.
    const status = anchor ? 'bounded' : 'seeded_limited';
    await finishRecovery(db, auditId, status, inserted, `max=${limit}; prior=${anchor ? 'known' : 'none'}; continuity=UNVERIFIED`);
    return inserted;
  } catch (error) {
    await finishRecovery(db, auditId, 'error', inserted, shortError(error));
    throw error;
  }
}

export async function processTransactions(db, rpc, config) {
  const jobs = await pendingSignatures(db, config.txBatchSize);
  for (const job of jobs) {
    try {
      const tx = await rpc.getTransaction(job.signature);
      if (!tx) throw new Error('getTransaction returned null (not indexed yet)');
      await saveTransaction(db, job.signature, tx);
    } catch (error) {
      const result = await markTransactionRetry(db, job.signature, job.attempts,
        config.txMaxAttempts, shortError(error), error?.retryAfterMs || 0);
      if (result.exhausted) log('tx_unavailable', { signature: job.signature, attempts: result.nextAttempt, error: shortError(error) });
    }
  }
  return jobs.length;
}

export function createWsSession(url, { maxQueue, onEvent, WebSocketImpl = WebSocket } = {}) {
  const socket = new WebSocketImpl(url);
  const pending = new Map();
  const subscriptions = new Map();
  const queue = [];
  let requestId = 0;
  let draining = null;
  let lastHeartbeat = Date.now();
  let stopped = false;
  let closeReason = null;
  let closeResolve;
  const closed = new Promise(resolve => { closeResolve = resolve; });

  const open = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket connect failed')), { once: true });
    socket.addEventListener('close', () => reject(new Error('WebSocket closed before opening')), { once: true });
  });

  function stop(reason) {
    if (stopped) return;
    stopped = true;
    closeReason = reason;
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('WebSocket closed')); }
    pending.clear();
    closeResolve(reason);
    try { socket.close(); } catch { /* already closed */ }
  }
  socket.addEventListener('close', () => stop(closeReason || 'remote_closed'));
  socket.addEventListener('error', () => stop('socket_error'));

  async function drain() {
    if (draining) return draining;
    draining = (async () => {
      while (queue.length) {
        const item = queue.shift();
        try { await onEvent(item); }
        catch (error) {
          log('event_store_error', { error: shortError(error), signature: item.signature });
          stop('event_store_failed');
          // If DB unavailable, stop ingestion; recovery on reconnect must fill the gap.
          queue.length = 0;
          break;
        }
      }
    })();
    try { await draining; } finally { draining = null; if (queue.length) void drain(); }
  }
  socket.addEventListener('message', event => {
    let body;
    try { body = JSON.parse(String(event.data)); } catch { return; }
    if (body.id !== undefined && pending.has(body.id)) {
      const job = pending.get(body.id);
      pending.delete(body.id);
      clearTimeout(job.timer);
      if (body.error) job.reject(new Error(`WebSocket RPC error ${body.error.code ?? 'unknown'}`));
      else job.resolve(body.result);
      return;
    }
    if (body.method === 'slotNotification') lastHeartbeat = Date.now();
    const observation = parseLogsNotification(body, subscriptions);
    if (!observation) return;
    if (queue.length >= maxQueue) { stop('notification_queue_overflow'); return; }
    queue.push(observation);
    void drain();
  });

  async function request(method, params = []) {
    if (stopped || socket.readyState !== WebSocketImpl.OPEN) throw new Error('WebSocket unavailable');
    const id = ++requestId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`WebSocket ${method} timed out`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
    });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return result;
  }
  async function subscribe(address) {
    if (!validPubkey(address)) throw new Error('Invalid pool public key');
    const subscriptionId = await request('logsSubscribe', [{ mentions: [address] }, { commitment: 'finalized' }]);
    if (!Number.isSafeInteger(subscriptionId)) throw new Error('Invalid subscription response');
    subscriptions.set(subscriptionId, address);
    return subscriptionId;
  }
  return {
    open,
    closed,
    stop,
    drain: () => draining || Promise.resolve(),
    request,
    subscribe,
    get heartbeatAgeMs() { return Date.now() - lastHeartbeat; },
    get closeReason() { return closeReason; }
  };
}

export async function runS1b(db, config, signal) {
  const external=config.hydrationMode==='external';
  const pacer=external?new SharedRpcPacer(db,config.httpUrl,{spacingMs:config.rpcSpacingMs}):null;
  const rpc = new SolanaRpc(config.httpUrl, { spacingMs: config.rpcSpacingMs,pacer });
  const reportHealth=(state,activePools,lastError=null)=>
    setHealth(db,state,activePools,lastError,config.hydrationMode||'inline');
  let backoff = config.reconnectMs;
  while (!signal.aborted) {
    let session;
    let tracked = [];
    const watchSessionIds = [];
    try {
      tracked = await selectPools(db, config.maxPools, config.maxPoolAgeMinutes);
      if (!tracked.length) {
        await reportHealth( 'waiting_for_pools', 0);
        log('idle', { reason: 'no_recent_pools' });
        await sleep(30000);
        continue;
      }
      const anchors = new Map();
      for (const address of tracked) anchors.set(address, await latestSignature(db, address));
      await reportHealth( 'connecting', tracked.length);
      session = createWsSession(config.wsUrl, {
        maxQueue: config.maxPendingNotifications,
        onEvent: item => recordEvent(db, item)
      });
      await Promise.race([session.open, sleep(20000).then(() => { throw new Error('WebSocket opening timeout'); })]);
      await session.request('slotSubscribe'); // Heartbeat: detect silent stale sockets.
      for (const address of tracked) {
        await session.subscribe(address);
        watchSessionIds.push(await beginWatch(db, address, anchors.get(address)));
      }
      await reportHealth( 'connected', tracked.length);
      log('connected', { pools: tracked.length, source: 'solana_logsSubscribe', commitment: 'finalized' });
      // Subscribe first, then recover history using a cursor captured before subscription.
      for (const address of tracked) {
        try {
          const count = await recoverPool(db, rpc, address, anchors.get(address), config.backfillLimit);
          log('recovered', { poolAddress: address, count, continuity: 'unverified' });
        } catch (error) {
          log('recovery_error', { poolAddress: address, error: shortError(error) });
        }
      }
      const endsAt = Date.now() + config.sessionSeconds * 1000;
      while (!signal.aborted && Date.now() < endsAt) {
        if (session.closeReason) throw new Error(`WebSocket ended (${session.closeReason})`);
        if (session.heartbeatAgeMs > 120000) throw new Error('WebSocket heartbeat stalled');
        if(!external)await processTransactions(db, rpc, config);
        await reportHealth( 'connected', tracked.length);
        await sleep(1000);
      }
      backoff = config.reconnectMs;
    } catch (error) {
      const message = shortError(error);
      log('session_error', { error: message, trackedPools: tracked.length });
      try { await reportHealth( 'reconnecting', 0, message); } catch { /* database may be down */ }
      backoff = Math.min(backoff * 2, 60000);
    } finally {
      const reason = session?.closeReason || (signal.aborted ? 'shutdown' : 'session_rotation');
      session?.stop(reason);
      if (session) await Promise.race([session.drain(), sleep(10000)]);
      try { await finishWatch(db, watchSessionIds, reason); } catch (error) { log('watch_end_error', { error: shortError(error) }); }
    }
    if (!signal.aborted) await sleep(backoff);
  }
  await reportHealth( 'stopped', 0);
}
