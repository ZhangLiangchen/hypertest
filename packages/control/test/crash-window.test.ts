/**
 * Crash window between the engine's turn commit and the work item's transition to `waiting`.
 *
 * The engine records a turn that decided to WAIT on operations atomically with the turn completion
 * (TurnRecord.outcome = {status: 'waiting', waitingOn}); the worker then moves the item `running → waiting`. A process
 * that dies between the two leaves the item `running`. The next executeTurn must re-enter `waiting` on the recorded
 * operations — never run another turn that would hand the model its `[pending]` results without their outcomes (PoC C:
 * a Hypertest kill right after a load job was acknowledged).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { WorkItem } from '@hypertest/domain';
import { call, createHarness, items, runItem, type BrainView, type Harness } from './harness.ts';

const LEAD_OUT = { summary: 'lead done', planProposed: false, readyForGate: false, objectives: [] };

describe('crash between the waiting turn commit and the waiting transition', () => {
  let h: Harness;
  const leadViews: BrainView[] = [];
  before(async () => {
    h = await createHarness({
      brains: {
        lead: (v) => {
          leadViews.push(v);
          if (v.step === 0) return call('delegate', { role: 'code_change_analyst', objective: 'Summarise the risky functions', title: 'summary' });
          return call('complete_work', { summary: 'delegation done', output: LEAD_OUT });
        },
        code_change_analyst: () => call('complete_work', { summary: 'CHILD SUMMARY', output: { summary: 'CHILD SUMMARY', risks: [], testIdeas: ['boundaries'] } }),
      },
    });
  });
  after(async () => h.dispose());

  test('the resumed turn re-enters waiting on the recorded operations; the model never sees an unresolved pending result', async () => {
    const run = await h.control.startRun({ goal: 'crash window', target: {} });
    const t = await h.control.tick(run.runId);
    const lead = t.dispatched[0]!;
    // simulate the crash: the item's transition to `waiting` never happens (the process dies right after the turn commit)
    const bb = h.deps.blackboard;
    const original = bb.transitionWorkItem.bind(bb);
    let crashed = 0;
    bb.transitionWorkItem = (async (...args: Parameters<typeof original>) => {
      if (args[0] === lead.workItemId && args[1] === 'waiting' && crashed === 0) {
        crashed++;
        throw new Error('simulated process death before the waiting transition');
      }
      return original(...args);
    }) as typeof original;
    try {
      await assert.rejects(h.control.executeTurn(lead.workItemId, lead.fencingToken), /simulated process death/);
    } finally {
      bb.transitionWorkItem = original;
    }
    assert.equal(crashed, 1);
    const turn1 = await h.deps.sessions.lastTurn((await h.deps.agents.byWorkItem(lead.workItemId))!.sessionId);
    assert.equal(turn1?.outcome?.status, 'waiting', 'the engine committed the waiting decision');
    assert.equal(((await h.deps.blackboard.getWorkItem(lead.workItemId)) as WorkItem).state, 'running', 'the item never entered waiting');
    const callsBefore = leadViews.length;

    // the retried turn (same claim) re-enters waiting on the recorded operations: no model call
    const child = (await items(h, run.runId)).find((w) => w.kind === 'delegation')!;
    const retried = await h.control.executeTurn(lead.workItemId, lead.fencingToken);
    assert.deepEqual(retried, { status: 'waiting', workItemId: lead.workItemId, operationIds: [`work:${child.workItemId}`] });
    assert.equal(leadViews.length, callsBefore, 'no model call while the operations are unresolved');
    const waiting = (await h.deps.blackboard.getWorkItem(lead.workItemId)) as WorkItem;
    assert.deepEqual([waiting.state, waiting.waitingOn], ['waiting', [`work:${child.workItemId}`]]);

    // the operations settle: the parent resumes WITH their results, exactly once
    const t2 = await h.control.tick(run.runId);
    assert.equal(await runItem(h.control, child.workItemId, t2.dispatched.find((d) => d.workItemId === child.workItemId)!.fencingToken), 'completed');
    assert.equal((await h.control.observeWaiting(lead.workItemId)).status, 'continue');
    const resumed = (await h.deps.blackboard.getWorkItem(lead.workItemId)) as WorkItem;
    assert.equal(await runItem(h.control, lead.workItemId, resumed.claim!.fencingToken), 'completed');
    const last = leadViews.at(-1)!;
    assert.equal(last.step, 1);
    assert.match(last.userText, new RegExp(`Results of pending operations/delegations:\\n- delegation work:${child.workItemId} \\(code_change_analyst\\) completed: CHILD SUMMARY`));
  });

  test('an item legitimately resumed after its operations settled runs its next turn (no false re-wait)', async () => {
    // the first test resumed the lead through observeWaiting: its last turn before the resume was a waiting turn, and
    // the next executeTurn ran the model (step 1) — covered above; here the waiting event exists for the item
    const run = (await h.deps.runs.list({}))[0]!;
    const waits = await h.deps.events.read(run.runId, { types: ['work.waiting'] });
    assert.equal(waits.length, 1, 'exactly one waiting period of the lead (the retried turn did not wait twice)');
  });
});
