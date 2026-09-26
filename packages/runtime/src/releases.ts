import {
  HypertestError, canonicalJson, fromJsonColumn, jsonClone, sha256Hex, toIso, toNumber, type BaseDeps, type JsonValue, type Migration, type SqlDatabase, type SqlExecutor, type SqlParam,
} from '@hypertest/core';
import type { RuntimeCompatibilityCheck, RuntimeEpoch, RuntimeManifest, RuntimeReleaseState } from '@hypertest/domain';
import { verifyRuntimeManifest } from './manifest.ts';

/**
 * Runtime release registry (architecture-improvements §Runtime Manifest 与版本钉死, §回滚与恢复): every runtime
 * manifest a deployment may run is registered as a release and moves through
 *
 *   candidate ─(compatibility suite)→ shadow ─(production replay)→ canary ─(release gate)→ active → retiring → retired
 *
 * one audited step at a time. Every promotion needs the latest recorded result of BOTH compatibility suites of that
 * manifest to be a pass: the engine contract suite (`engine_contract`, the AgentEngine ABI golden suite) and a replay /
 * golden eval suite (`replay`). The single ACTIVE POINTER names the release new TestRuns are created under; a canary
 * (at most one) serves only the runs its selection picks (a deterministic percentage bucket of the run id and/or run
 * labels). Rollback moves the pointer back to the previous active release (or stops a canary/shadow/candidate), retires
 * the rolled-back release for good, and hands its live runs to the caller for quarantine. Runs keep running on the
 * manifest they are pinned to (I11); a live run changes runtime only by an explicit migration, recorded here as a
 * RuntimeEpoch.
 *
 * History tables (suite results, transitions, epochs) are append-only (database triggers); a registered manifest is
 * immutable (only its state, canary selection and rolled-back flag change).
 */

export const RELEASE_STATES: readonly RuntimeReleaseState[] = Object.freeze(['candidate', 'shadow', 'canary', 'active', 'retiring', 'retired']);
/** The only promotions: one step along candidate → shadow → canary → active. */
export const PROMOTION_PATH: Readonly<Partial<Record<RuntimeReleaseState, RuntimeReleaseState>>> = Object.freeze({ candidate: 'shadow', shadow: 'canary', canary: 'active' });
/** The compatibility suites every promotion requires (latest result of each must pass). */
export const SUITE_KINDS = Object.freeze(['engine_contract', 'replay'] as const);
export type CompatibilitySuiteKind = (typeof SUITE_KINDS)[number];
/** Schemas a RuntimeManifest pins (`schemas.<key>`). */
export const MANIFEST_SCHEMA_KEYS = Object.freeze(['event', 'contextSnapshot', 'tool', 'operation', 'evidence'] as const);
export type ManifestSchemaKey = (typeof MANIFEST_SCHEMA_KEYS)[number];
/** Release states that still create or drive runs (a rollback may target them). */
const ROLLBACKABLE: ReadonlySet<RuntimeReleaseState> = new Set(['candidate', 'shadow', 'canary', 'active']);

/** Which new runs a canary serves: run-id bucket below `percentage` (0–100) OR every listed label present with its value. */
export interface CanarySelection {
  percentage?: number;
  labels?: Record<string, string>;
}

/** A schema change a run may take when it is migrated onto the release declaring it (expand/contract: explicit only). */
export interface SchemaMigrationAllowance {
  schema: ManifestSchemaKey;
  from: string;
  to: string;
}

export interface RuntimeRelease {
  manifestId: string;
  manifest: RuntimeManifest;
  state: RuntimeReleaseState;
  /** Present while the release is the canary. */
  canary?: CanarySelection;
  /** A rolled-back release is retired for good: it is never promoted again (register a fixed runtime instead). */
  rolledBack: boolean;
  allowedMigrations: SchemaMigrationAllowance[];
  registeredBy: string;
  registeredAt: string;
  updatedAt: string;
}

export interface CompatibilitySuiteResult {
  resultId: string;
  manifestId: string;
  kind: CompatibilitySuiteKind;
  suiteId: string;
  suiteRevision?: string;
  passed: boolean;
  summary: { total?: number; failed?: number; detail?: string };
  /** sha256 of the suite report the result was taken from (e.g. an eval SuiteResult JSON). */
  reportDigest?: string;
  recordedBy: string;
  recordedAt: string;
}

export type ReleaseAction = 'register' | 'promote' | 'rollback' | 'restore' | 'retire';

export interface ReleaseTransition {
  transitionId: string;
  seq: number;
  manifestId: string;
  action: ReleaseAction;
  fromState?: RuntimeReleaseState;
  toState: RuntimeReleaseState;
  actor: string;
  reason?: string;
  details: Record<string, unknown>;
  at: string;
}

export interface ActiveReleasePointer {
  manifestId: string;
  /** The release a rollback of the active one restores. */
  previousManifestId?: string;
  revision: number;
  updatedAt: string;
}

export interface PromotionReadiness {
  ready: boolean;
  problems: string[];
  latest: Partial<Record<CompatibilitySuiteKind, CompatibilitySuiteResult>>;
}

export interface PromotionResult {
  release: RuntimeRelease;
  transition: ReleaseTransition;
  /** The release that was active before (now retiring) when this promotion activated a release. */
  retiring?: RuntimeRelease;
  pointer?: ActiveReleasePointer;
}

export interface RollbackResult {
  /** The rolled-back release (retired, rolledBack). Its live runs must be quarantined by the caller. */
  rolledBack: RuntimeRelease;
  fromState: RuntimeReleaseState;
  /** The release the active pointer moved back to (rollback of the active release only). */
  restored?: RuntimeRelease;
  transition: ReleaseTransition;
  pointer?: ActiveReleasePointer;
}

export type RunAdmission =
  | { allowed: true; mode: 'unmanaged' | 'active' | 'canary'; activeManifestId?: string }
  | { allowed: false; reason: string; activeManifestId?: string; state?: RuntimeReleaseState };

export interface RecordSuiteInput {
  manifestId: string;
  kind: CompatibilitySuiteKind;
  suiteId: string;
  suiteRevision?: string;
  passed: boolean;
  summary?: { total?: number; failed?: number; detail?: string };
  reportDigest?: string;
  by: string;
}

export type NewRuntimeEpoch = Omit<RuntimeEpoch, 'epochId' | 'seq' | 'previousEpochId' | 'createdAt'>;

export interface RuntimeReleaseRegistryDeps extends BaseDeps {
  db: SqlDatabase;
}

export interface RuntimeReleaseRegistry {
  /** Registers a manifest as a candidate (idempotent: an existing release is returned unchanged, `created: false`). */
  register(manifest: RuntimeManifest, input: { by: string; allowedMigrations?: SchemaMigrationAllowance[] }, tx?: SqlExecutor): Promise<{ release: RuntimeRelease; created: boolean }>;
  get(manifestId: string, tx?: SqlExecutor): Promise<RuntimeRelease | undefined>;
  list(filter?: { states?: RuntimeReleaseState[] }): Promise<RuntimeRelease[]>;
  activePointer(tx?: SqlExecutor): Promise<ActiveReleasePointer | undefined>;
  /** Records one compatibility suite result for a registered manifest (append-only). */
  recordSuiteResult(input: RecordSuiteInput, tx?: SqlExecutor): Promise<CompatibilitySuiteResult>;
  /** Every recorded result of the manifest, oldest first. */
  suiteResults(manifestId: string): Promise<CompatibilitySuiteResult[]>;
  /** Whether the latest result of every required suite passed (and the release may be promoted at all). */
  promotionReadiness(manifestId: string, tx?: SqlExecutor): Promise<PromotionReadiness>;
  /** One step along candidate → shadow → canary → active (entering canary needs a selection). */
  promote(manifestId: string, input: { by: string; reason: string; canary?: CanarySelection }, tx?: SqlExecutor): Promise<PromotionResult>;
  /** Rolls back the given release, else the canary, else the active release (to the previous active one). */
  rollback(input: { by: string; reason: string; manifestId?: string }, tx?: SqlExecutor): Promise<RollbackResult>;
  /** retiring → retired (the caller checks that no live run is pinned to it any more). */
  retire(manifestId: string, input: { by: string; reason: string }, tx?: SqlExecutor): Promise<RuntimeRelease>;
  /** Whether a NEW run may be created under `manifestId`. */
  admit(input: { manifestId: string; runId: string; labels?: Record<string, string>; requireActive?: boolean }): Promise<RunAdmission>;
  /** Transitions, oldest first (all, or of one manifest). */
  history(manifestId?: string): Promise<ReleaseTransition[]>;
  /** Appends the next RuntimeEpoch of a run (seq and previous epoch are assigned here). */
  recordEpoch(input: NewRuntimeEpoch, tx?: SqlExecutor): Promise<RuntimeEpoch>;
  /** The run's epochs, oldest first. */
  epochs(runId: string, tx?: SqlExecutor): Promise<RuntimeEpoch[]>;
}

// ------------------------------------------------------------------------------------------------ schema

export const RELEASE_MIGRATION: Migration = {
  id: 'runtime/005-releases',
  sql: `
CREATE TABLE IF NOT EXISTS ht_runtime_releases (
  manifest_id        text PRIMARY KEY,
  manifest           jsonb NOT NULL,
  state              text NOT NULL CHECK (state IN ('candidate', 'shadow', 'canary', 'active', 'retiring', 'retired')),
  canary             jsonb,
  rolled_back        boolean NOT NULL DEFAULT false,
  allowed_migrations jsonb NOT NULL DEFAULT '[]'::jsonb,
  registered_by      text NOT NULL,
  registered_at      timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ht_runtime_releases_state_idx ON ht_runtime_releases (state);
CREATE UNIQUE INDEX IF NOT EXISTS ht_runtime_releases_one_active ON ht_runtime_releases (state) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS ht_runtime_releases_one_canary ON ht_runtime_releases (state) WHERE state = 'canary';

CREATE TABLE IF NOT EXISTS ht_runtime_release_pointer (
  pointer              text PRIMARY KEY CHECK (pointer = 'active'),
  manifest_id          text NOT NULL REFERENCES ht_runtime_releases (manifest_id),
  previous_manifest_id text REFERENCES ht_runtime_releases (manifest_id),
  revision             bigint NOT NULL CHECK (revision > 0),
  updated_at           timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS ht_runtime_release_lock (
  id integer PRIMARY KEY CHECK (id = 1)
);
INSERT INTO ht_runtime_release_lock (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ht_runtime_suite_results (
  result_id      text PRIMARY KEY,
  seq            bigserial NOT NULL,
  manifest_id    text NOT NULL REFERENCES ht_runtime_releases (manifest_id),
  kind           text NOT NULL CHECK (kind IN ('engine_contract', 'replay')),
  suite_id       text NOT NULL,
  suite_revision text,
  passed         boolean NOT NULL,
  summary        jsonb NOT NULL,
  report_digest  text,
  recorded_by    text NOT NULL,
  recorded_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ht_runtime_suite_results_idx ON ht_runtime_suite_results (manifest_id, kind, seq);

CREATE TABLE IF NOT EXISTS ht_runtime_release_transitions (
  transition_id text PRIMARY KEY,
  seq           bigserial NOT NULL,
  manifest_id   text NOT NULL REFERENCES ht_runtime_releases (manifest_id),
  action        text NOT NULL CHECK (action IN ('register', 'promote', 'rollback', 'restore', 'retire')),
  from_state    text,
  to_state      text NOT NULL,
  actor         text NOT NULL,
  reason        text,
  details       jsonb NOT NULL,
  at            timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ht_runtime_release_transitions_idx ON ht_runtime_release_transitions (manifest_id, seq);

CREATE TABLE IF NOT EXISTS ht_runtime_epochs (
  epoch_id   text PRIMARY KEY,
  run_id     text NOT NULL,
  seq        integer NOT NULL CHECK (seq >= 1),
  epoch      jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE OR REPLACE FUNCTION ht_runtime_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END
$$;

DROP TRIGGER IF EXISTS ht_runtime_suite_results_no_mutation ON ht_runtime_suite_results;
CREATE TRIGGER ht_runtime_suite_results_no_mutation BEFORE UPDATE OR DELETE ON ht_runtime_suite_results FOR EACH ROW EXECUTE FUNCTION ht_runtime_append_only();
DROP TRIGGER IF EXISTS ht_runtime_suite_results_no_truncate ON ht_runtime_suite_results;
CREATE TRIGGER ht_runtime_suite_results_no_truncate BEFORE TRUNCATE ON ht_runtime_suite_results FOR EACH STATEMENT EXECUTE FUNCTION ht_runtime_append_only();

DROP TRIGGER IF EXISTS ht_runtime_release_transitions_no_mutation ON ht_runtime_release_transitions;
CREATE TRIGGER ht_runtime_release_transitions_no_mutation BEFORE UPDATE OR DELETE ON ht_runtime_release_transitions FOR EACH ROW EXECUTE FUNCTION ht_runtime_append_only();
DROP TRIGGER IF EXISTS ht_runtime_release_transitions_no_truncate ON ht_runtime_release_transitions;
CREATE TRIGGER ht_runtime_release_transitions_no_truncate BEFORE TRUNCATE ON ht_runtime_release_transitions FOR EACH STATEMENT EXECUTE FUNCTION ht_runtime_append_only();

DROP TRIGGER IF EXISTS ht_runtime_epochs_no_mutation ON ht_runtime_epochs;
CREATE TRIGGER ht_runtime_epochs_no_mutation BEFORE UPDATE OR DELETE ON ht_runtime_epochs FOR EACH ROW EXECUTE FUNCTION ht_runtime_append_only();
DROP TRIGGER IF EXISTS ht_runtime_epochs_no_truncate ON ht_runtime_epochs;
CREATE TRIGGER ht_runtime_epochs_no_truncate BEFORE TRUNCATE ON ht_runtime_epochs FOR EACH STATEMENT EXECUTE FUNCTION ht_runtime_append_only();

-- a registered manifest is immutable; a release is never deleted
CREATE OR REPLACE FUNCTION ht_runtime_release_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ht_runtime_releases: a release is never deleted (retire it)' USING ERRCODE = '42501';
  END IF;
  IF (NEW.manifest_id, NEW.manifest, NEW.registered_by, NEW.registered_at, NEW.allowed_migrations)
     IS DISTINCT FROM (OLD.manifest_id, OLD.manifest, OLD.registered_by, OLD.registered_at, OLD.allowed_migrations) THEN
    RAISE EXCEPTION 'ht_runtime_releases: a registered manifest is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.rolled_back AND NOT NEW.rolled_back THEN
    RAISE EXCEPTION 'ht_runtime_releases: a rolled-back release stays rolled back' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS ht_runtime_releases_identity ON ht_runtime_releases;
CREATE TRIGGER ht_runtime_releases_identity BEFORE UPDATE OR DELETE ON ht_runtime_releases FOR EACH ROW EXECUTE FUNCTION ht_runtime_release_identity();
DROP TRIGGER IF EXISTS ht_runtime_releases_no_truncate ON ht_runtime_releases;
CREATE TRIGGER ht_runtime_releases_no_truncate BEFORE TRUNCATE ON ht_runtime_releases FOR EACH STATEMENT EXECUTE FUNCTION ht_runtime_append_only();
`,
};

// ------------------------------------------------------------------------------------------------ pure helpers

function invalid(message: string, details: Record<string, unknown> = {}): HypertestError {
  return new HypertestError('invalid_argument', message, { details });
}

function precondition(message: string, details: Record<string, unknown> = {}): HypertestError {
  return new HypertestError('precondition_failed', message, { details });
}

function requireText(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw invalid(`${what} must be a non-empty string`);
  return v;
}

function short(manifestId: string): string {
  return manifestId.length > 19 ? `${manifestId.slice(0, 19)}…` : manifestId;
}

/** Problems of a canary selection (empty = valid). A canary must select something: a percentage > 0 or labels. */
export function canarySelectionProblems(selection: unknown): string[] {
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) return ['canary selection must be an object {percentage?, labels?}'];
  const s = selection as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of Object.keys(s)) if (k !== 'percentage' && k !== 'labels') problems.push(`canary selection: unknown key '${k}'`);
  const p = s['percentage'];
  if (p !== undefined && !(typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 100)) problems.push('canary percentage must be an integer between 0 and 100');
  const labels = s['labels'];
  if (labels !== undefined) {
    if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) problems.push('canary labels must be a map of label → value');
    else {
      for (const [k, v] of Object.entries(labels)) {
        if (k.trim() === '' || typeof v !== 'string') problems.push(`canary label ${JSON.stringify(k)} must be a non-empty key with a string value`);
      }
    }
  }
  const hasLabels = labels !== null && typeof labels === 'object' && Object.keys(labels as object).length > 0;
  if (problems.length === 0 && !((typeof p === 'number' && p > 0) || hasLabels)) problems.push('a canary must select runs: a percentage above 0 and/or labels');
  return problems;
}

/** The deterministic canary bucket of a run id: 0–99 (first 32 bits of sha256(runId) mod 100). */
export function canaryBucket(runId: string): number {
  return Number.parseInt(sha256Hex(runId).slice(0, 8), 16) % 100;
}

/** True when the canary selection picks the run: its bucket is below the percentage, or every selection label matches. */
export function canarySelects(selection: CanarySelection | undefined, run: { runId: string; labels?: Record<string, string> }): boolean {
  if (!selection) return false;
  if (selection.percentage !== undefined && selection.percentage > 0 && canaryBucket(run.runId) < selection.percentage) return true;
  const want = Object.entries(selection.labels ?? {});
  if (want.length === 0) return false;
  const labels = run.labels ?? {};
  return want.every(([k, v]) => Object.hasOwn(labels, k) && labels[k] === v);
}

function allowanceProblems(list: unknown): string[] {
  if (!Array.isArray(list)) return ['allowedMigrations must be a list'];
  const problems: string[] = [];
  list.forEach((a, i) => {
    const at = `allowedMigrations[${i}]`;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return void problems.push(`${at} must be {schema, from, to}`);
    const r = a as Record<string, unknown>;
    if (!(MANIFEST_SCHEMA_KEYS as readonly unknown[]).includes(r['schema'])) problems.push(`${at}.schema must be one of ${MANIFEST_SCHEMA_KEYS.join(', ')}`);
    for (const k of ['from', 'to']) if (typeof r[k] !== 'string' || (r[k] as string).trim() === '') problems.push(`${at}.${k} must be a non-empty string`);
    if (typeof r['from'] === 'string' && r['from'] === r['to']) problems.push(`${at}: from and to are the same schema version`);
  });
  return problems;
}

/**
 * The compatibility verdict of migrating a live run pinned to `source` onto `target` (improvements §回滚与恢复): the target
 * release is active or the canary and not rolled back; its manifest verifies; every pinned schema is the same version or
 * covered by one of the target's explicit allowed migrations (expand/contract, never implicit); every engine the run's
 * agents use is pinned (with a version) by the target; and the governing protocol is the same protocol (its version may
 * move). Every check is reported; the migration may proceed only when all are ok.
 */
export function runtimeCompatibility(source: RuntimeManifest, target: Pick<RuntimeRelease, 'manifestId' | 'manifest' | 'state' | 'rolledBack' | 'allowedMigrations'>, options: { usedEngines?: readonly string[] } = {}): RuntimeCompatibilityCheck[] {
  const checks: RuntimeCompatibilityCheck[] = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });
  const stateOk = (target.state === 'active' || target.state === 'canary') && !target.rolledBack;
  add('target_state', stateOk, stateOk ? `release ${short(target.manifestId)} is ${target.state}` : `release ${short(target.manifestId)} is ${target.state}${target.rolledBack ? ' (rolled back)' : ''}: runs migrate only onto the active release or the canary`);
  const intact = verifyRuntimeManifest(target.manifest) && target.manifest.manifestId === target.manifestId;
  add('target_integrity', intact, intact ? 'the target manifest verifies against its id' : 'the target manifest does not verify against its id (altered)');
  add('source_differs', source.manifestId !== target.manifestId, source.manifestId !== target.manifestId ? `from ${short(source.manifestId)}` : 'the run is already pinned to the target manifest');
  for (const key of MANIFEST_SCHEMA_KEYS) {
    const from = source.schemas?.[key];
    const to = target.manifest.schemas?.[key];
    if (from === to) {
      add(`schema.${key}`, true, `same version ${String(to)}`);
      continue;
    }
    const allowed = target.allowedMigrations.some((a) => a.schema === key && a.from === from && a.to === to);
    add(`schema.${key}`, allowed, allowed ? `allowed migration ${String(from)} → ${String(to)}` : `${String(from)} → ${String(to)} is not an allowed migration of the target release (register it with --allow-migration ${key}:${String(from)}=>${String(to)})`);
  }
  for (const kind of [...new Set(options.usedEngines ?? [])].sort()) {
    const pinned = target.manifest.agentEngines.find((e) => e.kind === kind && typeof e.version === 'string' && e.version !== '');
    add(`engine.${kind}`, pinned !== undefined, pinned ? `the target pins ${kind} ${pinned.version}` : `the run's agents use engine ${kind}, which the target does not pin (with a version)`);
  }
  const sp = source.protocol;
  const tp = target.manifest.protocol;
  const protocolOk = sp === undefined || (tp !== undefined && tp.id === sp.id);
  add('protocol', protocolOk, protocolOk ? (sp ? `protocol ${sp.id}${tp && tp.version !== sp.version ? ` ${sp.version} → ${tp.version}` : ` ${sp.version}`}` : 'no protocol pinned') : `the run is governed by protocol ${sp?.id}; the target pins ${tp ? tp.id : 'none'}`);
  return checks;
}

// ------------------------------------------------------------------------------------------------ rows

interface ReleaseRow {
  manifest_id: string;
  manifest: unknown;
  state: string;
  canary: unknown;
  rolled_back: boolean;
  allowed_migrations: unknown;
  registered_by: string;
  registered_at: unknown;
  updated_at: unknown;
}

const RELEASE_COLUMNS = 'manifest_id, manifest, state, canary, rolled_back, allowed_migrations, registered_by, registered_at, updated_at';

function toRelease(r: ReleaseRow): RuntimeRelease {
  const out: RuntimeRelease = {
    manifestId: r.manifest_id,
    manifest: fromJsonColumn<RuntimeManifest>(r.manifest),
    state: r.state as RuntimeReleaseState,
    rolledBack: r.rolled_back === true,
    allowedMigrations: fromJsonColumn<SchemaMigrationAllowance[]>(r.allowed_migrations) ?? [],
    registeredBy: r.registered_by,
    registeredAt: toIso(r.registered_at),
    updatedAt: toIso(r.updated_at),
  };
  const canary = r.canary === null || r.canary === undefined ? undefined : fromJsonColumn<CanarySelection | null>(r.canary);
  if (canary) out.canary = canary;
  return out;
}

interface SuiteRow {
  result_id: string;
  manifest_id: string;
  kind: string;
  suite_id: string;
  suite_revision: string | null;
  passed: boolean;
  summary: unknown;
  report_digest: string | null;
  recorded_by: string;
  recorded_at: unknown;
}

function toSuiteResult(r: SuiteRow): CompatibilitySuiteResult {
  const out: CompatibilitySuiteResult = {
    resultId: r.result_id,
    manifestId: r.manifest_id,
    kind: r.kind as CompatibilitySuiteKind,
    suiteId: r.suite_id,
    passed: r.passed === true,
    summary: fromJsonColumn<CompatibilitySuiteResult['summary']>(r.summary) ?? {},
    recordedBy: r.recorded_by,
    recordedAt: toIso(r.recorded_at),
  };
  if (r.suite_revision !== null) out.suiteRevision = r.suite_revision;
  if (r.report_digest !== null) out.reportDigest = r.report_digest;
  return out;
}

interface TransitionRow {
  transition_id: string;
  seq: unknown;
  manifest_id: string;
  action: string;
  from_state: string | null;
  to_state: string;
  actor: string;
  reason: string | null;
  details: unknown;
  at: unknown;
}

function toTransition(r: TransitionRow): ReleaseTransition {
  const out: ReleaseTransition = {
    transitionId: r.transition_id,
    seq: toNumber(r.seq),
    manifestId: r.manifest_id,
    action: r.action as ReleaseAction,
    toState: r.to_state as RuntimeReleaseState,
    actor: r.actor,
    details: fromJsonColumn<Record<string, unknown>>(r.details) ?? {},
    at: toIso(r.at),
  };
  if (r.from_state !== null) out.fromState = r.from_state as RuntimeReleaseState;
  if (r.reason !== null) out.reason = r.reason;
  return out;
}

// ------------------------------------------------------------------------------------------------ registry

export function createRuntimeReleaseRegistry(deps: RuntimeReleaseRegistryDeps): RuntimeReleaseRegistry {
  const { db, ids, clock, logger } = deps;

  function inTx<T>(tx: SqlExecutor | undefined, fn: (q: SqlExecutor) => Promise<T>): Promise<T> {
    return tx ? fn(tx) : db.transaction(fn);
  }

  /** Serializes every mutation of the registry (a single lock row; portable across PGlite and PostgreSQL). */
  async function lock(q: SqlExecutor): Promise<void> {
    await q.query('SELECT id FROM ht_runtime_release_lock WHERE id = 1 FOR UPDATE');
  }

  async function load(q: SqlExecutor, manifestId: string): Promise<RuntimeRelease | undefined> {
    const r = await q.query<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM ht_runtime_releases WHERE manifest_id = $1`, [manifestId]);
    return r.rows[0] ? toRelease(r.rows[0]) : undefined;
  }

  async function mustLoad(q: SqlExecutor, manifestId: string): Promise<RuntimeRelease> {
    const r = await load(q, manifestId);
    if (!r) throw new HypertestError('not_found', `runtime release ${manifestId} is not registered`, { details: { manifestId } });
    return r;
  }

  async function pointer(q: SqlExecutor): Promise<ActiveReleasePointer | undefined> {
    const r = await q.query<{ manifest_id: string; previous_manifest_id: string | null; revision: unknown; updated_at: unknown }>(
      "SELECT manifest_id, previous_manifest_id, revision, updated_at FROM ht_runtime_release_pointer WHERE pointer = 'active'",
    );
    const row = r.rows[0];
    if (!row) return undefined;
    const out: ActiveReleasePointer = { manifestId: row.manifest_id, revision: toNumber(row.revision), updatedAt: toIso(row.updated_at) };
    if (row.previous_manifest_id !== null) out.previousManifestId = row.previous_manifest_id;
    return out;
  }

  async function setPointer(q: SqlExecutor, manifestId: string, previous: string | undefined, now: string): Promise<ActiveReleasePointer> {
    const cur = await pointer(q);
    const revision = (cur?.revision ?? 0) + 1;
    await q.query(
      `INSERT INTO ht_runtime_release_pointer (pointer, manifest_id, previous_manifest_id, revision, updated_at) VALUES ('active', $1, $2, $3, $4)
       ON CONFLICT (pointer) DO UPDATE SET manifest_id = EXCLUDED.manifest_id, previous_manifest_id = EXCLUDED.previous_manifest_id, revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at`,
      [manifestId, previous ?? null, revision, now],
    );
    const out: ActiveReleasePointer = { manifestId, revision, updatedAt: now };
    if (previous !== undefined) out.previousManifestId = previous;
    return out;
  }

  /** Moves a release to `state`; the canary selection exists only while the release is the canary. */
  async function setState(q: SqlExecutor, manifestId: string, state: RuntimeReleaseState, now: string, extra: { canary?: CanarySelection; rolledBack?: boolean } = {}): Promise<void> {
    const canary = state === 'canary' && extra.canary !== undefined ? JSON.stringify(extra.canary) : null;
    await q.query('UPDATE ht_runtime_releases SET state = $2, updated_at = $3, rolled_back = rolled_back OR $4, canary = $5::jsonb WHERE manifest_id = $1', [
      manifestId, state, now, extra.rolledBack === true, canary,
    ]);
  }

  async function transition(
    q: SqlExecutor,
    input: { manifestId: string; action: ReleaseAction; fromState?: RuntimeReleaseState; toState: RuntimeReleaseState; actor: string; reason?: string; details?: Record<string, unknown> },
    now: string,
  ): Promise<ReleaseTransition> {
    const transitionId = ids.next('rtx');
    const r = await q.query<TransitionRow>(
      `INSERT INTO ht_runtime_release_transitions (transition_id, manifest_id, action, from_state, to_state, actor, reason, details, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING transition_id, seq, manifest_id, action, from_state, to_state, actor, reason, details, at`,
      [transitionId, input.manifestId, input.action, input.fromState ?? null, input.toState, input.actor, input.reason ?? null, JSON.stringify(input.details ?? {}), now],
    );
    return toTransition(r.rows[0]!);
  }

  async function latestResults(q: SqlExecutor, manifestId: string): Promise<Partial<Record<CompatibilitySuiteKind, CompatibilitySuiteResult>>> {
    const out: Partial<Record<CompatibilitySuiteKind, CompatibilitySuiteResult>> = {};
    for (const kind of SUITE_KINDS) {
      const r = await q.query<SuiteRow>(
        `SELECT result_id, manifest_id, kind, suite_id, suite_revision, passed, summary, report_digest, recorded_by, recorded_at
         FROM ht_runtime_suite_results WHERE manifest_id = $1 AND kind = $2 ORDER BY seq DESC LIMIT 1`,
        [manifestId, kind],
      );
      if (r.rows[0]) out[kind] = toSuiteResult(r.rows[0]);
    }
    return out;
  }

  async function readiness(q: SqlExecutor, manifestId: string): Promise<PromotionReadiness> {
    const release = await mustLoad(q, manifestId);
    const latest = await latestResults(q, manifestId);
    const problems: string[] = [];
    if (release.rolledBack) problems.push(`release ${short(manifestId)} was rolled back: it is never promoted again (register a fixed runtime)`);
    if (!verifyRuntimeManifest(release.manifest)) problems.push(`the manifest of release ${short(manifestId)} does not verify against its id`);
    for (const kind of SUITE_KINDS) {
      const r = latest[kind];
      if (!r) problems.push(`no ${kind} suite result is recorded for ${short(manifestId)}`);
      else if (!r.passed) problems.push(`the latest ${kind} suite result (${r.suiteId}${r.suiteRevision ? `@${r.suiteRevision}` : ''}, ${r.resultId}) failed`);
    }
    return { ready: problems.length === 0, problems, latest };
  }

  const registry: RuntimeReleaseRegistry = {
    async register(manifest, input, tx) {
      const by = requireText(input?.by, 'register: by');
      if (!manifest || typeof manifest !== 'object' || typeof manifest.manifestId !== 'string') throw invalid('register: a RuntimeManifest is required');
      if (!verifyRuntimeManifest(manifest)) throw new HypertestError('integrity_violation', `register: manifest ${manifest.manifestId} does not verify against its content`, { details: { manifestId: manifest.manifestId } });
      const allowed = input.allowedMigrations ?? [];
      const problems = allowanceProblems(allowed);
      if (problems.length > 0) throw invalid(`register: ${problems.join('; ')}`, { problems });
      return inTx(tx, async (q) => {
        await lock(q);
        const existing = await load(q, manifest.manifestId);
        if (existing) {
          if (allowed.length > 0 && canonicalJson(existing.allowedMigrations) !== canonicalJson(allowed)) {
            throw new HypertestError('conflict', `register: release ${short(manifest.manifestId)} is already registered with other allowed migrations (a registered release is immutable)`, {
              details: { manifestId: manifest.manifestId },
            });
          }
          return { release: existing, created: false };
        }
        const now = clock.isoNow();
        await q.query(
          `INSERT INTO ht_runtime_releases (manifest_id, manifest, state, canary, rolled_back, allowed_migrations, registered_by, registered_at, updated_at)
           VALUES ($1, $2::jsonb, 'candidate', NULL, false, $3::jsonb, $4, $5, $5)`,
          [manifest.manifestId, JSON.stringify(manifest), JSON.stringify(allowed), by, now],
        );
        await transition(q, { manifestId: manifest.manifestId, action: 'register', toState: 'candidate', actor: by, details: { allowedMigrations: jsonClone(allowed) as unknown as JsonValue } }, now);
        logger.info('runtime release registered', { manifestId: manifest.manifestId, by });
        return { release: (await load(q, manifest.manifestId))!, created: true };
      });
    },

    get(manifestId, tx) {
      return load(tx ?? db, manifestId);
    },

    async list(filter = {}) {
      const params: SqlParam[] = [];
      let sql = `SELECT ${RELEASE_COLUMNS} FROM ht_runtime_releases`;
      if (filter.states !== undefined) {
        params.push([...filter.states]);
        sql += ' WHERE state = ANY($1)';
      }
      sql += ' ORDER BY registered_at DESC, manifest_id';
      const r = await db.query<ReleaseRow>(sql, params);
      return r.rows.map(toRelease);
    },

    activePointer(tx) {
      return pointer(tx ?? db);
    },

    async recordSuiteResult(input, tx) {
      const manifestId = requireText(input?.manifestId, 'recordSuiteResult: manifestId');
      if (!(SUITE_KINDS as readonly unknown[]).includes(input.kind)) throw invalid(`recordSuiteResult: kind must be one of ${SUITE_KINDS.join(', ')}`);
      const suiteId = requireText(input.suiteId, 'recordSuiteResult: suiteId');
      const by = requireText(input.by, 'recordSuiteResult: by');
      if (typeof input.passed !== 'boolean') throw invalid('recordSuiteResult: passed must be a boolean');
      if (input.suiteRevision !== undefined) requireText(input.suiteRevision, 'recordSuiteResult: suiteRevision');
      if (input.reportDigest !== undefined && !/^[0-9a-f]{64}$/.test(input.reportDigest)) throw invalid('recordSuiteResult: reportDigest must be a sha256 hex digest');
      const summary = input.summary ?? {};
      for (const k of ['total', 'failed'] as const) {
        const v = summary[k];
        if (v !== undefined && !(Number.isSafeInteger(v) && v >= 0)) throw invalid(`recordSuiteResult: summary.${k} must be an integer ≥ 0`);
      }
      if (summary.total !== undefined && summary.failed !== undefined && summary.failed > summary.total) throw invalid('recordSuiteResult: summary.failed exceeds summary.total');
      // a result that reports failures is never a pass (a caller cannot record "passed" over failed cases)
      if (input.passed && summary.failed !== undefined && summary.failed > 0) throw invalid(`recordSuiteResult: a result with ${summary.failed} failed case(s) cannot be recorded as passed`);
      if (input.passed && summary.total === 0) throw invalid('recordSuiteResult: a suite that ran no case cannot be recorded as passed (NOT RUN is not PASS)');
      return inTx(tx, async (q) => {
        await mustLoad(q, manifestId);
        const resultId = ids.next('rsr');
        const now = clock.isoNow();
        const r = await q.query<SuiteRow>(
          `INSERT INTO ht_runtime_suite_results (result_id, manifest_id, kind, suite_id, suite_revision, passed, summary, report_digest, recorded_by, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
           RETURNING result_id, manifest_id, kind, suite_id, suite_revision, passed, summary, report_digest, recorded_by, recorded_at`,
          [resultId, manifestId, input.kind, suiteId, input.suiteRevision ?? null, input.passed, JSON.stringify(summary), input.reportDigest ?? null, by, now],
        );
        logger.info('runtime compatibility suite result recorded', { manifestId, kind: input.kind, suiteId, passed: input.passed, by });
        return toSuiteResult(r.rows[0]!);
      });
    },

    async suiteResults(manifestId) {
      const r = await db.query<SuiteRow>(
        `SELECT result_id, manifest_id, kind, suite_id, suite_revision, passed, summary, report_digest, recorded_by, recorded_at
         FROM ht_runtime_suite_results WHERE manifest_id = $1 ORDER BY seq`,
        [manifestId],
      );
      return r.rows.map(toSuiteResult);
    },

    promotionReadiness(manifestId, tx) {
      return readiness(tx ?? db, manifestId);
    },

    async promote(manifestId, input, tx) {
      const by = requireText(input?.by, 'promote: by');
      const reason = requireText(input.reason, 'promote: reason');
      return inTx(tx, async (q) => {
        await lock(q);
        const release = await mustLoad(q, manifestId);
        const to = PROMOTION_PATH[release.state];
        if (!to) {
          throw precondition(`release ${short(manifestId)} is ${release.state}${release.rolledBack ? ' (rolled back)' : ''}: only candidate → shadow → canary → active promotions exist`, {
            manifestId, state: release.state,
          });
        }
        const ready = await readiness(q, manifestId);
        if (!ready.ready) {
          throw precondition(`release ${short(manifestId)} cannot be promoted to ${to}: ${ready.problems.join('; ')}`, { manifestId, to, problems: ready.problems });
        }
        const suiteResultIds = SUITE_KINDS.map((k) => ready.latest[k]!.resultId);
        const now = clock.isoNow();
        let canary: CanarySelection | undefined;
        if (to === 'canary') {
          if (input.canary === undefined) throw invalid('promote: entering canary needs a selection (percentage and/or labels)');
          const problems = canarySelectionProblems(input.canary);
          if (problems.length > 0) throw invalid(`promote: ${problems.join('; ')}`, { problems });
          const other = (await q.query<{ manifest_id: string }>("SELECT manifest_id FROM ht_runtime_releases WHERE state = 'canary'")).rows[0];
          if (other) throw new HypertestError('conflict', `release ${short(other.manifest_id)} is already the canary: promote or roll it back first`, { details: { canary: other.manifest_id } });
          canary = jsonClone(input.canary);
        } else if (input.canary !== undefined) {
          throw invalid(`promote: a canary selection applies only when entering canary (this promotion is ${release.state} → ${to})`);
        }
        const result: Omit<PromotionResult, 'transition' | 'release'> = {};
        if (to === 'active') {
          const cur = await pointer(q);
          if (cur && cur.manifestId !== manifestId) {
            await setState(q, cur.manifestId, 'retiring', now);
            await transition(q, { manifestId: cur.manifestId, action: 'retire', fromState: 'active', toState: 'retiring', actor: by, reason: `superseded by ${manifestId}: ${reason}` }, now);
            result.retiring = (await load(q, cur.manifestId))!;
          }
          await setState(q, manifestId, 'active', now);
          result.pointer = await setPointer(q, manifestId, cur && cur.manifestId !== manifestId ? cur.manifestId : undefined, now);
        } else {
          await setState(q, manifestId, to, now, to === 'canary' ? { canary: canary! } : {});
        }
        const details: Record<string, unknown> = { suiteResultIds };
        if (canary) details['canary'] = canary;
        if (result.retiring) details['retiring'] = result.retiring.manifestId;
        const t = await transition(q, { manifestId, action: 'promote', fromState: release.state, toState: to, actor: by, reason, details }, now);
        logger.info('runtime release promoted', { manifestId, from: release.state, to, by });
        return { ...result, release: (await load(q, manifestId))!, transition: t };
      });
    },

    async rollback(input, tx) {
      const by = requireText(input?.by, 'rollback: by');
      const reason = requireText(input.reason, 'rollback: reason');
      return inTx(tx, async (q) => {
        await lock(q);
        const cur = await pointer(q);
        let target: RuntimeRelease | undefined;
        if (input.manifestId !== undefined) {
          target = await mustLoad(q, requireText(input.manifestId, 'rollback: manifestId'));
          if (!ROLLBACKABLE.has(target.state)) {
            throw precondition(`release ${short(target.manifestId)} is ${target.state}: only a candidate, shadow, canary or active release can be rolled back`, { manifestId: target.manifestId, state: target.state });
          }
        } else {
          const canaryRow = (await q.query<{ manifest_id: string }>("SELECT manifest_id FROM ht_runtime_releases WHERE state = 'canary'")).rows[0];
          if (canaryRow) target = await mustLoad(q, canaryRow.manifest_id);
          else if (cur?.previousManifestId) target = await mustLoad(q, cur.manifestId);
          else throw precondition('nothing to roll back: there is no canary and the active release has no previous release to return to');
        }
        const now = clock.isoNow();
        const fromState = target.state;
        const result: Omit<RollbackResult, 'transition' | 'rolledBack' | 'fromState'> = {};
        if (fromState === 'active') {
          const previousId = cur?.manifestId === target.manifestId ? cur.previousManifestId : undefined;
          if (!previousId) throw precondition(`release ${short(target.manifestId)} is the active release and there is no previous release to return to`, { manifestId: target.manifestId });
          const previous = await mustLoad(q, previousId);
          if (previous.rolledBack) throw precondition(`the previous release ${short(previousId)} was itself rolled back: roll forward to a fixed release instead`, { manifestId: previousId });
          // the rolled-back release leaves `active` before the previous one returns (at most one active row)
          await setState(q, target.manifestId, 'retired', now, { rolledBack: true });
          await setState(q, previousId, 'active', now);
          result.pointer = await setPointer(q, previousId, undefined, now);
          await transition(q, { manifestId: previousId, action: 'restore', fromState: previous.state, toState: 'active', actor: by, reason: `rollback of ${target.manifestId}: ${reason}` }, now);
          result.restored = (await load(q, previousId))!;
        } else {
          await setState(q, target.manifestId, 'retired', now, { rolledBack: true });
        }
        const details: Record<string, unknown> = {};
        if (result.restored) details['restored'] = result.restored.manifestId;
        const t = await transition(q, { manifestId: target.manifestId, action: 'rollback', fromState, toState: 'retired', actor: by, reason, details }, now);
        logger.warn('runtime release rolled back', { manifestId: target.manifestId, from: fromState, restored: result.restored?.manifestId, by });
        return { ...result, rolledBack: (await load(q, target.manifestId))!, fromState, transition: t };
      });
    },

    async retire(manifestId, input, tx) {
      const by = requireText(input?.by, 'retire: by');
      const reason = requireText(input.reason, 'retire: reason');
      return inTx(tx, async (q) => {
        await lock(q);
        const release = await mustLoad(q, manifestId);
        if (release.state !== 'retiring') throw precondition(`release ${short(manifestId)} is ${release.state}: only a retiring release is retired`, { manifestId, state: release.state });
        const now = clock.isoNow();
        await setState(q, manifestId, 'retired', now);
        await transition(q, { manifestId, action: 'retire', fromState: 'retiring', toState: 'retired', actor: by, reason }, now);
        return (await load(q, manifestId))!;
      });
    },

    async admit(input) {
      const manifestId = requireText(input?.manifestId, 'admit: manifestId');
      const runId = requireText(input.runId, 'admit: runId');
      const cur = await pointer(db);
      const release = await load(db, manifestId);
      if (!cur) {
        if (input.requireActive) {
          return { allowed: false, reason: 'no runtime release is active (runtime.requireActiveRelease): register this runtime, record its compatibility suites and promote it to active first' };
        }
        // unmanaged (no release was ever activated): any runtime may create runs — except one that was rolled back/retired
        if (release && (release.rolledBack || release.state === 'retired')) {
          return { allowed: false, state: release.state, reason: `runtime ${short(manifestId)} is a retired${release.rolledBack ? ' (rolled back)' : ''} release: it creates no new runs` };
        }
        return { allowed: true, mode: 'unmanaged' };
      }
      if (cur.manifestId === manifestId) return { allowed: true, mode: 'active', activeManifestId: cur.manifestId };
      if (release?.state === 'canary') {
        if (canarySelects(release.canary, { runId, labels: input.labels ?? {} })) return { allowed: true, mode: 'canary', activeManifestId: cur.manifestId };
        return {
          allowed: false,
          state: 'canary',
          activeManifestId: cur.manifestId,
          reason: `runtime ${short(manifestId)} is the canary and its selection (${describeSelection(release.canary)}) does not pick run ${runId}; new runs go to the active release ${short(cur.manifestId)}`,
        };
      }
      const state = release?.state;
      return {
        allowed: false,
        activeManifestId: cur.manifestId,
        ...(state ? { state } : {}),
        reason: `runtime ${short(manifestId)} is ${state ? `a ${state}${release!.rolledBack ? ' (rolled back)' : ''} release` : 'not a registered release'}: new runs are created only under the active release ${short(cur.manifestId)} (or a canary that selects them)`,
      };
    },

    async history(manifestId) {
      const r = manifestId === undefined
        ? await db.query<TransitionRow>('SELECT transition_id, seq, manifest_id, action, from_state, to_state, actor, reason, details, at FROM ht_runtime_release_transitions ORDER BY seq')
        : await db.query<TransitionRow>('SELECT transition_id, seq, manifest_id, action, from_state, to_state, actor, reason, details, at FROM ht_runtime_release_transitions WHERE manifest_id = $1 ORDER BY seq', [manifestId]);
      return r.rows.map(toTransition);
    },

    async recordEpoch(input, tx) {
      const runId = requireText(input?.runId, 'recordEpoch: runId');
      requireText(input.fromManifestId, 'recordEpoch: fromManifestId');
      requireText(input.toManifestId, 'recordEpoch: toManifestId');
      requireText(input.snapshotId, 'recordEpoch: snapshotId');
      requireText(input.migratedBy, 'recordEpoch: migratedBy');
      requireText(input.reason, 'recordEpoch: reason');
      if (input.fromManifestId === input.toManifestId) throw invalid('recordEpoch: a runtime epoch changes the manifest');
      if (!Array.isArray(input.compatibility) || input.compatibility.some((c) => !c.ok)) throw precondition('recordEpoch: every compatibility check must pass');
      return inTx(tx, async (q) => {
        const prev = await q.query<{ epoch: unknown }>('SELECT epoch FROM ht_runtime_epochs WHERE run_id = $1 ORDER BY seq DESC LIMIT 1', [runId]);
        const last = prev.rows[0] ? fromJsonColumn<RuntimeEpoch>(prev.rows[0].epoch) : undefined;
        if (last && last.toManifestId !== input.fromManifestId) {
          throw new HypertestError('conflict', `recordEpoch: run ${runId} was last migrated to ${last.toManifestId}, not ${input.fromManifestId}`, { details: { runId } });
        }
        const epoch: RuntimeEpoch = {
          ...(jsonClone(input) as NewRuntimeEpoch),
          epochId: ids.next('rte'),
          seq: (last?.seq ?? 0) + 1,
          createdAt: clock.isoNow(),
        };
        if (last) epoch.previousEpochId = last.epochId;
        await q.query('INSERT INTO ht_runtime_epochs (epoch_id, run_id, seq, epoch, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)', [epoch.epochId, runId, epoch.seq, JSON.stringify(epoch), epoch.createdAt]);
        return epoch;
      });
    },

    async epochs(runId, tx) {
      const r = await (tx ?? db).query<{ epoch: unknown }>('SELECT epoch FROM ht_runtime_epochs WHERE run_id = $1 ORDER BY seq', [runId]);
      return r.rows.map((row) => fromJsonColumn<RuntimeEpoch>(row.epoch));
    },
  };
  return registry;
}

/** A canary selection in words (`12%`, `labels team=payments`). */
export function describeSelection(selection: CanarySelection | undefined): string {
  if (!selection) return 'none';
  const parts: string[] = [];
  if (selection.percentage !== undefined && selection.percentage > 0) parts.push(`${selection.percentage}% of runs`);
  const labels = Object.entries(selection.labels ?? {});
  if (labels.length > 0) parts.push(`labels ${labels.map(([k, v]) => `${k}=${v}`).join(',')}`);
  return parts.join(' or ') || 'none';
}
