-- SOLARIS S4.2A. Persistent research orchestration only; never places trades.
CREATE TABLE IF NOT EXISTS s42_research_tasks (
 id BIGSERIAL PRIMARY KEY,
 task_key CHAR(64) NOT NULL UNIQUE,
 context_sha256 CHAR(64) NOT NULL,
 evidence JSONB NOT NULL,
 roles JSONB NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','blocked')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 blocked_reason TEXT,
 economics_authorized BOOLEAN NOT NULL DEFAULT false CHECK(economics_authorized=false)
);
CREATE TABLE IF NOT EXISTS s42_agent_steps (
 task_id BIGINT NOT NULL REFERENCES s42_research_tasks(id),
 role TEXT NOT NULL CHECK(role IN ('discovery','onchain','security','strategy','audit')),
 ordinal SMALLINT NOT NULL CHECK(ordinal BETWEEN 0 AND 4),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reserved','completed','error')),
 decision JSONB,
 error_code TEXT,
 reserved_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ,
 PRIMARY KEY(task_id,role),
 UNIQUE(task_id,ordinal)
);
CREATE TABLE IF NOT EXISTS s42_daily_call_budget (
 day_utc DATE PRIMARY KEY,
 calls_reserved INTEGER NOT NULL DEFAULT 0 CHECK(calls_reserved>=0)
);
CREATE TABLE IF NOT EXISTS s42_progress_events (
 id BIGSERIAL PRIMARY KEY,
 task_id BIGINT NOT NULL REFERENCES s42_research_tasks(id),
 role TEXT,
 kind TEXT NOT NULL,
 at TIMESTAMPTZ NOT NULL DEFAULT now(),
 details JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS s42_tasks_ready_idx ON s42_research_tasks(status,created_at,id);
CREATE INDEX IF NOT EXISTS s42_progress_task_idx ON s42_progress_events(task_id,id DESC);
