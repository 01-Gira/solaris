# SOLARIS S1b.1 V2.4 — Stack subtree evidence audit (read-only)

V2.3: 188/188 V2 single-trade candidate event rows had parsed SPL token transfers somewhere in the same outer instruction group, and 188/188 had candidate `stackHeight`. This is **co-location**, not a fill. V2.2: 187 candidates matched their observed pool at official legacy IDL account positions; one cross-venue Meteora-labeled event did not.

V2.4 adds a stricter **contiguous stack subtree** check using saved `jsonParsed` inner-instruction order and `stackHeight`. Each single Pump.fun/PumpSwap candidate is matched to the observed pool under the legacy IDL mapping. For an inner candidate at depth H, only subsequent instructions with greater stack height before the first instruction with depth <=H belong to its descendant subtree. Sibling/neighboring transfers are counted separately, never attributed. An outer candidate uses only its own outer instruction group's inner trace. Missing heights, impossible depth jumps, multiple candidate instructions, failed transactions, signature mismatch and observed-pool mismatch fail closed.

Output statuses include `subtree_transfers_present_unattributed`, `only_outside_subtree_transfers`, `no_parsed_transfers_under_candidate`, `incomplete_stack_heights`, `invalid_stack_depth_transition`, `watched_pool_mismatch`.

**Interpretation restriction:** The presence of a parsed transfer descendant is not sufficient to prove the transfer belongs economically to a given swap; source/destination ownership, Token-2022 transfer fees, side, quoted amounts, signer/PDA authority, and transaction-level costs have not been reconciled. `verifiedFills=0`, `economicsAuthorized=false`, and `liveTrading=false` remain hard-coded. Neither PnL nor prices are generated. V2.4 does not write/migrate tables.

## Run on Mac / Colima

```bash
git pull --ff-only origin main
npm test
npm run check
docker-compose -f compose.yaml -f compose.s1b1.yaml \
  run --rm --build -T decode node src/s1b1/v24-report.js
```

Default reads up to 1,000 existing V2 `single_trade_candidate` events in a `BEGIN READ ONLY` transaction. Use local `S1B1_V24_LIMIT=...` in `.env` for 1–10,000. Requires no Codex, no RPC, no restarts, and does not affect the live S1b stream/hydrator. Do not use `--remove-orphans` or `docker-compose down -v`.

V2.5 gate: inspect full exact descendant transfer context using audited token-account identities, expected pool vaults, negative-controls for CPIs with sibling transfers, migration/fee pathways, and independent held-out signatures. Do not promote subtree transfer counts to execution fills.
