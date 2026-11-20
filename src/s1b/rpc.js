export class RpcError extends Error {
  constructor(message, retryAfterMs = 0) { super(message); this.name = 'RpcError'; this.retryAfterMs = retryAfterMs; }
}

function retryAfterMs(value) {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, Math.min(n * 1000, 600000));
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, Math.min(t - Date.now(), 600000)) : 0;
}

export class SolanaRpc {
  constructor(url, { fetchImpl = fetch, spacingMs = 1000 } = {}) {
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.spacingMs = spacingMs;
    this.nextAllowedAt = 0;
    this.pending = Promise.resolve();
    this.counter = 0;
  }
  async call(method, params = []) {
    // Serialize HTTP RPC calls to avoid bursts and account for provider quotas.
    const job = this.pending.then(async () => {
      const wait = this.nextAllowedAt - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      this.nextAllowedAt = Date.now() + this.spacingMs;
      let response;
      try {
        response = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.counter, method, params }),
          signal: AbortSignal.timeout(20000)
        });
      } catch (error) {
        throw new RpcError(`RPC ${method}: transport error ${error?.name || 'unknown'}`);
      }
      if (!response.ok) {
        const retry = response.status === 429 ? Math.max(30000, retryAfterMs(response.headers.get('retry-after'))) : 0;
        this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + retry);
        throw new RpcError(`RPC ${method}: HTTP ${response.status}`, retry);
      }
      let body;
      try { body = await response.json(); }
      catch { throw new RpcError(`RPC ${method}: invalid JSON`); }
      if (body?.error) throw new RpcError(`RPC ${method}: RPC error ${body.error.code ?? 'unknown'}`);
      if (!Object.hasOwn(body || {}, 'result')) throw new RpcError(`RPC ${method}: missing result`);
      return body.result;
    });
    this.pending = job.catch(() => {});
    return job;
  }
  getSignatures(address, opts) { return this.call('getSignaturesForAddress', [address, { commitment: 'finalized', ...opts }]); }
  getTransaction(signature) {
    return this.call('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]);
  }
}
