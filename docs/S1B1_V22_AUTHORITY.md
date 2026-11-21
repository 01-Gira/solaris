# SOLARIS S1b.1 V2.2 — CPI authority evidence audit

S1b.1 V2.1 found **187** single-trade candidates at legacy expected pool positions (158 Pump.fun and 29 PumpSwap) and **1** cross-venue mismatch from a Meteora-watched pool. It also found **145** `legacy_signer_flag_absent` vs **43** present, with 146 inner candidates total.

**Important:** An inner instruction can be invoked by a program through CPI, including PDA-assisted signing. The original transaction's `accountKeys.signer` property describes the transaction signer set, **not** the entire runtime privilege/authority of every CPI. A false flag is **not proof** the swap failed or was unauthorized. Similarly a true flag and matching account index do **not** establish a swap, instruction-level token transfers, fill price, or realized return.

The V2.2 audit compares candidate discriminators and account-index names against the official public Pump.fun IDL snapshots:

- `pump-fun/pump-public-docs/idl/pump.json`, Git blob SHA `bb79d04e5a4ef8b286d67511757c23a15672ef51`
- `pump-fun/pump-public-docs/idl/pump_amm.json`, Git blob SHA `d907b16a91f035aeb3c3182bfa0972a91bf23a86`

For legacy `buy`, `sell`, and `buy_exact_sol_in` Pump.fun cases the `bonding_curve` pool index is 3 and the `user` index is 6. PumpSwap legacy `buy`, `sell`, `buy_exact_quote_in` use `pool` at index 0 and `user` at index 1. The official IDL's minimum listed account count is checked too, but an index/count match alone does **not** prove every account's semantic identity.

This version adds **no DB tables and makes no writes**, calling only `BEGIN READ ONLY`. Source transaction payloads and V1/V2 outputs remain unchanged. `verifiedFills=0`, `economicsAuthorized=false`, `liveTrading=false`.

## Run on Mac

```bash
git pull --ff-only origin main
npm test
npm run check
docker-compose -f compose.yaml -f compose.s1b1.yaml \
  run --rm --build -T decode node src/s1b1/v22-report.js
```

Default limit 1,000 V2 single-candidate event rows, configurable with `S1B1_V22_LIMIT` 1..10000. No Codex, no RPC, no removal of running stream/hydration containers.

Review `byStatus`, `byScopeAuthority`, `byOuterInstructionProgram` and `accountCountComparedToOfficialIdl`. Cases with `user_not_tx_signer` need independent CPI authority tracing rather than immediate rejection. A future validated fill decoder requires program version-specific account semantics, validated token transfer attribution (including inner instruction tree), matching transaction and pool, and sampled manual checks with negative controls.
