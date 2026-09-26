import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonValue } from '@hypertest/core';
import type {
  BlackboardRecord, EvidenceRecord, Finding, GateSpec, Objective, OracleAssertion, OracleSpec, ReportClaim, Review, Risk, TestArtifact, TestRun, WorkItem,
} from '@hypertest/domain';
import { DEFAULT_GATE_SPEC, QualityGate, type GateInput } from '../src/index.ts';

const RUN = 'run_gate';
const gate = new QualityGate();

function ev(evidenceId: string, seq: number, evidenceType: string, structured: JsonValue, extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    evidenceId,
    seq,
    runId: RUN,
    evidenceType,
    artifact: { uri: `cas://sha256/${evidenceId}`, sha256: evidenceId, size: 1, mimeType: 'application/json' },
    summary: evidenceId,
    structured,
    producer: { workerId: 'w1', runtimeManifestId: 'rm_1' },
    provenance: {},
    parentEvidenceIds: [],
    classification: 'internal',
    retentionPolicy: 'run',
    capturedAt: '2026-01-01T00:00:00.000Z',
    metadataHash: 'm',
    recordHash: `h_${evidenceId}`,
    ...extra,
  };
}

function rec<T>(recordType: BlackboardRecord['recordType'], recordId: string, payload: T, extra: Partial<BlackboardRecord<T>> = {}): BlackboardRecord<T> {
  return { recordId, lineageId: recordId, recordType, runId: RUN, revision: 1, version: 1, createdBy: 'agent_x', payload, evidenceRefs: [], createdAt: '2026-01-01T00:00:00.000Z', ...extra };
}

const finding = (id: string, p: Partial<Finding>, extra: Partial<BlackboardRecord<Finding>> = {}) =>
  rec<Finding>('finding', id, { title: `finding ${id}`, description: 'd', severity: 'P1', category: 'product_defect', status: 'open', fingerprint: id, ...p }, { evidenceRefs: ['ev_tests'], ...extra });
const risk = (id: string, p: Partial<Risk>) => rec<Risk>('risk', id, { title: `risk ${id}`, description: 'd', likelihood: 'high', impact: 'high', level: 'high', componentRefs: [], source: 'change_analysis', status: 'open', ...p });
const review = (id: string, p: Partial<Review>, createdBy = 'agent_reviewer') =>
  rec<Review>('review', id, { subjectRef: { kind: 'decision', id: 'dec_1' }, verdict: 'approve', rationale: 'evidence checks out', checkedEvidenceRefs: ['ev_tests'], reviewerRole: 'reviewer', modelProvider: 'anthropic', ...p }, { createdBy });

const P1_TEST: OracleAssertion = { assertionId: 'a_total', description: 'cart total correct', kind: 'requirement', severity: 'P1', check: { type: 'test_outcome', testSelector: 'cart > total', expected: 'pass' } };
const P0_LATENCY: OracleAssertion = { assertionId: 'a_latency', description: 'p95 < 300ms', kind: 'statistical', severity: 'P0', check: { type: 'metric_threshold', metric: 'http_latency_ms', comparator: '<', threshold: 300, aggregation: 'p95' } };
const P1_ERRORS: OracleAssertion = { assertionId: 'a_errors', description: 'no 5xx', kind: 'deterministic_invariant', severity: 'P1', check: { type: 'evidence_predicate', evidenceType: 'api-response', field: 'status', comparator: '<', value: 500 } };
const P2_LLM: OracleAssertion = { assertionId: 'a_copy', description: 'UI copy is friendly', kind: 'llm_semantic', severity: 'P2', check: { type: 'llm_rubric', rubric: 'friendly' } };

function oracle(assertions: OracleAssertion[], extra: Partial<OracleSpec> = {}): OracleSpec {
  return {
    oracleId: 'or_cart',
    revision: 2,
    scope: { components: ['cart'], description: 'cart' },
    assertions,
    authorities: [{ sourceRef: 'req://1', authority: 'approved_requirement' }],
    judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: true },
    changePolicy: { agentMayPropose: true, selfApprove: false, invalidatesPriorDecisions: true, approvers: ['human'] },
    status: 'approved',
    approvedBy: [{ kind: 'human', id: 'u' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

const testResult = (id: string, seq: number, cases: Array<{ id: string; name: string; status: string }>, extra: Partial<EvidenceRecord> = {}) =>
  ev(id, seq, 'test-result', { framework: 'node_test', passed: cases.every((c) => c.status === 'passed'), cases } as unknown as JsonValue, extra);

function workItem(id: string, p: Partial<WorkItem> = {}): WorkItem {
  return {
    workItemId: id, runId: RUN, kind: 'task', origin: { kind: 'system', reason: 't' }, title: id, objective: id, role: 'executor', objectiveIds: ['obj_p1'],
    capabilityRequirements: [], inputRefs: [], evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 1, maxTokens: 1, maxToolCalls: 1, maxWallClockMs: 1 }, priority: 1,
    state: 'completed', depth: 0, fingerprint: id, resourceClaims: [], attempts: 1, waitingOn: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...p,
  };
}

const objectives: Objective[] = [
  { objectiveId: 'obj_p1', description: 'cart works', priority: 'P1', riskRefs: [], acceptanceCriteria: [], status: 'open' },
  { objectiveId: 'obj_p3', description: 'cosmetics', priority: 'P3', riskRefs: [], acceptanceCriteria: [], status: 'open' },
];

const run: TestRun = {
  runId: RUN, goal: 'assess releasability of the cart change', target: {}, status: 'gating', budget: { maxWallClockMs: 1, maxAgentConcurrency: 1, maxModelTokens: 1, maxToolCalls: 1, maxWorkItems: 1, maxAgentDepth: 1, maxPlanRevisions: 1 },
  runtimeManifestId: 'rm_1', policyRevision: 'builtin@1', currentPlanRevision: 1, systemModelRevision: 3, oracleRevisions: { or_cart: 2 }, experimentIds: [], labels: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

/** A fully passing input; each test perturbs one aspect. */
function baseline(): GateInput {
  const evidence = [
    testResult('ev_tests', 1, [{ id: 'cart > total', name: 'total', status: 'passed' }, { id: 'cart > empty', name: 'empty', status: 'passed' }], { workItemId: 'wi_exec' }),
    ev('ev_metric', 2, 'metric', { metric: 'http_latency_ms', p95: 180, p99: 290 }),
    ev('ev_api', 3, 'api-response', { method: 'GET', path: '/cart', status: 200, body: '{"total":5}' }),
    ev('ev_cov', 4, 'coverage', { totals: { lines: { covered: 90, total: 100 }, branches: { covered: 70, total: 100 } } }),
  ];
  return {
    run,
    gate: { ...DEFAULT_GATE_SPEC, minCoverage: { lines: 0.8 } },
    objectives,
    oracles: [oracle([P1_TEST, P0_LATENCY, P1_ERRORS, P2_LLM])],
    experiments: [{ experimentId: 'exp_1', revision: 2 } as never, { experimentId: 'exp_1', revision: 1 } as never],
    findings: [finding('rec_f_minor', { severity: 'P3' })],
    risks: [risk('rec_r_med', { level: 'medium' })],
    reviews: [review('rec_rev_1', {})],
    coverageGaps: [],
    testArtifacts: [],
    evidence,
    evidenceRoot: { rootHash: 'root_abc', count: evidence.length },
    workItems: [workItem('wi_exec', { evidenceRequirements: [{ evidenceType: 'test-result', minCount: 1, critical: true }] })],
    claims: [{ claimId: 'cl_1', statement: 'p95 is 180ms', evidenceQuery: { evidenceType: 'metric' }, evidenceRefs: ['ev_metric'], critical: true }],
    exceptions: [],
    runtimeManifestId: 'rm_1',
    policyRevision: 'builtin@1',
    decisionId: 'dec_2',
    now: '2026-02-01T00:00:00.000Z',
    producerProviders: ['openai'],
  };
}

const ids = (cs: Array<{ criterionId: string }>) => cs.map((c) => c.criterionId);
const criterion = (d: ReturnType<QualityGate['evaluate']>, id: string) => [...d.satisfiedCriteria, ...d.violatedCriteria, ...d.unknownCriteria].find((c) => c.criterionId === id)!;

// ----------------------------------------------------------------------------- baseline + determinism

test('baseline: every criterion satisfied ⇒ pass, with every decision field filled', () => {
  const d = gate.evaluate(baseline());
  assert.equal(d.verdict, 'pass', d.reasons.join('\n'));
  assert.deepEqual(ids(d.satisfiedCriteria), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9']);
  assert.deepEqual(d.violatedCriteria, []);
  assert.deepEqual(d.unknownCriteria, []);
  assert.equal(d.requiresHumanReview, false);
  assert.equal(d.decisionId, 'dec_2');
  assert.equal(d.runId, RUN);
  assert.equal(d.revision, 1);
  assert.equal(d.gateId, 'hypertest.default');
  assert.deepEqual(d.scope, { description: run.goal, objectiveIds: ['obj_p1', 'obj_p3'] });
  assert.equal(d.systemModelRevision, 3);
  assert.deepEqual(d.oracleRevisions, { or_cart: 2 });
  assert.deepEqual(d.experimentRevisions, { exp_1: 2 });
  assert.equal(d.evidenceRootHash, 'root_abc');
  assert.equal(d.evidenceCount, 4);
  assert.deepEqual(d.unresolvedFindings, []);
  assert.deepEqual(d.unresolvedRisks, []);
  assert.deepEqual(d.exceptions, []);
  assert.deepEqual(d.reviewerDecisions, [{ reviewRecordId: 'rec_rev_1', reviewerAgentId: 'agent_reviewer', verdict: 'approve', modelProvider: 'anthropic' }]);
  assert.equal(d.runtimeManifestId, 'rm_1');
  assert.equal(d.policyRevision, 'builtin@1');
  assert.equal(d.decidedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(d.reasons.at(-1), 'verdict pass: all criteria satisfied');
  assert.deepEqual(criterion(d, 'C3').evidenceRefs, ['ev_api', 'ev_metric', 'ev_tests']);
});

test('determinism: same input ⇒ identical decision; input order does not matter', () => {
  const a = gate.evaluate(baseline());
  const b = gate.evaluate(baseline());
  assert.deepEqual(a, b);
  const shuffled = baseline();
  shuffled.evidence.reverse();
  shuffled.findings.reverse();
  shuffled.reviews = [review('rec_rev_2', { verdict: 'approve' }, 'agent_r2'), ...shuffled.reviews];
  const x = gate.evaluate({ ...shuffled, reviews: [...shuffled.reviews].reverse() });
  const y = gate.evaluate(shuffled);
  assert.deepEqual(x, y);
  const input = baseline();
  const frozen = JSON.stringify(input);
  gate.evaluate(input);
  assert.equal(JSON.stringify(input), frozen, 'the gate does not mutate its input');
});

// ----------------------------------------------------------------------------- C1

test('C1: evidence root count mismatch ⇒ unknown ⇒ inconclusive (not waivable)', () => {
  const input = { ...baseline(), evidenceRoot: { rootHash: 'root_abc', count: 5 } };
  input.exceptions = [{ criterionId: 'C1', approvedBy: { kind: 'human', id: 'u' }, rationale: 'trust me' }];
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'inconclusive');
  assert.deepEqual(ids(d.unknownCriteria), ['C1']);
  assert.ok(d.reasons.includes('exception for C1 evidence_integrity ignored (not waivable)'));
  assert.deepEqual(d.exceptions, []);
});

test('C1: pass is impossible with zero evidence, even with a permissive gate', () => {
  const permissive: GateSpec = { ...DEFAULT_GATE_SPEC, requiredEvidence: [], requireIndependentReview: false };
  const d = gate.evaluate({ ...baseline(), gate: permissive, oracles: [], claims: [], workItems: [], evidence: [], evidenceRoot: { rootHash: 'empty', count: 0 } });
  assert.equal(d.verdict, 'inconclusive');
  assert.deepEqual(ids(d.unknownCriteria), ['C1']);
  assert.ok(d.reasons.includes('C1 no evidence recorded'));
});

test('C1: evidence from another run ⇒ unknown and ignored', () => {
  const input = baseline();
  input.evidence.push(testResult('ev_foreign', 9, [{ id: 'cart > total', name: 'total', status: 'failed' }], { runId: 'run_other' }));
  input.evidenceRoot = { rootHash: 'r', count: input.evidence.length };
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'inconclusive');
  assert.deepEqual(ids(d.unknownCriteria), ['C1']);
  assert.equal(criterion(d, 'C3').status, 'satisfied', 'foreign evidence does not count for oracles');
});

// ----------------------------------------------------------------------------- C2

test('C2: an unresolved P1 product defect ⇒ violated ⇒ fail', () => {
  const input = baseline();
  input.findings.push(finding('rec_f_bug', { severity: 'P1', category: 'product_defect', status: 'confirmed' }));
  input.findings.push(finding('rec_f_sec', { severity: 'P0', category: 'security', status: 'open' }, { evidenceRefs: [] }));
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'fail');
  assert.deepEqual(ids(d.violatedCriteria), ['C2']);
  assert.deepEqual(d.unresolvedFindings, ['rec_f_bug', 'rec_f_sec']);
  assert.ok(d.reasons.includes('C2 unevidenced finding rec_f_sec (still blocking)'));
  assert.equal(d.reasons.at(-1), 'verdict fail: violated C2');
});

test('C2: fixed-but-unverified still blocks; verified_fixed / below-threshold / duplicate do not; latest version wins', () => {
  const blocked = baseline();
  blocked.findings.push(finding('rec_f_fixed', { status: 'fixed' }));
  assert.equal(gate.evaluate(blocked).verdict, 'fail');
  const ok = baseline();
  ok.findings.push(finding('rec_f_v', { status: 'verified_fixed' }), finding('rec_f_p2', { severity: 'P2' }), finding('rec_f_dup', { status: 'duplicate' }));
  ok.findings.push(finding('rec_f_old', { status: 'open' }, { lineageId: 'lin_1', version: 1 }), finding('rec_f_new', { status: 'verified_fixed' }, { lineageId: 'lin_1', version: 2, supersedes: 'rec_f_old' }));
  const d = gate.evaluate(ok);
  assert.equal(d.verdict, 'pass', d.reasons.join('\n'));
  assert.deepEqual(d.unresolvedFindings, []);
});

test('C2: an unresolved P1 test-infrastructure finding casts doubt ⇒ unknown ⇒ inconclusive', () => {
  const input = baseline();
  input.findings.push(finding('rec_f_infra', { category: 'infrastructure', severity: 'P1' }));
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'inconclusive');
  assert.deepEqual(ids(d.unknownCriteria), ['C2']);
  assert.deepEqual(d.unresolvedFindings, []);
});

// ----------------------------------------------------------------------------- C3

test('C3: a failing critical test ⇒ violated ⇒ fail', () => {
  const input = baseline();
  input.evidence[0] = testResult('ev_tests', 1, [{ id: 'cart > total', name: 'total', status: 'failed' }], { workItemId: 'wi_exec' });
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'fail');
  assert.deepEqual(ids(d.violatedCriteria), ['C3']);
  assert.ok(d.reasons.some((r) => r.startsWith('C3 or_cart@2/a_total (P1) violated: cart > total: failed')));
});

test('C3: metric threshold and evidence predicate violations ⇒ fail', () => {
  const slow = baseline();
  slow.evidence[1] = ev('ev_metric', 2, 'metric', { metric: 'http_latency_ms', p95: 450 });
  assert.equal(gate.evaluate(slow).verdict, 'fail');
  const errors = baseline();
  errors.evidence.push(ev('ev_api_500', 5, 'api-response', { method: 'POST', path: '/cart', status: 503 }));
  errors.evidenceRoot.count = errors.evidence.length;
  const d = gate.evaluate(errors);
  assert.equal(d.verdict, 'fail');
  assert.deepEqual(criterion(d, 'C3').evidenceRefs.includes('ev_api_500'), true);
});

test('C3: no supporting evidence for a critical assertion ⇒ unknown ⇒ inconclusive', () => {
  const input = baseline();
  input.evidence[1] = ev('ev_metric', 2, 'metric', { metric: 'cpu_percent', p95: 10 });
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'inconclusive');
  assert.deepEqual(ids(d.unknownCriteria), ['C3']);
  assert.ok(d.reasons.some((r) => r.includes('no metric evidence for http_latency_ms.p95')));
});

test('I7 — C3: a P0/P1 assertion supported only by an LLM judgement ⇒ inconclusive, even with an approving review', () => {
  const input = baseline();
  const llmCritical: OracleAssertion = { assertionId: 'a_ux', description: 'checkout is understandable', kind: 'llm_semantic', severity: 'P1', check: { type: 'llm_rubric', rubric: 'clear' } };
  input.oracles = [oracle([P1_TEST, llmCritical])];
  input.reviews.push(review('rec_rev_llm', { verdict: 'approve', rationale: 'LLM judge says it is clear' }, 'agent_judge'));
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'inconclusive');
  assert.deepEqual(ids(d.unknownCriteria), ['C3']);
  assert.ok(d.reasons.includes('C3 or_cart@2/a_ux (P1): only LLM/semantic support; deterministic evidence required'));
  // a deterministic check on an llm_semantic assertion is still treated as LLM-only (conservative)
  input.oracles = [oracle([{ ...llmCritical, check: P1_TEST.check! }])];
  assert.equal(gate.evaluate(input).verdict, 'inconclusive');
  // a critical assertion with no machine-checkable check is unproven
  input.oracles = [oracle([{ assertionId: 'a_nocheck', description: 'x', kind: 'requirement', severity: 'P0' }])];
  assert.equal(gate.evaluate(input).verdict, 'inconclusive');
});

test('C3: evidence from a non-eligible generated test does not count', () => {
  const generated: TestArtifact = {
    artifactId: 'ta_gen', runId: RUN, revision: 1, path: 'test/gen.test.ts', artifactDigest: 'd', sourceType: 'generated', oracleRefs: [], runner: { framework: 'node_test', selector: 'x' },
    validations: { knownGood: { status: 'passed', evidenceRefs: [] } }, approvalState: 'validated', createdAt: '2026-01-01T00:00:00.000Z',
  };
  const input = baseline();
  input.testArtifacts = [generated];
  input.evidence[0] = testResult('ev_tests', 1, [{ id: 'cart > total', name: 'total', status: 'passed' }], { workItemId: 'wi_exec', structured: { testArtifactId: 'ta_gen', cases: [{ id: 'cart > total', name: 'total', status: 'passed' }] } });
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'inconclusive');
  assert.deepEqual(ids(d.unknownCriteria), ['C3', 'C4']);
  assert.ok(d.reasons.some((r) => r.startsWith('ignored evidence from ineligible generated tests: ev_tests (test artifact ta_gen not eligible)')));
  // once the generated test demonstrated sensitivity (fails on known-bad code) its evidence counts
  input.testArtifacts = [generated, { ...generated, revision: 2, validations: { ...generated.validations, knownBad: { status: 'passed', evidenceRefs: ['ev_kb'] } } }];
  assert.equal(gate.evaluate(input).verdict, 'pass');
  // evidence pointing at an unknown artifact is ignored as well
  input.testArtifacts = [];
  assert.equal(gate.evaluate(input).verdict, 'inconclusive');
});

test('C3: the latest build decides; a failure on the same build as a pass is a violation (no flake laundering)', () => {
  const fixed = baseline();
  fixed.evidence[0] = testResult('ev_tests', 1, [{ id: 'cart > total', name: 'total', status: 'failed' }], { workItemId: 'wi_exec', provenance: { commit: 'aaa' } });
  fixed.evidence.push(testResult('ev_tests_2', 5, [{ id: 'cart > total', name: 'total', status: 'passed' }], { workItemId: 'wi_exec', provenance: { commit: 'bbb' } }));
  fixed.evidenceRoot.count = fixed.evidence.length;
  assert.equal(gate.evaluate(fixed).verdict, 'pass');
  const flaky = baseline();
  flaky.evidence[0] = testResult('ev_tests', 1, [{ id: 'cart > total', name: 'total', status: 'failed' }], { workItemId: 'wi_exec', provenance: { commit: 'bbb' } });
  flaky.evidence.push(testResult('ev_tests_2', 5, [{ id: 'cart > total', name: 'total', status: 'passed' }], { workItemId: 'wi_exec', provenance: { commit: 'bbb' } }));
  flaky.evidenceRoot.count = flaky.evidence.length;
  assert.equal(gate.evaluate(flaky).verdict, 'fail');
});

test('C3: evidence without a build identity belongs to the build current when it was recorded — it can never hide the latest build\'s failure', () => {
  // black-box evidence carries the environment it was captured in (and its build digest); a request that names no
  // registered environment (a raw URL, another host) has no build identity. Recorded AFTER the failing exchange on build
  // b-2, it must not become "the latest build" on its own and take the failure out of the gate's view.
  const B1: OracleAssertion = { assertionId: 'a_neg', description: 'negative transfers are rejected', kind: 'requirement', severity: 'P1', check: { type: 'http_expectation', method: 'POST', path: '/transfers', expectStatus: 400 } };
  const deployed = { environmentId: 'bank', environmentClass: 'sandbox', generation: 2, buildDigest: 'b-2' };
  const escape = baseline();
  escape.oracles = [oracle([P1_TEST, B1])];
  escape.evidence.push(
    ev('ev_on_build', 10, 'api-response', { method: 'POST', path: '/transfers', status: 201 }, { environment: deployed }),
    ev('ev_no_build', 11, 'api-response', { method: 'POST', path: '/transfers', status: 400 }),
  );
  escape.evidenceRoot.count = escape.evidence.length;
  let d = gate.evaluate(escape);
  assert.equal(d.verdict, 'fail');
  assert.ok(d.reasons.includes('C3 or_cart@2/a_neg (P1) violated: POST /transfers expectation violated'), d.reasons.join('\n'));
  // the latest build still wins over an OLDER build: before the deploy of b-3 the endpoint failed (unidentified and on
  // b-2); after it, it passes — the fix is judged on b-3 and on what was recorded while b-3 was current
  const fixed = baseline();
  fixed.oracles = [oracle([P1_TEST, B1])];
  fixed.evidence.push(
    ev('ev_before', 10, 'api-response', { method: 'POST', path: '/transfers', status: 201 }),
    ev('ev_old_build', 11, 'api-response', { method: 'POST', path: '/transfers', status: 201 }, { environment: deployed }),
    ev('ev_new_build', 12, 'api-response', { method: 'POST', path: '/transfers', status: 400 }, { environment: { ...deployed, generation: 3, buildDigest: 'b-3' } }),
    ev('ev_after', 13, 'api-response', { method: 'POST', path: '/transfers', status: 400 }),
  );
  fixed.evidenceRoot.count = fixed.evidence.length;
  d = gate.evaluate(fixed);
  assert.equal(d.verdict, 'pass', d.reasons.join('\n'));
  // …but a failure recorded while b-3 is current (no build identity of its own) is a failure of b-3
  fixed.evidence.push(ev('ev_after_fail', 14, 'api-response', { method: 'POST', path: '/transfers', status: 201 }));
  fixed.evidenceRoot.count = fixed.evidence.length;
  assert.equal(gate.evaluate(fixed).verdict, 'fail');
  // with no build identity anywhere, everything is judged (as before)
  const plain = baseline();
  plain.oracles = [oracle([P1_TEST, B1])];
  plain.evidence.push(ev('ev_p1', 10, 'api-response', { method: 'POST', path: '/transfers', status: 201 }), ev('ev_p2', 11, 'api-response', { method: 'POST', path: '/transfers', status: 400 }));
  plain.evidenceRoot.count = plain.evidence.length;
  assert.equal(gate.evaluate(plain).verdict, 'fail');
});

test('C3: PASS/FAIL/XFAIL/SKIP stay distinct (xfail violates; skip and harness errors are unproven)', () => {
  for (const [status, verdict] of [['xfail', 'fail'], ['skipped', 'inconclusive'], ['error', 'inconclusive'], ['xpass', 'inconclusive']] as const) {
    const input = baseline();
    input.evidence[0] = testResult('ev_tests', 1, [{ id: 'cart > total', name: 'total', status }], { workItemId: 'wi_exec' });
    assert.equal(gate.evaluate(input).verdict, verdict, status);
  }
});

test('C3: only the latest approved oracle revision is evaluated', () => {
  const input = baseline();
  input.oracles = [oracle([P1_TEST], { revision: 3, status: 'draft' }), oracle([P1_TEST, { ...P1_ERRORS, assertionId: 'a_old' }], { revision: 1 }), oracle([P1_TEST], { revision: 2 })];
  const d = gate.evaluate(input);
  assert.deepEqual(d.oracleRevisions, { or_cart: 2 });
  assert.equal(criterion(d, 'C3').detail, '1 critical assertions: 0 violated, 0 unproven');
});

// ----------------------------------------------------------------------------- C4

test('C4: missing gate-required evidence ⇒ unknown ⇒ inconclusive', () => {
  const input = baseline();
  input.gate = { ...input.gate, requiredEvidence: [{ evidenceType: 'test-result', minCount: 2, critical: true }] };
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'inconclusive');
  assert.deepEqual(ids(d.unknownCriteria), ['C4']);
  assert.ok(d.reasons.includes('C4 gate requires 2× test-result: found 1'));
});

test('C4: critical work-item evidence requirements are checked per work item; non-critical and cancelled ones are not', () => {
  const input = baseline();
  input.workItems.push(workItem('wi_perf', { evidenceRequirements: [{ evidenceType: 'metric', minCount: 1, critical: true }] }));
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'inconclusive');
  assert.ok(d.reasons.includes('C4 work item wi_perf requires 1× metric: found 0'));
  const ok = baseline();
  ok.workItems.push(workItem('wi_soft', { evidenceRequirements: [{ evidenceType: 'trace', minCount: 1 }] }), workItem('wi_gone', { state: 'cancelled', evidenceRequirements: [{ evidenceType: 'trace', minCount: 1, critical: true }] }));
  assert.equal(gate.evaluate(ok).verdict, 'pass');
});

// ----------------------------------------------------------------------------- C5

test('C5: failed or unfinished work for an open P0/P1 objective ⇒ unknown ⇒ inconclusive', () => {
  const failed = baseline();
  failed.workItems.push(workItem('wi_fail', { state: 'failed', failure: { reason: 'budget_exhausted', message: 'tokens' } }));
  const d = gate.evaluate(failed);
  assert.equal(d.verdict, 'inconclusive');
  assert.deepEqual(ids(d.unknownCriteria), ['C5']);
  assert.ok(d.reasons.includes('C5 work item wi_fail failed (budget_exhausted: tokens) for open critical objective(s) obj_p1'));
  const running = baseline();
  running.workItems.push(workItem('wi_run', { state: 'running' }));
  assert.equal(gate.evaluate(running).verdict, 'inconclusive');
  const minor = baseline();
  minor.workItems.push(workItem('wi_minor', { state: 'failed', objectiveIds: ['obj_p3'] }), workItem('wi_cancel', { state: 'cancelled' }));
  assert.equal(gate.evaluate(minor).verdict, 'pass');
});

// ----------------------------------------------------------------------------- C6

test('C6: an independent reject ⇒ conditional + human review', () => {
  const input = baseline();
  input.reviews = [review('rec_rev_1', {}), review('rec_rev_rej', { verdict: 'reject', rationale: 'evidence does not cover refunds' }, 'agent_r2')];
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'conditional');
  assert.equal(d.requiresHumanReview, true);
  assert.deepEqual(ids(d.violatedCriteria), ['C6']);
  assert.ok(d.reasons.includes('C6 review rec_rev_rej rejected: evidence does not cover refunds'));
});

test('C6: needs_more_evidence ⇒ inconclusive', () => {
  const input = baseline();
  input.reviews = [review('rec_rev_more', { verdict: 'needs_more_evidence', rationale: 'no load test' })];
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'inconclusive');
  assert.deepEqual(ids(d.unknownCriteria), ['C6']);
});

test('C6: no review ⇒ conditional + human review; a same-provider approval is not independent', () => {
  const none = baseline();
  none.reviews = [];
  const d = gate.evaluate(none);
  assert.equal(d.verdict, 'conditional');
  assert.equal(d.requiresHumanReview, true);
  const same = baseline();
  same.reviews = [review('rec_rev_same', { modelProvider: 'openai' })];
  const s = gate.evaluate(same);
  assert.equal(s.verdict, 'conditional');
  assert.ok(s.reasons.includes('C6 review rec_rev_same not independent (provider openai also produced findings/tests)'));
  const noProvider = baseline();
  noProvider.reviews = [review('rec_rev_anon', { modelProvider: undefined as never })];
  delete noProvider.reviews[0]!.payload.modelProvider;
  assert.equal(gate.evaluate(noProvider).verdict, 'conditional');
  const otherSubject = baseline();
  otherSubject.reviews = [review('rec_rev_wi', { subjectRef: { kind: 'work_item', id: 'wi_exec' } })];
  assert.equal(gate.evaluate(otherSubject).verdict, 'conditional', 'a review of a work item is not a review of the run/decision');
});

test('C6: a review of the run subject counts; not required ⇒ satisfied', () => {
  const runReview = baseline();
  runReview.reviews = [review('rec_rev_run', { subjectRef: { kind: 'run' as never, id: RUN } })];
  assert.equal(gate.evaluate(runReview).verdict, 'pass');
  const notRequired = baseline();
  notRequired.reviews = [];
  notRequired.gate = { ...notRequired.gate, requireIndependentReview: false };
  const d = gate.evaluate(notRequired);
  assert.equal(d.verdict, 'pass');
  assert.equal(d.requiresHumanReview, false);
});

// ----------------------------------------------------------------------------- C7

test('C7: an open risk at/above the gate level ⇒ conditional; mitigated or lower risks do not', () => {
  const input = baseline();
  input.risks.push(risk('rec_r_high', { level: 'high' }));
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'conditional');
  assert.deepEqual(d.unresolvedRisks, ['rec_r_high']);
  assert.deepEqual(ids(d.violatedCriteria), ['C7']);
  assert.equal(d.requiresHumanReview, false);
  const ok = baseline();
  ok.risks.push(risk('rec_r_mit', { level: 'critical', status: 'mitigated' }));
  assert.equal(gate.evaluate(ok).verdict, 'pass');
});

// ----------------------------------------------------------------------------- C8

test('C8: coverage below the threshold ⇒ fail; percentages accepted', () => {
  const input = baseline();
  input.gate = { ...input.gate, minCoverage: { lines: 95 } };
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'fail');
  assert.deepEqual(ids(d.violatedCriteria), ['C8']);
  assert.ok(d.reasons.includes('C8 lines coverage 90.00% < 95.00% (ev_cov)'));
  input.gate = { ...input.gate, minCoverage: { lines: 0.9, branches: 0.7 } };
  assert.equal(gate.evaluate(input).verdict, 'pass');
});

test('C8: no coverage evidence, or unknown branch totals ⇒ inconclusive', () => {
  const none = baseline();
  none.evidence = none.evidence.filter((e) => e.evidenceType !== 'coverage');
  none.evidenceRoot.count = none.evidence.length;
  const d = gate.evaluate(none);
  assert.equal(d.verdict, 'inconclusive');
  assert.deepEqual(ids(d.unknownCriteria), ['C8']);
  const branches = baseline();
  branches.gate = { ...branches.gate, minCoverage: { branches: 0.5 } };
  branches.evidence[3] = ev('ev_cov', 4, 'coverage', { totals: { lines: { covered: 90, total: 100 }, branches: 'unknown' } });
  assert.equal(gate.evaluate(branches).verdict, 'inconclusive');
});

// ----------------------------------------------------------------------------- C9

test('C9: critical claims without resolvable evidence ⇒ inconclusive', () => {
  const noRefs = baseline();
  noRefs.claims.push({ claimId: 'cl_2', statement: 'no regressions', evidenceQuery: {}, evidenceRefs: [], critical: true });
  const d = gate.evaluate(noRefs);
  assert.equal(d.verdict, 'inconclusive');
  assert.deepEqual(ids(d.unknownCriteria), ['C9']);
  const dangling = baseline();
  dangling.claims = [{ claimId: 'cl_3', statement: 'TPS 100k', evidenceQuery: {}, evidenceRefs: ['ev_missing'], critical: true }];
  assert.ok(gate.evaluate(dangling).reasons.includes('C9 critical claim cl_3 cites unknown evidence ev_missing'));
  const nonCritical = baseline();
  nonCritical.claims.push({ claimId: 'cl_4', statement: 'nice', evidenceQuery: {}, evidenceRefs: [], critical: false } as ReportClaim);
  assert.equal(gate.evaluate(nonCritical).verdict, 'pass');
});

// ----------------------------------------------------------------------------- precedence + exceptions

test('precedence: fail > inconclusive > conditional > pass', () => {
  const all = baseline();
  all.findings.push(finding('rec_f_bug', {}));
  all.claims.push({ claimId: 'cl_x', statement: 'x', evidenceQuery: {}, evidenceRefs: [], critical: true });
  all.risks.push(risk('rec_r_high', {}));
  const d = gate.evaluate(all);
  assert.equal(d.verdict, 'fail');
  assert.deepEqual(ids(d.violatedCriteria), ['C2', 'C7']);
  assert.deepEqual(ids(d.unknownCriteria), ['C9']);
  all.findings.pop();
  assert.equal(gate.evaluate(all).verdict, 'inconclusive');
  all.claims.pop();
  assert.equal(gate.evaluate(all).verdict, 'conditional');
  all.risks.pop();
  assert.equal(gate.evaluate(all).verdict, 'pass');
});

test('exceptions: an unexpired human exception waives its criterion (by id or name); recorded on the decision', () => {
  const input = baseline();
  input.risks.push(risk('rec_r_high', {}));
  input.exceptions = [{ criterionId: 'unresolved_risks', approvedBy: { kind: 'human', id: 'user_po' }, rationale: 'accepted for beta', expiresAt: '2026-03-01T00:00:00.000Z' }];
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'pass');
  assert.deepEqual(d.exceptions, input.exceptions);
  assert.match(criterion(d, 'C7').detail!, /^waived by exception \(human:user_po: accepted for beta\); original status violated/);
  assert.ok(d.reasons.includes('C7 waived by human:user_po: accepted for beta'));
});

test('exceptions: expired or agent-approved exceptions are ignored', () => {
  const expired = baseline();
  expired.risks.push(risk('rec_r_high', {}));
  expired.exceptions = [{ criterionId: 'C7', approvedBy: { kind: 'human', id: 'u' }, rationale: 'old', expiresAt: '2026-01-15T00:00:00.000Z' }];
  const d = gate.evaluate(expired);
  assert.equal(d.verdict, 'conditional');
  assert.ok(d.reasons.includes('exception for C7 expired at 2026-01-15T00:00:00.000Z'));
  const byAgent = baseline();
  byAgent.findings.push(finding('rec_f_bug', {}));
  byAgent.exceptions = [{ criterionId: 'C2', approvedBy: { kind: 'agent', id: 'agent_exec' }, rationale: 'not a real bug' }];
  const a = gate.evaluate(byAgent);
  assert.equal(a.verdict, 'fail');
  assert.deepEqual(a.exceptions, []);
  assert.ok(a.reasons.includes('exception for C2 approved by agent agent_exec ignored'));
});

test('exceptions: waiving the review criterion clears the human-review demand; waiving one criterion leaves the others', () => {
  const input = baseline();
  input.reviews = [];
  input.findings.push(finding('rec_f_bug', {}));
  input.exceptions = [{ criterionId: 'C6', approvedBy: { kind: 'human', id: 'u' }, rationale: 'reviewed in person' }];
  const d = gate.evaluate(input);
  assert.equal(d.verdict, 'fail');
  assert.equal(d.requiresHumanReview, false);
  assert.deepEqual(ids(d.violatedCriteria), ['C2']);
});

test('DEFAULT_GATE_SPEC matches the documented defaults', () => {
  assert.equal(DEFAULT_GATE_SPEC.failOnUnresolvedSeverity, 'P1');
  assert.equal(DEFAULT_GATE_SPEC.conditionalOnRiskLevel, 'high');
  assert.deepEqual(DEFAULT_GATE_SPEC.requiredEvidence, [{ evidenceType: 'test-result', minCount: 1, critical: true }]);
  assert.equal(DEFAULT_GATE_SPEC.requireDeterministicForCritical, true);
  assert.equal(DEFAULT_GATE_SPEC.requireIndependentReview, true);
});

test('I7: pass is impossible when every evidence record comes from an ineligible generated test (permissive gate)', () => {
  const permissive: GateSpec = { ...DEFAULT_GATE_SPEC, requiredEvidence: [], requireIndependentReview: false };
  const draft: TestArtifact = {
    artifactId: 'ta_draft', runId: RUN, revision: 1, path: 'test/gen.test.ts', artifactDigest: 'd', sourceType: 'generated', oracleRefs: [], runner: { framework: 'node_test', selector: 'x' },
    validations: {}, approvalState: 'draft', createdAt: '2026-01-01T00:00:00.000Z',
  };
  const evidence = [testResult('ev_gen', 1, [{ id: 'x', name: 'x', status: 'passed' }], { structured: { testArtifactId: 'ta_draft', cases: [{ id: 'x', name: 'x', status: 'passed' }] } })];
  const d = gate.evaluate({ ...baseline(), gate: permissive, oracles: [], claims: [], workItems: [], testArtifacts: [draft], evidence, evidenceRoot: { rootHash: 'r', count: 1 } });
  assert.equal(d.verdict, 'inconclusive');
  assert.deepEqual(ids(d.unknownCriteria), ['C1']);
  assert.ok(d.reasons.includes('C1 no eligible evidence: all 1 run evidence records come from ineligible or unknown generated tests'), d.reasons.join('\n'));
  // C1 stays non-waivable
  const waived = gate.evaluate({ ...baseline(), gate: permissive, oracles: [], claims: [], workItems: [], testArtifacts: [draft], evidence, evidenceRoot: { rootHash: 'r', count: 1 }, exceptions: [{ criterionId: 'C1', approvedBy: { kind: 'human', id: 'u' }, rationale: 'x' }] });
  assert.equal(waived.verdict, 'inconclusive');
});
