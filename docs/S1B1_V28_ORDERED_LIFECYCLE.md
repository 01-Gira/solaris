# SOLARIS S1b.1 V2.8 — Ordered lifecycle and quote mint evidence

Observed V2.7 on 2026-11-21: 188 V2 single-trade candidate event rows, 146 complete role-based balance metadata, 41 gaps all with creation/closure hints, and one unrelated Meteora-watched pool. All 29 PumpSwap user_quote accounts had no pre or post SPL token-balance snapshot but had create, initialize and close instructions in the same transaction. Six Pump.fun user_base had pre missing and six had post missing. Also 58 additional PumpSwap quote-mint transfer instructions were observed. None are yet verified fills or fees.

V2.8 adds **ordered evidence**, read-only: reconstruct outer instruction execution order, nesting each RPC jsonParsed inner-instruction group at its parent outer index; compare transaction-order creation, initialization, syncNative and closeAccount events for the **same exact token account address** around the candidate instruction. Reject malformed/duplicated inner groups or multiple candidate instructions. It also distinguishes whether the PumpSwap quote mint account is precisely WSOL (`So11111111111111111111111111111111111111112`) or another mint. Unrecognized additional transfer destinations are labeled **only by their position in the candidate instruction account array**, or `not_in_candidate_accounts`, without presuming a creator fee identity. All identifiers in example reports are hash prefixes; no raw addresses or quantities are printed.

**Caveat:** Even an ordered `create -> trade-candidate -> close` pattern with WSOL mint does not prove a full lifecycle, fee treatment, economic ownership, actual fill or price. RPC parsed instruction records can omit information or expose ambiguous semantics. No PnL; no direction or amount is exported. We do not infer native SOL spent from whole-transaction lamport deltas or assume Token-2022 fee neutrality.

## Safe invocation
```bash
git pull --ff-only origin main
npm test
npm run check
docker-compose -f compose.yaml -f compose.s1b1.yaml \
  run --rm --build -T decode node src/s1b1/v28-report.js
```

This uses existing data and `BEGIN READ ONLY` against PostgreSQL. Default up to 1,000 previously classified V2 single-trade-candidate rows, optional `S1B1_V28_LIMIT=...` 1..10,000. No Codex or RPC calls, no schema writes, no restart of S1b stream/hydration, and no trading.

Read `byOrderedBalanceGapRole`, `byQuoteMintClass`, `bySyncNativeBeforeCandidate`, `byAdditionalDestinationCandidateIndex` and `byAdditionalSourceCandidateIndex`. Evidence readiness is limited to root-cause diagnostics. S3 remains `BLOCKED_DATA`, `verifiedFills=0`, `economicsAuthorized=false`, `liveTrading=false`; independent production transaction fixture review remains required.
