import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { isSolanaAddress } from './normalize.js';

const html = await readFile(new URL('../public/index.html', import.meta.url));
const js = await readFile(new URL('../public/dashboard.js', import.meta.url));
const css = await readFile(new URL('../public/style.css', import.meta.url));

function json(res, status, object) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(object));
}
function staticFile(res, contentType, body) {
  res.writeHead(200, { 'content-type': contentType, 'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache', 'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
  res.end(body);
}
function boundedInt(value, defaultValue = 100, max = 500) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : defaultValue;
}
function csvValue(value) {
  if (value == null) return '';
  let str = String(value);
  // CSV formula injection guard (especially spreadsheet programs).
  if (/^[\s]*[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return `"${str.replaceAll('"', '""')}"`;
}

async function api(db, pathname, u, res) {
  if (pathname === '/healthz') {
    await db.query('SELECT 1');
    return json(res, 200, { ok: true, readOnly: true });
  }
  if (pathname === '/api/status') {
    const [counts, lastRun, sourceCoverage, latestSnapshot, lastSuccess, runWindow] = await Promise.all([
      db.query('SELECT (SELECT count(*) FROM pools) AS pools, (SELECT count(*) FROM pool_snapshots) AS snapshots, (SELECT count(*) FROM raw_responses) AS raw_responses'),
      db.query('SELECT * FROM poll_runs ORDER BY started_at DESC LIMIT 1'),
      db.query('SELECT venue_family, count(*) AS count FROM pools GROUP BY venue_family ORDER BY count DESC'),
      db.query('SELECT max(observed_at) AS newest_at FROM pool_snapshots'),
      db.query("SELECT ended_at FROM poll_runs WHERE status='success' ORDER BY ended_at DESC LIMIT 1"),
      db.query("SELECT count(*)::integer AS runs, count(*) FILTER (WHERE status='success')::integer AS successful, count(*) FILTER (WHERE status IN ('failed','partial'))::integer AS unsuccessful FROM poll_runs WHERE started_at >= now() - interval '24 hours'")
    ]);
    return json(res, 200, { at: new Date().toISOString(), counters: counts.rows[0],
      latestRun: lastRun.rows[0] || null,
      latestSuccessAt: lastSuccess.rows[0]?.ended_at || null,
      newestSnapshotAt: latestSnapshot.rows[0]?.newest_at || null,
      coverage: sourceCoverage.rows, quality24h: runWindow.rows[0],
      capabilities: { source: 'geckoterminal', acquisition: 'REST polling', onChainStream: false,
        swaps: false, walletTracking: false, trading: false, completeMarketCoverage: false } });
  }
  if (pathname === '/api/pools') {
    const limit = boundedInt(u.searchParams.get('limit'), 100, 500);
    const family = u.searchParams.get('family') || null;
    const values = [];
    let where = '';
    if (family && family !== 'all') {
      if (!/^[a-z]{2,20}$/.test(family)) return json(res, 400, { error: 'invalid family' });
      values.push(family);
      where = `WHERE venue_family = $${values.length}`;
    }
    values.push(limit);
    const { rows } = await db.query(`SELECT pool_address, dex_id, venue_family, name, base_mint, quote_mint,
      base_symbol, quote_symbol, pool_created_at, first_seen_at, last_seen_at, last_price_usd,
      last_liquidity_usd, last_volume_h24_usd, last_buys_m5, last_sells_m5,
      CASE WHEN pool_created_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (first_seen_at - pool_created_at)) ELSE NULL END AS discovery_lag_seconds
      FROM pools ${where} ORDER BY first_seen_at DESC LIMIT $${values.length}`, values);
    return json(res, 200, { rows, count: rows.length });
  }
  const match = pathname.match(/^\/api\/pools\/([^/]+)\/snapshots$/);
  if (match) {
    const address = decodeURIComponent(match[1]);
    if (!isSolanaAddress(address)) return json(res, 400, { error: 'invalid Solana pool address' });
    const { rows } = await db.query(`SELECT observed_at, price_usd, liquidity_usd,
       volume_h24_usd, volume_m5_usd, buys_m5, sells_m5
       FROM pool_snapshots WHERE pool_address=$1 ORDER BY observed_at DESC LIMIT $2`,
    [address, boundedInt(u.searchParams.get('limit'), 100, 1000)]);
    return json(res, 200, { address, rows });
  }
  if (pathname === '/api/runs') {
    const { rows } = await db.query('SELECT * FROM poll_runs ORDER BY started_at DESC LIMIT $1',
      [boundedInt(u.searchParams.get('limit'), 30, 200)]);
    return json(res, 200, { rows });
  }
  if (pathname === '/api/export.csv') {
    const { rows } = await db.query(`SELECT s.pool_address, p.venue_family,
      s.observed_at, s.price_usd, s.liquidity_usd,
      s.volume_m5_usd, s.volume_h24_usd, s.buys_m5, s.sells_m5,
      p.pool_created_at, p.first_seen_at
      FROM pool_snapshots s JOIN pools p USING (pool_address)
      ORDER BY s.observed_at DESC, s.id DESC LIMIT $1`,
      [boundedInt(u.searchParams.get('limit'), 2000, 5000)]);
    const header = ['pool_address','venue_family','observed_at','price_usd','liquidity_usd',
      'volume_m5_usd','volume_h24_usd','buys_m5','sells_m5','pool_created_at','first_seen_at'];
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="solana_s1_snapshots.csv"',
      'cache-control': 'no-store' });
    res.end([header.join(','), ...rows.map(row => header.map(key => csvValue(row[key])).join(','))].join('\n') + '\n');
    return;
  }
  return json(res, 404, { error: 'Not found' });
}

export function startServer(db, config) {
  const server = http.createServer((req, res) => {
    const handle = async () => {
      if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
      const u = new URL(req.url || '/', 'http://localhost');
      if (u.pathname === '/') return staticFile(res, 'text/html; charset=utf-8', html);
      if (u.pathname === '/dashboard.js') return staticFile(res, 'application/javascript; charset=utf-8', js);
      if (u.pathname === '/style.css') return staticFile(res, 'text/css; charset=utf-8', css);
      return api(db, u.pathname, u, res);
    };
    handle().catch(err => {
      console.error(JSON.stringify({ kind: 'http_error', message: err.message }));
      if (!res.headersSent) json(res, 500, { error: 'Internal error' });
      else res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bindAddress, () => resolve(server));
  });
}
