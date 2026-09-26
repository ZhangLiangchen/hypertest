/**
 * Gate inputs written by models are governed (I7/I8): a finding cannot be made to disappear from the QualityGate
 * (resolved, downgraded, reclassified, duplicated onto something weaker) by a role without that authority or without
 * evidence; closing/lowering a risk is evidence-first. And domain tools are replay-safe (I5): a tool call re-dispatched
 * with the same invocation id (crash after the effect, before the call settled) never duplicates its effect.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { JsonValue } from '@hypertest/core';
import type { BlackboardRecord, EventContext, Finding, Risk, TestRun, WorkItem } from '@hypertest/domain';
import type { NewWorkItem } from '@hypertest/collab';
import { ControlStore } from '../src/index.ts';
import { call, createHarness, items, parsed, runItem, type Harness, type RoleBrain } from './harness.ts';

type Result = { name: string; content: string; isError: boolean };

const BUDGET = { maxTurns: 20, maxTokens: 400_000, maxToolCalls: 40, maxWallClockMs: 600_000 };

function newItem(runId: string, role: string, title: string, priority: number): NewWorkItem {
  return {
    runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title, objective: `objective ${title}`, role, objectiveIds: [], capabilityRequirements: [],
    inputRefs: [], evidenceRequirements: [], dependsOn: [], budget: BUDGET, priority, depth: 0, fingerprint: `fp-${runId}-${title}`, resourceClaims: [], state: 'ready',
  };
}

function recorder(into: Result[], script: (step: number) => ReturnType<RoleBrain>): RoleBrain {
  return (v) => {
    if (v.lastResult) into.push(v.lastResult);
    return script(v.step);
  };
}

const FAIL = call('fail_work', { reason: 'done', message: 'script finished' });

async function seedEvidence(h: Harness, run: TestRun): Promise<string> {
  const artifact = await h.deps.artifacts.put(Buffer.from('seed test-result'), { mimeType: 'text/plain' });
  const e = await h.deps.evidence.append({
    runId: run.runId, evidenceType: 'test-result', artifact, summary: 'seeded test result', structured: { passed: false },
    producer: { workerId: 'seed', runtimeManifestId: run.runtimeManifestId }, provenance: {},
  });
  return e.evidenceId;
}

describe('record governance: a model cannot make a defect or risk disappear from the gate', () => {
  let h: Harness;
  let run: TestRun;
  let ev = '';
  let f: BlackboardRecord<Finding>;
  let g: BlackboardRecord<Finding>;
  let r: BlackboardRecord<Risk>;
  const exec: Result[] = [];
  const rca: Result[] = [];
  const analyst: Result[] = [];
  const findingArgs = (overrides: Record<string, JsonValue>): JsonValue => ({
    title: 'discount applied twice', description: 'applyDiscount(1000, 10) returns 800', severity: 'P1', category: 'product_defect', component: 'pricing', evidenceRefs: [ev], updatesRecordId: f.recordId, ...overrides,
  });

  before(async () => {
    h = await createHarness({
      brains: {
        lead: () => call('fail_work', { reason: 'idle', message: 'not part of this test' }),
        executor: recorder(exec, (step) => {
          switch (step) {
            case 0:
              return call('blackboard.post_finding', findingArgs({ status: 'rejected' }));
            case 1:
              return call('blackboard.post_finding', findingArgs({ severity: 'P3' }));
            case 2:
              return call('blackboard.post_finding', findingArgs({ category: 'test_defect' }));
            case 3:
              return call('blackboard.post_finding', findingArgs({ status: 'duplicate', duplicateOf: g.recordId }));
            case 4:
              return call('blackboard.post_finding', findingArgs({ status: 'duplicate' }));
            case 5:
              return call('blackboard.post_finding', { title: 'checkout total too low', description: 'same defect seen from checkout', severity: 'P1', category: 'product_defect', component: 'checkout', evidenceRefs: [ev] });
            case 6:
              return call('blackboard.post_finding', {
                title: 'checkout total too low', description: 'same defect seen from checkout', severity: 'P1', category: 'product_defect', component: 'checkout', evidenceRefs: [ev],
                updatesRecordId: parsed(exec[5]!.content)['recordId'] as string, status: 'duplicate', duplicateOf: f.recordId,
              });
            default:
              return FAIL;
          }
        }),
        rca: recorder(rca, (step) => {
          switch (step) {
            case 0:
              return call('blackboard.post_finding', findingArgs({ status: 'rejected', evidenceRefs: [], category: 'test_defect' }));
            case 1:
              return call('blackboard.post_finding', findingArgs({ category: 'test_defect', severity: 'P2' }));
            default:
              return FAIL;
          }
        }),
        code_change_analyst: recorder(analyst, (step) => {
          const risk = { title: 'rounding', description: 'rounding changed', likelihood: 'high', impact: 'high', componentRefs: ['pricing'], source: 'change_analysis', updatesRecordId: r.recordId };
          switch (step) {
            case 0:
              return call('blackboard.post_risk', { ...risk, likelihood: 'low' });
            case 1:
              return call('blackboard.post_risk', { ...risk, status: 'mitigated' });
            case 2:
              return call('blackboard.post_risk', { ...risk, status: 'mitigated', evidenceRefs: [ev] });
            default:
              return FAIL;
          }
        }),
      },
    });
    run = await h.control.startRun({ goal: 'record governance', target: {}, budget: { maxAgentConcurrency: 8 } });
    ev = await seedEvidence(h, run);
    const ctx: EventContext = { runId: run.runId, correlationId: run.runId, actorId: 'agent:seed' };
    const post = <T extends object>(recordType: 'finding' | 'risk', payload: T) => h.deps.blackboard.postRecord({ runId: run.runId, recordType, payload: payload as never, createdBy: 'agent:seed', evidenceRefs: [ev] }, ctx);
    f = (await post('finding', { title: 'discount applied twice', description: 'applyDiscount(1000, 10) returns 800', severity: 'P1', category: 'product_defect', component: 'pricing', status: 'open', fingerprint: 'fp-f' })) as BlackboardRecord<Finding>;
    g = (await post('finding', { title: 'label typo', description: 'cosmetic', severity: 'P3', category: 'product_defect', component: 'ui', status: 'open', fingerprint: 'fp-g' })) as BlackboardRecord<Finding>;
    r = (await post('risk', { title: 'rounding', description: 'rounding changed', likelihood: 'high', impact: 'high', level: 'high', componentRefs: ['pricing'], source: 'change_analysis', status: 'open' })) as BlackboardRecord<Risk>;
    const ictx = h.ctx(run.runId);
    await h.deps.blackboard.createWorkItem(newItem(run.runId, 'executor', 'exec', 90), ictx);
    await h.deps.blackboard.createWorkItem(newItem(run.runId, 'code_change_analyst', 'analyst', 80), ictx);
    const t = await h.control.tick(run.runId);
    for (const d of t.dispatched) await runItem(h.control, d.workItemId, d.fencingToken);
    // RCA acts after the executor (its update supersedes the head the executor left)
    await h.deps.blackboard.createWorkItem(newItem(run.runId, 'rca', 'rca', 70), ictx);
    for (const d of (await h.control.tick(run.runId)).dispatched) await runItem(h.control, d.workItemId, d.fencingToken);
  });
  after(async () => h.dispose());

  test('an executor may not resolve, downgrade or reclassify a product finding, nor duplicate it onto a weaker one', () => {
    const [rejected, lowered, reclassified, weakDup, noTarget, fresh, dup] = exec;
    assert.equal(rejected!.isError, true);
    assert.match(rejected!.content, /permission_denied: role executor may not mark findings rejected \(only rca, reviewer, lead\)/);
    assert.match(lowered!.content, /permission_denied: role executor may not lower the severity P1 → P3/);
    assert.match(reclassified!.content, /permission_denied: role executor may not reclassify a product_defect finding as test_defect/);
    assert.match(weakDup!.content, /invalid_argument: duplicateOf rec_\w+ is P3, less severe than this P1 finding: the defect would disappear from the gate/);
    assert.match(noTarget!.content, /invalid_argument: status duplicate requires duplicateOf/);
    assert.equal(fresh!.isError, false, fresh!.content);
    assert.equal(dup!.isError, false, 'a true duplicate of an unresolved, at least as severe finding is fine');
    assert.ok([rejected, lowered, reclassified, weakDup, noTarget].every((x) => x!.isError));
  });

  test('RCA may resolve or reclassify only with evidence; the gate then sees exactly the governed statuses', async () => {
    const [noEvidence, reclassified] = rca;
    assert.equal(noEvidence!.isError, true);
    assert.match(noEvidence!.content, /evidence_required: marking a finding rejected takes it out of the quality gate: cite the evidence that shows it/);
    assert.equal(reclassified!.isError, false, reclassified!.content);
    const heads = await h.deps.blackboard.query<Finding>({ runId: run.runId, recordType: 'finding' });
    const byLineage = new Map(heads.map((x) => [x.lineageId, x.payload]));
    assert.deepEqual([byLineage.get(f.lineageId)!.category, byLineage.get(f.lineageId)!.severity, byLineage.get(f.lineageId)!.status], ['test_defect', 'P2', 'open']);
    assert.equal(byLineage.get(g.lineageId)!.status, 'open', 'the weaker finding was never touched');
  });

  test('closing or lowering a risk must cite evidence', async () => {
    const [lowered, closedNoEvidence, closed] = analyst;
    assert.match(lowered!.content, /evidence_required: lowering a risk from high to medium takes it out of the quality gate/);
    assert.match(closedNoEvidence!.content, /evidence_required: marking an open risk mitigated takes it out of the quality gate/);
    assert.equal(closed!.isError, false, closed!.content);
    const risk = await h.deps.blackboard.head<Risk>(r.lineageId);
    assert.deepEqual([risk!.payload.status, risk!.evidenceRefs], ['mitigated', [ev]]);
  });
});

describe('replayed tool calls (same invocation id) never duplicate their effect (I5)', () => {
  let h: Harness;
  let run: TestRun;
  let ev = '';
  before(async () => {
    h = await createHarness({
      brains: {
        lead: () => call('blackboard.read', {}),
        executor: () => call('blackboard.read', {}),
        code_change_analyst: () => call('blackboard.read', {}),
      },
    });
  });
  after(async () => h.dispose());

  /** The item's EngineHost dispatcher, as a turn would use it (fenced with the item's claim). */
  async function hostOf(workItemId: string) {
    const item = (await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem;
    const r = (await h.deps.runs.get(item.runId)) as TestRun;
    const { agent, spec } = await h.control.worker.ensureAgent(item, r, item.claim!.fencingToken);
    const host = await h.control.worker.buildHost(item, r, agent, spec, item.claim!.fencingToken);
    return async (name: string, args: JsonValue, invocationId: string) => {
      const res = await host.tools.dispatch({ id: invocationId.split(':').pop()!, name: name.replaceAll('.', '__'), arguments: args }, { sessionId: agent.sessionId, turn: 1, signal: new AbortController().signal, invocationId });
      return { content: res.message.content, isError: res.message.isError === true };
    };
  }

  test('plan, experiment, approval, claim and record tools return the first execution\'s result on a replay', async () => {
    run = await h.control.startRun({ goal: 'replays', target: { commit: 'abc1234' }, budget: { maxAgentConcurrency: 8 } });
    ev = await seedEvidence(h, run);
    const ictx = h.ctx(run.runId);
    await h.deps.blackboard.createWorkItem(newItem(run.runId, 'executor', 'exec', 90), ictx);
    await h.deps.blackboard.createWorkItem(newItem(run.runId, 'code_change_analyst', 'analyst', 80), ictx);
    const t = await h.control.tick(run.runId);
    assert.equal(t.dispatched.length, 3);
    for (const d of t.dispatched) assert.equal((await h.control.executeTurn(d.workItemId, d.fencingToken)).status, 'continue');
    const all = await items(h, run.runId);
    const lead = await hostOf(all.find((w) => w.role === 'lead')!.workItemId);
    const exec = await hostOf(all.find((w) => w.role === 'executor')!.workItemId);
    const analyst = await hostOf(all.find((w) => w.role === 'code_change_analyst')!.workItemId);

    const plan: JsonValue = { rationale: 'replay', objectives: [{ objectiveId: 'o', description: 'd', priority: 'P2' }], workItems: [{ localId: 'a', title: 'a', objective: 'analyse', role: 'historical_bug_analyst', dependsOn: [], objectiveIds: ['o'] }] };
    const twice = async (dispatch: typeof lead, name: string, args: JsonValue, id: string) => [await dispatch(name, args, id), await dispatch(name, args, id)];

    const [p1, p2] = await twice(lead, 'plan.propose_revision', plan, 'sess:1:plan');
    assert.equal(p1!.isError, false, p1!.content);
    const first = parsed(p1!.content);
    const again = parsed(p2!.content);
    assert.deepEqual([again['accepted'], again['revision'], again['workItemIds'], again['replayed']], [true, first['revision'], first['workItemIds'], true]);
    assert.equal((await h.deps.blackboard.listPlans(run.runId)).length, 1, 'one plan revision');
    assert.equal((await items(h, run.runId)).filter((w) => w.origin.kind === 'plan').length, 1, 'one planned work item');
    // a different invocation is a new proposal
    assert.equal(parsed((await lead('plan.propose_revision', plan, 'sess:1:plan-2')).content)['revision'], 2);

    const [x1, x2] = await twice(lead, 'experiment.define', { hypothesis: 'the service holds 50 rps' }, 'sess:1:exp');
    assert.equal(parsed(x1!.content)['experimentId'], parsed(x2!.content)['experimentId']);
    assert.equal((await h.deps.specs.listExperiments(run.runId)).length, 1);

    const [a1, a2] = await twice(lead, 'request_approval', { kind: 'manual_review', subject: { topic: 'sign-off' }, rationale: 'human sign-off' }, 'sess:1:appr');
    assert.equal(parsed(a1!.content)['approvalId'], parsed(a2!.content)['approvalId']);
    assert.equal((await h.deps.approvals.list({ runId: run.runId })).length, 1);

    const claim: JsonValue = { statement: 'the suite fails', evidenceRefs: [ev], evidenceQuery: { evidenceType: 'test-result' } };
    const [c1, c2] = await twice(exec, 'evidence.claim', claim, 'sess:1:claim');
    assert.equal(c1!.isError, false, c1!.content);
    assert.equal(parsed(c1!.content)['claimId'], parsed(c2!.content)['claimId']);
    assert.equal((await new ControlStore(h.db).claims(run.runId)).length, 1);

    const [n1, n2] = await twice(exec, 'blackboard.post_note', { text: 'observed a slow fixture', evidenceRefs: [ev] }, 'sess:1:note');
    assert.equal(parsed(n1!.content)['recordId'], parsed(n2!.content)['recordId']);
    const risk: JsonValue = { title: 'rounding', description: 'rounding changed', likelihood: 'high', impact: 'high', source: 'change_analysis' };
    const [r1, r2] = await twice(analyst, 'blackboard.post_risk', risk, 'sess:1:risk');
    assert.equal(parsed(r1!.content)['recordId'], parsed(r2!.content)['recordId']);
    const update: JsonValue = { ...(risk as object), impact: 'critical', updatesRecordId: parsed(r1!.content)['recordId'] as string };
    const [u1, u2] = await twice(analyst, 'blackboard.post_risk', update, 'sess:1:risk-up');
    assert.equal(u2!.isError, false, 'a replayed update finds its own new head instead of a conflict');
    assert.equal(parsed(u1!.content)['recordId'], parsed(u2!.content)['recordId']);
    assert.equal((await h.deps.blackboard.query({ runId: run.runId, recordType: 'note' })).length, 1);
    assert.equal((await h.deps.blackboard.query({ runId: run.runId, recordType: 'risk', includeSuperseded: true })).length, 2, 'the risk and its one update');
  });
});
