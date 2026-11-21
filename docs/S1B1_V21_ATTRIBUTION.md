# SOLARIS S1b.1 V2.1 — Candidate attribution audit

This is a **diagnostic** stage after a fixed 1,000-event V2 batch: 621 no_known_program, 188 single_trade_candidate, 111 unverified_program_usage, 80 failed_onchain. The join by venue shows 158 Pump.fun, 29 PumpSwap, and **one Meteora-labeled pool** among the 188 trade candidates.

The critical distinction is **observed pool vs program present in the transaction**. A Pump.fun discriminator in an event associated with Meteora is not proof of a trade on that Meteora pool.

## What V2.1 checks

- Each previously classified `single_trade_candidate` is evaluated against the persisted raw Solana transaction.
- Re-reads outer and inner parsed instructions, recognizing only the existing Pump.fun / PumpSwap candidate discriminators.
- Matches the watched pool address against candidate instruction accounts.
- Reports whether the address is at the **legacy V1 account-index hint** (Pump.fun index 3, PumpSwap index 0). These positions **have not independently passed a complete current IDL/account-layout audit**.
- Checks whether the legacy signer account is marked as a transaction signer when parsed signer metadata exists.
- Checks whether transaction signatures, metadata, and execution status are consistent.
- Aggregates results by observed venue, candidate program, scope (outer/inner), status, and signer hint. Examples include only SHA-256 prefixes.

**These are hints, not verified trades.** No instruction-level transfer attribution, token balance analysis, actual account-layout validation, financial return, price, direction or fill assertion is made. The report always prints `verifiedFills:0`, `economicsAuthorized:false`, and `liveTrading:false`.

## Run on macOS / Colima

```bash
git pull --ff-only origin main
npm test
npm run check

docker-compose -f compose.yaml -f compose.s1b1.yaml \
  run --rm --build -T decode node src/s1b1/v21-report.js
```

The report selects at most 1,000 previously stored V2 `single_trade_candidate` rows by event ID, with an explicit PostgreSQL `BEGIN READ ONLY` transaction. You can set `S1B1_V21_LIMIT` between 1 and 10,000 in local `.env`. No Codex, no RPC, no schema migration, no write to any table, no restart of S1b stream or hydration.

## Go/no-go for later instruction-level verification

- **Meteora:** inspect the one cross-venue candidate; classify it as *not attributable* unless exact pool account evidence is available.
- **Pump.fun and PumpSwap:** first validate the current deployed program's account positions against official, version-specific IDLs and public transaction fixtures. A legacy index match alone is not enough.
- **Only after independent fixture review:** test per-instruction token movement and instruction hierarchy; whole-transaction token balance delta can include other swaps or transfers and must not be reported as a fill price.
- Keep S3 `BLOCKED_DATA`, original data and V1/V2 evidence immutable.

Do **not** use `docker-compose --remove-orphans` or delete volumes. Existing streamer and hydration processes are intentionally separate and are not orphans to clean up.
