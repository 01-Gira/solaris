# SOLARIS S1b — bounded on-chain event recorder (candidate release)

## What this implementation does

Adds an **independent, read-only** Docker `stream` service. The existing S1a `recorder`, PostgreSQL schema, volume, dashboard, and REST collection remain intact. The streamer:

- Selects up to `S1B_MAX_POOLS` *recently observed* pools from S1a.
- Subscribes to Solana `logsSubscribe` with **one `mentions` filter per pool**, `finalized` commitment.
- Captures signature, slot, notification error, logs, event arrival time, and origin (`live`/`backfill`).
- Records watched pool membership/time in `onchain_watch_sessions`, including pools with no observed events.
- Stores raw `getTransaction` JSON using `jsonParsed`, `maxSupportedTransactionVersion=1`, finalized commitment.
- Stores SPL token account pre/post changes as **raw integers**, with exact BigInt deltas (not amounts in USD, not wallet BUY/SELL classification).
- Persists pending fetch jobs in PostgreSQL, retries with capped exponential backoff, and marks exhausted transactions unavailable without inventing data.
- Reconnects/resubscribes periodically; queries `getSignaturesForAddress` (with `until` known cursor when available) to attempt limited recovery. Records recovery audits, all continuity **UNVERIFIED**.
- Detects stale WebSocket heartbeat or overloaded queue and restarts the session.

## Important limits (NOT full S1b sign-off)

- Does **not** decode DEX-specific swaps, vaults, execution prices, wallet BUY/SELL, real-time token tick prices, or complete market history. Those require audited per-program parsers.
- Streaming starts **only after S1a discovers a pool**, and `logsSubscribe` matches the pool pubkey only if transactions mention it. Pump.fun / PumpSwap / Meteora / Orca / Raydium may use different addresses and layouts; **no completeness assumption**.
- Bounded bootstrap and reconnect recovery can miss transactions outside the API history window. Recovery status `bounded` is **not** proof that there are no gaps.
- No keypair, private key, wallet, trade signing or transaction submission exists. No changes to S1a's auth or network exposure.
- Avoid free public RPC endpoints for high-throughput tests. Need provider supporting WebSocket logs, `getTransaction`, and `getSignaturesForAddress`; rate limits and retention depend on provider. Keep provider keys only in local `.env`.
- Current retention is unlimited for S1b raw transactions and logs. Monitor disk; never run cleanup against unbacked-up data.

## Install in existing `solaris` checkout (Colima)

1. Copy **only the new/changed files from the package** into your existing repository. Do **not** replace your existing `.env` or PostgreSQL volume.
2. Append values from `s1b.env.example` to the existing `.env`, substituting your own HTTPS/WSS Solana mainnet RPC endpoints. The endpoints often contain a provider API key; **never commit `.env`**.
3. Keep your working S1a configuration (`POLL_INTERVAL_MS=60000`, `PAGES_PER_POLL=2`, `WATCHLIST_SIZE=0`).
4. Run tests, then start only the separate stream service:

```bash
npm test
npm run check
docker compose -f compose.yaml -f compose.s1b.yaml --profile s1b config --quiet
docker compose -f compose.yaml -f compose.s1b.yaml --profile s1b up -d --build stream
docker compose -f compose.yaml -f compose.s1b.yaml --profile s1b logs -f stream
```

If you have no RPC subscription yet, do **not** start `stream`: missing placeholder credentials must fail safely; S1a can keep running.

## Verify on-chain data without confusing it with REST snapshots

```bash
docker compose exec -T db psql -U ramusen -d solaris -c "SELECT * FROM onchain_stream_health;"
docker compose exec -T db psql -U ramusen -d solaris -c "SELECT source,tx_status,count(*) FROM onchain_pool_events GROUP BY 1,2 ORDER BY 1,2;"
docker compose exec -T db psql -U ramusen -d solaris -c "SELECT count(*) AS transactions FROM onchain_transactions;"
docker compose exec -T db psql -U ramusen -d solaris -c "SELECT status,count(*) FROM onchain_recovery_audits GROUP BY 1;"
docker compose exec -T db psql -U ramusen -d solaris -c "SELECT count(*) AS token_account_deltas FROM onchain_token_balance_changes;"
```

Tracked coverage audit:

```bash
docker compose exec -T db psql -U ramusen -d solaris -c "SELECT pool_address,started_at,ended_at,state FROM onchain_watch_sessions ORDER BY id DESC LIMIT 10;"
```

Database constraint: `UNIQUE(pool_address,signature)` in `onchain_pool_events`, and primary key `signature` on `onchain_transactions`. A single signature can appear for more than one tracked pool; don't double count it when measuring market volume.

## RPC transaction-version compatibility (Solana v1)

Solana transaction v1 requires `maxSupportedTransactionVersion: 1` on `getTransaction`.
A version ceiling of `0` produces RPC error `-32015` on v1 transactions even while
`logsSubscribe` and `getSignaturesForAddress` continue working. The `jsonParsed`
response is stored raw; SPL token balance deltas may be extracted, **not** DEX swaps.
See https://solana.com/docs/core/transactions/versioned-transactions.

For existing data previously exhausted due to `-32015`, use the scoped requeue script
`sql/s1b_requeue_version_mismatch.sql` **after stopping only the `stream` service**
so no worker races with the repair. The script leaves successful transactions intact
and only resets unresolved signatures explicitly marked with that error.
After starting the patched `stream` image, check `tx_status`, `tx_attempts`, and
`last_fetch_error`. Other RPC failures and gaps still require independent audits.

## Exit gates before declaring completed S1b

1. **Database integration test on Colima** using live persistent PostgreSQL and migration idempotence, including restart.
2. **Actual provider test**: finalized notifications matched to Solana explorer signatures and slots; no unsupported assumptions.
3. **Reconnect fault injection**: force network loss; verify recovery audit and identify unresolved gaps. Status never claims full recovery.
4. **Provider rate/availability**: measure 24h, quota, latency, null getTransaction and unavailable rows.
5. **DEX-specific decoding and reconciliation** before deriving BUY/SELL/price/volume, using token vault mapping and per-program instruction decoding; test against known finalized transactions.
6. **Survivorship coverage**: track which pools were selected, when, and which events remain unobserved; S1a newest-pages are not an exhaustive pool universe.

Docs: https://solana.com/docs/rpc/websocket/logssubscribe , https://solana.com/docs/rpc/http/gettransaction , https://solana.com/docs/rpc/http/getsignaturesforaddress

Derived token-account deltas require comparable pre/post amounts and account metadata. Missing sides stay unknown. Use the saved RPC payload for lifecycle and instruction reconciliation. The qualification runbook is [here](RESEARCH_QUALIFICATION.md).
