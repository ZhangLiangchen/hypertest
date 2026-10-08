/**
 * A[0]: the fallback pipeline ends in ALLOW or PAUSE — never in a silent work-item failure. A transiently unavailable
 * model (single-route role, fail_closed role, open circuits, timeouts / rate limits after retries) PAUSES the work item
 * (waiting on `model:<agentId>`, L0 `work.paused` with pauseReason model_unavailable) until the pause's resume time — a
 * circuit's half-open time or a backoff — or an operator release; the pause is durable across a process restart.
 * Permanent refusals (no configured route may ever serve the role) still fail closed with an exact reason.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonValue } from '@hypertest/core';
import type { DomainEvent, WorkItem } from '@hypertest/domain';
import { BUILTIN_ROLES, RoleCatalog } from '@hypertest/agents';
import { createControlPlane } from '../src/index.ts';
import { call, createHarness, items, route, type BrainView } from './harness.ts';

const LEAD_OUT: { [k: string]: JsonValue } = { summary: 'lead done', planProposed: false, readyForGate: false, objectives: [] };

async function eventsOf(h: Awaited<ReturnType<typeof createHarness>>, runId: string, type: string): Promise<DomainEvent<Record<string, unknown>>[]> {
  return (await h.deps.events.read(runId, { types: [type] })) as DomainEvent<Record<string, unknown>>[];
}

async function item(h: Awaited<ReturnType<typeof createHarness>>, id: string): Promise<WorkItem> {
  return (await h.deps.blackboard.getWorkItem(id)) as WorkItem;
}

test('audit probe (single route, provider timeout): the lead item PAUSES, resumes after the backoff and completes — never failed', async () => {
  const calls: BrainView[] = [];
  let failing = 2; // one turn = 2 attempts on the same route
  const h = await createHarness({
    catalog: [route('only', 'alpha', { default: 0.9 })],
    brains: {
      lead: (v) => {
        calls.push(v);
        if (failing > 0) {
          failing--;
          return { error: 'timeout', message: 'provider timed out' };
        }
        return call('complete_work', { summary: 'done after the pause', output: LEAD_OUT });
      },
    },
  });
  try {
    const run = await h.control.startRun({ goal: 'probe', target: {} });
    const t = await h.control.tick(run.runId);
    const d = t.dispatched[0]!;
    const out = await h.control.executeTurn(d.workItemId, d.fencingToken);
    const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
    // PAUSE, not failure (before A[0]: {status: 'failed'}, failure model_unavailable)
    assert.deepEqual(out, { status: 'waiting', workItemId: d.workItemId, operationIds: [`model:${agent.agentId}`] });
    const paused = await item(h, d.workItemId);
    assert.equal(paused.state, 'waiting');
    assert.equal(paused.failure, undefined);
    const [ev] = await eventsOf(h, run.runId, 'work.paused');
    assert.ok(ev, 'L0 work.paused');
    assert.equal(ev.payload['pauseReason'], 'model_unavailable');
    assert.equal(ev.payload['consecutive'], 1);
    assert.match(String(ev.payload['reason']), /only failed \(timeout/);
    const pause = (await h.deps.epochs.modelPause!(agent.sessionId))!;
    assert.equal(pause.resumeAt, ev.payload['resumeAt']);
    assert.equal(Date.parse(pause.resumeAt) - h.clock.nowMs(), 5_000, 'no known retry time: the first backoff step');
    assert.equal(calls.length, 2);
    // the agent is not settled failed: its session continues after the pause
    assert.equal((await h.deps.agents.get(agent.agentId))!.status, 'active');

    // before the resume time it keeps waiting and makes no model call
    h.clock.advance(4_000);
    assert.equal((await h.control.observeWaiting(d.workItemId)).status, 'waiting');
    const tick = await h.control.tick(run.runId);
    assert.deepEqual(tick.waiting, [{ workItemId: d.workItemId, operationIds: [`model:${agent.agentId}`] }]);
    assert.equal(tick.final, false, 'a paused item keeps the run from its gate');
    assert.equal(calls.length, 2);

    // after it: resumes, the next turn routes again and completes
    h.clock.advance(1_001);
    assert.equal((await h.control.observeWaiting(d.workItemId)).status, 'continue');
    assert.equal((await eventsOf(h, run.runId, 'work.resumed')).length, 1);
    const resumed = await item(h, d.workItemId);
    assert.equal(resumed.state, 'running');
    const done = await h.control.executeTurn(d.workItemId, resumed.claim!.fencingToken);
    assert.equal(done.status, 'completed');
    assert.equal(calls.length, 3);
    // a successful call ends the pause sequence
    assert.equal(await h.deps.epochs.modelPause!(agent.sessionId), undefined);
  } finally {
    await h.dispose();
  }
});

test('a fail_closed role with an alternative route still PAUSES on a transient failure (no fallback, no failure)', async () => {
  let alphaCalls = 0;
  let betaCalls = 0;
  const roles = new RoleCatalog(BUILTIN_ROLES, { roles: { lead: { defaultModelPolicy: { fallback: 'fail_closed', preferredRoutes: ['a-route'] } } } });
  const h = await createHarness({
    roles,
    catalog: [route('a-route', 'alpha', { default: 0.9 }), route('b-route', 'beta', { default: 0.8 })],
    brains: {
      lead: (v) => {
        if (v.request.model === 'a-route-model') {
          alphaCalls++;
          if (alphaCalls <= 2) return { error: 'rate_limited', message: '429' };
        } else betaCalls++;
        return call('complete_work', { summary: 'ok', output: LEAD_OUT });
      },
    },
  });
  try {
    const run = await h.control.startRun({ goal: 'fail closed', target: {} });
    const d = (await h.control.tick(run.runId)).dispatched[0]!;
    const out = await h.control.executeTurn(d.workItemId, d.fencingToken);
    assert.equal(out.status, 'waiting');
    const fallbacks = await eventsOf(h, run.runId, 'model.fallback');
    assert.equal(fallbacks.at(-1)!.payload['policy'], 'fail_closed');
    assert.equal(fallbacks.at(-1)!.payload['to'], null);
    h.clock.advance(5_001);
    assert.equal((await h.control.observeWaiting(d.workItemId)).status, 'continue');
    const done = await h.control.executeTurn(d.workItemId, (await item(h, d.workItemId)).claim!.fencingToken);
    assert.equal(done.status, 'completed');
    assert.equal(betaCalls, 0, 'fail_closed: never another route');
    assert.equal(alphaCalls, 3);
  } finally {
    await h.dispose();
  }
});

test('repeated failures open the circuit: the pause lasts until its half-open time, the half-open probe succeeds', async () => {
  let n = 0;
  const h = await createHarness({
    catalog: [route('only', 'alpha', { default: 0.9 })],
    brains: {
      lead: () => {
        n++;
        if (n <= 5) return { error: 'unavailable', message: '503' };
        return call('complete_work', { summary: 'ok', output: LEAD_OUT });
      },
    },
  });
  try {
    const run = await h.control.startRun({ goal: 'circuit', target: {} });
    const d = (await h.control.tick(run.runId)).dispatched[0]!;
    const agent = async () => (await h.deps.agents.byWorkItem(d.workItemId))!;
    // pause 1 (2 failures, 5s), pause 2 (2 more, 10s), pause 3: the 5th failure opens the circuit (cooldown 30s)
    assert.equal((await h.control.executeTurn(d.workItemId, d.fencingToken)).status, 'waiting');
    h.clock.advance(5_000);
    assert.equal((await h.control.observeWaiting(d.workItemId)).status, 'continue');
    assert.equal((await h.control.executeTurn(d.workItemId, (await item(h, d.workItemId)).claim!.fencingToken)).status, 'waiting');
    assert.equal((await h.deps.epochs.modelPause!((await agent()).sessionId))!.consecutive, 2);
    h.clock.advance(10_000);
    assert.equal((await h.control.observeWaiting(d.workItemId)).status, 'continue');
    assert.equal((await h.control.executeTurn(d.workItemId, (await item(h, d.workItemId)).claim!.fencingToken)).status, 'waiting');
    const opened = await eventsOf(h, run.runId, 'model.circuit_opened');
    assert.equal(opened.length, 1);
    const pause = (await h.deps.epochs.modelPause!((await agent()).sessionId))!;
    assert.equal(pause.consecutive, 3);
    assert.equal(pause.resumeAt, opened[0]!.payload['halfOpenAt'], 'the pause lasts until the circuit is half-open');
    assert.equal(n, 5);
    h.clock.advance(29_999);
    assert.equal((await h.control.observeWaiting(d.workItemId)).status, 'waiting');
    h.clock.advance(1);
    assert.equal((await h.control.observeWaiting(d.workItemId)).status, 'continue');
    assert.equal((await h.control.executeTurn(d.workItemId, (await item(h, d.workItemId)).claim!.fencingToken)).status, 'completed');
    assert.equal((await eventsOf(h, run.runId, 'model.circuit_closed')).length, 1, 'the probe closed the circuit');
  } finally {
    await h.dispose();
  }
});

test('the pause is durable across a process restart (a new control plane over the same store) and an operator can release it', async () => {
  let n = 0;
  const h = await createHarness({
    catalog: [route('only', 'alpha', { default: 0.9 })],
    brains: {
      lead: () => {
        n++;
        if (n <= 2) return { error: 'timeout', message: 'slow' };
        return call('complete_work', { summary: 'ok', output: LEAD_OUT });
      },
    },
  });
  try {
    const run = await h.control.startRun({ goal: 'restart', target: {} });
    const d = (await h.control.tick(run.runId)).dispatched[0]!;
    assert.equal((await h.control.executeTurn(d.workItemId, d.fencingToken)).status, 'waiting');
    // "restart": a fresh control plane of the same worker identity (no in-memory state: no issued claims, no circuits of
    // its own) over the same database
    await h.control.close();
    const plane = createControlPlane({ ...h.deps });
    try {
      await plane.recover(run.runId);
      const reattached = await eventsOf(h, run.runId, 'run.recovered');
      assert.ok(reattached.length >= 1);
      assert.equal((await plane.observeWaiting(d.workItemId)).status, 'waiting', 'still paused after the restart');
      // the operator releases the pauses (`hypertest resume`) — before the resume time
      const released = await plane.releaseModelPauses!(run.runId, 'operator:test');
      assert.equal(released.length, 1);
      assert.equal((await eventsOf(h, run.runId, 'model.pauses_released')).length, 1);
      assert.equal((await plane.observeWaiting(d.workItemId)).status, 'continue');
      const cur = await item(h, d.workItemId);
      assert.equal((await plane.executeTurn(d.workItemId, cur.claim!.fencingToken)).status, 'completed');
      assert.equal(n, 3);
    } finally {
      await plane.close();
    }
  } finally {
    await h.dispose();
  }
});

test('a permanent refusal still fails closed with the exact reason (no configured route may serve the role)', async () => {
  const h = await createHarness({
    // the only route cannot use tools: no turn of any agent can ever be routed to it
    catalog: [route('no-tools', 'alpha', { default: 0.9 }, { capabilities: ['reasoning'] })],
    brains: { lead: () => call('complete_work', { summary: 'unreachable', output: LEAD_OUT }) },
  });
  try {
    const run = await h.control.startRun({ goal: 'permanent', target: {} });
    const d = (await h.control.tick(run.runId)).dispatched[0]!;
    const out = await h.control.executeTurn(d.workItemId, d.fencingToken);
    assert.equal(out.status, 'failed');
    const it = await item(h, d.workItemId);
    assert.equal(it.failure?.reason, 'model_unavailable');
    assert.match(it.failure!.message, /no configured model route may serve this request: no-tools: capability \(missing capabilities: .*tool_use/);
    assert.equal((await eventsOf(h, run.runId, 'work.paused')).length, 0);
    const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
    assert.equal(await h.deps.epochs.modelPause!(agent.sessionId), undefined);
  } finally {
    await h.dispose();
  }
});

test('a paused item waits no longer than its wall clock: past it, it fails model_unavailable with the pause reason', async () => {
  const h = await createHarness({
    catalog: [route('only', 'alpha', { default: 0.9 })],
    brains: { lead: () => ({ error: 'timeout', message: 'never answers' }) },
  });
  try {
    const run = await h.control.startRun({ goal: 'deadline', target: {} });
    const d = (await h.control.tick(run.runId)).dispatched[0]!;
    assert.equal((await h.control.executeTurn(d.workItemId, d.fencingToken)).status, 'waiting');
    const it = await item(h, d.workItemId);
    // jump past the item's wall clock but stay before the (reset) resume time is irrelevant: the deadline wins while paused
    const pause = (await h.deps.epochs.modelPause!((await h.deps.agents.byWorkItem(d.workItemId))!.sessionId))!;
    await h.deps.epochs.setModelPause!({ ...pause, resumeAt: new Date(h.clock.nowMs() + 10 * it.budget.maxWallClockMs).toISOString() });
    h.clock.advance(it.budget.maxWallClockMs + 1);
    assert.equal((await h.control.observeWaiting(d.workItemId)).status, 'failed');
    const failed = await item(h, d.workItemId);
    assert.equal(failed.failure?.reason, 'model_unavailable');
    assert.match(failed.failure!.message, /paused for model unavailability past the work item's maxWallClockMs/);
    void (await items(h, run.runId));
  } finally {
    await h.dispose();
  }
});
