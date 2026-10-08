import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FixedClock, HypertestError, MemoryLogger, SequentialIdGenerator, isHypertestError, type SqlDatabase } from '@hypertest/core';
import { InMemoryEventSink, type ChatMessage, type EventContext } from '@hypertest/domain';
import type { AgentEngine, EngineContractDeps, EngineContractSuiteOptions, EngineHost, EngineSessionRef, RunTurnResult, SessionStore, TurnLimits } from './contracts.ts';
import { runtimeMigrations } from './migrations.ts';
import { createSessionStore } from './sessions.ts';
import { TEXT_ONLY_NUDGE as NUDGE } from './native-engine.ts';
import { FakeContextProvider, FakeDispatcher, FakeModelInvoker, completeWorkTool, failWorkTool, type FakeToolSpec } from './testing.ts';
const LIMITS: TurnLimits = { maxToolCallsPerTurn: 8, repetitionThreshold: 3 };

async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function isCode(code: string): (e: unknown) => boolean {
  return (e: unknown) => isHypertestError(e) && e.code === code;
}

/**
 * The AgentEngine behaviour contract shared by every engine (native, pi, dsh, …). Registers node:test tests; call it at
 * the top level of a test file. One database (migrated with runtimeMigrations) serves the whole suite; each test uses
 * its own session. `makeEngine` may be called several times against the same deps (it simulates a process restart).
 */
export function engineContractSuite(name: string, makeEngine: (deps: EngineContractDeps) => AgentEngine, options: EngineContractSuiteOptions): void {
  if (typeof options?.openDatabase !== 'function') {
    throw new HypertestError('invalid_argument', 'engineContractSuite requires options.openDatabase(migrations) (e.g. createTestDatabase from @hypertest/store)');
  }

  describe(`AgentEngine contract: ${name}`, () => {
    let db: SqlDatabase;
    let dispose: () => Promise<void> = async () => undefined;
    let deps: EngineContractDeps;
    let sessions: SessionStore;
    let events: InMemoryEventSink;
    let seq = 0;

    before(async () => {
      const opened = await options.openDatabase(runtimeMigrations);
      db = opened.db;
      dispose = opened.dispose;
      events = new InMemoryEventSink();
      const base = { db, ids: new SequentialIdGenerator(), clock: new FixedClock('2026-03-01T00:00:00.000Z'), logger: new MemoryLogger(), events };
      sessions = createSessionStore(base);
      deps = { ...base, sessions };
    });
    after(async () => dispose());

    async function newSession(engine: AgentEngine, initialMessages: ChatMessage[] = [{ role: 'user', content: 'task: exercise the engine contract' }]): Promise<{ ref: EngineSessionRef; runId: string; agentId: string }> {
      seq += 1;
      const runId = `run_contract${seq}`;
      const agentId = `agent_contract${seq}`;
      const ref = await engine.createSession({ runId, agentId, initialMessages });
      return { ref, runId, agentId };
    }

    function host(model: FakeModelInvoker, tools: FakeDispatcher, runId = 'run_contract'): EngineHost {
      const eventContext: EventContext = { runId, correlationId: `corr_${runId}`, actorId: 'system:contract' };
      return { model, tools, context: new FakeContextProvider({ tools: () => tools.definitions(), runId }), sessions, eventContext, events };
    }

    function turn(engine: AgentEngine, ref: EngineSessionRef, h: EngineHost, extra: { limits?: TurnLimits; signal?: AbortSignal; input?: ChatMessage[] } = {}): Promise<RunTurnResult> {
      const req: Parameters<AgentEngine['runTurn']>[0] = { session: ref, host: h, limits: extra.limits ?? LIMITS, signal: extra.signal ?? new AbortController().signal };
      if (extra.input) req.input = extra.input;
      return engine.runTurn(req);
    }

    test('declares its identity and creates sessions of its own kind', async () => {
      const engine = makeEngine(deps);
      assert.equal(typeof engine.kind, 'string');
      assert.ok(engine.kind.length > 0);
      assert.equal(typeof engine.version, 'string');
      assert.ok(engine.version.length > 0);
      for (const k of ['providerSwitch', 'continuableChild', 'backgroundChild', 'peerMessaging', 'structuredOutput', 'sandboxProfiles', 'nativeCompaction', 'nativeComputerUse'] as const) {
        assert.equal(typeof engine.capabilities[k], 'boolean', `capabilities.${k}`);
      }
      const { ref } = await newSession(engine);
      assert.equal(ref.engineKind, engine.kind);
      assert.equal((await sessions.get(ref.sessionId))?.engineKind, engine.kind);
    });

    test('session persistence: initial messages are turn-0 input and the state survives an engine restart', async () => {
      const engine = makeEngine(deps);
      const initial: ChatMessage[] = [
        { role: 'system', content: 'you are the contract agent' },
        { role: 'user', content: 'check the login flow' },
      ];
      const { ref, runId } = await newSession(engine, initial);
      assert.deepEqual(await engine.inspect(ref), { session: ref, status: 'active', turnCount: 0 });
      assert.deepEqual(await sessions.transcript(ref.sessionId), initial.map((message) => ({ turn: 0, message })));

      const restarted = makeEngine(deps);
      const model = new FakeModelInvoker([{ text: 'looking around' }]);
      const r = await turn(restarted, ref, host(model, new FakeDispatcher([]), runId));
      assert.equal(r.turn, 1);
      assert.equal(r.status, 'continue');
      assert.deepEqual(model.requests[0]!.messages, initial, 'the model sees the persisted turn-0 input');
      const state = await engine.inspect(ref);
      assert.equal(state.turnCount, 1);
      assert.equal(state.lastTurnStatus, 'completed');
      assert.equal(state.status, 'active');
    });

    test('persists the response before any tool runs; a crashed turn replays without the model and re-dispatches only the unsettled call with its recorded invocation id', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      let statusSeenByFirstTool: string | undefined;
      const crashing = new FakeDispatcher([
        {
          name: 'probe_a',
          handler: async (_call, meta) => {
            statusSeenByFirstTool = (await sessions.getTurn(meta.sessionId, meta.turn))?.status;
            return { content: 'a=1' };
          },
        },
        { name: 'probe_b', handler: () => { throw new Error('dispatcher crashed'); } },
      ]);
      const model = new FakeModelInvoker([{ text: 'probing', toolCalls: [{ id: 'c1', name: 'probe_a', arguments: { x: 1 } }, { id: 'c2', name: 'probe_b', arguments: { y: 2 } }] }]);
      await assert.rejects(turn(engine, ref, host(model, crashing, runId)), /dispatcher crashed/);
      assert.equal(statusSeenByFirstTool, 'model_responded', 'the response was persisted before the first tool ran');

      const crashed = await sessions.getTurn(ref.sessionId, 1);
      assert.equal(crashed?.status, 'model_responded');
      assert.deepEqual(crashed?.response?.toolCalls?.map((c) => c.id), ['c1', 'c2']);
      assert.deepEqual(crashed?.toolCalls.map((c) => [c.toolCallId, c.status, c.invocationId]), [
        ['c1', 'settled', `${ref.sessionId}:1:c1`],
        ['c2', 'pending', `${ref.sessionId}:1:c2`],
      ]);
      assert.deepEqual(crashing.calls.map((c) => [c.name, c.invocationId]), [['probe_a', `${ref.sessionId}:1:c1`], ['probe_b', `${ref.sessionId}:1:c2`]]);

      const restarted = makeEngine(deps);
      const noModel = new FakeModelInvoker([]);
      const healthy = new FakeDispatcher([{ name: 'probe_a' }, { name: 'probe_b', handler: () => ({ content: 'b=2' }) }]);
      const r = await turn(restarted, ref, host(noModel, healthy, runId));
      assert.equal(noModel.callCount, 0, 'a replay never calls the model');
      assert.equal(r.replayed, true);
      assert.equal(r.turn, 1);
      assert.equal(r.status, 'continue');
      assert.deepEqual(healthy.calls.map((c) => [c.name, c.toolCallId, c.invocationId]), [['probe_b', 'c2', `${ref.sessionId}:1:c2`]]);
      assert.deepEqual(r.toolResults.map((t) => [t.message.toolCallId, t.message.content]), [['c1', 'a=1'], ['c2', 'b=2']]);
      const done = await sessions.getTurn(ref.sessionId, 1);
      assert.equal(done?.status, 'completed');
      const t1 = (await sessions.transcript(ref.sessionId)).filter((e) => e.turn === 1).map((e) => e.message);
      assert.deepEqual(t1.map((m) => m.role), ['assistant', 'tool', 'tool']);
      assert.deepEqual(t1.slice(1).map((m) => (m.role === 'tool' ? [m.toolCallId, m.content] : null)), [['c1', 'a=1'], ['c2', 'b=2']]);
    });

    test('completion: a complete signal ends the loop as completed and closes the session', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      const tools = new FakeDispatcher([completeWorkTool()]);
      const model = new FakeModelInvoker([{ toolCalls: [{ name: 'complete_work', arguments: { summary: 'all good', output: { verdict: 'ok' }, evidenceRefs: ['ev_1'], recordRefs: ['rec_1'] } }] }]);
      const r = await turn(engine, ref, host(model, tools, runId));
      assert.equal(r.status, 'completed');
      assert.deepEqual(r.completion, { kind: 'complete', summary: 'all good', output: { verdict: 'ok' }, evidenceRefs: ['ev_1'], recordRefs: ['rec_1'] });
      assert.equal((await engine.inspect(ref)).status, 'completed');
      await assert.rejects(turn(engine, ref, host(new FakeModelInvoker([]), tools, runId)), isCode('precondition_failed'));
    });

    test('fail: a fail signal ends the loop as failed', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      const model = new FakeModelInvoker([{ toolCalls: [{ name: 'fail_work', arguments: { reason: 'blocked', message: 'environment is down' } }] }]);
      const r = await turn(engine, ref, host(model, new FakeDispatcher([failWorkTool()]), runId));
      assert.equal(r.status, 'failed');
      assert.deepEqual(r.failure, { reason: 'blocked', message: 'environment is down' });
      assert.equal(r.completion, undefined);
      assert.equal((await engine.inspect(ref)).status, 'failed');
    });

    test('waiting: pending operations put the session in waiting; a later turn with the operation result continues', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      const tools = new FakeDispatcher([{ name: 'load_start', handler: () => ({ content: 'load job started', pendingOperationId: 'op_load_1' }) }]);
      const model = new FakeModelInvoker([{ toolCalls: [{ name: 'load_start', arguments: { rps: 10 } }] }, { text: 'reading the result' }]);
      const r1 = await turn(engine, ref, host(model, tools, runId));
      assert.equal(r1.status, 'waiting');
      assert.deepEqual(r1.waitingOn, ['op_load_1']);
      assert.equal((await engine.inspect(ref)).status, 'waiting');
      const note: ChatMessage = { role: 'user', content: 'operation op_load_1 verified: p99 120ms' };
      const r2 = await turn(engine, ref, host(model, tools, runId), { input: [note] });
      assert.equal(r2.turn, 2);
      assert.equal(r2.status, 'continue');
      assert.deepEqual(model.requests[1]!.messages.at(-1), note);
      assert.equal((await engine.inspect(ref)).status, 'active');
    });

    test('boundary: a failed model invocation ends the turn before any tool runs; the next turn is a new turn', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      const tools = new FakeDispatcher([{ name: 'probe' }]);
      const model = new FakeModelInvoker([{ boundary: 'retry_next_turn', message: 'route A unavailable' }, { toolCalls: [{ name: 'probe', arguments: {} }] }]);
      const r1 = await turn(engine, ref, host(model, tools, runId));
      assert.equal(r1.status, 'boundary');
      assert.equal(r1.boundary, 'retry_next_turn');
      assert.deepEqual(r1.toolResults, []);
      assert.equal(tools.calls.length, 0);
      assert.equal((await sessions.getTurn(ref.sessionId, 1))?.status, 'boundary');
      const r2 = await turn(engine, ref, host(model, tools, runId));
      assert.equal(r2.turn, 2);
      assert.equal(r2.status, 'continue');
      assert.equal(tools.calls.length, 1);
    });

    test('text-only turn: the nudge is queued and is the next turn’s input', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      const model = new FakeModelInvoker([{ text: 'I think the login works.' }, { text: 'still thinking' }]);
      const r1 = await turn(engine, ref, host(model, new FakeDispatcher([]), runId));
      assert.equal(r1.status, 'continue');
      assert.deepEqual(r1.toolResults, []);
      await turn(engine, ref, host(model, new FakeDispatcher([]), runId));
      const seen = model.requests[1]!.messages;
      assert.deepEqual(seen.slice(-2), [{ role: 'assistant', content: [{ type: 'text', text: 'I think the login works.' }] }, { role: 'user', content: NUDGE }]);
      assert.deepEqual((await sessions.transcript(ref.sessionId)).filter((e) => e.turn === 2)[0], { turn: 2, message: { role: 'user', content: NUDGE } });
    });

    test('repetition: identical tool calls in the last repetitionThreshold turns stop the loop as repetitive_loop', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      const tools = new FakeDispatcher([{ name: 'look', parallelSafe: true }]);
      const call = (q: string) => ({ toolCalls: [{ name: 'look', arguments: { q, page: 1 } }] });
      const model = new FakeModelInvoker([call('a'), call('b'), call('b'), call('b')]);
      const statuses: string[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await turn(engine, ref, host(model, tools, runId))).status);
      assert.deepEqual(statuses, ['continue', 'continue', 'continue', 'failed']);
      const last = await sessions.getTurn(ref.sessionId, 4);
      assert.equal(last?.status, 'completed');
      assert.equal((await engine.inspect(ref)).status, 'failed');
      const r = await sessions.lastTurn(ref.sessionId);
      assert.equal(r?.turn, 4);
    });

    test('parallel-safe calls overlap; other calls run alone and in order', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      let arrived = 0;
      const barrier = async (): Promise<void> => {
        arrived += 1;
        const start = Date.now();
        while (arrived < 2 && Date.now() - start < 1500) await new Promise((r) => setTimeout(r, 2));
      };
      let inFlight = (): number => 0;
      const tools: FakeDispatcher = new FakeDispatcher([
        { name: 'read_a', parallelSafe: true, handler: async () => { await barrier(); return { content: 'A' }; } },
        { name: 'read_b', parallelSafe: true, handler: async () => { await barrier(); return { content: 'B' }; } },
        { name: 'write_x', handler: async () => ({ content: `X alone=${inFlight() === 1}` }) },
        { name: 'read_c', parallelSafe: true, handler: async () => ({ content: 'C' }) },
      ]);
      inFlight = () => tools.inFlight;
      const model = new FakeModelInvoker([
        { toolCalls: [{ id: 'a', name: 'read_a', arguments: {} }, { id: 'b', name: 'read_b', arguments: {} }, { id: 'x', name: 'write_x', arguments: {} }, { id: 'c', name: 'read_c', arguments: {} }] },
      ]);
      const r = await turn(engine, ref, host(model, tools, runId));
      assert.equal(r.status, 'continue');
      assert.equal(tools.maxInFlight, 2, 'the two leading parallel-safe reads overlapped');
      const at = (s: string) => tools.log.indexOf(s);
      assert.ok(at('start:write_x:x') > at('end:read_a:a') && at('start:write_x:x') > at('end:read_b:b'), `write waits for the reads: ${tools.log.join(' ')}`);
      assert.ok(at('start:read_c:c') > at('end:write_x:x'), `later reads wait for the write: ${tools.log.join(' ')}`);
      assert.deepEqual(r.toolResults.map((t) => t.message.content), ['A', 'B', 'X alone=true', 'C'], 'results keep the call order');
    });

    test('abort mid-dispatch: interrupted, no fabricated results; the next turn replays the unsettled calls', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      const ctrl = new AbortController();
      const tools = new FakeDispatcher([
        { name: 'step_one', handler: () => { ctrl.abort(new Error('worker shutting down')); return { content: 'partial output' }; } },
        { name: 'step_two' },
      ]);
      const model = new FakeModelInvoker([{ toolCalls: [{ id: 's1', name: 'step_one', arguments: {} }, { id: 's2', name: 'step_two', arguments: {} }] }]);
      const r = await turn(engine, ref, host(model, tools, runId), { signal: ctrl.signal });
      assert.equal(r.status, 'interrupted');
      assert.deepEqual(r.toolResults, []);
      assert.deepEqual(tools.calls.map((c) => c.name), ['step_one']);
      const t = await sessions.getTurn(ref.sessionId, 1);
      assert.equal(t?.status, 'model_responded');
      assert.deepEqual(t?.toolCalls.map((c) => c.status), ['pending', 'pending']);
      assert.equal((await engine.inspect(ref)).status, 'active', 'an abort is not an interrupt: the session stays runnable');

      const again = new FakeDispatcher([{ name: 'step_one', handler: () => ({ content: 'one' }) }, { name: 'step_two', handler: () => ({ content: 'two' }) }]);
      const noModel = new FakeModelInvoker([]);
      const r2 = await turn(engine, ref, host(noModel, again, runId));
      assert.equal(r2.replayed, true);
      assert.equal(r2.status, 'continue');
      assert.equal(noModel.callCount, 0);
      assert.deepEqual(again.calls.map((c) => [c.name, c.invocationId]), [['step_one', `${ref.sessionId}:1:s1`], ['step_two', `${ref.sessionId}:1:s2`]]);
      assert.deepEqual(r2.toolResults.map((x) => x.message.content), ['one', 'two']);
    });

    test('interrupt: aborts the running turn, marks the session interrupted, refuses turns until resumed', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      const tools = new FakeDispatcher([]);
      const model = new FakeModelInvoker([{ hangUntilAborted: true }, { text: 'back again' }]);
      const running = turn(engine, ref, host(model, tools, runId));
      await until(() => model.callCount === 1, 'the model call');
      await engine.interrupt({ session: ref, reason: 'operator stop' });
      const r = await running;
      assert.equal(r.status, 'interrupted');
      assert.equal(r.turn, 1);
      assert.equal((await engine.inspect(ref)).status, 'interrupted');
      assert.equal((await sessions.getTurn(ref.sessionId, 1))?.status, 'started', 'nothing was recorded for the interrupted turn');
      await assert.rejects(turn(engine, ref, host(model, tools, runId)), isCode('precondition_failed'));
      const resumed = await engine.resumeChild({ child: ref, host: host(model, tools, runId), limits: LIMITS, signal: new AbortController().signal });
      assert.equal(resumed.turn, 1, 'the interrupted turn is re-run');
      assert.equal(resumed.status, 'continue');
      assert.equal((await engine.inspect(ref)).status, 'active');
    });

    test('an interrupt that lands while the turn runs (e.g. from another process) is not undone by the turn completion', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      // Another worker marks the session interrupted while this turn's tool runs; this engine instance cannot abort.
      const tools = new FakeDispatcher([{ name: 'probe', handler: async (_c, meta) => { await sessions.setStatus(meta.sessionId, 'interrupted'); return { content: 'probed' }; } }]);
      const model = new FakeModelInvoker([{ toolCalls: [{ name: 'probe', arguments: {} }] }, { text: 'after resume' }]);
      await turn(engine, ref, host(model, tools, runId));
      assert.equal((await engine.inspect(ref)).status, 'interrupted');
      await assert.rejects(turn(engine, ref, host(model, tools, runId)), isCode('precondition_failed'));
      assert.equal(model.callCount, 1);
      const resumed = await engine.resumeChild({ child: ref, host: host(model, tools, runId), limits: LIMITS, signal: new AbortController().signal });
      assert.equal(resumed.turn, 2);
    });

    test('an abort during context assembly is an interruption (nothing recorded), not a fault', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      const ctrl = new AbortController();
      const model = new FakeModelInvoker([]);
      const h: EngineHost = {
        ...host(model, new FakeDispatcher([]), runId),
        context: {
          assemble: async (input) => {
            ctrl.abort(new Error('worker draining'));
            input.signal.throwIfAborted();
            throw new Error('unreachable: the signal was aborted');
          },
        },
      };
      const r = await turn(engine, ref, h, { signal: ctrl.signal });
      assert.equal(r.status, 'interrupted');
      assert.equal(model.callCount, 0);
      assert.equal(await sessions.lastTurn(ref.sessionId), undefined);
    });

    test('a terminal turn records its outcome with the completion (durable recovery of an unsettled agent)', async () => {
      const engine = makeEngine(deps);
      const done = await newSession(engine);
      const model = new FakeModelInvoker([{ toolCalls: [{ name: 'complete_work', arguments: { summary: 'all good', output: { n: 1 }, evidenceRefs: ['ev_9'] } }] }]);
      const r = await turn(engine, done.ref, host(model, new FakeDispatcher([completeWorkTool()]), done.runId));
      assert.deepEqual((await sessions.getTurn(done.ref.sessionId, r.turn))?.outcome, { status: 'completed', completion: r.completion });
      const failed = await newSession(engine);
      const m2 = new FakeModelInvoker([{ toolCalls: [{ name: 'fail_work', arguments: { reason: 'blocked', message: 'env down' } }] }]);
      const r2 = await turn(engine, failed.ref, host(m2, new FakeDispatcher([failWorkTool()]), failed.runId));
      assert.deepEqual((await sessions.getTurn(failed.ref.sessionId, r2.turn))?.outcome, { status: 'failed', failure: { reason: 'blocked', message: 'env down' } });
    });

    test('malformed arguments: an error tool result, never a dispatch', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      const tools = new FakeDispatcher([{ name: 'probe' }]);
      const model = new FakeModelInvoker([{ toolCalls: [{ id: 'm1', name: 'probe', rawArguments: '{"path": "a.txt"' }] }, { text: 'retrying' }]);
      const r = await turn(engine, ref, host(model, tools, runId));
      assert.equal(r.status, 'continue');
      assert.equal(tools.calls.length, 0);
      assert.equal(r.toolResults.length, 1);
      assert.equal(r.toolResults[0]!.message.isError, true);
      assert.match(r.toolResults[0]!.message.content, /malformed/i);
      await turn(engine, ref, host(model, tools, runId));
      const seen = model.requests[1]!.messages.at(-1);
      assert.equal(seen?.role, 'tool');
      assert.equal(seen?.role === 'tool' && seen.toolCallId, 'm1');
    });

    test('per-turn tool-call limit: calls beyond maxToolCallsPerTurn get an error result and are not dispatched', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      const tools = new FakeDispatcher([{ name: 'probe' }]);
      const model = new FakeModelInvoker([{ toolCalls: [{ id: 'p1', name: 'probe', arguments: { n: 1 } }, { id: 'p2', name: 'probe', arguments: { n: 2 } }, { id: 'p3', name: 'probe', arguments: { n: 3 } }] }]);
      const r = await turn(engine, ref, host(model, tools, runId), { limits: { maxToolCallsPerTurn: 1, repetitionThreshold: 3 } });
      assert.deepEqual(tools.calls.map((c) => c.toolCallId), ['p1']);
      assert.deepEqual(r.toolResults.map((t) => [t.message.toolCallId, t.message.isError === true]), [['p1', false], ['p2', true], ['p3', true]]);
      assert.match(r.toolResults[1]!.message.content, /too many tool calls in one turn/);
    });

    test('resumeChild (A[4]): a continuable child\'s completed task is resumed by the engine with its queued input; failed or disposed sessions are refused', async () => {
      const engine = makeEngine(deps);
      const { ref, runId } = await newSession(engine);
      const tools = new FakeDispatcher([completeWorkTool()]);
      const model = new FakeModelInvoker([
        { toolCalls: [{ name: 'complete_work', arguments: { summary: 'task 1' } }] },
        { toolCalls: [{ name: 'complete_work', arguments: { summary: 'task 2' } }] },
      ]);
      assert.equal((await turn(engine, ref, host(model, tools, runId))).status, 'completed');
      assert.equal((await engine.inspect(ref)).status, 'completed');
      // the parent's follow-up arrives through the session inbox; the host resumes the child through the engine
      await sessions.enqueueInput(ref.sessionId, [{ role: 'user', content: 'FOLLOW-UP from the parent' }]);
      const r = await engine.resumeChild({ child: ref, host: host(model, tools, runId), limits: LIMITS, signal: new AbortController().signal });
      assert.equal(r.status, 'completed');
      assert.equal(r.completion?.summary, 'task 2');
      assert.ok(JSON.stringify(model.requests[1]!.messages).includes('FOLLOW-UP from the parent'), 'the resumed turn saw the queued input');
      assert.equal((await engine.inspect(ref)).turnCount, 2);
      const failed = await newSession(engine);
      await sessions.setStatus(failed.ref.sessionId, 'failed');
      await assert.rejects(engine.resumeChild({ child: failed.ref, host: host(model, tools, failed.runId), limits: LIMITS, signal: new AbortController().signal }), isCode('precondition_failed'));
      assert.equal((await engine.inspect(failed.ref)).status, 'failed', 'never reactivated');
      const gone = await newSession(engine);
      await engine.dispose(gone.ref);
      await assert.rejects(engine.resumeChild({ child: gone.ref, host: host(model, tools, gone.runId), limits: LIMITS, signal: new AbortController().signal }), isCode('precondition_failed'));
    });

    test('spawnChild: the child session holds only its own task context', async () => {
      const engine = makeEngine(deps);
      const { ref: parent, runId } = await newSession(engine, [{ role: 'user', content: 'PARENT-ONLY secret plan' }]);
      const childTask: ChatMessage = { role: 'user', content: 'child task: verify the checkout endpoint' };
      const child = await engine.spawnChild({ parent, child: { runId, agentId: `agent_child${seq}`, initialMessages: [childTask] } });
      assert.equal(child.agentId, `agent_child${seq}`);
      assert.equal(child.session.engineKind, engine.kind);
      assert.notEqual(child.session.sessionId, parent.sessionId);
      assert.deepEqual(await sessions.transcript(child.session.sessionId), [{ turn: 0, message: childTask }]);
      const tools: FakeToolSpec[] = [completeWorkTool()];
      const model = new FakeModelInvoker([{ toolCalls: [{ name: 'complete_work', arguments: { summary: 'checkout ok' } }] }]);
      const r = await engine.resumeChild({ child: child.session, host: host(model, new FakeDispatcher(tools), runId), limits: LIMITS, signal: new AbortController().signal });
      assert.equal(r.status, 'completed');
      assert.ok(!JSON.stringify(model.requests[0]!.messages).includes('PARENT-ONLY'), 'the parent transcript never reaches the child');
    });
  });
}
