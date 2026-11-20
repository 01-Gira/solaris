-- SOLARIS S1b.1: derived analysis only. Never alter raw S1a/S1b evidence.
CREATE TABLE IF NOT EXISTS onchain_trade_decodes (
  pool_address TEXT NOT NULL,
  signature TEXT NOT NULL,
  decoder_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unknown','failed_onchain','unsupported_dex','unrelated_pool','ambiguous','unsupported_variant','direction_only','matched_quote_delta')),
  reason TEXT,
  dex TEXT,
  instruction_name TEXT,
  program_id TEXT,
  side TEXT CHECK (side IN ('BUY','SELL') OR side IS NULL),
  wallet TEXT,
  base_mint TEXT,
  quote_mint TEXT,
  base_amount_raw TEXT,
  quote_amount_raw TEXT,
  price_quote_per_base TEXT,
  price_sol TEXT,
  evidence JSONB NOT NULL,
  decoded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pool_address,signature),
  FOREIGN KEY (pool_address,signature) REFERENCES onchain_pool_events(pool_address,signature)
);
CREATE INDEX IF NOT EXISTS trade_decodes_status_idx ON onchain_trade_decodes(status,decoded_at DESC);
CREATE INDEX IF NOT EXISTS trade_decodes_pool_idx ON onchain_trade_decodes(pool_address,decoded_at DESC);
