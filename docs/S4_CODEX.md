# SOLARIS S4.1 — Codex-first research agents

**Status:** research-only orchestration; no live trading, no paid API fallback, no trade execution. S4.1 uses **Codex CLI on macOS host** authenticated specifically with your **ChatGPT account**, not an OpenAI Platform API key. No exchange/private wallet key is used. The default run is dry-run (0 Codex model calls).

S4.1 roles:
1. **Discovery** — pool source quality, observation lag and discovery/selection evidence
2. **On-Chain** — hydration, failed transactions, DEX decode and missing execution-price evidence
3. **Security** — S2 authority/extension/liquidity evidence; cannot certify safety
4. **Strategy** — S3 methodology, sample insufficiency, risk of lookahead/proxy bias
5. **Audit** — challenges the others' conclusions and proposes falsifiable research

These are **five role prompts**, not five separately finetuned models or long-lived daemons. Runs are **bounded, sequential, and manually triggered** by default. The ten-role S4 roadmap, live websocket analytics, richer multi-agent planning, real fills and paper order simulator are not implemented by S4.1.

## Zero paid-API fallback rule

- Only `S4_AI_BACKEND=codex` is supported.
- `S4_PAID_API_FALLBACK=0`, `S4_LIVE_TRADING_ENABLED=0`.
- No OpenAI API SDK/API calls are made by S4.1.
- The child process receives only `PATH`, `HOME`, optional `CODEX_HOME`, and basic terminal variables: no `OPENAI_API_KEY`, `DATABASE_URL`, Solana RPC URLs or AWS secrets.
- Before **each** Codex execution, `codex login status` must identify authentication as **ChatGPT**. Any API-key login or unavailable auth blocks that agent. This reduces accidental paid API use; verify Codex config and account billing separately because custom configured model providers or future CLI changes can affect routing.
- Codex usage through ChatGPT is **quota-limited**. The exact allowance depends on your plan. On quota/auth failure, the agent errors out; the research pipeline does not switch providers.
- Codex runs in a temporary minimal working directory with `codex --ask-for-approval never exec --sandbox read-only`. Note: **read-only is not a complete secret-isolation boundary**; a local Codex process may still be able to read files accessible to the operating-system user. For stronger isolation run under a dedicated macOS account with no access to private keys, production credentials, personal files or MCP configurations. Do not treat prompt instructions as a security sandbox.

## Run on your Mac (Colima)

Prerequisites: S1a/PostgreSQL running; Node.js >=22; install an up-to-date Codex CLI on the host using the official CLI instructions; use **ChatGPT sign-in**.

```bash
cd ~/solaris
git pull --ff-only origin main
npm install
npm test
npm run check

# Confirm this says "Logged in using ChatGPT":
codex login
codex login status

# Step 1: Create the local, git-ignored evidence directory
mkdir -p .solaris
chmod 700 .solaris

# Step 2: Export only bounded/allowlisted S1–S3 data from PostgreSQL,
# without giving Codex access to DATABASE_URL.
docker compose -f compose.yaml -f compose.s4.yaml build s4-context
docker compose -f compose.yaml -f compose.s4.yaml run --rm -T s4-context > .solaris/s4-context.json
chmod 600 .solaris/s4-context.json

# Step 3: First run is DRY_RUN even with Codex installed.
npm run s4:run -- --context .solaris/s4-context.json

# Step 4: ONLY after checking the dry-run JSON and Codex auth status:
S4_CODEX_ENABLED=1 S4_DRY_RUN=0 \
npm run s4:run -- --context .solaris/s4-context.json \
  --agents discovery,onchain,security,strategy,audit
```

For a single cheap/manual research task, select only one role:

```bash
S4_CODEX_ENABLED=1 S4_DRY_RUN=0 \
npm run s4:run -- --context .solaris/s4-context.json --agents audit
```

Optional `S4_TIMEOUT_MS=120000` caps each agent (15–300 seconds permitted). Each requested role launches at most one `codex exec` process; Codex may make multiple internal model requests during that process, so this is not a token or request budget. Max five roles and concurrency=1. Automatic periodic scheduling is deliberately not installed.

## How it works

1. **Exporter (in Docker)**: `src/s4/export-context.js` SELECTs at most 20 pools and a tiny set of S1–S3 counts/statuses. If optional S2 or S3 tables do not exist, it emits `unknown`. It does NOT export raw transactions, full pool payloads, API keys, wallet signer material, the .env file or DB URLs.
2. **Policy layer**: `src/s4/policy.js` strips unexpected fields, validates timestamps and evidence IDs and limits text sizes.
3. **Codex host adapter**: `src/s4/orchestrator.js` verifies ChatGPT auth, invokes structured `codex exec` with a read-only sandbox and timeout, and validates each JSON output. Unknown evidence IDs, additional fields, any attempted trade order, and `economics_authorized=true` are rejected.
4. **Audit trail**: `.solaris/s4-audit.ndjson` records role, context digest, decision/status, evidence IDs, unknowns and next step. It is ignored by Git. Raw model terminal output is deliberately discarded. Logs may still contain potentially misleading model summaries; manually audit and protect the file.

Any model-produced recommendation is **research-only** and cannot authorize funds, execution, paper orders or strategy deployment.

## Sample output

```json
{
  "mode": "DRY_RUN",
  "maxCalls": 0,
  "completed": 0,
  "economicsAuthorized": false,
  "liveTrading": false,
  "paidApiFallback": false
}
```

**Ready for S4.2?** Not yet proven by offline CI alone. First run against real sanitized S1–S3 data and successful ChatGPT-authenticated Codex CLI outputs. Validate prompts and evidence IDs by human review; check quota consumption.

## Next roadmap

- S4.2: improved on-chain and security research evidence; add missing wallet/sentiment feeds only with source audit.
- S4.3: deterministic paper execution simulator and risk limits; must NEVER make real transactions.
- S4.4: resumption, scheduling, quota budgets and fail-closed backoff after end-to-end tests.
- Future optional API adapter: separate reviewed implementation behind explicit opt-in and spend caps. **Not enabled or implemented in S4.1**.


## Troubleshooting: Codex process exits with code 1

A successful Docker build, S1–S3 exporter and S4 dry-run do **not** guarantee that
the host Codex CLI is able to run a model. An `AGENT_ERROR` of
`codex_exited_nonzero:1` indicates a Codex subprocess failure. By default,
the orchestrator deliberately discards raw stdout/stderr because they can
contain credentials, local paths and model responses.

S4 now reports an additional **safe error category** after a nonzero exit,
such as `CLI_ARGUMENT_OR_VERSION`, `CODEX_AUTH_OR_ACCESS`,
`CHATGPT_USAGE_OR_RATE_LIMIT`, `MODEL_NOT_AVAILABLE`,
`LOCAL_SANDBOX_OR_PERMISSION`, `STRUCTURED_OUTPUT_SCHEMA`,
`CODEX_LOCAL_CONFIGURATION`, `NETWORK_OR_TLS`, or `UNCLASSIFIED`.
This is pattern matching for diagnosis, **not proof of the exact root cause**.
The raw Codex output remains private and is never saved or returned.

Start with a **zero-model-call** check:

```bash
cd ~/solaris
git pull --ff-only origin main
npm test
npm run check
npm run s4:doctor
```

The doctor checks only `codex --help`, `codex exec --help`, and
`codex login status` in the same restricted environment as the agent.
A successful response says `PREFLIGHT_PASS_MODEL_NOT_TESTED`, which does
not imply a successful Codex request. If the doctor reports unsupported
CLI flags, update Codex using official installation instructions and rerun.
If login is unavailable, authenticate via ChatGPT and repeat.

Then retry **only one agent**:

```bash
S4_CODEX_ENABLED=1 S4_DRY_RUN=0 \
  S4_AI_BACKEND=codex S4_PAID_API_FALLBACK=0 S4_LIVE_TRADING_ENABLED=0 \
  npm run s4:run -- --context .solaris/s4-context.json --agents audit
```

If it still fails, inspect the **category only**. Do not paste `.env`,
`~/.codex/auth.json`, private keys, database credentials, full Codex
stderr or the complete private audit log. The S1b stream should be
left running; do not use `--remove-orphans` or delete Docker volumes.

Docker's `buildx isn't installed` warning is non-fatal when the image builds.
The `orphan containers` warning can occur because the S4 Compose overlay
does not list the existing S1b stream; it is not evidence that S1b failed.


## Codex structured-output compatibility (S4.1)

If the default Audit Agent produces `codex_exited_nonzero:1:STRUCTURED_OUTPUT_SCHEMA`, **do not assume the JSON Schema is invalid**. The older diagnostics classified the mere mention of `--output-schema` too broadly. The improved version distinguishes unsupported CLI flags from specific structured-output errors. Verify `codex --version` and `npm run s4:doctor` first.

The default `S4_CODEX_OUTPUT_MODE=structured` passes a strict JSON Schema to Codex. If a real schema rejection or model compatibility problem persists, there is an **explicit, single-shot** compatibility mode:

```bash
S4_CODEX_ENABLED=1 S4_DRY_RUN=0 \
S4_CODEX_OUTPUT_MODE=validated_json \
S4_PAID_API_FALLBACK=0 S4_LIVE_TRADING_ENABLED=0 \
npm run s4:run -- --context .solaris/s4-context.json --agents audit
```

`validated_json` removes the `--output-schema` CLI argument, but **does not loosen SOLARIS' own strict schema, evidence ID, risk policy, economics or execution checks**. If Codex does not return the required JSON object, the result becomes `AGENT_ERROR`, not a successful decision. No automatic retry or paid fallback occurs. One invocation can consume ChatGPT Codex allowance even if it fails.

Do not paste raw Codex stderr, `.env`, authentication tokens, private keys or full `.solaris` logs. Send only the safe `status` and `reason` fields.


## Troubleshooting: MODEL_NOT_AVAILABLE in both output modes

If both `structured` and `validated_json` return `MODEL_NOT_AVAILABLE`, do not keep swapping JSON settings. This error category is inferred from CLI output and may be related to a **model selection**, a local provider configuration, or account-level model access. The doctor only checked CLI flags and login; it did **not** query an actual model.

First, on your Mac (not inside the container), check:

```bash
codex --version
codex login status
# Launch normal interactive Codex and choose /model; note the exact model ID that your account offers.
codex
```

The model picker can show which models the current ChatGPT-login session supports. Do not share `~/.codex/auth.json`, full config files, authentication tokens, credentials or unredacted CLI output.

S4 supports an **optional one-run model override** `S4_CODEX_MODEL`. It is validated as a bounded identifier, supplied as the CLI `--model` argument, and does not edit `~/.codex/config.toml`. **Replace `<model-from-your-codex-picker>` with a model actually available to your login**:

```bash
S4_CODEX_ENABLED=1 S4_DRY_RUN=0 \
S4_CODEX_MODEL=<model-from-your-codex-picker> \
S4_PAID_API_FALLBACK=0 S4_LIVE_TRADING_ENABLED=0 \
npm run s4:run -- --context .solaris/s4-context.json --agents audit
```

Without `S4_CODEX_MODEL`, SOLARIS keeps the Codex CLI's default model. It does **not** guess which model is available, switch models on errors, or make retries. The adapter forces the built-in `openai` model provider, while continuing to require ChatGPT (not API-key) login before a call. This blocks accidental use of custom provider definitions but does not remove normal ChatGPT usage limits.

If the selected model still fails, provide only the **model identifier**, Codex version, and S4 `reason` classification. A successful login is not proof that a specific model is accessible.


## S1b hydration observability and safe queue diagnosis

The older S4 exporter used the global onchain_transactions row count
as hydrated_events. That value is **not necessarily the number of event
rows matched to hydrated transactions**. The revised exporter matches
onchain_pool_events to onchain_transactions **by signature** before
calculating event-based coverage. It also adds stats.hydration with
explicit event/transaction units.

On macOS, with S1b and PostgreSQL already running, use the same S4
one-shot Docker image to run the **read-only** diagnostic:

```bash
docker-compose -f compose.yaml -f compose.s4.yaml build s4-context
docker-compose -f compose.yaml -f compose.s4.yaml \
  run --rm -T s4-context node src/s4/hydration-report.js
```

The JSON report includes event_rows, unique_event_signatures,
hydrated_event_rows, missing_event_rows, pending_event_rows,
resolved_event_rows, unavailable_event_rows,
pending_unattempted_event_rows, retry_eligible_event_rows,
oldest_pending_age_seconds, new_event_rows_last_5m,
hydrated_event_rows_last_5m and stored_transaction_rows.
The hydration percentage compares **matched event rows with all event
rows**. It is not proof of full chain coverage, swap decoding, economic
authorization or data availability at the time of the original event.

Recent arrivals and recently fetched transactions are measured with
different timestamps, so the 5-minute counters are **not necessarily
the same cohort**. Compare two measurements over a fixed interval to
evaluate net backlog growth and confirm whether transaction fetch
throughput is sufficient.

To refresh the Codex context after this change:

```bash
umask 077
docker-compose -f compose.yaml -f compose.s4.yaml \
  run --rm -T s4-context > .solaris/s4-context.json
node -e "const d=require('./.solaris/s4-context.json'); console.log(JSON.stringify({at:d.collected_at,stats:d.stats},null,2))"
```

All commands above leave S1b streaming, retries, RPC spacing and
database contents unchanged. The S4 context remains bounded to the
existing 20 pools, and S4 continues to prohibit live trading and API
fallback. Do not run --remove-orphans for this workflow.
