import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHypertestError } from '@hypertest/core';
import type { OperationRecord } from '@hypertest/domain';
import type { OperationContext } from '@hypertest/operation';
import {
  CONTROL_TOKEN_HEADER, EnvControlAdapter, ProcessEnvAdapter, blackboxTools, builtinSideEffectAdapters, createEnvironmentRegistry, envDeployTool, envRestartTool, httpRequestTool, loadStartTool,
  PROCESS_SUPERVISOR_CLI_PATH, startProcessSupervisor, type EnvInput, type ProcessSupervisor, type SupervisorOperation, type ToolSpec,
} from '../src/index.ts';
import { CrashAfterDispatch, fakeContext, newGateway, newRuntime, nextInvocationId, openBlackboxEnv, sideEffectRequest, structuredOf, tempDir, toolRequest, waitFor, type BlackboxEnv } from './blackbox-helpers.ts';

const CHILD = `
import http from 'node:http';
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ pid: process.pid, buildRef: process.env.BUILD_REF ?? null, path: req.url }));
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

let env: BlackboxEnv;
let sup: ProcessSupervisor;
let cleanup: () => Promise<void>;
let childScript: string;

async function getJson(url: string): Promise<{ status: number; body: any; ms: number }> {
  const t = Date.now();
  const res = await fetch(url);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: res.status, body, ms: Date.now() - t };
}

before(async () => {
  const d = await tempDir('ht-bb-sup-');
  cleanup = d.cleanup;
  childScript = join(d.path, 'child.mjs');
  await writeFile(childScript, CHILD);
  sup = await startProcessSupervisor({ command: [process.execPath, childScript], readyTimeoutMs: 10_000, killGraceMs: 1000 });
  env = await openBlackboxEnv({
    environments: [{ environmentId: 'env_proc', environmentClass: 'local', generation: 1, baseUrl: sup.url, control: { kind: 'process', target: sup.controlUrl } }],
  });
});

after(async () => {
  await sup.close();
  await env.dispose();
  await cleanup();
});

test('process supervisor: proxies to the child, restarts idempotently per operation id, answers lookups, survives a child crash', async () => {
  const first = await getJson(`${sup.url}/hello`);
  assert.equal(first.status, 200);
  assert.equal(first.body.path, '/hello');
  assert.equal(first.body.pid, sup.childPid);
  const gen0 = sup.generation;

  const post = (id: string, body: unknown = {}) =>
    fetch(`${sup.controlBaseUrl}/restart`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hypertest-operation': id, [CONTROL_TOKEN_HEADER]: sup.controlToken }, body: JSON.stringify(body) });
  const [a, b] = await Promise.all([post('op_sup_r1'), post('op_sup_r1')]);
  const ra = (await a.json()) as { state: string; generation: number; restartId: string };
  const rb = (await b.json()) as { state: string; generation: number; restartId: string };
  assert.equal(ra.state, 'completed');
  assert.deepEqual(rb, ra, 'a duplicate request returns the same operation record');
  assert.equal(sup.generation, gen0 + 1, 'restarted exactly once');
  const again = (await (await post('op_sup_r1')).json()) as { restartId: string };
  assert.equal(again.restartId, ra.restartId);
  assert.equal(sup.generation, gen0 + 1);
  const after1 = await getJson(`${sup.url}/`);
  assert.notEqual(after1.body.pid, first.body.pid);

  assert.equal((await getJson(`${sup.controlBaseUrl}/operations/op_sup_r1`)).body.state, 'completed');
  assert.equal((await getJson(`${sup.controlBaseUrl}/operations/op_unknown`)).status, 404);
  assert.equal((await post('op_bad', { env: { LD_PRELOAD: '/evil.so' } })).status, 400, 'only allowlisted env overrides');
  assert.equal((await post('bad id with spaces')).status, 400);
  const conflict = await fetch(`${sup.controlBaseUrl}/faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hypertest-operation': 'op_sup_r1', [CONTROL_TOKEN_HEADER]: sup.controlToken },
    body: JSON.stringify({ kind: 'latency', params: { ms: 1 }, durationMs: 10 }),
  });
  assert.equal(conflict.status, 409);

  await sup.killChild();
  assert.equal(sup.childRunning, false);
  assert.equal((await getJson(`${sup.url}/`)).status, 502);
  const back = await sup.restart({ operationId: 'op_sup_r2' });
  assert.equal(back.state, 'completed');
  assert.equal((await getJson(`${sup.url}/`)).status, 200);
});

test('env.restart through the ToolRuntime: verified restart bumps the environment generation (stale snapshots)', async () => {
  const d = await tempDir('ht-bb-sup-state-');
  try {
    const { gateway, ledger } = newGateway(env, builtinSideEffectAdapters({ stateDir: d.path, environments: env.environments }));
    const runtime = newRuntime(env, blackboxTools({ stateDir: d.path }), gateway);
    const before = env.environments.get('env_proc')!.generation;
    const pidBefore = (await getJson(`${sup.url}/`)).body.pid;
    const supGen = sup.generation;
    const out = await runtime.execute(toolRequest('env.restart', { environmentId: 'env_proc', reason: 'clear state before the soak test' }));
    assert.equal(out.status, 'success', out.modelText);
    const s = structuredOf(out);
    assert.equal(s['environmentId'], 'env_proc');
    assert.equal(s['action'], 'restart');
    assert.equal(s['generation'], before + 1);
    assert.equal(s['processGeneration'], supGen + 1);
    assert.equal(env.environments.get('env_proc')!.generation, before + 1);
    assert.notEqual((await getJson(`${sup.url}/`)).body.pid, pidBefore);
    const op = (await ledger.get(out.operationId!))!;
    assert.equal(op.status, 'verified');
    assert.equal(op.adapterId, 'env.control');
    assert.equal(op.target.resourceKey, 'env/env_proc');
    // the supervisor recorded the restart under the operation id
    assert.equal((await getJson(`${sup.controlBaseUrl}/operations/${out.operationId}`)).body.state, 'completed');
    // the control token never reaches the ledger (target, receipt) — it is a capability, not data
    assert.equal(op.target.externalId, sup.controlBaseUrl);
    assert.equal(JSON.stringify(op).includes(sup.controlToken), false);
  } finally {
    await d.cleanup();
  }
});

test('CRASH/RECONCILE env.process: a restart whose receipt was lost is found by operation id — never restarted twice', async () => {
  const backend = new ProcessEnvAdapter({ environments: env.environments });
  const crashing = new CrashAfterDispatch<EnvInput, unknown>(new EnvControlAdapter({ environments: env.environments, backends: { process: backend } }));
  const g1 = newGateway(env, [crashing]);
  const invocationId = nextInvocationId();
  const req = sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_proc', reason: 'crash test' }, env.environments, invocationId);
  const supGen = sup.generation;
  const envGen = env.environments.get('env_proc')!.generation;
  void g1.gateway.run(req);
  await crashing.reached;
  assert.equal(sup.generation, supGen + 1, 'the restart happened');
  const stuck = (await g1.ledger.findByToolInvocation(invocationId, 'env.restart'))!;
  assert.equal(stuck.status, 'dispatching');

  const fresh = new EnvControlAdapter({ environments: env.environments, backends: { process: new ProcessEnvAdapter({ environments: env.environments }) } });
  const g2 = newGateway(env, [fresh]);
  const out = await g2.gateway.run({ ...req, signal: new AbortController().signal });
  assert.equal(out.status, 'verified');
  assert.equal(out.operation.operationId, stuck.operationId);
  assert.equal(out.operation.attempt, 1, 'reconciled, not re-dispatched');
  assert.equal(sup.generation, supGen + 1, 'still exactly one restart');
  assert.equal(env.environments.get('env_proc')!.generation, envGen + 1, 'generation bumped once');
});

test('CRASH between the generation bump and the ledger\'s verified: the resumed process re-verifies with a FRESH adapter and gets the recorded bump — one restart, one generation', async () => {
  // verify() bumps (and a persistent registry writes the bump) BEFORE the gateway records `verified`: a process killed in
  // between leaves the operation unsettled, and the reconciliation re-verifies it in a new process (new adapter, no
  // in-process memory of the bump). The registry remembers the bump by operation id, so it is not counted twice.
  const g = newGateway(env, [new EnvControlAdapter({ environments: env.environments, backends: { process: new ProcessEnvAdapter({ environments: env.environments }) } })]);
  const envGen = env.environments.get('env_proc')!.generation;
  const out = await g.gateway.run(sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_proc', reason: 'bump once' }, env.environments, nextInvocationId()));
  assert.equal(out.status, 'verified');
  assert.equal(env.environments.get('env_proc')!.generation, envGen + 1);
  const record = (await getJson(`${sup.controlBaseUrl}/operations/${out.operation.operationId}`)).body as SupervisorOperation;
  const ctx: OperationContext = { operation: out.operation, signal: new AbortController().signal };
  const resumed = new ProcessEnvAdapter({ environments: env.environments });
  const again = await resumed.verify(record, out.operation.desiredStateHash, ctx);
  assert.equal(again.status, 'verified');
  assert.equal((again as { result: { generation: number } }).result.generation, envGen + 1, 'the recorded bump is returned');
  assert.equal(env.environments.get('env_proc')!.generation, envGen + 1, 'the same restart is never counted twice');
  // the registry refuses to attribute one operation's bump to another environment
  env.environments.register({ environmentId: 'env_other_bump', environmentClass: 'local', generation: 1 });
  assert.throws(() => env.environments.bumpGeneration('env_other_bump', undefined, out.operation.operationId), (e: unknown) => isHypertestError(e, 'conflict'));
  assert.equal(env.environments.get('env_other_bump')!.generation, 1);
  // another operation (and an anonymous bump) still moves the generation forward
  assert.equal(env.environments.bumpGeneration('env_proc', undefined, 'op_other_restart').generation, envGen + 2);
  assert.equal(env.environments.bumpGeneration('env_proc').generation, envGen + 3);
  assert.equal(env.environments.bumpGeneration('env_proc').generation, envGen + 4);
});

test('env.deploy: critical risk needs approval through the runtime; the verified deploy sets BUILD_REF and bumps buildDigest', async () => {
  const d = await tempDir('ht-bb-sup-deploy-');
  try {
    const adapters = builtinSideEffectAdapters({ stateDir: d.path, environments: env.environments });
    const { gateway } = newGateway(env, adapters);
    const runtime = newRuntime(env, blackboxTools({ stateDir: d.path }), gateway);
    const supGen = sup.generation;
    const gated = await runtime.execute(toolRequest('env.deploy', { environmentId: 'env_proc', buildRef: 'registry.local/app@sha256:abc123' }));
    assert.equal(gated.status, 'denied');
    assert.equal(gated.error?.code, 'approval_required');
    assert.equal(sup.generation, supGen, 'nothing was deployed without approval');

    const envGen = env.environments.get('env_proc')!.generation;
    const out = await gateway.run(sideEffectRequest(envDeployTool() as ToolSpec, { environmentId: 'env_proc', buildRef: 'registry.local/app@sha256:abc123' }, env.environments, nextInvocationId()));
    assert.equal(out.status, 'verified');
    const result = out.result as Record<string, unknown>;
    assert.equal(result['action'], 'deploy');
    assert.equal(result['buildDigest'], 'registry.local/app@sha256:abc123');
    const desc = env.environments.get('env_proc')!;
    assert.equal(desc.generation, envGen + 1);
    assert.equal(desc.buildDigest, 'registry.local/app@sha256:abc123');
    assert.equal((await getJson(`${sup.url}/`)).body.buildRef, 'registry.local/app@sha256:abc123');
    await assert.rejects(
      gateway.run(sideEffectRequest(envDeployTool() as ToolSpec, { environmentId: 'env_proc', buildRef: '-rf /' }, env.environments, nextInvocationId())),
      (e: unknown) => isHypertestError(e, 'invalid_argument'),
    );
  } finally {
    await d.cleanup();
  }
});

test('env.inject_fault: error_rate and latency are injected by the supervisor proxy for durationMs, then expire', async () => {
  const d = await tempDir('ht-bb-sup-fault-');
  try {
    const { gateway } = newGateway(env, builtinSideEffectAdapters({ stateDir: d.path, environments: env.environments }));
    const runtime = newRuntime(env, blackboxTools({ stateDir: d.path }), gateway);
    const genBefore = env.environments.get('env_proc')!.generation;
    const out = await runtime.execute(toolRequest('env.inject_fault', { environmentId: 'env_proc', kind: 'error_rate', params: { rate: 1, status: 503 }, durationMs: 400 }));
    assert.equal(out.status, 'success', out.modelText);
    assert.equal(structuredOf(out)['action'], 'fault');
    assert.deepEqual(structuredOf(out)['fault'], { kind: 'error_rate', params: { rate: 1, status: 503 } });
    const faulted = await getJson(`${sup.url}/x`);
    assert.equal(faulted.status, 503);
    assert.equal(faulted.body.fault, 'error_rate');
    assert.equal(env.environments.get('env_proc')!.generation, genBefore, 'a fault does not change the build/generation');
    await new Promise((r) => setTimeout(r, 450));
    assert.equal((await getJson(`${sup.url}/x`)).status, 200, 'expired');
    assert.equal((await getJson(`${sup.controlBaseUrl}/operations/${out.operationId}`)).body.state, 'expired');

    const slow = await runtime.execute(toolRequest('env.inject_fault', { environmentId: 'env_proc', kind: 'latency', params: { ms: 300 }, durationMs: 5000 }));
    assert.equal(slow.status, 'success');
    const timed = await getJson(`${sup.url}/y`);
    assert.equal(timed.status, 200);
    assert.ok(timed.ms >= 290, `latency injected (${timed.ms} ms)`);
    sup.clearFaults();
    assert.ok((await getJson(`${sup.url}/y`)).ms < 250);

    // invalid parameters never reach the target
    const adapter = new ProcessEnvAdapter({ environments: env.environments });
    const ctx: OperationContext = { operation: { operationId: 'op_badfault', operationType: 'env.inject_fault' } as OperationRecord, signal: new AbortController().signal };
    await assert.rejects(adapter.prepare(ctx, { environmentId: 'env_proc', kind: 'error_rate', params: { rate: 2 }, durationMs: 100 }), /error rate must be a number in \[0, 1\]/);
    await assert.rejects(adapter.prepare(ctx, { environmentId: 'env_proc', kind: 'latency', params: { ms: 5 }, durationMs: 0 }), /durationMs/);
    const direct = await adapter.dispatch(
      { desiredState: { action: 'fault', environmentId: 'env_proc', target: sup.controlBaseUrl, fault: { kind: 'error_rate', params: { rate: 5 } }, durationMs: 100 }, desiredStateHash: 'h', target: { resourceKey: 'env/env_proc', kind: 'environment' } },
      ctx,
    );
    assert.equal(direct.accepted, false, 'the supervisor rejects invalid faults (definitively not applied)');
  } finally {
    await d.cleanup();
  }
});

test('process-supervisor-cli runs the supervisor as its own process (outlives its launcher) and stops the child on SIGTERM', async () => {
  const cli = fileURLToPath(new URL('../src/blackbox/process-supervisor-cli.ts', import.meta.url));
  assert.equal(PROCESS_SUPERVISOR_CLI_PATH, cli, 'the exported CLI path is the CLI module');
  const proc = spawn(process.execPath, ['--no-warnings', cli, '--port', '0', '--allow-env', 'BUILD_REF', '--control-token', 'cli-fixed-token-0123456789', '--', process.execPath, childScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(proc, 'exit');
  const line = await new Promise<string>((resolve, reject) => {
    let buf = '';
    proc.stdout.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) resolve(buf.slice(0, i));
    });
    void exited.then(([code]) => reject(new Error(`supervisor exited early (${String(code)})`)));
  });
  let info: { url: string; controlUrl: string; controlBaseUrl: string; childPid: number; generation: number };
  try {
    info = JSON.parse(line) as typeof info;
    assert.equal(info.generation, 1);
    assert.equal(info.controlBaseUrl, `${info.url}/__hypertest`);
    assert.equal(info.controlUrl, `${info.url}/__hypertest#token=cli-fixed-token-0123456789`, 'the control target carries the configured token');
    const res = await getJson(`${info.url}/cli`);
    assert.equal(res.status, 200);
    assert.equal(res.body.pid, info.childPid);
    const unauth = await fetch(`${info.controlBaseUrl}/kill`, { method: 'POST' });
    assert.equal(unauth.status, 401);
  } finally {
    proc.kill('SIGTERM'); // never leak the supervisor (and its child) when an assertion fails
  }
  const [code] = await exited;
  assert.equal(code, 0);
  await waitFor(() => {
    try {
      process.kill(info.childPid, 0);
      return false;
    } catch {
      return true;
    }
  }, 5000, 20, 'child exit');
});

test('I1 control plane: the supervisor refuses unauthenticated mutations; probe tools can never reach the control API', async () => {
  const pid = sup.childPid;
  const gen = sup.generation;
  // (1) no / wrong token ⇒ 401 before anything happens; reads stay open
  for (const headers of [{}, { [CONTROL_TOKEN_HEADER]: 'wrong-token-wrong-token' }] as Array<Record<string, string>>) {
    for (const [method, path] of [['POST', '/restart'], ['POST', '/kill'], ['POST', '/faults'], ['DELETE', '/faults']] as const) {
      const res = await fetch(`${sup.controlBaseUrl}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'POST' ? JSON.stringify({ kind: 'error_rate', params: { rate: 1 }, durationMs: 60_000 }) : null });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  }
  assert.equal((await getJson(`${sup.controlBaseUrl}/status`)).status, 200);
  assert.equal(sup.childPid, pid, 'the child was neither killed nor restarted');
  assert.equal(sup.generation, gen);
  assert.equal((await getJson(`${sup.url}/still-up`)).status, 200, 'no fault was injected');

  // (2) http.request (external/medium) must not act as env.restart/env.inject_fault (destructive/high):
  // the control namespace is refused before any request, even with the token and for a raw loopback URL
  const { ctx, evidence } = fakeContext({ environments: env.environments });
  const http = httpRequestTool({});
  const viaEnv = await http.execute({ method: 'POST', environmentId: 'env_proc', path: '/__hypertest/kill', headers: { [CONTROL_TOKEN_HEADER]: sup.controlToken } }, ctx);
  assert.equal(viaEnv.status, 'failed');
  assert.equal(viaEnv.error?.code, 'permission_denied');
  assert.match(viaEnv.error!.message, /reserved environment-control namespace/);
  const viaUrl = await http.execute({ method: 'POST', url: `${sup.controlBaseUrl}/restart` }, ctx);
  assert.equal(viaUrl.error?.code, 'permission_denied');
  const dotted = await http.execute({ method: 'POST', environmentId: 'env_proc', path: '/x/../__hypertest/kill' }, ctx);
  assert.equal(dotted.error?.code, 'permission_denied', 'dot segments are normalized before the check');
  assert.equal(evidence.length, 0, 'nothing was sent');
  // a custom control target on another path is protected the same way
  const custom = createEnvironmentRegistry([{ environmentId: 'env_custom', environmentClass: 'local', generation: 1, baseUrl: 'http://127.0.0.1:9', control: { kind: 'process', target: 'http://127.0.0.1:9/ops/ctl#token=abcdefabcdefabcdef' } }]);
  const customOut = await http.execute({ method: 'POST', environmentId: 'env_custom', path: '/ops/ctl/restart' }, fakeContext({ environments: custom }).ctx);
  assert.equal(customOut.error?.code, 'permission_denied');
  assert.match(customOut.error!.message, /control endpoint of environment env_custom/);
  // load.start refuses the control API as a load target (checked when the runtime derives the target)
  assert.throws(() => (loadStartTool() as ToolSpec).sideEffect!.target({ environmentId: 'env_proc', path: '/__hypertest/restart', method: 'POST', ratePerSecond: 1, durationMs: 100 }, ctx), /reserved environment-control namespace/);
  assert.equal(sup.childPid, pid);
  assert.equal(sup.generation, gen);
});

test('env.process without the control token is definitively not applied (401), never a restart', async () => {
  const noToken = createEnvironmentRegistry([{ environmentId: 'env_proc', environmentClass: 'local', generation: 1, baseUrl: sup.url, control: { kind: 'process', target: sup.controlBaseUrl } }]);
  const d = await tempDir('ht-bb-sup-notoken-');
  try {
    const { gateway } = newGateway(env, builtinSideEffectAdapters({ stateDir: d.path, environments: noToken }));
    const gen = sup.generation;
    const out = await gateway.run(sideEffectRequest(envRestartTool() as ToolSpec, { environmentId: 'env_proc', reason: 'x' }, noToken, nextInvocationId()));
    assert.equal(out.status, 'not_applied');
    assert.match((out as { reason: string }).reason, /HTTP 401/);
    assert.equal(sup.generation, gen);
  } finally {
    await d.cleanup();
  }
});

test('supervisor state file is written synchronously and in order: a completed restart is never persisted as running', async () => {
  const d = await tempDir('ht-bb-sup-statefile-');
  const stateFile = join(d.path, 'supervisor.json');
  const s2 = await startProcessSupervisor({ command: [process.execPath, childScript], stateFile, readyTimeoutMs: 10_000, killGraceMs: 1000 });
  try {
    await s2.restart({ operationId: 'op_state_1' });
    await s2.restart({ operationId: 'op_state_2' });
    // read immediately — no settling delay: the file must already hold the final records
    const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as { operations: Array<{ operationId: string; state: string }> };
    assert.deepEqual(persisted.operations.map((o) => [o.operationId, o.state]), [['op_state_1', 'completed'], ['op_state_2', 'completed']]);
  } finally {
    await s2.close();
  }
  // a supervisor restarted on the same state file answers lookups for the recorded operations
  const s3 = await startProcessSupervisor({ command: [process.execPath, childScript], stateFile, readyTimeoutMs: 10_000, killGraceMs: 1000 });
  try {
    assert.equal(s3.operation('op_state_2')?.state, 'completed');
  } finally {
    await s3.close();
    await d.cleanup();
  }
  await assert.rejects(startProcessSupervisor({ command: [process.execPath, childScript], controlToken: 'short' }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});
