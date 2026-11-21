# SOLARIS S1b.1 V2.3 — Group-level SPL transfer trace audit

V2.2 reports 188 candidate event rows: 187 matching Pump.fun/PumpSwap IDL pool positions, 1 cross-venue mismatch. Of 187, 145 inner Pump.fun CPI candidates had `user_not_tx_signer`, all under the same parent program; 42 outer candidates had an original transaction signer. Neither result proves nor disproves CPI PDA authority. No fills have been validated.

**V2.3 is a read-only prerequisite to per-instruction transfer attribution.** It reads existing `jsonParsed` on-chain transactions, determines the candidate's outer instruction group, counts Token Program / Token-2022 instructions within **that same outer group**, and distinguishes parsed `transfer`, `transferChecked`, `transferCheckedWithFee` from unparsed operations and non-transfer token mutations.

A matching outer group is **only co-location**, not proof that a transfer belongs to a Pump.fun/PumpSwap CPI. The group may include other CPI invocations or transfers. Nothing in this report establishes `invoke_signed`, actual swap amounts, direction, execution price, profitability, real wallet authority, verified fills, or trading permission.

## Run on Mac

```bash
git pull --ff-only origin main
npm test
npm run check
docker-compose -f compose.yaml -f compose.s1b1.yaml \
 run --rm --build -T decode node src/s1b1/v23-report.js
```

Default sample is up to 1,000 previously classified `single_trade_candidate` V2 event rows; `S1B1_V23_LIMIT` supports 1..10,000. The report returns statuses such as `transfers_colocated_not_attributed`, `unparsed_token_instructions`, and `no_token_instructions_in_group`; it is **not** a swap outcome classifier. Uses PostgreSQL `BEGIN READ ONLY`, no changes to any recorded transaction or decoder table, no RPC or Codex calls, and no restart of S1b.2. Ignore Docker orphan warnings; do not remove containers or volumes.

## Go/no-go for V2.4

Require independent, version-pinned event/program IDL verification, parent-child CPI stack mapping (including available `stackHeight`), authority and token account ownership checks, and exact instruction-level transfer allocation. Negative controls must cover multiple swaps, unrelated transfers in the same outer instruction group, absent Token-2022 parsed data, and the mismatched Meteora-watched pool. Until independently validated, `verifiedFills=0`, `economicsAuthorized=false`, and S3 remains `BLOCKED_DATA`.
