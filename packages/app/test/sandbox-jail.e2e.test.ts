/**
 * H1 / security-2 on the product path: a command an agent runs through `shell.exec` (default configuration: local
 * sandbox, `network: loopback`) computes paths at run time — which argument confinement cannot see — and still cannot
 * read the capability secret or signing keys, see the Hypertest process (its environment holds API keys), or reach a
 * host service. Skips with the reason when this host cannot provide the jail.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { networkIsolation } from '@hypertest/tools';
import { createHypertest, sandboxEgressOrigins, sandboxHiddenPaths, defaultConfig, type HypertestConfig } from '../src/index.ts';
import { call, roleRouter, scriptedConfig, sumRepo, testStore, tinyRunBrains } from './helpers.ts';

let dir: Awaited<ReturnType<typeof tempDir>>;
let repo: Awaited<ReturnType<typeof sumRepo>>;
let db: Awaited<ReturnType<typeof testStore>>;
before(async () => {
  dir = await tempDir('ht-app-jail-');
  repo = await sumRepo();
  db = await testStore();
});
after(async () => {
  await db.dispose();
  await repo.cleanup();
  await dir.cleanup();
});

test('sandboxHiddenPaths: keys, state, the embedded store and the artifacts; never a path holding the workspaces', () => {
  const data = join(dir.path, 'hp');
  const config = defaultConfig({ project: { name: 'hp', dataDir: data } });
  assert.deepEqual(sandboxHiddenPaths(config, data, join(data, 'state')), [join(data, 'keys'), join(data, 'state'), join(data, 'db'), join(data, 'artifacts')]);
  const logger = new MemoryLogger();
  const odd = { ...config, store: { kind: 'pglite' as const, dataDir: data } };
  assert.deepEqual(sandboxHiddenPaths(odd, data, join(data, 'state'), logger), [join(data, 'keys'), join(data, 'state'), join(data, 'artifacts')]);
  assert.ok(logger.entries.some((e) => e.level === 'warn' && /cannot be hidden/.test(e.msg)), 'the skipped path is reported');
});

test('sandboxEgressOrigins: the registered environments and the URL entries of the http allowlist, nothing else', () => {
  const envs = { list: () => [{ environmentId: 'a', environmentClass: 'local', baseUrl: 'http://127.0.0.1:8080', generation: 1 }, { environmentId: 'b', environmentClass: 'staging', generation: 1 }] } as never;
  assert.deepEqual(sandboxEgressOrigins(envs, ['http://127.0.0.1:9090', '*.example.com', 'api.example.com']), ['http://127.0.0.1:8080', 'http://127.0.0.1:9090']);
  assert.deepEqual(sandboxEgressOrigins(envs, undefined), ['http://127.0.0.1:8080']);
});

test('H1: an agent command computing paths at run time reads no secret, sees no Hypertest process and reaches no host service', async (t) => {
  const iso = await networkIsolation();
  if (!iso.available || !iso.jail) {
    t.skip(`the local sandbox jail is unavailable on this host: ${iso.available ? `strategy ${iso.strategy} has no PID/mount namespaces` : iso.reason}`);
    return;
  }
  let hostHits = 0;
  const host = createServer((_q, s) => {
    hostHits++;
    s.end('host');
  });
  await new Promise<void>((r) => host.listen(0, '127.0.0.1', () => r()));
  const port = (host.address() as { port: number }).port;
  const dataDir = join(dir.path, 'data');
  // the probe decodes every path at run time: argumentPathDenial sees only an opaque token
  const probe = Buffer.from(
    [
      "const fs = require('node:fs');",
      `const keys = ${JSON.stringify(join(dataDir, 'keys'))};`,
      "const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return 'ERR:' + e.code; } };",
      "const list = (p) => { try { return fs.readdirSync(p); } catch (e) { return 'ERR:' + e.code; } };",
      `const hostPid = ${process.pid};`,
      "const out = { keys: list(keys), secret: read(keys + '/capability.secret'), hostProc: fs.existsSync('/proc/' + hostPid), environ: read('/proc/' + hostPid + '/environ').slice(0, 40), root: list('/proc/' + hostPid + '/root') };",
      `fetch('http://127.0.0.1:${port}/').then(() => 'reached', (e) => 'blocked').then((net) => { out.net = net; process.stdout.write('PROBE' + JSON.stringify(out) + 'PROBE'); });`,
    ].join('\n'),
  ).toString('base64');
  const brains = tinyRunBrains();
  const executor = brains['executor']!;
  let observed = '';
  brains['executor'] = (v) => {
    if (v.step === 0) return call('shell.exec', { command: ['node', '-e', `eval(Buffer.from('${probe}', 'base64').toString())`] });
    if (v.step === 1) {
      observed = v.toolResults[0]!.content;
      return executor({ ...v, step: 0, toolResults: [] });
    }
    return executor({ ...v, step: v.step - 1, toolResults: v.toolResults.slice(1) });
  };
  const c: HypertestConfig = { ...scriptedConfig(dataDir, { gate: { requireIndependentReview: false } }), ...(db.store ? { store: db.store } : {}) };
  const ht = await createHypertest(c, { scriptedBrains: { sim: roleRouter(brains) }, logger: new MemoryLogger(), env: { ...process.env, HT_JAIL_ENV_SECRET: 'env-secret-4711' } });
  try {
    const outcome = await ht.run({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 90_000 });
    assert.equal(outcome.status, 'completed');
    const m = /PROBE(.*?)PROBE/s.exec(observed);
    assert.ok(m, `the probe ran: ${observed.slice(0, 500)}`);
    const seen = JSON.parse(m[1]!.replace(/\\"/g, '"')) as Record<string, unknown>;
    assert.match(String(seen['keys']), /^ERR:(ENOENT|EACCES)$|^$/, `keys directory hidden: ${JSON.stringify(seen['keys'])}`);
    assert.match(String(seen['secret']), /^ERR:(ENOENT|EACCES)$/);
    assert.equal(seen['hostProc'], false, 'the Hypertest process is not in the command\'s /proc');
    assert.match(String(seen['environ']), /^ERR:/);
    assert.match(String(seen['root']), /^ERR:/);
    assert.equal(seen['net'], 'blocked');
    assert.equal(hostHits, 0);
    assert.doesNotMatch(observed, /env-secret-4711/);
  } finally {
    await ht.close();
    await new Promise<void>((r) => host.close(() => r()));
  }
});
