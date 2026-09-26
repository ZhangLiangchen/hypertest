import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HypertestError, MemoryLogger } from '@hypertest/core';
import { createEnvironmentRegistry, splitControlTarget, type EnvironmentDescriptor } from '@hypertest/tools';
import { tempDir } from '@hypertest/testkit';
import { persistentEnvironmentRegistry, resolveEnvironments } from '../src/index.ts';

const env = (generation: number, extra: Partial<EnvironmentDescriptor> = {}): EnvironmentDescriptor => ({
  environmentId: 'shop', environmentClass: 'local', baseUrl: 'http://127.0.0.1:8080', generation, ...extra,
});

describe('environment generations survive restarts (freshness)', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => (dir = await tempDir('ht-app-envs-')));
  after(async () => dir.cleanup());

  test('a bump is persisted and restored over the configured generation after a restart (with its build digest)', async () => {
    const file = join(dir.path, 'a.json');
    const first = persistentEnvironmentRegistry(createEnvironmentRegistry([env(1, { buildDigest: 'b1' })]), file, new MemoryLogger());
    assert.equal(first.bumpGeneration('shop', 'b2').generation, 2);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, environments: { shop: { generation: 2, buildDigest: 'b2' } } });
    // restart: the configuration still says generation 1 / b1 — a snapshot taken before the deploy must stay stale
    const logger = new MemoryLogger();
    const second = persistentEnvironmentRegistry(createEnvironmentRegistry([env(1, { buildDigest: 'b1' })]), file, logger);
    assert.deepEqual([second.get('shop')!.generation, second.get('shop')!.buildDigest], [2, 'b2']);
    assert.equal(second.get('shop')!.baseUrl, 'http://127.0.0.1:8080', 'the other fields come from the configuration');
    assert.ok(logger.entries.some((e) => e.msg === 'environment generation restored from the state file' && e.fields?.['generation'] === 2));
  });

  test('a configured generation above the persisted one wins (an operator redeployed by hand)', async () => {
    const file = join(dir.path, 'b.json');
    persistentEnvironmentRegistry(createEnvironmentRegistry([env(1)]), file, new MemoryLogger()).bumpGeneration('shop', 'b2');
    const r = persistentEnvironmentRegistry(createEnvironmentRegistry([env(5, { buildDigest: 'b5' })]), file, new MemoryLogger());
    assert.deepEqual([r.get('shop')!.generation, r.get('shop')!.buildDigest], [5, 'b5']);
  });

  test('writes merge with the file: a registry that is behind never lowers a persisted generation', async () => {
    const file = join(dir.path, 'c.json');
    const ahead = persistentEnvironmentRegistry(createEnvironmentRegistry([env(1), { ...env(1), environmentId: 'other' }]), file, new MemoryLogger());
    ahead.bumpGeneration('shop');
    ahead.bumpGeneration('shop');
    // a second registry that loaded before those bumps, bumping another environment
    const behind = persistentEnvironmentRegistry(createEnvironmentRegistry([env(1), { ...env(1), environmentId: 'other' }]), join(dir.path, 'c-copy.json'), new MemoryLogger());
    await writeFile(join(dir.path, 'c-copy.json'), await readFile(file, 'utf8'));
    behind.bumpGeneration('other');
    const persisted = JSON.parse(await readFile(join(dir.path, 'c-copy.json'), 'utf8')) as { environments: Record<string, { generation: number }> };
    assert.deepEqual([persisted.environments['shop']!.generation, persisted.environments['other']!.generation], [3, 2]);
  });

  test('a corrupt state file fails closed (integrity_violation), never silently resets generations', async () => {
    const file = join(dir.path, 'd.json');
    await writeFile(file, '{"version":1,"environments":{"shop":{"generation":"two"}}}');
    assert.throws(() => persistentEnvironmentRegistry(createEnvironmentRegistry([env(1)]), file, new MemoryLogger()), (e: unknown) => e instanceof HypertestError && e.code === 'integrity_violation');
    await writeFile(file, 'not json');
    assert.throws(() => persistentEnvironmentRegistry(createEnvironmentRegistry([env(1)]), file, new MemoryLogger()), (e: unknown) => e instanceof HypertestError && e.code === 'integrity_violation');
  });
});

describe('control tokens from control.tokenEnv', () => {
  test('the token is attached to the control target (as the env.* adapters read it); tokenEnv never reaches the registry', () => {
    const configured = [{ ...env(0), control: { kind: 'process' as const, target: 'http://127.0.0.1:9100/__hypertest', tokenEnv: 'SHOP_SUPERVISOR' } }];
    const [resolved] = resolveEnvironments(configured, { SHOP_SUPERVISOR: 'tok en/&=#' }, new MemoryLogger());
    assert.deepEqual(Object.keys(resolved!.control!).sort(), ['kind', 'target']);
    const split = splitControlTarget(resolved!.control!.target);
    assert.deepEqual([split.url.href, split.token], ['http://127.0.0.1:9100/__hypertest', 'tok en/&=#']);
    assert.equal(configured[0]!.control.target, 'http://127.0.0.1:9100/__hypertest', 'the configuration is not mutated');
  });

  test('a missing token variable is a warning (by name), and the target carries no token', () => {
    const logger = new MemoryLogger();
    const [resolved] = resolveEnvironments([{ ...env(0), control: { kind: 'process', target: 'http://127.0.0.1:9100/__hypertest', tokenEnv: 'SHOP_SUPERVISOR' } }], {}, logger);
    assert.equal(resolved!.control!.target, 'http://127.0.0.1:9100/__hypertest');
    assert.deepEqual(logger.entries.filter((e) => e.level === 'warn').map((e) => e.fields), [{ environmentId: 'shop', tokenEnv: 'SHOP_SUPERVISOR' }]);
  });
});
