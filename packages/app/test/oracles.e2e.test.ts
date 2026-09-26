/**
 * conformance-1 on the product path: a run with no oracle in force is never `pass` (gate criterion C0), and the
 * configuration is a human surface to establish oracles (a named human authority; runs pin them by default).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { HypertestError, MemoryLogger } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, validateConfig, type HypertestConfig } from '../src/index.ts';
import { SUM_ORACLE, roleRouter, scriptedConfig, sumRepo, testStore, tinyRunBrains } from './helpers.ts';

const GOAL = 'Is the sum module releasable?';

describe('conformance-1: no oracle in force ⇒ never pass; configured oracles are established by a human and pinned', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  before(async () => {
    dir = await tempDir('ht-app-oracles-');
    repo = await sumRepo();
    db = await testStore();
  });
  after(async () => {
    await db.dispose();
    await repo.cleanup();
    await dir.cleanup();
  });

  function cfg(sub: string, extra: Record<string, unknown>): HypertestConfig {
    const c = scriptedConfig(`${dir.path}/${sub}`, { gate: { requireIndependentReview: false }, ...extra });
    return db.store ? { ...c, store: db.store } : c;
  }

  test('the tiny passing run WITHOUT any oracle is inconclusive (C0), not pass — the audit reproduction', async () => {
    const ht = await createHypertest(cfg('none', { oracles: [] }), { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger() });
    try {
      const outcome = await ht.run({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 90_000 });
      assert.equal(outcome.status, 'completed');
      assert.equal(outcome.decision!.verdict, 'inconclusive');
      assert.deepEqual(outcome.decision!.unknownCriteria.map((c) => c.criterionId), ['C0']);
      assert.equal(outcome.decision!.unknownCriteria[0]!.detail, 'no approved oracle is pinned by the run');
    } finally {
      await ht.close();
    }
  });

  test('a configured oracle is established by its named human authority and pinned by default: the same run passes on it', async () => {
    const ht = await createHypertest(cfg('with', {}), { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger() });
    try {
      const oracle = (await ht.services.specs.getOracle(SUM_ORACLE.oracleId))!;
      assert.equal(oracle.status, 'approved');
      assert.deepEqual(oracle.approvedBy, [{ kind: 'human', id: 'alice' }]);
      const outcome = await ht.run({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 90_000 });
      assert.equal(outcome.decision!.verdict, 'pass');
      assert.deepEqual(outcome.decision!.oracleRevisions, { 'sum-contract': 1 });
      assert.match(outcome.decision!.satisfiedCriteria.find((c) => c.criterionId === 'C0')!.detail ?? '', /sum-contract\/suite-passes/);
      // an explicit oracleIds list wins over the configured default (here: none ⇒ C0 unknown)
      const bare = await ht.run({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head }, oracleIds: [] }, { timeoutMs: 90_000 });
      assert.equal(bare.decision!.verdict, 'inconclusive');
    } finally {
      await ht.close();
    }
    // a second composition keeps the established oracle (it changes only through governed proposals)
    const again = await createHypertest(cfg('with', { oracles: [{ ...SUM_ORACLE, assertions: [{ ...SUM_ORACLE.assertions[0], severity: 'P3' }] }] }), {
      scriptedBrains: { sim: roleRouter(tinyRunBrains()) },
      logger: new MemoryLogger(),
    });
    try {
      const kept = (await again.services.specs.getOracle(SUM_ORACLE.oracleId))!;
      assert.equal(kept.revision, 1);
      assert.equal(kept.assertions[0]!.severity, 'P1', 'a config edit never weakens an established oracle');
    } finally {
      await again.close();
    }
  });

  test('an explicit gate override (requireOracle: false) is the only way to a verdict without an oracle; malformed oracles are refused', async () => {
    const ht = await createHypertest(cfg('off', { oracles: [] }), { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger() });
    try {
      const outcome = await ht.run({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head }, gate: { requireOracle: false } }, { timeoutMs: 90_000 });
      assert.equal(outcome.decision!.verdict, 'pass');
      assert.match(outcome.decision!.satisfiedCriteria.find((c) => c.criterionId === 'C0')!.detail ?? '', /requireOracle false/);
      await assert.rejects(ht.start({ goal: GOAL, target: {}, gate: { requireOracle: 'no' as never } }), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument');
    } finally {
      await ht.close();
    }
    const errors = validateConfig({
      ...scriptedConfig(`${dir.path}/bad`),
      oracles: [{ oracleId: 'x', scope: { components: [], description: 'd' }, assertions: [], establishedBy: '' }, { ...SUM_ORACLE, assertions: [{ ...SUM_ORACLE.assertions[0], kind: 'vibes' }] }],
    } as unknown as HypertestConfig);
    assert.ok(errors.includes('oracles[0].establishedBy must be a non-empty string'), errors.join('\n'));
    assert.ok(errors.includes('oracles[0].assertions must be a non-empty list'), errors.join('\n'));
    assert.ok(errors.some((e) => e.startsWith('oracles[1].assertions[0].kind must be one of')), errors.join('\n'));
  });
});
