/**
 * Model governance through createHypertest:
 *  - A[1] the price guard is configured (models.priceGuard), observed prices are runtime-observable (the prices file,
 *    re-read at every turn boundary) and a change beyond the guard opens the route's circuit with an L0 event;
 *  - coverage[7] eval results feed routing through an explicit, auditable file (models.scoresFile) recorded in the
 *    RuntimeManifest.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HypertestError, MemoryLogger, sha256Hex } from '@hypertest/core';
import { deriveRouteScores, updatePricesFile, type RouteRequest } from '@hypertest/model';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, modelPricesFile, validateConfig, type HypertestConfig } from '../src/index.ts';
import { FULL_ROUTE, roleRouter, scriptedConfig, sumRepo, testStore, tinyRunBrains } from './helpers.ts';

function twoRoutes(dataDir: string, store: HypertestConfig['store'] | undefined, extra: Partial<HypertestConfig['models']> = {}): HypertestConfig {
  const base = scriptedConfig(dataDir, { gate: { requireIndependentReview: false } });
  const c: HypertestConfig = {
    ...base,
    models: {
      providers: [{ id: 'sim', kind: 'scripted' }],
      routes: [
        { routeId: 'main', provider: 'sim', model: 'main-1', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities], quality: { default: 0.95 }, costPerMillionInputUsd: 1, costPerMillionOutputUsd: 4 },
        { routeId: 'backup', provider: 'sim', model: 'backup-1', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities], quality: { default: 0.9 }, costPerMillionInputUsd: 1, costPerMillionOutputUsd: 1 },
      ],
      ...extra,
    },
  };
  return store ? { ...c, store } : c;
}

const request = (role: string): RouteRequest => ({
  runId: 'r', agentId: 'a', role, taskType: 'execute', policy: {}, requiredCapabilities: ['tool_use'], actionRisk: 'low', dataClassification: 'internal', contextTokensEstimate: 100, contextSnapshotId: 's',
});

describe('A[1] price guard wired through the configuration', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  before(async () => {
    dir = await tempDir('ht-app-price-');
    db = await testStore();
  });
  after(async () => {
    await db?.dispose();
    await dir?.cleanup();
  });

  test('models.priceGuard is validated', () => {
    const bad = twoRoutes(join(dir.path, 'v'), undefined, { priceGuard: { maxIncreasePct: -5, routes: { ghost: { inputPerMillionUsd: 1 } }, appliesTo: 'sometimes' as never } });
    const errors = validateConfig(bad);
    assert.ok(errors.includes('models.priceGuard.maxIncreasePct must be a finite number ≥ 0, got -5'), errors.join('\n'));
    assert.ok(errors.includes('models.priceGuard.routes.ghost: no such route in models.routes'), errors.join('\n'));
    assert.ok(errors.some((e) => e.startsWith('models.priceGuard.appliesTo must be one of cost_limited, all')), errors.join('\n'));
  });

  test('a price change beyond the guard, observed at runtime, opens the route circuit (L0) and the run is served by the other route', async () => {
    const repo = await sumRepo();
    const config = twoRoutes(join(dir.path, 'run'), db.store, { priceGuard: { maxIncreasePct: 50 } });
    const ht = await createHypertest(config, { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger() });
    try {
      // before any change the better route serves
      const before = await ht.services.router.route(request('executor'), { runId: 'probe', correlationId: 'p', actorId: 'system:test' });
      assert.equal(before.ok && before.routeId, 'main');
      // the operator records the provider's new price (`hypertest models prices set main --input 3 --output 12`)
      await updatePricesFile(modelPricesFile(ht.config), 'main', { inputPerMillionUsd: 3, outputPerMillionUsd: 12, source: 'operator' });
      const outcome = await ht.run({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 90_000 });
      assert.equal(outcome.status, 'completed');
      const opened = await ht.events(outcome.runId, { types: ['model.circuit_opened'] });
      assert.equal(opened.length, 1, 'the change is recorded once per route');
      const p = opened[0]!.payload as Record<string, unknown>;
      assert.equal(p['reason'], 'price_change');
      assert.equal(p['routeId'], 'main');
      assert.equal(p['increasePct'], 200);
      assert.deepEqual(p['observedPrice'], { inputPerMillionUsd: 3, outputPerMillionUsd: 12, observedAt: null, source: 'operator' });
      const invoked = await ht.events(outcome.runId, { types: ['model.invoked'] });
      assert.ok(invoked.length > 0);
      assert.ok(invoked.every((e) => (e.payload as { routeId: string }).routeId === 'backup'), 'no call at the changed price');
      // the price back within the guard closes the circuit at the next safe point
      await updatePricesFile(modelPricesFile(ht.config), 'main', { inputPerMillionUsd: 1.2, outputPerMillionUsd: 4 });
      const again = await ht.services.router.route(request('executor'), { runId: outcome.runId, correlationId: 'p2', actorId: 'system:test' });
      assert.equal(again.ok && again.routeId, 'main');
      const closed = await ht.events(outcome.runId, { types: ['model.circuit_closed'] });
      assert.equal((closed.at(-1)!.payload as { reason: string }).reason, 'price_change_cleared');
    } finally {
      await ht.close();
      await repo.cleanup();
    }
  });
});

describe('coverage[7] eval scores feed routing through models.scoresFile', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => (dir = await tempDir('ht-app-scores-')));
  after(async () => dir.cleanup());

  test('derived scores change routing, the catalog revision and the RuntimeManifest (modelScores); an unknown route is refused', async () => {
    const trials = Array.from({ length: 6 }, (_, i) => ({ result: i < 6 ? 'pass' : 'fail', modelRoutes: [{ role: 'executor', routeId: 'backup', calls: 2 }] }));
    trials.push({ result: 'fail', modelRoutes: [{ role: 'executor', routeId: 'main', calls: 1 }] }, { result: 'fail', modelRoutes: [{ role: 'executor', routeId: 'main', calls: 1 }] }, { result: 'fail', modelRoutes: [{ role: 'executor', routeId: 'main', calls: 1 }] });
    const scores = deriveRouteScores({ suiteId: 'core', revision: 'r7', trials });
    assert.deepEqual(scores.scores, { backup: { executor: 0.875 }, main: { executor: 0.2 } });
    const file = join(dir.path, 'scores.json');
    const text = JSON.stringify(scores, null, 2);
    await writeFile(file, text);

    const brains = { sim: roleRouter({}) };
    const plain = await createHypertest(twoRoutes(join(dir.path, 'plain'), undefined), { scriptedBrains: brains, logger: new MemoryLogger() });
    let plainRevision: string;
    try {
      plainRevision = plain.manifest.modelCatalogRevision;
      const d = await plain.services.router.route(request('executor'), { runId: 'r', correlationId: 'c', actorId: 'system:test' });
      assert.equal(d.ok && d.routeId, 'main', 'without scores the catalog prefers main');
      assert.equal(plain.manifest.modelScores, undefined);
    } finally {
      await plain.close();
    }
    const scored = await createHypertest(twoRoutes(join(dir.path, 'scored'), undefined, { scoresFile: file }), { scriptedBrains: brains, logger: new MemoryLogger() });
    try {
      const d = await scored.services.router.route(request('executor'), { runId: 'r', correlationId: 'c', actorId: 'system:test' });
      assert.equal(d.ok && d.routeId, 'backup', 'the eval results moved the executor to backup');
      const lead = await scored.services.router.route(request('lead'), { runId: 'r', correlationId: 'c', actorId: 'system:test' });
      assert.equal(lead.ok && lead.routeId, 'main', 'roles without scores keep the configured quality');
      assert.notEqual(scored.manifest.modelCatalogRevision, plainRevision);
      assert.deepEqual(scored.manifest.modelScores, {
        digest: sha256Hex(Buffer.from(text)), routes: ['backup', 'main'],
        source: { suiteId: 'core', revision: 'r7', inputDigest: scores.source!.inputDigest!, trials: 9, method: scores.source!.method! },
      });
      assert.equal(scored.services.catalog.get('backup')!.quality['executor'], 0.875);
    } finally {
      await scored.close();
    }
    const badFile = join(dir.path, 'bad-scores.json');
    await writeFile(badFile, JSON.stringify({ version: 1, scores: { ghost: { lead: 0.5 } } }));
    await assert.rejects(
      createHypertest(twoRoutes(join(dir.path, 'bad'), undefined, { scoresFile: badFile }), { scriptedBrains: brains, logger: new MemoryLogger() }),
      (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument' && /scores for routes that are not configured: ghost/.test(e.message),
    );
  });
});

describe('A[3] a manual model switch through createHypertest is applied at the target agents\' next safe boundary', () => {
  test('requested for the executor role while the lead plans: the executor runs on the requested route (switchReason manual), the lead keeps its route', async () => {
    const dir = await tempDir('ht-app-manual-switch-');
    const db = await testStore();
    const repo = await sumRepo();
    // the lead's first turn waits until the operator's request is recorded (no race with the executor's creation)
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const brains = tinyRunBrains();
    const lead = brains['lead']!;
    let first = true;
    brains['lead'] = (v) => {
      if (!first) return lead(v);
      first = false;
      return gate.then(() => lead(v));
    };
    const ht = await createHypertest(twoRoutes(join(dir.path, 'data'), db.store), { scriptedBrains: { sim: roleRouter(brains) }, logger: new MemoryLogger() });
    try {
      const run = await ht.start({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } });
      // `hypertest model switch <runId> executor backup --by alice` (main is preferred: quality 0.95 > 0.9)
      const sw = await ht.requestModelSwitch(run.runId, 'executor', 'backup', { kind: 'human', id: 'alice' }, 'main is degraded');
      release();
      const outcome = await ht.durable.awaitCompletion(run.runId, { timeoutMs: 90_000 });
      assert.equal(outcome.status, 'completed');
      const epochs = await ht.events(run.runId, { types: ['model.epoch_started'] });
      const agents = await ht.agents(run.runId);
      const roleOf = new Map(agents.map((a) => [a.agentId, a.role]));
      const byRole = (role: string) => epochs.filter((e) => roleOf.get(e.aggregateId) === role).map((e) => e.payload as { routeId: string; switchReason: string });
      assert.ok(byRole('executor').length > 0, 'the executor ran');
      assert.deepEqual(byRole('executor').map((p) => [p.routeId, p.switchReason]), byRole('executor').map(() => ['backup', 'manual']), 'every executor epoch is the operator\'s route, switchReason manual');
      assert.ok(byRole('lead').every((p) => p.routeId === 'main' && p.switchReason !== 'manual'), 'the lead was not a target');
      // every executor model call ran on the requested route, after the request was on L0
      const invoked = (await ht.events(run.runId, { types: ['model.invoked'] })).filter((e) => roleOf.get(e.aggregateId) === 'executor');
      assert.ok(invoked.length > 0 && invoked.every((e) => (e.payload as { routeId: string }).routeId === 'backup'));
      const requested = (await ht.events(run.runId, { types: ['model.switch_requested'] }))[0]!;
      assert.equal((requested.payload as { switchId: string }).switchId, sw.switchId);
      assert.ok(invoked.every((e) => (e.seq ?? 0) > (requested.seq ?? Number.POSITIVE_INFINITY)), 'every executor call came after the request');
      // each executor agent recorded its outcome once (applied, with its epoch)
      const switches = await ht.services.db.query<{ agent_id: string; outcome: string; epoch_id: string | null }>(`SELECT agent_id, outcome, epoch_id FROM ht_model_switch_outcomes WHERE switch_id = $1`, [sw.switchId]);
      const executors = agents.filter((a) => a.role === 'executor').map((a) => a.agentId).sort();
      assert.deepEqual(switches.rows.map((r) => r.agent_id).sort(), executors);
      assert.ok(switches.rows.every((r) => r.outcome === 'applied' && r.epoch_id !== null));
    } finally {
      await ht.close();
      await repo.cleanup();
      await db.dispose();
      await dir.cleanup();
    }
  });
});
