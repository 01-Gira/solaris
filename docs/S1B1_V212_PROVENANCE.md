# SOLARIS S1b.1 V2.12 — PumpSwap 6040 and historical provenance

The 2026-11-21 V2.11 read-only audit covered 7,753 classified event rows. It found 1,834 failed Solana transactions, 1,108 failed `InstructionError:Custom:6040` events concentrated in one PumpSwap-labelled watched pool, 29 events observed in 2026 but with actual block dates Aug 25–26, 2024, and 277 `pool_discovered_before_tx_blocktime_gt_5min` flags. The last flag is **normally expected** when a watched pool continues trading after discovery; it is not a chain integrity anomaly.

Official public PumpSwap IDL `pump-fun/pump-public-docs/idl/pump_amm.json` (Git blob `d907b16a91f035aeb3c3182bfa0972a91bf23a86`) defines 6040 as `BuySlippageBelowMinBaseAmountOut`: BUY output lower than the specified minimum. **However the watched pool venue is not necessarily the failing program.** Before applying this interpretation to events, confirm the outer instruction index in `meta.err.InstructionError[0]`, the outer instruction program ID, and optional matching Solana `logMessages`. Logs indicating a nested PumpSwap invocation are separated from direct PumpSwap outer failures.

Historical data from a bounded recovery may be valid and old, but must be disentangled from the *pool record's creation time*. Check whether the watched pool appears at a supported Pump.fun/PumpSwap trade instruction pool index, only another instruction position, the transaction account keys, or nowhere. A transaction mentioning a watched address is not automatically a swap in that pool. `pool.first_seen_at` measures discovery, not creation. `pool_created_at` is a provider-derived datum requiring corroboration before declaring data corruption.

## Run

```bash
git pull --ff-only origin main
npm test
npm run check

docker-compose -f compose.yaml -f compose.s1b1.yaml \
  run --rm --build -T decode node src/s1b1/v212-report.js
```

V2.12 uses PostgreSQL `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`, a deterministic maximum of 10,000 already-classified events by default (`S1B1_V212_LIMIT` range 1..100000). No schema changes, no RPC or Codex calls, no changes to original V1/V2 decodes, and no disturbance to stream/hydration processes. Output identifiers are shortened SHA-256 hashes; no raw account addresses or signatures.

Pay attention to `byError6040ProgramEvidence`, `historicalPoolCreatedVsBlockDay`, and `historicalPoolReferenceEvidence`. A `pumpswap_failed_6040_log` corroborates a specific error origin; **it does not make a trade profitable or an unsuccessful transaction a fill**. Unresolved historical transactions remain excluded from economic authority until independently validated. S3 stays `BLOCKED_DATA`; `verifiedFills=0`, `economicsAuthorized=false`, and `liveTrading=false`.
