import type { JsonValue, Logger } from '@hypertest/core';
import type {
  BlackboardRecord, BudgetEnvelope, DomainEvent, EvidenceRecord, Finding, GateSpec, OperationRecord, PlanRevision, QualityDecision, QualityVerdict, RuntimeManifest, TargetRef, TestRun,
  WorkItem,
} from '@hypertest/domain';
import type { ScriptedBrain } from '@hypertest/model';
import type { Hypertest, HypertestConfig, HypertestInstance } from '@hypertest/app';
import type { EnvironmentDescriptor } from '@hypertest/tools';
import type { RunReport, StartRunInput } from '@hypertest/control';
import type { EvidenceVerification } from '@hypertest/evidence';
import type { OracleGovernance, PolicyDecisionRecord } from '@hypertest/policy';

/**
 * @hypertest/eval — the long-lived Eval Platform. Outcome graders first (environment state,
 * deterministic oracles, evidence consistency), LLM rubric last; multiple trials; paired comparisons.
 *
 * Implementations to export from src/index.ts:
 *   runTrial(task: EvalTask, arm: EvalArm, options: TrialOptions): Promise<EvalTrial>
 *   runSuite(suite: EvalSuite, options: SuiteOptions): Promise<SuiteResult>
 *   stats: mcnemarExact(b: number, c: number): number; pairedBootstrapCI(diffs, { iterations, alpha, seed }): { mean, lo, hi };
 *          passAtK(results, k), passHatK(results, k)
 *   graders: verdictGrader, defectDetectedGrader, noDuplicateSideEffectsGrader, evidenceCompletenessGrader,
 *            evidenceIntegrityGrader, policyViolationGrader, auditReconstructionGrader, planDynamicsGrader
 *   suites: pocAWhiteboxSuite(), pocBEventDrivenSuite(), pocCDurableLoadSuite(), oracleRobustnessSuite(), recoveryChaosSuite()
 *   renderSuiteReport(result): string (markdown)
 *   (additive) Grader = (ctx: GraderContext) => GraderResult; resolveGrader(spec, extra?), GRADERS, createPlanDynamicsGrader,
 *   outcomeMetrics/trajectoryMetrics, summarizeSuite, collectTrialData/runProbes, the trial child
 *   (src/trial-child.ts: TrialChildJob → progress JSON lines → exit code) with spawnTrialChild/runChildTrial (kill/restart
 *   helper for chaos plans), scripted-brain helpers (roleRouter, viewOf, toolCall, withModelTimeoutInjection), mulberry32.
 *   (additive, review) the trial result rules decideTrialResult / unexercisedChaos / chaosProblems / childExitProblem,
 *   hintProblems, RELEASE_VERDICTS.
 *   (additive, PoC suites) the PoC task factories (pocATask, pocBTask, pocCTask, pocCInsufficientTask, oracleRobustnessTask,
 *   recoveryChaosTask) and pocAllSuite(), the arms (scriptedMultiLlmArm, scriptedSingleArm, liveArm, liveArmAvailable,
 *   POC_ARMS, builtinArms), the scripted PoC brains (pocBrains; pocChildBrains: child-process brains export), the fixtures
 *   (createLedgerRepo, startBankApi, startKvService: supervisor in its own process; killLoadWorkers/isLoadWorker), the PoC graders (pocAWorkflow,
 *   pocBWorkflow, pocCWorkflow, causalChain, singleLeaseOwner, noOrphanOperations, loadJobReattached, recoveryAudit,
 *   offloadBounded, modelFallback, contextIsolation, independentReview, reportTracesToEvidence, testChangeGoverned,
 *   insufficientDataNotPassed) and establishOracles / killPointProblems / KILL_POINT_STATES.
 */
export interface HiddenFault {
  faultId: string;
  description: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  /** Keywords/paths the finding must reference to count as detected. */
  detectionHints: string[];
}

export interface TrialFixture {
  target: TargetRef;
  environments?: EnvironmentDescriptor[];
  /** Ground-truth probes run after the trial (environment state checkers). */
  probes?: Record<string, () => Promise<JsonValue>>;
  cleanup(): Promise<void>;
  /**
   * (additive) JSON the fixture hands to the arm's brains (in-process: `arm.brains(task, fixture)` reads it; child-process:
   * `ChildArmSpec.args(task, fixture)` forwards it), e.g. the path of the brains' observation log inside the trial
   * directory. Never secrets: brains see what a model sees.
   */
  brainArgs?: JsonValue;
}

/** (additive) An oracle established by a human authority before the run (the input of OracleGovernance.establish). */
export type EvalOracle = Parameters<OracleGovernance['establish']>[0];

/**
 * (additive) A point at which a chaos plan kills the Hypertest process: right after the `nth` distinct operation (of
 * `operationType`, when given) reached the state `after` — counted over the whole trial (every child's L0 progress).
 * `dispatched` = the dispatch is in flight (no receipt yet), `acknowledged` = the external job runs, `verified` = its
 * effect was observed.
 */
export interface KillPoint {
  after: 'dispatched' | 'acknowledged' | 'verified';
  operationType?: string;
  /** Default 1. */
  nth?: number;
  /**
   * Kill this many ms after the point was reached (default 0: at once). E.g. `dispatched` + a delay shorter than the
   * external call lands the kill while the request is in flight at the external system (an unknown outcome).
   */
  delayMs?: number;
  /**
   * (additive) How long Hypertest stays down after this kill before the resumed process starts (default 0). The external
   * world moves on meanwhile: e.g. an in-flight restart completes, so the recovery finds it done (and moves the
   * environment's generation on) before the interrupted turn is replayed.
   */
  downtimeMs?: number;
}

export interface TrialContext {
  workDir: string;
  seed: string;
  trial: number;
}

/**
 * Faults a trial injects. Every numeric field is a positive integer (checked before any environment exists). A planned
 * fault that never happened (see `unexercisedChaos`) leaves recovery from it unconfirmed: such a trial is `infra_error`
 * when every grader passed, and stays `fail` when a grader failed (an infra error never hides a failing arm).
 */
export interface ChaosPlan {
  /**
   * Kill the Hypertest instance after the Nth dispatched operation (distinct operations: a re-dispatch of the same
   * operation is not the next one), then restart and resume.
   */
  killAfterOperationDispatch?: number;
  /** The Nth model call of the trial fails with a provider timeout (child-process trials: the Nth call of the first child). */
  injectModelTimeoutOnCall?: number;
  duplicateEventDelivery?: boolean;
  /** The task's fixture/brains produce a tool output of at least this many bytes; the harness checks that an evidence artifact that large exists. */
  largeOutputBytes?: number;
  /**
   * (additive) Kill points, in order: at each one the Hypertest process is killed (child-process: SIGKILL; in-process:
   * closed mid-run) and a new one resumes the run over the same data directory. Applied after
   * `killAfterOperationDispatch` (when both are set). A point that is never reached leaves the plan unexercised.
   */
  kills?: KillPoint[];
}

export interface EvalTask {
  taskId: string;
  suiteRevision: string;
  title: string;
  goal: string;
  setup(ctx: TrialContext): Promise<TrialFixture>;
  hiddenFaults: HiddenFault[];
  expectedVerdict: QualityVerdict | QualityVerdict[];
  budget?: Partial<BudgetEnvelope>;
  chaos?: ChaosPlan;
  graders: string[];
  /** (additive) Gate overrides of the run (StartRunInput.gate), e.g. the evidence type a black-box task requires. */
  gate?: Partial<GateSpec>;
  /**
   * (additive) Oracles a human authority (`eval:oracle-authority`) establishes before the run; the run pins their current
   * revisions (StartRunInput.oracleIds). Agents can only propose changes to them.
   */
  oracles?: EvalOracle[];
}

export interface EvalArm {
  armId: string;
  description: string;
  config: (base: HypertestConfig, ctx: TrialContext) => HypertestConfig;
  brains?: (task: EvalTask, fixture: TrialFixture) => Record<string, ScriptedBrain>;
  /** (additive) Child-process support: where a trial child loads its brains from. */
  child?: ChildArmSpec;
}

export interface GraderResult {
  graderId: string;
  pass: boolean;
  score: number;
  detail: string;
}

export interface EvalTrial {
  taskId: string;
  armId: string;
  trial: number;
  seed: string;
  result: 'pass' | 'fail' | 'infra_error';
  verdict?: QualityVerdict;
  runId?: string;
  runtimeManifestId?: string;
  evidenceRootHash?: string;
  graders: GraderResult[];
  outcomeMetrics: Record<string, number>;
  trajectoryMetrics: Record<string, number>;
  durationMs: number;
  error?: string;
}

export interface EvalSuite {
  suiteId: string;
  revision: string;
  tasks: EvalTask[];
}

export interface TrialOptions extends HarnessOptions {
  workDir: string;
  trial: number;
  seed: string;
  baseConfig?: HypertestConfig;
  timeoutMs?: number;
}

export interface SuiteOptions extends HarnessOptions {
  arms: EvalArm[];
  trials: number;
  workDir: string;
  baseConfig?: HypertestConfig;
  timeoutMs?: number;
  /** (additive) Called after every trial (e.g. CLI progress output). */
  onTrial?: (trial: EvalTrial) => void;
}

export interface SuiteResult {
  suiteId: string;
  revision: string;
  trials: EvalTrial[];
  perArm: Record<string, { passRate: number; passHatK: number; metrics: Record<string, number> }>;
  comparisons: Array<{ armA: string; armB: string; mcnemarP: number; b: number; c: number } & ComparisonDetail>;
}

// ============================================================================= (additive) platform types
//
// Everything below is additive: the types above are unchanged. They describe how graders see a trial, how a trial
// runs in a child process (durable-recovery chaos with a real SIGKILL), and the harness options.

/**
 * (additive) Everything graders and metrics read about one trial, collected ONCE after the run (environment probes
 * first, then the stores of the trial's own Hypertest instance). Graders never see the model transcript as truth.
 */
export interface TrialData {
  runId?: string;
  run?: TestRun;
  /** Run status at collection time (e.g. `running` after a timeout). */
  status?: TestRun['status'];
  /**
   * The run's FINAL QualityDecision (`run.decisionId`); undefined while the run has none. An interim feedback-loop
   * decision (the gate asked for more evidence and the run went on) is never the verdict: it is listed in `decisions`.
   */
  decision?: QualityDecision;
  /** Every decision of the run, newest first (supersedes chain). */
  decisions: QualityDecision[];
  /** L0, seq order. */
  events: DomainEvent<unknown>[];
  operations: OperationRecord[];
  /** Finding lineage heads. */
  findings: BlackboardRecord<Finding>[];
  evidence: EvidenceRecord[];
  plans: PlanRevision[];
  workItems: WorkItem[];
  policyDecisions: PolicyDecisionRecord[];
  /** Committed agent turns from the SessionStore (independent of L0): agent, route and whether a response was persisted. */
  sessionTurns: Array<{ agentId: string; routeId: string | null; turn: number; hasResponse: boolean }>;
  /** EvidenceLedger.verify with the trusted keys. */
  verification?: EvidenceVerification;
  /** Hypertest.verifyEvidence (chain + seals + the decision's signature and evidence binding). */
  verifyEvidence?: { ok: boolean; problems: string[] };
  /** The pinned RuntimeManifest as stored (undefined when missing). */
  manifest?: RuntimeManifest;
  report?: RunReport;
  reportError?: string;
  /** Results of the fixture's probes (run once, before the stores are read). */
  probes: Record<string, JsonValue>;
  /** Outcome of the run as seen by the harness (undefined when the run never started). */
  outcome?: RunOutcome;
  /**
   * Harness facts: restarts (kills), injected model timeouts, whether duplicate delivery was on, and whether the run did
   * not finish in time (`timedOut`: the harness deadline, or a trial child's own timeout — such a trial always fails).
   */
  harness: { restarts: number; injectedModelTimeouts: number; duplicateDelivery: boolean; timedOut: boolean };
}

/** (additive) What a grader receives. `ht` is an open instance over the trial's stores (the run's own, or — after a
 *  child-process trial — a grading instance over the same data directory). */
export interface GraderContext {
  task: EvalTask;
  armId: string;
  trial: TrialContext;
  fixture: TrialFixture;
  data: TrialData;
  ht: HypertestInstance;
}

/**
 * (additive) A grader: an outcome check over the trial. It returns a result for anything the SYSTEM did (pass or
 * fail); it throws (HypertestError `precondition_failed`) only when the trial cannot be graded (e.g. a probe it needs
 * is missing) — the harness then records `infra_error`, never a silent pass.
 */
export type Grader = (ctx: GraderContext) => GraderResult | Promise<GraderResult>;

/** (additive) Options of the plan-dynamics grader (PoC A: ≥2 plan revisions, parallel children, ≥3 roles on distinct routes). */
export interface PlanDynamicsOptions {
  /** Accepted plan revisions (accepted or later superseded) required. Default 2. */
  minPlanRevisions?: number;
  /** Work items that must have been running at the same time (overlapping `running` intervals in L0). Default 2. */
  minParallel?: number;
  /** Roles that used pairwise distinct routes (maximum role→route matching over model.routed). Default 3. */
  minDistinctRoutes?: number;
}

/** (additive) How the child process obtains its brains (an EvalArm that supports child-process trials). */
export interface ChildArmSpec {
  /** Absolute path (or file: URL) of an ES module loadable by the child. */
  brainsModule: string;
  /**
   * Named export: a `Record<providerId, ScriptedBrain>` or a factory `(ctx: ChildBrainContext) => Record<…> | Promise<…>`.
   * Brains must be functions of the request (they are re-created in every child: after a kill the resumed child
   * rebuilds them).
   */
  brainsExport: string;
  /** JSON arguments for the brains factory, computed in the parent from the task and the fixture. */
  args?: (task: EvalTask, fixture: TrialFixture) => JsonValue;
  /** Module + export (`task` by default; an EvalTask or a function returning one) handed to the brains factory. */
  taskModule?: string;
  taskExport?: string;
}

/** (additive) Argument of a child brains factory. */
export interface ChildBrainContext {
  job: TrialChildJob;
  task?: EvalTask;
  args?: JsonValue;
  mode: 'start' | 'resume';
  /** 1 for the first child of the trial, 2… for resumed children. */
  attempt: number;
}

/** (additive) The JSON job file of `src/trial-child.ts`. */
export interface TrialChildJob {
  config: HypertestConfig;
  brainsModule: string;
  brainsExport: string;
  taskModule?: string;
  taskExport?: string;
  brainsArgs?: JsonValue;
  mode: 'start' | 'resume';
  /** start: the run to create (its `runId` is fixed by the parent); resume: `runId` names the run to await. */
  input: StartRunInput;
  /** JSON-lines progress file (appended). */
  progressFile: string;
  /** Run timeout inside the child (default 600 000 ms). */
  timeoutMs?: number;
  /** Attempt number (1 = first child). */
  attempt?: number;
  environments?: EnvironmentDescriptor[];
  chaos?: { injectModelTimeoutOnCall?: number; duplicateEventDelivery?: boolean };
  /** L0 poll interval for progress lines (default 20 ms). */
  pollMs?: number;
  /** Log file (JSON lines, level warn) of the child's Hypertest instance. */
  logFile?: string;
  /**
   * Worker identity of the child's Hypertest instance. The harness sets one stable id per trial so that a resumed
   * child re-takes the leases of the killed one at once (on PostgreSQL the default id contains the pid).
   */
  workerId?: string;
  /** (additive) Oracles established (start mode only, before the run) by the eval oracle authority. */
  oracles?: EvalOracle[];
}

/** (additive) One progress line written by a trial child. */
export type TrialProgressEvent =
  | { type: 'started'; pid: number; at: string; mode: 'start' | 'resume'; attempt: number; runId: string; manifestId: string }
  | { type: 'operation'; pid: number; at: string; runId: string; seq: number; eventType: string; operationId: string; operationType?: string; from: string | null; to: string }
  | { type: 'work'; pid: number; at: string; runId: string; seq: number; eventType: string; workItemId: string; role?: string; from?: string; to?: string }
  | { type: 'run'; pid: number; at: string; runId: string; seq: number; eventType: string; status?: string }
  | { type: 'chaos'; pid: number; at: string; kind: 'model_timeout'; call: number }
  | { type: 'completed'; pid: number; at: string; runId: string; status: TestRun['status']; verdict?: QualityVerdict; decisionId?: string; exitCode: number }
  | { type: 'error'; pid: number; at: string; code: string; message: string; exitCode: number };

/** (additive) Exit status of a child process. */
export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** (additive) A running trial child (see spawnTrialChild). */
export interface ChildTrialProcess {
  readonly pid: number;
  /** Progress lines read so far (the file is tailed while the child runs). */
  readonly progress: readonly TrialProgressEvent[];
  readonly exit: Promise<ChildExit>;
  /** Resolves with the first progress line matching the predicate, or undefined when the child exits (or the timeout elapses) first. */
  waitFor(predicate: (e: TrialProgressEvent, all: readonly TrialProgressEvent[]) => boolean, options?: { timeoutMs?: number }): Promise<TrialProgressEvent | undefined>;
  /** Sends the signal (default SIGKILL) and resolves when the child exited. */
  kill(signal?: NodeJS.Signals): Promise<ChildExit>;
}

/** (additive) Result of runChildTrial (a child, optionally killed and resumed). */
export interface ChildTrialResult {
  exit: ChildExit;
  /** Children killed by the chaos plan (= restarts). */
  kills: number;
  /** (additive) Kill points (ChaosPlan.kills, in order) that were reached and executed. */
  killPointsHit?: number;
  /** false when a kill was planned but the run finished before the planned point. */
  chaosExercised: boolean;
  timedOut: boolean;
  progress: TrialProgressEvent[];
}

/** (additive) The outcome of a run (`Hypertest.run`), as the durable runtime reports it. */
export type RunOutcome = Awaited<ReturnType<Hypertest['run']>>;

/** (additive) Options shared by runTrial and runSuite. */
export interface HarnessOptions {
  /** `in-process` (default) or `child-process` (requires `arm.child`; chaos kills are real SIGKILLs). */
  mode?: 'in-process' | 'child-process';
  /** Extra/overriding graders by id (merged over the built-in registry). */
  graders?: Record<string, Grader>;
  /** Harness logger (default: none). The Hypertest instances of a trial log into an in-memory logger. */
  logger?: Logger;
  /** Keep the trial work directories (default false: removed after the trial). */
  keepWorkDir?: boolean;
  /** Per-probe timeout (default 30 000 ms). */
  probeTimeoutMs?: number;
}

/** (additive) Optional fields of a comparison: number of graded pairs and the paired bootstrap CI of passA − passB. */
export interface ComparisonDetail {
  pairs?: number;
  passDiffCI?: { mean: number; lo: number; hi: number };
}
