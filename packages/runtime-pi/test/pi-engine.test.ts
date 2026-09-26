import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { FixedClock, MemoryLogger, SequentialIdGenerator, isHypertestError, type SqlDatabase } from '@hypertest/core';
import { InMemoryEventSink, type ChatMessage } from '@hypertest/domain';
import {
  EngineRegistry, FakeContextProvider, FakeDispatcher, FakeModelInvoker, NativeEngine, PARALLEL_TOOL_CONCURRENCY, TEXT_ONLY_NUDGE, completeWorkTool, createSessionStore, engineContractSuite,
  fakeHost, runtimeMigrations,
  type EngineHost, type EngineSessionRef, type SessionStore, type TurnLimits,
} from '@hypertest/runtime';
import { createTestDatabase } from '@hypertest/store';
import { PI_ENGINE_KIND, PiEngine } from '../src/index.ts';
import { PI_AGENT_CORE_VERSION, SUPPORTED_PI_AGENT_CORE_VERSION, assertSupportedPiAgentCore } from '../src/version.ts';

// The shared AgentEngine contract (every engine must pass it).
engineContractSuite('pi', (deps) => new PiEngine(deps), { openDatabase: (migrations) => createTestDatabase({ migrations }) });

const LIMITS: TurnLimits = { maxToolCallsPerTurn: 16, repetitionThreshold: 3 };

interface Trace {
  turn: number;
  streamRequests: number;
  events: string[];
}

describe('PiEngine specifics', () => {
  let db: SqlDatabase;
  let dispose: () => Promise<void>;
  let sessions: SessionStore;
  let events: InMemoryEventSink;
  let logger: MemoryLogger;
  let engine: PiEngine;
  let native: NativeEngine;
  let n = 0;

  before(async () => {
    ({ db, dispose } = await createTestDatabase({ migrations: runtimeMigrations }));
    events = new InMemoryEventSink();
    logger = new MemoryLogger();
    const deps = { db, ids: new SequentialIdGenerator(), clock: new FixedClock('2026-05-01T00:00:00.000Z'), logger, events };
    sessions = createSessionStore(deps);
    engine = new PiEngine({ ...deps, sessions });
    // Same ports (one id sequence): the reference engine for parity checks.
    native = new NativeEngine({ ...deps, sessions });
  });
  after(async () => dispose());

  async function session(initial: ChatMessage[] = [{ role: 'user', content: 'go' }]): Promise<EngineSessionRef> {
    n += 1;
    return engine.createSession({ runId: `run_p${n}`, agentId: `agent_p${n}`, initialMessages: initial });
  }
  function host(model: FakeModelInvoker, tools: FakeDispatcher, extra: Partial<EngineHost> = {}): EngineHost {
    return { ...fakeHost({ sessions, model, tools, events, eventContext: { runId: `run_p${n}`, correlationId: 'corr', actorId: 'system:test' } }), ...extra };
  }
  const run = (ref: EngineSessionRef, h: EngineHost, extra: { limits?: TurnLimits; signal?: AbortSignal; input?: ChatMessage[] } = {}) => {
    const req: Parameters<PiEngine['runTurn']>[0] = { session: ref, host: h, limits: extra.limits ?? LIMITS, signal: extra.signal ?? new AbortController().signal };
    if (extra.input) req.input = extra.input;
    return engine.runTurn(req);
  };
  const traces = (ref: EngineSessionRef): Trace[] =>
    logger.entries.filter((e) => e.msg === 'pi turn trace' && e.fields['sessionId'] === ref.sessionId).map((e) => e.fields as unknown as Trace);
  const warnings = (ref: EngineSessionRef): string[] => logger.entries.filter((e) => e.level === 'warn' && e.fields['sessionId'] === ref.sessionId).map((e) => e.msg);

  test('identity: kind pi, version = the pinned pi-agent-core (0.87.1), honest capabilities', () => {
    const installed = JSON.parse(readFileSync(new URL(import.meta.resolve('@earendil-works/pi-agent-core/package.json')), 'utf8')) as { version: string };
    const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; dependencies: Record<string, string> };
    assert.equal(engine.kind, 'pi');
    assert.equal(engine.kind, PI_ENGINE_KIND);
    assert.equal(engine.version, installed.version);
    assert.equal(engine.version, own.dependencies['@earendil-works/pi-agent-core'], 'the installed pi-agent-core is the pinned one');
    assert.equal(engine.version, '0.87.1');
    assert.equal(engine.adapterVersion, own.version);
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
    assert.throws(() => new PiEngine({} as never), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  });

  test('pin + adapter: the adapter refuses to exist over any pi-agent-core other than the pinned one (fail closed)', () => {
    const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    assert.equal(SUPPORTED_PI_AGENT_CORE_VERSION, own.dependencies['@earendil-works/pi-agent-core'], 'the supported version is the exact package.json pin');
    assert.equal(PI_AGENT_CORE_VERSION, SUPPORTED_PI_AGENT_CORE_VERSION, 'the installed pi-agent-core is the supported one');
    assert.doesNotThrow(() => assertSupportedPiAgentCore(PI_AGENT_CORE_VERSION));
    for (const drifted of ['0.87.2', '0.88.0', '0.84.1', '^0.87.1', '']) {
      assert.throws(
        () => assertSupportedPiAgentCore(drifted),
        (e: unknown) => isHypertestError(e, 'precondition_failed') && e.details['installed'] === drifted && e.details['supported'] === '0.87.1',
        `pi-agent-core ${JSON.stringify(drifted)} is refused`,
      );
    }
  });

  test('I11: a run pinned to another pi-agent-core version is refused; the pinned version is served', () => {
    const registry = new EngineRegistry([engine, new NativeEngine({ sessions, ids: new SequentialIdGenerator(), clock: new FixedClock('2026-05-01T00:00:00.000Z'), logger })]);
    assert.deepEqual(registry.manifestEntries().find((e) => e.kind === 'pi'), { kind: 'pi', version: '0.87.1' });
    assert.throws(() => registry.assertPinned({ manifestId: 'rm_old', agentEngines: [{ kind: 'pi', version: '0.84.1' }] }, 'pi'), (e: unknown) => isHypertestError(e, 'precondition_failed'));
    assert.equal(registry.assertPinned({ manifestId: 'rm_now', agentEngines: [{ kind: 'pi', version: engine.version }] }, 'pi'), engine);
  });

  test('one Hypertest turn = one pi turn: pi runs the tool loop, the host model is invoked exactly once per turn', async () => {
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
    assert.deepEqual(t.map((x) => [x.turn, x.streamRequests]), [[1, 1], [2, 1], [3, 1]], 'pi asked for exactly one response per turn');
    for (const x of t) {
      assert.equal(x.events.filter((e) => e === 'turn_start').length, 1, `turn ${x.turn}: one pi turn`);
      assert.deepEqual([x.events[0], x.events.at(-2), x.events.at(-1)], ['agent_start', 'turn_end', 'agent_end']);
    }
    // turn 1: the host response streamed through pi-ai's protocol, then pi executed both calls and emitted their results
    assert.deepEqual(t[0]!.events.filter((e) => e.startsWith('message_update:')), [
      'message_update:text_start', 'message_update:text_delta', 'message_update:text_end',
      'message_update:toolcall_start', 'message_update:toolcall_delta', 'message_update:toolcall_end',
      'message_update:toolcall_start', 'message_update:toolcall_delta', 'message_update:toolcall_end',
    ]);
    assert.deepEqual(t[0]!.events.filter((e) => e.startsWith('tool_execution_start:')), ['tool_execution_start:c1', 'tool_execution_start:c2']);
    assert.deepEqual(t[0]!.events.filter((e) => e === 'message_end:toolResult').length, 2);
    assert.equal(t[1]!.events.some((e) => e.startsWith('tool_execution')), false, 'a text-only turn executes nothing');
    assert.deepEqual(tools.calls.map((c) => [c.name, c.invocationId]), [
      ['read', `${ref.sessionId}:1:c1`],
      ['write', `${ref.sessionId}:1:c2`],
      ['complete_work', `${ref.sessionId}:3:d1`],
    ]);
    assert.deepEqual(warnings(ref), [], 'pi never asked for a second response and its view of every turn matched the recorded one');
  });

  test('replay goes through pi with the recorded response: no model call, only the unsettled call is dispatched', async () => {
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
    assert.equal(replay.streamRequests, 1, 'the shim served the recorded response');
    assert.deepEqual(replay.events.filter((e) => e.startsWith('tool_execution_start:')), ['tool_execution_start:k1', 'tool_execution_start:k2'], 'pi executed both; the settled one answered from the record');
  });

  test(`parallel-safe calls are bounded to ${PARALLEL_TOOL_CONCURRENCY} in flight (pi runs them concurrently)`, async () => {
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
    const start = Date.now();
    while (tools.inFlight < PARALLEL_TOOL_CONCURRENCY && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 2));
    gate.open = true;
    const r = await p;
    assert.equal(r.status, 'continue');
    assert.equal(tools.maxInFlight, PARALLEL_TOOL_CONCURRENCY);
    assert.deepEqual(tools.calls.map((c) => c.toolCallId), calls.map((c) => c.id), 'dispatched in call order');
    assert.deepEqual(r.toolResults.map((t) => t.message.toolCallId), calls.map((c) => c.id));
  });

  test('a tool the context did not declare still reaches the host dispatcher (never pi’s "tool not found")', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'known' }]);
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'u1', name: 'mystery_tool', arguments: { q: 1 } }] }]);
    const r = await run(ref, host(model, tools));
    assert.deepEqual(tools.calls.map((c) => [c.name, c.invocationId]), [['mystery_tool', `${ref.sessionId}:1:u1`]]);
    assert.deepEqual(r.toolResults.map((t) => [t.message.content, t.message.isError]), [['unknown tool mystery_tool', true]]);

    // the same holds on replay (the recorded response names the tool; the host declares nothing)
    const ref2 = await session();
    const crashing = new FakeDispatcher([{ name: 'hidden', handler: () => { throw new Error('crash before settle'); } }]);
    await assert.rejects(run(ref2, host(new FakeModelInvoker([{ toolCalls: [{ id: 'h1', name: 'hidden', arguments: {} }] }]), crashing)), /crash before settle/);
    const bare = { definitions: () => [], isParallelSafe: () => false, dispatch: (call: Parameters<FakeDispatcher['dispatch']>[0], meta: Parameters<FakeDispatcher['dispatch']>[1]) => again.dispatch(call, meta) };
    const again = new FakeDispatcher([{ name: 'hidden', handler: () => ({ content: 'found it' }) }]);
    const r2 = await run(ref2, host(new FakeModelInvoker([]), again, { tools: bare }));
    assert.equal(r2.replayed, true);
    assert.deepEqual(r2.toolResults.map((t) => t.message.content), ['found it']);
    assert.deepEqual(again.calls.map((c) => c.invocationId), [`${ref2.sessionId}:1:h1`]);
  });

  test('arguments are dispatched exactly as recorded: pi neither validates nor coerces them (validation is the host’s)', async () => {
    const ref = await session();
    const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false };
    const tools = new FakeDispatcher([{ name: 'count', inputSchema: schema }]);
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'n1', name: 'count', arguments: { n: '1' } }, { id: 'n2', name: 'count', arguments: { extra: null } }] }]);
    await run(ref, host(model, tools));
    assert.deepEqual(tools.calls.map((c) => c.arguments), [{ n: '1' }, { extra: null }]);
    assert.deepEqual(model.requests[0]!.tools, [{ name: 'count', description: 'fake tool count', inputSchema: schema }], 'the model sees the host tool schemas');
  });

  test('the model sees exactly the host-assembled context (system prompt, responseFormat, tools), not pi’s transcript', async () => {
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
  });

  test('rich transcripts (images, reasoning, opaque continuation, malformed calls) rebuild into pi state without divergence', async () => {
    const ref = await session([{ role: 'user', content: [{ type: 'image', mimeType: 'image/jpeg', artifactUri: 'artifact://sha256/abc' }] }]);
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const model = new FakeModelInvoker([
      { text: 'considering', reasoning: { text: 'hmm', opaque: { compatibilityClass: 'anthropic:x', data: { blocks: [{ thinking: 'hmm', signature: 's1' }] } } }, toolCalls: [{ id: 'm1', name: 'probe', rawArguments: '{"a":' }, { id: 'm2', name: 'probe', arguments: [1, 2] }] },
      { text: 'next' },
    ]);
    const r1 = await run(ref, host(model, tools));
    assert.equal(r1.status, 'continue');
    assert.deepEqual(r1.toolResults.map((t) => t.message.isError === true), [true, false]);
    assert.deepEqual(tools.calls.map((c) => [c.toolCallId, c.arguments]), [['m2', [1, 2]]], 'the malformed call was decided by the engine; the array-argument call went to the host');
    await run(ref, host(model, tools));
    assert.deepEqual(model.requests[1]!.messages.slice(0, 2), [
      { role: 'user', content: [{ type: 'image', mimeType: 'image/jpeg', artifactUri: 'artifact://sha256/abc' }] },
      (await sessions.getTurn(ref.sessionId, 1))!.response,
    ]);
    assert.deepEqual(warnings(ref), [], 'pi’s view of the turn equals the recorded response and results');
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

  test('a failed settlement of an engine decision is a fault (not swallowed by pi): later calls are not dispatched', async () => {
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
    const tools = new FakeDispatcher([
      { name: 'read_a', parallelSafe: true, handler: () => { aFailed = true; throw new Error('dispatcher exploded'); } },
      {
        name: 'read_b',
        parallelSafe: true,
        handler: async () => {
          const start = Date.now();
          while (!aFailed && Date.now() - start < 1000) await new Promise((r) => setTimeout(r, 2));
          return { content: 'B' };
        },
      },
      { name: 'write_c' },
    ]);
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'a', name: 'read_a', arguments: {} }, { id: 'b', name: 'read_b', arguments: {} }, { id: 'c', name: 'write_c', arguments: {} }] }]);
    await assert.rejects(run(ref, host(model, tools)), /dispatcher exploded/);
    assert.deepEqual(tools.calls.map((c) => c.name), ['read_a', 'read_b']);
    assert.deepEqual((await sessions.getTurn(ref.sessionId, 1))?.toolCalls.map((c) => [c.toolCallId, c.status]), [['a', 'pending'], ['b', 'settled'], ['c', 'pending']]);
  });

  test('a dispatcher result without a tool message is a fault; the call stays pending', async () => {
    const ref = await session();
    const broken = { definitions: () => [], isParallelSafe: () => false, dispatch: async () => ({}) as never };
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

  test('interrupt while pi executes a tool: the loop ends, the call stays pending, the resumed turn re-dispatches it', async () => {
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
    const t0 = Date.now();
    while (!started && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 2));
    await engine.interrupt({ session: ref, reason: 'operator stop' });
    const r = await running;
    assert.equal(r.status, 'interrupted');
    assert.deepEqual(r.toolResults, [], 'the late result is not trusted');
    assert.deepEqual(tools.calls.map((c) => c.name), ['long_job']);
    assert.equal((await engine.inspect(ref)).status, 'interrupted');
    assert.deepEqual((await sessions.getTurn(ref.sessionId, 1))?.toolCalls.map((c) => c.status), ['pending', 'pending']);

    const again = new FakeDispatcher([{ name: 'long_job', handler: () => ({ content: 'done' }) }, { name: 'after' }]);
    const resumed = await engine.resumeChild({ child: ref, host: host(new FakeModelInvoker([]), again), limits: LIMITS, signal: new AbortController().signal });
    assert.equal(resumed.replayed, true);
    assert.deepEqual(again.calls.map((c) => c.invocationId), [`${ref.sessionId}:1:j1`, `${ref.sessionId}:1:j2`]);
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
    assert.equal(mine[1]!.agentId, `agent_p${n}`);
  });

  test('a replay depends only on the record and dispatch: the host’s current tool definitions are never consulted', async () => {
    const ref = await session();
    const crashing = new FakeDispatcher([{ name: 'probe', handler: () => { throw new Error('crash mid-turn'); } }]);
    await assert.rejects(run(ref, host(new FakeModelInvoker([{ toolCalls: [{ id: 'r1', name: 'probe', arguments: { a: 1 } }] }]), crashing)), /crash mid-turn/);
    const healthy = new FakeDispatcher([{ name: 'probe', handler: () => ({ content: 'probed' }) }]);
    let definitionsCalls = 0;
    const noDefinitions = {
      definitions: () => {
        definitionsCalls += 1;
        throw new Error('tool catalog unavailable');
      },
      isParallelSafe: (name: string) => healthy.isParallelSafe(name),
      dispatch: (call: Parameters<FakeDispatcher['dispatch']>[0], meta: Parameters<FakeDispatcher['dispatch']>[1]) => healthy.dispatch(call, meta),
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
      const ref = await e.createSession({ runId: `run_p${n}`, agentId: `agent_p${n}`, initialMessages: [{ role: 'user', content: 'go' }] });
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
    assert.deepEqual(rows['pi'], [['bad1', 'pending'], ['bad2', 'pending'], ['ok', 'pending']]);
    assert.deepEqual(rows['pi'], rows['native']);
  });

  test('resumeChild validates before reactivating: a misrouted or malformed resume never un-interrupts a session', async () => {
    const tools = new FakeDispatcher([]);
    const model = new FakeModelInvoker([{ text: 'resumed' }]);
    const resume = (child: EngineSessionRef, limits: TurnLimits = LIMITS) => engine.resumeChild({ child, host: host(model, tools), limits, signal: new AbortController().signal });

    // another engine's interrupted session (whatever the ref claims)
    n += 1;
    await sessions.create({ sessionId: `sess_native_${n}`, runId: `run_p${n}`, agentId: `agent_p${n}`, engineKind: 'native' });
    await sessions.setStatus(`sess_native_${n}`, 'interrupted');
    await assert.rejects(resume({ sessionId: `sess_native_${n}`, engineKind: 'pi' }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
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

  test('a length-limited response never lets pi fail its calls: they reach the host dispatcher (tool policy is the host’s)', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'probe', handler: () => ({ content: 'ran' }) }]);
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'l1', name: 'probe', arguments: { q: 'x' } }], stopReason: 'length' }]);
    const r = await run(ref, host(model, tools));
    assert.equal(r.status, 'continue');
    assert.deepEqual(tools.calls.map((c) => [c.toolCallId, c.invocationId]), [['l1', `${ref.sessionId}:1:l1`]]);
    assert.deepEqual(r.toolResults.map((t) => [t.message.content, t.message.isError === true]), [['ran', false]]);
  });

  test('a text-only turn left model_responded is replayed through pi without a model call; the nudge is queued once', async () => {
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
    const t0 = Date.now();
    while (tools.inFlight < 2 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 2));
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
    const broken = {
      definitions: () => [],
      isParallelSafe: () => false,
      dispatch: async (call: Parameters<FakeDispatcher['dispatch']>[0]) => ({ message: { role: 'tool' as const, toolCallId: call.id, toolName: call.name, content: 'done?' }, terminal: { kind: 'complete' } as never }),
    };
    await assert.rejects(run(ref, host(new FakeModelInvoker([{ toolCalls: [{ id: 't1', name: 'complete_work', arguments: {} }] }]), new FakeDispatcher([]), { tools: broken })), (e: unknown) => isHypertestError(e, 'internal'));
    const t = await sessions.getTurn(ref.sessionId, 1);
    assert.equal(t?.status, 'model_responded');
    assert.deepEqual(t?.toolCalls.map((c) => c.status), ['pending']);
    assert.equal((await engine.inspect(ref)).status, 'active');
  });

  test('sessions of another engine kind are refused', async () => {
    const ref = await session();
    await assert.rejects(run({ ...ref, engineKind: 'native' }, host(new FakeModelInvoker([]), new FakeDispatcher([]))), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    await sessions.create({ sessionId: 'sess_native_x', runId: 'run_x', agentId: 'agent_x', engineKind: 'native' });
    await assert.rejects(run({ sessionId: 'sess_native_x', engineKind: 'pi' }, host(new FakeModelInvoker([]), new FakeDispatcher([]))), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  });
});
