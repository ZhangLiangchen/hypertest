/**
 * (F[9], F[10], F[11], F[12], coverage[14], coverage[15], stubs[5], item 18) The eval platform pieces of wave 3,
 * hermetic: pass@k / pass^k per k in suite results and reports; the defect-economics and human-intervention metrics; the
 * tiers; the private (directory) and public sanity (SWE-bench-style) layers; the configured, recording and human-labelled
 * judge; the retained grader revisions of a bridge.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { defaultConfig, type HypertestConfig } from '@hypertest/app';
import { tempDir } from '@hypertest/testkit';
import {
  EVAL_TIERS, EVAL_TIER_IDS, GRADER_REVISIONS, RETAINED_GRADERS, VERDICT_CONSISTENCY_RUBRIC, configuredJudge, defectEconomics, gitShowFile, humanInterventions, labelCalibrationItem,
  loadCalibrationSet, loadSuiteDirectory, parseSweBench, recordingJudge, renderSuiteReport, retainedGrader, sanitySuite, scriptedJudge, scriptedJudgeBrain, scriptedWireFetch, summarizeSuite,
  outcomeMetrics, tierSpec, wireHost, type EvalTrial,
} from '../src/index.ts';
import { Log, data, decision, evidence, finding, operation, task } from './helpers.ts';

function trial(taskId: string, n: number, pass: boolean): EvalTrial {
  return { taskId, armId: 'a', trial: n, seed: `${taskId}#${n}`, result: pass ? 'pass' : 'fail', graders: [], outcomeMetrics: {}, trajectoryMetrics: {}, durationMs: 1 };
}

describe('(F[9]) pass@k and pass^k per k', () => {
  test('summarizeSuite reports pass@k and pass^k for k = 1, 3, 5 and the largest trial count; the report shows both', () => {
    // task x: 3 of 5 pass; task y: 5 of 5 pass
    const trials = [...[true, true, false, true, false].map((p, i) => trial('x', i, p)), ...[0, 1, 2, 3, 4].map((i) => trial('y', i, true))];
    const r = summarizeSuite({ suiteId: 's', revision: '1' }, ['a'], trials);
    const arm = r.perArm['a']!;
    assert.deepEqual(Object.keys(arm.passAtK ?? {}), ['1', '3', '5']);
    // pass@1 = mean(3/5, 1) = 0.8; pass@3 = mean(1 − C(2,3)/C(5,3), 1) = 1; pass^3 = mean(C(3,3)/C(5,3), 1) = 0.55; pass^5 = mean(0, 1) = 0.5
    assert.ok(Math.abs(arm.passAtK!['1']! - 0.8) < 1e-9);
    assert.equal(arm.passAtK!['3'], 1);
    assert.ok(Math.abs(arm.passHatKByK!['3']! - 0.55) < 1e-9);
    assert.equal(arm.passHatKByK!['5'], 0.5);
    const md = renderSuiteReport(r);
    assert.match(md, /pass@1 \| pass\^1 \| pass@3 \| pass\^3 \| pass@5 \| pass\^5/);
    assert.match(md, /\| a \| 0\.800 \| 0\.800 \| 1 \| 0\.550 \| 1 \| 0\.500 \|/);
    assert.match(md, /^\| arm \| pass rate \| pass\^k \| graded \| infra errors \|$/m, 'a table without headline metrics has exactly its five columns');
  });

  test('a task with fewer trials than k does not enter that k (no fabricated reliability)', () => {
    const r = summarizeSuite({ suiteId: 's', revision: '1' }, ['a'], [trial('x', 0, true), ...[0, 1, 2].map((i) => trial('y', i, i !== 1))]);
    assert.deepEqual(Object.keys(r.perArm['a']!.passAtK ?? {}), ['1', '3']);
    assert.ok(Math.abs(r.perArm['a']!.passHatKByK!['3']! - 0) < 1e-9, 'only y has 3 trials, and one failed');
  });
});

describe('(F[10]) defect economics and human interventions', () => {
  test('independent reproduction: a confirmed defect whose execution evidence comes from ≥ 2 agents; cost and tokens per confirmed defect', () => {
    const log = new Log();
    log.add('model.invoked', { ok: true, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.3 } });
    log.add('model.invoked', { ok: true, usage: { inputTokens: 200, outputTokens: 50, costUsd: 0.1 } });
    log.add('model.invoked', { ok: false, usage: { inputTokens: 999, costUsd: 9 } });
    const d = data({
      events: log.events,
      evidence: [evidence('ev_1', 'api-response', { agentId: 'ag_exec' }), evidence('ev_2', 'stdout', { agentId: 'ag_rca' }), evidence('ev_3', 'test-result', { agentId: 'ag_exec' })],
      findings: [
        finding('rec_1', { category: 'product_defect', status: 'confirmed' }, ['ev_1', 'ev_2']),
        finding('rec_2', { category: 'performance', status: 'confirmed' }, ['ev_3']),
        finding('rec_3', { category: 'product_defect', status: 'open' }, ['ev_1']),
      ],
    });
    assert.deepEqual(defectEconomics(d), { confirmedDefects: 2, independentReproductionRate: 0.5, costPerConfirmedDefectUsd: 0.2, tokensPerConfirmedDefect: 200 });
    assert.deepEqual(defectEconomics(data({})), { confirmedDefects: 0 });
  });

  test('recovery correctness: only for a trial whose Hypertest was killed — a final decision, nothing unsettled, no duplicate effect', () => {
    const killed = { restarts: 1, injectedModelTimeouts: 0, duplicateDelivery: false, timedOut: false };
    assert.equal(outcomeMetrics(task(), data({ decision: decision('fail') }))['recoveryCorrectness'], undefined, 'no crash: nothing to recover');
    assert.equal(outcomeMetrics(task(), data({ harness: killed, decision: decision('fail'), operations: [operation('op_1', 'verified')] }))['recoveryCorrectness'], 1);
    assert.equal(outcomeMetrics(task(), data({ harness: killed, operations: [operation('op_1', 'verified')] }))['recoveryCorrectness'], 0, 'the recovered run reached no decision');
    assert.equal(outcomeMetrics(task(), data({ harness: killed, decision: decision('fail'), operations: [operation('op_1', 'dispatching')] }))['recoveryCorrectness'], 0, 'an orphaned operation');
    assert.equal(outcomeMetrics(task(), data({ harness: killed, decision: decision('fail'), operations: [operation('op_1', 'verified')], probes: { sideEffects: { op_1: 0 } } }))['recoveryCorrectness'], 0, 'the ledger says verified, the environment saw nothing');
    assert.equal(outcomeMetrics(task(), data({ harness: killed, decision: decision('fail'), operations: [operation('op_1', 'verified')], probes: { sideEffects: { op_1: 2 } } }))['recoveryCorrectness'], 0, 'a duplicate external effect');
  });

  test('human interventions: approval requests, manual reviews and a decision that needs a human', () => {
    const log = new Log().add('approval.requested', {}).add('operation.manual_review', { operationId: 'op' });
    assert.equal(humanInterventions(data({ events: log.events, decision: decision('conditional', { requiresHumanReview: true }) })), 3);
    assert.equal(humanInterventions(data({})), 0);
  });
});

describe('(coverage[15]) tiers', () => {
  test('pr-smoke, release-core, deep, failure-recovery: suite, trials and mode', () => {
    assert.deepEqual(EVAL_TIER_IDS, ['pr-smoke', 'release-core', 'deep', 'failure-recovery']);
    assert.deepEqual([tierSpec('release-core').suiteId, tierSpec('release-core').trials, tierSpec('release-core').mode], ['core', 5, 'in-process']);
    assert.deepEqual([EVAL_TIERS['failure-recovery'].trials, EVAL_TIERS['failure-recovery'].mode], [10, 'child-process']);
    assert.throws(() => tierSpec('nightly'), /unknown eval tier "nightly"/);
  });
});

describe('(coverage[14]) the private layer: suites from a directory', () => {
  test('a declarative suite becomes tasks over git fixtures; the directory content is part of the fingerprint', async () => {
    const dir = await tempDir('ht-private-');
    try {
      await mkdir(join(dir.path, 'base'), { recursive: true });
      await mkdir(join(dir.path, 'cand'), { recursive: true });
      await writeFile(join(dir.path, 'base', 'lib.js'), 'export const add = (a, b) => a + b;\n');
      await writeFile(join(dir.path, 'cand', 'lib.js'), 'export const add = (a, b) => a - b;\n');
      const doc = {
        suiteId: 'acme-private', revision: 'acme-1',
        tasks: [{ taskId: 'add-regression', goal: 'Is add still correct?', repo: { base: 'base', candidate: 'cand' }, expectedVerdict: 'fail', allowedTools: ['fs.*', 'test.run'], tiers: ['deep'] }],
      };
      await writeFile(join(dir.path, 'acme.suite.json'), JSON.stringify(doc));
      const loaded = await loadSuiteDirectory(dir.path);
      const s = loaded.get('acme-private')!;
      assert.deepEqual([s.suite.revision, s.suite.tasks.map((t) => t.taskId), s.suite.tasks[0]!.allowedTools], ['acme-1', ['add-regression'], ['fs.*', 'test.run']]);
      const fixture = await s.suite.tasks[0]!.setup({ workDir: join(dir.path, 'w'), seed: 's', trial: 0 });
      assert.match(await gitShowFile(fixture.target.repoPath!, 'HEAD', 'lib.js'), /a - b/);
      assert.match(await gitShowFile(fixture.target.repoPath!, fixture.target.baseCommit!, 'lib.js'), /a \+ b/);
      // a changed private fixture changes the suite fingerprint (a private suite is versioned like a built-in one)
      await writeFile(join(dir.path, 'cand', 'lib.js'), 'export const add = (a, b) => a * b;\n');
      assert.notEqual((await loadSuiteDirectory(dir.path)).get('acme-private')!.fingerprint, s.fingerprint);
      // malformed suites are refused with every problem named
      await writeFile(join(dir.path, 'bad.suite.json'), JSON.stringify({ suiteId: 'Bad Id', tasks: [{ taskId: 'x' }] }));
      await assert.rejects(loadSuiteDirectory(dir.path), /suiteId must be a lowercase id.*revision is required.*goal is required.*exactly one target.*expectedVerdict is required/);
    } finally {
      await dir.cleanup();
    }
  });
});

describe('(coverage[14]) the public sanity layer: SWE-bench-style instances over a local mirror', () => {
  test('per instance a fixed (gold patch) and an unfixed variant; never a download; malformed instances refused', async () => {
    const dir = await tempDir('ht-sanity-');
    try {
      const mirror = join(dir.path, 'repos', 'acme__calc');
      await mkdir(mirror, { recursive: true });
      const git = (...args: string[]) => execFileSync('git', ['-C', mirror, ...args], { encoding: 'utf8' }).trim();
      git('init', '-q', '-b', 'main');
      await writeFile(join(mirror, 'calc.py'), 'def add(a, b):\n    return a - b\n');
      git('add', '-A');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      const patch = 'diff --git a/calc.py b/calc.py\n--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n';
      const testPatch = 'diff --git a/test_calc.py b/test_calc.py\nnew file mode 100644\n--- /dev/null\n+++ b/test_calc.py\n@@ -0,0 +1,4 @@\n+from calc import add\n+\n+def test_add():\n+    assert add(2, 2) == 4\n';
      const instance = { instance_id: 'acme__calc-1', repo: 'acme/calc', base_commit: base, problem_statement: 'add subtracts', patch, test_patch: testPatch, FAIL_TO_PASS: '["test_calc.py::test_add"]' };
      const dataset = join(dir.path, 'swe.jsonl');
      await writeFile(dataset, `${JSON.stringify(instance)}\n\n`);
      const suite = sanitySuite({ datasetFile: dataset, reposDir: join(dir.path, 'repos') });
      assert.deepEqual(suite.tasks.map((t) => [t.taskId, t.expectedVerdict]), [['acme__calc-1:fixed', 'pass'], ['acme__calc-1:unfixed', 'fail']]);
      assert.match(suite.tasks[1]!.hiddenFaults[0]!.detectionHints[0]!, /test_add/);
      const fixed = await suite.tasks[0]!.setup({ workDir: join(dir.path, 'w1'), seed: 's', trial: 0 });
      assert.match(await gitShowFile(fixed.target.repoPath!, 'HEAD', 'calc.py'), /a \+ b/);
      assert.match(await gitShowFile(fixed.target.repoPath!, 'HEAD', 'test_calc.py'), /def test_add/);
      const unfixed = await suite.tasks[1]!.setup({ workDir: join(dir.path, 'w2'), seed: 's', trial: 0 });
      assert.match(await gitShowFile(unfixed.target.repoPath!, 'HEAD', 'calc.py'), /a - b/);
      assert.equal(git('worktree', 'list').split('\n').length, 1, 'the mirror is left as it was');
      // no mirror ⇒ refused, never downloaded
      const missing = sanitySuite({ datasetFile: dataset, reposDir: join(dir.path, 'nowhere') });
      await assert.rejects(missing.tasks[0]!.setup({ workDir: join(dir.path, 'w3'), seed: 's', trial: 0 }), /no local mirror of acme\/calc .* never downloads/);
      assert.throws(() => parseSweBench('{"instance_id":"x"}', 'ds'), /ds:1: repo is required/);
      assert.throws(() => parseSweBench('not json', 'ds'), /ds:1 is not JSON/);
      assert.throws(() => parseSweBench(JSON.stringify({ ...instance, FAIL_TO_PASS: [] }), 'ds'), /FAIL_TO_PASS names no test/);
    } finally {
      await dir.cleanup();
    }
  });
});

describe('(F[11], stubs[5]) the configured judge, recorded packets and human labels', () => {
  const judgeConfig = (provider: HypertestConfig['models']['providers'][number]): HypertestConfig => ({
    ...defaultConfig(),
    models: {
      providers: [provider],
      routes: [{
        routeId: 'judge-route', provider: provider.id, model: 'judge-1', capabilities: ['tool_use', 'structured_output', 'reasoning', 'long_context'], quality: { default: 0.9 }, toolReliability: 0.9, typicalLatencyMs: 100,
        contextWindow: 200_000, maxOutputTokens: 4096, maxActionRisk: 'critical', maxDataClassification: 'restricted', structuredOutput: 'native', reasoning: 'visible', costPerMillionInputUsd: 0, costPerMillionOutputUsd: 0, enabled: true,
      }],
    },
  });

  test('a judge over a configured route (here an openai-compatible adapter over the wire transport) is calibrated and answers', async () => {
    const set = loadCalibrationSet();
    const config = judgeConfig({ id: 'judge-wire', kind: 'openai-compatible', baseUrl: `http://${wireHost('judge-wire')}/v1` });
    const calls: unknown[] = [];
    const judge = await configuredJudge(config, { fetch: scriptedWireFetch({ 'judge-wire': scriptedJudgeBrain() }, [{ provider: 'judge-wire', wireClass: 'openai-compatible' }], calls as never), calibration: set });
    const item = set.items.find((i) => i.rubricId === VERDICT_CONSISTENCY_RUBRIC.rubricId)!;
    const answer = await judge.judge(item.packet, VERDICT_CONSISTENCY_RUBRIC);
    assert.equal(answer.routeId, 'judge-route');
    assert.equal(answer.verdict, item.label);
    assert.ok(calls.length >= 1, 'the judge went over the adapter');
    const cal = await judge.calibration(VERDICT_CONSISTENCY_RUBRIC);
    assert.ok(cal && cal.n > 0 && cal.meetsThreshold, JSON.stringify(cal));
    assert.deepEqual(cal.routes, ['judge-route']);
  });

  test('a configuration without an enabled route cannot judge (refused, never a silent pass)', async () => {
    const config = { ...judgeConfig({ id: 'x', kind: 'scripted' }), models: { providers: [{ id: 'x', kind: 'scripted' as const }], routes: [] } };
    await assert.rejects(configuredJudge(config, { scriptedBrains: { x: scriptedJudgeBrain() } }), /no enabled model route for the judge/);
  });

  test('recordingJudge keeps every packet it judged; a human label becomes a calibration item (a new set revision)', async () => {
    const dir = await tempDir('ht-judge-label-');
    try {
      const packets = join(dir.path, 'packets');
      const judge = recordingJudge(scriptedJudge({ calibration: false }), packets);
      const item = loadCalibrationSet().items[0]!;
      const answer = await judge.judge(item.packet, VERDICT_CONSISTENCY_RUBRIC);
      const files = readdirSync(packets);
      assert.equal(files.length, 1);
      const recorded = JSON.parse(readFileSync(join(packets, files[0]!), 'utf8')) as { answer: { verdict: string } };
      assert.equal(recorded.answer.verdict, answer.verdict);
      const setFile = join(dir.path, 'labels.json');
      assert.throws(() => labelCalibrationItem({ setFile, packetFile: join(packets, files[0]!), label: 'pass', by: 'model:judge' }), /given by a human/);
      assert.throws(() => labelCalibrationItem({ setFile, packetFile: join(packets, files[0]!), label: 'great', by: 'human:ana' }), /label must be one of/);
      const first = labelCalibrationItem({ setFile, packetFile: join(packets, files[0]!), label: 'fail', by: 'human:ana', note: 'the report hides a P1' });
      assert.equal(first.set.items.length, 1);
      assert.equal(first.item.labelledBy, 'human:ana');
      assert.ok(existsSync(setFile));
      assert.throws(() => labelCalibrationItem({ setFile, packetFile: join(packets, files[0]!), label: 'fail', by: 'human:bo' }), /already labels this packet/);
    } finally {
      await dir.cleanup();
    }
  });
});

describe('(F[12], item 18) retained grader revisions for bridges', () => {
  test('generatedTestsGoverned@1 is retained next to the current revision 2; unknown or current revisions are refused', () => {
    assert.equal(GRADER_REVISIONS['generatedTestsGoverned'], '2');
    const r = retainedGrader('generatedTestsGoverned@1');
    assert.deepEqual([r.graderId, r.versioned.revision], ['generatedTestsGoverned', '1']);
    assert.ok(Object.hasOwn(RETAINED_GRADERS, 'generatedTestsGoverned@1'));
    assert.throws(() => retainedGrader('generatedTestsGoverned@2'), /is the CURRENT revision/);
    assert.throws(() => retainedGrader('verdict@0'), /no retained revision verdict@0/);
    assert.throws(() => retainedGrader('nonsense'), /<graderId>@<revision>/);
  });
});
