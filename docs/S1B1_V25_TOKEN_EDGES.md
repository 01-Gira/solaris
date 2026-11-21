# SOLARIS S1b.1 V2.5 — Token Account & Checked Transfer Edge Reconciliation

**Input observation (2026-11-21):** among 188 previously classified V2 single trade candidates, V2.4 observed 187 correct watched-pool index matches with at least one parsed SPL transfer in the candidate's call-stack subtree, totaling 274 subtree transfer instructions; 1 Meteora-watched pool did not match a PumpSwap candidate. All prior stages report 0 verified fills and S3 remains BLOCKED_DATA.

This is a **read-only evidence sufficiency audit**, not a trade-fill decoder.

## What V2.5 does
- Respects V2.4 strict CPI stack boundaries, watched-pool account matching, and transaction outcome checks.
- Uses version-pinned *legacy* Pump.fun/PumpSwap account indices to identify expected base token source/destination, and for PumpSwap the expected SPL quote token source/destination. Pump.fun native SOL quote, lamport transfers, and fees are **not reconciled** here.
- Examines only descendants of the candidate, not a sibling CPI; expects parsed `transferChecked` with positive integer raw amount and a mint that matches the expected IDL role. Other parsed transfers, including unchecked transfers, stay **unverified**.
- Separately compares account-index mint labels in transaction pre/post token balance metadata as **supporting hints**, not price/volume inference.
- Rejects conflicting token mints, reversed expected legs, duplicated expected edges, reused account roles and absent expected token legs from complete inference.
- Aggregates statuses and **counts of evidence legs**; never exports token amounts, source/destination account keys or raw signatures. Results are not fills, not executable quotes, not realized returns, not BUY/SELL confirmations.

**Important:** `transferCheckedWithFee` and other Token-2022 fee-bearing paths are not promoted by this stage. A checked edge alone does not establish the effective amount received after fee. Native SOL transfers, rent refunds, fee accounts, PDA signing and end-to-end vault/account ownership remain separately unverified.

## Run on Mac / Colima
```bash
git pull --ff-only origin main
npm test
npm run check
docker-compose -f compose.yaml -f compose.s1b1.yaml \
 run --rm --build -T decode node src/s1b1/v25-report.js
```

The report reads up to 1,000 V2 `single_trade_candidate` event rows (override in local `.env` with `S1B1_V25_LIMIT` between 1 and 10,000). Executes inside `BEGIN READ ONLY`, **without DB table mutations, Solana RPC, Codex calls, or trader permissions**. Keep existing S1b streamer and hydrator running, and do not remove Docker orphan containers or volumes.

## Interpretation and next gate
Output `s1b1_v25_token_account_edges` includes `byStatus`, `byVenueStatus`, `byProgramStatus`, `byBalanceMintConsistency`, `checkedBaseEdgeInstructions` and `checkedQuoteEdgeInstructions`.

Even a status such as `expected_edges_with_balance_mint_hints` does **not** validate a fill: per-token transfer amounts, Token-2022 fees, native SOL quote movements, vault ownership, PDA rights and fee-inclusive price reconstruction remain unverified. Do not connect this diagnostic to S3 economic validation. Require independent manually checked positive and negative real-transaction fixtures, program-specific accounting including fee/rent effects, and temporal holdouts before authorizing any economics.
