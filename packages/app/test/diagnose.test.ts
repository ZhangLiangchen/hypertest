import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { MemoryLogger } from '@hypertest/core';
import { networkIsolation } from '@hypertest/tools';
import { acquireDirectoryLock, defaultConfig, diagnose, lockFileFor, providerLocality, type DiagnosticReport, type HypertestConfig } from '../src/index.ts';
import { FULL_ROUTE } from './helpers.ts';

/** A local model route every role can use, the specialists included: vision, and restricted data (it runs on this host). */
const LOCAL_ROUTE = { ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities, 'vision'], quality: { ...FULL_ROUTE.quality }, maxDataClassification: 'restricted' } as const;

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
          routes: [{ routeId: 'local-big', provider: 'local', model: 'm', ...LOCAL_ROUTE, capabilities: [...LOCAL_ROUTE.capabilities] }],
        },
        ...extra,
      } as never);
  });
  after(async () => dir.cleanup());

  test('a healthy configuration: every check ok, secrets reported by name only', async (t) => {
    const iso = await networkIsolation();
    if (!iso.available || !iso.jail) {
      // the default sandbox (network loopback) cannot be (fully) enforced here: doctor must say so (security-2, H1)
      const r = await diagnose(base(), { env: { HT_DOCTOR_KEY: 'sk-doctor-SECRET' } });
      assert.deepEqual(r.checks.filter((c) => c.status !== 'ok').map((c) => [c.name, c.status]), [['sandbox', iso.available ? 'warn' : 'error']]);
      t.skip(`the sandbox jail is unavailable on this host (${iso.available ? iso.strategy : iso.reason}): the default configuration is not fully healthy here`);
      return;
    }
    const r = await diagnose(base(), { env: { HT_DOCTOR_KEY: 'sk-doctor-SECRET' } });
    assert.equal(r.ok, true, JSON.stringify(r.checks, null, 2));
    assert.deepEqual(r.checks.filter((c) => c.status !== 'ok'), []);
    assert.match(of(r, 'sandbox')[0]!.detail, /^local sandbox, network loopback \(enforced: userns_jail, private loopback; keys, store and other workspaces hidden\), env allowlist /);
    assert.deepEqual(of(r, 'secrets'), [{ name: 'secrets', status: 'ok', detail: 'provider local (apiKeyEnv): HT_DOCTOR_KEY is set' }]);
    assert.deepEqual(of(r, 'models'), [
      { name: 'models', status: 'ok', detail: '1 route(s); every core role can be routed' },
      { name: 'models', status: 'ok', detail: 'vision_gui: routed to local-big (vision); computer-use fallback unavailable (no route with computer_use): DOM, API and screenshot checks only' },
      { name: 'models', status: 'ok', detail: 'local_private: restricted data is routed only to routes accepting it (local-big); selected local-big' },
    ]);
    assert.equal(of(r, 'store')[0]!.detail, `PGlite data directory ${join(dir.path, 'data', 'db')} can be created (${dir.path} is writable)`);
    assert.equal(existsSync(join(dir.path, 'data')), false, 'doctor is read-only');
    assert.match(of(r, 'protocol')[0]!.detail, /^BUGate .* \(embedded\), digest [0-9a-f]{16}$/);
    assert.equal(JSON.stringify(r).includes('sk-doctor-SECRET'), false);
  });

  test('security-2: an open sandbox network is a warning (no egress governance for commands agents run)', async () => {
    const r = await diagnose(base({ sandbox: { network: 'open' } }), { env: { HT_DOCTOR_KEY: 'k' }, connect: false });
    assert.deepEqual(of(r, 'sandbox'), [{ name: 'sandbox', status: 'warn', detail: 'local sandbox, network open (commands agents run reach any host: no egress governance), env allowlist PATH, HOME, LANG, LC_ALL, TMPDIR' }]);
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

  test('A[2]: a route declaring only [tool_use, structured_output] cannot serve the lead (error) nor the analysts (warning); its defaulted fields and unknown price are reported', async () => {
    const cfg = base({ models: { providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }], routes: [{ routeId: 'plain', provider: 'local', model: 'm', capabilities: ['tool_use', 'structured_output'] }] } });
    const r = await diagnose(cfg, { env: {}, connect: false });
    assert.equal(r.ok, false);
    const all = of(r, 'models');
    assert.deepEqual(all.slice(0, 2), [
      {
        name: 'models', status: 'warn',
        detail: 'route plain: defaulted fields reasoning, contextWindow, maxOutputTokens, maxDataClassification, quality, toolReliability, typicalLatencyMs, maxActionRisk, enabled, structuredOutput (declare them; security fields default to maxDataClassification internal, maxActionRisk low)',
      },
      { name: 'models', status: 'warn', detail: 'route plain: price unknown (no costPerMillionInputUsd/costPerMillionOutputUsd): runs or work items with a USD cost budget never route to it' },
    ]);
    const models = all.slice(2);
    assert.equal(models.length, 4);
    assert.equal(models[0]!.status, 'error');
    assert.match(models[0]!.detail, /^no route can serve the lead role \(plain: .+\): every run would fail at routing$/);
    assert.equal(models[1]!.status, 'warn');
    assert.match(models[1]!.detail, /code_change_analyst \(plain: /);
    assert.doesNotMatch(models[1]!.detail, /executor \(/, 'the executor needs tool_use + structured_output only: the default route serves it');
    assert.doesNotMatch(models[1]!.detail, /vision_gui|local_private/, 'the specialist roles are reported on their own');
    assert.deepEqual(models.slice(2).map((m) => m.status), ['warn', 'warn']);
    assert.match(models[2]!.detail, /^vision_gui: no route can serve GUI testing \(plain: .*vision.*\): GUI work items fail at routing — add a route with capabilities \[tool_use, structured_output, vision\]$/);
    assert.match(models[3]!.detail, /^local_private: no route can take restricted data \(plain: route accepts data up to internal; request carries restricted\): restricted work fails closed at routing and is never sent to another model/);
  });

  test('specialist route coverage: vision (+ computer-use fallback) and restricted data only on local routes', async () => {
    const providers: HypertestConfig['models']['providers'] = [
      { id: 'claude', kind: 'anthropic', apiKeyEnv: 'HT_DOCTOR_KEY' },
      { id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' },
    ];
    const hosted = { routeId: 'claude-big', provider: 'claude', model: 'c', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities, 'vision', 'computer_use'], quality: { default: 0.95 } };
    const local = { routeId: 'local-qwen', provider: 'local', model: 'q', ...FULL_ROUTE, capabilities: ['tool_use', 'structured_output'], quality: { default: 0.6 }, maxDataClassification: 'restricted' };
    // hosted vision route + a local restricted route: both specialists are served, restricted data stays local
    let r = await diagnose(base({ models: { providers, routes: [hosted, local] } }), { env: { HT_DOCTOR_KEY: 'k' }, connect: false });
    assert.deepEqual(of(r, 'models').slice(1), [
      { name: 'models', status: 'ok', detail: 'vision_gui: routed to claude-big (vision); computer-use fallback routes: claude-big' },
      { name: 'models', status: 'ok', detail: 'local_private: restricted data is routed only to routes accepting it (local-qwen); selected local-qwen' },
    ]);
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    // a hosted route declared to accept restricted data: local_private would be sent to it (warning naming the provider)
    r = await diagnose(base({ models: { providers, routes: [{ ...hosted, maxDataClassification: 'restricted' }, local] } }), { env: { HT_DOCTOR_KEY: 'k' }, connect: false });
    assert.deepEqual(of(r, 'models').filter((c) => c.status === 'warn').map((c) => c.detail), [
      'route claude-big accepts restricted data but its provider claude runs at the hosted Anthropic API: restricted data (local_private work) would leave this deployment — lower its maxDataClassification or point it at a local model',
    ]);
    // no route for restricted data at all: the role fails closed (never routed elsewhere)
    r = await diagnose(base({ models: { providers, routes: [hosted] } }), { env: { HT_DOCTOR_KEY: 'k' }, connect: false });
    const priv = of(r, 'models').find((c) => c.detail.startsWith('local_private'))!;
    assert.equal(priv.status, 'warn');
    assert.match(priv.detail, /claude-big: route accepts data up to confidential; request carries restricted/);
  });

  test('providerLocality: loopback, private networks and in-process providers are local; hosted APIs are not', () => {
    const local = (baseUrl: string) => providerLocality({ kind: 'openai-compatible', baseUrl }).local;
    for (const u of ['http://127.0.0.1:11434/v1', 'http://localhost:8000/v1', 'http://[::1]:8000/v1', 'http://10.1.2.3/v1', 'http://192.168.0.7:1234/v1', 'http://172.20.0.2/v1', 'http://llm.internal/v1', 'http://vllm.ml.svc.cluster.local/v1']) {
      assert.equal(local(u), true, u);
    }
    for (const u of ['https://api.deepseek.com/v1', 'http://172.32.0.1/v1', 'http://8.8.8.8/v1', 'http://127.0.0.1.nip.io/v1']) assert.equal(local(u), false, u);
    assert.equal(providerLocality({ kind: 'scripted' }).local, true);
    assert.equal(providerLocality({ kind: 'anthropic' }).local, false);
    assert.equal(providerLocality({ kind: 'pi-ai' }).local, false, 'no endpoint: the provider default (hosted)');
  });

  test('invalid configurations stop at validation with every problem', async () => {
    const r = await diagnose({ ...base(), engines: { default: 'openhands' } } as HypertestConfig, { connect: false });
    assert.deepEqual(r, { ok: false, checks: [{ name: 'config', status: 'error', detail: 'engines.default: "openhands" is not a registered engine (native, pi, dsh)' }] });
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
        routes: [{ routeId: 'local-big', provider: 'local', model: 'm', ...LOCAL_ROUTE, capabilities: [...LOCAL_ROUTE.capabilities] }],
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
