import type { JsonValue } from '@hypertest/core';
import type { BudgetEnvelope, QualityVerdict, TargetRef } from '@hypertest/domain';
import type { ScriptedBrain } from '@hypertest/model';
import type { HypertestConfig } from '@hypertest/app';
import type { EnvironmentDescriptor } from '@hypertest/tools';

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
}

export interface TrialContext {
  workDir: string;
  seed: string;
  trial: number;
}

export interface ChaosPlan {
  /** Kill the Hypertest instance after the Nth dispatched operation, then restart and resume. */
  killAfterOperationDispatch?: number;
  injectModelTimeoutOnCall?: number;
  duplicateEventDelivery?: boolean;
  largeOutputBytes?: number;
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
}

export interface EvalArm {
  armId: string;
  description: string;
  config: (base: HypertestConfig, ctx: TrialContext) => HypertestConfig;
  brains?: (task: EvalTask, fixture: TrialFixture) => Record<string, ScriptedBrain>;
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

export interface TrialOptions {
  workDir: string;
  trial: number;
  seed: string;
  baseConfig?: HypertestConfig;
  timeoutMs?: number;
}

export interface SuiteOptions {
  arms: EvalArm[];
  trials: number;
  workDir: string;
  baseConfig?: HypertestConfig;
  timeoutMs?: number;
}

export interface SuiteResult {
  suiteId: string;
  revision: string;
  trials: EvalTrial[];
  perArm: Record<string, { passRate: number; passHatK: number; metrics: Record<string, number> }>;
  comparisons: Array<{ armA: string; armB: string; mcnemarP: number; b: number; c: number }>;
}
