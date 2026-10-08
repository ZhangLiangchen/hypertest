/**
 * Side-effect governance of the tools package (audit wave 2):
 *  - E[2] the sandbox egress relay is protocol-aware: a sandboxed command's state-changing request to the SUT becomes a
 *    ledgered operation (operation id, Idempotency-Key, evidence; a replay answers from the record and never re-sends) or
 *    is refused with the exact reason; non-HTTP traffic is refused unless the environment allows raw egress.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import {
  AdapterRegistry, createLeaseService, createOperationLedger, createSideEffectGateway, type SideEffectGateway,
} from '@hypertest/operation';
import { ApprovalGatedPolicyEngine, createApprovalService } from '@hypertest/policy';
import {
  SANDBOX_HTTP_OPERATION, builtinTools, createLocalSandbox, networkIsolation, recordEffectAdapters, type EgressEndpointPolicy, type EgressWritePolicy, type SandboxRunner, type WorkspaceHandle,
} from '../src/index.ts';
import { ALL_EFFECTS_PROFILE, capability, openToolEnv, request, runtimeFor, snapshot, type ToolEnv } from './helpers.ts';

interface Sut {
  server: Server;
  port: number;
  writes: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }>;
  raw: string[];
}

async function startSut(): Promise<Sut> {
  const writes: Sut['writes'] = [];
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') writes.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, n: writes.length }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as { port: number }).port, writes, raw: [] };
}

/** A script a sandboxed `node -e` runs: one request, prints `status body` (or `blocked:<error>`). */
function fetchScript(port: number, method: string, path: string, body?: string): string {
  const init = body === undefined ? `{ method: '${method}' }` : `{ method: '${method}', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(body)} }`;
  return `fetch('http://127.0.0.1:${port}${path}', ${init}).then(async (r) => process.stdout.write(r.status + ' ' + (await r.text())), (e) => process.stdout.write('blocked:' + (e.cause?.code ?? e.message)))`;
}

describe('E[2]: sandboxed commands reach the SUT only through the protocol-aware egress relay', () => {
  let env: ToolEnv;
  let sut: Sut;
  let gateway: SideEffectGateway;
  let jail = true;
  let skipReason = '';
  const sandboxFor = (writes: EgressWritePolicy, policy: Partial<EgressEndpointPolicy> = {}): SandboxRunner =>
    // (review) the relayed writes are authorized as external effects on a REGISTERED environment (env_local: class local)
    createLocalSandbox({ killGraceMs: 300, egress: () => [{ origin: `http://127.0.0.1:${sut.port}`, resource: 'env/env_local', ...policy }], egressWrites: writes });
  const loopbackWs = async (id: string): Promise<WorkspaceHandle> => {
    const w = await env.workspaces.scratch({ runId: 'run_tools', workItemId: id });
    return { ...w, sandbox: { kind: 'local', network: 'loopback', envAllowlist: [] } };
  };

  before(async () => {
    const iso = await networkIsolation();
    if (!iso.available || !iso.jail) {
      jail = false;
      skipReason = `relayed egress needs the jail strategy: ${iso.available ? iso.strategy : iso.reason}`;
    }
    env = await openToolEnv();
    sut = await startSut();
    const deps = { ...env.deps, db: env.db, events: env.events };
    gateway = createSideEffectGateway({ ...deps, ledger: createOperationLedger(deps), leases: createLeaseService(deps), adapters: new AdapterRegistry(recordEffectAdapters()), pollIntervalMs: 5 });
  });
  after(async () => {
    await new Promise<void>((r) => sut.server.close(() => r()));
    await env.dispose();
  });

  test('audit egress probe: a sandboxed `node -e fetch(POST)` outside a governed call is refused (403, exact reason); the SUT receives nothing; GET still works', async (t) => {
    if (!jail) return t.skip(skipReason);
    const sb = sandboxFor('ledger');
    const ws = await loopbackWs('wi_probe');
    const r = await sb.run(ws, ['node', '-e', fetchScript(sut.port, 'POST', '/orders', '{}')], { timeoutMs: 20_000, signal: new AbortController().signal });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /^403 /);
    assert.match(r.stdout, /state-changing request POST http:\/\/127\.0\.0\.1:\d+\/orders from a sandboxed command refused: the command runs outside a governed tool call/);
    assert.deepEqual(sut.writes, [], 'the SUT never received the POST');
    const get = await sb.run(ws, ['node', '-e', fetchScript(sut.port, 'GET', '/orders')], { timeoutMs: 20_000, signal: new AbortController().signal });
    assert.match(get.stdout, /^200 \{"method":"GET","url":"\/orders"/, 'safe methods are relayed as they are');
  });

  test('ledger policy: shell.exec POSTs become sandbox.http operations (Idempotency-Key = operation id, api-response evidence); a replay of the same invocation answers from the record and never re-sends', async (t) => {
    if (!jail) return t.skip(skipReason);
    const sb = sandboxFor('ledger');
    const runtime = runtimeFor(env, builtinTools({ sandbox: sb, workspaces: env.workspaces }), { sideEffects: gateway });
    const ws = await loopbackWs('wi_ledger');
    const before = sut.writes.length;
    const invocationId = 'sess_egress:1:post';
    const input = { command: ['node', '-e', fetchScript(sut.port, 'POST', '/transfers', '{"amount":-1}')] };
    const first = await runtime.execute(request('shell.exec', input, ws, { invocationId }));
    assert.equal(first.status, 'success', first.modelText);
    assert.match(first.modelText, /201 \{"method":"POST","url":"\/transfers"/);
    assert.equal(sut.writes.length, before + 1, 'sent once');
    const sent = sut.writes.at(-1)!;
    const ops = (await createOperationLedger({ ...env.deps, db: env.db, events: env.events }).list({ runId: 'run_tools' })).filter((o) => o.operationType === SANDBOX_HTTP_OPERATION && o.toolInvocationId?.startsWith(`${invocationId}#egress:`));
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.status, 'verified');
    assert.equal(sent.headers['idempotency-key'], ops[0]!.operationId, 'idempotencyKey = operationId is sent to the target');
    assert.equal(ops[0]!.idempotencyKey, ops[0]!.operationId);
    const evidence = await env.evidence.query({ runId: 'run_tools', evidenceType: 'api-response' });
    const relayed = evidence.find((e) => e.operationId === ops[0]!.operationId);
    assert.ok(relayed, 'the exchange is api-response evidence of the operation');
    assert.ok(first.modelText.includes(`evidence ${relayed.evidenceId}`), 'the call names the side effect its command caused (and its evidence)');
    assert.match(first.modelText, new RegExp(`\\[sandbox egress: POST http://127\\.0\\.0\\.1:\\d+/transfers → 201 Created \\(relayed for a sandboxed command; operation ${ops[0]!.operationId}\\)`));
    assert.equal(relayed.toolInvocationId, invocationId, 'attributed to the tool call that ran the command');

    // a durable replay of the SAME invocation: the command runs again, the SUT is not written to again
    const replay = await runtime.execute(request('shell.exec', input, ws, { invocationId }));
    assert.equal(replay.status, 'success', replay.modelText);
    assert.match(replay.modelText, /201 \{"method":"POST","url":"\/transfers"/, 'the recorded response is answered');
    assert.equal(sut.writes.length, before + 1, 'replays never re-execute side effects');
    // a NEW invocation is a new decision: sent again
    await runtime.execute(request('shell.exec', input, ws, { invocationId: 'sess_egress:2:post' }));
    assert.equal(sut.writes.length, before + 2);
  });

  test('refuse policy (stricter): the write is refused with 403 and the exact reason; nothing reaches the SUT', async (t) => {
    if (!jail) return t.skip(skipReason);
    const sb = sandboxFor('refuse');
    const runtime = runtimeFor(env, builtinTools({ sandbox: sb, workspaces: env.workspaces }), { sideEffects: gateway });
    const ws = await loopbackWs('wi_refuse');
    const before = sut.writes.length;
    const r = await runtime.execute(request('shell.exec', { command: ['node', '-e', fetchScript(sut.port, 'DELETE', '/orders/1')] }, ws));
    // (review) a call whose write governance refused is a tool FAULT (never an outcome of the SUT)
    assert.deepEqual([r.status, r.error?.code], ['failed', 'egress_refused']);
    assert.match(r.error!.message, /1 state-changing request\(s\) of this call's commands .* were refused or left unsettled by sandbox egress governance/);
    assert.match(r.modelText, /403 .*state-changing request DELETE http:\/\/127\.0\.0\.1:\d+\/orders\/1 from a sandboxed command refused \(sandbox\.egressWrites: refuse\)/);
    assert.equal(sut.writes.length, before);
  });

  test('a work claim lost meanwhile (commit guard) and a refused resource claim (egress guard) both refuse the relayed write', async (t) => {
    if (!jail) return t.skip(skipReason);
    const sb = sandboxFor('ledger');
    const runtime = runtimeFor(env, builtinTools({ sandbox: sb, workspaces: env.workspaces }), { sideEffects: gateway });
    const ws = await loopbackWs('wi_guards');
    const before = sut.writes.length;
    const fenced = await runtime.execute(request('shell.exec', { command: ['node', '-e', fetchScript(sut.port, 'POST', '/a', '{}')] }, ws, { commitGuard: async () => 'work item wi_1 is no longer held with fencing token 2' }));
    assert.match(fenced.modelText, /403 .*claim_fenced: work item wi_1 is no longer held with fencing token 2; nothing was dispatched/);
    const claimed = await runtime.execute(request('shell.exec', { command: ['node', '-e', fetchScript(sut.port, 'POST', '/b', '{}')] }, ws, { egressGuard: async (resource) => `${resource} is held by experiment exp_other (fault_exclusive)` }));
    assert.match(claimed.modelText, /403 .*POST http:\/\/127\.0\.0\.1:\d+\/b refused: env\/env_local is held by experiment exp_other/);
    assert.equal(sut.writes.length, before, 'neither write reached the SUT');
  });

  test('non-HTTP traffic is refused (connection closed) unless the environment allows raw egress', async (t) => {
    if (!jail) return t.skip(skipReason);
    const ws = await loopbackWs('wi_raw');
    const rawSeen: string[] = [];
    const tcp = createTcpServer((s) => s.on('data', (d: Buffer) => {
      rawSeen.push(d.toString('utf8'));
      s.end('PONG');
    }));
    // a raw TCP listener stands in for a database port of the environment
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
    const port = (tcp.address() as { port: number }).port;
    const script = `const s=require('node:net').connect(${port},'127.0.0.1',()=>s.write('PING\\r\\n'));let out='';s.on('data',d=>out+=d);s.on('close',()=>process.stdout.write('closed:'+out));s.on('error',e=>process.stdout.write('error:'+e.code))`;
    try {
      const closed = await createLocalSandbox({ egress: () => [{ origin: `http://127.0.0.1:${port}`, resource: 'env/db' }] }).run(ws, ['node', '-e', script], { timeoutMs: 20_000, signal: new AbortController().signal });
      assert.equal(closed.stdout, 'closed:', 'not HTTP: the relay closed the connection without forwarding');
      assert.deepEqual(rawSeen, []);
      const raw = await createLocalSandbox({ egress: () => [{ origin: `http://127.0.0.1:${port}`, resource: 'env/db', raw: true }] }).run(ws, ['node', '-e', script], { timeoutMs: 20_000, signal: new AbortController().signal });
      assert.equal(raw.stdout, 'closed:PONG', 'the operator allowed raw egress for this environment');
      assert.deepEqual(rawSeen, ['PING\r\n']);
    } finally {
      await new Promise<void>((r) => tcp.close(() => r()));
    }
  });
  test('(review) a relayed write is authorized like a tool call of its own: an environment class the capability does not grant, a staging environment (approval required) and the control namespace are refused — nothing reaches the SUT, no approval is filed', async (t) => {
    if (!jail) return t.skip(skipReason);
    const before = sut.writes.length;
    const ws = await loopbackWs('wi_authz');
    const sb = sandboxFor('ledger');
    // 1) a capability confined to `sandbox` environments: its commands never write to a `local` (or staging…) environment
    const runtime = runtimeFor(env, builtinTools({ sandbox: sb, workspaces: env.workspaces }), { sideEffects: gateway });
    const confined = capability({ profile: { ...ALL_EFFECTS_PROFILE, name: 'sandbox_only', environmentClasses: ['sandbox'] } });
    const otherClass = await runtime.execute(request('shell.exec', { command: ['node', '-e', fetchScript(sut.port, 'POST', '/orders', '{}')] }, ws, { capability: confined }));
    assert.deepEqual([otherClass.status, otherClass.error?.code], ['failed', 'egress_refused'], otherClass.modelText);
    assert.match(otherClass.modelText, /403 .*POST http:\/\/127\.0\.0\.1:\d+\/orders refused: capability_denied: environment_not_permitted: local/);
    assert.equal(sut.writes.length, before);
    // the tool grant is what lets a command exercise the SUT: a test author's regression run (no `external` effect, no
    // env/** scope — what http.request would need) writes to a local environment it may act on, as a ledgered operation
    const author = capability({ profile: { ...ALL_EFFECTS_PROFILE, name: 'test_author_like', allowedEffects: ['read', 'record', 'write_workspace', 'execute'], resourceScopes: ['workspace/**', 'run/**'] } });
    const authored = await runtime.execute(request('shell.exec', { command: ['node', '-e', fetchScript(sut.port, 'POST', '/accounts', '{}')] }, ws, { capability: author }));
    assert.match(authored.modelText, /201 \{"method":"POST","url":"\/accounts"/, authored.modelText);
    assert.equal(authored.status, 'success', 'nothing was refused');
    assert.equal(sut.writes.length, before + 1);
    // 2) a staging environment: the policy requires an approval, which a sandboxed command cannot wait for — refused, and
    //    no approval request is filed (a write that needs one goes through http.request)
    env.environments.register({ environmentId: 'stg', environmentClass: 'staging', baseUrl: `http://127.0.0.1:${sut.port}`, generation: 1 });
    const approvals = createApprovalService({ ...env.deps, db: env.db, events: env.events });
    const gated = runtimeFor(env, builtinTools({ sandbox: createLocalSandbox({ killGraceMs: 300, egress: () => [{ origin: `http://127.0.0.1:${sut.port}`, resource: 'env/stg' }] }), workspaces: env.workspaces }), {
      sideEffects: gateway, policy: new ApprovalGatedPolicyEngine(env.policy, { approvals, clock: env.deps.clock }),
    });
    const staging = await gated.execute(request('shell.exec', { command: ['node', '-e', fetchScript(sut.port, 'PUT', '/config', '{}')] }, ws, { capability: capability({ profile: { ...ALL_EFFECTS_PROFILE, environmentClasses: ['local', 'sandbox', 'staging'] } }) }));
    assert.match(staging.modelText, /403 .*PUT http:\/\/127\.0\.0\.1:\d+\/config refused: approval required .*rule:approve-external-staging.*send this request with the http\.request tool/);
    assert.deepEqual(await approvals.list({ runId: 'run_tools' }), [], 'no approval request is filed for a relayed write');
    // 3) the environment-control namespace is out of reach for every method
    const control = await runtime.execute(request('shell.exec', { command: ['node', '-e', fetchScript(sut.port, 'GET', '/__hypertest/status')] }, ws));
    assert.match(control.modelText, /403 .*__hypertest is the reserved environment-control namespace; use the env\.\* tools/);
    assert.equal(sut.writes.length, before + 1, 'nothing else reached the SUT');
    const decisions = await env.db.query<{ tool: string; decision: string }>(`SELECT tool, decision FROM ht_policy_decisions WHERE run_id = 'run_tools' AND tool = 'shell.exec' AND effect = 'external'`);
    assert.ok(decisions.rows.some((r) => r.decision === 'approval_required'), 'the relayed write\'s permit is in the decision log');
  });

  test('(review) a method-override header turns a safe method into a write: GET + X-HTTP-Method-Override: DELETE is refused under `refuse` and ledgered under `ledger`', async (t) => {
    if (!jail) return t.skip(skipReason);
    const ws = await loopbackWs('wi_override');
    const script = `fetch('http://127.0.0.1:${sut.port}/orders/7', { method: 'GET', headers: { 'X-HTTP-Method-Override': 'DELETE' } }).then(async (r) => process.stdout.write(r.status + ' ' + (await r.text())))`;
    const seen: string[] = [];
    const tap = (req: { method?: string; headers: IncomingHttpHeaders; url?: string }) => {
      if (req.headers['x-http-method-override']) seen.push(`${req.method} ${req.url}`);
    };
    sut.server.on('request', tap);
    try {
      const refused = await runtimeFor(env, builtinTools({ sandbox: sandboxFor('refuse'), workspaces: env.workspaces }), { sideEffects: gateway }).execute(request('shell.exec', { command: ['node', '-e', script] }, ws));
      assert.match(refused.modelText, /403 .*GET \(as DELETE\) http:\/\/127\.0\.0\.1:\d+\/orders\/7 from a sandboxed command refused \(sandbox\.egressWrites: refuse\)/);
      assert.deepEqual(seen, [], 'the overridden GET never reached the SUT');
      const ledgered = await runtimeFor(env, builtinTools({ sandbox: sandboxFor('ledger'), workspaces: env.workspaces }), { sideEffects: gateway }).execute(request('shell.exec', { command: ['node', '-e', script] }, ws, { invocationId: 'sess_override:1:c1' }));
      assert.match(ledgered.modelText, /\[sandbox egress: GET \(as DELETE\) http:\/\/127\.0\.0\.1:\d+\/orders\/7 → 200/);
      assert.deepEqual(seen, ['GET /orders/7'], 'sent once, as a ledgered operation');
      const ops = (await createOperationLedger({ ...env.deps, db: env.db, events: env.events }).list({ runId: 'run_tools' })).filter((o) => o.toolInvocationId?.startsWith('sess_override:1:c1#egress:'));
      assert.equal(ops.length, 1);
    } finally {
      sut.server.off('request', tap);
    }
  });
  test('(review) relayed writes belong to the decision of their call (validated before the command started): a concurrent change never cuts a test run in half; a durable REPLAY of a write already dispatched answers its recorded response (never re-sent, never re-decided)', async (t) => {
    if (!jail) return t.skip(skipReason);
    let envStale = false;
    const checked: string[][] = [];
    const freshness = {
      validate: async (_s: unknown, a: { resources: string[] }) => {
        checked.push(a.resources);
        return envStale && a.resources.some((r) => r.startsWith('env/'))
          ? { fresh: false as const, checked: 1, stale: [{ resourceType: 'environment', resourceId: 'env_local', reason: 'generation 1 is now 2' }] }
          : { fresh: true as const, checked: 1 };
      },
    };
    const runtime = runtimeFor(env, builtinTools({ sandbox: sandboxFor('ledger'), workspaces: env.workspaces }), { sideEffects: gateway, freshness });
    const ws = await loopbackWs('wi_fresh');
    const before = sut.writes.length;
    const input = { command: ['node', '-e', `${fetchScript(sut.port, 'POST', '/fresh', '{"n":1}')}.then(() => ${fetchScript(sut.port, 'POST', '/fresh', '{"n":2}')})`] };
    envStale = true; // the environment moves on while (or before) the command runs: its writes are not re-decided one by one
    const first = await runtime.execute(request('shell.exec', input, ws, { invocationId: 'sess_fresh:1:c1', snapshot: snapshot() }));
    assert.equal(first.status, 'success', first.modelText);
    assert.equal(sut.writes.length, before + 2, 'both writes of the command were sent');
    assert.ok(checked.length > 0 && checked.every((r) => !r.some((x) => x.startsWith('env/'))), 'only the call itself was validated (before the command started)');
    const replay = await runtime.execute(request('shell.exec', input, ws, { invocationId: 'sess_fresh:1:c1', snapshot: snapshot() }));
    assert.match(replay.modelText, /201 \{"method":"POST","url":"\/fresh"/, 'the replay answers the recorded responses');
    assert.equal(replay.status, 'success');
    assert.equal(sut.writes.length, before + 2, 'the replay never re-sent');
  });
});
