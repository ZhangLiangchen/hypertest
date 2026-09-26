import type { DeliveredEvent, SqlExecutor } from '@hypertest/core';
import { workItemFingerprint, type BlackboardRecord, type DomainEvent, type Ref, type WorkItem } from '@hypertest/domain';
import type { NewWorkItem } from '@hypertest/collab';
import { matchesSubscription, renderSubscriptionWork, type RoleSubscription, type SubscriptionSubject } from '@hypertest/agents';
import type { AgentRole } from '@hypertest/domain';
import type { ControlDeps } from './deps.ts';
import { ControlStore } from './store.ts';
import { WorkFactory } from './work-factory.ts';
import { isTerminalRunStatus, workBudgetFor } from './util.ts';

/** Inbox consumer name of the reactors (dedupe key space for at-least-once delivery, I5). */
export const REACTOR_CONSUMER = 'reactors';
/** Durable bus consumer and subject filter used when an event bus is configured. */
export const REACTOR_SUBJECTS = ['ht.*.>'];
const BATCH = 200;

export interface CatchUpResult {
  /** Events of subscribed types examined (consumed or recognised as duplicates). */
  processed: number;
  /** Work items created by reactions. */
  created: string[];
  /** Cursor position after the catch-up. */
  lastSeq: number;
}

export interface ReactorService {
  /** Consumes the run's L0 events after the `reactors` cursor in seq order (inbox-deduped, one transaction per event). */
  catchUp(runId: string): Promise<CatchUpResult>;
  /** Bus handler: same reaction with inbox dedupe, so duplicate deliveries are harmless. */
  handleDelivered(event: DeliveredEvent): Promise<void>;
  /** Unconsumed events of subscribed types after the cursor. */
  pending(runId: string): Promise<number>;
  /** Event types any role subscribes to. */
  subscribedEventTypes(): string[];
}

type Payload = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Template variables of a record (the event payload is small; the record carries the full text). */
function recordVars(rec: BlackboardRecord<unknown> | undefined): Record<string, string> {
  if (!rec) return {};
  const p = (rec.payload ?? {}) as Payload;
  const out: Record<string, string> = { recordId: rec.recordId, lineageId: rec.lineageId };
  const set = (k: string, v: unknown) => {
    const s = str(v);
    if (s !== undefined) out[k] = s;
  };
  switch (rec.recordType) {
    case 'finding':
      set('title', p['title']);
      set('severity', p['severity']);
      set('summary', p['description']);
      set('component', p['component']);
      break;
    case 'coverage_gap':
      set('title', p['area']);
      set('summary', p['description']);
      break;
    case 'risk':
      set('title', p['title']);
      set('severity', p['level']);
      set('summary', p['description']);
      if (Array.isArray(p['componentRefs'])) set('component', (p['componentRefs'] as unknown[]).filter((x) => typeof x === 'string').join(', '));
      break;
    case 'hypothesis':
      set('title', typeof p['statement'] === 'string' ? (p['statement'] as string).slice(0, 200) : undefined);
      set('summary', p['statement']);
      break;
    case 'review':
      set('title', `${String(p['verdict'] ?? 'review')} of ${String((p['subjectRef'] as Payload | undefined)?.['id'] ?? 'subject')}`);
      set('summary', p['rationale']);
      break;
    case 'note':
      set('summary', p['text']);
      break;
    default:
      set('title', p['topic'] ?? p['title']);
      set('summary', p['rationale'] ?? p['description']);
  }
  return out;
}

export function createReactorService(deps: ControlDeps): ReactorService {
  const { db, events, inbox, blackboard, runs, roles, agents, logger } = deps;
  const store = new ControlStore(db);
  const factory = new WorkFactory(deps);
  const types = (): Set<string> => new Set(roles.subscriptions().flatMap((s) => s.eventTypes));

  async function actorRole(e: DomainEvent<unknown>): Promise<string | undefined> {
    if (e.agentId) {
      const a = await agents.get(e.agentId);
      if (a) return a.role;
    }
    if (e.workItemId) {
      const w = await blackboard.getWorkItem(e.workItemId);
      if (w) return w.role;
    }
    return undefined;
  }

  /** Creates the work items the event's subscriptions ask for (inside the caller's transaction). */
  async function react(e: DomainEvent<unknown>, tx: SqlExecutor): Promise<string[]> {
    const subs = roles.subscriptions().filter((s) => s.eventTypes.includes(e.eventType));
    if (subs.length === 0) return [];
    const payload = (e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload) ? e.payload : {}) as Payload;
    const subject: SubscriptionSubject = { eventType: e.eventType };
    const severity = str(payload['severity']) ?? str(payload['level']);
    if (severity !== undefined) subject.severity = severity;
    for (const k of ['category', 'status', 'recordType'] as const) {
      const v = str(payload[k]);
      if (v !== undefined) subject[k] = v;
    }
    const role = await actorRole(e);
    if (role !== undefined) subject.actorRole = role;
    const matched = subs.filter((s) => matchesSubscription(s, subject));
    if (matched.length === 0) return [];
    // a late delivery (bus lag, a stale agent) never adds work to a run that has ended
    const run = await runs.get(e.runId);
    if (!run || isTerminalRunStatus(run.status)) {
      logger.info('reaction skipped: the run has ended', { runId: e.runId, eventId: e.eventId, status: run?.status ?? 'missing' });
      return [];
    }
    // serialize with every other work creation of the run: the per-rule counts below are exact (I12)
    await factory.lock(e.runId, tx);

    // review.requested names its subject; record events name their record.
    const subjectRef = payload['subjectRef'] as Payload | undefined;
    const recordId = str(payload['recordId']) ?? (e.eventType === 'review.requested' ? str(subjectRef?.['id']) : undefined);
    let record: BlackboardRecord<unknown> | undefined;
    if (recordId !== undefined) {
      const r = await blackboard.getRecord(recordId);
      if (r && r.runId === e.runId) record = r;
    }
    const vars: Record<string, string> = {};
    for (const k of ['title', 'severity', 'summary', 'component', 'lineageId'] as const) {
      const v = str(payload[k]);
      if (v !== undefined) vars[k] = v;
    }
    if (recordId !== undefined) vars['recordId'] = recordId;
    Object.assign(vars, recordVars(record));
    if (vars['severity'] === undefined && severity !== undefined) vars['severity'] = severity;
    const lineageId = record?.lineageId ?? str(payload['lineageId']);

    // causal depth: the item whose agent produced the event (I12 livelock guard)
    let source: WorkItem | undefined;
    if (e.workItemId) source = await blackboard.getWorkItem(e.workItemId);
    const depth = (source?.depth ?? 0) + 1;
    const existing = await blackboard.listWorkItems({ runId: e.runId });
    const ctx = { runId: e.runId, correlationId: e.correlationId, causationId: e.eventId, actorId: 'system:reactors' };
    const created: string[] = [];
    for (const sub of matched as Array<RoleSubscription & { role: AgentRole }>) {
      const perRun = existing.filter((w) => w.origin.kind === 'reactor' && w.origin.rule === sub.ruleId).length;
      if (perRun >= sub.maxPerRun) {
        logger.info('reactor rule at its per-run cap; no work created', { ruleId: sub.ruleId, runId: e.runId, eventId: e.eventId, maxPerRun: sub.maxPerRun });
        continue;
      }
      if (depth > sub.maxCausalDepth) {
        logger.info('reactor rule beyond its causal depth; no work created', { ruleId: sub.ruleId, runId: e.runId, eventId: e.eventId, depth, maxCausalDepth: sub.maxCausalDepth });
        continue;
      }
      const roleDef = roles.require(sub.role);
      const rendered = renderSubscriptionWork(sub, vars);
      const inputRefs: Ref[] = recordId !== undefined ? [{ kind: 'record', id: recordId }] : [];
      const item: NewWorkItem = {
        runId: e.runId,
        kind: 'reaction',
        origin: { kind: 'reactor', rule: sub.ruleId, eventId: e.eventId },
        title: rendered.title,
        objective: rendered.objective,
        role: sub.role,
        objectiveIds: [],
        capabilityRequirements: [],
        inputRefs,
        evidenceRequirements: [],
        dependsOn: [],
        budget: workBudgetFor(roleDef, rendered.budget),
        priority: rendered.priority,
        depth,
        fingerprint: workItemFingerprint({ runId: e.runId, role: sub.role, objective: rendered.objective, originKey: `${sub.ruleId}:${lineageId ?? e.aggregateId}`, inputRefs }),
        resourceClaims: [],
        causationEventId: e.eventId,
        state: 'ready',
      };
      const expectedOutput = rendered.expectedOutput ?? roleDef.outputSchema;
      if (expectedOutput !== undefined) item.expectedOutput = expectedOutput;
      if (source) item.parentWorkItemId = source.workItemId;
      const r = await factory.create(item, ctx, tx);
      if (r.status === 'capped') break;
      if (r.status === 'created') {
        created.push(r.workItem.workItemId);
        existing.push(r.workItem);
      }
    }
    return created;
  }

  return {
    subscribedEventTypes: () => [...types()].sort(),

    async catchUp(runId) {
      const subscribed = types();
      let cursor = await store.cursor(runId, REACTOR_CONSUMER);
      const created: string[] = [];
      let processed = 0;
      for (;;) {
        const batch = await events.read(runId, { afterSeq: cursor, limit: BATCH });
        if (batch.length === 0) break;
        for (const e of batch) {
          const seq = e.seq ?? cursor;
          if (subscribed.has(e.eventType)) {
            const made = await db.transaction(async (tx) => {
              const fresh = await inbox.tryConsume(REACTOR_CONSUMER, e.eventId, tx);
              const out = fresh ? await react(e, tx) : [];
              await store.advanceCursor(runId, REACTOR_CONSUMER, seq, tx);
              return out;
            });
            created.push(...made);
            processed++;
          }
          cursor = seq;
        }
        await store.advanceCursor(runId, REACTOR_CONSUMER, cursor);
        if (batch.length < BATCH) break;
      }
      return { processed, created, lastSeq: cursor };
    },

    async handleDelivered(delivered) {
      const e = delivered.data as DomainEvent<unknown> | undefined;
      if (!e || typeof e !== 'object' || typeof e.eventId !== 'string' || typeof e.runId !== 'string') {
        logger.warn('reactor ignored a malformed bus envelope', { eventId: delivered.eventId, subject: delivered.subject });
        return;
      }
      if (!types().has(e.eventType)) return;
      await db.transaction(async (tx) => {
        if (await inbox.tryConsume(REACTOR_CONSUMER, e.eventId, tx)) await react(e, tx);
      });
    },

    async pending(runId) {
      const cursor = await store.cursor(runId, REACTOR_CONSUMER);
      const subscribed = [...types()];
      if (subscribed.length === 0) return 0;
      const rest = await events.read(runId, { afterSeq: cursor, types: subscribed });
      return rest.length;
    },
  };
}
