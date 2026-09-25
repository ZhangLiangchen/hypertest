import type { Migration } from '@hypertest/core';

/**
 * Evidence ledger schema. Both tables are append-only at the database level too: UPDATE, DELETE and
 * TRUNCATE are rejected by triggers (defence in depth for I6; verify() still detects tampering by
 * anyone able to bypass the triggers, e.g. a superuser disabling them).
 */
export const evidenceMigrations: Migration[] = [
  {
    id: 'evidence/001-ledger',
    sql: `
CREATE TABLE IF NOT EXISTS ht_evidence (
  evidence_id          text PRIMARY KEY,
  run_id               text NOT NULL,
  seq                  bigint NOT NULL CHECK (seq > 0),
  evidence_type        text NOT NULL,
  artifact_uri         text NOT NULL,
  artifact_sha256      text NOT NULL,
  artifact_size        bigint NOT NULL CHECK (artifact_size >= 0),
  artifact_mime_type   text NOT NULL,
  summary              text NOT NULL,
  structured           jsonb,
  work_item_id         text,
  agent_id             text,
  tool_invocation_id   text,
  operation_id         text,
  environment          jsonb,
  parent_evidence_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
  classification       text NOT NULL,
  retention_policy     text NOT NULL,
  producer             jsonb NOT NULL,
  provenance           jsonb NOT NULL,
  trace_id             text,
  captured_at          timestamptz NOT NULL,
  metadata_hash        text NOT NULL,
  previous_record_hash text,
  record_hash          text NOT NULL,
  CONSTRAINT ht_evidence_run_seq_uq UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS ht_evidence_run_type_idx ON ht_evidence (run_id, evidence_type, seq);
CREATE INDEX IF NOT EXISTS ht_evidence_run_work_item_idx ON ht_evidence (run_id, work_item_id, seq);
CREATE INDEX IF NOT EXISTS ht_evidence_operation_idx ON ht_evidence (operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ht_evidence_tool_invocation_idx ON ht_evidence (tool_invocation_id) WHERE tool_invocation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ht_evidence_artifact_idx ON ht_evidence (artifact_sha256);

CREATE TABLE IF NOT EXISTS ht_evidence_seals (
  seal_id       text PRIMARY KEY,
  run_id        text NOT NULL,
  seal_no       bigint NOT NULL CHECK (seal_no > 0),
  root_hash     text NOT NULL,
  record_count  bigint NOT NULL CHECK (record_count >= 0),
  last_seq      bigint NOT NULL CHECK (last_seq >= 0),
  key_id        text NOT NULL,
  algorithm     text NOT NULL,
  signature     text NOT NULL,
  sealed_at     timestamptz NOT NULL,
  CONSTRAINT ht_evidence_seals_run_no_uq UNIQUE (run_id, seal_no)
);

CREATE OR REPLACE FUNCTION ht_evidence_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END
$$;

DROP TRIGGER IF EXISTS ht_evidence_no_mutation ON ht_evidence;
CREATE TRIGGER ht_evidence_no_mutation BEFORE UPDATE OR DELETE ON ht_evidence
  FOR EACH ROW EXECUTE FUNCTION ht_evidence_append_only();
DROP TRIGGER IF EXISTS ht_evidence_no_truncate ON ht_evidence;
CREATE TRIGGER ht_evidence_no_truncate BEFORE TRUNCATE ON ht_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION ht_evidence_append_only();

DROP TRIGGER IF EXISTS ht_evidence_seals_no_mutation ON ht_evidence_seals;
CREATE TRIGGER ht_evidence_seals_no_mutation BEFORE UPDATE OR DELETE ON ht_evidence_seals
  FOR EACH ROW EXECUTE FUNCTION ht_evidence_append_only();
DROP TRIGGER IF EXISTS ht_evidence_seals_no_truncate ON ht_evidence_seals;
CREATE TRIGGER ht_evidence_seals_no_truncate BEFORE TRUNCATE ON ht_evidence_seals
  FOR EACH STATEMENT EXECUTE FUNCTION ht_evidence_append_only();
`,
  },
];
