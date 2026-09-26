import type { Migration } from '@hypertest/core';

/**
 * Context engine tables. `ht_vectors` is deliberately NOT here: it needs the pgvector extension and is created
 * lazily by createPgVectorIndex (which throws `unsupported` when the extension is unavailable).
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
];
