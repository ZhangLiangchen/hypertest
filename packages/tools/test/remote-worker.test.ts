/**
 * (row 246: Remote Worker) Tool bodies executed by a remote tool worker over HMAC-signed HTTP while capability, permit,
 * ledger and evidence stay local: the operation id created by the local gateway reaches the SUT through the worker
 * (`Idempotency-Key`), the worker's evidence is recorded in the local ledger (`provenance.executedBy`), a resend of the same
 * invocation never executes twice, unsigned / mis-signed requests and forged answers are refused, bound tools cannot be
 * delegated.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createEnvironmentRegistry, httpRequestTool, loadStartTool, remoteSignature, remoteToolSpec, startRemoteToolWorker, REMOTE_PROTOCOL_PATH, type RemoteToolWorker } from '../src/index.ts';
import { fakeContext, newGateway, newRuntime, openBlackboxEnv, startServer, toolRequest, type BlackboxEnv, type TestServer } from './blackbox-helpers.ts';

const SECRET = 'remote-worker-test-secret-0123456789';

describe('remote tool worker', () => {
  let sut: TestServer;
  let worker: RemoteToolWorker;
  let env: BlackboxEnv;

  before(async () => {
    sut = await startServer((req, res) => {
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method }));
    });
    const descriptors = [{ environmentId: 'shop', environmentClass: 'local', baseUrl: sut.url, generation: 3 }];
    // the worker composes its own tools with its own environments (here: the same SUT)
    worker = await startRemoteToolWorker({ workerId: 'edge', tools: [httpRequestTool({})], secret: SECRET, environments: createEnvironmentRegistry(descriptors) });
    env = await openBlackboxEnv({ environments: descriptors });
  });
  after(async () => {
    await worker?.close();
    await sut?.close();
    await env?.dispose();
  });

  test('a delegated write: local capability/permit/ledger, remote execution, the local operation id at the SUT, local evidence', async () => {
    const { gateway, ledger } = newGateway(env, []);
    const remote = remoteToolSpec(httpRequestTool({}), { workerId: 'edge', url: worker.url, secret: SECRET });
    const runtime = newRuntime(env, [remote], gateway);
    const req = toolRequest('http.request', { method: 'POST', environmentId: 'shop', path: '/orders', json: { sku: 'apple' } });
    const r = await runtime.execute(req);
    assert.equal(r.status, 'success', r.modelText);
    assert.equal((r.structured as { status: number }).status, 201);
    const op = await ledger.get(r.operationId!);
    assert.equal(op?.status, 'verified');
    assert.equal(sut.requests.at(-1)?.headers['idempotency-key'], r.operationId, 'the operation id created here reached the SUT through the worker');
    assert.equal(worker.executed, 1);
    const [ev] = await env.evidence.getMany(r.evidenceRefs);
    assert.equal(ev!.evidenceType, 'api-response');
    assert.equal((ev!.provenance as { executedBy?: string }).executedBy, 'remote:edge');
    assert.equal(ev!.environment?.environmentId, 'shop');
    assert.equal((r.structured as { evidenceId: string }).evidenceId, ev!.evidenceId, 'the worker\'s evidence reference is rewritten to the local id');
    // a durable replay answers from the local ledger; the worker is not asked again
    await runtime.execute({ ...req, signal: new AbortController().signal });
    assert.equal(worker.executed, 1);
  });

  test('a resend of the same invocation to the worker gets the recorded result; a different request under that id is a conflict', async () => {
    const remote = remoteToolSpec(httpRequestTool({}), { workerId: 'edge', url: worker.url, secret: SECRET });
    const { ctx } = fakeContext({ environments: env.environments, invocationId: 'sess:1:resend' });
    const before = worker.executed;
    const first = await remote.execute({ method: 'GET', environmentId: 'shop', path: '/a' }, ctx);
    const again = await remote.execute({ method: 'GET', environmentId: 'shop', path: '/a' }, ctx);
    assert.equal(first.status, 'success');
    assert.equal(again.status, 'success');
    assert.equal(worker.executed, before + 1, 'executed once');
    const other = await remote.execute({ method: 'GET', environmentId: 'shop', path: '/b' }, ctx);
    assert.equal(other.status, 'failed');
    assert.equal(other.error?.code, 'conflict');
  });

  test('authentication: a wrong secret is refused before anything runs; a forged answer is never trusted', async () => {
    const before = worker.executed;
    const wrong = remoteToolSpec(httpRequestTool({}), { workerId: 'edge', url: worker.url, secret: 'another-secret-of-enough-length' });
    const r = await wrong.execute({ method: 'GET', environmentId: 'shop', path: '/x' }, fakeContext({ environments: env.environments }).ctx);
    assert.equal(r.status, 'failed');
    assert.equal(r.error?.code, 'integrity_violation', 'the 401 answer is signed with the worker secret, which the caller cannot verify');
    assert.equal(worker.executed, before);
    // an unsigned request
    const raw = await fetch(`${worker.url}${REMOTE_PROTOCOL_PATH}`, { method: 'POST', body: '{}' });
    assert.equal(raw.status, 401);
    // a stale (replayed) signature
    const body = JSON.stringify({ toolId: 'http.request', input: { method: 'GET', environmentId: 'shop' }, invocationId: 'x', runId: 'r', workItemId: 'w', agentId: 'a', role: 'executor', permit: { decisionId: 'd' }, timeoutMs: 1000 });
    const old = String(Date.now() - 10 * 60_000);
    const stale = await fetch(`${worker.url}${REMOTE_PROTOCOL_PATH}`, { method: 'POST', body, headers: { 'x-hypertest-timestamp': old, 'x-hypertest-signature': remoteSignature(SECRET, old, 'POST', REMOTE_PROTOCOL_PATH, body) } });
    assert.equal(stale.status, 401);
    // a man in the middle rewriting the worker's answer
    const tampering: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const text = (await res.text()).replace('"status":200', '"status":500');
      return new Response(text, { status: res.status, headers: res.headers });
    };
    const forged = await remoteToolSpec(httpRequestTool({}), { workerId: 'edge', url: worker.url, secret: SECRET, fetch: tampering }).execute({ method: 'GET', environmentId: 'shop', path: '/y' }, fakeContext({ environments: env.environments }).ctx);
    assert.equal(forged.error?.code, 'integrity_violation');
  });

  test('fail closed: no secret ⇒ unavailable (nothing sent); bound tools cannot be delegated; unknown tools are refused', async () => {
    const off = await remoteToolSpec(httpRequestTool({}), { workerId: 'edge', url: worker.url, secret: undefined, unavailableReason: 'HT_WORKER_SECRET is not set' }).execute({ method: 'GET', environmentId: 'shop' }, fakeContext({ environments: env.environments }).ctx);
    assert.equal(off.error?.code, 'unavailable');
    assert.match(off.error!.message, /HT_WORKER_SECRET/);
    assert.throws(() => remoteToolSpec(loadStartTool({}), { workerId: 'edge', url: worker.url, secret: SECRET }), /side-effect binding/);
    const metricsLike = { ...httpRequestTool({}), id: 'metrics.query' };
    const unknown = await remoteToolSpec(metricsLike, { workerId: 'edge', url: worker.url, secret: SECRET }).execute({ method: 'GET', environmentId: 'shop' }, fakeContext({ environments: env.environments }).ctx);
    assert.equal(unknown.error?.code, 'not_found');
  });
});
