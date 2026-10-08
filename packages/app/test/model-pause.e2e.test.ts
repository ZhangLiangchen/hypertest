/**
 * A[0] the fallback pipeline ends in ALLOW or PAUSE, through createHypertest and the durable runtimes: a single-route
 * deployment whose provider times out (the audit probe) PAUSES the lead's work item (L0 `work.paused`, pauseReason
 * model_unavailable) instead of failing it; the durable runtime resumes it after the pause's resume time
 * (`work.resumed`) and the run completes. Local runtime always; Temporal when its infrastructure is up (skipped with an
 * explicit reason otherwise).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import type { ScriptedBrain } from '@hypertest/model';
import { openDatabase } from '@hypertest/store';
import { infraEnv, skipUnless, tempDir } from '@hypertest/testkit';
import { createHypertest, type HypertestConfig } from '../src/index.ts';
import { roleRouter, scriptedConfig, sumRepo, testStore, tinyRunBrains } from './helpers.ts';

const infra = infraEnv();
const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => undefined);
});

/** The provider times out on the first `n` calls (one invoke = 2 same-route attempts), then answers. */
function flaky(n: number): ScriptedBrain {
  const base = roleRouter(tinyRunBrains());
  let left = n;
  return (request, info) => (left-- > 0 ? { error: 'timeout', message: 'provider timed out' } : base(request, info));
}

async function pausedThenCompleted(config: HypertestConfig, env?: Record<string, string>): Promise<void> {
  const repo = await sumRepo();
  cleanups.push(repo.cleanup);
  const ht = await createHypertest(config, { scriptedBrains: { sim: flaky(2) }, logger: new MemoryLogger(), ...(env ? { env } : {}) });
  try {
    const outcome = await ht.run({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 120_000 });
    assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
    const paused = await ht.events(outcome.runId, { types: ['work.paused'] });
    assert.equal(paused.length, 1);
    const p = paused[0]!.payload as { pauseReason: string; routes: string[]; reason: string; resumeAt: string };
    assert.equal(p.pauseReason, 'model_unavailable');
    assert.deepEqual(p.routes, ['sim-large']);
    const resumed = await ht.events(outcome.runId, { types: ['work.resumed'] });
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0]!.aggregateId, paused[0]!.aggregateId);
    assert.ok(Date.parse(resumed[0]!.occurredAt) >= Date.parse(p.resumeAt), 'resumed no earlier than the pause allowed');
    const failed = (await ht.events(outcome.runId, { types: ['work.failed'] })).filter((e) => e.aggregateId === paused[0]!.aggregateId);
    assert.deepEqual(failed, [], 'the paused item was never failed');
  } finally {
    await ht.close();
  }
}

describe('A[0] PAUSE through the durable runtimes', { concurrency: false }, () => {
  test('local runtime: a timing-out single route pauses the lead, the runtime resumes it after the backoff, the run completes', async () => {
    const dir = await tempDir('ht-app-pause-');
    const db = await testStore();
    cleanups.push(dir.cleanup, () => db.dispose());
    const base = scriptedConfig(join(dir.path, 'data'), { gate: { requireIndependentReview: false } });
    await pausedThenCompleted(db.store ? { ...base, store: db.store } : base);
  });

  test(
    'Temporal runtime: the same pause and resume on the embedded worker over PostgreSQL',
    skipUnless(!!infra.pgUrl && !!infra.temporalAddress, 'HYPERTEST_TEST_PG_URL / HYPERTEST_TEST_TEMPORAL_ADDRESS not set (run npm run infra:up)'),
    async () => {
      const dir = await tempDir('ht-app-pause-temporal-');
      cleanups.push(dir.cleanup);
      const suffix = randomBytes(4).toString('hex');
      const schema = `ht_app_pause_${suffix}`;
      cleanups.push(async () => {
        const db = await openDatabase({ kind: 'postgres', url: infra.pgUrl! });
        try {
          await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await db.close();
        }
      });
      const env = { HT_PAUSE_PG_URL: infra.pgUrl!, HT_PAUSE_CAPABILITY_SECRET: randomBytes(24).toString('hex') };
      const config: HypertestConfig = {
        ...scriptedConfig(join(dir.path, 'data'), { gate: { requireIndependentReview: false } }),
        store: { kind: 'postgres', urlEnv: 'HT_PAUSE_PG_URL', schema },
        policy: { capabilitySecretEnv: 'HT_PAUSE_CAPABILITY_SECRET' },
        durable: { kind: 'temporal', address: infra.temporalAddress!, namespace: 'default', taskQueue: `ht-app-pause-${suffix}` },
      };
      await pausedThenCompleted(config, env);
    },
  );
});

/** Polls the run's events until one of `type` exists (bounded). */
async function eventually(ht: Awaited<ReturnType<typeof createHypertest>>, runId: string, type: string, timeoutMs = 30_000): Promise<Awaited<ReturnType<typeof ht.events>>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = await ht.events(runId, { types: [type] });
    if (found.length > 0) return found;
    if (Date.now() > until) throw new Error(`no ${type} event within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('A[0] operator resume of a model-paused run (`hypertest resume <runId>`, POST /runs/:id/resume)', { concurrency: false }, () => {
  test('ht.resume releases the pause before its backoff: the paused item resumes at once and the run completes', async () => {
    const dir = await tempDir('ht-app-pause-resume-');
    const db = await testStore();
    const repo = await sumRepo();
    cleanups.push(dir.cleanup, () => db.dispose(), repo.cleanup);
    const base = scriptedConfig(join(dir.path, 'data'), { gate: { requireIndependentReview: false } });
    const ht = await createHypertest(db.store ? { ...base, store: db.store } : base, { scriptedBrains: { sim: flaky(2) }, logger: new MemoryLogger() });
    try {
      const run = await ht.start({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } });
      const [paused] = await eventually(ht, run.runId, 'work.paused');
      const resumeAt = Date.parse((paused!.payload as { resumeAt: string }).resumeAt);
      const agents = await ht.agents(run.runId);
      const lead = agents.find((a) => a.role === 'lead')!;
      const sessionId = ((await ht.services.db.query<{ session_id: string }>(`SELECT session_id FROM ht_agents WHERE agent_id = $1`, [lead.agentId])).rows[0]!).session_id;
      const out = await ht.resume(run.runId);
      const releasedAt = Date.now();
      assert.deepEqual(out.releasedPauses, [sessionId], 'the lead\'s pause was released');
      // released: resumable now (the row is gone once the resumed turn succeeded)
      const row = (await ht.services.db.query<{ resume_at: string | Date }>(`SELECT resume_at FROM ht_model_pauses WHERE session_id = $1`, [sessionId])).rows[0];
      assert.ok(row === undefined || new Date(row.resume_at).getTime() <= releasedAt, `resume_at moved to the release (was ${new Date(resumeAt).toISOString()})`);
      const [released] = await eventually(ht, run.runId, 'model.pauses_released');
      assert.deepEqual((released!.payload as { sessions: string[]; by: string }).sessions, [sessionId]);
      assert.equal((released!.payload as { by: string }).by, 'operator:resume');
      await eventually(ht, run.runId, 'work.resumed');
      const outcome = await ht.durable.awaitCompletion(run.runId, { timeoutMs: 90_000 });
      assert.equal(outcome.status, 'completed');
      // failure paths: a terminal run, an unknown run
      await assert.rejects(ht.resume(run.runId), (e: unknown) => e instanceof Error && /is already completed/.test(e.message));
      await assert.rejects(ht.resume('run_nope'), (e: unknown) => e instanceof Error && /run run_nope not found/.test(e.message));
    } finally {
      await ht.close();
    }
  });

  test('a quarantined run is refused BEFORE anything changes: its model pauses stay as they are (no model.pauses_released)', async () => {
    const dir = await tempDir('ht-app-pause-quarantine-');
    const db = await testStore();
    const repo = await sumRepo();
    cleanups.push(dir.cleanup, () => db.dispose(), repo.cleanup);
    const base = scriptedConfig(join(dir.path, 'data'), { gate: { requireIndependentReview: false } });
    // the provider never answers: the lead stays paused
    const ht = await createHypertest(db.store ? { ...base, store: db.store } : base, { scriptedBrains: { sim: flaky(1_000_000) }, logger: new MemoryLogger() });
    try {
      const run = await ht.start({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } });
      await eventually(ht, run.runId, 'work.paused');
      // the runtime release the run is pinned to was rolled back meanwhile: the run is quarantined (paused)
      await ht.services.runs.update(run.runId, { status: 'paused', pauseReason: 'quarantined' }, { runId: run.runId, correlationId: run.runId, actorId: 'system:test' });
      const before = await ht.services.db.query<{ resume_at: unknown }>(`SELECT resume_at FROM ht_model_pauses WHERE run_id = $1`, [run.runId]);
      await assert.rejects(ht.resume(run.runId), (e: unknown) => e instanceof Error && /is quarantined/.test(e.message));
      assert.deepEqual(await ht.events(run.runId, { types: ['model.pauses_released'] }), [], 'nothing was released for a refused resume');
      const after = await ht.services.db.query<{ resume_at: unknown }>(`SELECT resume_at FROM ht_model_pauses WHERE run_id = $1`, [run.runId]);
      assert.deepEqual(after.rows.map((r) => String(r.resume_at)), before.rows.map((r) => String(r.resume_at)));
      assert.equal((await ht.status(run.runId))!.pauseReason, 'quarantined');
      await ht.cancel(run.runId, 'test done');
    } finally {
      await ht.close();
    }
  });
});
