/**
 * (B[4], CONFORMANCE "L4 durable context via PowerContext as a separate service") The L4 memory as a SEPARATE service: its
 * own process (a real child process here, never an in-process mock), its own storage (a PGlite directory that survives a
 * restart), an HTTP API with a bearer token; the store's invariants hold server side; `memory.kind: service` makes
 * createHypertest start it, use it through PowerContextClient (approved experience reaches the agents' prompts), record its
 * decisions on L0, and stop it on close.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { PowerContextClient } from '@hypertest/context';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, defaultConfig, sandboxHiddenPaths, startMemoryServiceProcess, type HypertestConfig, type HypertestInstance, type MemoryServiceProcess } from '../src/index.ts';
import { roleRouter, scriptedConfig, sumRepo, testStore, tinyRunBrains, type BrainView } from './helpers.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('the memory service process', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let svc: MemoryServiceProcess | undefined;
  before(async () => {
    dir = await tempDir('ht-memsvc-');
  });
  after(async () => {
    await svc?.close();
    await dir?.cleanup();
  });

  test('its own process and storage; the invariants hold server side; a restart keeps the data; close stops the process', async () => {
    svc = await startMemoryServiceProcess({ dataDir: join(dir.path, 'mem') });
    assert.notEqual(svc.pid, process.pid);
    assert.ok(alive(svc.pid));
    const health = await fetch(`${svc.url}/v1/health`);
    assert.deepEqual(await health.json(), { status: 'ok', service: 'hypertest-memory', kind: 'sql' });
    // no token, wrong token ⇒ 401
    assert.equal((await fetch(`${svc.url}/v1/experiences`)).status, 401);
    assert.equal((await fetch(`${svc.url}/v1/experiences`, { headers: { authorization: 'Bearer nope' } })).status, 401);

    const client = new PowerContextClient({ baseUrl: svc.url, apiKey: svc.apiKey, timeoutMs: 10_000 });
    const ctx = { runId: 'run_mem', correlationId: 'run_mem', actorId: 'agent:ag_rca' };
    const xp = await client.propose({ scope: { role: 'executor' }, kind: 'lesson', content: 'rounding must be half up at the cent', sourceRunId: 'run_mem', evidenceRefs: ['ev_1'], createdBy: 'agent:ag_rca' }, ctx);
    assert.equal(xp.status, 'candidate');
    assert.deepEqual(await client.retrieve({ text: 'rounding' }), [], 'a candidate is never retrieved');
    // self-review is refused BY THE SERVICE too: a fresh client (no creator cache) names the creator as the calling actor
    const fresh = new PowerContextClient({ baseUrl: svc.url, apiKey: svc.apiKey, timeoutMs: 10_000 });
    await assert.rejects(fresh.review(xp.experienceId, 'approve', 'human:alice', { ...ctx, actorId: 'agent:ag_rca' }), (e: Error & { code?: string }) => e.code === 'permission_denied' && /cannot be reviewed by its creator agent:ag_rca/.test(e.message));
    await assert.rejects(fresh.review('xp_missing', 'approve', 'human:alice', { ...ctx, actorId: 'human:alice' }), (e: Error & { code?: string }) => e.code === 'not_found');
    const approved = await fresh.review(xp.experienceId, 'approve', 'human:alice', { ...ctx, actorId: 'human:alice' });
    assert.equal(approved.status, 'approved');
    assert.deepEqual((await client.retrieve({ text: 'rounding', scope: { role: 'executor' } })).map((i) => i.experienceId), [xp.experienceId]);
    assert.deepEqual(await client.retrieve({ text: 'rounding', scope: { role: 'lead' } }), [], 'out of scope');
    await assert.rejects(client.review(xp.experienceId, 'reject', 'human:bob', { ...ctx, actorId: 'human:bob' }), (e: Error & { code?: string }) => e.code === 'precondition_failed');

    // stop: the process exits; restart on the same directory: the data is still there (its own durable storage)
    const pid = svc.pid;
    await svc.close();
    assert.equal(alive(pid), false);
    svc = await startMemoryServiceProcess({ dataDir: join(dir.path, 'mem') });
    const again = new PowerContextClient({ baseUrl: svc.url, apiKey: svc.apiKey, timeoutMs: 10_000 });
    assert.deepEqual((await again.list({ status: ['approved'] })).map((i) => [i.experienceId, i.reviewedBy]), [[xp.experienceId, 'human:alice']]);
    // one process per data directory: a second service on it is refused
    await assert.rejects(startMemoryServiceProcess({ dataDir: join(dir.path, 'mem'), startTimeoutMs: 20_000 }), /exited \(code 1\) before it listened: .*memory service data directory/s);
  });
});

describe('memory.kind: service in createHypertest', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  let ht: HypertestInstance | undefined;
  before(async () => {
    dir = await tempDir('ht-app-memsvc-');
    repo = await sumRepo();
    db = await testStore();
  });
  after(async () => {
    await ht?.close();
    await db?.dispose();
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('Hypertest starts the service, approved experience from it reaches the executor prompt, L0 records the decisions, close stops it', async () => {
    const config = scriptedConfig(join(dir.path, 'a'), { gate: { requireIndependentReview: false }, memory: { kind: 'service' } } as never);
    const executorViews: BrainView[] = [];
    const brains = tinyRunBrains();
    const exec = brains['executor']!;
    brains['executor'] = (v) => {
      if (v.step === 0) executorViews.push(v);
      return exec(v);
    };
    const logger = new MemoryLogger();
    ht = await createHypertest(db.store ? { ...config, store: db.store } : config, { scriptedBrains: { sim: roleRouter(brains) }, logger });
    assert.equal(ht.services.memory.kind, 'powercontext', 'the instance talks to the service over HTTP');
    const started = logger.entries.find((e) => e.msg === 'memory service process started')!;
    const pid = started.fields['pid'] as number;
    assert.ok(alive(pid) && pid !== process.pid);

    const ctx = { runId: 'run_learn', correlationId: 'run_learn', actorId: 'agent:ag_rca' };
    const xp = await ht.services.memory.propose({ scope: { role: 'executor' }, kind: 'lesson', content: 'MEMORY-SERVICE-MARKER: run the sum suite with node --test', sourceRunId: 'run_learn', evidenceRefs: [], createdBy: 'agent:ag_rca' }, ctx);
    await ht.services.memory.review(xp.experienceId, 'approve', 'human:alice', { ...ctx, actorId: 'human:alice' });
    // the decisions are on this deployment's L0 (deterministic ids: a retried call never appends twice)
    const l0 = await ht.services.db.query<{ event_type: string; aggregate_id: string }>("SELECT event_type, aggregate_id FROM ht_events WHERE run_id = 'run_learn' ORDER BY seq");
    assert.deepEqual(l0.rows.map((r) => [r.event_type, r.aggregate_id]), [['experience.proposed', xp.experienceId], ['experience.reviewed', xp.experienceId]]);
    // ... but not in this deployment's tables: the service has its own storage
    const local = await ht.services.db.query<{ n: number }>('SELECT count(*)::int AS n FROM ht_experience');
    assert.equal(local.rows[0]!.n, 0);

    const r = await ht.run({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 90_000 });
    assert.equal(r.status, 'completed');
    assert.match(executorViews.at(-1)!.userText, new RegExp(`## Durable memory[^\\n]*\\n- ${xp.experienceId} \\(lesson\\) MEMORY-SERVICE-MARKER`));
    await ht.close();
    ht = undefined;
    assert.equal(alive(pid), false, 'close() stops the service process');
  });
});

test('the memory service store is hidden from sandboxed agent commands (they never read or rewrite experience behind its API)', () => {
  const data = '/srv/ht';
  const config = defaultConfig({ project: { name: 'p', dataDir: data }, memory: { kind: 'service' } } as never) as HypertestConfig;
  assert.equal(config.memory?.kind === 'service' ? config.memory.dataDir : undefined, join(data, 'memory'), 'the default storage is <dataDir>/memory');
  assert.ok(sandboxHiddenPaths(config, data, join(data, 'state')).includes(join(data, 'memory')));
  const elsewhere = defaultConfig({ project: { name: 'p', dataDir: data }, memory: { kind: 'service', dataDir: '/var/lib/ht-memory' } } as never) as HypertestConfig;
  assert.ok(sandboxHiddenPaths(elsewhere, data, join(data, 'state')).includes('/var/lib/ht-memory'));
  assert.ok(!sandboxHiddenPaths(defaultConfig({ project: { name: 'p', dataDir: data } }) as HypertestConfig, data, join(data, 'state')).includes(join(data, 'memory')));
});
