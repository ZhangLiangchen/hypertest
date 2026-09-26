import type { BaseDeps, SqlDatabase, SqlExecutor } from '@hypertest/core';
import type { DomainEventSink, EventContext, OperationRecord, OperationStatus, ResourceClaim, ResourceLease, ResourceRef, RiskClass } from '@hypertest/domain';

/**
 * @hypertest/operation — side-effect recovery, idempotency and reconciliation (I4), experiment
 * isolation and budgets (I12).
 *
 * Implementations to export from src/index.ts:
 *   createOperationLedger(deps: OperationDeps): OperationLedger
 *   createLeaseService(deps: OperationDeps): LeaseService
 *   createSideEffectGateway(deps: GatewayDeps): SideEffectGateway
 *   createReconciler(deps: GatewayDeps): Reconciler
 *   createResourceAdmission(deps: OperationDeps): ResourceAdmission
 *   createBudgetLedger(deps: OperationDeps): BudgetLedger
 *   class AdapterRegistry  (register(adapter), get(adapterId) — throws not_found)
 *   operationMigrations: Migration[]  (ht_operations, ht_leases, ht_fences, ht_resource_claims,
 *                                      ht_budget_scopes, ht_budget_reservations)
 *
 * Gateway retry switch (improvements doc §副作用恢复):
 *   verified            → return recorded result, never re-dispatch
 *   prepared/not_applied → validate lease+fence, then dispatch
 *   dispatching/acknowledged/outcome_unknown/reconciling → reconcile via adapter.observe():
 *        present+matches  → acknowledged/verified (attach; never create a second resource)
 *        absent           → not_applied → safe re-dispatch (unless reconciliationClass is non_reconcilable
 *                           and risk ≥ high ⇒ manual_review)
 *        uncertain        → manual_review (never blind retry of destructive actions)
 *   A timeout/crash between dispatch and receipt records `outcome_unknown`, never `failed`.
 *   Stale fencing token ⇒ outcome `stale_fence`, no dispatch.
 *   Outcome mapping for states without their own outcome status: `compensated` ⇒ `not_applied` with
 *   reason `compensated`; `compensating` ⇒ `pending`; `prepared` (observe only) ⇒ `not_applied`
 *   with reason `not_dispatched`. The authoritative status is always `outcome.operation.status`.
 *   A dispatch receipt that arrives after another actor moved the operation is never dropped: it is
 *   attached while that reconciliation is still open, recorded terminally after `not_applied`, and
 *   otherwise surfaced as outcome `manual_review` plus an `operation.late_receipt` audit event.
 */
export interface OperationDeps extends BaseDeps {
  db: SqlDatabase;
  events?: DomainEventSink;
}

export interface PrepareOperationInput {
  /**
   * Pre-generated operation id (additive). The SideEffectGateway generates the id before calling
   * adapter.prepare() so labels/names derived from it match the persisted record. Defaults to a new id.
   */
  operationId?: string;
  runId: string;
  workItemId: string;
  agentId?: string;
  toolInvocationId?: string;
  operationType: string;
  adapterId: string;
  target: ResourceRef;
  desiredStateHash: string;
  inputHash: string;
  /** Defaults to the generated operationId. Supplying an existing key returns the existing record (idempotent). */
  idempotencyKey?: string;
  lease?: { leaseId: string; resourceKey: string; fencingToken: number };
  /**
   * (additive, conformance-6) The experiment the operation runs for (the work item declared it). Stored with the
   * operation (`ht_operations.experiment_id`) and returned as `LedgerOperationRecord.experimentId`, so a gate can tell
   * which external effects belong to which experiment. Recorded once: a deduplicated prepare keeps the first value.
   */
  experimentId?: string;
}

/**
 * (additive, conformance-6) An OperationRecord as the ledger returns it: `experimentId` is set when the operation was
 * prepared for an experiment. (The domain OperationRecord has no such field yet; see `operationExperimentId`.)
 */
export type LedgerOperationRecord = OperationRecord & { experimentId?: string };

export interface OperationLedger {
  /**
   * Idempotent: same idempotencyKey (or same toolInvocationId+operationType) returns the existing record.
   * Reusing either for a different run, operationType, adapterId or inputHash is a `conflict`.
   */
  prepare(input: PrepareOperationInput, ctx: EventContext, tx?: SqlExecutor): Promise<OperationRecord>;
  get(operationId: string): Promise<OperationRecord | undefined>;
  findByIdempotencyKey(key: string): Promise<OperationRecord | undefined>;
  /** With `operationType` (additive, optional) the lookup is exact; without it the oldest matching record is returned. */
  findByToolInvocation(toolInvocationId: string, operationType?: string): Promise<OperationRecord | undefined>;
  /**
   * Enforces canTransitionOperation; optimistic concurrency on `expectedFrom` (and, additively, on
   * `expectedAttempt`, which rules out ABA across a re-dispatch cycle). Increments attempt on → dispatching.
   * `evidenceRefs` in the patch are appended (never removed). `externalJobId`/`externalReceipt` describe the
   * current attempt: → dispatching clears them unless the patch supplies them (history stays in the events).
   */
  transition(
    operationId: string,
    to: OperationStatus,
    patch: Partial<Pick<OperationRecord, 'externalJobId' | 'externalReceipt' | 'result' | 'lastError' | 'evidenceRefs' | 'lease'>>,
    ctx: EventContext,
    options?: { expectedFrom?: OperationStatus[]; expectedAttempt?: number; tx?: SqlExecutor },
  ): Promise<OperationRecord>;
  /** (additive) `experimentId`: only the operations prepared for that experiment. */
  list(filter: { runId: string; workItemId?: string; status?: OperationStatus[]; experimentId?: string }): Promise<OperationRecord[]>;
  /** Operations that need reconciliation: dispatching, acknowledged, outcome_unknown, reconciling. */
  listUnsettled(runId?: string): Promise<OperationRecord[]>;
}

export interface LeaseService {
  /** Grants a lease if the resource is free or the previous lease expired; each grant increments the fencing token. */
  acquire(request: { resourceKey: string; owner: string; ttlMs: number }): Promise<ResourceLease | undefined>;
  renew(leaseId: string, ttlMs: number): Promise<ResourceLease>;
  release(leaseId: string): Promise<void>;
  current(resourceKey: string): Promise<ResourceLease | undefined>;
  /**
   * Target-side fence check (used by the SideEffectGateway before dispatch and by fenced targets):
   * accepts iff token ≥ highest accepted token for the resource AND token equals the live lease's token;
   * records the accepted token. Stale tokens return false.
   */
  checkFence(resourceKey: string, fencingToken: number): Promise<boolean>;
}

export interface SideEffectCapabilities {
  supportsNativeIdempotency: boolean;
  supportsExternalLookupByOperationId: boolean;
  supportsFencing: boolean;
  supportsCompensation: boolean;
  reconciliationClass: 'deterministic' | 'best_effort' | 'non_reconcilable';
  riskClass: RiskClass;
}

export interface OperationContext {
  operation: OperationRecord;
  fencingToken?: number;
  signal: AbortSignal;
}

export interface PreparedOperation {
  desiredState: unknown;
  desiredStateHash: string;
  target: ResourceRef;
}

export interface DispatchReceipt {
  accepted: boolean;
  externalJobId?: string;
  receipt?: string;
  /** When accepted=false: the target definitely did not apply the operation. */
  notAppliedReason?: string;
}

export type ObservationResult<O> = { state: 'present'; observation: O } | { state: 'absent' } | { state: 'uncertain'; detail: string };

export type VerificationResult = { status: 'verified'; result: unknown } | { status: 'pending'; progress?: unknown } | { status: 'failed'; reason: string };

export interface CompensationResult {
  compensated: boolean;
  detail?: string;
}

/**
 * Protocol every external/destructive tool adapter implements. observe() MUST locate the external
 * effect by operationId (label, name, client id) when supportsExternalLookupByOperationId.
 */
export interface SideEffectAdapter<I = unknown, O = unknown> {
  readonly adapterId: string;
  readonly capabilities: SideEffectCapabilities;
  prepare(op: OperationContext, input: I): Promise<PreparedOperation>;
  dispatch(prepared: PreparedOperation, op: OperationContext): Promise<DispatchReceipt>;
  observe(op: OperationContext): Promise<ObservationResult<O>>;
  verify(observation: O, desiredStateHash: string, op: OperationContext): Promise<VerificationResult>;
  compensate?(op: OperationContext): Promise<CompensationResult>;
}

export type SideEffectOutcome =
  | { status: 'verified'; operation: OperationRecord; result: unknown }
  | { status: 'pending'; operation: OperationRecord; progress?: unknown }
  | { status: 'not_applied' | 'failed' | 'manual_review' | 'stale_fence'; operation: OperationRecord; reason: string };

export interface GatewayDeps extends OperationDeps {
  ledger: OperationLedger;
  leases: LeaseService;
  adapters: AdapterRegistryLike;
  /** Delay between observe polls while waiting `verifyWithinMs` (additive; default 250). */
  pollIntervalMs?: number;
  /** Default dispatch timeout when the request gives none (additive; default: none, only the abort signal). */
  dispatchTimeoutMs?: number;
  /**
   * (additive) TTL an observation extends a lease to while its operation's effect exists but is unsettled
   * (acknowledged / outcome_unknown / reconciling); default 60 000. Never shortens a lease.
   */
  leaseRenewTtlMs?: number;
}

export interface AdapterRegistryLike {
  get(adapterId: string): SideEffectAdapter;
  has(adapterId: string): boolean;
}

export interface RunSideEffectRequest<I = unknown> {
  runId: string;
  workItemId: string;
  agentId?: string;
  /** Stable across retries (session:turn:toolCallId); the operation is found again by it. */
  toolInvocationId: string;
  operationType: string;
  adapterId: string;
  input: I;
  target: ResourceRef;
  /** Acquire (or reuse) a write lease on this resource with fencing. */
  lease?: { resourceKey: string; ttlMs: number; owner: string };
  ctx: EventContext;
  signal: AbortSignal;
  /** Max time to wait for verification before returning `pending`. */
  verifyWithinMs?: number;
  /**
   * Dispatch timeout (additive). A timed-out dispatch is recorded as `outcome_unknown`, never `failed`.
   * Defaults to GatewayDeps.dispatchTimeoutMs.
   */
  dispatchTimeoutMs?: number;
  /**
   * (additive) true: only settle this invocation's EXISTING operation — return its recorded outcome, attach to or
   * reconcile its dispatch — and never dispatch: an operation that is (or reconciles to) `prepared`/`not_applied`
   * returns `not_applied` (reason `dispatch_refused: …`) without an adapter dispatch. No operation at all is a
   * `not_found` error (nothing is recorded). Used for the replay of a call decided on a snapshot that is stale by now:
   * its act already happened (or may have), but a new dispatch would be a new decision.
   */
  reconcileOnly?: boolean;
  /** (additive, conformance-6) The experiment the call runs for; recorded on a NEW operation (PrepareOperationInput.experimentId). */
  experimentId?: string;
}

/**
 * Leases (I4, additive semantics): run() acquires or renews the request's lease; the drive keeps it alive while it
 * polls; once the operation settles (verified / not_applied / failed / manual_review / compensated) the lease is
 * RELEASED (never while another in-process drive uses it), so the next owner is not refused as busy until the TTL.
 * observe() extends the live lease of an operation whose effect exists but is unsettled, and releases it when the
 * observation settles the operation. A busy refusal of a never-dispatched operation records it `not_applied`
 * (lastError `resource_busy: …`; the outcome stays `failed`/`resource_busy`).
 */
export interface SideEffectGateway {
  run<I>(request: RunSideEffectRequest<I>): Promise<SideEffectOutcome>;
  /**
   * (additive, optional) The operation recorded for a tool invocation of this run (undefined when none): lets a caller
   * tell the replay of an already dispatched call from a new call before it decides anything.
   */
  find?(toolInvocationId: string, operationType: string, runId: string): Promise<OperationRecord | undefined>;
  /** Poll a pending/unsettled operation (observe → verify); used by durable waits. */
  observe(operationId: string, ctx: EventContext, signal: AbortSignal): Promise<SideEffectOutcome>;
  compensate(operationId: string, ctx: EventContext, signal: AbortSignal): Promise<SideEffectOutcome>;
}

export interface ReconcileReport {
  examined: number;
  verified: string[];
  notApplied: string[];
  manualReview: string[];
  stillPending: string[];
  /** Operations whose verification definitively failed during reconciliation (additive). */
  failed?: string[];
}

export interface Reconciler {
  /** Reconciles all unsettled operations (on startup/resume) before any new dispatch. */
  reconcile(filter: { runId?: string }, signal: AbortSignal): Promise<ReconcileReport>;
}

export type AdmissionResult =
  | { admitted: true; claimIds: string[] }
  | { admitted: false; conflicts: Array<{ requested: ResourceClaim; heldBy: string; held: ResourceClaim }> };

export interface ResourceAdmission {
  /**
   * Atomically admits all claims or none (conflicts via claimsConflict, ancestor/descendant aware). (additive,
   * conformance-6) `compatibleHolders`: live claims of these holders never conflict with this request — a work item that
   * runs FOR an experiment (holder = experimentId) shares that experiment's claims instead of being refused by them; any
   * other holder still conflicts. The holder's own live claims never conflict (idempotent re-admission extends them).
   */
  admit(request: { holderId: string; runId: string; claims: ResourceClaim[]; ttlMs: number; compatibleHolders?: string[] }): Promise<AdmissionResult>;
  release(holderId: string): Promise<void>;
  active(runId?: string): Promise<Array<{ holderId: string; runId: string; claim: ResourceClaim; expiresAt: string }>>;
  /** (additive, optional) The live claims of one holder (across runs); [] when it holds none. */
  held?(holderId: string): Promise<Array<{ runId: string; claim: ResourceClaim; expiresAt: string }>>;
}

/**
 * `externalQps` (additive, conformance-5) is a RESERVABLE rate dimension: a load job reserves its request rate while it
 * runs and releases it when it ends (never `used`), so concurrent jobs of a run can never exceed `maxExternalQps`.
 */
export type BudgetDimension = 'tokens' | 'costUsd' | 'toolCalls' | 'computeMs' | 'artifactBytes' | 'agents' | 'workItems' | 'wallClockMs' | 'externalQps';
export type BudgetAmounts = Partial<Record<BudgetDimension, number>>;

/** (additive) Which scope/dimension refused (or, for `consume`, ran out): the typed exhaustion callers act on. */
export interface BudgetExhaustion {
  scope: string;
  dimension: BudgetDimension;
  limit: number;
  used: number;
  reserved: number;
  requested: number;
}

export type ReserveOutcome = { ok: true; reservationId: string } | { ok: false; exhausted: BudgetExhaustion };

/**
 * (additive) Outcome of `BudgetLedger.consume`: the usage is ALWAYS recorded (it already happened); `exhausted` names the
 * first scope/dimension (caller scope order, then BUDGET_DIMENSIONS order) whose used amount reached its limit.
 */
export interface ConsumeOutcome {
  reservationId: string;
  exhausted?: BudgetExhaustion;
}

/** (additive) An open (still `reserved`) reservation, as `BudgetLedger.openReservations` lists it. */
export interface OpenReservation {
  reservationId: string;
  /** The listed scopes and all their ancestors (the chain the reservation holds amounts on). */
  scopes: string[];
  amounts: BudgetAmounts;
  reason: string;
  idempotencyKey?: string;
  createdAt: string;
}

export interface BudgetUsage {
  scope: string;
  limits: BudgetAmounts;
  used: BudgetAmounts;
  reserved: BudgetAmounts;
}

/**
 * Budgets are leases: reserve → execute → settle. Scopes are strings (`run:<id>`, `work:<id>`,
 * `agent:<id>`); a reservation is atomic across all listed scopes. Exhaustion is a typed outcome —
 * callers pause or stop; they never silently downgrade quality or permissions.
 */
export interface BudgetLedger {
  open(scope: string, limits: BudgetAmounts, parentScope?: string): Promise<void>;
  /**
   * (additive) `options.idempotencyKey`: a reservation already made under this key is returned as is (`ok: true`, its id —
   * whatever its status now), so a replayed reserve (a durable retry of the call that holds it) never reserves twice.
   * Reusing a key for other scopes or amounts is a `conflict`; a refused reserve records nothing.
   */
  reserve(scopes: string[], amounts: BudgetAmounts, reason: string, options?: { idempotencyKey?: string }): Promise<ReserveOutcome>;
  settle(reservationId: string, actual: BudgetAmounts): Promise<void>;
  release(reservationId: string): Promise<void>;
  /**
   * Record usage without a prior reservation (e.g. observed wall-clock). (additive) `options.idempotencyKey`: a charge
   * already recorded under this key is not charged again — its reservation id is returned (`ok: true`), so a replayed
   * charge (a durable retry of a tool call, a redelivered event) never double counts. Reusing a key for different scopes
   * or amounts is a `conflict`. A refused (exhausted) charge records nothing, so its retry is evaluated afresh.
   */
  charge(scopes: string[], amounts: BudgetAmounts, reason: string, options?: { idempotencyKey?: string }): Promise<ReserveOutcome>;
  usage(scope: string): Promise<BudgetUsage | undefined>;
  /**
   * (additive, durability-1) Releases every still-open reservation whose scope chain contains `scope` (e.g. the
   * `work:<id>` of a claim taken from a dead worker: its in-flight model calls will never settle). Returns the released
   * reservation ids. A later settle of a released reservation is refused (`precondition_failed`).
   */
  releaseOpen?(scope: string): Promise<string[]>;
  /**
   * (additive, optional; conformance-5) Records usage that ALREADY happened (sandbox wall time of a tool call, artifact
   * bytes it stored) on the listed scopes and their ancestors — like `settle`, even above a limit, never refused (under-
   * counting a spent resource would hide the exhaustion). Reports the first scope/dimension — among the dimensions named
   * in `amounts` — that is now exhausted (used ≥ limit) so the caller applies its exhaustion policy.
   */
  consume?(scopes: string[], amounts: BudgetAmounts, reason: string): Promise<ConsumeOutcome>;
  /**
   * (additive, optional) Headroom per limited dimension over the listed scopes and their ancestors:
   * min(limit − used − reserved), floored at 0. Dimensions without a limit anywhere in the chain are absent (unlimited).
   */
  remaining?(scopes: string[]): Promise<BudgetAmounts>;
  /** (additive, optional) Open (`reserved`) reservations whose chain contains `scope`, oldest first. */
  openReservations?(scope: string): Promise<OpenReservation[]>;
}
