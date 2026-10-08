/**
 * (wave 3) Sandbox egress — what the relay's governance means for the evidence of a call:
 *  - item 9: a test.run whose relayed write was refused ends failed/egress_refused AND the outcome evidence it recorded
 *    (test-result, stdout, stderr) is marked `inconclusive` (original type and payload kept inside; never eligible to
 *    satisfy or violate an assertion — the gate's checks read `test-result` / named evidence types only), announced by an
 *    `evidence.inconclusive` event naming every marked record;
 *  - row 249 network inspection: `captureNetwork: true` records every HTTP exchange of the call's commands through the
 *    relay (relayed reads, ledgered writes with their operation ids, refused requests with the reason; headers redacted)
 *    as `network-capture` evidence — which is never marked inconclusive (it is the traffic itself).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { join } from 'node:path';
import { AdapterRegistry, createLeaseService, createOperationLedger, createSideEffectGateway, type SideEffectGateway } from '@hypertest/operation';
import { builtinTools, createLocalSandbox, networkIsolation, recordEffectAdapters, type EgressWritePolicy, type SandboxRunner, type WorkspaceHandle } from '../src/index.ts';
import { openToolEnv, request, runtimeFor, type ToolEnv } from './helpers.ts';

describe('sandbox egress and the evidence of the call', () => {
  let env: ToolEnv;
  let server: Server;
  let port = 0;
  const writes: string[] = [];
  let gateway: SideEffectGateway;
  let skipReason = '';

  const sandboxFor = (mode: EgressWritePolicy): SandboxRunner =>
    createLocalSandbox({ killGraceMs: 300, egress: () => [{ origin: `http://127.0.0.1:${port}`, resource: 'env/env_local' }], egressWrites: mode });
  const workspace = async (id: string): Promise<WorkspaceHandle> => {
    const w = await env.workspaces.scratch({ runId: 'run_tools', workItemId: id });
    return { ...w, sandbox: { kind: 'local', network: 'loopback', envAllowlist: [] } };
  };

  before(async () => {
    const iso = await networkIsolation();
    if (!iso.available || !iso.jail) skipReason = `relayed egress needs the jail strategy: ${iso.available ? iso.strategy : iso.reason}`;
    env = await openToolEnv();
    server = createHttpServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.method !== 'GET') writes.push(`${req.method} ${req.url}`);
        res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json', 'set-cookie': 'session=abc' });
        res.end(JSON.stringify({ ok: true, method: req.method }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
    const deps = { ...env.deps, db: env.db, events: env.events };
    gateway = createSideEffectGateway({ ...deps, ledger: createOperationLedger(deps), leases: createLeaseService(deps), adapters: new AdapterRegistry(recordEffectAdapters()), pollIntervalMs: 5 });
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await env.dispose();
  });

  test('item 9: a test.run whose relayed write was refused records its result as INCONCLUSIVE evidence (never test-result) and emits evidence.inconclusive', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const ws = await workspace('wi_refused_test');
    await writeFile(join(ws.root, 'orders.test.mjs'), [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      `test('cancelling an order answers 200', async () => { const r = await fetch('http://127.0.0.1:${port}/orders/1', { method: 'DELETE' }); assert.equal(r.status, 200); });`,
    ].join('\n'));
    const runtime = runtimeFor(env, builtinTools({ sandbox: sandboxFor('refuse'), workspaces: env.workspaces }), { sideEffects: gateway });
    const invocationId = 'sess_inc:1:run';
    const before = writes.length;
    const out = await runtime.execute(request('test.run', { framework: 'node_test', selector: 'orders.test.mjs' }, ws, { invocationId }));
    assert.deepEqual([out.status, out.error?.code], ['failed', 'egress_refused'], out.modelText);
    assert.equal(writes.length, before, 'nothing reached the SUT');
    const ofCall = (await env.evidence.query({ runId: 'run_tools' })).filter((e) => e.toolInvocationId === invocationId);
    assert.deepEqual(ofCall.filter((e) => e.evidenceType === 'test-result'), [], 'no test-result evidence: the refused write makes the run tell nothing about the SUT');
    const inconclusive = ofCall.filter((e) => e.evidenceType === 'inconclusive');
    const original = inconclusive.map((e) => (e.structured as { originalEvidenceType: string }).originalEvidenceType).sort();
    assert.ok(original.includes('test-result'), `the test-result is kept, marked inconclusive (got ${original.join(', ')})`);
    const marked = inconclusive.find((e) => (e.structured as { originalEvidenceType: string }).originalEvidenceType === 'test-result')!;
    const s = marked.structured as { inconclusive: boolean; reason: string; refusedWrites: number; refused: string[]; original: { passed: boolean } };
    assert.deepEqual([s.inconclusive, s.reason, s.refusedWrites, s.original.passed], [true, 'egress_refused', 1, false]);
    assert.match(s.refused[0]!, /403 state-changing request DELETE http:\/\/127\.0\.0\.1:\d+\/orders\/1 from a sandboxed command refused/);
    assert.match(marked.summary, /^\[inconclusive: 1 sandbox egress write\(s\) refused\] /);
    const events = env.events.ofType('evidence.inconclusive').filter((e) => (e.payload as { invocationId: string }).invocationId === invocationId);
    assert.equal(events.length, 1);
    const p = events[0]!.payload as { toolId: string; reason: string; refusedWrites: number; evidence: Array<{ evidenceId: string; originalEvidenceType: string }> };
    assert.deepEqual([p.toolId, p.reason, p.refusedWrites], ['test.run', 'egress_refused', 1]);
    assert.deepEqual(p.evidence.map((x) => x.evidenceId).sort(), inconclusive.map((e) => e.evidenceId).sort(), 'the event names every marked record');
    // neither test.passed nor test.failed: the runtime reports the call as a fault (the control plane emits test.* only for outcomes)
    assert.equal(env.events.events.some((e) => (e.eventType === 'test.passed' || e.eventType === 'test.failed') && JSON.stringify(e.payload).includes(invocationId)), false);
  });

  test('item 9 (control): the same test whose write is ledgered is an ordinary test-result (nothing marked, no event)', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const ws = await workspace('wi_ledgered_test');
    await writeFile(join(ws.root, 'orders.test.mjs'), [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      `test('creating an order answers 201', async () => { const r = await fetch('http://127.0.0.1:${port}/orders', { method: 'POST', body: '{}' }); assert.equal(r.status, 201); });`,
    ].join('\n'));
    const runtime = runtimeFor(env, builtinTools({ sandbox: sandboxFor('ledger'), workspaces: env.workspaces }), { sideEffects: gateway });
    const invocationId = 'sess_inc:2:run';
    const out = await runtime.execute(request('test.run', { framework: 'node_test', selector: 'orders.test.mjs' }, ws, { invocationId }));
    assert.equal(out.status, 'success', out.modelText);
    const ofCall = (await env.evidence.query({ runId: 'run_tools' })).filter((e) => e.toolInvocationId === invocationId);
    assert.equal(ofCall.filter((e) => e.evidenceType === 'test-result').length, 1);
    assert.equal((ofCall.find((e) => e.evidenceType === 'test-result')!.structured as { passed: boolean }).passed, true);
    assert.deepEqual(ofCall.filter((e) => e.evidenceType === 'inconclusive'), []);
    assert.equal(env.events.ofType('evidence.inconclusive').filter((e) => (e.payload as { invocationId: string }).invocationId === invocationId).length, 0);
  });

  test('captureNetwork: every exchange of the commands (relayed read, ledgered write, refused write) is network-capture evidence with redacted headers', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const ws = await workspace('wi_capture');
    const script = [
      `const base = 'http://127.0.0.1:${port}';`,
      "(async () => {",
      "  const g = await fetch(base + '/catalog?q=1', { headers: { authorization: 'Bearer top-secret-token' } }); await g.text();",
      "  const p = await fetch(base + '/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{\"sku\":1}' }); await p.text();",
      "  process.stdout.write(g.status + ' ' + p.status);",
      "})();",
    ].join('\n');
    const runtime = runtimeFor(env, builtinTools({ sandbox: sandboxFor('ledger'), workspaces: env.workspaces }), { sideEffects: gateway });
    const out = await runtime.execute(request('shell.exec', { command: ['node', '-e', script], captureNetwork: true }, ws, { invocationId: 'sess_cap:1:x' }));
    assert.equal(out.status, 'success', out.modelText);
    const cap = (await env.evidence.query({ runId: 'run_tools', evidenceType: 'network-capture' })).filter((e) => e.toolInvocationId === 'sess_cap:1:x');
    assert.equal(cap.length, 1);
    const doc = cap[0]!.structured as { capturedBy: string; exchangeCount: number; exchanges: Array<{ method: string; url: string; outcome: string; status: number; operationId?: string; requestHeaders: Record<string, string>; responseHeaders?: Record<string, string>; responseBytes?: number }> };
    assert.equal(doc.capturedBy, 'sandbox-egress-relay');
    assert.deepEqual(doc.exchanges.map((x) => [x.method, x.url.replace(String(port), 'P'), x.outcome, x.status]), [
      ['GET', 'http://127.0.0.1:P/catalog?q=1', 'relayed', 200],
      ['POST', 'http://127.0.0.1:P/orders', 'ledgered', 201],
    ]);
    assert.equal(doc.exchanges[0]!.requestHeaders['authorization'], '[REDACTED]', 'credentials never land in evidence');
    assert.equal(doc.exchanges[0]!.responseHeaders!['set-cookie'], '[REDACTED]');
    assert.ok((doc.exchanges[0]!.responseBytes ?? 0) > 0);
    const op = (await createOperationLedger({ ...env.deps, db: env.db, events: env.events }).list({ runId: 'run_tools' })).find((o) => o.toolInvocationId?.startsWith('sess_cap:1:x#egress:'));
    assert.equal(doc.exchanges[1]!.operationId, op!.operationId, 'the ledgered write names its operation');
    assert.ok(out.evidenceRefs.includes(cap[0]!.evidenceId), 'the call names its capture');

    // without captureNetwork nothing is captured
    await runtime.execute(request('shell.exec', { command: ['node', '-e', script] }, ws, { invocationId: 'sess_cap:2:x' }));
    assert.deepEqual((await env.evidence.query({ runId: 'run_tools', evidenceType: 'network-capture' })).filter((e) => e.toolInvocationId === 'sess_cap:2:x'), []);
  });

  test('captureNetwork with a refused write: the capture shows the refusal and is NOT marked inconclusive; the outputs are', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const ws = await workspace('wi_capture_refused');
    const script = `fetch('http://127.0.0.1:${port}/orders/9', { method: 'PUT', body: 'x' }).then(async (r) => process.stdout.write(r.status + ' ' + (await r.text())))`;
    const runtime = runtimeFor(env, builtinTools({ sandbox: sandboxFor('refuse'), workspaces: env.workspaces }), { sideEffects: gateway });
    const out = await runtime.execute(request('shell.exec', { command: ['node', '-e', script], captureNetwork: true }, ws, { invocationId: 'sess_cap:3:x' }));
    assert.deepEqual([out.status, out.error?.code], ['failed', 'egress_refused']);
    const ofCall = (await env.evidence.query({ runId: 'run_tools' })).filter((e) => e.toolInvocationId === 'sess_cap:3:x');
    assert.deepEqual(ofCall.map((e) => e.evidenceType).sort(), ['inconclusive', 'network-capture']);
    const doc = ofCall.find((e) => e.evidenceType === 'network-capture')!.structured as { exchanges: Array<{ method: string; outcome: string; status: number; reason?: string }> };
    assert.deepEqual(doc.exchanges.map((x) => [x.method, x.outcome, x.status]), [['PUT', 'refused', 403]]);
    assert.match(doc.exchanges[0]!.reason!, /sandbox\.egressWrites: refuse/);
    assert.equal((ofCall.find((e) => e.evidenceType === 'inconclusive')!.structured as { originalEvidenceType: string }).originalEvidenceType, 'stdout');
  });
});
