# SOLARIS S1b.1 V2.14 — Generalized PumpSwap Recipient Routing (Research Only)

Based on V2.7 / V2.8 full-cohort read-only review on Nov 21 2026:
- V2.7: 1,156 / 1,429 single-candidate rows had no token balance metadata gaps; 235 had lifecycle presence hints; 31 watched pool mismatches, 6 unusable accounts, one unparsed transfer.
- V2.8: lifecycle create/initialize/close ordering hints observed for all 235 balance-gap candidate rows; 76 PumpSwap candidates used non-WSOL quote mint, 48 WSOL; several destination account indices and appended-account shapes.
- V2.9 was deliberately narrow: of 125 PumpSwap-labelled candidates, 29 had four expected checked-transfer edges with exactly two appended accounts and WSOL quote; 76 were non-WSOL, 19 had unverified appended-account shape and one had unparsed transfer.
- Official PumpSwap IDL (`pump-fun/pump-public-docs/idl/pump_amm.json`, blob `d907b16a91f035aeb3c3182bfa0972a91bf23a86`) defines fixed account 10 as `protocol_fee_recipient_token_account` and fixed account 17 as `coin_creator_vault_ata`; BUY / BUY_EXACT_QUOTE_IN have 23 fixed accounts, SELL 21.

V2.14 is additive, not a replacement for V2.9. It reports a strictly structural account-index audit over **both WSOL and non-WSOL** PumpSwap quotes using the candidate's recorded quote mint at index 4, and permits variable count of appended accounts. It recognizes fixed IDL protocol account 10 and creator vault 17 *by destination address*, keeping remaining-account destination transfer counts separate. Checked-transfer amounts must be positive strings but are **never exported**; no prices, fee amounts, or wallet-level net PnL. Unparsed/unknown SPL token transfers and aliasing cause conservative status rather than fill promotion. Known-matched edges do not prove that any account is economically authorized to receive a fee.

## Run

```bash
git pull --ff-only origin main
npm test
npm run check

docker-compose -f compose.yaml -f compose.s1b1.yaml \
 run --rm --build -T -e S1B1_V214_LIMIT=3000 \
 decode node src/s1b1/v214-report.js
```

The report is read-only: PostgreSQL `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`; no schema changes, RPC calls, Codex CLI, wallet, order creation, deletion, existing decoder overwrite or economic authority.

Interpret `byQuoteClassStatus`, `byAppendedAccountCount`, `byProtocolEdgeCount`, `byCreatorVaultEdgeCount` and `byRemainingEdgeCount`. Keep 31 cross-venue watched-pool mismatches and six unparseable 2024 candidate accounts quarantined. Repeat after hydration finishes and new days arrive; do not use accumulated first-ID-ordered events as independent holdout proof.

For all V2.14 statuses: **`verifiedFills=0`, `economicsAuthorized=false`, `liveTrading=false`**. S3 remains `BLOCKED_DATA`; no claim of executable prices or profitability.
