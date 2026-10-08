import type { Clock, EventBus, IdGenerator, Logger, SqlDatabase } from '@hypertest/core';
import type { BudgetEnvelope, DomainEvent, GateSpec, ModelPolicy, OracleAssertion, OracleSpec, RuntimeEpoch, RuntimeManifest, TestRun } from '@hypertest/domain';
import type { ModelCapabilityProfile, ModelCatalog, ModelRouter, ProviderRegistry, ScriptedBrain } from '@hypertest/model';
import type { ApprovalRequest, ApprovalService, OracleGovernance, PolicyDecisionLog, PolicyEngine, PolicyRule, ResolvedProtocol } from '@hypertest/policy';
import type { EnvironmentDescriptor, EnvironmentRegistry, SandboxProfile, ToolRegistryLike } from '@hypertest/tools';
import type { RoleCatalogLike, RoleOverrides } from '@hypertest/agents';
import type { ControlPlane, RunReport, StartRunInput } from '@hypertest/control';
import type { DurableRuntime, RunOutcome } from '@hypertest/durable';
import type { Blackboard, DecisionRepository, EventStore, OutboxRelay, RunRepository, SpecRepository } from '@hypertest/collab';
import type { ArtifactStore, EvidenceLedger, Signer } from '@hypertest/evidence';
import type { DurableMemory, ProvenanceService } from '@hypertest/context';
import type { AdapterRegistry, OperationLedger } from '@hypertest/operation';
import type {
  CanarySelection, CompatibilitySuiteResult, PromotionResult, RecordSuiteInput, RollbackResult, RuntimeRelease, RuntimeReleaseRegistry, SchemaMigrationAllowance,
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
  kind: 'openai-compatible' | 'anthropic' | 'pi-ai' | 'scripted';
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
  };
  roles?: RoleOverrides['roles'];
  budget?: Partial<BudgetEnvelope>;
  gate?: Partial<GateSpec>;
  policy?: { rules?: PolicyRule[]; opa?: { url: string; path?: string; timeoutMs?: number }; capabilitySecretEnv?: string };
  bugate?: { path?: string };
  /** The default AgentEngine. `dsh` (the pinned DeepSeek Harness adapter, experimental) is registered only when selected here. */
  engines?: { default: 'native' | 'pi' | 'dsh' | (string & {}) };
  sandbox?: Partial<SandboxProfile>;
  /** (additive: `control.tokenEnv`) Environments registered at startup; see EnvironmentConfig. */
  environments?: EnvironmentConfig[];
  tools?: { shellAllowlist?: string[]; httpAllowlist?: string[]; enableBrowser?: boolean };
  signing?: { keyFile?: string };
  memory?: { kind: 'sql' } | { kind: 'powercontext'; baseUrl: string; apiKeyEnv?: string };
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
  runtime?: { requireActiveRelease?: boolean };
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
export type EnvironmentConfig = Omit<EnvironmentDescriptor, 'control'> & {
  control?: NonNullable<EnvironmentDescriptor['control']> & { tokenEnv?: string };
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
}

/** (additive) What createHypertest returns: the Hypertest facade with every optional member present. */
export interface HypertestInstance extends Hypertest {
  readonly manifest: RuntimeManifest;
  readonly services: HypertestServices;
  listRuns(filter?: { status?: TestRun['status'][]; limit?: number }): Promise<TestRun[]>;
  events(runId: string, options?: { afterSeq?: number; limit?: number; types?: string[] }): Promise<DomainEvent<unknown>[]>;
  listApprovals(filter?: { runId?: string; status?: ApprovalRequest['status'][] }): Promise<ApprovalRequest[]>;
  cancel(runId: string, reason: string): Promise<void>;
  readonly releases: RuntimeReleaseService;
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
  signal?: AbortSignal;
}

/** (additive) Outcome of an explicit run migration. */
export interface RunMigrationResult {
  run: TestRun;
  epoch: RuntimeEpoch;
  /** This instance started driving the run (drive: true and this instance is the target). */
  driven: boolean;
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
