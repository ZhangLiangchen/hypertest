/**
 * The optional live arm: PoC B (event-driven black-box defect loop) driven by a REAL model provider, configured through
 * `HYPERTEST_EVAL_LIVE=1`, `HYPERTEST_EVAL_LIVE_KIND`, `HYPERTEST_EVAL_LIVE_MODEL`, `HYPERTEST_EVAL_LIVE_API_KEY` (and
 * `HYPERTEST_EVAL_LIVE_BASE_URL` for openai-compatible). Skipped — with the reason — when not configured: live model
 * calls are opt-in and never part of the hermetic suite. A live model may fail the task; the trial must still be run
 * and graded on the same outcome graders (never an infra error of the harness).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { liveArm, liveArmAvailable, pocBTask, runTrial } from '../src/index.ts';
import { assertSchemasDropped, schemaPrefix, trialOptions } from './fixtures/poc-e2e.ts';

const available = liveArmAvailable();
const PREFIX = schemaPrefix('l');
let root: Awaited<ReturnType<typeof tempDir>> | undefined;
before(async () => {
  if (available.ok) root = await tempDir('ht-poc-live-');
});
after(async () => {
  await root?.cleanup();
  await assertSchemasDropped(PREFIX);
});

test('live arm: PoC B against a real provider is run and graded by the same outcome graders', { skip: available.ok ? false : `live arm not configured: ${available.reason}` }, async () => {
  const task = pocBTask();
  const trial = await runTrial(task, liveArm(), trialOptions(PREFIX, join(root!.path, 'trial'), { timeoutMs: 900_000 }));
  assert.notEqual(trial.result, 'infra_error', trial.error);
  assert.deepEqual(trial.graders.map((g) => g.graderId), task.graders);
  assert.ok(trial.runId?.startsWith('run_'));
});
