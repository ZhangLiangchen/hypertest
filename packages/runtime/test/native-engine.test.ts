import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { FixedClock, MemoryLogger, SequentialIdGenerator, isHypertestError, type SqlDatabase } from '@hypertest/core';
import { InMemoryEventSink, type ChatMessage } from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';
import {
  FakeContextProvider, FakeDispatcher, FakeModelInvoker, NativeEngine, PARALLEL_TOOL_CONCURRENCY, REPETITIVE_LOOP, TEXT_ONLY_NUDGE, completeWorkTool, createSessionStore, engineContractSuite, fakeHost,
  fakeSnapshot, normalizeResponse, runtimeMigrations, turnCompletedEventId, validateLimits, type EngineHost, type SessionStore, type TurnLimits,
} from '../src/index.ts';
import { faultyDb } from './helpers.ts';

// The shared AgentEngine contract (every engine must pass it).
engineContractSuite('native', (deps) => new NativeEngine(deps), { openDatabase: (migrations) => createTestDatabase({ migrations }) });

const LIMITS: TurnLimits = { maxToolCallsPerTurn: 16, repetitionThreshold: 3 };

describe('NativeEngine specifics', () => {
  let db: SqlDatabase;
  let dispose: () => Promise<void>;
  let sessions: SessionStore;
  let events: InMemoryEventSink;
  let engine: NativeEngine;
  let n = 0;

  before(async () => {
    ({ db, dispose } = await createTestDatabase({ migrations: runtimeMigrations }));
    events = new InMemoryEventSink();
    const deps = { db, ids: new SequentialIdGenerator(), clock: new FixedClock('2026-04-01T00:00:00.000Z'), logger: new MemoryLogger(), events };
    sessions = createSessionStore(deps);
    engine = new NativeEngine({ ...deps, sessions });
  });
  after(async () => dispose());

  async function session(initial: ChatMessage[] = [{ role: 'user', content: 'go' }]) {
    n += 1;
    return engine.createSession({ runId: `run_n${n}`, agentId: `agent_n${n}`, initialMessages: initial });
  }
  function host(model: FakeModelInvoker, tools: FakeDispatcher): EngineHost {
    return fakeHost({ sessions, model, tools, events, eventContext: { runId: `run_n${n}`, correlationId: 'corr', actorId: 'system:test' } });
  }
  const run = (ref: { sessionId: string; engineKind: string }, h: EngineHost, limits = LIMITS) => engine.runTurn({ session: ref, host: h, limits, signal: new AbortController().signal });

  test('kind and version come from the package', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(engine.kind, 'native');
    assert.equal(engine.version, pkg.version);
  });

  test(`parallel-safe calls are bounded to ${PARALLEL_TOOL_CONCURRENCY} in flight`, async () => {
    const ref = await session();
    const gate = { open: false };
    const tools = new FakeDispatcher([
      {
        name: 'read',
        parallelSafe: true,
        handler: async () => {
          const start = Date.now();
          while (!gate.open && Date.now() - start < 200) await new Promise((r) => setTimeout(r, 2));
          return { content: 'r' };
        },
      },
    ]);
    const calls = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, name: 'read', arguments: { i } }));
    const model = new FakeModelInvoker([{ toolCalls: calls }]);
    const p = run(ref, host(model, tools));
    const start = Date.now();
    while (tools.inFlight < PARALLEL_TOOL_CONCURRENCY && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 2));
    gate.open = true;
    const r = await p;
    assert.equal(r.status, 'continue');
    assert.equal(tools.maxInFlight, PARALLEL_TOOL_CONCURRENCY);
    assert.equal(tools.calls.length, 6);
    assert.deepEqual(r.toolResults.map((t) => t.message.toolCallId), calls.map((c) => c.id));
  });

  test('repetition: the repeated call of the stopping turn is not executed', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'deploy', handler: () => ({ content: 'deployed' }) }]);
    const same = { toolCalls: [{ name: 'deploy', arguments: { env: 'sandbox' } }] };
    const model = new FakeModelInvoker([same, same, same]);
    const h = host(model, tools);
    assert.equal((await run(ref, h)).status, 'continue');
    assert.equal((await run(ref, h)).status, 'continue');
    const r = await run(ref, h);
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.failure, { reason: REPETITIVE_LOOP, message: 'the last 3 turns issued identical tool calls' });
    assert.equal(tools.calls.length, 2, 'the third identical deploy never reached the dispatcher');
    assert.equal(r.toolResults[0]!.message.isError, true);
    assert.match(r.toolResults[0]!.message.content, /^not executed: repetitive_loop detected/);
  });

  test('repetition detection is off at threshold 0', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'poll', parallelSafe: true }]);
    const same = { toolCalls: [{ name: 'poll', arguments: { id: 1 } }] };
    const model = new FakeModelInvoker([same, same, same, same]);
    const h = host(model, tools);
    for (let i = 0; i < 4; i++) assert.equal((await run(ref, h, { maxToolCallsPerTurn: 4, repetitionThreshold: 0 })).status, 'continue');
    assert.equal(tools.calls.length, 4);
  });

  test('duplicate or missing tool call ids are made unique before the response is persisted', async () => {
    const response = normalizeResponse({ role: 'assistant', content: [], toolCalls: [{ id: 'x', name: 'a', arguments: {} }, { id: 'x', name: 'b', arguments: {} }, { id: '', name: 'c', arguments: {} }] }, 7);
    assert.deepEqual(response.toolCalls?.map((c) => c.id), ['x', 'call_t7_1', 'call_t7_2']);
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'a' }, { name: 'b' }]);
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'dup', name: 'a', arguments: {} }, { id: 'dup', name: 'b', arguments: {} }] }]);
    const r = await run(ref, host(model, tools));
    assert.equal(r.status, 'continue');
    assert.deepEqual(tools.calls.map((c) => [c.toolCallId, c.invocationId]), [['dup', `${ref.sessionId}:1:dup`], ['call_t1_1', `${ref.sessionId}:1:call_t1_1`]]);
  });

  test('turn events carry the turn outcome (I10)', async () => {
    const ref = await session();
    const before = events.events.length;
    const model = new FakeModelInvoker([{ text: 'hmm' }]);
    await run(ref, host(model, new FakeDispatcher([])));
    const mine = events.events.slice(before).filter((e) => (e.payload as { sessionId?: string }).sessionId === ref.sessionId);
    assert.deepEqual(mine.map((e) => e.eventType), ['agent.turn_started', 'agent.turn_completed']);
    assert.deepEqual(mine[1]!.payload, { sessionId: ref.sessionId, turn: 1, status: 'continue', replayed: false, toolCalls: 0 });
    assert.equal(mine[1]!.agentId, `agent_n${n}`);
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
    const h: EngineHost = { ...host(model, tools), events: flaky };
    await assert.rejects(run(ref, h), /event store down/);
    assert.equal((await sessions.getTurn(ref.sessionId, 1))?.status, 'model_responded');
    fail = false;
    const r = await run(ref, h);
    assert.equal(r.replayed, true);
    assert.equal(model.callCount, 1);
    assert.equal(tools.calls.length, 1);
    assert.equal((await sessions.getTurn(ref.sessionId, 1))?.status, 'completed');
  });

  test('a model fault propagates and leaves the turn started; the retry re-runs the same turn', async () => {
    const ref = await session();
    const model = new FakeModelInvoker([{ throws: new Error('invoker bug') }, { text: 'ok now' }]);
    const h = host(model, new FakeDispatcher([]));
    await assert.rejects(run(ref, h), /invoker bug/);
    assert.equal((await sessions.lastTurn(ref.sessionId))?.status, 'started');
    const r = await run(ref, h);
    assert.equal(r.turn, 1);
    assert.equal(r.status, 'continue');
  });

  test('inputs are drained exactly once into the turn they start', async () => {
    const ref = await session();
    await sessions.enqueueInput(ref.sessionId, [{ role: 'user', content: 'peer: found a 500 on /cart' }]);
    const model = new FakeModelInvoker([{ text: 'noted' }, { text: 'again' }]);
    const r1 = await run(ref, host(model, new FakeDispatcher([])));
    assert.deepEqual(r1.appended[0], { turn: 1, message: { role: 'user', content: 'peer: found a 500 on /cart' } });
    await run(ref, host(model, new FakeDispatcher([])));
    const peer = (await sessions.transcript(ref.sessionId)).filter((e) => e.message.role === 'user' && e.message.content === 'peer: found a 500 on /cart');
    assert.equal(peer.length, 1);
    assert.deepEqual(model.requests[1]!.messages.at(-1), { role: 'user', content: TEXT_ONLY_NUDGE });
  });

  test('input given to a replayed turn is kept for the next turn', async () => {
    const ref = await session();
    const crashing = new FakeDispatcher([{ name: 'x', handler: () => { throw new Error('crash'); } }]);
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'x1', name: 'x', arguments: {} }] }, { text: 'next' }]);
    await assert.rejects(run(ref, host(model, crashing)), /crash/);
    const note: ChatMessage = { role: 'user', content: 'wake-up: op finished' };
    const r = await engine.runTurn({ session: ref, host: host(model, new FakeDispatcher([{ name: 'x' }])), limits: LIMITS, signal: new AbortController().signal, input: [note] });
    assert.equal(r.replayed, true);
    assert.deepEqual(r.appended.map((e) => e.message.role), ['assistant', 'tool']);
    const r2 = await run(ref, host(model, new FakeDispatcher([])));
    assert.deepEqual(r2.appended[0], { turn: 2, message: note });
  });

  test('a retried turn does not duplicate its request input (crash in the model call, crash in context assembly)', async () => {
    const ref = await session();
    const note: ChatMessage = { role: 'user', content: 'operation op_7 finished' };
    const model = new FakeModelInvoker([{ throws: new Error('model worker crashed') }, { text: 'thanks' }]);
    await assert.rejects(engine.runTurn({ session: ref, host: host(model, new FakeDispatcher([])), limits: LIMITS, signal: new AbortController().signal, input: [note] }), /model worker crashed/);
    const r = await engine.runTurn({ session: ref, host: host(model, new FakeDispatcher([])), limits: LIMITS, signal: new AbortController().signal, input: [note] });
    assert.equal(r.turn, 1);
    assert.deepEqual(r.appended.filter((e) => e.message.role === 'user'), [], 'nothing new appended by the retry');
    assert.equal(model.requests[1]!.messages.filter((m) => m.role === 'user' && m.content === note.content).length, 1);

    const ref2 = await session();
    let contextCalls = 0;
    const flaky: EngineHost = {
      ...host(new FakeModelInvoker([{ text: 'ok' }]), new FakeDispatcher([])),
      context: {
        assemble: async (input) => {
          if (contextCalls++ === 0) throw new Error('snapshot store down');
          return { messages: input.transcript.map((e) => e.message), tools: [], snapshot: fakeSnapshot(`run_n${n}`, 'cs_retry') };
        },
      },
    };
    await assert.rejects(engine.runTurn({ session: ref2, host: flaky, limits: LIMITS, signal: new AbortController().signal, input: [note, note] }), /snapshot store down/);
    assert.equal(await sessions.lastTurn(ref2.sessionId), undefined, 'the turn never began');
    await engine.runTurn({ session: ref2, host: flaky, limits: LIMITS, signal: new AbortController().signal, input: [note, note] });
    const t1 = (await sessions.transcript(ref2.sessionId)).filter((e) => e.turn === 1 && e.message.role === 'user');
    assert.equal(t1.length, 2, 'both (identical) inputs of the request, each exactly once');
  });

  test('input handed to a replay is queued once, with the turn completion', async () => {
    const ref = await session();
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'z1', name: 'z', arguments: {} }] }, { text: 'next' }]);
    const crash = new FakeDispatcher([{ name: 'z', handler: () => { throw new Error('crash'); } }]);
    await assert.rejects(run(ref, host(model, crash)), /crash/);
    const note: ChatMessage = { role: 'user', content: 'late peer message' };
    const replay = (d: FakeDispatcher) => engine.runTurn({ session: ref, host: host(model, d), limits: LIMITS, signal: new AbortController().signal, input: [note] });
    await assert.rejects(replay(crash), /crash/);
    assert.deepEqual(await sessions.drainInput(ref.sessionId), [], 'a failed replay queued nothing');
    await replay(new FakeDispatcher([{ name: 'z' }]));
    const r = await run(ref, host(model, new FakeDispatcher([])));
    assert.deepEqual(r.appended.filter((e) => e.message.role === 'user'), [{ turn: 2, message: note }]);
  });

  test('a SessionStore without drainInputInto still drains queued input into the turn', async () => {
    const ref = await session();
    const { drainInputInto: _atomic, ...plain } = sessions;
    await sessions.enqueueInput(ref.sessionId, [{ role: 'user', content: 'queued' }]);
    const model = new FakeModelInvoker([{ text: 'ok' }]);
    const r = await engine.runTurn({ session: ref, host: { ...host(model, new FakeDispatcher([])), sessions: plain }, limits: LIMITS, signal: new AbortController().signal, input: [{ role: 'user', content: 'direct' }] });
    assert.deepEqual(r.appended.slice(0, 2), [{ turn: 1, message: { role: 'user', content: 'queued' } }, { turn: 1, message: { role: 'user', content: 'direct' } }]);
    assert.deepEqual(model.requests[0]!.messages.slice(-2), [{ role: 'user', content: 'queued' }, { role: 'user', content: 'direct' }]);
  });

  test('limits are validated', () => {
    assert.throws(() => validateLimits({ maxToolCallsPerTurn: -1, repetitionThreshold: 3 }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    assert.throws(() => validateLimits({ maxToolCallsPerTurn: 1, repetitionThreshold: 1 }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    assert.throws(() => validateLimits({ maxToolCallsPerTurn: 1.5, repetitionThreshold: 2 }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    validateLimits({ maxToolCallsPerTurn: 0, repetitionThreshold: 0 });
  });

  test('createSession refuses assistant/tool messages as turn-0 input', async () => {
    await assert.rejects(
      engine.createSession({ runId: 'run_x', agentId: 'agent_x', initialMessages: [{ role: 'assistant', content: [] }] }),
      (e: unknown) => isHypertestError(e, 'invalid_argument'),
    );
  });

  test('a dispatcher result without a tool message is a fault; the call stays pending', async () => {
    const ref = await session();
    const broken = {
      definitions: () => [],
      isParallelSafe: () => false,
      dispatch: async () => ({}) as never,
    };
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'b1', name: 'y', arguments: {} }] }]);
    const h: EngineHost = { ...host(model, new FakeDispatcher([])), tools: broken };
    await assert.rejects(run(ref, h), (e: unknown) => isHypertestError(e, 'internal'));
    assert.deepEqual((await sessions.getTurn(ref.sessionId, 1))?.toolCalls.map((c) => c.status), ['pending']);
  });

  test('createSession writes the session and its turn-0 task input atomically', async () => {
    const faulty = faultyDb(db, (sql) => sql.includes('INSERT INTO ht_transcript'));
    const base = { ids: { next: (prefix: string) => `${prefix}_atomic_1` }, clock: new FixedClock('2026-04-01T00:00:00.000Z'), logger: new MemoryLogger() };
    const crashing = new NativeEngine({ ...base, sessions: createSessionStore({ ...base, db: faulty }) });
    const before = (await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM ht_sessions WHERE run_id = 'run_atomic'`)).rows[0]!.n;
    await assert.rejects(crashing.createSession({ runId: 'run_atomic', agentId: 'agent_atomic', initialMessages: [{ role: 'user', content: 'task' }] }), /injected fault/);
    assert.equal(faulty.hits, 1);
    const after = (await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM ht_sessions WHERE run_id = 'run_atomic'`)).rows[0]!.n;
    assert.equal(Number(after), Number(before), 'no session without its task context');
  });

  test('an abort during context assembly (provider throws on abort) is an interruption, not a fault; nothing is recorded', async () => {
    const ref = await session();
    const ctrl = new AbortController();
    const h: EngineHost = {
      ...host(new FakeModelInvoker([]), new FakeDispatcher([])),
      context: {
        assemble: async (input) => {
          ctrl.abort(new Error('worker draining'));
          input.signal.throwIfAborted();
          throw new Error('unreachable');
        },
      },
    };
    const r = await engine.runTurn({ session: ref, host: h, limits: LIMITS, signal: ctrl.signal });
    assert.equal(r.status, 'interrupted');
    assert.equal(r.turn, 1);
    assert.equal(await sessions.lastTurn(ref.sessionId), undefined, 'the turn never began');
    assert.equal((await engine.inspect(ref)).status, 'active');
  });

  test('a model invoker that throws on abort yields interrupted; the turn stays started and re-runs', async () => {
    const ref = await session();
    const ctrl = new AbortController();
    const model = new FakeModelInvoker(async (req, i) => {
      if (i === 0) {
        ctrl.abort(new Error('activity cancelled'));
        req.signal.throwIfAborted();
      }
      return { text: 'second attempt' };
    });
    const r = await engine.runTurn({ session: ref, host: host(model, new FakeDispatcher([])), limits: LIMITS, signal: ctrl.signal });
    assert.equal(r.status, 'interrupted');
    assert.equal((await sessions.lastTurn(ref.sessionId))?.status, 'started');
    const again = await run(ref, host(model, new FakeDispatcher([])));
    assert.equal(again.turn, 1);
    assert.equal(again.status, 'continue');
    // a non-abort fault still propagates
    const ref2 = await session();
    await assert.rejects(run(ref2, host(new FakeModelInvoker([{ throws: new Error('invoker bug') }]), new FakeDispatcher([]))), /invoker bug/);
  });

  test('an interrupt that lands between the status read and the start of the turn still aborts it (no model call)', async () => {
    const ref = await session();
    const model = new FakeModelInvoker([{ text: 'should never be asked' }]);
    let raced = false;
    // The status read returns the pre-interrupt record while the interrupt commits and aborts in-flight turns.
    const racing: SessionStore = {
      ...sessions,
      get: async (id) => {
        const rec = await sessions.get(id);
        if (!raced && id === ref.sessionId) {
          raced = true;
          await engine.interrupt({ session: ref, reason: 'operator stop' });
        }
        return rec;
      },
    };
    const r = await engine.runTurn({ session: ref, host: { ...host(model, new FakeDispatcher([])), sessions: racing }, limits: LIMITS, signal: new AbortController().signal });
    assert.equal(raced, true);
    assert.equal(r.status, 'interrupted');
    assert.equal(model.callCount, 0, 'the interrupted turn never reached the model');
    assert.equal((await engine.inspect(ref)).status, 'interrupted');
  });

  test('repetition is not reset by model-boundary turns in between (no model decision was made there)', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'deploy', handler: () => ({ content: 'deployed' }) }]);
    const same = { toolCalls: [{ name: 'deploy', arguments: { env: 'sandbox' } }] };
    const model = new FakeModelInvoker([same, { boundary: 'retry_next_turn' }, same, { boundary: 'model_unavailable' }, same]);
    const statuses: string[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await run(ref, host(model, tools))).status);
    assert.deepEqual(statuses, ['continue', 'boundary', 'continue', 'boundary', 'failed']);
    assert.equal(tools.calls.length, 2, 'the third identical deploy was not executed');
    assert.deepEqual((await sessions.getTurn(ref.sessionId, 5))?.outcome, { status: 'failed', failure: { reason: REPETITIVE_LOOP, message: 'the last 3 turns issued identical tool calls' } });
    // a different call in between does reset it
    const ref2 = await session();
    const other = { toolCalls: [{ name: 'deploy', arguments: { env: 'staging' } }] };
    const m2 = new FakeModelInvoker([same, { boundary: 'retry_next_turn' }, other, same, same]);
    const s2: string[] = [];
    for (let i = 0; i < 5; i++) s2.push((await run(ref2, host(m2, tools))).status);
    assert.deepEqual(s2, ['continue', 'boundary', 'continue', 'continue', 'continue']);
  });

  test('every finished turn records its outcome with the completion (boundary, continue, waiting, completed)', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'load', handler: () => ({ pendingOperationId: 'op_1' }) }, completeWorkTool()]);
    const model = new FakeModelInvoker([
      { boundary: 'retry_next_turn', message: 'A down' },
      { text: 'thinking' },
      { toolCalls: [{ name: 'load', arguments: {} }] },
      { toolCalls: [{ name: 'complete_work', arguments: { summary: 'ok', evidenceRefs: ['ev_1'] } }] },
    ]);
    for (let i = 0; i < 4; i++) await run(ref, host(model, tools));
    const outcomes = await Promise.all([1, 2, 3, 4].map(async (t) => (await sessions.getTurn(ref.sessionId, t))?.outcome));
    assert.deepEqual(outcomes, [
      { status: 'boundary', boundary: 'retry_next_turn' },
      { status: 'continue' },
      { status: 'waiting', waitingOn: ['op_1'] },
      { status: 'completed', completion: { kind: 'complete', summary: 'ok', evidenceRefs: ['ev_1'], recordRefs: [] } },
    ]);
  });

  test('a replay after a failed commit re-emits turn_completed with the same deterministic event id', async () => {
    const ref = await session();
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'p', name: 'probe', arguments: {} }] }]);
    let failCommit = true;
    const flaky: SessionStore = {
      ...sessions,
      completeTurn: async (...args) => {
        if (failCommit) {
          failCommit = false;
          throw new Error('database connection lost at commit');
        }
        return sessions.completeTurn(...args);
      },
    };
    const before = events.events.length;
    await assert.rejects(engine.runTurn({ session: ref, host: { ...host(model, tools), sessions: flaky }, limits: LIMITS, signal: new AbortController().signal }), /connection lost/);
    const r = await run(ref, host(model, tools));
    assert.equal(r.replayed, true);
    const completed = events.events.slice(before).filter((e) => e.eventType === 'agent.turn_completed' && (e.payload as { sessionId?: string }).sessionId === ref.sessionId);
    assert.deepEqual(completed.map((e) => e.eventId), [turnCompletedEventId(ref.sessionId, 1), turnCompletedEventId(ref.sessionId, 1)], 'an idempotent L0 store keeps one');
    // a boundary turn is re-attempted with a new model call, so its event is not deduplicated
    const ref2 = await session();
    await run(ref2, host(new FakeModelInvoker([{ boundary: 'model_unavailable' }]), tools));
    const boundary = events.events.filter((e) => e.eventType === 'agent.turn_completed' && (e.payload as { sessionId?: string }).sessionId === ref2.sessionId);
    assert.notEqual(boundary[0]?.eventId, turnCompletedEventId(ref2.sessionId, 1));
  });

  test('a retried started turn records the snapshot of the attempt that produced the response', async () => {
    const ref = await session();
    let attempt = 0;
    const model = new FakeModelInvoker([{ throws: new Error('model worker crashed') }, { text: 'ok' }]);
    const h: EngineHost = { ...host(model, new FakeDispatcher([])), context: new FakeContextProvider({ snapshotId: () => `cs_attempt${++attempt}` }) };
    await assert.rejects(run(ref, h), /model worker crashed/);
    assert.equal((await sessions.getTurn(ref.sessionId, 1))?.snapshotId, 'cs_attempt1');
    await run(ref, h);
    assert.deepEqual(model.requests.map((q) => q.snapshotId), ['cs_attempt1', 'cs_attempt2']);
    assert.equal((await sessions.getTurn(ref.sessionId, 1))?.snapshotId, 'cs_attempt2', 'the turn names the snapshot the model actually saw');
  });

  test('dispose aborts and closes the session', async () => {
    const ref = await session();
    await engine.dispose(ref);
    assert.equal((await engine.inspect(ref)).status, 'disposed');
    await assert.rejects(run(ref, host(new FakeModelInvoker([]), new FakeDispatcher([]))), (e: unknown) => isHypertestError(e, 'precondition_failed'));
  });
});

test('resumeChild never un-interrupts a session on a misrouted or malformed resume', async () => {
  const { createTestDatabase } = await import('@hypertest/store');
  const { runtimeMigrations, createSessionStore, NativeEngine } = await import('../src/index.ts');
  const { testDeps } = await import('@hypertest/testkit');
  const { db, dispose } = await createTestDatabase({ migrations: runtimeMigrations });
  try {
    const deps = { db, ...testDeps() };
    const sessions = createSessionStore(deps);
    const engine = new NativeEngine({ ...deps, sessions });
    const ref = await engine.createSession({ runId: 'run_x', agentId: 'ag_x', initialMessages: [{ role: 'user', content: 'task' }] });
    await engine.interrupt({ session: ref, reason: 'test' });
    await assert.rejects(engine.resumeChild({ child: { ...ref, engineKind: 'other' }, host: {} as never, limits: { maxToolCallsPerTurn: 4, repetitionThreshold: 3 }, signal: new AbortController().signal }));
    await assert.rejects(engine.resumeChild({ child: ref, host: {} as never, limits: { maxToolCallsPerTurn: 4, repetitionThreshold: 1 }, signal: new AbortController().signal }));
    assert.equal((await sessions.get(ref.sessionId))?.status, 'interrupted');
  } finally {
    await dispose();
  }
});
