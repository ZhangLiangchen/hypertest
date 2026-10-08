/**
 * E[4] / coverage[8] at the composition root: the LLM never receives a long-lived static credential.
 *  - where the local sandbox cannot hide the signing keys, the capability secret and the store from agent commands (no
 *    PID/mount jail, or `network: open`), createHypertest refuses (fail closed) unless `sandbox.insecureAllowUnhiddenSecrets`;
 *  - an externally configured signing key file is hidden too;
 *  - brokered credentials are configured per environment (a `*Env` secret); the registry shows agents their NAMES only.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { HypertestError, MemoryLogger } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { networkIsolation } from '@hypertest/tools';
import { createHypertest, defaultConfig, resolveEnvironments, sandboxHiddenPaths, validateConfig, type HypertestConfig } from '../src/index.ts';
import { scriptedConfig, testStore } from './helpers.ts';

const NO_JAIL = { python: false as const };

describe('fail closed where the sandbox cannot hide secrets (E[4])', () => {
  test('no PID/mount jail on the host ⇒ createHypertest refuses; the loud opt-in starts it with a warning', async () => {
    const iso = await networkIsolation(NO_JAIL);
    assert.ok(!iso.available || !iso.jail, 'without python3 no strategy hides paths');
    const dir = await tempDir('ht-app-secrets-');
    const db = await testStore();
    try {
      const config = (extra: Record<string, unknown> = {}): HypertestConfig => {
        const c = scriptedConfig(dir.path, extra as never);
        return db.store ? { ...c, store: db.store } : c;
      };
      await assert.rejects(
        createHypertest(config(), { scriptedBrains: { sim: () => ({ text: 'unused' }) }, logger: new MemoryLogger(), sandboxIsolation: NO_JAIL }),
        (e: unknown) => e instanceof HypertestError && e.code === 'precondition_failed' && /cannot hide the signing keys, the capability secret and the store/.test(e.message) && /sandbox\.insecureAllowUnhiddenSecrets: true/.test(e.message),
      );
      // network open: no namespaces at all ⇒ refused too
      await assert.rejects(
        createHypertest(config({ sandbox: { network: 'open' } }), { scriptedBrains: { sim: () => ({ text: 'unused' }) }, logger: new MemoryLogger() }),
        (e: unknown) => e instanceof HypertestError && e.code === 'precondition_failed' && /sandbox\.network is open/.test(e.message),
      );
      const logger = new MemoryLogger();
      const ht = await createHypertest(config({ sandbox: { insecureAllowUnhiddenSecrets: true } }), { scriptedBrains: { sim: () => ({ text: 'unused' }) }, logger, sandboxIsolation: NO_JAIL });
      try {
        assert.ok(logger.entries.some((e) => e.level === 'warn' && e.msg.startsWith('INSECURE: the local sandbox does NOT hide the signing keys')));
      } finally {
        await ht.close();
      }
    } finally {
      await db.dispose();
      await dir.cleanup();
    }
  });

  test('the configured signing key file is hidden from agent commands (with the keys dir, state, PGlite store, artifacts)', () => {
    const config = defaultConfig({ project: { dataDir: '/srv/ht' }, signing: { keyFile: '/etc/hypertest/evidence.pem' } });
    assert.ok(sandboxHiddenPaths(config, '/srv/ht', '/srv/ht/state').includes('/etc/hypertest/evidence.pem'));
  });
});

describe('brokered credentials in the configuration (coverage[8])', () => {
  test('validated exactly; an environment descriptor names its credentials only (no secret, no variable)', () => {
    const base = defaultConfig({ project: { dataDir: '/tmp/x' } });
    const env = (credentials: unknown[]) => ({ ...base, environments: [{ environmentId: 'shop', environmentClass: 'local', generation: 0, baseUrl: 'http://127.0.0.1:9', credentials }] }) as unknown as HypertestConfig;
    assert.deepEqual(validateConfig(env([{ name: 'orders', kind: 'jwt_hs256', secretEnv: 'ORDERS_SECRET', grantTo: ['test_executor'] }])), []);
    assert.deepEqual(validateConfig(env([{ name: 'orders', kind: 'basic', secretEnv: 'X', value: 'inline!' }])), [
      "environments[0].credentials[0]: unknown key 'value' (expected one of name, kind, secretEnv, header, ttlMs, audience, tokenUrl, clientId, clientIdEnv, scope, grantTo)",
      'environments[0].credentials[0].kind must be jwt_hs256 or oauth2_client_credentials',
    ]);
    assert.deepEqual(validateConfig(env([{ name: 'a', kind: 'jwt_hs256', secretEnv: 'A' }, { name: 'a', kind: 'jwt_hs256', secretEnv: 'B' }])), ["environments[0].credentials[1].name: duplicate credential 'a'"]);
    const [resolved] = resolveEnvironments([{ environmentId: 'shop', environmentClass: 'local', generation: 0, credentials: [{ name: 'orders', kind: 'jwt_hs256', secretEnv: 'ORDERS_SECRET', grantTo: ['test_executor'] }] }], { ORDERS_SECRET: 'sssssssssssssssss' }, new MemoryLogger());
    assert.deepEqual(resolved!.brokeredCredentials, [{ name: 'orders', grantTo: ['test_executor'] }]);
    assert.equal(JSON.stringify(resolved).includes('ORDERS_SECRET'), false);
    assert.equal(JSON.stringify(resolved).includes('sssssssssssssssss'), false);
    assert.equal('credentials' in resolved!, false);
  });

  test('the sandbox opt-in is a boolean', () => {
    const errors = validateConfig({ ...defaultConfig({ project: { dataDir: join('/tmp', 'y') } }), sandbox: { insecureAllowUnhiddenSecrets: 'yes' } } as unknown as HypertestConfig);
    assert.deepEqual(errors, ['sandbox.insecureAllowUnhiddenSecrets must be a boolean']);
  });
});
