import type { Migration } from '@hypertest/core';

/**
 * Control-plane tables (PGlite + PostgreSQL 16). Everything else the control plane reads or writes lives in the
 * owning packages' tables (collab, operation, evidence, policy, context, runtime).
 *
 *  ht_manifests        pinned RuntimeManifests (I11), content-addressed and immutable
 *  ht_run_gates        the GateSpec of each run (DEFAULT_GATE_SPEC ⊕ config ⊕ input)
 *  ht_reactor_cursors  per (run, consumer) L0 position of the reactor catch-up
 *  ht_claims           evidence-backed report claims (evidence.claim), inputs of the gate and the report
 *  ht_replans          replan bookkeeping: replan ordinal, last reason, gate attempts and pending gate feedback
 *  ht_agent_hosts      what is needed to rebuild an agent's EngineHost after a restart (capability, policies,
 *                      workspace recipe) — the runtime does not store model/tool policies
 *  002 (governance):
 *  ht_run_gates        + base_gate (DEFAULT_GATE_SPEC ⊕ config at start), weakened (the fields the run's override weakens),
 *                      override_by / override_rationale (the recorded human/system authority of a weakening, conformance-9)
 *  ht_delegations      one row per delegated child work item: parent, background / continuable, the parent's queued
 *                      messages (delegate.message) and the release of a continuable child
 */
export const controlMigrations: Migration[] = [
  {
    id: 'control/001-control',
    sql: `
CREATE TABLE ht_manifests (
  manifest_id text PRIMARY KEY,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE ht_run_gates (
  run_id text PRIMARY KEY,
  gate jsonb NOT NULL
);

CREATE TABLE ht_reactor_cursors (
  run_id text NOT NULL,
  consumer text NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, consumer)
);

CREATE TABLE ht_claims (
  claim_id text PRIMARY KEY,
  run_id text NOT NULL,
  claim jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX ht_claims_run_idx ON ht_claims (run_id, created_at);

CREATE TABLE ht_replans (
  run_id text PRIMARY KEY,
  revision_count integer NOT NULL DEFAULT 0,
  last_reason text,
  gate_attempts integer NOT NULL DEFAULT 0,
  feedback jsonb,
  feedback_pending boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL
);

CREATE TABLE ht_agent_hosts (
  agent_id text PRIMARY KEY,
  run_id text NOT NULL,
  work_item_id text NOT NULL,
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX ht_agent_hosts_work_idx ON ht_agent_hosts (work_item_id);
`,
  },
  {
    id: 'control/002-governance',
    sql: `
ALTER TABLE ht_run_gates ADD COLUMN base_gate jsonb;
ALTER TABLE ht_run_gates ADD COLUMN weakened jsonb;
ALTER TABLE ht_run_gates ADD COLUMN override_by jsonb;
ALTER TABLE ht_run_gates ADD COLUMN override_rationale text;

CREATE TABLE ht_delegations (
  child_work_item_id text PRIMARY KEY,
  run_id text NOT NULL,
  parent_work_item_id text NOT NULL,
  parent_agent_id text NOT NULL,
  background boolean NOT NULL DEFAULT false,
  continuable boolean NOT NULL DEFAULT false,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz NOT NULL
);
CREATE INDEX ht_delegations_parent_idx ON ht_delegations (parent_work_item_id);
CREATE INDEX ht_delegations_run_idx ON ht_delegations (run_id);
`,
  },
];
