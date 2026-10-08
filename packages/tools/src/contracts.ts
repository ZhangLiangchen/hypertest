import type { BaseDeps, Clock, JsonSchema, JsonValue, Logger, SqlDatabase } from '@hypertest/core';
import type { ActionCapability, DataClassification, ArtifactRef, ContextSnapshot, DomainEventSink, EventContext, EvidenceInput, EvidenceRecord, EvidenceType, Provenance, ResourceRef, RiskClass, ToolDefinition, ToolEffect } from '@hypertest/domain';
import type { ArtifactStore, EvidenceLedger } from '@hypertest/evidence';
import type { SideEffectAdapter, SideEffectGateway } from '@hypertest/operation';
import type { ActionPermit, PolicyDecisionLog, PolicyEngine } from '@hypertest/policy';

/**
 * @hypertest/tools — the Tool & Capability Runtime and the testing execution plane.
 *
 * Every invocation passes the pipeline (I1, I4, I9, I10):
 *   lookup → input schema validation → capability check (policy.capabilityAllows) → PolicyEngine permit
 *   (+ decision log) → FreshnessGuard for mutating effects → execution (side effects only through the
 *   SideEffectGateway with a stable operationId) → timeout/abort → output offload to the ArtifactStore
 *   → evidence records → tool.called / tool.completed / tool.denied events.
 * A failing test is `status: 'success'` at the transport level with `outcome.passed = false` inside the
 * structured result — never a thrown error (domain failure ≠ tool failure).
 * (additive, conformance-7) A tool WITHOUT a side-effect binding whose computed effect is `external`/`destructive`
 * (http.request POST/PUT/PATCH/DELETE, browser.click/fill, mcp.*) runs — when a gateway is configured — through
 * `SideEffectGateway.run` with the record-only adapter (`tool.effect`, or `tool.effect.resendable` when
 * `spec.resendable(input)`): executed once per invocation id; a replay returns the recorded outcome; an interrupted
 * call ends in manual_review (or one deduplicated resend), never a blind resend. Register `recordEffectAdapters()`
 * (included in `builtinSideEffectAdapters`) with the gateway.
 *
 * Implementations to export from src/index.ts:
 *   createToolRuntime(deps: ToolRuntimeDeps): ToolRuntime
 *   class ToolRegistry implements ToolRegistryLike
 *   createWorkspaceManager(deps: WorkspaceDeps): WorkspaceManager
 *   builtinTools(options: BuiltinToolOptions): ToolSpec[]      — all tools below
 *   builtinSideEffectAdapters(options): SideEffectAdapter[]   — load generator, process env, docker, kubectl
 *   runner adapters: nodeTestRunner, vitestRunner, jestRunner, pytestRunner, goTestRunner, commandRunner (TestRunnerAdapter)
 *   coverage parsers: parseCoverageJson (coverage.py), parseLcov, parseCobertura, parseGoCoverProfile → CoverageMap
 *   mutation: generateMutants(file, source, language) + runMutationAnalysis(...)
 *   startHttpLoadGenerator / HttpLoadJob (built-in load generator process; operation-id labelled job files)
 *   McpToolBridge (stdio MCP client → ToolSpecs; @modelcontextprotocol/sdk)
 *
 * Built-in tool ids (effect/risk):
 *   fs.read, fs.list, fs.search (read/low) · fs.write, fs.apply_patch (write_workspace/medium; isolated worktree only)
 *   git.status, git.diff, git.log, git.show, git.blame (read/low) · git.commit (write_workspace/medium)
 *   shell.exec (execute/medium; allowlisted commands; scrubbed env; sandbox cwd)
 *   test.run (execute/medium) · coverage.collect (execute/low) · mutation.run (execute/medium)
 *   code.symbols, code.references (read/low)
 *   http.request (read for GET/HEAD else external/medium; records api-response evidence)
 *   metrics.query, metrics.scrape (read/low; Prometheus HTTP API / text exposition)
 *   load.start (external/high, side-effect adapter `load.http`), load.observe (read), load.stop (external/medium)
 *   env.restart, env.inject_fault, env.deploy (destructive/high|critical, side-effect adapters)
 *   browser.navigate, browser.click, browser.fill, browser.screenshot, browser.text (Playwright; optional)
 */

export interface ToolContext {
  runId: string;
  workItemId: string;
  agentId: string;
  role: string;
  /** Stable across retries: `${sessionId}:${turn}:${toolCallId}`. */
  invocationId: string;
  workspace: WorkspaceHandle;
  artifacts: ArtifactStore;
  /**
   * Records evidence with producer/provenance pre-filled by the runtime. (additive) `environment`: the environment the
   * evidence was captured in; when omitted, the runtime records the environment the tool's input addresses
   * (`input.environmentId` of a registered environment, at its generation at execution) — black-box evidence then has
   * a provenance anchor (L5: evidence → environment/generation) instead of a gap.
   */
  recordEvidence(input: { evidenceType: EvidenceType; data: string | Uint8Array; mimeType: string; summary: string; structured?: JsonValue; operationId?: string; parentEvidenceIds?: string[]; provenance?: EvidenceInput['provenance']; environment?: EvidenceInput['environment'] }): Promise<EvidenceRecord>;
  /** Only for tools with a sideEffect binding. */
  sideEffects?: SideEffectGateway;
  eventContext: EventContext;
  snapshot?: ContextSnapshot;
  permit: ActionPermit;
  signal: AbortSignal;
  logger: Logger;
  /** Environment registry for black-box tools (base URLs, metrics endpoints, env classes). */
  environments: EnvironmentRegistry;
  /**
   * (additive) Owner of the side-effect resource leases this call takes (the gateway's `lease.owner`):
   * `ToolExecutionRequest.leaseOwner`, else the agent id. Set by the runtime.
   */
  leaseOwner?: string;
  /**
   * (additive) The work-item claim the call runs under (`ToolExecutionRequest.claim`). Tools that record effects
   * themselves (e.g. blackboard writes) re-check it right before they write, so a worker whose claim was revoked while
   * the call was in flight never writes.
   */
  claim?: ToolClaim;
  /** (additive, conformance-6) `ToolExecutionRequest.experimentId`. */
  experimentId?: string;
}

/** (additive) A work-item claim a tool call runs under: the claim lease's fencing token (and lease id / holder). */
export interface ToolClaim {
  workItemId: string;
  fencingToken: number;
  leaseId?: string;
  ownerId?: string;
}

export type ToolStatus = 'success' | 'failed' | 'timeout' | 'denied' | 'pending' | 'stale_context';

export interface ToolOutcome<O = JsonValue> {
  status: ToolStatus;
  /** Small structured result (validated against outputSchema when present). */
  structured?: O;
  /** Model-visible text; the runtime truncates/offloads it (I9). */
  text?: string;
  artifactRefs?: ArtifactRef[];
  evidenceRefs?: string[];
  operationId?: string;
  error?: { code: string; message: string };
}

export interface SideEffectBinding {
  adapterId: string;
  operationType: string;
  /**
   * Derive the external target and the lease resource from the input. The target's resourceKey must be one
   * of (or beneath) the tool's `resources(input)` — the runtime refuses (permission_denied) any other target.
   */
  target(input: unknown, ctx: ToolContext): ResourceRef;
  leaseTtlMs?: number;
}

export interface ToolSpec<I = any, O = JsonValue> {
  id: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  effect: ToolEffect | ((input: I) => ToolEffect);
  riskClass: RiskClass | ((input: I) => RiskClass);
  /** Concrete resource keys touched (for capability scopes, freshness and resource claims). */
  resources(input: I, ctx: Pick<ToolContext, 'workspace' | 'runId' | 'environments'>): string[];
  environmentClass?: (input: I, ctx: Pick<ToolContext, 'environments'>) => string | undefined;
  sideEffect?: SideEffectBinding;
  /**
   * (additive) For a tool WITHOUT a side-effect binding whose computed effect is `external`/`destructive` (the runtime
   * records such calls in the Operation Ledger through the record-only adapter, keyed by the invocation id): true when
   * the target deduplicates a resend of this very invocation (e.g. http.request to an environment declaring
   * `honoursIdempotencyKey`, the request carrying `Idempotency-Key: <invocationId>`). An interrupted call is then
   * re-sent once instead of going to manual review. Ignored at risk `high` or above.
   */
  resendable?(input: I, ctx: Pick<ToolContext, 'environments'>): boolean;
  timeoutMs: number;
  /** Bytes of model-visible text before offloading to an artifact (default 16 KiB). */
  maxInlineBytes?: number;
  execute(input: I, ctx: ToolContext): Promise<ToolOutcome<O>>;
}

export interface ToolRegistryLike {
  register(spec: ToolSpec): void;
  get(id: string): ToolSpec | undefined;
  list(): ToolSpec[];
  /** Tool definitions visible to a model under a capability + tool policy (id → name with `.` → `__`). */
  definitionsFor(capability: ActionCapability, allow: string[], deny?: string[]): ToolDefinition[];
  /** Registry content hash for RuntimeManifest.toolCatalogRevision. */
  revision(): string;
}

export interface ToolExecutionRequest {
  toolId: string;
  input: unknown;
  invocationId: string;
  runId: string;
  workItemId: string;
  agentId: string;
  role: string;
  capability: ActionCapability;
  workspace: WorkspaceHandle;
  snapshot?: ContextSnapshot;
  eventContext: EventContext;
  signal: AbortSignal;
  timeoutMs?: number;
  /**
   * (additive) Owner of the side-effect resource leases the call takes (default `agentId`). Pass a claim-scoped owner
   * (e.g. `${agentId}#${claim fencing token}`): a stale worker of the same agent — whose claim was revoked and
   * re-granted to another worker — is then a different owner and never reuses the live claim's resource lease.
   */
  leaseOwner?: string;
  /**
   * (additive, privacy) Data classification of the calling agent's role: every evidence record the call produces is
   * stored with it (runtime-set, never the tool's say), so readers below that clearance can be refused its content.
   */
  dataClassification?: DataClassification;
  /**
   * (additive) The work-item claim the call is made under; it must be a claim on `workItemId` (else `denied`). Handed to
   * the tool as `ToolContext.claim` so tools that record effects re-check it right before writing.
   */
  claim?: ToolClaim;
  /**
   * (additive, conformance-6) The experiment the call runs for (the work item declared it). Recorded on every evidence
   * record the call produces (`provenance.experimentId`, see ExperimentProvenance), on the operation of a side-effect call
   * (`RunSideEffectRequest.experimentId`) and in `tool.called`; handed to the tool as `ToolContext.experimentId`.
   */
  experimentId?: string;
  /**
   * (additive, D-8/D-9) The run's SystemModel revision when the call was made: recorded in the provenance of every evidence
   * record the call produces (`provenance.systemModelRevision`), so evidence is traceable to the system model it was
   * gathered under (as decisions are).
   */
  systemModelRevision?: number;
  /**
   * (additive, conformance-5) Resource bounds of this call: `maxArtifactBytes` — the artifact budget left to the caller; a
   * put that would exceed it is refused (`budget_exhausted`), nothing is stored.
   */
  limits?: { maxArtifactBytes?: number };
}

/** (additive, conformance-5) Resources a call consumed: sandbox process wall time and bytes stored (distinct objects). */
export interface ToolUsage {
  computeMs: number;
  artifactBytes: number;
}

/**
 * (additive, conformance-6) Evidence provenance of a call made for an experiment. The runtime records `experimentId` in
 * the (hash-chained) provenance of every evidence record the call produces; read it with `evidenceExperimentId(record)`.
 */
export interface ExperimentProvenance extends Provenance {
  experimentId?: string;
  /** (additive, D-8) The run's SystemModel revision at the call (ToolExecutionRequest.systemModelRevision). */
  systemModelRevision?: number;
}

export interface ToolExecutionResult {
  toolId: string;
  invocationId: string;
  status: ToolStatus;
  structured?: JsonValue;
  /** Bounded model-visible rendering (includes artifact refs when offloaded). */
  modelText: string;
  artifactRefs: ArtifactRef[];
  evidenceRefs: string[];
  operationId?: string;
  permit?: ActionPermit;
  durationMs: number;
  error?: { code: string; message: string };
  /** (additive, conformance-5) What the call consumed (zero for calls that never executed). */
  usage?: ToolUsage;
}

/** Structural freshness port (implemented by @hypertest/context FreshnessGuard). */
export interface FreshnessPort {
  validate(snapshot: ContextSnapshot | string, action: { tool: string; resources: string[]; mutating: boolean }, ctx: EventContext): Promise<{ fresh: true; checked: number } | { fresh: false; checked: number; stale: Array<{ resourceType: string; resourceId: string; reason: string }> }>;
}

export interface ToolRuntimeDeps extends BaseDeps {
  registry: ToolRegistryLike;
  policy: PolicyEngine;
  decisionLog?: PolicyDecisionLog;
  freshness?: FreshnessPort;
  sideEffects?: SideEffectGateway;
  artifacts: ArtifactStore;
  evidence: EvidenceLedger;
  events?: DomainEventSink;
  environments: EnvironmentRegistry;
  runtimeManifestId: string;
  workerId: string;
  /** Secret used to verify capability signatures. */
  capabilitySecret: string;
}

export interface ToolRuntime {
  readonly registry: ToolRegistryLike;
  /**
   * Idempotent per invocationId for side-effect tools (the operation is found again via the ledger).
   * Never throws for domain outcomes; throws only on programmer errors.
   */
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}

// ----------------------------------------------------------------------------- workspaces + sandbox

export interface WorkspaceHandle {
  workspaceId: string;
  kind: 'shared_readonly' | 'isolated_worktree' | 'scratch';
  root: string;
  /** Git commit the workspace was created from (when a repo). */
  baseCommit?: string;
  branch?: string;
  readOnly: boolean;
  sandbox: SandboxProfile;
  /** Resource key prefix for capability scopes: `workspace/<workspaceId>`. */
  resourcePrefix: string;
  /**
   * (additive) Private per-workspace directory OUTSIDE `root` for sandbox HOME/TMPDIR, test reports and
   * mutation copies, so tools never pollute the workspace (or its diff). Set by the WorkspaceManager.
   */
  tempDir?: string;
}

export interface SandboxProfile {
  kind: 'local' | 'oci';
  image?: string;
  network: 'none' | 'loopback' | 'egress_allowlist' | 'open';
  allowedHosts?: string[];
  /** Environment variables passed through (everything else is scrubbed). */
  envAllowlist: string[];
  cpuLimit?: number;
  memoryMb?: number;
}

export interface WorkspaceDeps extends BaseDeps {
  /** Directory under which worktrees/scratch dirs are created (e.g. `.hypertest/workspaces`). */
  baseDir: string;
  defaultSandbox: SandboxProfile;
}

export interface WorkspaceManager {
  /** Read-only view of the target (no copy for local paths; a git worktree at `commit` when given). */
  sharedSnapshot(input: { runId: string; repoPath: string; commit?: string }): Promise<WorkspaceHandle>;
  /** Isolated git worktree on branch `ht/<runId>/<workItemId>` for mutating agents. */
  isolatedWorktree(input: { runId: string; workItemId: string; repoPath: string; baseCommit?: string }): Promise<WorkspaceHandle>;
  scratch(input: { runId: string; workItemId: string }): Promise<WorkspaceHandle>;
  get(workspaceId: string): WorkspaceHandle | undefined;
  /** Resolves a path inside the workspace; throws permission_denied on traversal or symlink escape. */
  resolvePath(ws: WorkspaceHandle, relPath: string): Promise<string>;
  /** Unified diff of the worktree against its base. */
  diff(ws: WorkspaceHandle): Promise<string>;
  /**
   * (additive, optional) Every file that differs between the workspace and its base commit — committed on the work
   * branch, staged, unstaged or untracked (ignored files excluded) — with the sha256 of its current content (regular
   * files; absent for deletions and non-regular files). A scratch workspace (no repository: everything in it was
   * created in the run) lists every file as `added`. `precondition_failed` for a workspace without a git base that
   * is not a scratch workspace, or a handle this manager did not create/re-attach.
   */
  changedFiles?(ws: WorkspaceHandle): Promise<WorkspaceChange[]>;
  dispose(workspaceId: string): Promise<void>;
}

/** (additive) One file of a workspace that differs from the workspace's base commit (see WorkspaceManager.changedFiles). */
export interface WorkspaceChange {
  /** Workspace-relative POSIX path. */
  path: string;
  change: 'added' | 'modified' | 'deleted';
  /** sha256 hex of the current content (regular files only). */
  sha256?: string;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** (additive) Set when the program could not be started (e.g. ENOENT); exitCode is then 127. */
  spawnError?: string;
}

export interface SandboxRunner {
  /** (additive, optional) Which isolation the runner provides. */
  readonly kind?: 'local' | 'oci';
  run(ws: WorkspaceHandle, command: string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs: number; signal: AbortSignal; stdin?: string; maxOutputBytes?: number }): Promise<ProcessResult>;
  /** (additive, optional) Probes whether the runner can execute at all (e.g. docker daemon reachable). */
  available?(): Promise<boolean>;
}

// ----------------------------------------------------------------------------- environments (black-box)

export interface EnvironmentDescriptor {
  environmentId: string;
  environmentClass: 'local' | 'sandbox' | 'staging' | 'production' | (string & {});
  baseUrl?: string;
  metricsUrl?: string;
  prometheusUrl?: string;
  generation: number;
  buildDigest?: string;
  /** Process/docker/k8s control descriptors for env.* adapters. */
  control?: { kind: 'process' | 'docker' | 'kubectl'; target: string; namespace?: string; command?: string[] };
  /**
   * (additive) The SUT deduplicates non-idempotent requests by their `Idempotency-Key` header: a request interrupted
   * between sending and recording may be re-sent once with the same key (conformance-7); otherwise it goes to manual
   * review. Declare it only for SUTs that really honour the header.
   */
  honoursIdempotencyKey?: boolean;
  /**
   * (additive, coverage-13) The environment's isolation as registered by its operator (never claimed by an agent):
   * `dedicated` — the environment (and the namespace / database / account named here) serves one experiment at a time.
   * Only a dedicated environment admits an experiment with isolation mode `dedicated_environment`; the experiment records
   * these fields in its IsolationPlan.
   */
  isolation?: { dedicated: boolean; namespace?: string; database?: string; account?: string };
}

export interface EnvironmentRegistry {
  get(environmentId: string): EnvironmentDescriptor | undefined;
  list(): EnvironmentDescriptor[];
  register(env: EnvironmentDescriptor): void;
  /**
   * Bumps generation (after deploy/restart) — invalidates snapshots that observed the old one. (additive)
   * `operationId`: the verified operation the bump belongs to. A bump already recorded for it is returned as recorded
   * instead of bumping again — a re-verification (a duplicate observe, or a reconciliation after a crash between the
   * bump and the ledger's `verified`) never counts one restart twice.
   */
  bumpGeneration(environmentId: string, buildDigest?: string, operationId?: string): EnvironmentDescriptor;
  /**
   * (additive, optional) Authoritative read of an environment's generation from a store shared by every process
   * (the SQL registry); updates this registry's view. Freshness resolvers should prefer it over `get` when present.
   */
  load?(environmentId: string): Promise<EnvironmentDescriptor | undefined>;
  /**
   * (additive, optional) Durable, cross-process atomic `bumpGeneration` (the same operation bumps once across every
   * process sharing the store). The env.* adapters prefer it when present.
   */
  bumpGenerationAsync?(environmentId: string, buildDigest?: string, operationId?: string): Promise<EnvironmentDescriptor>;
}

/** (additive) Dependencies of createSqlEnvironmentRegistry (the core SqlDatabase port; migrations `toolsMigrations`). */
export interface SqlEnvironmentRegistryDeps {
  db: SqlDatabase;
  clock?: Clock;
  logger?: Logger;
}

/**
 * (additive) EnvironmentRegistry whose generations (and generation bumps by operation id) live in SQL, shared by every
 * worker process: a restart never forgets a deploy/restart (stale snapshots stay stale), and one operation bumps once
 * across processes. Descriptors themselves (URLs, control targets — possibly secret) come from the configuration of each
 * process and are never stored. `get`/`list` answer from the local view; `load`/`refresh` read the store.
 */
export interface SqlEnvironmentRegistry extends EnvironmentRegistry {
  load(environmentId: string): Promise<EnvironmentDescriptor | undefined>;
  bumpGenerationAsync(environmentId: string, buildDigest?: string, operationId?: string): Promise<EnvironmentDescriptor>;
  /** Durable `register` (generation = max(stored, given)); the sync `register` queues the same write. */
  registerAsync(env: EnvironmentDescriptor): Promise<EnvironmentDescriptor>;
  /** Re-reads every locally registered environment's generation from the store (never moves one backwards). */
  refresh(): Promise<void>;
  /** Resolves once every write queued by the sync `register`/`bumpGeneration` is durable; rejects with the first failure. */
  flush(): Promise<void>;
}

// ----------------------------------------------------------------------------- test runners + coverage

export type TestCaseStatus = 'passed' | 'failed' | 'skipped' | 'xfail' | 'xpass' | 'error';

export interface TestCaseResult {
  id: string;
  name: string;
  file?: string;
  status: TestCaseStatus;
  durationMs?: number;
  message?: string;
}

export interface TestRunResult {
  framework: string;
  command: string[];
  exitCode: number | null;
  totals: Record<TestCaseStatus, number> & { total: number };
  cases: TestCaseResult[];
  /** True only when every selected case passed and at least one ran (fake-green guard). */
  passed: boolean;
  /** Harness-level problems (collection errors, crashes) distinguished from assertion failures. */
  harnessError?: string;
  durationMs: number;
}

export interface TestRunnerAdapter {
  readonly framework: string;
  detect(ws: WorkspaceHandle): Promise<boolean>;
  run(ws: WorkspaceHandle, request: { selector?: string; coverage?: boolean; timeoutMs: number; signal: AbortSignal; env?: Record<string, string> }, sandbox: SandboxRunner): Promise<{ result: TestRunResult; rawReport?: { data: string; mimeType: string }; stdout: string; stderr: string; coverage?: CoverageMap }>;
}

export interface CoverageMap {
  format: 'coverage.py' | 'lcov' | 'cobertura' | 'go' | 'v8' | (string & {});
  files: Array<{ path: string; lines: { covered: number; total: number }; branches?: { covered: number; total: number } | 'unknown' }>;
  totals: { lines: { covered: number; total: number }; branches: { covered: number; total: number } | 'unknown' };
}

export interface BuiltinToolOptions {
  runners?: TestRunnerAdapter[];
  shellAllowlist?: string[];
  sandbox: SandboxRunner;
  workspaces: WorkspaceManager;
  retrieval?: { search(query: { text: string; symbol?: string; root?: string; limit?: number }): Promise<Array<{ path?: string; line?: number; snippet: string; score: number }>> };
  enableBrowser?: boolean;
  httpAllowlist?: string[];
  /**
   * (additive) State directory for the black-box tools (load job dirs, evidence markers); share it with
   * builtinSideEffectAdapters. Optional: without it load.observe dedupes evidence in-process only.
   */
  stateDir?: string;
}

// ----------------------------------------------------------------------------- (additive) tools-core types

/** (additive) Source mutation operators used by mutation.run / generateMutants. */
export type MutationOperator = 'arithmetic' | 'relational' | 'logical' | 'boolean' | 'numeric_literal' | 'return_value' | 'off_by_one';

export type MutationLanguage = 'javascript' | 'typescript' | 'python' | 'go';

/** (additive) One source mutant: replace `source.slice(start, end)` (= original) with `replacement`. */
export interface Mutant {
  /** Deterministic id `m<nnn>-L<line>-<operator>` (index in generation order). */
  id: string;
  file: string;
  line: number;
  column: number;
  operator: MutationOperator;
  start: number;
  end: number;
  original: string;
  replacement: string;
}

export type MutantStatus = 'killed' | 'survived' | 'error';

/** (additive) Structured payload of `mutation-result` evidence. */
export interface MutationAnalysisResult {
  file: string;
  framework: string;
  selector?: string;
  /** Mutants generated before capping. */
  generated: number;
  total: number;
  killed: number;
  survived: number;
  errors: number;
  /** killed / (killed + survived); 0 when no mutant was decidable (never a pass by default). */
  score: number;
  baseline: { passed: boolean; total: number; harnessError?: string };
  mutants: Array<{ id: string; line: number; operator: MutationOperator; original: string; replacement: string; status: MutantStatus; detail?: string }>;
  /**
   * (additive, D-0) The test files the analysis executed (the baseline run's cases attributed to files, with their content
   * digests): `mutation.run` records it on the mutation-result, and a mutation result counts for a TestArtifact only when
   * it executed exactly that artifact's file and content (policy `sensitivityBinding`).
   */
  executedTests?: { attribution: 'complete' | 'partial' | 'none'; files: Array<{ path: string; sha256?: string; cases: number; staticCheck?: { checker: string; ok: boolean; detail?: string } }>; unattributedCases: number };
}

/** (additive) Options of createLocalSandbox(). */
export interface LocalSandboxOptions {
  /** Delay between SIGTERM and SIGKILL of the process group on timeout/abort (default 2000). */
  killGraceMs?: number;
  /** Default per-stream capture limit (default 4 MiB). */
  maxOutputBytes?: number;
  /**
   * (additive, security-2) Programs used to isolate the network of commands whose profile is not `network: 'open'`
   * (a fresh user + network namespace). Default: `unshare` and `python3` from PATH. Local sandbox only.
   */
  networkIsolation?: { unshare?: string; python?: string | false; path?: string };
  /**
   * (additive, H1) Paths hidden from sandboxed commands (an empty read-only tmpfs over a directory, `/dev/null` over a
   * file) — e.g. the capability secret, signing keys, the store, the artifacts. Enforced where the host supports the
   * jail strategy (`networkIsolation().jail`); a hidden path containing the workspace is refused.
   */
  hiddenPaths?: string[];
  /** (additive, H1) Directory holding every workspace: a jailed command sees only its own root and temp dir in it. */
  workspacesDir?: string;
  /**
   * (additive, security-2) Origins (`http(s)://host:port`) a command of a `loopback` / `egress_allowlist` profile may
   * reach — typically the registered environments' base URLs and the operator's http allowlist. Only this host's
   * loopback endpoints can be relayed into the namespace (jail strategy); everything else stays unreachable.
   */
  egress?: (ws: WorkspaceHandle) => readonly string[] | Promise<readonly string[]>;
}

/** (additive) Options of createOciSandbox(). */
export interface OciSandboxOptions extends LocalSandboxOptions {
  image: string;
  /** Docker CLI binary (default `docker`). */
  docker?: string;
  /** `uid:gid` for `--user` (default: the current process uid:gid). */
  user?: string;
}

/** (additive) Options shared by the built-in test runner adapters. */
export interface TestRunnerOptions {
  /** Command prefix override (e.g. `['pytest']`, `['npx', 'vitest']`). */
  command?: string[];
  /** Extra environment passed to the runner process (runner-trusted, not agent input). */
  env?: Record<string, string>;
}

export type { SideEffectAdapter };
