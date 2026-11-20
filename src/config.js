function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw == null || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: expected integer ${min}..${max}`);
  }
  return value;
}

export function getConfig() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required');
  const apiBase = process.env.GECKO_API_BASE || 'https://api.geckoterminal.com/api/v2';
  if (!apiBase.startsWith('https://')) throw new Error('GECKO_API_BASE must be HTTPS');
  return {
    dbUrl,
    apiBase: apiBase.replace(/\/+$/, ''),
    port: intEnv('PORT', 8787, 1, 65535),
    bindAddress: process.env.BIND_ADDRESS || '127.0.0.1',
    pollIntervalMs: intEnv('POLL_INTERVAL_MS', 30_000, 15_000, 3_600_000),
    pagesPerPoll: intEnv('PAGES_PER_POLL', 2, 1, 10),
    watchlistSize: intEnv('WATCHLIST_SIZE', 20, 0, 30),
    fetchTimeoutMs: intEnv('FETCH_TIMEOUT_MS', 10_000, 1_000, 60_000),
    collectorEnabled: process.env.COLLECTOR_ENABLED !== '0'
  };
}
