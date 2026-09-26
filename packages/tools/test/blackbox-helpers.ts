// Shared harness for the black-box tool tests (blackbox-*.test.ts). Not a test file itself.
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedClock, MemoryLogger, SequentialIdGenerator, noopLogger, systemClock, type Clock, type JsonValue, type SqlDatabase } from '@hypertest/core';
import { InMemoryEventSink, type ActionCapability, type EventContext, type EvidenceRecord, type PermissionProfile } from '@hypertest/domain';
import { MemoryArtifactStore, createEvidenceLedger, evidenceMigrations, type EvidenceLedger } from '@hypertest/evidence';
import {
  AdapterRegistry, createLeaseService, createOperationLedger, createSideEffectGateway, operationMigrations,
  type CompensationResult, type DispatchReceipt, type LeaseService, type ObservationResult, type OperationContext, type OperationLedger, type PreparedOperation, type RunSideEffectRequest, type SideEffectAdapter,
  type SideEffectGateway, type VerificationResult,
} from '@hypertest/operation';
import { BuiltinPolicyEngine, DEFAULT_POLICY_RULES, createPolicyDecisionLog, createRootCapability, policyMigrations, type ActionPermit, type PolicyDecisionLog, type PolicyEngine } from '@hypertest/policy';
import { createTestDatabase } from '@hypertest/store';
import {
  ToolRegistry, createEnvironmentRegistry, createToolRuntime, recordEffectAdapters,
  type EnvironmentDescriptor, type EnvironmentRegistry, type ToolContext, type ToolExecutionRequest, type ToolRuntime, type ToolSpec, type WorkspaceHandle,
} from '../src/index.ts';

export const SECRET = 'blackbox-test-capability-secret';
export const RUN = 'run_bb';
export const AGENT = 'agent_bb';
export const WORK = 'wi_bb';
export const FAR = '2099-01-01T00:00:00.000Z';

export const BLACKBOX_PROFILE: PermissionProfile = {
  name: 'blackbox_all',
  allowedEffects: ['read', 'record', 'write_workspace', 'execute', 'external', 'destructive'],
  maxRiskClass: 'critical',
  resourceScopes: ['env/**', 'url/**', 'loadgen/**', 'loadjob/**', 'browser/**', 'mcp/**', 'workspace/**'],
  environmentClasses: ['local', 'sandbox', 'staging', 'production'],
  credentialScopes: [],
};

export function capability(overrides: { profile?: PermissionProfile; tools?: string[] } = {}): ActionCapability {
  return createRootCapability(
    { runId: RUN, subjectAgentId: AGENT, workItemId: WORK, profile: overrides.profile ?? BLACKBOX_PROFILE, tools: overrides.tools ?? ['*'], expiresAt: FAR, capabilityId: 'cap_bb' },
    SECRET,
  );
}

export function eventContext(): EventContext {
  return { runId: RUN, correlationId: 'corr_bb', causationId: 'cause_bb', actorId: `agent:${AGENT}`, workItemId: WORK, agentId: AGENT };
}

export async function tempDir(prefix = 'ht-bb-'): Promise<{ path: string; cleanup(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

export const WORKSPACE: WorkspaceHandle = {
  workspaceId: 'ws_bb',
  kind: 'scratch',
  root: tmpdir(),
  readOnly: false,
  sandbox: { kind: 'local', network: 'loopback', envAllowlist: [] },
  resourcePrefix: 'workspace/ws_bb',
};

export interface BlackboxEnv {
  db: SqlDatabase;
  deps: { ids: SequentialIdGenerator; clock: Clock; logger: MemoryLogger };
  artifacts: MemoryArtifactStore;
  evidence: EvidenceLedger;
  events: InMemoryEventSink;
  decisionLog: PolicyDecisionLog;
  policy: PolicyEngine;
  environments: EnvironmentRegistry;
  dispose(): Promise<void>;
}

/** One migrated database (evidence + operation + policy) per test file. */
export async function openBlackboxEnv(options: { clock?: 'fixed' | 'system'; environments?: EnvironmentDescriptor[] } = {}): Promise<BlackboxEnv> {
  const { db, dispose } = await createTestDatabase({ migrations: [...evidenceMigrations, ...operationMigrations, ...policyMigrations] });
  const clock: Clock = options.clock === 'fixed' ? new FixedClock('2026-01-01T00:00:00.000Z') : systemClock;
  const deps = { ids: new SequentialIdGenerator(), clock, logger: new MemoryLogger() };
  const artifacts = new MemoryArtifactStore();
  const events = new InMemoryEventSink();
  const evidence = createEvidenceLedger({ ...deps, db, artifacts, events });
  const decisionLog = createPolicyDecisionLog({ ...deps, db, events });
  const policy = new BuiltinPolicyEngine(DEFAULT_POLICY_RULES, 'policy-bb-rev', { clock, capabilitySecret: SECRET, newId: () => deps.ids.next('pdec') });
  return { db, deps, artifacts, evidence, events, decisionLog, policy, environments: createEnvironmentRegistry(options.environments ?? []), dispose };
}

export interface GatewayBundle {
  gateway: SideEffectGateway;
  ledger: OperationLedger;
  leases: LeaseService;
}

/**
 * A gateway over a FRESH ledger instance (the gateway's in-process single-flight state is keyed by the
 * ledger instance, so a new bundle behaves like a restarted Hypertest process on the same database).
 */
export function newGateway(env: BlackboxEnv, adapters: SideEffectAdapter<any, any>[], extra: { pollIntervalMs?: number } = {}): GatewayBundle {
  const opDeps = { ...env.deps, db: env.db, events: env.events };
  const ledger = createOperationLedger(opDeps);
  const leases = createLeaseService(opDeps);
  // the record-only adapters are part of every realistic gateway (external effects without an adapter of their own)
  const gateway = createSideEffectGateway({ ...opDeps, ledger, leases, adapters: new AdapterRegistry([...adapters, ...recordEffectAdapters().filter((r) => !adapters.some((a) => a.adapterId === r.adapterId))]), pollIntervalMs: extra.pollIntervalMs ?? 20 });
  return { gateway, ledger, leases };
}

export function newRuntime(env: BlackboxEnv, specs: ToolSpec[], sideEffects?: SideEffectGateway): ToolRuntime {
  const deps: Parameters<typeof createToolRuntime>[0] = {
    ...env.deps,
    registry: new ToolRegistry(specs),
    policy: env.policy,
    decisionLog: env.decisionLog,
    artifacts: env.artifacts,
    evidence: env.evidence,
    events: env.events,
    environments: env.environments,
    runtimeManifestId: 'manifest_bb',
    workerId: 'worker_bb',
    capabilitySecret: SECRET,
  };
  if (sideEffects) deps.sideEffects = sideEffects;
  return createToolRuntime(deps);
}

let invocation = 0;
export function nextInvocationId(): string {
  return `sess_bb:1:call_${++invocation}_${process.pid}`;
}

export function toolRequest(toolId: string, input: unknown, overrides: Partial<ToolExecutionRequest> = {}): ToolExecutionRequest {
  return {
    toolId,
    input,
    invocationId: overrides.invocationId ?? nextInvocationId(),
    runId: RUN,
    workItemId: WORK,
    agentId: AGENT,
    role: 'executor',
    capability: capability(),
    workspace: WORKSPACE,
    eventContext: eventContext(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** The request the ToolRuntime builds for a side-effect-bound tool (for driving the gateway directly). */
export function sideEffectRequest<I>(spec: ToolSpec, input: I, environments: EnvironmentRegistry, invocationId: string, overrides: Partial<RunSideEffectRequest<I>> = {}): RunSideEffectRequest<I> {
  const binding = spec.sideEffect!;
  const target = binding.target(input, fakeContext({ environments }).ctx);
  return {
    runId: RUN,
    workItemId: WORK,
    agentId: AGENT,
    toolInvocationId: invocationId,
    operationType: binding.operationType,
    adapterId: binding.adapterId,
    input,
    target,
    lease: { resourceKey: target.resourceKey, ttlMs: 120_000, owner: AGENT },
    ctx: eventContext(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

export function allowPermit(constraints?: ActionPermit['constraints']): ActionPermit {
  const p: ActionPermit = { decision: 'allow', decisionId: 'pdec_test', reasons: [], policyRevision: 'policy-bb-rev' };
  if (constraints) p.constraints = constraints;
  return p;
}

export interface RecordedEvidence {
  record: EvidenceRecord;
  input: Parameters<ToolContext['recordEvidence']>[0];
}

/** A ToolContext for calling spec.execute directly; evidence goes to an in-memory list. */
export function fakeContext(options: { environments?: EnvironmentRegistry; permit?: ActionPermit; sideEffects?: SideEffectGateway; signal?: AbortSignal; invocationId?: string } = {}): { ctx: ToolContext; evidence: RecordedEvidence[] } {
  const evidence: RecordedEvidence[] = [];
  const artifacts = new MemoryArtifactStore();
  const ctx: ToolContext = {
    runId: RUN,
    workItemId: WORK,
    agentId: AGENT,
    role: 'executor',
    invocationId: options.invocationId ?? nextInvocationId(),
    workspace: WORKSPACE,
    artifacts,
    async recordEvidence(input) {
      const artifact = await artifacts.put(input.data, { mimeType: input.mimeType });
      const record = {
        evidenceId: `ev_fake_${evidence.length + 1}`,
        runId: RUN,
        seq: evidence.length + 1,
        evidenceType: input.evidenceType,
        artifact,
        summary: input.summary,
        producer: { workerId: 'worker_bb', runtimeManifestId: 'manifest_bb' },
        provenance: input.provenance ?? {},
        parentEvidenceIds: [],
        classification: 'internal',
        retentionPolicy: 'default',
        capturedAt: new Date().toISOString(),
        metadataHash: 'x',
        recordHash: 'y',
        ...(input.structured !== undefined ? { structured: input.structured } : {}),
        ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
      } as EvidenceRecord;
      evidence.push({ record, input });
      return record;
    },
    eventContext: eventContext(),
    permit: options.permit ?? allowPermit(),
    signal: options.signal ?? new AbortController().signal,
    logger: noopLogger,
    environments: options.environments ?? createEnvironmentRegistry(),
  };
  if (options.sideEffects) ctx.sideEffects = options.sideEffects;
  return { ctx, evidence };
}

export interface TestServer {
  url: string;
  port: number;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>;
  close(): Promise<void>;
}

/** Local HTTP server (loopback, ephemeral port) that records every request. */
export async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void | Promise<void>): Promise<TestServer> {
  const requests: TestServer['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      Promise.resolve(handler(req, res, body)).catch((e: unknown) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(e));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Polls `fn` until it returns a truthy value (or throws after timeoutMs). */
export async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 10_000, intervalMs = 50, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function structuredOf(r: { structured?: JsonValue }): Record<string, any> {
  return (r.structured ?? {}) as Record<string, any>;
}

/**
 * Wraps a SideEffectAdapter to simulate a caller that dies around dispatch: the real dispatch runs (or
 * not, with applyEffect=false), then the call never returns, so the ledger stays in `dispatching`.
 */
export class CrashAfterDispatch<I = unknown, O = unknown> implements SideEffectAdapter<I, O> {
  readonly adapterId: string;
  readonly capabilities: SideEffectAdapter['capabilities'];
  readonly inner: SideEffectAdapter<I, O>;
  readonly applyEffect: boolean;
  readonly reached: Promise<void>;
  readonly compensate?: (op: OperationContext) => Promise<CompensationResult>;
  dispatched = 0;
  #resolve!: () => void;
  constructor(inner: SideEffectAdapter<I, O>, applyEffect = true) {
    this.inner = inner;
    this.adapterId = inner.adapterId;
    this.capabilities = inner.capabilities;
    this.applyEffect = applyEffect;
    this.reached = new Promise((r) => (this.#resolve = r));
    if (inner.compensate) this.compensate = (op) => inner.compensate!(op);
  }
  prepare(op: OperationContext, input: I): Promise<PreparedOperation> {
    return this.inner.prepare(op, input);
  }
  async dispatch(prepared: PreparedOperation, op: OperationContext): Promise<DispatchReceipt> {
    this.dispatched++;
    if (this.applyEffect) await this.inner.dispatch(prepared, op);
    this.#resolve();
    return new Promise<DispatchReceipt>(() => undefined);
  }
  observe(op: OperationContext): Promise<ObservationResult<O>> {
    return this.inner.observe(op);
  }
  verify(o: O, h: string, op: OperationContext): Promise<VerificationResult> {
    return this.inner.verify(o, h, op);
  }
}
