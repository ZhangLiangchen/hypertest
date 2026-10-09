/**
 * (review, E[2] / I4 / I-chain) Sandbox egress governance on the PRODUCTION composition (createHypertest: the composed
 * ToolRuntime, local sandbox with its HTTP-aware relays, SideEffectGateway, approval-gated policy and decision log).
 *  - the audit's probe: a sandboxed `node -e fetch(POST)` to a registered environment reached the SUT un-ledgered; now it
 *    is a `sandbox.http` operation (operation id = Idempotency-Key, api-response evidence), authorized like a tool call;
 *  - a capability confined to local/sandbox never writes to a staging environment from its commands (a test author's
 *    regression run still exercises the local SUT through its tool grant — ledgered);
 *  - a write that needs a human approval (staging) is refused and files no approval request;
 *  - a durable replay of the call answers the recorded response and never re-sends.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { createRootCapability } from '@hypertest/policy';
import { tempDir } from '@hypertest/testkit';
import { networkIsolation, SANDBOX_HTTP_OPERATION } from '@hypertest/tools';
import { createHypertest, loadCapabilitySecret, type HypertestConfig, type HypertestInstance } from '../src/index.ts';
import { roleRouter, scriptedConfig, testStore } from './helpers.ts';

interface Sut {
  server: Server;
  port: number;
  writes: Array<{ method: string; url: string; key: string | undefined }>;
}

async function startSut(): Promise<Sut> {
  const writes: Sut['writes'] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        const key = req.headers['idempotency-key'];
        writes.push({ method: req.method ?? '', url: req.url ?? '', key: Array.isArray(key) ? key[0] : key });
      }
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as { port: number }).port, writes };
}

function fetchScript(port: number, method: string, path: string): string {
  return `fetch('http://127.0.0.1:${port}${path}', { method: '${method}', headers: { 'content-type': 'application/json' }, body: ${method === 'GET' ? 'undefined' : "'{}'"} }).then(async (r) => process.stdout.write(r.status + ' ' + (await r.text())), (e) => process.stdout.write('blocked:' + (e.cause?.code ?? e.message)))`;
}

describe('(review) sandbox egress governance on the production composition', () => {
  let jail = true;
  let skipReason = '';
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  let local: Sut;
  let staging: Sut;
  let ht: HypertestInstance;

  before(async () => {
    const iso = await networkIsolation();
    if (!iso.available || !iso.jail) {
      jail = false;
      skipReason = `relayed egress needs the jail strategy: ${iso.available ? iso.strategy : iso.reason}`;
      return;
    }
    dir = await tempDir('ht-app-egress-');
    db = await testStore();
    local = await startSut();
    staging = await startSut();
    const base = scriptedConfig(dir.path, {
      environments: [
        { environmentId: 'shop', environmentClass: 'local', baseUrl: `http://127.0.0.1:${local.port}`, generation: 1 },
        { environmentId: 'stg', environmentClass: 'staging', baseUrl: `http://127.0.0.1:${staging.port}`, generation: 1 },
      ],
    } as never);
    const config: HypertestConfig = db.store ? { ...base, store: db.store } : base;
    ht = await createHypertest(config, { scriptedBrains: { sim: roleRouter({}) }, logger: new MemoryLogger() });
  });
  after(async () => {
    await ht?.close();
    for (const s of [local, staging]) if (s) await new Promise<void>((r) => s.server.close(() => r()));
    await db?.dispose();
    await dir?.cleanup();
  });

  test('a sandboxed POST is an authorized, ledgered sandbox.http operation; an executor cannot write to staging; staging needs an approval a command cannot wait for; a replay never re-sends', async (t) => {
    if (!jail) return t.skip(skipReason);
    const run = await ht.control.startRun({ goal: 'egress governance', target: {} }, { actorId: 'system:test' });
    const snapshot = await ht.control.snapshot(run.runId);
    const secret = await loadCapabilitySecret(ht.config, ht.config.project.dataDir, process.env, new MemoryLogger());
    const workspace = await ht.services.workspaces!.scratch({ runId: run.runId, workItemId: 'wi_egress' });
    const request = (profile: 'test_executor' | 'test_author' | 'environment_operator', command: string[], invocationId: string) => ({
      toolId: 'shell.exec', input: { command }, invocationId, runId: run.runId, workItemId: 'wi_egress', agentId: 'ag_egress', role: 'executor',
      capability: createRootCapability({ runId: run.runId, subjectAgentId: 'ag_egress', workItemId: 'wi_egress', profile, tools: ['shell.exec'], expiresAt: '2099-01-01T00:00:00.000Z' }, secret),
      workspace, snapshot, eventContext: { runId: run.runId, correlationId: invocationId, actorId: 'agent:ag_egress', agentId: 'ag_egress', workItemId: 'wi_egress' }, signal: new AbortController().signal,
    });

    // 1) the executor's command POSTs to the local environment: authorized, ledgered, sent once with Idempotency-Key = operation id
    const posted = await ht.services.toolRuntime!.execute(request('test_executor', ['node', '-e', fetchScript(local.port, 'POST', '/orders')], 'sess_eg:1:c1'));
    assert.equal(posted.status, 'success', posted.modelText);
    assert.match(posted.modelText, /--- stdout ---\n201 \{"method":"POST","url":"\/orders"\}/);
    const ops = (await ht.services.operations.list({ runId: run.runId })).filter((o) => o.operationType === SANDBOX_HTTP_OPERATION);
    assert.equal(ops.length, 1);
    assert.deepEqual([ops[0]!.status, ops[0]!.target.resourceKey], ['verified', 'env/shop']);
    assert.deepEqual(local.writes, [{ method: 'POST', url: '/orders', key: ops[0]!.operationId }], 'sent once, Idempotency-Key = operation id');
    const decisions = (await ht.events(run.runId, { types: ['policy.decided'] })).map((e) => e.payload as Record<string, unknown>);
    assert.ok(decisions.some((p) => JSON.stringify(p).includes('"external"') && JSON.stringify(p).includes('shell.exec')), 'the relayed write has its own policy decision');

    // 2) a durable replay of the same call: the recorded response is answered, nothing is sent again
    const replay = await ht.services.toolRuntime!.execute(request('test_executor', ['node', '-e', fetchScript(local.port, 'POST', '/orders')], 'sess_eg:1:c1'));
    assert.match(replay.modelText, /--- stdout ---\n201 \{"method":"POST","url":"\/orders"\}/);
    assert.equal(local.writes.length, 1);

    // 3) the executor's capability is confined to local/sandbox environments: its commands never write to staging
    const confined = await ht.services.toolRuntime!.execute(request('test_executor', ['node', '-e', fetchScript(staging.port, 'POST', '/orders')], 'sess_eg:2:c1'));
    assert.match(confined.modelText, /--- stdout ---\n403 .*POST http:\/\/127\.0\.0\.1:\d+\/orders refused: capability_denied: environment_not_permitted: staging/);
    assert.deepEqual([confined.status, confined.error?.code], ['failed', 'egress_refused'], 'a refused write makes the call a tool fault, never an SUT outcome');
    // (wave 3, item 9) what the call recorded after its refused write is kept as INCONCLUSIVE evidence (never an outcome),
    // announced by one evidence.inconclusive event naming every marked record
    const inconclusive = (await ht.events(run.runId, { types: ['evidence.inconclusive'] }))
      .map((e) => e.payload as { invocationId: string; reason: string; evidence: Array<{ evidenceId: string; originalEvidenceType: string }> })
      .filter((p) => p.invocationId === 'sess_eg:2:c1');
    assert.equal(inconclusive.length, 1);
    assert.equal(inconclusive[0]!.reason, 'egress_refused');
    const markedIds = new Set(inconclusive[0]!.evidence.map((x) => x.evidenceId));
    assert.ok(markedIds.size > 0, 'the call recorded its output after the refusal');
    const marked = (await ht.services.evidence.query({ runId: run.runId })).filter((e) => markedIds.has(e.evidenceId));
    assert.equal(marked.length, markedIds.size);
    assert.ok(marked.every((e) => e.evidenceType === 'inconclusive' && (e.structured as { reason?: string }).reason === 'egress_refused'), JSON.stringify(marked.map((e) => e.evidenceType)));
    const read = await ht.services.toolRuntime!.execute(request('test_executor', ['node', '-e', fetchScript(staging.port, 'GET', '/orders')], 'sess_eg:2:c2'));
    assert.match(read.modelText, /--- stdout ---\n200 /, 'safe methods pass');
    assert.deepEqual(staging.writes, []);
    // a test author's regression run exercises the local SUT through its tool grant (ledgered like any relayed write)
    const author = await ht.services.toolRuntime!.execute(request('test_author', ['node', '-e', fetchScript(local.port, 'POST', '/accounts')], 'sess_eg:2:c3'));
    assert.match(author.modelText, /--- stdout ---\n201 \{"method":"POST","url":"\/accounts"\}/);
    assert.equal(local.writes.length, 2);
    assert.equal((await ht.services.operations.list({ runId: run.runId })).filter((o) => o.operationType === SANDBOX_HTTP_OPERATION).length, 2);

    // 4) the environment operator writes to staging: the policy requires a human approval, which a command cannot wait for
    const before = (await ht.listApprovals({ runId: run.runId })).length;
    const stg = await ht.services.toolRuntime!.execute(request('environment_operator', ['node', '-e', fetchScript(staging.port, 'PUT', '/config')], 'sess_eg:3:c1'));
    assert.match(stg.modelText, /--- stdout ---\n403 .*PUT http:\/\/127\.0\.0\.1:\d+\/config refused: approval required .*approve-external-staging/);
    assert.deepEqual(staging.writes, []);
    assert.equal((await ht.listApprovals({ runId: run.runId })).length, before, 'no approval request is filed for a relayed write');
    await ht.cancel(run.runId, 'probe done');
  });
});
