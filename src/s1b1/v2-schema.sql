-- V2 candidates are versioned diagnostic outcomes, NOT swap/fill records.
-- Existing onchain_trade_decodes V1 rows remain untouched.
CREATE TABLE IF NOT EXISTS onchain_trade_candidate_v2 (
 pool_address TEXT NOT NULL,
 signature TEXT NOT NULL,
 candidate_version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('failed_onchain','no_known_program','unverified_program_usage','single_trade_candidate','multiple_trade_candidates','unknown')),
 trade_candidate_count INTEGER NOT NULL CHECK(trade_candidate_count>=0),
 known_program_instruction_count INTEGER NOT NULL CHECK(known_program_instruction_count>=0),
 unknown_known_program_instruction_count INTEGER NOT NULL CHECK(unknown_known_program_instruction_count>=0),
 has_inner_candidate BOOLEAN NOT NULL,
 has_outer_candidate BOOLEAN NOT NULL,
 contains_pumpfun BOOLEAN NOT NULL,
 contains_pumpswap BOOLEAN NOT NULL,
 verified_fill BOOLEAN NOT NULL DEFAULT false CHECK(verified_fill=false),
 economics_authorized BOOLEAN NOT NULL DEFAULT false CHECK(economics_authorized=false),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(pool_address,signature,candidate_version),
 FOREIGN KEY(pool_address,signature) REFERENCES onchain_pool_events(pool_address,signature)
);
CREATE INDEX IF NOT EXISTS candidate_v2_status_idx ON onchain_trade_candidate_v2(candidate_version,status);
