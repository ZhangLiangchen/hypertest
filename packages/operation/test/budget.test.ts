import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isHypertestError } from '@hypertest/core';
import { createBudgetLedger, type BudgetLedger, type ReserveOutcome } from '../src/index.ts';
import { openEnv, type Env } from './helpers.ts';

let env: Env;
let budget: BudgetLedger;
before(async () => {
  env = await openEnv();
  budget = createBudgetLedger(env.deps);
});
after(async () => {
  await env.dispose();
});

function reservationId(o: ReserveOutcome): string {
  assert.equal(o.ok, true, `expected ok, got ${JSON.stringify(o)}`);
  return o.ok ? o.reservationId : '';
}

test('I12: exhaustion is a typed outcome naming the scope, dimension and amounts', async () => {
  await budget.open('run:b1', { tokens: 1_000, toolCalls: 5 });
  const r1 = reservationId(await budget.reserve(['run:b1'], { tokens: 600 }, 'lead turn'));
  const over = await budget.reserve(['run:b1'], { tokens: 500 }, 'executor turn');
  assert.deepEqual(over, { ok: false, exhausted: { scope: 'run:b1', dimension: 'tokens', limit: 1_000, used: 0, reserved: 600, requested: 500 } });
  assert.deepEqual(await budget.usage('run:b1'), { scope: 'run:b1', limits: { tokens: 1_000, toolCalls: 5 }, used: {}, reserved: { tokens: 600 } });
  await budget.settle(r1, { tokens: 550 });
  assert.deepEqual(await budget.usage('run:b1'), { scope: 'run:b1', limits: { tokens: 1_000, toolCalls: 5 }, used: { tokens: 550 }, reserved: { tokens: 0 } });
  // Exactly at the limit is allowed.
  reservationId(await budget.reserve(['run:b1'], { tokens: 450 }, 'fits exactly'));
  const none = await budget.reserve(['run:b1'], { tokens: 1 }, 'one more');
  assert.equal(none.ok, false);
});

test('I12: parent scopes are enforced — a child without its own limit is bounded by its ancestors', async () => {
  await budget.open('run:b2', { costUsd: 1 });
  await budget.open('work:b2', {}, 'run:b2');
  await budget.open('agent:b2', { costUsd: 10 }, 'work:b2');
  const r = reservationId(await budget.reserve(['agent:b2'], { costUsd: 0.7 }, 'model call'));
  const over = await budget.reserve(['agent:b2'], { costUsd: 0.4 }, 'model call 2');
  assert.deepEqual(over, { ok: false, exhausted: { scope: 'run:b2', dimension: 'costUsd', limit: 1, used: 0, reserved: 0.7, requested: 0.4 } });
  // The reservation was charged to every ancestor.
  assert.deepEqual((await budget.usage('work:b2'))?.reserved, { costUsd: 0.7 });
  assert.deepEqual((await budget.usage('run:b2'))?.reserved, { costUsd: 0.7 });
  await budget.settle(r, { costUsd: 0.2 });
  assert.deepEqual((await budget.usage('run:b2'))?.used, { costUsd: 0.2 });
  assert.deepEqual((await budget.usage('agent:b2'))?.used, { costUsd: 0.2 });
  // Fractional amounts do not drift: 0.2 + 0.1 + 0.7 == 1 exactly fits.
  reservationId(await budget.reserve(['agent:b2'], { costUsd: 0.1 }, 'a'));
  reservationId(await budget.reserve(['agent:b2'], { costUsd: 0.7 }, 'b'));
});

test('I12: a multi-scope reservation is atomic — a violation in any scope reserves nothing anywhere', async () => {
  await budget.open('run:b3', { toolCalls: 100 });
  await budget.open('agent:b3-x', { toolCalls: 2 }, 'run:b3');
  await budget.open('pool:b3', { toolCalls: 100 });
  const res = await budget.reserve(['pool:b3', 'agent:b3-x'], { toolCalls: 3 }, 'batch');
  assert.deepEqual(res, { ok: false, exhausted: { scope: 'agent:b3-x', dimension: 'toolCalls', limit: 2, used: 0, reserved: 0, requested: 3 } });
  for (const s of ['run:b3', 'agent:b3-x', 'pool:b3']) assert.deepEqual((await budget.usage(s))?.reserved, {}, s);
  const ok = reservationId(await budget.reserve(['pool:b3', 'agent:b3-x', 'run:b3'], { toolCalls: 2 }, 'fits'));
  // run:b3 is listed and is also agent:b3-x's parent: it is charged once.
  assert.deepEqual((await budget.usage('run:b3'))?.reserved, { toolCalls: 2 });
  await budget.release(ok);
  assert.deepEqual((await budget.usage('run:b3'))?.reserved, { toolCalls: 0 });
});

test('the first violated scope/dimension is reported in caller scope order then canonical dimension order', async () => {
  await budget.open('a:b4', { tokens: 1, toolCalls: 1 });
  await budget.open('b:b4', { tokens: 1 });
  const res = await budget.reserve(['b:b4', 'a:b4'], { toolCalls: 2, tokens: 2 }, 'x');
  assert.equal(res.ok, false);
  assert.deepEqual(res.ok ? undefined : [res.exhausted.scope, res.exhausted.dimension], ['b:b4', 'tokens']);
});

test('I12: settle records actual usage even above the reservation (and the limit); later work is refused', async () => {
  await budget.open('run:b5', { computeMs: 1_000 });
  const r = reservationId(await budget.reserve(['run:b5'], { computeMs: 400 }, 'load test'));
  await budget.settle(r, { computeMs: 1_300 });
  assert.deepEqual(await budget.usage('run:b5'), { scope: 'run:b5', limits: { computeMs: 1_000 }, used: { computeMs: 1_300 }, reserved: { computeMs: 0 } });
  const refused = await budget.reserve(['run:b5'], { computeMs: 1 }, 'more');
  assert.deepEqual(refused, { ok: false, exhausted: { scope: 'run:b5', dimension: 'computeMs', limit: 1_000, used: 1_300, reserved: 0, requested: 1 } });
  // A request for an unlimited dimension still passes (missing limit = unlimited).
  reservationId(await budget.reserve(['run:b5'], { tokens: 10_000_000 }, 'unlimited tokens'));
  // Settling twice and releasing after settle are idempotent no-ops.
  await budget.settle(r, { computeMs: 9_999 });
  await budget.release(r);
  assert.deepEqual((await budget.usage('run:b5'))?.used, { computeMs: 1_300 });
});

test('release returns reserved capacity; a released reservation cannot be settled', async () => {
  await budget.open('run:b6', { agents: 2 });
  const r = reservationId(await budget.reserve(['run:b6'], { agents: 2 }, 'spawn two'));
  assert.equal((await budget.reserve(['run:b6'], { agents: 1 }, 'third')).ok, false);
  await budget.release(r);
  await budget.release(r);
  assert.deepEqual((await budget.usage('run:b6'))?.reserved, { agents: 0 });
  await assert.rejects(budget.settle(r, { agents: 2 }), (e: unknown) => isHypertestError(e, 'precondition_failed'));
  reservationId(await budget.reserve(['run:b6'], { agents: 1 }, 'third again'));
  await assert.rejects(budget.settle('bres_missing', { agents: 1 }), (e: unknown) => isHypertestError(e, 'not_found'));
});

test('I12: charge records usage atomically but still refuses (recording nothing) when it would exceed', async () => {
  await budget.open('run:b7', { wallClockMs: 10_000 });
  await budget.open('work:b7', {}, 'run:b7');
  reservationId(await budget.charge(['work:b7'], { wallClockMs: 9_000 }, 'observed wall clock'));
  assert.deepEqual((await budget.usage('run:b7'))?.used, { wallClockMs: 9_000 });
  assert.deepEqual((await budget.usage('work:b7'))?.used, { wallClockMs: 9_000 });
  const over = await budget.charge(['work:b7'], { wallClockMs: 1_001 }, 'more wall clock');
  assert.deepEqual(over, { ok: false, exhausted: { scope: 'run:b7', dimension: 'wallClockMs', limit: 10_000, used: 9_000, reserved: 0, requested: 1_001 } });
  assert.deepEqual((await budget.usage('run:b7'))?.used, { wallClockMs: 9_000 }, 'nothing recorded');
  const rows = await env.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ht_budget_reservations WHERE reason = 'more wall clock'`);
  assert.equal(rows.rows[0]!.n, 0);
});

test('H5: a charge under an idempotency key is recorded once — a replayed charge never double counts', async () => {
  await budget.open('run:b7k', { toolCalls: 3 });
  await budget.open('work:b7k', {}, 'run:b7k');
  const first = reservationId(await budget.charge(['work:b7k'], { toolCalls: 1 }, 'tool:inv_1', { idempotencyKey: 'tool:inv_1' }));
  // the same tool invocation replayed (durable retry, redelivery): the recorded charge, nothing new
  assert.equal(reservationId(await budget.charge(['work:b7k'], { toolCalls: 1 }, 'tool:inv_1', { idempotencyKey: 'tool:inv_1' })), first);
  assert.deepEqual((await budget.usage('run:b7k'))?.used, { toolCalls: 1 });
  assert.deepEqual((await budget.usage('work:b7k'))?.used, { toolCalls: 1 });
  // concurrent duplicates of one key charge once
  const dup = await Promise.all(Array.from({ length: 6 }, () => budget.charge(['work:b7k'], { toolCalls: 1 }, 'tool:inv_2', { idempotencyKey: 'tool:inv_2' })));
  assert.equal(new Set(dup.map(reservationId)).size, 1);
  assert.deepEqual((await budget.usage('run:b7k'))?.used, { toolCalls: 2 });
  // a different key is a different charge; unkeyed charges keep counting every call
  reservationId(await budget.charge(['work:b7k'], { toolCalls: 1 }, 'tool:inv_3', { idempotencyKey: 'tool:inv_3' }));
  const over = await budget.charge(['work:b7k'], { toolCalls: 1 }, 'tool:inv_4', { idempotencyKey: 'tool:inv_4' });
  assert.equal(over.ok, false, 'the limit still applies');
  // a refused charge recorded nothing: its key is free once budget exists again
  await budget.open('run:b7k', { toolCalls: 4 });
  reservationId(await budget.charge(['work:b7k'], { toolCalls: 1 }, 'tool:inv_4', { idempotencyKey: 'tool:inv_4' }));
  assert.deepEqual((await budget.usage('run:b7k'))?.used, { toolCalls: 4 });
  // the same key for another charge is a conflict (never silently absorbed)
  await assert.rejects(budget.charge(['work:b7k'], { toolCalls: 2 }, 'tool:inv_1', { idempotencyKey: 'tool:inv_1' }), (e: unknown) => isHypertestError(e, 'conflict'));
  await assert.rejects(budget.charge(['run:b7k'], { toolCalls: 1 }, 'tool:inv_1', { idempotencyKey: 'tool:inv_1' }), (e: unknown) => isHypertestError(e, 'conflict'));
  await assert.rejects(budget.charge(['work:b7k'], { toolCalls: 1 }, 'x', { idempotencyKey: '' }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  assert.deepEqual((await budget.usage('run:b7k'))?.used, { toolCalls: 4 });
});

test('I12: concurrent reservations never exceed the limit', async () => {
  await budget.open('run:b8', { workItems: 5 });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => budget.reserve(['run:b8'], { workItems: 1 }, `wi-${i}`)));
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.deepEqual((await budget.usage('run:b8'))?.reserved, { workItems: 5 });
});

test('scopes: unknown scopes and parents are not_found, parents are immutable, reopen updates limits', async () => {
  await assert.rejects(budget.reserve(['run:nope'], { tokens: 1 }, 'x'), (e: unknown) => isHypertestError(e, 'not_found'));
  await assert.rejects(budget.open('work:b9', {}, 'run:nope'), (e: unknown) => isHypertestError(e, 'not_found'));
  await assert.rejects(budget.open('self:b9', {}, 'self:b9'), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  await budget.open('run:b9', { tokens: 10 });
  await budget.open('work:b9', {}, 'run:b9');
  await assert.rejects(budget.open('work:b9', {}), (e: unknown) => isHypertestError(e, 'conflict'));
  await budget.open('run:b9', { tokens: 20 });
  reservationId(await budget.reserve(['work:b9'], { tokens: 15 }, 'after raise'));
  assert.equal(await budget.usage('run:missing'), undefined);
});

test('amounts are validated (no negative, non-finite or unknown dimensions)', async () => {
  await budget.open('run:b10', { tokens: 10 });
  const invalid = (e: unknown) => isHypertestError(e, 'invalid_argument');
  await assert.rejects(budget.reserve(['run:b10'], { tokens: -1 }, 'neg'), invalid);
  await assert.rejects(budget.reserve(['run:b10'], { tokens: Number.POSITIVE_INFINITY }, 'inf'), invalid);
  await assert.rejects(budget.reserve(['run:b10'], { tokenz: 1 } as never, 'typo'), invalid);
  await assert.rejects(budget.reserve([], { tokens: 1 }, 'no scope'), invalid);
  await assert.rejects(budget.open('run:b10b', { tokens: -5 }), invalid);
  assert.deepEqual((await budget.usage('run:b10'))?.reserved, {});
});

test('durability-1: releaseOpen frees the open reservations of a scope (a dead worker\'s calls); other scopes and settled rows are untouched', async () => {
  await budget.open('run:leak', { tokens: 1000 });
  await budget.open('work:leak-a', { tokens: 800 }, 'run:leak');
  await budget.open('work:leak-b', { tokens: 800 }, 'run:leak');
  const leaked = reservationId(await budget.reserve(['work:leak-a'], { tokens: 700 }, 'turn 3 (the worker died)'));
  const settled = reservationId(await budget.reserve(['work:leak-a'], { tokens: 50 }, 'turn 2'));
  await budget.settle(settled, { tokens: 40 });
  const other = reservationId(await budget.reserve(['work:leak-b'], { tokens: 100 }, 'another item'));
  // the leak blocks the retried turn of the requeued item
  assert.equal((await budget.reserve(['work:leak-a'], { tokens: 700 }, 'turn 3 retried')).ok, false);
  assert.deepEqual(await budget.releaseOpen!('work:leak-a'), [leaked]);
  assert.deepEqual((await budget.usage('run:leak'))!.reserved, { tokens: 100 });
  assert.deepEqual((await budget.usage('work:leak-a'))!, { scope: 'work:leak-a', limits: { tokens: 800 }, used: { tokens: 40 }, reserved: { tokens: 0 } });
  assert.equal((await budget.reserve(['work:leak-a'], { tokens: 700 }, 'turn 3 retried')).ok, true, 'the retried turn fits again');
  // a zombie settling its released reservation is refused; releasing again is a no-op
  await assert.rejects(budget.settle(leaked, { tokens: 10 }), (e: unknown) => isHypertestError(e, 'precondition_failed'));
  assert.deepEqual(await budget.releaseOpen!('work:leak-b').then((ids) => ids.length), 1);
  assert.equal(other.length > 0, true);
});
