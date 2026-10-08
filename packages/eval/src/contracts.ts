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
  /**
   * (additive, F[6]) A SCRIPTED HUMAN OPERATOR acting during the run (in-process trials only): `act` is called every
   * `intervalMs` (default 200) with the live instance — e.g. it resolves an operation under manual review from the
   * fixture's ground truth, as an on-call human would (`hypertest operations resolve`). Agents never act through it.
   */
  operator?: TrialOperator;
  /**
   * (additive, F[7] evidence suite) Runs after the run ended and BEFORE the trial's data is collected and graded (e.g. an
   * attacker tampers with a stored artifact). Its JSON result is recorded as the probe `afterRun`.
   */
  afterRun?: (ctx: { ht: HypertestInstance; runId: string; dataDir: string }) => Promise<JsonValue>;
}

/** (additive, F[6]) A scripted human operator of a trial (TrialFixture.operator). */
export interface TrialOperator {
  /** Poll interval (ms, default 200). */
  intervalMs?: number;
  /** One look at the run; errors are logged and the operator keeps going. */
  act(ctx: { ht: HypertestInstance; runId: string }): Promise<void>;
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
  /** (additive) The rubric the `llmRubric` grader asks the independent judge (default VERDICT_CONSISTENCY_RUBRIC). */
  rubric?: JudgeRubric;
  /**
   * (additive, row 310) The tools the trial's agents may use (tool ids or `prefix.*` patterns): the trial's
   * configuration DENIES every other tool to every role (policy rules), and the trial records the list. Absent ⇒ the
   * deployment's tool policy as configured.
   */
  allowedTools?: string[];
  /**
   * (additive, row 310) Safety constraints the trial enforces through its configuration (policy deny rules) and records:
   * `forbid_tool` (a tool id or `prefix.*`), `max_action_risk` (calls above the risk are denied), `no_writes` (every
   * write/external effect denied).
   */
  safetyConstraints?: SafetyConstraint[];
  /**
   * (additive, row 310/319) The digest of the system fixture the task runs against (`sha256:<hex>` of an OCI image, or
   * of the fixture's files): recorded on every trial. Absent ⇒ the harness fingerprints the fixture sources it knows
   * (fixtureFiles).
   */
  environmentImageDigest?: string;
  /** (additive, row 319) Files/directories whose content is the task's environment (fingerprinted per trial when no image digest is given). */
  fixtureFiles?: string[];
  /** (additive, coverage[15]) Tiers the task belongs to (`pr-smoke`, `release-core`, `deep`, `failure-recovery`). */
  tiers?: EvalTier[];
  /**
   * (additive, F[5]/F[7]) Task-level configuration of the trial (applied after the arm's configuration, before the
   * task constraints): e.g. the browser tools a UI task needs. It may only ADD capabilities the task needs; the harness
   * re-checks trial isolation afterwards.
   */
  configure?: (config: HypertestConfig) => HypertestConfig;
  /**
   * (additive) A no-failure twin task of the same suite (it must come earlier in EvalSuite.tasks): after every trial,
   * runSuite checks that this task's trial reached the same verdict and the same canonical state as the baseline's trial
   * of the same arm and trial number (grader `baselineEquivalence`; a mismatch fails the trial, a missing baseline leaves
   * it unconfirmed — infra_error — never a pass).
   */
  baselineTaskId?: string;
}

export interface EvalArm {
  armId: string;
  description: string;
  config: (base: HypertestConfig, ctx: TrialContext) => HypertestConfig;
  brains?: (task: EvalTask, fixture: TrialFixture) => Record<string, ScriptedBrain>;
  /** (additive) Child-process support: where a trial child loads its brains from. */
  child?: ChildArmSpec;
  /**
   * (additive, F[8]) The family the arm belongs to: `causal` (H0–H6 at a fixed model: harness features vary, nothing else),
   * `product` (a frontier/product baseline: another engine or an external agent), `model` (provider/model variation).
   */
  family?: 'causal' | 'product' | 'model';
  /**
   * (additive, F[8]) An EXTERNAL agent (Claude Code, Codex, OpenHands, …) invoked as a command instead of a Hypertest
   * run: the harness runs it in the fixture's workspace and grades its reported verdict and findings with the outcome
   * graders only (see externalAgentArm).
   */
  external?: ExternalAgentSpec;
  /**
   * (additive, item 6) Composition overrides of the trial's Hypertest instance, created once per trial: the fetch the HTTP
   * model adapters use (e.g. the scripted wire transport), the environment API-key variables are read from, and extra
   * ground-truth probes (e.g. the transport's log). In-process trials only (a fetch does not cross a process boundary).
   */
  overrides?: (task: EvalTask, fixture: TrialFixture) => ArmOverrides;
}

/** (additive, item 6) What EvalArm.overrides contributes to a trial. */
export interface ArmOverrides {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  probes?: Record<string, () => Promise<JsonValue>>;
}

/** (additive, row 310) A safety constraint of an EvalTask (enforced through the trial's policy and recorded). */
export type SafetyConstraint =
  | { kind: 'forbid_tool'; tool: string }
  | { kind: 'max_action_risk'; risk: 'low' | 'medium' | 'high' }
  | { kind: 'no_writes' };

/** (additive, coverage[15]) Eval tiers (architecture-improvements §Trial 设计). */
export type EvalTier = 'pr-smoke' | 'release-core' | 'deep' | 'failure-recovery';

/** (additive, coverage[16]) Eval tracks: `cold` (default) shares no long-term memory across trials; `learning` admits approved experience only. */
export type EvalTrack = 'cold' | 'learning';

/** (additive, F[8]) The harness subsystems a causal arm switches (H0 … H6). */
export interface HarnessFeatures {
  /** Specialized role agents (false: the lead is the only agent — H0 single agent). */
  subagents: boolean;
  /** The dynamic DAG scheduler (false: one turn at a time, a static sequential pipeline). */
  dynamicScheduler: boolean;
  /** Blackboard reactions (false: no event-driven work — roles never react to findings, reviews, …). */
  blackboard: boolean;
  /** Context freshness (false: no stale-snapshot refusal of mutating calls). */
  contextFreshness: boolean;
  /** Oracle governance (false: runs pin no oracle and the gate does not require one). */
  oracleGovernance: boolean;
}

/** (additive, F[8]) How an external agent arm invokes its agent. */
export interface ExternalAgentSpec {
  /** Executable (resolved on PATH) — e.g. `claude`, `codex`, `openhands`, or a test fake. */
  command: string;
  /** Arguments; `{goal}`, `{workspace}`, `{sutUrl}`, `{report}` are substituted. */
  args: string[];
  /** Variable NAMES passed through to the agent (its credentials stay in the environment, never in the config). */
  envPassthrough?: string[];
  /** Per-trial timeout of the command (default the trial timeout). */
  timeoutMs?: number;
}

export interface GraderResult {
  graderId: string;
  pass: boolean;
  score: number;
  detail: string;
  /**
   * (additive) Three-valued outcome. Deterministic graders are `pass`/`fail` (= `pass`); an LLM judge may answer `unknown`
   * when the evidence does not decide (then `pass` is false). A counted `unknown` never makes a trial pass: with no failing
   * grader the trial is `infra_error` ("needs human audit"), never a forced binary.
   */
  outcome?: 'pass' | 'fail' | 'unknown';
  /**
   * (additive) false ⇒ reported but NOT counted: the trial result ignores it (an LLM judge whose calibration against expert
   * labels is below the configured agreement threshold, or that has no calibration for the rubric). Absent ⇒ counted.
   */
  counted?: boolean;
  /** (additive) The grader revision that produced this result (graders are versioned; see GRADER_REVISIONS). */
  revision?: string;
  /** (additive) What the independent LLM judge was, saw and answered (llmRubric only). */
  judge?: JudgeRecord;
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
  /** (additive) The suite the trial ran in (set by runSuite / TrialOptions.suiteId). */
  suiteId?: string;
  /** (additive) The task's suite revision (EvalTask.suiteRevision). */
  suiteRevision?: string;
  /** (additive) Harness identity: `hypertest-eval@<EVAL_HARNESS_REVISION>/<mode>`. */
  harness?: string;
  /** (additive) The model routes the trial's agents ran on, per role (from L0: agent.spawned + model.epoch_started + model.invoked). */
  modelRoutes?: TrialModelRoute[];
  /** (additive) grader id → revision of every grader that graded the trial (EvalTask.graders order irrelevant). */
  graderRevisions?: Record<string, string>;
  /** (additive) Oracle revisions the run pinned (TestRun.oracleRevisions). */
  oracleRevisions?: Record<string, number>;
  /**
   * (additive) Comparability key: sha256 over suite id + suite revision + task id + grader revisions + runtime manifest id +
   * oracle revisions (see trialKey). Trials with different keys are not like-for-like; a grader revision change needs a
   * bridge comparison (bridgeCompare) before trends continue.
   */
  trialKey?: string;
  /** (additive) Canonical outcome projection (plan, blackboard, evidence, verdict) without ids, timestamps or routes. */
  canonical?: CanonicalState;
  /** (additive) Results of candidate grader revisions run on the same trial data (HarnessOptions.bridge); never counted. */
  bridge?: GraderResult[];
  /** (additive, F[14]) The trial was cancelled (SuiteOptions.signal / --timeout): result infra_error, never counted. */
  cancelled?: boolean;
  /** (additive, coverage[16]) The track the trial ran on (cold: no cross-trial memory). */
  track?: EvalTrack;
  /** (additive, row 310) EvalTask.allowedTools as enforced on the trial. */
  allowedTools?: string[];
  /** (additive, row 310) EvalTask.safetyConstraints as enforced on the trial. */
  safetyConstraints?: SafetyConstraint[];
  /** (additive, row 310/319) The fixture's image digest, or `files:<sha256>` of its fingerprinted files. */
  environmentImageDigest?: string;
  /** (additive, F[8]) The harness features the trial's instance ran with (causal arms). */
  harnessFeatures?: HarnessFeatures;
  /** (additive, F[12]) The suite content fingerprint (suiteFingerprint) the trial belongs to. */
  suiteFingerprint?: string;
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
  /** (additive) Suite id recorded on the trial and in its trialKey (runSuite sets it). */
  suiteId?: string;
  baseConfig?: HypertestConfig;
  timeoutMs?: number;
  /**
   * (additive, H11) Cancels the trial cooperatively: the run is cancelled (in-process) or the trial child SIGKILLed
   * (child-process), the trial ends as `infra_error` ("cancelled") and its environment is torn down as usual.
   */
  signal?: AbortSignal;
}

export interface SuiteOptions extends HarnessOptions {
  arms: EvalArm[];
  trials: number;
  workDir: string;
  baseConfig?: HypertestConfig;
  timeoutMs?: number;
  /** (additive, coverage[15]) The tier the suite runs as (recorded on the result). */
  tier?: EvalTier;
  /** (additive) Called after every trial (e.g. CLI progress output). */
  onTrial?: (trial: EvalTrial) => void;
  /**
   * (additive, H11) Cancels the suite: the running trial is cancelled (TrialOptions.signal) and no further trial starts;
   * runSuite then rejects with `cancelled` (details: the trials completed so far — also reported through onTrial).
   */
  signal?: AbortSignal;
}

export interface SuiteResult {
  suiteId: string;
  revision: string;
  trials: EvalTrial[];
  perArm: Record<string, { passRate: number; passHatK: number; metrics: Record<string, number>; passAtK?: Record<string, number>; passHatKByK?: Record<string, number> }>;
  comparisons: Array<{ armA: string; armB: string; mcnemarP: number; b: number; c: number } & ComparisonDetail>;
  /** (additive, F[14]) The suite was cancelled: `trials` holds what completed (and the cancelled trial). */
  cancelled?: boolean;
  /** (additive, coverage[15]) The tier the suite ran as. */
  tier?: EvalTier;
  /** (additive, coverage[16]) The track every trial ran on. */
  track?: EvalTrack;
  /** (additive, F[12]) sha256 over the suite's task definitions, fixtures and brains (suiteFingerprint). */
  suiteFingerprint?: string;
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
  /** (additive) The results of the graders that ran before this one (task order; the LLM judge runs last and sees them). */
  prior?: readonly GraderResult[];
  /** (additive) The independent LLM judge of the harness (HarnessOptions.judge), for `llmRubric`. */
  judge?: LlmJudge;
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
  /** (additive, H11) The trial's signal aborted: the child was killed (no verdict to take from it). */
  cancelled?: boolean;
}

/** (additive) The outcome of a run (`Hypertest.run`), as the durable runtime reports it. */
export type RunOutcome = Awaited<ReturnType<Hypertest['run']>>;

/** (additive) Options shared by runTrial and runSuite. */
export interface HarnessOptions {
  /** `in-process` (default) or `child-process` (requires `arm.child`; chaos kills are real SIGKILLs). */
  mode?: 'in-process' | 'child-process';
  /**
   * Extra/overriding graders by id (merged over the built-in registry). (additive) A VersionedGrader carries its revision;
   * a plain function gets the revision `custom-<sha256 of its source>` (a changed custom grader is a new revision).
   */
  graders?: Record<string, Grader | VersionedGrader>;
  /**
   * (additive) The independent LLM judge for `llmRubric` graders (createLlmJudge / scriptedJudge). A task that lists
   * `llmRubric` without a judge is refused before any trial.
   */
  judge?: LlmJudge;
  /**
   * (additive) Bridge: candidate revisions of existing graders (by grader id) run on the same trial data right after the
   * graders of the task; their results land in EvalTrial.bridge (never counted). Compare with bridgeCompare.
   */
  bridge?: Record<string, VersionedGrader>;
  /** Harness logger (default: none). The Hypertest instances of a trial log into an in-memory logger. */
  logger?: Logger;
  /**
   * (additive, coverage[16]) `cold` (default): a trial shares no long-term memory with any other — an arm whose memory
   * backend lives outside the trial directory (a shared PowerContext/memory service) is refused before the trial.
   * `learning`: such a backend is admitted, and `experience` (approved items only) is seeded into every trial's store.
   */
  track?: EvalTrack;
  /** (additive, coverage[16]) Learning track: experience items to seed (only `approved`/`published` ones are admitted; the rest are refused and counted). */
  experience?: ExperienceSeed[];
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

// ============================================================================= (additive) eval platform completion
//
// Versioned graders, recorded trial routes, the independent LLM judge with calibration, bridge comparisons and the eval
// release gate (architecture-improvements §Agent 评测基准与对比实验设计: Eval 数据模型, LLM Judge 的治理, 回滚与恢复, 发布 Gate).

/** (additive) A grader with its revision. Changing a grader's behaviour requires a new revision (and a bridge comparison). */
export interface VersionedGrader {
  revision: string;
  grader: Grader;
  /** `llm`: judged by a model (ordered LAST after every deterministic grader; may answer unknown). Default deterministic. */
  kind?: 'deterministic' | 'llm';
  description?: string;
}

/** (additive) One role's use of one model route in a trial (EvalTrial.modelRoutes). */
export interface TrialModelRoute {
  role: string;
  routeId: string;
  provider: string;
  model: string;
  /** ModelEpochs started on the route by agents of the role (a fallback starts a new epoch). */
  epochs: number;
  /** Agents of the role that ran on the route. */
  agents: number;
  /** Successful model calls on the route by agents of the role. */
  calls: number;
  /** Switch reasons of those epochs (`initial`, `fallback_timeout`, …), sorted, unique. */
  switchReasons: string[];
}

/** (additive) The canonical outcome of a trial: what must not depend on which model route produced it. */
export interface CanonicalProjection {
  verdict: QualityVerdict | null;
  violatedCriteria: string[];
  unknownCriteria: string[];
  /** Accepted plan revisions in order: their work items as `role: title`, and whether they handed over to the gate. */
  plans: Array<{ readyForGate: boolean; workItems: string[] }>;
  /** Work items as `role/state/origin: title`, sorted. */
  workItems: string[];
  /** Current blackboard heads as `type/severity/status: title`, sorted. */
  records: string[];
  /** Evidence as `type: outcome` (test results with their case outcomes, HTTP exchanges with method, path, status), sorted. */
  evidence: string[];
}

export interface CanonicalState {
  /** sha256 of the canonical JSON of the projection. */
  digest: string;
  projection: CanonicalProjection;
}

/** (additive) What the LLM judge is asked: a question decidable from the raw evidence, with explicit pass/fail/unknown rules. */
export interface JudgeRubric {
  rubricId: string;
  revision: string;
  question: string;
  passWhen: string[];
  failWhen: string[];
  /** When the judge must answer unknown instead of guessing (never a forced binary). */
  unknownWhen: string[];
}

export type JudgeVerdict = 'pass' | 'fail' | 'unknown';

/**
 * (additive) What the judge sees of a trial: the RAW recorded outcome — environment probes, the QualityDecision, the
 * evidence records themselves (structured payloads and bounded artifact excerpts), the agents' findings WITH the evidence
 * they cite, operations, tool denials and the deterministic grader results — never only an executor's final summary.
 * Everything in it is data, not instructions (the judge prompt says so).
 */
export interface EvidencePacket {
  runId?: string;
  taskGoal: string;
  /** Fixture probes (environment ground truth), JSON; the brains' observation log is excluded. */
  environment: Record<string, JsonValue>;
  decision?: { verdict: QualityVerdict; requiresHumanReview: boolean; violated: string[]; unknown: string[]; reasons: string[] };
  evidence: Array<{ evidenceId: string; evidenceType: string; summary?: string; structured?: JsonValue; excerpt?: string; truncated: boolean }>;
  findings: Array<{ recordId: string; title: string; severity: string; category: string; status: string; description: string; evidenceRefs: string[] }>;
  operations: Array<{ operationType: string; status: string }>;
  denials: Array<{ toolId: string; status: string }>;
  deterministicGraders: Array<{ graderId: string; outcome: JudgeVerdict; detail: string }>;
  /** Model providers that produced the trial: the judge's provider must differ from all of them. */
  producerProviders: string[];
  /** The packet was cut to its byte budget (items dropped or shortened). */
  truncated: boolean;
}

/** (additive) One answer of the judge. */
export interface JudgeAnswer {
  verdict: JudgeVerdict;
  /** The verdict as the model gave it (before grounding). */
  rawVerdict?: JudgeVerdict;
  rationale: string;
  /** Evidence ids of the packet the answer rests on (a pass/fail citing none of them is downgraded to unknown). */
  citedEvidence: string[];
  /** Why a pass/fail became unknown (ungrounded, unparseable answer, …). */
  downgraded?: string;
  routeId: string;
  provider: string;
  model: string;
}

/** (additive) The judge part of an llmRubric GraderResult. */
export interface JudgeRecord {
  rubricId: string;
  rubricRevision: string;
  routeId?: string;
  provider?: string;
  model?: string;
  /** Providers the judge was routed away from (the trial's producers). */
  prohibitedProviders: string[];
  rawVerdict?: JudgeVerdict;
  verdict: JudgeVerdict;
  rationale: string;
  citedEvidence: string[];
  downgraded?: string;
  calibration?: { calibrationSetId: string; revision: string; n: number; agreement: number; kappa: number; meetsThreshold: boolean; routes?: string[] };
  /** sha256 of the canonical JSON of the packet the judge saw. */
  packetDigest: string;
}

/** (additive) One labelled item of a calibration set: a past trial's packet and the expert's label for a rubric. */
export interface CalibrationItem {
  itemId: string;
  rubricId: string;
  /**
   * (additive) The rubric revision the expert labelled against. When set, the item calibrates only that revision: a
   * revised rubric (new pass/fail rules) is uncalibrated — its judge results do not count — until it is relabelled.
   * Absent ⇒ the label applies to every revision of the rubric.
   */
  rubricRevision?: string;
  packet: EvidencePacket;
  label: JudgeVerdict;
  /** `human:<name>`. */
  labelledBy: string;
  note?: string;
}

export interface CalibrationSet {
  calibrationSetId: string;
  revision: string;
  items: CalibrationItem[];
}

/** (additive) Agreement of the judge with the expert labels of a rubric (calibrate). */
export interface CalibrationReport {
  calibrationSetId: string;
  revision: string;
  rubricId: string;
  rubricRevision: string;
  /** LlmJudge.identity. */
  judge: string;
  n: number;
  /** Observed agreement (share of items where judge = expert). */
  agreement: number;
  /** Cohen's kappa over the three categories (chance-corrected agreement; 1 = perfect, ≤ 0 = chance). */
  kappa: number;
  /** expert label → judge verdict → count. */
  confusion: Record<JudgeVerdict, Record<JudgeVerdict, number>>;
  disagreements: Array<{ itemId: string; label: JudgeVerdict; verdict: JudgeVerdict }>;
  thresholds: { minAgreement: number; minKappa: number; minItems: number };
  /** The judge's results for this rubric count only when true. */
  meetsThreshold: boolean;
  /**
   * (additive) The judge routes that answered the calibration items (sorted, unique). The agreement was measured on these
   * models only: a trial answered by another route of the same judge is reported but not counted (llmRubric).
   */
  routes?: string[];
}

/** (additive) The independent LLM judge (createLlmJudge). */
export interface LlmJudge {
  /** Judge routes and models (part of the llmRubric grader revision recorded on trials). */
  readonly identity: string;
  /** Asks the judge; `prohibitedProviders` (the trial's producers) can never be routed to. Faults throw. */
  judge(packet: EvidencePacket, rubric: JudgeRubric, options?: { prohibitedProviders?: readonly string[]; signal?: AbortSignal }): Promise<JudgeAnswer>;
  /** Runs the judge over the set's items of the rubric and measures agreement / Cohen's kappa with the expert labels. */
  calibrate(set: CalibrationSet, rubric: JudgeRubric): Promise<CalibrationReport>;
  /** The configured calibration of a rubric (computed once per rubric revision); undefined without labelled items. */
  calibration(rubric: JudgeRubric): Promise<CalibrationReport | undefined>;
}

/** (additive) Bridge comparison of two revisions of one grader on the same trials (grader changes never rewrite history). */
export interface BridgeReport {
  graderId: string;
  fromRevision: string;
  toRevision: string;
  /** Trials graded by both revisions. */
  pairs: number;
  /** Share of pairs with the same outcome. */
  agreement: number;
  /** Trials (`task/arm#trial`) that pass under the old revision and do not under the new one. */
  newlyFailing: string[];
  newlyPassing: string[];
  /** Exact McNemar p over the discordant pairs. */
  mcnemarP: number;
  /** Mean of (new score − old score). */
  meanScoreDelta: number;
  /** Old score → mean new score (the score mapping for trend continuity). */
  scoreMapping: Array<{ from: number; to: number; n: number }>;
  /** Any outcome flipped: historical results of the old revision are not comparable without the mapping. */
  discontinuity: boolean;
  statement: string;
}

/** (additive) Options of the eval release gate (evaluateReleaseGate). */
export interface ReleaseGateOptions {
  /** Arm of the baseline result compared (default: its only arm, else the arm both results share). */
  baselineArm?: string;
  candidateArm?: string;
  /** Significance level of "defect recall not significantly lower" (exact McNemar; default 0.05). */
  alpha?: number;
  /**
   * (additive, row 321) The product SLO: the largest critical false release RATE (critical false releases / graded
   * candidate trials, infra errors that recorded one included) a candidate may have, whatever the baseline did. Default
   * 0 (DEFAULT_CRITICAL_FALSE_RELEASE_SLO): a release that passed a seeded critical defect never ships.
   */
  maxCriticalFalseReleaseRate?: number;
  /**
   * (additive, F[12]) Bridge reports (bridgeCompare / `eval bridge`) that make results of different grader revisions
   * comparable: a task whose grader revisions differ only by graders bridged WITHOUT discontinuity (same revisions, at
   * least one pair) is comparable; a discontinuity needs a new baseline.
   */
  bridges?: BridgeReport[];
}

export type ReleaseGateCheckId =
  | 'comparable' | 'coverage' | 'critical_false_release' | 'defect_recall' | 'security_violations' | 'duplicate_side_effects' | 'evidence_completeness'
  // (additive) the product SLO (row 321) and the per-task defect regression (F[13])
  | 'critical_false_release_slo' | 'defect_regression';

export interface ReleaseGateCheck {
  checkId: ReleaseGateCheckId;
  description: string;
  pass: boolean;
  detail: string;
  values: Record<string, number>;
}

/** (additive, coverage[16]) An experience item seeded into a learning-track trial (memory export / an approved skill). */
export interface ExperienceSeed {
  kind: 'lesson' | 'pattern' | 'pitfall' | 'test_idea' | 'skill_candidate';
  /** Only `approved` / `published` items are admitted. */
  status: string;
  content: string;
  scope?: { project?: string; role?: string; topic?: string };
}

/** (additive) Result of the eval release gate: pass only when every check passes. */
export interface ReleaseGateReport {
  pass: boolean;
  suiteId: string;
  baseline: { revision: string; arm: string; trials: number; graded: number };
  candidate: { revision: string; arm: string; trials: number; graded: number };
  /** (task, trial) pairs graded in both. */
  pairs: number;
  alpha: number;
  checks: ReleaseGateCheck[];
  /** (additive, F[12]) The bridges the comparability check used. */
  bridgesUsed?: Array<{ graderId: string; fromRevision: string; toRevision: string; pairs: number }>;
}
