/**
 * The independent LLM judge (hermetic): Cohen's kappa and calibration reports, answer grounding (unknown instead of a
 * forced binary), the evidence packet (raw evidence, never only a summary), independence from the trial's producer
 * providers through the judge's own router (fail-closed fallback), the calibrated scripted judge, the llmRubric grader's
 * counted/uncounted/unknown paths, the trial result rules for unknown and uncounted results, and judge ordering.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { isHypertestError } from '@hypertest/core';
import { ScriptedProvider, type ModelCallRequest } from '@hypertest/model';
import { tempDir } from '@hypertest/testkit';
import {
  VERDICT_CONSISTENCY_RUBRIC, buildEvidencePacket, calibrationReport, cohensKappa, createLlmJudge, decideTrialResult, graderOrderProblems, graderSetupProblems, groundJudgeAnswer,
  llmRubricGrader, loadCalibrationSet, parseJudgeRequest, producerProviders, resolveGrader, runSuite, scriptedJudge, scriptedJudgeRoute, stampGraderResult, verdictConsistencyPolicy,
  type CalibrationSet, type EvidencePacket,
  type EvalArm, type GraderResult, type JudgePolicy, type LlmJudge,
} from '../src/index.ts';
import { Log, ctx, data, decision, evidence, finding, task } from './helpers.ts';

const invalid = (e: unknown) => isHypertestError(e, 'invalid_argument');
const precondition = (e: unknown) => isHypertestError(e, 'precondition_failed');

function packet(extra: Partial<EvidencePacket> = {}): EvidencePacket {
  return {
    taskGoal: 'g', environment: {}, evidence: [], findings: [], operations: [], denials: [], deterministicGraders: [], producerProviders: [], truncated: false, ...extra,
  };
}

const failingTest = { evidenceId: 'ev_t', evidenceType: 'test-result', structured: { passed: false, cases: [{ name: 'a', status: 'failed' }] }, truncated: false };
const passingTest = { evidenceId: 'ev_p', evidenceType: 'test-result', structured: { passed: true, cases: [{ name: 'a', status: 'passed' }] }, truncated: false };

/** A stub artifact store over bytes by sha256. */
function htWith(artifacts: Record<string, string> = {}): unknown {
  return { services: { artifacts: { get: async (ref: { sha256: string }) => new TextEncoder().encode(artifacts[ref.sha256] ?? '') } } };
}

describe('calibration statistics', () => {
  test("Cohen's kappa: perfect agreement 1, chance agreement 0, a textbook value", () => {
    assert.equal(cohensKappa([['pass', 'pass'], ['fail', 'fail'], ['unknown', 'unknown']]), 1);
    // p_o = 0.5, p_e = 0.5 ⇒ 0
    assert.equal(cohensKappa([['pass', 'pass'], ['pass', 'fail'], ['fail', 'pass'], ['fail', 'fail']]), 0);
    // 20 items: 15 agree (10 pass/pass, 5 fail/fail); expert 12 pass/8 fail; judge 13 pass/7 fail
    // p_o = 0.75, p_e = 0.6·0.65 + 0.4·0.35 = 0.53 ⇒ kappa = 0.22 / 0.47
    const pairs: Array<[string, string]> = [...Array(10).fill(['pass', 'pass']), ...Array(2).fill(['pass', 'fail']), ...Array(3).fill(['fail', 'pass']), ...Array(5).fill(['fail', 'fail'])];
    assert.ok(Math.abs(cohensKappa(pairs) - 0.22 / 0.47) < 1e-12);
    assert.equal(cohensKappa([]), 0);
    assert.equal(cohensKappa([['pass', 'pass'], ['pass', 'pass']]), 1, 'one category, full agreement');
  });

  test('a report meets its thresholds only with enough items, agreement and kappa', () => {
    const set = { calibrationSetId: 's', revision: '1' };
    const results = [
      { itemId: '1', label: 'pass', verdict: 'pass' }, { itemId: '2', label: 'fail', verdict: 'fail' }, { itemId: '3', label: 'unknown', verdict: 'unknown' }, { itemId: '4', label: 'pass', verdict: 'fail' },
    ] as const;
    const r = calibrationReport(set, VERDICT_CONSISTENCY_RUBRIC, 'j', results, { minAgreement: 0.7, minKappa: 0.5, minItems: 4 });
    assert.deepEqual([r.n, r.agreement, r.confusion.pass.fail, r.disagreements], [4, 0.75, 1, [{ itemId: '4', label: 'pass', verdict: 'fail' }]]);
    assert.equal(r.meetsThreshold, true);
    assert.equal(calibrationReport(set, VERDICT_CONSISTENCY_RUBRIC, 'j', results, { minAgreement: 0.8, minKappa: 0.5, minItems: 4 }).meetsThreshold, false, 'agreement below');
    assert.equal(calibrationReport(set, VERDICT_CONSISTENCY_RUBRIC, 'j', results, { minAgreement: 0.7, minKappa: 0.5, minItems: 5 }).meetsThreshold, false, 'too few items');
  });

  test('the committed calibration set is expert-labelled (human labels, unique ids); a malformed set is refused', async () => {
    const set = loadCalibrationSet();
    assert.ok(set.items.length >= 8);
    assert.ok(set.items.every((i) => i.labelledBy.startsWith('human:') && i.rubricId === 'verdict-consistency'));
    assert.deepEqual([...new Set(set.items.map((i) => i.label))].sort(), ['fail', 'pass', 'unknown'], 'every category is labelled');
    const dir = await tempDir('ht-cal-');
    try {
      const bad = join(dir.path, 'bad.json');
      writeFileSync(bad, JSON.stringify({ calibrationSetId: 'x', revision: '1', items: [{ itemId: 'a', rubricId: 'r', label: 'maybe', labelledBy: 'agent:x', packet: {} }] }));
      assert.throws(() => loadCalibrationSet(bad), invalid);
      writeFileSync(bad, '{not json');
      assert.throws(() => loadCalibrationSet(bad), invalid);
    } finally {
      await dir.cleanup();
    }
  });
});

describe('grounding the answer', () => {
  const p = packet({ evidence: [failingTest] });
  test('a pass/fail citing packet evidence stands; foreign citations are dropped', () => {
    assert.deepEqual(groundJudgeAnswer(JSON.stringify({ verdict: 'fail', rationale: 'r', citedEvidence: ['ev_t', 'ev_zzz'] }), p), { verdict: 'fail', rawVerdict: 'fail', rationale: 'r', citedEvidence: ['ev_t'] });
  });

  test('a pass/fail citing nothing of the packet is downgraded to unknown (never a forced binary)', () => {
    const a = groundJudgeAnswer(JSON.stringify({ verdict: 'pass', rationale: 'looks fine', citedEvidence: ['ev_made_up'] }), p);
    assert.deepEqual([a.verdict, a.rawVerdict], ['unknown', 'pass']);
    assert.match(a.downgraded!, /^ungrounded pass: it cites no evidence of the packet \(ev_made_up\)/);
  });

  test('an unparseable or schema-violating answer is unknown; prose around the JSON is tolerated', () => {
    assert.equal(groundJudgeAnswer('I think it passes.', p).verdict, 'unknown');
    assert.match(groundJudgeAnswer('{"verdict":"yes","rationale":"x","citedEvidence":[]}', p).downgraded!, /^unparseable answer/);
    assert.equal(groundJudgeAnswer('Answer:\n```json\n{"verdict":"unknown","rationale":"no evidence","citedEvidence":[]}\n```', p).verdict, 'unknown');
    assert.equal(groundJudgeAnswer('Answer: {"verdict":"fail","rationale":"x","citedEvidence":["ev_t"]} done', p).verdict, 'fail');
  });
});

describe('the evidence packet', () => {
  test('raw outcome: probes (not the brains log), the decision, evidence payloads and artifact excerpts, findings with their citations, denials, prior graders, producers', async () => {
    const log = new Log()
      .add('model.routed', { ok: true, role: 'executor', routeId: 'r1', provider: 'fast-b', model: 'm' }, { agentId: 'ag_1' })
      .add('model.routed', { ok: false, role: 'reviewer', routeId: null, provider: null }, { agentId: 'ag_2' })
      .add('tool.denied', { toolId: 'fs.write', invocationId: 'i', status: 'denied', errorCode: 'not_offered' });
    const d = data({
      events: log.events,
      decision: decision('fail', { violatedCriteria: [{ criterionId: 'C3', description: '', status: 'violated', evidenceRefs: [] }], reasons: ['C3 violated'] }),
      evidence: [
        evidence('ev_log', 'log', { seq: 1 }),
        evidence('ev_run', 'test-result', { seq: 2, structured: { passed: false, cases: [{ name: 'x', status: 'failed' }] }, artifact: { uri: 'u', sha256: 'aa', size: 30, mimeType: 'text/plain' } }),
      ],
      findings: [finding('rec_1', { title: 'x fails' }, ['ev_run'])],
      probes: { observations: [{ secret: 'brain log' }] as never, bankHealth: { balanceConserved: false } },
    });
    const prior: GraderResult[] = [{ graderId: 'verdict', pass: true, score: 1, detail: 'ok', outcome: 'pass' }];
    const p = await buildEvidencePacket({ ...ctx(d, task(), htWith({ aa: 'TAP version 13\nnot ok 1 - x\n' })), prior });
    assert.deepEqual(p.environment, { bankHealth: { balanceConserved: false } });
    assert.deepEqual(p.decision, { verdict: 'fail', requiresHumanReview: false, violated: ['C3'], unknown: [], reasons: ['C3 violated'] });
    assert.deepEqual(p.evidence.map((e) => e.evidenceId), ['ev_run', 'ev_log'], 'execution evidence first');
    assert.deepEqual(p.evidence[0]!.structured, { passed: false, cases: [{ name: 'x', status: 'failed' }] });
    assert.equal(p.evidence[0]!.excerpt, 'TAP version 13\nnot ok 1 - x\n');
    assert.deepEqual(p.findings[0]!.evidenceRefs, ['ev_run']);
    assert.deepEqual(p.denials, [{ toolId: 'fs.write', status: 'not_offered' }]);
    assert.deepEqual(p.deterministicGraders, [{ graderId: 'verdict', outcome: 'pass', detail: 'ok' }]);
    assert.deepEqual(p.producerProviders, ['fast-b']);
    assert.equal(p.truncated, false);
  });

  test('producers are every provider the trial routed to, started an epoch on or called (answered or not)', () => {
    const log = new Log()
      .add('model.invoked', { ok: true, routeId: 'r9', provider: 'answered-only', model: 'm' }, { agentId: 'ag_9' })
      .add('model.invoked', { ok: false, routeId: 'r8', provider: 'failed-call', model: 'm' }, { agentId: 'ag_8' })
      .add('model.epoch_started', { routeId: 'r1', provider: 'epoch', model: 'm' }, { agentId: 'ag_1' })
      .add('model.routed', { ok: false, routeId: null, provider: null }, { agentId: 'ag_2' });
    assert.deepEqual(producerProviders(log.events), ['answered-only', 'epoch', 'failed-call']);
  });

  test('the byte budget cuts evidence (execution first) and says so', async () => {
    const big = 'x'.repeat(3000);
    const d = data({ evidence: Array.from({ length: 20 }, (_, i) => evidence(`ev_${i}`, i === 19 ? 'test-result' : 'log', { seq: i, summary: big })) });
    const p = await buildEvidencePacket(ctx(d, task(), htWith()), { maxBytes: 4096 });
    assert.equal(p.truncated, true);
    assert.equal(p.evidence[0]!.evidenceId, 'ev_19', 'the test result is kept first');
    assert.ok(p.evidence.length < 20);
  });
});

/** A judge over scripted providers: `routes` [routeId, provider], each provider answering with `policy` (or failing). */
function judgeOver(routes: Array<[string, string]>, answer: (provider: string, request: ModelCallRequest) => ReturnType<JudgePolicy> | 'timeout', calibration?: CalibrationSet): { judge: LlmJudge; seen: Array<{ provider: string; text: string }> } {
  const seen: Array<{ provider: string; text: string }> = [];
  const providers = [...new Set(routes.map(([, p]) => p))].map((p) => new ScriptedProvider({
    providerId: p,
    brain: (request) => {
      seen.push({ provider: p, text: JSON.stringify(request.messages) });
      const a = answer(p, request);
      return a === 'timeout' ? { error: 'timeout' } : { text: JSON.stringify(a) };
    },
  }));
  const setup: Parameters<typeof createLlmJudge>[0] = { routes: routes.map(([r, p]) => scriptedJudgeRoute(r, p)), providers, maxAttempts: 1 };
  if (calibration) setup.calibration = { set: calibration };
  return { judge: createLlmJudge(setup), seen };
}

describe('the independent judge', () => {
  const p = packet({ decision: { verdict: 'fail', requiresHumanReview: false, violated: ['C3'], unknown: [], reasons: [] }, evidence: [failingTest], findings: [], producerProviders: ['fast-b'] });

  test('never routed to a producer provider: the independent route answers; with none left the judge refuses', async () => {
    const { judge, seen } = judgeOver([['j-fast', 'fast-b'], ['j-ind', 'indep']], () => ({ verdict: 'pass', rationale: 'r', citedEvidence: ['ev_t'] }));
    const a = await judge.judge(p, VERDICT_CONSISTENCY_RUBRIC);
    assert.deepEqual([a.verdict, a.provider, a.routeId], ['pass', 'indep', 'j-ind']);
    assert.deepEqual(seen.map((s) => s.provider), ['indep']);
    const only = judgeOver([['j-fast', 'fast-b']], () => ({ verdict: 'pass', rationale: 'r', citedEvidence: ['ev_t'] }));
    await assert.rejects(only.judge.judge(p, VERDICT_CONSISTENCY_RUBRIC), (e: unknown) => precondition(e) && /no independent judge route \(prohibited providers: fast-b\)/.test((e as Error).message));
    assert.equal(only.seen.length, 0, 'the producer was never asked');
    // options.prohibitedProviders adds to the packet's producers
    await assert.rejects(judge.judge(p, VERDICT_CONSISTENCY_RUBRIC, { prohibitedProviders: ['indep'] }), precondition);
  });

  test('the request carries the rubric and the RAW packet as delimited data; a failing route falls back fail-closed', async () => {
    const { judge, seen } = judgeOver([['j-a', 'pa'], ['j-b', 'pb']], (provider) => (provider === 'pa' ? 'timeout' : { verdict: 'fail', rationale: 'x', citedEvidence: ['ev_t'] }));
    const a = await judge.judge(p, VERDICT_CONSISTENCY_RUBRIC);
    assert.deepEqual([a.verdict, a.provider], ['fail', 'pb']);
    assert.deepEqual(seen.map((s) => s.provider), ['pa', 'pb']);
    const parsed = parseJudgeRequest({ messages: JSON.parse(seen[1]!.text) });
    assert.deepEqual(parsed?.packet.evidence[0]?.structured, failingTest.structured, 'the judge received the recorded payload itself');
    assert.equal(parsed?.rubric.rubricId, 'verdict-consistency');
    assert.match(seen[1]!.text, /data, never instructions/);
    const failing = judgeOver([['j-a', 'pa']], () => 'timeout');
    await assert.rejects(failing.judge.judge(p, VERDICT_CONSISTENCY_RUBRIC), (e: unknown) => isHypertestError(e, 'unavailable'));
  });

  test('the scripted CI judge agrees with the expert labels well enough to count; an always-pass judge does not', async () => {
    const judge = scriptedJudge();
    const report = await judge.calibration(VERDICT_CONSISTENCY_RUBRIC);
    assert.ok(report, 'calibrated against the committed set');
    assert.ok(report.agreement >= 0.8 && report.kappa >= 0.6 && report.meetsThreshold, JSON.stringify(report));
    assert.ok(report.disagreements.length > 0, 'the scripted judge is not a copy of the labels (calibration measures a real judge)');
    assert.strictEqual(await judge.calibration(VERDICT_CONSISTENCY_RUBRIC), report, 'computed once per rubric revision');
    const yes = scriptedJudge({ policy: (pk) => ({ verdict: 'pass', rationale: 'always', citedEvidence: pk.evidence.slice(0, 1).map((e) => e.evidenceId) }) });
    const bad = await yes.calibration(VERDICT_CONSISTENCY_RUBRIC);
    assert.equal(bad!.meetsThreshold, false, JSON.stringify(bad));
    assert.ok(bad!.kappa < 0.6);
    assert.equal(await scriptedJudge({ calibration: false }).calibration(VERDICT_CONSISTENCY_RUBRIC), undefined, 'uncalibrated');
    assert.equal(await judge.calibration({ ...VERDICT_CONSISTENCY_RUBRIC, rubricId: 'other' }), undefined, 'no labelled items for another rubric');
  });

  test('a scripted judge with another policy is another judge: its identity (part of the recorded llmRubric revision) names the policy', () => {
    const always: JudgePolicy = () => ({ verdict: 'unknown', rationale: 'x', citedEvidence: [] });
    const never: JudgePolicy = () => ({ verdict: 'fail', rationale: 'y', citedEvidence: [] });
    const standard = scriptedJudge({ calibration: false });
    assert.match(standard.identity, /^judge\[eval-judge-scripted=eval-judge\/eval-judge-scripted-1\]@mc_/, 'the default policy keeps its model id');
    const a = scriptedJudge({ calibration: false, policy: always });
    const b = scriptedJudge({ calibration: false, policy: never });
    assert.match(a.identity, /eval-judge-scripted-policy-[0-9a-f]{12}\]/);
    assert.notEqual(a.identity, standard.identity);
    assert.notEqual(a.identity, b.identity);
    assert.equal(scriptedJudge({ calibration: false, policy: always }).identity, a.identity, 'stable for the same policy');
  });

  test('verdictConsistencyPolicy reads the raw evidence: a release against a failing record fails, a supported fail passes, no evidence is unknown', () => {
    const release = packet({ decision: { verdict: 'pass', requiresHumanReview: false, violated: [], unknown: [], reasons: [] }, evidence: [failingTest] });
    assert.equal(verdictConsistencyPolicy(release, VERDICT_CONSISTENCY_RUBRIC).verdict, 'fail');
    const clean = packet({ decision: { verdict: 'pass', requiresHumanReview: false, violated: [], unknown: [], reasons: [] }, evidence: [passingTest] });
    assert.equal(verdictConsistencyPolicy(clean, VERDICT_CONSISTENCY_RUBRIC).verdict, 'pass');
    assert.equal(verdictConsistencyPolicy(packet({ decision: clean.decision! }), VERDICT_CONSISTENCY_RUBRIC).verdict, 'unknown');
    assert.equal(verdictConsistencyPolicy(packet(), VERDICT_CONSISTENCY_RUBRIC).verdict, 'unknown', 'no decision');
    assert.equal(verdictConsistencyPolicy(release, { ...VERDICT_CONSISTENCY_RUBRIC, rubricId: 'other' }).verdict, 'unknown');
  });
});

describe('llmRubric (the grader)', () => {
  const fail = data({ decision: decision('fail'), evidence: [evidence('ev_run', 'test-result', { structured: { passed: false, cases: [{ name: 'x', status: 'failed' }] } })], findings: [finding('rec_1', {}, ['ev_run'])] });

  test('without a judge it cannot grade (precondition ⇒ infra_error)', async () => {
    await assert.rejects(async () => llmRubricGrader(ctx(fail, task(), htWith())), precondition);
  });

  test('a calibrated judge counts: pass/fail/unknown with its route, rubric, calibration and packet digest recorded', async () => {
    const judge = scriptedJudge();
    const r = await llmRubricGrader({ ...ctx(fail, task(), htWith()), judge });
    assert.deepEqual([r.graderId, r.pass, r.outcome, r.counted, r.score], ['llmRubric', true, 'pass', true, 1]);
    assert.deepEqual([r.judge?.rubricId, r.judge?.provider, r.judge?.citedEvidence], ['verdict-consistency', 'eval-judge', ['ev_run']]);
    assert.equal(r.judge?.calibration?.meetsThreshold, true);
    assert.match(r.judge!.packetDigest, /^[0-9a-f]{64}$/);
    const unknown = await llmRubricGrader({ ...ctx(data({ decision: decision('pass'), evidence: [evidence('ev_l', 'log')] }), task(), htWith()), judge });
    assert.deepEqual([unknown.pass, unknown.outcome, unknown.counted, unknown.score], [false, 'unknown', true, 0.5]);
  });

  test('an uncalibrated or badly calibrated judge is reported but not counted; a trial without any raw outcome is unknown without asking', async () => {
    const r = await llmRubricGrader({ ...ctx(fail, task(), htWith()), judge: scriptedJudge({ calibration: false }) });
    assert.deepEqual([r.outcome, r.counted], ['pass', false]);
    assert.match(r.detail, /NOT COUNTED \(no calibration of rubric verdict-consistency@1/);
    const asked: string[] = [];
    const spy = scriptedJudge({ policy: (pk) => (asked.push('x'), verdictConsistencyPolicy(pk, VERDICT_CONSISTENCY_RUBRIC)) });
    const empty = await llmRubricGrader({ ...ctx(data(), task(), htWith()), judge: spy });
    assert.equal(empty.outcome, 'unknown');
    assert.match(empty.judge!.rationale, /no raw outcome/);
  });

  test('expert labels calibrate the rubric revision they were given for: a revised rubric is uncalibrated (not counted) until relabelled', async () => {
    const set = loadCalibrationSet();
    assert.ok(set.items.every((i) => i.rubricRevision === VERDICT_CONSISTENCY_RUBRIC.revision), 'the committed labels name their rubric revision');
    const judge = scriptedJudge();
    const revised = { ...VERDICT_CONSISTENCY_RUBRIC, revision: '2', failWhen: [...VERDICT_CONSISTENCY_RUBRIC.failWhen, 'a new rule the experts never labelled'] };
    assert.equal(await judge.calibration(revised), undefined);
    const r = await llmRubricGrader({ ...ctx(fail, task({ rubric: revised }), htWith()), judge });
    assert.deepEqual([r.outcome, r.counted], ['pass', false]);
    assert.match(r.detail, /NOT COUNTED \(no calibration of rubric verdict-consistency@2/);
    // labels without a rubric revision apply to every revision of their rubric
    const unversioned: CalibrationSet = { ...set, items: set.items.map(({ rubricRevision: _r, ...i }) => i) };
    const report = await scriptedJudge({ calibration: unversioned }).calibration(revised);
    assert.equal(report?.n, set.items.length);
  });

  test('a result counts only when the route that answered is the route the calibration measured (another judge model is uncalibrated)', async () => {
    // two judge routes on two providers, both answering with the expert-grade policy
    const policy = (_p: string, request: ModelCallRequest) => {
      const parsed = parseJudgeRequest(request)!;
      return verdictConsistencyPolicy(parsed.packet, parsed.rubric);
    };
    const { judge } = judgeOver([['j-a', 'pa'], ['j-b', 'pb']], policy, loadCalibrationSet());
    const report = await judge.calibration(VERDICT_CONSISTENCY_RUBRIC);
    assert.ok(report?.meetsThreshold);
    assert.equal(report.routes?.length, 1, 'the calibration names the route that answered it');
    const calibrated = report.routes![0]!;
    const [calibratedProvider, otherRoute] = calibrated === 'j-a' ? ['pa', 'j-b'] : ['pb', 'j-a'];
    // a trial whose agents ran on the calibrated route's provider is judged by the OTHER route: reported, not counted
    const produced = data({ ...fail, events: new Log().add('model.routed', { ok: true, role: 'executor', routeId: 'x', provider: calibratedProvider, model: 'm' }, { agentId: 'ag_1' }).events });
    const r = await llmRubricGrader({ ...ctx(produced, task(), htWith()), judge });
    assert.deepEqual([r.judge?.routeId, r.outcome, r.counted], [otherRoute, 'pass', false]);
    assert.match(r.detail, new RegExp(`NOT COUNTED \\(the judge answered on route ${otherRoute}; its calibration .* was measured on ${calibrated}\\)`));
    assert.deepEqual(r.judge?.calibration?.routes, [calibrated]);
    // a trial the calibrated route judges counts
    const ok = await llmRubricGrader({ ...ctx(fail, task(), htWith()), judge });
    assert.deepEqual([ok.judge?.routeId, ok.counted], [calibrated, true]);
  });

  test('a judge that cannot answer: a counted judge is a precondition failure, an uncounted one is reported as unknown', async () => {
    const down = judgeOver([['j', 'p']], () => 'timeout', loadCalibrationSet());
    // calibration itself needs the judge: a judge that is down cannot even be calibrated (fails closed)
    await assert.rejects(async () => llmRubricGrader({ ...ctx(fail, task(), htWith()), judge: down.judge }), (e: unknown) => isHypertestError(e, 'unavailable'));
    const uncalibrated = judgeOver([['j', 'p']], () => 'timeout');
    const r = await llmRubricGrader({ ...ctx(fail, task(), htWith()), judge: uncalibrated.judge });
    assert.deepEqual([r.outcome, r.counted], ['unknown', false]);
    assert.match(r.judge!.rationale, /could not answer/);
  });
});

describe('trial results with a judge', () => {
  const ok = (id: string): GraderResult => ({ graderId: id, pass: true, score: 1, detail: '', outcome: 'pass' });
  test('a counted unknown never passes: without a failing grader it needs a human audit (infra_error)', () => {
    const unknown: GraderResult = { graderId: 'llmRubric', pass: false, score: 0.5, detail: 'd', outcome: 'unknown', counted: true };
    assert.deepEqual(decideTrialResult({ graders: [ok('verdict'), unknown], timedOut: false, unexercised: [] }), { result: 'infra_error', error: 'needs human audit: llmRubric could not decide from the evidence' });
    const failing: GraderResult = { graderId: 'verdict', pass: false, score: 0, detail: 'd', outcome: 'fail' };
    assert.equal(decideTrialResult({ graders: [failing, unknown], timedOut: false, unexercised: [] }).result, 'fail', 'an unknown never hides a failure');
  });

  test('an uncounted result never decides: an uncounted fail does not fail the trial, an uncounted unknown needs no audit', () => {
    const uncountedFail: GraderResult = { graderId: 'llmRubric', pass: false, score: 0, detail: 'd', outcome: 'fail', counted: false };
    assert.deepEqual(decideTrialResult({ graders: [ok('verdict'), uncountedFail], timedOut: false, unexercised: [] }), { result: 'pass' });
    const uncountedUnknown: GraderResult = { ...uncountedFail, outcome: 'unknown' };
    assert.deepEqual(decideTrialResult({ graders: [ok('verdict'), uncountedUnknown], timedOut: false, unexercised: [] }), { result: 'pass' });
  });

  test('only an LLM-judged grader may be uncounted; pass and outcome must agree (stampGraderResult)', () => {
    const schema = (re: RegExp) => (e: unknown) => isHypertestError(e, 'schema_violation') && re.test((e as Error).message);
    const uncounted: GraderResult = { graderId: 'g', pass: false, score: 0, detail: 'd', outcome: 'fail', counted: false };
    assert.throws(() => stampGraderResult(uncounted, { id: 'g', revision: '1', kind: 'deterministic' }), schema(/only an LLM-judged grader may be reported uncounted/));
    assert.throws(() => stampGraderResult(uncounted, { id: 'g', revision: '1' }), schema(/only an LLM-judged grader/), 'no kind = deterministic');
    assert.deepEqual(stampGraderResult(uncounted, { id: 'llmRubric', revision: '1/x', kind: 'llm' }), { ...uncounted, revision: '1/x' });
    assert.throws(() => stampGraderResult({ graderId: 'g', pass: false, score: 0, detail: 'd', outcome: 'pass' }, { id: 'g', revision: '1' }), schema(/returned pass false with outcome pass/));
    assert.throws(() => stampGraderResult({ graderId: 'g', pass: true, score: 1, detail: 'd', outcome: 'unknown' }, { id: 'g', revision: '1', kind: 'llm' }), schema(/returned pass true with outcome unknown/));
    assert.throws(() => stampGraderResult({ graderId: 'g', pass: false, score: 0, detail: 'd', outcome: 'maybe' as never }, { id: 'g', revision: '1' }), schema(/returned outcome maybe/));
    assert.throws(() => stampGraderResult({ graderId: 'g', pass: true, score: 1, detail: 'd', counted: 'yes' as never }, { id: 'g', revision: '1', kind: 'llm' }), schema(/returned counted yes/));
    assert.deepEqual(stampGraderResult({ graderId: 'g', pass: true, score: 1, detail: 'd' }, { id: 'g', revision: '3' }), { graderId: 'g', pass: true, score: 1, detail: 'd', revision: '3', outcome: 'pass' });
  });

  test('an override of the LLM-judged grader id stays LLM-judged (ordered last) unless it declares its kind', () => {
    const judgeLike = { revision: '2', grader: llmRubricGrader };
    assert.equal(resolveGrader('llmRubric', { llmRubric: judgeLike }).kind, 'llm');
    assert.match(graderOrderProblems(['llmRubric', 'verdict'], { llmRubric: judgeLike })[0]!, /llmRubric must come after every deterministic grader/);
    assert.equal(resolveGrader('llmRubric', { llmRubric: { ...judgeLike, kind: 'deterministic' } }).kind, 'deterministic');
  });

  test('ordering: the LLM judge comes after every deterministic grader; a task listing it needs a judge (refused before any trial)', async () => {
    assert.deepEqual(graderOrderProblems(['verdict', 'llmRubric']), []);
    assert.match(graderOrderProblems(['llmRubric', 'verdict', 'policyViolation'])[0]!, /llmRubric must come after every deterministic grader \(listed before: verdict, policyViolation\)/);
    assert.match(graderSetupProblems(task({ graders: ['verdict', 'llmRubric'] }), {})[0]!, /no independent judge is configured/);
    assert.deepEqual(graderSetupProblems(task({ graders: ['verdict', 'llmRubric'] }), { judge: scriptedJudge({ calibration: false }) }), []);
    const custom = { rubric2: { revision: '3', grader: () => ok('rubric2'), kind: 'llm' as const } };
    assert.match(graderOrderProblems(['rubric2', 'verdict'], custom)[0]!, /rubric2 must come after/);
    const arm: EvalArm = { armId: 'a', description: 'a', config: (b) => b };
    await assert.rejects(runSuite({ suiteId: 's', revision: '1', tasks: [task({ graders: ['llmRubric', 'verdict'] })] }, { arms: [arm], trials: 1, workDir: '/tmp/never', judge: scriptedJudge() }), (e: unknown) => invalid(e) && /must come after/.test((e as Error).message));
    await assert.rejects(runSuite({ suiteId: 's', revision: '1', tasks: [task({ graders: ['verdict', 'llmRubric'] })] }, { arms: [arm], trials: 1, workDir: '/tmp/never' }), (e: unknown) => invalid(e) && /no independent judge/.test((e as Error).message));
  });
});
