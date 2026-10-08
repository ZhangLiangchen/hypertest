/**
 * (F[8], coverage[14]) Harness feature flags of the controlled causal arms H0…H6: each flag switches one subsystem off
 * (subagents, dynamic scheduler, blackboard reactions, context freshness, oracle governance), the switched-off harness is
 * honoured ONLY for an eval trial instance (a deployment configuration that disables a feature is refused at composition),
 * the configuration validates the flags, and an ablated harness is another runtime (its role catalog revision — hence
 * its manifest — differs).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BUILTIN_ROLES, RoleCatalog } from '@hypertest/agents';
import { tempDir } from '@hypertest/testkit';
import {
  FULL_HARNESS, HARNESS_FEATURE_KEYS, applyHarnessFeatures, createHypertest, defaultConfig, disabledFeatures, harnessFeatures, harnessFreshness, harnessRoleCatalog, validateConfig,
  type HypertestConfig,
} from '../src/index.ts';
import { scriptedConfig, testStore } from './helpers.ts';

const off = (features: Partial<Record<(typeof HARNESS_FEATURE_KEYS)[number], boolean>>): Pick<HypertestConfig, 'harness'> => ({ harness: { features } });

describe('harness features', () => {
  test('unset means the full harness (H6); the switched-off features are listed', () => {
    assert.deepEqual(harnessFeatures({}), FULL_HARNESS);
    assert.deepEqual(disabledFeatures({}), []);
    assert.deepEqual(disabledFeatures(off({ blackboard: false, subagents: false })), ['subagents', 'blackboard']);
  });

  test('a deployment configuration may not switch a subsystem off (only an eval trial instance may)', () => {
    const config = { ...defaultConfig(), ...off({ contextFreshness: false }) };
    assert.throws(() => applyHarnessFeatures(config, {}), /harness\.features switches off contextFreshness: an ablated harness is an eval arm only/);
    assert.equal(applyHarnessFeatures(config, { evalTrial: true }), config, 'no structural change for freshness: the guard is wrapped at composition');
    const deployment = defaultConfig();
    assert.equal(applyHarnessFeatures(deployment, {}), deployment, 'the full harness is always allowed (unchanged)');
  });

  test('dynamicScheduler: false serializes turns; oracleGovernance: false drops the configured oracles and the oracle requirement', () => {
    const base = scriptedConfig('/tmp/unused-harness');
    const serial = applyHarnessFeatures({ ...base, ...off({ dynamicScheduler: false }) }, { evalTrial: true });
    assert.equal(serial.durable.kind === 'local' ? serial.durable.maxConcurrentTurns : undefined, 1);
    const ungoverned = applyHarnessFeatures({ ...base, ...off({ oracleGovernance: false }) }, { evalTrial: true });
    assert.equal(ungoverned.oracles, undefined);
    assert.equal(ungoverned.gate?.requireOracle, false);
    assert.ok((base.oracles ?? []).length > 0);
  });

  test('subagents: false leaves the lead alone with every non-delegation tool; blackboard: false removes every subscription', () => {
    const inner = new RoleCatalog(BUILTIN_ROLES);
    const solo = harnessRoleCatalog(inner, off({ subagents: false }));
    assert.deepEqual(solo.list().map((r) => r.role), ['lead']);
    assert.throws(() => solo.require('executor'), /role executor is not part of this harness/);
    const lead = solo.require('lead');
    assert.ok(lead.toolPolicy.allow.includes('test.run') && lead.toolPolicy.allow.includes('http.request') && !lead.toolPolicy.allow.some((t) => t.startsWith('delegate')), lead.toolPolicy.allow.join(', '));
    assert.deepEqual([lead.canDelegateTo, lead.maxDepth], [[], 0]);
    const quiet = harnessRoleCatalog(inner, off({ blackboard: false }));
    assert.ok(inner.subscriptions().length > 0);
    assert.deepEqual(quiet.subscriptions(), []);
    assert.ok(quiet.list().every((r) => r.subscriptions.length === 0));
    assert.notEqual(quiet.revision(), inner.revision(), 'an ablated catalog is another catalog');
    assert.equal(harnessRoleCatalog(inner, {}), inner, 'the full harness is the catalog itself');
  });

  test('contextFreshness: false passes every action without checking (the full harness keeps the guard)', async () => {
    let checked = 0;
    const inner = { resolvers: [], validate: async () => ((checked += 1), { fresh: false, checked: 1, stale: [] }) } as never;
    const ablated = harnessFreshness(inner, off({ contextFreshness: false }));
    assert.deepEqual(await (ablated as { validate: (...a: unknown[]) => Promise<unknown> }).validate({}), { fresh: true, checked: 0 });
    assert.equal(checked, 0);
    assert.equal(harnessFreshness(inner, {}), inner);
  });

  test('configuration validation: features are booleans of known names', () => {
    assert.deepEqual(validateConfig({ ...defaultConfig(), harness: { features: { subagents: false } } }), []);
    const errors = validateConfig({ ...defaultConfig(), harness: { features: { subagents: 'no', telepathy: false } } } as never);
    assert.ok(errors.some((e) => /harness\.features\.subagents must be a boolean/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /telepathy/.test(e)), errors.join('\n'));
  });

  test('composition: refused for a deployment; an eval trial instance composes the ablated harness as another runtime manifest', async () => {
    const dir = await tempDir('ht-harness-');
    const db = await testStore();
    try {
      const base = scriptedConfig(dir.path, db.store ? { store: db.store } : {});
      const scriptedBrains = { sim: () => ({ text: 'unused' }) };
      await assert.rejects(createHypertest({ ...base, ...off({ blackboard: false }) }, { scriptedBrains }), /an ablated harness is an eval arm only/);
      const full = await createHypertest(base, { evalTrial: true, scriptedBrains });
      const fullManifest = full.manifest.manifestId;
      await full.close();
      const ablated = await createHypertest({ ...base, ...off({ blackboard: false, subagents: false }) }, { evalTrial: true, scriptedBrains });
      try {
        assert.notEqual(ablated.manifest.manifestId, fullManifest);
        assert.deepEqual(ablated.services.roles.list().map((r) => r.role), ['lead']);
      } finally {
        await ablated.close();
      }
    } finally {
      await db.dispose();
      await dir.cleanup();
    }
  });
});
