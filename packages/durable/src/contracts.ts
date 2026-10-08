import type { Logger } from '@hypertest/core';
import type { QualityDecision, TestRun } from '@hypertest/domain';
import type { ControlPlane } from '@hypertest/control';

/**
 * @hypertest/durable — Durable Execution. Temporal owns "how accepted work survives failure"; the
 * control plane owns "what should happen next"; SQL owns domain truth (no duplicate business state in
 * Temporal history). Workflow code is deterministic: no LLM, I/O, Date.now or randomness — only
 * activity calls, timers and signals.
 *
 * Implementations to export from src/index.ts:
 *   class LocalDurableRuntime implements DurableRuntime     (in-process loop; crash-safe because every step is
 *                                                            persisted; resumeIncomplete() on startup)
 *   class TemporalDurableRuntime implements DurableRuntime  ({ address, namespace, taskQueue, control }; starts a Worker
 *                                                            in-process unless workerMode = 'external')
 *   createTemporalActivities(control: ControlPlane)         (tick, executeTurn, observeWaiting, recover)
 *   workflows (src/temporal/workflows.ts): testRunWorkflow(runId), workItemWorkflow({ workItemId, fencingToken })
 *     - testRunWorkflow: recover → loop { tick; start workItemWorkflow children for dispatched items; wait for
 *       signal `wake` / child completion / timer(idleMs) } until final. Signals: wake, cancel.
 *     - workItemWorkflow: loop executeTurn (activity; retry policy with non-retryable stale_fence/permission errors)
 *       → on waiting: sleep + observeWaiting until resumed → until terminal; then signal parent `wake`.
 *     - continueAsNew after N iterations to bound history.
 */
export interface RunOutcome {
  runId: string;
  status: TestRun['status'];
  decision?: QualityDecision;
}

export interface DurableRuntime {
  readonly kind: 'local' | 'temporal';
  startRun(runId: string): Promise<void>;
  /**
   * Wake the run loop (new events), cancel it, or (additive, E[8]) deliver an ApprovalSignal: a human decided approval
   * `approvalId` — the run loop wakes and every work item waiting on an approval observes it at once (local: the observe
   * loops are pulsed; Temporal: the run workflow forwards the signal to its child workflows, which stop their backoff).
   */
  signal(runId: string, signal: DurableSignal): Promise<void>;
  awaitCompletion(runId: string, options?: { timeoutMs?: number }): Promise<RunOutcome>;
  /** Resumes every non-terminal run (called on process start). Returns resumed run ids. */
  resumeIncomplete(): Promise<string[]>;
  shutdown(): Promise<void>;
}

/** The signals of a run: wake, cancel, (additive, E[8]) approval decided. */
export type DurableSignal = { type: 'wake' } | { type: 'cancel'; reason: string } | { type: 'approval'; approvalId: string };

/**
 * (additive) Hooks shared by both runtimes. All optional: a runtime works with `control` + `listRuns` alone.
 */
export interface DurableHooks {
  /**
   * (additive) Point lookup of one run (awaitCompletion fallback polling). Default: `listRuns()` filtered by id — supply
   * it when `listRuns` returns only the non-terminal runs (a finished run would otherwise read as not_found).
   */
  getRun?: (runId: string) => Promise<TestRun | undefined>;
  /**
   * (additive) The fencing token of the claim THIS worker (the control plane's `workerId`) holds on a work item, or
   * undefined when it holds none. `observeWaiting` re-takes the claim of a waiting item after a restart or a lapsed
   * lease (new fencing token) but does not return the token; with this hook the runtime continues such an item at
   * once. Without it the item resumes through the scheduler (lease expiry ⇒ requeue ⇒ dispatch, one work attempt).
   * It MUST check the claim owner: a token held by another worker would bypass fencing.
   */
  resolveClaim?: (workItemId: string) => Promise<number | undefined>;
  /** (additive) Logger (default: `control.deps.logger`). */
  logger?: Logger;
}

export interface LocalDurableOptions extends DurableHooks {
  control: ControlPlane;
  listRuns: () => Promise<TestRun[]>;
  maxConcurrentTurns: number;
  /** Upper bound for idle waits between ticks. */
  maxIdleMs?: number;
  /**
   * (additive) Attempts of one control call (tick, recover, executeTurn, observeWaiting) on a retryable fault before
   * the loop gives up (default 5, as the Temporal activity retry policy). executeTurn retries carry `expectedTurn`.
   */
  maxAttempts?: number;
  /**
   * (additive, H6) Interval at which a work loop waiting for a free turn slot keeps its claim alive through
   * `ControlPlane.renewClaim` (default 10000 ms; keep it well below the control plane's lease TTL). Ticks also hand out
   * claims only up to the free turn slots (`TickOptions.maxDispatch`).
   */
  claimKeepaliveMs?: number;
}

export interface TemporalDurableOptions extends DurableHooks {
  control: ControlPlane;
  listRuns: () => Promise<TestRun[]>;
  address: string;
  namespace?: string;
  taskQueue?: string;
  workerMode?: 'embedded' | 'external';
  maxConcurrentActivities?: number;
  /** (additive) A prebuilt workflow bundle (`bundleTemporalWorkflows()`): the worker skips webpack at start. */
  workflowBundle?: TemporalWorkflowBundle;
  /** (additive) Loop iterations of a workflow run before `continueAsNew` bounds its history (default 200). */
  maxWorkflowIterations?: number;
  /**
   * (additive) Upper bound of the run workflow's idle wait between ticks, and the interval at which it retries `recover`
   * while another live worker owns the run (standby) — as `LocalDurableOptions.maxIdleMs` (default 5000).
   */
  maxIdleMs?: number;
  /**
   * (additive, durability-5) Start-to-close bound of ONE agent-turn activity attempt (default 24 h: a turn may run tools
   * for hours — test.run ≤ 1 h, mutation.run ≤ 2 h each). Liveness is the activity heartbeat (1 min timeout), not this
   * bound; set it below the longest tool timeout and healthy turns can never complete.
   */
  turnTimeoutMs?: number;
}

/** (additive) A bundled `src/temporal/workflows.ts` (code in memory or a file path). */
export type TemporalWorkflowBundle = { code: string } | { codePath: string };

/** (additive) Options of a standalone Temporal worker (`hypertest worker`, or the embedded worker of the runtime). */
export interface TemporalWorkerOptions {
  control: ControlPlane;
  address: string;
  namespace?: string;
  taskQueue?: string;
  maxConcurrentActivities?: number;
  workflowBundle?: TemporalWorkflowBundle;
  resolveClaim?: (workItemId: string) => Promise<number | undefined>;
  logger?: Logger;
}

/** (additive) A running Temporal worker. */
export interface TemporalWorkerHandle {
  readonly taskQueue: string;
  /** Settles when the worker stopped (rejects when it crashed). */
  readonly done: Promise<void>;
  /** Stops polling, cancels in-flight activities (their turns replay on the next attempt) and closes the connection. */
  shutdown(): Promise<void>;
}
