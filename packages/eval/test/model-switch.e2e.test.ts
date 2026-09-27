/**
 * model-switch (core suite) — the suite (baseline + switch) on the scripted multi-LLM arm, run as a BRIDGE dataset:
 * the executor's primary route (fast-b) times out on every call after its first tool result; the router re-validates a
 * fallback route and the SAME executor continues its work item in a new ModelEpoch. The canonical state (plan, blackboard,
 * evidence) and the verdict equal the no-failure baseline (suite-level baselineEquivalence). The trials record the
 * executor on two routes with the switch reason. Every trial is also graded by a candidate revision of `verdict`
 * (HarnessOptions.bridge): the bridge comparison reports continuity. The single-provider arm cannot switch: its trial
 * fails (no fallback, the canonical state diverges from its baseline).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { modelSwitchSuite, runBridge, runSuite, scriptedMultiLlmArm, scriptedSingleArm, verdictGrader, type SuiteOptions } from '../src/index.ts';
import { assertSchemasDropped, baseConfig, failures, schemaPrefix } from './fixtures/poc-e2e.ts';

const PREFIX = schemaPrefix('m');
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-model-switch-')));
after(async () => {
  await root.cleanup();
  await assertSchemasDropped(PREFIX);
});

function options(dir: string, arms: SuiteOptions['arms']): SuiteOptions {
  const base = baseConfig(PREFIX);
  return { arms, trials: 1, workDir: join(root.path, dir), timeoutMs: 240_000, ...(base ? { baseConfig: base } : {}) };
}

test('model-switch: the primary route fails mid-run ⇒ fallback epoch, same agent and work item, canonical state and verdict of the baseline; bridged grader revision', async () => {
  const { result, reports } = await runBridge(modelSwitchSuite(), options('multi', [scriptedMultiLlmArm]), { verdict: { revision: '2-candidate', grader: verdictGrader } }, runSuite);
  const [baseline, switched] = result.trials;
  assert.ok(baseline && switched);
  assert.deepEqual([baseline.taskId, switched.taskId], ['model-switch-baseline', 'model-switch']);
  for (const t of [baseline, switched]) assert.deepEqual([failures(t), t.result, t.verdict], [[], 'pass', 'fail'], JSON.stringify(t.graders, null, 1));
  // suite level: same verdict and canonical state as the no-failure baseline
  const eq = switched.graders.find((g) => g.graderId === 'baselineEquivalence');
  assert.deepEqual([eq?.pass, eq?.revision], [true, '1']);
  assert.equal(switched.canonical?.digest, baseline.canonical?.digest);
  assert.equal(switched.graderRevisions?.['baselineEquivalence'], '1');
  // the executor ran on its primary route, then — after the failure — on the re-validated fallback, in a new epoch
  const executor = (switched.modelRoutes ?? []).filter((r) => r.role === 'executor');
  assert.equal(executor.length, 2, JSON.stringify(switched.modelRoutes));
  assert.deepEqual(executor.find((r) => r.routeId === 'fast-b-tools')?.switchReasons, ['initial']);
  const fallback = executor.find((r) => r.routeId !== 'fast-b-tools')!;
  assert.ok(fallback.epochs === 1 && fallback.calls >= 1 && fallback.switchReasons[0] !== 'initial', JSON.stringify(fallback));
  assert.ok(executor.every((r) => r.agents === 1));
  assert.equal(switched.trajectoryMetrics['modelFallbacks'], 1);
  assert.equal((baseline.modelRoutes ?? []).filter((r) => r.role === 'executor').length, 1, 'the baseline never switched');
  // the bridge: the candidate revision graded the same trials; continuous with revision 1
  assert.deepEqual(reports.map((r) => [r.graderId, r.fromRevision, r.toRevision, r.pairs, r.agreement, r.discontinuity]), [['verdict', '1', '2-candidate', 2, 1, false]]);
  assert.ok(switched.bridge?.every((b) => b.revision === '2-candidate'));
});

test('model-switch: a single provider cannot fall back — the trial fails and diverges from its baseline', async () => {
  const result = await runSuite(modelSwitchSuite(), options('single', [scriptedSingleArm]));
  const switched = result.trials.find((t) => t.taskId === 'model-switch')!;
  assert.equal(switched.result, 'fail');
  const failed = switched.graders.filter((g) => !g.pass).map((g) => g.graderId);
  assert.ok(failed.includes('modelFallback') && failed.includes('modelSwitchContinuity') && failed.includes('baselineEquivalence'), failed.join(', '));
});
