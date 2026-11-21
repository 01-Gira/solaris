# SOLARIS S1b.1 V2.7 — Lifecycle and Secondary Transfer Diagnostics

V2.6 (188 candidate event rows) showed **146** complete token-account pre/post metadata cases, **41** gap cases and **1** watched-pool mismatch. Among the gaps, **29** PumpSwap `user_quote` accounts had neither pre nor post balance snapshots, and **12** Pump.fun `user_base` accounts had one missing snapshot (six missing pre, six missing post). Separately, **58** extra checked transfer instructions in PumpSwap candidate subtrees had endpoints involving fee-token-account roles or previously unmapped accounts; **92** System Program transfers were counted across the sample. These are observations, *not* proof that specific fees, temporary accounts, or swaps occurred.

V2.7 tests the **account lifecycle hypothesis** using the hydrated jsonParsed transaction data SOLARIS already stores, without RPC re-fetches:
- Inspect Associated Token Account `create` and `createIdempotent`, System Program `createAccount` / `createAccountWithSeed`, Token Program / Token-2022 `initializeAccount*`, `closeAccount`, and `syncNative`, and associate them with expected token-account role addresses.
- Distinguish `both_balance_entries_missing`, `pre_balance_missing` and `post_balance_missing` by role; report whether creation/closure instructions involving that address are present anywhere in the same transaction.
- Label the extra PumpSwap subtree transfer endpoints using role names `protocol_fee_token_account`, `creator_vault_ata` or `unmapped` and distinguish checked quote-mint evidence from incomplete evidence.
- Count statuses by venue and account role, with only SHA-256 prefixes of pool/signature as sample identifiers. No token amounts, raw account keys or raw signatures are exported.

**These are only instruction-presence signals.** The report does not establish a true account creation/closure causal link, fee economic ownership, quote amounts, native SOL pricing, Token-2022 transfer fee treatment, PDA authority or fills. It never changes the original transactions, decoded rows or V2 candidate rows. No schema changes, external RPC calls, Codex calls or trader actions.

## Run

```bash
git pull --ff-only origin main
npm test
npm run check
docker-compose -f compose.yaml -f compose.s1b1.yaml \
  run --rm --build -T decode node src/s1b1/v27-report.js
```

Uses an explicit PostgreSQL `BEGIN READ ONLY` transaction, default sample up to 1,000 V2 single-trade candidate rows (optional `S1B1_V27_LIMIT` 1–10,000). Existing stream and hydration services need no restart. Ignore Compose orphan warnings: **do not** run `--remove-orphans` or `docker-compose down -v`.

The `s1b1_v27_lifecycle_evidence` report includes `byRoleBalanceGapAndLifecycle`, `byRoleLifecycleSignal`, `byAdditionalEdgeRole`, `byAdditionalEdgeMintEvidence`, and `balanceGapRolesWithoutLifecycleSignals`. A lifecycle hint is not sufficient to impute missing balance entries or assume zero token amounts. S3 remains `BLOCKED_DATA`, `verifiedFills=0`, `economicsAuthorized=false` and `liveTrading=false`.
