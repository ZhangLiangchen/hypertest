import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentRegistry, httpRequestTool, type ToolSpec } from '../src/index.ts';
import { EVIDENCE_BODY_LIMIT } from '../src/blackbox/http.ts';
import { checkHost, hostMatches, isLoopbackHost, joinUrl, redactHeaders, redactUrl } from '../src/blackbox/common.ts';
import { AdapterRegistry, createLeaseService, createOperationLedger, createSideEffectGateway, type OperationLedger } from '@hypertest/operation';
import { recordEffectAdapters } from '../src/index.ts';
import { allowPermit, fakeContext, newGateway, newRuntime, openBlackboxEnv, startServer, structuredOf, toolRequest, type BlackboxEnv, type TestServer } from './blackbox-helpers.ts';

let server: TestServer;
const transfers = new Map<string, { applied: number; body: string }>();
let appliedTransfers = 0;
let env: BlackboxEnv;
let tool: ToolSpec;
const BIG = 'b'.repeat(EVIDENCE_BODY_LIMIT + 512 * 1024);

before(async () => {
  server = await startServer(async (req, res, body) => {
    const url = new URL(req.url ?? '/', 'http://x');
    switch (url.pathname) {
      case '/ok':
      case '/api/ok':
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=supersecret; HttpOnly' });
        res.end(JSON.stringify({ hello: 'world', path: url.pathname }));
        return;
      case '/missing':
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no such thing');
        return;
      case '/echo':
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, idempotencyKey: req.headers['idempotency-key'] ?? null, body }));
        return;
      case '/transfer':
      case '/api/transfer': {
        // a SUT that applies each POST once per Idempotency-Key (a resend with the same key gets the recorded answer)
        const key = String(req.headers['idempotency-key'] ?? '');
        if (!transfers.has(key)) transfers.set(key, { applied: ++appliedTransfers, body });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ transfer: transfers.get(key)!.applied }));
        return;
      }
      case '/slow':
        await new Promise((r) => setTimeout(r, 1500));
        res.writeHead(200);
        res.end('late');
        return;
      case '/redirect':
        res.writeHead(302, { location: 'http://example.invalid/elsewhere' });
        res.end();
        return;
      case '/binary':
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from([0, 1, 2, 0, 255]));
        return;
      case '/nul-text':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('a\u0000b');
        return;
      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(BIG);
        return;
      case '/notjson':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{broken');
        return;
      case '/partial':
        // status + headers + part of the body, then the connection dies
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' });
        res.write('partial-body');
        setTimeout(() => res.socket?.destroy(), 30);
        return;
      default:
        res.writeHead(500);
        res.end('unexpected');
    }
  });
  env = await openBlackboxEnv({
    environments: [
      { environmentId: 'env_local', environmentClass: 'local', generation: 1, baseUrl: `${server.url}/api/` },
      { environmentId: 'env_prod', environmentClass: 'production', generation: 1, baseUrl: `http://127.0.0.2:${server.port}` },
      { environmentId: 'env_idem', environmentClass: 'local', generation: 1, baseUrl: `${server.url}/api/`, honoursIdempotencyKey: true },
    ],
  });
  tool = httpRequestTool({}) as ToolSpec;
});

after(async () => {
  await server.close();
  await env.dispose();
});

test('2xx response: success with parsed JSON and api-response evidence (full body artifact, redacted headers)', async () => {
  const { ctx, evidence } = fakeContext({ environments: env.environments });
  const before = server.requests.length;
  const out = await tool.execute({ method: 'GET', url: `${server.url}/ok?token=abc&x=1`, headers: { Authorization: 'Bearer s3cr3t', Cookie: 'a=b', 'X-Trace': 't1' } }, ctx);
  assert.equal(out.status, 'success');
  const s = structuredOf(out);
  assert.equal(s['status'], 200);
  assert.deepEqual(s['json'], { hello: 'world', path: '/ok' });
  assert.equal(s['headers']['set-cookie'], '[REDACTED]');
  assert.equal(s['url'], `${server.url}/ok?token=%5BREDACTED%5D&x=1`);
  assert.equal(server.requests.length, before + 1);
  assert.equal(server.requests.at(-1)!.headers['authorization'], 'Bearer s3cr3t', 'the real request carries the credential');
  assert.equal(evidence.length, 1);
  const ev = evidence[0]!;
  assert.equal(ev.input.evidenceType, 'api-response');
  assert.equal(ev.input.mimeType, 'application/json');
  assert.equal(Buffer.from(ev.input.data).toString('utf8'), JSON.stringify({ hello: 'world', path: '/ok' }));
  const st = ev.input.structured as Record<string, any>;
  assert.equal(st['request']['method'], 'GET');
  assert.equal(st['request']['headers']['authorization'], '[REDACTED]');
  assert.equal(st['request']['headers']['cookie'], '[REDACTED]');
  assert.equal(st['request']['headers']['x-trace'], 't1');
  assert.equal(st['response']['status'], 200);
  assert.equal(st['response']['headers']['set-cookie'], '[REDACTED]');
  assert.equal(st['response']['body'], JSON.stringify({ hello: 'world', path: '/ok' }));
  assert.equal(typeof st['durationMs'], 'number');
  assert.equal(s['evidenceId'], ev.record.evidenceId);
  assert.deepEqual(out.evidenceRefs, [ev.record.evidenceId]);
});

test('4xx is a successful tool call with the status as a domain outcome', async () => {
  const { ctx, evidence } = fakeContext({ environments: env.environments });
  const out = await tool.execute({ method: 'GET', url: `${server.url}/missing` }, ctx);
  assert.equal(out.status, 'success');
  assert.equal(out.error, undefined);
  assert.equal(structuredOf(out)['status'], 404);
  assert.equal(structuredOf(out)['bodyPreview'], 'no such thing');
  assert.equal(evidence.length, 1);
  assert.equal((evidence[0]!.input.structured as any)['response']['status'], 404);
});

test('environmentId + path is resolved against the environment baseUrl path prefix', async () => {
  const { ctx } = fakeContext({ environments: env.environments });
  const out = await tool.execute({ method: 'GET', environmentId: 'env_local', path: '/ok' }, ctx);
  assert.equal(out.status, 'success');
  assert.equal(structuredOf(out)['json']['path'], '/api/ok');
  assert.deepEqual(tool.resources({ method: 'GET', environmentId: 'env_local', path: '/ok' }, { workspace: ctx.workspace, runId: ctx.runId, environments: env.environments }), ['env/env_local']);
  assert.equal(tool.environmentClass!({ method: 'GET', environmentId: 'env_local' }, { environments: env.environments }), 'local');
});

test('the evidence records the request path an oracle names (http_expectation.path): environment-relative, without query', async () => {
  // the QualityGate matches http_expectation {method, path} against structured request.method / request.path of
  // api-response evidence: without the path, a black-box oracle could never be evaluated (C3 stays unknown)
  const { ctx, evidence } = fakeContext({ environments: env.environments });
  const viaEnv = await tool.execute({ method: 'GET', environmentId: 'env_local', path: '/ok?page=2' }, ctx);
  assert.equal(viaEnv.status, 'success');
  assert.equal(structuredOf(viaEnv)['json']['path'], '/api/ok', 'the request went to the environment baseUrl prefix');
  const viaUrl = await tool.execute({ method: 'POST', url: `${server.url}/echo?x=1`, json: { a: 1 } }, ctx);
  assert.equal(viaUrl.status, 'success');
  const requests = evidence.map((e) => (e.input.structured as Record<string, any>)['request']);
  assert.deepEqual(requests.map((r) => [r['method'], r['path']]), [['GET', '/ok'], ['POST', '/echo']]);
});

test('host allowlist: non-loopback host without allowlist is denied before any request', async () => {
  const { ctx, evidence } = fakeContext({ environments: env.environments });
  const out = await tool.execute({ method: 'GET', url: 'http://api.example.test/x' }, ctx);
  assert.equal(out.status, 'failed');
  assert.equal(out.error?.code, 'permission_denied');
  assert.match(out.error!.message, /not on the http allowlist/);
  assert.equal(evidence.length, 0);
});

test('host allowlist: loopback is allowed only for environment class local', async () => {
  // (e2e[0]) a URL on the origin of exactly ONE registered environment is a call on that environment (its resource, class
  // and trusted origins — governed by the capability like the environmentId form); a loopback origin whose owner is
  // ambiguous (environments of different classes) has no class: refused unless allowlisted
  const owned = createEnvironmentRegistry([{ environmentId: 'env_stage', environmentClass: 'staging', generation: 1, baseUrl: server.url }]);
  assert.deepEqual(tool.resources({ method: 'GET', url: `${server.url}/ok` }, { workspace: fakeContext().ctx.workspace, runId: 'run_bb', environments: owned }), ['env/env_stage']);
  assert.equal(tool.environmentClass!({ method: 'GET', url: `${server.url}/ok` }, { environments: owned }), 'staging');
  const envs = createEnvironmentRegistry([
    { environmentId: 'env_stage', environmentClass: 'staging', generation: 1, baseUrl: server.url },
    { environmentId: 'env_dev', environmentClass: 'local', generation: 1, baseUrl: `${server.url}/dev` },
  ]);
  const { ctx } = fakeContext({ environments: envs });
  const before = server.requests.length;
  const denied = await tool.execute({ method: 'GET', url: `${server.url}/ok` }, ctx);
  assert.equal(denied.status, 'failed');
  assert.equal(denied.error?.code, 'permission_denied');
  assert.match(denied.error!.message, /loopback is only allowed for environment class local/);
  assert.equal(server.requests.length, before, 'no request was sent');
  const allowed = await httpRequestTool({ httpAllowlist: ['127.0.0.1'] }).execute({ method: 'GET', url: `${server.url}/ok` }, ctx);
  assert.equal(allowed.status, 'success');
});

test('permit.constraints.allowedHosts is a hard bound even for the addressed environment', async () => {
  const { ctx, evidence } = fakeContext({ environments: env.environments, permit: allowPermit({ allowedHosts: ['api.example.test'] }) });
  const before = server.requests.length;
  const out = await tool.execute({ method: 'GET', environmentId: 'env_local', path: '/ok' }, ctx);
  assert.equal(out.status, 'failed');
  assert.equal(out.error?.code, 'permission_denied');
  assert.match(out.error!.message, /allowedHosts/);
  assert.equal(server.requests.length, before);
  assert.equal(evidence.length, 0);
});

test('non-idempotent methods carry Idempotency-Key = the operation id (E[9]; the invocation id only when unledgered) unless the caller sets one', async () => {
  const { ctx } = fakeContext({ environments: env.environments, invocationId: 'sess_x:3:call_7' });
  const out = await tool.execute({ method: 'POST', url: `${server.url}/echo`, json: { a: 1 } }, ctx);
  assert.equal(out.status, 'success');
  assert.deepEqual(structuredOf(out)['json'], { method: 'POST', idempotencyKey: 'sess_x:3:call_7', body: '{"a":1}' });
  // a ledgered execution names its operation: the target receives idempotencyKey = operationId
  const ledgered = await tool.execute({ method: 'POST', url: `${server.url}/echo`, json: { a: 2 } }, { ...ctx, operationId: 'op_01JLEDGEREDKEY0000000000000' });
  assert.equal(structuredOf(ledgered)['json']['idempotencyKey'], 'op_01JLEDGEREDKEY0000000000000');
  const own = await tool.execute({ method: 'PUT', url: `${server.url}/echo`, body: 'raw', headers: { 'Idempotency-Key': 'mine' } }, ctx);
  assert.equal(structuredOf(own)['json']['idempotencyKey'], 'mine');
  const get = await tool.execute({ method: 'GET', url: `${server.url}/echo` }, ctx);
  assert.equal(structuredOf(get)['json']['idempotencyKey'], null);
  assert.equal(tool.effect instanceof Function && (tool.effect as (i: unknown) => string)({ method: 'POST' }), 'external');
  assert.equal((tool.effect as (i: unknown) => string)({ method: 'GET' }), 'read');
  assert.equal((tool.riskClass as (i: unknown) => string)({ method: 'DELETE' }), 'medium');
});

test('timeout is reported as status timeout WITH evidence of the attempt', async () => {
  const { ctx, evidence } = fakeContext({ environments: env.environments });
  const out = await tool.execute({ method: 'GET', url: `${server.url}/slow`, timeoutMs: 150 }, ctx);
  assert.equal(out.status, 'timeout');
  assert.equal(out.error?.code, 'timeout');
  assert.equal(evidence.length, 1);
  const st = evidence[0]!.input.structured as Record<string, any>;
  assert.equal(st['response'], null);
  assert.equal(st['error']['code'], 'timeout');
});

test('connection refused is a failed call (unavailable) with evidence', async () => {
  const dead = await startServer(() => undefined);
  const url = `${dead.url}/x`;
  await dead.close();
  const { ctx, evidence } = fakeContext({ environments: env.environments });
  const out = await tool.execute({ method: 'GET', url }, ctx);
  assert.equal(out.status, 'failed');
  assert.equal(out.error?.code, 'unavailable');
  assert.match(out.error!.message, /ECONNREFUSED/);
  assert.equal(evidence.length, 1);
});

test('redirects are returned, not followed (a redirect could leave the allowlist)', async () => {
  const { ctx } = fakeContext({ environments: env.environments });
  const out = await tool.execute({ method: 'GET', url: `${server.url}/redirect` }, ctx);
  assert.equal(out.status, 'success');
  assert.equal(structuredOf(out)['status'], 302);
  assert.equal(structuredOf(out)['headers']['location'], 'http://example.invalid/elsewhere');
});

test('large bodies: evidence structured body is truncated at 1 MiB, the artifact keeps the full body', async () => {
  const { ctx, evidence } = fakeContext({ environments: env.environments });
  const out = await tool.execute({ method: 'GET', url: `${server.url}/big` }, ctx);
  assert.equal(out.status, 'success');
  const ev = evidence[0]!;
  const st = ev.input.structured as Record<string, any>;
  assert.equal(Buffer.byteLength(st['response']['body']), EVIDENCE_BODY_LIMIT);
  assert.equal(st['response']['bodyTruncated'], true);
  assert.equal(st['response']['bodyBytes'], BIG.length);
  assert.equal((ev.input.data as Uint8Array).byteLength, BIG.length);
  assert.equal(ev.record.artifact.size, BIG.length);
  assert.equal(structuredOf(out)['bodyPreview'].length, 4096);
});

test('binary and NUL-containing bodies are stored safely (no NUL in evidence JSON)', async () => {
  const { ctx, evidence } = fakeContext({ environments: env.environments });
  const bin = await tool.execute({ method: 'GET', url: `${server.url}/binary` }, ctx);
  assert.equal(bin.status, 'success');
  assert.equal((evidence[0]!.input.structured as any)['response']['body'], null);
  assert.equal((evidence[0]!.input.structured as any)['response']['bodyEncoding'], 'binary');
  assert.equal(structuredOf(bin)['bodyPreview'], '[binary application/octet-stream: 5 bytes]');
  const nul = await tool.execute({ method: 'GET', url: `${server.url}/nul-text` }, ctx);
  assert.equal(nul.status, 'success');
  assert.equal((evidence[1]!.input.structured as any)['response']['body'], 'a�b');
});

test('invalid JSON with a JSON content type is still a success with jsonError', async () => {
  const { ctx } = fakeContext({ environments: env.environments });
  const out = await tool.execute({ method: 'GET', url: `${server.url}/notjson` }, ctx);
  assert.equal(out.status, 'success');
  assert.equal(structuredOf(out)['json'], undefined);
  assert.match(structuredOf(out)['jsonError'], /^invalid JSON/);
});

test('GET with a body is rejected without sending', async () => {
  const { ctx } = fakeContext({ environments: env.environments });
  const before = server.requests.length;
  const out = await tool.execute({ method: 'GET', url: `${server.url}/ok`, body: 'x' }, ctx);
  assert.equal(out.status, 'failed');
  assert.equal(out.error?.code, 'invalid_argument');
  assert.equal(server.requests.length, before);
});

test('through the ToolRuntime: evidence lands in the ledger and policy classifies by environment (I1)', async () => {
  const runtime = newRuntime(env, [tool]);
  const ok = await runtime.execute(toolRequest('http.request', { method: 'GET', environmentId: 'env_local', path: '/ok' }));
  assert.equal(ok.status, 'success');
  assert.equal(ok.evidenceRefs.length, 1);
  const rec = await env.evidence.get(ok.evidenceRefs[0]!);
  assert.equal(rec?.evidenceType, 'api-response');
  assert.equal(rec?.toolInvocationId, ok.invocationId);
  assert.equal(rec?.provenance.toolId, 'http.request');
  assert.equal((rec?.structured as any)['response']['status'], 200);
  // POST against a production environment: the default policy denies mutations there; nothing is sent
  const before = server.requests.length;
  const denied = await runtime.execute(toolRequest('http.request', { method: 'POST', environmentId: 'env_prod', path: '/echo', json: {} }));
  assert.equal(denied.status, 'denied');
  assert.equal(denied.error?.code, 'permission_denied');
  assert.equal(server.requests.length, before);
  // protocol-relative path cannot escape the environment origin (schema violation, never executed)
  const escape = await runtime.execute(toolRequest('http.request', { method: 'GET', environmentId: 'env_local', path: '//evil.test/x' }));
  assert.equal(escape.status, 'failed');
  assert.equal(escape.error?.code, 'schema_violation');
  // url and environmentId together are ambiguous
  const both = await runtime.execute(toolRequest('http.request', { method: 'GET', environmentId: 'env_local', url: `${server.url}/ok` }));
  assert.equal(both.error?.code, 'schema_violation');
});

test('host helpers: loopback detection, pattern matching, URL joining, redaction', () => {
  for (const h of ['localhost', 'api.localhost', '127.0.0.1', '127.9.9.9', '[::1]', '::ffff:127.0.0.1']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['10.0.0.1', 'example.com', '[::2]', 'localhost.example.com', '128.0.0.1']) assert.equal(isLoopbackHost(h), false, h);
  const u = new URL('https://api.example.com:8443/x');
  assert.equal(hostMatches('*.example.com', u), true);
  assert.equal(hostMatches('*.example.com', new URL('https://example.com/')), false);
  assert.equal(hostMatches('api.example.com', u), true);
  assert.equal(hostMatches('api.example.com:8443', u), true);
  assert.equal(hostMatches('api.example.com:443', u), false);
  assert.equal(hostMatches('api.example.com:443', new URL('https://api.example.com/')), true);
  assert.equal(hostMatches('other.com', u), false);
  assert.equal(checkHost(new URL('ftp://x/'), {}).allowed, false);
  assert.equal(joinUrl('http://h:1/api/', '/v1/x?q=1').href, 'http://h:1/api/v1/x?q=1');
  assert.equal(joinUrl('http://h:1', undefined).href, 'http://h:1/');
  assert.throws(() => joinUrl('http://h:1/api', '//evil/x'), /single "\/"/);
  assert.throws(() => joinUrl('http://h:1/api', 'relative'), /single "\/"/);
  assert.deepEqual(redactHeaders({ Authorization: 'x', 'X-Api-Key': 'k', 'x-session-id': 's', accept: 'json' }), { authorization: '[REDACTED]', 'x-api-key': '[REDACTED]', 'x-session-id': '[REDACTED]', accept: 'json' });
  assert.equal(redactUrl(new URL('http://h/p?password=1&a=2')), 'http://h/p?password=%5BREDACTED%5D&a=2');
});

test('evidence redacts secret-named JSON request fields (the real request carries them)', async () => {
  const { ctx, evidence } = fakeContext({ environments: env.environments });
  const payload = { user: 'ada', password: 'hunter2', nested: { apiKey: 'k-123', list: [{ token: 't' }, 'plain'] } };
  const out = await tool.execute({ method: 'POST', url: `${server.url}/echo`, json: payload }, ctx);
  assert.equal(out.status, 'success');
  assert.equal(JSON.parse(structuredOf(out)['json']['body']).password, 'hunter2', 'the SUT received the credential');
  const recorded = (evidence[0]!.input.structured as any)['request'];
  assert.deepEqual(JSON.parse(recorded['body']), { user: 'ada', password: '[REDACTED]', nested: { apiKey: '[REDACTED]', list: [{ token: '[REDACTED]' }, 'plain'] } });
  assert.equal(recorded['bodyBytes'], Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(JSON.stringify(recorded).includes('hunter2'), false, 'the recorded request holds no credential (the SUT echo in the response is its own output)');
});

test('a body that breaks off after the status line keeps the bytes read and says so (never a silent short body)', async () => {
  const { ctx, evidence } = fakeContext({ environments: env.environments });
  const out = await tool.execute({ method: 'GET', url: `${server.url}/partial`, expectJson: true }, ctx);
  assert.equal(out.status, 'success', 'the status line arrived: a domain observation');
  const s = structuredOf(out);
  assert.equal(s['status'], 200);
  assert.equal(s['bodyPreview'], 'partial-body');
  assert.equal(s['bodyTruncated'], true);
  assert.match(s['bodyError'], /^body incomplete: /);
  assert.match(s['jsonError'], /^body incomplete: .*not parsed$/);
  const ev = evidence[0]!;
  assert.equal(Buffer.from(ev.input.data).toString('utf8'), 'partial-body');
  assert.match((ev.input.structured as any)['response']['bodyError'], /^body incomplete: /);
});

test('environmentId + path cannot climb above the environment base path (dot segments are normalized first)', async () => {
  const { ctx, evidence } = fakeContext({ environments: env.environments });
  const before = server.requests.length;
  for (const path of ['/../ok', '/%2e%2e/ok', '/a/../../ok']) {
    const out = await tool.execute({ method: 'GET', environmentId: 'env_local', path }, ctx);
    assert.equal(out.status, 'failed', path);
    assert.equal(out.error?.code, 'invalid_argument', path);
    assert.match(out.error!.message, /beneath the environment base path \/api/);
  }
  assert.equal(server.requests.length, before);
  assert.equal(evidence.length, 0);
  assert.equal(joinUrl('http://h:1/api/', '/v1/../v2').href, 'http://h:1/api/v2', 'dot segments inside the base path are fine');
});

// ------------------------------------------------------------------------------------ conformance-7 (I4): POST through the ledger

/**
 * A gateway whose ledger dies (throws) at the first transition to `at` (default `acknowledged`): the process is killed
 * after the request was sent, before (or, with `verified`, after) its receipt was recorded.
 */
function killedAfterSend(at: 'acknowledged' | 'verified' = 'acknowledged'): ReturnType<typeof createSideEffectGateway> {
  const opDeps = { ...env.deps, db: env.db, events: env.events };
  const real = createOperationLedger(opDeps);
  let killed = false;
  const ledger: OperationLedger = {
    prepare: (i, c, t) => real.prepare(i, c, t),
    get: (id) => real.get(id),
    findByIdempotencyKey: (k) => real.findByIdempotencyKey(k),
    findByToolInvocation: (i, t) => real.findByToolInvocation(i, t),
    list: (f) => real.list(f),
    listUnsettled: (r) => real.listUnsettled(r),
    transition: async (id, to, patch, ctx, options) => {
      if (!killed && to === at) {
        killed = true;
        throw new Error('process killed after the request was sent, before its outcome was recorded');
      }
      return real.transition(id, to, patch, ctx, options);
    },
  };
  return createSideEffectGateway({ ...opDeps, ledger, leases: createLeaseService(opDeps), adapters: new AdapterRegistry(recordEffectAdapters()), pollIntervalMs: 20 });
}

test('conformance-7: a POST is recorded in the Operation Ledger; its durable replay returns the recorded response without sending again', async () => {
  const runtime = newRuntime(env, [tool], newGateway(env, []).gateway);
  const req = toolRequest('http.request', { method: 'POST', environmentId: 'env_local', path: '/transfer', json: { amount: 5 } });
  const before = server.requests.length;
  const first = await runtime.execute(req);
  assert.equal(first.status, 'success', JSON.stringify(first.error));
  assert.ok(first.operationId);
  const replay = await newRuntime(env, [tool], newGateway(env, []).gateway).execute({ ...req });
  assert.equal(replay.status, 'success');
  assert.deepEqual(replay.structured, first.structured);
  assert.equal(replay.operationId, first.operationId);
  assert.equal(server.requests.length - before, 1, 'exactly one POST');
  // GET stays a plain read (no operation)
  const get = await runtime.execute(toolRequest('http.request', { method: 'GET', environmentId: 'env_local', path: '/ok' }));
  assert.equal(get.status, 'success');
  assert.equal(get.operationId, undefined);
});

test('conformance-7: a replay after a kill between send and settle sends exactly one POST (the unknown outcome goes to manual review)', async () => {
  const req = toolRequest('http.request', { method: 'POST', environmentId: 'env_local', path: '/transfer', json: { amount: 7 } });
  const before = server.requests.length;
  const killed = await newRuntime(env, [tool], killedAfterSend()).execute(req);
  assert.equal(killed.status, 'failed');
  assert.equal(server.requests.length - before, 1, 'the POST reached the SUT');
  // restart: a fresh process (fresh gateway state) replays the committed turn's tool call
  const replay = await newRuntime(env, [tool], newGateway(env, []).gateway).execute({ ...req });
  assert.equal(replay.status, 'failed');
  assert.equal(replay.error?.code, 'manual_review');
  assert.ok(replay.operationId);
  assert.equal(server.requests.length - before, 1, 'exactly one POST: never re-sent blindly');
  const again = await newRuntime(env, [tool], newGateway(env, []).gateway).execute({ ...req });
  assert.equal(again.error?.code, 'manual_review');
  assert.equal(server.requests.length - before, 1);
});

test('conformance-7: for an environment that honours Idempotency-Key the interrupted POST is re-sent ONCE with the same key; the SUT applies it once', async () => {
  const req = toolRequest('http.request', { method: 'POST', environmentId: 'env_idem', path: '/transfer', json: { amount: 9 } });
  const before = server.requests.length;
  const appliedBefore = appliedTransfers;
  const killed = await newRuntime(env, [tool], killedAfterSend()).execute(req);
  assert.equal(killed.status, 'failed');
  const replay = await newRuntime(env, [tool], newGateway(env, []).gateway).execute({ ...req });
  assert.equal(replay.status, 'success', JSON.stringify(replay.error));
  const sent = server.requests.slice(before);
  assert.equal(sent.length, 2, 'one safe resend');
  // E[9]: idempotencyKey = operationId — the key the ledger records is the one the SUT deduplicates by, on both sends
  const op = await newGateway(env, []).ledger.get(replay.operationId!);
  assert.equal(op?.idempotencyKey, replay.operationId);
  assert.deepEqual(sent.map((r) => r.headers['idempotency-key']), [replay.operationId, replay.operationId], 'the resend carries the same key: the operation id');
  assert.equal(appliedTransfers - appliedBefore, 1, 'the SUT applied the transfer once');
  // settled: further replays return the recorded response
  const third = await newRuntime(env, [tool], newGateway(env, []).gateway).execute({ ...req });
  assert.deepEqual(third.structured, replay.structured);
  assert.equal(server.requests.length - before, 2);
});

test('conformance-7: a kill between the recorded receipt and verification recovers the outcome from the (compact) receipt — not sent again', async () => {
  const req = toolRequest('http.request', { method: 'POST', environmentId: 'env_local', path: '/transfer', json: { amount: 11 } });
  const before = server.requests.length;
  const killed = await newRuntime(env, [tool], killedAfterSend('verified')).execute(req);
  assert.equal(killed.status, 'failed');
  const evidenceOfTheCall = (await env.evidence.query({ runId: 'run_bb' })).filter((e) => e.toolInvocationId === req.invocationId).map((e) => e.evidenceId);
  assert.equal(evidenceOfTheCall.length, 1);
  const replay = await newRuntime(env, [tool], newGateway(env, []).gateway).execute({ ...req });
  assert.equal(replay.status, 'success', JSON.stringify(replay.error));
  assert.match(replay.modelText, /recovered after an interruption.*not sent again/s);
  assert.deepEqual(replay.evidenceRefs, evidenceOfTheCall, 'the full response is in the evidence of the original call');
  assert.equal(server.requests.length - before, 1, 'exactly one POST');
  // the receipt in the L0 event stays small (never the whole response)
  const acked = env.events.events.filter((e) => e.eventType === 'operation.acknowledged' && (e.payload as { toolInvocationId?: string }).toolInvocationId === req.invocationId);
  assert.equal(acked.length, 1);
  const receipt = String((acked[0]!.payload as { externalReceipt: string }).externalReceipt);
  assert.ok(receipt.length < 2048, `receipt ${receipt.length} bytes`);
  assert.doesNotMatch(receipt, /transfer/);
});
