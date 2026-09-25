import type { Migration } from '@hypertest/core';

/**
 * Schema of @hypertest/operation. Portable across PGlite and PostgreSQL 16.
 *
 * - ht_operations: the Operation Ledger (authority for "did the external side effect happen").
 * - ht_fences: per-resource fencing counter (`last_token`, never reused, survives release) and the
 *   highest token a target accepted (`highest_accepted`).
 * - ht_leases: the live write lease per resource (one row per resource; regrant replaces the row).
 * - ht_admission_lock + ht_resource_claims: experiment isolation claims, admitted under one lock row.
 * - ht_budget_scopes + ht_budget_reservations: budget leases (reserve → settle | release).
 */
export const operationMigrations: Migration[] = [
  {
    id: 'operation/001-operations',
    sql: `
CREATE TABLE ht_operations (
  operation_id text PRIMARY KEY,
  run_id text NOT NULL,
  work_item_id text NOT NULL,
  agent_id text,
  tool_invocation_id text,
  operation_type text NOT NULL,
  adapter_id text NOT NULL,
  target jsonb NOT NULL,
  desired_state_hash text NOT NULL,
  input_hash text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  lease jsonb,
  status text NOT NULL CHECK (status IN ('prepared', 'dispatching', 'acknowledged', 'verified', 'not_applied', 'outcome_unknown',
    'reconciling', 'compensating', 'compensated', 'manual_review', 'failed')),
  external_job_id text,
  external_receipt text,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  result jsonb,
  last_error text,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX ht_operations_invocation_uq ON ht_operations (tool_invocation_id, operation_type);
CREATE INDEX ht_operations_run_status_idx ON ht_operations (run_id, status);
CREATE INDEX ht_operations_status_idx ON ht_operations (status);
`,
  },
  {
    id: 'operation/002-leases',
    sql: `
CREATE TABLE ht_fences (
  resource_key text PRIMARY KEY,
  last_token bigint NOT NULL DEFAULT 0,
  highest_accepted bigint NOT NULL DEFAULT 0
);
CREATE TABLE ht_leases (
  resource_key text PRIMARY KEY,
  lease_id text NOT NULL UNIQUE,
  owner text NOT NULL,
  fencing_token bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL
);
`,
  },
  {
    id: 'operation/003-resource-claims',
    sql: `
CREATE TABLE ht_admission_lock (lock_id integer PRIMARY KEY);
INSERT INTO ht_admission_lock (lock_id) VALUES (1);
CREATE TABLE ht_resource_claims (
  claim_id text PRIMARY KEY,
  holder_id text NOT NULL,
  run_id text NOT NULL,
  resource_key text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('read_shared', 'write_exclusive', 'fault_exclusive')),
  quantity double precision,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX ht_resource_claims_holder_idx ON ht_resource_claims (holder_id);
CREATE INDEX ht_resource_claims_run_idx ON ht_resource_claims (run_id);
CREATE INDEX ht_resource_claims_expires_idx ON ht_resource_claims (expires_at);
`,
  },
  {
    id: 'operation/004-budgets',
    sql: `
CREATE TABLE ht_budget_scopes (
  scope text PRIMARY KEY,
  parent_scope text REFERENCES ht_budget_scopes (scope),
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  used jsonb NOT NULL DEFAULT '{}'::jsonb,
  reserved jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE ht_budget_reservations (
  reservation_id text PRIMARY KEY,
  scopes jsonb NOT NULL,
  amounts jsonb NOT NULL,
  actual jsonb,
  status text NOT NULL CHECK (status IN ('reserved', 'settled', 'released')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX ht_budget_reservations_status_idx ON ht_budget_reservations (status);
`,
  },
];
