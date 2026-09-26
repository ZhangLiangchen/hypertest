/**
 * Subagent runtime semantics (technology-selection §Subagent Runtime): background and continuable children.
 *  - background: delegate returns at once with the child id; the parent keeps working, reads the child with
 *    delegate.status / delegate.collect (summary only) and is told in its inbox when the child finishes;
 *  - continuable: the child waits for more input after each task (delegate.message, queued through
 *    SubagentRuntime.message) until the parent releases it (delegate.release) or the parent's work ends (auto-release);
 *  - failure paths: messages to non-continuable / released children, handles on another item's child;
 *  - crash/resume: a background child whose worker died is taken over (new fencing token) and finishes with its identity.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { WorkItem } from '@hypertest/domain';
import { createControlPlane } from '../src/index.ts';
import { ControlStore } from '../src/store.ts';
import { call, createHarness, items, parsed, runItem, type BrainView, type Harness } from './harness.ts';

const LEAD_OUT = { summary: 'lead done', planProposed: false, readyForGate: false, objectives: [] };
const CHILD_OUT = (summary: string) => ({ summary, risks: [], testIdeas: ['boundary values'] });

function childIdOf(v: BrainView, index = 0): string {
  return parsed(v.toolResults[index]!.content)['workItemId'] as string;
}

async function item(h: Harness, id: string): Promise<WorkItem> {
  return (await h.deps.blackboard.getWorkItem(id)) as WorkItem;
}

async function dispatch(h: Harness, runId: string, workItemId: string): Promise<number> {
  const t = await h.control.tick(runId);
  const d = t.dispatched.find((x) => x.workItemId === workItemId);
  assert.ok(d, `${workItemId} dispatched (got ${t.dispatched.map((x) => x.workItemId).join(', ') || 'nothing'})`);
  return d.fencingToken;
}

describe('background delegation: the parent keeps working; status, collect and an inbox note carry only the summary', () => {
  test('delegate {background} returns the child id at once; the child runs on its own; collect returns its summary, never its trace', async () => {
    const leadViews: BrainView[] = [];
    let childId = '';
    const h = await createHarness({
      brains: {
        lead: (v) => {
          leadViews.push(v);
          switch (v.step) {
            case 0:
              return call('delegate', { role: 'code_change_analyst', objective: 'Summarise the risky functions of the change', title: 'bg summary', background: true });
            case 1:
              childId = childIdOf(v);
              return call('delegate.status', { childWorkItemId: childId });
            case 2:
              return call('delegate.collect', { childWorkItemId: childId });
            case 3:
              return call('delegate.status', { childWorkItemId: childId });
            default:
              return call('complete_work', { summary: 'background delegation done', output: LEAD_OUT });
          }
        },
        code_change_analyst: (v) => {
          if (v.step === 0) return call('blackboard.read', { status: 'CHILD-TRACE-MARKER' });
          return call('complete_work', { summary: 'BG CHILD SUMMARY: two risky functions', output: CHILD_OUT('BG CHILD SUMMARY') });
        },
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'background delegation', target: {} });
      const leadToken = (await h.control.tick(run.runId)).dispatched[0]!.fencingToken;
      const lead = (await items(h, run.runId))[0]!;
      // step 0: the delegate call does not suspend the parent
      assert.deepEqual(await h.control.executeTurn(lead.workItemId, leadToken), { status: 'continue', workItemId: lead.workItemId, turn: 1 });
      const child = (await items(h, run.runId)).find((w) => w.kind === 'delegation')!;
      assert.equal((await item(h, lead.workItemId)).state, 'running', 'the parent is not waiting');
      assert.equal(child.state, 'ready');
      assert.equal(child.parentWorkItemId, lead.workItemId);
      // step 1: the parent keeps working (status before the child ran)
      assert.equal((await h.control.executeTurn(lead.workItemId, leadToken)).status, 'continue');
      assert.equal(childId, child.workItemId);
      assert.match(leadViews[1]!.toolResults[0]!.content, /in the BACKGROUND as work item/);
      assert.equal(leadViews[1]!.toolResults[0]!.isError, false);
      // the child is admitted while the parent still runs, and completes on its own
      assert.equal(await runItem(h.control, child.workItemId, await dispatch(h, run.runId, child.workItemId)), 'completed');
      assert.equal((await h.deps.agents.byWorkItem(child.workItemId))!.background, true);
      // step 2: collect; the inbox note about the finished child arrived before it
      assert.equal((await h.control.executeTurn(lead.workItemId, leadToken)).status, 'continue');
      assert.match(leadViews[2]!.userText, new RegExp(`\\[delegation ${child.workItemId} \\(code_change_analyst\\) completed\\] BG CHILD SUMMARY: two risky functions`), 'the parent is told in its inbox');
      // step 3: status after completion; step 4: complete
      assert.equal(await runItem(h.control, lead.workItemId, leadToken), 'completed');
      const status0 = parsed(leadViews[2]!.toolResults[1]!.content);
      const collected = parsed(leadViews[3]!.toolResults[2]!.content);
      const status1 = parsed(leadViews[4]!.toolResults[3]!.content);
      assert.deepEqual([status0['state'], status0['agentStatus'], status0['resultAvailable'], status0['background'], status0['continuable']], ['ready', 'not_started', false, true, false]);
      assert.equal(collected['settled'], true);
      assert.equal(collected['summary'], 'BG CHILD SUMMARY: two risky functions');
      assert.deepEqual(collected['output'], CHILD_OUT('BG CHILD SUMMARY'));
      assert.deepEqual([status1['state'], status1['agentStatus'], status1['resultAvailable']], ['completed', 'completed', true]);
      for (const v of leadViews) assert.ok(!JSON.stringify(v.request.messages).includes('CHILD-TRACE-MARKER'), 'the child transcript never reaches the parent');
    } finally {
      await h.dispose();
    }
  });

  test('failure paths: a child of another work item is invisible; a non-continuable child takes no message and has nothing to release', async () => {
    const results: Array<{ name: string; content: string; isError: boolean }> = [];
    const h = await createHarness({
      brains: {
        lead: (v) => {
          if (v.lastResult) results.push(v.lastResult);
          switch (v.step) {
            case 0:
              return call('delegate', { role: 'code_change_analyst', objective: 'Summarise X', background: true });
            case 1:
              return call('delegate.message', { childWorkItemId: childIdOf(v), text: 'follow-up' });
            case 2:
              return call('delegate.release', { childWorkItemId: childIdOf(v) });
            case 3:
              return call('delegate.status', { childWorkItemId: v.workItemId });
            case 4:
              return call('delegate', { role: 'code_change_analyst', objective: 'Summarise Y', capabilityRequirements: [{ effect: 'teleport', resourceScopes: ['**'] }] });
            case 5:
              return call('delegate', { role: 'code_change_analyst', objective: 'Summarise Z', capabilityRequirements: [{ effect: 'read', resourceScopes: ['workspace/../etc'] }] });
            default:
              return call('complete_work', { summary: 'done', output: LEAD_OUT });
          }
        },
        code_change_analyst: () => call('complete_work', { summary: 'x', output: CHILD_OUT('x') }),
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'delegation refusals', target: {} });
      const t = await h.control.tick(run.runId);
      assert.equal(await runItem(h.control, t.dispatched[0]!.workItemId, t.dispatched[0]!.fencingToken), 'completed');
      const [delegated, message, release, foreign, badEffect, badScope] = results;
      assert.equal(delegated!.isError, false);
      assert.match(message!.content, /precondition_failed: child \S+ is not continuable/);
      assert.match(release!.content, /invalid_argument: child \S+ is not continuable/);
      assert.match(foreign!.content, /not_found: work item \S+ is not a child you delegated/);
      assert.match(badEffect!.content, /schema_violation|invalid_argument/);
      assert.match(badScope!.content, /invalid_argument: invalid capabilityRequirements: .*not a canonical resource pattern/);
      assert.equal((await items(h, run.runId)).filter((w) => w.kind === 'delegation').length, 1, 'refused delegations create nothing');
    } finally {
      await h.dispose();
    }
  });
});

describe('continuable delegation: follow-up messages, release and auto-release', () => {
  test('the child waits for input after its task; delegate.message resumes it (SubagentRuntime.message); release completes it with its last result', async () => {
    const leadViews: BrainView[] = [];
    const childViews: BrainView[] = [];
    let childId = '';
    const h = await createHarness({
      brains: {
        lead: (v) => {
          leadViews.push(v);
          switch (v.step) {
            case 0:
              return call('delegate', { role: 'code_change_analyst', objective: 'Summarise the risky functions', title: 'continuable', continuable: true });
            case 1:
              childId = /delegation work:(\S+) /.exec(v.userText)![1]!;
              return call('delegate.message', { childWorkItemId: childId, text: 'FOLLOW-UP: and what about rounding?' });
            case 2:
              return call('delegate.collect', { childWorkItemId: childId });
            case 3:
              return call('delegate.release', { childWorkItemId: childId });
            case 4:
              return call('delegate.message', { childWorkItemId: childId, text: 'too late' });
            default:
              return call('complete_work', { summary: 'continuable delegation done', output: LEAD_OUT });
          }
        },
        code_change_analyst: (v) => {
          childViews.push(v);
          if (/FOLLOW-UP/.test(v.userText)) return call('complete_work', { summary: 'ANSWER 2: rounding is safe', output: CHILD_OUT('ANSWER 2') });
          return call('complete_work', { summary: 'ANSWER 1: two risky functions', output: CHILD_OUT('ANSWER 1') });
        },
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'continuable delegation', target: {} });
      const t = await h.control.tick(run.runId);
      const leadId = t.dispatched[0]!.workItemId;
      assert.equal((await h.control.executeTurn(leadId, t.dispatched[0]!.fencingToken)).status, 'waiting', 'a foreground delegate waits');
      const child = (await items(h, run.runId)).find((w) => w.kind === 'delegation')!;
      // task 1: the child does not end, it waits for more input with its result recorded
      assert.equal(await runItem(h.control, child.workItemId, await dispatch(h, run.runId, child.workItemId)), 'waiting');
      const waiting = await item(h, child.workItemId);
      assert.deepEqual([waiting.state, waiting.waitingOn, waiting.result?.summary], ['waiting', [`input:${child.workItemId}`], 'ANSWER 1: two risky functions']);
      const childAgent = (await h.deps.agents.byWorkItem(child.workItemId))!;
      assert.deepEqual([childAgent.continuable, childAgent.status], [true, 'completed']);
      // nothing to do for the child yet
      assert.deepEqual(await h.control.observeWaiting(child.workItemId), { status: 'waiting', workItemId: child.workItemId, operationIds: [`input:${child.workItemId}`] });
      // the parent resumes with the first answer (the child's task is settled though it is not terminal)
      assert.equal((await h.control.observeWaiting(leadId)).status, 'continue');
      const leadToken = (await item(h, leadId)).claim!.fencingToken;
      assert.equal((await h.control.executeTurn(leadId, leadToken)).status, 'continue'); // step 1: delegate.message
      assert.match(leadViews[1]!.userText, /\(code_change_analyst\) completed its task \(continuable: it waits for delegate\.message or delegate\.release\): ANSWER 1/);
      assert.equal(childId, child.workItemId);
      // the message resumes the waiting child: it reads it at its next turn and answers with a new task result
      assert.equal((await h.control.observeWaiting(child.workItemId)).status, 'continue');
      assert.equal((await h.deps.agents.get(childAgent.agentId))!.status, 'active', 'SubagentRuntime.resume');
      assert.equal(await runItem(h.control, child.workItemId, (await item(h, child.workItemId)).claim!.fencingToken), 'waiting');
      assert.match(childViews.at(-1)!.userText, /\[delegate\.message dmsg_\w+ from lead \S+ \(work item \S+\)\]\nFOLLOW-UP: and what about rounding\?/);
      assert.equal((await item(h, child.workItemId)).result?.summary, 'ANSWER 2: rounding is safe');
      // step 2: collect returns the NEW answer; the inbox note about it arrived before it. step 3: release
      assert.equal((await h.control.executeTurn(leadId, leadToken)).status, 'continue');
      assert.match(leadViews[2]!.userText, new RegExp(`\\[delegation ${child.workItemId} \\(code_change_analyst\\) finished a task and waits for more input\\] ANSWER 2`));
      assert.equal((await h.control.executeTurn(leadId, leadToken)).status, 'continue');
      const collected = parsed(leadViews[3]!.toolResults[2]!.content);
      assert.equal(collected['summary'], 'ANSWER 2: rounding is safe');
      assert.equal(collected['awaitingInput'], true);
      // released: the child completes with its last result and takes no more input
      assert.deepEqual(await h.control.observeWaiting(child.workItemId), { status: 'completed', workItemId: child.workItemId });
      const done = await item(h, child.workItemId);
      assert.deepEqual([done.state, done.result?.summary], ['completed', 'ANSWER 2: rounding is safe']);
      assert.equal((await h.deps.agents.get(childAgent.agentId))!.status, 'disposed');
      assert.equal(await runItem(h.control, leadId, leadToken), 'completed'); // step 4: message refused, step 5: complete
      assert.match(leadViews[5]!.toolResults[4]!.content, /precondition_failed: child \S+ was released \(released by lead/);
      const d = (await new ControlStore(h.db).delegation(child.workItemId))!;
      assert.equal(d.messages.length, 1, 'one message, queued once');
      assert.equal(d.messages[0]!.enqueued, true);
      const types = (await h.deps.events.read(run.runId)).map((e) => e.eventType);
      assert.ok(types.includes('delegation.message_queued') && types.includes('delegation.released') && types.includes('agent.resumed'), types.join(','));
    } finally {
      await h.dispose();
    }
  });

  test('auto-release: a continuable child waiting for input is released when its parent completes; the run converges', async () => {
    const h = await createHarness({
      brains: {
        lead: (v) => {
          if (v.kind !== 'initial_plan') return call('fail_work', { reason: 'test', message: 'only the initial plan runs here' });
          if (v.step === 0) return call('delegate', { role: 'code_change_analyst', objective: 'Summarise the change', background: true, continuable: true });
          return call('complete_work', { summary: 'done without releasing', output: LEAD_OUT });
        },
        code_change_analyst: () => call('complete_work', { summary: 'CHILD ANSWER', output: CHILD_OUT('CHILD ANSWER') }),
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'auto release', target: {} });
      const t = await h.control.tick(run.runId);
      const leadId = t.dispatched[0]!.workItemId;
      assert.equal((await h.control.executeTurn(leadId, t.dispatched[0]!.fencingToken)).status, 'continue');
      const child = (await items(h, run.runId)).find((w) => w.kind === 'delegation')!;
      assert.equal(await runItem(h.control, child.workItemId, await dispatch(h, run.runId, child.workItemId)), 'waiting');
      // the parent finishes without releasing its child
      assert.equal(await runItem(h.control, leadId, t.dispatched[0]!.fencingToken), 'completed');
      const t2 = await h.control.tick(run.runId);
      assert.deepEqual(t2.waiting, [{ workItemId: child.workItemId, operationIds: [`input:${child.workItemId}`] }]);
      const d = (await new ControlStore(h.db).delegation(child.workItemId))!;
      assert.equal(d.releaseReason, `parent work item ${leadId} completed`);
      assert.deepEqual(await h.control.observeWaiting(child.workItemId), { status: 'completed', workItemId: child.workItemId });
      assert.equal((await item(h, child.workItemId)).result?.summary, 'CHILD ANSWER');
      const released = (await h.deps.events.read(run.runId, { types: ['delegation.released'] })).map((e) => e.payload as { auto: boolean; childWorkItemId: string });
      assert.deepEqual(released, [{ childWorkItemId: child.workItemId, parentWorkItemId: leadId, reason: `parent work item ${leadId} completed`, auto: true }]);
      // nothing is left waiting: the run converges (the lead replans once the plan drained; the harness has no plan)
      const t3 = await h.control.tick(run.runId);
      assert.deepEqual(t3.waiting, []);
    } finally {
      await h.dispose();
    }
  });
});

describe('crash / resume of a background child', () => {
  test('a background child whose worker died mid-task is taken over with a new fencing token and finishes as the same agent', async () => {
    const childViews: BrainView[] = [];
    const h = await createHarness({
      brains: {
        lead: (v) => {
          if (v.step === 0) return call('delegate', { role: 'code_change_analyst', objective: 'Summarise the risky functions', background: true });
          return call('complete_work', { summary: 'delegated in the background', output: LEAD_OUT });
        },
        code_change_analyst: (v) => {
          childViews.push(v);
          if (v.step === 0) return call('blackboard.read', {});
          return call('complete_work', { summary: 'RECOVERED CHILD SUMMARY', output: CHILD_OUT('RECOVERED') });
        },
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'background crash', target: {} });
      const t = await h.control.tick(run.runId);
      const leadId = t.dispatched[0]!.workItemId;
      assert.equal(await runItem(h.control, leadId, t.dispatched[0]!.fencingToken), 'completed');
      const child = (await items(h, run.runId)).find((w) => w.kind === 'delegation')!;
      const token1 = await dispatch(h, run.runId, child.workItemId);
      // the child's first turn runs, then its worker dies (no further executeTurn by worker-1)
      assert.equal((await h.control.executeTurn(child.workItemId, token1)).status, 'continue');
      const agent1 = (await h.deps.agents.byWorkItem(child.workItemId))!;
      h.clock.advance(60_001);
      const worker2 = createControlPlane({ ...h.deps, config: { ...h.deps.config, workerId: 'worker-2' } });
      try {
        const report = await worker2.recover(run.runId);
        assert.deepEqual(report.requeued, [child.workItemId]);
        const t2 = await worker2.tick(run.runId);
        const d2 = t2.dispatched.find((x) => x.workItemId === child.workItemId)!;
        assert.ok(d2.fencingToken > token1);
        assert.equal(d2.ownerId, 'worker-2');
        // the dead worker's claim is refused; the new one finishes the task in the same session
        assert.deepEqual(await h.control.executeTurn(child.workItemId, token1), { status: 'lease_lost', workItemId: child.workItemId });
        assert.equal(await runItem(worker2, child.workItemId, d2.fencingToken), 'completed');
        const agent2 = (await h.deps.agents.byWorkItem(child.workItemId))!;
        assert.equal(agent2.agentId, agent1.agentId, 'subagent identity survives the crash');
        assert.equal(agent2.background, true);
        assert.equal(childViews.at(-1)!.step, 1, 'the resumed child continues its transcript (turn 2), it does not start over');
        assert.equal((await item(h, child.workItemId)).result?.summary, 'RECOVERED CHILD SUMMARY');
        assert.ok((await h.deps.events.read(run.runId, { types: ['work.requeued'] })).some((e) => e.aggregateId === child.workItemId));
      } finally {
        await worker2.close();
      }
    } finally {
      await h.dispose();
    }
  });
});
