-- SOLARIS S1b one-time requeue for transactions rejected solely because the
-- RPC request declared an unsupported max transaction version (-32015).
-- Stop the `stream` service first; do not run this while a worker is hydrating.
-- This script never deletes events or overwrites hydrated transaction records.
BEGIN;
WITH failed_signatures AS (
  SELECT DISTINCT e.signature
  FROM onchain_pool_events e
  WHERE e.tx_status IN ('pending', 'unavailable')
    AND e.last_fetch_error LIKE 'RPC getTransaction: RPC error -32015%'
    AND NOT EXISTS (
      SELECT 1 FROM onchain_transactions t WHERE t.signature = e.signature
    )
), requeued AS (
  UPDATE onchain_pool_events e
  SET tx_status = 'pending',
      tx_attempts = 0,
      next_retry_at = now(),
      last_fetch_error = NULL
  WHERE e.signature IN (SELECT signature FROM failed_signatures)
    AND e.tx_status IN ('pending', 'unavailable')
  RETURNING e.signature
)
SELECT COUNT(*) AS requeued_event_rows,
       COUNT(DISTINCT signature) AS requeued_unique_signatures
FROM requeued;
COMMIT;
