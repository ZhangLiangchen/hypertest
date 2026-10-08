/**
 * (row 250 / E[6] / stubs[6]) Isolation tiers and sandbox profile keys — every key the configuration accepts is honoured by
 * the sandbox that runs the command, or the command is refused (never accepted and ignored):
 *  - read-only workspace (`read_only` tier, shared snapshots): the jail binds the root read-only — a command can read it,
 *    never change it; where it cannot be bound (open network, no mount namespace) the command is refused;
 *  - `memoryMb` (prlimit --data: an allocation beyond it fails), `cpuLimit` (the command runs on ceil(cpuLimit) CPUs);
 *  - `allowedHosts` with `egress_allowlist`: exactly those loopback endpoints are relayed (HTTP-aware); anything else stays
 *    unreachable; allowedHosts with another network mode, a remote host, or on the OCI sandbox is refused;
 *  - the runtime applies a call's tier (role / work item resolver) to the workspace the tool runs on;
 *  - routedSandbox sends each command to the runner its profile names.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { isHypertestError } from '@hypertest/core';
import {
  builtinTools, createLocalSandbox, createOciSandbox, networkIsolation, routedSandbox, withResourceLimits, type IsolationDecision, type SandboxRunner, type WorkspaceHandle,
} from '../src/index.ts';
import { createToolRuntime, ToolRegistry } from '../src/index.ts';
import { openToolEnv, request, runtimeFor, SECRET, type ToolEnv } from './helpers.ts';

const signal = () => new AbortController().signal;

describe('sandbox tiers and profile keys', () => {
  let env: ToolEnv;
  let jail = true;
  let skip = '';
  const servers: Server[] = [];
  const ports: number[] = [];

  before(async () => {
    const iso = await networkIsolation();
    if (!iso.available || !iso.jail) {
      jail = false;
      skip = `needs the jail strategy: ${iso.available ? iso.strategy : iso.reason}`;
    }
    env = await openToolEnv();
    for (const name of ['allowed', 'other']) {
      const s = createServer((_req, res) => res.end(name));
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
      servers.push(s);
      ports.push((s.address() as { port: number }).port);
    }
  });
  after(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await env.dispose();
  });

  const scratch = async (id: string, sandbox: Partial<WorkspaceHandle['sandbox']> = {}, readOnly = false): Promise<WorkspaceHandle> => {
    const w = await env.workspaces.scratch({ runId: 'run_tools', workItemId: id });
    return { ...w, readOnly, sandbox: { kind: 'local', network: 'loopback', envAllowlist: [], ...sandbox } };
  };
  const run = (sb: SandboxRunner, ws: WorkspaceHandle, argv: string[]) => sb.run(ws, argv, { timeoutMs: 30_000, signal: signal() });

  test('read-only workspace: the jail binds the root read-only (read works, write fails), temp stays writable', async (t) => {
    if (!jail) return t.skip(skip);
    const ws = await scratch('wi_ro', {}, true);
    await writeFile(join(ws.root, 'product.txt'), 'original');
    const sb = createLocalSandbox({ killGraceMs: 300 });
    const r = await run(sb, ws, ['sh', '-c', 'cat product.txt; echo changed > product.txt; echo "write=$?"; echo tmp > "$TMPDIR/ok" && echo tmp=ok']);
    assert.match(r.stdout, /^original/);
    assert.match(r.stdout, /write=[1-9]/, 'the write was refused');
    assert.match(r.stderr, /Read-only file system/);
    assert.match(r.stdout, /tmp=ok/);
    assert.equal(await readFile(join(ws.root, 'product.txt'), 'utf8'), 'original', 'the workspace is unchanged');
    // the same workspace, writable: the command can write (the bind is the tier, not a side effect of the jail)
    const rw = await run(sb, { ...ws, readOnly: false }, ['sh', '-c', 'echo changed > product.txt']);
    assert.equal(rw.exitCode, 0, rw.stderr);
    assert.equal((await readFile(join(ws.root, 'product.txt'), 'utf8')).trim(), 'changed');
  });

  test('read-only workspace with an open network (no namespaces) is refused, never run writable', async () => {
    const ws = await scratch('wi_ro_open', { network: 'open' }, true);
    await assert.rejects(run(createLocalSandbox(), ws, ['true']), (e: unknown) => isHypertestError(e, 'precondition_failed') && /cannot bind it read-only/.test((e as Error).message));
  });

  test('memoryMb: an allocation beyond the limit fails; within it succeeds', async (t) => {
    if (!jail) return t.skip(skip);
    const alloc = (mb: number) => `const a=[];for(let i=0;i<${mb / 10};i++)a.push(Buffer.alloc(10*1024*1024,1));console.log('allocated ${mb}')`;
    const sb = createLocalSandbox({ killGraceMs: 300 });
    const small = await run(sb, await scratch('wi_mem1', { memoryMb: 256 }), ['node', '-e', alloc(300)]);
    assert.notEqual(small.exitCode, 0, 'the 300 MB allocation is refused under memoryMb 256');
    assert.doesNotMatch(small.stdout, /allocated/);
    const big = await run(sb, await scratch('wi_mem2', { memoryMb: 1024 }), ['node', '-e', alloc(300)]);
    assert.equal(big.exitCode, 0, big.stderr);
    assert.match(big.stdout, /allocated 300/);
  });

  test('cpuLimit: the command runs on ceil(cpuLimit) CPUs', async (t) => {
    if (!jail) return t.skip(skip);
    const sb = createLocalSandbox({ killGraceMs: 300 });
    const one = await run(sb, await scratch('wi_cpu1', { cpuLimit: 0.5 }), ['nproc']);
    assert.equal(one.stdout.trim(), '1', one.stderr);
    const two = await run(sb, await scratch('wi_cpu2', { cpuLimit: 1.5 }), ['nproc']);
    assert.equal(two.stdout.trim(), String(Math.min(2, Number((await run(sb, await scratch('wi_cpu0'), ['nproc'])).stdout.trim()))));
    const argv = await withResourceLimits(['x'], await scratch('wi_cpu3', { cpuLimit: 1, memoryMb: 64 }));
    assert.match(argv.join(' '), /prlimit --data=67108864 -- .*taskset -c \d+ x$/);
  });

  test('allowedHosts with egress_allowlist: exactly the listed loopback endpoint is reachable', async (t) => {
    if (!jail) return t.skip(skip);
    const get = (port: number) => `fetch('http://127.0.0.1:${port}/').then(async (r) => process.stdout.write(r.status + ':' + (await r.text())), (e) => process.stdout.write('blocked:' + (e.cause?.code ?? e.message)))`;
    const sb = createLocalSandbox({ killGraceMs: 300 });
    const ws = await scratch('wi_allow', { network: 'egress_allowlist', allowedHosts: [`127.0.0.1:${ports[0]}`] });
    assert.equal((await run(sb, ws, ['node', '-e', get(ports[0]!)])).stdout, '200:allowed');
    assert.match((await run(sb, ws, ['node', '-e', get(ports[1]!)])).stdout, /^blocked:/);
    const none = await scratch('wi_allow_none', { network: 'egress_allowlist' });
    assert.match((await run(sb, none, ['node', '-e', get(ports[0]!)])).stdout, /^blocked:/, 'without the allowlist entry nothing is relayed');
  });

  test('allowedHosts that cannot be honoured are refused: other network mode, remote host, OCI sandbox', async () => {
    const sb = createLocalSandbox();
    await assert.rejects(run(sb, await scratch('wi_bad1', { network: 'loopback', allowedHosts: ['127.0.0.1:1'] }), ['true']), (e: unknown) => isHypertestError(e, 'precondition_failed') && /applies only to network 'egress_allowlist'/.test((e as Error).message));
    await assert.rejects(run(sb, await scratch('wi_bad2', { network: 'egress_allowlist', allowedHosts: ['example.com:443'] }), ['true']), (e: unknown) => isHypertestError(e, 'precondition_failed') && /relays only loopback endpoints/.test((e as Error).message));
    const oci = createOciSandbox({ image: 'node:22', docker: '/nonexistent/docker' });
    await assert.rejects(run(oci, await scratch('wi_bad3', { kind: 'oci', network: 'egress_allowlist', allowedHosts: ['127.0.0.1:1'] }), ['true']), (e: unknown) => isHypertestError(e, 'precondition_failed') && /cannot enforce sandbox\.allowedHosts/.test((e as Error).message));
  });

  test('the runtime applies the call tier: read_only refuses workspace writes (tools and commands); separate network none cuts egress', async (t) => {
    if (!jail) return t.skip(skip);
    const decisions: Record<string, IsolationDecision> = {
      reader: { tier: 'read_only', readOnly: true, reason: 'role reader' },
      offline: { tier: 'separate', sandbox: { network: 'none' }, reason: 'role offline' },
    };
    const seen: string[] = [];
    const sandbox = createLocalSandbox({ killGraceMs: 300, egress: () => [`http://127.0.0.1:${ports[0]}`] });
    const base = runtimeFor(env, builtinTools({ sandbox, workspaces: env.workspaces }));
    const runtime = createToolRuntime({
      ...env.deps, registry: base.registry as ToolRegistry, policy: env.policy, decisionLog: env.decisionLog, artifacts: env.artifacts, evidence: env.evidence, events: env.events,
      environments: env.environments, runtimeManifestId: 'manifest_test', workerId: 'worker_test', capabilitySecret: SECRET,
      isolation: (call) => {
        seen.push(`${call.role}:${call.workItemId}`);
        return decisions[call.role];
      },
    });
    const ws = await scratch('wi_tier');
    await writeFile(join(ws.root, 'a.txt'), 'a');
    const write = await runtime.execute(request('fs.write', { path: 'b.txt', content: 'b' }, ws, { role: 'reader' }));
    assert.equal(write.error?.code, 'permission_denied', write.modelText);
    assert.match(write.error!.message, /read-only/);
    const cmd = await runtime.execute(request('shell.exec', { command: ['node', '-e', "require('node:fs').writeFileSync('a.txt', 'x')"] }, ws, { role: 'reader' }));
    assert.match(cmd.modelText, /EROFS: read-only file system/);
    assert.equal(await readFile(join(ws.root, 'a.txt'), 'utf8'), 'a');
    const fetchIt = `fetch('http://127.0.0.1:${ports[0]}/').then(async (r) => process.stdout.write('got:' + (await r.text())), (e) => process.stdout.write('blocked:' + (e.cause?.code ?? e.message)))`;
    const online = await runtime.execute(request('shell.exec', { command: ['node', '-e', fetchIt] }, ws, { role: 'executor' }));
    assert.match(online.modelText, /got:allowed/, 'no tier: the environment endpoint is relayed');
    const offline = await runtime.execute(request('shell.exec', { command: ['node', '-e', fetchIt] }, ws, { role: 'offline' }));
    assert.match(offline.modelText, /blocked:/, 'the separate tier with network none has no egress');
    assert.ok(seen.includes('reader:wi_1') && seen.includes('offline:wi_1'));
    // the caller's workspace object is never mutated by a tier
    assert.equal(ws.readOnly, false);
  });

  test('routedSandbox: a workspace profile naming oci runs on the OCI runner, everything else locally', async () => {
    const calls: string[] = [];
    const fake = (name: string): SandboxRunner => ({ kind: name as 'local', run: async () => (calls.push(name), { exitCode: 0, signal: null, stdout: name, stderr: '', durationMs: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false }) });
    const sb = routedSandbox({ local: fake('local'), oci: fake('oci') });
    await run(sb, await scratch('wi_route1'), ['x']);
    await run(sb, await scratch('wi_route2', { kind: 'oci', image: 'node:22' }), ['x']);
    assert.deepEqual(calls, ['local', 'oci']);
  });
});
