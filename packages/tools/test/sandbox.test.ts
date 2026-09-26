import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isHypertestError, sleep } from '@hypertest/core';
import { testDeps } from '@hypertest/testkit';
import { SANDBOX_MARKER_ENV, argumentPathDenial, buildDockerArgs, createLocalSandbox, createOciSandbox, createWorkspaceManager, dockerCliEnv, dockerNetwork, loopbackEndpoints, networkIsolation, probeNetworkIsolation, type WorkspaceHandle } from '../src/index.ts';
import { SANDBOX, isProcessAlive, liveProcessesWithMarker, tempDir } from './helpers.ts';

let base: Awaited<ReturnType<typeof tempDir>>;
let ws: WorkspaceHandle;
const never = () => new AbortController().signal;

before(async () => {
  base = await tempDir('ht-sandbox-');
  const wm = createWorkspaceManager({ ...testDeps(), baseDir: base.path, defaultSandbox: { ...SANDBOX, envAllowlist: ['HT_TEST_ALLOWED'] } });
  ws = await wm.scratch({ runId: 'run_sb', workItemId: 'wi_1' });
});
after(async () => {
  delete process.env['HT_TEST_PARENT_SECRET'];
  delete process.env['HT_TEST_ALLOWED'];
  await base.cleanup();
});

test('env scrubbing: only allowlisted variables + PATH/HOME/LANG/TMPDIR reach the child; parent secrets never do', async () => {
  process.env['HT_TEST_PARENT_SECRET'] = 'do-not-leak-4711';
  process.env['HT_TEST_ALLOWED'] = 'visible';
  const sb = createLocalSandbox();
  const r = await sb.run(ws, ['node', '-e', 'process.stdout.write(JSON.stringify(process.env))'], { timeoutMs: 10_000, signal: never(), env: { EXPLICIT: '1' } });
  assert.equal(r.exitCode, 0, r.stderr);
  const childEnv = JSON.parse(r.stdout) as Record<string, string>;
  assert.equal(childEnv['HT_TEST_PARENT_SECRET'], undefined);
  assert.doesNotMatch(r.stdout, /do-not-leak-4711/);
  assert.deepEqual(Object.keys(childEnv).sort(), ['EXPLICIT', 'HOME', 'HT_TEST_ALLOWED', 'HYPERTEST_SANDBOX', 'LANG', 'PATH', 'TMPDIR']);
  assert.equal(childEnv['HYPERTEST_SANDBOX'], 'local');
  assert.equal(childEnv['HT_TEST_ALLOWED'], 'visible');
  assert.ok(childEnv['HOME']!.startsWith(ws.tempDir!), `HOME ${childEnv['HOME']} is a private home in the workspace temp dir`);
  assert.ok(childEnv['TMPDIR']!.startsWith(ws.tempDir!));
});

test('H1: every sandboxed process carries HYPERTEST_SANDBOX=<kind>; neither the allowlist nor the caller env can drop or spoof it', async () => {
  process.env['HYPERTEST_SANDBOX'] = 'parent-value';
  try {
    const wm = createWorkspaceManager({ ...testDeps(), baseDir: base.path, defaultSandbox: { ...SANDBOX, envAllowlist: ['HYPERTEST_SANDBOX'] } });
    const allowing = await wm.scratch({ runId: 'run_sb', workItemId: 'wi_marker' });
    const sb = createLocalSandbox();
    const r = await sb.run(allowing, ['node', '-e', 'process.stdout.write(String(process.env.HYPERTEST_SANDBOX))'], { timeoutMs: 10_000, signal: never(), env: { HYPERTEST_SANDBOX: '' } });
    assert.equal(r.stdout, 'local');
  } finally {
    delete process.env['HYPERTEST_SANDBOX'];
  }
  assert.equal(SANDBOX_MARKER_ENV, 'HYPERTEST_SANDBOX');
});

// ------------------------------------------------------------------------------------------------ network (security-2)

/** A loopback HTTP server of the HOST (stands in for the SUT's control endpoint, a database, any host service). */
async function hostServer(): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
  const { createServer } = await import('node:http');
  let hits = 0;
  const server = createServer((_q, s) => {
    hits++;
    s.end('host-secret');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, hits: () => hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Node program: fetch the host server, report what happened. */
const FETCH_HOST = (port: number) => `fetch('http://127.0.0.1:${port}/').then(async (r) => process.stdout.write('reached:' + (await r.text())), (e) => process.stdout.write('blocked:' + (e.cause?.code ?? e.message)))`;

test('security-2: a sandboxed command with network none/loopback reaches no host service and no interface but its own loopback', async (t) => {
  const iso = await networkIsolation();
  if (!iso.available) {
    t.skip(`network namespaces unavailable on this host: ${iso.reason} (the fail-closed test covers this case)`);
    return;
  }
  const host = await hostServer();
  try {
    for (const network of ['none', 'loopback', 'egress_allowlist'] as const) {
      const wm = createWorkspaceManager({ ...testDeps(), baseDir: base.path, defaultSandbox: { kind: 'local', network, envAllowlist: [] } });
      const w = await wm.scratch({ runId: 'run_sb', workItemId: `wi_net_${network}` });
      const sb = createLocalSandbox();
      const r = await sb.run(w, ['node', '-e', FETCH_HOST(host.port)], { timeoutMs: 15_000, signal: never() });
      assert.equal(r.exitCode, 0, r.stderr);
      assert.match(r.stdout, /^blocked:/, `${network}: the host's loopback service must be unreachable (got ${r.stdout})`);
      const ifs = await sb.run(w, ['node', '-e', 'process.stdout.write(JSON.stringify(Object.keys(require("node:os").networkInterfaces())))'], { timeoutMs: 15_000, signal: never() });
      assert.ok((JSON.parse(ifs.stdout) as string[]).every((i) => i === 'lo'), `${network}: only the namespace's loopback is visible (${ifs.stdout})`);
      // the command keeps the caller's identity (no namespace root)
      const id = await sb.run(w, ['node', '-e', 'process.stdout.write(String(process.getuid()))'], { timeoutMs: 15_000, signal: never() });
      if (iso.strategy !== 'userns_root') assert.equal(id.stdout, String(process.getuid!()));
    }
    assert.equal(host.hits(), 0, 'no sandboxed request reached the host service');
    if (iso.loopback) {
      // a test that serves and calls its own loopback still works inside the namespace
      const w = await createWorkspaceManager({ ...testDeps(), baseDir: base.path, defaultSandbox: { kind: 'local', network: 'loopback', envAllowlist: [] } }).scratch({ runId: 'run_sb', workItemId: 'wi_net_self' });
      const self = "const s=require('node:http').createServer((q,r)=>r.end('self')).listen(0,'127.0.0.1',async()=>{const t=await (await fetch('http://127.0.0.1:'+s.address().port)).text();process.stdout.write(t);s.close()})";
      const r = await createLocalSandbox().run(w, ['node', '-e', self], { timeoutMs: 15_000, signal: never() });
      assert.equal(r.stdout, 'self', r.stderr);
    }
    // an explicitly open profile is not isolated (the explicit, audited opt-out)
    const open = await createWorkspaceManager({ ...testDeps(), baseDir: base.path, defaultSandbox: { kind: 'local', network: 'open', envAllowlist: [] } }).scratch({ runId: 'run_sb', workItemId: 'wi_net_open' });
    const r = await createLocalSandbox().run(open, ['node', '-e', FETCH_HOST(host.port)], { timeoutMs: 15_000, signal: never() });
    assert.equal(r.stdout, 'reached:host-secret');
    assert.equal(host.hits(), 1);
  } finally {
    await host.close();
  }
});

test('security-2: only the allowlisted loopback endpoints (the SUT) are relayed into the namespace; `none` gets none', async (t) => {
  const iso = await networkIsolation();
  if (!iso.available || !iso.jail) {
    t.skip(`allowlisted egress needs the jail strategy: ${iso.available ? iso.strategy : iso.reason}`);
    return;
  }
  const sut = await hostServer();
  const other = await hostServer();
  try {
    const sb = createLocalSandbox({ egress: () => [`http://127.0.0.1:${sut.port}`, 'https://example.com', `http://localhost:${sut.port}/api`] });
    const wsOf = async (network: 'loopback' | 'none', id: string) =>
      createWorkspaceManager({ ...testDeps(), baseDir: base.path, defaultSandbox: { kind: 'local', network, envAllowlist: [] } }).scratch({ runId: 'run_sb', workItemId: id });
    const loop = await wsOf('loopback', 'wi_egress_loop');
    const both = `Promise.all([${[sut.port, other.port].map((p) => `fetch('http://127.0.0.1:${p}/').then(async (r) => 'reached:' + (await r.text()), (e) => 'blocked:' + (e.cause?.code ?? e.message))`).join(', ')}]).then((r) => process.stdout.write(JSON.stringify(r)))`;
    const r = await sb.run(loop, ['node', '-e', both], { timeoutMs: 15_000, signal: never() });
    assert.equal(r.exitCode, 0, r.stderr);
    const [toSut, toOther] = JSON.parse(r.stdout) as string[];
    assert.equal(toSut, 'reached:host-secret', 'the allowlisted SUT endpoint is reachable (a black-box regression test works)');
    assert.match(toOther!, /^blocked:/, 'any other host service is not');
    // `localhost` resolves inside the namespace to the relayed endpoint too
    const byName = await sb.run(loop, ['node', '-e', `fetch('http://localhost:${sut.port}/').then(async (r) => process.stdout.write(await r.text()), (e) => process.stdout.write('blocked:' + (e.cause?.code ?? e.message)))`], { timeoutMs: 15_000, signal: never() });
    assert.equal(byName.stdout, 'host-secret');
    const none = await wsOf('none', 'wi_egress_none');
    const n = await sb.run(none, ['node', '-e', FETCH_HOST(sut.port)], { timeoutMs: 15_000, signal: never() });
    assert.match(n.stdout, /^blocked:/, 'network none relays nothing');
    assert.equal(other.hits(), 0);
    assert.deepEqual(loopbackEndpoints(['http://127.0.0.1:81', 'https://localhost', 'http://[::1]:9', 'http://10.0.0.5:80', 'ftp://127.0.0.1:21', 'nonsense']), [
      { bind: '127.0.0.1', host: '127.0.0.1', port: 81 },
      { bind: '127.0.0.1', host: '127.0.0.1', port: 443 },
      { bind: '::1', host: '::1', port: 443 },
      { bind: '::1', host: '::1', port: 9 },
    ]);
  } finally {
    await sut.close();
    await other.close();
  }
});

test('security-2: without network namespaces the local sandbox refuses every profile but an open network (fail closed, never a silent downgrade)', async () => {
  const sb = createLocalSandbox({ networkIsolation: { unshare: 'definitely-not-unshare-xyz' } });
  const refused = await sb.run(ws, ['node', '-e', 'process.stdout.write("ran")'], { timeoutMs: 10_000, signal: never() }).then(
    () => assert.fail('an isolated profile ran without isolation'),
    (e: unknown) => e,
  );
  assert.ok(isHypertestError(refused, 'precondition_failed'), String(refused));
  assert.match((refused as Error).message, /cannot enforce network 'none'.*definitely-not-unshare-xyz.*OCI sandbox.*'open'/s);
  for (const network of ['loopback', 'egress_allowlist'] as const) {
    const w: WorkspaceHandle = { ...ws, sandbox: { kind: 'local', network, envAllowlist: [] } };
    await assert.rejects(sb.run(w, ['node', '-e', '1'], { timeoutMs: 10_000, signal: never() }), (e) => isHypertestError(e, 'precondition_failed'), network);
  }
  const open: WorkspaceHandle = { ...ws, sandbox: { kind: 'local', network: 'open', envAllowlist: [] } };
  assert.equal((await sb.run(open, ['node', '-e', 'process.stdout.write("ran")'], { timeoutMs: 10_000, signal: never() })).stdout, 'ran');
  const unavailable = await probeNetworkIsolation({ unshare: 'definitely-not-unshare-xyz' });
  assert.deepEqual(unavailable, { available: false, reason: "util-linux 'definitely-not-unshare-xyz' was not found on PATH" });
});

test('H1: the jail hides the Hypertest process, the configured secret paths and every other workspace; the command cannot undo it', async (t) => {
  const iso = await networkIsolation();
  if (!iso.available || !iso.jail) {
    t.skip(`the jail strategy (PID + mount namespaces, python3 helper) is unavailable here: ${iso.available ? iso.strategy : iso.reason}`);
    return;
  }
  const root = await tempDir('ht-jail-');
  try {
    const dataDir = join(root.path, 'data');
    const keys = join(dataDir, 'keys');
    const workspacesDir = join(dataDir, 'workspaces');
    await mkdir(keys, { recursive: true });
    await writeFile(join(keys, 'capability.secret'), 'CAPABILITY-SECRET-4711');
    await writeFile(join(dataDir, 'db.file'), 'STORE-BYTES');
    const wm = createWorkspaceManager({ ...testDeps(), baseDir: workspacesDir, defaultSandbox: { kind: 'local', network: 'loopback', envAllowlist: [] } });
    const mine = await wm.scratch({ runId: 'run_jail', workItemId: 'wi_mine' });
    const other = await wm.scratch({ runId: 'run_jail', workItemId: 'wi_other' });
    await writeFile(join(other.root, 'victim.txt'), 'other agent');
    const sb = createLocalSandbox({ hiddenPaths: [keys, join(dataDir, 'db.file')], workspacesDir });
    const js = (code: string) => sb.run(mine, ['node', '-e', code], { timeoutMs: 15_000, signal: never() });
    const tryRead = (p: string) => `(() => { try { return require('node:fs').readFileSync(${JSON.stringify(p)}, 'utf8'); } catch (e) { return 'ERR:' + e.code; } })()`;
    // the Hypertest process (and its environment, its view of the host file system) is not in the command's /proc
    const procs = await js(`process.stdout.write(JSON.stringify({ pid: process.pid, host: require('node:fs').existsSync('/proc/${process.pid}'), all: require('node:fs').readdirSync('/proc').filter((e) => /^\\d+$/.test(e)).length }))`);
    const seen = JSON.parse(procs.stdout) as { pid: number; host: boolean; all: number };
    assert.ok(seen.pid <= 2 && !seen.host && seen.all <= 3, procs.stdout);
    // secret paths are empty/unreadable; another workspace is invisible; the own workspace works
    const secrets = await js(`process.stdout.write(JSON.stringify([${tryRead(join(keys, 'capability.secret'))}, ${tryRead(join(dataDir, 'db.file'))}, ${tryRead(join(other.root, 'victim.txt'))}]))`);
    const [secret, store, victim] = JSON.parse(secrets.stdout) as string[];
    assert.match(secret!, /^ERR:(ENOENT|EACCES)$/, 'the hidden directory is an empty, inaccessible tmpfs (EACCES unless root)');
    assert.equal(store, '', 'a hidden file reads as /dev/null');
    assert.equal(victim, 'ERR:ENOENT', 'another workspace does not exist for the command');
    const write = await js(`const fs = require('node:fs'); fs.writeFileSync('own.txt', 'mine'); fs.writeFileSync(process.env.TMPDIR + '/t', 'tmp'); let sib = 'written'; try { fs.writeFileSync(${JSON.stringify(join(other.root, 'victim.txt'))}, 'pwned'); } catch (e) { sib = e.code; } process.stdout.write(sib)`);
    assert.equal(write.exitCode, 0, write.stderr);
    assert.match(write.stdout, /^E(ROFS|NOENT|ACCES)$/);
    assert.equal(await readFile(join(mine.root, 'own.txt'), 'utf8'), 'mine');
    assert.equal(await readFile(join(other.root, 'victim.txt'), 'utf8'), 'other agent', 'the other workspace was not touched');
    // the mounts are locked: not even a namespace of the command's own can remove them
    const undo = await sb.run(mine, ['unshare', '--user', '--map-root-user', '--mount', 'sh', '-c', `umount ${keys} 2>/dev/null; umount -l ${keys} 2>/dev/null; cat ${join(keys, 'capability.secret')}`], { timeoutMs: 15_000, signal: never() });
    assert.doesNotMatch(undo.stdout, /CAPABILITY-SECRET/);
    // the command keeps the caller's identity; exit codes and terminating signals are reported as without the jail
    assert.equal((await js('process.stdout.write(String(process.getuid()))')).stdout, String(process.getuid!()));
    assert.equal((await js('process.exit(3)')).exitCode, 3);
    const killed = await js("process.kill(process.pid, 'SIGKILL')");
    assert.deepEqual([killed.exitCode, killed.signal], [null, 'SIGKILL']);
    // a hidden path that contains the workspace is a configuration error
    const wrong = createLocalSandbox({ hiddenPaths: [dataDir] });
    await assert.rejects(wrong.run(mine, ['node', '-e', '1'], { timeoutMs: 5000, signal: never() }), (e) => isHypertestError(e, 'precondition_failed') && /contains workspace path/.test(e.message));
  } finally {
    await root.cleanup();
  }
});

test('cwd is confined to the workspace root; argv is never interpreted by a shell', async () => {
  const sb = createLocalSandbox();
  await assert.rejects(sb.run(ws, ['ls'], { cwd: '..', timeoutMs: 5000, signal: never() }), (e) => isHypertestError(e, 'permission_denied'));
  await assert.rejects(sb.run(ws, ['ls'], { cwd: '/tmp', timeoutMs: 5000, signal: never() }), (e) => isHypertestError(e, 'permission_denied'));
  const r = await sb.run(ws, ['node', '-e', 'console.log(process.argv[1])', '$(echo pwned); rm -rf /'], { timeoutMs: 5000, signal: never() });
  assert.equal(r.stdout, '$(echo pwned); rm -rf /\n');
  const pwd = await sb.run(ws, ['node', '-e', 'process.stdout.write(process.cwd())'], { timeoutMs: 5000, signal: never() });
  assert.equal(pwd.stdout, ws.root);
});

test('timeout kills the whole process group (grandchildren included) and reports timedOut', async () => {
  const sb = createLocalSandbox({ killGraceMs: 300 });
  // the grandchild is found by a marker in its command line: inside the sandbox's PID namespace its pid is local
  const marker = `ht-grandchild-${process.pid}-${Date.now()}`;
  const script = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000) // ${marker}'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);`;
  const running = sb.run(ws, ['node', '-e', script], { timeoutMs: 1500, signal: never() });
  let seen: number[] = [];
  for (let i = 0; i < 100 && seen.length === 0; i++) {
    await sleep(10);
    seen = liveProcessesWithMarker(marker);
  }
  const r = await running;
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  const grandchild = Number(r.stdout.trim());
  assert.ok(grandchild > 0, `grandchild pid printed: ${r.stdout}`);
  assert.equal(seen.length, 1, 'the grandchild was running');
  await sleep(100);
  assert.equal(isProcessAlive(seen[0]!), false, 'grandchild was killed with the group');
  assert.deepEqual(liveProcessesWithMarker(marker), []);
});

test('SIGTERM-ignoring processes are SIGKILLed after the grace period', async () => {
  const sb = createLocalSandbox({ killGraceMs: 300 });
  const started = Date.now();
  const r = await sb.run(ws, ['node', '-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], { timeoutMs: 400, signal: never() });
  assert.equal(r.timedOut, true);
  assert.equal(r.signal, 'SIGKILL');
  assert.ok(Date.now() - started >= 650, 'waited timeout + grace before SIGKILL');
});

test('background children left behind by a finished command are reaped', async () => {
  const sb = createLocalSandbox();
  const marker = `ht-background-${process.pid}-${Date.now()}`;
  // the child reports its host-visible existence through a file before its parent exits
  const script = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000) // ${marker}'], { stdio: 'ignore' }); console.log(c.pid); c.unref(); setTimeout(() => process.exit(0), 300);`;
  const running = sb.run(ws, ['node', '-e', script], { timeoutMs: 10_000, signal: never() });
  let seen: number[] = [];
  for (let i = 0; i < 100 && seen.length === 0; i++) {
    await sleep(5);
    seen = liveProcessesWithMarker(marker);
  }
  const r = await running;
  assert.equal(r.exitCode, 0);
  assert.equal(seen.length, 1, 'the background child was running');
  await sleep(100);
  assert.equal(isProcessAlive(seen[0]!), false);
  assert.deepEqual(liveProcessesWithMarker(marker), []);
});

test('abort signal terminates the process and rejects with the abort reason', async () => {
  const sb = createLocalSandbox({ killGraceMs: 200 });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new Error('stop now')), 150);
  const started = Date.now();
  await assert.rejects(sb.run(ws, ['node', '-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30_000, signal: ctrl.signal }), (e) => isHypertestError(e, 'cancelled') && /stop now/.test(e.message));
  assert.ok(Date.now() - started < 5000);
});

test('stdout/stderr are captured up to maxOutputBytes with truncation flags; stdin is supported', async () => {
  const sb = createLocalSandbox();
  const r = await sb.run(ws, ['node', '-e', "process.stdout.write('a'.repeat(100000)); process.stderr.write('e'.repeat(50))"], { timeoutMs: 10_000, signal: never(), maxOutputBytes: 1000 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'a'.repeat(1000));
  assert.equal(r.stdoutTruncated, true);
  assert.equal(r.stderr, 'e'.repeat(50));
  assert.equal(r.stderrTruncated, false);
  const echo = await sb.run(ws, ['node', '-e', 'process.stdin.pipe(process.stdout)'], { timeoutMs: 10_000, signal: never(), stdin: 'hello stdin' });
  assert.equal(echo.stdout, 'hello stdin');
  const missing = await sb.run(ws, ['definitely-not-a-program-xyz'], { timeoutMs: 5000, signal: never() });
  assert.equal(missing.exitCode, 127);
  assert.equal(missing.spawnError, 'ENOENT');
  await assert.rejects(sb.run(ws, [], { timeoutMs: 1000, signal: never() }), (e) => isHypertestError(e, 'invalid_argument'));
});

test('OCI: docker argv mounts the root (read-only when required), drops privileges, maps networks fail-closed', () => {
  const roWs: WorkspaceHandle = { ...ws, readOnly: true, sandbox: { kind: 'oci', network: 'egress_allowlist', allowedHosts: ['example.com'], envAllowlist: [], cpuLimit: 1.5, memoryMb: 512 } };
  const argv = buildDockerArgs({ docker: 'docker', image: 'node:22', name: 'ht-x', ws: roWs, cwdRel: 'sub/dir', env: { B: '2', A: '1' }, user: '1000:1000', command: ['node', '-v'], interactive: false });
  assert.deepEqual(argv, [
    'docker', 'run', '--rm', '--name', 'ht-x', '--network', 'none',
    '-v', `${ws.root}:/workspace:ro`, '-v', `${ws.tempDir}:${ws.tempDir}`,
    '-w', '/workspace/sub/dir', '--user', '1000:1000', '--cpus', '1.5', '--memory', '512m',
    '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
    '--env', 'A', '--env', 'B', 'node:22', 'node', '-v',
  ]);
  assert.equal(argv.some((a) => a.includes('=1') || a.includes('=2')), false, 'env values never appear in argv');
  assert.equal(dockerNetwork({ ...SANDBOX, network: 'open' }), 'bridge');
  assert.equal(dockerNetwork({ ...SANDBOX, network: 'loopback' }), 'none');
  assert.throws(() => createOciSandbox({ image: '' }), (e) => isHypertestError(e, 'invalid_argument'));
});

test('the local sandbox refuses a workspace whose profile requires OCI isolation (no silent downgrade)', async () => {
  const sb = createLocalSandbox();
  const ociWs: WorkspaceHandle = { ...ws, sandbox: { kind: 'oci', image: 'node:22-alpine', network: 'none', envAllowlist: [] } };
  const marker = `${ws.tempDir}/ran-on-host`;
  await assert.rejects(sb.run(ociWs, ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { timeoutMs: 5000, signal: never() }), (e) => isHypertestError(e, 'precondition_failed'));
  assert.equal(existsSync(marker), false, 'nothing ran on the host');
});

test('OCI: the docker CLI keeps its own configuration; only DOCKER_* settings and container values by name', () => {
  const parent = { PATH: '/usr/bin:/bin', HOME: '/home/op', DOCKER_HOST: 'unix:///run/user/1000/docker.sock', DOCKER_CONTEXT: 'rootless', DATABASE_URL: 'postgres://secret', AWS_SECRET_ACCESS_KEY: 'k' };
  const cli = dockerCliEnv({ HOME: '/ws/tmp/home', TMPDIR: '/ws/tmp/tmp', LANG: 'C.UTF-8', DOCKER_HOST: 'tcp://attacker:2375', FOO: '1' }, parent);
  assert.deepEqual(cli, {
    HOME: '/ws/tmp/home', TMPDIR: '/ws/tmp/tmp', LANG: 'C.UTF-8', FOO: '1',
    PATH: '/usr/bin:/bin', DOCKER_CONFIG: '/home/op/.docker', DOCKER_HOST: 'unix:///run/user/1000/docker.sock', DOCKER_CONTEXT: 'rootless',
  });
  assert.equal(dockerCliEnv({}, { ...parent, DOCKER_CONFIG: '/etc/docker-cfg' })['DOCKER_CONFIG'], '/etc/docker-cfg');
  assert.deepEqual(Object.keys(dockerCliEnv({}, parent)).sort(), ['DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'HOME', 'PATH']);
});

test('a host process that exits mid-run takes its sandboxed process groups with it (nothing outlives it)', async () => {
  const dir = ws.tempDir!;
  const pidFile = join(dir, 'exit-hook-pids');
  const hostFile = join(dir, 'host.mjs');
  const processModule = pathToFileURL(fileURLToPath(new URL('../src/whitebox/process.ts', import.meta.url))).href;
  const child = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + c.pid); setInterval(() => {}, 1000);`;
  await writeFile(hostFile, [
    "import { existsSync } from 'node:fs';",
    `import { spawnProcess } from ${JSON.stringify(processModule)};`,
    `spawnProcess({ argv: [process.execPath, '-e', ${JSON.stringify(child)}], cwd: ${JSON.stringify(dir)}, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 60000, signal: new AbortController().signal }).catch(() => {});`,
    // exit while the sandboxed command (and its grandchild) is still running
    `const t = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(t); process.exit(0); } }, 20);`,
  ].join('\n'));
  const r = spawnSync(process.execPath, [hostFile], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const [childPid, grandchildPid] = (await readFile(pidFile, 'utf8')).split(' ').map(Number);
  assert.ok(childPid! > 0 && grandchildPid! > 0);
  await sleep(200);
  assert.equal(isProcessAlive(childPid!), false, 'the sandboxed command died with its host');
  assert.equal(isProcessAlive(grandchildPid!), false, 'so did its grandchild');
});

const oci = createOciSandbox({ image: 'node:22-alpine' });
const ociAvailable = await oci.available!();
test('OCI: runs a command in a container', { skip: ociAvailable ? false : 'docker daemon unavailable (docker info failed); OCI sandbox execution cannot be exercised here' }, async () => {
  const r = await oci.run(ws, ['node', '-e', 'console.log(process.cwd())'], { timeoutMs: 120_000, signal: never() });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout.trim(), '/workspace');
});

// ------------------------------------------------------------------------------------ security-H1a: argument confinement

test('H1a: argumentPathDenial refuses argv that reads or writes outside the workspace (absolute, .., symlink, file://)', async () => {
  const outside = await tempDir('ht-argv-outside-');
  const sibling = await tempDir('ht-argv-sibling-');
  try {
    await writeFile(join(outside.path, 'capability.secret'), 'hmac-secret-xyz');
    await writeFile(join(ws.root, 'in.txt'), 'inside');
    const { symlink, mkdir } = await import('node:fs/promises');
    await symlink(join(outside.path, 'capability.secret'), join(ws.root, 'leak'));
    await mkdir(join(ws.root, 'sub'), { recursive: true });
    const deny = async (argv: string[], cwd = ws.root) => {
      const why = await argumentPathDenial(ws, cwd, argv);
      assert.ok(why, `expected a denial for ${JSON.stringify(argv)}`);
      return why;
    };
    // a relative path from a sub directory stays inside
    assert.equal(await argumentPathDenial(ws, join(ws.root, 'sub'), ['cat', '../in.txt']), undefined);
    // the PoC: cat <absolute path outside the root>, sed writing into a sibling worktree
    assert.match(await deny(['cat', join(outside.path, 'capability.secret')]), /existing path outside the workspace/);
    assert.match(await deny(['sed', '-n', `w ../${sibling.path.split('/').pop()}/pwned.txt`, 'in.txt']), /climbs out of the workspace/);
    assert.match(await deny(['sed', '-n', `w ${join(sibling.path, 'pwned.txt')}`, 'in.txt']), /outside the workspace/);
    await deny(['ls', '..']);
    await deny(['cat', 'sub/../../x']);
    await deny(['node', '-e', `require('fs').readFileSync(${JSON.stringify(join(outside.path, 'capability.secret'))})`]);
    await deny(['node', '-e', "require('fs').writeFileSync('/etc/hypertest-pwned', 'x')"]);
    await deny(['python3', '-c', `open("${outside.path}/capability.secret").read()`]);
    await deny(['grep', '-r', 'secret', '/']);
    await deny(['npm', `--prefix=${outside.path}`, 'install']);
    await deny(['node', `--require=${outside.path}/x.js`]);
    await deny(['cat', `file://${outside.path}/capability.secret`]);
    await deny(['node', 'x.js', `PATH=/usr/bin:${outside.path}`]);
    assert.match(await deny(['cat', 'leak']), /symlink/);
  } finally {
    await outside.cleanup();
    await sibling.cleanup();
  }
});

test('H1a: argumentPathDenial keeps ordinary commands working (scripts, regexes, git ranges, URLs, the private temp dir)', async () => {
  await writeFile(join(ws.root, 'robust.test.js'), 'assert.deepEqual(seen, items);\n');
  const allow = async (argv: string[]) => assert.equal(await argumentPathDenial(ws, ws.root, argv), undefined, JSON.stringify(argv));
  await allow(['sed', '-i', 's/assert.deepEqual(seen, items);/assert.ok(seen.length > 0);/', 'robust.test.js']);
  await allow(['sed', '/^#/d', 'robust.test.js']);
  await allow(['sed', '-n', '1,/^$/p', 'robust.test.js']);
  await allow(['awk', '/assert/ { print $1 }', 'robust.test.js']);
  await allow(['grep', '-rn', '/api/v1/transfer', '.']);
  await allow(['git', 'log', '--oneline', 'HEAD~3..HEAD']);
  await allow(['git', 'diff', 'main...feature']);
  await allow(['node', '--input-type=module', '-e', 'const { paginate } = await import("./src/ledger.js"); console.log(paginate([1], 1, 1));']);
  await allow(['node', '--input-type=module', '-e', 'const r = await fetch("http://127.0.0.1:4010/transfer", { method: "POST", headers: { "content-type": "application/json" } }); console.log(r.status);']);
  await allow(['diff', '/dev/null', 'robust.test.js']);
  await allow(['cat', join(ws.root, 'robust.test.js')]);
  await allow(['node', '-e', `require('fs').writeFileSync(${JSON.stringify(join(ws.tempDir!, 'tmp', 'scratch.txt'))}, 'x')`]);
  await allow(['node', '-e', 'process.stdout.write("x")']);
  await allow(['cat', 'does-not-exist-yet.txt']);
});
