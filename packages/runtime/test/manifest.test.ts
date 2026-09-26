import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isHypertestError } from '@hypertest/core';
import type { RuntimeManifest } from '@hypertest/domain';
import type { ToolSpec } from '@hypertest/tools';
import { EngineRegistry, NativeEngine, buildRuntimeManifest, createSessionStore, toolCatalogRevision, verifyRuntimeManifest, type AgentEngine } from '../src/index.ts';
import { baseDeps } from './helpers.ts';

type Content = Omit<RuntimeManifest, 'manifestId' | 'createdAt'>;

function content(): Content {
  return {
    hypertest: { version: '0.3.0', gitSha: 'a'.repeat(40) },
    agentEngines: [{ kind: 'native', version: '0.3.0' }, { kind: 'pi', version: '1.2.0' }],
    providerAdapters: [{ provider: 'anthropic', package: '@hypertest/model#anthropic', version: '0.3.0' }, { provider: 'openai', package: '@hypertest/model#openai', version: '0.3.0' }],
    modelCatalogRevision: 'mc_1',
    schemas: { event: '1', contextSnapshot: '1', tool: '1', operation: '1', evidence: '1' },
    policyBundleRevision: 'policy_1',
    toolCatalogRevision: 'tools_1',
    protocol: { id: 'bugate', version: '2', digest: 'sha256:aa' },
  };
}

describe('RuntimeManifest (I11)', () => {
  test('manifestId is a content hash that does not depend on createdAt', () => {
    const a = buildRuntimeManifest(content(), '2026-01-01T00:00:00.000Z');
    const b = buildRuntimeManifest(content(), '2026-09-09T09:09:09.000Z');
    assert.match(a.manifestId, /^rm_[0-9a-f]{64}$/);
    assert.equal(a.manifestId, b.manifestId);
    assert.equal(a.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(verifyRuntimeManifest(a), true);
  });

  test('any change of the bill of materials changes the id', () => {
    const base = buildRuntimeManifest(content(), '2026-01-01T00:00:00.000Z').manifestId;
    const variants: Array<(c: Content) => void> = [
      (c) => (c.hypertest.version = '0.3.1'),
      (c) => (c.agentEngines[1]!.version = '1.2.1'),
      (c) => (c.providerAdapters[0]!.version = '0.3.1'),
      (c) => (c.modelCatalogRevision = 'mc_2'),
      (c) => (c.schemas.tool = '2'),
      (c) => (c.policyBundleRevision = 'policy_2'),
      (c) => (c.toolCatalogRevision = 'tools_2'),
      (c) => (c.protocol!.digest = 'sha256:bb'),
      (c) => delete c.protocol,
      // runtime BOM fields
      (c) => (c.hypertest.gitSha = 'b'.repeat(40)),
      (c) => (c.hypertest.imageDigest = `sha256:${'c'.repeat(64)}`),
      (c) => (c.agentEngines[1]!.adapter = { package: '@hypertest/runtime-pi', version: '0.3.1' }),
      (c) => (c.defaultEngine = 'pi'),
      (c) => (c.roleCatalogRevision = 'roles_2'),
    ];
    const ids = variants.map((mutate) => {
      const c = content();
      mutate(c);
      return buildRuntimeManifest(c, '2026-01-01T00:00:00.000Z').manifestId;
    });
    for (const id of ids) assert.notEqual(id, base);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('set-like lists are canonical: their order does not change the id', () => {
    const c = content();
    c.agentEngines.reverse();
    c.providerAdapters.reverse();
    const reordered = buildRuntimeManifest(c, '2026-01-01T00:00:00.000Z');
    assert.equal(reordered.manifestId, buildRuntimeManifest(content(), '2026-01-01T00:00:00.000Z').manifestId);
    assert.deepEqual(reordered.agentEngines.map((e) => e.kind), ['native', 'pi']);
  });

  test('the manifest is immutable and tampering is detectable', () => {
    const m = buildRuntimeManifest(content(), '2026-01-01T00:00:00.000Z');
    assert.throws(() => {
      (m as { policyBundleRevision: string }).policyBundleRevision = 'policy_evil';
    }, TypeError);
    const forged: RuntimeManifest = { ...m, policyBundleRevision: 'policy_evil' };
    assert.equal(verifyRuntimeManifest(forged), false);
  });

  test('invalid content is refused', () => {
    const bad: Array<[string, (c: Content) => void]> = [
      ['no engines', (c) => (c.agentEngines = [])],
      ['empty version', (c) => (c.hypertest.version = '')],
      ['adapter without package', (c) => delete (c.providerAdapters[0] as { package?: string }).package],
      ['missing schema', (c) => delete (c.schemas as { evidence?: string }).evidence],
      ['empty git sha', (c) => (c.hypertest.gitSha = '')],
      ['image digest without algorithm', (c) => (c.hypertest.imageDigest = 'c'.repeat(64))],
      ['uppercase image digest', (c) => (c.hypertest.imageDigest = `sha256:${'C'.repeat(64)}`)],
      ['empty engine image digest', (c) => (c.agentEngines[0]!.imageDigest = '')],
      ['adapter without version', (c) => (c.agentEngines[1]!.adapter = { package: '@hypertest/runtime-pi' } as never)],
      ['default engine not pinned', (c) => (c.defaultEngine = 'dsh')],
      ['empty role catalog revision', (c) => (c.roleCatalogRevision = '')],
    ];
    for (const [what, mutate] of bad) {
      const c = content();
      mutate(c);
      assert.throws(() => buildRuntimeManifest(c, '2026-01-01T00:00:00.000Z'), (e: unknown) => isHypertestError(e, 'invalid_argument'), what);
    }
    assert.throws(() => buildRuntimeManifest(content(), 'yesterday'), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  });
});

describe('RuntimeManifest BOM: backward compatibility of the optional fields', () => {
  test('a manifest built without the runtime-BOM fields keeps verifying (ids of pinned runs stay valid)', () => {
    const c = content();
    delete c.hypertest.gitSha;
    const m = buildRuntimeManifest(c, '2026-01-01T00:00:00.000Z');
    assert.equal(verifyRuntimeManifest(m), true);
    assert.equal('defaultEngine' in m, false);
    assert.equal('roleCatalogRevision' in m, false);
  });
});

describe('toolCatalogRevision (runtime BOM: bindings, timeouts, adapters)', () => {
  const tool = (id: string, extra: Partial<ToolSpec> = {}): ToolSpec =>
    ({
      id, title: id, description: id, inputSchema: { type: 'object' }, effect: 'read', riskClass: 'low', timeoutMs: 30_000, resources: () => [], execute: async () => ({ status: 'success', output: null }), ...extra,
    }) as unknown as ToolSpec;
  const binding = { adapterId: 'env.process', operationType: 'env.restart', target: () => ({ kind: 'environment', resourceKey: 'env/e' }) } as unknown as NonNullable<ToolSpec['sideEffect']>;
  const adapters = [{ adapterId: 'env.process', capabilities: { supportsNativeIdempotency: false, supportsExternalLookupByOperationId: true, supportsFencing: true, supportsCompensation: false, reconciliationClass: 'deterministic', riskClass: 'high' } }];
  const catalog = () => [tool('fs.read'), tool('env.restart', { effect: 'destructive', riskClass: 'high', sideEffect: binding, timeoutMs: 120_000 })];

  test('content-addressed and order-independent', () => {
    const r = toolCatalogRevision(catalog(), adapters);
    assert.match(r, /^tc_[0-9a-f]{64}$/);
    assert.equal(toolCatalogRevision([...catalog()].reverse(), adapters), r);
  });

  test('a changed timeout, side-effect binding, lease TTL, effect, schema or adapter capability is another revision', () => {
    const base = toolCatalogRevision(catalog(), adapters);
    const variants = [
      toolCatalogRevision([tool('fs.read', { timeoutMs: 31_000 }), catalog()[1]!], adapters),
      toolCatalogRevision([tool('fs.read'), tool('env.restart', { effect: 'destructive', riskClass: 'high', timeoutMs: 120_000, sideEffect: { ...binding, operationType: 'env.redeploy' } })], adapters),
      toolCatalogRevision([tool('fs.read'), tool('env.restart', { effect: 'destructive', riskClass: 'high', timeoutMs: 120_000, sideEffect: { ...binding, leaseTtlMs: 5_000 } })], adapters),
      toolCatalogRevision([tool('fs.read'), tool('env.restart', { effect: 'destructive', riskClass: 'high', timeoutMs: 120_000 })], adapters),
      toolCatalogRevision([tool('fs.read', { effect: () => 'read' }), catalog()[1]!], adapters),
      toolCatalogRevision([tool('fs.read', { inputSchema: { type: 'object', required: ['path'] } }), catalog()[1]!], adapters),
      toolCatalogRevision(catalog(), [{ adapterId: 'env.process', capabilities: { ...adapters[0]!.capabilities, reconciliationClass: 'best_effort' } }]),
      toolCatalogRevision(catalog(), []),
    ];
    for (const v of variants) assert.notEqual(v, base);
    assert.equal(new Set(variants).size, variants.length);
  });

  test('refuses duplicate ids and tools without a positive timeout (they could not be pinned faithfully)', () => {
    assert.throws(() => toolCatalogRevision([tool('fs.read'), tool('fs.read')]), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    assert.throws(() => toolCatalogRevision([tool('fs.read', { timeoutMs: 0 })]), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    assert.throws(() => toolCatalogRevision([tool('fs.read')], [...adapters, ...adapters]), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  });
});

describe('EngineRegistry', () => {
  const deps = baseDeps();
  const native = new NativeEngine({ ...deps, sessions: createSessionStore({ ...deps, db: undefined as never }) });
  const fakeEngine = (kind: string, version: string): AgentEngine => ({ ...native, kind, version, runTurn: native.runTurn, createSession: native.createSession } as unknown as AgentEngine);

  test('register/get/list; duplicates conflict; unknown kinds are not found', () => {
    const reg = new EngineRegistry([native]);
    assert.equal(reg.get('native'), native);
    assert.throws(() => reg.register(fakeEngine('native', '9')), (e: unknown) => isHypertestError(e, 'conflict'));
    assert.throws(() => reg.get('dsh'), (e: unknown) => isHypertestError(e, 'not_found'));
    reg.register(fakeEngine('pi', '1.2.0'));
    assert.deepEqual(reg.manifestEntries(), [{ kind: 'native', version: native.version }, { kind: 'pi', version: '1.2.0' }]);
    assert.equal(reg.list().length, 2);
  });

  test('assertPinned refuses an engine whose version differs from the run manifest (no hot swap)', () => {
    const reg = new EngineRegistry([native, fakeEngine('pi', '1.3.0')]);
    const manifest = buildRuntimeManifest({ ...content(), agentEngines: [{ kind: 'native', version: native.version }, { kind: 'pi', version: '1.2.0' }] }, '2026-01-01T00:00:00.000Z');
    assert.equal(reg.assertPinned(manifest, 'native'), native);
    assert.throws(() => reg.assertPinned(manifest, 'pi'), (e: unknown) => isHypertestError(e, 'precondition_failed') && /pins 1\.2\.0/.test(e.message));
    const onlyNative = buildRuntimeManifest({ ...content(), agentEngines: [{ kind: 'native', version: native.version }] }, '2026-01-01T00:00:00.000Z');
    assert.throws(() => reg.assertPinned(onlyNative, 'pi'), (e: unknown) => isHypertestError(e, 'precondition_failed') && /not pinned/.test(e.message));
  });

  test('assertPinned fails closed on a pin without a version (the engine identity cannot be verified)', () => {
    const reg = new EngineRegistry([native]);
    const unversioned = buildRuntimeManifest({ ...content(), agentEngines: [{ kind: 'native', gitSha: 'abc123' }] }, '2026-01-01T00:00:00.000Z');
    assert.throws(() => reg.assertPinned(unversioned, 'native'), (e: unknown) => isHypertestError(e, 'precondition_failed') && /pins \(no version\)/.test(e.message));
    const both = buildRuntimeManifest({ ...content(), agentEngines: [{ kind: 'native' }, { kind: 'native', version: native.version }] }, '2026-01-01T00:00:00.000Z');
    assert.equal(reg.assertPinned(both, 'native'), native, 'an exact version pin is accepted');
  });
});
