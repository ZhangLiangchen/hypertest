/**
 * "Pass only from evidence + rules + reviewer + outstanding risk; never pass from agent text" (technology-selection
 * §目标产品定义, §实施路线 evidence-driven acceptance), end to end on the real stack: the executor runs the pricing suite on
 * the candidate with the seeded regression, the ONLY test-result evidence it produces FAILED — and it then reports
 * success in every channel an agent has: its complete_work summary and structured output ("passed"), a critical report
 * claim, no finding; an approving reviewer and a lead that marks the objective satisfied follow the narrative. The
 * QualityGate reads the evidence against the oracle in force: the verdict is FAIL.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { QualityDecision } from '@hypertest/domain';
import { call, createHarness, drive, evidenceIds, parsed, type Harness, type RoleBrain } from './harness.ts';
import { pricingOracle, pricingRepo } from './fixture.ts';

const OBJECTIVE = { objectiveId: 'obj-discount', description: 'Decide whether the discount change is releasable (REQ-7 holds).', priority: 'P1', acceptanceCriteria: ['the pricing suite ran on the candidate'] };
const CLAIM = 'All pricing tests PASSED on the candidate; the discount change is releasable.';

const lead: RoleBrain = (v) => {
  const ev = evidenceIds(v.userText);
  if (v.kind === 'initial_plan') {
    if (v.step === 0) {
      return call('plan.propose_revision', {
        rationale: 'Execute the pricing suite on the candidate.',
        objectives: [OBJECTIVE],
        workItems: [{
          localId: 'run', title: 'Run the pricing suite', objective: 'Run the node:test pricing suite on the candidate and report.', role: 'executor', dependsOn: [], objectiveIds: ['obj-discount'],
          evidenceRequirements: [{ evidenceType: 'test-result', minCount: 1, critical: true }],
        }],
      });
    }
    return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-discount', status: 'open', evidenceRefs: [] }] } });
  }
  // the lead believes the executor's narrative and declares the objective satisfied
  if (v.step === 0) return call('plan.propose_revision', { rationale: `The executor reports: ${CLAIM}`, objectives: [{ ...OBJECTIVE, status: 'satisfied' }], workItems: [], readyForGate: true });
  return call('complete_work', {
    summary: `Releasable: ${CLAIM}`,
    evidenceRefs: ev.slice(0, 1),
    output: { summary: 'releasable', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-discount', status: 'satisfied', evidenceRefs: ev.slice(0, 1) }] },
  });
};

/** Runs the suite (it FAILS on the candidate), then reports success everywhere an agent can speak. */
const executor: RoleBrain = (v) => {
  if (v.step === 0) return call('test.run', { framework: 'node_test' });
  const ids = evidenceIds(v.toolResults[0]!.content);
  if (v.step === 1) return call('evidence.claim', { statement: CLAIM, critical: true, evidenceRefs: ids, evidenceQuery: { evidenceType: 'test-result' } });
  return call('complete_work', {
    summary: CLAIM,
    evidenceRefs: ids,
    output: { summary: CLAIM, executed: [{ selector: 'test/pricing.test.js', passed: true, outcome: 'passed', evidenceIds: ids }], findings: [] },
  });
};

/** A reviewer that approves on the executor's narrative (it never reads the test result). */
const reviewer: RoleBrain = (v) => {
  if (v.step === 0) return call('evidence.query', { evidenceType: 'test-result' });
  const ids = evidenceIds(v.toolResults[0]!.content);
  if (v.step === 1) {
    return call('blackboard.post_review', { subjectRef: { kind: 'run', id: v.runId }, verdict: 'approve', rationale: `The executor reports: ${CLAIM}`, checkedEvidenceRefs: ids });
  }
  const rec = parsed(v.lastResult!.content)['recordId'] as string;
  return call('complete_work', { summary: 'approve', evidenceRefs: ids, recordRefs: [rec], output: { summary: 'approve', verdict: 'approve', reviews: [rec], checkedEvidenceIds: ids } });
};

const noop: RoleBrain = () => call('complete_work', { summary: 'nothing to add', output: { summary: 'nothing to add', testArtifacts: [] } });

describe('never pass from agent text: success claimed in every channel, the only test-result evidence failed ⇒ fail', () => {
  let h: Harness;
  let repo: Awaited<ReturnType<typeof pricingRepo>>;
  let runId = '';
  let decision: QualityDecision;

  before(async () => {
    repo = await pricingRepo();
    h = await createHarness({ brains: { lead, executor, reviewer, test_designer: noop } });
    await pricingOracle(h);
    const run = await h.control.startRun({ goal: 'Is the discount change releasable?', target: { repoPath: repo.path, commit: repo.head, baseCommit: repo.base }, oracleIds: ['oracle.pricing'] });
    runId = run.runId;
    const result = await drive(h, runId, 40);
    assert.ok(result.final?.decision, `did not converge: ${result.ticks.map((t) => t.convergence.state).join(',')}`);
    decision = result.final.decision;
  });
  after(async () => {
    await h.dispose();
    await repo.cleanup();
  });

  test('the agents all claimed success', async () => {
    const work = await h.deps.blackboard.listWorkItems({ runId });
    const exec = work.find((w) => w.role === 'executor')!;
    assert.equal(exec.state, 'completed');
    assert.equal(exec.result!.summary, CLAIM);
    assert.equal((exec.result!.output as { executed: Array<{ passed: boolean }> }).executed[0]!.passed, true);
    assert.deepEqual(await h.deps.blackboard.query({ runId, recordType: 'finding' }), [], 'no finding was posted');
    const reviews = await h.deps.blackboard.query<{ verdict: string }>({ runId, recordType: 'review' });
    assert.deepEqual(reviews.map((r) => r.payload.verdict), ['approve']);
    const plan = (await h.deps.blackboard.latestAcceptedPlan(runId))!;
    assert.deepEqual([plan.readyForGate, plan.objectives[0]!.status], [true, 'satisfied']);
    // … while the only test-result the run recorded is a failure
    const results = await h.deps.evidence.query({ runId, evidenceType: 'test-result' });
    assert.equal(results.length, 1);
    assert.equal((results[0]!.structured as { passed: boolean }).passed, false);
  });

  test('the verdict comes from the evidence against the oracle: fail (C3), never pass', async () => {
    assert.equal(decision.verdict, 'fail', decision.reasons.join('\n'));
    assert.ok(decision.violatedCriteria.some((c) => c.criterionId === 'C3'), decision.violatedCriteria.map((c) => c.criterionId).join(','));
    const c3 = decision.violatedCriteria.find((c) => c.criterionId === 'C3')!;
    const failing = (await h.deps.evidence.query({ runId, evidenceType: 'test-result' }))[0]!.evidenceId;
    assert.deepEqual(c3.evidenceRefs, [failing]);
    assert.ok(decision.reasons.some((r) => /^C3 oracle\.pricing@1\/discount-10 \(P1\) violated: \*applies a 10% discount\*: failed$/.test(r)), decision.reasons.join('\n'));
    // the narrative channels were all satisfied — they cannot turn a failed execution into a pass
    for (const id of ['C4', 'C6', 'C9']) assert.ok(decision.satisfiedCriteria.some((c) => c.criterionId === id), id);
    const report = await h.control.report(runId);
    assert.equal(report.verdict, 'fail');
    assert.match(report.markdown, /\*\*Verdict:\*\* FAIL/);
  });
});
