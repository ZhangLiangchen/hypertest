/**
 * (row 246: ACP Agent) The Agent Client Protocol client against a fake external coding agent process
 * (fixtures/fake-acp-agent.mjs): the agent runs inside the calling workspace's sandbox, reads and writes only through the
 * client (confined to the workspace; writes only in an isolated worktree), never gets a terminal, and every permission it
 * asks for is refused; the transcript and the resulting diff are evidence; capability and policy govern the call as a
 * workspace write. Timeouts, crashes and unavailable agents fail cleanly without leaking the process.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { createGitRepo } from '@hypertest/testkit';
import { acpTools, networkIsolation, type AcpAgentConfig, type WorkspaceHandle } from '../src/index.ts';
import { capability, openToolEnv, request, runtimeFor, snapshot, type ToolEnv } from './helpers.ts';

const AGENT = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

describe('acp.<agent>.prompt', () => {
  let env: ToolEnv;
  let repo: Awaited<ReturnType<typeof createGitRepo>>;
  let ws: WorkspaceHandle;
  let readonlyWs: WorkspaceHandle;
  let skip: string | undefined;

  before(async () => {
    env = await openToolEnv();
    repo = await createGitRepo({ 'package.json': '{ "type": "module" }\n', 'src/sum.js': 'export function sum(a, b) {\n  return a + b;\n}\n' });
    ws = await env.workspaces.isolatedWorktree({ runId: 'run_tools', workItemId: 'wi_1', repoPath: repo.path });
    readonlyWs = await env.workspaces.sharedSnapshot({ runId: 'run_tools', repoPath: repo.path });
    const iso = await networkIsolation({});
    if (!iso.available) skip = `the workspace sandbox needs network namespaces: ${iso.reason}`;
  });
  after(async () => {
    await env?.dispose();
    await repo?.cleanup();
  });

  const agent = (mode: string, extra: Partial<AcpAgentConfig> = {}): AcpAgentConfig => ({ id: 'coder', command: process.execPath, args: [AGENT], env: { FAKE_ACP_MODE: mode }, timeoutMs: 20_000, ...extra });
  const tool = (cfg: AcpAgentConfig) => acpTools([cfg], { sandbox: env.sandbox, workspaces: env.workspaces })[0]!;

  test('through the ToolRuntime: a workspace write — the agent reads and writes via the client, its terminal request is refused, transcript + diff are evidence', async (t) => {
    if (skip) return t.skip(skip);
    const runtime = runtimeFor(env, [tool(agent('write'))]);
    const r = await runtime.execute(request('acp.coder.prompt', { prompt: 'Add a test for adding zero.' }, ws, { snapshot: snapshot() }));
    assert.equal(r.status, 'success', r.modelText);
    const out = r.structured as { stopReason: string; filesWritten: string[]; permissionsRefused: number; message: string };
    assert.equal(out.stopReason, 'end_turn');
    assert.deepEqual(out.filesWritten, ['test/sum.more.test.js']);
    assert.equal(out.permissionsRefused, 1);
    assert.match(out.message, /Permission to run npm test: deny/);
    const written = await readFile(join(ws.root, 'test/sum.more.test.js'), 'utf8');
    assert.match(written, /derived from export function sum\(a, b\) \{/, 'the agent read the module through the client');
    const evidence = await env.evidence.getMany(r.evidenceRefs);
    assert.deepEqual(evidence.map((e) => e.evidenceType), ['acp-transcript', 'git-diff']);
    const transcript = evidence[0]!.structured as { filesRead: string[]; toolCalls: Array<{ title: string; status: string }>; permissionsRefused: Array<{ title: string; kind: string }>; sandbox: string };
    assert.deepEqual(transcript.filesRead, ['src/sum.js']);
    assert.deepEqual(transcript.toolCalls.map((c) => [c.title, c.status]), [['Write test/sum.more.test.js', 'completed']]);
    assert.deepEqual(transcript.permissionsRefused, [{ title: 'npm test', kind: 'execute' }]);
    assert.equal(transcript.sandbox, 'workspace');
    assert.match(String(await env.artifacts.getText(evidence[1]!.artifact)), /\+\+\+ b\/test\/sum\.more\.test\.js/);
  });

  test('the agent runs in the workspace sandbox (marker set, configured variables only, nothing else of the host env)', async (t) => {
    if (skip) return t.skip(skip);
    process.env['HT_NOT_FOR_AGENTS'] = 'leak';
    try {
      const out = await tool(agent('env', { env: { FAKE_ACP_MODE: 'env', ACP_TOKEN: 'given' } })).execute({ prompt: 'env' }, (await ctxFor(ws)).ctx);
      assert.equal(out.status, 'success', JSON.stringify(out.error));
      const seen = JSON.parse((out.structured as { message: string }).message) as Record<string, string | null>;
      assert.equal(seen['sandbox'], 'local');
      assert.equal(seen['token'], 'given');
      assert.equal(seen['secretLeak'], null);
    } finally {
      delete process.env['HT_NOT_FOR_AGENTS'];
    }
  });

  test('confinement: reads outside the workspace, writes outside it, relative paths and terminals are refused', async (t) => {
    if (skip) return t.skip(skip);
    const out = await tool(agent('escape')).execute({ prompt: 'escape' }, (await ctxFor(ws)).ctx);
    assert.equal(out.status, 'success');
    const attempts = JSON.parse((out.structured as { message: string }).message) as Array<{ method: string; error: number | null }>;
    assert.deepEqual(attempts.map((a) => [a.method, a.error !== null]), [['fs/read_text_file', true], ['fs/write_text_file', true], ['fs/write_text_file', true], ['terminal/create', true]]);
    assert.equal((out.structured as { refused: string[] }).refused.length, 3);
    await assert.rejects(readFile(join(ws.root, '..', 'escape.txt')), /ENOENT/);
  });

  test('a read-only workspace: the capability lacks write_workspace there, and the client refuses writes anyway', async (t) => {
    if (skip) return t.skip(skip);
    const out = await tool(agent('write')).execute({ prompt: 'try' }, (await ctxFor(readonlyWs)).ctx);
    assert.equal(out.status, 'success');
    assert.deepEqual((out.structured as { filesWritten: string[] }).filesWritten, []);
    assert.match((out.structured as { refused: string[] }).refused[0]!, /read-only/);
    // through the runtime a role without write_workspace never starts the agent
    const runtime = runtimeFor(env, [tool(agent('write'))]);
    const denied = await runtime.execute(request('acp.coder.prompt', { prompt: 'x' }, ws, { snapshot: snapshot(), capability: capability({ profile: { name: 'ro', allowedEffects: ['read', 'record'], maxRiskClass: 'medium', resourceScopes: ['workspace/**'], environmentClasses: ['local'], credentialScopes: [] } }) }));
    assert.equal(denied.status, 'denied');
    assert.match(denied.modelText, /effect_not_permitted: write_workspace/);
  });

  test('a hung agent times out and a crashing agent fails; neither leaks its process', async (t) => {
    if (skip) return t.skip(skip);
    const hung = await tool(agent('hang', { timeoutMs: 1500 })).execute({ prompt: 'x', timeoutMs: 1500 }, (await ctxFor(ws)).ctx);
    assert.equal(hung.status, 'timeout');
    const crashed = await tool(agent('crash')).execute({ prompt: 'x' }, (await ctxFor(ws)).ctx);
    assert.equal(crashed.status, 'failed');
    assert.match(crashed.error!.message, /exited|closed/);
    const off = await tool(agent('write', { unavailableReason: 'ACP_TOKEN is not set' })).execute({ prompt: 'x' }, (await ctxFor(ws)).ctx);
    assert.equal(off.error?.code, 'unavailable');
  });

  test('(review) an agent whose protocol line never ends fails at once (bounded buffer), never buffered until the timeout', async (t) => {
    if (skip) return t.skip(skip);
    const started = Date.now();
    const flooded = await tool(agent('flood', { timeoutMs: 8000 })).execute({ prompt: 'x', timeoutMs: 8000 }, (await ctxFor(ws)).ctx);
    assert.equal(flooded.status, 'failed', JSON.stringify(flooded.error));
    assert.match(flooded.error!.message, /protocol line longer than/);
    assert.ok(Date.now() - started < 7000, 'it failed on the oversized line, not at the timeout');
  });

  async function ctxFor(workspace: WorkspaceHandle) {
    const { fakeContext } = await import('./blackbox-helpers.ts');
    const c = fakeContext();
    c.ctx.workspace = workspace;
    return c;
  }
});
