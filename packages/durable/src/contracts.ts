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
  /** Wake the run loop (new events, approvals) or cancel it. */
  signal(runId: string, signal: { type: 'wake' } | { type: 'cancel'; reason: string }): Promise<void>;
  awaitCompletion(runId: string, options?: { timeoutMs?: number }): Promise<RunOutcome>;
  /** Resumes every non-terminal run (called on process start). Returns resumed run ids. */
  resumeIncomplete(): Promise<string[]>;
  shutdown(): Promise<void>;
}

export interface LocalDurableOptions {
  control: ControlPlane;
  listRuns: () => Promise<TestRun[]>;
  maxConcurrentTurns: number;
  /** Upper bound for idle waits between ticks. */
  maxIdleMs?: number;
}

export interface TemporalDurableOptions {
  control: ControlPlane;
  listRuns: () => Promise<TestRun[]>;
  address: string;
  namespace?: string;
  taskQueue?: string;
  workerMode?: 'embedded' | 'external';
  maxConcurrentActivities?: number;
}
