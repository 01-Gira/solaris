# SOLARIS S1b.1 V2.15 — Raw Token Amount Consistency (read-only)

## Basis

V2.14 production run on 2026-11-21 classified 1,429 V2 single-candidate event rows:
- 1,267 Pump.fun not considered by PumpSwap-specific audit.
- **124 / 125 PumpSwap** were compatible with required structural routing edges (76 non-WSOL, 48 WSOL).
- 31 watched-pool mismatches, six historical unparseable account layouts, and one unparsed transfer remained blocked.
- All 124 PumpSwap candidates had one checked base, quote, protocol-token-recipient (fixed IDL account 10) and one unknown remaining-recipient edge; 19 also had an edge to creator vault (fixed IDL account 17). These are structural counts, NOT verified fees/fills/amounts.

## V2.15 scope and limitations

The first V2.15 pass compares `transferChecked` integer raw amounts across **all transaction instructions** to **whole-transaction pre/post token-account changes** for four fixed PumpSwap roles: user base, pool base, user quote, pool quote.

- Uses `BigInt`, exact raw decimal metadata, candidate mint identity and wallet owner hints on the two user token accounts.
- Requires a successful transaction, candidate status from V2, matching signature and PumpSwap V2.14 structural eligibility.
- Missing pre/post balances for temporary accounts, token transfer variants, unexpected token program activity, fee withheld extensions, mint mismatches, or inconsistent account deltas are reported as a separate **blocked / incomplete** status.
- `meta.fee` being present is **only** transaction-level network fee metadata; it does not prove the correct fee payer nor attribute swap costs.
- Account deltas across an entire transaction can contain ATA creation/closure, other CPI transfers, rent/WSOL movements, outside instructions, rebates or other fees. Numerical agreement is therefore **not per-instruction economics**.
- Creator / protocol / appended recipient transfer counts are **not** used as verified fee deductions because ownership, semantics and authorization are unresolved.
- Only hashed signature and watched-pool fingerprints, diagnostic statuses and counts leave the process. No raw amounts, exact prices, wallet IDs, token names, or PnL.

No change to V2-V2.14 rows, no schema mutation, no RPC, no AI/Codex, no wallet, no trade execution. Do not label these outcomes as completed fills or economic strategy results.

## Run

```bash
git pull --ff-only origin main
npm test
npm run check

docker-compose -f compose.yaml -f compose.s1b1.yaml \
 run --rm --build -T \
 -e S1B1_V215_LIMIT=3000 \
 decode node src/s1b1/v215-report.js
```

`S1B1_V215_LIMIT` bounds first-event-ID-ordered rows to 1–100,000; default 3,000. PostgreSQL `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.

Inspect `byStatus`, `byQuoteStatus`, `byAccountBalanceEvidence` and `rowsWithTransactionFeeMetadata`. The research result remains **`verifiedFills=0`, `economicsAuthorized=false`, `liveTrading=false`**; S3 remains `BLOCKED_DATA`.

Next phase requires independently adjudicated Solana transaction evidence, account creation/closure/rent and WSOL transfer handling, actual fee-recipient ownership, and temporal plus pool holdout diversity. Raw transfer equality must never automatically enable economics.
