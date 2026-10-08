export * from './contracts.ts';
export {
  PERMISSION_PROFILES, PRODUCT_FIX_SCOPE, attenuateCapability, capabilityAllows, createRootCapability, holdsProductFix, nonCanonicalResource, signCapability, verifyCapability,
} from './capabilities.ts';
export { globToRegExp, intersectPatterns, matchesGlob, matchesPattern, matchesResourcePattern, matchesToolPattern, patternCovers, resourcePatternCovers, toolPatternCovers } from './patterns.ts';
export {
  BuiltinPolicyEngine, CompositePolicyEngine, DEFAULT_POLICY_RULES, PERMIT_CONSTRAINTS_SCHEMA, POLICY_RULE_SCHEMA, intersectConstraints, mostRestrictive, ruleMatches,
} from './engine.ts';
export { OpaPolicyEngine } from './opa.ts';
export { createPolicyDecisionLog, policyRequestHash } from './decision-log.ts';
export { createApprovalService } from './approvals.ts';
export { assertMayDecide, authorityProblems, createOracleGovernance } from './oracle-governance.ts';
export { agentIndependenceViolation, type IndependenceViolation } from './independence.ts';
export { DEFAULT_TEST_PATH_PATTERNS, categoryDecision, classifyTestChange } from './classifier.ts';
export { parseUnifiedDiff, type DiffFile, type DiffHunk, type DiffLine } from './diff.ts';
export { DEFAULT_GATE_SPEC, GATE_CRITERIA, ORACLE_AUTHORITY_KINDS, QualityGate, currentRecords, evaluateOracleCheck, gateOverrides, oracleAuthorityProblems, type OracleCheckOutcome } from './gate.ts';
export {
  TEST_FILE_PATH_PATTERNS, TEST_RUNNER_DISCOVERY_PATTERNS, artifactCaseStatuses, artifactEligibility, caseInFile, codeRevisionOf, executedTestsOf, isBaseRevisionRun, isTestPath,
  mutatedFileOf, normalizeTestPath, oracleRefProblems, reviewProblems, sameTestFile, sensitivityBinding, type ArtifactEligibility, type Binding, type BindingPurpose, type CodeRevision, type EligibilityContext, type ExecutedTestFile, type ExecutedTests,
  type StageStatus, type StaticCheckResult,
} from './sensitivity.ts';
export {
  ACTION_MAY_HAVE_HAPPENED, FAULT_TOOL_IDS, LOAD_TOOL_IDS, evaluateStopConditions, exclusiveResourcesOf, experimentValidity, faultMatches, observedErrorRate, planViolation,
  type ExperimentActionFacts, type ExperimentFacts, type ExperimentValidity, type ExperimentValidityInput, type GateOperation, type StopEvaluation,
} from './experiments.ts';
export { DEFAULT_PROTOCOL_CONTEXT_BYTES, extractMarkdownSections, prepareProtocolContext, resolveProtocolBinding } from './bugate.ts';
export { EMBEDDED_PRINCIPLES, EMBEDDED_PROTOCOL_VERSION, PREPARED_PROTOCOL_CONTEXT_SCHEMA } from './bugate-embedded.ts';
export { policyMigrations } from './migrations.ts';
export {
  IMPLICIT_EVIDENCE_TYPES, POLICY_PHASES, acceptanceFacts, actionOutcomeFacts, applyPhasePermit, flaggedActionsOf, requestPhase, withPolicyHold, type PolicyHold,
} from './phases.ts';
