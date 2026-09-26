import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isHypertestError } from '@hypertest/core';
import type { OperationRecord } from '@hypertest/domain';
import type { OperationContext } from '@hypertest/operation';
import {
  DockerEnvAdapter, EnvControlAdapter, KubectlEnvAdapter, blackboxTools, envDeployTool, envInjectFaultTool, envRestartTool, OPERATION_ANNOTATION, type EnvInput, type ToolSpec,
} from '../src/index.ts';
import { CrashAfterDispatch, eventContext, newGateway, newRuntime, nextInvocationId, openBlackboxEnv, sideEffectRequest, structuredOf, tempDir, toolRequest, waitFor, type BlackboxEnv } from './blackbox-helpers.ts';

/**
 * docker and kubectl are replaced by FAKE executables: shell scripts (in a temp dir, passed to the
 * adapters as their configurable binary path) that exec a small node program keeping state in JSON.
 */

const FAKE_DOCKER = (statePath: string) => `
const fs = require('fs');
const STATE = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const args = process.argv.slice(2);
state.log.push(args);
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const nano = () => new Date().toISOString().replace('Z', '123456Z');
if (args[0] === 'restart') {
  const name = args[1];
  const c = state.containers[name];
  if (!c) { save(); process.stderr.write('Error response from daemon: No such container: ' + name + '\\n'); process.exit(1); }
  if (state.mode.restartFail) { save(); process.stderr.write('Error response from daemon: Cannot restart container ' + name + ': driver failed\\n'); process.exit(1); }
  c.State.StartedAt = nano();
  c.State.Status = state.mode.statusAfterRestart || 'running';
  c.State.Running = c.State.Status === 'running';
  save();
  process.stdout.write(name + '\\n');
  process.exit(0);
}
if (args[0] === 'inspect') {
  const name = args[args.length - 1];
  const c = state.containers[name];
  save();
  if (!c) { process.stdout.write('[]\\n'); process.stderr.write('Error: No such object: ' + name + '\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify([c]) + '\\n');
  process.exit(0);
}
save();
process.stderr.write('fake docker: unsupported ' + args.join(' ') + '\\n');
process.exit(2);
`;

const FAKE_KUBECTL = (statePath: string) => `
const fs = require('fs');
const STATE = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
let args = process.argv.slice(2);
state.log.push(args);
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
let ns = 'default';
if (args[0] === '-n') { ns = args[1]; args = args.slice(2); }
const key = ns + '/' + args[2];
const d = state.deployments[key];
const notFound = () => { save(); process.stderr.write('Error from server (NotFound): deployments.apps "' + args[2] + '" not found\\n'); process.exit(1); };
const complete = (dep) => {
  const r = dep.spec.replicas ?? 1;
  dep.status = { observedGeneration: dep.metadata.generation, replicas: r, updatedReplicas: r, availableReplicas: r, readyReplicas: r, conditions: [{ type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' }] };
};
if (args[0] === 'get' && args[1] === 'deployment') {
  if (!d) notFound();
  if (state.mode.pendingGets > 0) {
    state.mode.pendingGets--;
    if (state.mode.pendingGets === 0) complete(d);
  }
  save();
  process.stdout.write(JSON.stringify(d) + '\\n');
  process.exit(0);
}
if (args[0] === 'patch' && args[1] === 'deployment') {
  if (!d) notFound();
  const patch = JSON.parse(args[args.indexOf('-p') + 1]);
  const before = JSON.stringify(d.spec.template);
  Object.assign(d.metadata.annotations = d.metadata.annotations || {}, (patch.metadata || {}).annotations || {});
  const t = (patch.spec || {}).template || {};
  const tm = d.spec.template.metadata = d.spec.template.metadata || {};
  Object.assign(tm.annotations = tm.annotations || {}, (t.metadata || {}).annotations || {});
  for (const c of ((t.spec || {}).containers || [])) {
    const cur = d.spec.template.spec.containers.find((x) => x.name === c.name);
    if (cur) Object.assign(cur, c); else d.spec.template.spec.containers.push(c);
  }
  if (JSON.stringify(d.spec.template) !== before) {
    d.metadata.generation++;
    state.patches++;
    const r = d.spec.replicas ?? 1;
    if (state.mode.rollout === 'instant') complete(d);
    else if (state.mode.rollout === 'deadline') d.status = { observedGeneration: d.metadata.generation, replicas: r * 2, updatedReplicas: 1, availableReplicas: r, readyReplicas: r, conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }] };
    else { d.status = { observedGeneration: d.metadata.generation - 1, replicas: r, updatedReplicas: 0, availableReplicas: r, readyReplicas: r }; state.mode.pendingGets = state.mode.progressiveGets; }
  }
  save();
  process.stdout.write('deployment.apps/' + args[2] + ' patched\\n');
  process.exit(0);
}
save();
process.stderr.write('fake kubectl: unsupported ' + args.join(' ') + '\\n');
process.exit(2);
`;

let env: BlackboxEnv;
let dir: string;
let cleanup: () => Promise<void>;
let dockerBin: string;
let kubectlBin: string;
let dockerState: string;
let kubectlState: string;

async function installFake(name: string, program: string): Promise<string> {
  const js = join(dir, `${name}.cjs`);
  await writeFile(js, program);
  const bin = join(dir, 'bin', name);
  await writeFile(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} "$@"\n`);
  await chmod(bin, 0o755);
  return bin;
}

const readState = async (p: string) => JSON.parse(await readFile(p, 'utf8')) as any;
const writeState = (p: string, s: unknown) => writeFile(p, JSON.stringify(s, null, 2));

async function resetDocker(mode: Record<string, unknown> = {}): Promise<void> {
  await writeState(dockerState, {
    containers: { 'shop-api': { Id: 'c0ffee', Name: '/shop-api', State: { Status: 'running', Running: true, StartedAt: '2020-01-01T00:00:00.000000000Z' } } },
    mode,
    log: [],
  });
}

function deployment(name: string) {
  return {
    metadata: { name, generation: 1, annotations: {} },
    spec: { replicas: 2, template: { metadata: { annotations: {} }, spec: { containers: [{ name: 'app', image: 'shop:1' }, { name: 'sidecar', image: 'proxy:1' }] } } },
    status: { observedGeneration: 1, replicas: 2, updatedReplicas: 2, availableReplicas: 2, readyReplicas: 2 },
  };
}

async function resetKubectl(mode: Record<string, unknown> = { rollout: 'instant' }): Promise<void> {
  await writeState(kubectlState, { deployments: { 'shop/checkout': deployment('checkout') }, mode, log: [], patches: 0 });
}

before(async () => {
  const d = await tempDir('ht-bb-envcli-');
  dir = d.path;
  cleanup = d.cleanup;
  await import('node:fs/promises').then((f) => f.mkdir(join(dir, 'bin')));
  dockerState = join(dir, 'docker-state.json');
  kubectlState = join(dir, 'kubectl-state.json');
  dockerBin = await installFake('docker', FAKE_DOCKER(dockerState));
  kubectlBin = await installFake('kubectl', FAKE_KUBECTL(kubectlState));
  env = await openBlackboxEnv({
    environments: [
      { environmentId: 'env_docker', environmentClass: 'local', generation: 1, control: { kind: 'docker', target: 'shop-api' } },
      { environmentId: 'env_ghost', environmentClass: 'local', generation: 1, control: { kind: 'docker', target: 'ghost' } },
      { environmentId: 'env_k8s', environmentClass: 'local', generation: 1, control: { kind: 'kubectl', target: 'deployment/checkout', namespace: 'shop' } },
      { environmentId: 'env_k8s_missing', environmentClass: 'local', generation: 1, control: { kind: 'kubectl', target: 'nope', namespace: 'shop' } },
      { environmentId: 'env_k8s_app', environmentClass: 'local', generation: 1, control: { kind: 'kubectl', target: 'deployment/checkout/app', namespace: 'shop' } },
      { environmentId: 'env_k8s_nocontainer', environmentClass: 'local', generation: 1, control: { kind: 'kubectl', target: 'deployment/checkout/ghost', namespace: 'shop' } },
      { environmentId: 'env_k8s_bad', environmentClass: 'local', generation: 1, control: { kind: 'kubectl', target: 'deployment/checkout/app/extra', namespace: 'shop' } },
    ],
  });
});

after(async () => {
  await env.dispose();
  await cleanup();
});

function adapters() {
  const docker = new DockerEnvAdapter({ environments: env.environments, docker: dockerBin });
  const kubectl = new KubectlEnvAdapter({ environments: env.environments, kubectl: kubectlBin });
  const control = new EnvControlAdapter({ environments: env.environments, backends: { docker, kubectl } });
  return { docker, kubectl, control };
}

const restarts = (s: any) => s.log.filter((a: string[]) => a[0] === 'restart').length;

test('docker: env.restart through the runtime restarts once, observes StartedAt after dispatch, bumps the generation', async () => {
  await resetDocker();
  const { control, docker } = adapters();
  const { gateway } = newGateway(env, [control, docker]);
  const runtime = newRuntime(env, blackboxTools({ stateDir: dir }), gateway);
  const gen = env.environments.get('env_docker')!.generation;
  const out = await runtime.execute(toolRequest('env.restart', { environmentId: 'env_docker', reason: 'reset' }));
  assert.equal(out.status, 'success', out.modelText);
  assert.equal(structuredOf(out)['container'], 'shop-api');
  assert.equal(structuredOf(out)['generation'], gen + 1);
  assert.equal(env.environments.get('env_docker')!.generation, gen + 1);
  const s = await readState(dockerState);
  assert.equal(restarts(s), 1);
  assert.deepEqual(s.log[0], ['restart', 'shop-api']);
  assert.deepEqual(s.log[1], ['inspect', '--type', 'container', 'shop-api']);
});

test('docker: unknown container ⇒ not_applied; deploy/fault are unsupported for docker', async () => {
  await resetDocker();
  const { control } = adapters();
  const { gateway } = newGateway(env, [control]);
  const out = await gateway.run(sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_ghost', reason: 'x' }, env.environments, nextInvocationId()));
  assert.equal(out.status, 'not_applied');
  assert.match((out as { reason: string }).reason, /no such container ghost/);
  await assert.rejects(gateway.run(sideEffectRequest(envDeployTool() as ToolSpec, { environmentId: 'env_docker', buildRef: 'img:2' }, env.environments, nextInvocationId())), (e: unknown) => isHypertestError(e, 'unsupported'));
  await assert.rejects(
    gateway.run(sideEffectRequest(envInjectFaultTool() as ToolSpec, { environmentId: 'env_docker', kind: 'latency', params: { ms: 1 }, durationMs: 10 }, env.environments, nextInvocationId())),
    (e: unknown) => isHypertestError(e, 'unsupported'),
  );
  const log = (await readState(dockerState)).log as string[][];
  assert.deepEqual(log.filter((a) => a[0] === 'restart'), [['restart', 'ghost']], 'only the rejected ghost restart was attempted');
});

test('docker CRASH without receipt ⇒ manual_review, never a blind second restart (standalone and via env.control)', async () => {
  for (const via of ['standalone', 'control'] as const) {
    await resetDocker();
    const a1 = adapters();
    const crashing = new CrashAfterDispatch<EnvInput, unknown>(via === 'control' ? a1.control : a1.docker);
    const g1 = newGateway(env, [crashing]);
    const invocationId = nextInvocationId();
    const req = { ...sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_docker', reason: 'x' }, env.environments, invocationId), adapterId: crashing.adapterId };
    void g1.gateway.run(req);
    await crashing.reached;
    assert.equal(restarts(await readState(dockerState)), 1);
    const a2 = adapters();
    const g2 = newGateway(env, [via === 'control' ? a2.control : a2.docker]);
    const out = await g2.gateway.run({ ...req, signal: new AbortController().signal });
    assert.equal(out.status, 'manual_review', `${via}: ${JSON.stringify(out)}`);
    assert.equal(out.operation.status, 'manual_review');
    assert.equal(restarts(await readState(dockerState)), 1, `${via}: no second restart`);
  }
});

test('docker: a failed restart command is outcome_unknown ⇒ manual_review; a container that exits after restart fails verification', async () => {
  await resetDocker({ restartFail: true });
  const { docker, control } = adapters();
  const g = newGateway(env, [docker, control]);
  const standalone = await g.gateway.run({ ...sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_docker', reason: 'x' }, env.environments, nextInvocationId()), adapterId: 'env.docker' });
  assert.equal(standalone.status, 'manual_review');
  assert.match((standalone as { reason: string }).reason, /cannot look up effects by operationId/);
  const viaControl = await g.gateway.run(sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_docker', reason: 'y' }, env.environments, nextInvocationId()));
  assert.equal(viaControl.status, 'pending', 'env.control first records outcome_unknown');
  assert.equal(viaControl.operation.status, 'outcome_unknown');
  const reconciled = await g.gateway.observe(viaControl.operation.operationId, eventContext(), new AbortController().signal);
  assert.equal(reconciled.status, 'manual_review');
  assert.match((reconciled as { reason: string }).reason, /no dispatch receipt was recorded/);
  assert.equal(restarts(await readState(dockerState)), 2, 'each operation attempted exactly once');

  await resetDocker({ statusAfterRestart: 'exited' });
  const exited = await g.gateway.run(sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_docker', reason: 'z' }, env.environments, nextInvocationId()));
  assert.equal(exited.status, 'failed');
  assert.match((exited as { reason: string }).reason, /container shop-api is exited after the restart/);
});

test('kubectl: env.restart = one atomic annotated patch; verified after rollout; generation bumped', async () => {
  await resetKubectl();
  const { control, kubectl } = adapters();
  const { gateway } = newGateway(env, [control, kubectl]);
  const runtime = newRuntime(env, blackboxTools({ stateDir: dir }), gateway);
  const gen = env.environments.get('env_k8s')!.generation;
  const out = await runtime.execute(toolRequest('env.restart', { environmentId: 'env_k8s', reason: 'rolling restart' }));
  assert.equal(out.status, 'success', out.modelText);
  assert.equal(structuredOf(out)['deployment'], 'checkout');
  assert.equal(structuredOf(out)['namespace'], 'shop');
  assert.equal(structuredOf(out)['generation'], gen + 1);
  const s = await readState(kubectlState);
  assert.equal(s.patches, 1);
  const patchCall = s.log.find((a: string[]) => a.includes('patch'));
  assert.deepEqual(patchCall.slice(0, 7), ['-n', 'shop', 'patch', 'deployment', 'checkout', '--type', 'strategic']);
  const dep = s.deployments['shop/checkout'];
  assert.equal(dep.metadata.annotations[OPERATION_ANNOTATION], out.operationId);
  assert.equal(dep.spec.template.metadata.annotations[OPERATION_ANNOTATION], out.operationId);
  assert.equal(typeof dep.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'], 'string');
});

test('kubectl: progressive rollout is pending until updated replicas are available; deadline exceeded ⇒ failed; missing deployment ⇒ not_applied', async () => {
  await resetKubectl({ rollout: 'progressive', progressiveGets: 3 });
  const { control } = adapters();
  const { gateway } = newGateway(env, [control]);
  const first = await gateway.run(sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_k8s', reason: 'x' }, env.environments, nextInvocationId()));
  assert.equal(first.status, 'pending');
  assert.match(JSON.stringify(first), /rollout spec update not yet observed/);
  const done = await waitFor(async () => {
    const o = await gateway.observe(first.operation.operationId, eventContext(), new AbortController().signal);
    return o.status === 'verified' ? o : undefined;
  }, 5000, 10, 'rollout');
  assert.equal((done.result as { replicas: number }).replicas, 2);
  assert.equal((await readState(kubectlState)).patches, 1);

  await resetKubectl({ rollout: 'deadline' });
  const failed = await gateway.run(sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_k8s', reason: 'x' }, env.environments, nextInvocationId()));
  assert.equal(failed.status, 'failed');
  assert.match((failed as { reason: string }).reason, /exceeded its progress deadline/);

  const missing = await gateway.run(sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_k8s_missing', reason: 'x' }, env.environments, nextInvocationId()));
  assert.equal(missing.status, 'not_applied');
  assert.match((missing as { reason: string }).reason, /shop\/nope not found/);
});

test('kubectl CRASH after the patch: a new gateway finds the rollout by its operation-id annotation (no second patch)', async () => {
  await resetKubectl();
  const a1 = adapters();
  const crashing = new CrashAfterDispatch<EnvInput, unknown>(a1.control);
  const g1 = newGateway(env, [crashing]);
  const invocationId = nextInvocationId();
  const req = sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_k8s', reason: 'x' }, env.environments, invocationId);
  void g1.gateway.run(req);
  await crashing.reached;
  const gen = env.environments.get('env_k8s')!.generation;
  const g2 = newGateway(env, [adapters().control]);
  const out = await g2.gateway.run({ ...req, signal: new AbortController().signal });
  assert.equal(out.status, 'verified');
  assert.equal(out.operation.attempt, 1);
  assert.equal((await readState(kubectlState)).patches, 1);
  assert.equal(env.environments.get('env_k8s')!.generation, gen + 1);

  // the annotation of ANOTHER operation does not count as ours: absent ⇒ (after the lease) not_applied
  const other: OperationContext = { operation: { operationId: 'op_someone_else', operationType: 'env.restart', target: { resourceKey: 'env/env_k8s', kind: 'environment' } } as OperationRecord, signal: new AbortController().signal };
  assert.deepEqual(await a1.kubectl.observe(other), { state: 'absent' });
});

test('kubectl: env.deploy sets the image of the NAMED container only (sidecars untouched), atomically, and records buildDigest', async () => {
  await resetKubectl();
  const { control } = adapters();
  const { gateway } = newGateway(env, [control]);
  // (1) multi-container pod without a named container: refused as definitively not applied — nothing patched
  const genK8s = env.environments.get('env_k8s')!.generation;
  const ambiguous = await gateway.run(sideEffectRequest(envDeployTool() as ToolSpec, { environmentId: 'env_k8s', buildRef: 'registry.local/shop@sha256:feed' }, env.environments, nextInvocationId()));
  assert.equal(ambiguous.status, 'not_applied');
  assert.equal(ambiguous.operation.status, 'not_applied');
  assert.match((ambiguous as { reason: string }).reason, /has 2 containers \(app, sidecar\); name the one to deploy/);
  assert.equal((await readState(kubectlState)).patches, 0, 'a single image was never written over the sidecar');
  assert.equal(env.environments.get('env_k8s')!.generation, genK8s);
  // (2) a container that does not exist: not applied either
  const ghost = await gateway.run(sideEffectRequest(envDeployTool() as ToolSpec, { environmentId: 'env_k8s_nocontainer', buildRef: 'registry.local/shop@sha256:feed' }, env.environments, nextInvocationId()));
  assert.equal(ghost.status, 'not_applied');
  assert.match((ghost as { reason: string }).reason, /has no container ghost/);
  await assert.rejects(
    gateway.run(sideEffectRequest(envDeployTool() as ToolSpec, { environmentId: 'env_k8s_bad', buildRef: 'img:2' }, env.environments, nextInvocationId())),
    (e: unknown) => isHypertestError(e, 'invalid_argument') && /expected \[deployment\/\]<name>\[\/<container>\]/.test(e.message),
  );
  // (3) the named container gets the build; the sidecar keeps its image
  await resetKubectl();
  const gen = env.environments.get('env_k8s_app')!.generation;
  const out = await gateway.run(sideEffectRequest(envDeployTool() as ToolSpec, { environmentId: 'env_k8s_app', buildRef: 'registry.local/shop@sha256:feed' }, env.environments, nextInvocationId()));
  assert.equal(out.status, 'verified', JSON.stringify(out));
  assert.deepEqual((out.result as { images: string[] }).images, ['registry.local/shop@sha256:feed', 'proxy:1']);
  const desc = env.environments.get('env_k8s_app')!;
  assert.equal(desc.generation, gen + 1);
  assert.equal(desc.buildDigest, 'registry.local/shop@sha256:feed');
  const s = await readState(kubectlState);
  assert.equal(s.patches, 1);
  assert.deepEqual(s.log.map((a: string[]) => a[2]), ['get', 'patch', 'get']);
  const patch = JSON.parse(s.log[1][s.log[1].indexOf('-p') + 1]) as { spec: { template: { spec: { containers: unknown[] } } } };
  assert.deepEqual(patch.spec.template.spec.containers, [{ name: 'app', image: 'registry.local/shop@sha256:feed' }]);
  await assert.rejects(
    gateway.run(sideEffectRequest(envInjectFaultTool() as ToolSpec, { environmentId: 'env_k8s', kind: 'latency', params: { ms: 1 }, durationMs: 10 }, env.environments, nextInvocationId())),
    (e: unknown) => isHypertestError(e, 'unsupported'),
  );
});
