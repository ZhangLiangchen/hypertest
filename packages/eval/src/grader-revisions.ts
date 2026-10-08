/**
 * Revisions of the built-in graders (architecture-improvements §Eval 回滚与恢复: "Suite v14, Grader v8 …"). A grader whose
 * behaviour changes gets a NEW revision — never an edit of an old one — and a bridge comparison (bridgeCompare) of the
 * old and new revision on the same trials before trends continue. `packages/eval/graders.lock.json` pins the source
 * fingerprint of every revision; `test/grader-versions.test.ts` fails when a grader's source changed but its revision did
 * not (see src/versioning.ts).
 *
 * This module has no imports on purpose: graders.ts (the registry), versioning.ts (fingerprints) and judge.ts (the scripted
 * judge's identity) all read it.
 */

/** Built-in grader id → current revision. */
export const GRADER_REVISIONS: Readonly<Record<string, string>> = Object.freeze({
  verdict: '1',
  defectDetected: '1',
  noDuplicateSideEffects: '1',
  evidenceCompleteness: '1',
  evidenceIntegrity: '1',
  policyViolation: '1',
  auditReconstruction: '1',
  planDynamics: '1',
  pocAWorkflow: '1',
  pocBWorkflow: '1',
  pocCWorkflow: '1',
  causalChain: '1',
  singleLeaseOwner: '1',
  noOrphanOperations: '1',
  loadJobReattached: '1',
  offloadBounded: '1',
  modelFallback: '1',
  contextIsolation: '1',
  independentReview: '1',
  reportTracesToEvidence: '1',
  testChangeGoverned: '1',
  recoveryAudit: '1',
  insufficientDataNotPassed: '1',
  // (F[4]) PoC C complete: anomaly → reactor RCA/regression, RCA ∥ metrics ∥ executor
  anomalyReaction: '1',
  rcaMetricsExecutorParallel: '1',
  // (F[5]/F[6]/F[7]) extended core suites and chaos cases
  blackBoxOnly: '1',
  uiEvidence: '1',
  faultTolerance: '1',
  tamperDetected: '1',
  delegation: '1',
  convergence: '1',
  budgetExhaustion: '1',
  competingFaultsIsolated: '1',
  unqueryableEscalated: '1',
  // (item 6) the three-provider-class arm
  providerClassesAudited: '1',
  // core suites (context-freshness, model-switch, security-injection, test-generation)
  freshnessGuarded: '1',
  modelSwitchContinuity: '1',
  injectionContained: '1',
  // 2: sensitivity only from evidence BOUND to the artifact; eligibility needs the whole lifecycle (D-0/D-1)
  generatedTestsGoverned: '2',
  baselineEquivalence: '1',
  // the independent LLM judge (ordered last)
  llmRubric: '1',
});

/** Grader ids judged by a model: ordered LAST after every deterministic grader, may answer `unknown`. */
export const LLM_GRADER_IDS: ReadonlySet<string> = new Set(['llmRubric']);

/**
 * Revision of the eval harness (trial procedure, result rules): recorded on every trial as `EvalTrial.harness`; the eval
 * release gate compares only results of the same harness revision and trial mode.
 * h3: outcome metrics, routes, canonical state and key are recorded before grading (an infra-error trial keeps them);
 * a grader result whose pass and outcome disagree, or a deterministic grader reporting itself uncounted, is a schema
 * violation (infra_error) instead of being counted as the result claimed.
 */
export const EVAL_HARNESS_REVISION = 'h3';

/**
 * Source text of a function with whitespace and full-line comments removed (stable across type-stripping runtimes): the
 * basis of grader fingerprints, custom grader revisions and the scripted judge's policy identity.
 */
export function normalizedSource(fn: (...args: never[]) => unknown): string {
  return fn
    .toString()
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/\s+/g, '');
}
