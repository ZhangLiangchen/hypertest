/**
 * (row 250 / E[6] / stubs[6]) Isolation tiers on the PRODUCTION composition (createHypertest: config → isolation resolver
 * → ToolRuntime → local sandbox), PGlite or PostgreSQL 16 with HYPERTEST_TEST_DB=postgres:
 *  - `sandbox.roles.reviewer: { tier: read_only }` — the reviewer's commands see its workspace read-only (EROFS), its
 *    mutating tools refuse; another role on the same kind of workspace writes normally;
 *  - `sandbox.roles.metrics_analyst: { tier: separate, network: none, memoryMb }` — its commands have no egress to the
 *    registered environment (the executor's do) and run under the memory limit.
 * Skipped with the reason where the host has no jail strategy.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { createRootCapability } from '@hypertest/policy';
import { tempDir } from '@hypertest/testkit';
import { networkIsolation } from '@hypertest/tools';
import { createHypertest, loadCapabilitySecret, type HypertestConfig, type HypertestInstance } from '../src/index.ts';
import { roleRouter, scriptedConfig, testStore } from './helpers.ts';

describe('isolation tiers per role on the production composition', () => {
  let skip = '';
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  let server: Server;
  let port = 0;
  let ht: HypertestInstance;

  before(async () => {
    const iso = await networkIsolation();
    if (!iso.available || !iso.jail) return void (skip = `needs the jail strategy: ${iso.available ? iso.strategy : iso.reason}`);
    dir = await tempDir('ht-app-tiers-');
    db = await testStore();
    server = createServer((_q, r) => r.end('sut'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
    const base = scriptedConfig(dir.path, {
      environments: [{ environmentId: 'shop', environmentClass: 'local', baseUrl: `http://127.0.0.1:${port}`, generation: 1 }],
      sandbox: { roles: { reviewer: { tier: 'read_only' }, metrics_analyst: { tier: 'separate', network: 'none', memoryMb: 256 } } },
    } as never);
    const config: HypertestConfig = db.store ? { ...base, store: db.store } : base;
    ht = await createHypertest(config, { scriptedBrains: { sim: roleRouter({}) }, logger: new MemoryLogger() });
  });
  after(async () => {
    await ht?.close();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await db?.dispose();
    await dir?.cleanup();
  });

  test('read_only for the reviewer, separate/no-egress/memory-limited for the metrics analyst, defaults elsewhere', async (t) => {
    if (skip) return t.skip(skip);
    const run = await ht.control.startRun({ goal: 'tiers', target: {} }, { actorId: 'system:test' });
    const snapshot = await ht.control.snapshot(run.runId);
    const secret = await loadCapabilitySecret(ht.config, ht.config.project.dataDir, process.env, new MemoryLogger());
    const call = async (role: string, profile: 'test_executor' | 'test_author', toolId: string, input: unknown, workItemId: string, n: number) => {
      const workspace = await ht.services.workspaces!.scratch({ runId: run.runId, workItemId });
      // a worktree-like (non-scratch) workspace: the read-only tier is about product code
      const ws = { ...workspace, kind: 'isolated_worktree' as const };
      return ht.services.toolRuntime!.execute({
        toolId, input, invocationId: `sess_tier:${n}:c`, runId: run.runId, workItemId, agentId: `ag_${role}`, role,
        capability: createRootCapability({ runId: run.runId, subjectAgentId: `ag_${role}`, workItemId, profile, tools: [toolId], expiresAt: '2099-01-01T00:00:00.000Z' }, secret),
        workspace: ws, snapshot, eventContext: { runId: run.runId, correlationId: `c${n}`, actorId: `agent:ag_${role}`, agentId: `ag_${role}`, workItemId }, signal: new AbortController().signal,
      });
    };
    const write = ['node', '-e', "require('node:fs').writeFileSync('out.txt', 'x'); console.log('wrote')"];
    const reviewer = await call('reviewer', 'test_author', 'shell.exec', { command: write }, 'wi_rev', 1);
    assert.match(reviewer.modelText, /EROFS: read-only file system/, reviewer.modelText);
    const designer = await call('test_designer', 'test_author', 'shell.exec', { command: write }, 'wi_des', 2);
    assert.match(designer.modelText, /wrote/, 'a role without a read-only tier writes its workspace');
    const reviewerWrite = await call('reviewer', 'test_author', 'fs.write', { path: 'x.txt', content: 'x' }, 'wi_rev2', 3);
    assert.equal(reviewerWrite.error?.code, 'permission_denied', reviewerWrite.modelText);

    const get = ['node', '-e', `fetch('http://127.0.0.1:${port}/').then(async (r) => console.log('got:' + (await r.text())), (e) => console.log('blocked:' + (e.cause?.code ?? e.message)))`];
    const executor = await call('executor', 'test_executor', 'shell.exec', { command: get }, 'wi_exe', 4);
    assert.match(executor.modelText, /got:sut/, executor.modelText);
    const analyst = await call('metrics_analyst', 'test_executor', 'shell.exec', { command: get }, 'wi_met', 5);
    assert.match(analyst.modelText, /blocked:/, 'the separate tier with network none has no egress');
    const hog = await call('metrics_analyst', 'test_executor', 'shell.exec', { command: ['node', '-e', "const a=[];for(let i=0;i<40;i++)a.push(Buffer.alloc(10*1024*1024,1));console.log('hogged')"] }, 'wi_met2', 6);
    assert.doesNotMatch(hog.modelText, /hogged/, 'memoryMb 256 refuses a 400 MB allocation');
    await ht.cancel(run.runId, 'probe done');
  });
});
