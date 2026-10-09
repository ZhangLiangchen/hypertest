/**
 * The PoC suites (BLUEPRINT §5 eval, §6 PoCs): factories named `<suiteId>Suite` (the CLI discovers them by name).
 * PoC C and recovery-chaos kill the Hypertest process: run them with `mode: 'child-process'` for a real SIGKILL (the
 * in-process mode closes the instance mid-run instead).
 */
import type { EvalSuite } from '../contracts.ts';
import { POC_SUITE_REVISION } from './common.ts';
import { pocATask } from './poc-a.ts';
import { pocBTask } from './poc-b.ts';
import { pocCAnomalyTask, pocCInsufficientTask, pocCTask, recoveryChaosTask } from './poc-c.ts';
import { oracleRobustnessTask } from './robustness.ts';
import { contextFreshnessTask, coreSuite, securityInjectionTask, testGenerationTask } from './core.ts';
import { apiBlackboxTask, chaosBudgetExhaustionTask, chaosCompetingFaultsTask, chaosKillAfterSuccessTask, evidenceTamperTask, faultToleranceLatencyTask, uiBlackboxTask } from './extended.ts';

export function pocAWhiteboxSuite(): EvalSuite {
  return { suiteId: 'poc-a-whitebox', revision: POC_SUITE_REVISION, tasks: [pocATask()] };
}

export function pocBEventDrivenSuite(): EvalSuite {
  return { suiteId: 'poc-b-event-driven', revision: POC_SUITE_REVISION, tasks: [pocBTask()] };
}

/**
 * PoC C: the durable load with a crash (pass), its insufficient-data variant (inconclusive) and (F[4]) the complete flow
 * with a latency anomaly (metrics → RCA ∥ metrics ∥ executor → targeted regression; fail).
 */
export function pocCDurableLoadSuite(): EvalSuite {
  return { suiteId: 'poc-c-durable-load', revision: POC_SUITE_REVISION, tasks: [pocCTask(), pocCInsufficientTask(), pocCAnomalyTask()] };
}

export function oracleRobustnessSuite(): EvalSuite {
  return { suiteId: 'oracle-robustness', revision: POC_SUITE_REVISION, tasks: [oracleRobustnessTask()] };
}

export function recoveryChaosSuite(): EvalSuite {
  return { suiteId: 'recovery-chaos', revision: POC_SUITE_REVISION, tasks: [recoveryChaosTask()] };
}

/**
 * (additive) Every PoC task in one suite — the arm comparison (`hypertest eval run poc-all --arms scripted-multi-llm,
 * scripted-single`): paired trials per task, McNemar over the discordant pairs.
 */
export function pocAllSuite(): EvalSuite {
  return {
    suiteId: 'poc-all',
    revision: POC_SUITE_REVISION,
    tasks: [pocATask(), pocBTask(), pocCTask(), pocCInsufficientTask(), oracleRobustnessTask(), recoveryChaosTask()],
  };
}

/** (coverage[15]) Revision of the tier suites (pr-smoke, deep, failure-recovery). */
export const TIER_SUITE_REVISION = 'tiers-1';

/** (coverage[15]) Tier `pr-smoke`: a fast subset of the core suites, one trial each (every runtime change). */
export function prSmokeSuite(): EvalSuite {
  return { suiteId: 'pr-smoke', revision: TIER_SUITE_REVISION, tasks: [contextFreshnessTask(), securityInjectionTask(), testGenerationTask(), apiBlackboxTask(), faultToleranceLatencyTask()] };
}

/** (coverage[15]) Tier `deep`: every core task, every PoC task, the browser and the evidence-tamper tasks (monthly / major architecture change). */
export function deepSuite(): EvalSuite {
  const seen = new Set<string>();
  const tasks = [...coreSuite().tasks, uiBlackboxTask(), evidenceTamperTask(), pocATask(), pocBTask(), pocCTask(), pocCInsufficientTask(), pocCAnomalyTask(), oracleRobustnessTask(), recoveryChaosTask()].filter((t) => !seen.has(t.taskId) && seen.add(t.taskId));
  return { suiteId: 'deep', revision: TIER_SUITE_REVISION, tasks };
}

/**
 * (coverage[15]) Tier `failure-recovery`: the recovery and chaos scenarios that run in a CHILD PROCESS (real SIGKILLs).
 * The unqueryable-target case needs a scripted operator on the live instance (in-process): it runs in `core` and `deep`.
 */
export function failureRecoverySuite(): EvalSuite {
  return { suiteId: 'failure-recovery', revision: TIER_SUITE_REVISION, tasks: [pocCTask(), recoveryChaosTask(), chaosKillAfterSuccessTask(), chaosBudgetExhaustionTask(), chaosCompetingFaultsTask()] };
}

export { OBSERVATIONS_PROBE, POC_SUITE_REVISION, observationsFile, observationsProbe } from './common.ts';
export { LEDGER_ORACLE, POC_A_TASK_ID, pocATask } from './poc-a.ts';
export { BANK_ORACLE, POC_B_TASK_ID, pocBTask } from './poc-b.ts';
export { KV_HOT_KEY_ANOMALY, KV_ORACLE, POC_C_ANOMALY_TASK_ID, POC_C_INSUFFICIENT_TASK_ID, POC_C_TASK_ID, RECOVERY_CHAOS_TASK_ID, kvFixture, pocCAnomalyTask, pocCInsufficientTask, pocCTask, recoveryChaosTask } from './poc-c.ts';
export { ORACLE_ROBUSTNESS_TASK_ID, oracleRobustnessTask } from './robustness.ts';
// (additive) the core suites (context-freshness, model-switch, security-injection, test-generation, core)
export {
  CONTEXT_FRESHNESS_TASK_ID, CORE_SUITE_REVISION, KV_RELEASE_ORACLE, LEDGER_PAGINATION_ORACLE, MODEL_SWITCH_BASELINE_TASK_ID, MODEL_SWITCH_TASK_ID, SECURITY_INJECTION_TASK_ID,
  TEST_GENERATION_DEFECT_TASK_ID, TEST_GENERATION_INSENSITIVE_TASK_ID, TEST_GENERATION_TASK_ID, contextFreshnessSuite, contextFreshnessTask, coreSuite, modelSwitchBaselineTask,
  modelSwitchSuite, modelSwitchTask, securityInjectionSuite, securityInjectionTask, testGenerationDefectTask, testGenerationInsensitiveTask, testGenerationSuite, testGenerationTask,
} from './core.ts';
// (additive, F[5]/F[6]/F[7]) the extended core suites and chaos cases
export {
  API_BLACKBOX_TASK_ID, BANK_UI_ORACLE, BUDGET_EXHAUSTION_TOOL_CALLS, CHAOS_BUDGET_EXHAUSTION_TASK_ID, CHAOS_COMPETING_FAULTS_TASK_ID, CHAOS_KILL_AFTER_SUCCESS_TASK_ID,
  CHAOS_UNQUERYABLE_TARGET_TASK_ID, EVIDENCE_MISSING_TASK_ID, EVIDENCE_TAMPER_TASK_ID, EXTENDED_SUITE_REVISION, FAULT_TOLERANCE_ERRORS_TASK_ID, FAULT_TOLERANCE_LATENCY_TASK_ID,
  KV_FLAG_ORACLE, KV_RESILIENCE_ORACLE, MULTI_AGENT_CONVERGENCE_TASK_ID, MULTI_AGENT_DELEGATION_TASK_ID, PERFORMANCE_REGRESSION_TASK_ID, PERFORMANCE_SLO_TASK_ID, UI_BLACKBOX_TASK_ID,
  apiBlackboxTask, apiUiBlackboxSuite, chaosBudgetExhaustionTask, chaosCompetingFaultsTask, chaosKillAfterSuccessTask, chaosSuite, chaosUnqueryableTargetTask, evidenceMissingTask,
  evidenceSuite, evidenceTamperTask, extendedTasks, faultToleranceErrorsTask, faultToleranceLatencyTask, faultToleranceSuite, multiAgentConvergenceTask, multiAgentDelegationTask,
  multiAgentSuite, performanceRegressionTask, performanceSloTask, performanceSuite, uiBlackboxTask,
} from './extended.ts';
