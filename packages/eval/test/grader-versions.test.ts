/**
 * Versioned graders and trial records (hermetic): the committed grader lock (a grader whose source changed under an old
 * revision fails here — bump its revision, record the fingerprint, bridge-compare), revisions of built-in, parameterized
 * and custom graders, bridge comparisons, the trial key, recorded model routes and the canonical projection.
 *
 * Updating the lock after a deliberate revision bump:
 *   HYPERTEST_UPDATE_GRADER_LOCK=1 node --test packages/eval/test/grader-versions.test.ts
 * (refused while any grader changed without a new revision).
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { isHypertestError } from '@hypertest/core';
import {
  DEFAULT_PACKET_BYTES, GRADER_DATA_DEPENDENCIES, GRADER_LOCK_PATH, GRADER_REVISIONS, JUDGE_ANSWER_SCHEMA, JUDGE_SYSTEM_PROMPT, bridgeCompare, canonicalProjection, canonicalState,
  currentGraderLock, customGraderRevision, fingerprintOf, graderFingerprint, graderLockProblems, normalizedSource, readGraderLock, renderGraderLock, resolveGrader, trialKey,
  trialModelRoutes, versionedGraderIds, withoutIds, type EvalTrial, type Grader, type GraderLock,
} from '../src/index.ts';
import { Log, data, decision, evidence, finding, plan } from './helpers.ts';

describe('the grader lock', () => {
  test('every grader has a revision and the committed lock pins its current source (change ⇒ new revision)', () => {
    const now = currentGraderLock();
    const lock = readGraderLock();
    if (process.env['HYPERTEST_UPDATE_GRADER_LOCK'] === '1') {
      // only a deliberate revision bump may re-pin a changed fingerprint
      const unbumped = graderLockProblems(lock, now).filter((p) => /but its revision is still/.test(p));
      assert.deepEqual(unbumped, [], 'bump the revision of every changed grader before updating the lock');
      writeFileSync(GRADER_LOCK_PATH, renderGraderLock(now));
      return;
    }
    assert.deepEqual(graderLockProblems(lock, now), []);
    for (const id of versionedGraderIds()) assert.equal(typeof GRADER_REVISIONS[id], 'string', id);
  });

  test('a changed grader under its old revision, a revision bumped without a change, missing and stale entries are all reported', () => {
    const now: GraderLock = { graders: { a: { revision: '1', fingerprint: 'f2' }, b: { revision: '2', fingerprint: 'fb' }, c: { revision: '2', fingerprint: 'fc2' }, d: { revision: '1', fingerprint: 'fd' } } };
    const lock: GraderLock = { graders: { a: { revision: '1', fingerprint: 'f1' }, b: { revision: '1', fingerprint: 'fb' }, c: { revision: '1', fingerprint: 'fc1' }, gone: { revision: '1', fingerprint: 'x' } } };
    const problems = graderLockProblems(lock, now);
    assert.equal(problems.length, 5, problems.join('\n'));
    assert.match(problems[0]!, /^grader a changed .* but its revision is still 1: bump GRADER_REVISIONS\.a/);
    assert.match(problems[1]!, /^grader b: revision 1 → 2 without a change of its source/);
    assert.match(problems[2]!, /^grader c: new revision 2 \(was 1\) is not recorded in the lock yet/);
    assert.match(problems[3]!, /^grader d \(revision 1\) is not in the lock/);
    assert.match(problems[4]!, /^the lock names grader gone, which no longer exists/);
  });

  test('the judge\'s prompt, answer contract and packet budget are part of the llmRubric fingerprint (a prompt change needs a new revision)', () => {
    const data = GRADER_DATA_DEPENDENCIES['llmRubric'] ?? [];
    assert.ok(data.includes(JUDGE_SYSTEM_PROMPT) && data.includes(JUDGE_ANSWER_SCHEMA as never) && data.includes(DEFAULT_PACKET_BYTES));
    const fn = () => 1;
    assert.equal(fingerprintOf([fn], ['prompt v1']), fingerprintOf([fn], ['prompt v1']));
    assert.notEqual(fingerprintOf([fn], ['prompt v1']), fingerprintOf([fn], ['prompt v2']), 'a changed prompt is a changed grader');
    assert.notEqual(fingerprintOf([fn], [{ a: 1 }]), fingerprintOf([fn], [{ a: 2 }]));
    assert.equal(fingerprintOf([fn], []), fingerprintOf([fn]), 'no data: the function sources alone');
  });

  test('fingerprints cover the grader and its declared analyses; whitespace and full-line comments do not matter', () => {
    assert.match(graderFingerprint('verdict'), /^[0-9a-f]{64}$/);
    assert.notEqual(graderFingerprint('verdict'), graderFingerprint('defectDetected'));
    assert.throws(() => graderFingerprint('nope'), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    const f1 = (x: number) => {
      // a comment
      return x + 1;
    };
    const f2 = (x: number) => { return x + 1; };
    const f3 = (x: number) => { return x + 2; };
    assert.equal(normalizedSource(f1), normalizedSource(f2));
    assert.notEqual(normalizedSource(f2), normalizedSource(f3));
  });
});

describe('grader revisions', () => {
  test('built-ins carry GRADER_REVISIONS; parameters are part of the revision; custom functions get a source digest', () => {
    assert.deepEqual([resolveGrader('verdict').revision, resolveGrader('verdict').kind], ['1', 'deterministic']);
    assert.equal(resolveGrader('llmRubric').kind, 'llm');
    assert.equal(resolveGrader('planDynamics?minParallel=3&minPlanRevisions=1').revision, '1+minParallel=3&minPlanRevisions=1');
    assert.equal(resolveGrader('planDynamics?minPlanRevisions=1&minParallel=3').revision, '1+minParallel=3&minPlanRevisions=1', 'normalized order');
    const g1: Grader = () => ({ graderId: 'x', pass: true, score: 1, detail: 'a' });
    const g2: Grader = () => ({ graderId: 'x', pass: true, score: 1, detail: 'b' });
    assert.match(resolveGrader('mine', { mine: g1 }).revision, /^custom-[0-9a-f]{12}$/);
    assert.notEqual(customGraderRevision(g1), customGraderRevision(g2), 'a changed custom grader is a new revision');
    assert.equal(resolveGrader('mine', { mine: { revision: '7', grader: g1 } }).revision, '7');
    assert.equal(resolveGrader('verdict', { verdict: g1 }).revision, customGraderRevision(g1), 'an override is not the built-in revision');
    for (const bad of [{ revision: '', grader: g1 }, { revision: '1', grader: g1, kind: 'magic' }, { grader: 'x' }]) {
      assert.throws(() => resolveGrader('mine', { mine: bad as never }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    }
  });
});

function trial(extra: Partial<EvalTrial>): EvalTrial {
  return { taskId: 't', armId: 'a', trial: 0, seed: 's', result: 'pass', graders: [], outcomeMetrics: {}, trajectoryMetrics: {}, durationMs: 1, ...extra };
}

describe('bridge comparisons', () => {
  const r = (pass: boolean, score: number, revision: string) => ({ graderId: 'g', pass, score, detail: '', revision });
  test('agreement, the trials that flip, McNemar, the score mapping and a declared discontinuity', () => {
    const trials = [
      trial({ trial: 0, graders: [r(true, 1, '1')], bridge: [r(true, 1, '2')] }),
      trial({ trial: 1, graders: [r(true, 1, '1')], bridge: [r(false, 0.5, '2')] }),
      trial({ trial: 2, graders: [r(false, 0, '1')], bridge: [r(false, 0, '2')] }),
      trial({ trial: 3, graders: [r(true, 1, '1')] }),
    ];
    const b = bridgeCompare('g', trials);
    assert.deepEqual([b.fromRevision, b.toRevision, b.pairs, b.agreement, b.newlyFailing, b.newlyPassing, b.mcnemarP, b.discontinuity], ['1', '2', 3, 2 / 3, ['t/a#1'], [], 1, true]);
    assert.deepEqual(b.scoreMapping, [{ from: 0, to: 0, n: 1 }, { from: 1, to: 0.75, n: 2 }]);
    assert.ok(Math.abs(b.meanScoreDelta - -0.5 / 3) < 1e-12);
    assert.match(b.statement, /DISCONTINUITY/);
    const same = bridgeCompare('g', [trials[0]!, trials[2]!]);
    assert.equal(same.discontinuity, false);
  });

  test('no bridged trial, or mixed revisions, cannot be compared', () => {
    assert.throws(() => bridgeCompare('g', [trial({ graders: [r(true, 1, '1')] })]), (e: unknown) => isHypertestError(e, 'precondition_failed'));
    assert.throws(() => bridgeCompare('g', [trial({ graders: [r(true, 1, '1')], bridge: [r(true, 1, '2')] }), trial({ trial: 1, graders: [r(true, 1, '1')], bridge: [r(true, 1, '3')] })]), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  });
});

describe('trial records', () => {
  test('the trial key changes with every part: suite, revision, task, grader revisions, manifest, oracle revisions', () => {
    const base = { suiteId: 's', suiteRevision: 'r1', taskId: 't', graderRevisions: { verdict: '1' }, runtimeManifestId: 'rm_1', oracleRevisions: { o: 1 } };
    const k = trialKey(base);
    assert.match(k, /^tk_[0-9a-f]{32}$/);
    assert.equal(trialKey({ ...base, graderRevisions: { verdict: '1' } }), k, 'stable');
    for (const variant of [{ suiteId: 's2' }, { suiteRevision: 'r2' }, { taskId: 't2' }, { graderRevisions: { verdict: '2' } }, { runtimeManifestId: 'rm_2' }, { oracleRevisions: { o: 2 } }]) {
      assert.notEqual(trialKey({ ...base, ...variant }), k, JSON.stringify(variant));
    }
  });

  test('model routes per role from L0: epochs (with switch reasons), agents and calls', () => {
    const log = new Log()
      .add('agent.spawned', { agentId: 'ag_1', role: 'executor' })
      .add('agent.spawned', { agentId: 'ag_2', role: 'lead' })
      .add('model.epoch_started', { agentId: 'ag_1', routeId: 'fast', provider: 'fb', model: 'fm', switchReason: 'initial' }, { agentId: 'ag_1' })
      .add('model.invoked', { ok: true, routeId: 'fast' }, { agentId: 'ag_1' })
      .add('model.invoked', { ok: false, routeId: 'fast' }, { agentId: 'ag_1' })
      .add('model.epoch_started', { agentId: 'ag_1', routeId: 'slow', provider: 'sb', model: 'sm', switchReason: 'timeout' }, { agentId: 'ag_1' })
      .add('model.invoked', { ok: true, routeId: 'slow' }, { agentId: 'ag_1' })
      .add('model.epoch_started', { agentId: 'ag_2', routeId: 'slow', provider: 'sb', model: 'sm', switchReason: 'initial' }, { agentId: 'ag_2' });
    assert.deepEqual(trialModelRoutes(log.events), [
      { role: 'executor', routeId: 'fast', provider: 'fb', model: 'fm', epochs: 1, agents: 1, calls: 1, switchReasons: ['initial'] },
      { role: 'executor', routeId: 'slow', provider: 'sb', model: 'sm', epochs: 1, agents: 1, calls: 1, switchReasons: ['timeout'] },
      { role: 'lead', routeId: 'slow', provider: 'sb', model: 'sm', epochs: 1, agents: 1, calls: 0, switchReasons: ['initial'] },
    ]);
  });

  test('the canonical projection ignores ids and routes, and changes with the verdict, a finding or an evidence outcome', () => {
    const d = (verdict: 'fail' | 'pass', caseStatus: string, runSuffix: string) =>
      data({
        decision: decision(verdict),
        plans: [plan(1, 'accepted')],
        findings: [finding(`rec_${runSuffix}`, { title: `paginate drops items (see ev_${runSuffix})` }, [`ev_${runSuffix}`])],
        evidence: [evidence(`ev_${runSuffix}`, 'test-result', { structured: { passed: caseStatus === 'passed', cases: [{ name: 'x', status: caseStatus }] } })],
      });
    const a = canonicalState(d('fail', 'failed', 'AAA'));
    assert.equal(canonicalState(d('fail', 'failed', 'BBB')).digest, a.digest, 'ids differ, the canonical state does not');
    assert.notEqual(canonicalState(d('pass', 'failed', 'AAA')).digest, a.digest);
    assert.notEqual(canonicalState(d('fail', 'passed', 'AAA')).digest, a.digest);
    assert.deepEqual(canonicalProjection(d('fail', 'failed', 'AAA')).records, ['finding/P1/product_defect/open: paginate drops items (see <id>)']);
    assert.equal(withoutIds('run run_01ABC and ev_9 with 0123456789abcdef0123'), 'run <id> and <id> with <hash>');
  });
});
