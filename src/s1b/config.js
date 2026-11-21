const required = (env, name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when S1b is enabled`);
  return value;
};
function integer(env, name, fallback, min, max) {
  const n = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be integer ${min}..${max}`);
  return n;
}
function validateURL(value, protocol, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${name}`); }
  if (url.protocol !== protocol || url.username || url.password) throw new Error(`${name} must use ${protocol} without URL basic auth`);
  return value;
}
export function getS1bConfig(env = process.env) {
  const hydrationMode=env.S1B_HYDRATION_MODE||'inline';
  if(!['inline','external'].includes(hydrationMode))
    throw new Error('S1B_HYDRATION_MODE must be inline or external');
  const dbUrl = required(env, 'DATABASE_URL');
  return {
    dbUrl,
    hydrationMode,
    httpUrl: validateURL(required(env, 'SOLANA_RPC_HTTP_URL'), 'https:', 'SOLANA_RPC_HTTP_URL'),
    wsUrl: validateURL(required(env, 'SOLANA_RPC_WS_URL'), 'wss:', 'SOLANA_RPC_WS_URL'),
    maxPools: integer(env, 'S1B_MAX_POOLS', 3, 1, 20),
    maxPoolAgeMinutes: integer(env, 'S1B_POOL_MAX_AGE_MINUTES', 30, 1, 1440),
    sessionSeconds: integer(env, 'S1B_SESSION_SECONDS', 300, 60, 3600),
    reconnectMs: integer(env, 'S1B_RECONNECT_MS', 10000, 1000, 600000),
    backfillLimit: integer(env, 'S1B_BACKFILL_LIMIT', 30, 1, 300),
    rpcSpacingMs: integer(env, 'S1B_RPC_SPACING_MS', 1000, 100, 60000),
    txBatchSize: integer(env, 'S1B_TX_BATCH_SIZE', 10, 1, 100),
    txMaxAttempts: integer(env, 'S1B_TX_MAX_ATTEMPTS', 8, 1, 30),
    maxPendingNotifications: integer(env, 'S1B_MAX_NOTIFICATION_QUEUE', 500, 20, 5000)
  };
}
