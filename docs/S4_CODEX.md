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

- Only \`S4_AI_BACKEND=codex\` is supported.
- \`S4_PAID_API_FALLBACK=0\`, \`S4_LIVE_TRADING_ENABLED=0\`.
- No OpenAI API SDK/API calls are made by S4.1.
- The child process receives only \`PATH\`, \`HOME\`, optional \`CODEX_HOME\`, and basic terminal variables: no \`OPENAI_API_KEY\`, \`DATABASE_URL\`, Solana RPC URLs or AWS secrets.
- Before **each** Codex execution, \`codex login status\` must identify authentication as **ChatGPT**. Any API-key login or unavailable auth blocks that agent. This reduces accidental paid API use; verify Codex config and account billing separately because custom configured model providers or future CLI changes can affect routing.
- Codex usage through ChatGPT is **quota-limited**. The exact allowance depends on your plan. On quota/auth failure, the agent errors out; the research pipeline does not switch providers.
- Codex runs in a temporary minimal working directory with \`--sandbox read-only --ask-for-approval never\`. Note: **read-only is not a complete secret-isolation boundary**; a local Codex process may still be able to read files accessible to the operating-system user. For stronger isolation run under a dedicated macOS account with no access to private keys, production credentials, personal files or MCP configurations. Do not treat prompt instructions as a security sandbox.

## Run on your Mac (Colima)

Prerequisites: S1a/PostgreSQL running; Node.js >=22; install an up-to-date Codex CLI on the host using the official CLI instructions; use **ChatGPT sign-in**.

\`\`\`bash
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
\`\`\`

For a single cheap/manual research task, select only one role:

\`\`\`bash
S4_CODEX_ENABLED=1 S4_DRY_RUN=0 \
npm run s4:run -- --context .solaris/s4-context.json --agents audit
\`\`\`

Optional \`S4_TIMEOUT_MS=120000\` caps each agent (15–300 seconds permitted). Each invocation makes at most one \`codex exec\` model call per requested role. Max five roles and concurrency=1. Automatic periodic scheduling is deliberately not installed.

## How it works

1. **Exporter (in Docker)**: \`src/s4/export-context.js\` SELECTs at most 20 pools and a tiny set of S1–S3 counts/statuses. If optional S2 or S3 tables do not exist, it emits \`unknown\`. It does NOT export raw transactions, full pool payloads, API keys, wallet signer material, the .env file or DB URLs.
2. **Policy layer**: \`src/s4/policy.js\` strips unexpected fields, validates timestamps and evidence IDs and limits text sizes.
3. **Codex host adapter**: \`src/s4/orchestrator.js\` verifies ChatGPT auth, invokes structured \`codex exec\` with a read-only sandbox and timeout, and validates each JSON output. Unknown evidence IDs, additional fields, any attempted trade order, and \`economics_authorized=true\` are rejected.
4. **Audit trail**: \`.solaris/s4-audit.ndjson\` records role, context digest, decision/status, evidence IDs, unknowns and next step. It is ignored by Git. Raw model terminal output is deliberately discarded. Logs may still contain potentially misleading model summaries; manually audit and protect the file.

Any model-produced recommendation is **research-only** and cannot authorize funds, execution, paper orders or strategy deployment.

## Sample output

\`\`\`json
{
  "mode": "DRY_RUN",
  "maxCalls": 0,
  "completed": 0,
  "economicsAuthorized": false,
  "liveTrading": false,
  "paidApiFallback": false
}
\`\`\`

**Ready for S4.2?** Not yet proven by offline CI alone. First run against real sanitized S1–S3 data and successful ChatGPT-authenticated Codex CLI outputs. Validate prompts and evidence IDs by human review; check quota consumption.

## Next roadmap

- S4.2: improved on-chain and security research evidence; add missing wallet/sentiment feeds only with source audit.
- S4.3: deterministic paper execution simulator and risk limits; must NEVER make real transactions.
- S4.4: resumption, scheduling, quota budgets and fail-closed backoff after end-to-end tests.
- Future optional API adapter: separate reviewed implementation behind explicit opt-in and spend caps. **Not enabled or implemented in S4.1**.
