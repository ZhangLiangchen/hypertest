import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isHypertestError, sleep } from '@hypertest/core';
import { testDeps } from '@hypertest/testkit';
import { buildDockerArgs, createLocalSandbox, createOciSandbox, createWorkspaceManager, dockerCliEnv, dockerNetwork, type WorkspaceHandle } from '../src/index.ts';
import { SANDBOX, isProcessAlive, tempDir } from './helpers.ts';

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
  assert.deepEqual(Object.keys(childEnv).sort(), ['EXPLICIT', 'HOME', 'HT_TEST_ALLOWED', 'LANG', 'PATH', 'TMPDIR']);
  assert.equal(childEnv['HT_TEST_ALLOWED'], 'visible');
  assert.ok(childEnv['HOME']!.startsWith(ws.tempDir!), `HOME ${childEnv['HOME']} is a private home in the workspace temp dir`);
  assert.ok(childEnv['TMPDIR']!.startsWith(ws.tempDir!));
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
  const script = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);`;
  const r = await sb.run(ws, ['node', '-e', script], { timeoutMs: 700, signal: never() });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  const grandchild = Number(r.stdout.trim());
  assert.ok(grandchild > 0, `grandchild pid printed: ${r.stdout}`);
  await sleep(100);
  assert.equal(isProcessAlive(grandchild), false, 'grandchild was killed with the group');
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
  const script = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); c.unref(); process.exit(0);`;
  const r = await sb.run(ws, ['node', '-e', script], { timeoutMs: 10_000, signal: never() });
  assert.equal(r.exitCode, 0);
  await sleep(100);
  assert.equal(isProcessAlive(Number(r.stdout.trim())), false);
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
