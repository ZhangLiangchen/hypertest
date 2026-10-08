/**
 * (B[7]) `hypertest skill …` — the learning pipeline's human surface over the store-enforced Skill Registry:
 * candidate experience → human review (approved) → candidate SKILL (propose) → eval validation bound to the revision (validate,
 * over the eval platform injected as a stub here) → published into the active registry (publish) → retire. Refusals: a
 * candidate experience as source, publishing without a passing validation, publishing by the creator, a failing eval, a
 * decision from inside a sandbox.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { createHypertest, defaultConfig, loadConfig, type HypertestConfig, type SkillRevision } from '@hypertest/app';
import type { EvalArm, EvalSuite, EvalTrial, SuiteOptions, SuiteResult } from '@hypertest/eval';
import { tempDir } from '@hypertest/testkit';
import type { EvalModuleLike } from '../src/index.ts';
import { cli, parseJson, writeProject, type TestProject } from './helpers.ts';

/** A stub eval platform: one suite, arm `scripted`; trials of the arms listed in `failing` fail. Records the arms it ran. */
function stubEval(failing: () => string[]): { module: EvalModuleLike; ran: Array<{ suite: EvalSuite; options: SuiteOptions }> } {
  const ran: Array<{ suite: EvalSuite; options: SuiteOptions }> = [];
  const scripted: EvalArm = { armId: 'scripted', description: 'scripted brains', config: (base) => base };
  const module: EvalModuleLike = {
    contextFreshnessSuite: () => ({ suiteId: 'context-freshness', revision: 'r1', tasks: [{ taskId: 't1', suiteRevision: 'r1', title: 't', goal: 'g', setup: async () => ({ target: {}, cleanup: async () => undefined }), hiddenFaults: [], expectedVerdict: 'pass', graders: [] }] }),
    arms: [scripted],
    async runSuite(suite, options) {
      ran.push({ suite, options });
      const trials: EvalTrial[] = [];
      for (const a of options.arms) {
        for (let i = 0; i < options.trials; i++) trials.push({ taskId: 't1', armId: a.armId, trial: i, seed: `s${i}`, result: failing().includes(a.armId) ? 'fail' : 'pass', graders: [], outcomeMetrics: {}, trajectoryMetrics: {}, durationMs: 1 });
      }
      return { suiteId: suite.suiteId, revision: suite.revision, trials, perArm: {}, comparisons: [] } as SuiteResult;
    },
  };
  return { module, ran };
}

describe('hypertest skill: propose → validate (eval) → publish → retire', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let project: TestProject;
  let approved = '';
  let candidate = '';
  let failing: string[] = [];
  const evalStub = stubEval(() => failing);
  const run = (argv: string[], env: Record<string, string> = {}) => cli(argv, { cwd: dir.path, env: { ...project.env, ...env }, loadEval: async () => evalStub.module });

  before(async () => {
    dir = await tempDir('ht-cli-skill-');
    project = await writeProject(dir.path);
    const config = await loadConfig(project.configPath, { env: { ...process.env, ...project.env } });
    const ht = await createHypertest(config, { env: { ...process.env, ...project.env }, scriptedBrains: { sim: () => ({ text: 'unused' }) }, logger: new MemoryLogger() });
    try {
      const ctx = { runId: 'run_learning', correlationId: 'run_learning', actorId: 'agent:ag_rca' };
      approved = (await ht.services.memory.propose({ scope: { role: 'executor' }, kind: 'skill_candidate', content: 'Retry idempotent GETs only; reconcile a timed-out POST instead of resending it.', sourceRunId: 'run_learning', evidenceRefs: [], createdBy: 'agent:ag_rca' }, ctx)).experienceId;
      await ht.services.memory.review(approved, 'approve', 'human:alice', { ...ctx, actorId: 'human:alice' });
      candidate = (await ht.services.memory.propose({ scope: {}, kind: 'lesson', content: 'unreviewed hunch', sourceRunId: 'run_learning', evidenceRefs: [], createdBy: 'agent:ag_rca' }, ctx)).experienceId;
    } finally {
      await ht.close();
    }
  });
  after(async () => {
    await project?.dispose();
    await dir?.cleanup();
  });

  test('the whole pipeline with its refusals', async () => {
    // a candidate (unreviewed) experience never becomes a skill
    const refused = await run(['skill', 'propose', '--from', candidate, '--name', 'hunch', '--description', 'd', '--body', 'b', '--by', 'bob']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, new RegExp(`a candidate skill needs approved experience: ${candidate} is not approved or published \\[precondition_failed\\]`));
    // proposed from approved experience
    const proposed = parseJson<SkillRevision>(await run(['skill', 'propose', '--from', approved, '--name', 'idempotent-retries', '--description', 'Retry without duplicating side effects', '--body', '1. Retry GET/HEAD only.\n2. Reconcile a timed-out POST.', '--role', 'executor', '--by', 'bob', '--json']));
    assert.deepEqual([proposed.status, proposed.revision, proposed.createdBy, proposed.sourceExperienceIds], ['candidate', 1, 'human:bob', [approved]]);
    const id = proposed.skillId;
    // not yet validated: not publishable (the registry, not the CLI, refuses)
    const early = await run(['skill', 'publish', id, '--by', 'carol']);
    assert.equal(early.code, 1);
    assert.match(early.stderr, /a skill enters the active registry only with a passing eval validation of this revision \(none recorded\) \[precondition_failed\]/);
    // a failing eval (the skill arm fails) is recorded and keeps it a candidate
    const armId = `skill-${id}-r1-${proposed.digest.slice(0, 12)}`;
    failing = [armId];
    const failed = await run(['skill', 'validate', id, '--suite', 'context-freshness', '--by', 'carol']);
    assert.equal(failed.code, 1, failed.stderr);
    assert.match(failed.stdout, /validation \S+: FAILED \(arm skill-\S+: 0\/1 passed, baseline scripted 1\.000\) — pass rate 0\.000 below 1; pass rate 0\.000 below the baseline arm scripted/);
    // the eval ran two arms: the cold track and the arm bound to the revision, whose configuration injects exactly this revision
    const lastRun = evalStub.ran.at(-1)!;
    assert.deepEqual(lastRun.options.arms.map((a) => a.armId), ['scripted', armId]);
    const armConfig = lastRun.options.arms[1]!.config(defaultConfig({}) as HypertestConfig, {} as never);
    assert.deepEqual((armConfig.skills?.trial ?? []).map((s) => [s.skillId, s.revision, s.digest]), [[id, 1, proposed.digest]]);
    assert.equal(lastRun.options.arms[0]!.config(defaultConfig({}) as HypertestConfig, {} as never).skills, undefined, 'the cold track has no skill');
    // a passing eval validates it
    failing = [];
    const passed = await run(['skill', 'validate', id, '--suite', 'context-freshness', '--trials', '2', '--by', 'carol', '--json']);
    assert.equal(passed.code, 0, passed.stderr);
    assert.deepEqual([parseJson<{ passed: boolean; trials: number }>(passed).passed, parseJson<{ trials: number }>(passed).trials], [true, 2]);
    // never published by its creator, never from a sandbox
    const self = await run(['skill', 'publish', id, '--by', 'bob']);
    assert.match(self.stderr, /cannot be published by its creator human:bob \[permission_denied\]/);
    const sandboxed = await run(['skill', 'publish', id, '--by', 'carol'], { HYPERTEST_SANDBOX: '1' });
    assert.match(sandboxed.stderr, /skill publish is a human decision and cannot be taken from inside a Hypertest sandbox/);
    const published = await run(['skill', 'publish', id, '--by', 'carol']);
    assert.deepEqual([published.code, published.stdout], [0, `skill ${id} r1 published by human:carol\n`]);
    const listed = parseJson<SkillRevision[]>(await run(['skill', 'list', '--status', 'published', '--json']));
    assert.deepEqual(listed.map((s) => [s.skillId, s.status]), [[id, 'published']]);
    const shown = await run(['skill', 'show', id]);
    assert.match(shown.stdout, /^# \S+ r1 \[published\] digest [0-9a-f]{64}\n/);
    assert.match(shown.stdout, /# validation \S+: PASSED context-freshness/);
    assert.match(shown.stdout, /---\nname: idempotent-retries\ndescription: "Retry without duplicating side effects"\n---\n\n1\. Retry GET\/HEAD only\./);
    const retired = await run(['skill', 'retire', id, '--by', 'carol']);
    assert.deepEqual([retired.code, retired.stdout], [0, `skill ${id} r1 retired by human:carol\n`]);
    assert.deepEqual(parseJson<SkillRevision[]>(await run(['skill', 'list', '--json'])).filter((s) => s.skillId === id), [], 'a retired skill is out of the default list');
  });

  test('usage errors', async () => {
    assert.match((await run(['skill'])).stderr, /missing sub-command \(skill list \| show \| propose \| validate \| publish \| retire \| reject\)/);
    assert.match((await run(['skill', 'validate', 'skl_x', '--by', 'carol'])).stderr, /exactly one of --suite and --result is required/);
    assert.match((await run(['skill', 'propose', '--from', 'xp_1', '--name', 'n', '--description', 'd', '--by', 'bob'])).stderr, /exactly one of --body-file and --body is required/);
    assert.match((await run(['skill', 'list', '--status', 'bogus'])).stderr, /--status: unknown skill status "bogus"/);
    // (review) a zero threshold would let a skill whose every trial failed pass its validation
    assert.match((await run(['skill', 'validate', 'skl_x', '--suite', 's', '--min-pass-rate', '0', '--by', 'carol'])).stderr, /--min-pass-rate must be a number in \(0, 1\]/);
  });
});
