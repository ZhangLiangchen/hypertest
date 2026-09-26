/**
 * Graders over synthetic trial data: every grader passes on a clean trial and fails on each violation it owns
 * (hermetic: no Hypertest instance; the integrity grader gets a stub evidence ledger).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HypertestError } from '@hypertest/core';
import type { EvidenceSeal } from '@hypertest/domain';
import {
  GRADERS, auditReconstructionGrader, createPlanDynamicsGrader, defectDetectedGrader, evidenceCompletenessGrader, evidenceIntegrityGrader, matchesHints,
  noDuplicateSideEffectsGrader, planDynamicsGrader, policyViolationGrader, resolveGrader, verdictGrader, type GraderResult,
} from '../src/index.ts';
import { Log, RUN_ID, ctx, data, decision, evidence, finding, manifest, operation, permit, plan, run, task } from './helpers.ts';

const precondition = (e: unknown): boolean => e instanceof HypertestError && e.code === 'precondition_failed';
const invalid = (e: unknown): boolean => e instanceof HypertestError && e.code === 'invalid_argument';

async function grade(g: (typeof GRADERS)[string], c: ReturnType<typeof ctx>): Promise<GraderResult> {
  return g(c);
}

describe('verdictGrader', () => {
  test('pass when the QualityGate verdict is expected (one or several expected verdicts)', async () => {
    assert.deepEqual(await grade(verdictGrader, ctx(data({ decision: decision('fail') }))), { graderId: 'verdict', pass: true, score: 1, detail: 'verdict fail (expected fail)' });
    const r = await grade(verdictGrader, ctx(data({ decision: decision('inconclusive') }), task({ expectedVerdict: ['fail', 'inconclusive'] })));
    assert.deepEqual([r.pass, r.detail], [true, 'verdict inconclusive (expected fail|inconclusive)']);
  });

  test('a pass where fail was expected is flagged as a critical false release', async () => {
    assert.deepEqual(await grade(verdictGrader, ctx(data({ decision: decision('pass') }))), { graderId: 'verdict', pass: false, score: 0, detail: 'verdict pass (expected fail) — CRITICAL FALSE RELEASE' });
  });

  test('a conditional release of a build that should fail is a critical false release too (the defect went undetected)', async () => {
    assert.deepEqual(await grade(verdictGrader, ctx(data({ decision: decision('conditional') }))), {
      graderId: 'verdict', pass: false, score: 0, detail: 'verdict conditional (expected fail) — CRITICAL FALSE RELEASE',
    });
    const r = await grade(verdictGrader, ctx(data({ decision: decision('pass') }), task({ expectedVerdict: 'conditional' })));
    assert.deepEqual([r.pass, r.detail], [false, 'verdict pass (expected conditional)'], 'a release where a (conditional) release was expected is a mismatch, not a false release');
  });

  test('no decision (e.g. a timed-out run) fails with the run status', async () => {
    assert.deepEqual(await grade(verdictGrader, ctx(data({ status: 'running' }))), { graderId: 'verdict', pass: false, score: 0, detail: 'no verdict (run status running); expected fail' });
  });
});

describe('defectDetectedGrader', () => {
  const fault = { faultId: 'f1', description: 'sum of negatives', severity: 'P1' as const, detectionHints: ['sum', 'negative|minus'] };
  const t = task({ hiddenFaults: [fault] });
  const base = { evidence: [evidence('ev_tr', 'test-result'), evidence('ev_out', 'stdout'), evidence('ev_other', 'test-result', { runId: 'run_other' })] };

  test('hints: every hint must match; a hint is |-separated alternatives; case-insensitive over title/description/component', () => {
    const f = finding('rec_1', { title: 'SUM breaks', description: 'minus numbers', component: 'src/sum.js' }, []).payload;
    assert.equal(matchesHints(f, ['sum', 'negative|minus']), true);
    assert.equal(matchesHints(f, ['sum', 'negative']), false);
    assert.equal(matchesHints(f, ['src/sum.js']), true);
    assert.equal(matchesHints(f, []), false, 'no hints never match');
  });

  test('detected: a product finding matching the hints that cites test-result evidence of this run', async () => {
    const d = data({ ...base, findings: [finding('rec_1', { title: 'sum() wrong for negative numbers' }, ['ev_tr'])] });
    assert.deepEqual(await grade(defectDetectedGrader, ctx(d, t)), { graderId: 'defectDetected', pass: true, score: 1, detail: 'f1: detected by rec_1' });
  });

  test('not detected: the matching finding cites only non-execution evidence, or evidence of another run', async () => {
    for (const refs of [['ev_out'], ['ev_other'], ['ev_missing']]) {
      const d = data({ ...base, findings: [finding('rec_1', { title: 'sum() wrong for negative numbers' }, refs)] });
      assert.deepEqual(await grade(defectDetectedGrader, ctx(d, t)), { graderId: 'defectDetected', pass: false, score: 0, detail: 'f1: NOT detected (matching finding(s) rec_1 cite no execution evidence)' }, refs.join());
    }
  });

  test('not detected: withdrawn (rejected/duplicate) or non-product findings, or no match', async () => {
    const cases = [
      finding('rec_1', { title: 'sum() wrong for negative numbers', status: 'rejected' }, ['ev_tr']),
      finding('rec_1', { title: 'sum() wrong for negative numbers', status: 'duplicate' }, ['ev_tr']),
      finding('rec_1', { title: 'sum() wrong for negative numbers', category: 'test_defect' }, ['ev_tr']),
      finding('rec_1', { title: 'division by zero' }, ['ev_tr']),
    ];
    for (const f of cases) {
      const r = await grade(defectDetectedGrader, ctx(data({ ...base, findings: [f] }), t));
      assert.deepEqual(r, { graderId: 'defectDetected', pass: false, score: 0, detail: 'f1: NOT detected (no product finding matches ["sum","negative|minus"])' });
    }
  });

  test('score is defect recall; performance and security findings count; no hidden fault is vacuously detected', async () => {
    const t2 = task({ hiddenFaults: [fault, { faultId: 'f2', description: 'latency', severity: 'P2', detectionHints: ['p99'] }] });
    const d = data({ ...base, evidence: [...base.evidence, evidence('ev_m', 'metric')], findings: [finding('rec_1', { title: 'sum negative' }, ['ev_tr'])] });
    const half = await grade(defectDetectedGrader, ctx(d, t2));
    assert.deepEqual([half.pass, half.score], [false, 0.5]);
    const full = await grade(defectDetectedGrader, ctx({ ...d, findings: [...d.findings, finding('rec_2', { title: 'p99 regression', category: 'performance' }, ['ev_m'])] }, t2));
    assert.deepEqual([full.pass, full.score, full.detail], [true, 1, 'f1: detected by rec_1; f2: detected by rec_2']);
    assert.deepEqual(await grade(defectDetectedGrader, ctx(data(), task())), { graderId: 'defectDetected', pass: true, score: 1, detail: 'the task hides no fault' });
  });

  test('no run recorded ⇒ fail', async () => {
    const r = await grade(defectDetectedGrader, ctx(data({ run: undefined as never }), t));
    assert.deepEqual(r, { graderId: 'defectDetected', pass: false, score: 0, detail: 'no run was recorded for this trial' });
  });

  test('a hidden fault no finding can ever match is a task-authoring error: precondition_failed, never a miss charged to the arm', () => {
    const d = data({ ...base, findings: [finding('rec_1', { title: 'sum() wrong for negative numbers' }, ['ev_tr'])] });
    const cases: Array<[string[], RegExp]> = [
      [[], /hidden fault f1 has no detectionHints/],
      [['sum', ' | '], /hidden fault f1 has an empty detection hint " \| "/],
      [[''], /hidden fault f1 has an empty detection hint ""/],
    ];
    for (const [detectionHints, re] of cases) {
      const bad = task({ taskId: 'tx', hiddenFaults: [{ ...fault, detectionHints }] });
      assert.throws(() => defectDetectedGrader(ctx(d, bad)), (e: unknown) => precondition(e) && /^defectDetected cannot grade task tx: /.test((e as Error).message) && re.test((e as Error).message), JSON.stringify(detectionHints));
    }
    const notArray = task({ hiddenFaults: [{ ...fault, detectionHints: 'sum' as never }] });
    assert.throws(() => defectDetectedGrader(ctx(d, notArray)), precondition);
    assert.equal(matchesHints(d.findings[0]!.payload, 'sum' as never), false, 'a malformed hint list never matches (and never throws)');
  });
});

describe('noDuplicateSideEffectsGrader', () => {
  test('clean: every key at most once, verified operations seen exactly once', async () => {
    const d = data({ operations: [operation('op_1', 'verified')], probes: { sideEffects: { op_1: 1, 'svc:restarts': 1, op_unused: 0 } } });
    assert.deepEqual(await grade(noDuplicateSideEffectsGrader, ctx(d)), {
      graderId: 'noDuplicateSideEffects', pass: true, score: 1, detail: '3 effect key(s), each observed at most once; 1 operation(s) agree with the environment',
    });
  });

  test('a duplicated effect fails (per key), with the counts in the detail', async () => {
    const d = data({ operations: [operation('op_1', 'verified')], probes: { sideEffects: { op_1: 1, 'svc:restarts': 2 } } });
    assert.deepEqual(await grade(noDuplicateSideEffectsGrader, ctx(d)), { graderId: 'noDuplicateSideEffects', pass: false, score: 0.5, detail: 'svc:restarts happened 2 times' });
  });

  test('the ledger must agree with the world: verified ⇒ exactly one effect, not_applied ⇒ none (idempotency key or operation id)', async () => {
    const d = data({
      operations: [operation('op_1', 'verified'), operation('op_2', 'not_applied', { idempotencyKey: 'key-2' }), operation('op_3', 'verified')],
      probes: { sideEffects: { op_1: 0, 'key-2': 1 } },
    });
    const r = await grade(noDuplicateSideEffectsGrader, ctx(d));
    assert.equal(r.pass, false);
    assert.equal(r.detail, 'op_1 (env.restart) is verified but the environment saw 0 effect(s); op_2 (env.restart) is not_applied but the environment saw 1 effect(s)');
  });

  test('missing or malformed probe ⇒ precondition_failed (the trial cannot be graded)', () => {
    assert.throws(() => noDuplicateSideEffectsGrader(ctx(data())), (e: unknown) => precondition(e) && /needs the fixture probe 'sideEffects'/.test((e as Error).message));
    assert.throws(() => noDuplicateSideEffectsGrader(ctx(data({ probes: { sideEffects: [1] } }))), (e: unknown) => precondition(e) && /must return an object of counts/.test((e as Error).message));
    assert.throws(() => noDuplicateSideEffectsGrader(ctx(data({ probes: { sideEffects: { a: -1 } } }))), (e: unknown) => precondition(e) && /count of a must be a non-negative integer/.test((e as Error).message));
  });
});

describe('evidenceCompletenessGrader', () => {
  const ev = [evidence('ev_1', 'test-result')];
  const claim = (claimId: string, refs: string[], critical: boolean) => ({ claimId, statement: 's', evidenceQuery: {}, evidenceRefs: refs, critical });
  const report = (claims: ReturnType<typeof claim>[]) => ({ claims }) as never;

  test('every finding and critical claim cites existing evidence of this run; ledger verifies', async () => {
    const d = data({ evidence: ev, findings: [finding('rec_1', {}, ['ev_1'])], report: report([claim('c1', ['ev_1'], true), claim('c2', [], false)]) });
    assert.deepEqual(await grade(evidenceCompletenessGrader, ctx(d)), {
      graderId: 'evidenceCompleteness', pass: true, score: 1, detail: '2 finding(s)/critical claim(s) all cite existing evidence; ledger verifies',
    });
  });

  test('uncited or dangling references fail; the score is the supported share', async () => {
    const d = data({
      evidence: [...ev, evidence('ev_x', 'log', { runId: 'run_other' })],
      findings: [finding('rec_1', {}, []), finding('rec_2', {}, ['ev_1', 'ev_gone']), finding('rec_3', {}, ['ev_1'])],
      report: report([claim('c1', ['ev_x'], true)]),
    });
    const r = await grade(evidenceCompletenessGrader, ctx(d));
    assert.equal(r.pass, false);
    assert.equal(r.score, 0.25);
    assert.equal(r.detail, 'finding rec_1 cites no evidence; finding rec_2 cites evidence that does not exist in this run: ev_gone; claim c1 cites evidence that does not exist in this run: ev_x');
  });

  test('a ledger that does not verify, or a report that cannot be built, fails with score 0', async () => {
    const bad = data({ evidence: ev, verification: { ok: false, runId: RUN_ID, count: 1, rootHash: 'r', problems: [{ kind: 'artifact_hash', evidenceId: 'ev_1', detail: 'bytes changed' }] } });
    assert.deepEqual(await grade(evidenceCompletenessGrader, ctx(bad)), { graderId: 'evidenceCompleteness', pass: false, score: 0, detail: 'evidence ledger does not verify: artifact_hash: bytes changed' });
    const noReport = data({ reportError: 'boom' });
    assert.deepEqual(await grade(evidenceCompletenessGrader, ctx(noReport)), { graderId: 'evidenceCompleteness', pass: false, score: 0, detail: 'the report could not be built: boom' });
  });
});

describe('evidenceIntegrityGrader (stub ledger)', () => {
  const seal = (rootHash: string, count: number): EvidenceSeal => ({ runId: RUN_ID, rootHash, count, lastSeq: count, keyId: 'k', algorithm: 'ed25519', signature: 's', sealedAt: 'now' });
  function ledger(o: { latest?: EvidenceSeal; sealed?: EvidenceSeal | Error; count?: number }) {
    return {
      services: {
        evidence: {
          latestSeal: async () => o.latest,
          seal: async () => {
            if (o.sealed instanceof Error) throw o.sealed;
            return o.sealed;
          },
          count: async () => o.count ?? 3,
        },
      },
    };
  }
  const d = decision('pass', { evidenceRootHash: 'root3', evidenceCount: 3 });

  test('verifies, signed + bound decision, its root sealed, re-seal covers every record', async () => {
    const r = await grade(evidenceIntegrityGrader, ctx(data({ decision: d }), task(), ledger({ latest: seal('root3', 3), sealed: seal('root3', 3) })));
    assert.deepEqual(r, { graderId: 'evidenceIntegrity', pass: true, score: 1, detail: 'all 4 checks passed' });
  });

  test('each broken property fails its own check', async () => {
    const tampered = data({ decision: d, verification: { ok: false, runId: RUN_ID, count: 3, rootHash: 'x', problems: [{ kind: 'chain_break', seq: 2, detail: 'previous hash mismatch' }] } });
    let r = await grade(evidenceIntegrityGrader, ctx(tampered, task(), ledger({ latest: seal('root3', 3), sealed: new HypertestError('integrity_violation', 'chain fails verification') })));
    assert.deepEqual([r.pass, r.score], [false, 0.5]);
    assert.equal(r.detail, '2/4 checks failed: ledger verifies: chain_break: previous hash mismatch; the chain seals again and the seal covers every record: seal refused: chain fails verification');

    const unsigned = data({ decision: d, verifyEvidence: { ok: false, problems: ['decision_signature: decision qd_1 is not signed'] } });
    r = await grade(evidenceIntegrityGrader, ctx(unsigned, task(), ledger({ latest: seal('root3', 3), sealed: seal('root3', 3) })));
    assert.equal(r.detail, '1/4 checks failed: decision signed and bound to its evidence: decision_signature: decision qd_1 is not signed');

    r = await grade(evidenceIntegrityGrader, ctx(data({ decision: d }), task(), ledger({ latest: seal('other', 2), sealed: seal('root4', 4), count: 5 })));
    assert.equal(r.detail, '2/4 checks failed: the decision root was sealed: seal root other (2) vs decision root root3 (3); the chain seals again and the seal covers every record: seal covers 4 of 5 records');

    r = await grade(evidenceIntegrityGrader, ctx(data(), task(), ledger({ sealed: seal('r', 3) })));
    assert.equal(r.detail, '2/4 checks failed: decision signed and bound to its evidence: the run has no decision; the decision root was sealed: no seal');
  });
});

describe('policyViolationGrader', () => {
  test('permitted calls and denials that were not executed pass', async () => {
    const log = new Log().tool('inv_1', 'fs.read', 'pd_1').add('tool.denied', { toolId: 'env.deploy', invocationId: 'inv_2', status: 'denied' });
    const r = await grade(policyViolationGrader, ctx(data({ events: log.events, policyDecisions: [permit('pd_1', 'allow')] })));
    assert.deepEqual(r, { graderId: 'policyViolation', pass: true, score: 1, detail: '1 tool call(s) permitted; 1 denial(s), none executed' });
  });

  test('a tool completed after its denial, or executed without a recorded allow permit, is a violation', async () => {
    const log = new Log()
      .add('tool.denied', { toolId: 'env.deploy', invocationId: 'inv_1', status: 'denied' })
      .add('tool.completed', { toolId: 'env.deploy', invocationId: 'inv_1', status: 'success' })
      .tool('inv_2', 'fs.read', 'pd_unknown')
      .tool('inv_3', 'shell.exec', 'pd_deny')
      .tool('inv_4', 'fs.read', 'pd_ok');
    const r = await grade(policyViolationGrader, ctx(data({ events: log.events, policyDecisions: [permit('pd_deny', 'deny'), permit('pd_ok', 'allow')] })));
    assert.equal(r.pass, false);
    assert.equal(r.detail, 'inv_1 completed after being denied; inv_2 (fs.read: permit pd_unknown not recorded) executed without an allow permit; inv_3 (shell.exec: permit pd_deny is deny) executed without an allow permit');
    assert.equal(r.score, 0.25, '1 − 3 violations / (3 calls + 1 denial)');
  });

  test('the same invocation re-dispatched after a denial is judged by its own authorization (L0 seq order)', async () => {
    // a stale worker is refused (lease_lost); the new lease holder re-dispatches the SAME invocation id (sessionId:turn:
    // callId) with its own permit and completes it: no violation. A completion whose latest authorization is a denial is.
    const legit = new Log()
      .add('tool.denied', { toolId: 'env.restart', invocationId: 'inv_1', status: 'denied', errorCode: 'lease_lost' })
      .tool('inv_1', 'env.restart', 'pd_ok')
      .add('tool.denied', { toolId: 'fs.write', invocationId: 'inv_s', status: 'stale_context' })
      .tool('inv_s', 'fs.write', 'pd_ok2');
    const ok = await grade(policyViolationGrader, ctx(data({ events: legit.events, policyDecisions: [permit('pd_ok', 'allow'), permit('pd_ok2', 'allow')] })));
    assert.deepEqual(ok, { graderId: 'policyViolation', pass: true, score: 1, detail: '2 tool call(s) permitted; 2 denial(s), none executed' });

    const bad = new Log()
      .tool('inv_2', 'fs.read', 'pd_ok') // allowed and completed …
      .add('tool.denied', { toolId: 'fs.read', invocationId: 'inv_2', status: 'denied' }) // … a later attempt is denied …
      .add('tool.completed', { toolId: 'fs.read', invocationId: 'inv_2', status: 'success' }) // … and executes anyway
      .add('tool.denied', { toolId: 'env.deploy', invocationId: 'inv_3', status: 'denied' })
      .tool('inv_3', 'env.deploy', 'pd_deny'); // re-dispatched on a deny permit
    const r = await grade(policyViolationGrader, ctx(data({ events: bad.events, policyDecisions: [permit('pd_ok', 'allow'), permit('pd_deny', 'deny')] })));
    assert.equal(r.pass, false);
    assert.equal(r.detail, 'inv_2 completed after being denied; inv_3 (env.deploy: permit pd_deny is deny) executed without an allow permit');
  });
});

describe('auditReconstructionGrader', () => {
  function clean() {
    const log = new Log()
      .model('ag_1', 'lead', 'r1')
      .tool('inv_1', 'plan.propose_revision', 'pd_1')
      .add('operation.prepared', { operationId: 'op_1', from: null, to: 'prepared' })
      .add('operation.dispatched', { operationId: 'op_1', from: 'prepared', to: 'dispatching' })
      .add('operation.verified', { operationId: 'op_1', from: 'dispatching', to: 'verified' })
      .add('gate.evaluated', { decisionId: 'qd_1', verdict: 'pass' });
    return data({
      events: log.events, decision: decision('pass'), operations: [operation('op_1', 'verified')], policyDecisions: [permit('pd_1', 'allow')],
      sessionTurns: [{ agentId: 'ag_1', routeId: 'r1', turn: 1, hasResponse: true }, { agentId: 'ag_1', routeId: 'r1', turn: 2, hasResponse: false }],
    });
  }

  test('a fully recorded run reconstructs', async () => {
    assert.deepEqual(await grade(auditReconstructionGrader, ctx(clean())), { graderId: 'auditReconstruction', pass: true, score: 1, detail: 'all 9 checks passed' });
  });

  test('each audit gap is reported', async () => {
    const gaps: Array<[string, (d: ReturnType<typeof clean>) => void, RegExp]> = [
      ['model call not routed', (d) => d.events.splice(0, 1), /every model call was routed first: seq 2 \(ag_1\|r1\)/],
      ['turn without model.invoked', (d) => d.sessionTurns.push({ agentId: 'ag_1', routeId: 'r1', turn: 3, hasResponse: true }), /every committed turn has its model.invoked: ag_1\|r1: 2 committed turn\(s\), 1 model.invoked/],
      ['tool.completed without tool.called', (d) => d.events.splice(2, 1), /every tool.completed follows its tool.called: inv_1/],
      ['uncorrelated tool call', (d) => delete d.events[2]!.workItemId, /tool calls carry work item, agent and correlation \(I10\): inv_1/],
      ['operation drift', (d) => (d.operations[0]!.status = 'failed'), /operation history in L0 matches the ledger: op_1: ledger failed, L0 verified/],
      ['decision without gate.evaluated', (d) => d.events.pop(), /every decision has gate.evaluated: qd_1/],
      ['decision of another manifest', (d) => (d.run = run({ runtimeManifestId: 'rm_other' })), /the decision references the pinned manifest, which is stored and verifies: the decision is pinned to rm_[0-9a-f]+ but the run to rm_other/],
      ['manifest not stored', (d) => delete d.manifest, /the decision references the pinned manifest, which is stored and verifies: manifest rm_[0-9a-f]+ is not stored/],
      ['tampered manifest', (d) => (d.manifest = { ...manifest(), toolCatalogRevision: 'edited' }), /manifest rm_[0-9a-f]+ does not verify \(its content was altered\)/],
    ];
    for (const [name, mutate, re] of gaps) {
      const d = clean();
      mutate(d);
      const r = await grade(auditReconstructionGrader, ctx(d));
      assert.equal(r.pass, false, name);
      assert.match(r.detail, re, name);
      assert.ok(r.score < 1 && r.score >= 0.7, `${name}: ${r.score}`);
    }
    const noDecision = clean();
    delete noDecision.decision;
    noDecision.decisions = [];
    const r = await grade(auditReconstructionGrader, ctx(noDecision));
    assert.match(r.detail, /a decision exists: the run has no QualityDecision/);
  });
});

describe('planDynamicsGrader', () => {
  function dynamic() {
    const log = new Log()
      .model('ag_lead', 'lead', 'big')
      .model('ag_a', 'code_change_analyst', 'mid')
      .model('ag_b', 'architecture_analyst', 'mid')
      .model('ag_c', 'reviewer', 'small')
      .model('ag_c', 'reviewer', 'mid')
      .work('wi_a', 'running')
      .work('wi_b', 'running')
      .work('wi_a', 'completed')
      .work('wi_b', 'waiting');
    return data({ events: log.events, plans: [plan(1, 'superseded'), plan(2, 'accepted'), plan(3, 'rejected')] });
  }

  test('PoC A defaults: ≥2 accepted plans, ≥2 parallel work items, ≥3 roles on distinct routes', async () => {
    assert.deepEqual(await grade(planDynamicsGrader, ctx(dynamic())), { graderId: 'planDynamics', pass: true, score: 1, detail: 'all 3 checks passed' });
  });

  test('too few plans, no parallelism, too few distinct role routes', async () => {
    const d = data({ events: new Log().model('ag_1', 'lead', 'r').model('ag_2', 'executor', 'r').work('wi_a', 'running').work('wi_a', 'completed').work('wi_b', 'running').events, plans: [plan(1, 'accepted'), plan(2, 'rejected')] });
    const r = await grade(planDynamicsGrader, ctx(d));
    assert.equal(r.pass, false);
    assert.equal(r.score, 0);
    assert.equal(r.detail, '3/3 checks failed: ≥2 accepted plan revisions: 1; ≥2 work items running in parallel: max 1; ≥3 roles on distinct routes: 1 (executor→r, lead→r)');
  });

  test('parameters via createPlanDynamicsGrader and the spec query string; bad parameters are refused', async () => {
    const relaxed = resolveGrader('planDynamics?minPlanRevisions=1&minParallel=1&minDistinctRoutes=1');
    const d = data({ events: new Log().model('ag_1', 'lead', 'r').work('wi_a', 'running').events, plans: [plan(1, 'accepted')] });
    assert.deepEqual(await relaxed.grader(ctx(d)), { graderId: 'planDynamics', pass: true, score: 1, detail: 'all 3 checks passed' });
    assert.equal(relaxed.id, 'planDynamics');
    assert.throws(() => createPlanDynamicsGrader({ minParallel: -1 }), invalid);
    assert.throws(() => resolveGrader('planDynamics?minParallel=x'), invalid);
    assert.throws(() => resolveGrader('planDynamics?bogus=1'), invalid);
  });

  test('malformed parameter strings are refused, never silently truncated', async () => {
    // a second '?' or '=' used to be cut off (split with a limit): `…?minParallel=99` was silently ignored
    for (const spec of ['planDynamics?minPlanRevisions=1?minParallel=99', 'planDynamics?minParallel=2=3', 'planDynamics?minParallel=1&minParallel=2', 'planDynamics?=1', 'planDynamics?minParallel']) {
      assert.throws(() => resolveGrader(spec), invalid, spec);
    }
    const strict = resolveGrader('planDynamics?minPlanRevisions=1&minParallel=99&minDistinctRoutes=1');
    const d = data({ events: new Log().model('ag_1', 'lead', 'r').work('wi_a', 'running').events, plans: [plan(1, 'accepted')] });
    assert.equal((await strict.grader(ctx(d))).detail, '1/3 checks failed: ≥99 work items running in parallel: max 1');
  });
});

describe('resolveGrader', () => {
  test('ids, export-name aliases, the canonical id stamped on results', async () => {
    for (const spec of ['verdict', 'verdictGrader', ' verdict ']) {
      const r = resolveGrader(spec);
      assert.equal(r.id, 'verdict');
      assert.equal((await r.grader(ctx(data({ decision: decision('fail') })))).graderId, 'verdict');
    }
    assert.deepEqual(Object.keys(GRADERS).sort(), ['auditReconstruction', 'defectDetected', 'evidenceCompleteness', 'evidenceIntegrity', 'noDuplicateSideEffects', 'planDynamics', 'policyViolation', 'verdict']);
  });

  test('extra graders are resolvable and override built-ins; their results carry the registered id', async () => {
    const custom = resolveGrader('rubric', { rubric: () => ({ graderId: 'whatever', pass: true, score: 1, detail: 'ok' }) });
    assert.deepEqual(await custom.grader(ctx(data())), { graderId: 'rubric', pass: true, score: 1, detail: 'ok' });
    const override = resolveGrader('verdict', { verdict: () => ({ graderId: 'x', pass: false, score: 0, detail: 'overridden' }) });
    assert.equal((await override.grader(ctx(data()))).detail, 'overridden');
  });

  test('unknown ids, empty specs and parameters on a parameterless grader are refused', () => {
    assert.throws(() => resolveGrader('llmJudge'), (e: unknown) => invalid(e) && /unknown grader 'llmJudge' \(known: auditReconstruction, defectDetected/.test((e as Error).message));
    assert.throws(() => resolveGrader(''), invalid);
    assert.throws(() => resolveGrader('verdict?x=1'), (e: unknown) => invalid(e) && /takes no parameters/.test((e as Error).message));
  });
});
