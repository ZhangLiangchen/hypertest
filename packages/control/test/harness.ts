/**
 * Full-stack test harness for @hypertest/control: every lower package is real (PGlite or PostgreSQL via
 * createTestDatabase), models are ScriptedProvider brains keyed by the machine-readable header line of the
 * system prompt, tools are the real ToolRuntime with the built-in tools plus the control domain tools.
 */
import { MemoryLogger, SequentialIdGenerator, FixedClock, type EventBus, type JsonValue, type SqlDatabase } from '@hypertest/core';
import type { ChatMessage, EventContext, TestRun, WorkItem } from '@hypertest/domain';
import {
  collabMigrations, createBlackboard, createDecisionRepository, createEventStore, createInbox, createRunRepository, createSpecRepository,
} from '@hypertest/collab';
import {
  AdapterRegistry, createBudgetLedger, createLeaseService, createOperationLedger, createReconciler, createResourceAdmission, createSideEffectGateway,
  operationMigrations,
} from '@hypertest/operation';
import { Ed25519Signer, MemoryArtifactStore, createEvidenceLedger, evidenceMigrations } from '@hypertest/evidence';
import {
  BuiltinPolicyEngine, DEFAULT_POLICY_RULES, QualityGate, createApprovalService, createOracleGovernance, createPolicyDecisionLog, policyMigrations,
  resolveProtocolBinding,
} from '@hypertest/policy';
import { ModelCatalog, ProviderRegistry, ScriptedProvider, createModelRouter, type ModelCallRequest, type ModelCapabilityProfile, type ScriptedBrain, type ScriptedReply } from '@hypertest/model';
import {
  ExactSearch, contextMigrations, createExperienceStore, createFreshnessGuard, createProvenanceService, createResolverRegistry, createSnapshotBuilder,
  createSnapshotStore, createWorkingContextManager,
} from '@hypertest/context';
import { ToolRegistry, builtinTools, createEnvironmentRegistry, createLocalSandbox, createToolRuntime, createWorkspaceManager, recordEffectAdapters, type EnvironmentDescriptor, type ToolRuntimeDeps } from '@hypertest/tools';
import {
  EngineRegistry, NativeEngine, buildRuntimeManifest, createAgentRepository, createAgentRunner, createEpochManager, createSessionStore, createSubagentRuntime,
  runtimeMigrations,
} from '@hypertest/runtime';
import { BUILTIN_ROLES, RoleCatalog, type RoleCatalogLike } from '@hypertest/agents';
import { createTestDatabase } from '@hypertest/store';
import { tempDir } from '@hypertest/testkit';
import { controlMigrations, createControlPlane, createDomainTools, parseAgentHeader, type ControlConfig, type ControlDeps, type ControlPlaneInternals } from '../src/index.ts';

export const SECRET = 'control-test-capability-secret';
export const ALL_MIGRATIONS = [...collabMigrations, ...operationMigrations, ...evidenceMigrations, ...policyMigrations, ...contextMigrations, ...runtimeMigrations, ...controlMigrations];

const ALL_CAPS: ModelCapabilityProfile['capabilities'] = ['tool_use', 'parallel_tool_calls', 'structured_output', 'reasoning', 'long_context'];

export function route(routeId: string, provider: string, quality: Record<string, number>, overrides: Partial<ModelCapabilityProfile> = {}): ModelCapabilityProfile {
  return {
    routeId,
    provider,
    model: `${routeId}-model`,
    capabilities: ALL_CAPS,
    structuredOutput: 'native',
    reasoning: 'visible',
    contextWindow: 200_000,
    maxOutputTokens: 4096,
    continuationCompatibilityClass: `${provider}:${routeId}`,
    maxDataClassification: 'restricted',
    quality,
    toolReliability: 0.9,
    costPerMillionInputUsd: 1,
    costPerMillionOutputUsd: 2,
    typicalLatencyMs: 100,
    maxActionRisk: 'critical',
    enabled: true,
    ...overrides,
  };
}

/**
 * Three providers with role-steering quality maps: alpha (lead, analysts, test designer), beta (executor, rca),
 * gamma (reviewer: independent of the producers' providers).
 */
export function defaultCatalog(): ModelCapabilityProfile[] {
  return [
    route('alpha-large', 'alpha', { default: 0.9 }),
    route('beta-exec', 'beta', { default: 0.8, executor: 0.95, rca: 0.95 }),
    route('gamma-review', 'gamma', { default: 0.78, reviewer: 0.99 }),
  ];
}

// ------------------------------------------------------------------------------------------------ brains

/** What a scripted brain sees of one model request. */
export interface BrainView {
  role: string;
  workItemId: string;
  kind: string;
  runId: string;
  system: string;
  request: ModelCallRequest;
  /** Assistant turns already in the transcript (0 on the first turn). */
  step: number;
  /** Tool results in order. */
  toolResults: Array<{ name: string; content: string; isError: boolean }>;
  lastResult?: { name: string; content: string; isError: boolean };
  /** Every user message text (task message, queued inputs, context). */
  userText: string;
  toolNames: string[];
}

export type RoleBrain = (view: BrainView) => ScriptedReply | Promise<ScriptedReply>;

export function viewOf(request: ModelCallRequest): BrainView {
  const system = request.messages[0]?.role === 'system' ? request.messages[0].content : '';
  const header = parseAgentHeader(system);
  if (!header) throw new Error(`request without a hypertest header: ${system.slice(0, 120)}`);
  const toolResults = request.messages.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool').map((m) => ({ name: m.toolName, content: m.content, isError: m.isError === true }));
  const userText = request.messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')))
    .join('\n');
  const view: BrainView = {
    ...header,
    system,
    request,
    step: request.messages.filter((m) => m.role === 'assistant').length,
    toolResults,
    userText,
    toolNames: (request.tools ?? []).map((t) => t.name),
  };
  const last = toolResults[toolResults.length - 1];
  if (last) view.lastResult = last;
  return view;
}

/** One brain for every provider: dispatches on the header's role. Unknown roles fail their work (never hang). */
export function roleRouter(brains: Record<string, RoleBrain>, calls?: BrainView[]): ScriptedBrain {
  return (request) => {
    const view = viewOf(request);
    calls?.push(view);
    const brain = brains[view.role];
    if (!brain) return { toolCalls: [{ name: 'fail_work', arguments: { reason: 'no_brain', message: `no scripted brain for role ${view.role}` } }] };
    return brain(view);
  };
}

export function call(name: string, args: JsonValue): ScriptedReply {
  return { toolCalls: [{ name: name.replaceAll('.', '__'), arguments: args }] };
}

export function evidenceIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\bev_[0-9A-Za-z]+\b/g)].map((m) => m[0]))];
}

export function recordIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\brec_[0-9A-Za-z]+\b/g)].map((m) => m[0]))];
}

export function parsed(content: string): Record<string, unknown> {
  const i = content.indexOf('{');
  if (i < 0) return {};
  const body = content.slice(i).split('\n[evidence:')[0]!;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------------------------------------ harness

export interface HarnessOptions {
  brains?: Record<string, RoleBrain>;
  catalog?: ModelCapabilityProfile[];
  config?: Partial<ControlConfig>;
  roles?: RoleCatalogLike;
  environments?: EnvironmentDescriptor[];
  signer?: boolean;
  start?: string;
  bus?: EventBus;
  /** Database kind (default: HYPERTEST_TEST_DB, else PGlite). */
  dbKind?: 'pglite' | 'postgres';
}

export interface Harness {
  db: SqlDatabase;
  deps: ControlDeps;
  control: ControlPlaneInternals;
  clock: FixedClock;
  ids: SequentialIdGenerator;
  logger: MemoryLogger;
  providers: Record<string, ScriptedProvider>;
  calls: BrainView[];
  ctx(runId: string): EventContext;
  dispose(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { db, dispose: disposeDb } = await createTestDatabase(options.dbKind ? { kind: options.dbKind, migrations: ALL_MIGRATIONS } : { migrations: ALL_MIGRATIONS });
  const dir = await tempDir('ht-control-ws-');
  const clock = new FixedClock(options.start ?? '2026-09-01T00:00:00.000Z');
  const ids = new SequentialIdGenerator();
  const logger = new MemoryLogger();
  const base = { ids, clock, logger };
  const events = createEventStore({ ...base, db });
  const blackboard = createBlackboard({ ...base, db, events });
  const runs = createRunRepository({ ...base, db, events });
  const specs = createSpecRepository({ ...base, db, events });
  const decisions = createDecisionRepository({ ...base, db, events });
  const inbox = createInbox({ ...base, db });
  const ledger = createOperationLedger({ ...base, db, events });
  const leases = createLeaseService({ ...base, db, events });
  // the record-only adapters are part of every realistic gateway: external effects without an adapter of their own
  // (http.request POST, browser clicks, MCP calls) run through the ledger with them
  const adapters = new AdapterRegistry(recordEffectAdapters());
  const gateway = createSideEffectGateway({ ...base, db, events, ledger, leases, adapters, pollIntervalMs: 5 });
  const reconciler = createReconciler({ ...base, db, events, ledger, leases, adapters, pollIntervalMs: 5 });
  const admission = createResourceAdmission({ ...base, db, events });
  const budget = createBudgetLedger({ ...base, db, events });
  const artifacts = new MemoryArtifactStore();
  const signer = options.signer === false ? undefined : Ed25519Signer.generate();
  const evidence = createEvidenceLedger(signer ? { ...base, db, artifacts, events, signer } : { ...base, db, artifacts, events });
  const policy = new BuiltinPolicyEngine(DEFAULT_POLICY_RULES, 'policy-rev-1', { clock, capabilitySecret: SECRET, newId: () => ids.next('pdec') });
  const decisionLog = createPolicyDecisionLog({ ...base, db, events });
  const approvals = createApprovalService({ ...base, db, events });
  const oracles = createOracleGovernance({ ...base, store: specs, decisions, events });
  const protocol = await resolveProtocolBinding({});
  const calls: BrainView[] = [];
  const brain = roleRouter(options.brains ?? {}, calls);
  const profiles = options.catalog ?? defaultCatalog();
  const providerIds = [...new Set(profiles.map((p) => p.provider))];
  const providers: Record<string, ScriptedProvider> = {};
  for (const id of providerIds) providers[id] = new ScriptedProvider({ providerId: id, brain });
  const providerRegistry = new ProviderRegistry(Object.values(providers));
  const catalog = new ModelCatalog(profiles);
  const router = createModelRouter({ ...base, catalog, providers: providerRegistry, events, retry: { baseDelayMs: 1, maxDelayMs: 2 } });
  const snapshots = createSnapshotStore({ ...base, db, events });
  const resolvers = createResolverRegistry();
  const freshness = createFreshnessGuard({ ...base, db, events, snapshots, resolvers });
  const snapshotBuilder = createSnapshotBuilder({
    ...base,
    db,
    events,
    snapshots,
    resolvers,
    sources: {
      getRun: (runId) => runs.get(runId),
      lastEventSeq: (runId) => events.lastSeq(runId),
      blackboardRevision: (runId) => blackboard.revision(runId),
      evidenceRoot: (runId) => evidence.rootHash(runId),
      experimentRevisions: async (runId) => Object.fromEntries((await specs.listExperiments(runId)).map((e) => [e.experimentId, e.revision])),
    },
  });
  const memory = createExperienceStore({ ...base, db, events });
  const provenance = createProvenanceService({ evidence, events, records: blackboard });
  const environments = createEnvironmentRegistry(options.environments ?? []);
  const workspaces = createWorkspaceManager({ ...base, baseDir: dir.path, defaultSandbox: { kind: 'local', network: 'none', envAllowlist: [] } });
  const sandbox = createLocalSandbox();
  const registry = new ToolRegistry(builtinTools({ sandbox, workspaces }));
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
    workerId: 'worker-1',
    capabilitySecret: SECRET,
  };
  const toolRuntime = createToolRuntime(toolDeps);
  const sessions = createSessionStore({ ...base, db, events });
  const agents = createAgentRepository({ ...base, db, events });
  const epochs = createEpochManager({ ...base, db, events, sessions });
  const engines = new EngineRegistry([new NativeEngine({ ...base, sessions, events })]);
  const subagents = createSubagentRuntime({ ...base, db, events, agents, sessions, engines, defaultEngineKind: 'native', maxAgentsPerRun: 100, capabilitySecret: SECRET });
  const runner = createAgentRunner({ ...base, db, events, agents, sessions, engines, subagents });
  const roles = options.roles ?? new RoleCatalog(BUILTIN_ROLES);

  const config: ControlConfig = {
    capabilitySecret: SECRET,
    runtimeManifest: { manifestId: 'rm_pending' } as ControlConfig['runtimeManifest'],
    workerId: 'worker-1',
    defaultEngineKind: 'native',
    ...options.config,
  };
  const deps: ControlDeps = {
    ...base,
    db,
    events,
    blackboard,
    runs,
    specs,
    decisions,
    inbox,
    ledger,
    leases,
    gateway,
    reconciler,
    admission,
    budget,
    adapters,
    artifacts,
    evidence,
    policy,
    decisionLog,
    approvals,
    oracles,
    gate: new QualityGate(),
    protocol,
    router,
    catalog,
    snapshots,
    snapshotBuilder,
    freshness,
    resolvers,
    workingContext: createWorkingContextManager(),
    retrieverFactory: (root) => new ExactSearch({ root, ripgrep: false }),
    memory,
    provenance,
    toolRuntime,
    registry,
    workspaces,
    environments,
    sessions,
    agents,
    epochs,
    engines,
    subagents,
    runner,
    roles,
    config,
  };
  if (signer) deps.signer = signer;
  if (options.bus) deps.bus = options.bus;
  // the manifest pins the complete tool catalog (built-in + domain tools)
  for (const spec of createDomainTools(deps)) registry.register(spec);
  const manifest = buildRuntimeManifest(
    {
      hypertest: { version: '0.3.0-dev' },
      agentEngines: engines.manifestEntries(),
      providerAdapters: providerRegistry.adapters(),
      modelCatalogRevision: catalog.revision,
      schemas: { event: '1', contextSnapshot: '1', tool: '1', operation: '1', evidence: '1' },
      policyBundleRevision: policy.revision,
      toolCatalogRevision: registry.revision(),
    },
    clock.isoNow(),
  );
  toolDeps.runtimeManifestId = manifest.manifestId;
  config.runtimeManifest = manifest;
  const control = createControlPlane(deps);
  return {
    db,
    deps,
    control,
    clock,
    ids,
    logger,
    providers,
    calls,
    ctx: (runId) => ({ runId, correlationId: runId, actorId: 'system:test' }),
    async dispose() {
      await control.close();
      await disposeDb();
      await dir.cleanup();
    },
  };
}

// ------------------------------------------------------------------------------------------------ driver

export interface DriveResult {
  ticks: Array<Awaited<ReturnType<ControlPlaneInternals['tick']>>>;
  final?: Awaited<ReturnType<ControlPlaneInternals['tick']>>;
  outcomes: Array<{ workItemId: string; status: string }>;
}

/** Runs one dispatched item until it leaves `continue` (completed/failed/waiting/…). */
export async function runItem(control: ControlPlaneInternals, workItemId: string, fencingToken: number, maxTurns = 40): Promise<string> {
  for (let i = 0; i < maxTurns; i++) {
    const o = await control.executeTurn(workItemId, fencingToken);
    if (o.status !== 'continue') return o.status;
  }
  throw new Error(`work item ${workItemId} did not finish within ${maxTurns} turns`);
}

/** Simple in-test durable loop: tick → executeTurn until terminal → observeWaiting. */
export async function drive(h: Harness, runId: string, maxTicks = 60): Promise<DriveResult> {
  const out: DriveResult = { ticks: [], outcomes: [] };
  for (let i = 0; i < maxTicks; i++) {
    const t = await h.control.tick(runId);
    out.ticks.push(t);
    if (t.final) {
      out.final = t;
      return out;
    }
    for (const d of t.dispatched) out.outcomes.push({ workItemId: d.workItemId, status: await runItem(h.control, d.workItemId, d.fencingToken) });
    for (const w of t.waiting) {
      const o = await h.control.observeWaiting(w.workItemId);
      if (o.status === 'continue') {
        const item = (await h.deps.blackboard.getWorkItem(w.workItemId)) as WorkItem;
        out.outcomes.push({ workItemId: w.workItemId, status: await runItem(h.control, w.workItemId, item.claim!.fencingToken) });
      }
    }
    if (t.dispatched.length === 0 && t.waiting.length === 0 && t.convergence.state === 'active' && t.idleMs > 0 && i > maxTicks / 2) break;
  }
  return out;
}

export async function items(h: Harness, runId: string): Promise<WorkItem[]> {
  return h.deps.blackboard.listWorkItems({ runId });
}

export async function mustRun(h: Harness, runId: string): Promise<TestRun> {
  const r = await h.deps.runs.get(runId);
  if (!r) throw new Error(`run ${runId} missing`);
  return r;
}

