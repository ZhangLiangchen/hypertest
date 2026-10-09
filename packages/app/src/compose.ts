import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  HypertestError, UlidIdGenerator, canonicalJson, isHypertestError, jsonLogger, sha256Hex, systemClock, type EventBus, type JsonValue, type Logger, type Migration,
  type SqlDatabase,
} from '@hypertest/core';
import { isTerminalRun, type EventContext, type Finding, type OperationStatus, type RuntimeManifest, type TestRun } from '@hypertest/domain';
import { migrate, openDatabase } from '@hypertest/store';
import {
  InProcessEventBus, collabMigrations, connectNatsEventBus, createBlackboard, createDecisionRepository, createEventStore, createInbox, createOutboxRelay,
  createRunRepository, createSpecRepository, type DecisionRepository, type OutboxRelay,
} from '@hypertest/collab';
import {
  AdapterRegistry, createBudgetLedger, createLeaseService, createOperationLedger, createReconciler, createResourceAdmission, createSideEffectGateway,
  operationMigrations,
} from '@hypertest/operation';
import { FsArtifactStore, S3ArtifactStore, createEvidenceLedger, evidenceMigrations, verifyEd25519, type ArtifactStore, type EvidenceLedger } from '@hypertest/evidence';
import {
  ApprovalGatedPolicyEngine, BuiltinPolicyEngine, CompositePolicyEngine, DEFAULT_POLICY_RULES, OpaPolicyEngine, QualityGate, createApprovalService, createOracleGovernance,
  createPolicyDecisionLog, policyMigrations, resolveProtocolBinding, type PolicyEngine,
} from '@hypertest/policy';
import {
  AnthropicProvider, ModelCatalog, OpenAICompatibleProvider, PiAiProvider, ProviderRegistry, ScriptedProvider, createFilePriceSource, createModelRouter, parseRouteScoresFile,
  piCompatibilityClass, type CircuitBreakerOptions, type ModelCapabilityProfile, type ModelProvider, type ModelRouter, type RouteRequest,
} from '@hypertest/model';
import {
  ExactSearch, HashEmbedder, HybridRetriever, PowerContextClient, SymbolIndex, VectorCorpusCache, WorkspaceVectorRetriever, contextMigrations, createExperienceStore, createFreshnessGuard,
  createObservationLog, createPgVectorIndex, createProvenanceService, createResolverRegistry, createSnapshotBuilder, createSnapshotStore, createWorkingContextManager,
  environmentResolver, environmentVersion, experimentResolver, leaseResolver, observeToolRuntime, oracleResolver, recordResolver, workspaceFileResolver,
  type DurableMemory, type Embedder, type Retriever, type VectorIndex,
} from '@hypertest/context';
import { OpenAICompatibleEmbedder, createCodeToolRetrieval, withExperienceEvents, createFreshnessPassLog, createSkillRegistry, recordTranscriptOnL0, withTrialSkills, type SkillRevision } from '@hypertest/context';
import {
  ToolRegistry, builtinSideEffectAdapters, builtinTools, closeBlackboxResources, createEnvironmentRegistry, createLocalSandbox, createOciSandbox, createSecretBroker, routedSandbox,
  createSqlEnvironmentRegistry, createToolRuntime, createWorkspaceManager, networkIsolation, toolsMigrations, type BrokeredCredentialConfig, type BuiltinToolOptions, type EgressEndpointPolicy,
  type EnvironmentRegistry, type NetworkIsolationOptions, type SandboxProfile, type ToolRuntimeDeps,
} from '@hypertest/tools';
import {
  EngineRegistry, NativeEngine, RUNTIME_PACKAGE_VERSION, buildRuntimeManifest, createAgentRepository, createAgentRunner, createEpochManager, createPluginKernel, createRuntimeReleaseRegistry,
  createSessionStore, createSubagentRuntime, inspectAgents, runtimeMigrations, toolCatalogRevision, type AgentEngine,
} from '@hypertest/runtime';
import { PI_AGENT_CORE_VERSION, PiEngine, RUNTIME_PI_PACKAGE_VERSION } from '@hypertest/runtime-pi';
import { DSH_PINS, DshEngine, RUNTIME_DSH_PACKAGE_VERSION } from '@hypertest/runtime-dsh';
import { BUILTIN_ROLES, RoleCatalog, type RoleCatalogLike } from '@hypertest/agents';
import { ControlStore, controlMigrations, createControlPlane, createDomainTools, type ControlConfig, type ControlDeps, type ControlPlane, type StartRunInput } from '@hypertest/control';
import { freshnessChecked } from '@hypertest/control';
import {
  DEFAULT_TEMPORAL_NAMESPACE, DEFAULT_TEMPORAL_TASK_QUEUE, LocalDurableRuntime, RESUMABLE_RUN_STATUSES, TemporalDurableRuntime, type DurableHooks, type DurableRuntime,
  type RunOutcome, type TemporalDurableOptions,
} from '@hypertest/durable';
import {
  DEFAULT_ENV_ALLOWLIST, completeRoute, oracleSpecFromConfig, providerCompatibilityClass, resolveConfigPaths, roleOverrides, validateConfig, validateRunOverrides,
  withDerivedPaths,
} from './config.ts';
import { ENVIRONMENT_STATE_FILE, persistentEnvironmentRegistry, resolveEnvironments, resolveUrlTarget } from './environments.ts';
import { urlTargetEnvironments } from '@hypertest/tools';
import { acpAgentConfigs, computerUseOptions, isolationResolver, mcpServerConfigs, withRemoteWorkers, withToolRoleGrants } from './tool-config.ts';
import { recordedFailureFlipDetector } from './governance.ts';
import { keysDir, loadCapabilitySecret, loadSigningKeys } from './keys.ts';
import { acquireDirectoryLock, lockFileFor } from './lock.ts';
import { providerLocality } from './diagnose.ts';
import { startMemoryServiceProcess } from './memory-service.ts';
import {
  agentClassification, condenserPrivacyFloor, createReleaseService, hypertestGitSha, imageDigestFrom, releaseGovernedControlPlane, runtimeReleaseNotes, withRuntimeReleaseNotes,
  shadowDryRunAdapters, shadowRunLookup, handoverControlPlane,
} from './releases.ts';
import type { HypertestConfig, HypertestInstance, HypertestOverrides, HypertestServices, ProviderConfig, RuntimeReleaseService } from './contracts.ts';
import { applyHarnessFeatures, harnessFreshness, harnessRoleCatalog } from './harness-features.ts';

/** Every migration of the stateful packages, in dependency order (applied idempotently at startup). */
export const ALL_MIGRATIONS: readonly Migration[] = Object.freeze([
  ...collabMigrations, ...operationMigrations, ...evidenceMigrations, ...policyMigrations, ...contextMigrations, ...runtimeMigrations, ...controlMigrations,
  ...toolsMigrations,
]);

/** Outbox relay poll interval (one relay per database per process). */
export const RELAY_POLL_MS = 200;
/** Per-process cap of agents per run (the scheduler enforces the run's work-item budget; this is a safety net). */
export const MAX_AGENTS_PER_RUN = 1000;
/** Version of the ToolSpec/ToolExecution ABI recorded as `schemas.tool` in runtime manifests. */
export const TOOL_SCHEMA_VERSION = 'tools/1';
const NON_TERMINAL: TestRun['status'][] = ['created', 'running', 'paused', 'converging', 'gating'];

function readVersion(url: URL): { name?: string; version?: string } {
  try {
    return JSON.parse(readFileSync(url, 'utf8')) as { name?: string; version?: string };
  } catch {
    return {};
  }
}

/** The Hypertest release version: the monorepo root package.json (falls back to this package's version). */
export const HYPERTEST_VERSION: string = (() => {
  const root = readVersion(new URL('../../../package.json', import.meta.url));
  if (root.name === 'hypertest-monorepo' && root.version) return root.version;
  return readVersion(new URL('../package.json', import.meta.url)).version ?? '0.0.0';
})();

const sourceDigests = new Map<string, string>();

/**
 * conformance-8: sha256 over every file under `<package>/src` of the Hypertest packages (sorted relative paths and their
 * content digests), so the RuntimeManifest identifies the code, not only its version: a rebuilt Hypertest with changed
 * gate, scheduler or tool logic at the same version has another manifest and cannot drive the old runs (I11). Cached
 * per process. `packagesDir` defaults to this installation's packages directory.
 */
export function hypertestSourceDigest(packagesDir: string = fileURLToPath(new URL('../../', import.meta.url))): string {
  const cached = sourceDigests.get(packagesDir);
  if (cached) return cached;
  const files: Array<{ rel: string; digest: string }> = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, `${rel}/${e.name}`);
      else if (e.isFile()) files.push({ rel: `${rel}/${e.name}`, digest: sha256Hex(readFileSync(p)) });
    }
  };
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const src = join(packagesDir, pkg, 'src');
    if (existsSync(src)) walk(src, `${pkg}/src`);
  }
  const digest = sha256Hex(files.map((f) => `${f.rel}\0${f.digest}\n`).join(''));
  sourceDigests.set(packagesDir, digest);
  return digest;
}

function lastId(migrations: readonly Migration[]): string {
  return [...migrations].map((m) => m.id).sort().at(-1) ?? 'none';
}

function invalid(message: string, details: Record<string, unknown> = {}): HypertestError {
  return new HypertestError('invalid_argument', message, { details });
}

/**
 * Worker identity: stable per host for PGlite (one process per data directory); per process for PostgreSQL with the
 * local durable runtime. With Temporal (durability-4) every worker of one deployment shares ONE identity
 * (`worker:temporal:<namespace>/<taskQueue>`): Temporal schedules a run's tick/turn/observe activities on any of its
 * workers, and a single run workflow / child workflow per claim already guarantees one driver — a per-process identity
 * would make every activity that lands on another worker find the run lease, the waiting item's lease or its claim
 * "owned by someone else" (no-op ticks, lease_lost observations, `no_claim` children, wasted work attempts). Fencing
 * tokens still separate claims.
 */
export function defaultWorkerId(config: HypertestConfig): string {
  if (config.durable.kind === 'temporal') return `worker:temporal:${config.durable.namespace ?? DEFAULT_TEMPORAL_NAMESPACE}/${config.durable.taskQueue ?? DEFAULT_TEMPORAL_TASK_QUEUE}`;
  return config.store.kind === 'pglite' ? `worker:${hostname()}` : `worker:${hostname()}:${process.pid}`;
}

/**
 * (durability-6) The Temporal task queue of a runtime manifest: `<configured queue>@<manifest digest prefix>`. Workers
 * poll only their own manifest's queue and runs are started on the queue of the manifest they are pinned to (I11), so a
 * rolling upgrade or two differently configured workers never receive each other's activities (a pin refusal would fail
 * the run workflow instead).
 */
export function manifestTaskQueue(taskQueue: string, manifestId: string): string {
  return `${taskQueue}@${manifestId.replace(/^rm_/, '').slice(0, 16)}`;
}

// ------------------------------------------------------------------------------------------------ models

function buildProviders(config: HypertestConfig, overrides: HypertestOverrides, env: Record<string, string | undefined>, logger: Logger, pluginProviders: readonly ModelProvider[] = []): ProviderRegistry {
  const registry = new ProviderRegistry();
  const brains = overrides.scriptedBrains ?? {};
  for (const p of config.models.providers) {
    const apiKey = p.apiKeyEnv ? env[p.apiKeyEnv] : undefined;
    // e2e[3] fail closed on a missing credential: a provider that names an apiKeyEnv (or the hosted Anthropic API, which
    // always needs one) is UNAVAILABLE without its key — the router never routes to it and no request leaves the process
    const requireApiKey = p.apiKeyEnv !== undefined || (p.kind === 'anthropic' && !p.baseUrl);
    if (requireApiKey && (apiKey === undefined || apiKey.trim() === '')) {
      logger.warn('model provider credential is missing: its routes are unavailable (fail closed, no request is sent) until it is set (see `hypertest doctor`)', {
        provider: p.id, apiKeyEnv: p.apiKeyEnv ?? null,
      });
    }
    const common: { apiKey?: string; headers?: Record<string, string>; timeoutMs?: number; requireApiKey?: boolean; apiKeySource?: string; fetchImpl?: typeof fetch } = {};
    if (apiKey) common.apiKey = apiKey;
    if (p.kind !== 'scripted') {
      common.requireApiKey = requireApiKey;
      common.apiKeySource = p.apiKeyEnv ?? `models.providers[${p.id}].apiKeyEnv (not configured)`;
      if (overrides.fetch) common.fetchImpl = overrides.fetch;
    }
    if (p.headers) common.headers = { ...p.headers };
    if (p.timeoutMs !== undefined) common.timeoutMs = p.timeoutMs;
    let provider: ModelProvider;
    switch (p.kind) {
      case 'openai-compatible':
        provider = new OpenAICompatibleProvider({ providerId: p.id, baseUrl: p.baseUrl!, ...common });
        break;
      case 'anthropic':
        provider = new AnthropicProvider({ providerId: p.id, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), ...common });
        break;
      case 'pi-ai':
        provider = new PiAiProvider({ providerId: p.id, piProvider: p.piProvider!, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), ...common });
        break;
      case 'plugin': {
        // A[6]: contributed by a configured provider plugin (declared `provider:<id>`, digest-pinned)
        const contributed = pluginProviders.find((x) => x.providerId === p.id);
        if (!contributed) throw invalid(`models.providers (${p.id}): no loaded plugin provides provider ${p.id}`, { provider: p.id });
        provider = contributed;
        break;
      }
      case 'scripted': {
        const brain = Object.hasOwn(brains, p.id) ? brains[p.id] : undefined;
        if (!brain) throw invalid(`models.providers (${p.id}): scripted provider has no brain; pass overrides.scriptedBrains['${p.id}']`, { provider: p.id });
        provider = new ScriptedProvider({ providerId: p.id, brain });
        break;
      }
      default:
        throw invalid(`models.providers (${(p as ProviderConfig).id}): unknown provider kind ${JSON.stringify((p as ProviderConfig).kind)}`);
    }
    registry.register(provider);
  }
  for (const id of Object.keys(brains)) {
    if (!config.models.providers.some((p) => p.id === id && p.kind === 'scripted')) logger.warn('a scripted brain was given for a provider that is not a configured scripted provider', { provider: id });
  }
  return registry;
}

/**
 * The model catalog: every configured route completed with ROUTE_DEFAULTS; `continuationCompatibilityClass` is the
 * provider's tag (`anthropic:<model>`, `pi-ai:<api>:<piProvider>:<model>` from the resolved pi model,
 * `<providerId>:<model>` otherwise). A route pinning a different tag for anthropic/pi-ai is refused (the router would
 * reject every continuation of such a route).
 */
/**
 * (additive, F[11]) The model providers and the enabled route profiles of a configuration OUTSIDE an instance — e.g. the
 * eval's independent LLM judge (`hypertest eval run --judge config`) routes over them with its own router. `routeIds`
 * narrows to those routes (an unknown or disabled one is refused). Credentials resolve through `env` (`*Env` names).
 */
export async function configuredModels(
  config: HypertestConfig,
  overrides: Pick<HypertestOverrides, 'scriptedBrains' | 'env' | 'logger' | 'fetch'> = {},
  routeIds?: readonly string[],
): Promise<{ routes: ModelCapabilityProfile[]; providers: ModelProvider[] }> {
  const env = overrides.env ?? process.env;
  const logger = overrides.logger ?? jsonLogger({ level: 'warn', fields: { component: 'hypertest-models' } });
  const providers = buildProviders(config, overrides, env, logger);
  const catalog = await buildCatalog(config, providers);
  let routes = catalog.list().filter((r) => r.enabled !== false);
  if (routeIds !== undefined) {
    const missing = routeIds.filter((id) => !routes.some((r) => r.routeId === id));
    if (missing.length > 0) throw invalid(`no enabled route ${missing.join(', ')} in the configuration (models.routes)`);
    routes = routes.filter((r) => routeIds.includes(r.routeId));
  }
  return { routes, providers: providers.list() };
}

export async function buildCatalog(config: HypertestConfig, providers: ProviderRegistry): Promise<ModelCatalog> {
  const profiles: ModelCapabilityProfile[] = [];
  for (const [i, route] of config.models.routes.entries()) {
    const label = `models.routes[${i}] (${route.routeId})`;
    const p = config.models.providers.find((x) => x.id === route.provider);
    if (!p || !providers.has(route.provider)) throw invalid(`${label}: provider '${route.provider}' is not registered`);
    let tag = providerCompatibilityClass(p, route.model);
    if (p.kind === 'pi-ai') {
      try {
        tag = piCompatibilityClass(await (providers.get(p.id) as PiAiProvider).resolveModel(route.model));
      } catch (e) {
        throw invalid(`${label}: ${(e as Error).message}`, { routeId: route.routeId });
      }
    }
    if ((p.kind === 'anthropic' || p.kind === 'pi-ai') && route.continuationCompatibilityClass !== undefined && route.continuationCompatibilityClass !== tag) {
      throw invalid(`${label}: continuationCompatibilityClass must equal the provider's tag '${tag}'`, { routeId: route.routeId });
    }
    profiles.push(completeRoute(route, tag!));
  }
  return new ModelCatalog(profiles);
}

/** (A[1]) The observed-prices file: models.pricesFile, else `<dataDir>/state/model-prices.json`. */
export function modelPricesFile(config: HypertestConfig): string {
  return config.models.pricesFile ?? join(config.project.dataDir, 'state', 'model-prices.json');
}

/**
 * (coverage[7]) Merges models.scoresFile (eval-derived route quality scores) into the catalog: a new catalog revision and
 * the manifest's `modelScores` record (file digest, scored routes, provenance). A scores file naming an unknown route, or
 * an unreadable / invalid one, fails the composition (invalid_argument) — never silently ignored.
 */
export async function applyScoresFile(catalog: ModelCatalog, path: string): Promise<{ catalog: ModelCatalog; record: NonNullable<RuntimeManifest['modelScores']> }> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw invalid(`models.scoresFile: ${path} cannot be read: ${(e as Error).message}`, { path });
  }
  let doc;
  try {
    doc = parseRouteScoresFile(JSON.parse(bytes.toString('utf8')), `models.scoresFile ${path}`);
  } catch (e) {
    throw invalid((e as Error).message, { path });
  }
  const unknown = Object.keys(doc.scores).filter((r) => !catalog.get(r));
  if (unknown.length > 0) throw invalid(`models.scoresFile ${path}: scores for routes that are not configured: ${unknown.join(', ')}`, { path, unknown });
  const record: NonNullable<RuntimeManifest['modelScores']> = { digest: sha256Hex(bytes), routes: Object.keys(doc.scores).sort() };
  if (doc.source) {
    const src: NonNullable<NonNullable<RuntimeManifest['modelScores']>['source']> = {};
    for (const k of ['suiteId', 'revision', 'inputDigest', 'method'] as const) if (typeof doc.source[k] === 'string') src[k] = doc.source[k] as string;
    if (typeof doc.source.trials === 'number') src.trials = doc.source.trials;
    record.source = src;
  }
  return { catalog: catalog.withScores(doc.scores), record };
}

// ------------------------------------------------------------------------------------------------ infrastructure

async function openStore(config: HypertestConfig, env: Record<string, string | undefined>): Promise<SqlDatabase> {
  const s = config.store;
  if (s.kind === 'pglite') {
    await mkdir(s.dataDir!, { recursive: true, mode: 0o700 });
    return openDatabase({ kind: 'pglite', dataDir: s.dataDir! });
  }
  const url = s.url ?? (s.urlEnv ? env[s.urlEnv] : undefined);
  if (!url) throw new HypertestError('precondition_failed', `store.urlEnv names ${s.urlEnv}, which is not set`);
  return openDatabase({ kind: 'postgres', url, ...(s.schema ? { schema: s.schema } : {}) });
}

async function openBus(config: HypertestConfig, workerId: string, logger: Logger): Promise<EventBus> {
  if (config.bus.kind === 'inprocess') return new InProcessEventBus({ logger: logger.child({ component: 'bus' }) });
  return connectNatsEventBus({
    servers: config.bus.servers,
    ...(config.bus.stream ? { stream: config.bus.stream } : {}),
    ...(config.bus.subjectPrefix ? { subjectPrefix: config.bus.subjectPrefix } : {}),
    name: `hypertest-${workerId.replace(/[^A-Za-z0-9_-]+/g, '-')}`,
    logger: logger.child({ component: 'bus' }),
  });
}

function openArtifacts(config: HypertestConfig, env: Record<string, string | undefined>): ArtifactStore {
  const a = config.artifacts;
  if (a.kind === 'fs') return new FsArtifactStore(a.root!);
  const options: ConstructorParameters<typeof S3ArtifactStore>[0] = { region: a.region, bucket: a.bucket };
  if (a.endpoint) options.endpoint = a.endpoint;
  if (a.prefix) options.prefix = a.prefix;
  if (a.forcePathStyle !== undefined) options.forcePathStyle = a.forcePathStyle;
  if (a.objectLockDays !== undefined) options.objectLockDays = a.objectLockDays;
  if (a.accessKeyIdEnv && a.secretAccessKeyEnv) {
    const accessKeyId = env[a.accessKeyIdEnv];
    const secretAccessKey = env[a.secretAccessKeyEnv];
    if (!accessKeyId || !secretAccessKey) throw new HypertestError('precondition_failed', `artifacts: ${!accessKeyId ? a.accessKeyIdEnv : a.secretAccessKeyEnv} is not set`);
    options.credentials = { accessKeyId, secretAccessKey };
  }
  return new S3ArtifactStore(options);
}

/**
 * conformance-12: the revision of the policies an OPA server serves for the decision path — `opa:<path>@<sha256 of the
 * policy modules (id + source) of that package subtree, 16 hex>` from its policy API (`GET /v1/policies`) — so a changed
 * policy is a changed policyRevision and
 * RuntimeManifest. An OPA server that cannot list its policies yields `opa:<path>@unverified` (logged): the decisions
 * still fail closed on OPA errors, and the manifest says the policy content is unknown.
 */
export async function opaPolicyRevision(url: string, path: string, options: { fetch?: typeof fetch; timeoutMs?: number; logger?: Logger } = {}): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  try {
    const res = await doFetch(`${url.replace(/\/+$/, '')}/v1/policies`, { signal: AbortSignal.timeout(options.timeoutMs ?? 2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result?: Array<{ id?: unknown; raw?: unknown }> };
    if (!Array.isArray(body.result)) throw new Error('no result list');
    // the modules of the decision's package subtree (another tenant's policies on a shared server do not count)
    const pkg = path.replace(/^\/+|\/+$/g, '').replace(/\//g, '.');
    const modules = body.result
      .map((m) => ({ id: String(m.id ?? ''), raw: String(m.raw ?? '') }))
      .filter((m) => {
        const declared = /^\s*package\s+([A-Za-z0-9_.]+)/m.exec(m.raw)?.[1];
        return declared !== undefined && (declared === pkg || declared.startsWith(`${pkg}.`));
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return `opa:${path}@${sha256Hex(canonicalJson(modules)).slice(0, 16)}`;
  } catch (e) {
    options.logger?.warn('OPA policies could not be listed: the policy revision is unverified', { url, error: (e as Error).message });
    return `opa:${path}@unverified`;
  }
}

async function policyEngine(config: HypertestConfig, capabilitySecret: string, deps: { clock: typeof systemClock; newId: () => string; logger: Logger }): Promise<PolicyEngine> {
  const rules = [...DEFAULT_POLICY_RULES, ...(config.policy?.rules ?? [])];
  const builtin = new BuiltinPolicyEngine(rules, `builtin:${sha256Hex(canonicalJson(rules)).slice(0, 16)}`, { clock: deps.clock, capabilitySecret, newId: deps.newId });
  const opa = config.policy?.opa;
  if (!opa) return builtin;
  const path = opa.path ?? 'hypertest/authz';
  const engine = new OpaPolicyEngine({
    url: opa.url,
    path,
    revision: await opaPolicyRevision(opa.url, path, { logger: deps.logger, ...(opa.timeoutMs !== undefined ? { timeoutMs: opa.timeoutMs } : {}) }),
    clock: deps.clock,
    capabilitySecret,
    newId: deps.newId,
    ...(opa.timeoutMs !== undefined ? { timeoutMs: opa.timeoutMs } : {}),
  });
  return new CompositePolicyEngine([builtin, engine], { newId: deps.newId });
}

/**
 * security-2: the origins a command agents run may reach from the sandbox (its `loopback` / `egress_allowlist` profile):
 * the registered environments' base URLs (the systems under test) and the operator's http allowlist entries that are
 * URLs. The local sandbox relays only this host's loopback endpoints among them; nothing else is reachable.
 */
export function sandboxEgressOrigins(environments: Pick<EnvironmentRegistry, 'list'>, httpAllowlist: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const e of environments.list()) if (e.baseUrl) out.add(e.baseUrl);
  for (const a of httpAllowlist ?? []) if (/^https?:\/\//.test(a)) out.add(a);
  return [...out];
}

/**
 * (E[2]) The egress policy of every relayed endpoint: the registered environments' base URLs (their effects keyed on
 * `env/<id>`; `rawEgress` / `honoursIdempotencyKey` as the operator declared them) and the operator's http allowlist URLs
 * (`url/<host>`, HTTP only).
 */
export function sandboxEgressPolicies(environments: Pick<EnvironmentRegistry, 'list'>, httpAllowlist: readonly string[] | undefined): EgressEndpointPolicy[] {
  const out: EgressEndpointPolicy[] = [];
  for (const e of environments.list()) {
    if (!e.baseUrl) continue;
    const p: EgressEndpointPolicy = { origin: e.baseUrl, resource: `env/${e.environmentId}` };
    if (e.rawEgress === true) p.raw = true;
    if (e.honoursIdempotencyKey === true) p.honoursIdempotencyKey = true;
    out.push(p);
  }
  for (const a of httpAllowlist ?? []) if (/^https?:\/\//.test(a) && !out.some((p) => p.origin === a)) out.push({ origin: a });
  return out;
}

/**
 * H1: what the local sandbox hides from the commands agents run (enforced by its jail where the host supports it): the
 * signing keys and capability secret, the embedded store, the evidence artifacts and the runtime state. A configured
 * path that contains the workspaces directory cannot be hidden (nothing could run) and is reported, never silently
 * dropped.
 */
export function sandboxHiddenPaths(config: HypertestConfig, dataDir: string, stateDir: string, logger?: Logger): string[] {
  const workspacesDir = resolve(join(dataDir, 'workspaces'));
  const candidates = [keysDir(dataDir), stateDir];
  // E[4]: an externally configured signing key file is hidden too (a file ⇒ /dev/null in the jail)
  if (config.signing?.keyFile) candidates.push(config.signing.keyFile);
  if (config.store.kind === 'pglite' && config.store.dataDir) candidates.push(config.store.dataDir);
  if (config.artifacts?.kind === 'fs' && config.artifacts.root) candidates.push(config.artifacts.root);
  // (B[4]) the memory service's own store: agent commands never read or rewrite (approved) experience behind its API
  if (config.memory?.kind === 'service' && config.memory.dataDir) candidates.push(config.memory.dataDir);
  const out: string[] = [];
  for (const c of candidates.map((p) => resolve(p))) {
    if (workspacesDir === c || workspacesDir.startsWith(c.endsWith(sep) ? c : c + sep)) {
      logger?.warn('sandbox: a path holding the workspaces cannot be hidden from sandboxed commands', { path: c, workspacesDir });
      continue;
    }
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * (E[4]) Refuses a local sandbox that cannot hide the signing keys, the capability secret and the store from the commands
 * agents run — `network: open` (no namespaces at all) or a host without the PID/mount jail (python3 + namespaces) — unless
 * the operator opted in with `sandbox.insecureAllowUnhiddenSecrets: true` (then a loud warning at every start).
 */
export async function assertSecretsHidden(config: HypertestConfig, profile: SandboxProfile, isolationOptions: NetworkIsolationOptions | undefined, logger: Logger): Promise<void> {
  let why: string | undefined;
  if (profile.network === 'open') why = 'sandbox.network is open: commands run without namespaces';
  else {
    const iso = await networkIsolation(isolationOptions ?? {});
    if (!iso.available) why = `no namespace isolation on this host (${iso.reason})`;
    else if (!iso.jail) why = `the host's isolation strategy ${iso.strategy} has no PID/mount jail (needs python3 and PID/mount namespaces)`;
  }
  if (why === undefined) return;
  if (config.sandbox?.insecureAllowUnhiddenSecrets === true) {
    logger.warn('INSECURE: the local sandbox does NOT hide the signing keys, the capability secret and the store from the commands agents run (sandbox.insecureAllowUnhiddenSecrets)', { why });
    return;
  }
  throw new HypertestError(
    'precondition_failed',
    `the local sandbox cannot hide the signing keys, the capability secret and the store from the commands agents run: ${why}. ` +
      'Use the OCI sandbox (sandbox.kind: oci), or a host with python3 and user/PID/mount namespaces, or — accepting that agent commands can read those secrets — set sandbox.insecureAllowUnhiddenSecrets: true',
    { details: { why } },
  );
}

/** The local sandbox profile: loopback network, minimal environment allowlist, merged with `config.sandbox`. */
export function sandboxProfile(config: HypertestConfig): SandboxProfile {
  const { egressWrites: _w, insecureAllowUnhiddenSecrets: _i, roles: _r, ...profile } = config.sandbox ?? {};
  return { kind: 'local', network: 'loopback', envAllowlist: [...DEFAULT_ENV_ALLOWLIST], ...profile } as SandboxProfile;
}

/** Exact search answers single-line queries only; multi-line prose (e.g. a work item objective) goes to the symbol index. */
function singleLineOnly(inner: Retriever): Retriever {
  return {
    name: inner.name,
    search: (query, signal) => ((query.text ?? query.symbol ?? '').includes('\n') ? Promise.resolve([]) : inner.search(query, signal)),
  };
}

/**
 * Per-root L3 retrievers — symbol graph + exact search + semantic vectors, RRF-fused — cached so the symbol index and
 * the vector corpus are built once per root (the vector corpus again when the root's commit changes). Vectors live in
 * pgvector when the store has it (feature-detected once, lazily: `sharedIndex`), else in memory per corpus.
 * (B[6] privacy) `restricted` roots — agents whose context is classified restricted — embed with `restrictedEmbedder` (the
 * local hashing embedder when the configured embedder's provider is off-host) into in-memory corpora of their own. The symbol
 * index takes the private Go helper directory (`goHelperDir`, hidden from sandboxed commands).
 */
export function cachedRetrievers(
  logger: Logger,
  vectors: { embedder: Embedder; sharedIndex: () => Promise<VectorIndex | undefined>; restrictedEmbedder?: Embedder },
  goHelperDir?: string,
): (root: string, options?: { restricted?: boolean }) => Retriever {
  const cache = new Map<string, Retriever>();
  // at most 8 workspace corpora in this process (LRU), whatever the number of parallel worktrees
  const corpora = new VectorCorpusCache({ maxCorpora: 8, logger });
  // (B[6] privacy) restricted agents' corpora: embedded locally only, kept apart (in memory, never in the shared pgvector index)
  const restrictedCorpora = new VectorCorpusCache({ maxCorpora: 4, logger });
  return (root, options) => {
    const restricted = options?.restricted === true && vectors.restrictedEmbedder !== undefined;
    const key = `${restricted ? 'restricted' : 'default'}\u0000${root}`;
    let r = cache.get(key);
    if (!r) {
      const vector = restricted
        ? new WorkspaceVectorRetriever({ root, embedder: vectors.restrictedEmbedder!, cache: restrictedCorpora, logger })
        : new WorkspaceVectorRetriever({ root, embedder: vectors.embedder, sharedIndex: vectors.sharedIndex, cache: corpora, logger });
      r = new HybridRetriever([new SymbolIndex(goHelperDir !== undefined ? { root, goHelperDir } : { root }), singleLineOnly(new ExactSearch({ root })), vector], { logger });
      cache.set(key, r);
      if (cache.size > 64) cache.delete(cache.keys().next().value!);
    }
    return r;
  };
}

/**
 * (B[6]) The `retrieval.embedder` route: an OpenAI-compatible `/embeddings` endpoint of a configured provider (its baseUrl,
 * apiKeyEnv, headers; the fetch override applies). Undefined when not configured — or, fail closed, when the provider's
 * credential is missing (no request is sent; the hashing embedder is used and the reason logged).
 */
function semanticEmbedder(config: HypertestConfig, env: Record<string, string | undefined>, overrides: HypertestOverrides, logger: Logger): { embedder: Embedder; local: boolean } | undefined {
  const route = config.retrieval?.embedder;
  if (!route) return undefined;
  const provider = config.models.providers.find((p) => p.id === route.provider);
  if (!provider || provider.kind !== 'openai-compatible' || !provider.baseUrl) {
    throw invalid(`retrieval.embedder.provider ${route.provider} must be an openai-compatible models.providers[] entry with a baseUrl`, { provider: route.provider });
  }
  const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
  if (provider.apiKeyEnv && (apiKey === undefined || apiKey.trim() === '')) {
    logger.warn('retrieval.embedder: the provider credential is missing; semantic embeddings are off (hashing embedder in use, no request is sent)', { provider: provider.id, apiKeyEnv: provider.apiKeyEnv });
    return undefined;
  }
  // (B[6] privacy) where the code goes: a provider outside this host / private network never embeds restricted agents' code
  const { local, where } = providerLocality(provider);
  logger.info('L3 vectors: semantic embeddings through an OpenAI-compatible /embeddings route', { provider: provider.id, model: route.model, dimensions: route.dimensions, where });
  const embedder = new OpenAICompatibleEmbedder({
    baseUrl: provider.baseUrl, model: route.model, dimensions: route.dimensions,
    ...(apiKey ? { apiKey } : {}), ...(provider.headers ? { headers: { ...provider.headers } } : {}),
    ...(route.timeoutMs !== undefined ? { timeoutMs: route.timeoutMs } : provider.timeoutMs !== undefined ? { timeoutMs: provider.timeoutMs } : {}),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
  });
  return { embedder, local };
}

/** pgvector when the store offers the extension (PGlite with `vector`, PostgreSQL with pgvector), else undefined (in memory). */
function pgVectorProbe(db: SqlDatabase, embedder: Embedder, logger: Logger): () => Promise<VectorIndex | undefined> {
  let probe: Promise<VectorIndex | undefined> | undefined;
  return () =>
    (probe ??= createPgVectorIndex(db, embedder).then(
      (index) => {
        logger.info('L3 vectors: pgvector index in use', { modelId: embedder.modelId });
        return index;
      },
      (e: unknown) => {
        logger.info('L3 vectors: pgvector unavailable; workspace corpora are kept in memory', { error: (e as Error).message });
        return undefined;
      },
    ));
}

/** The durable runtime of the configuration: LocalDurableRuntime (in-process) or TemporalDurableRuntime. */
function createDurable(config: HypertestConfig, base: { control: ControlPlane; listRuns: () => Promise<TestRun[]> } & DurableHooks, manifestId: string): DurableRuntime {
  if (config.durable.kind === 'temporal') {
    const options: TemporalDurableOptions = { ...base, address: config.durable.address };
    if (config.durable.namespace) options.namespace = config.durable.namespace;
    options.taskQueue = manifestTaskQueue(config.durable.taskQueue ?? DEFAULT_TEMPORAL_TASK_QUEUE, manifestId);
    if (config.durable.workerMode) options.workerMode = config.durable.workerMode;
    return new TemporalDurableRuntime(options);
  }
  return new LocalDurableRuntime({ ...base, maxConcurrentTurns: config.durable.maxConcurrentTurns ?? 4 });
}

// ------------------------------------------------------------------------------------------------ I11 pinning

/** Run ids accepted from callers (they become path segments, git branch names and workflow ids). */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PIN_CACHE_MAX = 10_000;

function pinViolation(run: TestRun, manifestId: string): HypertestError {
  return new HypertestError(
    'precondition_failed',
    `run ${run.runId} is pinned to runtime manifest ${run.runtimeManifestId}; this runtime is ${manifestId} (I11: a live run is never driven by another runtime — resume it with the runtime it was created on, or cancel it)`,
    { details: { runId: run.runId, pinnedManifestId: run.runtimeManifestId, runtimeManifestId: manifestId } },
  );
}

/** Lookups of pinnedControlPlane. */
export interface PinLookup {
  getRun(runId: string): Promise<TestRun | undefined>;
  /** The run of a work item (undefined when unknown). */
  runOf(workItemId: string): Promise<string | undefined>;
}

/**
 * I11 at the control boundary: the ControlPlane the durable runtime (and its Temporal activities) drives refuses to
 * tick, recover or execute turns of a live run pinned to another RuntimeManifest (`precondition_failed`, which both
 * runtimes treat as non-retryable). Finished runs stay readable (their outcome, reconciliation of their operations).
 * Every other member is the wrapped control plane's.
 */
export function pinnedControlPlane(control: ControlPlane, manifestId: string, lookup: PinLookup): ControlPlane & { forgetPin(runId: string): void } {
  const pinnedHere = new Set<string>();
  const runOfItem = new Map<string, string>();
  const bounded = (size: number, evict: () => void) => {
    if (size > PIN_CACHE_MAX) evict();
  };
  async function assertRun(runId: string): Promise<void> {
    if (pinnedHere.has(runId)) return;
    const run = await lookup.getRun(runId);
    if (!run) return; // the control plane reports not_found
    if (run.runtimeManifestId === manifestId) {
      // the pin of a run changes only through an explicit migration (forgetPin evicts it here; the control plane itself
      // re-checks the pin of every tick and turn from the stored run, so a migration in another process is never missed)
      pinnedHere.add(runId);
      bounded(pinnedHere.size, () => pinnedHere.delete(pinnedHere.values().next().value!));
      return;
    }
    if (isTerminalRun(run.status)) return;
    throw pinViolation(run, manifestId);
  }
  async function assertWork(workItemId: string): Promise<void> {
    let runId = runOfItem.get(workItemId);
    if (runId === undefined) {
      runId = await lookup.runOf(workItemId);
      if (runId === undefined) return;
      runOfItem.set(workItemId, runId);
      bounded(runOfItem.size, () => runOfItem.delete(runOfItem.keys().next().value!));
    }
    await assertRun(runId);
  }
  const pinned: ControlPlane & { forgetPin(runId: string): void } = {
    ...control,
    forgetPin(runId: string) {
      pinnedHere.delete(runId);
    },
    async tick(runId, options) {
      await assertRun(runId);
      return control.tick(runId, options);
    },
    async recover(runId, signal) {
      await assertRun(runId);
      return control.recover(runId, signal);
    },
    async executeTurn(workItemId, fencingToken, signal, options) {
      await assertWork(workItemId);
      return control.executeTurn(workItemId, fencingToken, signal, options);
    },
    async observeWaiting(workItemId, signal) {
      await assertWork(workItemId);
      return control.observeWaiting(workItemId, signal);
    },
  };
  const renew = control.renewClaim;
  if (renew) {
    pinned.renewClaim = async (workItemId, fencingToken) => {
      await assertWork(workItemId);
      return renew.call(control, workItemId, fencingToken);
    };
  }
  return pinned;
}

/**
 * The verdict's own verification (beyond the evidence chain): the run's current QualityDecision must carry an Ed25519
 * signature by a trusted key over its content, and be bound to the root of the first `evidenceCount` evidence records
 * of the verified chain. A decision edited in the store, or re-bound to other evidence, is reported.
 */
export async function decisionProblems(
  run: TestRun,
  deps: { decisions: Pick<DecisionRepository, 'get'>; evidence: Pick<EvidenceLedger, 'query' | 'rootHash'>; publicKeys: Record<string, string> },
): Promise<string[]> {
  if (!run.decisionId) return [];
  const d = await deps.decisions.get(run.decisionId);
  if (!d) return [`decision_missing: run ${run.runId} names decision ${run.decisionId}, which does not exist`];
  const problems: string[] = [];
  if (d.runId !== run.runId) problems.push(`decision_run: decision ${d.decisionId} belongs to run ${d.runId}`);
  const sig = d.signature;
  if (!sig) problems.push(`decision_signature: decision ${d.decisionId} is not signed`);
  else {
    const pem = Object.hasOwn(deps.publicKeys, sig.keyId) ? deps.publicKeys[sig.keyId] : undefined;
    const { signature: _s, ...unsigned } = d;
    if (!pem) problems.push(`decision_signature: decision ${d.decisionId} is signed by untrusted key ${sig.keyId}`);
    else if (sig.algorithm !== 'ed25519') problems.push(`decision_signature: decision ${d.decisionId} uses unsupported algorithm ${sig.algorithm}`);
    else if (!verifyEd25519(pem, canonicalJson(unsigned), sig.value)) problems.push(`decision_signature: the signature of decision ${d.decisionId} does not verify (its content was altered)`);
  }
  const records = (await deps.evidence.query({ runId: run.runId })).sort((a, b) => a.seq - b.seq);
  if (!Number.isSafeInteger(d.evidenceCount) || d.evidenceCount < 0 || d.evidenceCount > records.length) {
    problems.push(`decision_root: decision ${d.decisionId} covers ${d.evidenceCount} evidence records but the run has ${records.length}`);
  } else {
    const upto = d.evidenceCount === 0 ? 0 : records[d.evidenceCount - 1]!.seq;
    const root = await deps.evidence.rootHash(run.runId, upto);
    if (root.rootHash !== d.evidenceRootHash || root.count !== d.evidenceCount) {
      problems.push(`decision_root: decision ${d.decisionId} is bound to evidence root ${d.evidenceRootHash} (${d.evidenceCount} records) but the chain's root over those records is ${root.rootHash}`);
    }
  }
  return problems;
}

// ------------------------------------------------------------------------------------------------ composition

/**
 * The composition root. Validates the configuration, then wires (in this order) the store + ALL migrations, the event
 * bus + one outbox relay, artifacts, the persisted evidence signer, the evidence ledger, the operation services and
 * side-effect adapters, the policy engine (+ OPA), decision log, approvals, oracle governance, QualityGate and the
 * BUGate binding, the model providers/catalog/router, the context services and freshness resolvers, the tool
 * registry/runtime/workspaces/sandbox, the runtime (sessions, agents, epochs, native + pi engines (+ the DSH engine when it
 * is the configured default), subagents, runner),
 * the role catalog, the RuntimeManifest (I11, the runtime BOM), the control plane (pinned to the manifest, governed by the
 * runtime release registry) and the durable runtime, and the runtime release service. Anything opened before a
 * failure is closed again. Runs are NOT resumed automatically: call `resumeIncomplete()` (e.g. `hypertest resume`).
 */
export async function createHypertest(input: HypertestConfig, overrides: HypertestOverrides = {}): Promise<HypertestInstance> {
  const errors = validateConfig(input);
  if (errors.length > 0) throw invalid(`invalid configuration:\n  - ${errors.join('\n  - ')}`, { errors });
  // (F[8]) an eval causal arm's harness features (refused outside an eval trial instance)
  const config = applyHarnessFeatures(withDerivedPaths(resolveConfigPaths(input, process.cwd())), overrides);
  const env = overrides.env ?? process.env;
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? new UlidIdGenerator();
  const logger = overrides.logger ?? jsonLogger({ level: config.observability?.logLevel ?? 'info', fields: { component: 'hypertest' } });
  const workerId = overrides.workerId ?? defaultWorkerId(config);
  const dataDir = config.project.dataDir;
  const base = { ids, clock, logger };

  // Pure construction first: a missing scripted brain, a bad provider or route, a malformed image digest fails before
  // anything is created.
  const imageDigest = imageDigestFrom(env);
  // A[6] kernel plugins (digest-pinned local modules): loaded, started and health-checked before anything uses them
  const plugins = await createPluginKernel((config.plugins ?? []).map((p) => ({ ...p, ...(p.config ? { config: p.config } : {}) })), { logger, clock });
  let providers: ProviderRegistry;
  try {
    providers = buildProviders(config, overrides, env, logger, plugins.providers());
  } catch (e) {
    await plugins.stop();
    throw e;
  }
  for (const p of config.models.providers) {
    if (p.maxRetries !== undefined) logger.warn('models.providers[].maxRetries is not supported: retries and fail-closed fallback are the model router\'s; the value is ignored', { provider: p.id });
  }
  const pending: Array<{ name: string; close: () => Promise<void> }> = [];
  pending.push({ name: 'plugins', close: () => plugins.stop() });
  const closeAll = async (): Promise<void> => {
    for (const c of pending.splice(0).reverse()) {
      try {
        await c.close();
      } catch (e) {
        logger.error('error while closing a Hypertest resource', { resource: c.name, error: (e as Error).message });
      }
    }
  };

  try {
    let catalog = await buildCatalog(config, providers);
    // coverage[7]: eval-derived quality scores (an explicit, auditable file) feed the router's quality stage
    let modelScores: RuntimeManifest['modelScores'];
    if (config.models.scoresFile) {
      const applied = await applyScoresFile(catalog, config.models.scoresFile);
      catalog = applied.catalog;
      modelScores = applied.record;
      logger.info('eval-derived route scores applied to the model catalog', { scoresFile: config.models.scoresFile, routes: applied.record.routes, catalogRevision: catalog.revision });
    }
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const keys = await loadSigningKeys(config, dataDir, logger);
    const capabilitySecret = await loadCapabilitySecret(config, dataDir, env, logger);

    // ---- store + collaboration plane
    if (config.store.kind === 'pglite') {
      // one process per embedded data directory: PGlite has no locking, and a second process would lose writes and act
      // as the same worker (fencing)
      await mkdir(config.store.dataDir!, { recursive: true, mode: 0o700 });
      const lock = await acquireDirectoryLock(lockFileFor(config.store.dataDir!), `PGlite data directory ${config.store.dataDir}`, logger);
      pending.push({ name: 'store lock', close: () => lock.release() });
    }
    const db = await openStore(config, env);
    pending.push({ name: 'database', close: () => db.close() });
    await migrate(db, ALL_MIGRATIONS);
    const bus = overrides.bus ?? (await openBus(config, workerId, logger));
    if (!overrides.bus) pending.push({ name: 'bus', close: () => bus.close() });
    const events = createEventStore({ ...base, db });
    const blackboard = createBlackboard({ ...base, db, events });
    const runs = createRunRepository({ ...base, db, events });
    const specs = createSpecRepository({ ...base, db, events });
    const decisions = createDecisionRepository({ ...base, db, events });
    const inbox = createInbox({ ...base, db });
    const relay: OutboxRelay = createOutboxRelay({ ...base, db, bus, pollMs: RELAY_POLL_MS });

    // ---- evidence
    const artifacts = openArtifacts(config, env);
    if (artifacts instanceof S3ArtifactStore) pending.push({ name: 'artifacts', close: async () => artifacts.destroy() });
    const signer = keys.signer;
    const evidence = createEvidenceLedger({ ...base, db, artifacts, events, signer });

    // ---- external world (operation) + environments (generations persisted: a restart never forgets a deploy)
    const stateDir = join(dataDir, 'state');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const operatorEnvironments = [...resolveEnvironments(config.environments ?? [], env, logger), ...(overrides.environments ?? [])];
    // (e2e[0]) every allowlisted URL target (tools.httpAllowlist URL entries) is a black-box environment of this deployment
    // (`url-<host>-<port>`; class local for loopback, else tools.urlEnvironmentClass): `hypertest run --url` targets it and
    // its agents probe it — by URL or by id — under their env/** grant (every process derives the same set from the config)
    const configuredEnvironments = [
      ...operatorEnvironments,
      ...urlTargetEnvironments(config.tools?.httpAllowlist, operatorEnvironments, {
        ...(config.tools?.urlEnvironmentClass !== undefined ? { remoteClass: config.tools.urlEnvironmentClass } : {}),
        // (review) a remote URL is never classified by default (the class decides what agents may do there)
        onUnclassified: (entry) => logger.warn('tools.httpAllowlist: a non-loopback URL is not a black-box environment until tools.urlEnvironmentClass names its class (it cannot be targeted with --url)', { entry }),
      }),
    ];
    // H12: workers sharing one PostgreSQL store share the generations (and bumps by operation) in SQL — a worker never
    // validates freshness against a generation another worker already bumped; the embedded store keeps its state file
    const environments: EnvironmentRegistry =
      config.store.kind === 'postgres'
        ? await createSqlEnvironmentRegistry({ db, clock, logger: logger.child({ component: 'environments' }) }, configuredEnvironments)
        : persistentEnvironmentRegistry(createEnvironmentRegistry(configuredEnvironments), join(stateDir, ENVIRONMENT_STATE_FILE), logger);
    const flushEnvironments = (environments as { flush?: () => Promise<void> }).flush;
    if (flushEnvironments) pending.push({ name: 'environments', close: () => flushEnvironments.call(environments) });
    const ledger = createOperationLedger({ ...base, db, events });
    const leases = createLeaseService({ ...base, db, events });
    const adapters = new AdapterRegistry(builtinSideEffectAdapters({ stateDir, environments }));
    // (F[0]) a mirrored run of a shadow release dry-runs every external effect (recorded not_applied, never dispatched)
    const effectAdapters = shadowDryRunAdapters(adapters, shadowRunLookup((id) => runs.get(id)));
    const gateway = createSideEffectGateway({ ...base, db, events, ledger, leases, adapters: effectAdapters });
    const reconciler = createReconciler({ ...base, db, events, ledger, leases, adapters: effectAdapters });
    const admission = createResourceAdmission({ ...base, db, events });
    const budget = createBudgetLedger({ ...base, db, events });

    // ---- governance
    const approvals = createApprovalService({ ...base, db, events });
    // E[8]: approval_required actions wait for an independent human decision; an approval bound to the exact action is
    // consumed exactly once by the one call it authorizes (ApprovalGatedPolicyEngine around the rules + OPA)
    const policy: PolicyEngine = new ApprovalGatedPolicyEngine(await policyEngine(config, capabilitySecret, { clock, newId: () => ids.next('pdec'), logger }), { approvals, clock });
    const decisionLog = createPolicyDecisionLog({ ...base, db, events });
    // SpecRepository.saveOracleProposal already emits oracle.change_* events: no `events` here (no double emission)
    const oracles = createOracleGovernance({
      ...base,
      store: specs,
      decisions,
      wouldFlipRecordedFailure: recordedFailureFlipDetector({
        getOracle: (id, revision) => specs.getOracle(id, revision),
        // every revision: a failure recorded once stays recorded even if the finding was later superseded
        findings: (runId) => blackboard.query<Finding>({ runId, recordType: 'finding', includeSuperseded: true }),
        getEvidence: (ids) => evidence.getMany(ids),
        testResults: (runId) => evidence.query({ runId, evidenceType: 'test-result' }),
        // H8: every recorded evidence type, judged by the QualityGate's own evaluator
        evidence: (runId) => evidence.query({ runId }),
      }),
    });
    // conformance-1: configured oracles are established by their named human authority (an existing oracle is kept: it
    // changes only through governed proposals); runs started without explicit oracleIds pin them
    const configuredOracleIds: string[] = [];
    for (const o of config.oracles ?? []) {
      configuredOracleIds.push(o.oracleId);
      const existing = await specs.getOracle(o.oracleId);
      if (existing) {
        if (canonicalJson(existing.assertions as unknown as JsonValue) !== canonicalJson(o.assertions as unknown as JsonValue)) {
          logger.warn('a configured oracle differs from the established one; the established revision stays in force (oracles change only through governed proposals: hypertest oracle proposals / decide)', {
            oracleId: o.oracleId, revision: existing.revision,
          });
        }
        continue;
      }
      await oracles.establish(oracleSpecFromConfig(o), { kind: 'human', id: o.establishedBy }, { runId: `config-${o.oracleId}`, correlationId: `config-${o.oracleId}`, actorId: `human:${o.establishedBy}` });
    }
    const protocol = await resolveProtocolBinding(config.bugate?.path ? { bugatePath: config.bugate.path } : {});

    // ---- models (A[1]: observed prices re-read at every turn boundary; the configured price guard)
    const prices = createFilePriceSource(modelPricesFile(config), { logger: logger.child({ component: 'model-prices' }) });
    const circuitBreaker: CircuitBreakerOptions | undefined = config.models.priceGuard ? { priceGuard: { ...config.models.priceGuard } } : undefined;
    const router: ModelRouter = createModelRouter({ ...base, catalog, providers, events, prices, ...(circuitBreaker ? { circuitBreaker } : {}) });
    const preflightRouter: ModelRouter = createModelRouter({ ...base, catalog, providers });

    // ---- context engine
    const snapshots = createSnapshotStore({ ...base, db, events });
    // what agents observed through their tool calls (fed by the observing tool runtime below): the next turn's read set,
    // and the intra-turn refinement of the freshness guard
    const observations = createObservationLog({ ...base, db });
    const resolvers = createResolverRegistry([
      // the authoritative generation (the shared store when the registry has one: H12), not this process's view
      environmentResolver((id) => (environments.load ? environments.load(id) : environments.get(id))),
      oracleResolver((id) => specs.getOracle(id)),
      experimentResolver((id) => specs.getExperiment(id)),
      recordResolver((lineage) => blackboard.head(lineage)),
      leaseResolver((key) => leases.current(key)),
    ]);
    const freshness = harnessFreshness(createFreshnessGuard({ ...base, db, events, snapshots, resolvers, observations }), config);
    // (B[1]) record-effect tool calls that passed the guard and took effect (a durable replay is never refused by its own write)
    const freshnessPasses = createFreshnessPassLog({ ...base, db });
    const snapshotBuilder = createSnapshotBuilder({
      ...base,
      db,
      events,
      snapshots,
      resolvers,
      observations,
      sources: {
        getRun: (runId) => runs.get(runId),
        lastEventSeq: (runId) => events.lastSeq(runId),
        blackboardRevision: (runId) => blackboard.revision(runId),
        evidenceRoot: (runId) => evidence.rootHash(runId),
        experimentRevisions: async (runId) => Object.fromEntries((await specs.listExperiments(runId)).map((e) => [e.experimentId, e.revision])),
      },
    });
    let memory: DurableMemory;
    if (config.memory?.kind === 'powercontext') {
      const apiKey = config.memory.apiKeyEnv ? env[config.memory.apiKeyEnv] : undefined;
      // (B[4]) the service is the authority; its accepted decisions are recorded in this deployment's L0 too
      memory = withExperienceEvents(new PowerContextClient({ baseUrl: config.memory.baseUrl, timeoutMs: 10_000, logger, ...(apiKey ? { apiKey } : {}) }), { events });
    } else if (config.memory?.kind === 'service') {
      // (B[4]) L4 as a separate service process with its own storage, started and stopped with this instance
      const apiKey = config.memory.apiKeyEnv ? env[config.memory.apiKeyEnv] : undefined;
      if (config.memory.apiKeyEnv && !apiKey) throw new HypertestError('precondition_failed', `memory.apiKeyEnv names ${config.memory.apiKeyEnv}, which is not set`);
      const service = await startMemoryServiceProcess({ dataDir: config.memory.dataDir ?? join(dataDir, 'memory'), logger, ...(apiKey ? { apiKey } : {}) });
      pending.push({ name: 'memory service', close: () => service.close() });
      memory = withExperienceEvents(new PowerContextClient({ baseUrl: service.url, apiKey: service.apiKey, timeoutMs: 10_000, logger }), { events });
    } else {
      memory = createExperienceStore({ ...base, db, events });
    }
    // (B[7]) the Skill Registry (store-enforced: only eval-validated revisions are published; only published skills reach
    // prompts); an eval arm may add `skills.trial` revisions to the prompts of its own trial instances
    const skillRegistry = createSkillRegistry({ ...base, db, events, experiences: memory });
    // `skills.trial` is an EVALUATION setting (the eval arm bound to a candidate revision): its revisions reach this instance's
    // prompts without being published, so an instance carrying it says so loudly at every start
    if ((config.skills?.trial ?? []).length > 0) {
      logger.warn('skills.trial: candidate skill revisions that are NOT published are shown (marked as candidates under evaluation) to the agents of this instance — an evaluation setting, never for production runs', {
        trial: (config.skills?.trial ?? []).map((t) => `${t.skillId} r${t.revision}`),
      });
    }
    const provenance = createProvenanceService({ evidence, events, records: blackboard });
    // L3 semantic retrieval: (B[6]) the `retrieval.embedder` route (an OpenAI-compatible /embeddings provider) when configured,
    // else deterministic feature-hashing embeddings
    const semantic = semanticEmbedder(config, env, overrides, logger);
    const vectorEmbedder = semantic?.embedder ?? new HashEmbedder();
    // (B[6] privacy) agents whose context is `restricted` (local_private) never have their workspace embedded by a provider
    // outside this host / private network: their retrieval embeds with the local hashing embedder
    const restrictedEmbedder = semantic && !semantic.local ? new HashEmbedder() : undefined;

    // ---- tools
    const profile = sandboxProfile(config);
    const workspacesDir = join(dataDir, 'workspaces');
    const workspaces = createWorkspaceManager({ ...base, baseDir: workspacesDir, defaultSandbox: profile });
    // file read-set entries (`workspace/<id>/<path>`, sha256) of the workspaces this process opened
    resolvers.register(workspaceFileResolver((workspaceId) => workspaces.get(workspaceId)?.root));
    // E[4]: the LLM never receives a long-lived static credential — where the local sandbox cannot hide the signing keys,
    // the capability secret and the store from the commands agents run, the composition is refused (fail closed) unless
    // the operator opted in, loudly (sandbox.insecureAllowUnhiddenSecrets)
    if (profile.kind === 'local') await assertSecretsHidden(config, profile, overrides.sandboxIsolation, logger);
    // (wave 3, row 250) a role tier may run on the other sandbox kind (e.g. a `separate` OCI tier over a local base): both
    // runners exist and each command goes to the one its workspace profile names
    const tierKinds = new Set(Object.values(config.sandbox?.roles ?? {}).map((t) => t.kind ?? profile.kind));
    const ociImage = profile.image ?? Object.values(config.sandbox?.roles ?? {}).find((t) => t.kind === 'oci')?.image;
    const ociSandbox = profile.kind === 'oci' || tierKinds.has('oci') ? createOciSandbox({ image: ociImage! }) : undefined;
    if (profile.kind === 'oci' && tierKinds.has('local')) await assertSecretsHidden(config, { ...profile, kind: 'local' }, overrides.sandboxIsolation, logger);
    const localSandbox = () => createLocalSandbox({
          ...(overrides.sandboxIsolation ? { networkIsolation: overrides.sandboxIsolation } : {}),
          ...(config.sandbox?.insecureAllowUnhiddenSecrets === true ? { allowUnhiddenPaths: true } : {}),
          hiddenPaths: sandboxHiddenPaths(config, dataDir, stateDir, logger),
          workspacesDir,
          // E[2]: HTTP-aware relays: safe methods pass, writes become ledgered operations (or are refused), raw traffic only
          // where the environment's operator allowed it
          egress: () => sandboxEgressPolicies(environments, config.tools?.httpAllowlist),
          egressWrites: config.sandbox?.egressWrites ?? 'ledger',
        });
    const baseSandbox = profile.kind === 'oci' ? ociSandbox! : localSandbox();
    const otherSandbox = profile.kind === 'oci' ? (tierKinds.has('local') ? localSandbox() : undefined) : ociSandbox;
    const sandbox = otherSandbox ? routedSandbox(profile.kind === 'oci' ? { oci: baseSandbox, local: otherSandbox } : { local: baseSandbox, oci: otherSandbox }) : baseSandbox;
    // (wave 3) env: operator-NAMED variables (db.introspect `database.urlEnv`) are read from the instance environment
    const toolOptions: BuiltinToolOptions = { sandbox, workspaces, stateDir, env };
    // (B[6]) code.symbols / code.references answer from the syntax-tree symbol graph (definitions, classified writes / calls)
    // the Go `go/ast` helper lives under the state directory, which every sandboxed command finds hidden (it runs outside
    // the sandbox: an agent-writable helper path would be a sandbox escape)
    const parserHelperDir = join(stateDir, 'parsers');
    toolOptions.retrieval = createCodeToolRetrieval({ logger, goHelperDir: parserHelperDir });
    if (config.tools?.shellAllowlist) toolOptions.shellAllowlist = [...config.tools.shellAllowlist];
    if (config.tools?.httpAllowlist) toolOptions.httpAllowlist = [...config.tools.httpAllowlist];
    if (config.tools?.enableBrowser) {
      toolOptions.enableBrowser = true;
      pending.push({ name: 'browser', close: () => closeBlackboxResources() });
    }
    // (E[5]/stubs[1]/coverage[3]) configured MCP servers: `mcp.<id>.<tool>` specs (lazily connected; stopped on close)
    // (row 246) external coding agents over ACP, run in the caller's workspace sandbox
    const acpAgents = acpAgentConfigs(config, env, logger);
    if (acpAgents.length > 0) toolOptions.acpAgents = acpAgents;
    // (row 246) computer use over the configured desktop (its X connection closed with the instance)
    const computer = computerUseOptions(config, logger);
    if (computer) {
      toolOptions.computer = computer;
      pending.push({ name: 'computer use', close: async () => computer.backend.close?.() });
    }
    const mcpServers = mcpServerConfigs(config, env, logger);
    if (mcpServers.length > 0) {
      toolOptions.mcpServers = mcpServers;
      if (!config.tools?.enableBrowser) pending.push({ name: 'mcp servers', close: () => closeBlackboxResources() });
    }
    // (row 246) tools delegated to remote workers keep their local classification; only their execute step runs remotely
    const registry = new ToolRegistry(withRemoteWorkers(builtinTools(toolOptions), config, env, logger, overrides.fetch));
    // A[6]: plugin tools join the same registry AFTER the built-in and domain tools (below), so a plugin tool can never
    // take a governed tool's id (the registry refuses a duplicate id: conflict)
    const toolDeps: ToolRuntimeDeps = {
      ...base,
      registry,
      policy,
      decisionLog,
      freshness,
      sideEffects: gateway,
      artifacts,
      evidence,
      events,
      environments,
      runtimeManifestId: 'rm_pending',
      workerId,
      capabilitySecret,
      // (wave 3, row 250) isolation tier per role (sandbox.roles) and work item (its capability requirements)
      isolation: isolationResolver(config, blackboard),
      // E[4] / coverage[8]: brokered credentials (short-lived, scoped, minted per call); outputs redacted with it
      secrets: createSecretBroker({
        credentials: (config.environments ?? []).flatMap((e) => (e.credentials ?? []).map((c) => ({ ...c, environmentId: e.environmentId }) as BrokeredCredentialConfig)),
        env,
        clock,
        logger,
        ...(overrides.credentialFetch ? { fetch: overrides.credentialFetch } : {}),
      }),
    };
    // every tool result feeds the observation log before it returns (tool results → read-set entries)
    const toolRuntime = observeToolRuntime(createToolRuntime(toolDeps), {
      log: observations,
      logger,
      now: () => clock.isoNow(),
      environmentVersion: async (id) => {
        const env = environments.load ? await environments.load(id) : environments.get(id);
        return env ? environmentVersion(env) : undefined;
      },
    });

    // ---- agent runtime
    // (B[8]) every transcript entry a session commits is also appended to L0 (ht_events) in the same transaction: L0 is the
    // root of context reconstruction (rebuildWorkingContext)
    const sessions = recordTranscriptOnL0(createSessionStore({ ...base, db, events }), { db, events, logger });
    const agents = createAgentRepository({ ...base, db, events });
    const epochs = createEpochManager({ ...base, db, events, sessions });
    const engineList: AgentEngine[] = [new NativeEngine({ ...base, sessions, events }), ...plugins.engines({ ...base, sessions, events })];
    try {
      engineList.push(new PiEngine({ ...base, sessions, events }));
    } catch (e) {
      if (config.engines?.default === 'pi') throw e;
      logger.warn('the pi engine is unavailable; only the native engine is registered', { error: (e as Error).message });
    }
    // The DeepSeek Harness adapter (pinned, experimental) is registered — and pinned by the manifest — when it is the
    // configured default engine; a drifted DSH install fails composition (precondition_failed), never a run.
    if (config.engines?.default === 'dsh') {
      const dsh = new DshEngine({ ...base, sessions, events });
      engineList.push(dsh);
      pending.push({ name: 'engine:dsh', close: () => dsh.close() });
    }
    const engines = new EngineRegistry(engineList);
    const defaultEngineKind = config.engines?.default ?? 'native';
    if (!engines.has(defaultEngineKind)) throw invalid(`engines.default: engine '${defaultEngineKind}' is not registered`);
    const subagents = createSubagentRuntime({ ...base, db, events, agents, sessions, engines, defaultEngineKind, maxAgentsPerRun: MAX_AGENTS_PER_RUN, capabilitySecret });
    const runner = createAgentRunner({ ...base, db, events, agents, sessions, engines, subagents });
    // (wave 3) configured tools (MCP servers) join the tool policy of the roles they are offered to
    const roles: RoleCatalogLike = harnessRoleCatalog(new RoleCatalog(BUILTIN_ROLES, { roles: withToolRoleGrants(config, roleOverrides(config)) }), config);

    // ---- control plane
    const controlConfig: ControlConfig = {
      capabilitySecret,
      runtimeManifest: { manifestId: 'rm_pending' } as RuntimeManifest,
      workerId,
      defaultEngineKind,
    };
    if (config.budget) controlConfig.defaultBudget = { ...config.budget };
    // E[3] the exhaustion policy (every run carries it in its budget; this is the control plane's fallback)
    if (config.budget?.onExhausted) controlConfig.onBudgetExhausted = config.budget.onExhausted;
    if (config.gate) controlConfig.defaultGate = { ...config.gate };
    const deps: ControlDeps = {
      ...base,
      db, events, blackboard, runs, specs, decisions, inbox, bus, relay,
      ledger, leases, gateway, reconciler, admission, budget, adapters,
      artifacts, evidence, signer,
      policy, decisionLog, approvals, oracles, gate: new QualityGate(), protocol,
      // the condenser of a restricted agent's context routes with that agent's classification (local_private stays local)
      router: condenserPrivacyFloor(router, agentClassification({ controlStore: new ControlStore(db), agents, roles })), catalog,
      snapshots, snapshotBuilder, freshness, resolvers, workingContext: createWorkingContextManager(), retrieverFactory: cachedRetrievers(logger, { embedder: vectorEmbedder, sharedIndex: pgVectorProbe(db, vectorEmbedder, logger), ...(restrictedEmbedder ? { restrictedEmbedder } : {}) }, parserHelperDir), memory, provenance,
      // (B[0]/B[1]/B[2]/B[7]) prompt deliveries are pinned in the observation log; record tools' freshness passes; published skills
      observations, freshnessPasses, skills: withTrialSkills(skillRegistry, (config.skills?.trial ?? []) as SkillRevision[]),
      toolRuntime, registry, workspaces, environments,
      sessions, agents, epochs, engines, subagents, runner, roles,
      config: controlConfig,
      // A[6]: context-assembly hooks of kernel plugins
      ...(plugins.contextHooks().length > 0 ? { contextHooks: plugins.contextHooks() } : {}),
    };
    // the manifest pins the complete tool catalog: built-in + domain tools
    for (const spec of createDomainTools(deps)) if (!registry.get(spec.id)) registry.register(spec);
    // A[6]: plugin tools join the one registry (the same capability check, permit, freshness, ledger and evidence
    // pipeline) only now: a plugin tool reusing a built-in or domain tool id (e.g. complete_work) is refused, never a shadow
    for (const t of plugins.tools()) {
      if (registry.get(t.id)) {
        const owner = plugins.capabilities.owner(`tool:${t.id}`) ?? 'a plugin';
        throw new HypertestError('conflict', `plugin ${owner}: tool ${t.id} is already a built-in or domain tool; a plugin may not replace a governed tool`, { details: { toolId: t.id, pluginId: owner } });
      }
      // (B[1]) a plugin tool with a record effect is freshness-checked like the domain tools (the runtime checks the others)
      registry.register(freshnessChecked(deps, t));
    }
    const engineAdapters = [{ provider: 'engine:native', package: '@hypertest/runtime', version: RUNTIME_PACKAGE_VERSION }];
    if (engines.has('pi')) {
      engineAdapters.push({ provider: 'engine:pi', package: '@hypertest/runtime-pi', version: RUNTIME_PI_PACKAGE_VERSION });
      engineAdapters.push({ provider: 'engine:pi', package: '@earendil-works/pi-agent-core', version: PI_AGENT_CORE_VERSION });
    }
    if (engines.has('dsh')) {
      // the adapter and the whole pinned DSH train (the engine refuses to exist over any other installed version)
      engineAdapters.push({ provider: 'engine:dsh', package: '@hypertest/runtime-dsh', version: RUNTIME_DSH_PACKAGE_VERSION });
      for (const [pkg, version] of Object.entries(DSH_PINS)) engineAdapters.push({ provider: 'engine:dsh', package: pkg, version });
    }
    // runtime BOM: the installation (version, source digest, git commit, image digest) and each engine with its adapter
    const hypertestBom: RuntimeManifest['hypertest'] = { version: HYPERTEST_VERSION, sourceDigest: hypertestSourceDigest() };
    const gitSha = hypertestGitSha();
    if (gitSha) hypertestBom.gitSha = gitSha;
    if (imageDigest) hypertestBom.imageDigest = imageDigest;
    const engineAdapter: Record<string, { package: string; version: string }> = {
      native: { package: '@hypertest/runtime', version: RUNTIME_PACKAGE_VERSION },
      pi: { package: '@hypertest/runtime-pi', version: RUNTIME_PI_PACKAGE_VERSION },
      dsh: { package: '@hypertest/runtime-dsh', version: RUNTIME_DSH_PACKAGE_VERSION },
    };
    const manifest = buildRuntimeManifest(
      {
        hypertest: hypertestBom,
        agentEngines: engines.manifestEntries().map((e) => (Object.hasOwn(engineAdapter, e.kind) ? { ...e, adapter: engineAdapter[e.kind]! } : e)),
        defaultEngine: defaultEngineKind,
        providerAdapters: [...providers.adapters(), ...engineAdapters],
        modelCatalogRevision: catalog.revision,
        schemas: {
          event: lastId(collabMigrations),
          contextSnapshot: lastId(contextMigrations),
          tool: TOOL_SCHEMA_VERSION,
          operation: lastId(operationMigrations),
          evidence: lastId(evidenceMigrations),
        },
        // the governance bundle: policy rules (+ OPA) and the role catalog (tool policies, permission profiles, model policies)
        policyBundleRevision: `${policy.revision}+roles:${roles.revision()}`,
        roleCatalogRevision: roles.revision(),
        // every tool's schemas, effect, risk, timeout and side-effect binding + the adapters' capabilities
        toolCatalogRevision: toolCatalogRevision(registry.list(), adapters.list()),
        protocol: { id: protocol.binding.protocolId, version: protocol.binding.version, digest: protocol.binding.digest },
        ...(modelScores ? { modelScores } : {}),
        ...(plugins.plugins.length > 0 ? { plugins: plugins.manifestEntries() } : {}),
      },
      clock.isoNow(),
    );
    toolDeps.runtimeManifestId = manifest.manifestId;
    controlConfig.runtimeManifest = manifest;
    const plane = createControlPlane(deps);
    pending.push({ name: 'control', close: () => plane.close() });
    // I11: what the durable runtime drives (and what the facade exposes) never drives a live run of another manifest
    const pinned = pinnedControlPlane(plane, manifest.manifestId, {
      getRun: (id) => runs.get(id),
      runOf: async (id) => (await blackboard.getWorkItem(id))?.runId,
    });
    // runtime releases: new runs only under the active release (or a canary selecting them); quarantined runs stay paused
    const releaseRegistry = createRuntimeReleaseRegistry({ ...base, db });
    // the release service needs the durable runtime, which needs this control plane: bound once it exists (below)
    let releaseService: RuntimeReleaseService | undefined;
    const control = releaseGovernedControlPlane(pinned, {
      manifestId: manifest.manifestId,
      registry: releaseRegistry,
      requireActive: config.runtime?.requireActiveRelease === true,
      newRunId: () => ids.next('run'),
      getRun: (id) => runs.get(id),
      // a run admitted just before its release's rollback committed is quarantined by its creator
      afterCreate: (runId) => (releaseService ? releaseService.quarantineIfRolledBack(runId) : Promise.resolve(false)),
      // … and, should its creator have died before that re-check, by the first loop (or operator resume) that would drive it
      beforeDrive: (runId) => (releaseService ? releaseService.quarantineIfRolledBack(runId) : Promise.resolve(false)),
      // (F[1]) the loop that takes a migrated run over records it (run.migration_driven): a migration's drive is verified
      onDrive: async (runId) => {
        if (releaseService) await releaseService.markDriven(runId);
      },
    });
    relay.start();
    pending.push({ name: 'relay', close: () => relay.stop() });

    const durable = createDurable(config, {
      control,
      listRuns: () => runs.list({ status: NON_TERMINAL }),
      getRun: (id) => runs.get(id),
      // the token of a claim THIS worker holds (never another worker's: that would bypass fencing)
      resolveClaim: async (workItemId) => {
        const claim = (await blackboard.getWorkItem(workItemId))?.claim;
        return claim && claim.ownerId === workerId ? claim.fencingToken : undefined;
      },
      logger: logger.child({ component: 'durable' }),
    }, manifest.manifestId);
    pending.push({ name: 'durable', close: () => durable.shutdown() });

    const services: HypertestServices = {
      db, bus, relay, events, runs, blackboard, specs, decisions, operations: ledger, artifacts, evidence, signer, publicKeys: keys.publicKeys,
      policy, decisionLog, approvals, oracles, protocol, providers, catalog, router, memory, provenance, tools: registry, environments, roles, workerId, logger, clock, ids,
      adapters, toolRuntime, workspaces, plugins, skills: skillRegistry,
    };
    const releases = createReleaseService({
      db, registry: releaseRegistry, manifest, runs, events, blackboard, leases, ledger, reconciler, agents, control: plane, durable,
      forgetPin: (runId) => pinned.forgetPin(runId), clock, logger: logger.child({ component: 'releases' }),
      // (F[0]) shadow mirroring: decisions to compare, this instance's start (bound once `ht` exists), runtime.shadow
      decisions, startRun: (input) => ht.start(input), ...(config.runtime?.shadow ? { shadow: { ...config.runtime.shadow } } : {}),
      // (F[1]) Temporal: a migrated run's previous workflow on the SOURCE manifest's queue is handed over even without a
      // worker of the source runtime (served briefly by a worker whose control plane refuses exactly that run)
      ...(config.durable.kind === 'temporal'
        ? {
            handover: async ({ runId, fromManifestId, toManifestId }: { runId: string; fromManifestId: string; toManifestId: string }) => {
              const durableConfig = config.durable as Extract<HypertestConfig['durable'], { kind: 'temporal' }>;
              const options: TemporalDurableOptions = {
                control: handoverControlPlane(control, runId, toManifestId), listRuns: async () => [], address: durableConfig.address,
                taskQueue: manifestTaskQueue(durableConfig.taskQueue ?? DEFAULT_TEMPORAL_TASK_QUEUE, fromManifestId), logger: logger.child({ component: 'durable.handover', runId }),
              };
              if (durableConfig.namespace) options.namespace = durableConfig.namespace;
              const rt = new TemporalDurableRuntime(options);
              try {
                await rt.start();
              } catch (e) {
                await rt.shutdown().catch(() => undefined);
                throw e;
              }
              return { close: () => rt.shutdown() };
            },
          }
        : {}),
    });
    releaseService = releases;
    const ctx = (runId: string, actorId: string, correlationId = runId): EventContext => ({ runId, correlationId, actorId });

    /** Fail fast when the lead cannot be routed at all (a run would only fail its first work item). */
    async function preflight(): Promise<void> {
      const enabled = catalog.list().filter((p) => p.enabled);
      if (enabled.length === 0) {
        throw new HypertestError('precondition_failed', 'no model routes are configured (models.routes is empty or disabled): the lead agent cannot be routed; add a provider and a route to the configuration');
      }
      const lead = roles.get('lead');
      if (!lead) return;
      const request: RouteRequest = {
        runId: 'preflight', agentId: 'preflight', role: 'lead', taskType: lead.taskType, policy: lead.defaultModelPolicy, requiredCapabilities: [],
        actionRisk: 'low', dataClassification: lead.dataClassification, contextTokensEstimate: 1, contextSnapshotId: 'preflight',
      };
      const decision = await preflightRouter.route(request, ctx('preflight', 'system:preflight'));
      if (!decision.ok) {
        const why = decision.rejected.map((r) => `${r.routeId}: ${r.stage} — ${r.reason}`).join('; ');
        throw new HypertestError('precondition_failed', `no configured route can serve the lead role (${why}); adjust models.routes (capabilities, quality) or roles.lead.defaultModelPolicy`, {
          details: { rejected: decision.rejected },
        });
      }
    }

    /**
     * Best-effort wake of a live run after a human decision: the decision is already recorded (the run loop also polls),
     * so a failed signal is logged, never reported as a failed decision (a retry would find it decided).
     */
    async function wake(runId: string): Promise<void> {
      try {
        const run = await runs.get(runId);
        if (run && !isTerminalRun(run.status)) await durable.signal(runId, { type: 'wake' });
      } catch (e) {
        logger.warn('could not wake the run after a decision; its loop picks the decision up on its next tick', { runId, error: (e as Error).message });
      }
    }

    let closing: Promise<void> | undefined;
    const ht: HypertestInstance = {
      config,
      control,
      durable,
      manifest,
      services,
      releases,
      async start(runInput: StartRunInput): Promise<TestRun> {
        if (closing) throw new HypertestError('unavailable', 'this Hypertest instance is closed');
        const runId = runInput?.runId;
        if (runId !== undefined && (typeof runId !== 'string' || !RUN_ID_RE.test(runId) || runId.includes('..'))) {
          throw new HypertestError('invalid_argument', `runId must match ${RUN_ID_RE.source} (no '..'), got ${JSON.stringify(runId)}`);
        }
        const overrideErrors = validateRunOverrides({ budget: runInput?.budget, gate: runInput?.gate });
        if (overrideErrors.length > 0) throw new HypertestError('invalid_argument', `invalid run overrides:\n  - ${overrideErrors.join('\n  - ')}`, { details: { errors: overrideErrors } });
        await preflight();
        // conformance-1: a run without explicit oracles pins the configured ones (the gate's C0 needs an oracle in force)
        const pinnedOracles: StartRunInput = runInput && runInput.oracleIds === undefined && configuredOracleIds.length > 0 ? { ...runInput, oracleIds: [...configuredOracleIds] } : runInput;
        // (e2e[0]) a URL target becomes the environment serving it (refused before any run exists when nothing serves it)
        const input: StartRunInput = pinnedOracles?.target?.sutUrl !== undefined ? { ...pinnedOracles, target: resolveUrlTarget(pinnedOracles.target, environments) } : pinnedOracles;
        // startRun is idempotent for an existing runId: never drive a run created by another runtime (I11)
        const run = await control.startRun(input, { actorId: 'system:app' });
        if (run.runtimeManifestId !== manifest.manifestId && !isTerminalRun(run.status)) throw pinViolation(run, manifest.manifestId);
        try {
          await durable.startRun(run.runId);
        } catch (e) {
          const code = isHypertestError(e) ? e.code : 'unavailable';
          throw new HypertestError(code, `run ${run.runId} was created but its durable loop could not be started: ${(e as Error).message}; resumeIncomplete() (hypertest resume) drives it`, {
            cause: e,
            details: { runId: run.runId },
          });
        }
        return run;
      },
      async run(runInput: StartRunInput, options: { timeoutMs?: number } = {}): Promise<RunOutcome> {
        const run = await ht.start(runInput);
        return durable.awaitCompletion(run.runId, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {});
      },
      async resumeIncomplete(): Promise<string[]> {
        if (closing) throw new HypertestError('unavailable', 'this Hypertest instance is closed');
        // only runs pinned to THIS runtime's manifest (I11); the others wait for their own runtime (or a cancel)
        const resumable = await runs.list({ status: [...RESUMABLE_RUN_STATUSES] });
        const resumed: string[] = [];
        const foreign: Array<{ runId: string; runtimeManifestId: string }> = [];
        const quarantined: string[] = [];
        const undriven: Array<{ runId: string; problem: string }> = [];
        for (const run of resumable) {
          if (run.runtimeManifestId !== manifest.manifestId) {
            foreign.push({ runId: run.runId, runtimeManifestId: run.runtimeManifestId });
            continue;
          }
          // a live run of this runtime's rolled-back release that escaped the rollback's sweep (its creator died before
          // re-checking it) is quarantined, not resumed
          if (await releases.quarantineIfRolledBack(run.runId)) {
            quarantined.push(run.runId);
            continue;
          }
          // A[0]: an operator resume lets agents paused for model unavailability try their routes again now
          await control.releaseModelPauses?.(run.runId, 'operator:resume');
          await durable.startRun(run.runId);
          // (F[1], review) a run migrated onto this runtime and not driven yet is taken over verifiably, as by `resume`:
          // on Temporal its previous workflow may still be open on the source runtime's queue (startRun alone would be a
          // silent no-op). A run that was not taken over is not reported as resumed (the warning names the remedy).
          const drive = await releases.drive(run.runId);
          if (drive.needed && !drive.driven) {
            undriven.push({ runId: run.runId, problem: drive.problem ?? 'this runtime did not take the migrated run over' });
            continue;
          }
          resumed.push(run.runId);
        }
        if (undriven.length > 0) logger.warn('runs migrated to this runtime were not taken over (not resumed)', { manifestId: manifest.manifestId, runs: undriven });
        if (foreign.length > 0) logger.warn('incomplete runs pinned to another runtime manifest are not resumed by this runtime (I11)', { manifestId: manifest.manifestId, runs: foreign });
        if (quarantined.length > 0) logger.warn('incomplete runs of this rolled-back runtime release are quarantined, not resumed', { manifestId: manifest.manifestId, runs: quarantined });
        if (resumed.length > 0) logger.info('resumed incomplete runs', { runs: resumed });
        return resumed;
      },
      status: (runId) => runs.get(runId),
      async report(runId) {
        // the control plane's report + the run's runtime-release notes (quarantine, migrations)
        const report = await control.report(runId);
        const notes = runtimeReleaseNotes(await events.read(runId, { types: ['run.quarantined', 'run.migrated', 'run.migration_released', 'run.migration_driven'] }));
        return withRuntimeReleaseNotes(report, await runs.get(runId), notes);
      },
      async verifyEvidence(runId) {
        const run = await runs.get(runId);
        if (!run) throw new HypertestError('not_found', `run ${runId} not found`);
        const v = await evidence.verify(runId, { publicKeys: keys.publicKeys });
        const problems = v.problems.map((p) => `${p.kind}${p.evidenceId ? ` ${p.evidenceId}` : ''}${p.seq !== undefined ? ` (seq ${p.seq})` : ''}: ${p.detail}`);
        problems.push(...(await decisionProblems(run, { decisions, evidence, publicKeys: keys.publicKeys })));
        return { ok: problems.length === 0, problems };
      },
      async approve(approvalId, approve, actor, rationale) {
        const approval = await approvals.get(approvalId);
        if (!approval) throw new HypertestError('not_found', `approval ${approvalId} not found`);
        await approvals.decide(approvalId, approve, actor, rationale, ctx(approval.runId, `${actor.kind}:${actor.id}`, approvalId));
        // E[3] NEEDS_APPROVAL: a decided budget extension is applied now (approved ⇒ raised + resumed; rejected ⇒ resumed
        // to converge to the gate) — the run's loop applies it too (idempotent), this covers a run no loop drives now
        if (approval.kind === 'budget') {
          try {
            await control.resolveBudgetApproval?.(approval.runId);
          } catch (e) {
            logger.warn('could not apply the budget-extension decision now; the run applies it at its next tick', { runId: approval.runId, approvalId, error: (e as Error).message });
          }
        }
        // E[8] ApprovalSignal (it also wakes the run loop): the waiting work observes the decision now. A signal that could
        // not be delivered only delays it (the waits poll); a plain wake is tried instead.
        try {
          const run = await runs.get(approval.runId);
          if (run && !isTerminalRun(run.status)) await durable.signal(approval.runId, { type: 'approval', approvalId });
        } catch (e) {
          logger.warn('could not signal the approval decision; the waiting work observes it on its next poll', { runId: approval.runId, approvalId, error: (e as Error).message });
          await wake(approval.runId);
        }
      },
      async decideOracleProposal(proposalId, approve, actor, rationale) {
        const proposal = await specs.getOracleProposal(proposalId);
        if (!proposal) throw new HypertestError('not_found', `oracle change proposal ${proposalId} not found`);
        await oracles.decide(proposalId, approve, actor, rationale, ctx(proposal.runId, `${actor.kind}:${actor.id}`, proposalId));
        await wake(proposal.runId);
      },
      listRuns: (filter = {}) => runs.list(filter),
      events: (runId, options = {}) => events.read(runId, options),
      listApprovals: (filter = {}) => approvals.list(filter),
      async listOperations(filter = {}) {
        const status = filter.status && filter.status.length > 0 ? filter.status : (['manual_review'] as OperationStatus[]);
        if (filter.runId !== undefined) return ledger.list({ runId: filter.runId, status });
        if (!ledger.listByStatus) throw new HypertestError('unsupported', 'this operation ledger cannot list across runs');
        return ledger.listByStatus(status, filter.limit);
      },
      async resolveOperation(operationId, outcome, actor, note) {
        if (closing) throw new HypertestError('unavailable', 'this Hypertest instance is closed');
        if (actor?.kind !== 'human') throw new HypertestError('permission_denied', 'only a human resolves a manual review');
        if (!control.resolveOperation) throw new HypertestError('unsupported', 'this control plane cannot resolve operations');
        const resolved = await control.resolveOperation(operationId, outcome, actor.id, note);
        // the work waiting on the operation observes the resolution now (a lost wake only delays it: the waits poll)
        await wake(resolved.runId);
        return resolved;
      },
      async cancel(runId, reason) {
        const run = await runs.get(runId);
        if (!run) throw new HypertestError('not_found', `run ${runId} not found`);
        // a finished run keeps its outcome: report that instead of a silent no-op (cancelling a cancelled run is idempotent)
        if (run.status === 'completed' || run.status === 'failed') throw new HypertestError('conflict', `run ${runId} is already ${run.status}`, { details: { runId, status: run.status } });
        // cancelRun is idempotent: the control plane sweeps the work even when no loop of this process drives the run,
        // and the durable signal stops the loop that does
        await control.cancelRun(runId, reason);
        await durable.signal(runId, { type: 'cancel', reason });
      },
      async requestModelSwitch(runId, target, routeId, actor, reason) {
        if (!control.requestModelSwitch) throw new HypertestError('unsupported', 'this control plane cannot record model switches');
        if (actor?.kind !== 'human' || typeof actor.id !== 'string' || actor.id.trim() === '') throw new HypertestError('invalid_argument', 'a model switch is requested by a named human ({ kind: human, id })');
        const out = await control.requestModelSwitch(runId, target, routeId, `human:${actor.id}`, reason);
        await wake(runId);
        return out;
      },
      agents: (runId) => inspectAgents({ agents, engines, epochs }, runId),
      async resume(runId, options) {
        if (closing) throw new HypertestError('unavailable', 'this Hypertest instance is closed');
        const run = await runs.get(runId);
        if (!run) throw new HypertestError('not_found', `run ${runId} not found`);
        if (isTerminalRun(run.status)) throw new HypertestError('conflict', `run ${runId} is already ${run.status}`, { details: { runId, status: run.status } });
        if (run.runtimeManifestId !== manifest.manifestId) throw pinViolation(run, manifest.manifestId);
        if (options?.raise !== undefined) {
          // E[3] PAUSED_BUDGET: an operator raises the budget, then resumes (audited: budget.raised by human:<by>)
          const by = options.by?.trim();
          if (!by) throw new HypertestError('invalid_argument', 'a budget raise needs the name of the human who raises it (by)');
          if (!options.rationale?.trim()) throw new HypertestError('invalid_argument', 'a budget raise needs a rationale');
          if (!control.raiseBudget) throw new HypertestError('unsupported', 'this control plane cannot raise run budgets');
          await control.raiseBudget(runId, options.raise, by, options.rationale);
        }
        // a paused run is resumed FIRST, through the release-governed control plane: a quarantined or migrating run is
        // refused before anything changes (its model pauses stay as they are). That resume releases the run's model
        // pauses itself, so the pauses still waiting are listed before it to report what was released.
        const nowMs = clock.nowMs();
        const waitingBefore = run.status === 'paused' && epochs.listModelPauses ? (await epochs.listModelPauses(runId)).filter((p) => Date.parse(p.resumeAt) > nowMs).map((p) => p.sessionId) : [];
        if (run.status === 'paused') await control.resumeRun(runId);
        const releasedNow = (await control.releaseModelPauses?.(runId, 'operator:resume')) ?? [];
        const releasedPauses = [...new Set([...waitingBefore, ...releasedNow])].sort();
        await durable.startRun(runId);
        // (F[1]) a run migrated onto this runtime and not driven yet is taken over verifiably (on Temporal its previous
        // workflow may still be open on the source runtime's queue: startRun alone would be a silent no-op)
        const drive = await releases.drive(runId);
        if (drive.needed && !drive.driven) throw new HypertestError('unavailable', drive.problem ?? `run ${runId} was migrated here but this runtime did not take it over`, { details: { runId } });
        await wake(runId);
        return { releasedPauses };
      },
      close() {
        closing ??= closeAll();
        return closing;
      },
    };
    return ht;
  } catch (e) {
    await closeAll();
    throw e;
  }
}
