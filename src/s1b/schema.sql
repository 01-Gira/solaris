-- S1b is append-only and separate from S1a. No wallet/signing/trade execution.
CREATE TABLE IF NOT EXISTS onchain_pool_events (
  id BIGSERIAL PRIMARY KEY,
  pool_address TEXT NOT NULL REFERENCES pools(pool_address),
  signature TEXT NOT NULL,
  slot BIGINT NOT NULL CHECK (slot >= 0),
  notification_error JSONB,
  logs JSONB NOT NULL DEFAULT '[]'::jsonb,
  source TEXT NOT NULL CHECK (source IN ('live','backfill')),
  first_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tx_status TEXT NOT NULL DEFAULT 'pending' CHECK (tx_status IN ('pending','resolved','unavailable')),
  tx_attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fetch_error TEXT,
  UNIQUE(pool_address,signature)
);
CREATE INDEX IF NOT EXISTS onchain_events_retry_idx ON onchain_pool_events (next_retry_at,first_received_at) WHERE tx_status = 'pending';
CREATE INDEX IF NOT EXISTS onchain_events_pool_slot_idx ON onchain_pool_events (pool_address,slot DESC,id DESC);
CREATE TABLE IF NOT EXISTS onchain_transactions (
  signature TEXT PRIMARY KEY,
  slot BIGINT NOT NULL,
  block_time TIMESTAMPTZ,
  tx_error JSONB,
  fee_lamports BIGINT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS onchain_token_balance_changes (
  signature TEXT NOT NULL REFERENCES onchain_transactions(signature),
  account_index INTEGER NOT NULL,
  mint TEXT NOT NULL,
  owner TEXT,
  program_id TEXT,
  decimals INTEGER,
  pre_amount TEXT NOT NULL,
  post_amount TEXT NOT NULL,
  delta_raw TEXT NOT NULL,
  PRIMARY KEY(signature,account_index,mint)
);
-- audit indicates only attempted recovery; it never claims chain-complete history.
CREATE TABLE IF NOT EXISTS onchain_recovery_audits (
  id BIGSERIAL PRIMARY KEY,
  pool_address TEXT NOT NULL REFERENCES pools(pool_address),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  previous_signature TEXT,
  recovered_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('running','bounded','seeded_limited','error')),
  details TEXT
);
CREATE TABLE IF NOT EXISTS onchain_stream_health (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  state TEXT NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  active_pools INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_event_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS onchain_watch_sessions (
  id BIGSERIAL PRIMARY KEY,
  pool_address TEXT NOT NULL REFERENCES pools(pool_address),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'subscribed',
  previous_signature TEXT,
  end_reason TEXT
);
CREATE INDEX IF NOT EXISTS onchain_watch_pool_time_idx ON onchain_watch_sessions(pool_address,started_at DESC);

-- S1b.2 provider-wide rate slot reservation shared by stream & hydration.
-- A hash of the endpoint is the key; credentials/URLs are never stored.
CREATE TABLE IF NOT EXISTS onchain_rpc_request_budget (
 provider_key TEXT PRIMARY KEY CHECK(length(provider_key)=64),
 next_allowed_at TIMESTAMPTZ NOT NULL
);
