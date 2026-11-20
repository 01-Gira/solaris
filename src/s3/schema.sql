-- S3 research artefacts are append-only. No S1a/S1b mutation. Exploratory evidence only.
CREATE TABLE IF NOT EXISTS s3_research_runs (
 id BIGSERIAL PRIMARY KEY,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 engine_version TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('audit','exploratory_proxy')),
 status TEXT NOT NULL CHECK(status IN ('BLOCKED_DATA','RESEARCH_ONLY_BLOCKED')),
 economics_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK(economics_authorized=FALSE),
 inputs JSONB NOT NULL,
 report JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS s3_pool_coverage (
 run_id BIGINT NOT NULL REFERENCES s3_research_runs(id),
 pool_address TEXT NOT NULL REFERENCES pools(pool_address),
 ready BOOLEAN NOT NULL,
 observations INTEGER NOT NULL,
 span_minutes DOUBLE PRECISION,
 max_gap_minutes DOUBLE PRECISION,
 distinct_prices INTEGER,
 failures JSONB NOT NULL,
 PRIMARY KEY (run_id,pool_address)
);
CREATE TABLE IF NOT EXISTS s3_proxy_trades (
 id BIGSERIAL PRIMARY KEY,
 run_id BIGINT NOT NULL REFERENCES s3_research_runs(id),
 pool_address TEXT NOT NULL REFERENCES pools(pool_address),
 strategy TEXT NOT NULL,
 signal_at TIMESTAMPTZ NOT NULL,
 entry_at TIMESTAMPTZ,
 exit_at TIMESTAMPTZ,
 signal_price DOUBLE PRECISION NOT NULL,
 entry_mark DOUBLE PRECISION,
 exit_mark DOUBLE PRECISION,
 proxy_net_return DOUBLE PRECISION,
 censored BOOLEAN NOT NULL,
 reason TEXT,
 dataset_split TEXT CHECK(dataset_split IN ('discovery','validation','test') OR dataset_split IS NULL),
 feature_evidence JSONB NOT NULL,
 CHECK (censored OR (entry_at IS NOT NULL AND exit_at IS NOT NULL AND proxy_net_return IS NOT NULL)),
 CHECK (proxy_net_return IS NULL OR (proxy_net_return >= -1 AND proxy_net_return < 100000))
);
CREATE INDEX IF NOT EXISTS s3_proxy_trades_run_idx ON s3_proxy_trades(run_id,strategy,dataset_split);
