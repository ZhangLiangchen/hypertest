// A fake external coding agent speaking the Agent Client Protocol (JSON-RPC 2.0, newline-delimited, over stdio) for the
// ACP client tests. Behaviour by FAKE_ACP_MODE:
//   write   (default) reads src/sum.js through the client, writes test/sum.more.test.js, asks permission to run a
//           terminal command (the client must refuse), streams messages and tool calls, ends the turn
//   escape  tries to read /etc/passwd and to write outside the session cwd (the client must refuse every attempt)
//   env     reports what it can see of its environment (sandbox marker, configured variables)
//   hang    never answers the prompt (timeouts / cancellation)
//   crash   exits while the prompt is being processed
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_ACP_MODE ?? 'write';
let nextId = 1000;
const pending = new Map();
let cwd = '/';

function send(msg) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
}
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}
function update(sessionId, update) {
  send({ method: 'session/update', params: { sessionId, update } });
}
const say = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

async function prompt(id, params) {
  const sessionId = params.sessionId;
  if (mode === 'hang') return;
  if (mode === 'crash') process.exit(3);
  if (mode === 'env') {
    say(sessionId, JSON.stringify({ sandbox: process.env.HYPERTEST_SANDBOX ?? null, token: process.env.ACP_TOKEN ?? null, home: process.env.HOME ?? null, secretLeak: process.env.HT_NOT_FOR_AGENTS ?? null }));
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  if (mode === 'escape') {
    const attempts = [
      ['fs/read_text_file', { sessionId, path: '/etc/passwd' }],
      ['fs/write_text_file', { sessionId, path: `${cwd}/../escape.txt`, content: 'x' }],
      ['fs/write_text_file', { sessionId, path: 'relative.txt', content: 'x' }],
      ['terminal/create', { sessionId, command: 'sh', args: ['-c', 'id'] }],
    ];
    const results = [];
    for (const [method, p] of attempts) results.push({ method, ...(await request(method, p)) });
    say(sessionId, JSON.stringify(results.map((r) => ({ method: r.method, error: r.error?.code ?? null }))));
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  say(sessionId, 'Looking at src/sum.js. ');
  update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'read the module', priority: 'high', status: 'completed' }, { content: 'add a test', priority: 'high', status: 'in_progress' }] });
  const read = await request('fs/read_text_file', { sessionId, path: `${cwd}/src/sum.js` });
  const source = read.result?.content ?? '';
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write test/sum.more.test.js', kind: 'edit', status: 'in_progress' });
  const test = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../src/sum.js';\n\n// derived from ${source.split('\n')[0]}\ntest('adds zero', () => {\n  assert.equal(sum(4, 0), 4);\n});\n`;
  const wrote = await request('fs/write_text_file', { sessionId, path: `${cwd}/test/sum.more.test.js`, content: test });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: wrote.error ? 'failed' : 'completed' });
  const perm = await request('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 't2', title: 'npm test', kind: 'execute' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
  });
  say(sessionId, `Wrote the test${wrote.error ? ` (failed: ${wrote.error.message})` : ''}. Permission to run npm test: ${perm.result?.outcome?.optionId ?? perm.result?.outcome?.outcome}.`);
  send({ id, result: { stopReason: 'end_turn' } });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve?.(msg);
    return;
  }
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
  if (msg.method === 'session/new') {
    cwd = msg.params.cwd;
    return send({ id: msg.id, result: { sessionId: 'sess-1' } });
  }
  if (msg.method === 'session/prompt') return void prompt(msg.id, msg.params);
  if (msg.method === 'session/cancel') process.exit(0);
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
});
