/**
 * The PoC suites (BLUEPRINT §5 eval, §6 PoCs): factories named `<suiteId>Suite` (the CLI discovers them by name).
 * PoC C and recovery-chaos kill the Hypertest process: run them with `mode: 'child-process'` for a real SIGKILL (the
 * in-process mode closes the instance mid-run instead).
 */
import type { EvalSuite } from '../contracts.ts';
import { POC_SUITE_REVISION } from './common.ts';
import { pocATask } from './poc-a.ts';
import { pocBTask } from './poc-b.ts';
import { pocCInsufficientTask, pocCTask, recoveryChaosTask } from './poc-c.ts';
import { oracleRobustnessTask } from './robustness.ts';

export function pocAWhiteboxSuite(): EvalSuite {
  return { suiteId: 'poc-a-whitebox', revision: POC_SUITE_REVISION, tasks: [pocATask()] };
}

export function pocBEventDrivenSuite(): EvalSuite {
  return { suiteId: 'poc-b-event-driven', revision: POC_SUITE_REVISION, tasks: [pocBTask()] };
}

/** PoC C: the durable load with a crash (pass) and its insufficient-data variant (inconclusive). */
export function pocCDurableLoadSuite(): EvalSuite {
  return { suiteId: 'poc-c-durable-load', revision: POC_SUITE_REVISION, tasks: [pocCTask(), pocCInsufficientTask()] };
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

export { OBSERVATIONS_PROBE, POC_SUITE_REVISION, observationsFile, observationsProbe } from './common.ts';
export { LEDGER_ORACLE, POC_A_TASK_ID, pocATask } from './poc-a.ts';
export { BANK_ORACLE, POC_B_TASK_ID, pocBTask } from './poc-b.ts';
export { KV_ORACLE, POC_C_INSUFFICIENT_TASK_ID, POC_C_TASK_ID, RECOVERY_CHAOS_TASK_ID, kvFixture, pocCInsufficientTask, pocCTask, recoveryChaosTask } from './poc-c.ts';
export { ORACLE_ROBUSTNESS_TASK_ID, oracleRobustnessTask } from './robustness.ts';
// (additive) the core suites (context-freshness, model-switch, security-injection, test-generation, core)
export {
  CONTEXT_FRESHNESS_TASK_ID, CORE_SUITE_REVISION, KV_RELEASE_ORACLE, LEDGER_PAGINATION_ORACLE, MODEL_SWITCH_BASELINE_TASK_ID, MODEL_SWITCH_TASK_ID, SECURITY_INJECTION_TASK_ID,
  TEST_GENERATION_DEFECT_TASK_ID, TEST_GENERATION_INSENSITIVE_TASK_ID, TEST_GENERATION_TASK_ID, contextFreshnessSuite, contextFreshnessTask, coreSuite, modelSwitchBaselineTask,
  modelSwitchSuite, modelSwitchTask, securityInjectionSuite, securityInjectionTask, testGenerationDefectTask, testGenerationInsensitiveTask, testGenerationSuite, testGenerationTask,
} from './core.ts';
