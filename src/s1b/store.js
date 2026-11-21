import { readFile } from 'node:fs/promises';
import { extractTokenBalanceChanges, validSignature } from './parse.js';

export async function migrateS1b(db) {
  await db.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
}

export async function selectPools(db, maxPools, maxAgeMinutes) {
  const { rows } = await db.query(`SELECT pool_address FROM pools
    WHERE first_seen_at >= now() - ($2::int * interval '1 minute')
    ORDER BY first_seen_at DESC LIMIT $1`, [maxPools, maxAgeMinutes]);
  return rows.map(r => r.pool_address);
}

export async function latestSignature(db, poolAddress) {
  const { rows } = await db.query(`SELECT signature FROM onchain_pool_events WHERE pool_address=$1
    ORDER BY slot DESC, id DESC LIMIT 1`, [poolAddress]);
  return rows[0]?.signature ?? null;
}

export async function recordEvent(db, event) {
  // Two pools may refer to one signature. Event identity includes the watched pool.
  await db.query(`INSERT INTO onchain_pool_events
    (pool_address,signature,slot,notification_error,logs,source)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
    ON CONFLICT(pool_address,signature) DO UPDATE SET
      last_received_at=now(),
      slot=GREATEST(onchain_pool_events.slot,EXCLUDED.slot),
      source=CASE WHEN EXCLUDED.source='live' THEN 'live' ELSE onchain_pool_events.source END,
      notification_error=COALESCE(EXCLUDED.notification_error,onchain_pool_events.notification_error),
      logs=CASE WHEN jsonb_array_length(EXCLUDED.logs)>0 THEN EXCLUDED.logs ELSE onchain_pool_events.logs END`,
    [event.poolAddress, event.signature, event.slot,
      JSON.stringify(event.error), JSON.stringify(event.logs), event.source]);
  await db.query(`UPDATE onchain_stream_health SET last_event_at=now() WHERE singleton=true`);
}

export async function setHealth(db, state, activePools, lastError = null, hydrationMode = 'inline') {
  await db.query(`INSERT INTO onchain_stream_health(singleton,state,active_pools,last_error,hydration_mode)
    VALUES(true,$1,$2,$3,$4) ON CONFLICT(singleton) DO UPDATE SET
    state=EXCLUDED.state,active_pools=EXCLUDED.active_pools,last_error=EXCLUDED.last_error,
    hydration_mode=EXCLUDED.hydration_mode,heartbeat_at=now()`, [state, activePools, lastError?.slice(0, 250) ?? null,hydrationMode]);
}

export async function beginRecovery(db, poolAddress, previousSignature) {
  const { rows } = await db.query(`INSERT INTO onchain_recovery_audits
    (pool_address,previous_signature,status) VALUES($1,$2,'running') RETURNING id`,
  [poolAddress, previousSignature]);
  return rows[0].id;
}

export async function finishRecovery(db, id, status, recoveredCount, details) {
  await db.query(`UPDATE onchain_recovery_audits SET ended_at=now(),status=$2,
    recovered_count=$3,details=$4 WHERE id=$1`,
  [id, status, recoveredCount, String(details || '').slice(0, 400)]);
}

export async function pendingSignatures(db, limit) {
  const { rows } = await db.query(`SELECT signature, MAX(tx_attempts) AS attempts
    FROM onchain_pool_events WHERE tx_status='pending' AND next_retry_at<=now()
    GROUP BY signature ORDER BY MIN(first_received_at) ASC LIMIT $1`, [limit]);
  return rows;
}

export async function saveTransaction(db, signature, tx) {
  const message=tx?.transaction?.message,meta=tx?.meta;
  const blockTime=tx?.blockTime==null?null:new Date(tx.blockTime*1000);
  if (!Number.isSafeInteger(tx?.slot) || tx.slot < 0 || !validSignature(signature) ||
      !Array.isArray(tx.transaction?.signatures) || tx.transaction.signatures[0]!==signature ||
      !Array.isArray(message?.instructions) || !Array.isArray(message?.accountKeys) ||
      meta?.err===undefined || (meta.err!==null && typeof meta.err!=='string' &&
       (typeof meta.err!=='object' || Array.isArray(meta.err))) ||
      !Number.isSafeInteger(meta.fee) || meta.fee<0 ||
      (blockTime!==null && (!Number.isSafeInteger(tx.blockTime) || !Number.isFinite(blockTime.getTime()))))
    throw new Error('Incomplete RPC transaction response');
  const changes = extractTokenBalanceChanges(tx);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted=await client.query(`INSERT INTO onchain_transactions
      (signature,slot,block_time,tx_error,fee_lamports,payload)
      VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb)
      ON CONFLICT(signature) DO NOTHING`,
    [signature, tx.slot, blockTime, JSON.stringify(meta.err), meta.fee, JSON.stringify(tx)]);
    for (const b of inserted.rowCount===1?changes:[]) {
      await client.query(`INSERT INTO onchain_token_balance_changes
        (signature,account_index,mint,owner,program_id,decimals,pre_amount,post_amount,delta_raw)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [signature,b.accountIndex,b.mint,b.owner,b.programId,b.decimals,b.pre,b.post,b.deltaRaw]);
    }
    await client.query(`UPDATE onchain_pool_events
      SET tx_status='resolved',last_fetch_error=NULL WHERE signature=$1 AND tx_status='pending'`, [signature]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function markTransactionRetry(db, signature, attempts, maxAttempts, message, retryAfterMs = 0) {
  const nextAttempt = Number(attempts) + 1;
  const exhausted = nextAttempt >= maxAttempts;
  const delayMs = Math.max(retryAfterMs, Math.min(300000, 5000 * 2 ** Math.min(8, nextAttempt - 1)));
  await db.query(`UPDATE onchain_pool_events SET
    tx_status=CASE WHEN $2::boolean THEN 'unavailable' ELSE 'pending' END,
    tx_attempts=$3,
    next_retry_at=now() + ($4::bigint * interval '1 millisecond'),
    last_fetch_error=$5
    WHERE signature=$1 AND tx_status='pending'`,
  [signature, exhausted, nextAttempt, delayMs, String(message).slice(0, 300)]);
  return { nextAttempt, exhausted, delayMs };
}

export async function beginWatch(db, address, anchor) {
  const { rows } = await db.query(`INSERT INTO onchain_watch_sessions
    (pool_address,previous_signature) VALUES($1,$2) RETURNING id`, [address,anchor]);
  return rows[0].id;
}

export async function finishWatch(db, ids, reason) {
  if (!ids.length) return;
  await db.query(`UPDATE onchain_watch_sessions SET ended_at=now(),
    state='ended',end_reason=$2 WHERE id=ANY($1::bigint[]) AND ended_at IS NULL`,
  [ids, String(reason).slice(0,120)]);
}
