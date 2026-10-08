/**
 * (row 249 / E[7] / stubs[3]) Container and cluster fault injection: env.inject_fault on docker and kubectl
 * environments — time-boxed, reverted by a detached reverter (or by the adapter when the reverter is gone), ledgered
 * through the SideEffectGateway and observable by operation id.
 *
 * docker and kubectl are FAKE executables put on PATH (the adapters use their default binary names, exactly as in
 * production): small node programs that append every argv to a JSONL log and fail on demand. The live tests at the end
 * run against a real docker daemon / Kubernetes cluster and skip with the reason when there is none.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHypertestError } from '@hypertest/core';
import type { OperationContext } from '@hypertest/operation';
import {
  DockerEnvAdapter, EnvControlAdapter, KubectlEnvAdapter, blackboxTools, builtinSideEffectAdapters, dockerFaultPlan, envInjectFaultTool, envRestartTool, faultJobDir, kubectlFaultPlan, readFaultJob, unrevertedFaults,
  type EnvFaultInput, type EnvInput, type ToolSpec,
} from '../src/index.ts';
import { CrashAfterDispatch, newGateway, newRuntime, nextInvocationId, openBlackboxEnv, sideEffectRequest, structuredOf, tempDir, toolRequest, waitFor, type BlackboxEnv } from './blackbox-helpers.ts';

const FAKE = (name: string, logPath: string, modePath: string) => `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ bin: ${JSON.stringify(name)}, args }) + '\\n');
let mode = {};
try { mode = JSON.parse(fs.readFileSync(${JSON.stringify(modePath)}, 'utf8')); } catch {}
const verb = args.filter((a, i) => !(a.startsWith('--context') || args[i - 1] === '--context' || a === '-n' || args[i - 1] === '-n'))[0];
if ((mode.fail || []).includes(verb)) { process.stderr.write(${JSON.stringify(name)} + ': ' + verb + ' refused by the fake\\n'); process.exit(1); }
if (${JSON.stringify(name)} === 'kubectl' && verb === 'get') {
  process.stdout.write(JSON.stringify({ metadata: { name: 'checkout', generation: 4, annotations: {} }, spec: { replicas: 3, selector: { matchLabels: { app: 'checkout' } }, template: { spec: { containers: [{ name: 'app', image: 'shop:1' }] } } }, status: { observedGeneration: 4, replicas: 3, updatedReplicas: 3, availableReplicas: 3, readyReplicas: 3 } }) + '\\n');
  process.exit(0);
}
if (${JSON.stringify(name)} === 'kubectl' && verb === 'apply') {
  const file = args[args.indexOf('-f') + 1];
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ bin: 'kubectl', manifest: JSON.parse(fs.readFileSync(file, 'utf8')) }) + '\\n');
}
process.stdout.write('ok\\n');
`;

let env: BlackboxEnv;
let dir: string;
let stateDir: string;
let cleanup: () => Promise<void>;
let logPath: string;
let modePath: string;
const ORIGINAL_PATH = process.env['PATH'];

function install(name: string): void {
  const js = join(dir, `${name}.cjs`);
  writeFileSync(js, FAKE(name, logPath, modePath));
  const bin = join(dir, 'bin', name);
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} "$@"\n`);
  chmodSync(bin, 0o755);
}

type LogLine = { bin: string; args?: string[]; manifest?: Record<string, any> };
const log = (): LogLine[] => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogLine) : []);
const argvs = (bin: string) => log().filter((l) => l.bin === bin && l.args).map((l) => l.args!);
const reset = (mode: Record<string, unknown> = {}) => {
  writeFileSync(logPath, '');
  writeFileSync(modePath, JSON.stringify(mode));
};

before(async () => {
  const d = await tempDir('ht-bb-faults-');
  dir = d.path;
  cleanup = d.cleanup;
  stateDir = join(dir, 'state');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  logPath = join(dir, 'argv.jsonl');
  modePath = join(dir, 'mode.json');
  install('docker');
  install('kubectl');
  // the fakes are found on PATH by the adapters AND by the detached reverters (which inherit the environment)
  process.env['PATH'] = `${join(dir, 'bin')}:${ORIGINAL_PATH ?? ''}`;
  env = await openBlackboxEnv({
    clock: 'system',
    environments: [
      { environmentId: 'env_docker', environmentClass: 'local', generation: 1, control: { kind: 'docker', target: 'shop-api' } },
      { environmentId: 'env_docker2', environmentClass: 'local', generation: 1, control: { kind: 'docker', target: 'shop-db' } },
      { environmentId: 'env_k8s', environmentClass: 'local', generation: 1, control: { kind: 'kubectl', target: 'deployment/checkout', namespace: 'shop', context: 'kind-test' } },
      { environmentId: 'env_proc', environmentClass: 'local', generation: 1, control: { kind: 'process', target: 'http://127.0.0.1:9' } },
    ],
  });
});

after(async () => {
  process.env['PATH'] = ORIGINAL_PATH;
  // no reverter may outlive the tests
  for (const id of existsSync(join(stateDir, 'faults')) ? readdirSync(join(stateDir, 'faults')) : []) {
    const pidFile = join(faultJobDir(stateDir, id), 'pid');
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        // already exited
      }
    }
  }
  await env.dispose();
  await cleanup();
});

function adapters() {
  const all = builtinSideEffectAdapters({ stateDir, environments: env.environments });
  return { all, control: all.find((a) => a.adapterId === 'env.control')!, docker: all.find((a) => a.adapterId === 'env.docker') as DockerEnvAdapter };
}

const fault = (input: EnvFaultInput) => sideEffectRequest(envInjectFaultTool() as ToolSpec, input, env.environments, nextInvocationId());
const opCtx = (operationId: string, environmentId: string): OperationContext =>
  ({ operation: { operationId, operationType: 'env.inject_fault', target: { resourceKey: `env/${environmentId}` } }, signal: new AbortController().signal }) as unknown as OperationContext;

test('docker pause through the runtime: applied once, ledgered verified with effectUntil, reverted by the detached reverter at expiry', async () => {
  reset();
  const { all } = adapters();
  const { gateway, ledger } = newGateway(env, all);
  const runtime = newRuntime(env, blackboxTools({ stateDir }), gateway);
  const out = await runtime.execute(toolRequest('env.inject_fault', { environmentId: 'env_docker', kind: 'pause', params: {}, durationMs: 900 }));
  assert.equal(out.status, 'success', out.modelText);
  const s = structuredOf(out);
  assert.equal(s['fault'], 'pause');
  assert.equal(s['state'], 'active');
  assert.ok(Date.parse(s['expiresAt']) > Date.now() - 1000);
  assert.deepEqual(argvs('docker'), [['pause', 'shop-api']], 'applied exactly once, nothing reverted yet');
  const ops = await ledger.list({ runId: 'run_bb' });
  const op = ops.find((o) => o.operationType === 'env.inject_fault' && o.target.resourceKey === 'env/env_docker')!;
  assert.equal(op.status, 'verified');
  assert.equal((op.result as { effectUntil?: string }).effectUntil, s['expiresAt'], 'the effect window is recorded on the operation (the lease is held until then)');

  // while it is in force, a second fault on the same environment is refused (one fault at a time)
  await assert.rejects(gateway.run(fault({ environmentId: 'env_docker', kind: 'kill', params: {}, durationMs: 100 })), (e: unknown) => isHypertestError(e, 'precondition_failed') && /still under the pause fault/.test((e as Error).message));

  const job = await waitFor(() => {
    const v = readFaultJob(stateDir, op.operationId);
    return v.state === 'reverted' ? v : undefined;
  }, 10_000, 50, 'the reverter');
  assert.equal(job.outcome.by, 'reverter');
  assert.deepEqual(argvs('docker'), [['pause', 'shop-api'], ['unpause', 'shop-api']]);
  assert.ok(Date.parse(job.outcome.revertedAt) >= Date.parse(s['expiresAt']), 'not reverted before its time box ended');
  // the adapter now observes the reverted job
  const obs = await adapters().docker.observe(opCtx(op.operationId, 'env_docker'));
  assert.equal(obs.state, 'present');
  assert.equal((obs as { observation: { state: string } }).observation.state, 'reverted');
});

test('docker plans: kill, network_disconnect and netem argv (no shell); invalid params and process kinds refused', async () => {
  assert.deepEqual(dockerFaultPlan('docker', 'shop-api', 'kill', {}).revert.map((c) => c.argv), [['docker', 'start', 'shop-api']]);
  const nd = dockerFaultPlan('docker', 'shop-api', 'network_disconnect', { network: 'shop_net' });
  assert.deepEqual([nd.apply, nd.revert.map((c) => c.argv)], [[['docker', 'network', 'disconnect', 'shop_net', 'shop-api']], [['docker', 'network', 'connect', 'shop_net', 'shop-api']]]);
  const ne = dockerFaultPlan('docker', 'shop-api', 'netem', { delayMs: 200, jitterMs: 20, lossPct: 5 });
  assert.deepEqual(ne.apply, [['docker', 'exec', 'shop-api', 'tc', 'qdisc', 'add', 'dev', 'eth0', 'root', 'netem', 'delay', '200ms', '20ms', 'loss', '5%']]);
  assert.deepEqual(ne.revert.map((c) => c.argv), [['docker', 'exec', 'shop-api', 'tc', 'qdisc', 'del', 'dev', 'eth0', 'root', 'netem']]);
  assert.throws(() => dockerFaultPlan('docker', 'c', 'network_disconnect', { network: 'x; rm -rf /' }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  assert.throws(() => dockerFaultPlan('docker', 'c', 'netem', { interface: '$(id)', delayMs: 1 }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  assert.throws(() => dockerFaultPlan('docker', 'c', 'netem', {}), (e: unknown) => isHypertestError(e, 'invalid_argument'));

  reset();
  const { gateway } = newGateway(env, adapters().all);
  await assert.rejects(gateway.run(fault({ environmentId: 'env_docker2', kind: 'latency', params: { ms: 1 }, durationMs: 100 })), (e: unknown) => isHypertestError(e, 'unsupported'));
  await assert.rejects(gateway.run(fault({ environmentId: 'env_docker2', kind: 'scale_zero', params: {}, durationMs: 100 })), (e: unknown) => isHypertestError(e, 'unsupported'));
  await assert.rejects(gateway.run(fault({ environmentId: 'env_proc', kind: 'pause', params: {}, durationMs: 100 })), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  assert.deepEqual(argvs('docker'), [], 'nothing was run for refused faults');

  const netem = await gateway.run(fault({ environmentId: 'env_docker2', kind: 'netem', params: { delayMs: 150, lossPct: 2.5 }, durationMs: 400 }));
  assert.equal(netem.status, 'verified', JSON.stringify(netem));
  await waitFor(() => readFaultJob(stateDir, netem.operation.operationId).state === 'reverted', 10_000, 50, 'netem revert');
  assert.deepEqual(argvs('docker'), [
    ['exec', 'shop-db', 'tc', 'qdisc', 'add', 'dev', 'eth0', 'root', 'netem', 'delay', '150ms', 'loss', '2.5%'],
    ['exec', 'shop-db', 'tc', 'qdisc', 'del', 'dev', 'eth0', 'root', 'netem'],
  ]);
});

test('docker: a refused apply is not_applied (no reverter, nothing to revert)', async () => {
  reset({ fail: ['kill'] });
  const { gateway } = newGateway(env, adapters().all);
  const out = await gateway.run(fault({ environmentId: 'env_docker2', kind: 'kill', params: {}, durationMs: 200 }));
  assert.equal(out.status, 'not_applied', JSON.stringify(out));
  assert.match((out as { reason: string }).reason, /docker kill shop-db … failed \(exit 1\).*refused by the fake/);
  assert.equal(readFaultJob(stateDir, out.operation.operationId).state, 'not_applied');
  assert.equal(existsSync(join(faultJobDir(stateDir, out.operation.operationId), 'pid')), false, 'no reverter was started');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(argvs('docker'), [['kill', 'shop-db']], 'no start (revert) for a fault that never applied');
});

test('docker: a failed revert is revert_failed — observed as failed, and the environment refuses further operations until repaired', async (t) => {
  reset({ fail: ['unpause'] });
  const { gateway } = newGateway(env, adapters().all);
  const out = await gateway.run(fault({ environmentId: 'env_docker2', kind: 'pause', params: {}, durationMs: 300 }));
  assert.equal(out.status, 'verified');
  const opId = out.operation.operationId;
  t.after(() => execFileSync('rm', ['-rf', faultJobDir(stateDir, opId)]));
  await waitFor(() => readFaultJob(stateDir, opId).state === 'revert_failed', 10_000, 50, 'revert_failed');
  const { docker } = adapters();
  const obs = await docker.observe(opCtx(opId, 'env_docker2'));
  const verdict = await docker.verify((obs as { observation: any }).observation, '', opCtx(opId, 'env_docker2'));
  assert.equal(verdict.status, 'failed');
  assert.match((verdict as { reason: string }).reason, /revert FAILED.*unpause shop-db.*refused by the fake/);
  await assert.rejects(
    gateway.run(sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_docker2', reason: 'x' }, env.environments, nextInvocationId())),
    (e: unknown) => isHypertestError(e, 'precondition_failed') && /could not be reverted/.test((e as Error).message),
  );
  assert.equal(argvs('docker').filter((a) => a[0] === 'restart').length, 0, 'no restart on an environment in an unknown state');
  // the operator repairs the environment and removes the fault job: operations resume
  execFileSync('rm', ['-rf', faultJobDir(stateDir, opId)]);
  assert.deepEqual(await unrevertedFaults(stateDir, 'env_docker2'), []);
});

test('docker: the reverter is gone (killed) — the adapter reverts the overdue fault itself before the next operation', async () => {
  reset();
  const { gateway } = newGateway(env, adapters().all);
  const out = await gateway.run(fault({ environmentId: 'env_docker2', kind: 'pause', params: {}, durationMs: 1500 }));
  assert.equal(out.status, 'verified');
  const jobDir = faultJobDir(stateDir, out.operation.operationId);
  const pid = Number(await waitFor(() => (existsSync(join(jobDir, 'pid')) ? readFileSync(join(jobDir, 'pid'), 'utf8') : undefined), 5000, 20, 'reverter pid'));
  process.kill(pid, 'SIGKILL');
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 5000, 20, 'reverter gone');
  await new Promise((r) => setTimeout(r, Math.max(0, Date.parse((readFaultJob(stateDir, out.operation.operationId) as { spec: { expiresAt: string } }).spec.expiresAt) - Date.now() + 50)));
  assert.equal(readFaultJob(stateDir, out.operation.operationId).state, 'active', 'overdue, nobody reverted it yet');
  const restart = await gateway.run(sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_docker2', reason: 'after the fault' }, env.environments, nextInvocationId()));
  const job = readFaultJob(stateDir, out.operation.operationId);
  assert.equal(job.state, 'reverted');
  assert.equal((job as { outcome: { by: string } }).outcome.by, 'adapter');
  const cmds = argvs('docker').map((a) => a[0]);
  assert.deepEqual(cmds.slice(0, 3), ['pause', 'unpause', 'restart'], 'reverted before the restart ran');
  assert.ok(restart.operation.operationType === 'env.restart');
});

test('env.control crash after the fault was applied: reconciled by operation id (job directory), never applied twice', async () => {
  reset();
  const a1 = adapters();
  const crashing = new CrashAfterDispatch<EnvInput, unknown>(a1.control as never);
  const g1 = newGateway(env, [crashing]);
  const req = fault({ environmentId: 'env_docker2', kind: 'pause', params: {}, durationMs: 600 });
  void g1.gateway.run(req);
  await crashing.reached;
  assert.deepEqual(argvs('docker'), [['pause', 'shop-db']]);
  const g2 = newGateway(env, adapters().all);
  const out = await g2.gateway.run({ ...req, signal: new AbortController().signal });
  assert.equal(out.status, 'verified', JSON.stringify(out));
  assert.deepEqual(argvs('docker').filter((a) => a[0] === 'pause'), [['pause', 'shop-db']], 'one pause only');
  await waitFor(() => readFaultJob(stateDir, out.operation.operationId).state === 'reverted', 10_000, 50, 'revert');
});

test('kubectl: pod_delete, scale_zero, network_deny with the environment context; reverted at expiry', async () => {
  reset();
  const { gateway } = newGateway(env, adapters().all);
  const prefix = ['--context', 'kind-test', '-n', 'shop'];

  const scale = await gateway.run(fault({ environmentId: 'env_k8s', kind: 'scale_zero', params: {}, durationMs: 300 }));
  assert.equal(scale.status, 'verified', JSON.stringify(scale));
  await waitFor(() => readFaultJob(stateDir, scale.operation.operationId).state === 'reverted', 10_000, 50, 'scale revert');
  assert.deepEqual(argvs('kubectl'), [
    [...prefix, 'get', 'deployment', 'checkout', '-o', 'json'],
    [...prefix, 'scale', 'deployment/checkout', '--replicas=0'],
    [...prefix, 'scale', 'deployment/checkout', '--replicas=3'],
    [...prefix, 'rollout', 'status', 'deployment/checkout', '--timeout=180s'],
  ], 'scaled back to the 3 replicas read before the fault');

  reset();
  const del = await gateway.run(fault({ environmentId: 'env_k8s', kind: 'pod_delete', params: {}, durationMs: 200 }));
  assert.equal(del.status, 'verified');
  await waitFor(() => readFaultJob(stateDir, del.operation.operationId).state === 'reverted', 10_000, 50, 'pod_delete revert');
  assert.deepEqual(argvs('kubectl').slice(1), [[...prefix, 'delete', 'pod', '-l', 'app=checkout', '--wait=false'], [...prefix, 'rollout', 'status', 'deployment/checkout', '--timeout=180s']]);

  reset();
  const deny = await gateway.run(fault({ environmentId: 'env_k8s', kind: 'network_deny', params: {}, durationMs: 200 }));
  assert.equal(deny.status, 'verified');
  await waitFor(() => readFaultJob(stateDir, deny.operation.operationId).state === 'reverted', 10_000, 50, 'network_deny revert');
  const manifest = log().find((l) => l.manifest)!.manifest!;
  const name = manifest['metadata']['name'] as string;
  assert.match(name, /^ht-deny-/);
  assert.deepEqual([manifest['kind'], manifest['metadata']['namespace'], manifest['metadata']['annotations']['hypertest.io/operation-id'], manifest['spec']], [
    'NetworkPolicy', 'shop', deny.operation.operationId, { podSelector: { matchLabels: { app: 'checkout' } }, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] },
  ]);
  const k = argvs('kubectl');
  assert.deepEqual(k[1]!.slice(0, 6), [...prefix, 'apply', '-f']);
  assert.deepEqual(k[2], [...prefix, 'delete', 'networkpolicy', name, '--ignore-not-found']);
  assert.throws(() => kubectlFaultPlan(['kubectl'], 'checkout', 'pause', { replicas: 1, selector: { app: 'x' }, operationId: 'op_1', namespace: 'n', policyFile: '/dev/null' }), (e: unknown) => isHypertestError(e, 'unsupported'));
});

test('without a state directory container faults are refused (unsupported), never applied untracked', async () => {
  reset();
  const docker = new DockerEnvAdapter({ environments: env.environments });
  const kubectl = new KubectlEnvAdapter({ environments: env.environments });
  const control = new EnvControlAdapter({ environments: env.environments, backends: { docker, kubectl } });
  const { gateway } = newGateway(env, [control]);
  await assert.rejects(gateway.run(fault({ environmentId: 'env_docker2', kind: 'pause', params: {}, durationMs: 100 })), (e: unknown) => isHypertestError(e, 'unsupported'));
  await assert.rejects(gateway.run(fault({ environmentId: 'env_k8s', kind: 'scale_zero', params: {}, durationMs: 100 })), (e: unknown) => isHypertestError(e, 'unsupported'));
  assert.deepEqual(argvs('docker'), []);
});

const hasBinary = (bin: string) => (ORIGINAL_PATH ?? '').split(':').some((d) => d && existsSync(join(d, bin)));

test('LIVE docker: pause/unpause a real container', (t) => {
  if (!hasBinary('docker')) return t.skip('docker CLI is not installed on this host: live docker fault injection is not exercised here (the fake-binary tests above cover the argv and lifecycle)');
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', env: { ...process.env, PATH: ORIGINAL_PATH } });
  } catch {
    return t.skip('no reachable docker daemon on this host: live docker fault injection is not exercised here');
  }
  return t.skip('a docker daemon is reachable, but the live test needs HYPERTEST_LIVE_DOCKER_CONTAINER (a disposable container) to be set');
});

test('LIVE kubectl: scale_zero on a real cluster', (t) => {
  if (!hasBinary('kubectl')) return t.skip('kubectl is not installed on this host: live Kubernetes fault injection is not exercised here (the fake-binary tests above cover the argv and lifecycle)');
  return t.skip('kubectl is installed, but the live test needs HYPERTEST_LIVE_K8S_DEPLOYMENT (a disposable deployment) to be set');
});
