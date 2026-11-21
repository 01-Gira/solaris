# SOLARIS S1b.2 — Detached Hydration Worker

**Status:** staged migration, read-only market-data acquisition. No wallet, signing, live trading, paid API or deletion of S1b evidence. The S1a PostgreSQL volume and append-only S1b events remain intact.

## Why separate hydration?

Previously one streamer both subscribed/backfilled Solana pool events and fetched full transaction bodies. On the November 21, 2026 local snapshots the user saw ~55–57 hydrated transactions per minute, a backlog of 1,262, and an oldest pending age above ten minutes. This is a capacity/latency concern, not evidence of stalled WS or failed on-chain transactions.

This phase splits responsibilities:

- **stream**: WebSocket log observation + bounded historical recovery only; publishes its attested hydration mode and heartbeat to PostgreSQL
- **hydration**: separate process continuously looks for eligible pending signatures and saves fetched transactions using existing idempotent database constraints
- **shared RPC pacer**: both HTTP RPC clients reserve provider-wide request slots in PostgreSQL keyed by SHA-256 of the *same configured HTTP endpoint*. 429 invokes shared cooldown. If DB pacing fails, the transaction is not fetched and no retry attempt is consumed
- **single owner**: hydration takes a PostgreSQL session advisory lock; competing hydration instances wait rather than duplicating work. It only processes when the S1b health row is fresh, connected and explicitly `hydration_mode=external`

This **does not increase** the combined configured RPC request rate. It avoids pausing hydration during each backfill cycle, and provides a safer foundation for later, measured tuning.

## Mandatory staged rollout on macOS with Colima

**Do not start the hydration worker alone against an existing legacy streamer.** The old inline streamer does not support coordination and would continue to fetch transactions.

Do not delete PostgreSQL volumes. Do not use `--remove-orphans`. Do not run `docker compose down -v`. Keep your existing `.env` and RPC credentials private.

First update sources and run offline tests:

```bash
cd ~/solaris
git pull --ff-only origin main
npm test
npm run check
```

Rebuild/recreate **only** the existing `stream` service, now with external hydration mode, using the S1b base + S1b.2 overlay:

```bash
docker-compose -f compose.yaml -f compose.s1b.yaml -f compose.s1b2.yaml \\
  --profile s1b up -d --build --no-deps stream
```

This replaces the old stream container, so there will be a short WebSocket interruption. The streamer performs bounded recovery on reconnection; this does **not guarantee full history without gaps**. Inspect recovery audits after rollout.

**Verify the new stream reports `external` and has a fresh heartbeat before starting hydration:**

```bash
docker-compose -f compose.yaml exec -T db sh -lc \\
'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT state,hydration_mode,active_pools,now()-heartbeat_at AS heartbeat_age FROM onchain_stream_health;"'
```

Only proceed when `state=connected`, `hydration_mode=external` and heartbeat is recent. If the column is missing, or mode is `inline`, **do not start hydration**; troubleshoot the stream update first.

Then start the new hydration worker:

```bash
docker-compose -f compose.yaml -f compose.s1b.yaml -f compose.s1b2.yaml \\
  --profile s1b up -d --build --no-deps hydration
```

View status and logs (no secrets printed):

```bash
docker-compose -f compose.yaml -f compose.s1b.yaml -f compose.s1b2.yaml \\
  --profile s1b ps stream hydration
docker-compose -f compose.yaml -f compose.s1b.yaml -f compose.s1b2.yaml \\
  --profile s1b logs --tail=50 stream hydration
```

An initial `s1b2_lease_acquired` log shows one worker has obtained the database advisory lock. `s1b2_waiting_for_external_stream` means the worker is **not fetching** while stream health is not ready.

For an independent read-only backlog report, rebuild and run the existing S4 diagnostics:

```bash
docker-compose -f compose.yaml -f compose.s4.yaml build s4-context
docker-compose -f compose.yaml -f compose.s4.yaml \\
  run --rm -T s4-context node src/s4/hydration-report.js
```

Compare event rows, matched hydrated event rows, pending, retries and oldest age at least twice. Monitor actual provider 429/error rates and the WS stream's health. Do not infer increased capacity from the existence of a second service alone.

## Rollback

**Do not restart the old inline stream while detached hydration is running.** Stop detached hydration first:

```bash
docker-compose -f compose.yaml -f compose.s1b.yaml -f compose.s1b2.yaml \\
  --profile s1b stop hydration
```

Then recreate the original inline streamer using the original overlays, **without S1b.2**:

```bash
docker-compose -f compose.yaml -f compose.s1b.yaml \\
  --profile s1b up -d --build --no-deps --force-recreate stream
```

Once inline stream is connected and health shows `hydration_mode=inline`, the legacy inline hydration resumes. No persisted transaction rows, pending events, audit records or volumes need to be deleted. The new tables and hydration_mode column are additive and safe to leave in place.

## Limitations and safety

- The owner advisory lock is **per PostgreSQL database**. Do not run another old-version S1b inline streamer in any other container on this database. Two separate RPC URLs may have **different hashes even if they share a provider account quota**; use the same HTTP RPC URL for the streamer and hydration.
- A shared clock ensures requests are reserved and spaced; it does not override the provider's dynamic limits, guarantee historical data, ensure a specific throughput, or produce audited trade fills.
- Until rollout, running GitHub CI verifies only unit and contract tests. Real macOS/Colima/RPC behavior and a healthy cutover require the steps above.
- Leave `S1B_RPC_SPACING_MS` at its existing value initially (default 1000ms), and avoid additional workers. In a future stage we can compare request latency vs queue arrival rate and safely tune capacity.
