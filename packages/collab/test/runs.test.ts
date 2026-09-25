import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunStatus } from '@hypertest/domain';
import { eventCtx } from '@hypertest/testkit';
import { runEventType } from '../src/index.ts';
import { openEnv, rejectsWith, testRun, types, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

test('create stores the run and emits run.created; an identical re-create is idempotent, a different one conflicts', async () => {
  const runId = 'run-1';
  const ctx = eventCtx(runId);
  const run = await env.runs.create(testRun(runId), ctx);
  assert.deepEqual(await env.runs.get(runId), run);
  const again = await env.runs.create(testRun(runId), ctx);
  assert.deepEqual(again, run);
  await rejectsWith(env.runs.create(testRun(runId, { goal: 'something else' }), ctx), 'conflict');
  const evs = await env.events.read(runId);
  assert.deepEqual(types(evs), ['run.created']);
  assert.deepEqual(evs[0]!.payload, { runId, goal: run.goal, status: 'created', runtimeManifestId: 'rm_1', policyRevision: 'pol_1' });
  await rejectsWith(env.runs.create(testRun('run-1x'), eventCtx('run-other')), 'invalid_argument');
  assert.equal(await env.runs.get('run-missing'), undefined);
});

test('status transitions follow canTransitionRun and emit run.* events', async () => {
  const runId = 'run-2';
  const ctx = eventCtx(runId);
  await env.runs.create(testRun(runId), ctx);
  await env.runs.update(runId, { status: 'running' }, ctx);
  const paused = await env.runs.update(runId, { status: 'paused', pauseReason: 'budget' }, ctx);
  assert.equal(paused.pauseReason, 'budget');
  const resumed = await env.runs.update(runId, { status: 'running' }, ctx);
  assert.equal(resumed.pauseReason, undefined, 'leaving paused clears the pause reason');
  await env.runs.update(runId, { status: 'converging' }, ctx);
  await env.runs.update(runId, { status: 'gating' }, ctx);
  const done = await env.runs.update(runId, { status: 'completed', decisionId: 'qd_1' }, ctx);
  assert.equal(done.completedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(done.decisionId, 'qd_1');
  assert.deepEqual(await env.runs.get(runId), done);
  const evs = await env.events.read(runId);
  assert.deepEqual(types(evs), ['run.created', 'run.started', 'run.paused', 'run.resumed', 'run.converging', 'run.gating', 'run.completed']);
  assert.deepEqual(evs[2]!.payload, { runId, from: 'running', to: 'paused', pauseReason: 'budget' });
  assert.deepEqual(evs[6]!.payload, { runId, from: 'gating', to: 'completed', decisionId: 'qd_1' });
});

test('illegal run transitions are rejected and write nothing', async () => {
  const runId = 'run-3';
  const ctx = eventCtx(runId);
  await env.runs.create(testRun(runId), ctx);
  const err = await rejectsWith(env.runs.update(runId, { status: 'completed' }, ctx), 'precondition_failed');
  assert.deepEqual([err.details['from'], err.details['to']], ['created', 'completed']);
  await env.runs.update(runId, { status: 'cancelled' }, ctx);
  await rejectsWith(env.runs.update(runId, { status: 'running' }, ctx), 'precondition_failed');
  await rejectsWith(env.runs.update(runId, { goal: 'rewrite history' }, ctx), 'precondition_failed');
  await rejectsWith(env.runs.update(runId, { budget: { ...testRun(runId).budget, maxToolCalls: 1 } }, ctx), 'precondition_failed');
  assert.equal((await env.runs.get(runId))!.status, 'cancelled');
  assert.deepEqual(types(await env.events.read(runId)), ['run.created', 'run.cancelled']);
  // A terminal run may still point at a newer decision (re-decision after an oracle invalidation).
  const redecided = await env.runs.update(runId, { decisionId: 'qd_redecided' }, ctx);
  assert.equal(redecided.decisionId, 'qd_redecided');
  assert.equal(redecided.status, 'cancelled');
  await rejectsWith(env.runs.update('run-missing', { status: 'running' }, eventCtx('run-missing')), 'not_found');
});

test('a run stays pinned to its runtime manifest in every status (I11), paused included', async () => {
  const runId = 'run-4';
  const ctx = eventCtx(runId);
  await env.runs.create(testRun(runId), ctx);
  await rejectsWith(env.runs.update(runId, { runtimeManifestId: 'rm_2' }, ctx), 'precondition_failed');
  await env.runs.update(runId, { status: 'running' }, ctx);
  const err = await rejectsWith(env.runs.update(runId, { runtimeManifestId: 'rm_2' }, ctx), 'precondition_failed');
  assert.deepEqual([err.details['pinned'], err.details['requested']], ['rm_1', 'rm_2']);
  await env.runs.update(runId, { status: 'paused', pauseReason: 'operator' }, ctx);
  // A paused run is still a live run: resuming it must not hot-swap the runtime.
  await rejectsWith(env.runs.update(runId, { runtimeManifestId: 'rm_2', status: 'running' }, ctx), 'precondition_failed');
  await rejectsWith(env.runs.update(runId, { runtimeManifestId: 'rm_2' }, ctx), 'precondition_failed');
  const cur = (await env.runs.get(runId))!;
  assert.deepEqual([cur.runtimeManifestId, cur.status], ['rm_1', 'paused']);
  // Re-stating the pinned manifest is not a change.
  assert.equal((await env.runs.update(runId, { runtimeManifestId: 'rm_1' }, ctx)).runtimeManifestId, 'rm_1');
  assert.deepEqual(types(await env.events.read(runId)), ['run.created', 'run.started', 'run.paused']);
});

test('create requires the initial status created and a runtime manifest; nothing is written otherwise', async () => {
  for (const status of ['running', 'completed', 'paused'] as const) {
    const runId = `run-bad-${status}`;
    const err = await rejectsWith(env.runs.create(testRun(runId, { status }), eventCtx(runId)), 'invalid_argument');
    assert.equal(err.details['status'], status);
    assert.equal(await env.runs.get(runId), undefined);
    assert.equal(await env.events.lastSeq(runId), 0);
  }
  await rejectsWith(env.runs.create(testRun('run-bad-manifest', { runtimeManifestId: '' }), eventCtx('run-bad-manifest')), 'invalid_argument');
  assert.equal(await env.runs.get('run-bad-manifest'), undefined);
});

test('non-status updates emit run.updated with the changed fields; a no-op update emits nothing', async () => {
  const runId = 'run-5';
  const ctx = eventCtx(runId);
  const created = await env.runs.create(testRun(runId), ctx);
  const updated = await env.runs.update(runId, { currentPlanRevision: 2, oracleRevisions: { 'or-1': 1 } }, ctx);
  assert.equal(updated.currentPlanRevision, 2);
  assert.equal(updated.createdAt, created.createdAt);
  const noop = await env.runs.update(runId, { currentPlanRevision: 2 }, ctx);
  assert.deepEqual(noop, updated);
  const evs = await env.events.read(runId);
  assert.deepEqual(types(evs), ['run.created', 'run.updated']);
  assert.deepEqual(evs[1]!.payload, { runId, changed: ['currentPlanRevision', 'oracleRevisions'] });
});

test('runEventType covers every target status', () => {
  const cases: Array<[RunStatus, RunStatus, string]> = [
    ['created', 'running', 'run.started'], ['paused', 'running', 'run.resumed'], ['converging', 'running', 'run.resumed'], ['running', 'paused', 'run.paused'],
    ['running', 'converging', 'run.converging'], ['converging', 'gating', 'run.gating'], ['gating', 'completed', 'run.completed'],
    ['running', 'failed', 'run.failed'], ['running', 'cancelled', 'run.cancelled'],
  ];
  for (const [from, to, type] of cases) assert.equal(runEventType(from, to), type);
});

test('list filters by status, newest first, with a limit', async () => {
  const ctx = (id: string) => eventCtx(id);
  await env.runs.create(testRun('run-l1', { createdAt: '2026-02-01T00:00:00.000Z' }), ctx('run-l1'));
  await env.runs.create(testRun('run-l2', { createdAt: '2026-02-02T00:00:00.000Z' }), ctx('run-l2'));
  await env.runs.update('run-l2', { status: 'running' }, ctx('run-l2'));
  const all = (await env.runs.list()).map((r) => r.runId);
  assert.ok(all.indexOf('run-l2') < all.indexOf('run-l1'));
  const running = (await env.runs.list({ status: ['running'] })).map((r) => r.runId);
  assert.ok(running.includes('run-l2') && !running.includes('run-l1'));
  assert.equal((await env.runs.list({ limit: 1 })).length, 1);
});
