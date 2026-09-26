import { HypertestError, hashCanonical, type Logger } from '@hypertest/core';
import type { DispatchReceipt, ObservationResult, OperationContext, PreparedOperation, SideEffectAdapter, SideEffectCapabilities, VerificationResult } from '@hypertest/operation';
import type { EnvironmentDescriptor, EnvironmentRegistry } from '../contracts.ts';
import { CONTROL_TOKEN_HEADER, errorMessage, publicControlTarget, requireEnvironment, runCommand, splitControlTarget, type CommandResult } from './common.ts';
import { OPERATION_HEADER, normalizeFault, type SupervisorFault, type SupervisorOperation } from './process-supervisor.ts';

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
  kind: 'latency' | 'error_rate';
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
 * observe in this process — reuses the recorded bump instead of bumping twice).
 */
class GenerationBumper {
  readonly #done = new Map<string, EnvironmentDescriptor>();
  readonly #envs: EnvironmentRegistry;
  constructor(envs: EnvironmentRegistry) {
    this.#envs = envs;
  }
  bump(operationId: string, environmentId: string, buildDigest?: string): EnvironmentDescriptor {
    const prior = this.#done.get(operationId);
    if (prior) return prior;
    const next = this.#envs.bumpGeneration(environmentId, buildDigest);
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
    supportsFencing: false,
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
    if (token !== undefined) headers[CONTROL_TOKEN_HEADER] = token;
    let res: Response;
    try {
      res = await fetch(controlEndpoint(base, isFault ? 'faults' : 'restart'), { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      throw new HypertestError('unavailable', `supervisor ${base.href} unreachable: ${errorMessage(e)}`);
    }
    const text = await res.text();
    // Refused before acting (bad request, unknown endpoint, missing/invalid control token): definitively not applied.
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || res.status === 413 || res.status === 422) {
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
        return { status: 'verified', result: { environmentId, action: 'fault', faultId: obs.faultId ?? null, fault: obs.fault ?? null, expiresAt: obs.expiresAt ?? null, state: obs.state } };
      }
      return { status: 'failed', reason: `fault operation in unexpected state ${obs.state}` };
    }
    if (obs.state === 'running') return { status: 'pending', progress: { state: 'running', restartId: obs.restartId } };
    if (obs.state === 'failed') return { status: 'failed', reason: `supervised ${obs.kind} failed: ${obs.error ?? 'unknown error'}` };
    if (obs.state !== 'completed') return { status: 'failed', reason: `restart in unexpected state ${obs.state}` };
    const bumped = this.#bumper.bump(op.operation.operationId, environmentId, obs.kind === 'deploy' ? obs.buildRef : undefined);
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

// ----------------------------------------------------------------------------- env.docker

const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

export interface DockerEnvAdapterOptions {
  environments: EnvironmentRegistry;
  /** docker CLI binary (default `docker`). */
  docker?: string;
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
 * manual_review. Deploy and fault injection are not supported for docker environments.
 */
export class DockerEnvAdapter implements SideEffectAdapter<EnvInput, DockerEnvObservation> {
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

  async prepare(op: OperationContext, input: EnvInput): Promise<PreparedOperation> {
    const type = operationTypeOf(op);
    if (type !== 'env.restart') throw new HypertestError('unsupported', `${type} is not supported for docker environments (only env.restart)`);
    const env = requireEnvironment(this.#o.environments, input.environmentId);
    const container = requireControl(env, 'docker').target;
    if (!CONTAINER_RE.test(container)) throw new HypertestError('invalid_argument', `invalid docker container name ${JSON.stringify(container)}`);
    const desiredState = { action: 'restart', environmentId: env.environmentId, container };
    return { desiredState, desiredStateHash: hashCanonical(desiredState), target: envTarget(env) };
  }

  async dispatch(prepared: PreparedOperation, op: OperationContext): Promise<DispatchReceipt> {
    const { container } = prepared.desiredState as { container: string };
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

  async observe(op: OperationContext): Promise<ObservationResult<DockerEnvObservation>> {
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

  async verify(obs: DockerEnvObservation, _hash: string, op: OperationContext): Promise<VerificationResult> {
    if (obs.running) {
      const environmentId = environmentIdOf(op);
      const bumped = this.#bumper.bump(op.operation.operationId, environmentId);
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
  /** Optional `--context`. */
  context?: string;
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
export class KubectlEnvAdapter implements SideEffectAdapter<EnvInput, KubectlEnvObservation> {
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

  #kubectl(namespace: string, args: string[], signal: AbortSignal): Promise<CommandResult> {
    const prefix = this.#o.context ? ['--context', this.#o.context] : [];
    return runCommand(this.#o.kubectl ?? 'kubectl', [...prefix, '-n', namespace, ...args], { timeoutMs: this.#o.commandTimeoutMs ?? 120_000, signal });
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
    if (type === 'env.inject_fault') throw new HypertestError('unsupported', 'env.inject_fault is not supported for kubectl environments');
    const { namespace, deployment, container, env } = this.#location(input.environmentId);
    const desiredState: Record<string, unknown> = { action: type === 'env.deploy' ? 'deploy' : 'restart', environmentId: env.environmentId, namespace, deployment };
    if (type === 'env.deploy') {
      desiredState['buildRef'] = requireBuildRef(input);
      if (container !== undefined) desiredState['container'] = container;
    }
    return { desiredState, desiredStateHash: hashCanonical(desiredState), target: envTarget(env) };
  }

  async #get(namespace: string, deployment: string, signal: AbortSignal): Promise<K8sDeployment | undefined> {
    const r = await this.#kubectl(namespace, ['get', 'deployment', deployment, '-o', 'json'], signal);
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

  async observe(op: OperationContext): Promise<ObservationResult<KubectlEnvObservation>> {
    const { namespace, deployment } = this.#location(environmentIdOf(op));
    const d = await this.#get(namespace, deployment, op.signal);
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

  async verify(obs: KubectlEnvObservation, _hash: string, op: OperationContext): Promise<VerificationResult> {
    if (obs.progressDeadlineExceeded) return { status: 'failed', reason: `deployment ${obs.namespace}/${obs.deployment} exceeded its progress deadline` };
    const progress = { observedGeneration: obs.observedGeneration, generation: obs.generation, replicas: obs.replicas, updatedReplicas: obs.updatedReplicas, availableReplicas: obs.availableReplicas };
    if (obs.observedGeneration < obs.generation) return { status: 'pending', progress: { ...progress, waiting: 'rollout spec update not yet observed' } };
    if (obs.updatedReplicas < obs.replicas) return { status: 'pending', progress: { ...progress, waiting: `${obs.updatedReplicas} of ${obs.replicas} replicas updated` } };
    if (obs.statusReplicas > obs.updatedReplicas) return { status: 'pending', progress: { ...progress, waiting: `${obs.statusReplicas - obs.updatedReplicas} old replicas pending termination` } };
    if (obs.availableReplicas < obs.updatedReplicas) return { status: 'pending', progress: { ...progress, waiting: `${obs.availableReplicas} of ${obs.updatedReplicas} updated replicas available` } };
    const environmentId = environmentIdOf(op);
    const deploy = op.operation.operationType === 'env.deploy';
    const buildRef = deploy ? (obs.buildRef ?? obs.images[0]) : undefined;
    const bumped = this.#bumper.bump(op.operation.operationId, environmentId, buildRef);
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
    if (!backend.capabilities.supportsExternalLookupByOperationId && op.operation.externalJobId === undefined) {
      return { state: 'uncertain', detail: `backend ${backend.adapterId} cannot look up effects by operation id and no dispatch receipt was recorded; refusing to guess` };
    }
    return backend.observe(op);
  }

  verify(observation: unknown, desiredStateHash: string, op: OperationContext): Promise<VerificationResult> {
    return this.#backend(environmentIdOf(op)).verify(observation, desiredStateHash, op);
  }
}
