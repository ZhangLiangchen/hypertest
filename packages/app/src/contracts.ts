import type { Clock, EventBus, IdGenerator, JsonValue, Logger, SqlDatabase } from '@hypertest/core';
import type { BudgetEnvelope, DomainEvent, GateSpec, ModelPolicy, OperationRecord, OracleAssertion, OracleSpec, RuntimeEpoch, RuntimeManifest, TestRun } from '@hypertest/domain';
import type { ModelCapabilityProfile, ModelCatalog, ModelRouter, PriceCeiling, ProviderRegistry, ScriptedBrain } from '@hypertest/model';
import type { ApprovalRequest, ApprovalService, OracleGovernance, PolicyDecisionLog, PolicyEngine, PolicyRule, ResolvedProtocol } from '@hypertest/policy';
import type { BrokeredCredentialConfig, EnvironmentDescriptor, EnvironmentRegistry, NetworkIsolationOptions, SandboxProfile, ToolRegistryLike, ToolRuntime, WorkspaceManager } from '@hypertest/tools';
import type { RoleCatalogLike, RoleOverrides } from '@hypertest/agents';
import type { BudgetRaiseInput, ControlPlane, RunReport, StartRunInput } from '@hypertest/control';
import type { DurableRuntime, RunOutcome } from '@hypertest/durable';
import type { Blackboard, DecisionRepository, EventStore, OutboxRelay, RunRepository, SpecRepository } from '@hypertest/collab';
import type { ArtifactStore, EvidenceLedger, Signer } from '@hypertest/evidence';
import type { DurableMemory, ProvenanceService, SkillRegistry, SkillRevision } from '@hypertest/context';
import type { AdapterRegistry, OperationLedger } from '@hypertest/operation';
import type {
  AgentView, CanarySelection, CompatibilitySuiteResult, ModelSwitchRequest, PluginKernel, PromotionResult, RecordSuiteInput, RollbackResult, RuntimeRelease, RuntimeReleaseRegistry, SchemaMigrationAllowance,
  ShadowComparison,
} from '@hypertest/runtime';

/**
 * @hypertest/app — configuration + composition root. The only place that knows every package.
 *
 * Implementations to export from src/index.ts:
 *   loadConfig(path: string, options?: LoadConfigOptions): Promise<HypertestConfig>   (YAML/JSON; `${ENV}` interpolation for non-secret fields;
 *                                                         secrets only via *Env indirection, never inline)
 *   defaultConfig(overrides?: HypertestConfigInput): HypertestConfig   (pglite + inprocess bus + local durable +
 *                                                         fs artifacts under .hypertest/, scripted-free, native engine)
 *   validateConfig(config): string[]
 *   createHypertest(config: HypertestConfig, overrides?: HypertestOverrides): Promise<Hypertest>   (returns a HypertestInstance)
 *   startApiServer(ht: Hypertest, options: { port: number; host?: string }): Promise<{ url: string; close(): Promise<void> }>
 *       REST: POST /runs, GET /runs, GET /runs/:id, GET /runs/:id/events (SSE), GET /runs/:id/report,
 *             POST /approvals/:id, GET /runs/:id/evidence/verify
 *       (additive) GET /health, GET /approvals, POST /runs/:id/cancel, POST /oracle-proposals/:id; options ApiServerOptions
 *   (additive) diagnose(config, options?): Promise<DiagnosticReport>   (`hypertest doctor`)
 *   (additive) mergeConfig, interpolateConfig, resolveConfigPaths, completeRoute, ROUTE_DEFAULTS, PROVIDER_KINDS
 *   (additive, review) validateRunOverrides, pinnedControlPlane (I11 at the control boundary), decisionProblems,
 *       persistentEnvironmentRegistry, resolveEnvironments, acquireDirectoryLock (one process per PGlite directory)
 */
export interface ProviderConfig {
  id: string;
  /** (additive) `plugin`: the provider is contributed by a configured plugin declaring `provider:<id>`. */
  kind: 'openai-compatible' | 'anthropic' | 'pi-ai' | 'scripted' | 'plugin';
  baseUrl?: string;
  /** Name of the environment variable holding the API key (keys are never stored in config). */
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  /** pi-ai provider name (for kind pi-ai). */
  piProvider?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface HypertestConfig {
  version: 1;
  project: { name: string; dataDir: string };
  store: { kind: 'pglite'; dataDir?: string } | { kind: 'postgres'; url?: string; urlEnv?: string; schema?: string };
  /** (additive) nats `subjectPrefix`: first subject token on the wire (default `ht`), so independent deployments share a server. */
  bus: { kind: 'inprocess' } | { kind: 'nats'; servers: string | string[]; stream?: string; subjectPrefix?: string };
  durable: { kind: 'local'; maxConcurrentTurns?: number } | { kind: 'temporal'; address: string; namespace?: string; taskQueue?: string; workerMode?: 'embedded' | 'external' };
  artifacts: { kind: 'fs'; root?: string } | { kind: 's3'; endpoint?: string; region: string; bucket: string; prefix?: string; forcePathStyle?: boolean; objectLockDays?: number; accessKeyIdEnv?: string; secretAccessKeyEnv?: string };
  models: {
    providers: ProviderConfig[];
    routes: Array<Partial<ModelCapabilityProfile> & Pick<ModelCapabilityProfile, 'routeId' | 'provider' | 'model'>>;
    defaultPolicy?: ModelPolicy;
    /**
     * (additive, A[1]) The price guard: `maxIncreasePct` — an observed price (pricesFile) more than this percentage above
     * the route's catalog price opens the route's circuit for every request (`model.circuit_opened` reason
     * `price_change`); `default` / `routes` — per-million-token ceilings (USD) for cost-limited requests (`appliesTo`:
     * `cost_limited` (default) or `all`).
     */
    priceGuard?: { maxIncreasePct?: number; default?: PriceCeiling; routes?: Record<string, PriceCeiling>; appliesTo?: 'cost_limited' | 'all' };
    /**
     * (additive, A[1]) Observed route prices (JSON, `hypertest models prices set`), re-read at every turn boundary when it
     * changed. Default `<dataDir>/state/model-prices.json`.
     */
    pricesFile?: string;
    /**
     * (additive, coverage[7]) Route quality scores derived from eval results (`hypertest eval apply-scores`), merged into
     * the catalog at startup (a new catalog revision; recorded in the RuntimeManifest as modelScores).
     */
    scoresFile?: string;
  };
  roles?: RoleOverrides['roles'];
  budget?: Partial<BudgetEnvelope>;
  gate?: Partial<GateSpec>;
  policy?: { rules?: PolicyRule[]; opa?: { url: string; path?: string; timeoutMs?: number }; capabilitySecretEnv?: string };
  bugate?: { path?: string };
  /** The default AgentEngine. `dsh` (the pinned DeepSeek Harness adapter, experimental) is registered only when selected here. */
  engines?: { default: 'native' | 'pi' | 'dsh' | (string & {}) };
  /**
   * The sandbox profile of agent commands. (additive, E[2]) `egressWrites`: what a sandboxed command's state-changing HTTP
   * request to a relayed SUT endpoint becomes — `ledger` (default: an Operation Ledger operation with an Idempotency-Key and
   * evidence; durable replays answered from the record) or `refuse` (stricter: 403 with the exact reason).
   */
  /**
   * (additive) `egressWrites` (E[2]); `insecureAllowUnhiddenSecrets` (E[4]): the LOUD opt-in to run agent commands with
   * the local sandbox where it cannot hide the signing keys, capability secret and store from them (no PID/mount jail on
   * this host, or `network: open`). Without it such a composition is refused (fail closed) and doctor reports an ERROR.
   */
  sandbox?: Partial<SandboxProfile> & {
    egressWrites?: 'ledger' | 'refuse';
    insecureAllowUnhiddenSecrets?: boolean;
    /**
     * (additive, wave 3, row 250) Isolation tier per role: `read_only` (the workspace bound read-only for commands; mutating
     * tools refuse), `isolated` (its own worktree / scratch; with kind oci a container), `separate` (its own sandbox profile:
     * network, allowedHosts, kind/image, cpuLimit, memoryMb). Keys given here override the base profile for that role.
     */
    roles?: Record<string, SandboxRoleTierConfig>;
  };
  /** (additive: `control.tokenEnv`) Environments registered at startup; see EnvironmentConfig. */
  environments?: EnvironmentConfig[];
  /**
   * (additive, e2e[0]) `urlEnvironmentClass`: the environment class of the black-box environments the URL entries of
   * `httpAllowlist` stand for (`url-<host>-<port>`, the target of `hypertest run --url`) when their host is not loopback
   * (loopback hosts are always `local`). Default `sandbox`. Never allowlist a production URL under a lower class.
   */
  tools?: {
    shellAllowlist?: string[]; httpAllowlist?: string[]; enableBrowser?: boolean; urlEnvironmentClass?: string;
    /** (additive, E[5]/stubs[1]/coverage[3]) MCP servers whose tools join the registry as `mcp.<id>.<tool>` (see McpServerToolConfig). */
    mcpServers?: McpServerToolConfig[];
    /**
     * (additive, row 246) Remote tool workers (`hypertest tool-worker`): the execute step of each listed tool (no side-effect
     * binding) runs on the worker at `url` over HMAC-signed HTTP with the shared secret from the variable NAMED `secretEnv`;
     * capability, permit, freshness, Operation Ledger and evidence stay in this deployment (operation ids preserved).
     */
    remoteWorkers?: Array<{ id: string; url: string; secretEnv: string; tools: string[] }>;
    /**
     * (additive, row 246) External coding agents over the Agent Client Protocol (`acp.<id>.prompt`, offered to `roles`,
     * default test_designer): the agent process runs in the caller's workspace sandbox (`sandbox: host` is an explicit,
     * logged opt-out) and reaches files only through Hypertest (confined; writes only in an isolated worktree; no terminal;
     * its permission requests refused). Variables by NAME only (`envFrom`).
     */
    acpAgents?: Array<{ id: string; command: string; args?: string[]; envFrom?: Record<string, string>; sandbox?: 'workspace' | 'host'; roles?: string[]; timeoutMs?: number }>;
    /**
     * (additive, row 246) Computer use: the computer.* tools (screenshot; click / type / key as ledgered external effects)
     * over one desktop — `x11` (native XTEST client, e.g. Xvfb at `display`), `xdotool` (+ `screenshotCommand`), or `fake`
     * (the documented test backend). The desktop `desktop/<displayId>` is granted to `grantTo` (default test_executor) and
     * offered to `roles` (default vision_gui); `environmentClass` (default local: a display of this host) is its policy class.
     */
    computerUse?: { backend: 'x11' | 'xdotool' | 'fake'; display?: string; displayId?: string; environmentClass?: string; grantTo?: string[]; roles?: string[]; xdotool?: string; screenshotCommand?: string[] };
  };
  signing?: { keyFile?: string };
  /**
   * L4 durable memory. `sql`: in this process's store (embedded deployments, tests). `powercontext`: a separate context
   * service at `baseUrl` (its own process and storage — e.g. `hypertest memory serve`). (additive, B[4]) `service`: a memory
   * service process Hypertest starts and stops itself (`dataDir`, default `<dataDir>/memory`; its own PGlite store), reached
   * over the same HTTP API as `powercontext`.
   */
  memory?: { kind: 'sql' } | { kind: 'powercontext'; baseUrl: string; apiKeyEnv?: string } | { kind: 'service'; dataDir?: string; apiKeyEnv?: string };
  /**
   * (additive, B[6]) L3 retrieval. `embedder`: semantic embeddings through an OpenAI-compatible `/embeddings` endpoint of a
   * configured `openai-compatible` provider (`models.providers[].id`; its baseUrl and apiKeyEnv) instead of the default feature-hashing
   * embedder; `dimensions` is the vector size the model returns (verified on every answer). Code leaves the machine to that
   * provider: configure a local endpoint for private code.
   */
  retrieval?: { embedder?: { provider: string; model: string; dimensions: number; timeoutMs?: number } };
  /**
   * (additive, B[7]) Skills. `trial`: candidate skill revisions under evaluation, shown (marked as candidates) in the prompts of
   * THIS instance only — set by `hypertest skill validate` on the eval arm bound to the revision (skillArmId); never published.
   */
  skills?: { trial?: SkillRevision[] };
  observability?: { logLevel?: 'debug' | 'info' | 'warn' | 'error' };
  /**
   * (additive, conformance-1) Oracles established by a named human authority at composition (OracleGovernance.establish;
   * an oracle that already exists is kept: it changes only through governed proposals). Runs started without explicit
   * `oracleIds` pin every configured oracle.
   */
  oracles?: OracleConfig[];
  /**
   * (additive, runtime release management) `requireActiveRelease`: refuse to create runs until a runtime release is
   * active (default false: an installation that never activated a release runs unmanaged — any runtime but a rolled-back
   * one creates runs; once a release is active, new runs are created only under it or a canary that selects them).
   */
  runtime?: {
    requireActiveRelease?: boolean;
    /**
     * (additive, F[0]) What a SHADOW release of this deployment mirrors (`hypertest runtime shadow`): finished runs of the
     * active release selected by `percentage` (run-id bucket) and/or `labels`; `minRuns` mirrored runs (no divergence)
     * make a passing production replay; `timeoutMs` bounds one mirrored run.
     */
    shadow?: { percentage?: number; labels?: Record<string, string>; minRuns?: number; timeoutMs?: number };
  };
  /**
   * (additive, F[8]) The harness subsystems of an EVAL causal arm (unset = on, H6). Switching one off is refused outside
   * an eval trial instance (HypertestOverrides.evalTrial): see harness-features.ts.
   */
  harness?: { features?: HarnessFeatureConfig };
  /**
   * (additive, A[6]) Kernel plugins: local ES modules pinned by the sha256 of their entry file, loaded at composition in
   * this order (init → start → health; stopped in reverse on close), recorded in the RuntimeManifest. A plugin may
   * contribute only what its `capabilities` declare (`tool:<id>`, `engine:<kind>`, `provider:<id>`,
   * `context-hook:<name>`, `service:<name>`); its tools pass the same capability check, policy permit, ledger and evidence
   * as built-in tools (and are offered only to roles whose tool policy allows them).
   */
  plugins?: PluginConfig[];
}

/** (additive, F[8]) The harness features of a causal eval arm (H0 … H6). */
export interface HarnessFeatureConfig {
  subagents?: boolean;
  dynamicScheduler?: boolean;
  blackboard?: boolean;
  contextFreshness?: boolean;
  oracleGovernance?: boolean;
}

/** (additive, A[6]) One configured kernel plugin. */
export interface PluginConfig {
  id: string;
  version: string;
  kind: 'tool' | 'engine' | 'provider' | 'context-hook';
  /** The ES module (relative paths resolve against the configuration file). */
  entry: string;
  /** `sha256:<64 hex>` of the entry file (e.g. `sha256sum plugin.mjs`). */
  digest: string;
  capabilities: string[];
  /** Plugin configuration (no secrets: plugins read their secrets from `*Env` names they document). */
  config?: Record<string, JsonValue>;
}

/**
 * (additive, E[5]/stubs[1]/coverage[3]) A configured MCP server. Its `allowTools` become `mcp.<id>.<tool>` ToolSpecs of the
 * registry (pinned by the runtime manifest), offered to `roles` (default executor) and run through the full pipeline:
 * capability → policy permit → freshness (mutating) → Operation Ledger (external/destructive effects: record-only adapter,
 * keyed by the invocation id) → `mcp-response` evidence. Exactly one transport: `command` (+ args, cwd; stdio) or `url`
 * (streamable HTTP). Secrets only by NAME: `envFrom` (server variable → Hypertest variable) and `headersFromEnv` (header →
 * variable); a missing variable makes the server unavailable (fail closed). Classification is the operator's: `effect` /
 * `riskClass` per server (default external / medium), refined by `toolEffects`; `environmentId` binds the server to a
 * registered environment (its tools address `env/<id>` with its class), otherwise its tools address `mcp/<id>/<tool>`, a
 * scope granted to the permission profiles in `grantTo` (default test_executor, environment_operator).
 */
export interface McpServerToolConfig {
  id: string;
  command?: string;
  args?: string[];
  cwd?: string;
  envFrom?: Record<string, string>;
  url?: string;
  headersFromEnv?: Record<string, string>;
  allowTools: string[];
  effect?: 'read' | 'record' | 'write_workspace' | 'execute' | 'external' | 'destructive';
  riskClass?: 'low' | 'medium' | 'high' | 'critical';
  toolEffects?: Record<string, { effect?: McpServerToolConfig['effect']; riskClass?: McpServerToolConfig['riskClass'] }>;
  environmentId?: string;
  environmentClass?: string;
  roles?: string[];
  grantTo?: string[];
  timeoutMs?: number;
}

/** (additive, conformance-1) A configured oracle: the OracleSpec content plus the human who establishes it. */
export interface OracleConfig {
  oracleId: string;
  scope: OracleSpec['scope'];
  assertions: OracleAssertion[];
  /** Where the criteria come from (default `[{ sourceRef: 'hypertest.config', authority: 'approved_requirement' }]`). */
  authorities?: OracleSpec['authorities'];
  judgePolicy?: Partial<OracleSpec['judgePolicy']>;
  changePolicy?: Partial<Omit<OracleSpec['changePolicy'], 'selfApprove'>>;
  /** The human authority establishing it (`human:<establishedBy>` in the audit trail). */
  establishedBy: string;
}

export interface HypertestOverrides {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
  /**
   * (additive, F[8]) This instance is an eval trial: `harness.features` may switch subsystems off (the causal arms H0–H5).
   * Any other instance refuses a configuration that disables a feature.
   */
  evalTrial?: boolean;
  /** Brains for `scripted` providers keyed by provider id (tests, PoCs, eval). */
  scriptedBrains?: Record<string, ScriptedBrain>;
  /** Extra environments/tools/adapters injected by eval fixtures. */
  environments?: EnvironmentDescriptor[];
  workerId?: string;
  /**
   * (additive) Environment used to resolve `*Env` indirections (API keys, capability secret, postgres URL, S3
   * credentials). Default `process.env`.
   */
  env?: Record<string, string | undefined>;
  /**
   * (additive) Event bus used instead of the configured one (e.g. an InProcessEventBus with fault injection in eval
   * chaos trials). The caller owns it: close() does not close it.
   */
  bus?: EventBus;
  /** (additive, e2e[3]) The fetch the HTTP model providers use (tests prove that no request leaves the process). */
  fetch?: typeof fetch;
  /**
   * (additive, E[4]) Programs the local sandbox isolates commands with (default `unshare` + `python3` from PATH); tests
   * point them elsewhere to exercise the fail-closed composition on a host without the jail.
   */
  sandboxIsolation?: NetworkIsolationOptions;
  /** (additive, E[4]) The fetch the secret broker's oauth2 token exchange uses (tests inject one). */
  credentialFetch?: typeof fetch;
}

export interface Hypertest {
  readonly config: HypertestConfig;
  readonly control: ControlPlane;
  readonly durable: DurableRuntime;
  /** Starts a run and returns immediately. */
  start(input: StartRunInput): Promise<TestRun>;
  /** Starts a run and waits for its outcome. */
  run(input: StartRunInput, options?: { timeoutMs?: number }): Promise<RunOutcome>;
  /** Resumes the non-terminal runs pinned to this runtime's manifest (I11; runs of other manifests are left alone). */
  resumeIncomplete(): Promise<string[]>;
  status(runId: string): Promise<TestRun | undefined>;
  report(runId: string): Promise<RunReport>;
  /** Evidence chain + seals, and the run's QualityDecision (trusted signature, bound evidence root). Unknown run ⇒ not_found. */
  verifyEvidence(runId: string): Promise<{ ok: boolean; problems: string[] }>;
  approve(approvalId: string, approve: boolean, actor: { kind: 'human'; id: string }, rationale: string): Promise<void>;
  decideOracleProposal(proposalId: string, approve: boolean, actor: { kind: 'human'; id: string }, rationale: string): Promise<void>;
  close(): Promise<void>;
  // ---- (additive, optional on the interface; always present on a HypertestInstance from createHypertest)
  /** (additive) The runtime manifest every run started by this instance is pinned to (I11). */
  readonly manifest?: RuntimeManifest;
  /** (additive) Runs, newest first. */
  listRuns?(filter?: { status?: TestRun['status'][]; limit?: number }): Promise<TestRun[]>;
  /** (additive) L0 events of a run in seq order (after `afterSeq`). */
  events?(runId: string, options?: { afterSeq?: number; limit?: number; types?: string[] }): Promise<DomainEvent<unknown>[]>;
  /** (additive) Approval requests. */
  listApprovals?(filter?: { runId?: string; status?: ApprovalRequest['status'][] }): Promise<ApprovalRequest[]>;
  /** (additive) Cancels a run (durable cancel signal; the control plane sweeps its work). */
  cancel?(runId: string, reason: string): Promise<void>;
  /** (additive) Runtime release management: registry, promotions, rollback + quarantine, explicit run migration. */
  readonly releases?: RuntimeReleaseService;
}

// ----------------------------------------------------------------------------- (additive) app types

/**
 * (additive) A configured environment: an EnvironmentDescriptor whose process `control` may name the variable holding
 * the supervisor's control token (`tokenEnv`). The token is attached to the control target at composition; an inline
 * token (`control.target` with `#token=`) is a validation error.
 */
export type EnvironmentConfig = Omit<EnvironmentDescriptor, 'control' | 'brokeredCredentials'> & {
  control?: NonNullable<EnvironmentDescriptor['control']> & { tokenEnv?: string };
  /**
   * (additive, E[4] / coverage[8]) Brokered credentials of the environment: the secret broker mints a short-lived
   * credential per call from the secret in `secretEnv` (agents only name the credential: http.request `credential`).
   */
  credentials?: Array<Omit<BrokeredCredentialConfig, 'environmentId'>>;
};

/** (additive) One configured route: routeId, provider and model plus any capability-profile field (defaults fill the rest). */
export type RouteConfig = HypertestConfig['models']['routes'][number];

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** (additive) Configuration overrides deep-merged over the defaults by defaultConfig (arrays replace). */
export type HypertestConfigInput = DeepPartial<HypertestConfig>;

/** (additive) Options of loadConfig. */
export interface LoadConfigOptions {
  /** Variables for `${VAR}` interpolation (default `process.env`). */
  env?: Record<string, string | undefined>;
}

/** (additive) The services composed by createHypertest (read access for the API server, CLI, eval graders and tests). */
export interface HypertestServices {
  db: SqlDatabase;
  bus: EventBus;
  relay: OutboxRelay;
  events: EventStore;
  runs: RunRepository;
  blackboard: Blackboard;
  specs: SpecRepository;
  decisions: DecisionRepository;
  operations: OperationLedger;
  artifacts: ArtifactStore;
  evidence: EvidenceLedger;
  signer: Signer;
  /** Trusted evidence seal keys (keyId → SPKI PEM) used by verifyEvidence. */
  publicKeys: Record<string, string>;
  policy: PolicyEngine;
  decisionLog: PolicyDecisionLog;
  approvals: ApprovalService;
  oracles: OracleGovernance;
  protocol: ResolvedProtocol;
  providers: ProviderRegistry;
  catalog: ModelCatalog;
  router: ModelRouter;
  memory: DurableMemory;
  /**
   * (additive, optional) L5 provenance over the run's stores: evidence → tool invocation → operation → work item → agent
   * → environment / commit, records → cited evidence, report claims (the service the report builder traces claims with).
   */
  provenance?: ProvenanceService;
  tools: ToolRegistryLike;
  environments: EnvironmentRegistry;
  roles: RoleCatalogLike;
  workerId: string;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
  /** (additive, optional) The side-effect adapters whose capabilities the manifest's toolCatalogRevision pins. */
  adapters?: AdapterRegistry;
  /**
   * (additive, optional, A[6]) The governed ToolRuntime every tool call goes through (validate → capability → permit →
   * freshness → operation ledger → evidence), the workspace manager, and the loaded kernel plugins.
   */
  toolRuntime?: ToolRuntime;
  workspaces?: WorkspaceManager;
  plugins?: PluginKernel;
  /** (additive, optional, B[7]) The Skill Registry (candidate → eval-validated → published; `hypertest skill …`). */
  skills?: SkillRegistry;
}

/** (additive) What createHypertest returns: the Hypertest facade with every optional member present. */
export interface HypertestInstance extends Hypertest {
  readonly manifest: RuntimeManifest;
  readonly services: HypertestServices;
  listRuns(filter?: { status?: TestRun['status'][]; limit?: number }): Promise<TestRun[]>;
  events(runId: string, options?: { afterSeq?: number; limit?: number; types?: string[] }): Promise<DomainEvent<unknown>[]>;
  listApprovals(filter?: { runId?: string; status?: ApprovalRequest['status'][] }): Promise<ApprovalRequest[]>;
  /**
   * (additive, stubs[8]) Operations by status (default: those awaiting a human manual review), of one run or of all runs
   * (`hypertest operations list`, GET /operations).
   */
  listOperations(filter?: { runId?: string; status?: OperationRecord['status'][]; limit?: number }): Promise<OperationRecord[]>;
  /**
   * (additive, stubs[8]) A human resolves an operation under manual review (`hypertest operations resolve`, POST
   * /operations/:id/resolve): succeeded ⇒ verified, failed ⇒ failed, compensated ⇒ compensated; audited on L0
   * (`operation.resolved`); the work waiting on it resumes. Agents never resolve operations.
   */
  resolveOperation(operationId: string, outcome: 'succeeded' | 'failed' | 'compensated', actor: { kind: 'human'; id: string }, note: string): Promise<OperationRecord>;
  cancel(runId: string, reason: string): Promise<void>;
  readonly releases: RuntimeReleaseService;
  /**
   * (additive, A[3]) Manual model switch (`hypertest model switch`, POST /runs/:id/model-switch): `target` is an agent id
   * of the run or a role; applied at the target agents' next safe turn boundary after the permission/profile re-check.
   */
  requestModelSwitch(runId: string, target: string, routeId: string, actor: { kind: 'human'; id: string }, reason?: string): Promise<ModelSwitchRequest>;
  /** (additive, A[4]) The run's agents through engine.inspect (session state), with their epoch and any model pause. */
  agents(runId: string): Promise<AgentView[]>;
  /**
   * (additive, A[0]) Operator resume of one run (`hypertest resume <runId>`, POST /runs/:id/resume): releases its model
   * pauses (their open circuits probe now), resumes it when paused, and drives it in this process.
   */
  resume(runId: string, options?: ResumeRunOptions): Promise<{ releasedPauses: string[] }>;
}

/**
 * (additive, E[3]) Options of an operator resume: `raise` extends the run's budget first (amounts ADDED to its limits;
 * audited on L0 `budget.raised` as `human:<by>` with the rationale) — a PAUSED_BUDGET run is resumable after a raise.
 */
export interface ResumeRunOptions {
  raise?: BudgetRaiseInput;
  /** The human who raises (required with `raise`). */
  by?: string;
  /** Why (required with `raise`). */
  rationale?: string;
}

/** (additive) A runtime release as `hypertest runtime list` shows it. */
export interface RuntimeReleaseView extends RuntimeRelease {
  /** The active pointer names it. */
  active: boolean;
  /** It is the manifest of this instance. */
  current: boolean;
  /** Runs pinned to it that are not finished. */
  liveRuns: number;
}

/** (additive) Input of RuntimeReleaseService.migrate. */
export interface MigrateRunInput {
  /** The target release: a manifest id, a unique prefix, or `current` (this instance's manifest). */
  to: string;
  /** The actor, `<kind>:<id>` (e.g. `human:alice`). */
  by: string;
  reason: string;
  /** How long in-flight turns may take to give their claims back at the checkpoint (default 90 000 ms). */
  checkpointTimeoutMs?: number;
  /** Start driving the migrated run here when this instance is the target runtime (default false). */
  drive?: boolean;
  /**
   * (additive, F[1]) With `drive`: how long to wait for this runtime's durable loop to take the run over (its first
   * recover records `run.migration_driven`; default 30 000 ms). A previous loop still open elsewhere is woken meanwhile.
   */
  driveTimeoutMs?: number;
  signal?: AbortSignal;
}

/** (additive) Outcome of an explicit run migration. */
export interface RunMigrationResult {
  run: TestRun;
  epoch: RuntimeEpoch;
  /**
   * This instance drives the run (drive: true, this instance is the target, and its durable loop took the run over —
   * `run.migration_driven` was recorded for the epoch). Never true for a start that did not take effect.
   */
  driven: boolean;
  /** (additive, F[1]) Why a requested drive did not take effect (the run is migrated; what the operator does next). */
  driveProblem?: string;
}

/** (additive, F[0]) One mirror of a production run on this shadow release. */
export interface ShadowMirrorResult {
  comparison: ShadowComparison;
  shadowRunId: string;
  /** false: the run was mirrored before (its comparison is returned). */
  created: boolean;
}

/**
 * (additive) Runtime release management of a deployment (the registry is shared through the store): register manifests,
 * record compatibility suite results, promote candidate → shadow → canary → active, roll back (the active pointer moves
 * back; the rolled-back release's live runs are quarantined), and migrate a live run explicitly onto another release
 * (checkpoint → snapshot → operation reconciliation → compatibility → RuntimeEpoch + re-pin → resume). Mutations take the
 * acting human/system as `<kind>:<id>`.
 */
export interface RuntimeReleaseService {
  readonly registry: RuntimeReleaseRegistry;
  /** `current`, a registered manifest id or a unique prefix of one → the manifest id. */
  resolve(ref: string): Promise<string>;
  /** Every release (newest first) with the active flag and its live runs; retiring releases without live runs are retired. */
  list(): Promise<RuntimeReleaseView[]>;
  /** Registers `manifest` (default: this instance's) as a candidate; idempotent. */
  register(input: { manifest?: RuntimeManifest; by: string; allowedMigrations?: SchemaMigrationAllowance[] }): Promise<{ release: RuntimeRelease; created: boolean }>;
  recordSuite(input: RecordSuiteInput): Promise<CompatibilitySuiteResult>;
  promote(manifestId: string, input: { by: string; reason: string; canary?: CanarySelection }): Promise<PromotionResult & { retired: string[] }>;
  rollback(input: { by: string; reason: string; manifestId?: string }): Promise<RollbackResult & { quarantined: string[] }>;
  /**
   * Quarantines a live run whose release is rolled back (with that rollback's actor, reason and transition) — the
   * creator's re-check of a run admitted before the rollback committed but created after its sweep. True when it was
   * quarantined now; false when there is nothing to do (finished, already quarantined, release not rolled back).
   */
  quarantineIfRolledBack(runId: string): Promise<boolean>;
  migrate(runId: string, input: MigrateRunInput): Promise<RunMigrationResult>;
  /**
   * (additive) Releases the checkpoint of an abandoned migration (the migrating process died between its checkpoint and
   * its re-pin): a run paused `migrating` goes back to `running` on the manifest it is still pinned to, with
   * `run.migration_released` (actor, reason) on L0 — its own runtime drives it again (`hypertest resume` there). Anything
   * else is `precondition_failed`; a run whose release was rolled back is quarantined instead (never released onto that
   * runtime). A migration still in progress for the run then fails (it finds the run left its checkpoint) and re-pins
   * nothing.
   */
  releaseCheckpoint(runId: string, input: { by: string; reason: string }): Promise<TestRun>;
  epochs(runId: string): Promise<RuntimeEpoch[]>;
  /**
   * (additive, F[1]) Records `run.migration_driven` when this runtime's durable loop starts driving a run whose latest
   * RuntimeEpoch targets this manifest (once per epoch; true when recorded now). Called by every loop's recover.
   */
  markDriven(runId: string): Promise<boolean>;
  /**
   * (additive, F[0], e2e[5]) Records a `compatibility` result from an eval SuiteResult: passing only when every trial
   * passed AND every trial ran under `manifestId` (binding eval_trials); a passing result of other manifests is refused.
   */
  recordEvalSuite(input: { manifestId: string; kind: 'compatibility'; result: unknown; digest: string; by: string; detail?: string }): Promise<CompatibilitySuiteResult>;
  /**
   * (additive, F[0], F[13]) Records the `release_gate` result (canary → active): the eval release gate `report` of a CORE
   * candidate (suite id `core`, every trial ran under `manifestId`) against a baseline; passing when the gate passed and
   * every candidate trial passed. Any other suite is refused.
   */
  recordReleaseGate(input: {
    manifestId: string;
    candidate: unknown;
    candidateDigest: string;
    baselineDigest: string;
    report: { pass: boolean; suiteId: string; checks?: Array<{ checkId: string; pass: boolean }> };
    by: string;
  }): Promise<CompatibilitySuiteResult>;
  /**
   * (additive, F[0]) Mirrors a FINISHED production run onto this runtime, which must be the shadow release: a new run
   * (label `hypertest.shadow_of`) with the same goal, target, budget and oracles, whose every external effect is dry-run
   * (recorded `not_applied: dry_run`, never dispatched); its decision is compared with the production decision and the
   * comparison recorded. Idempotent per source run.
   */
  mirror(sourceRunId: string, input: { by: string; timeoutMs?: number }): Promise<ShadowMirrorResult>;
  /** (additive, F[0]) Finished runs of the active release that `runtime.shadow` selects and this shadow did not mirror yet (newest first). */
  shadowCandidates(input?: { limit?: number }): Promise<string[]>;
  /**
   * (additive, F[0]) Records the `production_replay` result (shadow → canary) of a shadow release from its shadow
   * comparisons: passing with at least `minRuns` (runtime.shadow.minRuns, default 1) mirrored runs and no divergence.
   */
  recordProductionReplay(input: { manifestId?: string; by: string; minRuns?: number }): Promise<CompatibilitySuiteResult>;
}

/** (additive) Options of startApiServer. */
export interface ApiServerOptions {
  port: number;
  /** Default 127.0.0.1. A non-loopback host requires `token`. */
  host?: string;
  /**
   * Bearer token required on every request when set (mandatory for non-loopback hosts). Human decisions
   * (POST /approvals/:id, POST /oracle-proposals/:id) are refused (403 token_required) by a server without a token:
   * agents and the code under test can reach loopback, so loopback alone never authenticates a human.
   */
  token?: string;
  /** SSE poll interval of GET /runs/:id/events (default 500 ms). */
  eventPollMs?: number;
  /** Maximum request body (default 1 MiB). */
  maxBodyBytes?: number;
}

/** (additive) A running API server. */
export interface ApiServer {
  url: string;
  close(): Promise<void>;
}

/** (additive) One check of `diagnose` (`hypertest doctor`). */
export interface DiagnosticCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

/** (additive) Result of `diagnose`: ok unless a check is an error. */
export interface DiagnosticReport {
  ok: boolean;
  checks: DiagnosticCheck[];
}

/** (additive) Options of `diagnose`. */
export interface DiagnoseOptions {
  /** Environment for `*Env` lookups (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Probe the configured infrastructure (postgres, NATS, Temporal, OPA, PowerContext). Default true. */
  connect?: boolean;
  /** Per-probe timeout (default 3000 ms). */
  timeoutMs?: number;
}

/** (additive, wave 3, row 250) The isolation tier of one role (`sandbox.roles.<role>`). */
export interface SandboxRoleTierConfig {
  tier: 'read_only' | 'isolated' | 'separate';
  kind?: 'local' | 'oci';
  image?: string;
  network?: 'none' | 'loopback' | 'egress_allowlist' | 'open';
  allowedHosts?: string[];
  cpuLimit?: number;
  memoryMb?: number;
}
