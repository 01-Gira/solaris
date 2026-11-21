# S1b.1 Decoder V2 candidate stage

Following the read-only 1,000-event forensic report (621 unsupported; 299 ambiguous; 80 on-chain failures), a new **versioned candidate-only** pass is available. It does not make swap/fill claims. It uses only known Pump.fun and PumpSwap buy/sell instruction discriminators. The overwhelming Meteora DAMM v2 program presence requires separate validated official IDL/account-level research before implementation; do not assume every observed Meteora program instruction is a swap.

The V2 candidate processor adds `onchain_trade_candidate_v2`; it **never** changes `onchain_trade_decodes` V1 or original Solana transaction/event evidence. The table enforces `verified_fill=false` and `economics_authorized=false`. Candidate count 1 means **only one recognized discriminator** was observed, not that there was a verified swap for the watched pool. Multiple candidate instructions stay unverified. Unrecognized/Meteora instructions remain unknown; failed `meta.err` transactions are never converted into fills.

## Staged execution

```bash
git pull --ff-only origin main
npm test
npm run check

docker-compose -f compose.yaml -f compose.s1b1.yaml \
  run --rm --build -T decode node src/s1b1/v2-run.js
```

Default processes up to 1000 previously unprocessed hydrated event rows. Optional `S1B1_V2_LIMIT` can be set in local `.env` between 1 and 10000. This consumes no Codex calls and no RPC calls. S1b streamer and detached hydration continue running; do not remove orphan containers.

## Inspect candidate classifications without AI

```bash
docker-compose exec -T db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT status,count(*) AS event_rows,sum(trade_candidate_count) AS recognized_instructions
FROM onchain_trade_candidate_v2
GROUP BY status ORDER BY event_rows DESC;
SQL
```

All classifications are diagnostics; do not use them for PnL or strategy performance. Future work requires audited Meteora IDLs, account ownership checks, inner vs outer instruction reconciliation, *per-instruction* transfer attribution and independent manual validation against held-out real transactions. Current S3 gate remains `BLOCKED_DATA` and economics is unauthorized.
