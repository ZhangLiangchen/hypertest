/**
 * E[4] / coverage[8]: the LLM never receives a long-lived static credential. A tool that needs one names WHICH credential;
 * the secret broker mints a short-lived, scoped credential for that one call from a `*Env` secret (JWT HS256 or an OAuth2
 * client-credentials token), the capability must grant its scope and the permit's credentialScope constraint must cover it,
 * and nothing the SUT echoes back carries a secret or a minted value to the model or the evidence. The process supervisor
 * is driven with per-operation control tokens — its long-lived control token never goes over the wire.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FixedClock, isHypertestError } from '@hypertest/core';
import type { OperationRecord } from '@hypertest/domain';
import { createRootCapability, type PermissionProfile } from '@hypertest/policy';
import {
  CONTROL_TOKEN_AUDIENCE, CONTROL_TOKEN_HEADER, OPERATION_HEADER, ProcessEnvAdapter, ToolRegistry, brokeredCredentialProblems, createEnvironmentRegistry, createSecretBroker, createToolRuntime, credentialScope,
  httpRequestTool, mintControlToken, signJwtHs256, startProcessSupervisor, verifyJwtHs256, type ProcessSupervisor, type SecretBroker, type ToolSpec,
} from '../src/index.ts';
import { AGENT, BLACKBOX_PROFILE, FAR, RUN, SECRET, WORK, openBlackboxEnv, startServer, structuredOf, toolRequest, type BlackboxEnv, type TestServer } from './blackbox-helpers.ts';

const SUT_SECRET = 'orders-api-hmac-secret-0123456789';
const CLIENT_SECRET = 'idp-client-secret-abcdefghijklmnop';

describe('JWT HS256 and the broker', () => {
  test('sign/verify: signature, expiry and audience are checked; tampering is refused', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    const t = signJwtHs256({ aud: 'svc', exp: now / 1000 + 60, scope: 'orders' }, 'k'.repeat(20));
    assert.deepEqual(verifyJwtHs256(t, 'k'.repeat(20), now, { audience: 'svc' }), { ok: true, claims: { aud: 'svc', exp: now / 1000 + 60, scope: 'orders' } });
    assert.deepEqual(verifyJwtHs256(t, 'x'.repeat(20), now), { ok: false, reason: 'bad signature' });
    assert.deepEqual(verifyJwtHs256(t, 'k'.repeat(20), now + 61_000), { ok: false, reason: 'expired' });
    assert.deepEqual(verifyJwtHs256(t, 'k'.repeat(20), now, { audience: 'other' }), { ok: false, reason: 'audience svc is not other' });
    const [h, , s] = t.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ aud: 'svc', exp: now / 1000 + 9999, scope: 'admin' })).toString('base64url')}.${s}`;
    assert.deepEqual(verifyJwtHs256(forged, 'k'.repeat(20), now), { ok: false, reason: 'bad signature' });
    assert.equal(verifyJwtHs256('garbage', 'k', now).ok, false);
  });

  test('a jwt credential: minted per call (run, credential, invocation bound; short-lived); describe never shows a value; unknown / unset ⇒ exact refusal', async () => {
    const clock = new FixedClock('2026-10-01T00:00:00.000Z');
    const broker = createSecretBroker({ credentials: [{ environmentId: 'shop', name: 'orders', kind: 'jwt_hs256', secretEnv: 'ORDERS_SECRET', ttlMs: 60_000 }], env: { ORDERS_SECRET: SUT_SECRET }, clock });
    assert.deepEqual(broker.describe('shop'), [{ name: 'orders', scope: 'credential:shop/orders', kind: 'jwt_hs256', grantTo: ['test_executor', 'environment_operator'] }]);
    assert.equal(JSON.stringify(broker.describe('shop')).includes(SUT_SECRET), false);
    const m = await broker.mint({ environmentId: 'shop', name: 'orders', runId: 'run_1', invocationId: 'sess:1:c1' });
    assert.equal(m.header, 'authorization');
    assert.equal(m.expiresAt, '2026-10-01T00:01:00.000Z');
    const v = verifyJwtHs256(m.value.replace(/^Bearer /, ''), SUT_SECRET, clock.nowMs(), { audience: 'shop' });
    assert.ok(v.ok);
    assert.deepEqual([v.claims['sub'], v.claims['scope'], v.claims['jti'], v.claims['iss']], ['run:run_1', 'orders', 'sess:1:c1', 'hypertest']);
    const other = await broker.mint({ environmentId: 'shop', name: 'orders', runId: 'run_1', invocationId: 'sess:1:c2' });
    assert.notEqual(other.value, m.value, 'one credential per call');
    // redaction: the long-lived secret and every minted value
    assert.equal(broker.redact(`a ${SUT_SECRET} b ${m.value.slice(7)} c`), 'a [REDACTED:orders] b [REDACTED:minted-credential] c');
    await assert.rejects(broker.mint({ environmentId: 'shop', name: 'nope', runId: 'r', invocationId: 'i' }), (e: unknown) => isHypertestError(e, 'not_found'));
    const unset = createSecretBroker({ credentials: [{ environmentId: 'shop', name: 'orders', kind: 'jwt_hs256', secretEnv: 'ORDERS_SECRET' }], env: {} });
    await assert.rejects(unset.mint({ environmentId: 'shop', name: 'orders', runId: 'r', invocationId: 'i' }), (e: unknown) => isHypertestError(e, 'unavailable') && /ORDERS_SECRET is not set/.test((e as Error).message));
  });

  test('an oauth2 client-credentials token: exchanged with the client secret, cached until shortly before it expires, redacted', async () => {
    const clock = new FixedClock('2026-10-01T00:00:00.000Z');
    const calls: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      calls.push(String(init.body));
      return new Response(JSON.stringify({ access_token: `at-${calls.length}-xxxxxxxx`, expires_in: 120 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const broker = createSecretBroker({
      credentials: [{ environmentId: 'shop', name: 'api', kind: 'oauth2_client_credentials', secretEnv: 'IDP_SECRET', tokenUrl: 'https://idp.invalid/token', clientId: 'hypertest', scope: 'orders:write' }],
      env: { IDP_SECRET: CLIENT_SECRET }, clock, fetch: fakeFetch,
    });
    const a = await broker.mint({ environmentId: 'shop', name: 'api', runId: 'r', invocationId: 'i1' });
    assert.equal(a.value, 'Bearer at-1-xxxxxxxx');
    assert.match(calls[0]!, /grant_type=client_credentials&client_id=hypertest&client_secret=idp-client-secret-abcdefghijklmnop&scope=orders%3Awrite/);
    assert.equal((await broker.mint({ environmentId: 'shop', name: 'api', runId: 'r', invocationId: 'i2' })).value, a.value, 'cached');
    clock.advance(95_000); // less than 30 s left ⇒ a new token
    assert.equal((await broker.mint({ environmentId: 'shop', name: 'api', runId: 'r', invocationId: 'i3' })).value, 'Bearer at-2-xxxxxxxx');
    assert.equal(broker.redact(`echo at-1-xxxxxxxx ${CLIENT_SECRET}`), 'echo [REDACTED:minted-credential] [REDACTED:api]');
    const failing = createSecretBroker({ credentials: [{ environmentId: 'shop', name: 'api', kind: 'oauth2_client_credentials', secretEnv: 'IDP_SECRET', tokenUrl: 'https://idp.invalid/token', clientId: 'c' }], env: { IDP_SECRET: 'x'.repeat(10) }, fetch: (async () => new Response('no', { status: 401 })) as unknown as typeof fetch });
    await assert.rejects(failing.mint({ environmentId: 'shop', name: 'api', runId: 'r', invocationId: 'i' }), (e: unknown) => isHypertestError(e, 'unavailable') && /answered 401/.test((e as Error).message));
  });

  test('configuration problems are exact; duplicates are refused', () => {
    assert.deepEqual(brokeredCredentialProblems({ environmentId: 'e', name: 'bad name', kind: 'jwt_hs256', secretEnv: 'lower' } as never, 'c'), ['c.name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', 'c.secretEnv must name an environment variable (upper case)']);
    assert.deepEqual(brokeredCredentialProblems({ environmentId: 'e', name: 'x', kind: 'oauth2_client_credentials', secretEnv: 'S' } as never, 'c'), ['c.tokenUrl is required (an http(s) URL) for oauth2_client_credentials', 'c: set exactly one of clientId, clientIdEnv']);
    assert.throws(() => createSecretBroker({ credentials: [{ environmentId: 'e', name: 'x', kind: 'jwt_hs256', secretEnv: 'S' }, { environmentId: 'e', name: 'x', kind: 'jwt_hs256', secretEnv: 'T' }] }), (e: unknown) => isHypertestError(e, 'invalid_argument') && /duplicate/.test((e as Error).message));
  });
});

describe('http.request with a brokered credential (through the ToolRuntime)', () => {
  let server: TestServer;
  let env: BlackboxEnv;
  let broker: SecretBroker;
  const seen: Array<string | undefined> = [];
  before(async () => {
    // a SUT that verifies the minted JWT and (maliciously) echoes the Authorization header and the secret back
    server = await startServer(async (req, res) => {
      const auth = req.headers['authorization'];
      seen.push(auth);
      const token = typeof auth === 'string' ? auth.replace(/^Bearer /, '') : '';
      const v = verifyJwtHs256(token, SUT_SECRET, Date.now(), { audience: 'shop' });
      res.writeHead(v.ok ? 200 : 401, { 'content-type': 'application/json', 'x-echo-auth': String(auth) });
      res.end(JSON.stringify({ ok: v.ok, youSent: auth ?? null, leaked: SUT_SECRET }));
    });
    env = await openBlackboxEnv({ environments: [{ environmentId: 'shop', environmentClass: 'local', baseUrl: server.url, generation: 1, brokeredCredentials: [{ name: 'orders' }] }] });
    broker = createSecretBroker({ credentials: [{ environmentId: 'shop', name: 'orders', kind: 'jwt_hs256', secretEnv: 'ORDERS_SECRET' }], env: { ORDERS_SECRET: SUT_SECRET } });
  });
  after(async () => {
    await server.close();
    await env.dispose();
  });

  function runtimeWith(secrets: SecretBroker | undefined, policy = env.policy) {
    const deps: Parameters<typeof createToolRuntime>[0] = {
      ...env.deps, registry: new ToolRegistry([httpRequestTool({})]), policy, decisionLog: env.decisionLog, artifacts: env.artifacts, evidence: env.evidence, events: env.events,
      environments: env.environments, runtimeManifestId: 'manifest_bb', workerId: 'worker_bb', capabilitySecret: SECRET,
    };
    if (secrets) deps.secrets = secrets;
    return createToolRuntime(deps);
  }
  const withScopes = (credentialScopes: string[]) =>
    createRootCapability({ runId: RUN, subjectAgentId: AGENT, workItemId: WORK, profile: { ...BLACKBOX_PROFILE, credentialScopes } as PermissionProfile, tools: ['*'], expiresAt: FAR, capabilityId: 'cap_cred' }, SECRET);

  test('the call carries a short-lived JWT the SUT verifies; no secret and no minted value reaches the model text, the structured result or the evidence', async () => {
    const rt = runtimeWith(broker);
    const out = await rt.execute(toolRequest('http.request', { method: 'GET', environmentId: 'shop', path: '/orders', credential: 'orders' }, { capability: withScopes([credentialScope('shop', 'orders')]) }));
    assert.equal(out.status, 'success', out.modelText);
    const s = structuredOf(out);
    assert.equal(s['status'], 200, 'the SUT accepted the minted credential');
    const sent = seen.at(-1)!;
    assert.match(sent, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const minted = sent.slice('Bearer '.length);
    for (const blob of [out.modelText, JSON.stringify(out.structured)]) {
      assert.equal(blob.includes(SUT_SECRET), false, 'the long-lived secret never reaches the model');
      assert.equal(blob.includes(minted), false, 'nor the minted credential');
    }
    const [ev] = await env.evidence.query({ runId: RUN, evidenceType: 'api-response' }).then((all) => all.filter((e) => out.evidenceRefs.includes(e.evidenceId)));
    assert.ok(ev);
    const stored = JSON.stringify(ev.structured) + Buffer.from(await env.artifacts.get(ev.artifact!)).toString('utf8');
    assert.equal(stored.includes(SUT_SECRET), false);
    assert.equal(stored.includes(minted), false);
    assert.match(out.modelText, /\[REDACTED:orders\]/);
  });

  test('capability and permit gate the credential: a capability without the scope, a permit constraint excluding it, a missing broker, or a self-set header are refused (nothing sent)', async () => {
    const before = seen.length;
    const rt = runtimeWith(broker);
    const noScope = await rt.execute(toolRequest('http.request', { method: 'GET', environmentId: 'shop', path: '/x', credential: 'orders' }));
    assert.equal(noScope.status, 'denied');
    assert.match(noScope.error!.message, /capability_denied: credential_scope_not_permitted: credential:shop\/orders/);
    const constrained = runtimeWith(broker, { revision: env.policy.revision, evaluate: async (r) => ({ ...(await env.policy.evaluate(r)), constraints: { credentialScope: ['credential:shop/readonly-*'] } }) });
    const narrowed = await constrained.execute(toolRequest('http.request', { method: 'GET', environmentId: 'shop', path: '/x', credential: 'orders' }, { capability: withScopes([credentialScope('shop', 'orders')]) }));
    assert.equal(narrowed.status, 'denied');
    assert.match(narrowed.error!.message, /permit_constraint_violated: credentials outside credentialScope: credential:shop\/orders/);
    const noBroker = await runtimeWith(undefined).execute(toolRequest('http.request', { method: 'GET', environmentId: 'shop', path: '/x', credential: 'orders' }, { capability: withScopes([credentialScope('shop', 'orders')]) }));
    assert.deepEqual([noBroker.status, noBroker.error?.code], ['failed', 'unavailable']);
    const selfSet = await rt.execute(toolRequest('http.request', { method: 'GET', environmentId: 'shop', path: '/x', credential: 'orders', headers: { Authorization: 'Bearer guessed' } }, { capability: withScopes([credentialScope('shop', 'orders')]) }));
    assert.deepEqual([selfSet.status, selfSet.error?.code], ['failed', 'invalid_argument']);
    const byUrl = await rt.execute(toolRequest('http.request', { method: 'GET', url: `${server.url}/x`, credential: 'orders' }, { capability: withScopes([credentialScope('shop', 'orders')]) }));
    assert.equal(byUrl.status, 'denied');
    assert.match(byUrl.error!.message, /credential needs environmentId/);
    assert.equal(seen.length, before, 'none of them reached the SUT');
  });
});

describe('(review) a tool mints only the credentials its call declared and was authorized for', () => {
  test('a tool that did not declare a credential (or names another one) cannot mint it through its context; the declared one works for this call only', async () => {
    const env = await openBlackboxEnv({ environments: [{ environmentId: 'shop', environmentClass: 'local', baseUrl: 'http://127.0.0.1:9', generation: 1, brokeredCredentials: [{ name: 'orders' }, { name: 'admin' }] }] });
    try {
      const broker = createSecretBroker({
        credentials: [{ environmentId: 'shop', name: 'orders', kind: 'jwt_hs256', secretEnv: 'ORDERS_SECRET' }, { environmentId: 'shop', name: 'admin', kind: 'jwt_hs256', secretEnv: 'ADMIN_SECRET' }],
        env: { ORDERS_SECRET: SUT_SECRET, ADMIN_SECRET: 'admin-secret-0123456789abcdef' },
      });
      const attempts: string[] = [];
      // a (plugin-like) tool: declares `orders`, then tries to mint `admin`, `orders` for another invocation, and `orders`
      const greedy: ToolSpec<{ name: string; invocation?: string }> = {
        id: 'probe.greedy', title: 'greedy', description: 'tries to mint credentials', inputSchema: { type: 'object', properties: { name: { type: 'string' }, invocation: { type: 'string' } }, required: ['name'] },
        effect: 'read', riskClass: 'low', resources: () => ['env/shop'], environmentClass: () => 'local', timeoutMs: 5_000,
        credentialScopes: () => [credentialScope('shop', 'orders')],
        async execute(input, ctx) {
          try {
            const m = await ctx.secrets!.mint({ environmentId: 'shop', name: input.name, runId: ctx.runId, invocationId: input.invocation ?? ctx.invocationId });
            attempts.push(`minted ${m.scope}`);
          } catch (e) {
            attempts.push(`${(e as { code?: string }).code}: ${(e as Error).message}`);
          }
          return { status: 'success', structured: { ok: true } };
        },
      };
      const rt = createToolRuntime({
        ...env.deps, registry: new ToolRegistry([greedy as ToolSpec]), policy: env.policy, decisionLog: env.decisionLog, artifacts: env.artifacts, evidence: env.evidence, events: env.events,
        environments: env.environments, runtimeManifestId: 'manifest_bb', workerId: 'worker_bb', capabilitySecret: SECRET, secrets: broker,
      });
      const cap = createRootCapability({ runId: RUN, subjectAgentId: AGENT, workItemId: WORK, profile: { ...BLACKBOX_PROFILE, credentialScopes: [credentialScope('shop', 'orders'), credentialScope('shop', 'admin')] } as PermissionProfile, tools: ['*'], expiresAt: FAR, capabilityId: 'cap_greedy' }, SECRET);
      for (const input of [{ name: 'admin' }, { name: 'orders', invocation: 'someone-else:1:c1' }, { name: 'orders' }]) {
        const out = await rt.execute(toolRequest('probe.greedy', input, { capability: cap }));
        assert.equal(out.status, 'success', out.modelText);
      }
      assert.match(attempts[0]!, /^permission_denied: credential credential:shop\/admin was not declared and authorized for this call/);
      assert.match(attempts[1]!, /^permission_denied: credential credential:shop\/orders is minted for this call only/);
      assert.equal(attempts[2], 'minted credential:shop/orders');
    } finally {
      await env.dispose();
    }
  });
});

describe('env control: per-operation control tokens', () => {
  let sup: ProcessSupervisor;
  before(async () => {
    sup = await startProcessSupervisor({ command: [process.execPath, '-e', "require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')"], readyTimeoutMs: 10_000, killGraceMs: 500 });
  });
  after(async () => {
    await sup.close();
  });
  const post = (headers: Record<string, string>) => fetch(`${sup.controlBaseUrl}/restart`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ kind: 'restart', desiredStateHash: 'h' }) });

  test('the supervisor accepts a minted token only for its own operation and only while it is valid; garbage and other operations are 401', async () => {
    const now = Date.now();
    const good = mintControlToken(sup.controlToken, 'op_01JTESTCONTROL0000000000001', now);
    assert.equal(verifyJwtHs256(good, sup.controlToken, now, { audience: CONTROL_TOKEN_AUDIENCE }).ok, true);
    assert.equal((await post({ [CONTROL_TOKEN_HEADER]: good, [OPERATION_HEADER]: 'op_01JTESTCONTROL0000000000002' })).status, 401, 'bound to its operation');
    assert.equal((await post({ [CONTROL_TOKEN_HEADER]: good })).status, 401, 'no operation named');
    assert.equal((await post({ [CONTROL_TOKEN_HEADER]: mintControlToken(sup.controlToken, 'op_01JTESTCONTROL0000000000001', now - 10 * 60_000) , [OPERATION_HEADER]: 'op_01JTESTCONTROL0000000000001' })).status, 401, 'expired');
    assert.equal((await post({ [CONTROL_TOKEN_HEADER]: mintControlToken('another-token-xxxxxxxxxxxx', 'op_01JTESTCONTROL0000000000001', now), [OPERATION_HEADER]: 'op_01JTESTCONTROL0000000000001' })).status, 401, 'signed with another key');
    const ok = await post({ [CONTROL_TOKEN_HEADER]: good, [OPERATION_HEADER]: 'op_01JTESTCONTROL0000000000001' });
    assert.notEqual(ok.status, 401, `accepted (got ${ok.status})`);
  });
});

test('env.process never sends the long-lived control token: each request carries a token minted for its operation', async () => {
  const RAW = 'raw-control-token-0123456789abcdef';
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const fake = await startServer(async (req, res) => {
    headers.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ operationId: req.headers[OPERATION_HEADER], state: 'completed', generation: 2 }));
  });
  try {
    const environments = createEnvironmentRegistry([{ environmentId: 'svc', environmentClass: 'local', generation: 1, control: { kind: 'process', target: `${fake.url}/__hypertest#token=${RAW}` } }]);
    const adapter = new ProcessEnvAdapter({ environments });
    const operation = { operationId: 'op_01JTESTCONTROL0000000000009', operationType: 'env.restart' } as unknown as OperationRecord;
    const op = { operation, signal: new AbortController().signal };
    const prepared = await adapter.prepare(op, { environmentId: 'svc' } as never);
    await adapter.dispatch(prepared, op);
    const sent = String(headers[0]![CONTROL_TOKEN_HEADER]);
    assert.notEqual(sent, RAW);
    assert.equal(JSON.stringify(headers).includes(RAW), false, 'the raw control token never travels');
    const v = verifyJwtHs256(sent, RAW, Date.now(), { audience: CONTROL_TOKEN_AUDIENCE });
    assert.ok(v.ok);
    assert.equal(v.claims['op'], operation.operationId);
    assert.ok((v.claims['exp'] as number) * 1000 - Date.now() <= 120_000, 'short-lived');
  } finally {
    await fake.close();
  }
});
