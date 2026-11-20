# Solana S1 — Market Data Recorder (MVP)

**Status:** S1 initial implementation; local tests runnable offline. **This is NOT a trading bot.**

Read-only Solana pool discovery through GeckoTerminal public REST API. Saves the unmodified raw provider responses, normalized pools, observation snapshots, and polling audit metadata to PostgreSQL. Serves a zero-build local dashboard and CSV export.

## Quick start (macOS / Linux with Docker)

```bash
cp .env.example .env
# Edit .env and replace POSTGRES_PASSWORD; update DATABASE_URL password to match.
docker compose up -d --build
docker compose ps
docker compose logs -f recorder
```

Open <http://localhost:8787>. The HTTP port is published to **127.0.0.1 only**. On a remote VPS, use an SSH tunnel:

```bash
ssh -L 8787:127.0.0.1:8787 USER@YOUR_VPS
```

First poll begins after startup, assuming internet access to GeckoTerminal. Do not expose this dashboard directly to the internet; this research MVP has no login.

### Local validation without Docker

```bash
node --version # requires Node.js 22+
npm test
npm run check
```

To run the full application locally instead of Docker you need PostgreSQL 16 and `pg` installed (`npm install`), then set `DATABASE_URL` and start `npm start`. **npm install and Docker image pull require internet.**

## Data source and limits

- `GET https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=N&include=base_token,quote_token,dex` (default: first 2 pages every 30 seconds)
- `GET /networks/solana/pools/multi/{addresses}?include=base_token,quote_token,dex` (default: up to 20 previously discovered pools, excluding freshly polled pools, in 1 extra request/cycle)
- Default approximate budget: **up to 6 HTTP calls/minute**, below the public docs' approximate 10 calls/minute (provider can still throttle). HTTP 429 triggers backoff; failures are recorded.
- Public API is *indexed/cached*, not on-chain streaming. **Not every Solana mint/pool will be discovered**, and pool discovery can lag behind creation. Paginated lists limit coverage. There are no on-chain transaction signatures, blockchain slots, individual swaps, true tick timestamps or executed fills in this version.
- Each snapshot's `observed_at` is **the response completion time**, not transaction time. The provider's `pool_created_at` is stored independently.
- `volume_m5_usd`, `volume_h24_usd`, and `buys_m5` are **rolling provider-window aggregates**. Do NOT sum consecutive snapshots or interpret them as incremental trades.
- Pool watchlist refresh is limited to pools first seen in the last 2 hours. Pools outside the watchlist do not get a continuous history. S1b should use paid high-fidelity event streams for exhaustive tick/trade coverage.
- No key, wallet, signing or trade execution code exists.

## Files

| Path | Description |
|---|---|
| `src/collector.js` | Scheduled polling, retries, run audit |
| `src/gecko.js` | GeckoTerminal HTTP adapter |
| `src/normalize.js` | Defensive token/pool parser |
| `src/db.js`, `src/schema.sql` | PostgreSQL persistence, raw response archives |
| `src/server.js`, `public/` | Local API and dashboard |
| `fixtures/`, `test/` | Synthetic fixtures and offline tests |
| `docs/ACCEPTANCE.md` | Stage gates and S1b upgrade work |

## API endpoints

| Method | Endpoint | Meaning |
|---|---|---|
| GET | `/healthz` | Database readiness |
| GET | `/api/status` | Counts, venue coverage, last run, 24h success rate |
| GET | `/api/pools?limit=150&family=pumpswap` | Latest discovered pool entities |
| GET | `/api/pools/{address}/snapshots?limit=100` | Observations for a Solana pool |
| GET | `/api/runs?limit=30` | Polling and exception audit |
| GET | `/api/export.csv?limit=5000` | Recent observations CSV export |

### Useful commands

```bash
docker compose logs --tail=50 recorder
curl -fsS http://localhost:8787/healthz
curl -fsS http://localhost:8787/api/status
curl -fsS 'http://localhost:8787/api/pools?limit=10'
curl -fsS 'http://localhost:8787/api/runs?limit=5'
# Explicitly prune old raw responses only (does NOT delete snapshots):
docker compose exec recorder node scripts/prune.js --raw-days=7
```

## Database

- `raw_responses`: original HTTP response body text plus parsed JSONB, fetch time, SHA-256, endpoint, poll run
- `pools`: unique pool address, token mints, venue, provider creation time, first/last observation and latest values
- `pool_snapshots`: observed price, liquidity, 5m and 24h rolling volumes, 5m buy/sell counts
- `poll_runs`: cycle status (`success`, `partial`, `failed`), error, pages, new pool count, duplicates

No automatic retention pruning. Monitor storage. The optional manual pruning tool deletes old raw responses and is irreversible.

## Known caveats / data hygiene

1. A public index of new pools is a *sample*, not a chain-complete list. It should not be used as a label universe for survivorship-free performance research without upstream completeness audits.
2. Re-running a new-pool page can produce the same content due to source caching. We store each observation and the response hash to allow diagnosing this.
3. API time is not blockchain event time. Avoid using creation timestamps as knowledge available before first observation (look-ahead bias).
4. Trade execution quality, token holders, contract metadata, rug risk, wallet tracking, and per-swap economics are **not present in S1 MVP**.
5. Venue labels use the provider's `dex` relationship. Unknown DEXs are saved as `other`, never silently dropped.
6. No production security/authentication, no retention policy, and no database partitioning yet. Don't expose outside localhost/SSH tunnel.
7. This source has no signed guarantee of a fixed interval or complete coverage. Even successful polling does not prove completeness.

## Official API references

- GeckoTerminal public reference: https://api.geckoterminal.com/docs/index.html
- GeckoTerminal new pools: https://api.geckoterminal.com/api/v2/networks/solana/new_pools
- GeckoTerminal multi pool endpoint: https://api.geckoterminal.com/docs/index.html

**No economic profitability claims** are made by this project.
