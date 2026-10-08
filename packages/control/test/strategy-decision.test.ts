import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { DecisionNote, TestStrategy } from '@hypertest/domain';
import { toolPermitted } from '@hypertest/agents';
import { call, createHarness, parsed, runItem, type BrainView, type Harness } from './harness.ts';

/**
 * (B[9], CONFORMANCE "Blackboard: structured, versioned records (WorkItems, Findings, Hypotheses, CoverageGaps, Strategies,
 * Reviews, Decisions, Claims, EvidenceRefs)"): TestStrategies and Decisions are written by agent tools (structured, versioned
 * with lineage, capability-checked) and read back with blackboard.read.
 */
describe('blackboard.post_strategy / blackboard.post_decision', () => {
  let h: Harness;
  const results: Array<{ name: string; content: string; isError: boolean }> = [];
  const views: BrainView[] = [];
  let strategyRec = '';
  let decisionRec = '';
  before(async () => {
    h = await createHarness({
      brains: {
        lead: (v) => {
          views.push(v);
          if (v.lastResult) results.push(v.lastResult);
          switch (v.step) {
            case 0:
              return call('plan.propose_revision', { rationale: 'plan', objectives: [{ objectiveId: 'obj-a', description: 'discounts are exact', priority: 'P1' }], workItems: [] });
            case 1:
              // a strategy for an objective the plan does not have is refused
              return call('blackboard.post_strategy', { objectiveIds: ['obj-missing'], approach: 'white_box', techniques: ['boundary values'], description: 'nothing to cover' });
            case 2:
              return call('blackboard.post_strategy', { objectiveIds: ['obj-a'], approach: 'hybrid', techniques: ['boundary values', 'mutation'], description: 'Exercise 0/100/odd percentages white-box; mutate the factor.' });
            case 3:
              strategyRec = String(parsed(v.lastResult!.content)['recordId']);
              return call('blackboard.post_strategy', { objectiveIds: ['obj-a'], approach: 'white_box', techniques: ['boundary values', 'mutation', 'property-based'], description: 'Add property-based rounding checks.', updatesRecordId: strategyRec });
            case 4:
              return call('blackboard.post_decision', { topic: 'load testing', decision: 'skip load tests of the pricing module', rationale: 'pure function, no I/O' });
            case 5:
              decisionRec = String(parsed(v.lastResult!.content)['recordId']);
              return call('blackboard.post_decision', { topic: 'load testing', decision: 'skip', rationale: 'revised', updatesRecordId: strategyRec });
            case 6:
              return call('blackboard.read', { recordType: 'test_strategy' });
            case 7:
              return call('blackboard.read', { recordType: 'decision' });
            default:
              return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } });
          }
        },
      },
    });
  });
  after(async () => h.dispose());

  test('structured, versioned records with lineage; type-checked updates; readable; refusals are exact', async () => {
    const run = await h.control.startRun({ goal: 'strategy', target: {} });
    const d = (await h.control.tick(run.runId)).dispatched[0]!;
    assert.equal(await runItem(h.control, d.workItemId, d.fencingToken), 'completed');
    const [, missing, first, revised, decided, wrongType, readStrategies, readDecisions] = results;
    assert.equal(missing!.isError, true);
    assert.match(missing!.content, /not_found: objectives obj-missing are not objectives of the accepted plan v1/);
    assert.equal(first!.isError, false, first!.content);
    assert.equal(revised!.isError, false, revised!.content);
    assert.equal(parsed(revised!.content)['version'], 2);
    assert.equal(parsed(revised!.content)['lineageId'], strategyRec, 'the revision continues the lineage');
    assert.equal(decided!.isError, false, decided!.content);
    // a decision cannot supersede a strategy (type-checked lineage)
    assert.equal(wrongType!.isError, true);
    assert.match(wrongType!.content, new RegExp(`record ${strategyRec} is a test_strategy, not a decision`));
    const strategies = parsed(readStrategies!.content)['records'] as Array<{ recordType: string; version: number; payload: TestStrategy }>;
    assert.deepEqual(strategies.map((r) => [r.recordType, r.version, r.payload.approach, r.payload.techniques.length]), [['test_strategy', 2, 'white_box', 3]]);
    const decisions = parsed(readDecisions!.content)['records'] as Array<{ recordId: string; payload: DecisionNote }>;
    assert.deepEqual(decisions.map((r) => [r.recordId, r.payload.topic]), [[decisionRec, 'load testing']]);
    // on L0 like every blackboard record
    const posted = (await h.deps.events.read(run.runId)).filter((e) => ['test_strategy', 'decision'].includes(String((e.payload as Record<string, unknown>)['recordType'])));
    assert.ok(posted.length >= 3);
  });

  test('capability-checked: a role without the tool cannot post a strategy or a decision', async () => {
    const permitted = (role: string, id: string) => toolPermitted(h.deps.roles.require(role).toolPolicy, id);
    assert.equal(permitted('executor', 'blackboard.post_strategy'), false);
    assert.equal(permitted('executor', 'blackboard.post_decision'), false);
    assert.equal(permitted('lead', 'blackboard.post_strategy'), true);
    assert.equal(permitted('lead', 'blackboard.post_decision'), true);
    assert.equal(permitted('test_designer', 'blackboard.post_strategy'), true);
  });
});
