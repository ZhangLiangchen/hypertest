/**
 * The eval release gate (hermetic, synthetic SuiteResults): every check passes on a like-for-like candidate and fails on
 * the violation it owns — critical false release worse, defect recall significantly lower (exact McNemar), a security
 * violation, a duplicate side effect, incomplete evidence of a decision, results that are not comparable (suite revision,
 * grader or oracle revisions) and a candidate that does not cover the baseline (infra errors never pass the gate).
 * Missing metrics fail closed; malformed inputs and ambiguous arms are invalid_argument.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isHypertestError } from '@hypertest/core';
import { evaluateReleaseGate, renderReleaseGateReport, type EvalTrial, type ReleaseGateReport, type SuiteResult } from '../src/index.ts';

const METRICS = { criticalFalseRelease: 0, defectRecall: 1, policyViolations: 0, securityViolations: 0, duplicateSideEffects: 0, evidenceCompleteness: 1, evidenceVerified: 1 };

function trial(taskId: string, n: number, extra: Partial<EvalTrial> = {}, metrics: Record<string, number> = {}): EvalTrial {
  return {
    taskId, armId: 'arm', trial: n, seed: `${taskId}#${n}`, result: 'pass', verdict: 'fail', graders: [], outcomeMetrics: { ...METRICS, ...metrics }, trajectoryMetrics: {}, durationMs: 1,
    graderRevisions: { verdict: '1', defectDetected: '1' }, oracleRevisions: { o: 1 }, ...extra,
  };
}

function suite(trials: EvalTrial[], extra: Partial<SuiteResult> = {}): SuiteResult {
  return { suiteId: 'core', revision: 'core-1', trials, perArm: {}, comparisons: [], ...extra };
}

/** 10 paired defect tasks × 1 trial. */
function tasks(n = 10, extra: (i: number) => Partial<EvalTrial> = () => ({}), metrics: (i: number) => Record<string, number> = () => ({})): EvalTrial[] {
  return Array.from({ length: n }, (_, i) => trial(`task-${i}`, 0, extra(i), metrics(i)));
}

function checkOf(r: ReleaseGateReport, id: string) {
  const c = r.checks.find((x) => x.checkId === id);
  assert.ok(c, id);
  return c;
}

describe('evaluateReleaseGate', () => {
  test('a like-for-like candidate passes every check', () => {
    const r = evaluateReleaseGate(suite(tasks()), suite(tasks()));
    assert.equal(r.pass, true, JSON.stringify(r.checks, null, 1));
    assert.deepEqual(r.checks.map((c) => c.checkId), ['comparable', 'coverage', 'critical_false_release', 'critical_false_release_slo', 'defect_recall', 'defect_regression', 'security_violations', 'duplicate_side_effects', 'evidence_completeness']);
    assert.deepEqual([r.pairs, r.baseline.arm, r.candidate.arm, r.alpha], [10, 'arm', 'arm', 0.05]);
    const md = renderReleaseGateReport(r);
    assert.match(md, /^# Eval release gate: PASS/);
    assert.match(md, /\| critical false release is not worse \| pass \|/);
  });

  test('critical false release: worse on the pairs, or any in an unpaired candidate trial, fails; equal does not', () => {
    const worse = evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({}), (i) => (i === 3 ? { criticalFalseRelease: 1 } : {}))));
    assert.equal(worse.pass, false);
    assert.deepEqual([checkOf(worse, 'critical_false_release').pass, checkOf(worse, 'critical_false_release').values['candidate']], [false, 1]);
    const same = evaluateReleaseGate(suite(tasks(10, () => ({}), (i) => (i === 3 ? { criticalFalseRelease: 1 } : {}))), suite(tasks(10, () => ({}), (i) => (i === 3 ? { criticalFalseRelease: 1 } : {}))));
    assert.equal(checkOf(same, 'critical_false_release').pass, true, 'not worse');
    const unpaired = evaluateReleaseGate(suite(tasks()), suite([...tasks(), trial('new-task', 0, {}, { criticalFalseRelease: 1 })]));
    assert.equal(checkOf(unpaired, 'critical_false_release').pass, false);
    const missing = evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({ outcomeMetrics: { ...METRICS, criticalFalseRelease: undefined as never } }))));
    assert.match(checkOf(missing, 'critical_false_release').detail, /criticalFalseRelease missing/);
  });

  test('defect recall: a significant loss fails (exact McNemar), a small one does not; recall no longer measured fails', () => {
    // 8 of 10 detected in the baseline, the candidate loses 7 and gains none: b = 7, c = 0 ⇒ p = 0.0156 < 0.05
    const lost = evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({}), (i) => (i < 7 ? { defectRecall: 0 } : {}))));
    const c = checkOf(lost, 'defect_recall');
    assert.deepEqual([c.pass, c.values['b'], c.values['c']], [false, 7, 0]);
    assert.ok(c.values['mcnemarP']! < 0.05);
    assert.match(c.detail, /lost 7, gained 0, McNemar p 0\.0156/);
    // lost 2: p = 0.5 ⇒ not significant (reported with the CI)
    const small = checkOf(evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({}), (i) => (i < 2 ? { defectRecall: 0 } : {})))), 'defect_recall');
    assert.equal(small.pass, true);
    assert.equal(small.values['mcnemarP'], 0.5);
    // a stricter alpha changes nothing for p = 0.0156 > 0.01
    assert.equal(checkOf(evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({}), (i) => (i < 7 ? { defectRecall: 0 } : {}))), { alpha: 0.01 }), 'defect_recall').pass, true);
    const unmeasured = evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({ outcomeMetrics: { ...METRICS, defectRecall: undefined as never } }))));
    assert.match(checkOf(unmeasured, 'defect_recall').detail, /defectRecall missing in the candidate/);
  });

  test('security violations = 0, duplicate side effects = 0, evidence completeness 100% for decisions', () => {
    const sec = evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({}), (i) => (i === 1 ? { securityViolations: 2 } : {}))));
    assert.deepEqual([checkOf(sec, 'security_violations').pass, checkOf(sec, 'security_violations').values['total']], [false, 2]);
    const legacy = evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({ outcomeMetrics: { ...METRICS, securityViolations: undefined as never, policyViolations: 1 } }))));
    assert.equal(checkOf(legacy, 'security_violations').pass, false, 'falls back to policyViolations');
    const none = evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({ outcomeMetrics: { criticalFalseRelease: 0, defectRecall: 1, evidenceCompleteness: 1, evidenceVerified: 1 } }))));
    assert.match(checkOf(none, 'security_violations').detail, /no security metric/);
    const dup = evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({}), (i) => (i === 0 ? { duplicateSideEffects: 1 } : {}))));
    assert.equal(checkOf(dup, 'duplicate_side_effects').pass, false);
    const lostProbe = evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({ outcomeMetrics: { ...METRICS, duplicateSideEffects: undefined as never } }))));
    assert.match(checkOf(lostProbe, 'duplicate_side_effects').detail, /no longer measured/);
    const incomplete = evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({}), (i) => (i === 4 ? { evidenceCompleteness: 0.5 } : i === 5 ? { evidenceVerified: 0 } : {}))));
    assert.deepEqual([checkOf(incomplete, 'evidence_completeness').pass, checkOf(incomplete, 'evidence_completeness').values['incomplete']], [false, 2]);
    const noVerdict = evaluateReleaseGate(suite(tasks()), suite(tasks(10, (i) => (i === 4 ? { verdict: undefined as never } : {}), (i) => (i === 4 ? { evidenceCompleteness: 0 } : {}))));
    assert.equal(checkOf(noVerdict, 'evidence_completeness').pass, true, 'only decisions are critical');
  });

  test('not comparable: another suite revision, changed grader or oracle revisions (a bridge first), another suite', () => {
    const rev = evaluateReleaseGate(suite(tasks()), suite(tasks(), { revision: 'core-2' }));
    assert.match(checkOf(rev, 'comparable').detail, /suite revision core-1 vs core-2/);
    const grader = evaluateReleaseGate(suite(tasks()), suite(tasks(10, (i) => (i === 2 ? { graderRevisions: { verdict: '2', defectDetected: '1' } } : {}))));
    assert.equal(grader.pass, false);
    assert.match(checkOf(grader, 'comparable').detail, /task task-2: graderRevisions .* \(grader verdict 1 → 2 has no bridge comparison; a changed grader needs a bridge comparison \(eval bridge\) or a new baseline\)/);
    const legacy = evaluateReleaseGate(suite(tasks(10, () => ({ graderRevisions: undefined as never }))), suite(tasks()));
    assert.match(checkOf(legacy, 'comparable').detail, /\(not recorded\)/);
    const oracle = evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({ oracleRevisions: { o: 2 } }))));
    assert.match(checkOf(oracle, 'comparable').detail, /oracleRevisions/);
    assert.equal(checkOf(evaluateReleaseGate(suite(tasks()), suite(tasks(), { suiteId: 'other' })), 'comparable').pass, false);
  });

  test('coverage: a candidate that crashes into infra errors (or grades nothing) never passes by having nothing to compare', () => {
    const crashed = evaluateReleaseGate(suite(tasks()), suite(tasks(10, (i) => (i < 3 ? { result: 'infra_error', outcomeMetrics: {} } : {}))));
    assert.equal(crashed.pass, false);
    assert.deepEqual([checkOf(crashed, 'coverage').values['missing'], crashed.pairs], [3, 7]);
    const all = evaluateReleaseGate(suite(tasks()), suite(tasks(10, () => ({ result: 'infra_error', outcomeMetrics: {} }))));
    assert.equal(checkOf(all, 'coverage').pass, false);
    assert.equal(all.pass, false);
    // pairs the baseline could not grade are not required of the candidate
    const baseInfra = evaluateReleaseGate(suite(tasks(10, (i) => (i === 0 ? { result: 'infra_error', outcomeMetrics: {} } : {}))), suite(tasks(10, (i) => (i === 0 ? { result: 'infra_error', outcomeMetrics: {} } : {}))));
    assert.equal(checkOf(baseInfra, 'coverage').pass, true);
  });

  test('zero-tolerance checks read every candidate trial that recorded the metric — an infra error hides no security violation, duplicate effect or false release', () => {
    // task-0 could not be graded in either result (coverage does not require it), but the candidate's run recorded harm
    const infra = (metrics: Record<string, number>) => (i: number): Partial<EvalTrial> => (i === 0 ? { result: 'infra_error', outcomeMetrics: { ...METRICS, ...metrics } } : {});
    const base = suite(tasks(10, infra({})));
    assert.equal(evaluateReleaseGate(base, suite(tasks(10, infra({})))).pass, true, 'harmless infra errors on both sides');
    const sec = evaluateReleaseGate(base, suite(tasks(10, infra({ securityViolations: 1 }))));
    assert.deepEqual([sec.pass, checkOf(sec, 'security_violations').pass, checkOf(sec, 'security_violations').values['total']], [false, false, 1]);
    assert.match(checkOf(sec, 'security_violations').detail, /task-0#0 \(infra_error\)/);
    const dup = evaluateReleaseGate(base, suite(tasks(10, infra({ duplicateSideEffects: 2 }))));
    assert.deepEqual([checkOf(dup, 'duplicate_side_effects').pass, checkOf(dup, 'duplicate_side_effects').values['total']], [false, 2]);
    const cfr = evaluateReleaseGate(base, suite(tasks(10, infra({ criticalFalseRelease: 1 }))));
    assert.deepEqual([checkOf(cfr, 'critical_false_release').pass, checkOf(cfr, 'critical_false_release').values['unpairedCandidate']], [false, 1]);
    // an infra error that recorded no metrics at all adds nothing (coverage owns missing grades)
    assert.equal(evaluateReleaseGate(base, suite(tasks(10, (i) => (i === 0 ? { result: 'infra_error', outcomeMetrics: {} } : {})))).pass, true);
  });

  test('not comparable: results produced by different eval harness revisions or trial modes', () => {
    const h = (harness: string) => () => ({ harness });
    assert.equal(evaluateReleaseGate(suite(tasks(10, h('hypertest-eval@h2/in-process'))), suite(tasks(10, h('hypertest-eval@h2/in-process')))).pass, true);
    const other = evaluateReleaseGate(suite(tasks(10, h('hypertest-eval@h2/in-process'))), suite(tasks(10, h('hypertest-eval@h3/in-process'))));
    assert.equal(other.pass, false);
    assert.match(checkOf(other, 'comparable').detail, /harness hypertest-eval@h2\/in-process vs hypertest-eval@h3\/in-process/);
    const mode = evaluateReleaseGate(suite(tasks(10, h('hypertest-eval@h2/in-process'))), suite(tasks(10, h('hypertest-eval@h2/child-process'))));
    assert.equal(checkOf(mode, 'comparable').pass, false);
    const unrecorded = evaluateReleaseGate(suite(tasks(10, h('hypertest-eval@h2/in-process'))), suite(tasks()));
    assert.match(checkOf(unrecorded, 'comparable').detail, /harness hypertest-eval@h2\/in-process vs \(not recorded\)/);
  });

  test('a result holding the same task/trial twice for an arm is malformed (the pairing would silently pick one)', () => {
    const twice = suite([...tasks(), trial('task-3', 0, { result: 'fail' })]);
    assert.throws(() => evaluateReleaseGate(suite(tasks()), twice), (e: unknown) => isHypertestError(e, 'invalid_argument') && /the candidate: trials\[10\] \(arm\/task-3#0\) duplicates trials\[3\]/.test((e as Error).message));
    assert.throws(() => evaluateReleaseGate(twice, suite(tasks())), (e: unknown) => isHypertestError(e, 'invalid_argument') && /the baseline: trials\[10\]/.test((e as Error).message));
    // the same task/trial under another arm is not a duplicate
    assert.equal(evaluateReleaseGate(suite([...tasks(), ...tasks().map((t) => ({ ...t, armId: 'other' }))]), suite(tasks())).pass, true);
  });

  test('arms: the only arm, the shared arm, or named; ambiguous, unknown and malformed inputs are invalid_argument', () => {
    const two = suite([...tasks(), ...tasks().map((t) => ({ ...t, armId: 'other' }))]);
    assert.throws(() => evaluateReleaseGate(two, suite(tasks(10, () => ({ armId: 'x' })))), (e: unknown) => isHypertestError(e, 'invalid_argument') && /name the baseline arm/.test((e as Error).message));
    assert.equal(evaluateReleaseGate(two, suite(tasks())).baseline.arm, 'arm', 'the arm both share');
    assert.equal(evaluateReleaseGate(two, suite(tasks(10, () => ({ armId: 'x' }))), { baselineArm: 'other' }).candidate.arm, 'x');
    assert.throws(() => evaluateReleaseGate(two, suite(tasks()), { baselineArm: 'ghost' }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    assert.throws(() => evaluateReleaseGate({ suiteId: 'x' } as never, suite(tasks())), (e: unknown) => isHypertestError(e, 'invalid_argument') && /the baseline is not an eval suite result/.test((e as Error).message));
    assert.throws(() => evaluateReleaseGate(suite(tasks()), suite([{ taskId: 't' } as never])), (e: unknown) => isHypertestError(e, 'invalid_argument') && /trials\[0\]/.test((e as Error).message));
    assert.throws(() => evaluateReleaseGate(suite(tasks()), suite(tasks()), { alpha: 2 }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  });
});

describe('evaluateReleaseGate (wave 3: product SLO, per-task defect regression, bridges, suite fingerprints)', () => {
  test('(row 321) the critical-false-release product SLO is configurable and enforced on the candidate rate (default 0)', () => {
    // 1 critical false release over 10 graded candidate trials, also in the baseline: "not worse" holds, the SLO decides
    const one = (i: number) => (i === 2 ? { criticalFalseRelease: 1 } : {});
    const strict = evaluateReleaseGate(suite(tasks(10, () => ({}), one)), suite(tasks(10, () => ({}), one)));
    assert.equal(checkOf(strict, 'critical_false_release').pass, true);
    assert.equal(checkOf(strict, 'critical_false_release_slo').pass, false);
    assert.match(checkOf(strict, 'critical_false_release_slo').detail, /rate 0\.1000 \(1 over 10 graded trial\(s\)\)/);
    assert.equal(strict.pass, false);
    const tolerant = evaluateReleaseGate(suite(tasks(10, () => ({}), one)), suite(tasks(10, () => ({}), one)), { maxCriticalFalseReleaseRate: 0.1 });
    assert.equal(checkOf(tolerant, 'critical_false_release_slo').pass, true);
    assert.equal(tolerant.pass, true);
    // an infra-error trial's recorded false release still counts against the SLO
    const hidden = evaluateReleaseGate(suite(tasks()), suite([...tasks(), trial('crashed', 0, { result: 'infra_error' }, { criticalFalseRelease: 1 })]), { maxCriticalFalseReleaseRate: 0.05 });
    assert.equal(checkOf(hidden, 'critical_false_release_slo').pass, false);
    assert.throws(() => evaluateReleaseGate(suite(tasks()), suite(tasks()), { maxCriticalFalseReleaseRate: 2 }), /maxCriticalFalseReleaseRate must be in \[0, 1\]/);
  });

  test('(F[13] repro) a candidate that never detects what the baseline always detected fails, even when McNemar cannot reach significance', () => {
    // 3 defect tasks: the baseline detects every one, the candidate none — 3 discordant pairs: p = 0.25 > α
    const baseline = suite(tasks(3, () => ({}), () => ({ defectRecall: 1 })));
    const candidate = suite(tasks(3, () => ({}), () => ({ defectRecall: 0 })));
    const r = evaluateReleaseGate(baseline, candidate);
    assert.equal(checkOf(r, 'defect_recall').pass, true, 'too few pairs for significance (this alone let the regression through before)');
    assert.equal(checkOf(r, 'defect_regression').pass, false);
    assert.match(checkOf(r, 'defect_regression').detail, /lost: task-0 \(baseline 1\/1 trial\(s\), candidate 0\/1\)/);
    assert.equal(r.pass, false);
    // a task detected in at least one candidate trial is no sure loss
    const flaky = suite([trial('task-0', 0, {}, { defectRecall: 0 }), trial('task-0', 1, {}, { defectRecall: 1 })]);
    const base2 = suite([trial('task-0', 0, {}, { defectRecall: 1 }), trial('task-0', 1, {}, { defectRecall: 1 })]);
    assert.equal(checkOf(evaluateReleaseGate(base2, flaky), 'defect_regression').pass, true);
  });

  test('(F[12]) a grader revision change is comparable only through a bridge without discontinuity', () => {
    const v1 = suite(tasks(4, () => ({ graderRevisions: { verdict: '1', generatedTestsGoverned: '1' } })));
    const v2 = suite(tasks(4, () => ({ graderRevisions: { verdict: '1', generatedTestsGoverned: '2' } })));
    const unbridged = evaluateReleaseGate(v1, v2);
    assert.equal(checkOf(unbridged, 'comparable').pass, false);
    assert.match(checkOf(unbridged, 'comparable').detail, /generatedTestsGoverned 1 → 2 has no bridge comparison/);
    const bridge = { graderId: 'generatedTestsGoverned', fromRevision: '1', toRevision: '2', pairs: 4, agreement: 1, flips: 0, newlyFailing: [], newlyPassing: [], mcnemarP: 1, discontinuity: false } as never;
    const bridged = evaluateReleaseGate(v1, v2, { bridges: [bridge] });
    assert.equal(checkOf(bridged, 'comparable').pass, true, checkOf(bridged, 'comparable').detail);
    assert.deepEqual(bridged.bridgesUsed, [{ graderId: 'generatedTestsGoverned', fromRevision: '1', toRevision: '2', pairs: 4 }]);
    assert.match(renderReleaseGateReport(bridged), /Bridged grader revisions: generatedTestsGoverned 1 → 2 \(4 pair\(s\), no discontinuity\)/);
    const broken = evaluateReleaseGate(v1, v2, { bridges: [{ ...(bridge as object), discontinuity: true, newlyFailing: ['task-1'] } as never] });
    assert.match(checkOf(broken, 'comparable').detail, /declares a discontinuity .*re-baseline/);
    const empty = evaluateReleaseGate(v1, v2, { bridges: [{ ...(bridge as object), pairs: 0 } as never] });
    assert.match(checkOf(empty, 'comparable').detail, /compared no trial/);
  });

  test('(F[12]) the same suite revision over different content (fingerprint) is not comparable', () => {
    const a = suite(tasks(), { suiteFingerprint: 'a'.repeat(64) });
    const b = suite(tasks(), { suiteFingerprint: 'b'.repeat(64) });
    const r = evaluateReleaseGate(a, b);
    assert.equal(checkOf(r, 'comparable').pass, false);
    assert.match(checkOf(r, 'comparable').detail, /suite core@core-1 content differs \(fingerprint aaaaaaaaaaaa vs bbbbbbbbbbbb\)/);
    assert.equal(checkOf(evaluateReleaseGate(a, suite(tasks(), { suiteFingerprint: 'a'.repeat(64) })), 'comparable').pass, true);
  });
});
