import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HypertestError } from '@hypertest/core';
import { pidState } from './common.ts';
import { runRevert, settleDeadline, type FaultJobSpec, type FaultJobState, type FaultRevertCommand } from './fault-worker.ts';

/**
 * Container and cluster fault injection (env.inject_fault on docker / kubectl environments): what each fault kind applies
 * and how it is reverted, plus the operation-id-labelled job directory (`<stateDir>/faults/<operationId>`) and the
 * detached reverter that holds the time box (fault-worker.ts). Kinds:
 *  - docker: `pause` (docker pause ⇢ unpause), `kill` (docker kill ⇢ start), `network_disconnect` {network}
 *    (docker network disconnect ⇢ connect), `netem` {delayMs, jitterMs, lossPct, interface} (tc qdisc netem inside the
 *    container ⇢ qdisc del; needs tc and NET_ADMIN in the container);
 *  - kubectl: `pod_delete` (delete the deployment's pods ⇢ wait for the rollout to be available again), `scale_zero`
 *    (scale to 0 ⇢ scale back to the replicas recorded before), `network_deny` (a deny-all NetworkPolicy for the
 *    deployment's pods ⇢ delete it).
 * Every value that reaches an argv is validated (names, numbers); nothing passes through a shell.
 */

export const FAULT_WORKER_PATH = fileURLToPath(new URL('./fault-worker.ts', import.meta.url));

export const DOCKER_FAULT_KINDS = Object.freeze(['pause', 'kill', 'network_disconnect', 'netem'] as const);
export const KUBECTL_FAULT_KINDS = Object.freeze(['pod_delete', 'scale_zero', 'network_deny'] as const);
export const PROCESS_FAULT_KINDS = Object.freeze(['latency', 'error_rate'] as const);
export type ContainerFaultKind = (typeof DOCKER_FAULT_KINDS)[number] | (typeof KUBECTL_FAULT_KINDS)[number];

const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IFACE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/;

export interface FaultPlan {
  kind: ContainerFaultKind;
  /** Canonical parameters (part of the desired state). */
  params: Record<string, number | string>;
  apply: string[][];
  revert: FaultRevertCommand[];
}

function num(params: Record<string, unknown>, key: string, min: number, max: number, dflt?: number): number | undefined {
  const v = params[key];
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new HypertestError('invalid_argument', `fault parameter ${key} must be a number in [${min}, ${max}]`);
  return v;
}

/** The docker plan of a fault on `container` (docker binary `docker`). */
export function dockerFaultPlan(docker: string, container: string, kind: string, params: Record<string, unknown>): FaultPlan {
  switch (kind) {
    case 'pause':
      return { kind, params: {}, apply: [[docker, 'pause', container]], revert: [{ argv: [docker, 'unpause', container] }] };
    case 'kill':
      return { kind, params: {}, apply: [[docker, 'kill', container]], revert: [{ argv: [docker, 'start', container] }] };
    case 'network_disconnect': {
      const network = params['network'];
      if (typeof network !== 'string' || !NETWORK_RE.test(network)) throw new HypertestError('invalid_argument', 'network_disconnect needs params.network (a docker network name)');
      return { kind, params: { network }, apply: [[docker, 'network', 'disconnect', network, container]], revert: [{ argv: [docker, 'network', 'connect', network, container] }] };
    }
    case 'netem': {
      const delayMs = num(params, 'delayMs', 0, 60_000, 0)!;
      const jitterMs = num(params, 'jitterMs', 0, 60_000);
      const lossPct = num(params, 'lossPct', 0, 100, 0)!;
      const iface = params['interface'] ?? 'eth0';
      if (typeof iface !== 'string' || !IFACE_RE.test(iface)) throw new HypertestError('invalid_argument', 'netem params.interface must be an interface name');
      if (delayMs === 0 && lossPct === 0) throw new HypertestError('invalid_argument', 'netem needs delayMs and/or lossPct');
      const netem = ['delay', `${delayMs}ms`, ...(jitterMs !== undefined ? [`${jitterMs}ms`] : []), 'loss', `${lossPct}%`];
      return {
        kind, params: { delayMs, ...(jitterMs !== undefined ? { jitterMs } : {}), lossPct, interface: iface },
        apply: [[docker, 'exec', container, 'tc', 'qdisc', 'add', 'dev', iface, 'root', 'netem', ...netem]],
        revert: [{ argv: [docker, 'exec', container, 'tc', 'qdisc', 'del', 'dev', iface, 'root', 'netem'] }],
      };
    }
    default:
      throw new HypertestError('unsupported', `fault kind ${kind} is not supported for docker environments (${DOCKER_FAULT_KINDS.join(', ')})`);
  }
}

/** A deny-all NetworkPolicy for the pods `selector` matches (labelled with the operation id). */
export function denyAllPolicy(name: string, namespace: string, selector: Record<string, string>, operationId: string): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'hypertest' }, annotations: { 'hypertest.io/operation-id': operationId } },
    spec: { podSelector: { matchLabels: selector }, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] },
  };
}

/**
 * The kubectl plan of a fault on `deployment` (`kubectl` = binary + context/namespace prefix). `replicas` (scale_zero) and
 * `selector` (pod_delete / network_deny) come from the deployment as read at prepare time; `policyFile` is where the
 * NetworkPolicy manifest is written (network_deny).
 */
export function kubectlFaultPlan(kubectl: string[], deployment: string, kind: string, ctx: { replicas: number; selector: Record<string, string>; operationId: string; namespace: string; policyFile: string }): FaultPlan {
  const sel = Object.entries(ctx.selector).map(([k, v]) => `${k}=${v}`).join(',');
  switch (kind) {
    case 'pod_delete':
      if (sel === '') throw new HypertestError('precondition_failed', `deployment ${deployment} has no matchLabels selector`);
      return {
        kind, params: {},
        apply: [[...kubectl, 'delete', 'pod', '-l', sel, '--wait=false']],
        // "reverted" = the controller brought the pods back and the rollout is available again
        revert: [{ argv: [...kubectl, 'rollout', 'status', `deployment/${deployment}`, '--timeout=180s'], timeoutMs: 200_000 }],
      };
    case 'scale_zero':
      return {
        kind, params: { replicas: ctx.replicas },
        apply: [[...kubectl, 'scale', `deployment/${deployment}`, '--replicas=0']],
        revert: [{ argv: [...kubectl, 'scale', `deployment/${deployment}`, `--replicas=${ctx.replicas}`] }, { argv: [...kubectl, 'rollout', 'status', `deployment/${deployment}`, '--timeout=180s'], timeoutMs: 200_000 }],
      };
    case 'network_deny': {
      if (sel === '') throw new HypertestError('precondition_failed', `deployment ${deployment} has no matchLabels selector`);
      const name = `ht-deny-${ctx.operationId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(-40).replace(/^-+/, '')}`;
      writeFileSync(ctx.policyFile, JSON.stringify(denyAllPolicy(name, ctx.namespace, ctx.selector, ctx.operationId)));
      return { kind, params: { policy: name }, apply: [[...kubectl, 'apply', '-f', ctx.policyFile]], revert: [{ argv: [...kubectl, 'delete', 'networkpolicy', name, '--ignore-not-found'] }] };
    }
    default:
      throw new HypertestError('unsupported', `fault kind ${kind} is not supported for kubectl environments (${KUBECTL_FAULT_KINDS.join(', ')})`);
  }
}

/** The operation-id-labelled job directory of a fault. */
export function faultJobDir(stateDir: string, operationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId)) throw new HypertestError('invalid_argument', 'invalid operation id');
  return join(stateDir, 'faults', operationId);
}

function writeAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** What the adapter knows of a fault operation (from its job directory). */
export type FaultJobView =
  | { state: 'absent' }
  | { state: 'dispatching'; spec: FaultJobSpec; abandoned?: boolean }
  | { state: 'not_applied'; reason: string }
  | { state: 'active'; spec: FaultJobSpec }
  | { state: 'reverted' | 'revert_failed'; spec: FaultJobSpec; outcome: FaultJobState };

export function readFaultJob(stateDir: string, operationId: string): FaultJobView {
  const dir = faultJobDir(stateDir, operationId);
  const spec = readJson<FaultJobSpec>(join(dir, 'spec.json'));
  if (!spec) return { state: 'absent' };
  const notApplied = readJson<{ reason: string }>(join(dir, 'not-applied.json'));
  if (notApplied) return { state: 'not_applied', reason: notApplied.reason };
  const outcome = readJson<FaultJobState>(join(dir, 'state.json'));
  if (outcome) return { state: outcome.state, spec, outcome };
  // (review) no apply outcome: an apply in flight, one whose applier died, or one it abandoned (timeout / abort) — the fault
  // may be in place either way
  if (!existsSync(join(dir, 'applied.json'))) return existsSync(join(dir, 'abandoned.json')) ? { state: 'dispatching', spec, abandoned: true } : { state: 'dispatching', spec };
  return { state: 'active', spec };
}

/** Records the job before anything is applied (a crash in between is visible as `dispatching`). */
export function beginFaultJob(stateDir: string, spec: FaultJobSpec): string {
  const dir = faultJobDir(stateDir, spec.operationId);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'spec.json'))) writeAtomic(join(dir, 'spec.json'), spec);
  return dir;
}

export function markFaultApplied(dir: string): void {
  writeAtomic(join(dir, 'applied.json'), { appliedAt: new Date().toISOString() });
}

/** (review) The applier gave up on the apply (timeout / abort): its outcome is unknown — the reverter ends the fault at expiry. */
export function markFaultAbandoned(dir: string, reason: string): void {
  writeAtomic(join(dir, 'abandoned.json'), { reason, at: new Date().toISOString() });
}

export function markFaultNotApplied(dir: string, reason: string): void {
  writeAtomic(join(dir, 'not-applied.json'), { reason });
  // (review) wakes the reverter early: a definitively refused fault has nothing to revert
  writeAtomic(join(dir, 'stop.json'), { reason: 'not applied' });
}

/** Starts the detached reverter that ends the fault at its expiry. */
export function spawnReverter(dir: string, options: { nodePath?: string; workerPath?: string } = {}): number | undefined {
  const child = spawn(options.nodePath ?? process.execPath, ['--no-warnings', options.workerPath ?? FAULT_WORKER_PATH, dir], { detached: true, stdio: 'ignore', env: process.env });
  child.on('error', () => undefined);
  child.unref();
  return child.pid;
}

/** True while the job's reverter process is alive. */
export function reverterAlive(dir: string): boolean {
  const raw = (() => {
    try {
      return readFileSync(join(dir, 'pid'), 'utf8').trim();
    } catch {
      return '';
    }
  })();
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 && pidState(pid, 'fault-worker.ts') === 'alive';
}

/** Reverts an overdue fault whose reverter is gone (the adapter's own safety net; the revert commands are idempotent). */
export async function revertOverdue(stateDir: string, spec: FaultJobSpec): Promise<FaultJobState> {
  return runRevert(faultJobDir(stateDir, spec.operationId), spec, 'adapter');
}

/**
 * (review) True when a job's fault must be reverted by the adapter now: it is (or, without an apply outcome, may be) in
 * place, its time box is over (for a job without an apply outcome: also its `settleBy`) and no reverter process holds it.
 */
export function overdueWithoutReverter(stateDir: string, view: FaultJobView): boolean {
  if (view.state !== 'active' && view.state !== 'dispatching') return false;
  const deadline = view.state === 'active' || (view.state === 'dispatching' && view.abandoned === true) ? Date.parse(view.spec.expiresAt) : settleDeadline(view.spec);
  return deadline <= Date.now() && !reverterAlive(faultJobDir(stateDir, view.spec.operationId));
}

/**
 * The faults on `environmentId` that are not (known to be) reverted: an overdue fault whose reverter is gone is reverted
 * here first; what remains is `revert_failed` (the environment may still be faulted) or still `active` (inside its time
 * box — or (review) a job without an apply outcome: an apply in flight, or one whose applier died; it may be in place).
 * Adapters refuse further operations on an environment with a failed revert (its state is unknown).
 */
export async function unrevertedFaults(stateDir: string, environmentId: string): Promise<Array<{ operationId: string; kind: string; state: 'active' | 'revert_failed'; expiresAt: string; detail?: string }>> {
  let ids: string[];
  try {
    ids = readdirSync(join(stateDir, 'faults'));
  } catch {
    return [];
  }
  const out: Array<{ operationId: string; kind: string; state: 'active' | 'revert_failed'; expiresAt: string; detail?: string }> = [];
  for (const id of ids) {
    let view: FaultJobView;
    try {
      view = readFaultJob(stateDir, id);
    } catch {
      continue;
    }
    if (view.state !== 'active' && view.state !== 'revert_failed' && view.state !== 'dispatching') continue;
    if (view.spec.environmentId !== environmentId) continue;
    if ((view.state === 'active' || view.state === 'dispatching') && overdueWithoutReverter(stateDir, view)) {
      const outcome = await revertOverdue(stateDir, view.spec);
      if (outcome.state === 'reverted') continue;
      view = { state: 'revert_failed', spec: view.spec, outcome };
    }
    const detail = view.state === 'revert_failed' ? view.outcome.results.filter((r) => r.exitCode !== 0).map((r) => `${r.argv.slice(1, 4).join(' ')}: ${r.stderr.trim().slice(0, 200)}`).join('; ') : undefined;
    out.push({ operationId: id, kind: view.spec.kind, state: view.state === 'revert_failed' ? 'revert_failed' : 'active', expiresAt: view.spec.expiresAt, ...(detail !== undefined ? { detail } : {}) });
  }
  return out;
}
