export * from './contracts.ts';
export { mcnemarExact, mulberry32, pairedBootstrapCI, passAtK, passHatK, seedFrom, seededShuffle, type BootstrapOptions } from './stats.ts';
export {
  GRADERS, auditReconstructionGrader, createPlanDynamicsGrader, customGraderRevision, defectDetectedGrader, evidenceCompletenessGrader, evidenceIntegrityGrader, graderOrderProblems,
  noDuplicateSideEffectsGrader, normalizedSource, planDynamicsGrader, policyViolationGrader, resolveGrader, verdictGrader, type ResolvedGrader,
} from './graders.ts';
export {
  EXECUTION_EVIDENCE_TYPES, METRIC_PROBE_PREFIX, PRODUCT_FINDING_CATEGORIES, RELEASE_VERDICTS, SIDE_EFFECT_PROBE, acceptedPlans, analyzeCompleteness, analyzeDefects,
  analyzePolicy, analyzeSensitivity, analyzeSideEffects, analyzeStaleness, analyzeVerdict, distinctRoleRoutes, expectedVerdicts, hintProblems, matchesHints, maxParallelWork,
  routesByRole, sideEffectCounts, timeToFirstEvidenceMs,
  type CompletenessAnalysis, type DefectAnalysis, type FaultDetection, type PolicyAnalysis, type SensitivityAnalysis, type SideEffectAnalysis, type StalenessAnalysis,
  type VerdictAnalysis,
} from './analysis.ts';
export { SECURITY_INCIDENTS_PROBE_NAME, outcomeMetrics, trajectoryMetrics } from './metrics.ts';
export { DEFAULT_PROBE_TIMEOUT_MS, collectTrialData, emptyTrialData, runProbes, sessionTurns, type CollectInput } from './collect.ts';
export {
  evidenceIdsIn, operationIdsIn, recordIdsIn, roleRouter, toolCall, viewOf, withModelTimeoutInjection, type BrainView, type ModelCallCounter, type RoleBrain,
} from './brains.ts';
export {
  TRIAL_CHILD_ENTRY, TRIAL_EXIT_CODES, dispatchCount, exitCodeForVerdict, parseProgress, readProgress, runChildTrial, spawnTrialChild, verdictForExitCode,
  type RunChildTrialOptions, type SpawnTrialChildOptions,
} from './child.ts';
export {
  DEFAULT_TRIAL_TIMEOUT_MS, TRIAL_DATA_DIR, chaosProblems, childExitProblem, decideTrialResult, graderRevisionsOf, graderSetupProblems, isolationProblems, runTrial, stampGraderResult,
  trialBaseConfig, trialDataDir, unexercisedChaos,
} from './harness.ts';
export { applyBaseline, renderSuiteReport, runSuite, summarizeSuite, trialSeed } from './suite.ts';
// (additive) versioned graders, trial records, the independent LLM judge, bridge comparisons and the release gate
export { EVAL_HARNESS_REVISION, GRADER_REVISIONS, LLM_GRADER_IDS } from './grader-revisions.ts';
export { canonicalDifferences, canonicalProjection, canonicalState, trialKey, trialModelRoutes, withoutIds, type TrialKeyParts } from './trial-records.ts';
export {
  GRADER_DATA_DEPENDENCIES, GRADER_DEPENDENCIES, GRADER_LOCK_PATH, bridgeCompare, currentGraderLock, fingerprintOf, graderFingerprint, graderLockProblems, readGraderLock,
  renderGraderLock, runBridge, versionedGraderIds, type GraderLock,
} from './versioning.ts';
export {
  DEFAULT_CALIBRATION_SET_PATH, DEFAULT_CALIBRATION_THRESHOLDS, DEFAULT_PACKET_BYTES, JUDGE_ANSWER_SCHEMA, JUDGE_SYSTEM_PROMPT, JUDGE_VERDICTS, SCRIPTED_JUDGE_PROVIDER,
  VERDICT_CONSISTENCY_RUBRIC, assertCalibrationSet, buildEvidencePacket, calibrationReport, cohensKappa, createLlmJudge, groundJudgeAnswer, judgeMessages, llmRubricGrader,
  loadCalibrationSet, parseJudgeRequest, producerProviders, scriptedJudge, scriptedJudgeBrain, scriptedJudgeRoute, verdictConsistencyPolicy,
  type JudgePolicy, type JudgeSetup, type ScriptedJudgeOptions,
} from './judge.ts';
export {
  CORE_SUITE_GRADERS, INJECTION_PROBE, SECURITY_INCIDENTS_PROBE, baselineEquivalence, freshnessGuardedGrader, generatedTestsGovernedGrader, injectionContainedGrader,
  modelSwitchContinuityGrader,
} from './core-graders.ts';
// (additive) PoC suites, arms, brains, fixtures and acceptance graders
export {
  BANK_ORACLE, KV_ORACLE, LEDGER_ORACLE, OBSERVATIONS_PROBE, ORACLE_ROBUSTNESS_TASK_ID, POC_A_TASK_ID, POC_B_TASK_ID, POC_C_INSUFFICIENT_TASK_ID, POC_C_TASK_ID,
  POC_SUITE_REVISION, RECOVERY_CHAOS_TASK_ID, kvFixture, observationsFile, observationsProbe, oracleRobustnessSuite, oracleRobustnessTask, pocAllSuite, pocATask, pocAWhiteboxSuite,
  pocBEventDrivenSuite, pocBTask, pocCDurableLoadSuite, pocCInsufficientTask, pocCTask, recoveryChaosSuite, recoveryChaosTask,
  // (additive) the core suites
  CONTEXT_FRESHNESS_TASK_ID, CORE_SUITE_REVISION, KV_RELEASE_ORACLE, LEDGER_PAGINATION_ORACLE, MODEL_SWITCH_BASELINE_TASK_ID, MODEL_SWITCH_TASK_ID, SECURITY_INJECTION_TASK_ID,
  TEST_GENERATION_DEFECT_TASK_ID, TEST_GENERATION_INSENSITIVE_TASK_ID, TEST_GENERATION_TASK_ID, contextFreshnessSuite, contextFreshnessTask, coreSuite, modelSwitchBaselineTask,
  modelSwitchSuite, modelSwitchTask, securityInjectionSuite, securityInjectionTask, testGenerationDefectTask, testGenerationInsensitiveTask, testGenerationSuite, testGenerationTask,
} from './suites/index.ts';
export {
  MULTI_ROUTES, POC_ARMS, POC_BRAINS_MODULE, SINGLE_ROUTES, brainArgsFor, builtinArms, liveArm, liveArmAvailable, scriptedMultiLlmArm, scriptedSingleArm,
} from './arms.ts';
export {
  LEAD_TRACE_MARKER, MULTI_PROVIDERS, SINGLE_PROVIDERS, armBrains, pocBrains, pocChildBrains, providerBrain, providersOf, type ArmKind, type PocBrainArgs,
  // (additive) core-suite brain helpers
  INJECTION_MARKER, awaitObservation, pairedCalls, type PairedCall,
} from './brains/index.ts';
export {
  BANK_API_SERVER, FIXTURES_DIR, KV_SERVICE_SERVER, createLedgerRepo, gitShowFile, isLoadWorker, killLoadWorkers, loadJobs, readKvWrites, readObservations, startAttackerEndpoint, startBankApi,
  startKvService, type AttackerEndpoint, type BankApi, type BrainObservation, type KvService, type KvServiceOptions, type KvWrite, type LedgerRepo, type LedgerRepoOptions,
} from './fixtures.ts';
export {
  MAX_BOUNDED_MESSAGE_BYTES, MAX_BOUNDED_REQUEST_BYTES, POC_GRADERS, causalChainGrader, contextIsolationGrader, independentReviewGrader, insufficientDataNotPassedGrader,
  loadJobReattachedGrader, maxConcurrent, modelFallbackGrader, noOrphanOperationsGrader, offloadBoundedGrader, pocAWorkflowGrader, pocBWorkflowGrader, pocCWorkflowGrader,
  recoveryAuditGrader, reportTracesToEvidenceGrader, runningIntervals, singleLeaseOwnerGrader, testChangeGovernedGrader,
} from './poc-graders.ts';
export { EVAL_ORACLE_AUTHORITY, establishOracles } from './oracles.ts';
export { KILL_POINT_STATES, describeKillPoint, killPointCount, killPointProblems } from './child.ts';
export { assertSuiteResult, evaluateReleaseGate, renderReleaseGateReport } from './release-gate.ts';
