import type { BaseDeps, JsonValue } from '@hypertest/core';
import type {
  BudgetEnvelope, ContextSnapshot, EventContext, GateSpec, PlanRevision, QualityDecision, ReportClaim, TargetRef, TestRun, WorkItem,
} from '@hypertest/domain';
import type { RoleCatalogLike } from '@hypertest/agents';

/**
 * @hypertest/control — the Hypertest-owned control plane: Lead/Scheduler (control), Blackboard-driven
 * reactors (collaboration), convergence, work execution and the gate/report path.
 *
 * Implementations to export from src/index.ts:
 *   createControlPlane(deps: ControlDeps): ControlPlane        (wires everything below)
 *   validatePlan(input: PlanValidationInput): PlanValidationResult   (pure)
 *   createScheduler(...), createReactorService(...), createConvergenceMonitor(...), createAgentWorker(...),
 *   createDomainTools(deps): ToolSpec[]   (blackboard.*, plan.propose_revision, work.propose, system_model.record,
 *                                          oracle.get|list|propose_change, experiment.define, test_artifact.register|validate,
 *                                          evidence.get|query|claim, delegate, request_approval, complete_work, fail_work)
 *   createReportBuilder(deps): ReportBuilder
 *
 * ControlDeps is intentionally an object of already-constructed services (built by @hypertest/app).
 * The concrete type is declared in src/deps.ts by the control implementation.
 */

export interface StartRunInput {
  goal: string;
  target: TargetRef;
  budget?: Partial<BudgetEnvelope>;
  gate?: Partial<GateSpec>;
  labels?: Record<string, string>;
  /** Oracles established by humans/authorities before the run (agents may only propose changes). */
  oracleIds?: string[];
  runId?: string;
}

export interface PlanValidationInput {
  run: TestRun;
  proposal: Pick<PlanRevision, 'objectives' | 'workItems' | 'cancelWorkItems' | 'readyForGate' | 'rationale'>;
  existingWorkItems: WorkItem[];
  roles: RoleCatalogLike;
  acceptedPlanCount: number;
  proposerRole: string;
}

export interface PlanValidationResult {
  valid: boolean;
  issues: string[];
}

export type ConvergenceState =
  | { state: 'active'; runnable: number; running: number; waiting: number; pendingEvents: number }
  | { state: 'drained'; reason: 'plan_drained' | 'ready_for_gate' }
  | { state: 'stalled'; reason: 'livelock' | 'max_plan_revisions' | 'blocked_dependencies' }
  | { state: 'exhausted'; reason: 'budget' | 'wall_clock' };

export interface TickResult {
  runId: string;
  status: TestRun['status'];
  /** Work items admitted and claimed this tick, ready to execute (leases held by the returned owner). */
  dispatched: Array<{ workItemId: string; ownerId: string; fencingToken: number }>;
  /** Work items waiting on long-running operations to poll. */
  waiting: Array<{ workItemId: string; operationIds: string[] }>;
  replanScheduled: boolean;
  convergence: ConvergenceState;
  /** Set when the run finished this tick (gate evaluated). */
  decision?: QualityDecision;
  final: boolean;
  /** Suggested delay before the next tick when nothing is runnable. */
  idleMs: number;
}

export type TurnOutcome =
  | { status: 'continue'; workItemId: string; turn: number }
  | { status: 'waiting'; workItemId: string; operationIds: string[] }
  | { status: 'completed' | 'failed' | 'cancelled'; workItemId: string }
  | { status: 'paused'; workItemId: string; reason: string }
  | { status: 'lease_lost'; workItemId: string };

export interface RunReport {
  runId: string;
  goal: string;
  verdict: QualityDecision['verdict'] | 'pending';
  decision?: QualityDecision;
  claims: ReportClaim[];
  findings: Array<{ recordId: string; title: string; severity: string; status: string; evidenceRefs: string[] }>;
  risks: Array<{ recordId: string; title: string; level: string; status: string }>;
  plans: Array<{ revision: number; status: string; rationale: string; workItems: number }>;
  workItems: Array<{ workItemId: string; role: string; title: string; state: string }>;
  models: Array<{ role: string; routeId: string; provider: string; turns: number }>;
  evidence: { count: number; rootHash: string; sealed: boolean };
  recovery: Array<{ at: string; detail: string }>;
  markdown: string;
  json: JsonValue;
}

export interface ReportBuilder {
  build(runId: string): Promise<RunReport>;
}

/** Facade used by the durable runtimes (Temporal activities call exactly these). */
export interface ControlPlane {
  startRun(input: StartRunInput, ctx?: Partial<EventContext>): Promise<TestRun>;
  /** One scheduling step: reactors catch-up, plan application, replan triggers, admission, convergence, gate. */
  tick(runId: string): Promise<TickResult>;
  /**
   * Executes one agent turn for a dispatched work item (idempotent per turn). `options` is additive:
   * `expectedTurn` makes a durable retry return `{status:'continue', turn}` without running when the session
   * already completed that turn (crash after a committed turn).
   */
  executeTurn(workItemId: string, fencingToken: number, signal?: AbortSignal, options?: ExecuteTurnOptions): Promise<TurnOutcome>;
  /** Polls long-running operations for a waiting work item; resumes it when all settled. */
  observeWaiting(workItemId: string, signal?: AbortSignal): Promise<TurnOutcome>;
  /** Startup recovery: reconcile operations, expire stale leases, requeue orphaned work. */
  recover(runId: string, signal?: AbortSignal): Promise<{ reconciled: number; requeued: string[] }>;
  cancelRun(runId: string, reason: string): Promise<void>;
  pauseRun(runId: string, reason: TestRun['pauseReason']): Promise<void>;
  resumeRun(runId: string): Promise<void>;
  snapshot(runId: string): Promise<ContextSnapshot>;
  report(runId: string): Promise<RunReport>;
  readonly deps: BaseDeps;
  /** (additive, optional) Releases process resources (e.g. the reactors' bus subscription). */
  close?(): Promise<void>;
}

/** (additive) Options of ControlPlane.executeTurn. */
export interface ExecuteTurnOptions {
  /** The turn the caller is about to run; an already committed turn ≥ expectedTurn is not run again. */
  expectedTurn?: number;
}
