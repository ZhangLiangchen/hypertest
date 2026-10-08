/**
 * Unit gate-governance — the control-plane side of the governed test lifecycle, experiments and replanning, end to end on
 * real tools and stores (scripted brains, a real node:test suite in a temp git repo).
 *
 *  D-0  the audit scenario: an insensitive `assert.ok(applyDiscount(1000, 10) > 0)` test plus a mutation-result of ANOTHER
 *       file never validates the artifact and never passes the gate; the positive path (bound known-bad on the candidate,
 *       known-good on the BASE revision, an independent oracle consistency review) makes the artifact gate evidence.
 *  D-1  lifecycle stages, re-registration (unchanged ⇒ same revision, never demoted; changed ⇒ new draft), drift hint.
 *  D-3/D-4/coverage-13  write/fault/load calls need an ACTIVE experiment (stopped, stop condition, plan, budget,
 *       ambiguity); dedicated environments are registration facts.
 *  D-10 an oracle approved mid-run re-pins the run and marks its decisions on the old revision needs_reassessment.
 *  coverage-17  a new unresolved P0/P1 finding replans the lead once per finding event (inbox dedupe).
 *  coverage-1 / D-9  the decision records its contract revisions (system model, oracles, experiments, test artifacts).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { JsonValue } from '@hypertest/core';
import type { ActionCapability, TestRun, WorkItem } from '@hypertest/domain';
import { artifactEligibility } from '@hypertest/policy';
import type { ToolExecutionRequest, ToolExecutionResult } from '@hypertest/tools';
import { WorkFactory, createToolDispatcher, experimentScope, runScope, workScope } from '../src/index.ts';
import { recordExperimentStop } from '../src/domain-tools/specs.ts';
import { assembleTurn, call, createHarness, drive, evidenceIds, items, parsed, runItem, turnSnapshot, type Harness, type RoleBrain } from './harness.ts';
import { pricingOracle, pricingRepo } from './fixture.ts';

type Result = { name: string; content: string; isError: boolean };

const HEADER = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { applyDiscount } from '../src/pricing.js';\n\n";
/** The audit's insensitive test: it passes on the defective candidate (800 > 0). */
const WEAK = `${HEADER}test('applies a 10% discount (weak)', () => {\n  assert.ok(applyDiscount(1000, 10) > 0);\n});\n`;
/** Another (strong) file: its mutation run kills mutants — evidence about IT, never about the weak artifact. */
const STRONG = `${HEADER}test('keeps a price without discount', () => {\n  assert.equal(applyDiscount(1000, 0), 1000);\n  assert.equal(applyDiscount(0, 10), 0);\n});\n`;
/** A real regression test bound to oracle assertion discount-10. */
const REGRESSION = `${HEADER}test('applies a 10% discount (regression)', () => {\n  assert.equal(applyDiscount(1000, 10), 900);\n});\n`;

const OBJ = { objectiveId: 'obj', description: 'Decide whether REQ-7 holds on the candidate.', priority: 'P1', acceptanceCriteria: ['an oracle-bound, validated test ran on the candidate'] };

function lead(designObjective: string): RoleBrain {
  return (v) => {
    if (v.kind === 'initial_plan') {
      if (v.step === 0) return call('system_model.record', { components: [{ componentId: 'pricing', name: 'pricing', kind: 'module', paths: ['src/pricing.js'] }], changedComponents: ['pricing'], sources: [{ kind: 'file', id: 'src/pricing.js' }] });
      if (v.step === 1) {
        return call('plan.propose_revision', {
          rationale: 'a regression test for REQ-7', objectives: [OBJ],
          workItems: [{ localId: 'd', title: 'design', objective: designObjective, role: 'test_designer', dependsOn: [], objectiveIds: ['obj'] }],
        });
      }
      return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj', status: 'open', evidenceRefs: [] }] } });
    }
    const ev = evidenceIds(v.userText);
    const status = ev.length > 0 ? 'satisfied' : 'dropped';
    if (v.step === 0) return call('plan.propose_revision', { rationale: 'hand over to the gate', objectives: [{ ...OBJ, status }], workItems: [], readyForGate: true });
    return call('complete_work', { summary: 'ready', output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj', status, evidenceRefs: ev.slice(0, 1) }] } });
  };
}

/**
 * The reviewer: an oracle consistency review of a test artifact (approve or reject as scripted), or the run review the
 * gate requires (approve on the recorded test-results).
 */
function reviewer(hRef: () => Harness, artifactVerdict: 'approve' | 'reject', log: Result[]): RoleBrain {
  return async (v) => {
    if (v.lastResult) log.push(v.lastResult);
    const h = hRef();
    const artifactId = /Independently review subject (ta_\w+)/.exec(v.userText)?.[1];
    const checked = (await h.deps.evidence.query({ runId: v.runId, evidenceType: 'test-result' })).map((e) => e.evidenceId).slice(0, 4);
    const verdict = artifactId ? artifactVerdict : 'approve';
    if (v.step === 0) {
      return call('blackboard.post_review', {
        subjectRef: artifactId ? { kind: 'test_artifact', id: artifactId } : { kind: 'run', id: v.runId }, verdict,
        rationale: artifactId ? 'the assertion checks exactly 1000 → 900 (discount-10)' : 'the verdict rests on the recorded test-results', checkedEvidenceRefs: checked,
      });
    }
    const rec = parsed(v.lastResult!.content)['recordId'] as string;
    return call('complete_work', { summary: `review: ${verdict}`, evidenceRefs: checked, recordRefs: [rec], output: { summary: verdict, verdict, reviews: [rec], checkedEvidenceIds: checked } });
  };
}

async function evidenceOf(h: Harness, runId: string, workItemId: string, type: string) {
  return h.deps.evidence.query({ runId, workItemId, evidenceType: type });
}

describe('D-0 the audit scenario: an insensitive test plus another file\'s mutation result never passes', () => {
  let h: Harness;
  let repo: Awaited<ReturnType<typeof pricingRepo>>;
  const design: Result[] = [];
  const reviews: Result[] = [];
  let runId = '';
  before(async () => {
    repo = await pricingRepo();
    h = await createHarness({
      brains: {
        lead: lead('write a regression test for the 10% discount'),
        test_designer: async (v) => {
          if (v.lastResult) design.push(v.lastResult);
          const artifactId = design[2] ? (parsed(design[2].content)['artifactId'] as string) : '';
          const [mutation] = await evidenceOf(h, v.runId, v.workItemId, 'mutation-result');
          const [weakRun] = await evidenceOf(h, v.runId, v.workItemId, 'test-result');
          switch (v.step) {
            case 0:
              return call('fs.write', { path: 'test/weak.test.js', content: WEAK });
            case 1:
              return call('fs.write', { path: 'test/strong.test.js', content: STRONG });
            case 2:
              return call('test_artifact.register', { path: 'test/weak.test.js', sourceType: 'generated', runner: { framework: 'node_test', selector: 'test/weak.test.js' }, oracleRefs: [{ oracleId: 'oracle.pricing', revision: 1, assertionIds: ['discount-10'] }] });
            case 3:
              // the mutation run of ANOTHER file (the audit's "mutation-result from another file")
              return call('mutation.run', { file: 'src/pricing.js', testSelector: 'test/strong.test.js', framework: 'node_test', maxMutants: 6 });
            case 4:
              return call('test.run', { framework: 'node_test', selector: 'test/weak.test.js' });
            case 5:
              return call('test_artifact.validate', { artifactId, knownGoodEvidenceId: weakRun!.evidenceId, mutationEvidenceId: mutation!.evidenceId });
            case 6:
              // its own run on the defective candidate PASSED: bound, but no sensitivity
              return call('test_artifact.validate', { artifactId, knownBadEvidenceId: weakRun!.evidenceId });
            default:
              return call('complete_work', { summary: 'weak test registered', output: { summary: 'registered', testArtifacts: [{ artifactId, path: 'test/weak.test.js', covers: ['discount-10'] }] } });
          }
        },
        reviewer: reviewer(() => h, 'approve', reviews),
      },
    });
    await pricingOracle(h);
    const run = await h.control.startRun({ goal: 'audit scenario', target: { repoPath: repo.path, commit: repo.head, baseCommit: repo.base }, oracleIds: ['oracle.pricing'] });
    runId = run.runId;
  });
  after(async () => {
    await h.dispose();
    await repo.cleanup();
  });

  test('foreign mutation evidence is refused; the insensitive test stays draft; the gate never passes on it', async () => {
    const out = await drive(h, runId, 60);
    const [, , registered, mutated, ran, foreign, insensitive] = design;
    assert.equal(registered!.isError, false, registered!.content);
    assert.equal(mutated!.isError, false, mutated!.content);
    assert.match(mutated!.content, /executed test files: test\/strong\.test\.js/);
    assert.match(ran!.content, /PASSED/, 'the weak test passes on the defective candidate');
    // the mutation result of another file is refused outright (foreign evidence), with the exact reason
    assert.equal(foreign!.isError, true);
    assert.match(foreign!.content, /foreign_evidence: validation refused: mutation evidence ev_\w+ did not execute test\/weak\.test\.js \(artifact ta_\w+\); it executed test\/strong\.test\.js — foreign evidence never proves this artifact/);
    // its own passing candidate run is bound but proves no sensitivity
    assert.equal(parsed(insensitive!.content)['approvalState'], 'draft');
    assert.match(insensitive!.content, /known-bad: the test did not fail with an assertion failure on the known-bad code/);
    const artifactId = parsed(registered!.content)['artifactId'] as string;
    const artifact = (await h.deps.specs.getTestArtifact(artifactId))!;
    assert.equal(artifact.approvalState, 'draft');
    assert.equal(artifact.validations.mutation, undefined, 'no foreign mutation result was recorded for it');
    // no review was ever requested for it (only a validated artifact is reviewed)
    const requested = (await h.deps.events.read(runId, { types: ['review.requested'] })).filter((e) => (e.payload as { subjectRef?: { kind: string } }).subjectRef?.kind === 'test_artifact');
    assert.deepEqual(requested, []);
    // the gate: the weak artifact's passing run is not gate evidence — discount-10 is unproven, never pass
    const decision = out.final!.decision!;
    assert.notEqual(decision.verdict, 'pass');
    assert.ok(!decision.satisfiedCriteria.some((c) => c.criterionId === 'C3'), 'C3 is never satisfied by the insensitive test');
    assert.ok(decision.unknownCriteria.some((c) => c.criterionId === 'C3'), decision.reasons.join('\n'));
    assert.ok(decision.reasons.some((r) => r.includes(artifactId) && /not eligible|ineligible|draft/.test(r)), decision.reasons.join('\n'));
  });
});

describe('review of D-0/D-1: an insensitive test cannot borrow sensitivity from mutants of itself, nor P0/P1 support from a pass on the candidate', () => {
  // Before the review fix both paths reached VERDICT pass on the defective candidate (applyDiscount(1000, 10) = 800): the
  // weak test mutated ITSELF (its tautological `10 * 2 === 20` killed its own mutants), or it cited its own passing run on
  // the candidate as "known-good" plus one product mutant its `> 0` happens to kill; an approving oracle review did the rest.
  const TAUTOLOGY = `${HEADER}test('applies a 10% discount (weak)', () => {\n  assert.ok(applyDiscount(1000, 10) > 0);\n  assert.equal(10 * 2, 20);\n});\n`;
  let h: Harness;
  let repo: Awaited<ReturnType<typeof pricingRepo>>;
  const design: Result[] = [];
  const reviews: Result[] = [];
  let runId = '';
  before(async () => {
    repo = await pricingRepo();
    h = await createHarness({
      brains: {
        lead: lead('write a regression test for the 10% discount'),
        test_designer: async (v) => {
          if (v.lastResult) design.push(v.lastResult);
          const artifactId = design[1] ? (parsed(design[1].content)['artifactId'] as string) : '';
          const [candidateRun] = await evidenceOf(h, v.runId, v.workItemId, 'test-result');
          const [mutation] = await evidenceOf(h, v.runId, v.workItemId, 'mutation-result');
          switch (v.step) {
            case 0:
              return call('fs.write', { path: 'test/weak.test.js', content: TAUTOLOGY });
            case 1:
              return call('test_artifact.register', { path: 'test/weak.test.js', sourceType: 'generated', runner: { framework: 'node_test', selector: 'test/weak.test.js' }, oracleRefs: [{ oracleId: 'oracle.pricing', revision: 1, assertionIds: ['discount-10'] }] });
            case 2:
              // mutate the test itself: refused (test code is never a mutation target)
              return call('mutation.run', { file: 'test/weak.test.js', testSelector: 'test/weak.test.js', framework: 'node_test', maxMutants: 8 });
            case 3:
              // product mutants: `> 0` kills the one that makes the price negative — bound, a real (if weak) kill
              return call('mutation.run', { file: 'src/pricing.js', testSelector: 'test/weak.test.js', framework: 'node_test', maxMutants: 20 });
            case 4:
              return call('test.run', { framework: 'node_test', selector: 'test/weak.test.js' });
            case 5:
              // "known-good" = its own pass on the defective candidate
              return call('test_artifact.validate', { artifactId, knownGoodEvidenceId: candidateRun!.evidenceId, mutationEvidenceId: mutation!.evidenceId });
            default:
              return call('complete_work', { summary: 'weak test validated', output: { summary: 'validated', testArtifacts: [{ artifactId, path: 'test/weak.test.js', covers: ['discount-10'] }] } });
          }
        },
        reviewer: reviewer(() => h, 'approve', reviews),
      },
    });
    await pricingOracle(h);
    const run = await h.control.startRun({ goal: 'review probe', target: { repoPath: repo.path, commit: repo.head, baseCommit: repo.base }, oracleIds: ['oracle.pricing'] });
    runId = run.runId;
  });
  after(async () => {
    await h.dispose();
    await repo.cleanup();
  });

  test('self-mutation is refused; a candidate "known-good" leaves the approved artifact without P0/P1 support; the buggy candidate never passes', async () => {
    const out = await drive(h, runId, 60);
    const [, registered, selfMutation, productMutation, , validated] = design;
    assert.equal(selfMutation!.isError, true);
    assert.match(selfMutation!.content, /test\/weak\.test\.js is test code: mutation\.run mutates the candidate's PRODUCT source/);
    assert.equal(productMutation!.isError, false, productMutation!.content);
    assert.match(productMutation!.content, /mutated: src\/pricing\.js\n/);
    assert.equal(parsed(validated!.content)['approvalState'], 'validated', validated!.content);
    assert.equal((parsed(validated!.content)['stages'] as Record<string, string>)['knownGood'], 'passed (workspace: no P0/P1 support)');
    assert.match(validated!.content, /never support or violate a P0\/P1 assertion/);
    const artifactId = parsed(registered!.content)['artifactId'] as string;
    const artifact = (await h.deps.specs.getTestArtifact(artifactId))!;
    assert.equal(artifact.approvalState, 'approved', 'the (LLM) oracle consistency review approved it');
    const decision = out.final!.decision!;
    assert.notEqual(decision.verdict, 'pass', decision.reasons.join('\n'));
    assert.ok(decision.unknownCriteria.some((c) => c.criterionId === 'C3'), decision.reasons.join('\n'));
    assert.ok(decision.reasons.some((r) => r.startsWith('C3 oracle.pricing@1/discount-10 (P1) unproven') && r.includes('neither satisfy nor violate')), decision.reasons.join('\n'));
  });
});

describe('D-0/D-1 the positive path: bound known-bad + base known-good + independent review ⇒ gate evidence', () => {
  let h: Harness;
  let repo: Awaited<ReturnType<typeof pricingRepo>>;
  const design: Result[] = [];
  const reviews: Result[] = [];
  let runId = '';
  before(async () => {
    repo = await pricingRepo();
    h = await createHarness({
      brains: {
        lead: lead('write a regression test for the 10% discount, validated against the base revision'),
        test_designer: async (v) => {
          if (v.lastResult) design.push(v.lastResult);
          const artifactId = design[1] ? (parsed(design[1].content)['artifactId'] as string) : '';
          const [bad, good] = await evidenceOf(h, v.runId, v.workItemId, 'test-result');
          const registration = { path: 'test/regression.test.js', sourceType: 'generated', runner: { framework: 'node_test', selector: 'test/regression.test.js' }, oracleRefs: [{ oracleId: 'oracle.pricing', revision: 1, assertionIds: ['discount-10'] }] };
          switch (v.step) {
            case 0:
              return call('fs.write', { path: 'test/regression.test.js', content: REGRESSION });
            case 1:
              return call('test_artifact.register', registration);
            case 2:
              return call('test.run', { framework: 'node_test', selector: 'test/regression.test.js' });
            case 3:
              return call('test.run', { framework: 'node_test', selector: 'test/regression.test.js', revision: 'base' });
            case 4:
              return call('test_artifact.validate', { artifactId, knownGoodEvidenceId: good!.evidenceId, knownBadEvidenceId: bad!.evidenceId });
            case 5:
              // addendum: registering the unchanged file again never demotes the validated artifact
              return call('test_artifact.register', registration);
            default:
              return call('complete_work', { summary: 'regression test validated', output: { summary: 'validated', testArtifacts: [{ artifactId, path: 'test/regression.test.js', covers: ['discount-10'] }] } });
          }
        },
        reviewer: reviewer(() => h, 'approve', reviews),
      },
    });
    await pricingOracle(h);
    const run = await h.control.startRun({ goal: 'positive path', target: { repoPath: repo.path, commit: repo.head, baseCommit: repo.base }, oracleIds: ['oracle.pricing'] });
    runId = run.runId;
  });
  after(async () => {
    await h.dispose();
    await repo.cleanup();
  });

  test('validated → reviewed by another agent and role → approved; eligible; its failure on the candidate fails the gate', async () => {
    const out = await drive(h, runId, 60);
    const [, registered, bad, good, validated, again] = design;
    const artifactId = parsed(registered!.content)['artifactId'] as string;
    assert.match(bad!.content, /NOT PASSED/);
    assert.match(good!.content, /KNOWN-GOOD RUN ON THE BASE REVISION/);
    assert.equal(parsed(validated!.content)['approvalState'], 'validated', validated!.content);
    assert.deepEqual(parsed(again!.content), { ...parsed(again!.content), artifactId, revision: parsed(validated!.content)['revision'], approvalState: 'validated', unchanged: true });
    // the review was requested once and answered by the reviewer (another agent, another role)
    const requested = (await h.deps.events.read(runId, { types: ['review.requested'] })).filter((e) => (e.payload as { subjectRef?: { kind: string; id: string } }).subjectRef?.id === artifactId);
    assert.equal(requested.length, 1);
    const reviewItem = (await items(h, runId)).find((w) => w.role === 'reviewer' && w.inputRefs.some((r) => r.kind === 'test_artifact' && r.id === artifactId))!;
    assert.equal(reviewItem.state, 'completed');
    const artifact = (await h.deps.specs.getTestArtifact(artifactId))!;
    assert.equal(artifact.approvalState, 'approved');
    assert.equal(artifact.oracleReview!.verdict, 'approve');
    assert.equal(artifact.oracleReview!.reviewerRole, 'reviewer');
    assert.equal(artifact.oracleReview!.artifactDigest, artifact.artifactDigest);
    assert.notEqual(artifact.oracleReview!.reviewerAgentId, artifact.generatedBy!.agentId);
    const reviewed = await h.deps.events.read(runId, { types: ['test_artifact.reviewed'] });
    assert.deepEqual(reviewed.map((e) => (e.payload as { verdict: string; approvalState: string }).approvalState), ['approved']);
    // the policy re-derives the lifecycle from the stores: eligible, and may support a P1 assertion
    const run = (await h.deps.runs.get(runId))!;
    const evidence = await h.deps.evidence.query({ runId });
    const reviewRecords = await h.deps.blackboard.query({ runId, recordType: 'review' });
    const oracle = (await h.deps.specs.getOracle('oracle.pricing', 1))!;
    const eligibility = artifactEligibility(artifact, { evidence: new Map(evidence.map((e) => [e.evidenceId, e])), reviews: reviewRecords as never, oraclesInForce: [oracle], baseCommit: run.target.baseCommit! });
    assert.deepEqual([eligibility.eligible, eligibility.criticalSupport], [true, true], eligibility.reasons.join('; '));
    // D-9: evidence names the SystemModel revision it was recorded under (provenance, inside the hash-chained metadata)
    const candidateRun = evidence.find((e) => e.evidenceType === 'test-result' && (e.structured as { codeRevision?: { kind?: string } }).codeRevision?.kind === 'workspace')!;
    assert.equal((candidateRun.provenance as { systemModelRevision?: number }).systemModelRevision, 1);
    // the gate: the approved, bound regression test fails on the candidate ⇒ C3 violated, verdict fail
    const decision = out.final!.decision!;
    assert.equal(decision.verdict, 'fail', decision.reasons.join('\n'));
    assert.ok(decision.violatedCriteria.some((c) => c.criterionId === 'C3'), decision.reasons.join('\n'));
    // coverage-1 / D-9: the decision records the contract revisions it judged
    assert.deepEqual(decision.testArtifactRevisions, { [artifactId]: artifact.revision });
    assert.equal(decision.systemModelId, `sm_${runId}`);
    assert.equal(decision.systemModelRevision, 1);
    assert.deepEqual(decision.oracleRevisions, { 'oracle.pricing': 1 });
    assert.ok(decision.satisfiedCriteria.some((c) => c.criterionId === 'C12'), 'C12: SystemModel recorded, no action without an experiment');
  });
});

describe('D-1 addendum: re-registration and the drift hint', () => {
  test('unchanged content returns the same revision; changed content is a new draft with a message; a run of changed content names the mismatch', async () => {
    const repo = await pricingRepo();
    const design: Result[] = [];
    const h = await createHarness({
      brains: {
        lead: (v) => {
          if (v.step === 0) return call('plan.propose_revision', { rationale: 'design', objectives: [{ objectiveId: 'o', description: 'd', priority: 'P2' }], workItems: [{ localId: 'd', title: 'design', objective: 'design', role: 'test_designer', dependsOn: [], objectiveIds: ['o'] }] });
          return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } });
        },
        test_designer: (v) => {
          if (v.lastResult) design.push(v.lastResult);
          const reg = { path: 'test/regression.test.js', sourceType: 'generated', runner: { framework: 'node_test', selector: 'test/regression.test.js' }, oracleRefs: [] };
          switch (v.step) {
            case 0:
              return call('fs.write', { path: 'test/regression.test.js', content: REGRESSION });
            case 1:
              return call('test_artifact.register', reg);
            case 2:
              return call('test_artifact.register', reg);
            case 3:
              return call('fs.write', { path: 'test/regression.test.js', content: `${REGRESSION}\ntest('applies a 50% discount (regression)', () => {\n  assert.equal(applyDiscount(100, 50), 50);\n});\n` });
            case 4:
              return call('test.run', { framework: 'node_test', selector: 'test/regression.test.js' });
            case 5:
              return call('test_artifact.register', reg);
            default:
              return call('complete_work', { summary: 'done', output: { summary: 'done', testArtifacts: [] } });
          }
        },
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'register', target: { repoPath: repo.path, commit: repo.head, baseCommit: repo.base } });
      for (let i = 0; i < 2; i++) for (const d of (await h.control.tick(run.runId)).dispatched) await runItem(h.control, d.workItemId, d.fencingToken);
      const [, first, same, rewritten, ran, changed] = design;
      assert.equal(rewritten!.isError, false, rewritten!.content);
      const r1 = parsed(first!.content);
      assert.deepEqual([r1['revision'], r1['approvalState']], [1, 'draft']);
      assert.deepEqual(parsed(same!.content), { ...r1, unchanged: true }, 'idempotent: the same revision, nothing new stored');
      assert.equal((await h.deps.specs.listTestArtifacts(run.runId)).length, 1, 'one artifact for one file');
      // the run of the changed file names the mismatch precisely
      assert.match(ran!.content, /\[test artifact mismatch: test\/regression\.test\.js now has content [0-9a-f]{12}…, but test artifact ta_\w+ \(revision 1, draft\) was registered with [0-9a-f]{12}…\. This run's evidence does not count for those artifacts — re-register the file \(test_artifact\.register\) and validate the new content again\.\]/);
      const r2 = parsed(changed!.content);
      assert.deepEqual([r2['artifactId'], r2['revision'], r2['approvalState'], r2['contentChanged']], [r1['artifactId'], 2, 'draft', true]);
      assert.match(changed!.content, /the content of test\/regression\.test\.js changed: artifact ta_\w+ revision 2 is a new draft — validate it again/);
    } finally {
      await h.dispose();
      await repo.cleanup();
    }
  });
});

describe('review of D-1: an oracle consistency review applies only to the content it was requested for', () => {
  test('content changed and re-validated while a review was pending: the stale approval is recorded but not applied; the review of the new content is', async () => {
    const repo = await pricingRepo();
    const design: Result[] = [];
    const reviews: Result[] = [];
    const V2 = `${REGRESSION}\ntest('applies a 50% discount (regression)', () => {\n  assert.equal(applyDiscount(100, 50), 50);\n});\n`;
    let h: Harness;
    const registration = { path: 'test/regression.test.js', sourceType: 'generated', runner: { framework: 'node_test', selector: 'test/regression.test.js' }, oracleRefs: [{ oracleId: 'oracle.pricing', revision: 1, assertionIds: ['discount-10'] }] };
    h = await createHarness({
      brains: {
        lead: lead('write a regression test for the 10% discount'),
        test_designer: async (v) => {
          if (v.lastResult) design.push(v.lastResult);
          const artifactId = design[1] ? (parsed(design[1].content)['artifactId'] as string) : '';
          const runs = await evidenceOf(h, v.runId, v.workItemId, 'test-result');
          switch (v.step) {
            case 0: return call('fs.write', { path: 'test/regression.test.js', content: REGRESSION });
            case 1: return call('test_artifact.register', registration);
            case 2: return call('test.run', { framework: 'node_test', selector: 'test/regression.test.js' });
            case 3: return call('test.run', { framework: 'node_test', selector: 'test/regression.test.js', revision: 'base' });
            case 4: return call('test_artifact.validate', { artifactId, knownBadEvidenceId: runs[0]!.evidenceId, knownGoodEvidenceId: runs[1]!.evidenceId });
            // the designer keeps improving the test after its first validation: new content, new validation, new review request
            case 5: return call('fs.write', { path: 'test/regression.test.js', content: V2 });
            case 6: return call('test_artifact.register', registration);
            case 7: return call('test.run', { framework: 'node_test', selector: 'test/regression.test.js' });
            case 8: return call('test.run', { framework: 'node_test', selector: 'test/regression.test.js', revision: 'base' });
            case 9: return call('test_artifact.validate', { artifactId, knownBadEvidenceId: runs[2]!.evidenceId, knownGoodEvidenceId: runs[3]!.evidenceId });
            default: return call('complete_work', { summary: 'validated', output: { summary: 'validated', testArtifacts: [{ artifactId, path: 'test/regression.test.js', covers: ['discount-10'] }] } });
          }
        },
        reviewer: reviewer(() => h, 'approve', reviews),
      },
    });
    try {
      await pricingOracle(h);
      const run = await h.control.startRun({ goal: 'stale review', target: { repoPath: repo.path, commit: repo.head, baseCommit: repo.base }, oracleIds: ['oracle.pricing'] });
      await drive(h, run.runId, 60);
      const [, registered, , , first, , changed, , , second] = design;
      const artifactId = parsed(registered!.content)['artifactId'] as string;
      assert.equal(parsed(first!.content)['approvalState'], 'validated', first!.content);
      assert.equal(parsed(changed!.content)['contentChanged'], true, changed!.content);
      assert.equal(parsed(second!.content)['approvalState'], 'validated', second!.content);
      // two review requests (one per validated content), two reviewer items, two review records
      const requested = (await h.deps.events.read(run.runId, { types: ['review.requested'] })).filter((e) => (e.payload as { artifactId?: string }).artifactId === artifactId);
      const revisions = requested.map((e) => (e.payload as { revision: number }).revision).sort((a, b) => a - b);
      assert.equal(revisions.length, 2);
      const artifactReviews = reviews.filter((r) => r.name === 'blackboard__post_review' && /"testArtifact"/.test(r.content));
      assert.equal(artifactReviews.length, 2, reviews.map((r) => r.content).join('\n'));
      const stale = artifactReviews.filter((r) => /changed while it was reviewed .* the review was recorded but NOT applied/.test(r.content));
      assert.equal(stale.length, 1, artifactReviews.map((r) => r.content).join('\n'));
      // exactly one review was applied — to the content it was requested for (the current one)
      const reviewed = await h.deps.events.read(run.runId, { types: ['test_artifact.reviewed'] });
      assert.equal(reviewed.length, 1);
      const artifact = (await h.deps.specs.getTestArtifact(artifactId))!;
      assert.equal(artifact.approvalState, 'approved');
      assert.equal(artifact.oracleReview!.artifactDigest, artifact.artifactDigest);
      const [r1, r2] = [(await h.deps.specs.getTestArtifact(artifactId, revisions[0]))!, (await h.deps.specs.getTestArtifact(artifactId, revisions[1]))!];
      assert.notEqual(r1.artifactDigest, r2.artifactDigest);
      assert.equal(r2.artifactDigest, artifact.artifactDigest, 'the approved content is the content the applied review was requested for');
    } finally {
      await h.dispose();
      await repo.cleanup();
    }
  });
});

// ======================================================================================== experiments (D-3, D-4, cov-13)

const ENVIRONMENTS = [
  { environmentId: 'svc', environmentClass: 'local', baseUrl: 'http://127.0.0.1:9', generation: 3, buildDigest: 'sha256:build-7', control: { kind: 'process' as const, target: 'svc-main' } },
  { environmentId: 'dedi', environmentClass: 'local', baseUrl: 'http://127.0.0.1:12', generation: 1, isolation: { dedicated: true, namespace: 'ns-hypertest', database: 'db_hypertest', account: 'acct-hypertest' } },
];

function readingLead(): Record<string, RoleBrain> {
  return { lead: (v) => (v.step === 0 ? call('blackboard.read', {}) : call('complete_work', { summary: 'done', output: { summary: 'lead done', planProposed: false, readyForGate: false, objectives: [] } })) };
}

async function leadHost(h: Harness, goal: string) {
  const run = await h.control.startRun({ goal, target: {} });
  const t = await h.control.tick(run.runId);
  const d = t.dispatched[0]!;
  assert.equal((await h.control.executeTurn(d.workItemId, d.fencingToken)).status, 'continue');
  const item = (await h.deps.blackboard.getWorkItem(d.workItemId))!;
  const cur = (await h.deps.runs.get(run.runId))!;
  const { agent, spec } = await h.control.worker.ensureAgent(item, cur, d.fencingToken);
  const host = await assembleTurn(await h.control.worker.buildHost(item, cur, agent, spec, d.fencingToken), agent.sessionId);
  let turn = 100;
  const dispatch = (name: string, args: JsonValue) => {
    const n = ++turn;
    return host.tools.dispatch({ id: `c${n}`, name: name.replaceAll('.', '__'), arguments: args }, { sessionId: agent.sessionId, turn: n, invocationId: `${agent.sessionId}:${n}:c${n}`, signal: new AbortController().signal });
  };
  return { run: cur, item, agent, spec, dispatch };
}

function intercept(h: Harness, fn: (req: ToolExecutionRequest) => Promise<ToolExecutionResult | undefined>): () => void {
  const runtime = h.deps.toolRuntime;
  const original = runtime.execute;
  runtime.execute = async (req) => (await fn(req)) ?? original.call(runtime, req);
  return () => {
    runtime.execute = original;
  };
}

function result(req: ToolExecutionRequest, over: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return { toolId: req.toolId, invocationId: req.invocationId, status: 'success', structured: {}, modelText: 'ok', artifactRefs: [], evidenceRefs: [], durationMs: 1, usage: { computeMs: 0, artifactBytes: 0 }, ...over };
}

async function executorFor(h: Harness, runId: string, expIds: string[], fp: string): Promise<WorkItem> {
  const c = await new WorkFactory(h.deps).create({
    runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title: `for ${expIds.join(',')}`, objective: `run ${fp}`, role: 'executor', objectiveIds: [], capabilityRequirements: [],
    inputRefs: expIds.map((id) => ({ kind: 'experiment' as const, id })), evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 5, maxTokens: 10_000, maxToolCalls: 50, maxWallClockMs: 6_000_000 },
    priority: 10, depth: 0, fingerprint: fp, resourceClaims: [], state: 'blocked',
  }, h.ctx(runId));
  const w = c.status === 'created' ? c.workItem : assert.fail('not created');
  await h.deps.budget.open(workScope(w.workItemId), {}, runScope(runId));
  return w;
}

async function dispatcherFor(h: Harness, run: TestRun, item: WorkItem, agentId: string, sessionId: string, capability: ActionCapability, extraTools: string[]) {
  const d = createToolDispatcher(h.deps, {
    runId: run.runId, workItemId: item.workItemId, agentId, role: item.role, sessionId,
    capability: { ...capability, tools: [...capability.tools, ...extraTools], allowedEffects: ['read', 'record', 'write_workspace', 'execute', 'external', 'destructive'] },
    allow: ['blackboard.read', ...extraTools], deny: [],
    workspace: await h.deps.workspaces.scratch({ runId: run.runId, workItemId: item.workItemId }),
    eventContext: { runId: run.runId, correlationId: item.workItemId, actorId: agentId, workItemId: item.workItemId, agentId },
    turnState: { snapshot: await turnSnapshot(h, run.runId) },
  });
  let turn = 500;
  return (name: string, args: JsonValue) => {
    const n = ++turn;
    return d.dispatch({ id: `x${n}`, name: name.replaceAll('.', '__'), arguments: args }, { sessionId, turn: n, invocationId: `${sessionId}:${n}:x${n}`, signal: new AbortController().signal });
  };
}

const expIdOf = (r: { execution?: ToolExecutionResult; message: { content: unknown } }): string => {
  const id = (r.execution?.structured as Record<string, unknown> | undefined)?.['experimentId'];
  assert.equal(typeof id, 'string', String(r.message.content));
  return String(id);
};

describe('D-3/D-4: a write, load or fault call runs only for an ACTIVE experiment, within its plan and budget', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  test('a manual stop, a met stop condition, a plan violation and a spent experiment budget each refuse the call before it runs', async () => {
    const l = await leadHost(h, 'experiment governance');
    const seen: ToolExecutionRequest[] = [];
    const ops = new Map<string, string>();
    const restore = intercept(h, async (req) => {
      if (req.workItemId === l.item.workItemId) return undefined;
      seen.push(req);
      if (req.toolId === 'load.start' || req.toolId === 'env.restart' || req.toolId === 'http.request') {
        // a side effect recorded on the ledger for its experiment (what the stop conditions and the gate read)
        const op = await h.deps.ledger.prepare({
          runId: req.runId, workItemId: req.workItemId, toolInvocationId: req.invocationId, operationType: req.toolId, adapterId: 'record.effect',
          target: { resourceKey: 'env/svc', kind: 'environment' }, desiredStateHash: `d-${req.invocationId}`, inputHash: `i-${req.invocationId}`,
          ...(req.experimentId !== undefined ? { experimentId: req.experimentId } : {}),
        }, req.eventContext);
        ops.set(req.invocationId, op.operationId);
      }
      return result(req);
    });
    try {
      // 1. a manual stop: further writes refused; ending load stays possible
      const manual = expIdOf(await l.dispatch('experiment.define', { hypothesis: 'orders accept writes', environmentId: 'svc', isolation: { mode: 'exclusive_write', resourceClaims: [] } }));
      const w1 = await executorFor(h, l.run.runId, [manual], 'fp-manual');
      const d1 = await dispatcherFor(h, l.run, w1, 'agent-1', 'sess-1', l.spec.capability, ['http.request', 'load.stop']);
      assert.equal((await d1('http.request', { method: 'POST', environmentId: 'svc', path: '/orders', body: '{}' })).message.isError, undefined);
      const stopped = await l.dispatch('experiment.stop', { experimentId: manual, reason: 'enough data' });
      assert.equal(stopped.message.isError, undefined, String(stopped.message.content));
      const refused = await d1('http.request', { method: 'POST', environmentId: 'svc', path: '/orders', body: '{}' });
      assert.match(String(refused.message.content), new RegExp(`^\\[denied\\] experiment_stopped: experiment ${manual} was stopped \\(manual: enough data\\); its write, load and fault calls are refused`));
      assert.equal((await d1('load.stop', { operationId: 'op_01J00000000000000000000000' })).message.isError, undefined, 'ending a load job is never blocked');
      // a second stop is idempotent (one experiment.stopped event, deterministic id)
      await l.dispatch('experiment.stop', { experimentId: manual, reason: 'again' });
      assert.equal((await h.deps.events.read(l.run.runId, { types: ['experiment.stopped'] })).filter((e) => e.aggregateId === manual).length, 1);
      await h.deps.admission.release(manual);

      // 2. a stop condition met (duration since the first action): recorded once, further calls refused
      const timed = expIdOf(await l.dispatch('experiment.define', { hypothesis: 'svc holds 5 rps for 10 s', environmentId: 'svc', workload: { kind: 'http_load', ratePerSecond: 5, durationMs: 10_000 } }));
      const w2 = await executorFor(h, l.run.runId, [timed], 'fp-timed');
      const d2 = await dispatcherFor(h, l.run, w2, 'agent-2', 'sess-2', l.spec.capability, ['load.start']);
      // 3. the plan: a rate above the declared workload is refused (and never runs)
      const over = await d2('load.start', { method: 'GET', environmentId: 'svc', path: '/', ratePerSecond: 50, durationMs: 10_000 });
      assert.match(String(over.message.content), new RegExp(`^\\[denied\\] experiment_plan_violation: load\\.start exceeds the workload of experiment ${timed}: ratePerSecond 50 > declared 5`));
      assert.equal((await d2('load.start', { method: 'GET', environmentId: 'svc', path: '/', ratePerSecond: 5, durationMs: 10_000 })).message.isError, undefined);
      h.clock.advance(10_001);
      const late = await d2('load.start', { method: 'GET', environmentId: 'svc', path: '/', ratePerSecond: 5, durationMs: 1_000 });
      assert.match(String(late.message.content), new RegExp(`^\\[denied\\] experiment_stopped: stop condition duration of experiment ${timed} is met \\(10000 ms elapsed since the first action\\)`));
      const stops = (await h.deps.events.read(l.run.runId, { types: ['experiment.stopped'] })).filter((e) => e.aggregateId === timed);
      assert.deepEqual(stops.map((e) => (e.payload as { condition: string }).condition), ['duration']);
      await h.deps.admission.release(timed);

      // 4. the experiment's own budget: maxToolCalls 1 ⇒ the second action is refused (typed, on L0)
      const budgeted = expIdOf(await l.dispatch('experiment.define', { hypothesis: 'svc survives one restart', environmentId: 'svc', faultPlan: [{ kind: 'restart', target: 'svc' }], budget: { maxToolCalls: 1 } }));
      assert.deepEqual((await h.deps.budget.usage(experimentScope(budgeted)))?.limits, { toolCalls: 1 });
      const w3 = await executorFor(h, l.run.runId, [budgeted], 'fp-budget');
      const d3 = await dispatcherFor(h, l.run, w3, 'agent-3', 'sess-3', l.spec.capability, ['env.restart', 'env.inject_fault']);
      // a fault outside the fault plan is refused first
      const unplanned = await d3('env.inject_fault', { environmentId: 'svc', kind: 'latency', params: { ms: 500 }, durationMs: 1000 });
      assert.match(String(unplanned.message.content), new RegExp(`^\\[denied\\] experiment_plan_violation: env\\.inject_fault latency on svc .* is not in the fault plan of experiment ${budgeted} \\(restart@svc\\)`));
      assert.equal((await d3('env.restart', { environmentId: 'svc', reason: 'planned' })).message.isError, undefined);
      const spent = await d3('env.restart', { environmentId: 'svc', reason: 'again' });
      assert.match(String(spent.message.content), new RegExp(`^\\[denied\\] experiment_budget_exhausted: the tool-call budget of experiment ${budgeted} is spent \\(1/1\\)`));
      const exhausted = (await h.deps.events.read(l.run.runId, { types: ['budget.exhausted'] })).filter((e) => (e.payload as { reason?: string }).reason === 'experiment_tool_calls');
      assert.equal(exhausted.length, 1);
      // every executed action is on L0 as an experiment.action (one per invocation): the gate compares them with the plan
      const actions = (await h.deps.events.read(l.run.runId, { types: ['experiment.action'] })).map((e) => [(e.payload as { experimentId: string }).experimentId, (e.payload as { toolId: string }).toolId]);
      assert.deepEqual(actions, [[manual, 'http.request'], [timed, 'load.start'], [budgeted, 'env.restart']]);
      assert.deepEqual(seen.map((r) => [r.toolId, r.experimentId]), [['http.request', manual], ['load.stop', manual], ['load.start', timed], ['env.restart', budgeted]]);
      await h.deps.admission.release(budgeted);
    } finally {
      restore();
    }
  });

  test('review: two concurrent stops of one experiment record ONE experiment.stopped and both callers see it', async () => {
    const l = await leadHost(h, 'stop race');
    const id = expIdOf(await l.dispatch('experiment.define', { hypothesis: 'race', environmentId: 'svc', isolation: { mode: 'exclusive_write', resourceClaims: [] } }));
    const spec = (await h.deps.specs.getExperiment(id))!;
    const ctx = h.ctx(l.run.runId);
    const [a, b] = await Promise.all([
      recordExperimentStop(h.deps, ctx, spec, { condition: 'manual', reason: 'first' }),
      recordExperimentStop(h.deps, ctx, spec, { condition: 'manual', reason: 'second' }),
    ]);
    assert.deepEqual(a, b);
    assert.equal((await h.deps.events.read(l.run.runId, { types: ['experiment.stopped'] })).filter((e) => e.aggregateId === id).length, 1);
    await h.deps.admission.release(id);
  });

  test('review (C12): load.stop by an item that runs for no experiment is attributed to the experiment of the job it ends', async () => {
    const l = await leadHost(h, 'stop attribution');
    const seen: ToolExecutionRequest[] = [];
    const restore = intercept(h, async (req) => {
      if (req.workItemId === l.item.workItemId) return undefined;
      seen.push(req);
      if (req.toolId === 'load.start') {
        const op = await h.deps.ledger.prepare({
          runId: req.runId, workItemId: req.workItemId, toolInvocationId: req.invocationId, operationType: req.toolId, adapterId: 'record.effect',
          target: { resourceKey: 'env/svc', kind: 'environment' }, desiredStateHash: `d-${req.invocationId}`, inputHash: `i-${req.invocationId}`,
          ...(req.experimentId !== undefined ? { experimentId: req.experimentId } : {}),
        }, req.eventContext);
        return result(req, { structured: { operationId: op.operationId } });
      }
      return result(req);
    });
    try {
      const exp = expIdOf(await l.dispatch('experiment.define', { hypothesis: 'svc holds 5 rps', environmentId: 'svc', workload: { kind: 'http_load', ratePerSecond: 5, durationMs: 60_000 } }));
      const starter = await executorFor(h, l.run.runId, [exp], 'fp-stop-starter');
      const ds = await dispatcherFor(h, l.run, starter, 'agent-s', 'sess-s', l.spec.capability, ['load.start']);
      const started = await ds('load.start', { method: 'GET', environmentId: 'svc', path: '/', ratePerSecond: 5, durationMs: 60_000 });
      const jobId = String((started.execution?.structured as Record<string, unknown>)['operationId']);
      // another item — no experiment of its own — ends the job (ending an effect is never blocked)
      const cleaner = await executorFor(h, l.run.runId, [], 'fp-stop-cleaner');
      const dc = await dispatcherFor(h, l.run, cleaner, 'agent-c', 'sess-c', l.spec.capability, ['load.stop']);
      assert.equal((await dc('load.stop', { operationId: jobId })).message.isError, undefined);
      assert.deepEqual(seen.map((r) => [r.toolId, r.experimentId]), [['load.start', exp], ['load.stop', exp]]);
      // a job id of no operation (or of another run) attributes nothing
      assert.equal((await dc('load.stop', { operationId: 'op_01J00000000000000000000000' })).message.isError, undefined);
      assert.equal(seen.at(-1)!.experimentId, undefined);
      await h.deps.admission.release(exp);
    } finally {
      restore();
    }
  });

  test('an item running for two experiments, neither of whose claims covers a call, cannot attribute it (experiment_ambiguous); a covered call is attributed', async () => {
    const l = await leadHost(h, 'ambiguous');
    const a = expIdOf(await l.dispatch('experiment.define', { hypothesis: 'a', environmentId: 'svc', isolation: { mode: 'exclusive_write', resourceClaims: [] } }));
    const b = expIdOf(await l.dispatch('experiment.define', { hypothesis: 'b', environmentId: 'dedi', isolation: { mode: 'exclusive_write', resourceClaims: [] } }));
    const w = await executorFor(h, l.run.runId, [a, b], 'fp-ambiguous');
    // a deployment-specific external tool that acts on no environment key (a message queue)
    if (!h.deps.registry.get('queue.publish')) {
      h.deps.registry.register({
        id: 'queue.publish', title: 'Publish', description: 'Publish a message to a queue.', inputSchema: { type: 'object' }, effect: 'external', riskClass: 'medium',
        resources: () => ['queue/orders'], timeoutMs: 5000, execute: async () => ({ status: 'success', text: 'published' }),
      } as never);
    }
    const seen: ToolExecutionRequest[] = [];
    const restore = intercept(h, async (req) => (req.workItemId === w.workItemId ? (seen.push(req), result(req)) : undefined));
    try {
      const d = await dispatcherFor(h, l.run, w, 'agent-amb', 'sess-amb', l.spec.capability, ['queue.publish', 'http.request']);
      // neither experiment's claims cover the queue: the action belongs to no single experiment
      const r = await d('queue.publish', { message: 'x' });
      assert.match(String(r.message.content), /^\[denied\] experiment_ambiguous: work item wi_\w+ runs for experiments exp_\w+, exp_\w+ and none of them cover queue\.publish unambiguously: the action could not be attributed to exactly one experiment/);
      // a call one experiment's claims cover is attributed to it
      assert.equal((await d('http.request', { method: 'POST', environmentId: 'dedi', path: '/x', body: '{}' })).message.isError, undefined);
      assert.deepEqual(seen.map((x) => [x.toolId, x.experimentId]), [['http.request', b]]);
    } finally {
      restore();
      await h.deps.admission.release(a);
      await h.deps.admission.release(b);
    }
  });

  test('coverage-13: dedicated_environment needs an environment REGISTERED as dedicated; its namespace, database and account are recorded', async () => {
    const l = await leadHost(h, 'dedicated');
    const shared = await l.dispatch('experiment.define', { hypothesis: 'x', environmentId: 'svc', isolation: { mode: 'dedicated_environment', resourceClaims: [] } });
    assert.equal(shared.message.isError, true);
    assert.match(String(shared.message.content), /isolation_insufficient: experiment not created: isolation mode dedicated_environment needs an environment registered as dedicated \(environments\[\]\.isolation\.dedicated: true\); environment svc is not registered as dedicated — use exclusive_write with resource claims instead/);
    const dedicated = expIdOf(await l.dispatch('experiment.define', { hypothesis: 'migrations are idempotent', environmentId: 'dedi', isolation: { mode: 'dedicated_environment', resourceClaims: [] } }));
    const spec = (await h.deps.specs.getExperiment(dedicated))!;
    assert.deepEqual(spec.isolation.plan, {
      dedicatedEnvironment: true, dedicatedNamespace: 'ns-hypertest', dedicatedDatabase: 'db_hypertest', dedicatedAccount: 'acct-hypertest',
      contaminationChecks: [{ kind: 'foreign_operations', resources: ['env/dedi'] }, { kind: 'environment_generation' }, { kind: 'exclusive_claims' }],
    });
    assert.deepEqual(spec.isolation.resourceClaims, [{ resourceKey: 'env/dedi', mode: 'write_exclusive' }], 'a dedicated environment is held exclusively as a whole');
    await h.deps.admission.release(dedicated);
  });
});

// ======================================================================================== replanning (D-10, coverage-17)

describe('D-10: an oracle approved mid-run re-pins the run; its decisions on the old revision need reassessment', () => {
  test('the first (non-final) decision on revision 1 is marked needs_reassessment; the run moves to revision 2 and replans', async () => {
    const readyLead: RoleBrain = (v) => {
      if (v.step === 0) return call('plan.propose_revision', { rationale: 'nothing to execute', objectives: [{ objectiveId: 'o', description: 'objective', priority: 'P3', status: 'dropped' }], workItems: [], readyForGate: true });
      return call('complete_work', { summary: 'ready', output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'o', status: 'dropped', evidenceRefs: [] }] } });
    };
    const h = await createHarness({ brains: { lead: readyLead } });
    try {
      await pricingOracle(h);
      const run = await h.control.startRun({ goal: 'oracle change', target: {}, oracleIds: ['oracle.pricing'] });
      // drive to the first gate decision (inconclusive, not final: the lead is sent back once)
      let first: Awaited<ReturnType<typeof h.control.tick>>['decision'];
      for (let i = 0; i < 20 && !first; i++) {
        const t = await h.control.tick(run.runId);
        for (const d of t.dispatched) await runItem(h.control, d.workItemId, d.fencingToken);
        first = t.decision;
      }
      assert.ok(first, 'a first decision');
      assert.deepEqual(first.oracleRevisions, { 'oracle.pricing': 1 });
      // a human approves revision 2 of the oracle while the run is in flight
      const current = (await h.deps.specs.getOracle('oracle.pricing'))!;
      const { revision: _r, createdAt: _c, supersedes: _s, ...rest } = current as typeof current & { createdAt?: string; supersedes?: number };
      await h.deps.specs.saveOracle({ ...rest, assertions: current.assertions.map((a) => ({ ...a, description: `${a.description} (clarified)` })) } as never, { ...h.ctx('oracle-setup'), actorId: 'human:qa-lead' });
      const out = await drive(h, run.runId, 30);
      assert.deepEqual((await h.deps.runs.get(run.runId))!.oracleRevisions, { 'oracle.pricing': 2 });
      const reassessment = await h.deps.decisions.reassessment(first.decisionId);
      assert.equal(reassessment?.needsReassessment, true);
      assert.match(reassessment!.reason!, /re-pinned from oracle oracle\.pricing revision 1 to 2/);
      // no history rewrite: the first decision still names revision 1; the final one names revision 2
      assert.deepEqual((await h.deps.decisions.get(first.decisionId))!.oracleRevisions, { 'oracle.pricing': 1 });
      assert.deepEqual(out.final!.decision!.oracleRevisions, { 'oracle.pricing': 2 });
      assert.ok((await items(h, run.runId)).some((w) => w.kind === 'replan' && /oracle revision changed/.test(w.title)));
    } finally {
      await h.dispose();
    }
  });
});

describe('coverage-17: a new unresolved P0/P1 finding replans the lead, once per finding event', () => {
  test('the finding event is consumed once (inbox): re-reads and further ticks schedule no second replan', async () => {
    const repo = await pricingRepo();
    const lead: RoleBrain = (v) => {
      if (v.kind === 'initial_plan' && v.step === 0) {
        return call('plan.propose_revision', {
          rationale: 'explore', objectives: [{ objectiveId: 'o', description: 'objective', priority: 'P1' }],
          workItems: [{ localId: 'e', title: 'probe', objective: 'probe the service', role: 'executor', dependsOn: [], objectiveIds: ['o'] }],
        });
      }
      return call('complete_work', { summary: 'lead turn', output: { summary: 'lead turn', planProposed: v.kind === 'initial_plan', readyForGate: false, objectives: [] } });
    };
    const findings: Result[] = [];
    const executor: RoleBrain = async (v) => {
      if (v.lastResult) findings.push(v.lastResult);
      if (v.step === 0) return call('test.run', { framework: 'node_test' });
      const ids = evidenceIds(v.toolResults[0]?.content ?? findings[0]!.content);
      if (v.step === 1) {
        return call('blackboard.post_finding', {
          title: '10% discount is applied twice', description: 'applyDiscount(1000, 10) returns 800', severity: 'P1', category: 'product_defect', component: 'pricing',
          expected: '900', actual: '800', reproduction: 'node --test test/pricing.test.js', evidenceRefs: evidenceIds(findings[0]!.content),
        });
      }
      return call('complete_work', { summary: 'suite failed', evidenceRefs: ids, output: { summary: 'suite failed', executed: [], findings: [] } });
    };
    const h = await createHarness({ brains: { lead, executor, rca: () => call('fail_work', { reason: 'test', message: 'not part of this test' }), test_designer: () => call('fail_work', { reason: 'test', message: 'not part of this test' }) } });
    try {
      const run = await h.control.startRun({ goal: 'critical findings', target: { repoPath: repo.path, commit: repo.head } });
      for (let i = 0; i < 4; i++) {
        const t = await h.control.tick(run.runId);
        for (const d of t.dispatched) await runItem(h.control, d.workItemId, d.fencingToken);
      }
      assert.equal(findings[1]!.isError, false, findings[1]!.content);
      const replans = (await items(h, run.runId)).filter((w) => w.kind === 'replan' && w.origin.kind === 'system' && w.origin.reason === 'replan:critical_finding');
      assert.equal(replans.length, 1, 'one replan for the finding');
      assert.match(replans[0]!.objective, /### New unresolved P0\/P1 findings \(the reason for this replan\)\n- rec_\w+ \[P1 product_defect\] 10% discount is applied twice/);
      const triggered = await h.deps.events.read(run.runId, { types: ['replan.triggered'] });
      assert.equal(triggered.length, 1);
      const findingEvent = (await h.deps.events.read(run.runId, { types: ['finding.created'] }))[0]!;
      assert.deepEqual((triggered[0]!.payload as { triggers: string[] }).triggers, [findingEvent.eventId]);
      // more ticks (the event is re-read from L0 each time): consumed once, never a second replan
      for (let i = 0; i < 3; i++) await h.control.tick(run.runId);
      assert.equal((await items(h, run.runId)).filter((w) => w.origin.kind === 'system' && w.origin.reason === 'replan:critical_finding').length, 1);
    } finally {
      await h.dispose();
      await repo.cleanup();
    }
  });
});
