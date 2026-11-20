CREATE TABLE IF NOT EXISTS poll_runs (
    id BIGSERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
    pages_fetched INTEGER NOT NULL DEFAULT 0,
    pools_seen INTEGER NOT NULL DEFAULT 0,
    newly_discovered INTEGER NOT NULL DEFAULT 0,
    duplicate_in_run INTEGER NOT NULL DEFAULT 0,
    error TEXT
);
CREATE INDEX IF NOT EXISTS poll_runs_started_idx ON poll_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS raw_responses (
    id BIGSERIAL PRIMARY KEY,
    poll_run_id BIGINT NOT NULL REFERENCES poll_runs(id),
    provider TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    page INTEGER NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL,
    response_sha256 TEXT NOT NULL,
    pool_count INTEGER NOT NULL,
    payload JSONB NOT NULL,
    raw_body TEXT NOT NULL,
    UNIQUE (poll_run_id, page)
);
CREATE INDEX IF NOT EXISTS raw_responses_fetched_idx ON raw_responses (fetched_at DESC);

CREATE TABLE IF NOT EXISTS pools (
    pool_address TEXT PRIMARY KEY,
    source_pool_id TEXT,
    dex_id TEXT,
    venue_family TEXT NOT NULL DEFAULT 'other',
    name TEXT,
    base_mint TEXT,
    quote_mint TEXT,
    base_symbol TEXT,
    quote_symbol TEXT,
    pool_created_at TIMESTAMPTZ,
    first_seen_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    last_price_usd NUMERIC,
    last_liquidity_usd NUMERIC,
    last_volume_h24_usd NUMERIC,
    last_buys_m5 INTEGER,
    last_sells_m5 INTEGER,
    last_raw JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS pools_first_seen_idx ON pools (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS pools_family_idx ON pools (venue_family, first_seen_at DESC);

CREATE TABLE IF NOT EXISTS pool_snapshots (
    id BIGSERIAL PRIMARY KEY,
    pool_address TEXT NOT NULL REFERENCES pools(pool_address),
    poll_run_id BIGINT NOT NULL REFERENCES poll_runs(id),
    observed_at TIMESTAMPTZ NOT NULL,
    price_usd NUMERIC,
    liquidity_usd NUMERIC,
    volume_h24_usd NUMERIC,
    volume_m5_usd NUMERIC,
    buys_m5 INTEGER,
    sells_m5 INTEGER,
    source_data JSONB NOT NULL,
    UNIQUE (poll_run_id, pool_address)
);
CREATE INDEX IF NOT EXISTS pool_snapshots_history_idx ON pool_snapshots (pool_address, observed_at DESC);
CREATE INDEX IF NOT EXISTS pool_snapshots_observed_idx ON pool_snapshots (observed_at DESC);

-- Observed_at is the HTTP response completion time, NOT the on-chain event time.
-- volume_m5 and volume_h24 are rolling provider windows, NOT interval traded volume.
-- No trades, signatures, slot or swap events are available through this MVP endpoint.
