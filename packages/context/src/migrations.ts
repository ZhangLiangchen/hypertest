import type { Migration } from '@hypertest/core';

/**
 * Context engine tables. `ht_vectors` is deliberately NOT here: it needs the pgvector extension and is created
 * lazily by createPgVectorIndex (which throws `unsupported` when the extension is unavailable).
 * 003 — ht_context_observations: the ObservationLog (append-only: UPDATE/DELETE/TRUNCATE refused by triggers).
 * 004 — ht_context_freshness_passes: (B[1]) invocations of record-effect tools that passed the FreshnessGuard and took
 *       effect (written in the tool's own transaction; append-only): a durable replay of such a call is recognised and never
 *       refused as stale by its own effect.
 * 005 — (B[7]) the Skill Registry: ht_skills (immutable skill revisions; only the status moves, along candidate → validated →
 *       published → retired / rejected) and ht_skill_validations (append-only eval validations). Database-enforced: a revision
 *       is inserted as a candidate, its content never changes, and it can become `validated` or `published` only while the
 *       LATEST validation of its exact digest passed (42501 otherwise); one published revision per skill.
 * 006 — (B[7], review) a validation row is CONSISTENT with its own numbers: `passed` only with at least one passing trial of the
 *       skill arm, at least min_trials trials, a pass rate (= passes / trials) reaching min_pass_rate (> 0) and not below the
 *       baseline arm; so a row claiming `passed` against its numbers — or with a zero threshold — never validates a skill.
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
  {
    // (B[1]) A record-effect tool call that passed the FreshnessGuard and took effect, recorded in the SAME transaction as its
    // effect: a durable replay of the same invocation (crash after the commit, before the call settled) is recognised and
    // returns its recorded outcome instead of being refused as stale by its own write. Append-only.
    id: 'context/004-freshness-passes',
    sql: `
CREATE TABLE IF NOT EXISTS ht_context_freshness_passes (
  invocation_id text PRIMARY KEY,
  run_id text NOT NULL,
  agent_id text NOT NULL,
  tool_id text NOT NULL,
  snapshot_id text,
  checked integer NOT NULL CHECK (checked >= 0),
  passed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ht_context_freshness_passes_run_idx ON ht_context_freshness_passes (run_id);
DROP TRIGGER IF EXISTS ht_context_freshness_passes_no_update ON ht_context_freshness_passes;
CREATE TRIGGER ht_context_freshness_passes_no_update BEFORE UPDATE OR DELETE ON ht_context_freshness_passes FOR EACH ROW EXECUTE FUNCTION ht_context_observations_append_only();
DROP TRIGGER IF EXISTS ht_context_freshness_passes_no_truncate ON ht_context_freshness_passes;
CREATE TRIGGER ht_context_freshness_passes_no_truncate BEFORE TRUNCATE ON ht_context_freshness_passes FOR EACH STATEMENT EXECUTE FUNCTION ht_context_observations_append_only();
`,
  },
  {
    // (B[7]) The Hypertest Skill Registry. A candidate skill never enters the active registry (status published) without a
    // passing eval validation of its exact revision digest: enforced here, in the database, not only by the registry code.
    id: 'context/005-skills',
    sql: `
CREATE TABLE IF NOT EXISTS ht_skills (
  skill_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  name text NOT NULL,
  description text NOT NULL,
  body text NOT NULL,
  scope jsonb NOT NULL,
  scope_role text,
  digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('candidate', 'validated', 'published', 'retired', 'rejected')),
  source_experience_ids jsonb NOT NULL,
  created_by text NOT NULL,
  published_by text,
  retired_by text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (skill_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS ht_skills_one_published_idx ON ht_skills (skill_id) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS ht_skills_status_idx ON ht_skills (status);
CREATE INDEX IF NOT EXISTS ht_skills_digest_idx ON ht_skills (digest);

CREATE TABLE IF NOT EXISTS ht_skill_validations (
  seq bigserial NOT NULL,
  validation_id text PRIMARY KEY,
  skill_id text NOT NULL,
  revision integer NOT NULL,
  digest text NOT NULL,
  suite_id text NOT NULL,
  suite_revision text NOT NULL,
  arm_id text NOT NULL,
  trials integer NOT NULL CHECK (trials >= 1),
  passes integer NOT NULL CHECK (passes >= 0 AND passes <= trials),
  pass_rate double precision NOT NULL CHECK (pass_rate >= 0 AND pass_rate <= 1),
  baseline_arm_id text,
  baseline_pass_rate double precision,
  min_pass_rate double precision NOT NULL,
  min_trials integer NOT NULL,
  passed boolean NOT NULL,
  reasons jsonb NOT NULL,
  result_digest text NOT NULL,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY (skill_id, revision) REFERENCES ht_skills (skill_id, revision)
);
CREATE INDEX IF NOT EXISTS ht_skill_validations_skill_idx ON ht_skill_validations (skill_id, revision, digest, recorded_at);

CREATE OR REPLACE FUNCTION ht_skills_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_passed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'candidate' THEN
      RAISE EXCEPTION 'skill registry: a skill revision is created as a candidate, not %', NEW.status USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'skill registry: skill revisions are never deleted (retire them)' USING ERRCODE = '42501';
  END IF;
  -- a revision's content (and identity) never changes: only its status, its publisher/retirer and updated_at move
  IF (to_jsonb(NEW) - 'status' - 'published_by' - 'retired_by' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'published_by' - 'retired_by' - 'updated_at') THEN
    RAISE EXCEPTION 'skill registry: the content of skill % revision % is immutable', OLD.skill_id, OLD.revision USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'candidate' AND NEW.status IN ('validated', 'rejected'))
         OR (OLD.status = 'validated' AND NEW.status IN ('published', 'candidate', 'rejected'))
         OR (OLD.status = 'published' AND NEW.status = 'retired')) THEN
      RAISE EXCEPTION 'skill registry: skill % revision % cannot go from % to %', OLD.skill_id, OLD.revision, OLD.status, NEW.status USING ERRCODE = '42501';
    END IF;
    IF NEW.status IN ('validated', 'published') THEN
      SELECT v.passed INTO latest_passed FROM ht_skill_validations v
       WHERE v.skill_id = NEW.skill_id AND v.revision = NEW.revision AND v.digest = NEW.digest
       ORDER BY v.recorded_at DESC, v.seq DESC LIMIT 1;
      IF latest_passed IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'skill registry: skill % revision % cannot be % without a passing eval validation of its digest', NEW.skill_id, NEW.revision, NEW.status USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS ht_skills_guard_trg ON ht_skills;
CREATE TRIGGER ht_skills_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON ht_skills FOR EACH ROW EXECUTE FUNCTION ht_skills_guard();
DROP TRIGGER IF EXISTS ht_skills_no_truncate ON ht_skills;
CREATE TRIGGER ht_skills_no_truncate BEFORE TRUNCATE ON ht_skills FOR EACH STATEMENT EXECUTE FUNCTION ht_context_observations_append_only();
DROP TRIGGER IF EXISTS ht_skill_validations_no_update ON ht_skill_validations;
CREATE TRIGGER ht_skill_validations_no_update BEFORE UPDATE OR DELETE ON ht_skill_validations FOR EACH ROW EXECUTE FUNCTION ht_context_observations_append_only();
DROP TRIGGER IF EXISTS ht_skill_validations_no_truncate ON ht_skill_validations;
CREATE TRIGGER ht_skill_validations_no_truncate BEFORE TRUNCATE ON ht_skill_validations FOR EACH STATEMENT EXECUTE FUNCTION ht_context_observations_append_only();
`,
  },
  {
    // (B[7], review) the guard trusts `passed`: the database now refuses a row whose `passed` contradicts its own numbers, a
    // zero (or out-of-range) threshold, and a pass rate that is not passes / trials.
    id: 'context/006-skill-validation-consistency',
    sql: `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ht_skill_validations_consistent' AND conrelid = 'ht_skill_validations'::regclass) THEN
    ALTER TABLE ht_skill_validations ADD CONSTRAINT ht_skill_validations_consistent CHECK (
      min_pass_rate > 0 AND min_pass_rate <= 1
      AND min_trials >= 1
      AND abs(pass_rate - passes::double precision / trials) < 1e-9
      AND (baseline_pass_rate IS NULL OR (baseline_pass_rate >= 0 AND baseline_pass_rate <= 1))
      AND (NOT passed OR (passes >= 1 AND trials >= min_trials AND pass_rate >= min_pass_rate AND (baseline_pass_rate IS NULL OR pass_rate >= baseline_pass_rate)))
    );
  END IF;
END
$$;
`,
  },
];
