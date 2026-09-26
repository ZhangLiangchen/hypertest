import type { JsonValue } from '@hypertest/core';

/**
 * Immutable domain event (L0). Written to the event store and the outbox in the same transaction as
 * the state change it describes. `seq` is assigned per run by the event store.
 */
export interface DomainEvent<T = JsonValue> {
  eventId: string;
  eventType: EventType | (string & {});
  aggregateType: AggregateType;
  aggregateId: string;
  runId: string;
  seq?: number;
  correlationId: string;
  causationId?: string;
  actorId: string;
  workItemId?: string;
  agentId?: string;
  schemaVersion: string;
  payload: T;
  occurredAt: string;
}

export type AggregateType =
  | 'run'
  | 'plan'
  | 'work_item'
  | 'agent'
  | 'session'
  | 'record'
  | 'evidence'
  | 'operation'
  | 'oracle'
  | 'experiment'
  | 'test_artifact'
  | 'system_model'
  | 'decision'
  | 'policy'
  | 'model'
  | 'tool'
  | 'context'
  | 'budget'
  | 'approval'
  | 'experience';

/** Event catalog. Payload shapes are documented next to each producer; names are stable API. */
export const EVENT_TYPES = {
  runCreated: 'run.created',
  runStarted: 'run.started',
  runPaused: 'run.paused',
  runResumed: 'run.resumed',
  /**
   * (additive) A process recovered the run after a restart (control recover()): payload `{ workerId, operations:
   * {examined, verified, notApplied, manualReview, stillPending, compensated}, requeued: [{workItemId, role, from,
   * attempts}], reattached: [{workItemId, role, waitingOn, fencingToken, claim: 'kept' | 'retaken'}] }` — what was
   * reconciled, what re-runs and what keeps waiting on its (re-attached, never re-created) operations. Emitted only when
   * the pass recovered something.
   */
  runRecovered: 'run.recovered',
  runConverging: 'run.converging',
  runGating: 'run.gating',
  runUpdated: 'run.updated',
  runCompleted: 'run.completed',
  runFailed: 'run.failed',
  runCancelled: 'run.cancelled',

  planProposed: 'plan.proposed',
  planAccepted: 'plan.accepted',
  planRejected: 'plan.rejected',
  planDrained: 'plan.drained',

  workCreated: 'work.created',
  workReady: 'work.ready',
  workClaimed: 'work.claimed',
  workStarted: 'work.started',
  workWaiting: 'work.waiting',
  workCompleted: 'work.completed',
  workFailed: 'work.failed',
  workCancelled: 'work.cancelled',
  workRequeued: 'work.requeued',
  workBlocked: 'work.blocked',
  workUpdated: 'work.updated',

  agentSpawned: 'agent.spawned',
  agentTurnStarted: 'agent.turn_started',
  agentTurnCompleted: 'agent.turn_completed',
  agentInterrupted: 'agent.interrupted',
  agentDisposed: 'agent.disposed',
  agentSettled: 'agent.settled',
  agentResumed: 'agent.resumed',

  modelRouted: 'model.routed',
  modelEpochStarted: 'model.epoch_started',
  modelInvoked: 'model.invoked',
  modelFallback: 'model.fallback',

  toolCalled: 'tool.called',
  toolCompleted: 'tool.completed',
  toolDenied: 'tool.denied',

  policyDecided: 'policy.decided',
  approvalRequested: 'approval.requested',
  approvalGranted: 'approval.granted',
  approvalDenied: 'approval.denied',

  findingCreated: 'finding.created',
  findingUpdated: 'finding.updated',
  findingConfirmed: 'finding.confirmed',
  findingRejected: 'finding.rejected',
  hypothesisCreated: 'hypothesis.created',
  hypothesisSupported: 'hypothesis.supported',
  hypothesisRefuted: 'hypothesis.refuted',
  coverageGapDetected: 'coverage.gap_detected',
  riskIdentified: 'risk.identified',
  reviewRequested: 'review.requested',
  reviewCompleted: 'review.completed',
  recordPosted: 'record.posted',

  testFailed: 'test.failed',
  testPassed: 'test.passed',
  testRecovered: 'test.recovered',
  testArtifactRegistered: 'test_artifact.registered',
  testArtifactValidated: 'test_artifact.validated',

  evidenceAttached: 'evidence.attached',
  evidenceSealed: 'evidence.sealed',

  operationPrepared: 'operation.prepared',
  operationDispatched: 'operation.dispatched',
  operationVerified: 'operation.verified',
  operationOutcomeUnknown: 'operation.outcome_unknown',
  operationReconciled: 'operation.reconciled',
  operationManualReview: 'operation.manual_review',
  operationLateReceipt: 'operation.late_receipt',

  oracleChangeProposed: 'oracle.change_proposed',
  oracleChangeApproved: 'oracle.change_approved',
  oracleChangeRejected: 'oracle.change_rejected',
  oracleRevised: 'oracle.revised',
  experimentDefined: 'experiment.defined',
  systemModelRecorded: 'system_model.recorded',

  contextSnapshotCreated: 'context.snapshot_created',
  contextCompacted: 'context.compacted',
  contextStaleRejected: 'context.stale_rejected',

  budgetReserved: 'budget.reserved',
  budgetExhausted: 'budget.exhausted',

  /**
   * (additive, durability-2) Resource admission of a work item (ResourceClaims): `granted` `{ workItemId, claims }` when
   * the scheduler admits it; `refused` `{ workItemId, conflicts: ["<resourceKey>@<holder>"] }` when a conflicting holder
   * blocks it (once per distinct conflict set); `lapsed` `{ workItemId, conflicts, phase }` when a held item's claims could
   * not be renewed (another holder took them) — the item stops (its turn is refused / its claim yielded).
   */
  admissionGranted: 'admission.granted',
  admissionRefused: 'admission.refused',
  admissionLapsed: 'admission.lapsed',

  gateEvaluated: 'gate.evaluated',
  gatePassed: 'gate.passed',
  gateFailed: 'gate.failed',
  decisionRecorded: 'decision.recorded',
  experienceProposed: 'experience.proposed',
  experienceReviewed: 'experience.reviewed',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export const EVENT_SCHEMA_VERSION = '1';

/** Event to emit; the sink assigns eventId (unless given), seq, occurredAt and schemaVersion. */
export type DomainEventInput<T = JsonValue> = Omit<DomainEvent<T>, 'eventId' | 'seq' | 'occurredAt' | 'schemaVersion'> & {
  eventId?: string;
  occurredAt?: string;
};

/** Correlation context threaded through every call that may emit events (I10). */
export interface EventContext {
  runId: string;
  correlationId: string;
  causationId?: string;
  actorId: string;
  workItemId?: string;
  agentId?: string;
}

/**
 * Port for emitting domain events. @hypertest/collab implements it with the L0 event store + outbox
 * (same transaction when `tx` is given). Lower-level packages depend only on this port.
 */
export interface DomainEventSink {
  emit(events: DomainEventInput<unknown>[], tx?: unknown): Promise<DomainEvent<unknown>[]>;
}

/** Convenience: build an event input from a context. */
export function eventFrom<T>(ctx: EventContext, eventType: EventType | (string & {}), aggregateType: AggregateType, aggregateId: string, payload: T): DomainEventInput<T> {
  const e: DomainEventInput<T> = { eventType, aggregateType, aggregateId, runId: ctx.runId, correlationId: ctx.correlationId, actorId: ctx.actorId, payload };
  if (ctx.causationId !== undefined) e.causationId = ctx.causationId;
  if (ctx.workItemId !== undefined) e.workItemId = ctx.workItemId;
  if (ctx.agentId !== undefined) e.agentId = ctx.agentId;
  return e;
}

/** In-memory sink for unit tests and for components running without a database. */
export class InMemoryEventSink implements DomainEventSink {
  readonly events: DomainEvent<unknown>[] = [];
  #seq = new Map<string, number>();
  #n = 0;
  async emit(events: DomainEventInput<unknown>[]): Promise<DomainEvent<unknown>[]> {
    const out: DomainEvent<unknown>[] = [];
    for (const e of events) {
      const seq = (this.#seq.get(e.runId) ?? 0) + 1;
      this.#seq.set(e.runId, seq);
      const full: DomainEvent<unknown> = {
        ...e,
        eventId: e.eventId ?? `evt_mem${String(++this.#n).padStart(8, '0')}`,
        seq,
        schemaVersion: EVENT_SCHEMA_VERSION,
        occurredAt: e.occurredAt ?? new Date().toISOString(),
      };
      this.events.push(full);
      out.push(full);
    }
    return out;
  }
  ofType(eventType: string): DomainEvent<unknown>[] {
    return this.events.filter((e) => e.eventType === eventType);
  }
}
