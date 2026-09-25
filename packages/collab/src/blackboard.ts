import { HypertestError, type SqlExecutor, type SqlParam } from '@hypertest/core';
import {
  canTransitionWorkItem,
  isTerminalWorkState,
  type BlackboardRecord,
  type WorkClaim,
  type BlackboardRecordType,
  type DomainEventInput,
  type EventContext,
  type PlanRevision,
  type WorkItem,
  type WorkItemState,
} from '@hypertest/domain';
import type { Blackboard, CollabDeps, EventStore, NewRecordInput, NewWorkItem, WorkItemPatch } from './contracts.ts';
import {
  bumpRevision, compact, eventInput, inTx, iso, json, jsonParam, lockRun, normalize, num, requireArray, requireFinite, requireNonNegativeInt, requireObject,
  requireRunMatch, requireString,
} from './sql.ts';

export interface BlackboardDeps extends CollabDeps {
  events: EventStore;
}

const RECORD_TYPES: ReadonlySet<string> = new Set(['finding', 'hypothesis', 'coverage_gap', 'risk', 'review', 'test_strategy', 'decision', 'note']);

interface RecordRow {
  record_id: string;
  lineage_id: string;
  record_type: string;
  run_id: string;
  revision: unknown;
  version: unknown;
  created_by: string;
  work_item_id: string | null;
  payload: unknown;
  evidence_refs: unknown;
  supersedes: string | null;
  is_head: boolean;
  created_at: unknown;
}

function rowToRecord<T>(r: RecordRow): BlackboardRecord<T> {
  const rec: BlackboardRecord<T> = {
    recordId: r.record_id,
    lineageId: r.lineage_id,
    recordType: r.record_type as BlackboardRecordType,
    runId: r.run_id,
    revision: num(r.revision),
    version: num(r.version),
    createdBy: r.created_by,
    payload: json<T>(r.payload),
    evidenceRefs: json<string[]>(r.evidence_refs),
    createdAt: iso(r.created_at),
  };
  if (r.work_item_id !== null) rec.workItemId = r.work_item_id;
  if (r.supersedes !== null) rec.supersedes = r.supersedes;
  return rec;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Event types for a record write (contracts.ts): the base event plus a status event when the status newly
 * became confirmed/rejected (findings) or supported/refuted (hypotheses).
 */
function recordEventTypes(recordType: BlackboardRecordType, isNew: boolean, status: string | undefined, previousStatus: string | undefined): string[] {
  const changed = status !== undefined && status !== previousStatus;
  switch (recordType) {
    case 'finding': {
      const out = [isNew ? 'finding.created' : 'finding.updated'];
      if (changed && status === 'confirmed') out.push('finding.confirmed');
      if (changed && status === 'rejected') out.push('finding.rejected');
      return out;
    }
    case 'hypothesis': {
      const out: string[] = [];
      if (isNew) out.push('hypothesis.created');
      if (changed && status === 'supported') out.push('hypothesis.supported');
      if (changed && status === 'refuted') out.push('hypothesis.refuted');
      if (out.length === 0) out.push('record.posted');
      return out;
    }
    case 'coverage_gap':
      return [isNew ? 'coverage.gap_detected' : 'record.posted'];
    case 'risk':
      return [isNew ? 'risk.identified' : 'record.posted'];
    case 'review':
      return ['review.completed'];
    default:
      return ['record.posted'];
  }
}

/** Small payload with what reactors filter on (severity, category, status, title …), never the full record. */
function recordEventPayload(rec: BlackboardRecord<unknown>, previousStatus: string | undefined): Record<string, unknown> {
  const p = (rec.payload ?? {}) as Record<string, unknown>;
  const base: Record<string, unknown> = {
    recordId: rec.recordId,
    lineageId: rec.lineageId,
    recordType: rec.recordType,
    version: rec.version,
    revision: rec.revision,
    supersedes: rec.supersedes,
    workItemId: rec.workItemId,
    status: str(p['status']),
    previousStatus,
  };
  switch (rec.recordType) {
    case 'finding':
      Object.assign(base, { severity: str(p['severity']), category: str(p['category']), title: str(p['title']), fingerprint: str(p['fingerprint']), component: str(p['component']) });
      break;
    case 'hypothesis':
      Object.assign(base, { findingLineageId: str(p['findingLineageId']), title: str(p['statement'])?.slice(0, 200) });
      break;
    case 'coverage_gap':
      Object.assign(base, { title: str(p['area']), relatedFindingLineageId: str(p['relatedFindingLineageId']), relatedRiskLineageId: str(p['relatedRiskLineageId']) });
      break;
    case 'risk':
      Object.assign(base, { title: str(p['title']), level: str(p['level']), source: str(p['source']) });
      break;
    case 'review': {
      const subject = p['subjectRef'] as { kind?: unknown; id?: unknown } | undefined;
      Object.assign(base, { verdict: str(p['verdict']), reviewerRole: str(p['reviewerRole']), subjectRef: subject ? compact({ kind: subject.kind, id: subject.id }) : undefined });
      break;
    }
    case 'decision':
      Object.assign(base, { title: str(p['topic']) });
      break;
    default:
      break;
  }
  return compact(base);
}

// ----------------------------------------------------------------------------------------- work items

interface WorkRow {
  item: unknown;
}

const WORK_EVENT: Record<WorkItemState, string> = {
  proposed: 'work.created',
  ready: 'work.ready',
  blocked: 'work.blocked',
  claimed: 'work.claimed',
  running: 'work.started',
  waiting: 'work.waiting',
  completed: 'work.completed',
  failed: 'work.failed',
  cancelled: 'work.cancelled',
};

const REQUEUE_FROM: ReadonlySet<WorkItemState> = new Set(['claimed', 'running', 'waiting', 'failed']);

export function workEventType(from: WorkItemState, to: WorkItemState): string {
  if (to === 'ready' && REQUEUE_FROM.has(from)) return 'work.requeued';
  return WORK_EVENT[to];
}

function workPayload(item: WorkItem, from: WorkItemState | undefined): Record<string, unknown> {
  return compact({
    workItemId: item.workItemId,
    from,
    to: item.state,
    state: item.state,
    role: item.role,
    kind: item.kind,
    title: item.title,
    attempts: item.attempts,
    priority: item.priority,
    depth: item.depth,
    fingerprint: from === undefined ? item.fingerprint : undefined,
    planRevision: item.planRevision,
    parentWorkItemId: item.parentWorkItemId,
    ownerId: item.claim?.ownerId,
    leaseId: item.claim?.leaseId,
    fencingToken: item.claim?.fencingToken,
    waitingOn: item.state === 'waiting' ? item.waitingOn : undefined,
    failure: item.state === 'failed' ? item.failure : undefined,
    resultSummary: item.state === 'completed' ? item.result?.summary : undefined,
  });
}

async function writeWorkItem(q: SqlExecutor, item: WorkItem, revision: number, fenceHighWater: number, insert: boolean): Promise<number> {
  const params: SqlParam[] = [
    item.workItemId, item.runId, item.kind, item.role, item.state, item.title, item.priority, item.planRevision ?? null, item.parentWorkItemId ?? null,
    item.depth, item.fingerprint, item.attempts, item.claim?.ownerId ?? null, item.claim?.fencingToken ?? null, item.agentId ?? null,
    item.causationEventId ?? null, revision, jsonParam(item), item.createdAt, item.updatedAt, fenceHighWater,
  ];
  if (insert) {
    const r = await q.query(
      `INSERT INTO ht_work_items (work_item_id, run_id, kind, role, state, title, priority, plan_revision, parent_work_item_id, depth, fingerprint,
         attempts, claim_owner_id, claim_fencing_token, agent_id, causation_event_id, revision, item, created_at, updated_at, fence_high_water)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21)
       ON CONFLICT (run_id, fingerprint) DO NOTHING`,
      params,
    );
    return r.rowCount;
  }
  const r = await q.query(
    `UPDATE ht_work_items SET kind = $3, role = $4, state = $5, title = $6, priority = $7, plan_revision = $8, parent_work_item_id = $9, depth = $10,
       fingerprint = $11, attempts = $12, claim_owner_id = $13, claim_fencing_token = $14, agent_id = $15, causation_event_id = $16, revision = $17,
       item = $18::jsonb, created_at = $19, updated_at = $20, fence_high_water = $21
     WHERE work_item_id = $1 AND run_id = $2`,
    params,
  );
  return r.rowCount;
}

/** Fields of a new work item that only the Blackboard may set; stripped from caller input even if present at runtime. */
const STORE_OWNED_FIELDS = ['workItemId', 'state', 'claim', 'agentId', 'result', 'failure', 'attempts', 'waitingOn', 'createdAt', 'updatedAt'] as const;

/** Rejects a NewWorkItem that would violate a column constraint or produce an unusable WorkItem (invalid_argument, not an SQL fault). */
function validateNewWorkItem(input: NewWorkItem): void {
  requireString(input.runId, 'workItem.runId');
  requireString(input.fingerprint, 'workItem.fingerprint');
  requireString(input.role, 'workItem.role');
  requireString(input.kind, 'workItem.kind');
  requireString(input.title, 'workItem.title');
  if (typeof input.objective !== 'string') throw new HypertestError('invalid_argument', 'workItem.objective must be a string');
  requireString(requireObject(input.origin, 'workItem.origin')['kind'], 'workItem.origin.kind');
  requireObject(input.budget, 'workItem.budget');
  requireFinite(input.priority, 'workItem.priority');
  requireNonNegativeInt(input.depth, 'workItem.depth');
  for (const k of ['objectiveIds', 'capabilityRequirements', 'inputRefs', 'evidenceRequirements', 'dependsOn', 'resourceClaims'] as const) requireArray(input[k], `workItem.${k}`);
  if (input.planRevision !== undefined) requireNonNegativeInt(input.planRevision, 'workItem.planRevision');
  if (input.workItemId !== undefined) requireString(input.workItemId, 'workItem.workItemId');
}

function validateClaim(claim: WorkClaim, what: string): void {
  const c = requireObject(claim, what);
  requireString(c['ownerId'], `${what}.ownerId`);
  requireString(c['leaseId'], `${what}.leaseId`);
  requireNonNegativeInt(c['fencingToken'], `${what}.fencingToken`);
  requireString(c['expiresAt'], `${what}.expiresAt`);
}

function validatePatch(patch: WorkItemPatch): void {
  requireObject(patch, 'patch');
  if (patch.claim !== undefined && patch.claim !== null) validateClaim(patch.claim, 'patch.claim');
  if (patch.attempts !== undefined) requireNonNegativeInt(patch.attempts, 'patch.attempts');
  if (patch.priority !== undefined) requireFinite(patch.priority, 'patch.priority');
  if (patch.waitingOn !== undefined && (!Array.isArray(patch.waitingOn) || patch.waitingOn.some((w) => typeof w !== 'string'))) {
    throw new HypertestError('invalid_argument', 'patch.waitingOn must be an array of strings');
  }
  if (patch.agentId !== undefined) requireString(patch.agentId, 'patch.agentId');
}

/** States in which nobody holds the item: entering one drops the claim, so a stale holder's token stops matching. */
const HOLDERLESS: ReadonlySet<WorkItemState> = new Set(['proposed', 'ready', 'blocked']);

/**
 * Same-state patch fields that change who/what owns the work (audited with `work.updated`). A claim whose only
 * change is `expiresAt` is a lease renewal: bookkeeping owned by the LeaseService, not an audit event.
 */
function significantChanges(cur: WorkItem, next: WorkItem): string[] {
  const changed: string[] = [];
  const claimKey = (c: WorkClaim | undefined) => JSON.stringify(c ? [c.ownerId, c.leaseId, c.fencingToken] : null);
  if (claimKey(cur.claim) !== claimKey(next.claim)) changed.push('claim');
  for (const k of ['agentId', 'attempts', 'priority', 'result', 'failure', 'waitingOn'] as const) {
    if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(next[k] ?? null)) changed.push(k);
  }
  return changed;
}

function applyPatch(cur: WorkItem, patch: WorkItemPatch): WorkItem {
  const next: WorkItem = { ...cur };
  if (patch.claim === null) delete next.claim;
  else if (patch.claim !== undefined) next.claim = patch.claim;
  if (patch.agentId !== undefined) next.agentId = patch.agentId;
  if (patch.result !== undefined) next.result = patch.result;
  if (patch.failure !== undefined) next.failure = patch.failure;
  if (patch.waitingOn !== undefined) next.waitingOn = patch.waitingOn;
  if (patch.attempts !== undefined) next.attempts = patch.attempts;
  if (patch.priority !== undefined) next.priority = patch.priority;
  return next;
}

// ----------------------------------------------------------------------------------------- plans

interface PlanRow {
  plan: unknown;
}

function planPayload(plan: PlanRevision, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return compact({
    planId: plan.planId,
    revision: plan.revision,
    parentRevision: plan.parentRevision,
    status: plan.status,
    proposedBy: plan.proposedBy,
    workItems: plan.workItems.length,
    cancelWorkItems: plan.cancelWorkItems.length,
    objectives: plan.objectives.length,
    readyForGate: plan.readyForGate,
    ...extra,
  });
}

// ----------------------------------------------------------------------------------------- factory

export function createBlackboard(deps: BlackboardDeps): Blackboard {
  const { db, ids, clock, events } = deps;

  async function planById(q: SqlExecutor, runId: string, revision: number, lock: boolean): Promise<PlanRevision | undefined> {
    const r = await q.query<PlanRow>(`SELECT plan FROM ht_plans WHERE run_id = $1 AND revision = $2${lock ? ' FOR UPDATE' : ''}`, [runId, revision]);
    return r.rows[0] ? json<PlanRevision>(r.rows[0].plan) : undefined;
  }

  async function writePlan(q: SqlExecutor, plan: PlanRevision): Promise<void> {
    await q.query('UPDATE ht_plans SET status = $3, plan = $4::jsonb, decided_at = $5 WHERE run_id = $1 AND revision = $2', [
      plan.runId, plan.revision, plan.status, jsonParam(plan), plan.decidedAt ?? null,
    ]);
  }

  const board: Blackboard = {
    async revision(runId) {
      const r = await db.query<{ bb_revision: unknown }>('SELECT bb_revision FROM ht_run_counters WHERE run_id = $1', [runId]);
      return r.rows[0] ? num(r.rows[0].bb_revision) : 0;
    },

    // ------------------------------------------------------------------------------------- records

    async postRecord(input, ctx, tx) {
      requireString(input.runId, 'record.runId');
      requireRunMatch(input.runId, ctx, 'record');
      if (!RECORD_TYPES.has(input.recordType)) throw new HypertestError('invalid_argument', `unknown record type ${String(input.recordType)}`);
      requireString(input.createdBy, 'record.createdBy');
      if (input.payload === null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
        throw new HypertestError('invalid_argument', 'record.payload must be an object');
      }
      if (input.evidenceRefs !== undefined && (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.some((r) => typeof r !== 'string'))) {
        throw new HypertestError('invalid_argument', 'record.evidenceRefs must be an array of strings');
      }
      if (input.workItemId !== undefined) requireString(input.workItemId, 'record.workItemId');
      return inTx(db, tx, async (q) => {
        await lockRun(q, input.runId);
        let lineageId: string;
        let version = 1;
        let previousStatus: string | undefined;
        const recordId = ids.next('rec');
        if (input.supersedes !== undefined) {
          const prev = await q.query<RecordRow>('SELECT * FROM ht_records WHERE record_id = $1 FOR UPDATE', [input.supersedes]);
          const p = prev.rows[0];
          if (!p) throw new HypertestError('not_found', `superseded record ${input.supersedes} does not exist`);
          if (p.run_id !== input.runId || p.record_type !== input.recordType) {
            throw new HypertestError('invalid_argument', `record ${input.supersedes} is a ${p.record_type} of run ${p.run_id}; cannot supersede it with a ${input.recordType} of run ${input.runId}`);
          }
          if (!p.is_head) {
            const head = await q.query<{ record_id: string }>('SELECT record_id FROM ht_records WHERE lineage_id = $1 AND is_head', [p.lineage_id]);
            throw new HypertestError('conflict', `record ${input.supersedes} is not the head of lineage ${p.lineage_id}`, {
              details: { lineageId: p.lineage_id, supersedes: input.supersedes, head: head.rows[0]?.record_id },
            });
          }
          await q.query('UPDATE ht_records SET is_head = false WHERE record_id = $1', [p.record_id]);
          lineageId = p.lineage_id;
          version = num(p.version) + 1;
          previousStatus = str(json<Record<string, unknown>>(p.payload)?.['status']);
        } else {
          lineageId = recordId;
        }
        const revision = await bumpRevision(q, input.runId);
        const rec = normalize({
          recordId,
          lineageId,
          recordType: input.recordType,
          runId: input.runId,
          revision,
          version,
          createdBy: input.createdBy,
          workItemId: input.workItemId,
          payload: input.payload,
          evidenceRefs: input.evidenceRefs ?? [],
          supersedes: input.supersedes,
          createdAt: clock.isoNow(),
        }) as BlackboardRecord<unknown>;
        await q.query(
          `INSERT INTO ht_records (record_id, lineage_id, record_type, run_id, revision, version, created_by, work_item_id, payload, evidence_refs,
             supersedes, is_head, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, true, $12)`,
          [rec.recordId, rec.lineageId, rec.recordType, rec.runId, rec.revision, rec.version, rec.createdBy, rec.workItemId ?? null,
            jsonParam(rec.payload), jsonParam(rec.evidenceRefs), rec.supersedes ?? null, rec.createdAt],
        );
        const status = str((rec.payload as Record<string, unknown>)['status']);
        const payload = recordEventPayload(rec, previousStatus);
        const evs: DomainEventInput<unknown>[] = recordEventTypes(rec.recordType, version === 1, status, previousStatus).map((type) =>
          // I10: the record's work item stands in when the caller's context carries none.
          eventInput(ctx, type, 'record', rec.lineageId, payload, rec.workItemId),
        );
        await events.append(evs, q);
        return rec as BlackboardRecord<never>;
      });
    },

    async getRecord<T>(recordId: string) {
      const r = await db.query<RecordRow>('SELECT * FROM ht_records WHERE record_id = $1', [recordId]);
      return r.rows[0] ? rowToRecord<T>(r.rows[0]) : undefined;
    },

    async head<T>(lineageId: string) {
      const r = await db.query<RecordRow>('SELECT * FROM ht_records WHERE lineage_id = $1 AND is_head', [lineageId]);
      return r.rows[0] ? rowToRecord<T>(r.rows[0]) : undefined;
    },

    async query<T>(query: Parameters<Blackboard['query']>[0]) {
      const params: SqlParam[] = [query.runId];
      let sql = 'SELECT * FROM ht_records WHERE run_id = $1';
      if (query.recordType !== undefined) {
        params.push(Array.isArray(query.recordType) ? query.recordType : [query.recordType]);
        sql += ` AND record_type = ANY($${params.length})`;
      }
      if (query.status !== undefined) {
        params.push(query.status);
        sql += ` AND status = ANY($${params.length})`;
      }
      if (query.workItemId !== undefined) {
        params.push(query.workItemId);
        sql += ` AND work_item_id = $${params.length}`;
      }
      if (query.afterRevision !== undefined) {
        params.push(query.afterRevision);
        sql += ` AND revision > $${params.length}`;
      }
      if (!query.includeSuperseded) sql += ' AND is_head';
      sql += ' ORDER BY revision';
      if (query.limit !== undefined) {
        params.push(Math.max(0, Math.floor(query.limit)));
        sql += ` LIMIT $${params.length}`;
      }
      const r = await db.query<RecordRow>(sql, params);
      return r.rows.map((row) => rowToRecord<T>(row));
    },

    // ------------------------------------------------------------------------------------- work items

    async createWorkItem(input: NewWorkItem, ctx: EventContext, tx?: SqlExecutor) {
      validateNewWorkItem(input);
      requireRunMatch(input.runId, ctx, 'workItem');
      const state = input.state ?? 'ready';
      if (state !== 'proposed' && state !== 'ready' && state !== 'blocked') throw new HypertestError('invalid_argument', `a new work item cannot start in state ${String(state)}`);
      return inTx(db, tx, async (q) => {
        // Run lock first: concurrent creators of one run serialize, so the fingerprint check below is exact and
        // a duplicate neither bumps the revision nor emits an event.
        await lockRun(q, input.runId);
        const existing = await q.query<WorkRow>('SELECT item FROM ht_work_items WHERE run_id = $1 AND fingerprint = $2', [input.runId, input.fingerprint]);
        if (existing.rows[0]) return { workItem: json<WorkItem>(existing.rows[0].item), created: false };

        const now = clock.isoNow();
        const rest: Record<string, unknown> = { ...input };
        for (const k of STORE_OWNED_FIELDS) delete rest[k];
        const item: WorkItem = normalize({
          ...(rest as unknown as NewWorkItem),
          workItemId: input.workItemId ?? ids.next('wi'),
          state,
          attempts: 0,
          waitingOn: [],
          causationEventId: input.causationEventId ?? ctx.causationId,
          createdAt: now,
          updatedAt: now,
        } as WorkItem);
        const revision = await bumpRevision(q, input.runId);
        const inserted = await writeWorkItem(q, item, revision, 0, true);
        if (inserted !== 1) {
          // Only reachable when a writer bypassed the run lock; report instead of guessing.
          throw new HypertestError('conflict', `work item fingerprint ${item.fingerprint} was inserted concurrently`);
        }
        const evs = [eventInput(ctx, 'work.created', 'work_item', item.workItemId, workPayload(item, undefined), item.workItemId)];
        if (state === 'ready') evs.push(eventInput(ctx, 'work.ready', 'work_item', item.workItemId, workPayload(item, 'proposed'), item.workItemId));
        await events.append(evs, q);
        return { workItem: item, created: true };
      });
    },

    async getWorkItem(workItemId) {
      const r = await db.query<WorkRow>('SELECT item FROM ht_work_items WHERE work_item_id = $1', [workItemId]);
      return r.rows[0] ? json<WorkItem>(r.rows[0].item) : undefined;
    },

    async listWorkItems(filter) {
      const params: SqlParam[] = [filter.runId];
      let sql = 'SELECT item FROM ht_work_items WHERE run_id = $1';
      if (filter.states !== undefined) {
        params.push(filter.states);
        sql += ` AND state = ANY($${params.length})`;
      }
      if (filter.roles !== undefined) {
        params.push(filter.roles);
        sql += ` AND role = ANY($${params.length})`;
      }
      if (filter.planRevision !== undefined) {
        params.push(filter.planRevision);
        sql += ` AND plan_revision = $${params.length}`;
      }
      sql += ' ORDER BY created_at, work_item_id';
      const r = await db.query<WorkRow>(sql, params);
      return r.rows.map((row) => json<WorkItem>(row.item));
    },

    async transitionWorkItem(workItemId, to, patch, ctx, options = {}) {
      validatePatch(patch);
      return inTx(db, options.tx, async (q) => {
        const pre = await q.query<{ run_id: string }>('SELECT run_id FROM ht_work_items WHERE work_item_id = $1', [workItemId]);
        if (!pre.rows[0]) throw new HypertestError('not_found', `work item ${workItemId} does not exist`);
        const runId = pre.rows[0].run_id;
        requireRunMatch(runId, ctx, 'workItem');
        await lockRun(q, runId);
        const row = await q.query<WorkRow & { fence_high_water: unknown }>('SELECT item, fence_high_water FROM ht_work_items WHERE work_item_id = $1 FOR UPDATE', [workItemId]);
        const cur = json<WorkItem>(row.rows[0]!.item);
        const highWater = num(row.rows[0]!.fence_high_water);

        if (options.expectedFencingToken !== undefined && cur.claim?.fencingToken !== options.expectedFencingToken) {
          throw new HypertestError('stale_fence', `work item ${workItemId}: fencing token ${options.expectedFencingToken} is stale`, {
            details: { workItemId, expected: options.expectedFencingToken, current: cur.claim?.fencingToken ?? null, owner: cur.claim?.ownerId ?? null },
          });
        }
        if (options.expectedFrom !== undefined && !options.expectedFrom.includes(cur.state)) {
          throw new HypertestError('conflict', `work item ${workItemId} is ${cur.state}, expected ${options.expectedFrom.join('|')}`, {
            details: { workItemId, state: cur.state, expectedFrom: options.expectedFrom },
          });
        }
        const stateChange = to !== cur.state;
        if (!stateChange && isTerminalWorkState(cur.state)) {
          throw new HypertestError('precondition_failed', `work item ${workItemId} is ${cur.state} (terminal) and cannot be modified`, { details: { workItemId, state: cur.state } });
        }
        if (stateChange && !canTransitionWorkItem(cur.state, to)) {
          throw new HypertestError('precondition_failed', `illegal work item transition ${cur.state} → ${to}`, { details: { workItemId, from: cur.state, to } });
        }
        if (HOLDERLESS.has(to) && patch.claim !== undefined && patch.claim !== null) {
          throw new HypertestError('invalid_argument', `work item ${workItemId}: a ${to} item cannot hold a claim`, { details: { workItemId, to } });
        }

        // Monotonic fencing (I4): a new claim may never carry an older token than one already granted on this item;
        // the same token is accepted only from the lease that holds it (renewal or an idempotent retry).
        let fenceHighWater = highWater;
        if (patch.claim) {
          const token = patch.claim.fencingToken;
          const sameLease = cur.claim !== undefined && cur.claim.fencingToken === token && cur.claim.ownerId === patch.claim.ownerId && cur.claim.leaseId === patch.claim.leaseId;
          if (token < highWater || (token === highWater && highWater > 0 && !sameLease)) {
            throw new HypertestError('stale_fence', `work item ${workItemId}: claim fencing token ${token} is not newer than the highest granted token ${highWater}`, {
              details: { workItemId, token, highWater, owner: patch.claim.ownerId, currentOwner: cur.claim?.ownerId ?? null },
            });
          }
          fenceHighWater = Math.max(highWater, token);
        }

        const next = normalize({ ...applyPatch(cur, patch), state: to, updatedAt: clock.isoNow() });
        if (HOLDERLESS.has(to)) delete next.claim;
        if (to === 'claimed' && next.claim === undefined) throw new HypertestError('invalid_argument', `claiming work item ${workItemId} requires a claim (lease + fencing token)`);
        const revision = await bumpRevision(q, runId);
        await writeWorkItem(q, next, revision, fenceHighWater, false);
        if (stateChange) {
          await events.append([eventInput(ctx, workEventType(cur.state, to), 'work_item', workItemId, workPayload(next, cur.state), workItemId)], q);
        } else {
          // I10: a same-state change of ownership/progress (claim takeover, attempts, result …) is audited too.
          const changed = significantChanges(cur, next);
          if (changed.length > 0) {
            await events.append([eventInput(ctx, 'work.updated', 'work_item', workItemId, { ...workPayload(next, cur.state), changed }, workItemId)], q);
          }
        }
        return next;
      });
    },

    // ------------------------------------------------------------------------------------- plans

    async proposePlan(plan, ctx, tx) {
      requireString(plan.runId, 'plan.runId');
      requireRunMatch(plan.runId, ctx, 'plan');
      requireString(plan.planId, 'plan.planId');
      return inTx(db, tx, async (q) => {
        await lockRun(q, plan.runId);
        const max = await q.query<{ m: unknown }>('SELECT COALESCE(MAX(revision), 0) AS m FROM ht_plans WHERE run_id = $1', [plan.runId]);
        const revision = num(max.rows[0]!.m) + 1;
        const stored: PlanRevision = normalize({ ...plan, revision, status: 'proposed', validationIssues: [], createdAt: clock.isoNow() } as PlanRevision);
        await q.query('INSERT INTO ht_plans (run_id, revision, plan_id, status, plan, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)', [
          stored.runId, stored.revision, stored.planId, stored.status, jsonParam(stored), stored.createdAt,
        ]);
        await bumpRevision(q, plan.runId);
        await events.append([eventInput(ctx, 'plan.proposed', 'plan', stored.planId, planPayload(stored))], q);
        return stored;
      });
    },

    async decidePlan(runId, revision, decision, issues, ctx, tx) {
      requireRunMatch(runId, ctx, 'plan');
      if (decision !== 'accepted' && decision !== 'rejected') throw new HypertestError('invalid_argument', `unknown plan decision ${String(decision)}`);
      return inTx(db, tx, async (q) => {
        await lockRun(q, runId);
        const cur = await planById(q, runId, revision, true);
        if (!cur) throw new HypertestError('not_found', `plan revision ${revision} of run ${runId} does not exist`);
        if (cur.status === decision) return cur; // idempotent retry of the same decision
        if (cur.status !== 'proposed') {
          throw new HypertestError('precondition_failed', `plan revision ${revision} is already ${cur.status}`, { details: { runId, revision, status: cur.status, decision } });
        }
        const decidedAt = clock.isoNow();
        const superseded: number[] = [];
        if (decision === 'accepted') {
          const prev = await q.query<PlanRow>("SELECT plan FROM ht_plans WHERE run_id = $1 AND status = 'accepted' AND revision <> $2 ORDER BY revision FOR UPDATE", [runId, revision]);
          // Accepting a proposal older than the accepted plan would roll the run back to a stale plan (and mark the
          // newer plan superseded by an older one); the caller must reject it instead.
          const newer = prev.rows.map((row) => json<PlanRevision>(row.plan).revision).filter((r) => r > revision);
          if (newer.length > 0) {
            throw new HypertestError('precondition_failed', `plan revision ${revision} is older than accepted revision ${Math.max(...newer)}`, {
              details: { runId, revision, acceptedRevision: Math.max(...newer) },
            });
          }
          for (const row of prev.rows) {
            const p = json<PlanRevision>(row.plan);
            await writePlan(q, { ...p, status: 'superseded' });
            superseded.push(p.revision);
          }
        }
        const next: PlanRevision = { ...cur, status: decision, validationIssues: [...issues], decidedAt };
        await writePlan(q, next);
        await bumpRevision(q, runId);
        const payload = planPayload(next, decision === 'accepted' ? { supersededRevisions: superseded } : { issues: [...issues] });
        await events.append([eventInput(ctx, decision === 'accepted' ? 'plan.accepted' : 'plan.rejected', 'plan', next.planId, payload)], q);
        return next;
      });
    },

    async getPlan(runId, revision) {
      return planById(db, runId, revision, false);
    },

    async latestAcceptedPlan(runId) {
      const r = await db.query<PlanRow>("SELECT plan FROM ht_plans WHERE run_id = $1 AND status = 'accepted' ORDER BY revision DESC LIMIT 1", [runId]);
      return r.rows[0] ? json<PlanRevision>(r.rows[0].plan) : undefined;
    },

    async listPlans(runId) {
      const r = await db.query<PlanRow>('SELECT plan FROM ht_plans WHERE run_id = $1 ORDER BY revision', [runId]);
      return r.rows.map((row) => json<PlanRevision>(row.plan));
    },
  };
  return board;
}

export type { NewRecordInput };
