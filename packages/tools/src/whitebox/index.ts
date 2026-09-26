// White-box tools, runtime, registry, workspaces, sandbox (owned by the tools-core implementer).
export { ToolRegistry, toolIdToName, toolNameToId, assertValidToolId } from './registry.ts';
export { createToolRuntime, redactSecrets, utf8Head, utf8Tail, DEFAULT_MAX_INLINE_BYTES, SECRET_KEY_PATTERN, REDACTED, SIDE_EFFECT_SETTLE_MS } from './runtime.ts';
export { createEnvironmentRegistry } from './environments.ts';
export { createWorkspaceManager, workspaceIdFor } from './workspaces.ts';
export { confineExisting, normalizeRel, workspaceResource } from './paths.ts';
export { createLocalSandbox, createOciSandbox, buildDockerArgs, dockerNetwork, dockerCliEnv, dockerContainerEnv, allowlistedEnv, SANDBOX_BASE_ENV, DOCKER_CLI_ENV_KEYS } from './sandbox.ts';
export { spawnProcess, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_KILL_GRACE_MS, type SpawnRequest } from './process.ts';
export { SAFE_GIT_CONFIG, TRUSTED_GIT_ENV_KEYS, trustedGitEnv } from './git-exec.ts';
export { parseXml, decodeEntities, type XmlElement } from './xml.ts';
export { parseCoverageJson, parseLcov, parseCobertura, parseGoCoverProfile, parseCoverage, detectCoverageFormat, type CoverageFormat } from './coverage.ts';
export {
  nodeTestRunner, vitestRunner, jestRunner, pytestRunner, goTestRunner, commandRunner, defaultTestRunners,
  parseJunitCases, parseJestJson, parseGoTestJson, applyPytestSummary, goSelectorArgs, buildResult, totalsOf, type CommandRunnerOptions,
} from './runners/index.ts';
export { generateMutants, applyMutant, selectMutants, classifyMutantRun, maskSource, languageOf, runMutationAnalysis, MUTATION_OPERATORS, type MutationAnalysisInput } from './mutation.ts';
export { DEFAULT_SHELL_ALLOWLIST, shellDenial } from './tools/shell.ts';
export { patchPaths, parseNumstatPaths } from './tools/fs.ts';
export { assertNotGitMetadata } from './tools/common.ts';
export { selectRunner } from './tools/testing.ts';
export { extractSymbols, type SymbolHit, type SymbolKind } from './tools/code.ts';
export { builtinTools, whiteboxTools } from './builtin.ts';
