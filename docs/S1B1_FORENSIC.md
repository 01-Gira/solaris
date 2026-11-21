# SOLARIS S1b.1 forensic audit — prerequisite for Decoder V2

S4.2A task #1 completed 5/5 research agents. Their current conclusion remains `INSUFFICIENT_DATA`, and S3 remains `BLOCKED_DATA` with no economics approval. Initial decoder batch of 1,000 hydrated event rows contained 621 `unsupported_dex` (`no_supported_dex_instruction`), 299 `ambiguous` (`multiple_dex_instructions`), and 80 `failed_onchain` (`meta_err_present`).

**Do not implement speculative new BUY/SELL classification from these labels.** Determine which on-chain programs dominate and whether duplicate/inner instructions explain the multiple-DEX label. Current decoder includes outer and inner instructions; unverified price ratios must not become executable fill metrics.

The added diagnostic reads existing `onchain_pool_events`, `onchain_trade_decodes`, `onchain_transactions`, and `pools` with an explicit `BEGIN READ ONLY` transaction. It does **not** re-decode, modify DB tables, move retry states, contact Solana RPC, access wallets, call Codex, or mark trades valid. Representative sample signatures/pools are represented only by SHA-256 prefixes; output is aggregation-focused, but still consider it private research material.

## Run on Mac / Colima

```bash
cd ~/solaris
git pull --ff-only origin main
npm test
npm run check
docker-compose -f compose.yaml -f compose.s1b1.yaml build decode
docker-compose -f compose.yaml -f compose.s1b1.yaml \
  run --rm -T decode node src/s1b1/forensic-report.js
```

Default limit: 1,000 event rows with existing `decoder_version=s1b1-0.3.0`, ordered by event ID. Optional `S1B1_FORENSIC_LIMIT` supports 1–10,000. This is a **bounded sample**, not an unbiased census of all historical pools. The diagnostic labels **program presence**, **not fills**, and counts the number of recognized instructions across outer and inner instructions. It can reveal how often "multiple_dex_instructions" actually has more than one recognized Pump.fun/PumpSwap instruction, and whether program IDs vary by current decoder status.

## Acceptance checks for a future Decoder V2

- Preserve original raw transaction data, old decoder outputs and S4 decisions; no overwriting evidence.
- Verify dominant program IDs against audited official program definitions/IDLs before adding support.
- Differentiate a pool being mentioned in logs from an instruction representing an actual swap on that pool.
- For multi-instruction transactions, refuse to infer instruction-level fill amounts from whole-transaction net balance deltas.
- Never treat `unsupported_dex` as proof that a transaction is a swap. Validate failed transactions against `meta.err`.
- Evaluate against a fixed, independently reviewed set of real transaction samples with positive and negative cases, then freeze and test separately.
- Keep `economics_authorized=false`, `liveTrading=false`, and S3 gate blocked unless independent execution data is actually verified.

**Rollout impact:** no restart of S1b.2 `stream` or `hydration` needed. Ignore orphan warnings; never use `--remove-orphans` or `docker-compose down -v`.
