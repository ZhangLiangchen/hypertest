import { hashCanonical, type SqlDatabase } from '@hypertest/core';
import { InMemoryEventSink, type OperationRecord, type OperationStatus } from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';
import { eventCtx, testDeps } from '@hypertest/testkit';
import {
  AdapterRegistry,
  createLeaseService,
  createOperationLedger,
  createReconciler,
  createSideEffectGateway,
  operationMigrations,
  type CompensationResult,
  type DispatchReceipt,
  type GatewayDeps,
  type LeaseService,
  type ObservationResult,
  type OperationContext,
  type OperationDeps,
  type OperationLedger,
  type PreparedOperation,
  type Reconciler,
  type RunSideEffectRequest,
  type SideEffectAdapter,
  type SideEffectCapabilities,
  type SideEffectGateway,
  type VerificationResult,
} from '../src/index.ts';

export interface Env {
  db: SqlDatabase;
  dispose(): Promise<void>;
  deps: OperationDeps & ReturnType<typeof testDeps>;
  clock: ReturnType<typeof testDeps>['clock'];
  events: InMemoryEventSink;
  ledger: OperationLedger;
  leases: LeaseService;
}

/** One migrated database per test file; tests isolate themselves with distinct run ids / keys. */
export async function openEnv(): Promise<Env> {
  const { db, dispose } = await createTestDatabase({ migrations: operationMigrations });
  const base = testDeps();
  const events = new InMemoryEventSink();
  const deps = { ...base, db, events };
  return { db, dispose, deps, clock: base.clock, events, ledger: createOperationLedger(deps), leases: createLeaseService(deps) };
}

export function gatewayFor(
  env: Env,
  adapters: SideEffectAdapter<any, any>[],
  options: { ledger?: OperationLedger; pollIntervalMs?: number; dispatchTimeoutMs?: number } = {},
): { gateway: SideEffectGateway; reconciler: Reconciler; registry: AdapterRegistry } {
  const registry = new AdapterRegistry(adapters);
  const deps: GatewayDeps = { ...env.deps, ledger: options.ledger ?? env.ledger, leases: env.leases, adapters: registry, pollIntervalMs: options.pollIntervalMs ?? 5 };
  if (options.dispatchTimeoutMs !== undefined) deps.dispatchTimeoutMs = options.dispatchTimeoutMs;
  return { gateway: createSideEffectGateway(deps), reconciler: createReconciler(deps), registry };
}

export interface Job {
  jobId: string;
  operationId: string;
  name: string;
  desiredStateHash: string;
  state: 'running' | 'done';
  observed: number;
  fence?: number;
}

/** A fake external system (e.g. a load generator) that labels jobs with the operation id. */
export class FakeTarget {
  readonly jobs = new Map<string, Job>();
  /** External side effects actually performed (jobs ever created). */
  created = 0;
  #n = 0;
  create(operationId: string, name: string, desiredStateHash: string, fence?: number): Job {
    this.created++;
    const job: Job = { jobId: `job-${++this.#n}`, operationId, name, desiredStateHash, state: 'running', observed: 0 };
    if (fence !== undefined) job.fence = fence;
    this.jobs.set(operationId, job);
    return job;
  }
}

export type DispatchFault = 'apply_then_throw' | 'throw_before_apply' | 'reject' | 'hang';
/** `hang` never settles and ignores the abort signal (a non-cooperative target client). */
export type ObserveFault = 'uncertain' | 'absent' | 'throw' | 'hang';

export const LOOKUP_CAPS: SideEffectCapabilities = {
  supportsNativeIdempotency: false,
  supportsExternalLookupByOperationId: true,
  supportsFencing: true,
  supportsCompensation: true,
  reconciliationClass: 'deterministic',
  riskClass: 'medium',
};

/** Scriptable SideEffectAdapter over a FakeTarget; counts every call. */
export class FakeAdapter implements SideEffectAdapter<{ name: string }, Job> {
  readonly adapterId: string;
  readonly capabilities: SideEffectCapabilities;
  readonly target: FakeTarget;
  readonly calls = { prepare: 0, dispatch: 0, observe: 0, verify: 0, compensate: 0 };
  /** Consumed one per dispatch call. */
  dispatchFaults: DispatchFault[] = [];
  /** Consumed one per observe call; afterwards the real target state is reported. */
  observeFaults: ObserveFault[] = [];
  /** A job reports `done` from its (n+1)-th observation on. */
  completeAfterObserves = 0;
  verifyFailure: string | undefined;
  compensateFault: 'throw' | 'not_confirmed' | undefined;
  onPrepare: (() => Promise<void> | void) | undefined;
  prepareFault: Error | undefined;
  /** When set, dispatch waits for it before applying (models a slow request still in flight). */
  dispatchGate: Promise<void> | undefined;
  /** When set, compensate waits for it before deleting (models a slow rollback still in flight). */
  compensateGate: Promise<void> | undefined;
  readonly dispatchedFences: Array<number | undefined> = [];

  constructor(options: { adapterId?: string; capabilities?: Partial<SideEffectCapabilities>; target?: FakeTarget } = {}) {
    this.adapterId = options.adapterId ?? 'fake';
    this.capabilities = { ...LOOKUP_CAPS, ...options.capabilities };
    this.target = options.target ?? new FakeTarget();
  }

  async prepare(op: OperationContext, input: { name: string }): Promise<PreparedOperation> {
    this.calls.prepare++;
    if (this.onPrepare) await this.onPrepare();
    if (this.prepareFault) throw this.prepareFault;
    return {
      desiredState: { name: input.name, labels: { 'hypertest-operation-id': op.operation.operationId } },
      desiredStateHash: hashCanonical({ name: input.name }),
      target: { resourceKey: `loadgen/${input.name}`, kind: 'load_job' },
    };
  }

  async dispatch(prepared: PreparedOperation, op: OperationContext): Promise<DispatchReceipt> {
    this.calls.dispatch++;
    this.dispatchedFences.push(op.fencingToken);
    const fault = this.dispatchFaults.shift();
    if (fault === 'throw_before_apply') throw new Error('connection reset before the request reached the target');
    if (fault === 'reject') return { accepted: false, notAppliedReason: 'target quota exceeded' };
    if (fault === 'hang') return new Promise<DispatchReceipt>(() => undefined);
    if (this.dispatchGate) await this.dispatchGate;
    const desired = prepared.desiredState as { name: string };
    const job = this.target.create(op.operation.operationId, desired.name, prepared.desiredStateHash, op.fencingToken);
    if (fault === 'apply_then_throw') throw new Error('socket hang up after the target applied the request');
    return { accepted: true, externalJobId: job.jobId, receipt: `receipt-${job.jobId}` };
  }

  async observe(op: OperationContext): Promise<ObservationResult<Job>> {
    this.calls.observe++;
    const fault = this.observeFaults.shift();
    if (fault === 'throw') throw new Error('target API unavailable');
    if (fault === 'hang') return new Promise<ObservationResult<Job>>(() => undefined);
    if (fault === 'uncertain') return { state: 'uncertain', detail: 'target API answered 503 for the lookup' };
    if (fault === 'absent') return { state: 'absent' };
    const job = this.target.jobs.get(op.operation.operationId);
    if (!job) return { state: 'absent' };
    job.observed++;
    if (job.observed > this.completeAfterObserves) job.state = 'done';
    return { state: 'present', observation: { ...job } };
  }

  async verify(observation: Job, desiredStateHash: string): Promise<VerificationResult> {
    this.calls.verify++;
    if (observation.desiredStateHash !== desiredStateHash) return { status: 'failed', reason: 'observed job does not match the desired state' };
    if (this.verifyFailure) return { status: 'failed', reason: this.verifyFailure };
    if (observation.state !== 'done') return { status: 'pending', progress: { state: observation.state, observed: observation.observed } };
    return { status: 'verified', result: { jobId: observation.jobId, name: observation.name } };
  }

  async compensate(op: OperationContext): Promise<CompensationResult> {
    this.calls.compensate++;
    if (this.compensateGate) await this.compensateGate;
    if (this.compensateFault === 'throw') throw new Error('delete call timed out');
    if (this.compensateFault === 'not_confirmed') return { compensated: false, detail: 'job still terminating' };
    this.target.jobs.delete(op.operation.operationId);
    return { compensated: true, detail: 'job deleted' };
  }
}

/** Fault injection: the first transition to `crashOn` throws as if the worker process died right there. */
export function crashingLedger(inner: OperationLedger, crashOn: OperationStatus): OperationLedger & { crashed: boolean } {
  const wrapper: OperationLedger & { crashed: boolean } = {
    crashed: false,
    prepare: (input, ctx, tx) => inner.prepare(input, ctx, tx),
    get: (id) => inner.get(id),
    findByIdempotencyKey: (key) => inner.findByIdempotencyKey(key),
    findByToolInvocation: (tii, type) => inner.findByToolInvocation(tii, type),
    async transition(id, to, patch, ctx, options) {
      if (to === crashOn && !wrapper.crashed) {
        wrapper.crashed = true;
        throw new Error(`simulated worker crash before persisting ${to}`);
      }
      return inner.transition(id, to, patch, ctx, options);
    },
    list: (filter) => inner.list(filter),
    listUnsettled: (runId) => inner.listUnsettled(runId),
  };
  return wrapper;
}

let invocation = 0;
/** A run request with a fresh, stable toolInvocationId; reuse the object to model a retry. */
export function request(runId: string, overrides: Partial<RunSideEffectRequest<{ name: string }>> = {}): RunSideEffectRequest<{ name: string }> {
  return {
    runId,
    workItemId: `wi-${runId}`,
    agentId: `agent-${runId}`,
    toolInvocationId: `sess-${runId}:turn-1:call-${++invocation}`,
    operationType: 'load.start',
    adapterId: 'fake',
    input: { name: 'job' },
    target: { resourceKey: 'loadgen/job', kind: 'load_job' },
    ctx: eventCtx(runId, { workItemId: `wi-${runId}`, agentId: `agent-${runId}` }),
    signal: new AbortController().signal,
    ...overrides,
  };
}

export function eventTypesFor(env: Env, operationId: string): string[] {
  return env.events.events.filter((e) => e.aggregateId === operationId).map((e) => e.eventType);
}

/** A promise with its resolver, for gating fake adapters deterministically. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Polls the ledger (bounded) until the tool invocation's operation reaches `status`. */
export async function waitForStatus(env: Env, toolInvocationId: string, status: OperationStatus): Promise<OperationRecord> {
  let op = await env.ledger.findByToolInvocation(toolInvocationId);
  for (let i = 0; i < 500 && op?.status !== status; i++) {
    await new Promise((r) => setTimeout(r, 2));
    op = await env.ledger.findByToolInvocation(toolInvocationId);
  }
  if (op?.status !== status) throw new Error(`operation for ${toolInvocationId} never reached ${status} (last: ${op?.status ?? 'none'})`);
  return op;
}
