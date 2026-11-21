# SOLARIS V2.13 — Provider creation timestamp provenance

V2.12 established 1,108 `Custom:6040` failures genuinely logged by PumpSwap (official IDL: `BuySlippageBelowMinBaseAmountOut`), and 29 historical Pump.fun event rows from Aug 25–26 2024 with transaction pool-address evidence, all associated with a pool record whose `pool_created_at` is 2026-11-21.

**Cause of the timestamp ambiguity:** SOLARIS `normalizeGeckoResponse` reads `attributes.pool_created_at` from GeckoTerminal. `db.savePage` can **update** the current `pools.pool_created_at` on later provider observations. Therefore the current field is **mutable provider metadata, not a verified on-chain creation time**. `pools.first_seen_at` records when our collector discovered the pool, not its creation. The `pool_snapshots.source_data` payload preserves historic provider values and can show if they changed between polls, but snapshots still cannot establish authoritative chain time.

V2.13 is a read-only reconciliation for historically observed pools (transaction block time more than 30 days before execution):
- Compare the oldest saved on-chain transaction date to current provider creation metadata.
- Compare the earliest and latest saved provider creation timestamps and count their distinct values.
- Distinguish provider value changes from a stable (but possibly incorrect) creation timestamp.
- Retain hash-only pool identifiers, no raw signatures, wallet addresses or token quantities.
- Leave historical cohort blocked for economic studies until independent time+pool identity evidence is obtained.

## Run

```bash
git pull --ff-only origin main
npm test
npm run check

docker-compose -f compose.yaml -f compose.s1b1.yaml \
  run --rm --build -T decode node src/s1b1/v213-report.js
```

Uses PostgreSQL `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`. Default limit 1,000 historical pools; `S1B1_V213_LIMIT` allows 1–10,000. Reads existing `onchain_pool_events`, `onchain_transactions`, `pools`, and `pool_snapshots` only. No schema modifications, external RPC, Codex, restarts, deletions or trading.

**Important:** do not delete or rewrite the 29 historical rows; do not backdate the pool creation timestamp without evidence. The V2.11 flag `pool_discovered_before_tx_blocktime_gt_5min` is expected for transactions after discovery and should **not** be treated as corruption. `verifiedFills=0`, `economicsAuthorized=false`, `liveTrading=false`, S3 `BLOCKED_DATA`.

## V2.13.1 correction — PostgreSQL JSONB null

The initial V2.13 report incorrectly counted all 29 historical rows as failed because `onchain_transactions.tx_error` stores JSONB `'null'` for successful RPC calls: `tx_error IS NOT NULL` is **true** for JSONB null. V2.13.1 counts explicit non-null JSONB as failed, JSONB `'null'` as successful transactions, and SQL NULL as unknown; an assertion rejects any status partition not matching the historical event total. This aligns with V2/V2.12 reporting 23 failed + 6 successful transaction candidates among the 29 historical records. Successful transactions are **not necessarily verified swaps**.

One provider snapshot with one date cannot demonstrate stability. The corrected report labels it `insufficient_comparable_provider_snapshots`, reporting comparable snapshot count explicitly. A consistent date on two or more snapshots still represents provider metadata, not on-chain creation proof.

Run the same V2.13 command after updating to main; do not rewrite original transactions or provider snapshots. Keep economic authorization blocked.
