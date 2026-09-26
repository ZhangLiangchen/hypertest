import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { FixedClock } from '@hypertest/core';
import { OpaPolicyEngine } from '../src/index.ts';
import { NOW, cap, request } from './helpers.ts';

// Hermetic: a localhost mock of the OPA data API started in-test.
let server: Server;
let base = '';
let handler: (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void = () => undefined;
const seen: Array<{ url: string; body: Record<string, unknown> }> = [];

before(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = data ? (JSON.parse(data) as Record<string, unknown>) : {};
      seen.push({ url: req.url ?? '', body });
      handler(body, req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const opa = (o: Partial<ConstructorParameters<typeof OpaPolicyEngine>[0]> = {}) =>
  new OpaPolicyEngine({ url: base, revision: 'opa@test', timeoutMs: 500, newId: () => 'pdec_opa', clock: new FixedClock(NOW), ...o });

test('posts {input: request} to /v1/data/<path> (signature stripped) and maps allow', async () => {
  seen.length = 0;
  handler = (_b, _req, res) => json(res, 200, { result: { allow: true, reasons: ['read ok'], constraints: { allowedHosts: ['h.test'] } } });
  const p = await opa().evaluate(request({ capability: { ...cap(), signature: 'sig' } }));
  assert.deepEqual(p, { decision: 'allow', decisionId: 'pdec_opa', reasons: ['read ok'], policyRevision: 'opa@test', constraints: { allowedHosts: ['h.test'] } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, '/v1/data/hypertest/authz');
  const input = seen[0]!.body['input'] as Record<string, unknown>;
  assert.equal(input['tool'], 'fs.read');
  assert.equal((input['capability'] as Record<string, unknown>)['signature'], undefined);
});

test('maps approval_required and deny; dotted paths are converted', async () => {
  seen.length = 0;
  handler = (_b, _req, res) => json(res, 200, { result: { allow: false, approval_required: true, reasons: ['staging'] } });
  const a = await opa({ path: 'hypertest.custom' }).evaluate(request());
  assert.equal(a.decision, 'approval_required');
  assert.equal(seen[0]!.url, '/v1/data/hypertest/custom');
  handler = (_b, _req, res) => json(res, 200, { result: { allow: false } });
  const d = await opa().evaluate(request());
  assert.deepEqual(d.reasons, ['opa:deny']);
  assert.equal(d.decision, 'deny');
});

test('fail closed: undefined decision document ⇒ deny opa_unavailable', async () => {
  handler = (_b, _req, res) => json(res, 200, {});
  const p = await opa().evaluate(request());
  assert.equal(p.decision, 'deny');
  assert.deepEqual(p.reasons, ['opa_unavailable', 'undefined decision document']);
});

test('fail closed: malformed decision (non-boolean allow, bad constraints) ⇒ deny', async () => {
  handler = (_b, _req, res) => json(res, 200, { result: { allow: 'yes' } });
  assert.deepEqual((await opa().evaluate(request())).reasons, ['opa_unavailable', 'decision document has no boolean allow']);
  handler = (_b, _req, res) => json(res, 200, { result: { allow: true, constraints: { maxDurationMs: 'long' } } });
  const p = await opa().evaluate(request());
  assert.equal(p.decision, 'deny');
  assert.deepEqual(p.reasons, ['opa_unavailable', 'malformed constraints']);
});

test('fail closed: HTTP 500 ⇒ deny', async () => {
  handler = (_b, _req, res) => json(res, 500, { code: 'internal_error' });
  const p = await opa().evaluate(request());
  assert.equal(p.decision, 'deny');
  assert.deepEqual(p.reasons, ['opa_unavailable', 'http_status: 500']);
});

test('fail closed: timeout ⇒ deny', async () => {
  handler = () => undefined; // never answers
  const started = Date.now();
  const p = await opa({ timeoutMs: 150 }).evaluate(request());
  assert.equal(p.decision, 'deny');
  assert.deepEqual(p.reasons, ['opa_unavailable', 'timeout after 150ms']);
  assert.ok(Date.now() - started < 2000);
});

test('fail closed: unreachable server ⇒ deny', async () => {
  const p = await new OpaPolicyEngine({ url: 'http://127.0.0.1:1', revision: 'opa@dead', timeoutMs: 500 }).evaluate(request());
  assert.equal(p.decision, 'deny');
  assert.equal(p.reasons[0], 'opa_unavailable');
});

test('the capability is checked locally before OPA is consulted', async () => {
  seen.length = 0;
  handler = (_b, _req, res) => json(res, 200, { result: { allow: true } });
  const p = await opa().evaluate(request({ capability: cap({ allowedEffects: ['record'] }) }));
  assert.equal(p.decision, 'deny');
  assert.deepEqual(p.reasons, ['capability_denied: effect_not_permitted: read']);
  assert.equal(seen.length, 0);
});

test('OPA is not consulted for a capability used by another agent or a malformed request (deny locally)', async () => {
  seen.length = 0;
  handler = (_b, _req, res) => json(res, 200, { result: { allow: true } });
  const foreign = await opa().evaluate(request({ agentId: 'agent_other' }));
  assert.equal(foreign.decision, 'deny');
  assert.deepEqual(foreign.reasons, ['capability_subject_mismatch: agent_1 != agent_other']);
  const malformed = await opa().evaluate(request({ resources: undefined as never }));
  assert.deepEqual(malformed.reasons, ['malformed_request: resources']);
  assert.equal(seen.length, 0);
});

test('the OPA decision path is restricted to package segments', () => {
  for (const path of ['../policies/x', 'hypertest/authz?pretty=true', 'hypertest/%2e%2e', 'a b']) {
    assert.throws(() => opa({ path }), { code: 'invalid_argument' }, path);
  }
  assert.equal(opa({ path: '/hypertest.authz_v2/' }).endpoint, `${base}/v1/data/hypertest/authz_v2`);
});

test('BUGate phases: OPA always receives the phase (absent ⇒ before_action) and the phase facts in its input', async () => {
  seen.length = 0;
  handler = (b, _req, res) => {
    const input = b['input'] as Record<string, unknown>;
    // a phase-aware document: flag after_action evidence the tool does not declare, withhold a flagged acceptance
    const outcome = input['outcome'] as { undeclaredEvidenceTypes?: string[] } | undefined;
    const acceptance = input['acceptance'] as { flaggedActions?: number } | undefined;
    if (input['phase'] === 'after_action' && (outcome?.undeclaredEvidenceTypes?.length ?? 0) > 0) return json(res, 200, { result: { allow: false, reasons: ['undeclared evidence'] } });
    if (input['phase'] === 'before_acceptance' && (acceptance?.flaggedActions ?? 0) > 0) return json(res, 200, { result: { allow: false, approval_required: true, reasons: ['flagged run'] } });
    return json(res, 200, { result: { allow: true, reasons: [`ok ${String(input['phase'])}`] } });
  };
  const e = opa();
  assert.deepEqual((await e.evaluate(request())).reasons, ['ok before_action']);
  const after = await e.evaluate(request({ phase: 'after_action', outcome: { status: 'success', evidenceTypes: ['test-result'], evidenceIds: ['ev_1'], declaredEvidenceTypes: ['stdout'], undeclaredEvidenceTypes: ['test-result'] } }));
  assert.deepEqual([after.decision, after.reasons], ['deny', ['undeclared evidence']]);
  const transition = await e.evaluate(request({ phase: 'before_transition', transition: { subject: 'plan', subjectId: 'plan_1', from: 'proposed', to: 'accepted', flaggedActions: 0 } }));
  assert.deepEqual(transition.reasons, ['ok before_transition']);
  const acceptance = await e.evaluate(request({
    phase: 'before_acceptance',
    acceptance: {
      gateId: 'g', gateOverrides: [], verdict: 'pass', requiresHumanReview: false, satisfiedCriteria: [], violatedCriteria: [], unknownCriteria: [], evidence: { count: 0, rootHash: 'r', byType: {} },
      findings: { total: 0, unresolved: [] }, risks: { total: 0, unresolved: [] }, reviews: [], oracleRevisions: {}, workItems: {}, claims: { total: 0, critical: 0 }, exceptions: [], flaggedActions: 1,
    },
  }));
  assert.equal(acceptance.decision, 'approval_required');
  const phases = seen.map((s) => (s.body['input'] as Record<string, unknown>)['phase']);
  assert.deepEqual(phases, ['before_action', 'after_action', 'before_transition', 'before_acceptance']);
  assert.deepEqual(((seen[2]!.body['input'] as Record<string, unknown>)['transition'] as Record<string, unknown>)['to'], 'accepted');
});
