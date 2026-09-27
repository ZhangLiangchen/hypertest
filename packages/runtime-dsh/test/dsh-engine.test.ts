import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { FixedClock, MemoryLogger, SequentialIdGenerator, isHypertestError, type JsonValue, type SqlDatabase } from '@hypertest/core';
import { InMemoryEventSink, type ChatMessage, type ToolCall, type ToolDefinition } from '@hypertest/domain';
import {
  EngineRegistry, FakeContextProvider, FakeDispatcher, FakeModelInvoker, NativeEngine, PARALLEL_TOOL_CONCURRENCY, TEXT_ONLY_NUDGE, completeWorkTool, createSessionStore, engineContractSuite,
  fakeHost, runtimeMigrations,
  type DispatchResult, type EngineHost, type EngineSessionRef, type ModelInvoker, type SessionStore, type ToolDispatcher, type TurnLimits,
} from '@hypertest/runtime';
import { createTestDatabase } from '@hypertest/store';
import { DSH_AGENT_VERSION, DSH_ENGINE_KIND, DSH_PINS, DshEngine, RUNTIME_DSH_PACKAGE_VERSION, SUPPORTED_DSH_VERSION } from '../src/index.ts';
import { assertSupportedDsh, installedDshVersions } from '../src/version.ts';

// The shared AgentEngine contract (every engine must pass it).
engineContractSuite('dsh', (deps) => new DshEngine(deps), { openDatabase: (migrations) => createTestDatabase({ migrations }) });

const LIMITS: TurnLimits = { maxToolCallsPerTurn: 16, repetitionThreshold: 3 };

interface Trace {
  turn: number;
  streamRequests: number;
  steps: number;
  events: string[];
  dshErrors: string[];
}

describe('DshEngine specifics', () => {
  let db: SqlDatabase;
  let dispose: () => Promise<void>;
  let sessions: SessionStore;
  let events: InMemoryEventSink;
  let logger: MemoryLogger;
  let engine: DshEngine;
  let native: NativeEngine;
  let ids: SequentialIdGenerator;
  let n = 0;

  before(async () => {
    ({ db, dispose } = await createTestDatabase({ migrations: runtimeMigrations }));
    events = new InMemoryEventSink();
    logger = new MemoryLogger();
    ids = new SequentialIdGenerator();
    const deps = { db, ids, clock: new FixedClock('2026-05-01T00:00:00.000Z'), logger, events };
    sessions = createSessionStore(deps);
    engine = new DshEngine({ ...deps, sessions });
    // Same ports (one id sequence): the reference engine for parity checks.
    native = new NativeEngine({ ...deps, sessions });
  });
  after(async () => {
    await engine.close();
    await dispose();
  });

  async function session(initial: ChatMessage[] = [{ role: 'user', content: 'go' }]): Promise<EngineSessionRef> {
    n += 1;
    return engine.createSession({ runId: `run_d${n}`, agentId: `agent_d${n}`, initialMessages: initial });
  }
  function host(model: FakeModelInvoker, tools: ToolDispatcher, extra: Partial<EngineHost> = {}): EngineHost {
    return { ...fakeHost({ sessions, model, tools, events, eventContext: { runId: `run_d${n}`, correlationId: 'corr', actorId: 'system:test' } }), ...extra };
  }
  const run = (ref: EngineSessionRef, h: EngineHost, extra: { limits?: TurnLimits; signal?: AbortSignal; input?: ChatMessage[] } = {}) => {
    const req: Parameters<DshEngine['runTurn']>[0] = { session: ref, host: h, limits: extra.limits ?? LIMITS, signal: extra.signal ?? new AbortController().signal };
    if (extra.input) req.input = extra.input;
    return engine.runTurn(req);
  };
  const traces = (ref: EngineSessionRef): Trace[] =>
    logger.entries.filter((e) => e.msg === 'dsh turn trace' && e.fields['sessionId'] === ref.sessionId).map((e) => e.fields as unknown as Trace);
  const warnings = (ref: EngineSessionRef): string[] => logger.entries.filter((e) => e.level === 'warn' && e.fields['sessionId'] === ref.sessionId).map((e) => e.msg);
  const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 2));
  };

  test('identity: kind dsh, version = the pinned dsh-agent (0.1.0-rc.6), honest capabilities', () => {
    const installed = JSON.parse(readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-agent/package.json')), 'utf8')) as { version: string };
    const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; dependencies: Record<string, string> };
    assert.equal(engine.kind, 'dsh');
    assert.equal(engine.kind, DSH_ENGINE_KIND);
    assert.equal(engine.version, installed.version);
    assert.equal(engine.version, DSH_AGENT_VERSION);
    assert.equal(engine.version, own.dependencies['@deepseek-ai/dsh-agent'], 'the installed dsh-agent is the pinned one');
    assert.equal(engine.version, '0.1.0-rc.6');
    assert.equal(engine.adapterVersion, own.version);
    assert.equal(engine.adapterVersion, RUNTIME_DSH_PACKAGE_VERSION);
    assert.deepEqual(engine.capabilities, {
      providerSwitch: true,
      continuableChild: true,
      backgroundChild: false,
      peerMessaging: true,
      structuredOutput: true,
      sandboxProfiles: false,
      nativeCompaction: false,
      nativeComputerUse: false,
    });
    assert.throws(() => new DshEngine({} as never), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  });

  test('pin + adapter: every @deepseek-ai dependency is an exact pin, installed as pinned; any drift is refused (fail closed)', () => {
    const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    const pinned = Object.fromEntries(Object.entries(own.dependencies).filter(([name]) => name.startsWith('@deepseek-ai/')));
    assert.deepEqual(DSH_PINS, pinned, 'DSH_PINS is exactly the package.json @deepseek-ai pins');
    for (const [name, version] of Object.entries(pinned)) assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/, `${name} is an exact version, not a range`);
    assert.equal(SUPPORTED_DSH_VERSION, '0.1.0-rc.6');
    assert.ok(Object.entries(DSH_PINS).filter(([name]) => name.startsWith('@deepseek-ai/dsh-')).every(([, v]) => v === SUPPORTED_DSH_VERSION), 'one DSH release train');
    assert.deepEqual(installedDshVersions(), { ...DSH_PINS }, 'the installed train is the pinned one');
    assert.doesNotThrow(() => assertSupportedDsh(installedDshVersions()));
    // Closure: every @deepseek-ai package a pinned one loads (dependency or required peer — both often declared as RANGES,
    // e.g. schemastery ^3.18.1, cosmokit ~1.8.5) is pinned too, so no loaded @deepseek-ai code can drift unnoticed.
    for (const name of Object.keys(DSH_PINS)) {
      const pkg = JSON.parse(readFileSync(new URL(import.meta.resolve(`${name}/package.json`)), 'utf8')) as {
        dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      };
      const loaded = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}).filter((p) => pkg.peerDependenciesMeta?.[p]?.optional !== true)];
      for (const dep of loaded.filter((d) => d.startsWith('@deepseek-ai/'))) assert.ok(dep in DSH_PINS, `${name} loads ${dep}, which is not pinned`);
    }
    const drift = (name: string, version: string | undefined) => ({ ...DSH_PINS, [name]: version });
    for (const [name, version] of [
      ['@deepseek-ai/dsh-agent-loop', '0.1.0-rc.8'],
      ['@deepseek-ai/dsh-tools', '0.1.7-rc.2'],
      ['@deepseek-ai/dsh-llm', '^0.1.0-rc.6'],
      ['@deepseek-ai/cordis', '4.0.3'],
      ['@deepseek-ai/schemastery', '3.19.0'],
      ['@deepseek-ai/cosmokit', '1.8.6'],
      ['@deepseek-ai/dsh-session', undefined],
    ] as const) {
      assert.throws(
        () => assertSupportedDsh(drift(name, version)),
        (e: unknown) => isHypertestError(e, 'precondition_failed') && JSON.stringify(e.details['drifted']) === JSON.stringify([{ name, pinned: DSH_PINS[name], installed: version ?? null }]),
        `${name} ${String(version)} is refused`,
      );
    }
  });

  test('I11: a run pinned to another DSH version is refused; the pinned version is served', () => {
    const registry = new EngineRegistry([engine, new NativeEngine({ sessions, ids: new SequentialIdGenerator(), clock: new FixedClock('2026-05-01T00:00:00.000Z'), logger })]);
    assert.deepEqual(registry.manifestEntries().find((e) => e.kind === 'dsh'), { kind: 'dsh', version: '0.1.0-rc.6' });
    assert.throws(() => registry.assertPinned({ manifestId: 'rm_old', agentEngines: [{ kind: 'dsh', version: '0.1.0-rc.3' }] }, 'dsh'), (e: unknown) => isHypertestError(e, 'precondition_failed'));
    assert.equal(registry.assertPinned({ manifestId: 'rm_now', agentEngines: [{ kind: 'dsh', version: engine.version }] }, 'dsh'), engine);
  });

  test('one Hypertest turn = one DSH turn of one step: DSH runs the tool loop, the host model is invoked exactly once per turn', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'read', parallelSafe: true, handler: () => ({ content: 'R' }) }, { name: 'write', handler: () => ({ content: 'W' }) }, completeWorkTool()]);
    const model = new FakeModelInvoker([
      { text: 'probing', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }, { id: 'c2', name: 'write', arguments: { path: 'b' } }] },
      { text: 'thinking about it' },
      { toolCalls: [{ id: 'd1', name: 'complete_work', arguments: { summary: 'done' } }] },
    ]);
    const h = host(model, tools);
    const statuses: string[] = [];
    for (let i = 1; i <= 3; i++) {
      statuses.push((await run(ref, h)).status);
      assert.equal(model.callCount, i, `exactly one host model call after turn ${i}`);
    }
    assert.deepEqual(statuses, ['continue', 'continue', 'completed']);
    assert.deepEqual(model.requests.map((r) => r.turn), [1, 2, 3]);

    const t = traces(ref);
    assert.deepEqual(t.map((x) => [x.turn, x.streamRequests, x.steps]), [[1, 1, 1], [2, 1, 1], [3, 1, 1]], 'DSH asked for exactly one response and entered exactly one step per turn');
    // turn 1: the response streamed through DSH's chunk protocol, DSH's scheduler executed both calls, then a second
    // step was proposed and rejected (the turn closes `blocked`); a text-only turn closes `completed` by itself
    assert.deepEqual(t[0]!.events, [
      'session/end-seed', 'agent/inbox/spliced', 'turn/start', 'agent/inbox/spliced', 'step/start', 'user/message', 'request/header', 'request/context',
      // text block (start, delta, end) + 2 tool-call blocks (start, delta, end) + finish
      'assistant/chunk×10', 'assistant/message',
      // the parallel-safe read, then the exclusive write alone (DSH's scheduler; results committed in call order)
      'tool/call:c1', 'tool/result:c1', 'tool/call:c2', 'tool/result:c2',
      'step/end', 'turn/end:blocked',
    ]);
    assert.equal(t[1]!.events.at(-1), 'turn/end:completed');
    assert.equal(t[1]!.events.some((e) => e.startsWith('tool/')), false, 'a text-only turn executes nothing');
    assert.deepEqual(tools.calls.map((c) => [c.name, c.invocationId]), [
      ['read', `${ref.sessionId}:1:c1`],
      ['write', `${ref.sessionId}:1:c2`],
      ['complete_work', `${ref.sessionId}:3:d1`],
    ]);
    assert.deepEqual(warnings(ref), [], 'DSH never asked for a second response and its view of every turn matched the recorded one');
    assert.equal(await engine.liveDshSessions(), 0, 'every turn disposed its DSH agent');
  });

  test('replay goes through DSH with the recorded response: no model call, only the unsettled call is dispatched', async () => {
    const ref = await session();
    const crashing = new FakeDispatcher([{ name: 'a', handler: () => ({ content: 'A' }) }, { name: 'b', handler: () => { throw new Error('worker died'); } }]);
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'k1', name: 'a', arguments: {} }, { id: 'k2', name: 'b', arguments: {} }] }]);
    await assert.rejects(run(ref, host(model, crashing)), /worker died/);
    assert.equal((await sessions.getTurn(ref.sessionId, 1))?.status, 'model_responded');

    const noModel = new FakeModelInvoker([]);
    const healthy = new FakeDispatcher([{ name: 'a' }, { name: 'b', handler: () => ({ content: 'B' }) }]);
    const r = await run(ref, host(noModel, healthy));
    assert.equal(r.replayed, true);
    assert.equal(noModel.callCount, 0);
    assert.deepEqual(r.usage, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    assert.deepEqual(healthy.calls.map((c) => [c.toolCallId, c.invocationId]), [['k2', `${ref.sessionId}:1:k2`]]);
    assert.deepEqual(r.toolResults.map((x) => x.message.content), ['A', 'B']);
    const replay = traces(ref).at(-1)!;
    assert.equal(replay.streamRequests, 1, 'the host route served the recorded response');
    assert.deepEqual(replay.events.filter((e) => e.startsWith('tool/result')), ['tool/result:k1', 'tool/result:k2'], 'DSH executed both; the settled one answered from the record');
    assert.deepEqual(warnings(ref), []);
  });

  test(`parallel-safe calls are bounded to ${PARALLEL_TOOL_CONCURRENCY} in flight (DSH's rolling pool runs them concurrently)`, async () => {
    const ref = await session();
    const gate = { open: false };
    const tools = new FakeDispatcher([
      {
        name: 'read',
        parallelSafe: true,
        handler: async () => {
          const start = Date.now();
          while (!gate.open && Date.now() - start < 300) await new Promise((r) => setTimeout(r, 2));
          return { content: 'r' };
        },
      },
    ]);
    const calls = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, name: 'read', arguments: { i } }));
    const p = run(ref, host(new FakeModelInvoker([{ toolCalls: calls }]), tools));
    await until(() => tools.inFlight >= PARALLEL_TOOL_CONCURRENCY);
    gate.open = true;
    const r = await p;
    assert.equal(r.status, 'continue');
    assert.equal(tools.maxInFlight, PARALLEL_TOOL_CONCURRENCY);
    assert.deepEqual(tools.calls.map((c) => c.toolCallId), calls.map((c) => c.id), 'dispatched in call order');
    assert.deepEqual(r.toolResults.map((t) => t.message.toolCallId), calls.map((c) => c.id));
  });

  test('an engine-decided call between parallel-safe calls does not split their batch (NativeEngine batching)', async () => {
    let arrived = 0;
    const barrier = async (): Promise<void> => {
      arrived += 1;
      const start = Date.now();
      while (arrived < 2 && Date.now() - start < 1500) await new Promise((r) => setTimeout(r, 2));
    };
    for (const e of [engine, native] as const) {
      arrived = 0;
      n += 1;
      const ref = await e.createSession({ runId: `run_d${n}`, agentId: `agent_d${n}`, initialMessages: [{ role: 'user', content: 'go' }] });
      const tools = new FakeDispatcher([{ name: 'read', parallelSafe: true, handler: async () => { await barrier(); return { content: 'r' }; } }, { name: 'write' }]);
      const model = new FakeModelInvoker([{ toolCalls: [{ id: 'a', name: 'read', arguments: {} }, { id: 'w', name: 'write', rawArguments: '{' }, { id: 'b', name: 'read', arguments: {} }] }]);
      const r = await e.runTurn({ session: ref, host: host(model, tools), limits: LIMITS, signal: new AbortController().signal });
      assert.equal(tools.maxInFlight, 2, `${e.kind}: the two reads overlapped across the malformed (never dispatched) write`);
      assert.deepEqual(r.toolResults.map((t) => [t.message.toolCallId, t.message.isError === true]), [['a', false], ['w', true], ['b', false]]);
    }
  });

  test('a tool the context did not declare — or whose name DSH reserves — still reaches the host dispatcher', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'known' }, { name: 'run_code', handler: () => ({ content: 'host run_code' }) }, { name: 'hypertest:x', handler: () => ({ content: 'escaped' }) }, { name: '', handler: () => ({ content: 'nameless' }) }]);
    const model = new FakeModelInvoker([
      {
        toolCalls: [
          { id: 'u1', name: 'mystery_tool', arguments: { q: 1 } },
          { id: 'u2', name: 'run_code', arguments: {} },
          { id: 'u3', name: 'hypertest:x', arguments: {} },
          { id: 'u4', name: '', arguments: {} },
        ],
      },
    ]);
    const r = await run(ref, host(model, tools, { context: new FakeContextProvider({ tools: [{ name: 'known', description: 'k', inputSchema: { type: 'object' } }] }) }));
    assert.deepEqual(tools.calls.map((c) => [c.name, c.invocationId]), [
      ['mystery_tool', `${ref.sessionId}:1:u1`],
      ['run_code', `${ref.sessionId}:1:u2`],
      ['hypertest:x', `${ref.sessionId}:1:u3`],
      ['', `${ref.sessionId}:1:u4`],
    ]);
    assert.deepEqual(r.toolResults.map((t) => [t.message.content, t.message.isError === true]), [['unknown tool mystery_tool', true], ['host run_code', false], ['escaped', false], ['nameless', false]]);
    assert.deepEqual(warnings(ref), [], 'DSH recorded the calls under their (unescaped) names');

    // the same holds on replay (the recorded response names the tool; the host declares nothing)
    const ref2 = await session();
    const crashing = new FakeDispatcher([{ name: 'hidden', handler: () => { throw new Error('crash before settle'); } }]);
    await assert.rejects(run(ref2, host(new FakeModelInvoker([{ toolCalls: [{ id: 'h1', name: 'hidden', arguments: {} }] }]), crashing)), /crash before settle/);
    const again = new FakeDispatcher([{ name: 'hidden', handler: () => ({ content: 'found it' }) }]);
    const bare: ToolDispatcher = { definitions: () => [], isParallelSafe: () => false, dispatch: (call, meta) => again.dispatch(call, meta) };
    const r2 = await run(ref2, host(new FakeModelInvoker([]), again, { tools: bare }));
    assert.equal(r2.replayed, true);
    assert.deepEqual(r2.toolResults.map((t) => t.message.content), ['found it']);
    assert.deepEqual(again.calls.map((c) => c.invocationId), [`${ref2.sessionId}:1:h1`]);
  });

  test('arguments are dispatched exactly as recorded: DSH neither validates nor coerces them (validation is the host’s)', async () => {
    const ref = await session();
    const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false };
    const seen: Array<{ id: string; arguments: JsonValue }> = [];
    const inner = new FakeDispatcher([{ name: 'count', inputSchema: schema }]);
    const tools: ToolDispatcher = {
      definitions: () => inner.definitions(),
      isParallelSafe: () => false,
      dispatch: (call: ToolCall, meta) => {
        seen.push({ id: call.id, arguments: call.arguments });
        return inner.dispatch(call, meta);
      },
    };
    const model = new FakeModelInvoker([
      { toolCalls: [{ id: 'n1', name: 'count', arguments: { n: '1' } }, { id: 'n2', name: 'count', arguments: { extra: null } }, { id: 'n3', name: 'count', arguments: { n: -0 } }, { id: 'n4', name: 'count', arguments: 'raw string' }] },
    ]);
    const r = await run(ref, host(model, tools));
    assert.deepEqual(seen.map((s) => s.id), ['n1', 'n2', 'n3', 'n4'], 'every call reached the host (DSH would refuse a -0 in its argument snapshot)');
    assert.deepEqual(seen[0]!.arguments, { n: '1' });
    assert.deepEqual(seen[1]!.arguments, { extra: null });
    assert.equal(seen[3]!.arguments, 'raw string');
    const recorded = (await sessions.getTurn(ref.sessionId, 1))!.response!.toolCalls!.map((c) => c.arguments);
    assert.deepEqual(seen.map((s) => s.arguments), recorded, 'the host receives the recorded IR arguments, never DSH’s parsed projection');
    assert.equal(r.toolResults.length, 4);
    assert.deepEqual(model.requests[0]!.tools, [{ name: 'count', description: 'fake tool count', inputSchema: schema }], 'the model sees the host tool schemas');
  });

  test('the model sees exactly the host-assembled context (system prompt, responseFormat, tools), not DSH’s transcript or persona', async () => {
    const ref = await session([{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }] }]);
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const responseFormat = { name: 'verdict', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } };
    const model = new FakeModelInvoker([{ text: 'seen' }]);
    const context = new FakeContextProvider({ system: 'SYSTEM PROMPT', responseFormat, tools: () => tools.definitions() });
    await run(ref, host(model, tools, { context }));
    assert.deepEqual(model.requests[0]!.messages, [
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }] },
    ]);
    assert.deepEqual(model.requests[0]!.responseFormat, responseFormat);
    assert.equal(model.requests[0]!.snapshotId, `cs_fake_${ref.sessionId}_1`);
    assert.ok(!JSON.stringify(model.requests).includes('DeepSeek Harness'), 'DSH’s system prompt never reaches the model');
  });

  test('rich transcripts (images, reasoning, opaque continuation, malformed calls, boundary turns, system input) project into DSH without divergence', async () => {
    const ref = await session([
      { role: 'system', content: 'you are careful' },
      { role: 'user', content: [{ type: 'image', mimeType: 'image/jpeg', artifactUri: 'artifact://sha256/abc' }] },
    ]);
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const model = new FakeModelInvoker([
      { text: 'considering', reasoning: { text: 'hmm', opaque: { compatibilityClass: 'anthropic:x', data: { blocks: [{ thinking: 'hmm', signature: 's1' }] } } }, toolCalls: [{ id: 'm1', name: 'probe', rawArguments: '{"a":' }, { id: 'm2', name: 'probe', arguments: [1, 2] }] },
      { boundary: 'retry_next_turn', message: 'route flapped' },
      { text: '' },
      { toolCalls: [{ id: 'm1', name: 'probe', arguments: { again: true } }] },
      { text: 'next' },
    ]);
    const r1 = await run(ref, host(model, tools));
    assert.equal(r1.status, 'continue');
    assert.deepEqual(r1.toolResults.map((t) => t.message.isError === true), [true, false]);
    assert.deepEqual(tools.calls.map((c) => [c.toolCallId, c.arguments]), [['m2', [1, 2]]], 'the malformed call was decided by the engine; the array-argument call went to the host');
    assert.equal((await run(ref, host(model, tools), { input: [{ role: 'user', content: 'wake up' }] })).status, 'boundary');
    assert.equal((await run(ref, host(model, tools))).status, 'continue', 'an empty text-only response');
    assert.equal((await run(ref, host(model, tools))).status, 'continue', 'a call id reused from an earlier turn');
    await run(ref, host(model, tools));
    assert.deepEqual(model.requests[4]!.messages.slice(0, 3), [
      { role: 'system', content: 'you are careful' },
      { role: 'user', content: [{ type: 'image', mimeType: 'image/jpeg', artifactUri: 'artifact://sha256/abc' }] },
      (await sessions.getTurn(ref.sessionId, 1))!.response,
    ]);
    const t = traces(ref);
    assert.deepEqual(t.map((x) => x.steps), [1, 1, 1, 1, 1]);
    assert.equal(t[1]!.events.at(-1), 'turn/end:error', 'a model boundary ends DSH’s step without tools');
    assert.deepEqual(warnings(ref), [], 'DSH’s view of every turn equals the recorded response and results');
  });

  test('a model boundary without a message still ends the DSH step cleanly as a boundary (no fault, nothing dispatched)', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const model = new FakeModelInvoker([{ boundary: 'budget_exhausted', message: '' }, { toolCalls: [{ name: 'probe', arguments: {} }] }]);
    const r1 = await run(ref, host(model, tools));
    assert.deepEqual([r1.status, r1.boundary], ['boundary', 'budget_exhausted']);
    assert.equal(tools.calls.length, 0);
    assert.equal(traces(ref).at(-1)!.events.at(-1), 'turn/end:error');
    // DSH ends the step on the boundary itself, not on its own validation of an empty failure message
    assert.deepEqual(traces(ref).at(-1)!.dshErrors, ['HYPERTEST_BOUNDARY_BUDGET_EXHAUSTED']);
    assert.equal((await run(ref, host(model, tools))).status, 'continue');
  });

  test('a model fault propagates and leaves the turn started; the retry re-runs the same turn', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const model = new FakeModelInvoker([{ throws: new Error('invoker bug') }, { toolCalls: [{ name: 'probe', arguments: {} }] }]);
    await assert.rejects(run(ref, host(model, tools)), /invoker bug/);
    assert.equal((await sessions.lastTurn(ref.sessionId))?.status, 'started');
    assert.equal(tools.calls.length, 0);
    const r = await run(ref, host(model, tools));
    assert.equal(r.turn, 1);
    assert.equal(r.status, 'continue');
    assert.equal(model.callCount, 2);
  });

  test('response persisted before tools: when recording the response fails nothing is dispatched and the turn is re-run', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'deploy' }]);
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'd1', name: 'deploy', arguments: { env: 'x' } }] }, { toolCalls: [{ id: 'd1', name: 'deploy', arguments: { env: 'x' } }] }]);
    const failing: SessionStore = { ...sessions, recordModelResponse: async () => { throw new Error('database unavailable while recording'); } };
    await assert.rejects(run(ref, host(model, tools, { sessions: failing })), /database unavailable while recording/);
    assert.equal(tools.calls.length, 0, 'no tool ran without a persisted response');
    assert.equal((await sessions.lastTurn(ref.sessionId))?.status, 'started');
    const r = await run(ref, host(model, tools));
    assert.equal(r.turn, 1);
    assert.deepEqual(tools.calls.map((c) => c.invocationId), [`${ref.sessionId}:1:d1`]);
  });

  test('a failed settlement of an engine decision is a fault (not swallowed by DSH): later calls are not dispatched', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'bad', name: 'probe', rawArguments: '{' }, { id: 'good', name: 'probe', arguments: {} }] }]);
    const failing: SessionStore = {
      ...sessions,
      settleToolCall: async (...args) => {
        if (args[2] === 'bad') throw new Error('settle failed');
        return sessions.settleToolCall(...args);
      },
    };
    await assert.rejects(run(ref, host(model, tools, { sessions: failing })), /settle failed/);
    assert.equal(tools.calls.length, 0);
    assert.deepEqual((await sessions.getTurn(ref.sessionId, 1))?.toolCalls.map((c) => [c.toolCallId, c.status]), [['bad', 'pending'], ['good', 'pending']]);
    const r = await run(ref, host(new FakeModelInvoker([]), tools));
    assert.equal(r.replayed, true);
    assert.deepEqual(r.toolResults.map((t) => [t.message.toolCallId, t.message.isError === true]), [['bad', true], ['good', false]]);
  });

  test('a dispatch fault: in-flight parallel calls settle, later calls are not dispatched, the fault propagates', async () => {
    const ref = await session();
    let aFailed = false;
    let inFlight = (): number => 0;
    const tools = new FakeDispatcher([
      {
        name: 'read_a',
        parallelSafe: true,
        handler: async () => {
          const start = Date.now();
          while (inFlight() < 2 && Date.now() - start < 1000) await new Promise((r) => setTimeout(r, 2));
          aFailed = true;
          throw new Error('dispatcher exploded');
        },
      },
      {
        name: 'read_b',
        parallelSafe: true,
        handler: async () => {
          const start = Date.now();
          while (!aFailed && Date.now() - start < 1000) await new Promise((r) => setTimeout(r, 2));
          return { content: 'B' };
        },
      },
      { name: 'read_d', parallelSafe: true },
      { name: 'write_c' },
    ]);
    inFlight = () => tools.inFlight;
    const model = new FakeModelInvoker([
      { toolCalls: [{ id: 'a', name: 'read_a', arguments: {} }, { id: 'b', name: 'read_b', arguments: {} }, { id: 'c', name: 'write_c', arguments: {} }, { id: 'd', name: 'read_d', arguments: {} }] },
    ]);
    await assert.rejects(run(ref, host(model, tools)), /dispatcher exploded/);
    assert.deepEqual(tools.calls.map((c) => c.name), ['read_a', 'read_b'], 'the in-flight read settled; nothing started after the fault');
    assert.deepEqual((await sessions.getTurn(ref.sessionId, 1))?.toolCalls.map((c) => [c.toolCallId, c.status]), [['a', 'pending'], ['b', 'settled'], ['c', 'pending'], ['d', 'pending']]);
    assert.equal(await engine.liveDshSessions(), 0, 'the faulted turn disposed its DSH agent');
  });

  test('a dispatcher result without a tool message is a fault; the call stays pending', async () => {
    const ref = await session();
    const broken: ToolDispatcher = { definitions: () => [], isParallelSafe: () => false, dispatch: async () => ({}) as DispatchResult };
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'b1', name: 'y', arguments: {} }] }]);
    await assert.rejects(run(ref, host(model, new FakeDispatcher([]), { tools: broken })), (e: unknown) => isHypertestError(e, 'internal'));
    assert.deepEqual((await sessions.getTurn(ref.sessionId, 1))?.toolCalls.map((c) => c.status), ['pending']);
  });

  test('an abort right after the response is recorded: interrupted, nothing dispatched; the replay dispatches', async () => {
    const ref = await session();
    const ctrl = new AbortController();
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const model = new FakeModelInvoker(async () => {
      ctrl.abort(new Error('worker draining'));
      return { toolCalls: [{ id: 'p1', name: 'probe', arguments: {} }], usage: { outputTokens: 11 } };
    });
    const r = await run(ref, host(model, tools), { signal: ctrl.signal });
    assert.equal(r.status, 'interrupted');
    assert.equal(r.usage.outputTokens, 11, 'the response was produced (and recorded)');
    assert.equal(tools.calls.length, 0);
    assert.equal((await sessions.getTurn(ref.sessionId, 1))?.status, 'model_responded');
    assert.equal((await engine.inspect(ref)).status, 'active');
    const r2 = await run(ref, host(model, tools));
    assert.equal(r2.replayed, true);
    assert.equal(model.callCount, 1);
    assert.deepEqual(tools.calls.map((c) => c.invocationId), [`${ref.sessionId}:1:p1`]);
  });

  test('interrupt while DSH executes a tool: the loop ends, the call stays pending, the resumed turn re-dispatches it', async () => {
    const ref = await session();
    let started = false;
    const tools = new FakeDispatcher([
      {
        name: 'long_job',
        handler: async (_call, meta) => {
          started = true;
          await new Promise<void>((resolve) => (meta.signal.aborted ? resolve() : meta.signal.addEventListener('abort', () => resolve(), { once: true })));
          return { content: 'late result' };
        },
      },
      { name: 'after' },
    ]);
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'j1', name: 'long_job', arguments: {} }, { id: 'j2', name: 'after', arguments: {} }] }]);
    const running = run(ref, host(model, tools));
    await until(() => started);
    await engine.interrupt({ session: ref, reason: 'operator stop' });
    const r = await running;
    assert.equal(r.status, 'interrupted');
    assert.deepEqual(r.toolResults, [], 'the late result is not trusted');
    assert.deepEqual(tools.calls.map((c) => c.name), ['long_job']);
    assert.equal((await engine.inspect(ref)).status, 'interrupted');
    assert.deepEqual((await sessions.getTurn(ref.sessionId, 1))?.toolCalls.map((c) => c.status), ['pending', 'pending']);
    assert.equal(traces(ref).at(-1)!.events.at(-1), 'turn/end:aborted', 'the abort cancelled DSH’s turn');

    const again = new FakeDispatcher([{ name: 'long_job', handler: () => ({ content: 'done' }) }, { name: 'after' }]);
    const resumed = await engine.resumeChild({ child: ref, host: host(new FakeModelInvoker([]), again), limits: LIMITS, signal: new AbortController().signal });
    assert.equal(resumed.replayed, true);
    assert.deepEqual(again.calls.map((c) => c.invocationId), [`${ref.sessionId}:1:j1`, `${ref.sessionId}:1:j2`]);
    assert.equal(await engine.liveDshSessions(), 0);
  });

  test('a failed turn_completed emit leaves the turn replayable (no second model call, no re-dispatch)', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'q', name: 'probe', arguments: {} }] }]);
    let fail = true;
    const flaky = {
      emit: async (evs: Parameters<InMemoryEventSink['emit']>[0]) => {
        if (fail && evs.some((e) => e.eventType === 'agent.turn_completed')) throw new Error('event store down');
        return events.emit(evs);
      },
    };
    await assert.rejects(run(ref, host(model, tools, { events: flaky })), /event store down/);
    assert.equal((await sessions.getTurn(ref.sessionId, 1))?.status, 'model_responded');
    fail = false;
    const r = await run(ref, host(model, tools, { events: flaky }));
    assert.equal(r.replayed, true);
    assert.equal(model.callCount, 1);
    assert.equal(tools.calls.length, 1);
    assert.equal((await sessions.getTurn(ref.sessionId, 1))?.status, 'completed');
  });

  test('turn events carry the same payloads as the native engine (I10)', async () => {
    const ref = await session();
    const before = events.events.length;
    await run(ref, host(new FakeModelInvoker([{ toolCalls: [{ id: 'e1', name: 'probe', arguments: {} }] }]), new FakeDispatcher([{ name: 'probe' }])));
    const mine = events.events.slice(before).filter((e) => (e.payload as { sessionId?: string }).sessionId === ref.sessionId);
    assert.deepEqual(mine.map((e) => e.eventType), ['agent.turn_started', 'agent.turn_completed']);
    assert.deepEqual(mine[0]!.payload, { sessionId: ref.sessionId, turn: 1, snapshotId: `cs_fake_${ref.sessionId}_1`, retried: false });
    assert.deepEqual(mine[1]!.payload, { sessionId: ref.sessionId, turn: 1, status: 'continue', replayed: false, toolCalls: 1 });
    assert.equal(mine[1]!.eventId, `evt_${ref.sessionId}_t1_completed`);
    assert.equal(mine[1]!.agentId, `agent_d${n}`);
  });

  test('a replay depends only on the record and dispatch: the host’s current tool definitions are never consulted', async () => {
    const ref = await session();
    const crashing = new FakeDispatcher([{ name: 'probe', handler: () => { throw new Error('crash mid-turn'); } }]);
    await assert.rejects(run(ref, host(new FakeModelInvoker([{ toolCalls: [{ id: 'r1', name: 'probe', arguments: { a: 1 } }] }]), crashing)), /crash mid-turn/);
    const healthy = new FakeDispatcher([{ name: 'probe', handler: () => ({ content: 'probed' }) }]);
    let definitionsCalls = 0;
    const noDefinitions: ToolDispatcher = {
      definitions: () => {
        definitionsCalls += 1;
        throw new Error('tool catalog unavailable');
      },
      isParallelSafe: (name) => healthy.isParallelSafe(name),
      dispatch: (call, meta) => healthy.dispatch(call, meta),
    };
    const noModel = new FakeModelInvoker([]);
    const r = await run(ref, host(noModel, new FakeDispatcher([]), { tools: noDefinitions }));
    assert.equal(r.replayed, true);
    assert.equal(r.status, 'continue');
    assert.equal(definitionsCalls, 0);
    assert.equal(noModel.callCount, 0);
    assert.deepEqual(healthy.calls.map((c) => [c.name, c.invocationId]), [['probe', `${ref.sessionId}:1:r1`]]);
    assert.deepEqual(r.toolResults.map((t) => t.message.content), ['probed']);
  });

  test('after a fault the turn does nothing more: later engine decisions stay unsettled (as in NativeEngine)', async () => {
    const rows: Record<string, Array<[string, string]>> = {};
    for (const e of [engine, native] as const) {
      n += 1;
      const ref = await e.createSession({ runId: `run_d${n}`, agentId: `agent_d${n}`, initialMessages: [{ role: 'user', content: 'go' }] });
      const tools = new FakeDispatcher([{ name: 'probe' }]);
      const model = new FakeModelInvoker([{ toolCalls: [{ id: 'bad1', name: 'probe', rawArguments: '{' }, { id: 'bad2', name: 'probe', rawArguments: '[' }, { id: 'ok', name: 'probe', arguments: {} }] }]);
      const failing: SessionStore = {
        ...sessions,
        settleToolCall: async (...args) => {
          if (args[2] === 'bad1') throw new Error('settle failed');
          return sessions.settleToolCall(...args);
        },
      };
      await assert.rejects(e.runTurn({ session: ref, host: host(model, tools, { sessions: failing }), limits: LIMITS, signal: new AbortController().signal }), /settle failed/);
      assert.equal(tools.calls.length, 0, `${e.kind}: nothing dispatched after the fault`);
      rows[e.kind] = (await sessions.getTurn(ref.sessionId, 1))!.toolCalls.map((c) => [c.toolCallId, c.status]);
      // the replay makes (and settles) every decision and dispatches the valid call once
      const r = await e.runTurn({ session: ref, host: host(new FakeModelInvoker([]), tools), limits: LIMITS, signal: new AbortController().signal });
      assert.equal(r.replayed, true);
      assert.deepEqual(r.toolResults.map((t) => [t.message.toolCallId, t.message.isError === true]), [['bad1', true], ['bad2', true], ['ok', false]]);
      assert.deepEqual(tools.calls.map((c) => c.toolCallId), ['ok']);
    }
    assert.deepEqual(rows['dsh'], [['bad1', 'pending'], ['bad2', 'pending'], ['ok', 'pending']]);
    assert.deepEqual(rows['dsh'], rows['native']);
  });

  test('resumeChild validates before reactivating: a misrouted or malformed resume never un-interrupts a session', async () => {
    const tools = new FakeDispatcher([]);
    const model = new FakeModelInvoker([{ text: 'resumed' }]);
    const resume = (child: EngineSessionRef, limits: TurnLimits = LIMITS) => engine.resumeChild({ child, host: host(model, tools), limits, signal: new AbortController().signal });

    // another engine's interrupted session (whatever the ref claims)
    n += 1;
    await sessions.create({ sessionId: `sess_native_${n}`, runId: `run_d${n}`, agentId: `agent_d${n}`, engineKind: 'native' });
    await sessions.setStatus(`sess_native_${n}`, 'interrupted');
    await assert.rejects(resume({ sessionId: `sess_native_${n}`, engineKind: 'dsh' }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    await assert.rejects(resume({ sessionId: `sess_native_${n}`, engineKind: 'native' }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    assert.equal((await sessions.get(`sess_native_${n}`))?.status, 'interrupted');

    // an own interrupted session resumed with invalid limits
    const ref = await session();
    await engine.interrupt({ session: ref, reason: 'operator stop' });
    await assert.rejects(resume(ref, { maxToolCallsPerTurn: -1, repetitionThreshold: 3 }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    await assert.rejects(resume(ref, { maxToolCallsPerTurn: 4, repetitionThreshold: 1 }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    assert.equal((await sessions.get(ref.sessionId))?.status, 'interrupted');
    assert.equal(model.callCount, 0);

    // a valid resume still works
    const r = await resume(ref);
    assert.equal(r.status, 'continue');
    assert.equal((await sessions.get(ref.sessionId))?.status, 'active');
  });

  test('a length-limited response never lets DSH skip its calls: they reach the host dispatcher (tool policy is the host’s)', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'probe', handler: () => ({ content: 'ran' }) }]);
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'l1', name: 'probe', arguments: { q: 'x' } }], stopReason: 'length' }]);
    const r = await run(ref, host(model, tools));
    assert.equal(r.status, 'continue');
    assert.deepEqual(tools.calls.map((c) => [c.toolCallId, c.invocationId]), [['l1', `${ref.sessionId}:1:l1`]]);
    assert.deepEqual(r.toolResults.map((t) => [t.message.content, t.message.isError === true]), [['ran', false]]);
  });

  test('a text-only turn left model_responded is replayed through DSH without a model call; the nudge is queued once', async () => {
    const ref = await session();
    const model = new FakeModelInvoker([{ text: 'I believe it works.' }, { text: 'next' }]);
    let fail = true;
    const flaky = {
      emit: async (evs: Parameters<InMemoryEventSink['emit']>[0]) => {
        if (fail && evs.some((e) => e.eventType === 'agent.turn_completed')) throw new Error('event store down');
        return events.emit(evs);
      },
    };
    await assert.rejects(run(ref, host(model, new FakeDispatcher([]), { events: flaky })), /event store down/);
    assert.equal((await sessions.getTurn(ref.sessionId, 1))?.status, 'model_responded');
    fail = false;
    const r = await run(ref, host(model, new FakeDispatcher([]), { events: flaky }));
    assert.equal(r.replayed, true);
    assert.equal(r.status, 'continue');
    assert.deepEqual(r.toolResults, []);
    assert.equal(model.callCount, 1);
    assert.equal(traces(ref).at(-1)!.streamRequests, 1);
    await run(ref, host(model, new FakeDispatcher([])));
    assert.deepEqual(model.requests[1]!.messages.slice(-2), [{ role: 'assistant', content: [{ type: 'text', text: 'I believe it works.' }] }, { role: 'user', content: TEXT_ONLY_NUDGE }]);
    assert.equal(model.requests[1]!.messages.filter((m) => m.role === 'user' && m.content === TEXT_ONLY_NUDGE).length, 1);
  });

  test('abort while an exclusive call waits behind in-flight parallel calls: late results untrusted, the exclusive call never dispatched, the replay runs all three in order', async () => {
    const ref = await session();
    const ctrl = new AbortController();
    const waitForAbort = async (signal: AbortSignal): Promise<void> => {
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    };
    const tools = new FakeDispatcher([
      { name: 'read_a', parallelSafe: true, handler: async (_c, meta) => { await waitForAbort(meta.signal); return { content: 'late A' }; } },
      { name: 'read_b', parallelSafe: true, handler: async (_c, meta) => { await waitForAbort(meta.signal); return { content: 'late B' }; } },
      { name: 'write_c' },
    ]);
    const calls = [{ id: 'a', name: 'read_a', arguments: {} }, { id: 'b', name: 'read_b', arguments: {} }, { id: 'c', name: 'write_c', arguments: {} }];
    const running = run(ref, host(new FakeModelInvoker([{ toolCalls: calls }]), tools), { signal: ctrl.signal });
    await until(() => tools.inFlight >= 2);
    assert.equal(tools.inFlight, 2, 'both parallel-safe reads are in flight');
    ctrl.abort(new Error('worker draining'));
    const r = await running;
    assert.equal(r.status, 'interrupted');
    assert.deepEqual(r.toolResults, []);
    assert.deepEqual(tools.calls.map((c) => c.name), ['read_a', 'read_b'], 'the exclusive call was never dispatched');
    assert.deepEqual((await sessions.getTurn(ref.sessionId, 1))?.toolCalls.map((c) => [c.toolCallId, c.status]), [['a', 'pending'], ['b', 'pending'], ['c', 'pending']]);
    assert.equal((await engine.inspect(ref)).status, 'active', 'an abort is not an interrupt');

    const again = new FakeDispatcher([{ name: 'read_a', parallelSafe: true }, { name: 'read_b', parallelSafe: true }, { name: 'write_c' }]);
    const r2 = await run(ref, host(new FakeModelInvoker([]), again));
    assert.equal(r2.replayed, true);
    assert.equal(r2.status, 'continue');
    assert.deepEqual(again.calls.map((c) => c.invocationId), ['a', 'b', 'c'].map((id) => `${ref.sessionId}:1:${id}`));
    const at = (s: string) => again.log.indexOf(s);
    assert.ok(at('start:write_c:c') > at('end:read_a:a') && at('start:write_c:c') > at('end:read_b:b'), again.log.join(' '));
  });

  test('a malformed terminal signal from the dispatcher is a fault; the call stays pending and nothing is committed', async () => {
    const ref = await session();
    const broken: ToolDispatcher = {
      definitions: () => [],
      isParallelSafe: () => false,
      dispatch: async (call) => ({ message: { role: 'tool' as const, toolCallId: call.id, toolName: call.name, content: 'done?' }, terminal: { kind: 'complete' } as never }),
    };
    await assert.rejects(run(ref, host(new FakeModelInvoker([{ toolCalls: [{ id: 't1', name: 'complete_work', arguments: {} }] }]), new FakeDispatcher([]), { tools: broken })), (e: unknown) => isHypertestError(e, 'internal'));
    const t = await sessions.getTurn(ref.sessionId, 1);
    assert.equal(t?.status, 'model_responded');
    assert.deepEqual(t?.toolCalls.map((c) => c.status), ['pending']);
    assert.equal((await engine.inspect(ref)).status, 'active');
  });

  test('concurrent turns of different sessions share one DSH kernel without crossing (each step is served to its own turn)', async () => {
    const a = await session([{ role: 'user', content: 'session A' }]);
    const b = await session([{ role: 'user', content: 'session B' }]);
    let arrived = 0;
    const meet = async (): Promise<void> => {
      arrived += 1;
      const start = Date.now();
      while (arrived < 2 && Date.now() - start < 1500) await new Promise((r) => setTimeout(r, 2));
    };
    const toolsA = new FakeDispatcher([{ name: 'probe', handler: async () => { await meet(); return { content: 'from A' }; } }]);
    const toolsB = new FakeDispatcher([{ name: 'probe', handler: async () => { await meet(); return { content: 'from B' }; } }]);
    const modelA = new FakeModelInvoker([{ toolCalls: [{ id: 'x', name: 'probe', arguments: { s: 'A' } }] }]);
    const modelB = new FakeModelInvoker([{ toolCalls: [{ id: 'x', name: 'probe', arguments: { s: 'B' } }] }]);
    const [ra, rb] = await Promise.all([run(a, host(modelA, toolsA)), run(b, host(modelB, toolsB))]);
    assert.equal(arrived, 2, 'both turns were dispatching at the same time');
    assert.deepEqual(toolsA.calls.map((c) => [c.sessionId, c.arguments]), [[a.sessionId, { s: 'A' }]]);
    assert.deepEqual(toolsB.calls.map((c) => [c.sessionId, c.arguments]), [[b.sessionId, { s: 'B' }]]);
    assert.deepEqual([ra.toolResults[0]!.message.content, rb.toolResults[0]!.message.content], ['from A', 'from B']);
    assert.deepEqual([...warnings(a), ...warnings(b)], []);
    assert.equal(await engine.liveDshSessions(), 0);
  });

  test('close() disposes the DSH kernel; a later turn boots a new one', async () => {
    const own = new DshEngine({ sessions, ids, clock: new FixedClock('2026-05-01T00:00:00.000Z'), logger });
    await own.close();
    const ref = await own.createSession({ runId: 'run_close', agentId: 'agent_close', initialMessages: [{ role: 'user', content: 'go' }] });
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const turn = (m: FakeModelInvoker) => own.runTurn({ session: ref, host: host(m, tools), limits: LIMITS, signal: new AbortController().signal });
    assert.equal((await turn(new FakeModelInvoker([{ toolCalls: [{ id: 'p', name: 'probe', arguments: {} }] }]))).status, 'continue');
    await own.close();
    await own.close();
    assert.equal(await own.liveDshSessions(), 0);
    assert.equal((await turn(new FakeModelInvoker([{ text: 'after close' }]))).status, 'continue', 'a new kernel serves the next turn');
    await own.close();
  });

  test('any Clock serves: a fractional-millisecond clock never makes DSH refuse the seeded agent of a later turn', async () => {
    // e.g. a performance-based Clock (legal: nowMs() is "milliseconds since epoch"); DSH's seed envelope needs integers
    const clock = { nowMs: () => 1_777_000_000_000.25, isoNow: () => '2026-04-24T03:06:40.000Z' };
    const own = new DshEngine({ sessions, ids, clock, logger });
    try {
      const ref = await own.createSession({ runId: 'run_clock', agentId: 'agent_clock', initialMessages: [{ role: 'user', content: 'go' }] });
      const tools = new FakeDispatcher([{ name: 'probe' }, completeWorkTool()]);
      const model = new FakeModelInvoker([
        { toolCalls: [{ id: 'k1', name: 'probe', arguments: {} }] },
        { text: 'looking' },
        { toolCalls: [{ id: 'k2', name: 'complete_work', arguments: { summary: 'done' } }] },
      ]);
      const statuses: string[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await own.runTurn({ session: ref, host: host(model, tools), limits: LIMITS, signal: new AbortController().signal })).status);
      assert.deepEqual(statuses, ['continue', 'continue', 'completed'], 'turns 2 and 3 run over a seeded DSH session');
      assert.equal(model.callCount, 3);
      assert.deepEqual(tools.calls.map((c) => c.toolCallId), ['k1', 'k2']);
      assert.deepEqual(warnings(ref), []);
    } finally {
      await own.close();
    }
  });

  test('a host tool definition DSH could not log (no string description) still reaches the model untouched; the turn runs', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const defs = [{ name: 'probe', description: undefined, inputSchema: { type: 'object' } }] as unknown as ToolDefinition[];
    const seen: ToolDefinition[][] = [];
    const model: ModelInvoker = {
      invoke: async (req) => {
        seen.push(req.tools);
        return { ok: true, message: { role: 'assistant', content: [], toolCalls: [{ id: 'u1', name: 'probe', arguments: {} }] }, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, routeId: 'r', epochId: 'e', stopReason: 'tool_use' };
      },
    };
    const r = await run(ref, { ...host(new FakeModelInvoker([]), tools, { context: new FakeContextProvider({ tools: defs }) }), model });
    assert.equal(r.status, 'continue');
    assert.deepEqual(seen, [defs], 'the model gets the host definitions as assembled (never DSH’s listing)');
    assert.deepEqual(tools.calls.map((c) => c.toolCallId), ['u1']);
  });

  test('sessions of another engine kind are refused', async () => {
    const ref = await session();
    await assert.rejects(run({ ...ref, engineKind: 'native' }, host(new FakeModelInvoker([]), new FakeDispatcher([]))), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    await sessions.create({ sessionId: 'sess_native_x', runId: 'run_x', agentId: 'agent_x', engineKind: 'native' });
    await assert.rejects(run({ sessionId: 'sess_native_x', engineKind: 'dsh' }, host(new FakeModelInvoker([]), new FakeDispatcher([]))), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  });
});
