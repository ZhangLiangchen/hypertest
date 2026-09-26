import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HypertestError, MemoryLogger } from '@hypertest/core';
import { AnthropicProvider, OpenAICompatibleProvider, PiAiProvider, ProviderRegistry, ScriptedProvider } from '@hypertest/model';
import { BUILTIN_ROLES, RoleCatalog } from '@hypertest/agents';
import { tempDir } from '@hypertest/testkit';
import type { ControlPlane } from '@hypertest/control';
import type { TestRun } from '@hypertest/domain';
import { splitControlTarget } from '@hypertest/tools';
import {
  buildCatalog, createHypertest, defaultConfig, hypertestSourceDigest, opaPolicyRevision, defaultWorkerId, lockFileFor, manifestTaskQueue, pinnedControlPlane, roleOverrides, sandboxProfile, type HypertestConfig,
} from '../src/index.ts';
import { scriptedConfig } from './helpers.ts';

function cfg(models: HypertestConfig['models'], extra: Partial<HypertestConfig> = {}): HypertestConfig {
  return { ...defaultConfig(), models, ...extra };
}

describe('model catalog from the configuration', () => {
  const registry = () =>
    new ProviderRegistry([
      new AnthropicProvider({ providerId: 'claude' }),
      new OpenAICompatibleProvider({ providerId: 'local', baseUrl: 'http://127.0.0.1:1/v1' }),
      new PiAiProvider({ providerId: 'pi', piProvider: 'ollama', baseUrl: 'http://127.0.0.1:1/v1' }),
      new ScriptedProvider({ providerId: 'sim', brain: () => ({ text: 'x' }) }),
    ]);
  const providers: HypertestConfig['models']['providers'] = [
    { id: 'claude', kind: 'anthropic' },
    { id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' },
    { id: 'pi', kind: 'pi-ai', piProvider: 'ollama', baseUrl: 'http://127.0.0.1:1/v1' },
    { id: 'sim', kind: 'scripted' },
  ];

  test("each route's continuation class is its provider's tag (anthropic, pi-ai resolved model, <id>:<model>)", async () => {
    const catalog = await buildCatalog(
      cfg({
        providers,
        routes: [
          { routeId: 'c', provider: 'claude', model: 'claude-x' },
          { routeId: 'l', provider: 'local', model: 'qwen' },
          { routeId: 'p', provider: 'pi', model: 'llama3' },
          { routeId: 's', provider: 'sim', model: 'sim-1', quality: { default: 0.9 } },
        ],
      }),
      registry(),
    );
    assert.deepEqual(
      catalog.list().map((p) => [p.routeId, p.continuationCompatibilityClass]),
      [['c', 'anthropic:claude-x'], ['l', 'local:qwen'], ['p', 'pi-ai:openai-completions:ollama:llama3'], ['s', 'sim:sim-1']],
    );
    assert.deepEqual(catalog.get('s')!.quality, { default: 0.9 });
    assert.deepEqual(catalog.get('c')!.capabilities, ['tool_use', 'structured_output']);
  });

  test('a pinned tag that differs from the provider tag, an unresolvable pi model and an unregistered provider are refused', async () => {
    await assert.rejects(
      buildCatalog(cfg({ providers, routes: [{ routeId: 'p', provider: 'pi', model: 'llama3', continuationCompatibilityClass: 'pi:llama3' }] }), registry()),
      (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument' && e.message === "models.routes[0] (p): continuationCompatibilityClass must equal the provider's tag 'pi-ai:openai-completions:ollama:llama3'",
    );
    const noBase = new ProviderRegistry([new PiAiProvider({ providerId: 'pi', piProvider: 'nosuchprovider' })]);
    await assert.rejects(
      buildCatalog(cfg({ providers: [{ id: 'pi', kind: 'pi-ai', piProvider: 'nosuchprovider' }], routes: [{ routeId: 'p', provider: 'pi', model: 'm' }] }), noBase),
      (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument' && /^models\.routes\[0\] \(p\): pi-ai: model m is not defined for provider nosuchprovider/.test(e.message),
    );
    await assert.rejects(
      buildCatalog(cfg({ providers, routes: [{ routeId: 'x', provider: 'ghost', model: 'm' }] }), registry()),
      (e: unknown) => e instanceof HypertestError && e.message === "models.routes[0] (x): provider 'ghost' is not registered",
    );
  });
});

describe('role overrides', () => {
  test('the condenser runs as a plain summarizer (no required capabilities); defaultPolicy applies to every role; config roles win', () => {
    const overrides = roleOverrides(cfg({ providers: [], routes: [], defaultPolicy: { prohibitedProviders: ['untrusted'] } }, { roles: { lead: { defaultModelPolicy: { minQuality: 0.9 } } } }));
    const roles = new RoleCatalog(BUILTIN_ROLES, { roles: overrides });
    assert.deepEqual(roles.require('condenser').defaultModelPolicy.requiredCapabilities, []);
    for (const r of roles.list()) assert.deepEqual(r.defaultModelPolicy.prohibitedProviders, ['untrusted'], r.role);
    assert.equal(roles.require('lead').defaultModelPolicy.minQuality, 0.9);
    assert.deepEqual(roles.require('lead').defaultModelPolicy.requiredCapabilities, ['tool_use', 'reasoning', 'long_context'], 'untouched fields keep the built-in policy');
    const plain = new RoleCatalog(BUILTIN_ROLES, { roles: roleOverrides(defaultConfig()) });
    assert.equal(plain.require('lead').defaultModelPolicy.prohibitedProviders, undefined);
  });

  test('sandbox profile and worker identity defaults', () => {
    assert.deepEqual(sandboxProfile(defaultConfig()), { kind: 'local', network: 'loopback', envAllowlist: ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'] });
    assert.deepEqual(sandboxProfile(defaultConfig({ sandbox: { network: 'none' } })).network, 'none');
    assert.equal(defaultWorkerId(defaultConfig()), `worker:${hostname()}`);
    assert.equal(defaultWorkerId(defaultConfig({ store: { kind: 'postgres', urlEnv: 'X' } })), `worker:${hostname()}:${process.pid}`);
    // durability-4: every Temporal worker of one deployment is ONE identity (activities land on any of them)
    const temporal = defaultConfig({ store: { kind: 'postgres', urlEnv: 'X' }, durable: { kind: 'temporal', address: '127.0.0.1:7233', namespace: 'ns', taskQueue: 'q' } });
    assert.equal(defaultWorkerId(temporal), 'worker:temporal:ns/q');
    assert.ok(!defaultWorkerId(temporal).includes(String(process.pid)), 'never the process id');
    assert.equal(defaultWorkerId(defaultConfig({ durable: { kind: 'temporal', address: '127.0.0.1:7233' } })), 'worker:temporal:default/hypertest');
  });

  test('durability-6: the Temporal task queue is scoped to the runtime manifest (workers of another manifest never get its activities)', async () => {
    assert.equal(manifestTaskQueue('hypertest', 'rm_0123456789abcdef0123'), 'hypertest@0123456789abcdef');
    const dir = await tempDir('ht-app-queue-');
    try {
      const base = { durable: { kind: 'temporal' as const, address: '127.0.0.1:1', taskQueue: 'q', workerMode: 'external' as const } };
      const a = await createHypertest(scriptedConfig(join(dir.path, 'a'), base), { scriptedBrains: { sim: () => ({ text: 'x' }) }, logger: new MemoryLogger() });
      const b = await createHypertest(
        scriptedConfig(join(dir.path, 'b'), { ...base, policy: { rules: [{ id: 'site.extra', description: 'another bundle', match: { effects: ['read'] }, decision: 'allow' }] } }),
        { scriptedBrains: { sim: () => ({ text: 'x' }) }, logger: new MemoryLogger() },
      );
      try {
        const queueOf = (ht: typeof a) => (ht.durable as unknown as { taskQueue: string }).taskQueue;
        assert.equal(queueOf(a), manifestTaskQueue('q', a.manifest.manifestId));
        assert.notEqual(a.manifest.manifestId, b.manifest.manifestId);
        assert.notEqual(queueOf(a), queueOf(b), 'another manifest ⇒ another queue');
        assert.equal(a.services.workerId, 'worker:temporal:default/q');
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await dir.cleanup();
    }
  });
});

describe('createHypertest (fast paths)', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => (dir = await tempDir('ht-app-compose-')));
  after(async () => dir.cleanup());

  test('an unresolvable route fails before the data directory is created', async () => {
    const c = defaultConfig({ project: { dataDir: join(dir.path, 'x') }, models: { providers: [{ id: 'pi', kind: 'pi-ai', piProvider: 'nosuchprovider' }], routes: [{ routeId: 'p', provider: 'pi', model: 'm' }] } });
    await assert.rejects(createHypertest(c, { logger: new MemoryLogger() }), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument');
    assert.equal(existsSync(join(dir.path, 'x')), false);
  });

  test('a configured signing key that is missing aborts the composition and closes what was opened', async () => {
    const c = defaultConfig({ project: { dataDir: join(dir.path, 'y') }, signing: { keyFile: join(dir.path, 'absent.pem') } });
    await assert.rejects(createHypertest(c, { logger: new MemoryLogger() }), (e: unknown) => e instanceof HypertestError && e.code === 'not_found');
    assert.equal(existsSync(join(dir.path, 'y', 'db')), false, 'the database was never opened');
  });

  test('a missing API key variable is a warning (never the value), not a composition failure', async () => {
    const logger = new MemoryLogger();
    const c = defaultConfig({
      project: { dataDir: join(dir.path, 'z') },
      models: { providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'HT_COMPOSE_KEY' }], routes: [{ routeId: 'l', provider: 'local', model: 'm' }] },
    });
    const ht = await createHypertest(c, { logger, env: { OTHER: 'x' } });
    try {
      const warn = logger.entries.find((e) => e.msg.startsWith('model provider API key variable is not set'));
      assert.deepEqual(warn?.fields, { provider: 'local', apiKeyEnv: 'HT_COMPOSE_KEY' });
      assert.equal(ht.services.workerId, `worker:${hostname()}`);
      assert.equal(ht.config.store.kind === 'pglite' && ht.config.store.dataDir, join(dir.path, 'z', 'db'));
    } finally {
      await ht.close();
    }
  });
});

describe('I11 at the control boundary: pinnedControlPlane', () => {
  const run = (runId: string, runtimeManifestId: string, status: TestRun['status'] = 'running') => ({ runId, runtimeManifestId, status }) as TestRun;
  function fakeControl() {
    const calls: string[] = [];
    const control = {
      deps: {} as ControlPlane['deps'],
      async tick(runId: string) {
        calls.push(`tick ${runId}`);
        return { runId } as never;
      },
      async recover(runId: string) {
        calls.push(`recover ${runId}`);
        return { reconciled: 0, requeued: [] };
      },
      async executeTurn(workItemId: string) {
        calls.push(`executeTurn ${workItemId}`);
        return { status: 'completed', workItemId } as const;
      },
      async observeWaiting(workItemId: string) {
        calls.push(`observeWaiting ${workItemId}`);
        return { status: 'completed', workItemId } as const;
      },
      async cancelRun(runId: string) {
        calls.push(`cancelRun ${runId}`);
      },
    } as unknown as ControlPlane;
    return { control, calls };
  }
  const runs = new Map<string, TestRun>([
    ['run_here', run('run_here', 'rm_this')],
    ['run_foreign', run('run_foreign', 'rm_old')],
    ['run_foreign_done', run('run_foreign_done', 'rm_old', 'completed')],
  ]);
  const items = new Map([['wi_here', 'run_here'], ['wi_foreign', 'run_foreign'], ['wi_done', 'run_foreign_done']]);
  const lookups: string[] = [];
  const lookup = {
    getRun: async (id: string) => (lookups.push(id), runs.get(id)),
    runOf: async (id: string) => items.get(id),
  };

  test('a live run pinned to another manifest is refused (precondition_failed) before the control plane acts', async () => {
    const { control, calls } = fakeControl();
    const guarded = pinnedControlPlane(control, 'rm_this', lookup);
    const refused = (e: unknown) => {
      assert.ok(e instanceof HypertestError && e.code === 'precondition_failed');
      assert.match(e.message, /^run run_foreign is pinned to runtime manifest rm_old; this runtime is rm_this \(I11/);
      assert.deepEqual(e.details, { runId: 'run_foreign', pinnedManifestId: 'rm_old', runtimeManifestId: 'rm_this' });
      return true;
    };
    await assert.rejects(guarded.tick('run_foreign'), refused);
    await assert.rejects(guarded.recover('run_foreign'), refused);
    await assert.rejects(guarded.executeTurn('wi_foreign', 7), refused);
    await assert.rejects(guarded.observeWaiting('wi_foreign'), refused);
    assert.deepEqual(calls, [], 'nothing reached the control plane');
    // cancelling is not driving: it stays available for any run
    await guarded.cancelRun('run_foreign', 'operator');
    assert.deepEqual(calls, ['cancelRun run_foreign']);
  });

  test('own runs, finished foreign runs (read-only outcome) and unknown ids pass through; own pins are cached', async () => {
    const { control, calls } = fakeControl();
    const guarded = pinnedControlPlane(control, 'rm_this', lookup);
    lookups.length = 0;
    await guarded.tick('run_here');
    await guarded.tick('run_here');
    await guarded.executeTurn('wi_here', 1);
    await guarded.tick('run_foreign_done');
    await guarded.observeWaiting('wi_done');
    await guarded.tick('run_unknown');
    await guarded.executeTurn('wi_unknown', 1);
    assert.deepEqual(calls, ['tick run_here', 'tick run_here', 'executeTurn wi_here', 'tick run_foreign_done', 'observeWaiting wi_done', 'tick run_unknown', 'executeTurn wi_unknown']);
    assert.deepEqual(lookups, ['run_here', 'run_foreign_done', 'run_foreign_done', 'run_unknown'], 'a run pinned here is looked up once');
  });
});

describe('createHypertest: embedded store ownership and durable environments', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => (dir = await tempDir('ht-app-compose-own-')));
  after(async () => dir.cleanup());

  test('a PGlite data directory is opened by one instance at a time (a second one fails before touching it); close() releases it', async () => {
    const c = defaultConfig({ project: { dataDir: join(dir.path, 'one') } });
    const first = await createHypertest(c, { logger: new MemoryLogger() });
    const lock = lockFileFor(join(dir.path, 'one', 'db'));
    try {
      assert.equal(existsSync(lock), true);
      await assert.rejects(createHypertest(c, { logger: new MemoryLogger() }), (e: unknown) => {
        assert.ok(e instanceof HypertestError && e.code === 'precondition_failed');
        assert.match(e.message, /^PGlite data directory .*one\/db is in use: it is already open in this process/);
        return true;
      });
      // the refused instance closed nothing of the first one
      assert.deepEqual(await first.listRuns(), []);
    } finally {
      await first.close();
    }
    assert.equal(existsSync(lock), false, 'close() released the lock');
    const second = await createHypertest(c, { logger: new MemoryLogger() });
    await second.close();
  });

  test('a composition that fails after taking the store lock (corrupt environment state) releases it and closes the database', async () => {
    const dataDir = join(dir.path, 'corrupt');
    const c = defaultConfig({ project: { dataDir }, environments: [{ environmentId: 'shop', environmentClass: 'local', generation: 1 }] });
    await mkdir(join(dataDir, 'state'), { recursive: true });
    await writeFile(join(dataDir, 'state', 'environments.json'), '{"version":1,"environments":{"shop":{"generation":-4}}}');
    await assert.rejects(createHypertest(c, { logger: new MemoryLogger() }), (e: unknown) => e instanceof HypertestError && e.code === 'integrity_violation' && /environment state file .* is corrupt/.test(e.message));
    assert.equal(existsSync(lockFileFor(join(dataDir, 'db'))), false, 'the lock was released');
    await writeFile(join(dataDir, 'state', 'environments.json'), '{"version":1,"environments":{"shop":{"generation":4}}}');
    const ht = await createHypertest(c, { logger: new MemoryLogger() });
    try {
      assert.equal(ht.services.environments.get('shop')!.generation, 4);
    } finally {
      await ht.close();
    }
  });

  test('environment generation bumps survive a restart; control tokens come from control.tokenEnv and never enter the config', async () => {
    const c = defaultConfig({
      project: { dataDir: join(dir.path, 'envs') },
      environments: [{ environmentId: 'shop', environmentClass: 'local', baseUrl: 'http://127.0.0.1:8080', generation: 1, control: { kind: 'process', target: 'http://127.0.0.1:9100/__hypertest', tokenEnv: 'SHOP_SUPERVISOR_TOKEN' } }],
    });
    const env = { SHOP_SUPERVISOR_TOKEN: 'supervisor-secret-1' };
    const first = await createHypertest(c, { logger: new MemoryLogger(), env });
    try {
      const shop = first.services.environments.get('shop')!;
      assert.equal(splitControlTarget(shop.control!.target).token, 'supervisor-secret-1');
      assert.equal(JSON.stringify(first.config).includes('supervisor-secret-1'), false);
      first.services.environments.bumpGeneration('shop', 'build-2');
    } finally {
      await first.close();
    }
    const second = await createHypertest(c, { logger: new MemoryLogger(), env });
    try {
      const shop = second.services.environments.get('shop')!;
      assert.deepEqual([shop.generation, shop.buildDigest], [2, 'build-2'], 'the deploy is not forgotten: pre-deploy snapshots stay stale');
    } finally {
      await second.close();
    }
  });
});

describe('conformance-8: the RuntimeManifest identifies the code', () => {
  test('the source digest changes with any source file (content, new file) and is pinned in the manifest', async () => {
    const dir = await tempDir('ht-app-srcdigest-');
    try {
      const pkgs = join(dir.path, 'packages');
      await mkdir(join(pkgs, 'gate', 'src', 'sub'), { recursive: true });
      await mkdir(join(pkgs, 'gate', 'test'), { recursive: true });
      await writeFile(join(pkgs, 'gate', 'src', 'gate.ts'), 'export const threshold = 1;\n');
      await writeFile(join(pkgs, 'gate', 'test', 'x.test.ts'), 'test\n');
      const d1 = hypertestSourceDigest(pkgs);
      assert.match(d1, /^[0-9a-f]{64}$/);
      // another copy (the cache is per directory) with one changed byte in the gate logic
      const other = join(dir.path, 'other');
      await mkdir(join(other, 'gate', 'src', 'sub'), { recursive: true });
      await writeFile(join(other, 'gate', 'src', 'gate.ts'), 'export const threshold = 2;\n');
      assert.notEqual(hypertestSourceDigest(other), d1, 'changed code at the same version is another runtime');
      const third = join(dir.path, 'third');
      await mkdir(join(third, 'gate', 'src', 'sub'), { recursive: true });
      await writeFile(join(third, 'gate', 'src', 'gate.ts'), 'export const threshold = 1;\n');
      assert.equal(hypertestSourceDigest(third), d1, 'tests and other files outside src do not count; the same sources give the same digest');
      await writeFile(join(third, 'gate', 'src', 'sub', 'extra.ts'), 'export {};\n');
      const fourth = join(dir.path, 'fourth');
      await mkdir(join(fourth, 'gate', 'src', 'sub'), { recursive: true });
      await writeFile(join(fourth, 'gate', 'src', 'gate.ts'), 'export const threshold = 1;\n');
      await writeFile(join(fourth, 'gate', 'src', 'sub', 'extra.ts'), 'export {};\n');
      assert.notEqual(hypertestSourceDigest(fourth), d1, 'a new source file changes it');
      // the composed runtime pins this installation's digest
      const ht = await createHypertest(defaultConfig({ project: { name: 'd', dataDir: join(dir.path, 'data') }, models: { providers: [{ id: 'sim', kind: 'scripted' }], routes: [] } } as never), { scriptedBrains: { sim: () => ({ text: 'unused' }) }, logger: new MemoryLogger() });
      try {
        assert.equal(ht.manifest.hypertest.sourceDigest, hypertestSourceDigest());
        assert.match(ht.manifest.hypertest.sourceDigest!, /^[0-9a-f]{64}$/);
      } finally {
        await ht.close();
      }
    } finally {
      await dir.cleanup();
    }
  });
});

describe('conformance-12: the OPA policy revision is the content of the served policies', () => {
  test('a changed module of the decision package changes the revision; another package does not; an unlistable server is unverified', async () => {
    const { createServer } = await import('node:http');
    let modules: Array<{ id: string; raw: string }> = [
      { id: 'authz.rego', raw: 'package hypertest.authz\n\ndefault allow := false\n' },
      { id: 'other.rego', raw: 'package tenant.other\n\nallow := true\n' },
    ];
    let status = 200;
    const server = createServer((req, res) => {
      if (req.url === '/v1/policies' && status === 200) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ result: modules }));
      } else {
        res.statusCode = status === 200 ? 404 : status;
        res.end('{}');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const r1 = await opaPolicyRevision(url, 'hypertest/authz');
      assert.match(r1, /^opa:hypertest\/authz@[0-9a-f]{16}$/);
      modules = [modules[0]!, { id: 'other.rego', raw: 'package tenant.other\n\nallow := false\n' }];
      assert.equal(await opaPolicyRevision(url, 'hypertest/authz'), r1, 'another package on a shared server does not count');
      modules = [{ id: 'authz.rego', raw: 'package hypertest.authz\n\ndefault allow := true\n' }, modules[1]!];
      assert.notEqual(await opaPolicyRevision(url, 'hypertest/authz'), r1, 'a changed policy is a changed revision');
      modules = [...modules, { id: 'authz_sub.rego', raw: 'package hypertest.authz.helpers\n\nx := 1\n' }];
      const withSub = await opaPolicyRevision(url, '/hypertest/authz/');
      assert.notEqual(withSub, r1);
      status = 403;
      const logger = new MemoryLogger();
      assert.equal(await opaPolicyRevision(url, 'hypertest/authz', { logger }), 'opa:hypertest/authz@unverified');
      assert.ok(logger.entries.some((e) => e.level === 'warn'));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
