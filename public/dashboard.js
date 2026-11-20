const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const money = value => value == null ? '—' : '$' + Number(value).toLocaleString('en-US', {
  maximumSignificantDigits: 5
});
const time = value => value ? new Date(value).toLocaleString() : '—';
const ago = value => {
  if (!value) return '—';
  const seconds = Math.round((Date.now() - Date.parse(value)) / 1000);
  if (seconds < 0) return 'clock skew';
  if (seconds < 90) return `${seconds}s ago`;
  return seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
};
const cell = (row, text) => { const td = document.createElement('td'); td.textContent = text ?? '—'; row.append(td); return td; };
const clear = id => { $(id).replaceChildren(); };
async function get(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  return response.json();
}
function renderStatus(status) {
  $('pool-count').textContent = nf.format(status.counters.pools);
  $('snapshot-count').textContent = nf.format(status.counters.snapshots);
  $('last-poll').textContent = ago(status.latestSuccessAt);
  const q = status.quality24h;
  $('success-rate').textContent = Number(q.runs) ? `${Math.round(100 * q.successful / q.runs)}%` : '—';
  const chip = $('connection');
  const stale = !status.latestSuccessAt || Date.now() - Date.parse(status.latestSuccessAt) > 120000;
  chip.className = 'chip ' + (stale ? 'warn' : 'ok');
  chip.textContent = stale ? 'Collector stale / starting' : 'Collector online';
  const list = [
    ['Source', 'GeckoTerminal REST'],
    ['Last run', status.latestRun?.status || 'none'],
    ['Last run started', time(status.latestRun?.started_at)],
    ['Latest snapshot', time(status.newestSnapshotAt)],
    ['Failed / partial (24h)', String(q.unsuccessful)],
    ['Raw responses stored', nf.format(status.counters.raw_responses)],
    ['On-chain ticks', 'Not available in S1 MVP']
  ];
  const quality = $('quality'); quality.replaceChildren();
  for (const [key, value] of list) {
    const dt = document.createElement('dt'); dt.textContent = key;
    const dd = document.createElement('dd'); dd.textContent = value;
    quality.append(dt, dd);
  }
  clear('venues');
  for (const item of status.coverage) {
    const row = document.createElement('div'); row.className = 'venue-row';
    const label = document.createElement('span'); label.textContent = item.venue_family;
    const count = document.createElement('strong'); count.textContent = nf.format(item.count);
    row.append(label, count); $('venues').append(row);
  }
}
function renderPools(rows) {
  clear('pool-rows');
  if (!rows.length) { const row = document.createElement('tr'); cell(row, 'No pools observed yet. Check collector status.').colSpan = 7; $('pool-rows').append(row); return; }
  for (const pool of rows) {
    const row = document.createElement('tr'); row.dataset.address = pool.pool_address;
    const first = cell(row, pool.name || 'Unnamed pool'); first.className = 'pool-link';
    const addr = document.createElement('small'); addr.className = 'address'; addr.textContent = pool.pool_address.slice(0, 8) + '…' + pool.pool_address.slice(-6); first.append(addr);
    cell(row, pool.venue_family).className = 'venue';
    cell(row, time(pool.first_seen_at));
    cell(row, pool.discovery_lag_seconds == null ? '—' : `${Math.round(Number(pool.discovery_lag_seconds))}s`);
    cell(row, money(pool.last_liquidity_usd));
    cell(row, money(pool.last_price_usd));
    cell(row, money(pool.last_volume_h24_usd));
    row.addEventListener('click', () => showSnapshots(pool).catch(console.error));
    $('pool-rows').append(row);
  }
}
async function showSnapshots(pool) {
  $('selected-text').textContent = `${pool.name || 'Pool'} | ${pool.pool_address}`;
  const response = await get(`/api/pools/${encodeURIComponent(pool.pool_address)}/snapshots?limit=40`);
  clear('snapshot-rows');
  for (const snap of response.rows) {
    const row = document.createElement('tr');
    cell(row, time(snap.observed_at)); cell(row, money(snap.liquidity_usd));
    cell(row, money(snap.price_usd)); cell(row, money(snap.volume_m5_usd));
    $('snapshot-rows').append(row);
  }
}
function renderRuns(rows) {
  clear('run-rows');
  for (const item of rows) {
    const row = document.createElement('tr');
    cell(row, time(item.started_at)); cell(row, item.status);
    cell(row, item.pages_fetched); cell(row, item.newly_discovered);
    $('run-rows').append(row);
  }
}
async function refresh() {
  const family = $('filter').value;
  const [status, pools, runs] = await Promise.all([
    get('/api/status'), get(`/api/pools?limit=150&family=${encodeURIComponent(family)}`), get('/api/runs?limit=12')
  ]);
  renderStatus(status); renderPools(pools.rows); renderRuns(runs.rows);
}
$('filter').addEventListener('change', () => refresh().catch(console.error));
await refresh().catch(error => {
  const chip = $('connection'); chip.textContent = `Error: ${error.message}`; chip.className = 'chip warn';
});
setInterval(() => refresh().catch(error => {
  const chip = $('connection'); chip.textContent = `Error: ${error.message}`; chip.className = 'chip warn';
}), 15000);
