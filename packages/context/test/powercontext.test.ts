import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { eventCtx } from '@hypertest/testkit';
import { DECISION_STATUS, PowerContextClient, canTransitionExperience, type ExperienceItem } from '../src/index.ts';
import { rejectsWith } from './helpers.ts';

/**
 * Minimal PowerContext-like service implementing the endpoint mapping the client assumes. Faults are injectable
 * per test via `mode`.
 */
interface Mock {
  items: Map<string, ExperienceItem>;
  requests: Array<{ method: string; url: string; auth?: string | undefined; runId?: string | undefined; body?: unknown }>;
  mode: 'ok' | 'error503' | 'hang' | 'stall_body' | 'leak_candidates' | 'accept_self_review' | 'garbage' | 'wrong_status' | 'wrong_id' | 'rewrite_creator' | 'ignore_filters';
}

let server: Server;
let baseUrl: string;
const mock: Mock = { items: new Map(), requests: [], mode: 'ok' };
let n = 0;

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : undefined;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const b = req.method === 'POST' ? await body(req) : undefined;
  mock.requests.push({ method: req.method ?? '', url: url.pathname + url.search, auth: req.headers['authorization'], runId: req.headers['x-hypertest-run-id'] as string | undefined, body: b });
  if (mock.mode === 'hang') return; // never answers
  if (mock.mode === 'stall_body') {
    // Headers and the start of a body, then nothing: the deadline must still fire.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"items": [');
    return;
  }
  if (mock.mode === 'error503') return send(res, 503, { error: 'overloaded' });
  if (mock.mode === 'garbage') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{not json');
    return;
  }
  const now = '2026-01-01T00:00:00.000Z';
  if (req.method === 'POST' && url.pathname === '/v1/experiences') {
    const input = b as Omit<ExperienceItem, 'experienceId' | 'status'>;
    const item: ExperienceItem = { ...input, experienceId: `pc_${++n}`, status: 'candidate', createdAt: now, updatedAt: now };
    if (mock.mode === 'rewrite_creator') item.createdBy = 'service-account';
    mock.items.set(item.experienceId, item);
    return send(res, 201, { experience: item });
  }
  const m = /^\/v1\/experiences\/([^/]+)\/review$/.exec(url.pathname);
  if (req.method === 'POST' && m) {
    const item = mock.items.get(decodeURIComponent(m[1]!));
    if (!item) return send(res, 404, { error: 'not found' });
    const { decision, reviewer } = b as { decision: keyof typeof DECISION_STATUS; reviewer: string };
    if (reviewer === item.createdBy && mock.mode !== 'accept_self_review') return send(res, 403, { error: 'self review' });
    const to = DECISION_STATUS[decision];
    if (!canTransitionExperience(item.status, to)) return send(res, 409, { error: `cannot ${item.status} -> ${to}` });
    const next = { ...item, status: to, reviewedBy: reviewer };
    mock.items.set(item.experienceId, next);
    if (mock.mode === 'wrong_status') return send(res, 200, { ...next, status: 'published' });
    if (mock.mode === 'wrong_id') return send(res, 200, { ...next, experienceId: 'pc_other' });
    return send(res, 200, next);
  }
  if (req.method === 'POST' && url.pathname === '/v1/context/prepare') {
    const { query, limit } = b as { query: string; limit: number };
    const words = query.toLowerCase().split(/\W+/).filter(Boolean);
    const all = [...mock.items.values()].filter((it) => words.some((w) => it.content.toLowerCase().includes(w)));
    const visible = mock.mode === 'leak_candidates' ? all : all.filter((it) => it.status === 'approved' || it.status === 'published');
    return send(res, 200, { items: visible.slice(0, limit), budget: { tokens: 1000 } });
  }
  if (req.method === 'GET' && url.pathname === '/v1/experiences') {
    const statuses = url.searchParams.get('status')?.split(',');
    const run = url.searchParams.get('sourceRunId');
    const items = [...mock.items.values()].filter((it) => mock.mode === 'ignore_filters' || ((!statuses || statuses.includes(it.status)) && (!run || it.sourceRunId === run)));
    return send(res, 200, { items });
  }
  send(res, 404, { error: 'no route' });
}

before(async () => {
  server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => send(res, 500, { error: String(e) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  mock.mode = 'ok';
  mock.requests = [];
});

const client = (extra: Partial<ConstructorParameters<typeof PowerContextClient>[0]> = {}) => new PowerContextClient({ baseUrl, apiKey: 'k-secret', timeoutMs: 2000, ...extra });
const proposal = (content: string, createdBy = 'agent-exec') => ({ scope: { project: 'shop' }, kind: 'lesson' as const, content, sourceRunId: 'run_pc', evidenceRefs: ['ev_9'], createdBy });

test('propose / review / retrieve / list map onto the PowerContext endpoints', async () => {
  const c = client();
  assert.equal(c.kind, 'powercontext');
  const item = await c.propose(proposal('Always seed the payment sandbox before checkout tests.'), eventCtx('run_pc'));
  assert.equal(item.status, 'candidate');
  assert.deepEqual(mock.requests[0], {
    method: 'POST',
    url: '/v1/experiences',
    auth: 'Bearer k-secret',
    runId: 'run_pc',
    body: proposal('Always seed the payment sandbox before checkout tests.'),
  });
  assert.deepEqual(await c.retrieve({ text: 'payment sandbox' }), [], 'candidates are not served');
  const approved = await c.review(item.experienceId, 'approve', 'human:alice', eventCtx('run_pc'));
  assert.equal(approved.status, 'approved');
  assert.equal(approved.reviewedBy, 'human:alice');
  assert.deepEqual(mock.requests.at(-1)!.body, { decision: 'approve', reviewer: 'human:alice' });
  assert.equal(mock.requests.at(-1)!.url, `/v1/experiences/${item.experienceId}/review`);
  const got = await c.retrieve({ text: 'payment sandbox', scope: { project: 'shop' }, limit: 3 });
  assert.deepEqual(got.map((x) => x.experienceId), [item.experienceId]);
  assert.deepEqual(mock.requests.at(-1)!.body, { query: 'payment sandbox', scope: { project: 'shop' }, limit: 3 });
  const listed = await c.list({ status: ['approved', 'published'], sourceRunId: 'run_pc' });
  assert.deepEqual(listed.map((x) => x.experienceId), [item.experienceId]);
  assert.equal(mock.requests.at(-1)!.url, '/v1/experiences?status=approved%2Cpublished&sourceRunId=run_pc');
});

test('self-review is refused client side without a request, and a server that accepts one is an integrity violation', async () => {
  const c = client();
  const item = await c.propose(proposal('Retry only idempotent calls.', 'agent-self'), eventCtx('run_pc'));
  const before = mock.requests.length;
  await rejectsWith(c.review(item.experienceId, 'approve', 'agent-self', eventCtx('run_pc')), 'permission_denied');
  assert.equal(mock.requests.length, before, 'no request was sent');
  // A fresh client does not know the creator: the server's 403 maps to permission_denied.
  await rejectsWith(client().review(item.experienceId, 'approve', 'agent-self', eventCtx('run_pc')), 'permission_denied');
  mock.mode = 'accept_self_review';
  await rejectsWith(client().review(item.experienceId, 'approve', 'agent-self', eventCtx('run_pc')), 'integrity_violation');
});

test('retrieve drops items that are not approved/published even if the service returns them', async () => {
  const logger = new MemoryLogger();
  const c = client({ logger });
  const cand = await c.propose(proposal('Quarantine me: flaky test heuristics.'), eventCtx('run_pc'));
  const ok = await c.propose(proposal('Flaky test heuristics: rerun once, then investigate.'), eventCtx('run_pc'));
  await c.review(ok.experienceId, 'approve', 'human:alice', eventCtx('run_pc'));
  const q = await c.propose(proposal('Flaky test heuristics: quarantined advice.'), eventCtx('run_pc'));
  await c.review(q.experienceId, 'quarantine', 'human:alice', eventCtx('run_pc'));
  mock.mode = 'leak_candidates';
  const got = await c.retrieve({ text: 'flaky heuristics' });
  assert.deepEqual(got.map((x) => x.experienceId), [ok.experienceId]);
  const warn = logger.entries.find((e) => e.msg.includes('non-approved'));
  assert.deepEqual(warn?.fields['dropped'], [`${cand.experienceId}:candidate`, `${q.experienceId}:quarantined`]);
});

test('errors: 5xx and timeouts are unavailable (retryable); 404/409/garbage map precisely', async () => {
  const c = client();
  mock.mode = 'error503';
  const e1 = await rejectsWith(c.retrieve({ text: 'x' }), 'unavailable');
  assert.equal(e1.retryable, true);
  assert.equal(e1.details['status'], 503);
  mock.mode = 'hang';
  const e2 = await rejectsWith(client({ timeoutMs: 100 }).list({}), 'unavailable');
  assert.equal(e2.details['timeout'], true);
  assert.match(e2.message, /timed out after 100ms/);
  mock.mode = 'garbage';
  await rejectsWith(c.list({}), 'provider_error');
  mock.mode = 'ok';
  await rejectsWith(c.review('pc_missing', 'approve', 'human:alice', eventCtx('run_pc')), 'not_found');
  const it = await c.propose(proposal('x y z'), eventCtx('run_pc'));
  await rejectsWith(c.review(it.experienceId, 'publish', 'human:alice', eventCtx('run_pc')), 'conflict');
  // Connection refused ⇒ unavailable.
  const dead = new PowerContextClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 });
  await rejectsWith(dead.list({}), 'unavailable');
  assert.throws(() => new PowerContextClient({ baseUrl: 'ftp://x', timeoutMs: 10 }), /baseUrl/);
});

test('paths are configurable', async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push(`${init?.method} ${String(input)}`);
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const c = new PowerContextClient({ baseUrl: 'https://pc.example.test/api/', timeoutMs: 100, fetchImpl, paths: { retrieve: '/prepare_context', list: '/memories' } });
  await c.retrieve({ text: 'q' });
  await c.list({});
  assert.deepEqual(seen, ['POST https://pc.example.test/api/prepare_context', 'GET https://pc.example.test/api/memories']);
});

test('the deadline covers the response body: a server that stalls after the headers is unavailable (timeout)', async () => {
  mock.mode = 'stall_body';
  const started = Date.now();
  const err = await rejectsWith(client({ timeoutMs: 150 }).list({}), 'unavailable');
  assert.equal(err.details['timeout'], true);
  assert.match(err.message, /timed out after 150ms/);
  assert.ok(Date.now() - started < 1500, 'fails at the deadline, not never');
});

test('review answers are verified: another status or another item is a provider_error, never accepted', async () => {
  const c = client();
  const it = await c.propose(proposal('Verify review answers.'), eventCtx('run_pc'));
  mock.mode = 'wrong_status';
  const e1 = await rejectsWith(c.review(it.experienceId, 'approve', 'human:alice', eventCtx('run_pc')), 'provider_error');
  assert.equal(e1.details['returnedStatus'], 'published');
  const it2 = await (mock.mode = 'ok', c.propose(proposal('Verify review ids.'), eventCtx('run_pc')));
  mock.mode = 'wrong_id';
  const e2 = await rejectsWith(c.review(it2.experienceId, 'approve', 'human:alice', eventCtx('run_pc')), 'provider_error');
  assert.equal(e2.details['returnedId'], 'pc_other');
});

test('propose must keep createdBy (it is what makes self-review detectable)', async () => {
  mock.mode = 'rewrite_creator';
  await rejectsWith(client().propose(proposal('Creator rewritten by the service.'), eventCtx('run_pc')), 'provider_error');
});

test('self-review is refused for normalized ids and for the acting ctx.actorId / agentId, before any request', async () => {
  const c = client();
  const it = await c.propose(proposal('Normalized self review.', 'agent-self'), eventCtx('run_pc'));
  const before = mock.requests.length;
  await rejectsWith(c.review(it.experienceId, 'approve', ' Agent-Self ', eventCtx('run_pc')), 'permission_denied');
  await rejectsWith(c.review(it.experienceId, 'approve', 'human:alice', eventCtx('run_pc', { actorId: 'agent-self' })), 'permission_denied');
  await rejectsWith(c.review(it.experienceId, 'approve', 'human:alice', eventCtx('run_pc', { agentId: 'agent-self' })), 'permission_denied');
  assert.equal(mock.requests.length, before, 'no request was sent');
  // A service that accepts the creator acting under another reviewer name is an integrity violation.
  mock.mode = 'accept_self_review';
  await rejectsWith(client().review(it.experienceId, 'approve', 'human:alice', eventCtx('run_pc', { actorId: 'agent-self' })), 'integrity_violation');
});

test('retrieve and list re-apply scope and filters client side', async () => {
  const logger = new MemoryLogger();
  const c = client({ logger });
  const shop = await c.propose({ ...proposal('Zyxscoped advice: seed the cart fixture.'), scope: { project: 'shop' } }, eventCtx('run_scope_a'));
  const bank = await c.propose({ ...proposal('Zyxscoped advice: seed the ledger fixture.'), scope: { project: 'bank' }, sourceRunId: 'run_scope_b' }, eventCtx('run_scope_b'));
  const global = await c.propose({ ...proposal('Zyxscoped advice: seed fixtures first.'), scope: {} }, eventCtx('run_scope_a'));
  for (const it of [shop, bank, global]) await c.review(it.experienceId, 'approve', 'human:alice', eventCtx('run_pc'));
  // The mock's prepare endpoint ignores scope; the client must not let the bank project's knowledge in.
  const got = await c.retrieve({ text: 'zyxscoped', scope: { project: 'shop' }, limit: 10 });
  assert.deepEqual(got.map((x) => x.experienceId).sort(), [shop.experienceId, global.experienceId].sort());
  assert.deepEqual(logger.entries.find((e) => e.msg.includes('out-of-scope'))?.fields['dropped'], [bank.experienceId]);
  mock.mode = 'ignore_filters';
  const listed = await c.list({ status: ['approved'], sourceRunId: 'run_scope_b' });
  assert.deepEqual(listed.map((x) => x.experienceId), [bank.experienceId]);
  await rejectsWith(c.retrieve({ text: 'x', limit: Number.NaN }), 'invalid_argument');
});
