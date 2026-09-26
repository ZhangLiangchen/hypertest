import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { JsonValue } from '@hypertest/core';
import type { ActionCapability, WorkItem } from '@hypertest/domain';
import { ANALYSIS_OUTPUT_SCHEMA, LEAD_OUTPUT_SCHEMA, TEST_DESIGN_OUTPUT_SCHEMA } from '@hypertest/agents';
import { call, createHarness, items, parsed, runItem, type BrainView, type Harness, type RoleBrain } from './harness.ts';

const LEAD_OUT: { [k: string]: JsonValue } = { summary: 'lead done', planProposed: false, readyForGate: false, objectives: [] };

function leadPlan(workItems: JsonValue[], objectives: JsonValue[] = [{ objectiveId: 'obj', description: 'objective', priority: 'P2' }]): ReturnType<RoleBrain> {
  return call('plan.propose_revision', { rationale: 'test plan', objectives, workItems });
}

async function dispatchLead(h: Harness, runId: string): Promise<{ workItemId: string; fencingToken: number }> {
  const t = await h.control.tick(runId);
  const d = t.dispatched.find((x) => x.workItemId);
  assert.ok(d, 'lead dispatched');
  return d;
}

describe('delegation: the parent waits, the child gets only its task, the parent gets only the summary', () => {
  let h: Harness;
  const leadViews: BrainView[] = [];
  before(async () => {
    h = await createHarness({
      brains: {
        lead: (v) => {
          leadViews.push(v);
          if (v.step === 0) return call('delegate', { role: 'code_change_analyst', objective: 'Summarise the risky functions of the change', title: 'change summary' });
          return call('complete_work', { summary: 'delegation done', output: LEAD_OUT });
        },
        code_change_analyst: (v) => {
          if (v.step === 0) return call('blackboard.read', { status: 'CHILD-TRACE-MARKER' });
          return call('complete_work', { summary: 'CHILD SUMMARY: two risky functions', output: { summary: 'CHILD SUMMARY', risks: [], testIdeas: ['boundary values'] } });
        },
      },
    });
  });
  after(async () => h.dispose());

  test('delegate ⇒ waiting ⇒ child runs with an attenuated capability ⇒ parent resumes with the summary only', async () => {
    const run = await h.control.startRun({ goal: 'delegation', target: {} });
    const lead = await dispatchLead(h, run.runId);
    const first = await h.control.executeTurn(lead.workItemId, lead.fencingToken);
    assert.equal(first.status, 'waiting');
    const all = await items(h, run.runId);
    const child = all.find((w) => w.kind === 'delegation')!;
    assert.deepEqual(first, { status: 'waiting', workItemId: lead.workItemId, operationIds: [`work:${child.workItemId}`] });
    assert.equal(all.find((w) => w.workItemId === lead.workItemId)!.state, 'waiting');
    assert.equal(child.role, 'code_change_analyst');
    assert.equal(child.parentWorkItemId, lead.workItemId);
    assert.deepEqual(child.expectedOutput, ANALYSIS_OUTPUT_SCHEMA);
    assert.equal(child.depth, 1);

    // not settled yet
    assert.deepEqual(await h.control.observeWaiting(lead.workItemId), { status: 'waiting', workItemId: lead.workItemId, operationIds: [`work:${child.workItemId}`] });

    // the waiting parent does not count against concurrency: the child is admitted
    const t = await h.control.tick(run.runId);
    assert.deepEqual(t.dispatched.map((d) => d.workItemId), [child.workItemId]);
    assert.deepEqual(t.waiting, [{ workItemId: lead.workItemId, operationIds: [`work:${child.workItemId}`] }]);
    assert.equal(await runItem(h.control, child.workItemId, t.dispatched[0]!.fencingToken), 'completed');

    // I2: the child's capability is attenuated from the parent's recorded capability, never a new root
    const leadAgent = (await h.deps.agents.byWorkItem(lead.workItemId))!;
    const childAgent = (await h.deps.agents.byWorkItem(child.workItemId))!;
    assert.equal(childAgent.parentAgentId, leadAgent.agentId);
    assert.equal(childAgent.depth, 1);
    const parentCap = (await h.deps.subagents.capabilityOf!(leadAgent.agentId)) as ActionCapability;
    const childCap = (await h.deps.subagents.capabilityOf!(childAgent.agentId)) as ActionCapability;
    assert.equal(childCap.parentCapabilityId, parentCap.capabilityId);
    assert.ok(childCap.tools.every((t2) => parentCap.tools.some((p) => p === t2 || (p.endsWith('*') && t2.startsWith(p.slice(0, -1))))));
    assert.ok(!childCap.tools.includes('blackboard.post_risk'), 'a tool the parent does not hold is never granted to the child');
    assert.ok(Date.parse(childCap.expiresAt) <= Date.parse(parentCap.expiresAt));

    // the parent resumes with the child's summary and nothing of the child's trace
    assert.equal((await h.control.observeWaiting(lead.workItemId)).status, 'continue');
    const leadItem = (await h.deps.blackboard.getWorkItem(lead.workItemId)) as WorkItem;
    assert.equal(leadItem.state, 'running');
    assert.deepEqual(leadItem.waitingOn, []);
    assert.equal(await runItem(h.control, lead.workItemId, leadItem.claim!.fencingToken), 'completed');
    const resumed = leadViews[leadViews.length - 1]!;
    assert.match(resumed.userText, /Results of pending operations\/delegations:\n- delegation work:\S+ \(code_change_analyst\) completed: CHILD SUMMARY: two risky functions/);
    const everything = JSON.stringify(resumed.request.messages);
    assert.ok(!everything.includes('CHILD-TRACE-MARKER'), 'the child transcript never reaches the parent');
    // the delegate call itself was a pending (not an error) tool result
    assert.match(resumed.toolResults[0]!.content, /^\[pending\] \(operation work:/);
    assert.equal(resumed.toolResults[0]!.isError, false);
  });
});

describe('domain tools: evidence-first governance', () => {
  let h: Harness;
  const executorResults: Array<{ name: string; content: string; isError: boolean }> = [];
  let leadWorkItem = '';
  before(async () => {
    h = await createHarness({
      brains: {
        lead: (v) => {
          leadWorkItem = v.workItemId;
          if (v.step === 0) {
            return leadPlan([
              { localId: 'e1', title: 'execute', objective: 'run the suite', role: 'executor', dependsOn: [], objectiveIds: ['obj'], evidenceRequirements: [{ evidenceType: 'test-result', minCount: 1, critical: true }] },
            ]);
          }
          return call('complete_work', { summary: 'planned', output: { ...LEAD_OUT, planProposed: true } });
        },
        executor: (v) => {
          if (v.lastResult) executorResults.push(v.lastResult);
          switch (v.step) {
            case 0:
              return call('blackboard.post_finding', { title: 'Discount doubled', description: 'd', severity: 'P1', category: 'product_defect', component: 'pricing', evidenceRefs: [] });
            case 1:
              return call('blackboard.post_finding', { title: 'Discount doubled', description: 'd', severity: 'P1', category: 'product_defect', component: 'pricing', evidenceRefs: ['ev_424242'] });
            case 2:
              return call('blackboard.post_finding', { title: 'Flaky fixture', description: 'fixture seeds time', severity: 'P3', category: 'test_defect', component: 'fixtures', evidenceRefs: [] });
            case 3:
              return call('blackboard.post_finding', { title: '  flaky   FIXTURE ', description: 'same symptom again', severity: 'P3', category: 'test_defect', component: 'fixtures', evidenceRefs: [] });
            case 4:
              return call('blackboard.post_finding', { title: 'Flaky fixture', description: 'd', severity: 'P3', category: 'test_defect', component: 'fixtures', evidenceRefs: [], status: 'confirmed', updatesRecordId: parsed(executorResults[2]!.content)['recordId'] as string });
            case 5:
              return call('complete_work', { summary: 'no run', output: { summary: 'no run', executed: [], findings: [] } });
            default:
              return call('fail_work', { reason: 'no_tests', message: 'could not produce the required test-result evidence' });
          }
        },
      },
    });
  });
  after(async () => h.dispose());

  test('post_finding refuses unevidenced defects and unknown evidence; dedupes; confirm is role-gated; complete_work checks evidence requirements', async () => {
    const run = await h.control.startRun({ goal: 'governance', target: {} });
    const lead = await dispatchLead(h, run.runId);
    assert.equal(await runItem(h.control, lead.workItemId, lead.fencingToken), 'completed');
    const t = await h.control.tick(run.runId);
    const exec = t.dispatched[0]!;
    assert.equal(await runItem(h.control, exec.workItemId, exec.fencingToken), 'failed');

    const [noEvidence, unknownEvidence, testDefect, duplicate, confirm, completion] = executorResults;
    assert.equal(noEvidence!.isError, true);
    assert.match(noEvidence!.content, /evidence_required: a product_defect finding must cite at least one evidence id/);
    assert.equal(unknownEvidence!.isError, true);
    assert.match(unknownEvidence!.content, /unknown_evidence: finding refused: evidence ev_424242 does not exist/);
    assert.equal(testDefect!.isError, false);
    const rec = parsed(testDefect!.content);
    assert.equal(rec['deduplicated'], false);
    assert.equal(parsed(duplicate!.content)['recordId'], rec['recordId']);
    assert.equal(parsed(duplicate!.content)['deduplicated'], true);
    assert.equal(confirm!.isError, true);
    assert.match(confirm!.content, /permission_denied: role executor may not confirm findings/);
    assert.equal(completion!.isError, true);
    assert.match(completion!.content, /complete_work refused; fix and call it again:\n- evidence requirements not met by this work item's own evidence: 1× test-result \(found 0\)/);

    const findings = await h.deps.blackboard.query({ runId: run.runId, recordType: 'finding' });
    assert.equal(findings.length, 1, 'refused findings were never written');
    const item = (await h.deps.blackboard.getWorkItem(exec.workItemId)) as WorkItem;
    assert.equal(item.state, 'failed');
    assert.deepEqual(item.failure, { reason: 'agent_failed', message: 'no_tests: could not produce the required test-result evidence' });
    assert.equal(item.result, undefined);
    assert.ok(leadWorkItem.startsWith('wi_'));
  });
});

describe('plan.propose_revision: validated Plan IR ⇒ work items with mapped dependencies', () => {
  let h: Harness;
  const results: Array<{ content: string; isError: boolean }> = [];
  before(async () => {
    h = await createHarness({
      brains: {
        lead: (v) => {
          if (v.lastResult) results.push(v.lastResult);
          if (v.step === 0) {
            return leadPlan([
              { localId: 'x', title: 'x', objective: 'x', role: 'code_change_analyst', dependsOn: ['y'], objectiveIds: ['obj'] },
              { localId: 'y', title: 'y', objective: 'y', role: 'code_change_analyst', dependsOn: ['x'], objectiveIds: ['obj'] },
            ]);
          }
          if (v.step === 1) {
            return leadPlan([
              { localId: 'a1', title: 'analyse', objective: 'analyse the diff', role: 'code_change_analyst', dependsOn: [], objectiveIds: ['obj'], priority: 70 },
              { localId: 'd1', title: 'design', objective: 'design a regression test', role: 'test_designer', dependsOn: ['a1'], objectiveIds: ['obj'], budget: { maxTurns: 7 } },
              { localId: 'e1', title: 'execute', objective: 'execute the test', role: 'executor', dependsOn: ['d1'], objectiveIds: ['obj'], evidenceRequirements: [{ evidenceType: 'test-result', minCount: 1, critical: true }] },
              { localId: 'h1', title: 'after lead', objective: 'history after planning', role: 'historical_bug_analyst', dependsOn: [v.workItemId], objectiveIds: ['obj'] },
            ]);
          }
          return call('complete_work', { summary: 'planned', output: { ...LEAD_OUT, planProposed: true } });
        },
      },
    });
  });
  after(async () => h.dispose());

  test('an invalid revision is recorded as rejected with issues and creates nothing; a valid one is accepted atomically', async () => {
    const run = await h.control.startRun({ goal: 'planning', target: {} });
    const lead = await dispatchLead(h, run.runId);
    assert.equal(await runItem(h.control, lead.workItemId, lead.fencingToken), 'completed');

    const [rejected, accepted] = results;
    assert.equal(rejected!.isError, false);
    assert.equal(parsed(rejected!.content)['accepted'], false);
    assert.match(rejected!.content, /plan revision 1 REJECTED:\n- dependency cycle: x → y → x/);
    const r2 = parsed(accepted!.content);
    assert.equal(r2['accepted'], true);
    assert.equal(r2['revision'], 2);

    const plans = await h.deps.blackboard.listPlans(run.runId);
    assert.deepEqual(plans.map((p) => [p.revision, p.status]), [[1, 'rejected'], [2, 'accepted']]);
    assert.deepEqual(plans[0]!.validationIssues, ['dependency cycle: x → y → x']);
    assert.equal((await h.deps.runs.get(run.runId))!.currentPlanRevision, 2);

    const all = await items(h, run.runId);
    const byLocal = (id: string) => all.find((w) => w.origin.kind === 'plan' && w.origin.localId === id)!;
    const [a1, d1, e1, h1] = ['a1', 'd1', 'e1', 'h1'].map(byLocal) as [WorkItem, WorkItem, WorkItem, WorkItem];
    assert.deepEqual(r2['workItemIds'], [a1.workItemId, d1.workItemId, e1.workItemId, h1.workItemId]);
    assert.deepEqual(a1.origin, { kind: 'plan', planRevision: 2, localId: 'a1' });
    assert.equal(a1.state, 'ready');
    assert.equal(a1.priority, 70);
    assert.deepEqual(d1.dependsOn, [a1.workItemId]);
    assert.equal(d1.state, 'blocked');
    assert.equal(d1.budget.maxTurns, 7);
    assert.equal(d1.budget.maxToolCalls, 150); // test_designer role default
    assert.deepEqual(d1.expectedOutput, TEST_DESIGN_OUTPUT_SCHEMA);
    assert.deepEqual(e1.dependsOn, [d1.workItemId]);
    assert.deepEqual(e1.evidenceRequirements, [{ evidenceType: 'test-result', minCount: 1, critical: true }]);
    assert.deepEqual(h1.dependsOn, [lead.workItemId], 'existing work item ids are kept');
    assert.equal(h1.state, 'blocked');
    assert.equal(all.filter((w) => w.kind === 'task').length, 4, 'the rejected revision created nothing');
    // the lead's item is complete now: its dependent becomes ready at the next tick
    await h.control.tick(run.runId);
    assert.notEqual((await h.deps.blackboard.getWorkItem(h1.workItemId))!.state, 'blocked');
    const leadItem = (await h.deps.blackboard.getWorkItem(lead.workItemId)) as WorkItem;
    assert.deepEqual(leadItem.expectedOutput, LEAD_OUTPUT_SCHEMA);
  });
});
