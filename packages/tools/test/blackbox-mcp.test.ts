import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isHypertestError } from '@hypertest/core';
import { McpToolBridge, ToolRegistry, blackboxTools, closeBlackboxResources, mcpToolId, sanitizeMcpSegment, type McpServerConfig, type ToolSpec } from '../src/index.ts';
import { fakeContext, newRuntime, openBlackboxEnv, toolRequest, waitFor, type BlackboxEnv } from './blackbox-helpers.ts';

const SERVER = fileURLToPath(new URL('./blackbox-mcp-server.mjs', import.meta.url));
const calc = (extra: Partial<McpServerConfig> = {}): McpServerConfig => ({ name: 'calc', command: process.execPath, args: [SERVER], environmentClass: 'sandbox', timeoutMs: 20_000, ...extra });

let env: BlackboxEnv;
const bridges: McpToolBridge[] = [];
const bridge = (servers: McpServerConfig[]) => {
  const b = new McpToolBridge({ servers });
  bridges.push(b);
  return b;
};

before(async () => {
  env = await openBlackboxEnv();
});

after(async () => {
  for (const b of bridges) await b.close();
  await closeBlackboxResources();
  await env.dispose();
});

test('listTools exposes MCP tools as mcp.<server>.<tool> specs with sanitized ids and the server input schema', async () => {
  const b = bridge([calc()]);
  const specs = await b.listTools();
  const weird = mcpToolId('calc', 'weird.name/with spaces');
  assert.match(weird, /^mcp\.calc\.weird_name_with_spaces-[0-9a-f]{6}$/);
  assert.deepEqual(specs.map((s) => s.id), ['mcp.calc.add', 'mcp.calc.divide', weird]);
  const add = specs[0]!;
  assert.deepEqual(add.inputSchema, { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false });
  assert.equal(add.description, 'Add two numbers');
  assert.equal(add.effect, 'external');
  assert.equal(add.riskClass, 'medium');
  assert.deepEqual(add.resources({}, { workspace: undefined as never, runId: 'r', environments: env.environments }), ['mcp/calc/add']);
  const registry = new ToolRegistry(specs); // ids and schemas are valid registry entries
  assert.equal(registry.list().length, 3);
  assert.deepEqual(b.connectedServers, ['calc']);
});

test('execute: text content joined, structuredContent kept, isError ⇒ failed (through the ToolRuntime)', async () => {
  const b = bridge([calc()]);
  const runtime = newRuntime(env, await b.listTools());
  const sum = await runtime.execute(toolRequest('mcp.calc.add', { a: 2, b: 3 }));
  assert.equal(sum.status, 'success', sum.modelText);
  // (E[5]) every MCP call records mcp-response evidence; the runtime names it in the model text
  assert.match(sum.modelText, /^5\n\[evidence: ev_\w+\]$/);
  assert.equal(sum.evidenceRefs.length, 1);
  const [rec] = await env.evidence.getMany(sum.evidenceRefs);
  assert.equal(rec!.evidenceType, 'mcp-response');
  assert.deepEqual((rec!.structured as { server: string; tool: string; arguments: unknown; isError: boolean }).arguments, { a: 2, b: 3 });
  assert.deepEqual(sum.structured, { sum: 5 });
  const div = await runtime.execute(toolRequest('mcp.calc.divide', { a: 1, b: 0 }));
  assert.equal(div.status, 'failed');
  assert.equal(div.error?.code, 'mcp_tool_error');
  assert.equal(div.error?.message, 'division by zero');
  const bad = await runtime.execute(toolRequest('mcp.calc.add', { a: 'two', b: 3 }));
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error?.code, 'schema_violation', 'the MCP input schema is enforced before the call');
  const { ctx } = fakeContext();
  const weird = (await b.listTools()).find((s) => s.id.startsWith('mcp.calc.weird'))!;
  const echoed = await weird.execute({ x: 1 }, ctx);
  assert.equal(echoed.status, 'success');
  assert.match(echoed.text!, /^\{"x":1\}\npid=\d+$/);
});

test('allowTools restricts the exposed tools; an unconfigured environment class leaves external MCP tools to the policy (denied by default)', async () => {
  const { environmentClass: _unset, ...noClass } = calc({ allowTools: ['add'] });
  const b = bridge([noClass]);
  const specs = await b.listTools();
  assert.deepEqual(specs.map((s) => s.id), ['mcp.calc.add']);
  const runtime = newRuntime(env, specs);
  const denied = await runtime.execute(toolRequest('mcp.calc.add', { a: 1, b: 1 }));
  assert.equal(denied.status, 'denied');
  assert.equal(denied.error?.code, 'permission_denied');
});

test('lazy tools from blackboxTools({mcpServers}) connect on first use; servers without allowTools are rejected', async () => {
  const specs = blackboxTools({ stateDir: '/nonexistent', mcpServers: [calc({ allowTools: ['add'] })] }).filter((s) => s.id.startsWith('mcp.'));
  assert.deepEqual(specs.map((s) => s.id), ['mcp.calc.add']);
  assert.deepEqual(specs[0]!.inputSchema, { type: 'object' });
  const { ctx } = fakeContext();
  const out = await (specs[0] as ToolSpec).execute({ a: 3, b: 4 }, ctx);
  assert.equal(out.status, 'success');
  assert.equal(out.text, '7');
  assert.throws(() => blackboxTools({ stateDir: '/x', mcpServers: [calc()] }), (e: unknown) => isHypertestError(e, 'invalid_argument') && /allowTools/.test(e.message));
});

test('a server that cannot start is unavailable; close() terminates the server process', async () => {
  const broken = bridge([{ name: 'nope', command: '/nonexistent/mcp-server' }]);
  await assert.rejects(broken.connect(), (e: unknown) => isHypertestError(e, 'unavailable') && /nope could not be started/.test(e.message));
  const b = bridge([calc()]);
  const specs = await b.listTools();
  const { ctx } = fakeContext();
  const echoed = await specs.find((s) => s.id.startsWith('mcp.calc.weird'))!.execute({}, ctx);
  const pid = Number(/pid=(\d+)/.exec(echoed.text!)![1]);
  process.kill(pid, 0);
  await b.close();
  const deadline = Date.now() + 5000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 20));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'the MCP server process exited');
  assert.deepEqual(b.connectedServers, []);
  assert.throws(() => new McpToolBridge({ servers: [calc(), calc()] }), /duplicate MCP server name/);
  assert.equal(sanitizeMcpSegment('a'.repeat(40)).length, 24);
  assert.notEqual(sanitizeMcpSegment('a'.repeat(40)), sanitizeMcpSegment('a'.repeat(41)), 'truncated names stay distinct');
});

test('connections are per server: a server that cannot start does not take down the tools of the others', async () => {
  const b = bridge([{ name: 'nope', command: '/nonexistent/mcp-server', allowTools: ['x'] }, calc({ allowTools: ['add'] })]);
  const specs = new Map(b.lazyTools().map((s) => [s.id, s]));
  const { ctx } = fakeContext();
  const add = await specs.get('mcp.calc.add')!.execute({ a: 20, b: 22 }, ctx);
  assert.equal(add.status, 'success', JSON.stringify(add.error));
  assert.equal(add.text, '42');
  const broken = await specs.get('mcp.nope.x')!.execute({}, ctx);
  assert.equal(broken.status, 'failed');
  assert.equal(broken.error?.code, 'unavailable');
  assert.match(broken.error!.message, /nope could not be started/);
  assert.deepEqual(b.connectedServers, ['calc']);
  await assert.rejects(b.connect(), /nope could not be started/, 'connect() still reports the broken server');
});

test('a server whose process exits is dropped and reconnected on the next call', async () => {
  const b = bridge([calc({ allowTools: ['weird.name/with spaces'] })]);
  const [weird] = b.lazyTools();
  const { ctx } = fakeContext();
  const first = await weird!.execute({}, ctx);
  const pid1 = Number(/pid=(\d+)/.exec(first.text!)![1]);
  process.kill(pid1, 'SIGKILL');
  await waitFor(() => b.connectedServers.length === 0, 5000, 20, 'connection drop');
  const second = await weird!.execute({}, ctx);
  assert.equal(second.status, 'success', JSON.stringify(second.error));
  const pid2 = Number(/pid=(\d+)/.exec(second.text!)![1]);
  assert.notEqual(pid2, pid1, 'a fresh server process answered');
});

test('one caller aborting during the shared connect does not fail the other callers', async () => {
  const b = bridge([calc({ allowTools: ['add'] })]);
  const [add] = b.lazyTools();
  const abort = new AbortController();
  const a = fakeContext({ signal: abort.signal });
  const c = fakeContext();
  const pa = add!.execute({ a: 1, b: 1 }, a.ctx);
  const pc = add!.execute({ a: 2, b: 2 }, c.ctx);
  setTimeout(() => abort.abort(), 5);
  await assert.rejects(pa);
  const out = await pc;
  assert.equal(out.status, 'success', JSON.stringify(out.error));
  assert.equal(out.text, '4');
});
