import { fileURLToPath } from 'node:url';
import { HypertestError, type ErrorCode, type Logger } from '@hypertest/core';
import type { TestRun } from '@hypertest/domain';
import type { ControlPlane } from '@hypertest/control';
import type { Client, Connection } from '@temporalio/client';
import type { NativeConnection, Worker } from '@temporalio/worker';
import type { DurableRuntime, RunOutcome, TemporalDurableOptions, TemporalWorkerHandle, TemporalWorkerOptions, TemporalWorkflowBundle } from '../contracts.ts';
import { errorMessage, isErrorCode } from '../errors.ts';
import { RESUMABLE_RUN_STATUSES, isTerminalRunStatus, outcomeOf } from '../local.ts';
import { createTemporalActivities } from './activities.ts';
import { DEFAULT_MAX_WORKFLOW_ITERATIONS, DEFAULT_WORKFLOW_MAX_IDLE_MS, cancelSignal, runWorkflowId, wakeSignal, type TestRunWorkflowState, type testRunWorkflow } from './workflows.ts';

export const DEFAULT_TEMPORAL_NAMESPACE = 'default';
export const DEFAULT_TEMPORAL_TASK_QUEUE = 'hypertest';
/** Absolute path of the workflow module the worker bundles. */
export const TEMPORAL_WORKFLOWS_PATH = fileURLToPath(new URL('./workflows.ts', import.meta.url));

type ClientModule = typeof import('@temporalio/client');
type WorkerModule = typeof import('@temporalio/worker');

// The Temporal SDK (gRPC client, native core bridge) loads on first use only: a local-durable process never pays for it.
let clientModule: Promise<ClientModule> | undefined;
let workerModule: Promise<WorkerModule> | undefined;
const loadClient = (): Promise<ClientModule> => (clientModule ??= import('@temporalio/client'));
const loadWorker = (): Promise<WorkerModule> => (workerModule ??= import('@temporalio/worker'));

let runtimeInstalled = false;
let logSink: Logger | undefined;

/**
 * The Temporal Runtime is process-global (SDK logs, telemetry, signal handling). Installed once by this package (the
 * only one allowed to use Temporal): SDK warnings/errors go to the Hypertest Logger of the latest worker, and the SDK
 * does NOT hijack SIGINT/SIGTERM (the host process owns its signals).
 */
function installRuntime(worker: WorkerModule, logger: Logger): void {
  logSink = logger;
  if (runtimeInstalled) return;
  runtimeInstalled = true;
  try {
    worker.Runtime.install({
      logger: new worker.DefaultLogger('WARN', (entry) => {
        const fields: Record<string, unknown> = { component: 'temporal-sdk', ...(entry.meta ?? {}) };
        if (entry.level === 'ERROR') logSink?.error(entry.message, fields);
        else logSink?.warn(entry.message, fields);
      }),
      // native (Rust core) logs are forwarded to the same logger instead of the console
      telemetryOptions: { logging: { filter: { core: 'WARN', other: 'ERROR' }, forward: {} } },
      shutdownSignals: [],
    });
  } catch {
    // a Runtime was already instantiated by the host: keep it
  }
}

/** Bundles src/temporal/workflows.ts once (webpack + swc); pass the result as `workflowBundle` to skip it at start. */
export async function bundleTemporalWorkflows(options: { logger?: Logger } = {}): Promise<{ code: string }> {
  const w = await loadWorker();
  const sink = options.logger;
  const { code } = await w.bundleWorkflowCode({
    workflowsPath: TEMPORAL_WORKFLOWS_PATH,
    logger: new w.DefaultLogger('WARN', (entry) => {
      if (entry.level === 'ERROR') sink?.error(entry.message, { component: 'temporal-bundler' });
      else sink?.warn(entry.message, { component: 'temporal-bundler' });
    }),
  });
  return { code };
}

/**
 * A failed run workflow as a HypertestError: the code of the innermost ApplicationFailure whose type is a Hypertest
 * error code (e.g. a non-retryable tick fault), else `internal`.
 */
function workflowFault(e: unknown, runId: string): HypertestError {
  let code: ErrorCode = 'internal';
  let message = errorMessage(e);
  let cur: unknown = e;
  for (let depth = 0; depth < 16 && cur instanceof Error; depth++) {
    const type = (cur as { type?: unknown }).type;
    if (isErrorCode(type)) {
      code = type;
      message = cur.message;
    }
    cur = cur.cause;
  }
  return new HypertestError(code, `the workflow of run ${runId} failed: ${message}`, { cause: e, details: { runId, workflowId: runWorkflowId(runId) } });
}

function validateAddress(address: unknown, what: string): string {
  if (typeof address !== 'string' || address.trim() === '') throw new HypertestError('invalid_argument', `${what}: address is required (host:port of the Temporal frontend)`);
  return address;
}

/**
 * Starts a Temporal worker in this process: polls `taskQueue` for the Hypertest workflows and the activities bound
 * to `control`. Used by TemporalDurableRuntime (workerMode 'embedded') and by `hypertest worker`.
 */
export async function createTemporalWorker(options: TemporalWorkerOptions): Promise<TemporalWorkerHandle> {
  if (!options?.control) throw new HypertestError('invalid_argument', 'createTemporalWorker: control is required');
  const address = validateAddress(options.address, 'createTemporalWorker');
  const max = options.maxConcurrentActivities;
  if (max !== undefined && (!Number.isSafeInteger(max) || max < 1)) throw new HypertestError('invalid_argument', `createTemporalWorker: maxConcurrentActivities must be an integer ≥ 1 (got ${String(max)})`);
  const taskQueue = options.taskQueue ?? DEFAULT_TEMPORAL_TASK_QUEUE;
  const logger = (options.logger ?? options.control.deps.logger).child({ component: 'durable.temporal.worker', taskQueue });
  const w = await loadWorker();
  installRuntime(w, logger);
  let connection: NativeConnection;
  try {
    connection = await w.NativeConnection.connect({ address });
  } catch (e) {
    throw new HypertestError('unavailable', `Temporal frontend ${address} unreachable: ${errorMessage(e)}`, { cause: e });
  }
  let worker: Worker;
  try {
    const activities = createTemporalActivities(options.control, options.resolveClaim ? { resolveClaim: options.resolveClaim } : {});
    const bundle: TemporalWorkflowBundle | undefined = options.workflowBundle;
    worker = await w.Worker.create({
      connection,
      namespace: options.namespace ?? DEFAULT_TEMPORAL_NAMESPACE,
      taskQueue,
      activities,
      ...(bundle ? { workflowBundle: bundle } : { workflowsPath: TEMPORAL_WORKFLOWS_PATH }),
      ...(max !== undefined ? { maxConcurrentActivityTaskExecutions: max } : {}),
    });
  } catch (e) {
    await connection.close().catch(() => undefined);
    throw e;
  }
  const done = worker.run().finally(() => connection.close().catch(() => undefined));
  done.catch((e: unknown) => logger.error('Temporal worker stopped with an error', { error: errorMessage(e) }));
  logger.info('Temporal worker started', { address });
  let stopping: Promise<void> | undefined;
  return {
    taskQueue,
    done,
    shutdown() {
      stopping ??= (async () => {
        if (worker.getState() === 'RUNNING') worker.shutdown();
        await done.catch(() => undefined);
        logger.info('Temporal worker stopped');
      })();
      return stopping;
    },
  };
}

/**
 * Durable runtime on Temporal: one `testRunWorkflow` per run (workflow id `run-<runId>`, started idempotently), one
 * `workItemWorkflow` child per claim. The worker runs in-process (workerMode 'embedded', default) or elsewhere
 * ('external', e.g. `hypertest worker`). Connections are opened lazily (or by `start()`).
 */
export class TemporalDurableRuntime implements DurableRuntime {
  readonly kind = 'temporal' as const;
  readonly #options: TemporalDurableOptions;
  readonly #control: ControlPlane;
  readonly #logger: Logger;
  readonly #namespace: string;
  readonly #taskQueue: string;
  readonly #maxIterations: number;
  readonly #maxIdleMs: number;
  readonly #getRun: (runId: string) => Promise<TestRun | undefined>;
  readonly #closed = new AbortController();
  #ready: Promise<{ client: Client; connection: Connection; worker?: TemporalWorkerHandle }> | undefined;
  #shutdown: Promise<void> | undefined;

  constructor(options: TemporalDurableOptions) {
    if (!options || typeof options !== 'object' || !options.control) throw new HypertestError('invalid_argument', 'TemporalDurableRuntime: control is required');
    if (typeof options.listRuns !== 'function') throw new HypertestError('invalid_argument', 'TemporalDurableRuntime: listRuns is required');
    validateAddress(options.address, 'TemporalDurableRuntime');
    if (options.workerMode !== undefined && options.workerMode !== 'embedded' && options.workerMode !== 'external') {
      throw new HypertestError('invalid_argument', `TemporalDurableRuntime: workerMode must be 'embedded' or 'external' (got ${String(options.workerMode)})`);
    }
    const maxIterations = options.maxWorkflowIterations ?? DEFAULT_MAX_WORKFLOW_ITERATIONS;
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) throw new HypertestError('invalid_argument', `TemporalDurableRuntime: maxWorkflowIterations must be an integer ≥ 1 (got ${String(options.maxWorkflowIterations)})`);
    const max = options.maxConcurrentActivities;
    if (max !== undefined && (!Number.isSafeInteger(max) || max < 1)) throw new HypertestError('invalid_argument', `TemporalDurableRuntime: maxConcurrentActivities must be an integer ≥ 1 (got ${String(max)})`);
    const maxIdleMs = options.maxIdleMs ?? DEFAULT_WORKFLOW_MAX_IDLE_MS;
    if (!Number.isSafeInteger(maxIdleMs) || maxIdleMs < 1) throw new HypertestError('invalid_argument', `TemporalDurableRuntime: maxIdleMs must be an integer ≥ 1 (got ${String(options.maxIdleMs)})`);
    const turnTimeoutMs = options.turnTimeoutMs;
    if (turnTimeoutMs !== undefined && (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1000)) {
      throw new HypertestError('invalid_argument', `TemporalDurableRuntime: turnTimeoutMs must be an integer ≥ 1000 (got ${String(turnTimeoutMs)})`);
    }
    this.#options = options;
    this.#maxIdleMs = maxIdleMs;
    this.#control = options.control;
    this.#namespace = options.namespace ?? DEFAULT_TEMPORAL_NAMESPACE;
    this.#taskQueue = options.taskQueue ?? DEFAULT_TEMPORAL_TASK_QUEUE;
    this.#maxIterations = maxIterations;
    this.#logger = (options.logger ?? options.control.deps.logger).child({ component: 'durable.temporal', taskQueue: this.#taskQueue });
    const listRuns = options.listRuns;
    this.#getRun = options.getRun ?? (async (runId) => (await listRuns()).find((r) => r.runId === runId));
  }

  get taskQueue(): string {
    return this.#taskQueue;
  }

  /** (additive) Connects the client and starts the embedded worker now (otherwise done by the first call). */
  async start(): Promise<void> {
    await this.#init();
  }

  async startRun(runId: string): Promise<void> {
    if (typeof runId !== 'string' || runId.length === 0) throw new HypertestError('invalid_argument', 'startRun: runId must be a non-empty string');
    const { client } = await this.#init();
    const c = await loadClient();
    const state: TestRunWorkflowState = {};
    if (this.#maxIterations !== DEFAULT_MAX_WORKFLOW_ITERATIONS) state.maxIterations = this.#maxIterations;
    if (this.#maxIdleMs !== DEFAULT_WORKFLOW_MAX_IDLE_MS) state.maxIdleMs = this.#maxIdleMs;
    if (this.#options.turnTimeoutMs !== undefined) state.turnTimeoutMs = this.#options.turnTimeoutMs;
    try {
      await client.workflow.start<typeof testRunWorkflow>('testRunWorkflow', {
        workflowId: runWorkflowId(runId),
        taskQueue: this.#taskQueue,
        args: [runId, state],
        workflowIdReusePolicy: c.WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      });
      this.#logger.info('run workflow started', { runId, workflowId: runWorkflowId(runId) });
    } catch (e) {
      // idempotent: a running (or completed) workflow of this run is the one driving it
      if (e instanceof c.WorkflowExecutionAlreadyStartedError) return;
      throw new HypertestError('unavailable', `could not start the workflow of run ${runId}: ${errorMessage(e)}`, { cause: e, details: { runId } });
    }
  }

  async signal(runId: string, signal: { type: 'wake' } | { type: 'cancel'; reason: string }): Promise<void> {
    if (typeof runId !== 'string' || runId.length === 0) throw new HypertestError('invalid_argument', 'signal: runId must be a non-empty string');
    if (signal?.type !== 'wake' && signal?.type !== 'cancel') throw new HypertestError('invalid_argument', `signal: unknown signal type ${JSON.stringify((signal as { type?: unknown } | undefined)?.type)}`);
    if (signal.type === 'cancel' && (typeof signal.reason !== 'string' || signal.reason.trim() === '')) throw new HypertestError('invalid_argument', 'signal cancel: reason is required');
    const { client } = await this.#init();
    const c = await loadClient();
    const handle = client.workflow.getHandle(runWorkflowId(runId));
    try {
      if (signal.type === 'wake') await handle.signal(wakeSignal);
      else await handle.signal(cancelSignal, signal.reason);
    } catch (e) {
      if (!(e instanceof c.WorkflowNotFoundError)) throw new HypertestError('unavailable', `could not signal run ${runId}: ${errorMessage(e)}`, { cause: e, details: { runId } });
      // no running workflow (finished, or never started here): a cancel still goes to the control plane (the authority)
      if (signal.type === 'cancel') await this.#control.cancelRun(runId, signal.reason);
    }
  }

  async awaitCompletion(runId: string, options: { timeoutMs?: number } = {}): Promise<RunOutcome> {
    if (typeof runId !== 'string' || runId.length === 0) throw new HypertestError('invalid_argument', 'awaitCompletion: runId must be a non-empty string');
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs >= 0)) throw new HypertestError('invalid_argument', `awaitCompletion: timeoutMs must be ≥ 0 (got ${String(timeoutMs)})`);
    const { client } = await this.#init();
    const c = await loadClient();
    const ctrl = new AbortController();
    const signal = AbortSignal.any([this.#closed.signal, ctrl.signal]);
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, timeoutMs);
    }
    try {
      const handle = client.workflow.getHandle<typeof testRunWorkflow>(runWorkflowId(runId));
      return await client.withAbortSignal(signal, () => handle.result());
    } catch (e) {
      if (timedOut) throw new HypertestError('timeout', `run ${runId} did not complete within ${timeoutMs}ms`, { details: { runId } });
      if (this.#closed.signal.aborted) throw new HypertestError('cancelled', `awaitCompletion(${runId}) aborted: the durable runtime shut down`, { details: { runId } });
      if (e instanceof c.WorkflowNotFoundError) {
        // no workflow for this run: a run finished elsewhere (or before this runtime) still has an outcome
        const run = await this.#getRun(runId);
        if (!run) throw new HypertestError('not_found', `run ${runId} not found`, { details: { runId } });
        if (isTerminalRunStatus(run.status)) {
          const r = await this.#control.tick(runId);
          return r.final ? outcomeOf(r) : { runId, status: run.status };
        }
        throw new HypertestError('not_found', `run ${runId} (${run.status}) has no workflow; startRun or resumeIncomplete drives it`, { details: { runId } });
      }
      throw workflowFault(e, runId);
    } finally {
      if (timer) clearTimeout(timer);
      ctrl.abort();
    }
  }

  async resumeIncomplete(): Promise<string[]> {
    const resumable = new Set<string>(RESUMABLE_RUN_STATUSES);
    const ids = (await this.#options.listRuns()).filter((r) => resumable.has(r.status)).map((r) => r.runId);
    for (const runId of ids) await this.startRun(runId); // idempotent per workflow id
    if (ids.length > 0) this.#logger.info('resumed incomplete runs', { runs: ids });
    return ids;
  }

  shutdown(): Promise<void> {
    this.#shutdown ??= (async () => {
      this.#closed.abort();
      const ready = this.#ready;
      if (!ready) return;
      const r = await ready.catch(() => undefined);
      if (!r) return;
      await r.worker?.shutdown();
      await r.connection.close().catch(() => undefined);
    })();
    return this.#shutdown;
  }

  #init(): Promise<{ client: Client; connection: Connection; worker?: TemporalWorkerHandle }> {
    if (this.#closed.signal.aborted) return Promise.reject(new HypertestError('precondition_failed', 'the Temporal durable runtime is shut down'));
    this.#ready ??= (async () => {
      const c = await loadClient();
      const address = this.#options.address;
      let connection: Connection;
      try {
        connection = await c.Connection.connect({ address });
      } catch (e) {
        throw new HypertestError('unavailable', `Temporal frontend ${address} unreachable: ${errorMessage(e)}`, { cause: e });
      }
      const client = new c.Client({ connection, namespace: this.#namespace });
      if ((this.#options.workerMode ?? 'embedded') === 'external') return { client, connection };
      try {
        const o = this.#options;
        const workerOptions: TemporalWorkerOptions = { control: o.control, address, namespace: this.#namespace, taskQueue: this.#taskQueue, logger: this.#logger };
        if (o.maxConcurrentActivities !== undefined) workerOptions.maxConcurrentActivities = o.maxConcurrentActivities;
        if (o.workflowBundle) workerOptions.workflowBundle = o.workflowBundle;
        if (o.resolveClaim) workerOptions.resolveClaim = o.resolveClaim;
        const worker = await createTemporalWorker(workerOptions);
        return { client, connection, worker };
      } catch (e) {
        await connection.close().catch(() => undefined);
        throw e;
      }
    })();
    const ready = this.#ready;
    ready.catch(() => {
      if (this.#ready === ready) this.#ready = undefined; // a failed connect may be retried by the next call
    });
    return ready;
  }
}
