export * from './contracts.ts';
export {
  DEFAULT_ENV_ALLOWLIST, ENGINE_KINDS, PROVIDER_KINDS, ROUTE_DEFAULTS, completeRoute, defaultConfig, defaultedRouteFields, interpolateConfig, loadConfig, mergeConfig,
  oracleConfigProblems, oracleSpecFromConfig, providerCompatibilityClass, resolveConfigPaths, roleOverrides, secretVariableNames, validateConfig, validateRunOverrides, withDerivedPaths,
} from './config.ts';
export {
  ALL_MIGRATIONS, HYPERTEST_VERSION, hypertestSourceDigest, MAX_AGENTS_PER_RUN, RELAY_POLL_MS, RUN_ID_RE, TOOL_SCHEMA_VERSION, buildCatalog, createHypertest, decisionProblems, defaultWorkerId,
  manifestTaskQueue, pinnedControlPlane, sandboxProfile, sandboxHiddenPaths, sandboxEgressOrigins, opaPolicyRevision, type PinLookup,
  applyScoresFile, modelPricesFile, configuredModels,
  cachedRetrievers,
} from './compose.ts';
export { ENVIRONMENT_STATE_FILE, persistentEnvironmentRegistry, resolveEnvironments, resolveUrlTarget } from './environments.ts';
/** (additive, F[8]) Harness features of the eval causal arms (H0 … H6). */
export { FULL_HARNESS, HARNESS_FEATURE_KEYS, applyHarnessFeatures, disabledFeatures, harnessFeatures, harnessFreshness, harnessRoleCatalog } from './harness-features.ts';
export { acquireDirectoryLock, lockFileFor, lockHolder, processAlive, type DirectoryLock } from './lock.ts';
export { CAPABILITY_SECRET_FILE, SIGNING_KEY_FILE, keysDir, loadCapabilitySecret, loadSigningKeys, publicKeyFileName, type SigningKeys } from './keys.ts';
export { changedAssertions, flipsRecordedViolation, recordedFailureFlipDetector, testCaseMatches, type FlipDetectorDeps } from './governance.ts';
export { startApiServer, isLoopbackHost } from './api.ts';
export { serveMemory, startMemoryServiceProcess, type MemoryServiceConfig, type MemoryServiceProcess, type RunningMemoryService } from './memory-service.ts';
export { diagnose, providerLocality } from './diagnose.ts';
export {
  DEFAULT_CHECKPOINT_TIMEOUT_MS, IMAGE_DIGEST_ENV, agentClassification, condenserPrivacyFloor, createReleaseService, hypertestGitSha, imageDigestFrom, releaseGovernedControlPlane,
  runtimeReleaseNotes, withRuntimeReleaseNotes, type ReleaseServiceDeps,
  // (additive, F[0]/F[1]) shadow mirroring, dry-run effects, bound eval results, verified migration drive
  DEFAULT_DRIVE_TIMEOUT_MS, DEFAULT_SHADOW_TIMEOUT_MS, DRY_RUN_REASON, evalTrialManifests, shadowDivergences, shadowDryRunAdapters, shadowRunId, shadowRunLookup, type ShadowSettings,
} from './releases.ts';
/** (additive) Model governance helpers for the CLI: eval-derived route scores (coverage[7]) and observed prices (A[1]). */
export { deriveRouteScores, parseRouteScoresFile, readPricesFile, updatePricesFile, type RouteScoresFile, type ScoredTrial, type PricesFile } from '@hypertest/model';
/** (additive, B[7] / B[4]) Skill registry and memory service helpers for the CLI (`hypertest skill …`, `hypertest memory serve`). */
export { renderSkillMarkdown, skillArmId, skillDigest, SKILL_NAME_RE, SKILL_STATUSES, type SkillEvalResult, type SkillRegistry, type SkillRevision, type SkillStatus, type SkillValidation } from '@hypertest/context';
/** (additive, wave 3: tool surface) remote tool workers, MCP / remote-worker configuration helpers. */
export { startToolWorker, type StartedToolWorker, type ToolWorkerOptions } from './tool-worker.ts';
export {
  DEFAULT_ACP_ROLES, DEFAULT_COMPUTER_ROLES, DEFAULT_MCP_ROLES, acpAgentConfigs, acpAgentProblems, computerUseOptions, computerUseProblems, environmentToolProblems, mcpServerConfigs, mcpServerProblems,
  remoteWorkerProblems, withRemoteWorkers, withToolRoleGrants, isolationResolver, sandboxKeyProblems, sandboxRoleProblems,
} from './tool-config.ts';
