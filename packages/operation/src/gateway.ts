import { HypertestError, abortReason, hashCanonical, isHypertestError, sleep, throwIfAborted, toHypertestError } from '@hypertest/core';
import { RISK_ORDER, eventFrom, type EventContext, type OperationRecord, type OperationStatus, type ResourceLease } from '@hypertest/domain';
import type {
  CompensationResult,
  DispatchReceipt,
  GatewayDeps,
  ObservationResult,
  OperationContext,
  OperationLedger,
  PreparedOperation,
  ReconcileReport,
  Reconciler,
  RunSideEffectRequest,
  SideEffectAdapter,
  SideEffectGateway,
  SideEffectOutcome,
  VerificationResult,
} from './contracts.ts';

type LeaseRef = NonNullable<OperationRecord['lease']>;
type Patch = Partial<Pick<OperationRecord, 'externalJobId' | 'externalReceipt' | 'result' | 'lastError' | 'evidenceRefs' | 'lease'>>;

/** Per-call state of one gateway operation drive. */
interface Flow {
  adapter: SideEffectAdapter;
  ctx: EventContext;
  signal: AbortSignal;
  /** Fence validated before any dispatch; recorded on the operation by every transition it drives. */
  fence?: LeaseRef;
  /** Present only for run(): enables dispatch and the single safe re-dispatch after `absent`. */
  input?: { value: unknown };
  prepared?: PreparedOperation;
  verifyWithinMs: number;
  dispatchTimeoutMs?: number;
  redispatchesLeft: number;
}

/** Another actor moved the operation first (optimistic concurrency); converted to a passive outcome. */
class Superseded extends Error {
  readonly current: OperationRecord;
  constructor(current: OperationRecord) {
    super(`operation ${current.operationId} was moved concurrently to ${current.status}`);
    this.current = current;
  }
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const WORK_STATUSES: ReadonlySet<OperationStatus> = new Set(['prepared', 'not_applied', 'dispatching', 'acknowledged', 'outcome_unknown', 'reconciling']);
const OBSERVATION_STATES = new Set(['present', 'absent', 'uncertain']);

/** Operations currently driven (dispatch or compensation) by this process, reference-counted. */
class InFlight {
  readonly #counts = new Map<string, number>();
  add(id: string): void {
    this.#counts.set(id, (this.#counts.get(id) ?? 0) + 1);
  }
  delete(id: string): void {
    const n = (this.#counts.get(id) ?? 0) - 1;
    if (n > 0) this.#counts.set(id, n);
    else this.#counts.delete(id);
  }
  has(id: string): boolean {
    return this.#counts.has(id);
  }
}

/**
 * Process-wide state shared by EVERY gateway and reconciler built over the same ledger instance
 * (e.g. one created by tools and one by control): duplicate run() calls join one single-flight
 * drive, and observe()/reconcile()/run() never act underneath a dispatch or compensation that is
 * still in flight in this process.
 */
interface ProcessState {
  flights: Map<string, Promise<SideEffectOutcome>>;
  inFlight: InFlight;
}
const processStateByLedger = new WeakMap<OperationLedger, ProcessState>();
function processStateFor(ledger: OperationLedger): ProcessState {
  let s = processStateByLedger.get(ledger);
  if (!s) {
    s = { flights: new Map(), inFlight: new InFlight() };
    processStateByLedger.set(ledger, s);
  }
  return s;
}

/**
 * Passive mapping of a recorded operation to an outcome (no adapter calls). The authoritative status
 * is always `outcome.operation.status`.
 */
export function outcomeForOperation(op: OperationRecord): SideEffectOutcome {
  switch (op.status) {
    case 'verified':
      return { status: 'verified', operation: op, result: op.result };
    case 'not_applied':
      return { status: 'not_applied', operation: op, reason: op.lastError ?? 'not_applied' };
    case 'prepared':
      return { status: 'not_applied', operation: op, reason: 'not_dispatched' };
    case 'compensated':
      return { status: 'not_applied', operation: op, reason: 'compensated' };
    case 'failed':
      return { status: 'failed', operation: op, reason: op.lastError ?? 'failed' };
    case 'manual_review':
      return { status: 'manual_review', operation: op, reason: op.lastError ?? 'manual_review' };
    case 'dispatching':
    case 'acknowledged':
    case 'outcome_unknown':
    case 'reconciling':
    case 'compensating':
      return { status: 'pending', operation: op, progress: { status: op.status } };
  }
}

function pending(op: OperationRecord, progress?: unknown): SideEffectOutcome {
  return progress === undefined ? { status: 'pending', operation: op } : { status: 'pending', operation: op, progress };
}

function sameLease(a: LeaseRef | undefined, b: LeaseRef): boolean {
  return a !== undefined && a.leaseId === b.leaseId && a.resourceKey === b.resourceKey && a.fencingToken === b.fencingToken;
}

function toLeaseRef(lease: ResourceLease): LeaseRef {
  return { leaseId: lease.leaseId, resourceKey: lease.resourceKey, fencingToken: lease.fencingToken };
}

function isHighRisk(adapter: SideEffectAdapter): boolean {
  return RISK_ORDER[adapter.capabilities.riskClass] >= RISK_ORDER.high;
}

function requireText(value: unknown, name: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new HypertestError('invalid_argument', `${name} must be a non-empty string`);
}

function validateRequest(req: RunSideEffectRequest<unknown>): void {
  requireText(req.runId, 'runId');
  requireText(req.workItemId, 'workItemId');
  requireText(req.toolInvocationId, 'toolInvocationId');
  requireText(req.operationType, 'operationType');
  requireText(req.adapterId, 'adapterId');
  if (!req.target || typeof req.target.resourceKey !== 'string' || req.target.resourceKey.length === 0) {
    throw new HypertestError('invalid_argument', 'target.resourceKey must be a non-empty string');
  }
  if (req.lease) {
    requireText(req.lease.resourceKey, 'lease.resourceKey');
    requireText(req.lease.owner, 'lease.owner');
    if (!Number.isFinite(req.lease.ttlMs) || req.lease.ttlMs <= 0) throw new HypertestError('invalid_argument', 'lease.ttlMs must be positive');
  }
  if (req.verifyWithinMs !== undefined && (!Number.isFinite(req.verifyWithinMs) || req.verifyWithinMs < 0)) {
    throw new HypertestError('invalid_argument', 'verifyWithinMs must be a non-negative number');
  }
  if (req.dispatchTimeoutMs !== undefined && (!Number.isFinite(req.dispatchTimeoutMs) || req.dispatchTimeoutMs <= 0)) {
    throw new HypertestError('invalid_argument', 'dispatchTimeoutMs must be positive');
  }
  if (req.reconcileOnly !== undefined && typeof req.reconcileOnly !== 'boolean') throw new HypertestError('invalid_argument', 'reconcileOnly must be a boolean');
}

function validatePrepared(prepared: PreparedOperation, adapterId: string): void {
  if (!prepared || typeof prepared.desiredStateHash !== 'string' || prepared.desiredStateHash.length === 0 || !prepared.target || typeof prepared.target.resourceKey !== 'string') {
    throw new HypertestError('schema_violation', `adapter ${adapterId} returned an invalid PreparedOperation`);
  }
}

/** Runs fn with a derived signal; rejects on parent abort or timeout even if fn ignores the signal. */
async function callWithDeadline<T>(fn: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeoutMs: number | undefined, what: string): Promise<T> {
  throwIfAborted(parent);
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    onAbort = () => {
      const reason = abortReason(parent);
      ctrl.abort(reason);
      reject(reason);
    };
    parent.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        const e = new HypertestError('timeout', `${what} timed out after ${timeoutMs}ms`);
        ctrl.abort(e);
        reject(e);
      }, timeoutMs);
    }
  });
  try {
    return await Promise.race([Promise.resolve().then(() => fn(ctrl.signal)), guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) parent.removeEventListener('abort', onAbort);
  }
}

/**
 * Shared engine behind the SideEffectGateway and the Reconciler: the retry switch, reconciliation,
 * verification and compensation over the Operation Ledger (I4).
 */
class SideEffectEngine {
  readonly #deps: GatewayDeps;
  readonly #pollIntervalMs: number;
  readonly #flights: Map<string, Promise<SideEffectOutcome>>;
  readonly #inFlight: InFlight;

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
    this.#pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isFinite(this.#pollIntervalMs) || this.#pollIntervalMs <= 0) throw new HypertestError('invalid_argument', 'pollIntervalMs must be positive');
    const state = processStateFor(deps.ledger);
    this.#flights = state.flights;
    this.#inFlight = state.inFlight;
  }

  // ------------------------------------------------------------------------------------------ run

  run<I>(req: RunSideEffectRequest<I>): Promise<SideEffectOutcome> {
    try {
      throwIfAborted(req.signal);
      validateRequest(req as RunSideEffectRequest<unknown>);
    } catch (e) {
      return Promise.reject(e);
    }
    let inputHash: string;
    let adapter: SideEffectAdapter;
    try {
      adapter = this.#deps.adapters.get(req.adapterId);
      inputHash = hashCanonical(req.input === undefined ? null : req.input);
    } catch (e) {
      return Promise.reject(toHypertestError(e, 'invalid_argument'));
    }
    // Single-flight (process-wide per ledger): concurrent duplicate deliveries of one tool invocation
    // share one drive. A request that differs in run/adapter/input is not joined; #run rejects it.
    // a reconcile-only call never joins (nor lends its no-dispatch outcome to) a drive that may dispatch
    const key = [req.toolInvocationId, req.operationType, req.runId, req.adapterId, inputHash, req.reconcileOnly === true ? 'reconcile-only' : 'run'].join('\u0000');
    const existing = this.#flights.get(key);
    if (existing) return existing;
    const flight = this.#run(req as RunSideEffectRequest<unknown>, adapter, inputHash).finally(() => this.#flights.delete(key));
    this.#flights.set(key, flight);
    return flight;
  }

  async #run(req: RunSideEffectRequest<unknown>, adapter: SideEffectAdapter, inputHash: string): Promise<SideEffectOutcome> {
    const { ledger, ids, clock } = this.#deps;
    let op = await ledger.findByToolInvocation(req.toolInvocationId, req.operationType);
    if (op) {
      this.#assertSameRequest(op, req, inputHash);
      // verified ⇒ recorded result; failed/manual_review/compensation states ⇒ recorded outcome. Never re-dispatch.
      if (!WORK_STATUSES.has(op.status)) return outcomeForOperation(op);
    }
    if (req.reconcileOnly) {
      // settle what exists; a dispatch would be a new decision (see RunSideEffectRequest.reconcileOnly)
      if (!op) throw new HypertestError('not_found', `no operation is recorded for tool invocation ${req.toolInvocationId} (${req.operationType}): nothing to reconcile, and a reconcile-only call never dispatches`);
      if (op.status === 'prepared' || op.status === 'not_applied') return { status: 'not_applied', operation: op, reason: `dispatch_refused: operation ${op.operationId} is ${op.status}; a (re-)dispatch needs a fresh decision` };
    }

    let lease: ResourceLease | undefined;
    let busy = false;
    if (req.lease) {
      lease = await this.#obtainLease(req.lease);
      busy = lease === undefined;
    }

    let prepared: PreparedOperation | undefined;
    if (!op) {
      const operationId = ids.next('op');
      const now = clock.isoNow();
      const provisional: OperationRecord = {
        operationId,
        runId: req.runId,
        workItemId: req.workItemId,
        toolInvocationId: req.toolInvocationId,
        operationType: req.operationType,
        adapterId: req.adapterId,
        target: req.target,
        desiredStateHash: '',
        inputHash,
        idempotencyKey: operationId,
        status: 'prepared',
        attempt: 0,
        evidenceRefs: [],
        createdAt: now,
        updatedAt: now,
      };
      if (req.agentId !== undefined) provisional.agentId = req.agentId;
      if (lease) provisional.lease = toLeaseRef(lease);
      prepared = await this.#prepareWith(adapter, provisional, lease?.fencingToken, req.input, req.signal);
      op = await ledger.prepare(
        {
          operationId,
          runId: req.runId,
          workItemId: req.workItemId,
          ...(req.agentId !== undefined ? { agentId: req.agentId } : {}),
          toolInvocationId: req.toolInvocationId,
          operationType: req.operationType,
          adapterId: req.adapterId,
          target: prepared.target,
          desiredStateHash: prepared.desiredStateHash,
          inputHash,
          ...(lease ? { lease: toLeaseRef(lease) } : {}),
        },
        req.ctx,
      );
      if (op.operationId !== operationId) {
        // Lost a prepare race to another process: continue with the persisted record only.
        this.#assertSameRequest(op, req, inputHash);
        prepared = undefined;
        if (!WORK_STATUSES.has(op.status)) return outcomeForOperation(op);
      }
    }

    if (busy) {
      this.#deps.logger.info('side-effect resource busy', { operationId: op.operationId, resourceKey: req.lease?.resourceKey, owner: req.lease?.owner });
      return { status: 'failed', operation: op, reason: 'resource_busy' };
    }

    const flow: Flow = {
      adapter,
      ctx: req.ctx,
      signal: req.signal,
      input: { value: req.input },
      verifyWithinMs: req.verifyWithinMs ?? 0,
      // reconcile-only: an operation found absent ends not_applied (never re-dispatched)
      redispatchesLeft: req.reconcileOnly ? 0 : 1,
    };
    const fence = lease ? toLeaseRef(lease) : op.lease;
    if (fence) flow.fence = fence;
    if (prepared) flow.prepared = prepared;
    const timeout = req.dispatchTimeoutMs ?? this.#deps.dispatchTimeoutMs;
    if (timeout !== undefined) flow.dispatchTimeoutMs = timeout;

    // Defensive: never reconcile a dispatch that another drive in this process still has in flight.
    if (op.status === 'dispatching' && this.#inFlight.has(op.operationId)) return outcomeForOperation(op);
    this.#inFlight.add(op.operationId);
    try {
      return await this.#drive(op, flow);
    } catch (e) {
      if (e instanceof Superseded) return outcomeForOperation(e.current);
      throw e;
    } finally {
      this.#inFlight.delete(op.operationId);
    }
  }

  #assertSameRequest(op: OperationRecord, req: RunSideEffectRequest<unknown>, inputHash: string): void {
    if (op.runId !== req.runId || op.adapterId !== req.adapterId || op.inputHash !== inputHash) {
      throw new HypertestError('conflict', `tool invocation ${req.toolInvocationId} was already used for a different operation`, {
        details: {
          operationId: op.operationId,
          recorded: { runId: op.runId, adapterId: op.adapterId, inputHash: op.inputHash },
          requested: { runId: req.runId, adapterId: req.adapterId, inputHash },
        },
      });
    }
  }

  /** adapter.prepare() bounded by the caller's abort signal; faults surface as HypertestErrors. */
  async #prepareWith(adapter: SideEffectAdapter, operation: OperationRecord, fencingToken: number | undefined, input: unknown, parent: AbortSignal): Promise<PreparedOperation> {
    let prepared: PreparedOperation;
    try {
      prepared = await callWithDeadline(
        (signal) => {
          const ctx: OperationContext = { operation, signal };
          if (fencingToken !== undefined) ctx.fencingToken = fencingToken;
          return adapter.prepare(ctx, input);
        },
        parent,
        undefined,
        `prepare of ${operation.operationType}`,
      );
    } catch (e) {
      throw toHypertestError(e);
    }
    validatePrepared(prepared, adapter.adapterId);
    return prepared;
  }

  /** True while the lease recorded on the operation is still the live lease of its resource. */
  async #leaseStillHeld(op: OperationRecord): Promise<boolean> {
    if (!op.lease) return false;
    const live = await this.#deps.leases.current(op.lease.resourceKey);
    return live !== undefined && live.leaseId === op.lease.leaseId;
  }

  /** Reuses the owner's live lease (renewed) or acquires a new one; undefined when another owner holds it. */
  async #obtainLease(spec: { resourceKey: string; ttlMs: number; owner: string }): Promise<ResourceLease | undefined> {
    const { leases } = this.#deps;
    const current = await leases.current(spec.resourceKey);
    if (current && current.owner === spec.owner) {
      try {
        return await leases.renew(current.leaseId, spec.ttlMs);
      } catch (e) {
        if (!isHypertestError(e, 'stale_fence')) throw e;
        // Expired or superseded between current() and renew(): fall through to a fresh grant.
      }
    }
    return leases.acquire({ resourceKey: spec.resourceKey, owner: spec.owner, ttlMs: spec.ttlMs });
  }

  /** The retry switch (improvements doc §副作用恢复). */
  async #drive(op: OperationRecord, flow: Flow): Promise<SideEffectOutcome> {
    switch (op.status) {
      case 'prepared':
      case 'not_applied':
        return this.#dispatch(op, flow);
      case 'dispatching':
      case 'outcome_unknown':
      case 'reconciling':
        // A stale worker stops immediately; it must not drive the operation further.
        if (!(await this.#fenceOk(flow))) return this.#stale(op, flow);
        return this.#reconcile(op, flow);
      case 'acknowledged':
        if (!(await this.#fenceOk(flow))) return this.#stale(op, flow);
        return this.#attach(op, flow);
      default:
        return outcomeForOperation(op);
    }
  }

  async #fenceOk(flow: Flow): Promise<boolean> {
    if (!flow.fence) return true;
    return this.#deps.leases.checkFence(flow.fence.resourceKey, flow.fence.fencingToken);
  }

  #stale(op: OperationRecord, flow: Flow): SideEffectOutcome {
    const reason = `stale fencing token ${flow.fence?.fencingToken} for ${flow.fence?.resourceKey}: lease expired or superseded`;
    this.#deps.logger.warn('side-effect refused: stale fence', { operationId: op.operationId, status: op.status, resourceKey: flow.fence?.resourceKey, fencingToken: flow.fence?.fencingToken });
    return { status: 'stale_fence', operation: op, reason };
  }

  #opCtx(op: OperationRecord, flow: Flow, signal?: AbortSignal): OperationContext {
    const ctx: OperationContext = { operation: op, signal: signal ?? flow.signal };
    if (flow.fence) ctx.fencingToken = flow.fence.fencingToken;
    return ctx;
  }

  /** Ledger transition with optimistic concurrency on the status we acted upon. */
  async #move(op: OperationRecord, to: OperationStatus, patch: Patch, flow: Flow): Promise<OperationRecord> {
    const full: Patch = { ...patch };
    if (flow.fence && !sameLease(op.lease, flow.fence) && full.lease === undefined) full.lease = flow.fence;
    try {
      return await this.#deps.ledger.transition(op.operationId, to, full, flow.ctx, { expectedFrom: [op.status], expectedAttempt: op.attempt });
    } catch (e) {
      if (isHypertestError(e, 'conflict')) {
        const current = await this.#deps.ledger.get(op.operationId);
        if (current && (current.status !== op.status || current.attempt !== op.attempt)) {
          this.#deps.logger.info('operation moved concurrently', { operationId: op.operationId, expected: op.status, actual: current.status, to });
          throw new Superseded(current);
        }
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------- dispatch

  async #dispatch(op: OperationRecord, flow: Flow): Promise<SideEffectOutcome> {
    if (!flow.input) return outcomeForOperation(op);
    const adapter = flow.adapter;
    let prepared = flow.prepared;
    delete flow.prepared;
    if (!prepared) {
      prepared = await this.#prepareWith(adapter, op, flow.fence?.fencingToken, flow.input.value, flow.signal);
      if (prepared.desiredStateHash !== op.desiredStateHash) {
        throw new HypertestError('conflict', `adapter ${adapter.adapterId} prepared a different desired state for operation ${op.operationId}`, {
          details: { recorded: op.desiredStateHash, prepared: prepared.desiredStateHash },
        });
      }
    }
    if (!(await this.#fenceOk(flow))) return this.#stale(op, flow);

    // Persist the intent to dispatch BEFORE touching the external system.
    op = await this.#move(op, 'dispatching', {}, flow);
    const dispatching = op;
    let receipt: DispatchReceipt;
    try {
      receipt = await callWithDeadline((signal) => adapter.dispatch(prepared, this.#opCtx(dispatching, flow, signal)), flow.signal, flow.dispatchTimeoutMs, `dispatch of ${op.operationType}`);
      if (!receipt || typeof receipt.accepted !== 'boolean') throw new HypertestError('schema_violation', `adapter ${adapter.adapterId} returned a malformed dispatch receipt`);
    } catch (e) {
      return this.#dispatchOutcomeUnknown(op, flow, e);
    }

    if (!receipt.accepted) {
      const reason = receipt.notAppliedReason ?? 'target did not apply the operation';
      const patch: Patch = { lastError: reason };
      if (receipt.receipt !== undefined) patch.externalReceipt = receipt.receipt;
      op = await this.#move(op, 'not_applied', patch, flow);
      return { status: 'not_applied', operation: op, reason };
    }

    const ack: Patch = {};
    if (receipt.externalJobId !== undefined) ack.externalJobId = receipt.externalJobId;
    if (receipt.receipt !== undefined) ack.externalReceipt = receipt.receipt;
    try {
      op = await this.#move(op, 'acknowledged', ack, flow);
    } catch (e) {
      if (e instanceof Superseded) return this.#lateReceipt(e.current, ack, flow, dispatching.attempt);
      throw e;
    }
    return this.#attach(op, flow);
  }

  /** Crash/timeout/lost response between dispatch and receipt: `outcome_unknown`, never `failed`. */
  async #dispatchOutcomeUnknown(op: OperationRecord, flow: Flow, e: unknown): Promise<SideEffectOutcome> {
    const err = toHypertestError(e);
    const reason = `dispatch outcome unknown (${err.code}): ${err.message}`;
    this.#deps.logger.warn('side-effect dispatch outcome unknown', { operationId: op.operationId, adapterId: op.adapterId, code: err.code, error: err.message });
    op = await this.#move(op, 'outcome_unknown', { lastError: reason }, flow);
    if (flow.adapter.capabilities.supportsExternalLookupByOperationId) {
      // A later observe()/reconcile() settles it by looking the effect up by operationId.
      return pending(op, { reason: 'outcome_unknown', detail: reason });
    }
    return this.#toManualReview(op, flow, `${reason}; adapter ${op.adapterId} cannot look up effects by operationId, refusing blind retry`);
  }

  /**
   * The target accepted our dispatch (attempt `dispatchedAttempt`), but another actor moved the
   * operation before the receipt was persisted. The receipt proves the effect exists, so:
   * - still being reconciled (same attempt): record the receipt (attach) before anyone can conclude
   *   `not_applied` and re-dispatch;
   * - already concluded `not_applied`: record it terminally (never re-dispatch; humans review);
   * - a later attempt was started: our effect is an orphaned duplicate — surfaced, never dropped;
   * - already escalated to manual_review: keep the receipt in the audit log for the reviewer.
   */
  async #lateReceipt(current: OperationRecord, ack: Patch, flow: Flow, dispatchedAttempt: number, depth = 0): Promise<SideEffectOutcome> {
    const job = ack.externalJobId ?? 'n/a';
    // Our own writes can lose again to the concurrent actor: re-evaluate against its new state (bounded).
    const write = async (fn: () => Promise<OperationRecord>): Promise<{ op: OperationRecord } | { outcome: SideEffectOutcome }> => {
      try {
        return { op: await fn() };
      } catch (e) {
        if (e instanceof Superseded && depth < 5) return { outcome: await this.#lateReceipt(e.current, ack, flow, dispatchedAttempt, depth + 1) };
        throw e;
      }
    };
    if (current.status === 'not_applied') {
      const reason = `dispatch receipt (externalJobId=${job}) arrived after reconciliation recorded not_applied; the effect exists and needs manual review`;
      this.#deps.logger.error('late dispatch receipt after not_applied', { operationId: current.operationId, externalJobId: ack.externalJobId });
      const w = await write(() => this.#move(current, 'failed', { ...ack, lastError: reason }, flow));
      return 'outcome' in w ? w.outcome : { status: 'manual_review', operation: w.op, reason };
    }
    if (current.attempt === dispatchedAttempt && (current.status === 'outcome_unknown' || current.status === 'reconciling')) {
      this.#deps.logger.warn('late dispatch receipt attached to a concurrent reconciliation', { operationId: current.operationId, externalJobId: ack.externalJobId });
      const w = await write(async () => {
        const op = current.status === 'outcome_unknown' ? await this.#move(current, 'reconciling', {}, flow) : current;
        return this.#move(op, 'acknowledged', ack, flow);
      });
      return 'outcome' in w ? w.outcome : this.#attach(w.op, flow);
    }
    if (current.attempt !== dispatchedAttempt) {
      const reason = `orphaned external effect (externalJobId=${job}) from dispatch attempt ${dispatchedAttempt}: its receipt arrived after attempt ${current.attempt} was started; the duplicate needs manual cleanup`;
      this.#deps.logger.error('orphaned side effect: late receipt after re-dispatch', { operationId: current.operationId, externalJobId: ack.externalJobId, dispatchedAttempt, currentAttempt: current.attempt, currentStatus: current.status });
      await this.#auditLateReceipt(current, ack, flow, dispatchedAttempt, 'orphaned');
      return { status: 'manual_review', operation: current, reason };
    }
    if (current.status === 'manual_review') {
      this.#deps.logger.error('late dispatch receipt for an operation under manual review', { operationId: current.operationId, externalJobId: ack.externalJobId });
      await this.#auditLateReceipt(current, ack, flow, dispatchedAttempt, 'manual_review');
    }
    // acknowledged/verified/failed/manual_review under the same attempt: the effect is already attached or escalated.
    return outcomeForOperation(current);
  }

  /** Records a receipt the ledger could not store (no legal transition) as an L0 audit event (I10). */
  async #auditLateReceipt(current: OperationRecord, ack: Patch, flow: Flow, dispatchedAttempt: number, disposition: 'orphaned' | 'manual_review'): Promise<void> {
    if (!this.#deps.events) return;
    const payload: Record<string, unknown> = { operationId: current.operationId, disposition, dispatchedAttempt, currentAttempt: current.attempt, currentStatus: current.status };
    if (ack.externalJobId !== undefined) payload['externalJobId'] = ack.externalJobId;
    if (ack.externalReceipt !== undefined) payload['externalReceipt'] = ack.externalReceipt;
    const event = eventFrom(flow.ctx, 'operation.late_receipt', 'operation', current.operationId, payload);
    event.runId = current.runId;
    event.workItemId = flow.ctx.workItemId ?? current.workItemId;
    try {
      await this.#deps.events.emit([event]);
    } catch (e) {
      const err = toHypertestError(e);
      this.#deps.logger.error('failed to record late receipt audit event', { operationId: current.operationId, code: err.code, error: err.message });
    }
  }

  // --------------------------------------------------------------------------- attach and verify

  /** Acknowledged operation: attach to the recorded external effect (observe → verify), never recreate it. */
  async #attach(op: OperationRecord, flow: Flow): Promise<SideEffectOutcome> {
    const polls = flow.verifyWithinMs > 0 ? Math.ceil(flow.verifyWithinMs / this.#pollIntervalMs) + 1 : 1;
    let progress: unknown = { status: 'acknowledged' };
    for (let i = 0; i < polls; i++) {
      if (i > 0) {
        try {
          await sleep(this.#pollIntervalMs, flow.signal);
        } catch {
          break;
        }
      }
      const obs = await this.#observeSafely(op, flow);
      if (obs === undefined) {
        progress = { reason: 'observe_failed' };
        continue;
      }
      if (obs.state === 'uncertain') return this.#toManualReview(op, flow, `observation uncertain after acknowledgement: ${obs.detail}`);
      if (obs.state === 'absent') {
        // The target acknowledged the job: absence is lag or cleanup, never "not applied". Keep waiting.
        progress = { reason: 'not_yet_observable' };
        continue;
      }
      const out = await this.#verify(op, flow, obs.observation);
      if (out.status !== 'pending') return out;
      progress = out.progress ?? { status: 'acknowledged' };
    }
    return pending(op, progress);
  }

  /** adapter.observe() bounded by the abort signal (an adapter ignoring it cannot hang the drive). */
  async #observeSafely(op: OperationRecord, flow: Flow): Promise<ObservationResult<unknown> | undefined> {
    try {
      const obs = await callWithDeadline((signal) => flow.adapter.observe(this.#opCtx(op, flow, signal)), flow.signal, undefined, `observe of ${op.operationType}`);
      if (!obs || !OBSERVATION_STATES.has(obs.state)) throw new HypertestError('schema_violation', `adapter ${op.adapterId} returned a malformed observation`);
      return obs;
    } catch (e) {
      const err = toHypertestError(e);
      this.#deps.logger.warn('side-effect observe failed', { operationId: op.operationId, code: err.code, error: err.message });
      return undefined;
    }
  }

  async #verify(op: OperationRecord, flow: Flow, observation: unknown): Promise<SideEffectOutcome> {
    let v: VerificationResult;
    try {
      v = await callWithDeadline((signal) => flow.adapter.verify(observation, op.desiredStateHash, this.#opCtx(op, flow, signal)), flow.signal, undefined, `verify of ${op.operationType}`);
      if (!v || (v.status !== 'verified' && v.status !== 'pending' && v.status !== 'failed')) throw new HypertestError('schema_violation', `adapter ${op.adapterId} returned a malformed verification result`);
    } catch (e) {
      const err = toHypertestError(e);
      this.#deps.logger.warn('side-effect verify failed', { operationId: op.operationId, code: err.code, error: err.message });
      return pending(op, { reason: 'verify_failed', error: err.message });
    }
    if (v.status === 'verified') {
      const done = await this.#move(op, 'verified', { result: v.result }, flow);
      return { status: 'verified', operation: done, result: done.result };
    }
    if (v.status === 'failed') {
      const failed = await this.#move(op, 'failed', { lastError: v.reason }, flow);
      return { status: 'failed', operation: failed, reason: v.reason };
    }
    return pending(op, v.progress);
  }

  // ------------------------------------------------------------------------------------ reconcile

  /** dispatching / outcome_unknown / reconciling: look the effect up before anything else happens. */
  async #reconcile(op: OperationRecord, flow: Flow): Promise<SideEffectOutcome> {
    if (op.status === 'dispatching') op = await this.#move(op, 'outcome_unknown', { lastError: 'dispatch interrupted before a receipt was recorded' }, flow);
    if (op.status === 'outcome_unknown') op = await this.#move(op, 'reconciling', {}, flow);
    const adapter = flow.adapter;
    const caps = adapter.capabilities;
    const highRisk = isHighRisk(adapter);
    if (op.externalJobId === undefined && !caps.supportsExternalLookupByOperationId && highRisk) {
      return this.#toManualReview(op, flow, `outcome unknown and adapter ${adapter.adapterId} cannot look up effects by operationId (risk ${caps.riskClass}); refusing blind retry`);
    }
    const obs = await this.#observeSafely(op, flow);
    if (obs === undefined) return pending(op, { reason: 'observe_failed', status: op.status });
    switch (obs.state) {
      case 'present': {
        // Found and attached: never create a second resource.
        const acked = await this.#move(op, 'acknowledged', {}, flow);
        return this.#verify(acked, flow, obs.observation);
      }
      case 'uncertain':
        return this.#toManualReview(op, flow, `reconciliation uncertain: ${obs.detail}`);
      case 'absent': {
        if (caps.reconciliationClass === 'non_reconcilable' && highRisk) {
          return this.#toManualReview(op, flow, `effect not observed, but adapter ${adapter.adapterId} is non_reconcilable with risk ${caps.riskClass}: absence cannot be trusted, refusing re-dispatch`);
        }
        const reason = 'reconciled: effect absent at target';
        const notApplied = await this.#move(op, 'not_applied', { lastError: reason }, flow);
        if (flow.input && flow.redispatchesLeft > 0) {
          flow.redispatchesLeft--;
          return this.#dispatch(notApplied, flow);
        }
        return { status: 'not_applied', operation: notApplied, reason };
      }
    }
  }

  /** Walks the legal path to manual_review from any unsettled/compensating state. */
  async #toManualReview(op: OperationRecord, flow: Flow, reason: string): Promise<SideEffectOutcome> {
    const paths: Partial<Record<OperationStatus, OperationStatus[]>> = {
      dispatching: ['outcome_unknown', 'reconciling', 'manual_review'],
      acknowledged: ['outcome_unknown', 'reconciling', 'manual_review'],
      outcome_unknown: ['reconciling', 'manual_review'],
      reconciling: ['manual_review'],
      compensating: ['manual_review'],
    };
    const steps = paths[op.status];
    if (!steps) return outcomeForOperation(op);
    let cur = op;
    for (const step of steps) cur = await this.#move(cur, step, step === 'reconciling' ? {} : { lastError: reason }, flow);
    this.#deps.logger.warn('operation requires manual review', { operationId: op.operationId, adapterId: op.adapterId, reason });
    return { status: 'manual_review', operation: cur, reason };
  }

  // -------------------------------------------------------------------------- observe/compensate

  async observe(operationId: string, ctx: EventContext, signal: AbortSignal): Promise<SideEffectOutcome> {
    throwIfAborted(signal);
    const op = await this.#deps.ledger.get(operationId);
    if (!op) throw new HypertestError('not_found', `operation ${operationId} not found`);
    assertSameRun(op, ctx);
    // A dispatch in flight in this process, or under a still-live lease (its dispatcher may be alive in
    // another process), is not a crash: do not reconcile underneath it. Its receipt or lease expiry settles it.
    if (op.status === 'dispatching' && (this.#inFlight.has(op.operationId) || (await this.#leaseStillHeld(op)))) return outcomeForOperation(op);
    if (op.status !== 'acknowledged' && op.status !== 'dispatching' && op.status !== 'outcome_unknown' && op.status !== 'reconciling') return outcomeForOperation(op);
    const flow: Flow = { adapter: this.#deps.adapters.get(op.adapterId), ctx, signal, verifyWithinMs: 0, redispatchesLeft: 0 };
    try {
      return op.status === 'acknowledged' ? await this.#attach(op, flow) : await this.#reconcile(op, flow);
    } catch (e) {
      if (e instanceof Superseded) return outcomeForOperation(e.current);
      throw e;
    }
  }

  async compensate(operationId: string, ctx: EventContext, signal: AbortSignal): Promise<SideEffectOutcome> {
    throwIfAborted(signal);
    const op = await this.#deps.ledger.get(operationId);
    if (!op) throw new HypertestError('not_found', `operation ${operationId} not found`);
    assertSameRun(op, ctx);
    const adapter = this.#deps.adapters.get(op.adapterId);
    if (!adapter.capabilities.supportsCompensation || typeof adapter.compensate !== 'function') {
      throw new HypertestError('unsupported', `adapter ${adapter.adapterId} does not support compensation`);
    }
    const flow: Flow = { adapter, ctx, signal, verifyWithinMs: 0, redispatchesLeft: 0 };
    if (this.#deps.dispatchTimeoutMs !== undefined) flow.dispatchTimeoutMs = this.#deps.dispatchTimeoutMs;
    // A compensation still running in this process is not an interrupted one: never undo twice.
    if (op.status === 'compensating' && this.#inFlight.has(op.operationId)) return outcomeForOperation(op);
    this.#inFlight.add(op.operationId);
    try {
      switch (op.status) {
        case 'compensated':
          return outcomeForOperation(op);
        case 'verified':
          return await this.#runCompensation(await this.#move(op, 'compensating', {}, flow), flow);
        case 'compensating': {
          // Resumed after an interrupted compensation: find out whether the effect is still there.
          if (!adapter.capabilities.supportsExternalLookupByOperationId) {
            return await this.#toManualReview(op, flow, 'compensation was interrupted and the adapter cannot look up the effect');
          }
          const obs = await this.#observeSafely(op, flow);
          if (obs === undefined) return pending(op, { reason: 'observe_failed', status: op.status });
          if (obs.state === 'uncertain') return await this.#toManualReview(op, flow, `compensation state uncertain: ${obs.detail}`);
          if (obs.state === 'absent') {
            const done = await this.#move(op, 'compensated', {}, flow);
            return { status: 'not_applied', operation: done, reason: 'compensated' };
          }
          return await this.#runCompensation(op, flow);
        }
        default:
          // Only a known-applied effect may be compensated; an unknown outcome is reconciled first.
          throw new HypertestError('precondition_failed', `operation ${op.operationId} is ${op.status}; compensation requires a verified operation`, {
            details: { operationId: op.operationId, status: op.status },
          });
      }
    } catch (e) {
      if (e instanceof Superseded) return outcomeForOperation(e.current);
      throw e;
    } finally {
      this.#inFlight.delete(op.operationId);
    }
  }

  async #runCompensation(op: OperationRecord, flow: Flow): Promise<SideEffectOutcome> {
    const compensate = flow.adapter.compensate!.bind(flow.adapter);
    let res: CompensationResult;
    try {
      res = await callWithDeadline((signal) => compensate(this.#opCtx(op, flow, signal)), flow.signal, flow.dispatchTimeoutMs, `compensation of ${op.operationType}`);
    } catch (e) {
      const err = toHypertestError(e);
      return this.#toManualReview(op, flow, `compensation failed (${err.code}): ${err.message}`);
    }
    if (!res || res.compensated !== true) return this.#toManualReview(op, flow, `compensation not confirmed: ${res?.detail ?? 'no detail'}`);
    const done = await this.#move(op, 'compensated', res.detail !== undefined ? { lastError: `compensated: ${res.detail}` } : {}, flow);
    return { status: 'not_applied', operation: done, reason: 'compensated' };
  }

  // ------------------------------------------------------------------------------ reconciliation

  /** Reconciles one unsettled operation without dispatching anything. */
  async reconcileOne(op: OperationRecord, signal: AbortSignal): Promise<SideEffectOutcome> {
    const { adapters, logger } = this.#deps;
    if (this.#inFlight.has(op.operationId)) return outcomeForOperation(op);
    if (!adapters.has(op.adapterId)) {
      logger.warn('reconcile skipped: adapter not registered', { operationId: op.operationId, adapterId: op.adapterId });
      return outcomeForOperation(op);
    }
    if (await this.#leaseStillHeld(op)) {
      // The live holder of the operation's lease owns its progress; do not race it.
      logger.info('reconcile skipped: operation lease still live', { operationId: op.operationId, leaseId: op.lease?.leaseId });
      return outcomeForOperation(op);
    }
    const ctx: EventContext = { runId: op.runId, correlationId: op.operationId, actorId: 'system:reconciler', workItemId: op.workItemId };
    if (op.agentId !== undefined) ctx.agentId = op.agentId;
    const flow: Flow = { adapter: adapters.get(op.adapterId), ctx, signal, verifyWithinMs: 0, redispatchesLeft: 0 };
    try {
      return op.status === 'acknowledged' ? await this.#attach(op, flow) : await this.#reconcile(op, flow);
    } catch (e) {
      if (e instanceof Superseded) return outcomeForOperation(e.current);
      throw e;
    }
  }
}

export function createSideEffectGateway(deps: GatewayDeps): SideEffectGateway {
  const engine = new SideEffectEngine(deps);
  return {
    run: (request) => engine.run(request),
    observe: (operationId, ctx, signal) => engine.observe(operationId, ctx, signal),
    compensate: (operationId, ctx, signal) => engine.compensate(operationId, ctx, signal),
    async find(toolInvocationId, operationType, runId) {
      const op = await deps.ledger.findByToolInvocation(toolInvocationId, operationType);
      // run-scoped like every other gateway call
      return op && op.runId === runId ? op : undefined;
    },
  };
}

export function createReconciler(deps: GatewayDeps): Reconciler {
  const engine = new SideEffectEngine(deps);
  return {
    async reconcile(filter, signal): Promise<ReconcileReport> {
      throwIfAborted(signal);
      const ops = await deps.ledger.listUnsettled(filter.runId);
      const report: ReconcileReport = { examined: ops.length, verified: [], notApplied: [], manualReview: [], stillPending: [], failed: [] };
      for (const op of ops) {
        throwIfAborted(signal);
        let outcome: SideEffectOutcome;
        try {
          outcome = await engine.reconcileOne(op, signal);
        } catch (e) {
          if (signal.aborted) throw abortReason(signal);
          const err = toHypertestError(e);
          deps.logger.error('reconcile failed for operation', { operationId: op.operationId, code: err.code, error: err.message });
          report.stillPending.push(op.operationId);
          continue;
        }
        switch (outcome.status) {
          case 'verified':
            report.verified.push(op.operationId);
            break;
          case 'not_applied':
            report.notApplied.push(op.operationId);
            break;
          case 'manual_review':
            report.manualReview.push(op.operationId);
            break;
          case 'failed':
            report.failed!.push(op.operationId);
            break;
          default:
            report.stillPending.push(op.operationId);
        }
      }
      // An abort cut observations short: the caller asked to stop, so report it rather than a partial result.
      throwIfAborted(signal);
      deps.logger.info('reconciliation complete', {
        runId: filter.runId ?? null,
        examined: report.examined,
        verified: report.verified.length,
        notApplied: report.notApplied.length,
        manualReview: report.manualReview.length,
        stillPending: report.stillPending.length,
        failed: report.failed!.length,
      });
      return report;
    },
  };
}


/** Operations are run-scoped: a tool in one run can never observe or compensate another run's side effects. */
function assertSameRun(op: { operationId: string; runId: string }, ctx: EventContext): void {
  if (ctx.runId !== op.runId) {
    throw new HypertestError('permission_denied', `operation ${op.operationId} belongs to run ${op.runId}, not ${ctx.runId}`, { details: { operationId: op.operationId } });
  }
}
