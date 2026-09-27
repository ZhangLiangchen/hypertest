/**
 * engines.default: dsh — the tiny run end to end on the DeepSeek Harness adapter (@hypertest/runtime-dsh: pinned,
 * experimental; pin + adapter, no fork) with the same governance and verdict as the native engine. The RuntimeManifest
 * (I11) pins the DSH engine version, its adapter and the whole pinned DSH train; an installation that does not select
 * DSH neither registers nor pins it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { verifyRuntimeManifest } from '@hypertest/runtime';
import { DSH_AGENT_VERSION, DSH_PINS, RUNTIME_DSH_PACKAGE_VERSION } from '@hypertest/runtime-dsh';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, type HypertestConfig } from '../src/index.ts';
import { roleRouter, scriptedConfig, sumRepo, testStore, tinyRunBrains } from './helpers.ts';

const GOAL = 'Is the sum module releasable?';

function config(dataDir: string, store: HypertestConfig['store'] | undefined, extra: Record<string, unknown> = {}): HypertestConfig {
  const c = scriptedConfig(dataDir, { gate: { requireIndependentReview: false }, ...extra });
  return store ? { ...c, store } : c;
}

describe('engines.default: dsh', () => {
  test('the tiny run completes on the DSH engine with the same governance and verdict; the manifest pins the DSH train', async () => {
    const dir = await tempDir('ht-app-dsh-');
    const repo = await sumRepo();
    const db = await testStore();
    const ht = await createHypertest({ ...config(dir.path, db.store), engines: { default: 'dsh' } }, { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger() });
    try {
      const outcome = await ht.run({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 90_000 });
      assert.deepEqual([outcome.status, outcome.decision?.verdict], ['completed', 'pass']);
      const kinds = await ht.services.db.query<{ engine_kind: string }>('SELECT engine_kind FROM ht_agents ORDER BY created_at');
      assert.deepEqual(kinds.rows.map((r) => r.engine_kind), ['dsh', 'dsh', 'dsh']);
      const sessions = await ht.services.db.query<{ engine_kind: string }>('SELECT DISTINCT engine_kind FROM ht_sessions');
      assert.deepEqual(sessions.rows.map((r) => r.engine_kind), ['dsh']);

      const m = ht.manifest;
      assert.equal(verifyRuntimeManifest(m), true);
      assert.equal((await ht.status(outcome.runId))!.runtimeManifestId, m.manifestId, 'I11: the run is pinned to this manifest');
      assert.equal(m.defaultEngine, 'dsh');
      assert.deepEqual(m.agentEngines.find((e) => e.kind === 'dsh'), { kind: 'dsh', version: DSH_AGENT_VERSION, adapter: { package: '@hypertest/runtime-dsh', version: RUNTIME_DSH_PACKAGE_VERSION } });
      assert.equal(DSH_AGENT_VERSION, '0.1.0-rc.6');
      const adapters = m.providerAdapters.map((a) => `${a.provider}|${a.package}|${a.version}`);
      assert.ok(adapters.includes(`engine:dsh|@hypertest/runtime-dsh|${RUNTIME_DSH_PACKAGE_VERSION}`));
      for (const [pkg, version] of Object.entries(DSH_PINS)) assert.ok(adapters.includes(`engine:dsh|${pkg}|${version}`), `the manifest pins ${pkg}@${version}`);
    } finally {
      await ht.close();
      await db.dispose();
      await repo.cleanup();
      await dir.cleanup();
    }
  });

  test('an installation that does not select DSH neither registers nor pins it', async () => {
    const dir = await tempDir('ht-app-nodsh-');
    const db = await testStore();
    const ht = await createHypertest(config(dir.path, db.store), { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger() });
    try {
      assert.equal(ht.manifest.defaultEngine, 'native');
      assert.deepEqual(ht.manifest.agentEngines.map((e) => e.kind), ['native', 'pi']);
      assert.equal(ht.manifest.providerAdapters.some((a) => a.provider === 'engine:dsh'), false);
    } finally {
      await ht.close();
      await db.dispose();
      await dir.cleanup();
    }
  });
});
