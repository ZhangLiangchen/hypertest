import { canonicalJson, deepFreeze, fromJsonColumn, HypertestError, sha256Hex, toIso, type SqlExecutor } from '@hypertest/core';
import { eventFrom, EVENT_TYPES, type ContextSnapshot, type EventContext, type Freshness, type ReadSetEntry } from '@hypertest/domain';
import type { BuildSnapshotInput, ContextDeps, SnapshotBuilder, SnapshotBuilderDeps, SnapshotStore } from './contracts.ts';
import { cmpStr, isRecord, requireInt, requireText, storableJson } from './util.ts';

export type SnapshotContent = Omit<ContextSnapshot, 'snapshotId' | 'createdAt'>;

/** Content address of a snapshot: 'cs_' + sha256(canonicalJson(content without snapshotId/createdAt))[0..40]. */
export function snapshotIdFor(content: SnapshotContent | ContextSnapshot): string {
  const { snapshotId: _id, createdAt: _at, ...rest } = content as ContextSnapshot;
  return 'cs_' + sha256Hex(canonicalJson(rest)).slice(0, 40);
}

function validateFreshness(f: unknown, at: string): asserts f is Freshness {
  if (!isRecord(f)) throw new HypertestError('invalid_argument', `${at} must be an object`);
  if (f['kind'] === 'immutable' || f['kind'] === 'exact_version') return;
  if (f['kind'] === 'max_age') {
    const ms = f['milliseconds'];
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new HypertestError('invalid_argument', `${at}.milliseconds must be a number ≥ 0`);
    return;
  }
  throw new HypertestError('invalid_argument', `${at}.kind must be immutable, exact_version or max_age`);
}

export function validateReadSetEntry(e: unknown, at: string): asserts e is ReadSetEntry {
  if (!isRecord(e)) throw new HypertestError('invalid_argument', `${at} must be an object`);
  requireText(e['resourceType'], `${at}.resourceType`);
  requireText(e['resourceId'], `${at}.resourceId`);
  if (typeof e['observedVersion'] !== 'string') throw new HypertestError('invalid_argument', `${at}.observedVersion must be a string`);
  requireText(e['observedAt'], `${at}.observedAt`);
  if (Number.isNaN(Date.parse(e['observedAt']))) throw new HypertestError('invalid_argument', `${at}.observedAt must be an ISO timestamp`);
  validateFreshness(e['freshness'], `${at}.freshness`);
}

function validateRevisionMap(m: unknown, at: string): void {
  if (!isRecord(m)) throw new HypertestError('invalid_argument', `${at} must be an object`);
  for (const [k, v] of Object.entries(m)) requireInt(v, `${at}.${k}`, 0);
}

function validateContent(c: unknown): asserts c is SnapshotContent {
  if (!isRecord(c)) throw new HypertestError('invalid_argument', 'snapshot must be an object');
  requireText(c['runId'], 'snapshot.runId');
  requireInt(c['eventSeq'], 'snapshot.eventSeq');
  requireInt(c['blackboardRevision'], 'snapshot.blackboardRevision');
  requireInt(c['planRevision'], 'snapshot.planRevision');
  requireText(c['runtimeManifestId'], 'snapshot.runtimeManifestId');
  if (c['modelEpochId'] !== undefined) requireText(c['modelEpochId'], 'snapshot.modelEpochId');
  if (c['systemModelRevision'] !== undefined) requireInt(c['systemModelRevision'], 'snapshot.systemModelRevision');
  validateRevisionMap(c['oracleRevisions'], 'snapshot.oracleRevisions');
  validateRevisionMap(c['experimentRevisions'], 'snapshot.experimentRevisions');
  if (typeof c['policyRevision'] !== 'string') throw new HypertestError('invalid_argument', 'snapshot.policyRevision must be a string');
  if (typeof c['evidenceRootHash'] !== 'string') throw new HypertestError('invalid_argument', 'snapshot.evidenceRootHash must be a string');
  const env = c['environment'];
  if (env !== undefined) {
    if (!isRecord(env)) throw new HypertestError('invalid_argument', 'snapshot.environment must be an object');
    requireText(env['environmentId'], 'snapshot.environment.environmentId');
    requireInt(env['generation'], 'snapshot.environment.generation');
    if (env['buildDigest'] !== undefined && typeof env['buildDigest'] !== 'string') throw new HypertestError('invalid_argument', 'snapshot.environment.buildDigest must be a string');
  }
  if (!Array.isArray(c['readSet'])) throw new HypertestError('invalid_argument', 'snapshot.readSet must be an array');
  c['readSet'].forEach((e, i) => validateReadSetEntry(e, `snapshot.readSet[${i}]`));
}

interface SnapshotRow {
  snapshot_id: string;
  content: unknown;
  created_at: unknown;
}

function rowToSnapshot(r: SnapshotRow): ContextSnapshot {
  const content = fromJsonColumn<SnapshotContent>(r.content);
  const id = snapshotIdFor(content);
  // The id is a content address: a row edited behind the store no longer hashes to its id.
  if (id !== r.snapshot_id) {
    throw new HypertestError('integrity_violation', `context snapshot ${r.snapshot_id} does not match its content hash`, { details: { snapshotId: r.snapshot_id, recomputed: id } });
  }
  return deepFreeze({ ...content, snapshotId: r.snapshot_id, createdAt: toIso(r.created_at) } as ContextSnapshot);
}

const SELECT = 'SELECT snapshot_id, content, created_at FROM ht_context_snapshots';

/**
 * Immutable, content-addressed snapshots. Identical content ⇒ same id; the second create returns the stored
 * snapshot (with its original createdAt) and emits nothing. context.snapshot_created is written in the same
 * transaction as the row.
 */
export function createSnapshotStore(deps: ContextDeps): SnapshotStore {
  const { db, clock, logger } = deps;

  async function selectById(x: SqlExecutor, id: string): Promise<ContextSnapshot | undefined> {
    const r = await x.query<SnapshotRow>(`${SELECT} WHERE snapshot_id = $1`, [id]);
    return r.rows[0] ? rowToSnapshot(r.rows[0]) : undefined;
  }

  return {
    async create(snapshot, ctx) {
      validateContent(snapshot);
      const { snapshotId: _id, createdAt: _at, ...raw } = snapshot as ContextSnapshot;
      const content = storableJson(raw as SnapshotContent);
      const snapshotId = snapshotIdFor(content);
      const createdAt = clock.isoNow();
      return db.transaction(async (tx) => {
        const ins = await tx.query<{ snapshot_id: string }>(
          `INSERT INTO ht_context_snapshots (snapshot_id, run_id, content, created_at) VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (snapshot_id) DO NOTHING RETURNING snapshot_id`,
          [snapshotId, content.runId, JSON.stringify(content), createdAt],
        );
        if (ins.rows.length === 0) {
          const stored = await selectById(tx, snapshotId);
          if (!stored) throw new HypertestError('internal', `snapshot ${snapshotId} conflicted but is not readable`);
          return stored;
        }
        if (deps.events) {
          const payload: Record<string, unknown> = {
            snapshotId,
            eventSeq: content.eventSeq,
            blackboardRevision: content.blackboardRevision,
            planRevision: content.planRevision,
            evidenceRootHash: content.evidenceRootHash,
            readSetSize: content.readSet.length,
          };
          if (content.modelEpochId !== undefined) payload['modelEpochId'] = content.modelEpochId;
          if (content.environment) payload['environment'] = content.environment;
          const event = eventFrom(ctx, EVENT_TYPES.contextSnapshotCreated, 'context', snapshotId, payload);
          event.runId = content.runId;
          await deps.events.emit([event], tx);
        }
        logger.debug('context snapshot created', { snapshotId, runId: content.runId });
        return deepFreeze({ ...content, snapshotId, createdAt: new Date(createdAt).toISOString() } as ContextSnapshot);
      });
    },

    async get(snapshotId) {
      if (typeof snapshotId !== 'string' || snapshotId.length === 0) return undefined;
      return selectById(db, snapshotId);
    },

    async latest(runId) {
      const r = await db.query<SnapshotRow>(`${SELECT} WHERE run_id = $1 ORDER BY created_at DESC, ord DESC LIMIT 1`, [runId]);
      return r.rows[0] ? rowToSnapshot(r.rows[0]) : undefined;
    },
  };
}

function readSetKey(e: ReadSetEntry): string {
  return canonicalJson([e.resourceType, e.resourceId, e.observedVersion, e.freshness]);
}

/** Version string of an environment: `${generation}:${buildDigest ?? ''}` (shared with environmentResolver). */
export function environmentVersion(env: { generation: number; buildDigest?: string | undefined }): string {
  return `${env.generation}:${env.buildDigest ?? ''}`;
}

/**
 * Builds a snapshot from canonical sources. The read set always contains one exact_version entry per run
 * oracle (version = revision) and one for the environment (when given), plus the caller's observed entries.
 * The read set is sorted and de-duplicated so equal observations give equal snapshot ids.
 */
export function createSnapshotBuilder(deps: SnapshotBuilderDeps): SnapshotBuilder {
  const { sources, snapshots, clock } = deps;
  return {
    async build(input: BuildSnapshotInput, ctx: EventContext) {
      requireText(input?.runId, 'input.runId');
      const run = await sources.getRun(input.runId);
      if (!run) throw new HypertestError('not_found', `run ${input.runId} not found`);
      const [eventSeq, blackboardRevision, evidence, experimentRevisions] = await Promise.all([
        sources.lastEventSeq(input.runId),
        sources.blackboardRevision(input.runId),
        sources.evidenceRoot(input.runId),
        sources.experimentRevisions(input.runId),
      ]);
      const now = clock.isoNow();
      const entries: ReadSetEntry[] = [];
      for (const [oracleId, rev] of Object.entries(run.oracleRevisions ?? {})) {
        entries.push({ resourceType: 'oracle', resourceId: oracleId, observedVersion: String(rev), observedAt: now, freshness: { kind: 'exact_version' } });
      }
      if (input.environment) {
        requireText(input.environment.environmentId, 'input.environment.environmentId');
        requireInt(input.environment.generation, 'input.environment.generation');
        entries.push({
          resourceType: 'environment',
          resourceId: input.environment.environmentId,
          observedVersion: environmentVersion(input.environment),
          observedAt: now,
          freshness: { kind: 'exact_version' },
        });
      }
      (input.readSet ?? []).forEach((e, i) => {
        validateReadSetEntry(e, `input.readSet[${i}]`);
        entries.push(e);
      });
      const seen = new Set<string>();
      const readSet = entries
        .filter((e) => {
          const k = readSetKey(e);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .sort((a, b) => cmpStr(a.resourceType, b.resourceType) || cmpStr(a.resourceId, b.resourceId) || cmpStr(a.observedVersion, b.observedVersion) || cmpStr(a.observedAt, b.observedAt));

      const content: SnapshotContent = {
        runId: input.runId,
        eventSeq,
        blackboardRevision,
        planRevision: run.currentPlanRevision,
        runtimeManifestId: run.runtimeManifestId,
        oracleRevisions: { ...(run.oracleRevisions ?? {}) },
        experimentRevisions: { ...experimentRevisions },
        policyRevision: run.policyRevision,
        evidenceRootHash: evidence.rootHash,
        readSet,
      };
      if (input.modelEpochId !== undefined) content.modelEpochId = input.modelEpochId;
      if (run.systemModelRevision !== undefined) content.systemModelRevision = run.systemModelRevision;
      if (input.environment) {
        const env: { environmentId: string; generation: number; buildDigest?: string } = { environmentId: input.environment.environmentId, generation: input.environment.generation };
        if (input.environment.buildDigest !== undefined) env.buildDigest = input.environment.buildDigest;
        content.environment = env;
      }
      return snapshots.create(content, ctx);
    },
  };
}
