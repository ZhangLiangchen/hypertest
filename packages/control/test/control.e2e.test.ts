/**
 * The product's behaviour end to end on the real stack (PGlite/PostgreSQL, real ToolRuntime, real router with
 * scripted brains keyed by the header line, a real node:test suite in a temp git repo):
 *   lead Plan v1 (2 parallel analysts) → analysts post risks → plan drained → lead Plan v2 (executor) → the executor
 *   runs the suite and posts an evidence-backed P1 finding → reactors wake RCA and TestDesigner (no lead in the path)
 *   → plan drained → lead Plan v3 readyForGate → QualityGate verdict fail, signed and bound to the sealed evidence root.
 * The audit test then reconstructs every model route, tool call and gate decision of that run from L0 events alone.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { canonicalJson } from '@hypertest/core';
import type { DomainEvent, QualityDecision, WorkItem } from '@hypertest/domain';
import { verifyEd25519 } from '@hypertest/evidence';
import { call, createHarness, drive, evidenceIds, items, parsed, type DriveResult, type Harness, type RoleBrain } from './harness.ts';
import { pricingOracle, pricingRepo } from './fixture.ts';

const OBJECTIVE = { objectiveId: 'obj-discount', description: 'Decide whether the discount change is releasable (REQ-7 holds on the candidate commit).', priority: 'P1', acceptanceCriteria: ['the pricing suite ran on the candidate with recorded test-result evidence'] };

const lead: RoleBrain = (v) => {
  const ordinal = Number(/Replan #(\d+)/.exec(v.userText)?.[1] ?? '0');
  if (v.kind === 'initial_plan') {
    if (v.step === 0) {
      return call('plan.propose_revision', {
        rationale: 'Analyse the change and its history in parallel before designing execution.',
        objectives: [OBJECTIVE],
        workItems: [
          { localId: 'change', title: 'Analyse the discount change', objective: 'Analyse the diff of src/pricing.js between base and candidate; post the risks.', role: 'code_change_analyst', dependsOn: [], objectiveIds: ['obj-discount'] },
          { localId: 'history', title: 'Analyse pricing history', objective: 'Review the history of src/pricing.js for defect-prone areas; post the risks.', role: 'historical_bug_analyst', dependsOn: [], objectiveIds: ['obj-discount'] },
        ],
      });
    }
    return call('complete_work', { summary: 'Plan v1 proposed', output: { summary: 'Plan v1: two parallel analyses', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-discount', status: 'open', evidenceRefs: [] }] } });
  }
  if (ordinal === 1) {
    if (v.step === 0) {
      return call('plan.propose_revision', {
        rationale: 'The analysts report high risks in applyDiscount: execute the pricing suite on the candidate.',
        objectives: [OBJECTIVE],
        workItems: [
          {
            localId: 'run-suite', title: 'Run the pricing suite', objective: 'Run the node:test pricing suite on the candidate commit and post evidence-backed findings for failures.',
            role: 'executor', dependsOn: [], objectiveIds: ['obj-discount'], evidenceRequirements: [{ evidenceType: 'test-result', minCount: 1, critical: true }],
          },
        ],
      });
    }
    return call('complete_work', { summary: 'Plan v2 proposed', output: { summary: 'Plan v2: execution', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-discount', status: 'open', evidenceRefs: [] }] } });
  }
  const ev = evidenceIds(v.userText);
  if (v.step === 0) {
    return call('plan.propose_revision', {
      rationale: 'The suite failed with a P1 product defect (RCA hypothesis supported). The objective is answered by evidence; hand over to the gate.',
      objectives: [{ ...OBJECTIVE, status: 'satisfied' }],
      workItems: [],
      readyForGate: true,
    });
  }
  return call('complete_work', { summary: 'Plan v3: ready for the gate', evidenceRefs: ev.slice(0, 1), output: { summary: 'ready for gate', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-discount', status: 'satisfied', evidenceRefs: ev.slice(0, 1) }] } });
};

const analyst: RoleBrain = (v) => {
  if (v.step === 0) {
    return call('blackboard.post_risk', {
      title: `${v.role}: discount arithmetic changed in applyDiscount`, description: 'The percentage factor changed in src/pricing.js.', likelihood: 'high', impact: 'high',
      componentRefs: ['pricing'], source: v.role === 'historical_bug_analyst' ? 'history' : 'change_analysis',
    });
  }
  const rec = parsed(v.lastResult!.content)['recordId'] as string;
  return call('complete_work', {
    summary: `${v.role} found a high risk in applyDiscount`, recordRefs: [rec],
    output: { summary: 'high risk', risks: [{ title: 'discount arithmetic', level: 'high', rationale: 'factor changed', components: ['pricing'], recordId: rec }], testIdeas: ['10% of 1000 cents'] },
  });
};

const executor: RoleBrain = (v) => {
  if (v.step === 0) return call('test.run', { framework: 'node_test' });
  if (v.step === 1) {
    return call('blackboard.post_finding', {
      title: '10% discount is applied twice', description: 'applyDiscount(1000, 10) returns 800 instead of 900 on the candidate commit.', severity: 'P1', category: 'product_defect',
      component: 'pricing', expected: '900', actual: '800', reproduction: 'node --test test/pricing.test.js', oracleRef: { oracleId: 'oracle.pricing', revision: 1, assertionId: 'discount-10' },
      evidenceRefs: evidenceIds(v.toolResults[0]!.content),
    });
  }
  const ids = evidenceIds(v.toolResults[0]!.content);
  const rec = parsed(v.lastResult!.content)['recordId'] as string;
  return call('complete_work', {
    summary: 'The pricing suite fails on the candidate: 1 of 2 tests.', evidenceRefs: ids, recordRefs: [rec],
    output: { summary: 'suite failed', executed: [{ selector: 'test/pricing.test.js', passed: false, outcome: 'failed', evidenceIds: ids }], findings: [rec] },
  });
};

const rca: RoleBrain = (v) => {
  const finding = /Determine the root cause of finding (rec_\w+)/.exec(v.userText)![1]!;
  if (v.step === 0) {
    return call('blackboard.post_hypothesis', {
      findingRecordId: finding, statement: 'The percentage factor is doubled at src/pricing.js:2 in the candidate commit.', confidence: 0.8, status: 'supported',
      suggestedChecks: ['compare applyDiscount on base and candidate'], evidenceRefs: evidenceIds(v.userText).slice(0, 1),
    });
  }
  const hyp = parsed(v.lastResult!.content)['recordId'] as string;
  return call('complete_work', {
    summary: 'Root cause hypothesis: doubled percentage factor.', recordRefs: [hyp, finding],
    output: { summary: 'hypothesis posted', hypotheses: [hyp], rootCause: { status: 'hypothesis', statement: 'doubled percentage factor' }, reproduction: 'not_attempted', findingRecordId: finding },
  });
};

const testDesigner: RoleBrain = () => call('complete_work', { summary: 'The existing test already covers the defect; no new artifact.', output: { summary: 'covered by existing test', testArtifacts: [] } });

/** (H7) The run-level review the gate requires: judges the recorded test-result itself, never a narrative. */
const reviewer: RoleBrain = (v) => {
  if (v.step === 0) return call('evidence.query', { evidenceType: 'test-result' });
  const ids = evidenceIds(v.toolResults[0]!.content);
  if (v.step === 1) {
    return call('blackboard.post_review', {
      subjectRef: { kind: 'run', id: v.runId }, verdict: 'approve',
      rationale: 'The recorded test-result shows the discount case failing on the candidate: the run\'s finding and verdict rest on execution evidence.',
      checkedEvidenceRefs: ids,
    });
  }
  const rec = parsed(v.lastResult!.content)['recordId'] as string;
  return call('complete_work', { summary: `run review: approve (checked ${ids.join(', ')})`, evidenceRefs: ids, recordRefs: [rec], output: { summary: 'approve', verdict: 'approve', reviews: [rec], checkedEvidenceIds: ids } });
};

describe('full mini run (e2e): plan v1 → v2 → reactors → v3 → gate fail', () => {
  let h: Harness;
  let repo: Awaited<ReturnType<typeof pricingRepo>>;
  let runId = '';
  let result: DriveResult;
  let decision: QualityDecision;

  before(async () => {
    repo = await pricingRepo();
    h = await createHarness({ brains: { lead, code_change_analyst: analyst, historical_bug_analyst: analyst, executor, rca, test_designer: testDesigner, reviewer } });
    await pricingOracle(h);
    const run = await h.control.startRun({
      goal: 'Analyse the discount change and decide whether it is releasable.',
      target: { repoPath: repo.path, commit: repo.head, baseCommit: repo.base, description: 'shop pricing module' },
      oracleIds: ['oracle.pricing'],
      labels: { project: 'shop' },
    });
    runId = run.runId;
    result = await drive(h, runId, 40);
    decision = result.final!.decision!;
  });
  after(async () => {
    await h.dispose();
    await repo.cleanup();
  });

  test('the run converges to a signed gate decision: fail, with the evidence-backed defect', async () => {
    assert.ok(result.final, `did not converge: ${result.ticks.map((t) => t.convergence.state).join(',')}`);
    assert.equal(result.final.final, true);
    assert.equal(decision.verdict, 'fail');
    // H7: the independent run review the gate requires was requested before the gate and approved on the recorded
    // test-result by a reviewer on another provider (gamma): C6 is satisfied; the defect still fails the gate
    assert.deepEqual(decision.violatedCriteria.map((c) => c.criterionId), ['C2', 'C3', 'C7']);
    assert.ok(decision.satisfiedCriteria.some((c) => c.criterionId === 'C6'), 'C6 satisfied by the independent run review');
    assert.deepEqual(decision.unknownCriteria, []);
    // the human review flag came from the missing independent review (C6), which the run review now supplies
    assert.equal(decision.requiresHumanReview, false);
    assert.deepEqual(decision.oracleRevisions, { 'oracle.pricing': 1 });
    const run = (await h.deps.runs.get(runId))!;
    assert.equal(run.status, 'completed');
    assert.equal(run.decisionId, decision.decisionId);
    assert.equal(run.currentPlanRevision, 3);
    // signed over its canonical content and bound to the sealed Merkle root
    const { signature, ...unsigned } = decision;
    assert.ok(signature);
    assert.equal(verifyEd25519(h.deps.signer!.publicKeyPem(), canonicalJson(unsigned), signature.value), true);
    const seal = await h.deps.evidence.latestSeal(runId);
    assert.equal(seal!.rootHash, decision.evidenceRootHash);
    assert.equal(seal!.count, decision.evidenceCount);
    assert.equal((await h.deps.evidence.verify(runId)).ok, true);
  });

  test('dynamic planning: three accepted revisions, parallel analysts, reactions without the lead', async () => {
    const plans = await h.deps.blackboard.listPlans(runId);
    assert.deepEqual(plans.map((p) => [p.revision, p.status, p.readyForGate]), [[1, 'superseded', false], [2, 'superseded', false], [3, 'accepted', true]]);
    const all = await items(h, runId);
    const v1 = all.filter((w) => w.planRevision === 1);
    const tickWithAnalysts = result.ticks.find((t) => t.dispatched.some((d) => v1.some((w) => w.workItemId === d.workItemId)))!;
    assert.deepEqual(tickWithAnalysts.dispatched.map((d) => all.find((w) => w.workItemId === d.workItemId)!.role).sort(), ['code_change_analyst', 'historical_bug_analyst']);
    assert.deepEqual(all.map((w) => [w.kind, w.role, w.state]), [
      ['initial_plan', 'lead', 'completed'],
      ['task', 'code_change_analyst', 'completed'],
      ['task', 'historical_bug_analyst', 'completed'],
      ['replan', 'lead', 'completed'],
      ['task', 'executor', 'completed'],
      ['reaction', 'test_designer', 'completed'],
      ['reaction', 'rca', 'completed'],
      ['replan', 'lead', 'completed'],
      ['reaction', 'reviewer', 'completed'],
    ]);
    // H7: the run-level review was requested by the control plane once the plan was ready for the gate (no lead involved)
    const requested = await h.deps.events.read(runId, { types: ['review.requested'] });
    assert.equal(requested.length, 1);
    assert.deepEqual((requested[0]!.payload as { subjectRef: unknown }).subjectRef, { kind: 'run', id: runId });
    const review = all.find((w) => w.role === 'reviewer')!;
    assert.deepEqual(review.origin, { kind: 'reactor', rule: 'reviewer.review_requested', eventId: requested[0]!.eventId });
    assert.deepEqual(review.inputRefs, [{ kind: 'run', id: runId }]);
    const replans = all.filter((w) => w.kind === 'replan');
    assert.match(replans[0]!.objective, /^Replan #1 \(reason: plan_drained\)/);
    assert.match(replans[0]!.objective, /risk rec_\w+ \[high, open\] code_change_analyst: discount arithmetic changed/);
    assert.match(replans[1]!.objective, /finding rec_\w+ \[P1, product_defect, open\] 10% discount is applied twice \(evidence: ev_/);
    // the reactions were caused by the finding event, not by the lead
    const findingEvent = (await h.deps.events.read(runId, { types: ['finding.created'] }))[0]!;
    for (const w of all.filter((x) => x.kind === 'reaction' && x.role !== 'reviewer')) {
      assert.deepEqual(w.origin, { kind: 'reactor', rule: w.role === 'rca' ? 'rca.investigate_finding' : 'test_designer.regression_for_finding', eventId: findingEvent.eventId });
      assert.equal(w.causationEventId, findingEvent.eventId);
    }
    assert.equal(findingEvent.workItemId, all.find((w) => w.role === 'executor')!.workItemId);
  });

  test('evidence-first artefacts: the finding cites the executor test-result; memory gets a candidate pitfall only', async () => {
    const [finding] = await h.deps.blackboard.query<{ severity: string; status: string }>({ runId, recordType: 'finding' });
    const exec = (await items(h, runId)).find((w) => w.role === 'executor')!;
    const testResults = await h.deps.evidence.query({ runId, workItemId: exec.workItemId, evidenceType: 'test-result' });
    assert.equal(testResults.length, 1);
    assert.ok(finding!.evidenceRefs.includes(testResults[0]!.evidenceId));
    const structured = testResults[0]!.structured as { passed: boolean; totals: { passed: number; failed: number } };
    assert.equal(structured.passed, false);
    assert.equal(structured.totals.failed, 1);
    assert.equal(structured.totals.passed, 1);
    const testEvents = await h.deps.events.read(runId, { types: ['test.failed', 'test.passed'] });
    assert.deepEqual(testEvents.map((e) => [e.eventType, (e.payload as { failed: number }).failed]), [['test.failed', 1]]);
    const trace = await h.deps.provenance.traceRecord(finding!.recordId);
    assert.deepEqual(trace.gaps, []);
    assert.equal(trace.complete, true);
    const experience = await h.deps.memory.list({ sourceRunId: runId });
    assert.equal(experience.length, 1);
    assert.equal(experience[0]!.kind, 'pitfall');
    assert.equal(experience[0]!.status, 'candidate');
    assert.deepEqual(experience[0]!.scope, { project: 'shop', topic: 'pricing' });
    assert.deepEqual(await h.deps.memory.retrieve({ text: 'discount' }), [], 'candidates are never retrievable before review');
  });

  test('the report is built from the stores: verdict, findings, plan evolution, routes per role, evidence seal', async () => {
    const report = await h.control.report(runId);
    assert.equal(report.verdict, 'fail');
    assert.equal(report.decision!.decisionId, decision.decisionId);
    assert.deepEqual(report.plans.map((p) => [p.revision, p.workItems]), [[1, 2], [2, 1], [3, 0]]);
    assert.deepEqual(report.findings.map((f) => [f.severity, f.status, f.title]), [['P1', 'open', '10% discount is applied twice']]);
    assert.equal(report.risks.length, 2);
    const routes = Object.fromEntries(report.models.map((m) => [m.role, m.routeId]));
    assert.deepEqual(routes, {
      code_change_analyst: 'alpha-large', executor: 'beta-exec', historical_bug_analyst: 'alpha-large', lead: 'alpha-large', rca: 'beta-exec', test_designer: 'alpha-large',
      reviewer: 'gamma-review',
    });
    assert.equal(report.models.find((m) => m.role === 'lead')!.turns, 6);
    assert.equal(report.evidence.sealed, true);
    assert.equal(report.evidence.rootHash, decision.evidenceRootHash);
    assert.match(report.markdown, /- \*\*Verdict:\*\* FAIL \(decision qd_\w+, revision 1, signed by ed25519:\w+\)/);
    assert.match(report.markdown, /\| rec_\w+ \| P1 \| open \| 10% discount is applied twice \| ev_/);
    assert.match(report.markdown, /- v2 \[superseded\] 1 work items — The analysts report high risks/);
    assert.match(report.markdown, /- executor: beta-exec \(beta\), 3 turns/);
  });

  test('audit (I10): every model route, tool call and gate decision is reconstructible from L0 events alone', async () => {
    const l0 = await h.deps.events.read(runId);
    // every event is correlated with its run
    for (const e of l0) {
      assert.equal(e.runId, runId);
      assert.ok(e.correlationId.length > 0, `${e.eventType} lacks a correlation id`);
    }
    const byType = (t: string) => l0.filter((e) => e.eventType === t);
    const agentRole = new Map(byType('agent.spawned').map((e) => [e.aggregateId, (e.payload as { role: string }).role]));
    const agentItem = new Map(byType('agent.spawned').map((e) => [e.aggregateId, (e.payload as { workItemId: string }).workItemId]));

    // model routes: role → route, from model.routed + model.epoch_started alone, equal to the runtime's epochs
    const routedByAgent = new Map<string, string[]>();
    for (const e of byType('model.epoch_started')) {
      const p = e.payload as { routeId: string; agentId?: string };
      const agentId = e.agentId ?? p.agentId!;
      routedByAgent.set(agentId, [...(routedByAgent.get(agentId) ?? []), p.routeId]);
    }
    assert.equal(byType('model.routed').length, agentRole.size, 'one routing decision per agent (no fallback happened)');
    const agents = await h.deps.agents.list({ runId });
    assert.equal(agents.length, agentRole.size);
    for (const a of agents) {
      const epochs = await h.deps.epochs.list(a.sessionId);
      assert.deepEqual(routedByAgent.get(a.agentId), epochs.map((x) => x.routeId), `routes of ${a.role}`);
      assert.equal(agentRole.get(a.agentId), a.role);
    }
    const invoked = byType('model.invoked');
    for (const e of invoked) {
      assert.ok(e.agentId && e.workItemId, 'model.invoked carries agent and work item');
      assert.equal(agentItem.get(e.agentId!), e.workItemId);
    }

    // tool calls: every tool call recorded by the session store is on L0 (called + completed), correlated to its item
    const called = new Map(byType('tool.called').map((e) => [(e.payload as { invocationId: string }).invocationId, e]));
    const completed = new Map(byType('tool.completed').map((e) => [(e.payload as { invocationId: string }).invocationId, e]));
    let calls = 0;
    let responses = 0;
    for (const a of agents) {
      const session = (await h.deps.sessions.get(a.sessionId))!;
      for (let turn = 1; turn <= session.turnCount; turn++) {
        const record = await h.deps.sessions.getTurn(a.sessionId, turn);
        if (record?.response) responses++;
        for (const tc of record?.toolCalls ?? []) {
          calls++;
          const c = called.get(tc.invocationId);
          assert.ok(c, `tool call ${tc.name} ${tc.invocationId} missing on L0`);
          assert.equal((c.payload as { toolId: string }).toolId, tc.name.replaceAll('__', '.'));
          assert.equal(c.agentId, a.agentId);
          assert.equal(c.workItemId, a.workItemId);
          assert.equal(c.correlationId, a.workItemId);
          assert.ok(completed.has(tc.invocationId), `tool call ${tc.invocationId} has no completion on L0`);
        }
      }
    }
    assert.equal(calls, called.size, 'L0 has exactly the recorded tool calls');
    assert.equal(invoked.length, responses, 'one model.invoked per recorded model response');

    // gate decisions: gate.evaluated + decision.recorded reproduce the stored decision
    const gates = byType('gate.evaluated');
    assert.equal(gates.length, 1);
    const g = gates[0]!.payload as { decisionId: string; verdict: string; evidenceRootHash: string; violated: string[]; unknown: string[]; satisfied: string[]; signed: boolean; final: boolean };
    assert.deepEqual(
      { decisionId: g.decisionId, verdict: g.verdict, root: g.evidenceRootHash, violated: g.violated, unknown: g.unknown, satisfied: g.satisfied, signed: g.signed, final: g.final },
      {
        decisionId: decision.decisionId, verdict: decision.verdict, root: decision.evidenceRootHash, violated: decision.violatedCriteria.map((c) => c.criterionId), unknown: [],
        satisfied: decision.satisfiedCriteria.map((c) => c.criterionId), signed: true, final: true,
      },
    );
    const recorded = byType('decision.recorded').find((e) => e.aggregateId === decision.decisionId)!;
    assert.equal((recorded.payload as { verdict: string }).verdict, 'fail');
    assert.equal(byType('gate.failed').length, 1);
    assert.ok(byType('evidence.sealed').length >= 1);

    // work lifecycle: the last work.* event of each item reproduces its final state
    const workEvents = l0.filter((e) => e.eventType.startsWith('work.'));
    for (const w of await items(h, runId)) {
      const mine = workEvents.filter((e) => e.aggregateId === w.workItemId) as Array<DomainEvent<{ to: string }>>;
      assert.equal(mine[mine.length - 1]!.payload.to, w.state, `lifecycle of ${w.workItemId}`);
    }
    // causal chain: RCA work ← finding.created ← (executor's work item)
    const rcaItem = (await items(h, runId)).find((w: WorkItem) => w.role === 'rca')!;
    const created = workEvents.find((e) => e.eventType === 'work.created' && e.aggregateId === rcaItem.workItemId)!;
    assert.deepEqual((await h.deps.events.causalChain(created.eventId)).map((e) => e.eventType), ['finding.created', 'work.created']);
  });
});
