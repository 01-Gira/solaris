# SOLARIS S1b.1 V2.9 — PumpSwap fee-recipient routing evidence

V2.8 on 188 existing candidates identified:
- 29 PumpSwap events with quote mint WSOL and ordered temporary user_quote create → candidate → close hints.
- 15 with SyncNative before the candidate, 14 without that hint.
- 58 additional quote-mint checked transfer instructions: all 29 target candidate account position 10, while the second target is candidate position 24 in 15 cases and 22 in 14 cases.
- 158 Pump.fun rows have native-SOL quote accounting unresolved, and the Meteora-watched cross-venue event remains rejected.
- No verified fills, no economics authorization.

Pump.fun public PumpSwap IDL snapshot `pump-fun/pump-public-docs/idl/pump_amm.json`, blob SHA `d907b16a91f035aeb3c3182bfa0972a91bf23a86`, identifies **index 10 as `protocol_fee_recipient_token_account`**, and 23 fixed accounts for `buy`/`buy_exact_quote_in`, 21 for `sell`. Two observed trailing accounts are *outside that IDL* and must **not** automatically be called creator fees.

V2.9 is a **read-only routing audit**, not an economic decoder. It requires upstream V2.8 evidence, confirms expected fixed account counts with exactly two trailing accounts, exact watched pool, WSOL mint, and one checked SPL base, quote, protocol-recipient, and unclassified trailing-recipient edge from the candidate subtree. It checks optional token-owner metadata for protocol account without inferring fee entitlement. It intentionally exports only counts, roles, hashed example identifiers, no amounts, raw addresses, prices, PnL, wallet authority, or fee values.

## Run on macOS/Colima

```bash
git pull --ff-only origin main
npm test
npm run check

docker-compose -f compose.yaml -f compose.s1b1.yaml \
  run --rm --build -T decode node src/s1b1/v29-report.js
```

Bounded to at most 1,000 previously processed V2 single-trade candidates (optional `S1B1_V29_LIMIT` 1–10,000) in PostgreSQL `BEGIN READ ONLY`, no write migrations, no RPC or Codex calls. Do not stop or remove S1b stream/hydration containers, ignore orphan warnings.

**Interpretation:** Routing to the official protocol-recipient token account does not establish the actual program-assessed fee, protocol revenue, or effective execution price. The extra trailing recipient is unclassified. Promoting fee values requires authoritative, version-specific IDL/event semantics, individual verified transaction fixtures, and reconciliation of gross/net amounts, native SOL and WSOL wrap/unwrapping effects, rent and fee payer. Never connect this data directly to S3 trading strategy metrics. `verifiedFills=0`, `economicsAuthorized=false`, `liveTrading=false`.
