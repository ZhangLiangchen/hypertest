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
export { SECURITY_INCIDENTS_PROBE_NAME, defectEconomics, humanInterventions, outcomeMetrics, trajectoryMetrics } from './metrics.ts';
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
  // (F[4]) PoC C complete: the latency anomaly flow
  KV_HOT_KEY_ANOMALY, POC_C_ANOMALY_TASK_ID, pocCAnomalyTask,
  // (additive) the core suites
  CONTEXT_FRESHNESS_TASK_ID, CORE_SUITE_REVISION, KV_RELEASE_ORACLE, LEDGER_PAGINATION_ORACLE, MODEL_SWITCH_BASELINE_TASK_ID, MODEL_SWITCH_TASK_ID, SECURITY_INJECTION_TASK_ID,
  TEST_GENERATION_DEFECT_TASK_ID, TEST_GENERATION_INSENSITIVE_TASK_ID, TEST_GENERATION_TASK_ID, contextFreshnessSuite, contextFreshnessTask, coreSuite, modelSwitchBaselineTask,
  modelSwitchSuite, modelSwitchTask, securityInjectionSuite, securityInjectionTask, testGenerationDefectTask, testGenerationInsensitiveTask, testGenerationSuite, testGenerationTask,
  // (coverage[15]) the tier suites
  TIER_SUITE_REVISION, deepSuite, failureRecoverySuite, prSmokeSuite,
  // (F[5]/F[6]/F[7]) the extended core suites and chaos cases
  API_BLACKBOX_TASK_ID, BANK_UI_ORACLE, BUDGET_EXHAUSTION_TOOL_CALLS, CHAOS_BUDGET_EXHAUSTION_TASK_ID, CHAOS_COMPETING_FAULTS_TASK_ID, CHAOS_KILL_AFTER_SUCCESS_TASK_ID,
  CHAOS_UNQUERYABLE_TARGET_TASK_ID, EVIDENCE_MISSING_TASK_ID, EVIDENCE_TAMPER_TASK_ID, EXTENDED_SUITE_REVISION, FAULT_TOLERANCE_ERRORS_TASK_ID, FAULT_TOLERANCE_LATENCY_TASK_ID,
  KV_FLAG_ORACLE, KV_RESILIENCE_ORACLE, MULTI_AGENT_CONVERGENCE_TASK_ID, MULTI_AGENT_DELEGATION_TASK_ID, PERFORMANCE_REGRESSION_TASK_ID, PERFORMANCE_SLO_TASK_ID, UI_BLACKBOX_TASK_ID,
  apiBlackboxTask, apiUiBlackboxSuite, chaosBudgetExhaustionTask, chaosCompetingFaultsTask, chaosKillAfterSuccessTask, chaosSuite, chaosUnqueryableTargetTask, evidenceMissingTask,
  evidenceSuite, evidenceTamperTask, extendedTasks, faultToleranceErrorsTask, faultToleranceLatencyTask, faultToleranceSuite, multiAgentConvergenceTask, multiAgentDelegationTask,
  multiAgentSuite, performanceRegressionTask, performanceSloTask, performanceSuite, uiBlackboxTask,
} from './suites/index.ts';
export {
  EXTENDED_GRADERS, WHITE_BOX_TOOL_PREFIXES, blackBoxOnlyGrader, budgetExhaustionGrader, competingFaultsIsolatedGrader, convergenceGrader, delegationGrader, faultToleranceGrader,
  tamperDetectedGrader, uiEvidenceGrader, unqueryableEscalatedGrader, providerClassesAuditedGrader,
} from './extended-graders.ts';
export { fromAnthropicMessages, fromOpenAIMessages, scriptedWireFetch, wireHost, type WireCall, type WireClass, type WireEndpoint } from './wire.ts';
export {
  MULTI_ROUTES, POC_ARMS, POC_BRAINS_MODULE, SINGLE_ROUTES, brainArgsFor, builtinArms, liveArm, liveArmAvailable, scriptedMultiLlmArm, scriptedSingleArm,
  // (F[8], item 6) causal, product-engine and three-provider-class arms
  CAUSAL_ARMS, CAUSAL_ARM_FEATURES, PRODUCT_ARMS, PRODUCT_ENGINES, THREE_CLASS_PROVIDERS, WIRE_CALLS_PROBE, WIRE_KEY_ENV, causalArm, productEngineArm, scriptedConfig, threeProviderClassArm,
} from './arms.ts';
export {
  LEAD_TRACE_MARKER, MULTI_PROVIDERS, SINGLE_PROVIDERS, armBrains, pocBrains, pocChildBrains, providerBrain, providersOf, type ArmKind, type PocBrainArgs,
  // (additive) core-suite brain helpers
  INJECTION_MARKER, awaitObservation, pairedCalls, type PairedCall,
  // (F[4]) PoC C anomaly brains
  KV_P99_BOUND_MS, KV_REGRESSION_TEST_PATH, anomalyRoles, kvRegressionTest, timingScript,
  // (F[5]/F[6]/F[7]) extended-suite brains
  BANK_UI_ORACLE_ID, FLAG_ORACLE_ID, FLAG_PATH, FT_FAULTS, FT_FAULT_MS, KV_RESILIENCE_ORACLE_ID, UI_REGRESSION_TEST_PATH, UI_REJECTED_MESSAGE,
} from './brains/index.ts';
export {
  BANK_API_SERVER, FIXTURES_DIR, KV_SERVICE_SERVER, createLedgerRepo, gitShowFile, isLoadWorker, killLoadWorkers, loadJobs, readKvWrites, readObservations, startAttackerEndpoint, startBankApi,
  startKvService, type AttackerEndpoint, type BankApi, type BrainObservation, type KvService, type KvServiceOptions, type KvWrite, type LedgerRepo, type LedgerRepoOptions,
} from './fixtures.ts';
export {
  MAX_BOUNDED_MESSAGE_BYTES, MAX_BOUNDED_REQUEST_BYTES, POC_GRADERS, causalChainGrader, contextIsolationGrader, independentReviewGrader, insufficientDataNotPassedGrader,
  loadJobReattachedGrader, maxConcurrent, modelFallbackGrader, noOrphanOperationsGrader, offloadBoundedGrader, pocAWorkflowGrader, pocBWorkflowGrader, pocCWorkflowGrader,
  recoveryAuditGrader, reportTracesToEvidenceGrader, runningIntervals, singleLeaseOwnerGrader, testChangeGovernedGrader,
  anomalyReactionGrader, latestOf, rcaMetricsExecutorParallelGrader, reactionsTo,
} from './poc-graders.ts';
export { EVAL_ORACLE_AUTHORITY, establishOracles } from './oracles.ts';
export { KILL_POINT_STATES, describeKillPoint, killPointCount, killPointProblems } from './child.ts';
export { DEFAULT_CRITICAL_FALSE_RELEASE_SLO, assertSuiteResult, evaluateReleaseGate, renderReleaseGateReport } from './release-gate.ts';
// (additive, wave 3 release-eval) tiers, tracks and task constraints, suite/environment versioning, retained graders,
// external product arms, the configured judge and human calibration, the private and public sanity layers
export { EVAL_TIERS, EVAL_TIER_IDS, tierSpec, type TierSpec } from './tiers.ts';
export { seedExperience, taskConstraintProblems, taskPolicyRules, toolPatternCovers, trackProblems, withTaskConstraints } from './task-constraints.ts';
export {
  EVAL_PACKAGE_ROOT, SUITE_LOCK_PATH, SUITE_SOURCE_PATHS, builtinSourcesDigest, currentSuiteLock, environmentDigestOf, filesDigest, readSuiteLock, renderSuiteLock, suiteFingerprint,
  suiteLockProblems, taskDefinition, type SuiteLock,
} from './suite-versions.ts';
export { RETAINED_GRADERS, generatedTestsGovernedV1, retainedGrader } from './retained-graders.ts';
export { EXTERNAL_GRADER_REVISION, externalAgentArm, externalArgs, externalReportProblems, runExternalTrial, type ExternalAgentReport } from './external.ts';
export { configuredJudge, labelCalibrationItem, recordingJudge, type ConfiguredJudgeOptions, type RecordedJudgePacket } from './judge-config.ts';
export { SANITY_SUITE_REVISION, declarativeTask, loadSuiteDirectory, parseSweBench, sanitySuite, type DeclarativeSuite, type DeclarativeTask, type LoadedSuite, type SweBenchInstance } from './layers.ts';
