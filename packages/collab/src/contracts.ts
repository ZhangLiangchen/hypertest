import type { BaseDeps, EventBus, Logger, SqlDatabase, SqlExecutor } from '@hypertest/core';
import type {
  BlackboardPayloads, BlackboardRecord, BlackboardRecordType, DomainEvent, DomainEventInput, DomainEventSink, EventContext,
  ExperimentSpec, OracleChangeProposal, OracleSpec, PlanRevision, QualityDecision, SystemModel, TestArtifact, TestRun, WorkClaim,
  WorkItem, WorkItemState,
} from '@hypertest/domain';

/**
 * @hypertest/collab — the canonical collaboration/domain database, L0 event store, outbox/inbox and
 * event buses (bounded decentralization, I5, I10).
 *
 * Implementations to export from src/index.ts:
 *   createEventStore(deps: CollabDeps): EventStore
 *   createInbox(deps: CollabDeps): Inbox
 *   createOutboxRelay(deps: CollabDeps & { bus: EventBus; pollMs?: number; batchSize?: number }): OutboxRelay
 *   class InProcessEventBus implements EventBus   (constructor(options?: InProcessBusOptions))
 *   connectNatsEventBus(options: NatsBusOptions): Promise<EventBus>   (@nats-io/transport-node + @nats-io/jetstream)
 *   createBlackboard(deps: CollabDeps & { events: EventStore }): Blackboard
 *   createRunRepository(deps), createSpecRepository(deps), createDecisionRepository(deps)
 *   collabMigrations: Migration[]  (ht_events, ht_outbox, ht_inbox, ht_runs, ht_records, ht_work_items,
 *                                   ht_plans, ht_system_models, ht_oracles, ht_oracle_proposals,
 *                                   ht_experiments, ht_test_artifacts, ht_decisions, ht_run_counters)
 *
 * Rules:
 *  - Every state change and its events are written in ONE transaction (state row + ht_events + ht_outbox).
 *    Methods accept an optional `tx`; when absent they open their own transaction.
 *  - Event seq is per run, gap-free, assigned under a per-run row lock (ht_run_counters).
 *  - Blackboard revision is per run, monotonic, incremented by every record write and work/plan change.
 *  - Work item fingerprints are unique per run; createWorkItem returns the existing item with created=false.
 *  - transitionWorkItem enforces canTransitionWorkItem; when `expectedFencingToken` is given the stored
 *    claim token must match (stale workers are refused with stale_fence). Entering proposed/ready/blocked drops
 *    the claim; claim tokens are monotonic per item (an older or re-used token is stale_fence); a same-state
 *    change of claim/agentId/attempts/priority/result/failure/waitingOn emits `work.updated` (lease renewal does not).
 *  - Record writes emit type-specific events: finding.created|finding.updated (and finding.confirmed/
 *    finding.rejected on those statuses), hypothesis.created|hypothesis.supported|hypothesis.refuted,
 *    coverage.gap_detected, risk.identified, review.completed, record.posted (others).
 */
export interface CollabDeps extends BaseDeps {
  db: SqlDatabase;
}

export interface EventStore extends DomainEventSink {
  /** Assigns eventId (if absent), per-run seq, occurredAt; writes ht_events + ht_outbox. */
  append(events: DomainEventInput<unknown>[], tx?: SqlExecutor): Promise<DomainEvent<unknown>[]>;
  read(runId: string, options?: { afterSeq?: number; limit?: number; types?: string[] }): Promise<DomainEvent<unknown>[]>;
  get(eventId: string): Promise<DomainEvent<unknown> | undefined>;
  lastSeq(runId: string): Promise<number>;
  /** Walks causationId links back to the root (audit reconstruction). */
  causalChain(eventId: string): Promise<DomainEvent<unknown>[]>;
}

export interface Inbox {
  /** Records (consumer, eventId); returns false if already consumed (duplicate delivery). Use inside the handler's tx. */
  tryConsume(consumer: string, eventId: string, tx?: SqlExecutor): Promise<boolean>;
  consumed(consumer: string, eventId: string): Promise<boolean>;
}

export interface OutboxRelay {
  /** Publishes unsent outbox rows in order and marks them sent; returns the number published. */
  flush(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
  /** Number of outbox rows not yet marked sent (additive; used by convergence checks and tests). */
  pending(): Promise<number>;
  /**
   * (additive, durability-11) Deletes rows marked sent more than `sentRetentionMs` ago (the event store keeps every
   * event; a sent outbox row is only a delivery record). Returns the number deleted. The poll loop of start() prunes
   * once per `pruneIntervalMs`.
   */
  prune?(): Promise<number>;
}

/** Dependencies of createOutboxRelay (additive named type for the inline contract signature). */
export interface OutboxRelayDeps extends CollabDeps {
  bus: EventBus;
  /** Poll interval of start(); default 250 ms. */
  pollMs?: number;
  /** Rows per SELECT batch; default 100. */
  batchSize?: number;
  /** (additive, durability-11) How long sent rows are kept before prune() deletes them; default 1 h. */
  sentRetentionMs?: number;
  /** (additive, durability-11) How often the poll loop prunes; default 60 s. */
  pruneIntervalMs?: number;
}

export interface InProcessBusOptions {
  /**
   * Fault injection for I5 tests: probability (0..1, drawn from `random`) or explicit predicate for duplicate
   * delivery. (The number form is additive: it was documented but not typed.)
   */
  duplicateDelivery?: number | ((event: { eventId: string; eventType: string }) => boolean);
  /**
   * Additive fault injection ("delayed ack"): milliseconds by which the ack of a successfully handled delivery is
   * delayed. A delay beyond the consumer's ackWaitMs makes the bus redeliver a message whose side effect already
   * happened (deliveryCount + 1) — the consumer's inbox must absorb it. 0 or less = no delay.
   */
  delayedAck?: (event: { eventId: string; eventType: string; deliveryCount: number }) => number;
  /** Additive: random source for the probabilistic `duplicateDelivery` (default Math.random). */
  random?: () => number;
  /** Additive: how long close()/unsubscribe() wait for in-flight handlers before detaching (default 5000 ms). */
  closeGraceMs?: number;
  defaultAckWaitMs?: number;
  defaultMaxDeliver?: number;
  /** Additive: receives handler/dead-letter callback failures (default: no-op logger). */
  logger?: Logger;
}

export interface NatsBusOptions {
  servers: string | string[];
  /** JetStream stream name (created if missing) capturing subjects `ht.>`. */
  stream?: string;
  name?: string;
  /**
   * Additive: first subject token on the wire (default 'ht'). Envelope subjects `ht.<run>.<type>` are published as
   * `<subjectPrefix>.<run>.<type>` and subscription filters are rewritten the same way; delivered envelopes keep
   * their canonical `ht.` subject. Lets several independent streams (e.g. parallel test runs) share one server.
   */
  subjectPrefix?: string;
  /** Additive: messages buffered per subscription (pull batch size); default 16. */
  prefetch?: number;
  /** Additive: connection/handler diagnostics (default: no-op logger). */
  logger?: Logger;
}

export interface NewRecordInput<K extends BlackboardRecordType> {
  runId: string;
  recordType: K;
  payload: BlackboardPayloads[K];
  createdBy: string;
  workItemId?: string;
  evidenceRefs?: string[];
  /** recordId being superseded (same lineage, version+1). Must be the current head of the lineage. */
  supersedes?: string;
}

export interface RecordQuery {
  runId: string;
  recordType?: BlackboardRecordType | BlackboardRecordType[];
  /** Filter on payload.status when present. */
  status?: string[];
  workItemId?: string;
  afterRevision?: number;
  /** Default false: only lineage heads. */
  includeSuperseded?: boolean;
  limit?: number;
}

export interface NewWorkItem extends Omit<WorkItem, 'workItemId' | 'state' | 'attempts' | 'waitingOn' | 'createdAt' | 'updatedAt' | 'claim' | 'agentId' | 'result' | 'failure'> {
  workItemId?: string;
  state?: 'proposed' | 'ready' | 'blocked';
}

export interface WorkItemPatch {
  claim?: WorkClaim | null;
  agentId?: string;
  result?: WorkItem['result'];
  failure?: WorkItem['failure'];
  waitingOn?: string[];
  attempts?: number;
  priority?: number;
}

export interface Blackboard {
  revision(runId: string): Promise<number>;

  postRecord<K extends BlackboardRecordType>(input: NewRecordInput<K>, ctx: EventContext, tx?: SqlExecutor): Promise<BlackboardRecord<BlackboardPayloads[K]>>;
  getRecord<T = unknown>(recordId: string): Promise<BlackboardRecord<T> | undefined>;
  /** Current head of a lineage. */
  head<T = unknown>(lineageId: string): Promise<BlackboardRecord<T> | undefined>;
  query<T = unknown>(query: RecordQuery): Promise<BlackboardRecord<T>[]>;

  createWorkItem(input: NewWorkItem, ctx: EventContext, tx?: SqlExecutor): Promise<{ workItem: WorkItem; created: boolean }>;
  getWorkItem(workItemId: string): Promise<WorkItem | undefined>;
  listWorkItems(filter: { runId: string; states?: WorkItemState[]; roles?: string[]; planRevision?: number }): Promise<WorkItem[]>;
  transitionWorkItem(
    workItemId: string,
    to: WorkItemState,
    patch: WorkItemPatch,
    ctx: EventContext,
    options?: { expectedFencingToken?: number; expectedFrom?: WorkItemState[]; tx?: SqlExecutor },
  ): Promise<WorkItem>;

  proposePlan(plan: Omit<PlanRevision, 'revision' | 'status' | 'createdAt' | 'validationIssues' | 'decidedAt'>, ctx: EventContext, tx?: SqlExecutor): Promise<PlanRevision>;
  decidePlan(runId: string, revision: number, decision: 'accepted' | 'rejected', issues: string[], ctx: EventContext, tx?: SqlExecutor): Promise<PlanRevision>;
  getPlan(runId: string, revision: number): Promise<PlanRevision | undefined>;
  latestAcceptedPlan(runId: string): Promise<PlanRevision | undefined>;
  listPlans(runId: string): Promise<PlanRevision[]>;
}

export interface RunRepository {
  create(run: TestRun, ctx: EventContext, tx?: SqlExecutor): Promise<TestRun>;
  get(runId: string): Promise<TestRun | undefined>;
  /** Enforces canTransitionRun when status changes; emits run.* events. */
  update(runId: string, patch: Partial<Omit<TestRun, 'runId' | 'createdAt'>>, ctx: EventContext, tx?: SqlExecutor): Promise<TestRun>;
  list(filter?: { status?: TestRun['status'][]; limit?: number }): Promise<TestRun[]>;
}

/** Revisioned, append-only specs. Every save of an existing id creates revision+1 that supersedes the previous. */
export interface SpecRepository {
  saveSystemModel(model: Omit<SystemModel, 'revision' | 'createdAt' | 'supersedes'>, ctx: EventContext, tx?: SqlExecutor): Promise<SystemModel>;
  latestSystemModel(runId: string): Promise<SystemModel | undefined>;

  saveOracle(spec: Omit<OracleSpec, 'revision' | 'createdAt' | 'supersedes'> & { revision?: number }, ctx: EventContext, tx?: SqlExecutor): Promise<OracleSpec>;
  getOracle(oracleId: string, revision?: number): Promise<OracleSpec | undefined>;
  listOracles(filter?: { status?: OracleSpec['status'][] }): Promise<OracleSpec[]>;
  saveOracleProposal(p: OracleChangeProposal, ctx: EventContext, tx?: SqlExecutor): Promise<OracleChangeProposal>;
  getOracleProposal(proposalId: string): Promise<OracleChangeProposal | undefined>;
  listOracleProposals(filter: { runId?: string; status?: OracleChangeProposal['status'][] }): Promise<OracleChangeProposal[]>;

  saveExperiment(spec: Omit<ExperimentSpec, 'revision' | 'createdAt' | 'supersedes'>, ctx: EventContext, tx?: SqlExecutor): Promise<ExperimentSpec>;
  getExperiment(experimentId: string, revision?: number): Promise<ExperimentSpec | undefined>;
  listExperiments(runId: string): Promise<ExperimentSpec[]>;

  saveTestArtifact(a: Omit<TestArtifact, 'revision' | 'createdAt'> & { revision?: number }, ctx: EventContext, tx?: SqlExecutor): Promise<TestArtifact>;
  getTestArtifact(artifactId: string, revision?: number): Promise<TestArtifact | undefined>;
  listTestArtifacts(runId: string): Promise<TestArtifact[]>;
}

export interface DecisionRepository {
  /** Append-only; a re-decision supersedes. */
  save(decision: QualityDecision, ctx: EventContext, tx?: SqlExecutor): Promise<QualityDecision>;
  get(decisionId: string): Promise<QualityDecision | undefined>;
  latestForRun(runId: string): Promise<QualityDecision | undefined>;
  /** Decisions that used a given oracle revision (for needs_reassessment after an oracle is invalidated). */
  findByOracleRevision(oracleId: string, revision: number): Promise<QualityDecision[]>;
  markNeedsReassessment(decisionId: string, reason: string, ctx: EventContext): Promise<void>;
  /** Additive: the reassessment flag set by markNeedsReassessment (undefined for an unknown decision). */
  reassessment(decisionId: string): Promise<{ needsReassessment: boolean; reason?: string } | undefined>;
}
