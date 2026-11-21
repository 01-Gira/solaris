# SOLARIS V2.11 — Cohort Quality and Integrity Audit

The November 21 V2 cohort expanded from 1,000 to **7,753 classified event rows / 7,755 hydrated event rows (99.97% at the snapshot)**. It covers **78 unique watched pools**, but event concentration remains high: largest pool 16.35%, top three 40.87%, effective event-weighted pools 12.35. There are 7,724 block-time events from Nov 20–21, 2026, and 29 from Aug 25–26, 2024. One PumpSwap pool accounted for 1,125 of its venue's 1,131 failed-on-chain event rows. None of these are verified fills.

V2.11 diagnoses **cohort-specific** data quality:
- Group `single_trade_candidate` by pool and block date; calculate effective pool count **for candidates only**, separately from the overall cohort.
- Group `failed_onchain` by pool and **sanitized Solana `meta.err` error family/code** to identify one repeatedly failing transaction source. A failed transaction is **not** a strategy loss.
- Compare stored signature, slot, block-time and error metadata against the original stored RPC payload. Check watched pool creation/first-seen timestamps as *possible* anomalies, not hard correctness rules.
- Measure block-time-to-observation lag, including late historical transactions; preserve block date and received date, never automatically interpret 2024 transactions as corrupted.
- Report only aggregated counts and 16-character SHA-256 prefixes of pool/signature, no raw transaction payloads, secrets, addresses, token quantities, executable prices or PnL.

## Run (read-only, existing data only)

```bash
git pull --ff-only origin main
npm test
npm run check
docker-compose -f compose.yaml -f compose.s1b1.yaml \
 run --rm --build -T decode node src/s1b1/v211-report.js
```

Default report scans up to 10,000 already-classified V2 event rows, configurable by `S1B1_V211_LIMIT` 1–100,000. PostgreSQL uses `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`. No schema migration, no RPC or Codex calls, and no impact on running stream/hydration. Ignore Compose orphan warnings; do not remove running collector/hydration containers.

Read `candidatePoolConcentration`, `candidateByBlockDay`, `failedByErrorFamily`, `topFailedPools`, `integrityFlags`, `oldBackfillAgeGt30dEventRows`, and `oldExamples`. A positive structural attribution result, an old transaction, or a Solana error code **does not establish an executed profitable trade**.

Next decision: require independent reviewed transaction fixtures and at least distinct temporal/pool holdout periods. Remaining 2024-era rows should be investigated for valid signatures and pool dates, **not deleted or silently excluded**. S3 remains `BLOCKED_DATA`, `verifiedFills=0`, `economicsAuthorized=false`, `liveTrading=false`.
