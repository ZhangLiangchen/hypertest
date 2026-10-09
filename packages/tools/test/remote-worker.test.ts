/**
 * (row 246: Remote Worker) Tool bodies executed by a remote tool worker over HMAC-signed HTTP while capability, permit,
 * ledger and evidence stay local: the operation id created by the local gateway reaches the SUT through the worker
 * (`Idempotency-Key`), the worker's evidence is recorded in the local ledger (`provenance.executedBy`), a resend of the same
 * invocation never executes twice, unsigned / mis-signed requests and forged answers are refused, bound tools cannot be
 * delegated.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createEnvironmentRegistry, createSecretBroker, httpRequestTool, loadStartTool, remoteSignature, remoteToolSpec, startRemoteToolWorker, REMOTE_PROTOCOL_PATH, type RemoteToolWorker, type ToolSpec } from '../src/index.ts';
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

  test('(review) a genuine answer captured from one call is never accepted as the answer to another (signature bound to the request)', async () => {
    // a man in the middle that records the worker's first (genuine, correctly signed) answer and replays it, unchanged and
    // well inside the clock-skew window, as the answer to the next call — which it never forwards
    let captured: { body: string; headers: Headers; status: number } | undefined;
    const forwardedPaths: string[] = [];
    const replaying: typeof fetch = async (input, init) => {
      if (captured) return new Response(captured.body, { status: captured.status, headers: captured.headers });
      forwardedPaths.push(String((JSON.parse(String(init?.body)) as { input: { path: string } }).input.path));
      const res = await fetch(input, init);
      captured = { body: await res.text(), headers: res.headers, status: res.status };
      return new Response(captured.body, { status: captured.status, headers: captured.headers });
    };
    const spec = remoteToolSpec(httpRequestTool({}), { workerId: 'edge', url: worker.url, secret: SECRET, fetch: replaying });
    const first = await spec.execute({ method: 'GET', environmentId: 'shop', path: '/first' }, fakeContext({ environments: env.environments, invocationId: 'sess:mitm:1' }).ctx);
    assert.equal(first.status, 'success', JSON.stringify(first));
    const before = worker.executed;
    const { ctx, evidence } = fakeContext({ environments: env.environments, invocationId: 'sess:mitm:2' });
    const second = await spec.execute({ method: 'POST', environmentId: 'shop', path: '/second', json: { sku: 'pear' } }, ctx);
    assert.deepEqual(forwardedPaths, ['/first'], 'the second call never reached the worker');
    assert.equal(worker.executed, before);
    assert.equal(second.status, 'failed', 'the replayed answer of /first is not the answer of /second');
    assert.equal(second.error?.code, 'integrity_violation');
    assert.equal(evidence.length, 0, 'no evidence of the replayed answer was recorded for the second call');
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

describe('(review) remote tool worker: brokered credentials are scoped to the call, as on the caller side', () => {
  let sut: TestServer;
  let worker: RemoteToolWorker;
  const minted: string[] = [];
  // a delegable tool that mints a credential its input never declared (a buggy or compromised tool body): the caller's
  // capability and permit were checked against the DECLARED scopes only (none here)
  const rogue: ToolSpec = {
    id: 'probe.rogue', title: 'rogue', description: 'mints an undeclared credential', inputSchema: { type: 'object' }, effect: 'read', riskClass: 'low',
    resources: () => ['env/shop'], credentialScopes: () => [], evidenceTypes: [], timeoutMs: 10_000,
    async execute(_input, ctx) {
      try {
        const m = await ctx.secrets!.mint({ environmentId: 'shop', name: 'orders', runId: ctx.runId, invocationId: ctx.invocationId });
        minted.push(m.scope);
        return { status: 'success', structured: { minted: m.scope } };
      } catch (e) {
        return { status: 'failed', error: { code: (e as { code?: string }).code ?? 'internal', message: (e as Error).message } };
      }
    },
  };

  before(async () => {
    sut = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ auth: req.headers['authorization'] ? 'present' : 'absent' }));
    });
    const descriptors = [{ environmentId: 'shop', environmentClass: 'local', baseUrl: sut.url, generation: 1 }];
    const environments = createEnvironmentRegistry(descriptors);
    const secrets = createSecretBroker({ credentials: [{ environmentId: 'shop', name: 'orders', kind: 'jwt_hs256', secretEnv: 'ORDERS_SECRET', ttlMs: 60_000 }], env: { ORDERS_SECRET: 'orders-signing-secret-0123456789' } });
    worker = await startRemoteToolWorker({ workerId: 'edge2', tools: [httpRequestTool({}), rogue], secret: SECRET, environments, secrets });
  });
  after(async () => {
    await worker?.close();
    await sut?.close();
  });

  test('an undeclared credential is refused on the worker; a declared one is minted for the call', async () => {
    const env = createEnvironmentRegistry([{ environmentId: 'shop', environmentClass: 'local', baseUrl: sut.url, generation: 1 }]);
    const out = await remoteToolSpec(rogue, { workerId: 'edge2', url: worker.url, secret: SECRET }).execute({}, fakeContext({ environments: env }).ctx);
    assert.equal(out.status, 'failed', JSON.stringify(out));
    assert.equal(out.error?.code, 'permission_denied');
    assert.match(out.error!.message, /credential:shop\/orders was not declared and authorized for this call/);
    assert.deepEqual(minted, [], 'the worker minted nothing it was not asked for');
    // the declared credential (http.request credential: orders) is minted on the worker and sent to the SUT
    const ok = await remoteToolSpec(httpRequestTool({}), { workerId: 'edge2', url: worker.url, secret: SECRET }).execute({ method: 'GET', environmentId: 'shop', path: '/x', credential: 'orders' }, fakeContext({ environments: env }).ctx);
    assert.equal(ok.status, 'success', JSON.stringify(ok));
    assert.equal(sut.requests.at(-1)?.headers['authorization']?.startsWith('Bearer '), true);
  });
});
