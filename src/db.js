import pg from 'pg';
import { readFile } from 'node:fs/promises';

export function createPool(dbUrl) {
  return new pg.Pool({ connectionString: dbUrl, max: 8, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
}

export async function migrate(pool) {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

export async function startRun(db) {
  const { rows } = await db.query('INSERT INTO poll_runs DEFAULT VALUES RETURNING id');
  return rows[0].id;
}

export async function finishRun(db, id, status, counters, error) {
  await db.query(`UPDATE poll_runs SET ended_at = now(), status = $2,
      pages_fetched = $3, pools_seen = $4, newly_discovered = $5,
      duplicate_in_run = $6, error = $7 WHERE id = $1`,
    [id, status, counters.pages, counters.seen, counters.newPools, counters.duplicates, error ? String(error).slice(0, 2000) : null]);
}

export async function savePage(db, runId, page, knownThisRun) {
  const client = await db.connect();
  let newlyDiscovered = 0;
  let duplicates = 0;
  let saved = 0;
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO raw_responses
      (poll_run_id,provider,endpoint,page,fetched_at,response_sha256,pool_count,payload,raw_body)
      VALUES ($1,'geckoterminal',$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [runId, page.endpoint, page.page, page.fetchedAt, page.sha256, page.pools.length, JSON.stringify(page.payload), page.rawBody]);
    for (const item of page.pools) {
      if (knownThisRun.has(item.address)) { duplicates++; continue; }
      // First insert uses DO NOTHING so NEW is counted correctly under concurrent data.
      const inserted = await client.query(`INSERT INTO pools
        (pool_address,source_pool_id,dex_id,venue_family,name,base_mint,quote_mint,base_symbol,quote_symbol,
         pool_created_at,first_seen_at,last_seen_at,last_price_usd,last_liquidity_usd,last_volume_h24_usd,
         last_buys_m5,last_sells_m5,last_raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$15,$16,$17::jsonb)
        ON CONFLICT (pool_address) DO NOTHING RETURNING pool_address`,
        [item.address,item.sourcePoolId,item.dexId,item.family,item.name,item.baseMint,item.quoteMint,
         item.baseSymbol,item.quoteSymbol,item.createdAt,page.fetchedAt,item.priceUsd,item.liquidityUsd,
         item.volumeH24Usd,item.buysM5,item.sellsM5,JSON.stringify(item.sourceData)]);
      if (inserted.rowCount === 1) newlyDiscovered++;
      else await client.query(`UPDATE pools SET
        source_pool_id=COALESCE($2,source_pool_id),dex_id=COALESCE($3,dex_id),venue_family=$4,
        name=COALESCE($5,name),base_mint=COALESCE($6,base_mint),quote_mint=COALESCE($7,quote_mint),
        base_symbol=COALESCE($8,base_symbol),quote_symbol=COALESCE($9,quote_symbol),
        pool_created_at=COALESCE($10,pool_created_at),last_seen_at=$11,
        last_price_usd=$12,last_liquidity_usd=$13,last_volume_h24_usd=$14,
        last_buys_m5=$15,last_sells_m5=$16,last_raw=$17::jsonb
        WHERE pool_address=$1`,
        [item.address,item.sourcePoolId,item.dexId,item.family,item.name,item.baseMint,item.quoteMint,
         item.baseSymbol,item.quoteSymbol,item.createdAt,page.fetchedAt,item.priceUsd,item.liquidityUsd,
         item.volumeH24Usd,item.buysM5,item.sellsM5,JSON.stringify(item.sourceData)]);
      await client.query(`INSERT INTO pool_snapshots
        (pool_address,poll_run_id,observed_at,price_usd,liquidity_usd,volume_h24_usd,volume_m5_usd,
         buys_m5,sells_m5,source_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [item.address,runId,page.fetchedAt,item.priceUsd,item.liquidityUsd,item.volumeH24Usd,
         item.volumeM5Usd,item.buysM5,item.sellsM5,JSON.stringify(item.sourceData)]);
      knownThisRun.add(item.address);
      saved++;
    }
    await client.query('COMMIT');
    return { newlyDiscovered, duplicates, saved };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function pickWatchlist(db, exclude, limit) {
  if (limit <= 0) return [];
  const { rows } = await db.query(`SELECT pool_address FROM pools
    WHERE NOT (pool_address = ANY($1::text[]))
      AND first_seen_at >= now() - interval '2 hours'
    ORDER BY last_seen_at ASC, first_seen_at DESC LIMIT $2`,
    [Array.from(exclude), limit]);
  return rows.map(row => row.pool_address);
}
