import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { InMemoryEventSink } from '@hypertest/domain';
import { eventCtx } from '@hypertest/testkit';
import { contextMigrations, createExperienceStore, type DurableMemory, type ExperienceItem } from '../src/index.ts';
import { openDb, rejectsWith, type Db } from './helpers.ts';

let env: Db;
let sink: InMemoryEventSink;
let mem: DurableMemory;

before(async () => {
  env = await openDb(contextMigrations);
  sink = new InMemoryEventSink();
  mem = createExperienceStore({ ...env.deps, events: sink });
});
after(async () => {
  await env.dispose();
});

type Proposal = Parameters<DurableMemory['propose']>[0];
const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  scope: { project: 'shop', role: 'executor', topic: 'checkout' },
  kind: 'pitfall',
  content: 'The checkout API returns 500 instead of 400 for an empty cart; always test empty carts.',
  sourceRunId: 'run_xp',
  evidenceRefs: ['ev_1', 'ev_2'],
  createdBy: 'agent-executor',
  ...overrides,
});

test('propose ⇒ candidate with experience.proposed; candidates are never retrieved', async () => {
  const item = await mem.propose(proposal(), eventCtx('run_xp'));
  assert.match(item.experienceId, /^xp_/);
  assert.equal(item.status, 'candidate');
  assert.equal(item.reviewedBy, undefined);
  assert.equal(item.createdAt, '2026-01-01T00:00:00.000Z');
  const ev = sink.ofType('experience.proposed').at(-1)!;
  assert.equal(ev.aggregateId, item.experienceId);
  assert.equal(ev.runId, 'run_xp');
  assert.deepEqual(ev.payload, { experienceId: item.experienceId, kind: 'pitfall', scope: item.scope, createdBy: 'agent-executor', evidenceRefs: ['ev_1', 'ev_2'] });
  assert.deepEqual(await mem.retrieve({ text: 'empty cart checkout' }), []);
  assert.deepEqual((await mem.list({ sourceRunId: 'run_xp' })).map((x) => x.experienceId), [item.experienceId]);
});

test('self-review is forbidden (permission_denied) at every step; status is unchanged', async () => {
  const item = await mem.propose(proposal({ createdBy: 'agent-self' }), eventCtx('run_xp'));
  for (const d of ['review', 'approve', 'publish', 'reject', 'quarantine'] as const) {
    await rejectsWith(mem.review(item.experienceId, d, 'agent-self', eventCtx('run_xp')), 'permission_denied');
  }
  assert.equal((await mem.list({ status: ['candidate'] })).find((x) => x.experienceId === item.experienceId)?.status, 'candidate');
});

test('lifecycle: candidate → reviewed → approved → published is retrievable; illegal transitions are refused', async () => {
  const item = await mem.propose(proposal({ content: 'Flaky payment sandbox: retry the idempotent GET, never the POST.', scope: { project: 'shop', topic: 'payments' } }), eventCtx('run_xp'));
  const ctx = eventCtx('run_xp', { actorId: 'human:alice' });
  await rejectsWith(mem.review(item.experienceId, 'publish', 'human:alice', ctx), 'precondition_failed');
  const reviewed = await mem.review(item.experienceId, 'review', 'agent-reviewer', ctx);
  assert.equal(reviewed.status, 'reviewed');
  assert.equal(reviewed.reviewedBy, 'agent-reviewer');
  assert.deepEqual(await mem.retrieve({ text: 'payment sandbox retry' }), [], 'reviewed is not approved');
  env.deps.clock.advance(1000);
  const approved = await mem.review(item.experienceId, 'approve', 'human:alice', ctx);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.updatedAt, '2026-01-01T00:00:01.000Z');
  assert.deepEqual((await mem.retrieve({ text: 'payment sandbox retry' })).map((x) => x.experienceId), [item.experienceId]);
  // Idempotent retry of the same decision by the same reviewer.
  assert.equal((await mem.review(item.experienceId, 'approve', 'human:alice', ctx)).status, 'approved');
  const published = await mem.review(item.experienceId, 'publish', 'human:alice', ctx);
  assert.equal(published.status, 'published');
  assert.deepEqual((await mem.retrieve({ text: 'payment sandbox retry' })).map((x) => x.status), ['published']);
  await rejectsWith(mem.review(item.experienceId, 'approve', 'human:bob', ctx), 'precondition_failed');
  await rejectsWith(mem.review(item.experienceId, 'reject', 'human:bob', ctx), 'precondition_failed');
  await rejectsWith(mem.review('xp_missing', 'approve', 'human:bob', ctx), 'not_found');
  await rejectsWith(mem.review(item.experienceId, 'bless' as never, 'human:bob', ctx), 'invalid_argument');
  const trail = sink.ofType('experience.reviewed').filter((e) => e.aggregateId === item.experienceId).map((e) => {
    const p = e.payload as { from: string; to: string; reviewer: string };
    return `${p.from}->${p.to} by ${p.reviewer}`;
  });
  assert.deepEqual(trail, ['candidate->reviewed by agent-reviewer', 'reviewed->approved by human:alice', 'approved->published by human:alice']);
});

test('quarantine removes published knowledge from retrieval for good; rejected items are never retrieved', async () => {
  const a = await mem.propose(proposal({ content: 'Load test ramp: warm caches for 60s before measuring p95 latency.', scope: { topic: 'load' } }), eventCtx('run_xp'));
  const b = await mem.propose(proposal({ content: 'Load test p95 latency is meaningless below 100 samples.', scope: { topic: 'load' } }), eventCtx('run_xp'));
  const c = await mem.propose(proposal({ content: 'Hallucinated: p95 latency load tests always pass on Fridays.', scope: { topic: 'load' } }), eventCtx('run_xp'));
  const ctx = eventCtx('run_xp');
  await mem.review(a.experienceId, 'approve', 'human:alice', ctx);
  await mem.review(a.experienceId, 'publish', 'human:alice', ctx);
  await mem.review(b.experienceId, 'approve', 'human:alice', ctx);
  await mem.review(c.experienceId, 'reject', 'human:alice', ctx);
  const ids = async () => (await mem.retrieve({ text: 'p95 latency load test' })).map((x) => x.experienceId).sort();
  assert.deepEqual(await ids(), [a.experienceId, b.experienceId].sort());
  await mem.review(a.experienceId, 'quarantine', 'agent-auditor', ctx);
  assert.deepEqual(await ids(), [b.experienceId]);
  await rejectsWith(mem.review(a.experienceId, 'publish', 'human:alice', ctx), 'precondition_failed');
  await rejectsWith(mem.review(a.experienceId, 'approve', 'human:alice', ctx), 'precondition_failed');
  assert.deepEqual((await mem.list({ status: ['quarantined'] })).map((x) => x.experienceId), [a.experienceId]);
  assert.deepEqual((await mem.list({ status: ['rejected'] })).map((x) => x.experienceId), [c.experienceId]);
});

test('retrieve: scope filters (unscoped fields are global), token-overlap relevance, limit', async () => {
  const ctx = eventCtx('run_scope');
  const mk = async (content: string, scope: ExperienceItem['scope']) => {
    const it = await mem.propose(proposal({ content, scope, sourceRunId: 'run_scope' }), ctx);
    await mem.review(it.experienceId, 'approve', 'human:alice', ctx);
    return it.experienceId;
  };
  const global = await mk('Kubernetes rollout: wait for readiness before injecting faults.', {});
  const shopExec = await mk('Kubernetes rollout for shop executor: pin the image digest.', { project: 'shop', role: 'executor' });
  const otherProject = await mk('Kubernetes rollout for bank: use the canary namespace.', { project: 'bank' });
  const q = 'kubernetes rollout';
  assert.deepEqual((await mem.retrieve({ text: q, scope: { project: 'shop', role: 'executor' } })).map((x) => x.experienceId).sort(), [global, shopExec].sort());
  assert.deepEqual((await mem.retrieve({ text: q, scope: { project: 'shop', role: 'rca' } })).map((x) => x.experienceId), [global]);
  assert.deepEqual((await mem.retrieve({ text: q, scope: { project: 'bank' } })).map((x) => x.experienceId).sort(), [global, otherProject].sort());
  // Relevance: more overlapping terms rank higher.
  const top = await mem.retrieve({ text: 'kubernetes rollout image digest', scope: { project: 'shop' } });
  assert.equal(top[0]!.experienceId, shopExec);
  assert.equal((await mem.retrieve({ text: q, limit: 1 })).length, 1);
  assert.deepEqual(await mem.retrieve({ text: 'zebra quantum' }), []);
});

test('propose validates input', async () => {
  const ctx = eventCtx('run_xp');
  await rejectsWith(mem.propose(proposal({ content: '' }), ctx), 'invalid_argument');
  await rejectsWith(mem.propose(proposal({ kind: 'rumour' as never }), ctx), 'invalid_argument');
  await rejectsWith(mem.propose(proposal({ evidenceRefs: [''] }), ctx), 'invalid_argument');
  await rejectsWith(mem.propose(proposal({ scope: { project: '' } }), ctx), 'invalid_argument');
  await rejectsWith(mem.propose(proposal({ createdBy: '' }), ctx), 'invalid_argument');
});

test('racing reviewers: exactly one terminal decision wins, the other is refused', async () => {
  const ctx = eventCtx('run_xp');
  const it = await mem.propose(proposal({ content: 'Race: approve vs reject.' }), ctx);
  const results = await Promise.allSettled([
    mem.review(it.experienceId, 'reject', 'human:alice', ctx),
    mem.review(it.experienceId, 'quarantine', 'human:bob', ctx),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal((failed[0] as PromiseRejectedResult).reason.code, 'precondition_failed');
  const final = (await mem.list({ sourceRunId: 'run_xp' })).find((x) => x.experienceId === it.experienceId)!;
  assert.equal(final.status, (ok[0] as PromiseFulfilledResult<{ status: string }>).value.status);
  assert.equal(sink.ofType('experience.reviewed').filter((e) => e.aggregateId === it.experienceId).length, 1);
});

test('self-review cannot be bypassed by case/whitespace variants or by the creator acting under another name', async () => {
  const item = await mem.propose(proposal({ createdBy: 'agent-self2', content: 'Bypass attempts.' }), eventCtx('run_xp'));
  await rejectsWith(mem.review(item.experienceId, 'approve', ' AGENT-SELF2 ', eventCtx('run_xp')), 'permission_denied');
  const e1 = await rejectsWith(mem.review(item.experienceId, 'approve', 'human:alice', eventCtx('run_xp', { actorId: 'agent-self2' })), 'permission_denied');
  assert.equal(e1.details['actor'], 'agent-self2');
  await rejectsWith(mem.review(item.experienceId, 'approve', 'human:alice', eventCtx('run_xp', { actorId: 'system:x', agentId: 'agent-self2' })), 'permission_denied');
  assert.equal((await mem.list({ sourceRunId: 'run_xp' })).find((x) => x.experienceId === item.experienceId)!.status, 'candidate');
  assert.equal(sink.ofType('experience.reviewed').filter((e) => e.aggregateId === item.experienceId).length, 0);
  // An independent actor may review.
  assert.equal((await mem.review(item.experienceId, 'approve', 'human:alice', eventCtx('run_xp', { actorId: 'human:alice' }))).status, 'approved');
});

test('the experience row and its event are atomic: a failing event sink stores / changes nothing', async () => {
  let fail = true;
  const flaky = {
    async emit(evs: Parameters<InMemoryEventSink['emit']>[0]) {
      if (fail) throw new Error('sink down (injected)');
      return sink.emit(evs);
    },
  };
  const store = createExperienceStore({ ...env.deps, events: flaky });
  const runId = 'run_xp_atomic';
  await assert.rejects(store.propose(proposal({ sourceRunId: runId, content: 'Atomic propose.' }), eventCtx(runId)), /sink down/);
  assert.deepEqual(await store.list({ sourceRunId: runId }), [], 'no row without its event');
  fail = false;
  const item = await store.propose(proposal({ sourceRunId: runId, content: 'Atomic propose.' }), eventCtx(runId));
  fail = true;
  await assert.rejects(store.review(item.experienceId, 'approve', 'human:alice', eventCtx(runId)), /sink down/);
  const after = (await store.list({ sourceRunId: runId }))[0]!;
  assert.equal(after.status, 'candidate', 'the transition rolled back with its event');
  assert.equal(after.reviewedBy, undefined);
  fail = false;
  assert.equal((await store.review(item.experienceId, 'approve', 'human:alice', eventCtx(runId))).status, 'approved');
});

test('retrieve rejects a non-finite limit instead of silently returning nothing', async () => {
  await rejectsWith(mem.retrieve({ text: 'checkout', limit: Number.NaN }), 'invalid_argument');
  await rejectsWith(mem.retrieve({ text: 'checkout', limit: Number.POSITIVE_INFINITY }), 'invalid_argument');
});
