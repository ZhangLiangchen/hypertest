import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkClaim, WorkItemState } from '@hypertest/domain';
import { eventCtx } from '@hypertest/testkit';
import { workEventType } from '../src/index.ts';
import { count, newWorkItem, openEnv, rejectsWith, types, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

const claim = (token: number, ownerId = `worker-${token}`): WorkClaim => ({ ownerId, leaseId: `lease-${token}`, fencingToken: token, expiresAt: '2026-01-01T00:10:00.000Z' });

test('createWorkItem defaults to ready and emits work.created + work.ready', async () => {
  const runId = 'wi-1';
  const { workItem, created } = await env.board.createWorkItem(newWorkItem(runId), eventCtx(runId, { causationId: 'evt_trigger' }));
  assert.equal(created, true);
  assert.equal(workItem.state, 'ready');
  assert.equal(workItem.attempts, 0);
  assert.deepEqual(workItem.waitingOn, []);
  assert.equal(workItem.causationEventId, 'evt_trigger', 'the triggering event is recorded for traceability');
  assert.equal(workItem.createdAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(await env.board.getWorkItem(workItem.workItemId), workItem);
  const evs = await env.events.read(runId);
  assert.deepEqual(types(evs), ['work.created', 'work.ready']);
  assert.ok(evs.every((e) => e.aggregateType === 'work_item' && e.aggregateId === workItem.workItemId && e.workItemId === workItem.workItemId && e.causationId === 'evt_trigger'));
  assert.equal(await env.board.revision(runId), 1);
});

test('createWorkItem in proposed/blocked emits only work.created; other initial states are rejected', async () => {
  const runId = 'wi-2';
  await env.board.createWorkItem(newWorkItem(runId, { state: 'proposed', objective: 'a', fingerprint: 'fp-a' }), eventCtx(runId));
  await env.board.createWorkItem(newWorkItem(runId, { state: 'blocked', objective: 'b', fingerprint: 'fp-b' }), eventCtx(runId));
  assert.deepEqual(types(await env.events.read(runId)), ['work.created', 'work.created']);
  await rejectsWith(env.board.createWorkItem(newWorkItem(runId, { state: 'running' as never, fingerprint: 'fp-c' }), eventCtx(runId)), 'invalid_argument');
  await rejectsWith(env.board.createWorkItem(newWorkItem(runId, { fingerprint: '' }), eventCtx(runId)), 'invalid_argument');
  await rejectsWith(env.board.createWorkItem(newWorkItem(runId, { fingerprint: 'fp-d' }), eventCtx('wi-other')), 'invalid_argument');
});

test('fingerprint dedupe under 10 concurrent createWorkItem: 1 created, 9 created:false, exactly one work.created', async () => {
  const runId = 'wi-dedupe';
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => env.board.createWorkItem(newWorkItem(runId, { title: `attempt ${i}` }), eventCtx(runId))));
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(results.filter((r) => !r.created).length, 9);
  assert.equal(new Set(results.map((r) => r.workItem.workItemId)).size, 1);
  assert.equal(await count(env.db, 'SELECT count(*) AS n FROM ht_work_items WHERE run_id = $1', [runId]), 1);
  const evs = await env.events.read(runId);
  assert.equal(evs.filter((e) => e.eventType === 'work.created').length, 1);
  assert.equal(await env.board.revision(runId), 1, 'duplicates neither bump the revision nor emit events');
});

test('a duplicate with a different explicit id still resolves to the first item (no second row)', async () => {
  const runId = 'wi-dup2';
  const a = await env.board.createWorkItem(newWorkItem(runId, { workItemId: 'wi_explicit_a' }), eventCtx(runId));
  const b = await env.board.createWorkItem(newWorkItem(runId, { workItemId: 'wi_explicit_b' }), eventCtx(runId));
  assert.equal(b.created, false);
  assert.equal(b.workItem.workItemId, 'wi_explicit_a');
  assert.deepEqual(b.workItem, a.workItem);
  assert.equal(await env.board.getWorkItem('wi_explicit_b'), undefined);
});

test('lifecycle transitions emit the matching work.* events', async () => {
  const runId = 'wi-life';
  const ctx = eventCtx(runId);
  const { workItem } = await env.board.createWorkItem(newWorkItem(runId), ctx);
  const id = workItem.workItemId;
  await env.board.transitionWorkItem(id, 'claimed', { claim: claim(1), attempts: 1 }, ctx, { expectedFrom: ['ready'] });
  await env.board.transitionWorkItem(id, 'running', { agentId: 'agent-rca' }, ctx, { expectedFencingToken: 1 });
  const waiting = await env.board.transitionWorkItem(id, 'waiting', { waitingOn: ['op_1'] }, ctx, { expectedFencingToken: 1 });
  assert.deepEqual(waiting.waitingOn, ['op_1']);
  await env.board.transitionWorkItem(id, 'running', { waitingOn: [] }, ctx, { expectedFencingToken: 1 });
  const done = await env.board.transitionWorkItem(id, 'completed', { result: { summary: 'root cause found', evidenceRefs: ['ev_1'], recordRefs: [] }, claim: null }, ctx, { expectedFencingToken: 1 });
  assert.equal(done.state, 'completed');
  assert.equal(done.claim, undefined, 'claim=null clears the claim');
  assert.equal(done.agentId, 'agent-rca');
  assert.equal(done.attempts, 1);
  assert.deepEqual(await env.board.getWorkItem(id), done);
  const evs = await env.events.read(runId);
  assert.deepEqual(types(evs), ['work.created', 'work.ready', 'work.claimed', 'work.started', 'work.waiting', 'work.started', 'work.completed']);
  const claimed = evs[2]!.payload as Record<string, unknown>;
  assert.deepEqual([claimed['from'], claimed['to'], claimed['ownerId'], claimed['fencingToken']], ['ready', 'claimed', 'worker-1', 1]);
  assert.equal((evs[6]!.payload as Record<string, unknown>)['resultSummary'], 'root cause found');
  assert.equal(await env.board.revision(runId), 6);
});

test('requeue, failure and cancellation events', async () => {
  const runId = 'wi-requeue';
  const ctx = eventCtx(runId);
  const { workItem } = await env.board.createWorkItem(newWorkItem(runId), ctx);
  const id = workItem.workItemId;
  await env.board.transitionWorkItem(id, 'claimed', { claim: claim(1) }, ctx);
  await env.board.transitionWorkItem(id, 'running', {}, ctx);
  await env.board.transitionWorkItem(id, 'ready', { claim: null }, ctx); // lease lost → requeued
  await env.board.transitionWorkItem(id, 'claimed', { claim: claim(2) }, ctx);
  const failed = await env.board.transitionWorkItem(id, 'failed', { failure: { reason: 'budget_exhausted', message: 'turn limit' } }, ctx);
  assert.deepEqual(failed.failure, { reason: 'budget_exhausted', message: 'turn limit' });
  await env.board.transitionWorkItem(id, 'ready', { claim: null }, ctx); // retry of a failed item → requeued
  await env.board.transitionWorkItem(id, 'cancelled', {}, ctx);
  assert.deepEqual(types(await env.events.read(runId, { afterSeq: 2 })), ['work.claimed', 'work.started', 'work.requeued', 'work.claimed', 'work.failed', 'work.requeued', 'work.cancelled']);
});

test('workEventType maps every reachable transition', () => {
  const cases: Array<[WorkItemState, WorkItemState, string]> = [
    ['proposed', 'ready', 'work.ready'], ['blocked', 'ready', 'work.ready'], ['proposed', 'blocked', 'work.blocked'], ['ready', 'claimed', 'work.claimed'],
    ['claimed', 'running', 'work.started'], ['waiting', 'running', 'work.started'], ['running', 'waiting', 'work.waiting'], ['running', 'completed', 'work.completed'],
    ['running', 'failed', 'work.failed'], ['ready', 'cancelled', 'work.cancelled'], ['claimed', 'ready', 'work.requeued'], ['running', 'ready', 'work.requeued'],
    ['waiting', 'ready', 'work.requeued'], ['failed', 'ready', 'work.requeued'],
  ];
  for (const [from, to, type] of cases) assert.equal(workEventType(from, to), type, `${from} → ${to}`);
});

test('a stale fencing token is refused (stale_fence) and the item is untouched', async () => {
  const runId = 'wi-fence';
  const ctx = eventCtx(runId);
  const { workItem } = await env.board.createWorkItem(newWorkItem(runId), ctx);
  const id = workItem.workItemId;
  // Worker A claims with token 1, loses its lease; the item is requeued and worker B claims with token 2.
  await env.board.transitionWorkItem(id, 'claimed', { claim: claim(1, 'worker-a') }, ctx);
  await env.board.transitionWorkItem(id, 'running', {}, ctx, { expectedFencingToken: 1 });
  await env.board.transitionWorkItem(id, 'ready', { claim: null }, ctx);
  await env.board.transitionWorkItem(id, 'claimed', { claim: claim(2, 'worker-b') }, ctx);
  const before = await env.board.getWorkItem(id);
  const seqBefore = await env.events.lastSeq(runId);
  const revBefore = await env.board.revision(runId);
  const err = await rejectsWith(env.board.transitionWorkItem(id, 'running', {}, ctx, { expectedFencingToken: 1 }), 'stale_fence');
  assert.deepEqual([err.details['expected'], err.details['current'], err.details['owner']], [1, 2, 'worker-b']);
  assert.deepEqual(await env.board.getWorkItem(id), before);
  assert.equal(await env.events.lastSeq(runId), seqBefore);
  assert.equal(await env.board.revision(runId), revBefore);
  // A fenced call against an item without a claim is stale as well.
  await env.board.transitionWorkItem(id, 'ready', { claim: null }, ctx, { expectedFencingToken: 2 });
  await rejectsWith(env.board.transitionWorkItem(id, 'cancelled', {}, ctx, { expectedFencingToken: 2 }), 'stale_fence');
  // The current owner proceeds.
  await env.board.transitionWorkItem(id, 'claimed', { claim: claim(3, 'worker-b') }, ctx);
  const running = await env.board.transitionWorkItem(id, 'running', {}, ctx, { expectedFencingToken: 3 });
  assert.equal(running.state, 'running');
});

test('illegal transitions are rejected with precondition_failed; nothing is written', async () => {
  const runId = 'wi-illegal';
  const ctx = eventCtx(runId);
  const { workItem } = await env.board.createWorkItem(newWorkItem(runId), ctx);
  const id = workItem.workItemId;
  const seq = await env.events.lastSeq(runId);
  let err = await rejectsWith(env.board.transitionWorkItem(id, 'completed', {}, ctx), 'precondition_failed');
  assert.deepEqual([err.details['from'], err.details['to']], ['ready', 'completed']);
  await rejectsWith(env.board.transitionWorkItem(id, 'waiting', {}, ctx), 'precondition_failed');
  await env.board.transitionWorkItem(id, 'cancelled', {}, ctx);
  err = await rejectsWith(env.board.transitionWorkItem(id, 'ready', {}, ctx), 'precondition_failed');
  assert.deepEqual([err.details['from'], err.details['to']], ['cancelled', 'ready']);
  await rejectsWith(env.board.transitionWorkItem(id, 'cancelled', { priority: 99 }, ctx), 'precondition_failed');
  assert.equal((await env.board.getWorkItem(id))!.priority, 10);
  assert.deepEqual(types(await env.events.read(runId, { afterSeq: seq })), ['work.cancelled']);
});

test('expectedFrom mismatch is a conflict; claiming without a claim is invalid; unknown items are not_found', async () => {
  const runId = 'wi-guards';
  const ctx = eventCtx(runId);
  const { workItem } = await env.board.createWorkItem(newWorkItem(runId), ctx);
  const err = await rejectsWith(env.board.transitionWorkItem(workItem.workItemId, 'claimed', { claim: claim(1) }, ctx, { expectedFrom: ['proposed'] }), 'conflict');
  assert.equal(err.details['state'], 'ready');
  await rejectsWith(env.board.transitionWorkItem(workItem.workItemId, 'claimed', {}, ctx), 'invalid_argument');
  await rejectsWith(env.board.transitionWorkItem('wi_missing', 'claimed', { claim: claim(1) }, ctx), 'not_found');
  await rejectsWith(env.board.transitionWorkItem(workItem.workItemId, 'claimed', { claim: claim(1) }, eventCtx('wi-elsewhere')), 'invalid_argument');
  assert.equal((await env.board.getWorkItem(workItem.workItemId))!.state, 'ready');
});

test('same-state patch (e.g. lease renewal) updates fields without a work event', async () => {
  const runId = 'wi-patch';
  const ctx = eventCtx(runId);
  const { workItem } = await env.board.createWorkItem(newWorkItem(runId), ctx);
  await env.board.transitionWorkItem(workItem.workItemId, 'claimed', { claim: claim(1) }, ctx);
  const seq = await env.events.lastSeq(runId);
  const renewed = await env.board.transitionWorkItem(workItem.workItemId, 'claimed', { claim: { ...claim(1), expiresAt: '2026-01-01T00:20:00.000Z' } }, ctx, { expectedFencingToken: 1 });
  assert.equal(renewed.claim!.expiresAt, '2026-01-01T00:20:00.000Z');
  assert.equal(await env.events.lastSeq(runId), seq);
});

test('transition inside a caller transaction rolls back with it', async () => {
  const runId = 'wi-tx';
  const ctx = eventCtx(runId);
  const { workItem } = await env.board.createWorkItem(newWorkItem(runId), ctx);
  await assert.rejects(
    env.db.transaction(async (tx) => {
      await env.board.transitionWorkItem(workItem.workItemId, 'claimed', { claim: claim(1) }, ctx, { tx });
      throw new Error('dispatch failed');
    }),
    /dispatch failed/,
  );
  assert.equal((await env.board.getWorkItem(workItem.workItemId))!.state, 'ready');
  assert.deepEqual(types(await env.events.read(runId)), ['work.created', 'work.ready']);
});

test('listWorkItems filters by state, role and plan revision in creation order', async () => {
  const runId = 'wi-list';
  const ctx = eventCtx(runId);
  const a = (await env.board.createWorkItem(newWorkItem(runId, { role: 'rca', fingerprint: 'l-a', planRevision: 1 }), ctx)).workItem;
  const b = (await env.board.createWorkItem(newWorkItem(runId, { role: 'executor', fingerprint: 'l-b', planRevision: 2 }), ctx)).workItem;
  const c = (await env.board.createWorkItem(newWorkItem(runId, { role: 'executor', fingerprint: 'l-c', state: 'blocked', planRevision: 2 }), ctx)).workItem;
  const ids = (xs: Array<{ workItemId: string }>) => xs.map((x) => x.workItemId);
  assert.deepEqual(ids(await env.board.listWorkItems({ runId })), [a.workItemId, b.workItemId, c.workItemId]);
  assert.deepEqual(ids(await env.board.listWorkItems({ runId, states: ['ready'] })), [a.workItemId, b.workItemId]);
  assert.deepEqual(ids(await env.board.listWorkItems({ runId, roles: ['executor'] })), [b.workItemId, c.workItemId]);
  assert.deepEqual(ids(await env.board.listWorkItems({ runId, planRevision: 2, states: ['blocked'] })), [c.workItemId]);
  assert.deepEqual(await env.board.listWorkItems({ runId: 'wi-none' }), []);
});

test('requeue drops the claim even without claim:null, so the lost-lease holder is refused (stale_fence)', async () => {
  const runId = 'wi-requeue-clear';
  const ctx = eventCtx(runId);
  const { workItem } = await env.board.createWorkItem(newWorkItem(runId), ctx);
  const id = workItem.workItemId;
  await env.board.transitionWorkItem(id, 'claimed', { claim: claim(1, 'worker-a') }, ctx);
  await env.board.transitionWorkItem(id, 'running', {}, ctx, { expectedFencingToken: 1 });
  const requeued = await env.board.transitionWorkItem(id, 'ready', {}, ctx); // lease expired → requeued by the scheduler
  assert.equal(requeued.claim, undefined);
  assert.equal((await env.board.getWorkItem(id))!.claim, undefined);
  const seq = await env.events.lastSeq(runId);
  // Worker A still believes it owns the item.
  await rejectsWith(env.board.transitionWorkItem(id, 'cancelled', {}, ctx, { expectedFencingToken: 1 }), 'stale_fence');
  await rejectsWith(env.board.transitionWorkItem(id, 'blocked', {}, ctx, { expectedFencingToken: 1 }), 'stale_fence');
  assert.equal((await env.board.getWorkItem(id))!.state, 'ready');
  assert.equal(await env.events.lastSeq(runId), seq);
  // A holderless state can never be given a claim.
  const err = await rejectsWith(env.board.transitionWorkItem(id, 'blocked', { claim: claim(9) }, ctx), 'invalid_argument');
  assert.equal(err.details['to'], 'blocked');
});

test('fencing tokens are monotonic per item: an older or re-used token is refused, a newer one wins', async () => {
  const runId = 'wi-monotonic';
  const ctx = eventCtx(runId);
  const { workItem } = await env.board.createWorkItem(newWorkItem(runId), ctx);
  const id = workItem.workItemId;
  await env.board.transitionWorkItem(id, 'claimed', { claim: claim(5, 'worker-b') }, ctx);
  await env.board.transitionWorkItem(id, 'ready', { claim: null }, ctx);
  const revBefore = await env.board.revision(runId);
  // A stale scheduler replays an older lease …
  let err = await rejectsWith(env.board.transitionWorkItem(id, 'claimed', { claim: claim(3, 'worker-a') }, ctx), 'stale_fence');
  assert.deepEqual([err.details['token'], err.details['highWater']], [3, 5]);
  // … or re-uses the token of the lease that was just revoked.
  await rejectsWith(env.board.transitionWorkItem(id, 'claimed', { claim: claim(5, 'worker-b') }, ctx), 'stale_fence');
  assert.equal((await env.board.getWorkItem(id))!.state, 'ready');
  assert.equal(await env.board.revision(runId), revBefore);
  const ok = await env.board.transitionWorkItem(id, 'claimed', { claim: claim(6, 'worker-c') }, ctx, { expectedFrom: ['ready'] });
  assert.equal(ok.claim!.fencingToken, 6);
  // Same-state takeover with an older token is refused too; renewal by the holder (same lease, same token) is fine.
  err = await rejectsWith(env.board.transitionWorkItem(id, 'claimed', { claim: claim(4, 'worker-d') }, ctx), 'stale_fence');
  assert.equal(err.details['currentOwner'], 'worker-c');
  const renewed = await env.board.transitionWorkItem(id, 'claimed', { claim: { ...claim(6, 'worker-c'), expiresAt: '2026-01-01T00:30:00.000Z' } }, ctx, { expectedFencingToken: 6 });
  assert.equal(renewed.claim!.expiresAt, '2026-01-01T00:30:00.000Z');
  // Token 6 from a different owner is not a renewal.
  await rejectsWith(env.board.transitionWorkItem(id, 'claimed', { claim: claim(6, 'worker-x') }, ctx), 'stale_fence');
});

test('a same-state change of ownership or progress is audited with work.updated; a pure lease renewal is not', async () => {
  const runId = 'wi-updated';
  const ctx = eventCtx(runId);
  const { workItem } = await env.board.createWorkItem(newWorkItem(runId), ctx);
  const id = workItem.workItemId;
  await env.board.transitionWorkItem(id, 'claimed', { claim: claim(1, 'worker-a') }, ctx);
  await env.board.transitionWorkItem(id, 'running', {}, ctx, { expectedFencingToken: 1 });
  const seq = await env.events.lastSeq(runId);
  // Crash recovery re-grants the running item to worker B without leaving `running`.
  const taken = await env.board.transitionWorkItem(id, 'running', { claim: claim(2, 'worker-b'), attempts: 2 }, ctx);
  assert.equal(taken.claim!.ownerId, 'worker-b');
  await env.board.transitionWorkItem(id, 'running', { claim: { ...claim(2, 'worker-b'), expiresAt: '2026-01-01T00:40:00.000Z' } }, ctx, { expectedFencingToken: 2 });
  await env.board.transitionWorkItem(id, 'running', { priority: 50 }, ctx);
  const evs = await env.events.read(runId, { afterSeq: seq });
  assert.deepEqual(types(evs), ['work.updated', 'work.updated']);
  const p0 = evs[0]!.payload as Record<string, unknown>;
  assert.deepEqual([p0['changed'], p0['ownerId'], p0['fencingToken'], p0['attempts'], p0['state']], [['claim', 'attempts'], 'worker-b', 2, 2, 'running']);
  assert.deepEqual((evs[1]!.payload as Record<string, unknown>)['changed'], ['priority']);
  assert.ok(evs.every((e) => e.workItemId === id && e.aggregateId === id));
  await rejectsWith(env.board.transitionWorkItem(id, 'running', {}, ctx, { expectedFencingToken: 1 }), 'stale_fence');
});

test('createWorkItem ignores store-owned fields passed at runtime and rejects malformed input as invalid_argument', async () => {
  const runId = 'wi-validate';
  const ctx = eventCtx(runId);
  const smuggled = {
    ...newWorkItem(runId),
    claim: claim(99, 'intruder'), agentId: 'agent-x', result: { summary: 'done already', evidenceRefs: [], recordRefs: [] },
    failure: { reason: 'agent_failed', message: 'x' }, attempts: 7, waitingOn: ['op_1'], createdAt: '1999-01-01T00:00:00.000Z',
  } as unknown as Parameters<typeof env.board.createWorkItem>[0];
  const { workItem } = await env.board.createWorkItem(smuggled, ctx);
  for (const k of ['claim', 'agentId', 'result', 'failure'] as const) assert.equal(workItem[k], undefined, k);
  assert.deepEqual([workItem.attempts, workItem.waitingOn, workItem.createdAt], [0, [], '2026-01-01T00:00:00.000Z']);
  assert.deepEqual(await env.board.getWorkItem(workItem.workItemId), workItem);
  assert.equal(await count(env.db, 'SELECT count(*) AS n FROM ht_work_items WHERE run_id = $1 AND claim_fencing_token IS NULL', [runId]), 1);

  const bad: Array<[string, Record<string, unknown>]> = [
    ['title', { title: undefined }], ['kind', { kind: '' }], ['priority', { priority: Number.NaN }], ['depth', { depth: -1 }],
    ['dependsOn', { dependsOn: 'wi_1' }], ['origin', { origin: null }], ['budget', { budget: undefined }], ['objective', { objective: 3 }],
  ];
  for (const [what, override] of bad) {
    const err = await rejectsWith(env.board.createWorkItem({ ...newWorkItem(runId, { fingerprint: `bad-${what}` }), ...override } as never, ctx), 'invalid_argument');
    assert.match(err.message, new RegExp(what), what);
  }
  assert.equal(await count(env.db, 'SELECT count(*) AS n FROM ht_work_items WHERE run_id = $1', [runId]), 1);
  assert.equal(await env.board.revision(runId), 1);
});

test('transition patches are validated before anything is written', async () => {
  const runId = 'wi-patch-validate';
  const ctx = eventCtx(runId);
  const { workItem } = await env.board.createWorkItem(newWorkItem(runId), ctx);
  const id = workItem.workItemId;
  const seq = await env.events.lastSeq(runId);
  await rejectsWith(env.board.transitionWorkItem(id, 'claimed', { claim: { ownerId: 'w', leaseId: 'l', expiresAt: 'x' } as never }, ctx), 'invalid_argument');
  await rejectsWith(env.board.transitionWorkItem(id, 'claimed', { claim: { ...claim(1), fencingToken: -1 } }, ctx), 'invalid_argument');
  await rejectsWith(env.board.transitionWorkItem(id, 'ready', { attempts: -1 }, ctx), 'invalid_argument');
  await rejectsWith(env.board.transitionWorkItem(id, 'ready', { waitingOn: 'op_1' as never }, ctx), 'invalid_argument');
  await rejectsWith(env.board.transitionWorkItem(id, 'ready', { priority: Number.POSITIVE_INFINITY }, ctx), 'invalid_argument');
  assert.deepEqual(await env.board.getWorkItem(id), workItem);
  assert.equal(await env.events.lastSeq(runId), seq);
});
