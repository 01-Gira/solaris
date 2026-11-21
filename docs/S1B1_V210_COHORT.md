# SOLARIS S1b.1 V2.10 — Cohort Coverage / Independence Audit

The 2026-11-21 V2.9 report selected 188 already-classified event rows: 29 PumpSwap candidates had four structurally matched transfer legs, 158 Pump.fun were out of V2.9 scope, and one Meteora-associated event failed pool attribution. **These 188 rows are neither an independent sample of 188 pools nor an unbiased selection of Solana swaps.** The V2 candidate runner processes available transactions in event ID order and has a default bound of 1,000 rows; V2.1–V2.9 reports consequently examine the available candidate subset. Subsequent stream/hydration data can grow without being classified by V2 automatically.

V2.10 audits the *sampling frame* before promoting price, fee, PnL or strategy claims:
- Counts total S1b event rows, event rows with an existing hydrated transaction, and event rows already classified by the exact V2 candidate version. Denominators count pool/signature event pairs, **not** unique swaps.
- Reports **unique pools**, **unique transaction signatures**, top-one and top-three event concentration, event-share-based effective pool count, source (live vs bounded backfill), by-status/by-venue counts, earliest/latest block date and number of distinct block days.
- Shows the most repeated observed pools only by SHA-256 prefixes; never exports raw pool addresses or signatures.
- Tags whether all currently V2-classified rows were included. Early event-ID ordered samples are **not random, representative, or independent**.
- No changes to V1/V2 results; no price, costs, fills, strategy metrics or S3 economic authorization.

## Run on Mac / Colima

```bash
git pull --ff-only origin main
npm test
npm run check

docker-compose -f compose.yaml -f compose.s1b1.yaml \
  run --rm --build -T decode node src/s1b1/v210-report.js
```

Default scans up to 10,000 *already V2-classified* event rows in stable event-ID order (optional `S1B1_V210_LIMIT` 1..100000). The report uses PostgreSQL `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`. It makes no RPC, Codex or additional inference requests; no table writes; no stream/hydration restart.

Look at `sampling.hydratedEventRows` compared with `sampling.v2ClassifiedEventRows`, `uniquePools`, `uniqueSignatures`, `concentration`, and `timeCoverage`. **Do not confuse 187 matched candidate account/transfer traces with 187 independently validated fills.** A limited number of correlated pools or historical days can invalidate a general claim regardless of how well those internal instruction traces appear to match.

## Next decisions

If V2 classification only covers a small fraction of hydrated events, extend the **existing bounded offline candidate processing** with version-pinned and immutable evidence rather than repeatedly evaluating the same first 188 rows. When broadening the cohort, preserve temporal separation, pool-group separation, deterministic negative controls, and old evidence. Per-instruction price and fee validation still requires individual manually reviewed transaction fixtures, correct WSOL/native SOL wrap/unwrap, net fees/rent and audited account semantics.

S3 remains `BLOCKED_DATA`; `verifiedFills=0`, `economicsAuthorized=false`, `liveTrading=false`.
