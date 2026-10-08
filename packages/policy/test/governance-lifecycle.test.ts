/**
 * Gate governance (audit unit gate-governance): sensitivity evidence bound to its artifact and the full TestArtifact
 * lifecycle re-derived by the gate (D-0/D-1), symmetric C3 eligibility (addendum), evaluated report claims (area-C-0),
 * experiment validity C10 (D-3/D-4/D-5, coverage-13), environment validity C11 (D-11), domain contracts C12
 * (coverage-1), oracle authorities / judge policy (D-7) and oracle invalidation (D-10). Pure inputs; every audited defect is
 * reproduced as the input that used to pass and is now refused.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { JsonValue } from '@hypertest/core';
import {
  InMemoryEventSink, evaluateClaim,
  type ActorRef, type BlackboardRecord, type EvidenceRecord, type ExperimentSpec, type Finding, type GateSpec, type OracleAssertion, type OracleSpec, type Review, type SystemModel,
  type TestArtifact, type TestRun, type WorkItem,
} from '@hypertest/domain';
import { eventCtx, testDeps } from '@hypertest/testkit';
import {
  DEFAULT_GATE_SPEC, QualityGate, artifactEligibility, createOracleGovernance, evaluateStopConditions, experimentValidity, oracleAuthorityProblems, planViolation, sensitivityBinding,
  type GateInput, type GateOperation,
} from '../src/index.ts';
import { MemoryDecisions, MemoryOracleStore } from './helpers.ts';

const RUN = 'run_gg';
const NOW = '2026-02-01T00:00:00.000Z';
const gate = new QualityGate();

function ev(evidenceId: string, seq: number, evidenceType: string, structured: JsonValue, extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    evidenceId, seq, runId: RUN, evidenceType, artifact: { uri: `cas://sha256/${evidenceId}`, sha256: evidenceId, size: 1, mimeType: 'application/json' }, summary: evidenceId, structured,
    producer: { workerId: 'w1', runtimeManifestId: 'rm_1' }, provenance: {}, parentEvidenceIds: [], classification: 'internal', retentionPolicy: 'run', capturedAt: '2026-01-01T00:00:10.000Z',
    metadataHash: 'm', recordHash: `h_${evidenceId}`, ...extra,
  };
}

function rec<T>(recordType: BlackboardRecord['recordType'], recordId: string, payload: T, extra: Partial<BlackboardRecord<T>> = {}): BlackboardRecord<T> {
  return { recordId, lineageId: recordId, recordType, runId: RUN, revision: 1, version: 1, createdBy: 'agent_x', payload, evidenceRefs: [], createdAt: '2026-01-01T00:00:00.000Z', ...extra };
}

const DISCOUNT: OracleAssertion = { assertionId: 'discount-10', description: '10% of 1000 is 900', kind: 'deterministic_invariant', severity: 'P1', check: { type: 'test_outcome', testSelector: '*applies a 10% discount*', expected: 'pass' } };
const ZERO: OracleAssertion = { assertionId: 'zero', description: '0% keeps the price', kind: 'requirement', severity: 'P1', check: { type: 'test_outcome', testSelector: '*zero discount*', expected: 'pass' } };

function oracle(extra: Partial<OracleSpec> = {}): OracleSpec {
  return {
    oracleId: 'oracle.pricing', revision: 1, scope: { components: ['pricing'], description: 'REQ-7' }, assertions: [DISCOUNT, ZERO],
    authorities: [{ sourceRef: 'REQ-7', authority: 'approved_requirement' }],
    judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: false },
    changePolicy: { agentMayPropose: true, selfApprove: false, invalidatesPriorDecisions: true, approvers: ['human'] },
    status: 'approved', approvedBy: [{ kind: 'human', id: 'qa-lead' }], createdAt: '2026-01-01T00:00:00.000Z', ...extra,
  };
}

const run: TestRun = {
  runId: RUN, goal: 'is the discount change releasable', target: { environmentId: undefined as never, baseCommit: 'base', commit: 'head' }, status: 'gating',
  budget: { maxWallClockMs: 1, maxAgentConcurrency: 1, maxModelTokens: 1, maxToolCalls: 1, maxWorkItems: 1, maxAgentDepth: 1, maxPlanRevisions: 1 },
  runtimeManifestId: 'rm_1', policyRevision: 'builtin@1', currentPlanRevision: 1, systemModelRevision: 1, oracleRevisions: { 'oracle.pricing': 1 }, experimentIds: [], labels: {},
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
delete (run.target as Record<string, unknown>)['environmentId'];

const systemModel: SystemModel = {
  systemModelId: `sm_${RUN}`, runId: RUN, revision: 1, subject: { repoRefs: ['/repo'], commitDigests: ['head'], buildDigests: [] },
  components: [{ componentId: 'pricing', name: 'pricing', kind: 'module', paths: ['src/pricing.js'], riskTags: [] }], interfaces: [], dependencies: [], stateMachines: [], invariants: [],
  dataAssets: [], securityBoundaries: [], changedComponents: ['pricing'], riskTags: [], sources: [], createdBy: 'agent_lead', createdAt: '2026-01-01T00:00:00.000Z',
};

const workItem = (id: string, p: Partial<WorkItem> = {}): WorkItem => ({
  workItemId: id, runId: RUN, kind: 'task', origin: { kind: 'system', reason: 't' }, title: id, objective: id, role: 'executor', objectiveIds: [], capabilityRequirements: [], inputRefs: [],
  evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 1, maxTokens: 1, maxToolCalls: 1, maxWallClockMs: 1 }, priority: 1, state: 'completed', depth: 0, fingerprint: id,
  resourceClaims: [], attempts: 1, waitingOn: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...p,
});

/** A gate with independent review and coverage out of the way (each test perturbs the governance under test). */
const GATE: GateSpec = { ...DEFAULT_GATE_SPEC, requireIndependentReview: false };

function input(extra: Partial<GateInput> = {}): GateInput {
  const evidence = extra.evidence ?? [];
  return {
    run, gate: GATE, objectives: [], oracles: [oracle()], experiments: [], findings: [], risks: [], reviews: [], coverageGaps: [], testArtifacts: [], evidence,
    evidenceRoot: { rootHash: 'root', count: evidence.length }, workItems: [], claims: [], exceptions: [], runtimeManifestId: 'rm_1', policyRevision: 'builtin@1', decisionId: 'qd_1', now: NOW,
    systemModel, operations: [], environments: [], ...extra,
  };
}

// ------------------------------------------------------------------------------------------------- execution binding

const TRIVIAL_SHA = 't'.repeat(64);
const ZERO_SHA = 'z'.repeat(64);
const executed = (files: Array<{ path: string; sha256: string; cases?: number; staticOk?: boolean }>, extra: Record<string, unknown> = {}) => ({
  attribution: 'complete', unattributedCases: 0, ...extra,
  files: files.map((f) => ({ path: f.path, sha256: f.sha256, cases: f.cases ?? 1, ...(f.staticOk !== undefined ? { staticCheck: { checker: 'node --check', ok: f.staticOk } } : {}) })),
});
const workspaceRev = { kind: 'workspace', baseCommit: 'base', treeDigest: 'tree_candidate' };
/** What mutation.run records about the file it mutated: the candidate's product code, unchanged in the workspace. */
const productMutation = { file: 'src/pricing.js', mutatedFile: { path: 'src/pricing.js', isTestFile: false, changedSinceBase: false } };
const baseRev = { kind: 'base', baseCommit: 'base', treeDigest: 'tree_base' };

/** The audit's insensitive generated test (`assert.ok(applyDiscount(1000,10) > 0)`), named after the P1 assertion. */
function trivialArtifact(extra: Partial<TestArtifact> = {}): TestArtifact {
  return {
    artifactId: 'ta_trivial', runId: RUN, revision: 2, path: 'test/trivial.test.js', artifactDigest: TRIVIAL_SHA, sourceType: 'generated',
    generatedBy: { agentId: 'agent_designer', role: 'test_designer' }, oracleRefs: [{ oracleId: 'oracle.pricing', revision: 1, assertionIds: ['discount-10'] }],
    runner: { framework: 'node_test', selector: 'test/trivial.test.js' }, validations: {}, approvalState: 'draft', createdAt: '2026-01-01T00:00:00.000Z', ...extra,
  };
}

/** The mutation run of ANOTHER test file (test/zero.test.js) that killed mutants — foreign evidence for the trivial test. */
const foreignMutation = ev('ev_mut_zero', 3, 'mutation-result', {
  ...productMutation, selector: 'test/zero.test.js', killed: 6, survived: 4, score: 0.6, baseline: { passed: true, total: 1 },
  executedTests: executed([{ path: 'test/zero.test.js', sha256: ZERO_SHA }]), codeRevision: workspaceRev,
} as unknown as JsonValue);

/** The executor's run of the trivial test on the BUGGY candidate: it passes (800 > 0). */
const trivialPassOnBuggy = ev('ev_trivial_run', 4, 'test-result', {
  framework: 'node_test', passed: true, cases: [{ id: 'test/trivial.test.js::applies a 10% discount', name: 'applies a 10% discount', file: 'test/trivial.test.js', status: 'passed' }],
  workspaceDelta: { status: 'computed', baseCommit: 'base', readOnly: true, treeDigest: 'tree_candidate', changedFiles: 2, testFiles: [{ path: 'test/trivial.test.js', change: 'added', sha256: TRIVIAL_SHA }] },
  executedTests: executed([{ path: 'test/trivial.test.js', sha256: TRIVIAL_SHA, staticOk: true }]), codeRevision: workspaceRev, testArtifactId: 'ta_trivial',
} as unknown as JsonValue, { workItemId: 'wi_exec' });

describe('D-0 (BLOCKER) sensitivity evidence is bound to the artifact it validates', () => {
  test('the audit scenario: a mutation result of ANOTHER test file never validates the insensitive test, and the buggy candidate is never released', () => {
    const a = trivialArtifact();
    const b = sensitivityBinding(foreignMutation, a, 'mutation');
    assert.equal(b.ok, false);
    assert.match((b as { problem: string }).problem, /did not execute test\/trivial\.test\.js .*executed test\/zero\.test\.js — foreign evidence never proves this artifact/);
    // the state the old code produced (validated, mutationScore 0.6 from the foreign run) is NOT trusted by the gate
    const trusted = trivialArtifact({ approvalState: 'validated', validations: { mutationScore: 0.6, mutation: { status: 'passed', evidenceRefs: ['ev_mut_zero'], killed: 6 } } });
    const d = gate.evaluate(input({ testArtifacts: [trusted], evidence: [foreignMutation, trivialPassOnBuggy] }));
    assert.notEqual(d.verdict, 'pass');
    assert.equal(d.verdict, 'inconclusive');
    // the P1 assertion rests only on the insensitive test: unproven (C3), and no eligible test-result exists (C4)
    for (const c of ['C3', 'C4']) assert.ok(d.unknownCriteria.some((x) => x.criterionId === c), `${c} unknown: ${d.reasons.join('\n')}`);
    // without the (eligible, candidate-code) mutation record, nothing eligible is left at all (C1)
    const alone = gate.evaluate(input({ testArtifacts: [trusted], evidence: [trivialPassOnBuggy] }));
    assert.ok(alone.unknownCriteria.some((x) => x.criterionId === 'C1'), alone.reasons.join('\n'));
    assert.ok(d.reasons.some((r) => r.includes('ev_trivial_run') && r.includes('not eligible')), d.reasons.join('\n'));
    // even a forged "approved" state with the foreign mutation evidence does not count
    const forged = { ...trusted, approvalState: 'approved' as const, validations: { ...trusted.validations, static: { status: 'passed' as const, evidenceRefs: ['ev_trivial_run'] }, knownGood: { status: 'passed' as const, evidenceRefs: ['ev_trivial_run'] } } };
    assert.notEqual(gate.evaluate(input({ testArtifacts: [forged], evidence: [foreignMutation, trivialPassOnBuggy] })).verdict, 'pass');
  });

  test('binding problems are exact: no execution record, no code revision, other content, mixed mutation run, no case of the file', () => {
    const a = trivialArtifact();
    const bare = ev('ev_bare', 1, 'test-result', { cases: [{ id: 'x', file: 'test/trivial.test.js', status: 'failed' }] });
    assert.match((sensitivityBinding(bare, a, 'known_bad') as { problem: string }).problem, /records no executed test files/);
    const noRev = ev('ev_norev', 1, 'test-result', { executedTests: executed([{ path: a.path, sha256: TRIVIAL_SHA }]) } as unknown as JsonValue);
    assert.match((sensitivityBinding(noRev, a, 'known_bad') as { problem: string }).problem, /records no code revision/);
    const other = ev('ev_other', 1, 'test-result', { executedTests: executed([{ path: a.path, sha256: 'x'.repeat(64) }]), codeRevision: workspaceRev } as unknown as JsonValue);
    assert.match((sensitivityBinding(other, a, 'known_bad') as { problem: string }).problem, /not the registered artifact content .*re-register it and validate the new content/);
    const mixed = ev('ev_mixed', 1, 'mutation-result', { ...productMutation, killed: 2, baseline: { passed: true }, executedTests: executed([{ path: a.path, sha256: TRIVIAL_SHA }, { path: 'test/zero.test.js', sha256: ZERO_SHA }]), codeRevision: workspaceRev } as unknown as JsonValue);
    assert.match((sensitivityBinding(mixed, a, 'mutation') as { problem: string }).problem, /executed more than test\/trivial\.test\.js \(also test\/zero\.test\.js\).*testSelector naming only/);
    const partial = ev('ev_partial', 1, 'mutation-result', { ...productMutation, killed: 2, baseline: { passed: true }, executedTests: executed([{ path: a.path, sha256: TRIVIAL_SHA }], { attribution: 'partial', unattributedCases: 3 }), codeRevision: workspaceRev } as unknown as JsonValue);
    assert.match((sensitivityBinding(partial, a, 'mutation') as { problem: string }).problem, /3 case\(s\) not attributable/);
    const wrongType = ev('ev_wrong', 1, 'metric', {});
    assert.match((sensitivityBinding(wrongType, a, 'known_good') as { problem: string }).problem, /must be a test-result \(got metric\)/);
    const own = ev('ev_own', 1, 'mutation-result', { ...productMutation, killed: 2, baseline: { passed: true }, executedTests: executed([{ path: a.path, sha256: TRIVIAL_SHA }]), codeRevision: workspaceRev } as unknown as JsonValue);
    assert.deepEqual(sensitivityBinding(own, a, 'mutation'), { ok: true, codeDigest: 'tree_candidate', revision: 'workspace', file: { path: a.path, sha256: TRIVIAL_SHA, cases: 1 } });
  });
});

// ------------------------------------------------------------------------------------------------- lifecycle (D-1)

/** Every lifecycle record of an artifact: static + known-good on base, known-bad (bound failure) or mutation, review. */
function lifecycle(a: TestArtifact, opts: { sensitivity?: 'mutation' | 'known_bad'; knownGood?: 'base' | 'unavailable'; reviewer?: { by: string; role: string } } = {}) {
  const mine = (staticOk?: boolean) => executed([{ path: a.path, sha256: a.artifactDigest, ...(staticOk !== undefined ? { staticOk } : {}) }]);
  const evidence: EvidenceRecord[] = [];
  const validations: TestArtifact['validations'] = {};
  if (opts.knownGood === 'unavailable') {
    const bad = ev(`ev_kb_${a.artifactId}`, 20, 'test-result', { cases: [{ id: 'c', name: 'c', file: a.path, status: 'failed' }], executedTests: mine(true), codeRevision: workspaceRev } as unknown as JsonValue);
    evidence.push(bad);
    validations.static = { status: 'passed', evidenceRefs: [bad.evidenceId] };
    validations.knownGoodUnavailable = { reason: 'a new behaviour the base revision does not have; no fix exists yet', recordedBy: 'agent_designer', at: NOW };
    validations.knownBad = { status: 'passed', evidenceRefs: [bad.evidenceId], codeDigest: 'tree_candidate' };
  } else {
    const good = ev(`ev_kg_${a.artifactId}`, 20, 'test-result', { cases: [{ id: 'c', name: 'c', file: a.path, status: 'passed' }], executedTests: mine(true), codeRevision: baseRev } as unknown as JsonValue);
    evidence.push(good);
    validations.static = { status: 'passed', evidenceRefs: [good.evidenceId] };
    validations.knownGood = { status: 'passed', evidenceRefs: [good.evidenceId], codeDigest: 'tree_base' };
    if (opts.sensitivity === 'known_bad') {
      const bad = ev(`ev_kb_${a.artifactId}`, 21, 'test-result', { cases: [{ id: 'c', name: 'c', file: a.path, status: 'failed' }], executedTests: mine(), codeRevision: workspaceRev } as unknown as JsonValue);
      evidence.push(bad);
      validations.knownBad = { status: 'passed', evidenceRefs: [bad.evidenceId], codeDigest: 'tree_candidate' };
    } else {
      const mut = ev(`ev_mut_${a.artifactId}`, 21, 'mutation-result', { ...productMutation, killed: 4, baseline: { passed: true, total: 1 }, executedTests: mine(), codeRevision: workspaceRev } as unknown as JsonValue);
      evidence.push(mut);
      validations.mutation = { status: 'passed', evidenceRefs: [mut.evidenceId], killed: 4 };
    }
  }
  const reviewer = opts.reviewer ?? { by: 'agent_reviewer', role: 'reviewer' };
  const review = rec<Review>('review', `rec_rev_${a.artifactId}`, { subjectRef: { kind: 'test_artifact', id: a.artifactId }, verdict: 'approve', rationale: 'it checks discount-10 exactly', checkedEvidenceRefs: evidence.map((e) => e.evidenceId), reviewerRole: reviewer.role }, { createdBy: reviewer.by });
  const artifact: TestArtifact = {
    ...a, validations, approvalState: 'approved',
    oracleReview: { reviewRecordId: review.recordId, reviewerAgentId: reviewer.by, reviewerRole: reviewer.role, verdict: 'approve', artifactDigest: a.artifactDigest, oracleRevisions: { 'oracle.pricing': 1 }, at: NOW },
  };
  return { artifact, evidence, review };
}

describe('D-1 the full TestArtifact lifecycle is re-derived (generated → static → known-good → known-bad/mutation → oracle review → eligible)', () => {
  const ctxOf = (l: ReturnType<typeof lifecycle>, oracles = [oracle()]) => ({ evidence: new Map(l.evidence.map((e) => [e.evidenceId, e])), reviews: [l.review], oraclesInForce: oracles, baseCommit: 'base' });

  test('positive path: bound mutation evidence (the artifact\'s own file and content) + base known-good + independent review ⇒ eligible and critical', () => {
    const l = lifecycle(trivialArtifact());
    const j = artifactEligibility(l.artifact, ctxOf(l));
    assert.deepEqual(j.stages, { static: 'passed', knownGood: 'passed', sensitivity: 'passed', oracleReview: 'passed' });
    assert.equal(j.eligible, true);
    assert.equal(j.criticalSupport, true);
    const kb = lifecycle(trivialArtifact(), { sensitivity: 'known_bad' });
    assert.equal(artifactEligibility(kb.artifact, ctxOf(kb)).eligible, true);
  });

  test('each missing or failed stage keeps the artifact ineligible, with the stage named', () => {
    const l = lifecycle(trivialArtifact());
    const cases: Array<[string, TestArtifact, RegExp]> = [
      ['no static check', { ...l.artifact, validations: { ...l.artifact.validations, static: undefined as never } }, /static validation missing/],
      ['failed static check', { ...l.artifact, validations: { ...l.artifact.validations, static: { status: 'failed', evidenceRefs: [], detail: 'SyntaxError' } } }, /static validation failed \(SyntaxError\)/],
      ['no known-good (and no reason)', { ...l.artifact, validations: { ...l.artifact.validations, knownGood: undefined as never } }, /known-good missing/],
      ['no sensitivity', { ...l.artifact, validations: { static: l.artifact.validations.static!, knownGood: l.artifact.validations.knownGood! } }, /sensitivity not demonstrated/],
      ['validated but never reviewed', { ...l.artifact, approvalState: 'validated', oracleReview: undefined as never }, /approval state validated/],
      ['review of other content', { ...l.artifact, oracleReview: { ...l.artifact.oracleReview!, artifactDigest: 'other' } }, /judged other content/],
      ['oracleRefs empty', { ...l.artifact, oracleRefs: [] }, /names no oracle assertion/],
      ['oracleRefs name an assertion that does not exist', { ...l.artifact, oracleRefs: [{ oracleId: 'oracle.pricing', revision: 1, assertionIds: ['nope'] }] }, /assertion nope does not exist/],
    ];
    for (const [what, a, re] of cases) {
      const j = artifactEligibility(a, ctxOf(l));
      assert.equal(j.eligible, false, what);
      assert.ok(j.reasons.some((r) => re.test(r)), `${what}: ${j.reasons.join('; ')}`);
    }
    // the reviewer must be another agent of another role than the creator
    const self = lifecycle(trivialArtifact(), { reviewer: { by: 'agent_designer', role: 'reviewer' } });
    assert.ok(artifactEligibility(self.artifact, ctxOf(self)).reasons.some((r) => r.includes("posted by the artifact's creator")));
    const sameRole = lifecycle(trivialArtifact(), { reviewer: { by: 'agent_other', role: 'test_designer' } });
    assert.ok(artifactEligibility(sameRole.artifact, ctxOf(sameRole)).reasons.some((r) => r.includes("creator's role test_designer")));
    // a known-good run on a base revision other than the run's base commit is not the known-good run
    const otherBase = artifactEligibility(l.artifact, { ...ctxOf(l), baseCommit: 'another-base' });
    assert.ok(otherBase.reasons.some((r) => r.includes("not the run's base commit another-base")), otherBase.reasons.join('; '));
    assert.equal(otherBase.eligible, false);
    // the oracle revision the artifact encodes must still be in force
    assert.equal(artifactEligibility(l.artifact, ctxOf(l, [oracle({ revision: 2 })])).eligible, false);
    // known-good and known-bad on the same code is no sensitivity proof
    const kb = lifecycle(trivialArtifact(), { sensitivity: 'known_bad' });
    const sameCode = kb.evidence.map((e) => (e.evidenceId.startsWith('ev_kb') ? { ...e, structured: { ...(e.structured as object), codeRevision: { ...baseRev } } as JsonValue } : e));
    assert.equal(artifactEligibility(kb.artifact, { ...ctxOf(kb), evidence: new Map(sameCode.map((e) => [e.evidenceId, e])) }).eligible, false);
  });

  test('a recorded "known-good unavailable" reason keeps the artifact eligible but never lets it support or violate a P0/P1 assertion', () => {
    const l = lifecycle(trivialArtifact(), { knownGood: 'unavailable' });
    const j = artifactEligibility(l.artifact, ctxOf(l));
    assert.equal(j.eligible, true);
    assert.equal(j.criticalSupport, false);
    assert.equal(j.stages.knownGood, 'waived');
    // its passing evidence does not satisfy the P1 assertion: C3 stays unknown
    const d = gate.evaluate(input({ testArtifacts: [l.artifact], reviews: [l.review], evidence: [...l.evidence, trivialPassOnBuggy] }));
    assert.equal(d.unknownCriteria.find((c) => c.criterionId === 'C3')?.status, 'unknown', d.reasons.join('\n'));
  });
});

describe('review of the D-0/D-1 fix: sensitivity must be shown on PRODUCT code, and only a base-revision known-good decides P0/P1', () => {
  const ctxOf = (l: ReturnType<typeof lifecycle>) => ({ evidence: new Map(l.evidence.map((e) => [e.evidenceId, e])), reviews: [l.review], oraclesInForce: [oracle()], baseCommit: 'base' });
  /** The lifecycle with its mutation record replaced by `mutation` (same id, so the artifact cites it). */
  function withMutation(l: ReturnType<typeof lifecycle>, mutation: Record<string, unknown>): ReturnType<typeof lifecycle> {
    return { ...l, evidence: l.evidence.map((e) => (e.evidenceType === 'mutation-result' ? { ...e, structured: { ...(e.structured as Record<string, unknown>), ...mutation } as unknown as JsonValue } : e)) };
  }

  test('a mutation run of the artifact ITSELF (its own tautological assertion killed) is no sensitivity proof — the bypass that passed the buggy candidate', () => {
    const l = lifecycle(trivialArtifact());
    const self = withMutation(l, { file: 'test/trivial.test.js', mutatedFile: { path: 'test/trivial.test.js', isTestFile: false, changedSinceBase: true } });
    const mut = self.evidence.find((e) => e.evidenceType === 'mutation-result')!;
    const b = sensitivityBinding(mut, self.artifact, 'mutation');
    assert.equal(b.ok, false);
    assert.match((b as { problem: string }).problem, /mutated test\/trivial\.test\.js, which is test code \(the artifact itself or another test file\): killing mutants of a test proves nothing about the product/);
    const j = artifactEligibility(self.artifact, ctxOf(self));
    assert.deepEqual([j.eligible, j.stages.sensitivity], [false, 'failed'], j.reasons.join('; '));
    // the run that reached PASS before the fix: approved artifact, base known-good, self-mutation, passing on the BUGGY candidate
    const d = gate.evaluate(input({ testArtifacts: [self.artifact], reviews: [self.review], evidence: [...self.evidence, trivialPassOnBuggy] }));
    assert.notEqual(d.verdict, 'pass', d.reasons.join('\n'));
    assert.ok(d.unknownCriteria.some((c) => c.criterionId === 'C3'), d.reasons.join('\n'));
  });

  test('mutants of another test file, of a file written in the workspace, or with no mutated-file facts are refused with the exact reason', () => {
    const l = lifecycle(trivialArtifact());
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['another test file (by pattern, even when the tool flag says otherwise)', { file: 'test/helpers.js', mutatedFile: { path: 'test/helpers.js', isTestFile: false, changedSinceBase: false } }, /mutated test\/helpers\.js, which is test code/],
      ['a test file by the tool flag', { file: 'lib/checks.js', mutatedFile: { path: 'lib/checks.js', isTestFile: true, changedSinceBase: false } }, /mutated lib\/checks\.js, which is test code/],
      ['a helper written in the workspace', { file: 'lib/assert-helper.js', mutatedFile: { path: 'lib/assert-helper.js', isTestFile: false, changedSinceBase: true } }, /mutated lib\/assert-helper\.js, which was added or modified in the workspace: only mutants of the candidate's own product code show sensitivity/],
      ['unknown provenance of the mutated file', { file: 'src/pricing.js', mutatedFile: { path: 'src/pricing.js', isTestFile: false } }, /is not known to be unchanged since the base commit/],
      ['no mutated-file facts at all', { file: 'src/pricing.js', mutatedFile: null }, /records no mutated-file facts/],
    ];
    for (const [what, m, re] of cases) {
      const x = withMutation(l, m);
      const b = sensitivityBinding(x.evidence.find((e) => e.evidenceType === 'mutation-result')!, x.artifact, 'mutation');
      assert.equal(b.ok, false, what);
      assert.match((b as { problem: string }).problem, re, what);
      assert.equal(artifactEligibility(x.artifact, ctxOf(x)).eligible, false, what);
    }
    // the product-code mutation of the lifecycle is (still) accepted
    assert.equal(artifactEligibility(l.artifact, ctxOf(l)).eligible, true);
  });

  test('a known-good pass on the CANDIDATE workspace (e.g. a test that encodes the defect as its expectation) never supports or violates a P0/P1 assertion', () => {
    const l = lifecycle(trivialArtifact());
    const onCandidate: ReturnType<typeof lifecycle> = { ...l, evidence: l.evidence.map((e) => (e.evidenceId.startsWith('ev_kg_') ? { ...e, structured: { ...(e.structured as Record<string, unknown>), codeRevision: workspaceRev } as unknown as JsonValue } : e)) };
    const j = artifactEligibility(onCandidate.artifact, ctxOf(onCandidate));
    assert.equal(j.eligible, true, j.reasons.join('; '));
    assert.equal(j.criticalSupport, false);
    assert.equal(j.knownGoodRevision, 'workspace');
    assert.ok(j.reasons.some((r) => /passed on the workspace \(candidate\) code, not on the run's base revision: the artifact never supports or violates a P0\/P1 assertion/.test(r)), j.reasons.join('; '));
    // before the review fix this exact input was PASS on the buggy candidate (the artifact "supported" discount-10)
    const d = gate.evaluate(input({ testArtifacts: [onCandidate.artifact], reviews: [onCandidate.review], evidence: [...onCandidate.evidence, trivialPassOnBuggy] }));
    assert.notEqual(d.verdict, 'pass', d.reasons.join('\n'));
    assert.ok(d.unknownCriteria.some((c) => c.criterionId === 'C3'), d.reasons.join('\n'));
    // the base-revision known-good of the same artifact does decide it (positive control)
    assert.equal(artifactEligibility(l.artifact, ctxOf(l)).criticalSupport, true);
    // and without a base commit in the run there is no base revision: never critical
    assert.equal(artifactEligibility(l.artifact, { ...ctxOf(l), baseCommit: undefined as never }).criticalSupport, false);
  });
});

// ------------------------------------------------------------------------------------------------- C3 symmetric (addendum)

describe('addendum: evidence of an ineligible generated test can neither satisfy NOR violate a critical assertion', () => {
  const failing = (id: string, seq: number) => ev(id, seq, 'test-result', {
    framework: 'node_test', passed: false, cases: [{ id: 'test/discount.test.js::applies a 10% discount', name: 'applies a 10% discount', file: 'test/discount.test.js', status: 'failed' }],
    workspaceDelta: { status: 'computed', baseCommit: 'base', readOnly: true, treeDigest: 'tree_candidate', changedFiles: 1, testFiles: [{ path: 'test/discount.test.js', change: 'added', sha256: 'd'.repeat(64) }] },
    executedTests: executed([{ path: 'test/discount.test.js', sha256: 'd'.repeat(64), staticOk: true }]), codeRevision: workspaceRev,
  } as unknown as JsonValue, { workItemId: 'wi_exec' });
  const regression = (): TestArtifact => trivialArtifact({ artifactId: 'ta_disc', path: 'test/discount.test.js', artifactDigest: 'd'.repeat(64) });

  test('an unvalidated failing generated test (maybe a broken test) does not fail the run: C3 unknown ⇒ inconclusive (the live-run FAIL)', () => {
    const draft = regression();
    const d = gate.evaluate(input({ testArtifacts: [draft], evidence: [failing('ev_fail', 5)] }));
    assert.equal(d.verdict, 'inconclusive', d.reasons.join('\n'));
    assert.ok(d.reasons.some((r) => r.includes('C3 oracle.pricing@1/discount-10 (P1) unproven') && r.includes('would have violated it')), d.reasons.join('\n'));
  });

  test('once its known-good run on the BASE revision passed and it is bound + reviewed, the same failure fails the run', () => {
    const l = lifecycle(regression(), { sensitivity: 'known_bad' });
    const d = gate.evaluate(input({ testArtifacts: [l.artifact], reviews: [l.review], evidence: [...l.evidence, failing('ev_fail', 30)] }));
    assert.equal(d.verdict, 'fail', d.reasons.join('\n'));
    assert.equal(d.violatedCriteria.find((c) => c.criterionId === 'C3')?.status, 'violated');
    // the known-good run on the base revision is validation evidence only — never evidence about the candidate
    assert.ok(d.reasons.some((r) => r.startsWith('validation-only evidence') && r.includes('ev_kg_ta_disc')), d.reasons.join('\n'));
  });

  test('D-11 "critical test failed": an eligible artifact bound to the assertion fails ⇒ violated, even when the oracle selector does not match its case names', () => {
    const l = lifecycle(regression(), { sensitivity: 'known_bad' });
    const renamed = ev('ev_renamed', 30, 'test-result', {
      framework: 'node_test', passed: false, cases: [{ id: 'test/discount.test.js::rounds down a tenth', name: 'rounds down a tenth', file: 'test/discount.test.js', status: 'failed' }],
      workspaceDelta: { status: 'computed', baseCommit: 'base', readOnly: true, treeDigest: 'tree_candidate', changedFiles: 1, testFiles: [{ path: 'test/discount.test.js', change: 'added', sha256: 'd'.repeat(64) }] },
      executedTests: executed([{ path: 'test/discount.test.js', sha256: 'd'.repeat(64) }]), codeRevision: workspaceRev,
    } as unknown as JsonValue);
    const d = gate.evaluate(input({ testArtifacts: [l.artifact], reviews: [l.review], evidence: [...l.evidence, renamed] }));
    assert.equal(d.verdict, 'fail', d.reasons.join('\n'));
    assert.ok(d.reasons.some((r) => r.includes('test artifact(s) bound to this assertion failed: test/discount.test.js')), d.reasons.join('\n'));
  });
});

// ------------------------------------------------------------------------------------------------- C9 (area-C-0)

describe('area-C-0 report claims are EVALUATED against their evidence', () => {
  const tps = ev('ev_tps', 1, 'metric', { avg_tps: 103215, samples: [100000, 106430] });
  test('evaluateClaim: aggregation, tolerance, exact strings/booleans, unevaluable claims', () => {
    const q = (field: string, aggregation?: string) => ({ evidenceType: 'metric', field, ...(aggregation ? { aggregation } : {}) });
    assert.equal(evaluateClaim({ value: 103215, evidenceQuery: q('avg_tps'), evidenceRefs: ['ev_tps'] }, [tps]).status, 'match');
    assert.equal(evaluateClaim({ value: 103300, evidenceQuery: q('avg_tps'), evidenceRefs: ['ev_tps'] }, [tps]).status, 'match', 'within 0.5 %');
    assert.equal(evaluateClaim({ value: 999999, evidenceQuery: q('avg_tps', 'avg'), evidenceRefs: ['ev_tps'] }, [tps]).status, 'mismatch');
    assert.equal(evaluateClaim({ value: '103215', evidenceQuery: q('avg_tps'), evidenceRefs: ['ev_tps'] }, [tps]).status, 'match', 'a numeric string is its number');
    assert.equal(evaluateClaim({ value: 103215, evidenceQuery: q('samples', 'avg'), evidenceRefs: ['ev_tps'] }, [tps]).status, 'match');
    assert.equal(evaluateClaim({ value: 106430, evidenceQuery: q('samples', 'max'), evidenceRefs: ['ev_tps'] }, [tps]).status, 'match');
    assert.equal(evaluateClaim({ value: 2, evidenceQuery: q('samples', 'count'), evidenceRefs: ['ev_tps'] }, [tps]).status, 'match');
    assert.equal(evaluateClaim({ value: 106430, evidenceQuery: q('samples', 'p95'), evidenceRefs: ['ev_tps'] }, [tps]).status, 'match');
    assert.equal(evaluateClaim({ value: true, evidenceQuery: q('passed'), evidenceRefs: ['ev_p'] }, [ev('ev_p', 1, 'test-result', { passed: false })]).status, 'mismatch');
    assert.equal(evaluateClaim({ value: 1, evidenceQuery: { evidenceType: 'metric' }, evidenceRefs: ['ev_tps'] }, [tps]).status, 'unevaluable', 'a value needs a field');
    assert.equal(evaluateClaim({ value: 1, evidenceQuery: q('nope'), evidenceRefs: ['ev_tps'] }, [tps]).status, 'unevaluable');
    assert.equal(evaluateClaim({ value: 1, evidenceQuery: q('avg_tps', 'median-ish'), evidenceRefs: ['ev_tps'] }, [tps]).status, 'unevaluable');
    assert.equal(evaluateClaim({ evidenceQuery: q('avg_tps'), evidenceRefs: ['ev_tps'] }, [tps]).status, 'reference');
    // a field read from the record's artifact (data) when the structured payload does not carry it
    assert.equal(evaluateClaim({ value: 7, evidenceQuery: q('deep.n'), evidenceRefs: ['ev_tps'] }, [tps], new Map([['ev_tps', { deep: { n: 7 } }]])).status, 'match');
  });

  test('C9: an invented number backed by a real evidence id is a violated critical claim (fail); unevaluable ⇒ unknown; correct ⇒ satisfied', () => {
    const claim = (value: JsonValue, field = 'avg_tps') => ({ claimId: 'cl_tps', statement: `avg TPS is ${String(value)}`, value, evidenceQuery: { evidenceType: 'metric', field, aggregation: 'avg' }, evidenceRefs: ['ev_tps'], critical: true });
    const invented = gate.evaluate(input({ evidence: [tps], claims: [claim(999999)] }));
    assert.equal(invented.violatedCriteria.find((c) => c.criterionId === 'C9')?.status, 'violated');
    assert.equal(invented.verdict, 'fail');
    assert.ok(invented.reasons.some((r) => r.includes('critical claim cl_tps ("avg TPS is 999999") is contradicted by its evidence: claimed 999999 but avg of avg_tps')), invented.reasons.join('\n'));
    assert.equal(gate.evaluate(input({ evidence: [tps], claims: [claim(103215, 'missing')] })).unknownCriteria.find((c) => c.criterionId === 'C9')?.status, 'unknown');
    const ok = gate.evaluate(input({ evidence: [tps], claims: [claim(103215)] }));
    assert.equal([...ok.satisfiedCriteria].find((c) => c.criterionId === 'C9')?.status, 'satisfied');
  });
});

// ------------------------------------------------------------------------------------------------- C10 experiment validity

function experiment(extra: Partial<ExperimentSpec> = {}): ExperimentSpec {
  return {
    experimentId: 'exp_1', runId: RUN, revision: 1, oracleRefs: [{ oracleId: 'oracle.pricing', revision: 1 }], hypothesis: 'kv meets its SLO under 30 rps and a latency fault',
    subjects: [{ role: 'candidate', buildDigest: 'b-1' }], environment: { environmentId: 'kv', environmentClass: 'local', generation: 4 }, fixtures: [],
    workload: { kind: 'http_load', ratePerSecond: 30, durationMs: 10_000 }, faultPlan: [{ kind: 'latency', target: 'kv', params: { ms: 200 } }], randomSeeds: ['s1'],
    isolation: { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'env/kv', mode: 'fault_exclusive' }] }, evidenceRequirements: [{ evidenceType: 'metric', minCount: 1 }],
    stopConditions: [{ kind: 'duration', value: 60_000 }], contaminationRules: [], createdBy: 'agent_lead', createdAt: '2026-01-01T00:00:00.000Z', ...extra,
  };
}
const op = (operationId: string, toolId: string, extra: Partial<GateOperation> = {}): GateOperation => ({
  operationId, toolId, effect: toolId.startsWith('env.') ? 'destructive' : 'external', workItemId: 'wi_exec', experimentId: 'exp_1', status: 'verified', resourceKey: 'env/kv',
  toolInvocationId: `inv_${operationId}`, createdAt: '2026-01-01T00:00:01.000Z', ...extra,
});
const loadOp = op('op_load', 'load.start', { action: { kind: 'http_load', target: 'env/kv', ratePerSecond: 30, durationMs: 10_000 } });
const faultOp = op('op_fault', 'env.inject_fault', { action: { kind: 'latency', target: 'kv', params: { ms: 200 } } });
const metric = ev('ev_metric', 2, 'metric', { metric: 'p95_ms', value: 120 }, { provenance: { experimentId: 'exp_1' } as never, environment: { environmentId: 'kv', environmentClass: 'local', generation: 4 } });
const kvEnv = [{ environmentId: 'kv', registered: true, generation: 4 }];

describe('D-3/D-4/D-5, coverage-13: experiment validity (C10)', () => {
  const valid = () => input({ experiments: [experiment()], operations: [loadOp, faultOp], evidence: [metric], environments: kvEnv, gate: { ...GATE, requireOracle: false, requiredEvidence: [] } });

  test('a valid experiment (plan == executed, isolation held, generation unchanged, requirements met) satisfies C10', () => {
    const d = gate.evaluate(valid());
    assert.equal(d.satisfiedCriteria.find((c) => c.criterionId === 'C10')?.detail, '1 experiment(s): 0 invalid, 0 unproven', d.reasons.join('\n'));
  });

  test('contradictions ⇒ violated (fail): lapsed claims, contamination, generation drift, an undeclared fault, load beyond the workload, an action after a met stop condition', () => {
    const cases: Array<[string, (i: GateInput) => void, RegExp]> = [
      ['claims lapsed', (i) => { i.experimentFacts = [{ experimentId: 'exp_1', lapses: [{ at: '2026-01-01T00:00:05.000Z', conflicts: ['env/kv@exp_other'] }] }]; }, /claims lapsed at .*isolation did not hold/],
      ['foreign write during the experiment', (i) => { i.operations!.push(op('op_foreign', 'http.request', { experimentId: 'exp_other', workItemId: 'wi_other', createdAt: '2026-01-01T00:00:02.000Z' })); i.experiments.push(experiment({ experimentId: 'exp_other', faultPlan: [], workload: undefined as never, evidenceRequirements: [] })); }, /contamination: http\.request operation op_foreign of experiment exp_other acted on env\/kv/],
      ['generation drift', (i) => { i.evidence = [{ ...metric, environment: { environmentId: 'kv', environmentClass: 'local', generation: 6 } }]; }, /captured on generation 6 of kv; the experiment ran on generation 4/],
      ['undeclared fault', (i) => { i.operations![1] = { ...faultOp, action: { kind: 'error_rate', target: 'kv', params: { rate: 0.5 } } }; }, /not in the fault plan of experiment exp_1/],
      ['load beyond the workload', (i) => { i.operations![0] = { ...loadOp, action: { ...loadOp.action!, ratePerSecond: 300 } }; }, /ratePerSecond 300 > declared 30/],
      ['action after the stop', (i) => { i.experimentFacts = [{ experimentId: 'exp_1', lapses: [], stopped: { at: '2026-01-01T00:00:00.500Z', condition: 'manual', reason: 'enough' } }]; }, /ran at .* after stop condition manual was met/],
    ];
    for (const [what, perturb, re] of cases) {
      const i = valid();
      i.operations = [...i.operations!];
      perturb(i);
      i.evidenceRoot = { rootHash: 'root', count: i.evidence.length };
      const d = gate.evaluate(i);
      assert.equal(d.violatedCriteria.find((c) => c.criterionId === 'C10')?.status, 'violated', `${what}: ${d.reasons.join('\n')}`);
      assert.equal(d.verdict, 'fail', what);
      assert.ok(d.reasons.some((r) => re.test(r)), `${what}: ${d.reasons.join('\n')}`);
    }
  });

  test('missing facts ⇒ unknown: a declared fault never executed, an unrecorded action, unmet evidence requirements, a non-dedicated "dedicated" environment', () => {
    const cases: Array<[string, (i: GateInput) => void, RegExp]> = [
      ['fault never executed', (i) => { i.operations = [loadOp]; }, /declared fault latency@kv was never executed/],
      ['unrecorded action', (i) => { i.operations = [loadOp, { ...faultOp, action: undefined as never }]; }, /has no recorded action/],
      ['evidence requirement unmet', (i) => { i.experiments = [experiment({ evidenceRequirements: [{ evidenceType: 'metric', minCount: 3 }] })]; }, /evidence requirement 3× metric: found 1/],
      ['dedicated environment not registered as dedicated', (i) => { i.experiments = [experiment({ isolation: { mode: 'dedicated_environment', resourceClaims: [{ resourceKey: 'env/kv', mode: 'fault_exclusive' }] } })]; i.environments = [{ ...kvEnv[0]!, dedicated: false }]; }, /not registered as dedicated/],
    ];
    for (const [what, perturb, re] of cases) {
      const i = valid();
      perturb(i);
      const d = gate.evaluate(i);
      assert.equal(d.unknownCriteria.find((c) => c.criterionId === 'C10')?.status, 'unknown', `${what}: ${d.reasons.join('\n')}`);
      assert.ok(d.reasons.some((r) => re.test(r)), `${what}: ${d.reasons.join('\n')}`);
      assert.notEqual(d.verdict, 'pass');
    }
    // C4 includes the experiment's evidence requirements too (D-3)
    const i = valid();
    i.experiments = [experiment({ evidenceRequirements: [{ evidenceType: 'metric', minCount: 3 }] })];
    assert.ok(gate.evaluate(i).reasons.some((r) => r.startsWith('C4 experiment exp_1 requires 3× metric: found 1')));
  });

  test('D-10 (review): an experiment under a superseded oracle revision never decides — its evidence is ignored — and once re-run as a NEW experiment it no longer blocks the verdict', () => {
    // the metric supports the P0 latency assertion of revision 2; the experiment that gathered it ran under revision 1
    const LATENCY: OracleAssertion = { assertionId: 'latency', description: 'p95 below 150 ms', kind: 'deterministic_invariant', severity: 'P1', check: { type: 'metric_threshold', metric: 'p95_ms', comparator: '<', threshold: 150 } };
    const v2 = oracle({ revision: 2, assertions: [LATENCY] });
    const pinned2 = { ...run, oracleRevisions: { 'oracle.pricing': 2 } };
    const old = experiment({ oracleRefs: [{ oracleId: 'oracle.pricing', revision: 1 }] });
    const base = (): GateInput => input({ run: pinned2, oracles: [v2], experiments: [old], operations: [loadOp, faultOp], evidence: [metric], environments: kvEnv, gate: { ...GATE, requiredEvidence: [] } });
    const before = gate.evaluate(base());
    assert.notEqual(before.verdict, 'pass', before.reasons.join('\n'));
    assert.ok(before.unknownCriteria.some((c) => c.criterionId === 'C3'), 'the old experiment\'s metric does not decide the new assertion');
    assert.ok(before.reasons.some((r) => r.startsWith('ignored evidence of experiments under a superseded oracle revision: ev_metric (experiment exp_1: it ran under oracle oracle.pricing revision 1; revision 2 is in force)')), before.reasons.join('\n'));
    assert.ok(before.reasons.some((r) => /^C10 experiment exp_1 is superseded .*re-run it as a new experiment/.test(r)), before.reasons.join('\n'));
    // the lead re-runs it as a NEW experiment under revision 2: its evidence decides, the superseded one no longer blocks
    const rerun = experiment({ experimentId: 'exp_2', oracleRefs: [{ oracleId: 'oracle.pricing', revision: 2 }], createdAt: '2026-01-01T00:01:00.000Z' });
    const i = base();
    const at = (o: GateOperation, id: string) => ({ ...o, operationId: `${o.operationId}_2`, experimentId: id, toolInvocationId: `${o.toolInvocationId}_2`, createdAt: '2026-01-01T00:01:01.000Z' });
    const metric2 = { ...metric, evidenceId: 'ev_metric_2', seq: 3, capturedAt: '2026-01-01T00:01:10.000Z', provenance: { experimentId: 'exp_2' } as never };
    i.experiments = [old, rerun];
    i.operations = [loadOp, faultOp, at(loadOp, 'exp_2'), at(faultOp, 'exp_2')];
    i.evidence = [metric, metric2];
    i.evidenceRoot = { rootHash: 'root', count: 2 };
    const after = gate.evaluate(i);
    assert.equal(after.verdict, 'pass', after.reasons.join('\n'));
    assert.equal(after.satisfiedCriteria.find((c) => c.criterionId === 'C10')?.detail, '1 experiment(s): 0 invalid, 0 unproven; 1 superseded');
    assert.deepEqual(after.satisfiedCriteria.find((c) => c.criterionId === 'C3')?.evidenceRefs, ['ev_metric_2']);
  });

  test('stop conditions are evaluated deterministically (duration, error rate, metric threshold, manual)', () => {
    const actions = [{ createdAt: '2026-01-01T00:00:00.000Z' }];
    assert.deepEqual(evaluateStopConditions({ stopConditions: [{ kind: 'duration', value: 1000 }] }, [], actions, '2026-01-01T00:00:00.500Z'), { met: false });
    const d = evaluateStopConditions({ stopConditions: [{ kind: 'duration', value: 1000 }] }, [], actions, '2026-01-01T00:00:02.000Z');
    assert.equal(d.met && d.at, '2026-01-01T00:00:01.000Z');
    const load = ev('ev_load', 3, 'metric', { source: 'loadgen', sent: 100, errors: 30 }, { capturedAt: '2026-01-01T00:00:03.000Z' });
    const e = evaluateStopConditions({ stopConditions: [{ kind: 'error_rate_above', value: 0.2 }] }, [load], actions, NOW);
    assert.equal(e.met && e.observed, 'error rate 0.3 > 0.2 in ev_load');
    const m = evaluateStopConditions({ stopConditions: [{ kind: 'metric_threshold', metric: 'p95_ms', value: 100 }] }, [metric], actions, NOW);
    assert.equal(m.met && m.condition.kind, 'metric_threshold');
    assert.deepEqual(evaluateStopConditions({ stopConditions: [{ kind: 'manual' }] }, [], actions, NOW), { met: false });
    assert.equal(evaluateStopConditions({ stopConditions: [{ kind: 'manual' }] }, [], actions, NOW, { at: NOW, reason: 'operator' }).met, true);
  });

  test('planViolation: faults must be declared (kind, target, params), load stays within the workload', () => {
    const x = experiment();
    assert.equal(planViolation(x, 'env.inject_fault', { kind: 'latency', target: 'kv', params: { ms: 200 } }), undefined);
    assert.match(planViolation(x, 'env.inject_fault', { kind: 'latency', target: 'kv', params: { ms: 900 } })!, /not in the fault plan/);
    assert.match(planViolation(x, 'env.inject_fault', { kind: 'latency', target: 'other', params: { ms: 200 } })!, /not in the fault plan/);
    assert.match(planViolation(experiment({ faultPlan: [] }), 'env.restart', { kind: 'restart', target: 'kv' })!, /declares no fault plan/);
    assert.equal(planViolation(experiment({ faultPlan: [{ kind: 'restart', target: 'env/kv' }] }), 'env.restart', { kind: 'restart', target: 'kv' }), undefined);
    assert.match(planViolation(experiment({ workload: undefined as never }), 'load.start', { ratePerSecond: 1, durationMs: 1 })!, /declares no workload/);
    assert.match(planViolation(x, 'load.start', { ratePerSecond: 30, durationMs: 20_000 })!, /durationMs 20000 > declared 10000/);
  });

  test('experimentValidity is order-independent and never ignores a contradiction (seeded property test)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 200; n++) {
      const ops: GateOperation[] = [loadOp, faultOp];
      const lapse = rnd() < 0.3;
      const foreign = rnd() < 0.3;
      if (foreign) ops.push(op(`op_f${n}`, 'http.request', { experimentId: undefined as never, workItemId: 'wi_x', createdAt: '2026-01-01T00:00:01.500Z' }));
      const facts = { experimentId: 'exp_1', lapses: lapse ? [{ at: NOW, conflicts: ['x'] }] : [] };
      const v1 = experimentValidity({ spec: experiment(), evidence: [metric], operations: ops, facts, oraclesInForce: [oracle()], now: NOW });
      const v2 = experimentValidity({ spec: experiment(), evidence: [metric], operations: [...ops].reverse(), facts, oraclesInForce: [oracle()], now: NOW });
      assert.deepEqual(v1, v2);
      assert.equal(v1.violations.length > 0, lapse || foreign, `n=${n}`);
    }
  });
});

// ------------------------------------------------------------------------------------------------- C11, C12

describe('D-11 environment validity (C11) and coverage-1 domain contracts (C12)', () => {
  const kvMetric = ev('ev_kv', 1, 'metric', { metric: 'x', value: 1 }, { environment: { environmentId: 'kv', environmentClass: 'local', generation: 4 } });
  const base = (extra: Partial<GateInput> = {}) => input({ evidence: [kvMetric], environments: kvEnv, gate: { ...GATE, requireOracle: false, requiredEvidence: [] }, ...extra });

  test('C11 unknown: unregistered environment, unexplained generation drift, an uncertain environment operation, an unresolved P0–P2 environment finding', () => {
    assert.equal(gate.evaluate(base()).satisfiedCriteria.find((c) => c.criterionId === 'C11')?.status, 'satisfied');
    const cases: Array<[string, Partial<GateInput>, RegExp]> = [
      ['unregistered', { environments: [{ environmentId: 'kv', registered: false }] }, /environment kv is not registered/],
      ['drift', { environments: [{ environmentId: 'kv', registered: true, generation: 5 }] }, /kv drifted during the run: generation 4 → 5 but the run itself verified only 0/],
      ['uncertain op', { experiments: [experiment({ faultPlan: [], workload: undefined as never, evidenceRequirements: [] })], operations: [op('op_r', 'env.restart', { status: 'outcome_unknown' })] }, /env\.restart operation op_r on env\/kv is outcome_unknown/],
      ['environment finding', { findings: [rec<Finding>('finding', 'rec_env', { title: 'kv keeps restarting', description: 'd', severity: 'P2', category: 'environment', status: 'open', fingerprint: 'f' })] }, /unresolved P2 environment finding rec_env/],
    ];
    for (const [what, extra, re] of cases) {
      const d = gate.evaluate(base(extra));
      assert.equal(d.unknownCriteria.find((c) => c.criterionId === 'C11')?.status, 'unknown', what);
      assert.ok(d.reasons.some((r) => re.test(r)), `${what}: ${d.reasons.join('\n')}`);
      assert.notEqual(d.verdict, 'pass', what);
    }
    // a drift explained by the run's own verified restart is not one
    const explained = gate.evaluate(base({ environments: [{ environmentId: 'kv', registered: true, generation: 5 }], experiments: [experiment({ faultPlan: [{ kind: 'restart', target: 'kv' }], workload: undefined as never, evidenceRequirements: [] })], operations: [op('op_r', 'env.restart', { action: { kind: 'restart', target: 'kv' } })] }));
    assert.equal(explained.satisfiedCriteria.find((c) => c.criterionId === 'C11')?.status, 'satisfied', explained.reasons.join('\n'));
    // a P3 environment note does not invalidate it
    assert.equal(gate.evaluate(base({ findings: [rec<Finding>('finding', 'rec_env', { title: 'cosmetic', description: 'd', severity: 'P3', category: 'environment', status: 'open', fingerprint: 'f' })] })).satisfiedCriteria.find((c) => c.criterionId === 'C11')?.status, 'satisfied');
  });

  test('C12 unknown without a SystemModel, with an action outside every ExperimentSpec, or with the actions not supplied; requireContracts false is the only way out', () => {
    const noModel = gate.evaluate(base({ systemModel: undefined as never, run: { ...run, systemModelRevision: undefined as never } }));
    assert.ok(noModel.reasons.includes('C12 the run has no SystemModel revision: record the system under test (system_model.record) before judging it'), noModel.reasons.join('\n'));
    assert.notEqual(noModel.verdict, 'pass');
    const empty = gate.evaluate(base({ systemModel: { ...systemModel, components: [] } }));
    assert.ok(empty.reasons.some((r) => r.includes('has no component')));
    const loose = gate.evaluate(base({ operations: [op('op_post', 'http.request', { experimentId: undefined as never, resourceKey: 'url/127.0.0.1:8080' })] }));
    assert.ok(loose.reasons.some((r) => r.includes('http.request operation op_post (external) on url/127.0.0.1:8080 belongs to no ExperimentSpec')), loose.reasons.join('\n'));
    assert.equal(loose.unknownCriteria.find((c) => c.criterionId === 'C12')?.status, 'unknown');
    const unsupplied = gate.evaluate(base({ operations: undefined as never }));
    assert.ok(unsupplied.reasons.some((r) => r.includes("write/fault/load actions were not supplied")));
    const off = gate.evaluate(base({ gate: { ...GATE, requireOracle: false, requiredEvidence: [], requireContracts: false }, systemModel: undefined as never }));
    assert.equal(off.satisfiedCriteria.find((c) => c.criterionId === 'C12')?.status, 'satisfied');
    assert.ok(off.gateOverrides?.includes('requireContracts=false'));
  });

  test('coverage-1: the decision locates the revisions of all five core contracts (SystemModel, OracleSpec, ExperimentSpec, TestArtifact, itself)', () => {
    const l = lifecycle(trivialArtifact());
    const d = gate.evaluate(input({ testArtifacts: [l.artifact], reviews: [l.review], evidence: l.evidence, experiments: [experiment()], revision: 3, supersedes: 'qd_0' }));
    assert.equal(d.systemModelId, `sm_${RUN}`);
    assert.equal(d.systemModelRevision, 1);
    assert.deepEqual(d.oracleRevisions, { 'oracle.pricing': 1 });
    assert.deepEqual(d.experimentRevisions, { exp_1: 1 });
    assert.deepEqual(d.testArtifactRevisions, { ta_trivial: 2 });
    assert.equal(d.revision, 3);
    assert.equal(d.supersedes, 'qd_0');
    assert.deepEqual(d.buildDigests, ['b-1']);
  });

  test('reviewers can never waive a deterministic criterion (C1–C5, C8, C10, C11, C12): agent-approved exceptions are ignored', () => {
    for (const criterionId of ['C1', 'C2', 'C3', 'C4', 'C5', 'C8', 'C10', 'C11', 'C12']) {
      const d = gate.evaluate(base({ systemModel: undefined as never, run: { ...run, systemModelRevision: undefined as never }, exceptions: [{ criterionId, approvedBy: { kind: 'agent', id: 'agent_reviewer' }, rationale: 'fine by me' }] }));
      assert.notEqual(d.verdict, 'pass', criterionId);
      if (criterionId !== 'C1') assert.ok(d.reasons.includes(`exception for ${criterionId} approved by agent agent_reviewer ignored`), criterionId);
    }
  });
});

// ------------------------------------------------------------------------------------------------- D-7 oracle governance

describe('D-7 OracleSpec authorities, judge policy and approvals are enforced', () => {
  test('C0: an oracle without a valid authority, an expert-approved one approved by an agent, or agent approval without independent_agent is not in force', () => {
    assert.deepEqual(oracleAuthorityProblems(oracle()), []);
    const cases: Array<[string, Partial<OracleSpec>, RegExp]> = [
      ['no authority', { authorities: [] }, /names no authority/],
      ['blank source', { authorities: [{ sourceRef: ' ', authority: 'approved_requirement' }] }, /has no sourceRef/],
      ['unknown kind', { authorities: [{ sourceRef: 'x', authority: 'vibes' as never }] }, /unknown kind vibes/],
      ['expert approved by an agent', { authorities: [{ sourceRef: 'x', authority: 'expert_approved' }], approvedBy: [{ kind: 'agent', id: 'a', role: 'reviewer' }], changePolicy: { agentMayPropose: true, selfApprove: false, invalidatesPriorDecisions: true, approvers: ['human', 'independent_agent'] } }, /expert_approved authority requires a human approver/],
      ['agent approver not accepted', { approvedBy: [{ kind: 'agent', id: 'a', role: 'reviewer' }] }, /accepts no agent approver/],
      ['no approver', { approvedBy: [] }, /records no approver/],
    ];
    for (const [what, extra, re] of cases) {
      const o = oracle(extra);
      assert.ok(oracleAuthorityProblems(o).some((p) => re.test(p)), what);
      const d = gate.evaluate(input({ oracles: [o], evidence: [ev('ev_t', 1, 'test-result', { cases: [{ id: 'applies a 10% discount', status: 'passed' }, { id: 'zero discount', status: 'passed' }] })] }));
      assert.equal(d.unknownCriteria.find((c) => c.criterionId === 'C0')?.status, 'unknown', what);
      assert.notEqual(d.verdict, 'pass', what);
    }
  });

  test('C0: a pinned revision declared invalid (a newer invalid revision) is unknown', () => {
    const invalid = oracle({ revision: 2, status: 'invalid', supersedes: 1, invalidation: { revision: 1, reason: 'REQ-7 was misread', by: { kind: 'human', id: 'qa-lead' }, at: NOW } });
    const d = gate.evaluate(input({ oracles: [oracle(), invalid] }));
    assert.ok(d.reasons.some((r) => r.includes('C0 a pinned oracle was declared invalid')), d.reasons.join('\n'));
    assert.ok(d.unknownCriteria.find((c) => c.criterionId === 'C0')?.detail?.includes('REQ-7 was misread'));
  });

  const human: ActorRef = { kind: 'human', id: 'qa-lead' };
  const proposer: ActorRef = { kind: 'agent', id: 'agent_exec', role: 'executor', modelProvider: 'openai' };
  const reviewer: ActorRef = { kind: 'agent', id: 'agent_rev', role: 'reviewer', modelProvider: 'anthropic' };
  const setup = () => {
    const store = new MemoryOracleStore();
    const decisions = new MemoryDecisions();
    const events = new InMemoryEventSink();
    return { store, decisions, events, gov: createOracleGovernance({ ...testDeps(), store, decisions, events }) };
  };
  const ctx = eventCtx(RUN);
  const est = (extra: Record<string, unknown> = {}) => ({
    oracleId: 'oracle.pricing', scope: { components: ['pricing'], description: 'REQ-7' }, assertions: [DISCOUNT],
    authorities: [{ sourceRef: 'REQ-7', authority: 'approved_requirement' as const }],
    judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: true },
    changePolicy: { agentMayPropose: true, selfApprove: false as const, invalidatesPriorDecisions: false, approvers: ['human' as const, 'independent_agent' as const] }, ...extra,
  });

  test('establish refuses an oracle without authorities, with an unknown authority kind, or an expert-approved one from a system actor', async () => {
    const { gov } = setup();
    await assert.rejects(gov.establish(est({ authorities: [] }) as never, human, ctx), (e: Error & { code?: string }) => e.code === 'invalid_argument' && /at least one authority/.test(e.message));
    await assert.rejects(gov.establish(est({ authorities: [{ sourceRef: 'x', authority: 'vibes' }] }) as never, human, ctx), /unknown kind vibes/);
    await assert.rejects(gov.establish(est({ authorities: [{ sourceRef: 'x', authority: 'expert_approved' }] }) as never, { kind: 'system', id: 'system:import' }, ctx), /must be established by a human/);
    assert.equal((await gov.establish(est() as never, human, ctx)).status, 'approved');
  });

  test('an agent can never approve a change of an expert-approved oracle (approvals checked against authorities)', async () => {
    const { gov } = setup();
    await gov.establish(est({ authorities: [{ sourceRef: 'panel-2026', authority: 'expert_approved' }] }) as never, human, ctx);
    const p = await gov.propose({ runId: RUN, oracleId: 'oracle.pricing', fromRevision: 1, proposedAssertions: [ZERO], rationale: 'r', relatedEvidenceRefs: [] }, proposer, ctx);
    await assert.rejects(gov.decide(p.proposalId, true, reviewer, 'looks right', ctx), (e: Error & { details?: { rule?: string } }) => e.details?.rule === 'authority_requires_human');
    assert.equal((await gov.decide(p.proposalId, true, human, 'panel agreed', ctx)).newRevision?.revision, 2);
  });

  test('D-10 invalidate: human/system only, append-only invalid revision, decisions on it marked needs_reassessment regardless of the change policy; a new approved revision follows', async () => {
    const { gov, store, decisions, events } = setup();
    await gov.establish(est() as never, human, ctx);
    decisions.decisions.push({ decisionId: 'qd_old', runId: 'run_old', oracleRevisions: { 'oracle.pricing': 1 } } as never);
    await assert.rejects(gov.invalidate!('oracle.pricing', 1, reviewer, 'wrong', ctx), { code: 'permission_denied' });
    await assert.rejects(gov.invalidate!('oracle.pricing', 1, human, ' ', ctx), { code: 'invalid_argument' });
    await assert.rejects(gov.invalidate!('oracle.pricing', 7, human, 'wrong', ctx), { code: 'conflict' });
    const r = await gov.invalidate!('oracle.pricing', 1, human, 'REQ-7 was misread', ctx);
    assert.equal(r.invalid.revision, 2);
    assert.equal(r.invalid.status, 'invalid');
    assert.deepEqual(r.invalid.invalidation?.revision, 1);
    assert.deepEqual(r.invalidatedDecisions, ['qd_old'], 'invalidatesPriorDecisions false does not spare decisions on an invalid revision');
    assert.match(decisions.marked.get('qd_old')!, /declared invalid by human:qa-lead: REQ-7 was misread/);
    assert.equal((await store.getOracle('oracle.pricing', 1))?.status, 'approved', 'history is never rewritten');
    assert.ok(events.events.some((e) => e.eventType === 'oracle.invalidated'));
    // v3: a governed change from the invalid revision creates a clean approved revision
    const p = await gov.propose({ runId: RUN, oracleId: 'oracle.pricing', fromRevision: 2, proposedAssertions: [DISCOUNT, ZERO], rationale: 'corrected', relatedEvidenceRefs: [] }, proposer, ctx);
    const v3 = (await gov.decide(p.proposalId, true, human, 'ok', ctx)).newRevision!;
    assert.equal(v3.revision, 3);
    assert.equal(v3.status, 'approved');
    assert.equal(v3.invalidation, undefined);
    await assert.rejects(gov.invalidate!('oracle.pricing', 2, human, 'x', ctx), { code: 'conflict' });
  });
});

// ------------------------------------------------------------------------------------------------- determinism of the new criteria

test('determinism: C10–C12 do not depend on input order', () => {
  const l = lifecycle(trivialArtifact());
  const i = input({ testArtifacts: [l.artifact], reviews: [l.review], evidence: [...l.evidence, metric], experiments: [experiment()], operations: [loadOp, faultOp], environments: kvEnv });
  const a = gate.evaluate(i);
  const b = gate.evaluate({ ...i, evidence: [...i.evidence].reverse(), operations: [...i.operations!].reverse(), experiments: [...i.experiments].reverse(), reviews: [...i.reviews].reverse() });
  assert.deepEqual(a, b);
});

void ({} as GateSpec);
