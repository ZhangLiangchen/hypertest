/**
 * (e2e[6]) Verdict-aware exit codes proven by REAL scripted runs per verdict — pass 0, fail 3, conditional 4,
 * inconclusive 5 — and, beyond the exit code, that each run CONVERGED the way the scenario says: the lead's plans were
 * accepted (no schema-refused proposal, no repetitive-loop failure, the plan left v1 where the scenario replans), so a
 * verdict is never reached by exhausting broken replans.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { DomainEvent } from '@hypertest/domain';
import { tempDir } from '@hypertest/testkit';
import { BRAINS, GOAL, cli, parseJson, sumRepo, writeProject, type TestProject } from './helpers.ts';

describe('verdict-aware exit codes from converged scripted runs', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let good: Awaited<ReturnType<typeof sumRepo>>;
  let bad: Awaited<ReturnType<typeof sumRepo>>;
  const projects: TestProject[] = [];

  before(async () => {
    dir = await tempDir('ht-cli-exitcodes-');
    good = await sumRepo(true);
    bad = await sumRepo(false);
  });
  after(async () => {
    for (const p of projects) await p.dispose();
    await good?.cleanup();
    await bad?.cleanup();
    await dir?.cleanup();
  });

  async function scenario(name: string, brainScenario: string, repoPath: string, extra: Record<string, unknown> = {}) {
    const cwd = join(dir.path, name);
    await mkdir(cwd);
    const project = await writeProject(cwd, extra);
    projects.push(project);
    const env = { ...project.env, HT_CLI_SCENARIO: brainScenario };
    const r = await cli(['run', GOAL, '--repo', repoPath, '--commit', 'HEAD', '--scripted-brains', BRAINS, '--timeout-ms', '120000', '--json'], { cwd, env });
    const out = parseJson<{ runId: string; verdict: string; exitCode: number }>(r);
    const listed = await cli(['events', out.runId, '--json'], { cwd, env });
    assert.equal(listed.code, 0, listed.stderr);
    const events = listed.stdout.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as DomainEvent<unknown>);
    assert.ok(events.length > 0);
    const payload = (e: DomainEvent<unknown>) => (e.payload ?? {}) as Record<string, unknown>;
    return {
      code: r.code, out,
      refusedPlans: events.filter((e) => e.eventType === 'tool.denied' && payload(e)['toolId'] === 'plan.propose_revision').map((e) => String(payload(e)['reason'])),
      loops: events.filter((e) => e.eventType === 'work.failed' && /repetitive_loop/.test(JSON.stringify(e.payload))).length,
      acceptedPlans: events.filter((e) => e.eventType === 'plan.accepted').length,
    };
  }

  test('pass ⇒ 0, converged (two accepted plans, nothing refused)', async () => {
    const s = await scenario('pass', 'pass', good.path);
    assert.deepEqual([s.code, s.out.verdict, s.out.exitCode], [0, 'pass', 0]);
    assert.deepEqual([s.refusedPlans, s.loops], [[], 0]);
    assert.ok(s.acceptedPlans >= 2, `${s.acceptedPlans} accepted plan(s)`);
  });

  test('fail ⇒ 3, converged: the replan that hands the failed objective to the gate is accepted (no schema refusal, no loop)', async () => {
    const s = await scenario('fail', 'fail', bad.path);
    assert.deepEqual([s.code, s.out.verdict, s.out.exitCode], [3, 'fail', 3]);
    assert.deepEqual(s.refusedPlans, [], 'no plan proposal was refused');
    assert.equal(s.loops, 0, 'no work item failed in a repetitive loop');
    assert.ok(s.acceptedPlans >= 2, `the plan left v1 (${s.acceptedPlans} accepted)`);
  });

  test('conditional ⇒ 4, converged', async () => {
    const s = await scenario('conditional', 'pass', good.path, { gate: { requireIndependentReview: true } });
    assert.deepEqual([s.code, s.out.verdict, s.out.exitCode], [4, 'conditional', 4]);
    assert.deepEqual([s.refusedPlans, s.loops], [[], 0]);
  });

  test('inconclusive ⇒ 5, never pass; no refused proposal', async () => {
    const s = await scenario('inconclusive', 'inconclusive', good.path);
    assert.deepEqual([s.code, s.out.verdict, s.out.exitCode], [5, 'inconclusive', 5]);
    assert.deepEqual(s.refusedPlans, []);
  });
});
