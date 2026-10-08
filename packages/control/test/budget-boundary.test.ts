/**
 * The model budget boundary, from the first real (DeepSeek) run: an executor work item failed `budget_exhausted` with
 * 151,956 of its 250,000 tokens unused and a replan failed at RUN scope with 296,009 of 1,500,000 tokens unused. The
 * L0 of that run shows the refusing dimension was the RUN's USD budget ($0.9935 of $1.00 spent; the turn needed
 * $0.028956 = 20,764 estimated input tokens × $1/M + 4,096 output tokens × $2/M), but the worker re-derived the scope
 * from the TOKEN dimension (reason `model_tokens`, scope work:…), so the item failed as if its own budget were spent and
 * the run's exhaustion policy was not applied. Here:
 *  - the ledger's typed refusal (scope + dimension) reaches the worker: exact message and `budget.exhausted` marker;
 *  - a call that can be afforded with a smaller output reserve runs (maxOutputTokens shrinks, never below the floor);
 *  - a context that does not fit the remaining budget is condensed BEFORE the call (`context.budget_condensed`);
 *  - under onBudgetExhausted 'pause' the item is never failed: it waits, the run pauses; raising the limit and resuming
 *    continues the same agent; resuming without room ends it with the exact reason (the gate decides);
 *  - the token estimator is calibrated against provider-reported usage (reservations follow measured usage).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { estimateTokens, type WorkItem } from '@hypertest/domain';
import { createModelInvoker, createTokenCalibration } from '@hypertest/runtime';
import { createControlPlane, runScope, workScope } from '../src/index.ts';
import { call, createHarness, drive, route, runItem, type RoleBrain } from './harness.ts';

const DONE: RoleBrain = () => call('complete_work', { summary: 'no plan', output: { summary: 'no plan', planProposed: false, readyForGate: false, objectives: [] } });
/** The live run's expensive route: $1 / $2 per million tokens in / out. */
const PRO = route('ds-pro', 'alpha', { default: 0.9 }, { costPerMillionInputUsd: 1, costPerMillionOutputUsd: 2 });

async function eventsOf(h: Awaited<ReturnType<typeof createHarness>>, runId: string, type: string): Promise<Array<Record<string, unknown>>> {
  return (await h.deps.events.read(runId, { types: [type] })).map((e) => e.payload as Record<string, unknown>);
}

describe('model budget boundary (live-run regression)', () => {
  test('the RUN cost budget refused the call: typed marker (run scope, costUsd, model_cost) and the exact reason — never a token-scope guess', async () => {
    const h = await createHarness({ brains: { lead: DONE }, catalog: [PRO] });
    try {
      const run = await h.control.startRun({ goal: 'cost', target: {}, budget: { maxModelCostUsd: 1 } });
      // the run already spent $0.999 of its $1 (the live run: $0.9935): no call on this route fits any more
      await h.deps.budget.charge([runScope(run.runId)], { costUsd: 0.999 }, 'earlier turns');
      const t = await h.control.tick(run.runId);
      const workItemId = t.dispatched[0]!.workItemId;
      assert.equal(await runItem(h.control, workItemId, t.dispatched[0]!.fencingToken), 'failed');
      assert.equal(h.calls.length, 0, 'no model call beyond the budget');
      const item = (await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem;
      assert.equal(item.failure!.reason, 'budget_exhausted');
      assert.match(item.failure!.message, new RegExp(`^model budget exhausted at run:${run.runId} on costUsd: \\$0\\.999 used \\+ \\$0 reserved by calls in flight \\+ \\$0\\.0\\d+ for this call > limit \\$1; route ds-pro needed \\d+ tokens \\(input \\d+ \\+ output reserve 4096\\), \\$0\\.0\\d+$`));
      const [marker] = await eventsOf(h, run.runId, 'budget.exhausted');
      assert.deepEqual(
        { scope: marker!['scope'], reason: marker!['reason'], dimension: marker!['dimension'], limit: marker!['limit'], used: marker!['used'], reservedByOthers: marker!['reservedByOthers'], routeId: marker!['routeId'] },
        { scope: runScope(run.runId), reason: 'model_cost', dimension: 'costUsd', limit: 1, used: 0.999, reservedByOthers: 0, routeId: 'ds-pro' },
      );
      // the item's own scope was never the problem (the live run reported it as the refusing scope)
      const work = await h.deps.budget.usage(workScope(workItemId));
      assert.equal(work!.used.tokens ?? 0, 0);
    } finally {
      await h.dispose();
    }
  });

  test('with budget left for a smaller answer, the call runs with a shrunk output reserve (never below the floor)', async () => {
    let seenMax: number | undefined;
    const lead: RoleBrain = (v) => {
      seenMax = v.request.maxOutputTokens;
      return DONE(v);
    };
    const h = await createHarness({ brains: { lead }, catalog: [PRO] });
    try {
      const run = await h.control.startRun({ goal: 'cost', target: {}, budget: { maxModelCostUsd: 1 } });
      // $0.985 spent → $0.015 left: this ~10k-token context ($0.010) fits, the full 4096-token reserve ($0.0082) does not
      await h.deps.budget.charge([runScope(run.runId)], { costUsd: 0.985 }, 'earlier turns');
      const t = await h.control.tick(run.runId);
      const st = await runItem(h.control, t.dispatched[0]!.workItemId, t.dispatched[0]!.fencingToken);
      assert.equal(st, 'completed', JSON.stringify((await h.deps.blackboard.getWorkItem(t.dispatched[0]!.workItemId))?.failure));
      assert.ok(seenMax !== undefined && seenMax < 4096 && seenMax >= 1024, `maxOutputTokens ${String(seenMax)}`);
      const u = await h.deps.budget.usage(runScope(run.runId));
      assert.ok(u!.used.costUsd! <= 1, `the settled usage stays within the limit (${u!.used.costUsd})`);
    } finally {
      await h.dispose();
    }
  });

  test('a context the remaining budget cannot hold is condensed BEFORE the call (context.budget_condensed), and the call fits', async () => {
    const BIG = 'observation '.repeat(1400); // ≈ 4,200 estimated tokens per assistant turn
    let step3: { userText: string } | undefined;
    let n = 0;
    const lead: RoleBrain = (v) => {
      // a call counter, not the transcript's step: after the condensation the view holds fewer assistant turns
      if (++n <= 3) return { text: `${n}: ${BIG}`, toolCalls: [{ name: 'blackboard__read', arguments: {} }] };
      step3 = { userText: v.userText };
      return DONE(v);
    };
    const h = await createHarness({ brains: { lead }, catalog: [PRO] });
    try {
      const run = await h.control.startRun({ goal: 'condense', target: {} });
      const t = await h.control.tick(run.runId);
      const { workItemId, fencingToken } = t.dispatched[0]!;
      for (let i = 0; i < 3; i++) assert.equal((await h.control.executeTurn(workItemId, fencingToken)).status, 'continue');
      // the run budget now holds less than this turn: 4096 output + 16k input (the fixed prompt and tools are ~10k)
      const used = (await h.deps.budget.usage(runScope(run.runId)))!.used.tokens ?? 0;
      await h.deps.budget.open(runScope(run.runId), { tokens: used + 4096 + 16_000 });
      const st = await runItem(h.control, workItemId, fencingToken);
      assert.equal(st, 'completed', JSON.stringify((await h.deps.blackboard.getWorkItem(workItemId))?.failure));
      const [fit] = await eventsOf(h, run.runId, 'context.budget_condensed');
      assert.ok(fit, 'the budget fit was recorded');
      assert.deepEqual([fit!['dimension'], fit!['level']], ['tokens', 'hard']);
      // the view cap came from the remaining budget (minus the prompt overhead measured at the previous turn)
      assert.ok((fit!['viewBudgetCap'] as number) < (fit!['allowanceTokens'] as number), JSON.stringify(fit));
      assert.ok((fit!['estimateAfter'] as number) <= (fit!['allowanceTokens'] as number), JSON.stringify(fit));
      const compacted = await eventsOf(h, run.runId, 'context.compacted');
      assert.equal(compacted.at(-1)!['level'], 'hard');
      assert.ok(step3, 'the model was called after the condensation');
      assert.ok(step3!.userText.length < BIG.length * 2, 'the condensed transcript reached the model');
      assert.deepEqual(await eventsOf(h, run.runId, 'budget.exhausted'), []);
    } finally {
      await h.dispose();
    }
  });

  test('after a worker restart (no measured overhead yet) the assembled turn is condensed with the exact cap before the call', async () => {
    const BIG = 'observation '.repeat(1400);
    let n = 0;
    const lead: RoleBrain = (v) => (++n <= 3 ? { text: `${n}: ${BIG}`, toolCalls: [{ name: 'blackboard__read', arguments: {} }] } : DONE(v));
    const h = await createHarness({ brains: { lead }, catalog: [PRO] });
    try {
      const run = await h.control.startRun({ goal: 'condense', target: {} });
      const t = await h.control.tick(run.runId);
      const { workItemId, fencingToken } = t.dispatched[0]!;
      for (let i = 0; i < 3; i++) assert.equal((await h.control.executeTurn(workItemId, fencingToken)).status, 'continue');
      const used = (await h.deps.budget.usage(runScope(run.runId)))!.used.tokens ?? 0;
      await h.deps.budget.open(runScope(run.runId), { tokens: used + 4096 + 16_000 });
      const restarted = createControlPlane({ ...h.deps });
      const st = await runItem(restarted, workItemId, fencingToken);
      assert.equal(st, 'completed', JSON.stringify((await h.deps.blackboard.getWorkItem(workItemId))?.failure));
      const [fit] = await eventsOf(h, run.runId, 'context.budget_condensed');
      assert.ok(fit);
      assert.equal(fit!['level'], 'hard');
      assert.ok((fit!['estimateBefore'] as number) > (fit!['allowanceTokens'] as number), JSON.stringify(fit));
      assert.ok((fit!['estimateAfter'] as number) <= (fit!['allowanceTokens'] as number), JSON.stringify(fit));
    } finally {
      await h.dispose();
    }
  });

  test("onBudgetExhausted 'pause': the item waits (never failed), the run pauses; a raised limit + resume continues the SAME agent", async () => {
    const h = await createHarness({ brains: { lead: DONE }, config: { onBudgetExhausted: 'pause' } });
    try {
      const run = await h.control.startRun({ goal: 'tokens', target: {}, budget: { maxModelTokens: 6000 } });
      const t = await h.control.tick(run.runId);
      const { workItemId, fencingToken } = t.dispatched[0]!;
      assert.deepEqual(await h.control.executeTurn(workItemId, fencingToken), { status: 'paused', workItemId, reason: 'budget' });
      const waiting = (await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem;
      assert.deepEqual([waiting.state, waiting.waitingOn], ['waiting', [`budget:${run.runId}`]]);
      const agent = (await h.deps.agents.byWorkItem(workItemId))!;
      assert.notEqual(agent.status, 'failed');
      const [paused] = await eventsOf(h, run.runId, 'work.paused');
      assert.deepEqual([paused!['pauseReason'], paused!['scope'], paused!['dimension'], paused!['runPaused']], ['budget', runScope(run.runId), 'tokens', true]);
      assert.equal((await h.deps.runs.get(run.runId))!.pauseReason, 'budget');
      // while paused the item keeps waiting
      assert.equal((await h.control.observeWaiting(workItemId)).status, 'waiting');
      // the operator raises the run's token limit and resumes
      await h.deps.budget.open(runScope(run.runId), { tokens: 500_000 });
      await h.control.resumeRun(run.runId);
      const r = await drive(h, run.runId, 40);
      assert.ok(r.final, `the run reached its gate: ${JSON.stringify(r.ticks.map((x) => [x.status, x.convergence, x.dispatched.length, x.waiting.length]))} ${JSON.stringify(r.outcomes)}`);
      const done = (await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem;
      assert.equal(done.state, 'completed');
      assert.equal((await h.deps.agents.byWorkItem(workItemId))!.agentId, agent.agentId, 'the same agent continued');
      const [resumed] = await eventsOf(h, run.runId, 'work.resumed');
      assert.deepEqual([resumed!['pauseReason'], resumed!['dimension']], ['budget', 'tokens']);
      assert.equal(h.calls[0]!.workItemId, workItemId, 'the first model call is the paused item\'s, after the resume');
    } finally {
      await h.dispose();
    }
  });

  test('a refusal caused only by calls in flight is contention, not exhaustion: the item waits for room and resumes when they settle', async () => {
    const h = await createHarness({ brains: { lead: DONE } });
    try {
      const run = await h.control.startRun({ goal: 'contention', target: {}, budget: { maxModelTokens: 40_000 } });
      // another agent's call in flight holds most of the run's tokens
      const held = await h.deps.budget.reserve([runScope(run.runId)], { tokens: 30_000 }, 'model:other:turn:1');
      assert.ok(held.ok);
      const t = await h.control.tick(run.runId);
      const { workItemId, fencingToken } = t.dispatched[0]!;
      const out = await h.control.executeTurn(workItemId, fencingToken);
      assert.deepEqual(out, { status: 'waiting', workItemId, operationIds: [`budget:${run.runId}`] });
      assert.equal((await h.deps.runs.get(run.runId))!.status, 'running', 'contention never pauses the run');
      assert.deepEqual(await eventsOf(h, run.runId, 'budget.exhausted'), [], 'no exhaustion marker for contention');
      const [paused] = await eventsOf(h, run.runId, 'work.paused');
      assert.deepEqual([paused!['pauseReason'], paused!['contention'], paused!['runPaused']], ['budget', true, false]);
      // still held: keeps waiting
      assert.equal((await h.control.observeWaiting(workItemId)).status, 'waiting');
      // the other call settles at its actual use: room again
      await h.deps.budget.settle(held.reservationId, { tokens: 2_000 });
      const resumed = await h.control.observeWaiting(workItemId);
      assert.equal(resumed.status, 'continue');
      const token = ((await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem).claim!.fencingToken;
      assert.equal(await runItem(h.control, workItemId, token), 'completed');
    } finally {
      await h.dispose();
    }
  });

  test("contention that becomes exhaustion under 'pause': the run pauses once; a resume without room ends the item with the exact reason (no re-pause loop)", async () => {
    const h = await createHarness({ brains: { lead: DONE }, config: { onBudgetExhausted: 'pause' } });
    try {
      const run = await h.control.startRun({ goal: 'contention then exhaustion', target: {}, budget: { maxModelTokens: 40_000 } });
      const held = await h.deps.budget.reserve([runScope(run.runId)], { tokens: 30_000 }, 'model:other:turn:1');
      assert.ok(held.ok);
      const t = await h.control.tick(run.runId);
      const { workItemId, fencingToken } = t.dispatched[0]!;
      assert.deepEqual(await h.control.executeTurn(workItemId, fencingToken), { status: 'waiting', workItemId, operationIds: [`budget:${run.runId}`] });
      // the other call settles at nearly all it held: no room for this call, and nothing left in flight
      await h.deps.budget.settle(held.reservationId, { tokens: 30_000 });
      assert.deepEqual(await h.control.observeWaiting(workItemId), { status: 'paused', workItemId, reason: 'budget' });
      assert.deepEqual([(await h.deps.runs.get(run.runId))!.status, (await h.deps.runs.get(run.runId))!.pauseReason], ['paused', 'budget']);
      const pauses = await eventsOf(h, run.runId, 'work.paused');
      assert.deepEqual(pauses.map((p) => p['runPaused']), [false, true], 'the escalation to a run pause is on L0');
      // the operator resumes WITHOUT raising the limit: the item ends with the exact reason (before: it paused the run again)
      await h.control.resumeRun(run.runId);
      assert.deepEqual(await h.control.observeWaiting(workItemId), { status: 'failed', workItemId });
      assert.equal((await h.deps.runs.get(run.runId))!.status, 'running');
      const ended = (await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem;
      assert.equal(ended.failure!.reason, 'budget_exhausted');
      assert.match(ended.failure!.message, /^the run was resumed but its budget still has no room for the model call \(tokens: \d+ left, \d+ needed\): model budget exhausted at run:/);
      assert.equal(h.calls.length, 0, 'no model call beyond the budget');
    } finally {
      await h.dispose();
    }
  });

  test('an LLM condensation is a model call of the run: its USD cost is charged to the run budget, not only its tokens', async () => {
    let n = 0;
    const lead: RoleBrain = (v) => (n++ < 7 ? call('blackboard.read', { status: `status-${n}-${'x'.repeat(700)}` }) : DONE(v));
    const condenser: RoleBrain = () => ({ text: 'CONDENSED: the lead read the blackboard seven times.' });
    const h = await createHarness({ brains: { lead, condenser }, catalog: [PRO], config: { maxInlineContextTokens: 1500 } });
    try {
      const run = await h.control.startRun({ goal: 'condense cost', target: {}, budget: { maxModelCostUsd: 5 } });
      const t = await h.control.tick(run.runId);
      assert.equal(await runItem(h.control, t.dispatched[0]!.workItemId, t.dispatched[0]!.fencingToken), 'completed');
      assert.ok(h.calls.some((c) => c.role === 'condenser'), 'the LLM condenser ran (on the priced route)');
      // every model call of the run (the lead's turns and the condenser's calls) is on L0 with its USD cost
      const invoked = (await h.deps.events.read(run.runId, { types: ['model.invoked'] })).map((e) => e.payload as { usage?: { costUsd?: number } });
      assert.ok(invoked.length > h.calls.filter((c) => c.role === 'lead').length, 'condenser calls are recorded next to the lead turns');
      const total = invoked.reduce((a, p) => a + (p.usage?.costUsd ?? 0), 0);
      const used = (await h.deps.budget.usage(runScope(run.runId)))!.used.costUsd ?? 0;
      // before: the condenser's calls were charged as tokens only, so the run's USD usage missed their cost
      assert.ok(Math.abs(used - total) < 1e-9, `run USD usage ${used} = the cost of every model call ${total}`);
    } finally {
      await h.dispose();
    }
  });

  test('the token estimator is calibrated against provider-reported usage: reservations follow what the provider measured', async () => {
    const reserved: number[] = [];
    let call = 0;
    const lead: RoleBrain = (v) => {
      call++;
      // the provider counts 1.5× the chars/4 estimate (a denser tokenizer)
      const reply = call < 3 ? { toolCalls: [{ name: 'blackboard__read', arguments: {} }] } : DONE(v);
      return { ...reply, usage: { inputTokens: Math.ceil(1.5 * estimateTokens(v.request.messages, v.request.tools)) } };
    };
    const h = await createHarness({ brains: { lead }, catalog: [PRO] });
    try {
      const run = await h.control.startRun({ goal: 'calibrate', target: {} });
      const original = h.deps.budget.reserve.bind(h.deps.budget);
      h.deps.budget.reserve = async (scopes, amounts, reason, options) => {
        if (reason.startsWith('model:')) reserved.push(amounts.tokens ?? 0);
        return original(scopes, amounts, reason, options);
      };
      const t = await h.control.tick(run.runId);
      assert.equal(await runItem(h.control, t.dispatched[0]!.workItemId, t.dispatched[0]!.fencingToken), 'completed');
      const invoked = await eventsOf(h, run.runId, 'model.invoked');
      assert.equal(invoked.length, 3);
      for (const e of invoked) assert.equal(typeof e['estimatedInputTokens'], 'number', 'model.invoked records the estimate it is measured against');
      // the first reservation is the raw estimate; later ones carry the measured ratio (> 1.2 × their raw estimate)
      const est = invoked.map((e) => e['estimatedInputTokens'] as number);
      assert.equal(reserved[0], est[0]! + 4096);
      assert.ok(reserved[2]! - 4096 > 1.2 * est[2]!, `calibrated reservation ${reserved[2]! - 4096} vs raw estimate ${est[2]}`);
    } finally {
      await h.dispose();
    }
  });

  test('createTokenCalibration: clamps and smooths samples; ignores invalid ones', () => {
    const c = createTokenCalibration();
    assert.equal(c.ratio('r'), 1);
    c.observe('r', 1000, 1500);
    assert.equal(c.ratio('r'), 1.5);
    c.observe('r', 1000, 1000);
    assert.equal(c.ratio('r'), 1.25);
    c.observe('r', 1000, 100_000);
    assert.equal(c.ratio('r'), 2.125, 'clamped to 3 before smoothing');
    c.observe('r', 0, 10);
    c.observe('r', Number.NaN, 10);
    assert.equal(c.ratio('r'), 2.125);
    assert.equal(c.ratio('other'), 1);
    assert.throws(() => createModelInvoker({ maxOutputTokens: 100, minOutputTokens: 200, agent: { sessionId: 's' } } as never), /minOutputTokens must be an integer in \[1, maxOutputTokens 100\]/);
  });
});
