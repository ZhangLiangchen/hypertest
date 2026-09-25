import { HypertestError, canonicalJson, type SqlExecutor, type SqlParam } from '@hypertest/core';
import type { EventContext, ExperimentSpec, OracleChangeProposal, OracleSpec, SystemModel, TestArtifact } from '@hypertest/domain';
import type { CollabDeps, EventStore, SpecRepository } from './contracts.ts';
import { compact, eventInput, inTx, json, jsonParam, lockKey, lockRun, normalize, num, requireString } from './sql.ts';

export interface SpecRepositoryDeps extends CollabDeps {
  events: EventStore;
}

/** Revisioned tables: (id column, json column) per kind. Table/column names are constants, never input. */
type SpecTable = 'ht_system_models' | 'ht_oracles' | 'ht_experiments' | 'ht_test_artifacts';
const ID_COLUMN: Record<SpecTable, string> = {
  ht_system_models: 'system_model_id',
  ht_oracles: 'oracle_id',
  ht_experiments: 'experiment_id',
  ht_test_artifacts: 'artifact_id',
};
const JSON_COLUMN: Record<SpecTable, string> = {
  ht_system_models: 'model',
  ht_oracles: 'spec',
  ht_experiments: 'spec',
  ht_test_artifacts: 'artifact',
};

/**
 * Latest revision of a spec id, read under a per-id lock held until commit. Spec ids are not run-scoped (an
 * oracle is shared by every run; other ids may be revised from another run's context), so the run lock alone does
 * not serialize two writers of one id: without this lock both would compute the same next revision.
 */
async function latestRevision(q: SqlExecutor, table: SpecTable, id: string): Promise<number> {
  await lockKey(q, `${table}:${id}`);
  const r = await q.query<{ m: unknown }>(`SELECT COALESCE(MAX(revision), 0) AS m FROM ${table} WHERE ${ID_COLUMN[table]} = $1`, [id]);
  return num(r.rows[0]!.m);
}

async function getRevision<T>(q: SqlExecutor, table: SpecTable, id: string, revision?: number): Promise<T | undefined> {
  const col = JSON_COLUMN[table];
  const r =
    revision === undefined
      ? await q.query<{ v: unknown }>(`SELECT ${col} AS v FROM ${table} WHERE ${ID_COLUMN[table]} = $1 ORDER BY revision DESC LIMIT 1`, [id])
      : await q.query<{ v: unknown }>(`SELECT ${col} AS v FROM ${table} WHERE ${ID_COLUMN[table]} = $1 AND revision = $2`, [id, revision]);
  return r.rows[0] ? json<T>(r.rows[0].v) : undefined;
}

/** Latest revision of every id of a run. */
async function latestPerId<T>(q: SqlExecutor, table: Exclude<SpecTable, 'ht_oracles'>, runId: string): Promise<T[]> {
  const idc = ID_COLUMN[table];
  const r = await q.query<{ v: unknown }>(
    `SELECT v FROM (SELECT DISTINCT ON (${idc}) ${idc} AS id, ${JSON_COLUMN[table]} AS v FROM ${table} WHERE run_id = $1 ORDER BY ${idc}, revision DESC) latest ORDER BY id`,
    [runId],
  );
  return r.rows.map((row) => json<T>(row.v));
}

/**
 * Next revision for an append-only spec. `requested` (optimistic concurrency) is honoured only when it equals
 * the next revision; `requestedSupersedes` likewise must name the current latest revision.
 */
function nextRevision(kind: string, id: string, latest: number, requested: number | undefined, requestedSupersedes?: number): number {
  const next = latest + 1;
  if (requested !== undefined && requested !== next) {
    throw new HypertestError('conflict', `${kind} ${id}: revision ${requested} requested but the next revision is ${next}`, { details: { id, requested, expected: next } });
  }
  if (requestedSupersedes !== undefined && requestedSupersedes !== latest) {
    throw new HypertestError('conflict', `${kind} ${id}: supersedes ${requestedSupersedes} but the latest revision is ${latest}`, { details: { id, supersedes: requestedSupersedes, latest } });
  }
  return next;
}

const PROPOSAL_DECISION_FIELDS: ReadonlySet<string> = new Set(['status', 'decidedBy', 'decisionRationale', 'decidedAt']);

export function createSpecRepository(deps: SpecRepositoryDeps): SpecRepository {
  const { db, clock, events } = deps;

  return {
    // ------------------------------------------------------------------------------------- system models

    async saveSystemModel(model, ctx: EventContext, tx?: SqlExecutor) {
      requireString(model.systemModelId, 'systemModel.systemModelId');
      requireString(model.runId, 'systemModel.runId');
      return inTx(db, tx, async (q) => {
        await lockRun(q, ctx.runId);
        const latest = await latestRevision(q, 'ht_system_models', model.systemModelId);
        const revision = nextRevision('system model', model.systemModelId, latest, undefined);
        const stored: SystemModel = normalize({ ...model, revision, supersedes: latest > 0 ? latest : undefined, createdAt: clock.isoNow() } as SystemModel);
        await q.query('INSERT INTO ht_system_models (system_model_id, revision, run_id, model, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)', [
          stored.systemModelId, stored.revision, stored.runId, jsonParam(stored), stored.createdAt,
        ]);
        await events.append(
          [eventInput(ctx, 'system_model.recorded', 'system_model', stored.systemModelId, compact({
            systemModelId: stored.systemModelId, revision: stored.revision, supersedes: stored.supersedes, components: stored.components.length,
            changedComponents: stored.changedComponents, riskTags: stored.riskTags,
          }))],
          q,
        );
        return stored;
      });
    },

    async latestSystemModel(runId) {
      const r = await db.query<{ model: unknown }>('SELECT model FROM ht_system_models WHERE run_id = $1 ORDER BY write_seq DESC LIMIT 1', [runId]);
      return r.rows[0] ? json<SystemModel>(r.rows[0].model) : undefined;
    },

    // ------------------------------------------------------------------------------------- oracles

    async saveOracle(spec, ctx, tx) {
      requireString(spec.oracleId, 'oracle.oracleId');
      return inTx(db, tx, async (q) => {
        await lockRun(q, ctx.runId);
        const latest = await latestRevision(q, 'ht_oracles', spec.oracleId);
        const revision = nextRevision('oracle', spec.oracleId, latest, spec.revision);
        const stored: OracleSpec = normalize({ ...spec, revision, supersedes: latest > 0 ? latest : undefined, createdAt: clock.isoNow() } as OracleSpec);
        await q.query('INSERT INTO ht_oracles (oracle_id, revision, status, spec, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)', [
          stored.oracleId, stored.revision, stored.status, jsonParam(stored), stored.createdAt,
        ]);
        await events.append(
          [eventInput(ctx, 'oracle.revised', 'oracle', stored.oracleId, compact({
            oracleId: stored.oracleId, revision: stored.revision, supersedes: stored.supersedes, status: stored.status, assertions: stored.assertions.length,
            approvedBy: stored.approvedBy.map((a) => a.id),
          }))],
          q,
        );
        return stored;
      });
    },

    getOracle(oracleId, revision) {
      return getRevision<OracleSpec>(db, 'ht_oracles', oracleId, revision);
    },

    async listOracles(filter = {}) {
      const params: SqlParam[] = [];
      let sql = 'SELECT spec FROM (SELECT DISTINCT ON (oracle_id) oracle_id, status, spec FROM ht_oracles ORDER BY oracle_id, revision DESC) latest';
      if (filter.status !== undefined) {
        params.push(filter.status);
        sql += ' WHERE status = ANY($1)';
      }
      sql += ' ORDER BY oracle_id';
      const r = await db.query<{ spec: unknown }>(sql, params);
      return r.rows.map((row) => json<OracleSpec>(row.spec));
    },

    async saveOracleProposal(p: OracleChangeProposal, ctx: EventContext, tx?: SqlExecutor) {
      requireString(p.proposalId, 'proposal.proposalId');
      requireString(p.runId, 'proposal.runId');
      requireString(p.oracleId, 'proposal.oracleId');
      const next = normalize(p);
      return inTx(db, tx, async (q) => {
        await lockRun(q, ctx.runId);
        const r = await q.query<{ proposal: unknown }>('SELECT proposal FROM ht_oracle_proposals WHERE proposal_id = $1 FOR UPDATE', [p.proposalId]);
        const cur = r.rows[0] ? json<OracleChangeProposal>(r.rows[0].proposal) : undefined;
        const now = clock.isoNow();
        if (!cur) {
          if (next.status !== 'pending') {
            throw new HypertestError('invalid_argument', `proposal ${p.proposalId} must be created pending (got ${next.status}); decisions are recorded on an existing proposal`);
          }
          await q.query(
            'INSERT INTO ht_oracle_proposals (proposal_id, run_id, oracle_id, status, proposal, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)',
            [next.proposalId, next.runId, next.oracleId, next.status, jsonParam(next), now, now],
          );
          await events.append(
            [eventInput(ctx, 'oracle.change_proposed', 'oracle', next.oracleId, compact({
              proposalId: next.proposalId, oracleId: next.oracleId, fromRevision: next.fromRevision, proposedBy: next.proposedBy.id,
              proposerKind: next.proposedBy.kind, wouldFlipRecordedFailure: next.wouldFlipRecordedFailure, assertions: next.proposedAssertions.length,
            }))],
            q,
          );
          return next;
        }
        if (canonicalJson(cur) === canonicalJson(next)) return cur; // idempotent re-save
        // A proposal's content is immutable; only a pending proposal may be decided, exactly once.
        const changed = [...new Set([...Object.keys(cur), ...Object.keys(next)])].filter(
          (k) => canonicalJson((cur as unknown as Record<string, unknown>)[k] ?? null) !== canonicalJson((next as unknown as Record<string, unknown>)[k] ?? null),
        );
        const illegal = changed.filter((k) => !PROPOSAL_DECISION_FIELDS.has(k));
        if (illegal.length > 0) {
          throw new HypertestError('conflict', `proposal ${p.proposalId} content is immutable (changed: ${illegal.join(', ')})`, { details: { proposalId: p.proposalId, changed: illegal } });
        }
        if (cur.status !== 'pending') {
          throw new HypertestError('precondition_failed', `proposal ${p.proposalId} is already ${cur.status}`, { details: { proposalId: p.proposalId, status: cur.status } });
        }
        if (next.status === 'pending') {
          throw new HypertestError('invalid_argument', `proposal ${p.proposalId}: decision fields changed but status is still pending`);
        }
        // I8 defence in depth (OracleGovernance enforces the full independence rules): the proposer can never be the
        // approver of its own oracle change.
        if (next.status === 'approved' && next.decidedBy !== undefined && next.decidedBy.kind === cur.proposedBy.kind && next.decidedBy.id === cur.proposedBy.id) {
          throw new HypertestError('permission_denied', `proposal ${p.proposalId} cannot be approved by its proposer ${cur.proposedBy.id}`, {
            details: { proposalId: p.proposalId, proposedBy: cur.proposedBy.id, decidedBy: next.decidedBy.id },
          });
        }
        if (next.status === 'approved' && next.decidedBy === undefined) {
          throw new HypertestError('invalid_argument', `proposal ${p.proposalId}: an approval must name decidedBy`);
        }
        await q.query('UPDATE ht_oracle_proposals SET status = $2, proposal = $3::jsonb, updated_at = $4 WHERE proposal_id = $1', [next.proposalId, next.status, jsonParam(next), now]);
        await events.append(
          [eventInput(ctx, next.status === 'approved' ? 'oracle.change_approved' : 'oracle.change_rejected', 'oracle', next.oracleId, compact({
            proposalId: next.proposalId, oracleId: next.oracleId, fromRevision: next.fromRevision, decidedBy: next.decidedBy?.id, deciderKind: next.decidedBy?.kind,
          }))],
          q,
        );
        return next;
      });
    },

    async getOracleProposal(proposalId) {
      const r = await db.query<{ proposal: unknown }>('SELECT proposal FROM ht_oracle_proposals WHERE proposal_id = $1', [proposalId]);
      return r.rows[0] ? json<OracleChangeProposal>(r.rows[0].proposal) : undefined;
    },

    async listOracleProposals(filter) {
      const params: SqlParam[] = [];
      const where: string[] = [];
      if (filter.runId !== undefined) {
        params.push(filter.runId);
        where.push(`run_id = $${params.length}`);
      }
      if (filter.status !== undefined) {
        params.push(filter.status);
        where.push(`status = ANY($${params.length})`);
      }
      const sql = `SELECT proposal FROM ht_oracle_proposals${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, proposal_id`;
      const r = await db.query<{ proposal: unknown }>(sql, params);
      return r.rows.map((row) => json<OracleChangeProposal>(row.proposal));
    },

    // ------------------------------------------------------------------------------------- experiments

    async saveExperiment(spec, ctx, tx) {
      requireString(spec.experimentId, 'experiment.experimentId');
      requireString(spec.runId, 'experiment.runId');
      return inTx(db, tx, async (q) => {
        await lockRun(q, ctx.runId);
        const latest = await latestRevision(q, 'ht_experiments', spec.experimentId);
        const revision = nextRevision('experiment', spec.experimentId, latest, undefined);
        const stored: ExperimentSpec = normalize({ ...spec, revision, supersedes: latest > 0 ? latest : undefined, createdAt: clock.isoNow() } as ExperimentSpec);
        await q.query('INSERT INTO ht_experiments (experiment_id, revision, run_id, spec, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)', [
          stored.experimentId, stored.revision, stored.runId, jsonParam(stored), stored.createdAt,
        ]);
        await events.append(
          [eventInput(ctx, 'experiment.defined', 'experiment', stored.experimentId, compact({
            experimentId: stored.experimentId, revision: stored.revision, supersedes: stored.supersedes, oracleRefs: stored.oracleRefs,
            environmentId: stored.environment.environmentId, isolation: stored.isolation.mode,
          }))],
          q,
        );
        return stored;
      });
    },

    getExperiment(experimentId, revision) {
      return getRevision<ExperimentSpec>(db, 'ht_experiments', experimentId, revision);
    },

    listExperiments(runId) {
      return latestPerId<ExperimentSpec>(db, 'ht_experiments', runId);
    },

    // ------------------------------------------------------------------------------------- test artifacts

    async saveTestArtifact(a, ctx, tx) {
      requireString(a.artifactId, 'testArtifact.artifactId');
      requireString(a.runId, 'testArtifact.runId');
      return inTx(db, tx, async (q) => {
        await lockRun(q, ctx.runId);
        const latest = await latestRevision(q, 'ht_test_artifacts', a.artifactId);
        const revision = nextRevision('test artifact', a.artifactId, latest, a.revision, a.supersedes);
        const stored: TestArtifact = normalize({ ...a, revision, supersedes: latest > 0 ? latest : undefined, createdAt: clock.isoNow() } as TestArtifact);
        await q.query('INSERT INTO ht_test_artifacts (artifact_id, revision, run_id, approval_state, artifact, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)', [
          stored.artifactId, stored.revision, stored.runId, stored.approvalState, jsonParam(stored), stored.createdAt,
        ]);
        const type = stored.approvalState === 'validated' ? 'test_artifact.validated' : 'test_artifact.registered';
        await events.append(
          [eventInput(ctx, type, 'test_artifact', stored.artifactId, compact({
            artifactId: stored.artifactId, revision: stored.revision, supersedes: stored.supersedes, approvalState: stored.approvalState,
            sourceType: stored.sourceType, path: stored.path, artifactDigest: stored.artifactDigest, experimentId: stored.experimentId,
          }))],
          q,
        );
        return stored;
      });
    },

    getTestArtifact(artifactId, revision) {
      return getRevision<TestArtifact>(db, 'ht_test_artifacts', artifactId, revision);
    },

    listTestArtifacts(runId) {
      return latestPerId<TestArtifact>(db, 'ht_test_artifacts', runId);
    },
  };
}
