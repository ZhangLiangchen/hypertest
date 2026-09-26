import type { Migration } from '@hypertest/core';

/**
 * Context engine tables. `ht_vectors` is deliberately NOT here: it needs the pgvector extension and is created
 * lazily by createPgVectorIndex (which throws `unsupported` when the extension is unavailable).
 * 003 — ht_context_observations: the ObservationLog (append-only: UPDATE/DELETE/TRUNCATE refused by triggers).
 *
 * ht_context_snapshots.ord is an insertion-order tie breaker for latest(): several snapshots of one run can share
 * a created_at millisecond (and always do under a FixedClock).
 */
export const contextMigrations: Migration[] = [
  {
    id: 'context/001-snapshots',
    sql: `
CREATE TABLE IF NOT EXISTS ht_context_snapshots (
  snapshot_id text PRIMARY KEY,
  run_id text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  ord bigserial NOT NULL
);
CREATE INDEX IF NOT EXISTS ht_context_snapshots_run_created_idx ON ht_context_snapshots (run_id, created_at);
`,
  },
  {
    id: 'context/002-experience',
    sql: `
CREATE TABLE IF NOT EXISTS ht_experience (
  experience_id text PRIMARY KEY,
  scope jsonb NOT NULL,
  scope_project text,
  scope_role text,
  scope_topic text,
  kind text NOT NULL,
  content text NOT NULL,
  source_run_id text NOT NULL,
  evidence_refs jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('candidate', 'reviewed', 'approved', 'published', 'quarantined', 'rejected')),
  created_by text NOT NULL,
  reviewed_by text,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ht_experience_status_idx ON ht_experience (status);
CREATE INDEX IF NOT EXISTS ht_experience_source_run_idx ON ht_experience (source_run_id);
`,
  },
  {
    // What agents OBSERVED through their tool calls (files read and written, records read and posted, metric windows,
    // environment generations): the ReadSet source of the next turn's snapshot and the FreshnessGuard's intra-turn
    // refinement. Append-only: an observation is a fact about the past (UPDATE, DELETE and TRUNCATE are refused, 42501 —
    // deleting an agent's latest observation would roll its pin back or drop it, leaving a later mutation unchecked).
    id: 'context/003-observations',
    sql: `
CREATE TABLE IF NOT EXISTS ht_context_observations (
  seq bigserial PRIMARY KEY,
  run_id text NOT NULL,
  agent_id text NOT NULL,
  work_item_id text,
  snapshot_id text,
  tool_id text NOT NULL,
  invocation_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('read', 'write')),
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  observed_version text NOT NULL,
  observed_at timestamptz NOT NULL,
  freshness jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS ht_context_observations_agent_idx ON ht_context_observations (run_id, agent_id, resource_type, resource_id, seq);
CREATE INDEX IF NOT EXISTS ht_context_observations_snapshot_idx ON ht_context_observations (run_id, agent_id, snapshot_id);

CREATE OR REPLACE FUNCTION ht_context_observations_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END
$$;
DROP TRIGGER IF EXISTS ht_context_observations_no_update ON ht_context_observations;
CREATE TRIGGER ht_context_observations_no_update BEFORE UPDATE OR DELETE ON ht_context_observations FOR EACH ROW EXECUTE FUNCTION ht_context_observations_append_only();
DROP TRIGGER IF EXISTS ht_context_observations_no_truncate ON ht_context_observations;
CREATE TRIGGER ht_context_observations_no_truncate BEFORE TRUNCATE ON ht_context_observations FOR EACH STATEMENT EXECUTE FUNCTION ht_context_observations_append_only();
`,
  },
];
