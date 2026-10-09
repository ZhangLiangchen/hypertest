import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HypertestError, hashCanonical, type Logger } from '@hypertest/core';
import type { DispatchReceipt, ObservationResult, OperationContext, PreparedOperation, SideEffectAdapter, SideEffectCapabilities, VerificationResult } from '@hypertest/operation';
import type { EnvironmentDescriptor, EnvironmentRegistry } from '../contracts.ts';
import { CONTROL_TOKEN_HEADER, errorMessage, publicControlTarget, requireEnvironment, runCommand, splitControlTarget, type CommandResult } from './common.ts';
import { mintControlToken } from './secrets.ts';
import { FENCE_HEADER, OPERATION_HEADER, normalizeFault, type SupervisorFault, type SupervisorOperation } from './process-supervisor.ts';
import {
  beginFaultJob, dockerFaultPlan, faultJobDir, kubectlFaultPlan, markFaultAbandoned, markFaultApplied, markFaultNotApplied, overdueWithoutReverter, readFaultJob, revertOverdue, spawnReverter, unrevertedFaults, type FaultJobView, type FaultPlan,
} from './fault-injection.ts';
import type { FaultJobSpec } from './fault-worker.ts';

/**
 * Environment control adapters (restart / deploy / fault injection) as SideEffectAdapters. Operation
 * types: `env.restart`, `env.deploy`, `env.inject_fault`. After a VERIFIED restart or deploy the adapter
 * bumps the environment's generation in the EnvironmentRegistry (deploy also sets buildDigest), so context
 * snapshots that observed the old generation become stale (FreshnessGuard).
 */

export type EnvOperationType = 'env.restart' | 'env.deploy' | 'env.inject_fault';
export const ENV_OPERATION_TYPES: readonly EnvOperationType[] = ['env.restart', 'env.deploy', 'env.inject_fault'];

export interface EnvRestartInput {
  environmentId: string;
  reason?: string;
}
export interface EnvDeployInput {
  environmentId: string;
  buildRef: string;
}
export interface EnvFaultInput {
  environmentId: string;
  /**
   * process environments: `latency` | `error_rate` (the supervisor's proxy); (wave 3) docker: `pause` | `kill` |
   * `network_disconnect` | `netem`; kubectl: `pod_delete` | `scale_zero` | `network_deny` (fault-injection.ts).
   */
  kind: 'latency' | 'error_rate' | 'pause' | 'kill' | 'network_disconnect' | 'netem' | 'pod_delete' | 'scale_zero' | 'network_deny';
  params: Record<string, unknown>;
  durationMs: number;
}
export type EnvInput = EnvRestartInput | EnvDeployInput | EnvFaultInput;

export const BUILD_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;

function operationTypeOf(op: OperationContext): EnvOperationType {
  const t = op.operation.operationType;
  if (!(ENV_OPERATION_TYPES as readonly string[]).includes(t)) throw new HypertestError('invalid_argument', `unsupported environment operation ${t}`);
  return t as EnvOperationType;
}

/** The environment id of an env operation (its target is always `env/<environmentId>`). */
export function environmentIdOf(op: OperationContext): string {
  const key = op.operation.target.resourceKey;
  if (!key.startsWith('env/') || key.length <= 4) throw new HypertestError('invalid_argument', `environment operation ${op.operation.operationId} has target ${key}, expected env/<environmentId>`);
  return key.slice(4);
}

function requireControl(env: EnvironmentDescriptor, kind: 'process' | 'docker' | 'kubectl'): NonNullable<EnvironmentDescriptor['control']> {
  if (!env.control) throw new HypertestError('precondition_failed', `environment ${env.environmentId} has no control descriptor`);
  if (env.control.kind !== kind) throw new HypertestError('invalid_argument', `environment ${env.environmentId} is controlled by ${env.control.kind}, not ${kind}`);
  if (typeof env.control.target !== 'string' || env.control.target === '') throw new HypertestError('precondition_failed', `environment ${env.environmentId} control target is empty`);
  return env.control;
}

function requireBuildRef(input: EnvInput): string {
  const ref = (input as EnvDeployInput).buildRef;
  if (typeof ref !== 'string' || !BUILD_REF_RE.test(ref)) throw new HypertestError('invalid_argument', `buildRef must match ${BUILD_REF_RE.source}`);
  return ref;
}

/** The operation target (persisted in the ledger): never carries a control token. */
function envTarget(env: EnvironmentDescriptor): PreparedOperation['target'] {
  return { resourceKey: `env/${env.environmentId}`, kind: 'environment', externalId: env.control?.target !== undefined ? publicControlTarget(env.control.target) : env.environmentId };
}

/** `<control base>/<suffix>` (query and fragment of the control target dropped). */
function controlEndpoint(base: URL, suffix: string): URL {
  const u = new URL(base.href);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/${suffix}`;
  u.search = '';
  u.hash = '';
  return u;
}

/**
 * Bumps the environment generation once per verified operation (a re-verification — e.g. a duplicate
 * observe in this process — reuses the recorded bump instead of bumping twice). The operation id is handed to the
 * registry as well: a registry that remembers bumps by operation (the in-memory one per process; the app's persistent
 * one across processes) returns the recorded bump when ANOTHER adapter instance re-verifies the same operation — a
 * reconciliation after a crash between the bump and the ledger's `verified` never counts one restart twice.
 */
class GenerationBumper {
  readonly #done = new Map<string, EnvironmentDescriptor>();
  readonly #envs: EnvironmentRegistry;
  constructor(envs: EnvironmentRegistry) {
    this.#envs = envs;
  }
  /** A registry with a shared durable store (bumpGenerationAsync, e.g. the SQL registry) bumps atomically across processes. */
  async bump(operationId: string, environmentId: string, buildDigest?: string): Promise<EnvironmentDescriptor> {
    const prior = this.#done.get(operationId);
    if (prior) return prior;
    const next = typeof this.#envs.bumpGenerationAsync === 'function'
      ? await this.#envs.bumpGenerationAsync(environmentId, buildDigest, operationId)
      : this.#envs.bumpGeneration(environmentId, buildDigest, operationId);
    this.#done.set(operationId, next);
    return next;
  }
}

// ----------------------------------------------------------------------------- env.process

export interface ProcessEnvAdapterOptions {
  environments: EnvironmentRegistry;
  /** Timeout of a restart/deploy request (the supervisor answers once the child is ready). Default 60 s. */
  requestTimeoutMs?: number;
  logger?: Logger;
}

export type ProcessEnvObservation = SupervisorOperation;

/**
 * `env.process`: restart / deploy / fault injection of a local process behind a process supervisor
 * (see process-supervisor.ts). The supervisor records every request by `X-Hypertest-Operation`, so it is
 * natively idempotent and observable by operation id (`GET <target>/operations/<operationId>`).
 * Deploy = restart with `BUILD_REF=<buildRef>` (bumps buildDigest to the buildRef).
 * The control token (fragment of `control.target`) is read from the registry at dispatch time and sent as
 * `X-Hypertest-Control-Token`; it never enters the desired state (hash), the ledger target or a receipt.
 */
export class ProcessEnvAdapter implements SideEffectAdapter<EnvInput, ProcessEnvObservation> {
  readonly adapterId = 'env.process';
  readonly capabilities: SideEffectCapabilities = {
    supportsNativeIdempotency: true,
    supportsExternalLookupByOperationId: true,
    // E[0]: the supervisor is a fenced target (X-Hypertest-Fence: the gateway's lease token; stale ⇒ 412, not applied)
    supportsFencing: true,
    supportsCompensation: false,
    reconciliationClass: 'deterministic',
    riskClass: 'high',
  };
  readonly #o: ProcessEnvAdapterOptions;
  readonly #bumper: GenerationBumper;

  constructor(options: ProcessEnvAdapterOptions) {
    if (!options?.environments) throw new HypertestError('invalid_argument', 'ProcessEnvAdapter requires an environment registry');
    this.#o = options;
    this.#bumper = new GenerationBumper(options.environments);
  }

  async prepare(op: OperationContext, input: EnvInput): Promise<PreparedOperation> {
    const type = operationTypeOf(op);
    const env = requireEnvironment(this.#o.environments, input.environmentId);
    const control = requireControl(env, 'process');
    const target = splitControlTarget(control.target, `environment ${env.environmentId} control target`).url.href;
    let desiredState: Record<string, unknown>;
    if (type === 'env.restart') desiredState = { action: 'restart', environmentId: env.environmentId, target };
    else if (type === 'env.deploy') desiredState = { action: 'deploy', environmentId: env.environmentId, target, buildRef: requireBuildRef(input) };
    else {
      const f = input as EnvFaultInput;
      const fault = normalizeFault(f.kind, f.params);
      if (!(Number.isInteger(f.durationMs) && f.durationMs > 0 && f.durationMs <= 3_600_000)) throw new HypertestError('invalid_argument', 'durationMs must be an integer in [1, 3600000]');
      desiredState = { action: 'fault', environmentId: env.environmentId, target, fault, durationMs: f.durationMs };
    }
    return { desiredState, desiredStateHash: hashCanonical(desiredState), target: envTarget(env) };
  }

  /** The control token of the environment, only while its registered control target is still `publicTarget`. */
  #token(environmentId: string | undefined, publicTarget: string): string | undefined {
    const control = environmentId !== undefined ? this.#o.environments.get(environmentId)?.control : undefined;
    if (control?.kind !== 'process') return undefined;
    try {
      const { url, token } = splitControlTarget(control.target);
      return url.href === publicTarget ? token : undefined;
    } catch {
      return undefined;
    }
  }

  async dispatch(prepared: PreparedOperation, op: OperationContext): Promise<DispatchReceipt> {
    const s = prepared.desiredState as { action: string; environmentId?: string; target: string; buildRef?: string; fault?: SupervisorFault; durationMs?: number };
    const base = splitControlTarget(s.target).url;
    const isFault = s.action === 'fault';
    const body = isFault
      ? { kind: s.fault!.kind, params: s.fault!.params, durationMs: s.durationMs, desiredStateHash: prepared.desiredStateHash }
      : { kind: s.action === 'deploy' ? 'deploy' : 'restart', desiredStateHash: prepared.desiredStateHash, ...(s.buildRef !== undefined ? { buildRef: s.buildRef } : {}) };
    const signal = AbortSignal.any([op.signal, AbortSignal.timeout(this.#o.requestTimeoutMs ?? 60_000)]);
    const headers: Record<string, string> = { 'content-type': 'application/json', [OPERATION_HEADER]: op.operation.operationId };
    const token = this.#token(s.environmentId, base.href);
    // E[4]: the long-lived control token never goes over the wire — a short-lived token bound to THIS operation, signed
    // with it, does (the supervisor verifies signature, expiry and operation)
    if (token !== undefined) headers[CONTROL_TOKEN_HEADER] = mintControlToken(token, op.operation.operationId, Date.now());
    if (op.fencingToken !== undefined) headers[FENCE_HEADER] = String(op.fencingToken);
    let res: Response;
    try {
      res = await fetch(controlEndpoint(base, isFault ? 'faults' : 'restart'), { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      throw new HypertestError('unavailable', `supervisor ${base.href} unreachable: ${errorMessage(e)}`);
    }
    const text = await res.text();
    // Refused before acting (bad request, unknown endpoint, missing/invalid control token): definitively not applied.
    // 412: the supervisor refused a stale fencing token (another owner was granted the environment): nothing was done
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || res.status === 412 || res.status === 413 || res.status === 422) {
      return { accepted: false, notAppliedReason: `supervisor rejected the request (HTTP ${res.status}): ${text.slice(0, 500)}`, receipt: text.slice(0, 2000) };
    }
    if (res.status === 409) throw new HypertestError('conflict', `supervisor reports a conflicting operation ${op.operation.operationId}: ${text.slice(0, 500)}`);
    if (!res.ok) throw new HypertestError('unavailable', `supervisor answered HTTP ${res.status}: ${text.slice(0, 500)}`);
    let record: SupervisorOperation;
    try {
      record = JSON.parse(text) as SupervisorOperation;
    } catch {
      throw new HypertestError('unavailable', 'supervisor answered with a non-JSON body');
    }
    const receipt: DispatchReceipt = { accepted: true, receipt: text.slice(0, 4000) };
    const jobId = record.restartId ?? record.faultId;
    if (jobId !== undefined) receipt.externalJobId = jobId;
    return receipt;
  }

  async observe(op: OperationContext): Promise<ObservationResult<ProcessEnvObservation>> {
    const env = requireEnvironment(this.#o.environments, environmentIdOf(op));
    const control = requireControl(env, 'process');
    const url = controlEndpoint(splitControlTarget(control.target).url, `operations/${encodeURIComponent(op.operation.operationId)}`);
    const res = await fetch(url, { signal: AbortSignal.any([op.signal, AbortSignal.timeout(15_000)]) });
    const text = await res.text();
    if (res.status === 404) return { state: 'absent' };
    if (!res.ok) throw new HypertestError('unavailable', `supervisor lookup answered HTTP ${res.status}`);
    try {
      return { state: 'present', observation: JSON.parse(text) as SupervisorOperation };
    } catch {
      return { state: 'uncertain', detail: 'supervisor lookup returned a non-JSON body' };
    }
  }

  async verify(obs: ProcessEnvObservation, desiredStateHash: string, op: OperationContext): Promise<VerificationResult> {
    if (obs.desiredStateHash !== undefined && obs.desiredStateHash !== desiredStateHash) {
      return { status: 'failed', reason: `supervisor operation ${obs.operationId} records a different desired state` };
    }
    const environmentId = environmentIdOf(op);
    if (obs.kind === 'fault') {
      if (obs.state === 'active' || obs.state === 'expired' || obs.state === 'cleared') {
        const verified: VerificationResult = { status: 'verified', result: { environmentId, action: 'fault', faultId: obs.faultId ?? null, fault: obs.fault ?? null, expiresAt: obs.expiresAt ?? null, state: obs.state } };
        // E[1]: an active time-boxed fault holds its environment until it expires (the gateway keeps the lease)
        if (obs.state === 'active' && typeof obs.expiresAt === 'string' && Number.isFinite(Date.parse(obs.expiresAt))) verified.effectUntil = obs.expiresAt;
        return verified;
      }
      return { status: 'failed', reason: `fault operation in unexpected state ${obs.state}` };
    }
    if (obs.state === 'running') return { status: 'pending', progress: { state: 'running', restartId: obs.restartId } };
    if (obs.state === 'failed') return { status: 'failed', reason: `supervised ${obs.kind} failed: ${obs.error ?? 'unknown error'}` };
    if (obs.state !== 'completed') return { status: 'failed', reason: `restart in unexpected state ${obs.state}` };
    const bumped = await this.#bumper.bump(op.operation.operationId, environmentId, obs.kind === 'deploy' ? obs.buildRef : undefined);
    return {
      status: 'verified',
      result: {
        environmentId,
        action: obs.kind,
        restartId: obs.restartId ?? null,
        processGeneration: obs.generation ?? null,
        pid: obs.pid ?? null,
        generation: bumped.generation,
        ...(bumped.buildDigest !== undefined ? { buildDigest: bumped.buildDigest } : {}),
      },
    };
  }
}

// ----------------------------------------------------------------------------- (wave 3) container / cluster faults

/** The observation of a container/cluster fault operation (its job directory). */
export interface ContainerFaultObservation {
  kind: 'container_fault';
  fault: string;
  state: 'active' | 'reverted' | 'revert_failed';
  expiresAt: string;
  revertedAt?: string;
  revertedBy?: string;
  results?: Array<{ argv: string[]; exitCode: number | null; stderr: string }>;
}

function faultDuration(input: EnvFaultInput): number {
  if (!(Number.isInteger(input.durationMs) && input.durationMs > 0 && input.durationMs <= 3_600_000)) throw new HypertestError('invalid_argument', 'durationMs must be an integer in [1, 3600000]');
  return input.durationMs;
}

/** (review) Grace on top of the apply commands' timeout before a job without an apply outcome is treated as applied. */
const FAULT_SETTLE_GRACE_MS = 30_000;

/**
 * Applies a planned container/cluster fault for an operation: records the job (operation-id-labelled), starts the detached
 * reverter that ends it at expiry, then runs the apply commands. (review) The reverter is started FIRST: a process that
 * dies while — or right after — the apply runs never leaves the fault in place past its time box (the reverter reverts
 * a job without an apply outcome too). Only a definitive refusal (the command ran and exited non-zero, or could not be
 * started) is "not applied"; an apply that timed out or was aborted may have reached the daemon / API server: its
 * outcome is unknown (the gateway reconciles it; the reverter still ends the fault at expiry).
 */
async function applyFault(stateDir: string, op: OperationContext, environmentId: string, plan: FaultPlan, durationMs: number, run: (argv: string[]) => Promise<CommandResult>, commandTimeoutMs: number): Promise<DispatchReceipt> {
  const now = Date.now();
  const spec: FaultJobSpec = {
    operationId: op.operation.operationId, environmentId, kind: plan.kind, appliedAt: new Date(now).toISOString(), expiresAt: new Date(now + durationMs).toISOString(), revert: plan.revert,
    settleBy: new Date(now + plan.apply.length * commandTimeoutMs + FAULT_SETTLE_GRACE_MS).toISOString(),
  };
  const prior = readFaultJob(stateDir, spec.operationId);
  // a re-dispatch of an operation whose fault is already recorded never applies it twice
  if (prior.state === 'active' || prior.state === 'reverted' || prior.state === 'revert_failed') {
    return { accepted: true, externalJobId: spec.operationId, receipt: JSON.stringify({ jobDir: faultJobDir(stateDir, spec.operationId), expiresAt: prior.spec.expiresAt }) };
  }
  // (review) a job without an apply outcome (its applier died): its fault may be in place — never applied a second time
  if (prior.state === 'dispatching') throw new HypertestError('unavailable', `fault ${spec.operationId} was being applied when its process stopped (outcome unknown); it is reverted at ${prior.spec.expiresAt} at the latest`);
  const dir = beginFaultJob(stateDir, spec);
  if (spawnReverter(dir) === undefined) {
    markFaultNotApplied(dir, 'the fault reverter could not be started (nothing applied: a fault is never applied without its time box)');
    return { accepted: false, notAppliedReason: 'the fault reverter could not be started; nothing was applied' };
  }
  for (const argv of plan.apply) {
    const r = await run(argv);
    if (r.exitCode === 0) continue;
    const reason = `${argv.slice(0, 3).join(' ')} … failed (exit ${r.exitCode}${r.spawnError ? `, ${r.spawnError}` : ''}${r.timedOut ? ', timed out' : ''}): ${r.stderr.trim().slice(0, 500)}`;
    // (review) the command ran to its own non-zero exit (or never started): definitively refused
    if ((r.exitCode !== null && !r.timedOut) || r.spawnError === 'ENOENT' || r.spawnError === 'EACCES') {
      markFaultNotApplied(dir, reason);
      return { accepted: false, notAppliedReason: reason };
    }
    // timed out / aborted / killed: the daemon may have applied it — unknown (no apply outcome; the reverter ends it at expiry)
    markFaultAbandoned(dir, reason);
    throw new HypertestError(r.timedOut ? 'timeout' : 'unavailable', `the apply outcome of fault ${spec.operationId} is unknown (it is reverted at ${spec.expiresAt}): ${reason}`);
  }
  markFaultApplied(dir);
  return { accepted: true, externalJobId: spec.operationId, receipt: JSON.stringify({ jobDir: dir, expiresAt: spec.expiresAt }) };
}

/** Observes a container/cluster fault by its job directory; an overdue fault whose reverter is gone is reverted now. */
async function observeFault(stateDir: string, op: OperationContext): Promise<ObservationResult<ContainerFaultObservation>> {
  let view: FaultJobView = readFaultJob(stateDir, op.operation.operationId);
  if (view.state === 'absent' || view.state === 'not_applied') return { state: 'absent' };
  // (review) a job without an apply outcome (an apply in flight, or one whose applier died) whose settle deadline passed
  // and whose reverter is gone: its fault may be in place — reverted now like an overdue one
  if ((view.state === 'active' || view.state === 'dispatching') && overdueWithoutReverter(stateDir, view)) {
    const outcome = await revertOverdue(stateDir, view.spec);
    view = { state: outcome.state, spec: view.spec, outcome };
  }
  if (view.state === 'dispatching') return { state: 'uncertain', detail: `fault ${op.operation.operationId} was being applied when it was last seen (no apply outcome recorded); its reverter ends it by ${view.spec.settleBy ?? view.spec.expiresAt}` };
  const obs: ContainerFaultObservation = { kind: 'container_fault', fault: view.spec.kind, state: view.state, expiresAt: view.spec.expiresAt };
  if (view.state !== 'active') {
    obs.revertedAt = view.outcome.revertedAt;
    obs.revertedBy = view.outcome.by;
    obs.results = view.outcome.results;
  }
  return { state: 'present', observation: obs };
}

/**
 * Refuses an operation on an environment whose earlier fault could not be reverted (its state is unknown until an
 * operator repairs it and removes the fault job), or — for a new fault — that is still inside another fault's time box.
 */
async function assertFaultFree(stateDir: string | undefined, environmentId: string, type: string): Promise<void> {
  if (!stateDir) return;
  const open = await unrevertedFaults(stateDir, environmentId);
  const failed = open.find((f) => f.state === 'revert_failed');
  if (failed) throw new HypertestError('precondition_failed', `environment ${environmentId}: the ${failed.kind} fault of operation ${failed.operationId} could not be reverted (${failed.detail ?? 'unknown'}); repair the environment and remove ${faultJobDir(stateDir, failed.operationId)} first`);
  const active = open.find((f) => f.state === 'active');
  if (active && type === 'env.inject_fault') throw new HypertestError('precondition_failed', `environment ${environmentId} is still under the ${active.kind} fault of operation ${active.operationId} until ${active.expiresAt}`);
}

function verifyFault(obs: ContainerFaultObservation, environmentId: string): VerificationResult {
  if (obs.state === 'revert_failed') {
    const failed = (obs.results ?? []).filter((r) => r.exitCode !== 0).map((r) => `${r.argv.slice(1, 4).join(' ')}: ${r.stderr.trim().slice(0, 200)}`);
    return { status: 'failed', reason: `the fault was applied but its revert FAILED (the environment may still be faulted; check it): ${failed.join('; ')}` };
  }
  const verified: VerificationResult = { status: 'verified', result: { environmentId, action: 'fault', fault: obs.fault, state: obs.state, expiresAt: obs.expiresAt, ...(obs.revertedAt ? { revertedAt: obs.revertedAt } : {}) } };
  // E[1]: an active time-boxed fault holds its environment until it expires (the gateway keeps the lease)
  if (obs.state === 'active') verified.effectUntil = obs.expiresAt;
  return verified;
}

// ----------------------------------------------------------------------------- env.docker

const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

export interface DockerEnvAdapterOptions {
  environments: EnvironmentRegistry;
  /** docker CLI binary (default `docker`). */
  docker?: string;
  /** (additive, wave 3) State directory of fault jobs (`<stateDir>/faults/<operationId>`); faults need it. */
  stateDir?: string;
  commandTimeoutMs?: number;
  /** Tolerated clock skew between this host and the docker daemon when comparing StartedAt (default 0). */
  clockSkewMs?: number;
  logger?: Logger;
}

export interface DockerEnvObservation {
  container: string;
  id?: string;
  status: string;
  running: boolean;
  startedAt: string;
  /** StartedAt is at/after the reference (dispatch) time. */
  restarted: boolean;
}

function commandFailure(what: string, r: CommandResult): HypertestError {
  if (r.spawnError) return new HypertestError('unavailable', `${what}: cannot run the CLI (${r.spawnError}): ${r.stderr.trim().slice(0, 500)}`);
  if (r.timedOut) return new HypertestError('timeout', `${what} timed out`);
  return new HypertestError('unavailable', `${what} failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 1000)}`);
}

function parseTime(iso: string | undefined): number {
  if (!iso) return Number.NaN;
  // docker/k8s print nanoseconds; Date.parse wants at most milliseconds
  return Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
}

/**
 * `env.docker`: `docker restart <container>`. docker keeps no record of who restarted a container, so the
 * effect can NOT be looked up by operation id (reconciliation best_effort): observe compares the
 * container's State.StartedAt with the dispatch time (from the receipt, else the operation's creation
 * time). The gateway therefore never retries an unknown dispatch blindly — without a receipt it goes to
 * manual_review. Deploy is not supported for docker environments. (wave 3) Fault injection: `pause`, `kill`,
 * `network_disconnect`, `netem` — applied by the docker CLI, time-boxed and reverted by a detached reverter, observable
 * by operation id through its job directory (fault-injection.ts).
 */
export class DockerEnvAdapter implements SideEffectAdapter<EnvInput, DockerEnvObservation | ContainerFaultObservation> {
  readonly adapterId = 'env.docker';
  readonly capabilities: SideEffectCapabilities = {
    supportsNativeIdempotency: false,
    supportsExternalLookupByOperationId: false,
    supportsFencing: false,
    supportsCompensation: false,
    reconciliationClass: 'best_effort',
    riskClass: 'high',
  };
  readonly #o: DockerEnvAdapterOptions;
  readonly #bumper: GenerationBumper;

  constructor(options: DockerEnvAdapterOptions) {
    if (!options?.environments) throw new HypertestError('invalid_argument', 'DockerEnvAdapter requires an environment registry');
    this.#o = options;
    this.#bumper = new GenerationBumper(options.environments);
  }

  #docker(args: string[], signal: AbortSignal): Promise<CommandResult> {
    return runCommand(this.#o.docker ?? 'docker', args, { timeoutMs: this.#o.commandTimeoutMs ?? 120_000, signal });
  }

  /** (wave 3) Fault jobs are found by operation id (their job directory), restarts are not. */
  looksUpByOperationId(operationType: string): boolean {
    return operationType === 'env.inject_fault' && this.#o.stateDir !== undefined;
  }

  async prepare(op: OperationContext, input: EnvInput): Promise<PreparedOperation> {
    const type = operationTypeOf(op);
    if (type === 'env.deploy') throw new HypertestError('unsupported', 'env.deploy is not supported for docker environments (env.restart, env.inject_fault)');
    const env = requireEnvironment(this.#o.environments, input.environmentId);
    const container = requireControl(env, 'docker').target;
    if (!CONTAINER_RE.test(container)) throw new HypertestError('invalid_argument', `invalid docker container name ${JSON.stringify(container)}`);
    await assertFaultFree(this.#o.stateDir, env.environmentId, type);
    if (type === 'env.inject_fault') {
      if (!this.#o.stateDir) throw new HypertestError('unsupported', 'docker fault injection needs a state directory for its fault jobs (builtinSideEffectAdapters stateDir)');
      const f = input as EnvFaultInput;
      const plan = dockerFaultPlan(this.#o.docker ?? 'docker', container, f.kind, f.params ?? {});
      const desiredState = { action: 'fault', environmentId: env.environmentId, container, fault: plan.kind, params: plan.params, durationMs: faultDuration(f) };
      return { desiredState, desiredStateHash: hashCanonical(desiredState), target: envTarget(env) };
    }
    const desiredState = { action: 'restart', environmentId: env.environmentId, container };
    return { desiredState, desiredStateHash: hashCanonical(desiredState), target: envTarget(env) };
  }

  async dispatch(prepared: PreparedOperation, op: OperationContext): Promise<DispatchReceipt> {
    const ds = prepared.desiredState as { action: string; environmentId: string; container: string; fault?: string; params?: Record<string, unknown>; durationMs?: number };
    if (ds.action === 'fault') {
      const plan = dockerFaultPlan(this.#o.docker ?? 'docker', ds.container, ds.fault!, ds.params ?? {});
      return applyFault(this.#o.stateDir!, op, ds.environmentId, plan, ds.durationMs!, (argv) => this.#docker(argv.slice(1), op.signal), this.#o.commandTimeoutMs ?? 120_000);
    }
    const { container } = ds;
    const dispatchedAt = new Date().toISOString();
    const r = await this.#docker(['restart', container], op.signal);
    if (r.exitCode !== 0) {
      if (/no such container/i.test(r.stderr)) return { accepted: false, notAppliedReason: `docker: no such container ${container}` };
      throw commandFailure(`docker restart ${container}`, r);
    }
    const inspected = await this.#inspect(container, op.signal).catch(() => undefined);
    const receipt = { container, dispatchedAt, ...(inspected?.startedAt ? { startedAt: inspected.startedAt } : {}) };
    return { accepted: true, externalJobId: inspected?.id ?? container, receipt: JSON.stringify(receipt) };
  }

  async #inspect(container: string, signal: AbortSignal): Promise<{ id?: string; status: string; running: boolean; startedAt: string } | undefined> {
    const r = await this.#docker(['inspect', '--type', 'container', container], signal);
    if (r.exitCode !== 0) {
      if (/no such (object|container)/i.test(r.stderr)) return undefined;
      throw commandFailure(`docker inspect ${container}`, r);
    }
    let parsed: Array<{ Id?: string; State?: { Status?: string; Running?: boolean; StartedAt?: string } }>;
    try {
      parsed = JSON.parse(r.stdout) as typeof parsed;
    } catch {
      throw new HypertestError('unavailable', 'docker inspect returned invalid JSON');
    }
    const c = parsed[0];
    if (!c?.State) throw new HypertestError('unavailable', 'docker inspect returned no State');
    const out: { id?: string; status: string; running: boolean; startedAt: string } = { status: String(c.State.Status ?? 'unknown'), running: c.State.Running === true, startedAt: String(c.State.StartedAt ?? '') };
    if (c.Id !== undefined) out.id = c.Id;
    return out;
  }

  async observe(op: OperationContext): Promise<ObservationResult<DockerEnvObservation | ContainerFaultObservation>> {
    if (op.operation.operationType === 'env.inject_fault') {
      if (!this.#o.stateDir) return { state: 'uncertain', detail: 'no state directory: the fault job cannot be read' };
      return observeFault(this.#o.stateDir, op);
    }
    const env = requireEnvironment(this.#o.environments, environmentIdOf(op));
    const container = requireControl(env, 'docker').target;
    const state = await this.#inspect(container, op.signal);
    if (!state) return { state: 'uncertain', detail: `container ${container} not found` };
    let reference = op.operation.createdAt;
    if (op.operation.externalReceipt) {
      try {
        const r = JSON.parse(op.operation.externalReceipt) as { dispatchedAt?: string };
        if (r.dispatchedAt) reference = r.dispatchedAt;
      } catch {
        // keep createdAt
      }
    }
    const started = parseTime(state.startedAt);
    const ref = parseTime(reference);
    if (!Number.isFinite(started) || !Number.isFinite(ref)) return { state: 'uncertain', detail: `cannot compare StartedAt ${state.startedAt} with ${reference}` };
    const restarted = started >= ref - (this.#o.clockSkewMs ?? 0);
    if (!restarted) return { state: 'absent' };
    const obs: DockerEnvObservation = { container, status: state.status, running: state.running, startedAt: state.startedAt, restarted };
    if (state.id !== undefined) obs.id = state.id;
    return { state: 'present', observation: obs };
  }

  async verify(observation: DockerEnvObservation | ContainerFaultObservation, _hash: string, op: OperationContext): Promise<VerificationResult> {
    if ((observation as ContainerFaultObservation).kind === 'container_fault') return verifyFault(observation as ContainerFaultObservation, environmentIdOf(op));
    const obs = observation as DockerEnvObservation;
    if (obs.running) {
      const environmentId = environmentIdOf(op);
      const bumped = await this.#bumper.bump(op.operation.operationId, environmentId);
      return { status: 'verified', result: { environmentId, action: 'restart', container: obs.container, startedAt: obs.startedAt, generation: bumped.generation } };
    }
    if (obs.status === 'restarting' || obs.status === 'created') return { status: 'pending', progress: { status: obs.status } };
    return { status: 'failed', reason: `container ${obs.container} is ${obs.status} after the restart` };
  }
}

// ----------------------------------------------------------------------------- env.kubectl

const DNS1123_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const DNS1123_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
export const OPERATION_ANNOTATION = 'hypertest.io/operation-id';
export const BUILD_REF_ANNOTATION = 'hypertest.io/build-ref';
const RESTARTED_AT_ANNOTATION = 'kubectl.kubernetes.io/restartedAt';

export interface KubectlEnvAdapterOptions {
  environments: EnvironmentRegistry;
  /** kubectl binary (default `kubectl`). */
  kubectl?: string;
  /** Optional `--context` (an environment's own `control.context` wins). */
  context?: string;
  /** (additive, wave 3) State directory of fault jobs (`<stateDir>/faults/<operationId>`); faults need it. */
  stateDir?: string;
  commandTimeoutMs?: number;
  logger?: Logger;
}

export interface KubectlEnvObservation {
  namespace: string;
  deployment: string;
  generation: number;
  observedGeneration: number;
  replicas: number;
  statusReplicas: number;
  updatedReplicas: number;
  availableReplicas: number;
  readyReplicas: number;
  images: string[];
  /** hypertest.io/build-ref of the pod template (deploys). */
  buildRef?: string;
  progressDeadlineExceeded: boolean;
}

interface K8sDeployment {
  metadata?: { generation?: number; annotations?: Record<string, string> };
  spec?: { replicas?: number; template?: { metadata?: { annotations?: Record<string, string> }; spec?: { containers?: Array<{ name?: string; image?: string }> } } };
  status?: { observedGeneration?: number; replicas?: number; updatedReplicas?: number; availableReplicas?: number; readyReplicas?: number; conditions?: Array<{ type?: string; status?: string; reason?: string }> };
}

/**
 * `env.kubectl`: rolling restart / image deploy of a Deployment. The rollout is triggered and labelled
 * in ONE `kubectl patch` (equivalent to `kubectl rollout restart` + annotate, but atomic, so the
 * operation-id annotation can never exist without the rollout or vice versa):
 *   metadata.annotations[hypertest.io/operation-id] and spec.template.metadata.annotations
 *   {hypertest.io/operation-id: <operationId>, kubectl.kubernetes.io/restartedAt: <operation createdAt>}
 * (+ for a deploy, the image of ONE container = buildRef: the container named by control.target
 * `deployment/<name>/<container>`, or the only container; a multi-container pod without a named container
 * is refused as not applied, so sidecars are never overwritten). Re-applying the same patch is a no-op, so the
 * dispatch is natively idempotent. observe = `kubectl get deployment -o json` with the annotation
 * matching the operation id; verify = rollout status semantics (observedGeneration, updated/available
 * replicas, ProgressDeadlineExceeded ⇒ failed).
 */
export class KubectlEnvAdapter implements SideEffectAdapter<EnvInput, KubectlEnvObservation | ContainerFaultObservation> {
  readonly adapterId = 'env.kubectl';
  readonly capabilities: SideEffectCapabilities = {
    supportsNativeIdempotency: true,
    supportsExternalLookupByOperationId: true,
    supportsFencing: false,
    supportsCompensation: false,
    reconciliationClass: 'deterministic',
    riskClass: 'high',
  };
  readonly #o: KubectlEnvAdapterOptions;
  readonly #bumper: GenerationBumper;

  constructor(options: KubectlEnvAdapterOptions) {
    if (!options?.environments) throw new HypertestError('invalid_argument', 'KubectlEnvAdapter requires an environment registry');
    this.#o = options;
    this.#bumper = new GenerationBumper(options.environments);
  }

  /** `kubectl [--context c] -n <namespace>` for an environment (its own control.context, else the adapter's). */
  #prefix(namespace: string, context: string | undefined): string[] {
    const ctx = context ?? this.#o.context;
    return [this.#o.kubectl ?? 'kubectl', ...(ctx ? ['--context', ctx] : []), '-n', namespace];
  }

  #kubectl(namespace: string, args: string[], signal: AbortSignal, context?: string): Promise<CommandResult> {
    const [bin, ...prefix] = this.#prefix(namespace, context);
    return runCommand(bin!, [...prefix, ...args], { timeoutMs: this.#o.commandTimeoutMs ?? 120_000, signal });
  }

  /** control.target: `[deployment/]<name>[/<container>]` (the container a deploy updates). */
  #location(environmentId: string): { namespace: string; deployment: string; container?: string; env: EnvironmentDescriptor } {
    const env = requireEnvironment(this.#o.environments, environmentId);
    const control = requireControl(env, 'kubectl');
    const [deployment = '', container, ...rest] = control.target.replace(/^deployment(s)?(\.apps)?\//, '').split('/');
    const namespace = control.namespace ?? 'default';
    if (!DNS1123_RE.test(deployment)) throw new HypertestError('invalid_argument', `invalid deployment name ${JSON.stringify(deployment)}`);
    if (rest.length > 0 || (container !== undefined && !DNS1123_LABEL_RE.test(container))) throw new HypertestError('invalid_argument', `invalid kubectl control target ${JSON.stringify(control.target)} (expected [deployment/]<name>[/<container>])`);
    if (!DNS1123_RE.test(namespace)) throw new HypertestError('invalid_argument', `invalid namespace ${JSON.stringify(namespace)}`);
    return { namespace, deployment, ...(container !== undefined ? { container } : {}), env };
  }

  async prepare(op: OperationContext, input: EnvInput): Promise<PreparedOperation> {
    const type = operationTypeOf(op);
    await assertFaultFree(this.#o.stateDir, input.environmentId, type);
    if (type === 'env.inject_fault') {
      // (wave 3) pod_delete / scale_zero / network_deny: time-boxed, reverted by the detached reverter
      if (!this.#o.stateDir) throw new HypertestError('unsupported', 'kubectl fault injection needs a state directory for its fault jobs (builtinSideEffectAdapters stateDir)');
      const f = input as EnvFaultInput;
      const { namespace, deployment, env } = this.#location(input.environmentId);
      const d = await this.#get(namespace, deployment, op.signal, env.control?.context);
      if (!d) throw new HypertestError('precondition_failed', `deployment ${namespace}/${deployment} not found`);
      const selector = (d.spec as { selector?: { matchLabels?: Record<string, string> } } | undefined)?.selector?.matchLabels ?? {};
      for (const [k, v] of Object.entries(selector)) if (!/^[A-Za-z0-9./_-]{1,253}$/.test(k) || !/^[A-Za-z0-9._-]{0,63}$/.test(v)) throw new HypertestError('invalid_argument', `unsupported selector label ${k}=${v}`);
      const replicas = d.spec?.replicas ?? 1;
      // the plan is validated now (kind supported, selector present); it is rebuilt at dispatch from the desired state
      kubectlFaultPlan(this.#prefix(namespace, env.control?.context), deployment, f.kind, { replicas, selector, operationId: op.operation.operationId, namespace, policyFile: '/dev/null' });
      const desiredState = { action: 'fault', environmentId: env.environmentId, namespace, deployment, fault: f.kind, selector, replicas, durationMs: faultDuration(f) };
      return { desiredState, desiredStateHash: hashCanonical(desiredState), target: envTarget(env) };
    }
    const { namespace, deployment, container, env } = this.#location(input.environmentId);
    const desiredState: Record<string, unknown> = { action: type === 'env.deploy' ? 'deploy' : 'restart', environmentId: env.environmentId, namespace, deployment };
    if (type === 'env.deploy') {
      desiredState['buildRef'] = requireBuildRef(input);
      if (container !== undefined) desiredState['container'] = container;
    }
    return { desiredState, desiredStateHash: hashCanonical(desiredState), target: envTarget(env) };
  }

  async #get(namespace: string, deployment: string, signal: AbortSignal, context?: string): Promise<K8sDeployment | undefined> {
    const r = await this.#kubectl(namespace, ['get', 'deployment', deployment, '-o', 'json'], signal, context);
    if (r.exitCode !== 0) {
      if (/notfound|not found/i.test(r.stderr)) return undefined;
      throw commandFailure(`kubectl get deployment ${deployment}`, r);
    }
    try {
      return JSON.parse(r.stdout) as K8sDeployment;
    } catch {
      throw new HypertestError('unavailable', 'kubectl get returned invalid JSON');
    }
  }

  async dispatch(prepared: PreparedOperation, op: OperationContext): Promise<DispatchReceipt> {
    const fault = prepared.desiredState as { action: string; environmentId: string; namespace: string; deployment: string; fault?: string; selector?: Record<string, string>; replicas?: number; durationMs?: number };
    if (fault.action === 'fault') {
      const context = this.#o.environments.get(fault.environmentId)?.control?.context;
      const dir = faultJobDir(this.#o.stateDir!, op.operation.operationId);
      mkdirSync(dir, { recursive: true });
      const plan = kubectlFaultPlan(this.#prefix(fault.namespace, context), fault.deployment, fault.fault!, { replicas: fault.replicas ?? 1, selector: fault.selector ?? {}, operationId: op.operation.operationId, namespace: fault.namespace, policyFile: join(dir, 'networkpolicy.json') });
      return applyFault(this.#o.stateDir!, op, fault.environmentId, plan, fault.durationMs!, (argv) => runCommand(argv[0]!, argv.slice(1), { timeoutMs: this.#o.commandTimeoutMs ?? 120_000, signal: op.signal }), this.#o.commandTimeoutMs ?? 120_000);
    }
    const s = prepared.desiredState as { action: 'restart' | 'deploy'; namespace: string; deployment: string; buildRef?: string; container?: string };
    const operationId = op.operation.operationId;
    const templateAnnotations: Record<string, string> = { [OPERATION_ANNOTATION]: operationId, [RESTARTED_AT_ANNOTATION]: op.operation.createdAt };
    const patch: K8sDeployment = { metadata: { annotations: { [OPERATION_ANNOTATION]: operationId } }, spec: { template: { metadata: { annotations: templateAnnotations } } } };
    if (s.action === 'deploy') {
      const current = await this.#get(s.namespace, s.deployment, op.signal);
      if (!current) return { accepted: false, notAppliedReason: `deployment ${s.namespace}/${s.deployment} not found` };
      const names = (current.spec?.template?.spec?.containers ?? []).map((c) => c.name).filter((n): n is string => typeof n === 'string');
      // Nothing has been patched yet: every refusal below is definitively "not applied" (never outcome_unknown).
      if (names.length === 0) return { accepted: false, notAppliedReason: `deployment ${s.namespace}/${s.deployment} has no containers` };
      let container = s.container;
      if (container === undefined) {
        // One image into a multi-container pod would overwrite the sidecars: the operator must name the container.
        if (names.length > 1) return { accepted: false, notAppliedReason: `deployment ${s.namespace}/${s.deployment} has ${names.length} containers (${names.join(', ')}); name the one to deploy in control.target as deployment/${s.deployment}/<container>` };
        container = names[0]!;
      } else if (!names.includes(container)) {
        return { accepted: false, notAppliedReason: `deployment ${s.namespace}/${s.deployment} has no container ${container} (has ${names.join(', ')})` };
      }
      templateAnnotations[BUILD_REF_ANNOTATION] = s.buildRef!;
      patch.metadata!.annotations![BUILD_REF_ANNOTATION] = s.buildRef!;
      patch.spec!.template!.spec = { containers: [{ name: container, image: s.buildRef! }] };
    }
    const r = await this.#kubectl(s.namespace, ['patch', 'deployment', s.deployment, '--type', 'strategic', '-p', JSON.stringify(patch)], op.signal);
    if (r.exitCode !== 0) {
      if (/notfound|not found/i.test(r.stderr)) return { accepted: false, notAppliedReason: `deployment ${s.namespace}/${s.deployment} not found` };
      throw commandFailure(`kubectl patch deployment ${s.deployment}`, r);
    }
    return { accepted: true, externalJobId: `${s.namespace}/${s.deployment}`, receipt: r.stdout.trim().slice(0, 2000) };
  }

  async observe(op: OperationContext): Promise<ObservationResult<KubectlEnvObservation | ContainerFaultObservation>> {
    if (op.operation.operationType === 'env.inject_fault') {
      if (!this.#o.stateDir) return { state: 'uncertain', detail: 'no state directory: the fault job cannot be read' };
      return observeFault(this.#o.stateDir, op);
    }
    const { namespace, deployment, env } = this.#location(environmentIdOf(op));
    const d = await this.#get(namespace, deployment, op.signal, env.control?.context);
    if (!d) return { state: 'uncertain', detail: `deployment ${namespace}/${deployment} not found` };
    const mark = d.spec?.template?.metadata?.annotations?.[OPERATION_ANNOTATION];
    if (mark !== op.operation.operationId) return { state: 'absent' };
    const replicas = d.spec?.replicas ?? 1;
    const buildRef = d.spec?.template?.metadata?.annotations?.[BUILD_REF_ANNOTATION];
    return {
      state: 'present',
      observation: {
        ...(buildRef !== undefined ? { buildRef } : {}),
        namespace,
        deployment,
        generation: d.metadata?.generation ?? 0,
        observedGeneration: d.status?.observedGeneration ?? 0,
        replicas,
        statusReplicas: d.status?.replicas ?? 0,
        updatedReplicas: d.status?.updatedReplicas ?? 0,
        availableReplicas: d.status?.availableReplicas ?? 0,
        readyReplicas: d.status?.readyReplicas ?? 0,
        images: (d.spec?.template?.spec?.containers ?? []).map((c) => String(c.image ?? '')),
        progressDeadlineExceeded: (d.status?.conditions ?? []).some((c) => c.type === 'Progressing' && c.reason === 'ProgressDeadlineExceeded'),
      },
    };
  }

  async verify(observation: KubectlEnvObservation | ContainerFaultObservation, _hash: string, op: OperationContext): Promise<VerificationResult> {
    if ((observation as ContainerFaultObservation).kind === 'container_fault') return verifyFault(observation as ContainerFaultObservation, environmentIdOf(op));
    const obs = observation as KubectlEnvObservation;
    if (obs.progressDeadlineExceeded) return { status: 'failed', reason: `deployment ${obs.namespace}/${obs.deployment} exceeded its progress deadline` };
    const progress = { observedGeneration: obs.observedGeneration, generation: obs.generation, replicas: obs.replicas, updatedReplicas: obs.updatedReplicas, availableReplicas: obs.availableReplicas };
    if (obs.observedGeneration < obs.generation) return { status: 'pending', progress: { ...progress, waiting: 'rollout spec update not yet observed' } };
    if (obs.updatedReplicas < obs.replicas) return { status: 'pending', progress: { ...progress, waiting: `${obs.updatedReplicas} of ${obs.replicas} replicas updated` } };
    if (obs.statusReplicas > obs.updatedReplicas) return { status: 'pending', progress: { ...progress, waiting: `${obs.statusReplicas - obs.updatedReplicas} old replicas pending termination` } };
    if (obs.availableReplicas < obs.updatedReplicas) return { status: 'pending', progress: { ...progress, waiting: `${obs.availableReplicas} of ${obs.updatedReplicas} updated replicas available` } };
    const environmentId = environmentIdOf(op);
    const deploy = op.operation.operationType === 'env.deploy';
    const buildRef = deploy ? (obs.buildRef ?? obs.images[0]) : undefined;
    const bumped = await this.#bumper.bump(op.operation.operationId, environmentId, buildRef);
    return {
      status: 'verified',
      result: { environmentId, action: deploy ? 'deploy' : 'restart', namespace: obs.namespace, deployment: obs.deployment, replicas: obs.replicas, images: obs.images, generation: bumped.generation, ...(bumped.buildDigest !== undefined ? { buildDigest: bumped.buildDigest } : {}) },
    };
  }
}

// ----------------------------------------------------------------------------- env.control (router)

export interface EnvControlAdapterOptions {
  environments: EnvironmentRegistry;
  backends: { process?: SideEffectAdapter<EnvInput, unknown>; docker?: SideEffectAdapter<EnvInput, unknown>; kubectl?: SideEffectAdapter<EnvInput, unknown> };
}

/**
 * `env.control`: the adapter the env.* tools bind to (a ToolSpec binding names one adapter statically).
 * It routes each operation to the backend of the environment's `control.kind` (process | docker |
 * kubectl). It declares lookup-by-operation-id so that process/kubectl operations can be reconciled
 * after a crash; for a backend WITHOUT that capability (docker) it reports `uncertain` whenever no
 * dispatch receipt was recorded, which the gateway turns into manual_review — exactly as safe as using
 * that backend directly. Changing an environment's control kind while its operations are unsettled is
 * unsupported (routing reads the registry).
 */
export class EnvControlAdapter implements SideEffectAdapter<EnvInput, unknown> {
  readonly adapterId = 'env.control';
  readonly capabilities: SideEffectCapabilities = {
    supportsNativeIdempotency: false,
    supportsExternalLookupByOperationId: true,
    supportsFencing: false,
    supportsCompensation: false,
    reconciliationClass: 'best_effort',
    riskClass: 'high',
  };
  readonly #o: EnvControlAdapterOptions;

  constructor(options: EnvControlAdapterOptions) {
    if (!options?.environments) throw new HypertestError('invalid_argument', 'EnvControlAdapter requires an environment registry');
    this.#o = options;
  }

  #backend(environmentId: string): SideEffectAdapter<EnvInput, unknown> {
    const env = requireEnvironment(this.#o.environments, environmentId);
    const kind = env.control?.kind;
    if (kind === undefined) throw new HypertestError('precondition_failed', `environment ${environmentId} has no control descriptor`);
    const backend = this.#o.backends[kind];
    if (!backend) throw new HypertestError('unsupported', `no ${kind} environment adapter is configured`);
    return backend;
  }

  prepare(op: OperationContext, input: EnvInput): Promise<PreparedOperation> {
    if (!input || typeof input.environmentId !== 'string') return Promise.reject(new HypertestError('invalid_argument', 'environmentId is required'));
    return this.#backend(input.environmentId).prepare(op, input);
  }

  dispatch(prepared: PreparedOperation, op: OperationContext): Promise<DispatchReceipt> {
    return this.#backend(environmentIdOf(op)).dispatch(prepared, op);
  }

  async observe(op: OperationContext): Promise<ObservationResult<unknown>> {
    const backend = this.#backend(environmentIdOf(op));
    const byId = backend.capabilities.supportsExternalLookupByOperationId || (backend as { looksUpByOperationId?: (t: string) => boolean }).looksUpByOperationId?.(op.operation.operationType) === true;
    if (!byId && op.operation.externalJobId === undefined) {
      return { state: 'uncertain', detail: `backend ${backend.adapterId} cannot look up effects by operation id and no dispatch receipt was recorded; refusing to guess` };
    }
    return backend.observe(op);
  }

  verify(observation: unknown, desiredStateHash: string, op: OperationContext): Promise<VerificationResult> {
    return this.#backend(environmentIdOf(op)).verify(observation, desiredStateHash, op);
  }
}
