/**
 * (B[7]) createHypertest wires the Skill Registry into L1: only PUBLISHED skills reach a real run's agent prompts (a candidate
 * never does); an eval arm's `skills.trial` revision reaches the prompts of that instance only, marked as under evaluation, and
 * only with an intact digest.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, skillArmId, skillDigest, type HypertestInstance, type SkillRevision } from '../src/index.ts';
import { roleRouter, scriptedConfig, sumRepo, testStore, tinyRunBrains, type BrainView } from './helpers.ts';

let dir: Awaited<ReturnType<typeof tempDir>>;
let repo: Awaited<ReturnType<typeof sumRepo>>;
let db: Awaited<ReturnType<typeof testStore>>;
let ht: HypertestInstance | undefined;
const executorViews: BrainView[] = [];

function brains() {
  const b = tinyRunBrains();
  const exec = b['executor']!;
  b['executor'] = (v) => {
    if (v.step === 0) executorViews.push(v);
    return exec(v);
  };
  return b;
}

before(async () => {
  dir = await tempDir('ht-app-skills-');
  repo = await sumRepo();
  db = await testStore();
});
after(async () => {
  await ht?.close();
  await db?.dispose();
  await repo?.cleanup();
  await dir?.cleanup();
});

test('a candidate skill never reaches a prompt; once validated and published it is in the executor\'s Skills section', async () => {
  const config = scriptedConfig(join(dir.path, 'a'), { gate: { requireIndependentReview: false } });
  ht = await createHypertest(db.store ? { ...config, store: db.store } : config, { scriptedBrains: { sim: roleRouter(brains()) }, logger: new MemoryLogger() });
  const skills = ht.services.skills!;
  const ctx = { runId: 'skills-setup', correlationId: 'skills-setup', actorId: 'human:alice' };
  const xp = await ht.services.memory.propose({ scope: { role: 'executor' }, kind: 'skill_candidate', content: 'run the whole suite, then the failing selector alone', sourceRunId: 'skills-setup', evidenceRefs: [], createdBy: 'agent:ag_rca' }, ctx);
  await ht.services.memory.review(xp.experienceId, 'approve', 'human:alice', ctx);
  const skill = await skills.propose({ name: 'suite-then-selector', description: 'Run the whole suite first', body: 'SKILL-BODY-MARKER: run the whole suite, then re-run the failing selector alone.', scope: { role: 'executor' }, sourceExperienceIds: [xp.experienceId], createdBy: 'human:bob' }, { ...ctx, actorId: 'human:bob' });

  const r1 = await ht.run({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 90_000 });
  assert.equal(r1.status, 'completed');
  assert.ok(!executorViews.at(-1)!.userText.includes('SKILL-BODY-MARKER'), 'a candidate skill is not in the prompt');

  await skills.recordValidation(skill.skillId, 1, { suiteId: 'context-freshness', revision: 'r1', trials: [{ taskId: 't', armId: skillArmId(skill), trial: 0, result: 'pass' }] }, { recordedBy: 'human:carol' }, ctx);
  await skills.publish(skill.skillId, 1, 'human:carol', { ...ctx, actorId: 'human:carol' });
  const r2 = await ht.run({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 90_000 });
  assert.equal(r2.status, 'completed');
  const prompt = executorViews.at(-1)!.userText;
  assert.match(prompt, /## Skills \(published, validated by eval\)\n### suite-then-selector \(skl_\w+ r1\)\nRun the whole suite first\nSKILL-BODY-MARKER/);
  // what the prompt delivered is pinned (the skill revision, immutable)
  const pinned = await ht.services.db.query<{ resource_id: string; observed_version: string }>("SELECT DISTINCT resource_id, observed_version FROM ht_context_observations WHERE run_id = $1 AND resource_type = 'skill'", [r2.runId]);
  assert.deepEqual(pinned.rows.map((r) => [r.resource_id, r.observed_version]), [[skill.skillId, `1:${skill.digest}`]]);
  await ht.close();
  ht = undefined;
});

test('skills.trial (an eval arm) shows its candidate, marked, in that instance only; a tampered trial revision is refused', async () => {
  const trial: SkillRevision = {
    skillId: 'skl_trial', revision: 1, name: 'trial-skill', description: 'Trial description', body: 'TRIAL-BODY-MARKER', scope: { role: 'executor' }, digest: '',
    status: 'candidate', sourceExperienceIds: ['xp_1'], createdBy: 'human:bob', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  trial.digest = skillDigest(trial);
  const config = scriptedConfig(join(dir.path, 'b'), { gate: { requireIndependentReview: false }, skills: { trial: [trial] } } as never);
  ht = await createHypertest(db.store ? { ...config, store: db.store } : config, { scriptedBrains: { sim: roleRouter(brains()) }, logger: new MemoryLogger() });
  const r = await ht.run({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 90_000 });
  assert.equal(r.status, 'completed');
  assert.match(executorViews.at(-1)!.userText, /### trial-skill \(skl_trial r1\)\n\[candidate under evaluation\] Trial description\nTRIAL-BODY-MARKER/);
  // (on PostgreSQL both tests share one schema: the first test's published skill is in it — the trial one never is)
  assert.deepEqual((await ht.services.skills!.list({})).filter((x) => x.skillId === trial.skillId), [], 'a trial revision never enters the registry');
  await ht.close();
  ht = undefined;
  const tampered = scriptedConfig(join(dir.path, 'c'), { skills: { trial: [{ ...trial, body: 'tampered' }] } } as never);
  await assert.rejects(createHypertest(db.store ? { ...tampered, store: db.store } : tampered, { scriptedBrains: { sim: roleRouter(brains()) }, logger: new MemoryLogger() }), /does not hash to its digest/);
});
