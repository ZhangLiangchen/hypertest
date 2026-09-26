import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashCanonical, type SqlDatabase } from '@hypertest/core';
import { InMemoryEventSink, type ActionCapability, type ContextSnapshot, type EventContext, type PermissionProfile } from '@hypertest/domain';
import { MemoryArtifactStore, createEvidenceLedger, evidenceMigrations, type EvidenceLedger } from '@hypertest/evidence';
import {
  AdapterRegistry, createLeaseService, createOperationLedger, createSideEffectGateway, operationMigrations,
  type DispatchReceipt, type ObservationResult, type OperationContext, type PreparedOperation, type SideEffectAdapter, type SideEffectCapabilities, type SideEffectGateway, type VerificationResult,
} from '@hypertest/operation';
import { BuiltinPolicyEngine, DEFAULT_POLICY_RULES, createPolicyDecisionLog, createRootCapability, policyMigrations, type PolicyDecisionLog, type PolicyEngine } from '@hypertest/policy';
import { createTestDatabase } from '@hypertest/store';
import { testDeps } from '@hypertest/testkit';
import {
  ToolRegistry, createEnvironmentRegistry, createLocalSandbox, createToolRuntime, createWorkspaceManager, recordEffectAdapters,
  type EnvironmentRegistry, type FreshnessPort, type SandboxProfile, type SandboxRunner, type ToolExecutionRequest, type ToolRuntime, type ToolSpec, type WorkspaceHandle, type WorkspaceManager,
} from '../src/index.ts';

export const SECRET = 'tools-test-capability-secret';
export const RUN = 'run_tools';
export const AGENT = 'agent_exec';
export const WORK = 'wi_1';
export const FAR = '2099-01-01T00:00:00.000Z';

export const SANDBOX: SandboxProfile = { kind: 'local', network: 'none', envAllowlist: [] };

export const ALL_EFFECTS_PROFILE: PermissionProfile = {
  name: 'test_all',
  allowedEffects: ['read', 'record', 'write_workspace', 'execute', 'external', 'destructive'],
  maxRiskClass: 'high',
  resourceScopes: ['workspace/**', 'run/**', 'env/**', 'loadgen/**'],
  environmentClasses: ['local', 'sandbox'],
  credentialScopes: [],
};

export function capability(overrides: { profile?: PermissionProfile; tools?: string[]; agentId?: string; workItemId?: string; runId?: string } = {}): ActionCapability {
  return createRootCapability(
    {
      runId: overrides.runId ?? RUN,
      subjectAgentId: overrides.agentId ?? AGENT,
      workItemId: overrides.workItemId ?? WORK,
      profile: overrides.profile ?? ALL_EFFECTS_PROFILE,
      tools: overrides.tools ?? ['*'],
      expiresAt: FAR,
      capabilityId: 'cap_test',
    },
    SECRET,
  );
}

export function eventContext(): EventContext {
  return { runId: RUN, correlationId: 'corr_1', causationId: 'cause_1', actorId: `agent:${AGENT}`, workItemId: WORK, agentId: AGENT };
}

export async function tempDir(prefix = 'ht-tools-'): Promise<{ path: string; cleanup(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

export interface ToolEnv {
  db: SqlDatabase;
  deps: ReturnType<typeof testDeps>;
  artifacts: MemoryArtifactStore;
  evidence: EvidenceLedger;
  events: InMemoryEventSink;
  decisionLog: PolicyDecisionLog;
  policy: PolicyEngine;
  environments: EnvironmentRegistry;
  sandbox: SandboxRunner;
  workspaces: WorkspaceManager;
  baseDir: string;
  dispose(): Promise<void>;
}

/** One migrated database per test file (evidence + operation + policy tables). */
export async function openToolEnv(): Promise<ToolEnv> {
  const { db, dispose } = await createTestDatabase({ migrations: [...evidenceMigrations, ...operationMigrations, ...policyMigrations] });
  const deps = testDeps();
  const artifacts = new MemoryArtifactStore();
  const events = new InMemoryEventSink();
  const evidence = createEvidenceLedger({ ...deps, db, artifacts, events });
  const decisionLog = createPolicyDecisionLog({ ...deps, db, events });
  const policy = new BuiltinPolicyEngine(DEFAULT_POLICY_RULES, 'policy-test-rev', { clock: deps.clock, capabilitySecret: SECRET, newId: () => deps.ids.next('pdec') });
  const base = await tempDir('ht-tools-ws-');
  return {
    db,
    deps,
    artifacts,
    evidence,
    events,
    decisionLog,
    policy,
    environments: createEnvironmentRegistry([{ environmentId: 'env_local', environmentClass: 'local', generation: 1 }]),
    sandbox: createLocalSandbox({ killGraceMs: 300 }),
    workspaces: createWorkspaceManager({ ...deps, baseDir: base.path, defaultSandbox: SANDBOX }),
    baseDir: base.path,
    dispose: async () => {
      await base.cleanup();
      await dispose();
    },
  };
}

export function runtimeFor(env: ToolEnv, specs: ToolSpec[], extra: { freshness?: FreshnessPort; sideEffects?: SideEffectGateway; policy?: PolicyEngine; decisionLog?: PolicyDecisionLog | null } = {}): ToolRuntime {
  const registry = new ToolRegistry(specs);
  const deps: Parameters<typeof createToolRuntime>[0] = {
    ...env.deps,
    registry,
    policy: extra.policy ?? env.policy,
    artifacts: env.artifacts,
    evidence: env.evidence,
    events: env.events,
    environments: env.environments,
    runtimeManifestId: 'manifest_test',
    workerId: 'worker_test',
    capabilitySecret: SECRET,
  };
  if (extra.decisionLog !== null) deps.decisionLog = extra.decisionLog ?? env.decisionLog;
  if (extra.freshness) deps.freshness = extra.freshness;
  if (extra.sideEffects) deps.sideEffects = extra.sideEffects;
  return createToolRuntime(deps);
}

let invocation = 0;
export function request(toolId: string, input: unknown, workspace: WorkspaceHandle, overrides: Partial<ToolExecutionRequest> = {}): ToolExecutionRequest {
  return {
    toolId,
    input,
    invocationId: overrides.invocationId ?? `sess_1:1:call_${++invocation}`,
    runId: RUN,
    workItemId: WORK,
    agentId: AGENT,
    role: 'executor',
    capability: capability(),
    workspace,
    eventContext: eventContext(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

export function snapshot(): ContextSnapshot {
  return {
    snapshotId: 'snap_1',
    runId: RUN,
    eventSeq: 1,
    blackboardRevision: 1,
    planRevision: 1,
    runtimeManifestId: 'manifest_test',
    oracleRevisions: {},
    experimentRevisions: {},
    policyRevision: 'policy-test-rev',
    evidenceRootHash: '0'.repeat(64),
    readSet: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

// ----------------------------------------------------------------------------- side effects

/** A fake external system: counts every externally applied effect; jobs are labelled by operation id. */
export class FakeExternal {
  readonly jobs = new Map<string, { jobId: string; name: string; desiredStateHash: string }>();
  applied = 0;
}

const CAPS: SideEffectCapabilities = {
  supportsNativeIdempotency: false,
  supportsExternalLookupByOperationId: true,
  supportsFencing: true,
  supportsCompensation: false,
  reconciliationClass: 'deterministic',
  riskClass: 'medium',
};

export class FakeLoadAdapter implements SideEffectAdapter<{ name: string }, { jobId: string; name: string; desiredStateHash: string }> {
  readonly adapterId = 'fake.load';
  readonly capabilities = CAPS;
  readonly external = new FakeExternal();
  readonly calls = { prepare: 0, dispatch: 0, observe: 0, verify: 0 };
  /** When true, verification reports `pending` (a long-running job). */
  verifyPending = false;
  /** When true, the target rejects the dispatch (definitely not applied). */
  rejectDispatch = false;
  /** When true, dispatch never answers (a lost response / hung target); only an abort ends the call. */
  hangDispatch = false;
  async prepare(op: OperationContext, input: { name: string }): Promise<PreparedOperation> {
    this.calls.prepare++;
    return { desiredState: { name: input.name, label: op.operation.operationId }, desiredStateHash: hashCanonical({ name: input.name }), target: { resourceKey: `loadgen/${input.name}`, kind: 'load_job' } };
  }
  async dispatch(prepared: PreparedOperation, op: OperationContext): Promise<DispatchReceipt> {
    this.calls.dispatch++;
    if (this.hangDispatch) return new Promise<DispatchReceipt>(() => undefined);
    if (this.rejectDispatch) return { accepted: false, notAppliedReason: 'quota exceeded' };
    this.external.applied++;
    const jobId = `job-${this.external.applied}`;
    this.external.jobs.set(op.operation.operationId, { jobId, name: (prepared.desiredState as { name: string }).name, desiredStateHash: prepared.desiredStateHash });
    return { accepted: true, externalJobId: jobId, receipt: `rcpt-${jobId}` };
  }
  async observe(op: OperationContext): Promise<ObservationResult<{ jobId: string; name: string; desiredStateHash: string }>> {
    this.calls.observe++;
    const job = this.external.jobs.get(op.operation.operationId);
    return job ? { state: 'present', observation: job } : { state: 'absent' };
  }
  async verify(observation: { jobId: string; name: string; desiredStateHash: string }, desiredStateHash: string): Promise<VerificationResult> {
    this.calls.verify++;
    if (this.verifyPending) return { status: 'pending', progress: { percent: 40 } };
    return observation.desiredStateHash === desiredStateHash ? { status: 'verified', result: { jobId: observation.jobId, name: observation.name } } : { status: 'failed', reason: 'hash mismatch' };
  }
}

export function gatewayFor(env: ToolEnv, adapters: SideEffectAdapter<any, any>[]): SideEffectGateway {
  const opDeps = { ...env.deps, db: env.db, events: env.events };
  const ledger = createOperationLedger(opDeps);
  // the record-only adapters are part of every realistic gateway (external effects without an adapter of their own)
  return createSideEffectGateway({ ...opDeps, ledger, leases: createLeaseService(opDeps), adapters: new AdapterRegistry([...adapters, ...recordEffectAdapters().filter((r) => !adapters.some((a) => a.adapterId === r.adapterId))]), pollIntervalMs: 5 });
}

/** True when the process exists and is not a zombie (killed orphans may stay unreaped when PID 1 does not reap). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return true;
  }
}

/**
 * Live (non-zombie) processes of this host whose command line contains `marker` — how a test finds processes a
 * sandboxed command started: inside the sandbox's PID namespace their pids are namespace-local and mean nothing here.
 */
export function liveProcessesWithMarker(marker: string): number[] {
  const out: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(marker) && isProcessAlive(Number(entry))) out.push(Number(entry));
    } catch {
      // gone meanwhile
    }
  }
  return out;
}
