// SOLARIS read-only S1b hydration diagnostic.
// All event-level comparisons are anchored to onchain_pool_events rows.
// Do not confuse distinct transaction rows with event rows or declare missing
// transaction records failed on-chain. This query never mutates S1b state.
export const HYDRATION_SQL = `
SELECT
  COUNT(*)::integer AS event_rows,
  COUNT(DISTINCT e.signature)::integer AS unique_event_signatures,
  COUNT(*) FILTER (WHERE t.signature IS NOT NULL)::integer AS hydrated_event_rows,
  COUNT(*) FILTER (WHERE t.signature IS NULL)::integer AS missing_event_rows,
  COUNT(*) FILTER (WHERE e.tx_status='pending')::integer AS pending_event_rows,
  COUNT(*) FILTER (WHERE e.tx_status='resolved')::integer AS resolved_event_rows,
  COUNT(*) FILTER (WHERE e.tx_status='unavailable')::integer AS unavailable_event_rows,
  COUNT(*) FILTER (
    WHERE e.tx_status='pending' AND e.tx_attempts=0
  )::integer AS pending_unattempted_event_rows,
  COUNT(*) FILTER (
    WHERE e.tx_status='pending' AND e.next_retry_at<=now()
  )::integer AS retry_eligible_event_rows,
  EXTRACT(EPOCH FROM (now() - MIN(e.first_received_at) FILTER (
    WHERE e.tx_status='pending'
  )))::double precision AS oldest_pending_age_seconds,
  COUNT(*) FILTER (
    WHERE e.first_received_at >= now() - interval '5 minutes'
  )::integer AS new_event_rows_last_5m,
  COUNT(*) FILTER (
    WHERE t.fetched_at >= now() - interval '5 minutes'
  )::integer AS hydrated_event_rows_last_5m,
  (SELECT COUNT(*)::integer FROM onchain_transactions) AS stored_transaction_rows
FROM onchain_pool_events e
LEFT JOIN onchain_transactions t ON e.signature=t.signature
`;
const numericFields=[
 'event_rows','unique_event_signatures','hydrated_event_rows','missing_event_rows',
 'pending_event_rows','resolved_event_rows','unavailable_event_rows',
 'pending_unattempted_event_rows','retry_eligible_event_rows',
 'oldest_pending_age_seconds','new_event_rows_last_5m',
 'hydrated_event_rows_last_5m','stored_transaction_rows'
];
export function normalizeHydrationMetrics(row){
 if(!row || typeof row!=='object') return null;
 const normalized={};
 for(const field of numericFields){
  const value=row[field];
  if(value===undefined||value===null||value===''){normalized[field]=null;continue;}
  const n=Number(value);
  normalized[field]=Number.isFinite(n)&&n>=0?n:null;
 }
 // Context reporting is only accepted if the denominator is a real event count.
 if(normalized.event_rows===null || normalized.hydrated_event_rows===null) return null;
 if(normalized.hydrated_event_rows>normalized.event_rows) return null;
 if(normalized.missing_event_rows!==null&&normalized.missing_event_rows+
   normalized.hydrated_event_rows!==normalized.event_rows) return null;
 return normalized;
}
export async function fetchHydrationMetrics(db){
 const result=await db.query(HYDRATION_SQL);
 return normalizeHydrationMetrics(result.rows?.[0]);
}
