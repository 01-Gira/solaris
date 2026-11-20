import { createHash } from 'node:crypto';
import { normalizeGeckoResponse } from './normalize.js';

export class ApiError extends Error {
  constructor(message, retryAfterMs = 0) {
    super(message);
    this.name = 'ApiError';
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(600_000, Math.max(0, seconds * 1000));
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.min(600_000, Math.max(0, dateMs - Date.now())) : 0;
}

export async function fetchNewPools(apiBase, page, timeoutMs, fetchImpl = fetch) {
  const url = `${apiBase}/networks/solana/new_pools?page=${page}&include=base_token,quote_token,dex`;
  return fetchGecko(url, page, timeoutMs, fetchImpl);
}

export async function fetchMultiPools(apiBase, addresses, timeoutMs, fetchImpl = fetch) {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 30) {
    throw new Error('fetchMultiPools requires 1..30 pool addresses');
  }
  const url = `${apiBase}/networks/solana/pools/multi/${addresses.join(',')}?include=base_token,quote_token,dex`;
  return fetchGecko(url, 0, timeoutMs, fetchImpl);
}

async function fetchGecko(url, page, timeoutMs, fetchImpl) {
  const startedAt = new Date().toISOString();
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'Solana-S1-Research-Recorder/0.1' },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new ApiError(`Fetch failed (${error?.name || 'network'}): ${error?.message || error}`);
  }
  if (!response.ok) {
    const retry = response.status === 429 ? Math.max(60_000, parseRetryAfter(response.headers.get('retry-after'))) : 0;
    throw new ApiError(`GeckoTerminal HTTP ${response.status} on page ${page}`, retry);
  }
  let rawBody;
  try { rawBody = await response.text(); }
  catch (error) { throw new ApiError(`Failed to read response: ${error.message}`); }
  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { throw new ApiError('GeckoTerminal returned non-JSON body'); }
  const { pools, malformed } = normalizeGeckoResponse(payload);
  return {
    page,
    endpoint: url,
    startedAt,
    fetchedAt: new Date().toISOString(),
    rawBody,
    sha256: createHash('sha256').update(rawBody).digest('hex'),
    payload,
    pools,
    malformed
  };
}
