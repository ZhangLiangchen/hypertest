import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { MemoryLogger } from '@hypertest/core';
import { acquireDirectoryLock, defaultConfig, diagnose, lockFileFor, type DiagnosticReport, type HypertestConfig } from '../src/index.ts';
import { FULL_ROUTE } from './helpers.ts';

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const of = (r: DiagnosticReport, name: string) => r.checks.filter((c) => c.name === name);

describe('diagnose (hypertest doctor)', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let base: (extra?: Record<string, unknown>) => HypertestConfig;
  before(async () => {
    dir = await tempDir('ht-app-doctor-');
    base = (extra = {}) =>
      defaultConfig({
        project: { name: 'doc', dataDir: join(dir.path, 'data') },
        models: {
          providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'HT_DOCTOR_KEY' }],
          routes: [{ routeId: 'local-big', provider: 'local', model: 'm', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities], quality: { ...FULL_ROUTE.quality } }],
        },
        ...extra,
      } as never);
  });
  after(async () => dir.cleanup());

  test('a healthy configuration: every check ok, secrets reported by name only', async () => {
    const r = await diagnose(base(), { env: { HT_DOCTOR_KEY: 'sk-doctor-SECRET' } });
    assert.equal(r.ok, true, JSON.stringify(r.checks, null, 2));
    assert.deepEqual(r.checks.filter((c) => c.status !== 'ok'), []);
    assert.deepEqual(of(r, 'secrets'), [{ name: 'secrets', status: 'ok', detail: 'provider local (apiKeyEnv): HT_DOCTOR_KEY is set' }]);
    assert.deepEqual(of(r, 'models'), [{ name: 'models', status: 'ok', detail: '1 route(s); every built-in role can be routed' }]);
    assert.equal(of(r, 'store')[0]!.detail, `PGlite data directory ${join(dir.path, 'data', 'db')} can be created (${dir.path} is writable)`);
    assert.equal(existsSync(join(dir.path, 'data')), false, 'doctor is read-only');
    assert.match(of(r, 'protocol')[0]!.detail, /^BUGate .* \(embedded\), digest [0-9a-f]{16}$/);
    assert.equal(JSON.stringify(r).includes('sk-doctor-SECRET'), false);
  });

  test('a missing API key variable is an error (reported by doctor, not at load)', async () => {
    const r = await diagnose(base(), { env: {}, connect: false });
    assert.equal(r.ok, false);
    assert.deepEqual(of(r, 'secrets'), [{ name: 'secrets', status: 'error', detail: 'provider local (apiKeyEnv): environment variable HT_DOCTOR_KEY is not set' }]);
  });

  test('no routes ⇒ error: every run would fail at routing', async () => {
    const r = await diagnose(defaultConfig({ project: { dataDir: join(dir.path, 'x') } }), { env: {}, connect: false });
    assert.equal(r.ok, false);
    assert.deepEqual(of(r, 'models'), [{ name: 'models', status: 'error', detail: 'no model routes are configured: every run fails when it routes its lead agent (add models.providers and models.routes)' }]);
  });

  test('a route with default capabilities cannot serve the lead (error) nor the analysts (warning)', async () => {
    const cfg = base({ models: { providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }], routes: [{ routeId: 'plain', provider: 'local', model: 'm' }] } });
    const r = await diagnose(cfg, { env: {}, connect: false });
    assert.equal(r.ok, false);
    const models = of(r, 'models');
    assert.equal(models.length, 2);
    assert.equal(models[0]!.status, 'error');
    assert.match(models[0]!.detail, /^no route can serve the lead role \(plain: .+\): every run would fail at routing$/);
    assert.equal(models[1]!.status, 'warn');
    assert.match(models[1]!.detail, /code_change_analyst \(plain: /);
    assert.doesNotMatch(models[1]!.detail, /executor \(/, 'the executor needs tool_use + structured_output only: the default route serves it');
  });

  test('invalid configurations stop at validation with every problem', async () => {
    const r = await diagnose({ ...base(), engines: { default: 'dsh' } } as HypertestConfig, { connect: false });
    assert.deepEqual(r, { ok: false, checks: [{ name: 'config', status: 'error', detail: 'engines.default: "dsh" is not a registered engine (native, pi)' }] });
  });

  test('infrastructure probes: unreachable NATS / Temporal / OPA are errors; connect:false skips them', async () => {
    const port = await closedPort();
    const cfg = base({
      bus: { kind: 'nats', servers: [`nats://127.0.0.1:${port}`] },
      durable: { kind: 'temporal', address: `127.0.0.1:${port}` },
      policy: { opa: { url: `http://127.0.0.1:${port}` } },
      bugate: { path: join(dir.path, 'no-bugate') },
    });
    const r = await diagnose(cfg, { env: { HT_DOCTOR_KEY: 'k' }, timeoutMs: 1000 });
    assert.equal(r.ok, false);
    assert.match(of(r, 'bus')[0]!.detail, new RegExp(`^NATS 127\\.0\\.0\\.1:${port} is not reachable: `));
    assert.match(of(r, 'durable')[0]!.detail, new RegExp(`^Temporal 127\\.0\\.0\\.1:${port} is not reachable: `));
    assert.match(of(r, 'policy')[0]!.detail, new RegExp(`^OPA http://127\\.0\\.0\\.1:${port}/health is not reachable: `));
    assert.equal(of(r, 'protocol')[0]!.status, 'warn');
    assert.match(of(r, 'protocol')[0]!.detail, /no BUGate checkout at .*no-bugate/);
    const offline = await diagnose(cfg, { env: { HT_DOCTOR_KEY: 'k' }, connect: false });
    assert.deepEqual([of(offline, 'bus'), of(offline, 'durable'), of(offline, 'policy')], [[], [], []]);
    assert.equal(offline.ok, true);
  });

  test('a postgres store without a shared capability secret is a warning; a missing urlEnv an error', async () => {
    const r = await diagnose(base({ store: { kind: 'postgres', urlEnv: 'HT_DOCTOR_PG' } }), { env: { HT_DOCTOR_KEY: 'k' }, connect: false });
    assert.deepEqual(
      of(r, 'secrets').filter((c) => c.status !== 'ok'),
      [
        { name: 'secrets', status: 'error', detail: 'store (urlEnv): environment variable HT_DOCTOR_PG is not set' },
        { name: 'secrets', status: 'warn', detail: 'store is postgres but policy.capabilitySecretEnv is not set: every worker generates its own capability secret; workers sharing the database need a shared one' },
      ],
    );
  });

  test('control tokens by name (missing ⇒ error), an ignored maxRetries (warning), a PGlite directory in use (warning)', async () => {
    const cfg = base({
      environments: [{ environmentId: 'shop', environmentClass: 'local', generation: 0, control: { kind: 'process', target: 'http://127.0.0.1:9100/__hypertest', tokenEnv: 'HT_DOCTOR_SUPERVISOR' } }],
      models: {
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'HT_DOCTOR_KEY', maxRetries: 3 }],
        routes: [{ routeId: 'local-big', provider: 'local', model: 'm', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities], quality: { ...FULL_ROUTE.quality } }],
      },
    });
    let r = await diagnose(cfg, { env: { HT_DOCTOR_KEY: 'k' }, connect: false });
    assert.equal(r.ok, false);
    assert.deepEqual(of(r, 'secrets').filter((c) => c.status !== 'ok'), [{ name: 'secrets', status: 'error', detail: 'environment shop (control.tokenEnv): environment variable HT_DOCTOR_SUPERVISOR is not set' }]);
    assert.deepEqual(of(r, 'models').filter((c) => c.status === 'warn'), [{ name: 'models', status: 'warn', detail: "provider local: maxRetries is not supported (retries and fail-closed fallback are the model router's); the value is ignored" }]);
    const storeDir = join(dir.path, 'data', 'db');
    const lock = await acquireDirectoryLock(lockFileFor(storeDir), 'test', new MemoryLogger());
    try {
      r = await diagnose(cfg, { env: { HT_DOCTOR_KEY: 'k', HT_DOCTOR_SUPERVISOR: 'secret-token-value' }, connect: false });
      assert.equal(r.ok, true, JSON.stringify(r.checks));
      assert.deepEqual(of(r, 'store').filter((c) => c.status === 'warn').map((c) => c.detail), [
        `PGlite data directory ${storeDir} is in use by process ${process.pid} on ${hostname()} (lock file ${lockFileFor(storeDir)}): another Hypertest process cannot open it until that one stops`,
      ]);
      assert.equal(JSON.stringify(r).includes('secret-token-value'), false);
    } finally {
      await lock.release();
    }
  });
});
