import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isHypertestError } from '@hypertest/core';
import type { OperationRecord } from '@hypertest/domain';
import type { OperationContext } from '@hypertest/operation';
import {
  HttpLoadAdapter, HttpLoadStopAdapter, LOADGEN_WORKER_PATH, blackboxTools, builtinSideEffectAdapters, loadJobDir, loadObserveTool, loadStartTool, loadStopTool, observeLoadJob, type LoadJobObservation,
  type LoadStartInput, type ToolSpec,
} from '../src/index.ts';
import {
  AGENT, CrashAfterDispatch, RUN, WORK, allowPermit, eventContext, fakeContext, newGateway, newRuntime, nextInvocationId, openBlackboxEnv, sideEffectRequest, startServer, structuredOf, tempDir, toolRequest,
  waitFor, type BlackboxEnv, type TestServer,
} from './blackbox-helpers.ts';

let env: BlackboxEnv;
let target: TestServer;
const cleanups: Array<() => Promise<void>> = [];
const workers = new Set<number>();

before(async () => {
  target = await startServer((req, res) => {
    // /fail answers 500: the load generator must count it as an error
    res.writeHead(req.url === '/fail' ? 500 : 200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  env = await openBlackboxEnv({ environments: [{ environmentId: 'env_load', environmentClass: 'local', generation: 1, baseUrl: target.url }] });
});

after(async () => {
  for (const pid of workers) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const c of cleanups) await c();
  await target.close();
  await env.dispose();
});

async function stateDir(): Promise<string> {
  const d = await tempDir('ht-bb-load-');
  cleanups.push(d.cleanup);
  return d.path;
}

function hitsFor(operationId: string, path?: string): number {
  return target.requests.filter((r) => r.headers['x-hypertest-operation'] === operationId && (path === undefined || r.url === path)).length;
}

async function trackPid(dir: string, operationId: string): Promise<number> {
  const obs = await waitFor(async () => {
    const o = await observeLoadJob(dir, operationId);
    return o.state === 'present' && o.observation.pid !== undefined ? o.observation : undefined;
  }, 10_000, 20, 'worker pid');
  workers.add(obs.pid!);
  return obs.pid!;
}

const baseInput = (path: string, extra: Partial<LoadStartInput> = {}): LoadStartInput => ({ environmentId: 'env_load', path, method: 'GET', ratePerSecond: 20, durationMs: 1000, concurrency: 4, ...extra });

test('load results report the error rate over completed requests (non-2xx responses are errors), recorded in the metric evidence', async () => {
  const dir = await stateDir();
  const { gateway } = newGateway(env, builtinSideEffectAdapters({ stateDir: dir, environments: env.environments }));
  const runtime = newRuntime(env, blackboxTools({ stateDir: dir }), gateway);
  const start = await runtime.execute(toolRequest('load.start', baseInput('/fail', { ratePerSecond: 10, durationMs: 500 })));
  assert.equal(start.status, 'pending', start.modelText);
  await trackPid(dir, start.operationId!);
  const done = await waitFor(async () => {
    const r = await runtime.execute(toolRequest('load.observe', { operationId: start.operationId! }));
    return r.status === 'success' ? r : undefined;
  }, 15_000, 100, 'load job verification');
  const s = structuredOf(done);
  assert.equal(s['results']['sent'], 5);
  assert.equal(s['results']['errors'], 5);
  assert.equal(s['results']['errorRate'], 1);
  assert.deepEqual(s['results']['statusCodes'], { '500': 5 });
});

test('the results evidence records the environment the job MEASURED (its generation at launch), even when load.observe runs after a restart', async () => {
  // load.observe addresses an operation, not an environment: without the job's environment the SLO numbers would have
  // no provenance anchor (L5 gap: "records neither an environment nor a commit")
  const dir = await stateDir();
  const { gateway } = newGateway(env, builtinSideEffectAdapters({ stateDir: dir, environments: env.environments }));
  const runtime = newRuntime(env, blackboxTools({ stateDir: dir }), gateway);
  const launchGeneration = env.environments.get('env_load')!.generation;
  const start = await runtime.execute(toolRequest('load.start', baseInput('/hit-env', { ratePerSecond: 10, durationMs: 300 })));
  assert.equal(start.status, 'pending', start.modelText);
  await trackPid(dir, start.operationId!);
  const spec = JSON.parse(await readFile(join(loadJobDir(dir, start.operationId!), 'spec.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual([spec['environmentId'], spec['environmentClass'], spec['environmentGeneration']], ['env_load', 'local', launchGeneration]);
  env.environments.bumpGeneration('env_load'); // e.g. an env.restart after the job ran
  const done = await waitFor(async () => {
    const r = await runtime.execute(toolRequest('load.observe', { operationId: start.operationId! }));
    return r.status === 'success' ? r : undefined;
  }, 15_000, 100, 'load job verification');
  const ev = (await env.evidence.get(structuredOf(done)['evidenceId']))!;
  assert.equal(ev.evidenceType, 'metric');
  assert.deepEqual(ev.environment, { environmentId: 'env_load', environmentClass: 'local', generation: launchGeneration });
  // a job against a bare URL names no registered environment: no environment is invented
  const bare = await runtime.execute(toolRequest('load.start', { targetUrl: `${target.url}/hit-bare`, method: 'GET', ratePerSecond: 10, durationMs: 200, concurrency: 2 }));
  assert.equal(bare.status, 'pending', bare.modelText);
  await trackPid(dir, bare.operationId!);
  const bareDone = await waitFor(async () => {
    const r = await runtime.execute(toolRequest('load.observe', { operationId: bare.operationId! }));
    return r.status === 'success' ? r : undefined;
  }, 15_000, 100, 'bare load job verification');
  assert.equal((await env.evidence.get(structuredOf(bareDone)['evidenceId']))!.environment, undefined);
});

test('load.start → pending → load.observe → verified results (20 rps × 1 s) through the ToolRuntime, with metric evidence recorded once', async () => {
  const dir = await stateDir();
  const { gateway, ledger } = newGateway(env, builtinSideEffectAdapters({ stateDir: dir, environments: env.environments }));
  const runtime = newRuntime(env, blackboxTools({ stateDir: dir }), gateway);
  const start = await runtime.execute(toolRequest('load.start', baseInput('/hit-a')));
  assert.equal(start.status, 'pending', start.modelText);
  const opId = start.operationId!;
  assert.match(opId, /^op_/);
  assert.equal(structuredOf(start)['operationStatus'], 'acknowledged');
  await trackPid(dir, opId);

  const first = await runtime.execute(toolRequest('load.observe', { operationId: opId }));
  assert.ok(first.status === 'pending' || first.status === 'success', first.modelText);
  const done = await waitFor(async () => {
    const r = await runtime.execute(toolRequest('load.observe', { operationId: opId }));
    return r.status === 'success' ? r : undefined;
  }, 15_000, 100, 'load job verification');
  const s = structuredOf(done);
  assert.equal(s['state'], 'completed');
  assert.equal(s['results']['sent'], 20);
  assert.equal(s['results']['ok'], 20);
  assert.equal(s['results']['errors'], 0);
  assert.equal(s['results']['errorRate'], 0, 'an error-rate SLO reads the error rate from the results evidence');
  assert.equal(s['results']['planned'], 20);
  assert.equal(typeof s['results']['latencyMs']['p95'], 'number');
  assert.equal(s['results']['histogram']['buckets'].at(-1).count, 20);
  assert.equal(hitsFor(opId, '/hit-a'), 20, 'every request is labelled with the operation id');
  assert.equal(done.evidenceRefs.length, 1);
  const evidenceId = s['evidenceId'];
  assert.deepEqual(done.evidenceRefs, [evidenceId]);

  const again = await runtime.execute(toolRequest('load.observe', { operationId: opId }));
  assert.equal(again.status, 'success');
  assert.equal(structuredOf(again)['evidenceId'], evidenceId, 'results evidence is recorded once per operation');
  const marker = JSON.parse(await import('node:fs/promises').then((f) => f.readFile(join(dir, 'load-evidence', `${opId}.json`), 'utf8'))) as { runId: string; evidenceId: string };
  assert.deepEqual(marker, { runId: RUN, evidenceId }, 'the dedupe marker survives a restart of this process');
  const metricEvidence = await env.evidence.query({ runId: RUN, operationId: opId, evidenceType: 'metric' });
  assert.equal(metricEvidence.length, 1);
  assert.equal((metricEvidence[0]!.structured as Record<string, unknown>)['sent'], 20);
  const op = (await ledger.get(opId))!;
  assert.equal(op.status, 'verified');
  assert.equal(op.attempt, 1);
  assert.equal((await readdir(join(dir, 'loadjobs'))).length, 1);
});

test('CRASH/RECONCILE: a caller that dies after dispatch is re-attached to the SAME job by a new gateway (one job dir, one worker)', async () => {
  const dir = await stateDir();
  const inner = new HttpLoadAdapter({ stateDir: dir, environments: env.environments });
  const crashing = new CrashAfterDispatch<LoadStartInput, LoadJobObservation>(inner, true);
  const g1 = newGateway(env, [crashing]);
  const invocationId = nextInvocationId();
  const input = baseInput('/hit-crash', { durationMs: 500 });
  const req = sideEffectRequest(loadStartTool() as ToolSpec, input, env.environments, invocationId);
  void g1.gateway.run(req); // never settles
  await crashing.reached;
  const stuck = (await g1.ledger.findByToolInvocation(invocationId, 'load.start'))!;
  assert.equal(stuck.status, 'dispatching', 'the receipt was never recorded');
  const pid = await trackPid(dir, stuck.operationId);

  // "restart": new adapter + ledger + gateway on the same database and state dir; the tool call is retried
  const fresh = new HttpLoadAdapter({ stateDir: dir, environments: env.environments });
  const g2 = newGateway(env, [fresh]);
  const retry = await g2.gateway.run({ ...req, signal: new AbortController().signal });
  assert.equal(retry.operation.operationId, stuck.operationId);
  assert.ok(retry.status === 'pending' || retry.status === 'verified', `unexpected ${retry.status}`);
  const verified = await waitFor(async () => {
    const o = await g2.gateway.observe(stuck.operationId, eventContext(), new AbortController().signal);
    return o.status === 'verified' ? o : undefined;
  }, 15_000, 100, 'reattached job verification');
  assert.equal((verified.result as { results: { sent: number } }).results.sent, 10);
  assert.equal(inner.spawned, 1);
  assert.equal(fresh.spawned, 0, 'the restarted caller never launched a second worker');
  assert.deepEqual(await readdir(join(dir, 'loadjobs')), [stuck.operationId]);
  assert.equal(hitsFor(stuck.operationId, '/hit-crash'), 10, 'exactly one job worth of requests');
  const op = (await g2.ledger.get(stuck.operationId))!;
  assert.equal(op.status, 'verified');
  assert.equal(op.attempt, 1, 'never re-dispatched');
  const launch = JSON.parse(await import('node:fs/promises').then((f) => f.readFile(join(loadJobDir(dir, op.operationId), 'launch.json'), 'utf8'))) as { pid: number };
  assert.equal(launch.pid, pid);
});

test('CRASH before the effect: absent job ⇒ not_applied (only once the dispatcher lease is gone), then exactly one dispatch', async () => {
  const dir = await stateDir();
  const inner = new HttpLoadAdapter({ stateDir: dir, environments: env.environments });
  const crashing = new CrashAfterDispatch<LoadStartInput, LoadJobObservation>(inner, false);
  const g1 = newGateway(env, [crashing]);
  const invocationId = nextInvocationId();
  const req = sideEffectRequest(loadStartTool() as ToolSpec, baseInput('/hit-absent', { durationMs: 300 }), env.environments, invocationId);
  void g1.gateway.run(req);
  await crashing.reached;
  const stuck = (await g1.ledger.findByToolInvocation(invocationId, 'load.start'))!;
  assert.equal(stuck.status, 'dispatching');

  const fresh = new HttpLoadAdapter({ stateDir: dir, environments: env.environments });
  const g2 = newGateway(env, [fresh]);
  const whileLeased = await g2.gateway.observe(stuck.operationId, eventContext(), new AbortController().signal);
  assert.equal(whileLeased.status, 'pending', 'a dispatch under a live lease may still be in flight elsewhere: no conclusion yet');
  assert.equal(whileLeased.operation.status, 'dispatching');

  await g2.leases.release(stuck.lease!.leaseId); // the crashed dispatcher's lease expires
  const reconciled = await g2.gateway.observe(stuck.operationId, eventContext(), new AbortController().signal);
  assert.equal(reconciled.status, 'not_applied');
  assert.equal(reconciled.operation.status, 'not_applied');
  assert.match((reconciled as { reason: string }).reason, /effect absent at target/);
  assert.equal(existsSync(loadJobDir(dir, stuck.operationId)), false);
  assert.equal(fresh.spawned, 0);

  const redo = await g2.gateway.run({ ...req, signal: new AbortController().signal });
  assert.equal(redo.operation.operationId, stuck.operationId);
  assert.equal(redo.operation.attempt, 2);
  await trackPid(dir, stuck.operationId);
  const verified = await waitFor(async () => {
    const o = await g2.gateway.observe(stuck.operationId, eventContext(), new AbortController().signal);
    return o.status === 'verified' ? o : undefined;
  }, 15_000, 100, 'redispatched job');
  assert.equal((verified.result as { results: { sent: number } }).results.sent, 6);
  assert.equal(fresh.spawned, 1);
  assert.equal(inner.spawned, 0);
  assert.equal(hitsFor(stuck.operationId, '/hit-absent'), 6);
});

test('dispatch is natively idempotent per operation id (existing job dir ⇒ receipt, never a second worker); spawn failure ⇒ not applied', async () => {
  const dir = await stateDir();
  const adapter = new HttpLoadAdapter({ stateDir: dir, environments: env.environments });
  const op = { operationId: 'op_idem1', createdAt: new Date().toISOString() } as OperationRecord;
  const ctx: OperationContext = { operation: op, signal: new AbortController().signal };
  const prepared = await adapter.prepare(ctx, baseInput('/hit-idem', { durationMs: 200, ratePerSecond: 10 }));
  assert.equal(prepared.target.resourceKey, `loadgen/127.0.0.1:${target.port}`);
  const r1 = await adapter.dispatch(prepared, ctx);
  const r2 = await adapter.dispatch(prepared, ctx);
  assert.equal(r1.accepted, true);
  assert.equal(r2.accepted, true);
  assert.equal(JSON.parse(r2.receipt!).existing, true);
  assert.equal(adapter.spawned, 1);
  await trackPid(dir, 'op_idem1');

  const broken = new HttpLoadAdapter({ stateDir: dir, environments: env.environments, nodePath: '/nonexistent/node-binary' });
  const bctx: OperationContext = { operation: { operationId: 'op_broken1' } as OperationRecord, signal: new AbortController().signal };
  const r3 = await broken.dispatch(await broken.prepare(bctx, baseInput('/x')), bctx);
  assert.equal(r3.accepted, false);
  assert.match(r3.notAppliedReason!, /could not be started/);
  assert.equal(existsSync(loadJobDir(dir, 'op_broken1')), false, 'the claim is removed so the operation is definitively not applied');
  await assert.rejects(adapter.prepare(ctx, baseInput('/x', { ratePerSecond: 0 })), /ratePerSecond/);
  assert.throws(() => loadJobDir(dir, '../escape'), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});

test('observation edge cases: corrupt status ⇒ uncertain, dead worker ⇒ failed, interrupted launch ⇒ uncertain; the gateway sends uncertain to manual_review', async () => {
  const dir = await stateDir();
  const mk = async (id: string, files: Record<string, string>) => {
    const d = loadJobDir(dir, id);
    await mkdir(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) await writeFile(join(d, f), c);
  };
  await mk('op_corrupt', { 'status.json': '{"state": "runn' });
  assert.deepEqual((await observeLoadJob(dir, 'op_corrupt')).state, 'uncertain');
  await mk('op_dead', { pid: '999999\n', 'status.json': JSON.stringify({ state: 'running', sent: 3, ok: 3, errors: 0 }) });
  const dead = await observeLoadJob(dir, 'op_dead');
  assert.equal(dead.state, 'present');
  assert.equal((dead as { observation: LoadJobObservation }).observation.state, 'failed');
  assert.match((dead as { observation: LoadJobObservation }).observation.reason!, /died while the job was running/);
  await mk('op_launch', { 'spec.json': '{}' });
  assert.equal((await observeLoadJob(dir, 'op_launch', { launchGraceMs: 60_000 })).state, 'present');
  const interrupted = await observeLoadJob(dir, 'op_launch', { launchGraceMs: 0 });
  assert.equal(interrupted.state, 'uncertain');
  await mk('op_nores', { 'status.json': JSON.stringify({ state: 'completed', sent: 1, ok: 1, errors: 0 }) });
  assert.equal((await observeLoadJob(dir, 'op_nores')).state, 'uncertain');
  assert.equal((await observeLoadJob(dir, 'op_missing')).state, 'absent');

  // an acknowledged operation whose job status is corrupt is never retried blindly
  const { gateway, ledger } = newGateway(env, [new HttpLoadAdapter({ stateDir: dir, environments: env.environments })]);
  const prepared = await ledger.prepare(
    { operationId: 'op_manual', runId: RUN, workItemId: WORK, agentId: AGENT, toolInvocationId: nextInvocationId(), operationType: 'load.start', adapterId: 'load.http', target: { resourceKey: 'loadgen/x', kind: 'load_job' }, desiredStateHash: 'h', inputHash: 'i' },
    eventContext(),
  );
  await ledger.transition(prepared.operationId, 'dispatching', {}, eventContext());
  await ledger.transition(prepared.operationId, 'acknowledged', { externalJobId: 'op_manual' }, eventContext());
  await mk('op_manual', { 'status.json': 'garbage' });
  const out = await gateway.observe('op_manual', eventContext(), new AbortController().signal);
  assert.equal(out.status, 'manual_review');
  assert.equal(out.operation.status, 'manual_review');
});

test('load.stop stops a running job as its own operation; compensate stops a running job; a finished job compensates as a no-op', async () => {
  const dir = await stateDir();
  const adapters = builtinSideEffectAdapters({ stateDir: dir, environments: env.environments });
  const loadAdapter = adapters.find((a) => a.adapterId === 'load.http') as HttpLoadAdapter;
  assert.ok(adapters.some((a) => a instanceof HttpLoadStopAdapter));
  const { gateway, ledger } = newGateway(env, adapters);
  const runtime = newRuntime(env, blackboxTools({ stateDir: dir }), gateway);

  // (1) load.stop through the runtime
  const long = await runtime.execute(toolRequest('load.start', baseInput('/hit-long', { ratePerSecond: 5, durationMs: 60_000 })));
  assert.equal(long.status, 'pending');
  const longId = long.operationId!;
  const pid = await trackPid(dir, longId);
  const stop = await runtime.execute(toolRequest('load.stop', { operationId: longId }));
  assert.equal(stop.status, 'success', stop.modelText);
  assert.equal(structuredOf(stop)['finalState'], 'stopped');
  assert.notEqual(stop.operationId, longId, 'the stop is its own governed operation');
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 5000, 20, 'worker exit');
  const observed = await runtime.execute(toolRequest('load.observe', { operationId: longId }));
  assert.equal(observed.status, 'failed');
  assert.equal(observed.error?.code, 'failed');
  assert.match(observed.error!.message, /stopped before completion/);
  assert.equal(structuredOf(observed)['jobState'], 'stopped');
  const stopAgain = await runtime.execute(toolRequest('load.stop', { operationId: longId }));
  assert.equal(stopAgain.status, 'success', 'stopping a stopped job is idempotent');
  // an unknown job has no environment class: the policy cannot classify it and fails closed
  const unknown = await runtime.execute(toolRequest('load.stop', { operationId: 'op_doesnotexist' }));
  assert.equal(unknown.status, 'denied');
  assert.equal(unknown.error?.code, 'permission_denied');
  // at the gateway level, stopping a job that does not exist is definitively not applied
  const noJob = await gateway.run(sideEffectRequest(loadStopTool() as ToolSpec, { operationId: 'op_doesnotexist' }, env.environments, nextInvocationId()));
  assert.equal(noJob.status, 'not_applied');
  assert.match((noJob as { reason: string }).reason, /no load job op_doesnotexist/);

  // (2) adapter.compensate on a running job
  const req = sideEffectRequest(loadStartTool() as ToolSpec, baseInput('/hit-comp', { ratePerSecond: 5, durationMs: 60_000 }), env.environments, nextInvocationId());
  const running = await gateway.run(req);
  assert.equal(running.status, 'pending');
  const runningPid = await trackPid(dir, running.operation.operationId);
  await assert.rejects(gateway.compensate(running.operation.operationId, eventContext(), new AbortController().signal), (e: unknown) => isHypertestError(e, 'precondition_failed'), 'the gateway only compensates verified operations');
  const comp = await loadAdapter.compensate({ operation: (await ledger.get(running.operation.operationId))!, signal: new AbortController().signal });
  assert.equal(comp.compensated, true);
  assert.match(comp.detail!, /SIGTERM sent; final state stopped/);
  // compensate returns once the worker is gone (a zombie counts as gone); the OS entry disappears when reaped
  await waitFor(() => {
    try {
      process.kill(runningPid, 0);
      return false;
    } catch {
      return true;
    }
  }, 5000, 20, 'worker reaped');

  // (3) gateway.compensate on a completed (verified) job
  const shortReq = sideEffectRequest(loadStartTool() as ToolSpec, baseInput('/hit-short', { ratePerSecond: 10, durationMs: 200 }), env.environments, nextInvocationId());
  const short = await gateway.run(shortReq);
  await trackPid(dir, short.operation.operationId);
  await waitFor(async () => (await gateway.observe(short.operation.operationId, eventContext(), new AbortController().signal)).status === 'verified', 10_000, 50, 'short job');
  const compensated = await gateway.compensate(short.operation.operationId, eventContext(), new AbortController().signal);
  assert.equal(compensated.status, 'not_applied');
  assert.equal(compensated.operation.status, 'compensated');
  assert.equal(compensated.operation.lastError, 'compensated: job already completed; nothing to stop');
});

test('a RELATIVE state dir works: the worker gets an absolute job dir (it runs with the job dir as cwd)', async () => {
  const abs = await stateDir();
  const rel = relative(process.cwd(), abs);
  assert.ok(!rel.startsWith('/'), 'the state dir is given relative to the cwd');
  const adapter = new HttpLoadAdapter({ stateDir: rel, environments: env.environments });
  const ctx: OperationContext = { operation: { operationId: 'op_relative1', runId: RUN } as OperationRecord, signal: new AbortController().signal };
  const receipt = await adapter.dispatch(await adapter.prepare(ctx, baseInput('/hit-rel', { ratePerSecond: 10, durationMs: 300 })), ctx);
  assert.equal(receipt.accepted, true);
  assert.equal(JSON.parse(receipt.receipt!).jobDir, join(abs, 'loadjobs', 'op_relative1'));
  await trackPid(abs, 'op_relative1');
  const done = await waitFor(async () => {
    const o = await adapter.observe(ctx);
    return o.state === 'present' && (o.observation.state === 'completed' || o.observation.state === 'failed') ? o.observation : undefined;
  }, 10_000, 50, 'relative-dir job');
  assert.equal(done.state, 'completed', done.reason);
  assert.equal((await adapter.verify(done, (await adapter.prepare(ctx, baseInput('/hit-rel', { ratePerSecond: 10, durationMs: 300 }))).desiredStateHash)).status, 'verified');
  assert.equal(hitsFor('op_relative1', '/hit-rel'), 3);
  // an observer that spells the same state dir absolutely sees the same live job (pid-reuse marker is path-independent)
  const spec = JSON.parse(await readFile(join(abs, 'loadjobs', 'op_relative1', 'spec.json'), 'utf8')) as { runId: string };
  assert.equal(spec.runId, RUN, 'the launching run is recorded with the job');
});

test('egress: load.start honours the permit allowedHosts bound and the host allowlist BEFORE any operation exists', async () => {
  const dir = await stateDir();
  const { gateway, ledger } = newGateway(env, builtinSideEffectAdapters({ stateDir: dir, environments: env.environments }));
  const spec = loadStartTool() as ToolSpec;
  // the permit only allows another host: even the addressed environment is refused
  const bounded = fakeContext({ environments: env.environments, permit: allowPermit({ allowedHosts: ['load.example.test'] }) }).ctx;
  assert.throws(() => spec.sideEffect!.target(baseInput('/x'), bounded), (e: unknown) => isHypertestError(e, 'permission_denied') && /allowedHosts/.test(e.message));
  // a non-registered, non-loopback host is not a load target without an allowlist entry
  const open = fakeContext({ environments: env.environments }).ctx;
  const internet = { targetUrl: 'http://203.0.113.7:8080/x', method: 'GET', ratePerSecond: 1, durationMs: 100 };
  assert.throws(() => spec.sideEffect!.target(internet, open), (e: unknown) => isHypertestError(e, 'permission_denied') && /not on the http allowlist/.test(e.message));
  assert.deepEqual((loadStartTool({ httpAllowlist: ['203.0.113.7'] }) as ToolSpec).sideEffect!.target(internet, open), { resourceKey: 'loadgen/203.0.113.7:8080', kind: 'load_job' });

  // through the runtime: refused with permission_denied, no operation prepared, no job launched
  const runtime = newRuntime(env, blackboxTools({ stateDir: dir }), gateway);
  const invocationId = nextInvocationId();
  const out = await runtime.execute(toolRequest('load.start', { targetUrl: `${target.url}/__hypertest/restart`, method: 'POST', ratePerSecond: 5, durationMs: 200 }, { invocationId }));
  assert.equal(out.status, 'failed');
  assert.equal(out.error?.code, 'permission_denied');
  assert.equal(await ledger.findByToolInvocation(invocationId, 'load.start'), undefined);
  assert.equal(existsSync(join(dir, 'loadjobs')), false);
});

test('load.start input: GET with a body and duplicate / reserved headers are refused; header names are normalized', async () => {
  const dir = await stateDir();
  const adapter = new HttpLoadAdapter({ stateDir: dir, environments: env.environments });
  const ctx: OperationContext = { operation: { operationId: 'op_input1', runId: RUN } as OperationRecord, signal: new AbortController().signal };
  await assert.rejects(adapter.prepare(ctx, baseInput('/x', { body: 'nope' })), (e: unknown) => isHypertestError(e, 'invalid_argument') && /GET load requests cannot carry a body/.test(e.message));
  await assert.rejects(adapter.prepare(ctx, baseInput('/x', { headers: { 'X-A': '1', 'x-a': '2' } })), /given more than once/);
  await assert.rejects(adapter.prepare(ctx, baseInput('/x', { headers: { 'X-Hypertest-Operation': 'forged' } })), /set by the load generator/);
  const prepared = await adapter.prepare(ctx, baseInput('/x', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }));
  assert.deepEqual((prepared.desiredState as { headers: Record<string, string> }).headers, { 'content-type': 'application/json' });
});

test('run isolation: load.observe and load.stop refuse a load job of another run (the job keeps running)', async () => {
  const dir = await stateDir();
  const adapters = builtinSideEffectAdapters({ stateDir: dir, environments: env.environments });
  const { gateway } = newGateway(env, adapters);
  const started = await gateway.run(sideEffectRequest(loadStartTool() as ToolSpec, baseInput('/hit-iso', { ratePerSecond: 5, durationMs: 60_000 }), env.environments, nextInvocationId()));
  assert.equal(started.status, 'pending');
  const jobId = started.operation.operationId;
  const pid = await trackPid(dir, jobId);

  for (const stateDirOption of [{ stateDir: dir }, {}]) {
    const other = fakeContext({ environments: env.environments, sideEffects: gateway });
    other.ctx.runId = 'run_other';
    const seen = await (loadObserveTool(stateDirOption) as ToolSpec).execute({ operationId: jobId }, other.ctx);
    assert.equal(seen.status, 'failed', JSON.stringify(stateDirOption));
    assert.equal(seen.error?.code, 'permission_denied');
    assert.equal(seen.structured, undefined, 'nothing about the foreign job is reported');
    assert.equal(other.evidence.length, 0);
  }
  await assert.rejects(
    gateway.run(sideEffectRequest(loadStopTool() as ToolSpec, { operationId: jobId }, env.environments, nextInvocationId(), { runId: 'run_other' })),
    (e: unknown) => isHypertestError(e, 'permission_denied') && /belongs to another run/.test(e.message),
  );
  const stopAdapter = adapters.find((a) => a.adapterId === 'load.http.stop') as HttpLoadStopAdapter;
  const foreignStop: OperationContext = { operation: { operationId: 'op_foreignstop1', runId: 'run_other' } as OperationRecord, signal: new AbortController().signal };
  const receipt = await stopAdapter.dispatch({ desiredState: { jobOperationId: jobId, action: 'stop' }, desiredStateHash: 'h', target: { resourceKey: `loadjob/${jobId}`, kind: 'load_job' } }, foreignStop);
  assert.deepEqual(receipt, { accepted: false, notAppliedReason: `load job ${jobId} belongs to another run` });
  process.kill(pid, 0); // still running
  await waitFor(async () => {
    const o = await observeLoadJob(dir, jobId);
    return o.state === 'present' && o.observation.state === 'running';
  }, 5000, 20, 'job running');
  // the owning run can stop it
  const own = await gateway.run(sideEffectRequest(loadStopTool() as ToolSpec, { operationId: jobId }, env.environments, nextInvocationId()));
  assert.equal(own.status, 'verified');
});

test('a stop requested before the worker started wins: the worker exits as stopped without sending a request', async () => {
  const dir = await stateDir();
  const jobDir = loadJobDir(dir, 'op_prestop1');
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, 'spec.json'), JSON.stringify({ operationId: 'op_prestop1', targetUrl: `${target.url}/hit-prestop`, method: 'GET', ratePerSecond: 50, durationMs: 2000, concurrency: 4, timeoutMs: 1000 }));
  await writeFile(join(jobDir, 'stop-op_stopper1.json'), JSON.stringify({ stopOperationId: 'op_stopper1' }));
  const worker = spawn(process.execPath, ['--no-warnings', LOADGEN_WORKER_PATH, jobDir], { cwd: jobDir, stdio: 'ignore' });
  const [code] = await once(worker, 'exit');
  assert.equal(code, 0);
  const results = JSON.parse(await readFile(join(jobDir, 'results.json'), 'utf8')) as { state: string; sent: number };
  assert.equal(results.state, 'stopped');
  assert.equal(results.sent, 0);
  assert.equal((results as { errorRate?: unknown }).errorRate, null, 'no completed request: the error rate is unknown, never 0');
  assert.equal(hitsFor('op_prestop1'), 0);
});

test("the worker's own HTTP client start-up is never charged to the target: the schedule starts once the client is warm, and the warm-up sends nothing", async () => {
  // Node's fetch initializes its client lazily on the first call (tens of ms, far more on a loaded host). Latency is
  // measured from each request's scheduled time, so a schedule that started before the client was usable charged that
  // start-up to the target: the first requests' latency — the p99 of a short job — was the generator's, not the SUT's.
  // The preload makes the first fetch call of the process (whatever its URL) take 400 ms.
  const dir = await stateDir();
  const preload = join(dir, 'slow-first-fetch.mjs');
  await writeFile(preload, [
    'const real = globalThis.fetch;',
    'let first = true;',
    'globalThis.fetch = async (...args) => {',
    '  if (first) { first = false; await new Promise((r) => setTimeout(r, 400)); }',
    '  return real(...args);',
    '};',
  ].join('\n'));
  const jobDir = loadJobDir(dir, 'op_warmup1');
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, 'spec.json'), JSON.stringify({ operationId: 'op_warmup1', targetUrl: `${target.url}/hit-warmup`, method: 'GET', ratePerSecond: 10, durationMs: 300, concurrency: 4, timeoutMs: 5000 }));
  const worker = spawn(process.execPath, ['--no-warnings', '--import', pathToFileURL(preload).href, LOADGEN_WORKER_PATH, jobDir], { cwd: jobDir, stdio: 'ignore' });
  const [code] = await once(worker, 'exit');
  assert.equal(code, 0);
  const results = JSON.parse(await readFile(join(jobDir, 'results.json'), 'utf8')) as { state: string; sent: number; ok: number; latencyMs: { max: number } };
  assert.deepEqual([results.state, results.sent, results.ok], ['completed', 3, 3]);
  assert.ok(results.latencyMs.max < 400, `the client start-up (400 ms) was charged to the target: max latency ${results.latencyMs.max} ms`);
  assert.equal(hitsFor('op_warmup1'), 3, 'the warm-up never reaches the target');
});

test('CRASH during load.stop after the stop marker, before the signal: the worker honours the marker; reconciliation attaches (no re-dispatch)', async () => {
  const dir = await stateDir();
  const adapters = builtinSideEffectAdapters({ stateDir: dir, environments: env.environments });
  const g1 = newGateway(env, adapters);
  const started = await g1.gateway.run(sideEffectRequest(loadStartTool() as ToolSpec, baseInput('/hit-lost-signal', { ratePerSecond: 5, durationMs: 60_000 }), env.environments, nextInvocationId()));
  const jobId = started.operation.operationId;
  const pid = await trackPid(dir, jobId);
  await waitFor(async () => {
    const o = await observeLoadJob(dir, jobId);
    return o.state === 'present' && o.observation.state === 'running';
  }, 5000, 20, 'job running');

  // the stop dispatcher writes its marker and dies before signalling the worker
  const realStop = adapters.find((a) => a.adapterId === 'load.http.stop') as HttpLoadStopAdapter;
  let markerWritten!: () => void;
  const written = new Promise<void>((r) => (markerWritten = r));
  const crashingStop = {
    adapterId: realStop.adapterId,
    capabilities: realStop.capabilities,
    prepare: (op: OperationContext, input: { operationId: string }) => realStop.prepare(op, input),
    async dispatch(_p: unknown, op: OperationContext) {
      await writeFile(join(loadJobDir(dir, jobId), `stop-${op.operation.operationId}.json`), '{}\n');
      markerWritten();
      return new Promise<never>(() => undefined);
    },
    observe: (op: OperationContext) => realStop.observe(op),
    verify: (o: never) => realStop.verify(o),
  };
  const gCrash = newGateway(env, [crashingStop as never]);
  const invocationId = nextInvocationId();
  const stopReq = sideEffectRequest(loadStopTool() as ToolSpec, { operationId: jobId }, env.environments, invocationId);
  void gCrash.gateway.run(stopReq);
  await written;

  const g2 = newGateway(env, builtinSideEffectAdapters({ stateDir: dir, environments: env.environments }));
  const retry = await g2.gateway.run({ ...stopReq, signal: new AbortController().signal });
  assert.ok(retry.status === 'pending' || retry.status === 'verified', retry.status);
  const verified = await waitFor(async () => {
    const o = await g2.gateway.observe(retry.operation.operationId, eventContext(), new AbortController().signal);
    return o.status === 'verified' ? o : undefined;
  }, 5000, 50, 'stop verified via the marker');
  assert.equal((verified.result as { finalState: string }).finalState, 'stopped');
  assert.equal(verified.operation.attempt, 1, 'reconciled, never re-dispatched');
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 5000, 20, 'worker exit');
});

test('pid reuse guard: a live pid counts for a job only when an argument ENDS with /loadjobs/<operationId>', async () => {
  const { pidState } = await import('../src/blackbox/common.ts');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '/state/loadjobs/op_12'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    assert.equal(pidState(child.pid!, '/loadjobs/op_12'), 'alive');
    assert.equal(pidState(child.pid!, '/loadjobs/op_1'), 'dead', 'the worker of op_12 never passes for op_1');
    assert.equal(pidState(child.pid!), 'alive');
  } finally {
    child.kill('SIGKILL');
  }
  await once(child, 'exit');
  assert.equal(pidState(child.pid!, '/loadjobs/op_12'), 'dead');
});
