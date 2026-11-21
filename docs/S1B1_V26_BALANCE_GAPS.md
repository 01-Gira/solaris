# SOLARIS S1b.1 V2.6 — root causes for PumpSwap balance gaps and extra transfers

V2.5 analyzed 188 V2 candidates: 158 Pump.fun expected base edges plus balance-mint hints; 29 PumpSwap expected base and quote edges **without** complete balance-mint hints; 1 mismatched Meteora-watched pool. The PumpSwap cases also had 2 other token transfers each within the candidate instruction subtree. This is not enough to claim swap fills, volumes, fees or executable prices.

V2.6 is a **diagnostic only** that reuses V2.5 as a fail-closed prerequisite. It inspects individual role-labelled token account indices (Pump.fun: user/pool base; PumpSwap: user/pool base and quote), and reports whether pre/post token balance metadata is present, missing, or inconsistent. Missing token balance entries do not prove a missing on-chain transfer or failure: RPC transaction balance arrays are snapshots with their own inclusion rules. V2.6 also labels non-expected transfer *source/destination account roles* inside the V2.4 candidate subtree, without assigning them to fees or classifying their economic effect.

For Pump.fun, the report checks only whether `preBalances` and `postBalances` contain integer lamport snapshots for the user and bonding curve accounts. **No native SOL transfer amount is inferred**, since whole-transaction balances can include fees, rent, unrelated transfers, or multiple instructions.

## Run on Mac

```bash
git pull --ff-only origin main
npm test
npm run check
docker-compose -f compose.yaml -f compose.s1b1.yaml \
  run --rm --build -T decode node src/s1b1/v26-report.js
```

Reads up to 1000 existing V2 single-trade-candidate rows by default (optional `S1B1_V26_LIMIT` in .env: 1..10000), in a PostgreSQL `BEGIN READ ONLY` transaction. Does not modify V1–V2 tables or original RPC transaction payloads; makes no Solana RPC or Codex calls, and does not touch running `stream` and `hydration` services.

Output: `s1b1_v26_balance_gap_audit` containing `byBalanceAccountRole`, `byOtherTransferEndpointRole`, `byNativeLamportEvidence`, `byStatus`, and hashed examples. It exports **no raw transaction signatures, addresses, token quantities, swap amounts, PnL or prices**.

## Follow-up gate

If missing balance entries or extra transfer roles recur, next step is to document their account and Token-2022 semantics with independently audited on-chain fixtures and versioned program documentation. Do not backfill missing token metadata with guessed zeroes. For any claim of executed swap price/fill, also require complete fee/rent/WSOL/native SOL accounting and independent positive/negative review. S3 remains `BLOCKED_DATA`, `verifiedFills=0`, `economicsAuthorized=false`, `liveTrading=false`.
