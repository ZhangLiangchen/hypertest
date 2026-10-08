import type { Migration } from '@hypertest/core';

/**
 * Policy schema. `ht_policy_decisions` is an audit log and append-only at the database level (UPDATE,
 * DELETE and TRUNCATE are rejected by triggers). `ht_approval_consumptions` (004, E[8]): the single consumption of an
 * approved action approval (append-only). `ht_approvals` rows move pending → approved|denied|expired
 * exactly once (guarded by a conditional UPDATE in the service and a transition trigger here).
 */
export const policyMigrations: Migration[] = [
  {
    id: 'policy/001-policy-decisions',
    sql: `
CREATE TABLE IF NOT EXISTS ht_policy_decisions (
  decision_id     text PRIMARY KEY,
  run_id          text NOT NULL,
  request_id      text NOT NULL,
  request_hash    text NOT NULL,
  decision        text NOT NULL CHECK (decision IN ('allow', 'deny', 'approval_required')),
  tool            text NOT NULL,
  effect          text NOT NULL,
  work_item_id    text,
  agent_id        text,
  policy_revision text NOT NULL,
  request         jsonb NOT NULL,
  permit          jsonb NOT NULL,
  decided_at      timestamptz NOT NULL,
  seq             bigserial NOT NULL
);

CREATE INDEX IF NOT EXISTS ht_policy_decisions_run_idx ON ht_policy_decisions (run_id, seq);
CREATE INDEX IF NOT EXISTS ht_policy_decisions_request_idx ON ht_policy_decisions (request_hash);

CREATE OR REPLACE FUNCTION ht_policy_decisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END
$$;

DROP TRIGGER IF EXISTS ht_policy_decisions_no_mutation ON ht_policy_decisions;
CREATE TRIGGER ht_policy_decisions_no_mutation BEFORE UPDATE OR DELETE ON ht_policy_decisions
  FOR EACH ROW EXECUTE FUNCTION ht_policy_decisions_append_only();
DROP TRIGGER IF EXISTS ht_policy_decisions_no_truncate ON ht_policy_decisions;
CREATE TRIGGER ht_policy_decisions_no_truncate BEFORE TRUNCATE ON ht_policy_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION ht_policy_decisions_append_only();
`,
  },
  {
    id: 'policy/002-approvals',
    sql: `
CREATE TABLE IF NOT EXISTS ht_approvals (
  approval_id  text PRIMARY KEY,
  run_id       text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('action', 'oracle_change', 'test_change', 'budget', 'manual_review')),
  subject      jsonb NOT NULL,
  requested_by jsonb NOT NULL,
  status       text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  decided_by   jsonb,
  rationale    text,
  created_at   timestamptz NOT NULL,
  decided_at   timestamptz,
  seq          bigserial NOT NULL
);

CREATE INDEX IF NOT EXISTS ht_approvals_run_idx ON ht_approvals (run_id, seq);
CREATE INDEX IF NOT EXISTS ht_approvals_status_idx ON ht_approvals (status, seq);

CREATE OR REPLACE FUNCTION ht_approvals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ht_approvals: DELETE is not permitted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'ht_approvals: approval % is already %', OLD.approval_id, OLD.status USING ERRCODE = '42501';
  END IF;
  IF NEW.approval_id <> OLD.approval_id OR NEW.run_id <> OLD.run_id OR NEW.kind <> OLD.kind
     OR NEW.subject <> OLD.subject OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'ht_approvals: request fields are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ht_approvals_guard_trg ON ht_approvals;
CREATE TRIGGER ht_approvals_guard_trg BEFORE UPDATE OR DELETE ON ht_approvals
  FOR EACH ROW EXECUTE FUNCTION ht_approvals_guard();
`,
  },
  {
    // conformance-11: human gate waivers are approvals of kind gate_exception ({criterionId, expiresAt?})
    id: 'policy/003-gate-exception-approvals',
    sql: `
ALTER TABLE ht_approvals DROP CONSTRAINT IF EXISTS ht_approvals_kind_check;
ALTER TABLE ht_approvals ADD CONSTRAINT ht_approvals_kind_check
  CHECK (kind IN ('action', 'oracle_change', 'test_change', 'budget', 'manual_review', 'gate_exception'));
`,
  },
  {
    // E[8]: an approved action approval is consumed EXACTLY ONCE (primary key) by the one action it authorizes; append-only
    id: 'policy/004-approval-consumptions',
    sql: `
CREATE TABLE IF NOT EXISTS ht_approval_consumptions (
  approval_id  text PRIMARY KEY REFERENCES ht_approvals (approval_id),
  run_id       text NOT NULL,
  consumed_by  text NOT NULL,
  digest       text NOT NULL,
  consumed_at  timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION ht_approval_consumptions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ht_approval_consumptions is append-only (%)', TG_OP USING ERRCODE = '42501';
END
$$;

DROP TRIGGER IF EXISTS ht_approval_consumptions_guard ON ht_approval_consumptions;
CREATE TRIGGER ht_approval_consumptions_guard BEFORE UPDATE OR DELETE ON ht_approval_consumptions
  FOR EACH ROW EXECUTE FUNCTION ht_approval_consumptions_append_only();
DROP TRIGGER IF EXISTS ht_approval_consumptions_no_truncate ON ht_approval_consumptions;
CREATE TRIGGER ht_approval_consumptions_no_truncate BEFORE TRUNCATE ON ht_approval_consumptions
  FOR EACH STATEMENT EXECUTE FUNCTION ht_approval_consumptions_append_only();
`,
  },
];
