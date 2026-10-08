/**
 * (E[5]) The MCP bridge as the production composition configures it: per-tool classification (`toolEffects`), servers
 * bound to a registered environment (`env/<id>` resources, the environment's class, evidence anchored to it), the operator
 * grant of unbound servers (`mcp/<server>/**` for `grantTo`), the streamable HTTP transport (a real SDK server in a child
 * process, its bearer header) and fail-closed unavailability (a missing `*Env` variable: nothing is spawned).
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_MCP_GRANT, McpToolBridge, createEnvironmentRegistry, type McpServerConfig } from '../src/index.ts';
import { fakeContext, newRuntime, openBlackboxEnv, tempDir, toolRequest, type BlackboxEnv } from './blackbox-helpers.ts';

const SERVER = fileURLToPath(new URL('./mcp-tickets-server.mjs', import.meta.url));
const TOKEN = 'mcp-unit-token-31';

describe('MCP bridge configuration', () => {
  let env: BlackboxEnv;
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let http: ChildProcess;
  let httpUrl: string;
  const bridges: McpToolBridge[] = [];
  const bridge = (servers: McpServerConfig[]) => {
    const b = new McpToolBridge({ servers });
    bridges.push(b);
    return b;
  };

  before(async () => {
    dir = await tempDir('ht-mcp-config-');
    env = await openBlackboxEnv({ environments: [{ environmentId: 'tracker-env', environmentClass: 'sandbox', generation: 4 }] });
    http = spawn(process.execPath, [SERVER, '--http', '0'], { env: { ...process.env, TICKETS_FILE: join(dir.path, 'http.jsonl'), TICKETS_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'inherit'] });
    httpUrl = await new Promise<string>((resolve, reject) => {
      let buf = '';
      http.stdout!.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        const line = buf.split('\n').find((l) => l.startsWith('{'));
        if (line) resolve((JSON.parse(line) as { url: string }).url);
      });
      http.once('exit', (code) => reject(new Error(`fixture exited ${code}`)));
    });
  });
  after(async () => {
    for (const b of bridges) await b.close();
    http?.kill('SIGTERM');
    await env.dispose();
    await dir.cleanup();
  });

  test('classification per tool, environment binding and the operator grant', () => {
    const [create, list] = bridge([{ name: 'tickets', command: process.execPath, args: [SERVER], allowTools: ['create_ticket', 'list_tickets'], toolEffects: { list_tickets: { effect: 'read', riskClass: 'low' } }, environmentId: 'tracker-env' }]).lazyTools();
    assert.deepEqual([create!.effect, create!.riskClass, list!.effect, list!.riskClass], ['external', 'medium', 'read', 'low']);
    const ctx = { workspace: undefined as never, runId: 'r', environments: env.environments };
    assert.deepEqual(create!.resources({}, ctx), ['env/tracker-env']);
    assert.equal(create!.environmentClass!({}, { environments: env.environments }), 'sandbox');
    assert.equal(create!.grant, undefined, 'an environment-bound server is covered by env/** grants');
    assert.deepEqual(create!.evidenceTypes, ['mcp-response']);
    const [unbound] = bridge([{ name: 'tracker', url: 'http://127.0.0.1:1/mcp', allowTools: ['list_tickets'], grantTo: ['environment_operator'] }]).lazyTools();
    assert.deepEqual(unbound!.resources({}, ctx), ['mcp/tracker/list_tickets']);
    assert.deepEqual(unbound!.grant, { scopes: ['mcp/tracker/**'], profiles: ['environment_operator'] });
    const [byDefault] = bridge([{ name: 'other', command: 'x', allowTools: ['t'] }]).lazyTools();
    assert.deepEqual(byDefault!.grant!.profiles, [...DEFAULT_MCP_GRANT]);
  });

  test('a server needs exactly one transport', () => {
    assert.throws(() => new McpToolBridge({ servers: [{ name: 'both', command: 'x', url: 'http://h/mcp' }] }), /exactly one of command/);
    assert.throws(() => new McpToolBridge({ servers: [{ name: 'none' }] }), /exactly one of command/);
  });

  test('streamable HTTP transport: the configured bearer header authenticates; the call records mcp-response evidence', async () => {
    const authed = bridge([{ name: 'tracker', url: httpUrl, headers: { authorization: `Bearer ${TOKEN}` }, allowTools: ['create_ticket', 'list_tickets'], effect: 'read', riskClass: 'low' }]);
    const runtime = newRuntime(env, authed.lazyTools());
    const r = await runtime.execute(toolRequest('mcp.tracker.list_tickets', {}));
    assert.equal(r.status, 'success', r.modelText);
    assert.deepEqual(r.structured, { count: 0, tickets: [] });
    const [ev] = await env.evidence.getMany(r.evidenceRefs);
    assert.equal((ev!.structured as { transport: string }).transport, 'http');
    // failure path: without the header the server refuses (an MCP tool error, a failed call — never a silent success)
    const anonymous = bridge([{ name: 'anon', url: httpUrl, allowTools: ['list_tickets'], effect: 'read', riskClass: 'low' }]);
    const denied = await newRuntime(env, anonymous.lazyTools()).execute(toolRequest('mcp.anon.list_tickets', {}));
    assert.equal(denied.status, 'failed');
    assert.equal(denied.error?.code, 'mcp_tool_error');
    assert.match(denied.error!.message, /unauthenticated/);
  });

  test('fail closed: a server marked unavailable is never started; calls fail unavailable with the reason', async () => {
    const off = bridge([{ name: 'tickets', command: process.execPath, args: [SERVER], allowTools: ['list_tickets'], effect: 'read', unavailableReason: 'the variable(s) TICKETS_TOKEN it is configured with are not set' }]);
    const [spec] = off.lazyTools();
    const out = await spec!.execute({}, fakeContext({ environments: createEnvironmentRegistry() }).ctx);
    assert.equal(out.status, 'failed');
    assert.equal(out.error?.code, 'unavailable');
    assert.match(out.error!.message, /TICKETS_TOKEN/);
    assert.deepEqual(off.connectedServers, []);
  });

  test('evidence of a bound server names its environment; secret-named arguments are redacted', async () => {
    const b = bridge([{ name: 'tickets', command: process.execPath, args: [SERVER], env: { TICKETS_FILE: join(dir.path, 'stdio.jsonl'), TICKETS_TOKEN: TOKEN }, allowTools: ['create_ticket'], environmentId: 'tracker-env', timeoutMs: 20_000 }]);
    const [spec] = b.lazyTools();
    const { ctx, evidence } = fakeContext({ environments: env.environments });
    const out = await spec!.execute({ title: 'x', apiToken: 'should-not-be-recorded' }, ctx);
    assert.equal(out.status, 'success', JSON.stringify(out.error));
    assert.equal(evidence[0]!.input.environment?.environmentId, 'tracker-env');
    assert.equal(evidence[0]!.input.environment?.generation, 4);
    assert.equal(JSON.stringify(evidence[0]!.input.structured).includes('should-not-be-recorded'), false);
  });
});
