# SOLARIS S4.2A — Persistent Research Coordinator

**Status:** research-only; manual opt-in. No API billing fallback, unattended scheduler, trade signing, wallet, execution authority, or automatic trading. Each role remains a local host Codex CLI session authenticated using ChatGPT.

## Architecture

- PostgreSQL tables: `s42_research_tasks`, `s42_agent_steps`, `s42_daily_call_budget`, `s42_progress_events`.
- `src/s42/bridge.js` runs inside `s4-context` Docker and is the **only** S4.2 component with `DATABASE_URL`. It accepts a bounded JSON command on stdin and emits bounded JSON. The host never receives DSNs, raw transactions or wallet keys.
- `src/s42/host.js` runs on the Mac, uses the bridge via `docker-compose` and calls `codex exec` with the preexisting S4.1 restrictions.
- A task is identified by a SHA-256 of **sanitized S4 evidence** and its selected roles. Export timestamp is excluded from the identity, so multiple exports with identical research evidence deduplicate.
- Each selected role is a separate durable step. PostgreSQL row locks ensure only one worker can reserve each step. Steps run in order. Prior successful decisions are provided to the next role.
- A **UTC daily call reservation budget**, capped at 20 Codex CLI starts per day by policy (default 5). Reserving a step consumes one slot, even if the process crashes or Codex fails. This counts CLI invocations, **not** internal model requests/tokens.
- Any failure blocks the task and leaves audit evidence. A crash after reservation leaves a `reserved` step and **does not auto retry**; this prevents duplicate billable calls. Manual recovery must be reviewed in a future stage.
- All agent decisions are validated against the S4.1 schema. `economics_authorized=false` and `execution_authorized=false` remain mandatory.

## First run on macOS (zero Codex calls)

Keep S1a/S1b.2 and the existing database running; do not remove containers or volumes.

```bash
cd ~/solaris
git pull --ff-only origin main
npm test
npm run check

docker-compose -f compose.yaml -f compose.s4.yaml build s4-context
docker-compose -f compose.yaml -f compose.s4.yaml run --rm -T s4-context > .solaris/s4-context.json
chmod 600 .solaris/s4-context.json

# Import the context, dedupe and create up to five persistent steps. NO AI CALLS.
npm run s42:submit -- --context .solaris/s4-context.json
```

The command outputs a numeric `task.id`. Repeated submission of unchanged evidence/roles returns the same task rather than creating duplicates.

```bash
npm run s42:status -- --task 1
```

Replace `1` with the real `task.id` from your output. This shows each role's state and bounded progress log without running Codex.

## Explicit, one-step ChatGPT-Codex invocation

Start with **one** role and a conservative budget:

```bash
S42_CODEX_ENABLED=1 \
S4_CODEX_ENABLED=1 S4_DRY_RUN=0 \
S4_AI_BACKEND=codex S4_PAID_API_FALLBACK=0 S4_LIVE_TRADING_ENABLED=0 \
S4_CODEX_MODEL=gpt-6.2-astra \
npm run s42:run -- --task 1 --max-steps 1 --daily-limit 5
```

The model ID above is an example from an earlier working S4.1 configuration; choose a model currently available in your Codex/ChatGPT login. Do not share authentication files or private logs.

Recheck `npm run s42:status -- --task 1`. A second invocation with the same task advances to the next role only if the previous completed successfully. To request up to five sequential roles in one foreground invocation, use `--max-steps 5` **only if you explicitly want to spend those call reservations**.

`S42_CODEX_ENABLED` must be `1` as well as `S4_CODEX_ENABLED=1` and `S4_DRY_RUN=0`. The default CLI does not invoke Codex, cannot approve economics, and cannot place trades.

## What this does not solve

- S3 remains `BLOCKED_DATA`, zero ready pools; no realistic fill proof or validated strategy.
- In the first 1,000 decoded events on 2026-11-21, 621 were `unsupported_dex`, 299 `ambiguous`, and 80 `failed_onchain`. These are decoder classifications, not verified trades. No `matched_quote_delta` appeared in that batch.
- S4.2A has **no automatic cron/scheduler**, no automatic unblocking of crashed tasks, and no autonomous execution. It is persistent, user-triggered research coordination only.
- CI tests offline queue semantics. Production database integration and real ChatGPT quota behavior require a smoke test on the user's macOS/Colima environment.

Never run `docker-compose down -v`, `--remove-orphans`, or anything that deletes transaction history as part of this workflow.
