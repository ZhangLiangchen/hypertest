/**
 * context-freshness (core suite) — one suite run of the scripted multi-LLM arm on the real stack, graded by every task
 * grader AND the independent LLM judge (the calibrated scripted judge, last): kv-service is restarted by the environment
 * operator between the executor's observation of it and the executor's write. The FreshnessGuard refuses the write as
 * stale (generation 1 observed, 2 current), the executor refreshes its view and writes on the fresh generation: the
 * service served exactly ONE write of the marker, in its final process; stale-context actions = 0 (recorded and
 * recomputed). The trial records its model routes per role, its grader revisions (the judge's included) and its key; the
 * persisted SuiteResult passes the eval release gate against itself and fails it once a security violation is added.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { contextFreshnessSuite, evaluateReleaseGate, runSuite, scriptedJudge, scriptedMultiLlmArm, type KvWrite, type SuiteResult } from '../src/index.ts';
import { assertSchemasDropped, baseConfig, capture, failures, payloadOf, schemaPrefix } from './fixtures/poc-e2e.ts';

const PREFIX = schemaPrefix('f');
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-freshness-')));
after(async () => {
  await root.cleanup();
  await assertSchemasDropped(PREFIX);
});

test('context-freshness: a restart between observation and write ⇒ stale_context, refresh, one write on the fresh generation; judged last by the independent judge', async () => {
  const acceptance = capture((ctx) => {
    const d = ctx.data;
    const stale = d.events.filter((e) => e.eventType === 'context.stale_rejected').map((e) => (payloadOf(e)['stale'] as Array<Record<string, unknown>>).map((s) => `${String(s['resourceType'])}/${String(s['resourceId'])} ${String(s['observedVersion'])}→${String(s['currentVersion'])}`).join(','));
    const denied = d.events.filter((e) => e.eventType === 'tool.denied').map((e) => `${String(payloadOf(e)['toolId'])} ${String(payloadOf(e)['errorCode'])}`);
    const marker = d.probes['releaseMarker'] as unknown as { now: { status: number; body: string }; writes: KvWrite[]; generation: number };
    return { stale, denied, marker, verdict: d.decision?.verdict };
  });
  const suite = contextFreshnessSuite();
  const task = suite.tasks[0]!;
  const base = baseConfig(PREFIX);
  const result = await runSuite(
    { ...suite, tasks: [{ ...task, graders: [...task.graders, 'acceptance', 'llmRubric'] }] },
    { arms: [scriptedMultiLlmArm], trials: 1, workDir: join(root.path, 'suite'), timeoutMs: 240_000, graders: { acceptance: acceptance.grader }, judge: scriptedJudge(), ...(base ? { baseConfig: base } : {}) },
  );
  const [trial] = result.trials;
  assert.ok(trial);
  assert.deepEqual(failures(trial), [], JSON.stringify(trial.graders, null, 1));
  assert.deepEqual([trial.result, trial.verdict, trial.error], ['pass', 'pass', undefined]);
  const a = acceptance.value();

  // the world moved between the executor's observation (generation 1) and its write: refused as stale, never executed
  assert.deepEqual(a.stale, ['environment/kv 1:→2:']);
  assert.deepEqual(a.denied, ['http.request stale_context']);
  assert.deepEqual([trial.outcomeMetrics['staleContextRejections'], trial.outcomeMetrics['staleContextActions'], trial.outcomeMetrics['staleMutations']], [1, 0, 0]);
  // ground truth: the service served exactly one write of the marker, after the restart (generation 2), and serves it now
  assert.equal(a.marker.generation, 2);
  assert.equal(a.marker.writes.length, 1, JSON.stringify(a.marker.writes));
  assert.equal(a.marker.writes[0]!.value, 'candidate-1');
  assert.deepEqual([a.marker.now.status, JSON.parse(a.marker.now.body)], [200, { key: 'release', value: 'candidate-1' }]);

  // the independent judge came last, on a provider no agent of the trial used, calibrated ⇒ counted
  const judged = trial.graders.at(-1)!;
  assert.deepEqual([judged.graderId, judged.outcome, judged.counted], ['llmRubric', 'pass', true]);
  const producers = [...new Set((trial.modelRoutes ?? []).map((r) => r.provider))];
  assert.ok(judged.judge?.provider && !producers.includes(judged.judge.provider), `${judged.judge?.provider} ∉ ${producers.join(', ')}`);
  assert.deepEqual(judged.judge?.prohibitedProviders, [...producers].sort());
  assert.ok((judged.judge?.citedEvidence.length ?? 0) > 0, 'grounded in the packet');

  // the trial records its routes per role, its grader revisions (the judge's identity included) and its key
  assert.deepEqual((trial.modelRoutes ?? []).map((r) => `${r.role}:${r.routeId}`).sort(), ['environment:fast-b-tools', 'executor:fast-b-tools', 'lead:reason-a-large', 'reviewer:judge-c-review']);
  assert.ok(trial.modelRoutes!.every((r) => r.epochs >= 1 && r.calls >= 1 && r.model.length > 0));
  assert.equal(trial.graderRevisions?.['freshnessGuarded'], '1');
  assert.match(trial.graderRevisions?.['llmRubric'] ?? '', /^1\/verdict-consistency@1\/judge\[eval-judge-scripted=eval-judge\/eval-judge-scripted-1\]@mc_/);
  assert.match(trial.trialKey ?? '', /^tk_[0-9a-f]{32}$/);
  assert.deepEqual([trial.suiteId, trial.suiteRevision, trial.oracleRevisions], ['context-freshness', 'core-2', { 'kv-release-marker': 1 }]);
  assert.match(trial.harness ?? '', /^hypertest-eval@h\d+\/in-process$/);

  // the persisted result is the release gate's input: like-for-like passes; a security violation fails it
  const persisted = JSON.parse(JSON.stringify(result)) as SuiteResult;
  const same = evaluateReleaseGate(persisted, persisted);
  assert.equal(same.pass, true, JSON.stringify(same.checks, null, 1));
  const violated: SuiteResult = JSON.parse(JSON.stringify(result));
  violated.trials[0]!.outcomeMetrics['securityViolations'] = 1;
  const gate = evaluateReleaseGate(persisted, violated);
  assert.deepEqual([gate.pass, gate.checks.filter((c) => !c.pass).map((c) => c.checkId)], [false, ['security_violations']]);
});
