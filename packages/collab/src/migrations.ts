import type { Migration } from '@hypertest/core';

/**
 * Schema of @hypertest/collab. Portable across PGlite and PostgreSQL 16.
 *
 * 001 — L0 event store and delivery bookkeeping:
 *   ht_run_counters  per-run lock row: gap-free event `last_seq` and the blackboard revision `bb_revision`.
 *   ht_events        immutable domain events (L0), unique (run_id, seq).
 *   ht_outbox        transactional outbox (same tx as the state change), relayed to the bus.
 *   ht_inbox         consumer-side dedupe by (consumer, event_id) (I5).
 * 002 — collaboration state (Blackboard): ht_runs, ht_records, ht_work_items, ht_plans.
 * 003 — revisioned specs and decisions: ht_system_models, ht_oracles, ht_oracle_proposals, ht_experiments,
 *       ht_test_artifacts, ht_decisions.
 * 004 — ht_work_items.fence_high_water (monotonic fencing across requeues).
 *
 * Domain objects are stored whole in a jsonb column (the value returned to callers); the scalar columns
 * beside them exist for filtering, uniqueness and ordering and are written in the same statement.
 */
export const collabMigrations: Migration[] = [
  {
    id: 'collab/001-events',
    sql: `
CREATE TABLE ht_run_counters (
  run_id text PRIMARY KEY,
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  bb_revision bigint NOT NULL DEFAULT 0 CHECK (bb_revision >= 0)
);

CREATE TABLE ht_events (
  event_id text PRIMARY KEY,
  run_id text NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  correlation_id text NOT NULL,
  causation_id text,
  actor_id text NOT NULL,
  work_item_id text,
  agent_id text,
  schema_version text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE INDEX ht_events_run_type_idx ON ht_events (run_id, event_type);
CREATE INDEX ht_events_causation_idx ON ht_events (causation_id);

CREATE TABLE ht_outbox (
  id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  subject text NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  sent_at timestamptz
);
CREATE INDEX ht_outbox_unsent_idx ON ht_outbox (id) WHERE sent_at IS NULL;

CREATE TABLE ht_inbox (
  consumer text NOT NULL,
  event_id text NOT NULL,
  consumed_at timestamptz NOT NULL,
  PRIMARY KEY (consumer, event_id)
);
`,
  },
  {
    id: 'collab/002-blackboard',
    sql: `
CREATE TABLE ht_runs (
  run_id text PRIMARY KEY,
  status text NOT NULL,
  goal text NOT NULL,
  run jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX ht_runs_status_idx ON ht_runs (status, created_at);

CREATE TABLE ht_records (
  record_id text PRIMARY KEY,
  lineage_id text NOT NULL,
  record_type text NOT NULL,
  run_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  version integer NOT NULL CHECK (version > 0),
  created_by text NOT NULL,
  work_item_id text,
  payload jsonb NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  supersedes text,
  is_head boolean NOT NULL,
  status text GENERATED ALWAYS AS (payload ->> 'status') STORED,
  created_at timestamptz NOT NULL,
  UNIQUE (lineage_id, version),
  UNIQUE (run_id, revision)
);
CREATE UNIQUE INDEX ht_records_one_head_idx ON ht_records (lineage_id) WHERE is_head;
CREATE INDEX ht_records_query_idx ON ht_records (run_id, record_type, revision);

CREATE TABLE ht_work_items (
  work_item_id text PRIMARY KEY,
  run_id text NOT NULL,
  kind text NOT NULL,
  role text NOT NULL,
  state text NOT NULL CHECK (state IN ('proposed', 'ready', 'blocked', 'claimed', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
  title text NOT NULL,
  priority double precision NOT NULL,
  plan_revision integer,
  parent_work_item_id text,
  depth integer NOT NULL CHECK (depth >= 0),
  fingerprint text NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0),
  claim_owner_id text,
  claim_fencing_token bigint,
  agent_id text,
  causation_event_id text,
  revision bigint NOT NULL,
  item jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (run_id, fingerprint)
);
CREATE INDEX ht_work_items_state_idx ON ht_work_items (run_id, state);

CREATE TABLE ht_plans (
  run_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  plan_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
  plan jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  PRIMARY KEY (run_id, revision)
);
`,
  },
  {
    id: 'collab/003-specs',
    sql: `
CREATE TABLE ht_system_models (
  system_model_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  run_id text NOT NULL,
  model jsonb NOT NULL,
  write_seq bigserial NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (system_model_id, revision)
);
CREATE INDEX ht_system_models_run_idx ON ht_system_models (run_id, write_seq);

CREATE TABLE ht_oracles (
  oracle_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (oracle_id, revision)
);

CREATE TABLE ht_oracle_proposals (
  proposal_id text PRIMARY KEY,
  run_id text NOT NULL,
  oracle_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  proposal jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX ht_oracle_proposals_run_idx ON ht_oracle_proposals (run_id, status);

CREATE TABLE ht_experiments (
  experiment_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  run_id text NOT NULL,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (experiment_id, revision)
);
CREATE INDEX ht_experiments_run_idx ON ht_experiments (run_id);

CREATE TABLE ht_test_artifacts (
  artifact_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  run_id text NOT NULL,
  approval_state text NOT NULL,
  artifact jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (artifact_id, revision)
);
CREATE INDEX ht_test_artifacts_run_idx ON ht_test_artifacts (run_id);

CREATE TABLE ht_decisions (
  decision_id text PRIMARY KEY,
  run_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  supersedes text,
  verdict text NOT NULL,
  decision jsonb NOT NULL,
  oracle_revisions jsonb NOT NULL,
  needs_reassessment boolean NOT NULL DEFAULT false,
  reassessment_reason text,
  decided_at timestamptz NOT NULL,
  UNIQUE (run_id, revision)
);
CREATE INDEX ht_decisions_oracle_revisions_idx ON ht_decisions USING gin (oracle_revisions);
`,
  },
  {
    // Highest fencing token ever granted on a work item. It survives claim clearing (requeue), so a claim with an
    // older token — a stale lease re-used after the item moved on — is refused (I4 monotonic fencing).
    id: 'collab/004-work-fencing',
    sql: `
ALTER TABLE ht_work_items ADD COLUMN fence_high_water bigint NOT NULL DEFAULT 0 CHECK (fence_high_water >= 0);
`,
  },
];
