-- Derived assessments only. S1a/S1b raw evidence is immutable.
CREATE TABLE IF NOT EXISTS s2_pool_assessments (
 pool_address TEXT PRIMARY KEY REFERENCES pools(pool_address),
 version TEXT NOT NULL,
 assessed_at TIMESTAMPTZ NOT NULL,
 risk_band TEXT NOT NULL CHECK(risk_band IN ('reject','unknown','review')),
 observed_concern_score INTEGER NOT NULL CHECK(observed_concern_score BETWEEN 0 AND 100),
 tradability TEXT NOT NULL DEFAULT 'blocked' CHECK(tradability='blocked'),
 reasons JSONB NOT NULL,
 unknowns JSONB NOT NULL,
 evidence JSONB NOT NULL,
 economics_authorized BOOLEAN NOT NULL DEFAULT FALSE CHECK(economics_authorized=FALSE)
);
CREATE INDEX IF NOT EXISTS s2_assessments_band_idx ON s2_pool_assessments(risk_band,assessed_at DESC);
