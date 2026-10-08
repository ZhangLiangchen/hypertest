import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { InMemoryEventSink } from '@hypertest/domain';
import { eventCtx } from '@hypertest/testkit';
import {
  contextMigrations, createExperienceStore, createSkillRegistry, renderSkillMarkdown, skillArmId, skillDigest, withTrialSkills,
  type DurableMemory, type SkillEvalResult, type SkillRegistry, type SkillRevision,
} from '../src/index.ts';
import { openDb, rejectsWith, type Db } from './helpers.ts';

/**
 * (B[7], CONFORMANCE "Learning …" and "candidate skills never enter the active registry without passing eval (100%)"):
 * candidate experience → human review → approved → candidate SKILL → eval validation bound to the revision → published into
 * the ACTIVE registry. Enforced by the registry AND by database triggers; only published skills reach prompts.
 */

let env: Db;
let sink: InMemoryEventSink;
let mem: DurableMemory;
let skills: SkillRegistry;
const human = (name: string) => eventCtx('skill-registry', { actorId: `human:${name}` });

before(async () => {
  env = await openDb(contextMigrations);
  sink = new InMemoryEventSink();
  mem = createExperienceStore({ ...env.deps, events: sink });
  skills = createSkillRegistry({ ...env.deps, events: sink, experiences: mem });
});
after(async () => env.dispose());

async function experience(status: 'candidate' | 'approved' | 'published' | 'rejected', content = 'Retry idempotent GETs only; never retry POSTs blindly.'): Promise<string> {
  const item = await mem.propose({ scope: { role: 'executor' }, kind: 'skill_candidate', content, sourceRunId: 'run_learn', evidenceRefs: ['ev_1'], createdBy: 'agent-rca' }, eventCtx('run_learn'));
  const ctx = eventCtx('run_learn', { actorId: 'human:alice' });
  if (status === 'approved' || status === 'published') await mem.review(item.experienceId, 'approve', 'human:alice', ctx);
  if (status === 'published') await mem.review(item.experienceId, 'publish', 'human:alice', ctx);
  if (status === 'rejected') await mem.review(item.experienceId, 'reject', 'human:alice', ctx);
  return item.experienceId;
}

const SKILL = { name: 'idempotent-retries', description: 'How to retry calls against the SUT without duplicating side effects', body: '1. Retry GET/HEAD only.\n2. A POST that timed out is reconciled, never resent.', scope: { role: 'executor' } };

function evalResult(skill: SkillRevision, outcome: { skill: Array<'pass' | 'fail' | 'infra_error'>; baseline?: Array<'pass' | 'fail'> }): SkillEvalResult {
  const trials: SkillEvalResult['trials'] = outcome.skill.map((result, i) => ({ taskId: 't1', armId: skillArmId(skill), trial: i, result }));
  for (const [i, result] of (outcome.baseline ?? []).entries()) trials.push({ taskId: 't1', armId: 'scripted', trial: i, result });
  return { suiteId: 'context-freshness', revision: 'r1', trials };
}

test('a candidate skill needs APPROVED experience: candidate / rejected / unknown sources and malformed skills are refused', async () => {
  const candidate = await experience('candidate');
  const rejected = await experience('rejected');
  for (const src of [candidate, rejected, 'xp_unknown']) {
    const e = await rejectsWith(skills.propose({ ...SKILL, sourceExperienceIds: [src], createdBy: 'human:bob' }, human('bob')), 'precondition_failed');
    assert.match(e.message, /needs approved experience/);
  }
  await rejectsWith(skills.propose({ ...SKILL, sourceExperienceIds: [], createdBy: 'human:bob' }, human('bob')), 'invalid_argument');
  const approved = await experience('approved');
  await rejectsWith(skills.propose({ ...SKILL, name: 'Not A Skill Name', sourceExperienceIds: [approved], createdBy: 'human:bob' }, human('bob')), 'invalid_argument');
  await rejectsWith(skills.propose({ ...SKILL, scope: { role: 'executor', extra: 'x' } as never, sourceExperienceIds: [approved], createdBy: 'human:bob' }, human('bob')), 'invalid_argument');
  assert.deepEqual(await skills.list(), [], 'nothing was recorded');
});

test('candidate → eval validation bound to the revision → published (by someone else); only published skills reach prompts', async () => {
  const src = await experience('approved');
  const c = await skills.propose({ ...SKILL, sourceExperienceIds: [src], createdBy: 'human:bob' }, human('bob'));
  assert.equal(c.status, 'candidate');
  assert.equal(c.revision, 1);
  assert.equal(c.digest, skillDigest(SKILL));
  assert.deepEqual(await skills.propose({ ...SKILL, sourceExperienceIds: [src], createdBy: 'human:bob' }, human('bob')), c, 'the same content is the same candidate');
  assert.deepEqual(await skills.forPrompt({ role: 'executor', text: 'retry a POST' }), [], 'a candidate never reaches a prompt');

  // publishing without a validation: refused by the registry AND by the database
  const refused = await rejectsWith(skills.publish(c.skillId, 1, 'human:carol', human('carol')), 'precondition_failed');
  assert.match(refused.message, /passing eval validation/);
  await assert.rejects(env.db.query("UPDATE ht_skills SET status = 'published' WHERE skill_id = $1", [c.skillId]), /cannot go from candidate to published/);
  await assert.rejects(env.db.query("UPDATE ht_skills SET status = 'validated' WHERE skill_id = $1", [c.skillId]), /without a passing eval validation/);

  // an eval result that was not run with THIS revision (no trial of its arm) validates nothing
  await rejectsWith(skills.recordValidation(c.skillId, 1, { suiteId: 's', revision: 'r', trials: [{ taskId: 't', armId: 'scripted', trial: 0, result: 'pass' }] }, { recordedBy: 'human:carol' }, human('carol')), 'precondition_failed');
  // a failing eval (pass rate below 1, or worse than the cold-track baseline) is recorded and keeps it a candidate
  const failed = await skills.recordValidation(c.skillId, 1, evalResult(c, { skill: ['pass', 'fail'], baseline: ['pass', 'pass'] }), { recordedBy: 'human:carol' }, human('carol'));
  assert.equal(failed.passed, false);
  assert.equal(failed.baselineArmId, 'scripted');
  assert.match(failed.reasons.join('; '), /pass rate 0\.500 below 1/);
  assert.match(failed.reasons.join('; '), /below the baseline arm scripted/);
  assert.equal((await skills.get(c.skillId))!.status, 'candidate');
  await rejectsWith(skills.publish(c.skillId, 1, 'human:carol', human('carol')), 'precondition_failed');
  assert.equal(sink.ofType('skill.validation_failed').length, 1);

  // a passing eval of the exact revision validates it
  const passed = await skills.recordValidation(c.skillId, 1, evalResult(c, { skill: ['pass', 'pass'], baseline: ['pass', 'fail'] }), { recordedBy: 'human:carol' }, human('carol'));
  assert.equal(passed.passed, true);
  assert.equal(passed.armId, skillArmId(c));
  assert.equal(passed.passRate, 1);
  assert.equal(passed.baselinePassRate, 0.5);
  assert.equal((await skills.get(c.skillId))!.status, 'validated');
  assert.deepEqual(await skills.forPrompt({ role: 'executor' }), [], 'validated is not published');
  // the creator never publishes its own skill
  await rejectsWith(skills.publish(c.skillId, 1, 'human:bob', human('bob')), 'permission_denied');
  const published = await skills.publish(c.skillId, 1, 'human:carol', human('carol'));
  assert.equal(published.status, 'published');
  assert.equal(published.publishedBy, 'human:carol');
  assert.deepEqual((await skills.forPrompt({ role: 'executor', text: 'retry' })).map((s) => s.skillId), [c.skillId]);
  assert.deepEqual(await skills.forPrompt({ role: 'reviewer', text: 'retry' }), [], 'scoped to the executor role');
  assert.equal(sink.ofType('skill.published').at(-1)!.aggregateId, c.skillId);
  assert.match(renderSkillMarkdown(published), /^---\nname: idempotent-retries\ndescription: "How to retry/);

  // the content of a revision is immutable in the database; revisions are never deleted; validations are append-only
  await assert.rejects(env.db.query("UPDATE ht_skills SET body = 'resend everything' WHERE skill_id = $1", [c.skillId]), /immutable/);
  await assert.rejects(env.db.query('DELETE FROM ht_skills WHERE skill_id = $1', [c.skillId]), /never deleted/);
  await assert.rejects(env.db.query('UPDATE ht_skill_validations SET passed = true WHERE skill_id = $1', [c.skillId]), /append-only/);
  await assert.rejects(env.db.query('DELETE FROM ht_skill_validations WHERE skill_id = $1', [c.skillId]), /append-only/);
  await assert.rejects(
    env.db.query(
      `INSERT INTO ht_skills (skill_id, revision, name, description, body, scope, digest, status, source_experience_ids, created_by, created_at, updated_at)
       VALUES ('skl_forged', 1, 'forged', 'd', 'b', '{}'::jsonb, 'x', 'published', '[]'::jsonb, 'agent', now(), now())`,
    ),
    /created as a candidate/,
  );

  // a new revision replaces the published one only once IT is validated and published (one active revision per skill)
  const r2 = await skills.propose({ ...SKILL, skillId: c.skillId, body: `${SKILL.body}\n3. Cite the operation id.`, sourceExperienceIds: [src], createdBy: 'human:bob' }, human('bob'));
  assert.equal(r2.revision, 2);
  assert.equal(r2.status, 'candidate');
  assert.deepEqual((await skills.forPrompt({ role: 'executor', text: 'retry' })).map((s) => s.revision), [1]);
  await rejectsWith(skills.recordValidation(c.skillId, 2, evalResult(c, { skill: ['pass'] }), { recordedBy: 'human:carol' }, human('carol')), 'precondition_failed');
  await skills.recordValidation(c.skillId, 2, evalResult(r2, { skill: ['pass'] }), { recordedBy: 'human:carol' }, human('carol'));
  await skills.publish(c.skillId, 2, 'human:carol', human('carol'));
  assert.deepEqual((await skills.list({ skillId: c.skillId })).map((s) => [s.revision, s.status]), [[1, 'retired'], [2, 'published']]);
  assert.deepEqual((await skills.forPrompt({ role: 'executor', text: 'retry' })).map((s) => s.revision), [2]);

  // retire: the skill leaves the active registry
  await skills.retire(c.skillId, 'human:carol', human('carol'));
  assert.deepEqual(await skills.forPrompt({ role: 'executor', text: 'retry' }), []);
  await rejectsWith(skills.retire(c.skillId, 'human:carol', human('carol')), 'precondition_failed');
});

test('the LATEST validation decides: a validated revision that later fails eval goes back to candidate and cannot be published', async () => {
  const src = await experience('published', 'Always check the response schema before asserting values.');
  const c = await skills.propose({ name: 'schema-first', description: 'Assert the schema first', body: 'Validate the JSON schema, then the values.', sourceExperienceIds: [src], createdBy: 'human:bob' }, human('bob'));
  await skills.recordValidation(c.skillId, 1, evalResult(c, { skill: ['pass'] }), { recordedBy: 'human:carol' }, human('carol'));
  assert.equal((await skills.get(c.skillId))!.status, 'validated');
  await skills.recordValidation(c.skillId, 1, evalResult(c, { skill: ['infra_error'] }), { recordedBy: 'human:carol' }, human('carol'));
  assert.equal((await skills.get(c.skillId))!.status, 'candidate');
  await rejectsWith(skills.publish(c.skillId, 1, 'human:carol', human('carol')), 'precondition_failed');
  // even a hand-written status change is refused by the database: the latest validation failed
  await env.db.transaction(async (tx) => {
    await assert.rejects(tx.query("UPDATE ht_skills SET status = 'validated' WHERE skill_id = $1", [c.skillId]), /without a passing eval validation/);
  }).catch(() => undefined);
  assert.equal((await skills.get(c.skillId))!.status, 'candidate');
  // minTrials / minPassRate thresholds
  const few = await skills.recordValidation(c.skillId, 1, evalResult(c, { skill: ['pass'] }), { recordedBy: 'human:carol', minTrials: 3 }, human('carol'));
  assert.equal(few.passed, false);
  assert.match(few.reasons[0]!, /fewer than 3/);
  await rejectsWith(skills.recordValidation(c.skillId, 1, evalResult(c, { skill: ['pass'] }), { recordedBy: 'human:carol', minPassRate: 2 }, human('carol')), 'invalid_argument');
  // (review) a zero threshold would let a skill whose every trial failed "pass": refused; zero passes never pass
  await rejectsWith(skills.recordValidation(c.skillId, 1, evalResult(c, { skill: ['fail', 'fail'] }), { recordedBy: 'human:carol', minPassRate: 0 }, human('carol')), 'invalid_argument');
  const none = await skills.recordValidation(c.skillId, 1, evalResult(c, { skill: ['fail'], baseline: ['fail'] }), { recordedBy: 'human:carol', minPassRate: 0.0001 }, human('carol'));
  assert.equal(none.passed, false);
  assert.match(none.reasons.join('; '), /pass rate 0\.000 below 0\.0001/);
  // (review) the database refuses a validation row whose `passed` contradicts its own numbers (or a zero threshold), so a
  // hand-written "passing" row can never validate the revision
  const row = (passed: boolean, passes: number, minPassRate: number) => env.db.query(
    `INSERT INTO ht_skill_validations (validation_id, skill_id, revision, digest, suite_id, suite_revision, arm_id, trials, passes, pass_rate, min_pass_rate, min_trials, passed, reasons, result_digest, recorded_by, recorded_at)
     VALUES ($1, $2, 1, $3, 's', 'r', 'a', 2, $4, $5, $6, 1, $7, '[]'::jsonb, 'd', 'human:mallory', now())`,
    [`sklv_forged_${passes}_${minPassRate}_${passed}`, c.skillId, c.digest, passes, passes / 2, minPassRate, passed],
  );
  await assert.rejects(row(true, 0, 0.5), /ht_skill_validations_consistent/);
  await assert.rejects(row(true, 1, 0.9), /ht_skill_validations_consistent/);
  await assert.rejects(row(false, 0, 0), /ht_skill_validations_consistent/);
  await assert.rejects(env.db.query(
    `INSERT INTO ht_skill_validations (validation_id, skill_id, revision, digest, suite_id, suite_revision, arm_id, trials, passes, pass_rate, min_pass_rate, min_trials, passed, reasons, result_digest, recorded_by, recorded_at)
     VALUES ('sklv_forged_rate', $1, 1, $2, 's', 'r', 'a', 2, 0, 1, 0.5, 1, true, '[]'::jsonb, 'd', 'human:mallory', now())`,
    [c.skillId, c.digest],
  ), /ht_skill_validations_consistent/, 'a pass rate that is not passes / trials');
  assert.equal((await skills.get(c.skillId))!.status, 'candidate');
  // a human rejection ends the revision (never by its creator)
  await rejectsWith(skills.reject(c.skillId, 1, 'human:bob', human('bob')), 'permission_denied');
  assert.equal((await skills.reject(c.skillId, 1, 'human:carol', human('carol'))).status, 'rejected');
  await rejectsWith(skills.recordValidation(c.skillId, 1, evalResult(c, { skill: ['pass'] }), { recordedBy: 'human:carol' }, human('carol')), 'precondition_failed');
});

test('trial skills (an eval arm under evaluation) reach the evaluated prompts marked as candidates, and only with an intact digest', async () => {
  const base = createSkillRegistry({ ...env.deps, experiences: mem });
  const trial: SkillRevision = {
    skillId: 'skl_trial', revision: 1, name: 'trial-skill', description: 'Under evaluation', body: 'Do the thing.', scope: { role: 'executor' }, digest: '', status: 'candidate',
    sourceExperienceIds: ['xp_x'], createdBy: 'human:bob', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  trial.digest = skillDigest(trial);
  const view = withTrialSkills(base, [trial]);
  const shown = await view.forPrompt({ role: 'executor', text: 'anything' });
  assert.deepEqual(shown.map((s) => [s.skillId, s.description]), [['skl_trial', '[candidate under evaluation] Under evaluation']]);
  assert.deepEqual(await view.forPrompt({ role: 'reviewer' }), [], 'scope still applies');
  assert.throws(() => withTrialSkills(base, [{ ...trial, body: 'tampered' }]), /does not hash to its digest/);
  assert.deepEqual(await base.list({ skillId: 'skl_trial' }), [], 'a trial skill never enters the registry');
});
