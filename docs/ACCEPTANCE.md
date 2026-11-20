# S1 acceptance gates & follow-up research

## S1a — Public API ingestion (what is implemented in this package)

### Offline acceptance (can run without Docker)

- `npm test` passes for fixture normalization, response hashing, pagination URL, provider failures, 429 backoff, basic HTTP paths and read-only behavior.
- `npm run check` succeeds.
- No private key, signing, swap, or trading endpoints are included.

### Integration acceptance (requires Docker and real outbound internet; NOT yet certified)

1. `docker compose up -d --build` starts healthy PostgreSQL + recorder containers.
2. `/healthz` returns `{ "ok": true, "readOnly": true }`.
3. `/api/status` advances after multiple polls and latest run status is `success`.
4. Pool count increments only for truly new pool addresses; periodic results do not count as newly discovered.
5. For a pool with repeated observations, snapshots carry distinct times and can be exported as CSV.
6. 429 response results in `failed`/`partial` poll and backoff, not a fake zero-pool success.
7. Confirm actual venue IDs for Pump.fun, PumpSwap, Raydium, and Meteora and document distribution/coverage. A missing venue is NOT evidence it has no launches.
8. Reconcile 50 randomly selected pool addresses, creation time and price/liquidity values with provider website/API.
9. Run a controlled 24-hour soak: zero unhandled crashes, successful reconnect following transient failures, and trend of raw response hashes / poll timestamps.
10. Measure delayed discovery against independent transaction feed and quantify the percentage missed before advancing to strategy research.

### Suggested minimum initial quality thresholds (proposed, not achieved)

- 24-hour polling success >= 98% after excluding a properly documented provider outage window.
- 0 duplicate `pools.pool_address` and 0 duplicate `(poll_run_id, pool_address)` snapshots.
- At least 95% of provider-returned records with valid Solana addresses and parseable fields; any missed records documented.
- Exactly 100% of buy/sell and volume values described as provider rolling window aggregates rather than distinct transactions.
- Provider-backed pool freshness and gap metrics reported alongside strategy research.

## S1b — On-chain stream, higher fidelity (NOT implemented)

1. Connect paid Solana Geyser/gRPC or transaction stream (Helius LaserStream, Yellowstone-compatible), or dedicated WebSocket provider.
2. Identify and version program IDs for Pump.fun bonding curve, PumpSwap AMM, Raydium CPMM/CLMM, Meteora DLMM and others through official IDLs/docs.
3. Decode pool-create and swap events with fixture-covered versioned decoders, not regex on log text alone.
4. Capture `slot`, `signature`, `block_time`, `tx_index` (where provided), event ordinal and ingest time with provenance and finality level.
5. Replay missed slot ranges, handle fork/reorg, resubscribe with heartbeat/backoff, and enforce idempotency (`signature`, instruction/event position, program ID).
6. Cross-check minute-by-minute counts and token launch distributions against an independent source before calling coverage exhaustive.
7. Add bounded market historical backfill, storage partitioning, retention and data export to Parquet.
8. Set strict raw-to-normalized reproducibility tests and continuous quality checks: delayed events, gap durations, decode error rates, dropped-event counts.

**Go/no-go:** Do not call historical backtest realistic until high-fidelity market data, survivorship-free universe, and executable price/fee assumptions are established.
