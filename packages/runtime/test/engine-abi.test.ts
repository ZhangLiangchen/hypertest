/**
 * A[4] the AgentEngine ABI is used by the host — not only defined:
 *  - a resumed child (continuable / interrupted) continues through engine.resumeChild (the engine reactivates its child
 *    session) when the engine declares continuableChild; the host emulates it (reactivates the session, runTurn) when not;
 *  - EngineCapabilities choose behaviour: background children are host-emulated, continuable children need peerMessaging
 *    (refused — cannot be emulated — without it), messages are refused to an engine without peerMessaging;
 *  - engine.inspect is the source of each agent's session state for diagnostics (inspectAgents).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isHypertestError, type SqlDatabase } from '@hypertest/core';
import type { ActionCapability, EventContext } from '@hypertest/domain';
import { createRootCapability } from '@hypertest/policy';
import { createTestDatabase } from '@hypertest/store';
import {
  EngineRegistry, FakeDispatcher, FakeModelInvoker, NativeEngine, capabilityModes, childModes, completeWorkTool, createAgentRepository, createAgentRunner, createEpochManager,
  createSessionStore, createSubagentRuntime, fakeHost, inspectAgents, resumePending, runtimeMigrations,
  type AgentEngine, type AgentRepository, type EngineCapabilities, type SessionStore, type SpawnRequest,
} from '../src/index.ts';
import { baseDeps } from './helpers.ts';

const SECRET = 'engine-abi-secret';
const FAR = '2099-01-01T00:00:00.000Z';
const LIMITS = { maxToolCallsPerTurn: 4, repetitionThreshold: 3 };

/** A native engine under another kind, with chosen capabilities, recording which ABI calls the host made. */
class SpyEngine implements AgentEngine {
  readonly kind: string;
  readonly version = 'spy-1';
  readonly capabilities: EngineCapabilities;
  readonly calls: string[] = [];
  readonly #inner: NativeEngine;
  constructor(kind: string, inner: NativeEngine, caps: Partial<EngineCapabilities>) {
    this.kind = kind;
    this.#inner = inner;
    this.capabilities = { ...inner.capabilities, ...caps };
  }
  #ref<T extends { engineKind: string }>(r: T): T {
    return { ...r, engineKind: 'native' };
  }
  async createSession(r: Parameters<AgentEngine['createSession']>[0]) {
    this.calls.push('createSession');
    const ref = await this.#inner.createSession(r);
    return { ...ref, engineKind: 'native' };
  }
  runTurn(r: Parameters<AgentEngine['runTurn']>[0]) {
    this.calls.push('runTurn');
    return this.#inner.runTurn({ ...r, session: this.#ref(r.session) });
  }
  spawnChild(r: Parameters<AgentEngine['spawnChild']>[0]) {
    this.calls.push('spawnChild');
    return this.#inner.spawnChild(r);
  }
  resumeChild(r: Parameters<AgentEngine['resumeChild']>[0]) {
    this.calls.push('resumeChild');
    return this.#inner.resumeChild({ ...r, child: this.#ref(r.child) });
  }
  interrupt(r: Parameters<AgentEngine['interrupt']>[0]) {
    this.calls.push('interrupt');
    return this.#inner.interrupt(r);
  }
  inspect(ref: Parameters<AgentEngine['inspect']>[0]) {
    this.calls.push('inspect');
    return this.#inner.inspect(this.#ref(ref));
  }
  dispose(ref: Parameters<AgentEngine['dispose']>[0]) {
    this.calls.push('dispose');
    return this.#inner.dispose(this.#ref(ref));
  }
}

describe('A[4] the host uses the AgentEngine ABI and EngineCapabilities', () => {
  let db: SqlDatabase;
  let dispose: () => Promise<void>;
  let deps: ReturnType<typeof baseDeps>;
  let sessions: SessionStore;
  let agents: AgentRepository;
  let n = 0;

  before(async () => {
    ({ db, dispose } = await createTestDatabase({ migrations: runtimeMigrations }));
    deps = baseDeps('2026-06-15T00:00:00.000Z');
    sessions = createSessionStore({ ...deps, db });
    agents = createAgentRepository({ ...deps, db });
  });
  after(async () => dispose());

  const ctx = (runId: string): EventContext => ({ runId, correlationId: `corr_${runId}`, actorId: 'system:test' });
  function request(runId: string, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
    return {
      runId, workItemId: `wi_${runId}`, role: 'code_change_analyst', depth: 0, maxDepth: 2,
      capability: (agentId: string): ActionCapability => createRootCapability({ runId, subjectAgentId: agentId, workItemId: `wi_${runId}`, profile: 'test_executor', tools: ['*'], expiresAt: FAR }, SECRET),
      modelPolicy: {}, toolPolicy: { allow: ['*'] }, contextSnapshotId: 'cs_1', initialMessages: [{ role: 'user', content: 'task' }], continuable: false, background: false,
      budget: { maxTurns: 10, maxTokens: 10_000, maxToolCalls: 10, maxWallClockMs: 60_000 }, ...overrides,
    };
  }
  function stack(engine: SpyEngine) {
    const engines = new EngineRegistry([engine]);
    const subagents = createSubagentRuntime({ ...deps, db, agents, sessions, engines, defaultEngineKind: engine.kind, maxAgentsPerRun: 10 });
    const runner = createAgentRunner({ ...deps, db, agents, sessions, engines, subagents });
    return { engines, subagents, runner };
  }

  async function finishTask(runner: ReturnType<typeof createAgentRunner>, agentId: string, summary: string) {
    const model = new FakeModelInvoker([{ toolCalls: [{ name: 'complete_work', arguments: { summary } }] }]);
    return runner.step(agentId, fakeHost({ sessions, model, tools: new FakeDispatcher([completeWorkTool()]) }), { limits: LIMITS, signal: new AbortController().signal });
  }

  test('a continuable child is resumed through engine.resumeChild (continuableChild: true): the ENGINE reactivates its session', async () => {
    const engine = new SpyEngine('spy-native', new NativeEngine({ ...deps, sessions }), {});
    const { subagents, runner } = stack(engine);
    const runId = `run_abi${++n}`;
    const child = await subagents.spawn(request(runId, { continuable: true }), ctx(runId));
    assert.equal((await finishTask(runner, child.agentId, 'task 1')).result.status, 'completed');
    assert.equal((await sessions.get(child.sessionId))!.status, 'completed');
    await subagents.message(child.agentId, { role: 'user', content: 'follow-up question' });
    await subagents.resume(child.agentId);
    assert.equal((await sessions.get(child.sessionId))!.status, 'completed', 'the host did not reactivate the session itself');
    assert.equal(await resumePending(db, child.agentId), true);
    engine.calls.length = 0;
    const out = await finishTask(runner, child.agentId, 'task 2');
    assert.deepEqual(engine.calls, ['resumeChild'], 'the resumed step went through resumeChild, not runTurn');
    assert.equal(out.result.status, 'completed');
    assert.equal(out.result.completion?.summary, 'task 2');
    assert.equal(await resumePending(db, child.agentId), false);
    assert.equal((await subagents.collect(child.agentId)).summary, 'task 2');
    // the next ordinary step is runTurn again
    engine.calls.length = 0;
    await subagents.resume(child.agentId);
    await finishTask(runner, child.agentId, 'task 3');
    assert.deepEqual(engine.calls, ['resumeChild']);
  });

  test('crash window: resumeChild committed the resumed turn but the runner died before clearing the flag — the next step recovers that turn, never runs another', async () => {
    const engine = new SpyEngine('spy-crash', new NativeEngine({ ...deps, sessions }), {});
    const { subagents, runner } = stack(engine);
    const runId = `run_abi${++n}`;
    const child = await subagents.spawn(request(runId, { continuable: true }), ctx(runId));
    assert.equal((await finishTask(runner, child.agentId, 'task 1')).result.status, 'completed');
    await subagents.message(child.agentId, { role: 'user', content: 'follow-up question' });
    await subagents.resume(child.agentId);
    assert.equal(await resumePending(db, child.agentId), true);
    // the runner's step up to the crash: the engine resumed the child and committed its turn ('task 2') — then the process
    // died before resume_pending was cleared and before the agent was settled
    const crashed = await engine.resumeChild({
      child: { sessionId: child.sessionId, engineKind: engine.kind }, host: fakeHost({ sessions, model: new FakeModelInvoker([{ toolCalls: [{ name: 'complete_work', arguments: { summary: 'task 2' } }] }]), tools: new FakeDispatcher([completeWorkTool()]) }),
      limits: LIMITS, signal: new AbortController().signal,
    });
    assert.equal(crashed.status, 'completed');
    assert.equal(await resumePending(db, child.agentId), true, 'the flag survived the crash');
    // the retried step: an empty model script — any model call would fail the turn (before the fix: a second resumed turn
    // ran, superseding the committed 'task 2' completion)
    engine.calls.length = 0;
    const model = new FakeModelInvoker([]);
    const out = await runner.step(child.agentId, fakeHost({ sessions, model, tools: new FakeDispatcher([completeWorkTool()]) }), { limits: LIMITS, signal: new AbortController().signal });
    assert.deepEqual(engine.calls, [], 'neither resumeChild nor runTurn ran again');
    assert.equal(model.requests.length, 0, 'no model call');
    assert.equal(out.result.status, 'completed');
    assert.equal(out.result.completion?.summary, 'task 2');
    assert.equal(await resumePending(db, child.agentId), false, 'the resume is consumed');
    assert.equal((await subagents.collect(child.agentId)).summary, 'task 2', 'the committed resumed turn was settled');
    assert.equal((await sessions.get(child.sessionId))!.turnCount, 2);
  });

  test('crash window with a replayed turn: an interrupted child resumed mid-dispatch, its replayed turn committed — the next step recovers it, never a second turn', async () => {
    const engine = new SpyEngine('spy-replay', new NativeEngine({ ...deps, sessions }), {});
    const { subagents, runner } = stack(engine);
    const runId = `run_abi${++n}`;
    const child = await subagents.spawn(request(runId, { continuable: true }), ctx(runId));
    // turn 1 answers complete_work, but the step dies before the turn commits (its turn_completed event cannot be stored):
    // the turn is left model_responded
    const failing = { emit: async (evs: Parameters<typeof deps.events.emit>[0]) => (evs.some((e) => e.eventType === 'agent.turn_completed') ? Promise.reject(new Error('event store down')) : deps.events.emit(evs)) };
    const tools = new FakeDispatcher([completeWorkTool()]);
    const first = { ...fakeHost({ sessions, model: new FakeModelInvoker([{ toolCalls: [{ name: 'complete_work', arguments: { summary: 'replayed task' } }] }]), tools }), events: failing };
    await assert.rejects(runner.step(child.agentId, first, { limits: LIMITS, signal: new AbortController().signal }), /event store down/);
    assert.equal((await sessions.lastTurn(child.sessionId))?.status, 'model_responded');
    // the parent interrupts the child, then resumes it: the resume goes through resumeChild, which will REPLAY turn 1
    await subagents.interrupt(child.agentId, 'parent re-plans', ctx(runId));
    await subagents.resume(child.agentId);
    assert.equal(await resumePending(db, child.agentId), true);
    // the runner's step up to the crash: resumeChild replayed and committed turn 1 (no model call) — then the process died
    const replay = fakeHost({ sessions, model: new FakeModelInvoker([]), tools: new FakeDispatcher([completeWorkTool()]) });
    const crashed = await engine.resumeChild({ child: { sessionId: child.sessionId, engineKind: engine.kind }, host: replay, limits: LIMITS, signal: new AbortController().signal });
    assert.deepEqual([crashed.status, crashed.replayed, crashed.turn], ['completed', true, 1]);
    // the retried step must settle that turn, not run turn 2 (the turn NUMBER did not move: a replay commits in place)
    engine.calls.length = 0;
    const model = new FakeModelInvoker([]);
    const out = await runner.step(child.agentId, fakeHost({ sessions, model, tools: new FakeDispatcher([completeWorkTool()]) }), { limits: LIMITS, signal: new AbortController().signal });
    assert.deepEqual(engine.calls, [], 'neither resumeChild nor runTurn ran again');
    assert.equal(model.requests.length, 0);
    assert.deepEqual([out.result.status, out.result.completion?.summary], ['completed', 'replayed task']);
    assert.equal(await resumePending(db, child.agentId), false);
    assert.equal((await sessions.get(child.sessionId))!.turnCount, 1, 'no second turn');
  });

  test('an engine without continuable children: the host EMULATES the resume (session reactivated by the host, runTurn)', async () => {
    const engine = new SpyEngine('spy-plain', new NativeEngine({ ...deps, sessions }), { continuableChild: false });
    const { subagents, runner } = stack(engine);
    const runId = `run_abi${++n}`;
    const child = await subagents.spawn(request(runId, { continuable: true }), ctx(runId));
    const spawned = deps.events.events.find((e) => e.eventType === 'agent.spawned' && e.aggregateId === child.agentId)!;
    assert.deepEqual((spawned.payload as { modes: unknown }).modes, { continuable: 'host_emulated', background: null });
    await finishTask(runner, child.agentId, 'task 1');
    await subagents.resume(child.agentId);
    assert.equal((await sessions.get(child.sessionId))!.status, 'active', 'reactivated by the host');
    assert.equal(await resumePending(db, child.agentId), false);
    const resumedEvent = deps.events.events.filter((e) => e.eventType === 'agent.resumed' && e.aggregateId === child.agentId).at(-1)!;
    assert.equal((resumedEvent.payload as { via: string }).via, 'host_emulated');
    engine.calls.length = 0;
    await finishTask(runner, child.agentId, 'task 2');
    assert.deepEqual(engine.calls, ['runTurn']);
  });

  test('what cannot be emulated is refused: a continuable child or a message on an engine without peerMessaging', async () => {
    const engine = new SpyEngine('spy-deaf', new NativeEngine({ ...deps, sessions }), { peerMessaging: false });
    const { subagents } = stack(engine);
    const runId = `run_abi${++n}`;
    await assert.rejects(subagents.spawn(request(runId, { continuable: true }), ctx(runId)), (e: unknown) => isHypertestError(e, 'precondition_failed') && /cannot host a continuable child: it cannot receive its parent's messages \(peerMessaging: false\)/.test((e as Error).message));
    assert.deepEqual(await agents.list({ runId }), [], 'nothing was created');
    const plain = await subagents.spawn(request(runId, { background: true }), ctx(runId));
    const spawned = deps.events.events.find((e) => e.eventType === 'agent.spawned' && e.aggregateId === plain.agentId)!;
    assert.deepEqual((spawned.payload as { modes: unknown }).modes, { continuable: null, background: 'host_emulated' }, 'background children are scheduled by the host');
    await assert.rejects(subagents.message(plain.agentId, { role: 'user', content: 'x' }), (e: unknown) => isHypertestError(e, 'precondition_failed') && /cannot receive messages \(peerMessaging: false\)/.test((e as Error).message));
  });

  test('capability modes: what each engine provides, what the host emulates, what is refused', () => {
    const native = new NativeEngine({ ...deps, sessions });
    assert.deepEqual(capabilityModes(native), {
      providerSwitch: 'engine', continuableChild: 'engine', backgroundChild: 'host_emulated', peerMessaging: 'engine', structuredOutput: 'engine', sandboxProfiles: 'host_emulated',
      nativeCompaction: 'host_emulated', nativeComputerUse: 'host_emulated',
    });
    assert.deepEqual(childModes(native, { continuable: true, background: true }), { continuable: 'engine', background: 'host_emulated' });
    assert.equal(capabilityModes({ capabilities: { ...native.capabilities, peerMessaging: false } }).peerMessaging, 'refused');
  });

  test('engine.inspect is the source of each agent\'s session state (inspectAgents), with its epoch and model pause', async () => {
    const engine = new SpyEngine('spy-inspect', new NativeEngine({ ...deps, sessions }), {});
    const { subagents, runner, engines } = stack(engine);
    const epochs = createEpochManager({ ...deps, db, sessions });
    const runId = `run_abi${++n}`;
    const a = await subagents.spawn(request(runId), ctx(runId));
    await finishTask(runner, a.agentId, 'done');
    await epochs.setModelPause!({ sessionId: a.sessionId, runId, agentId: a.agentId, turn: 1, reason: 'route down', resumeAt: '2026-06-15T00:05:00.000Z', routes: ['r1'], consecutive: 1 });
    engine.calls.length = 0;
    const [view] = await inspectAgents({ agents, engines, epochs }, runId);
    assert.deepEqual(engine.calls, ['inspect']);
    assert.equal(view!.agentId, a.agentId);
    assert.deepEqual(view!.engine, { session: { sessionId: a.sessionId, engineKind: 'native' }, status: 'completed', turnCount: 1, lastTurnStatus: 'completed' });
    assert.equal(view!.capabilities['continuableChild'], 'engine');
    assert.equal(view!.modelPause?.reason, 'route down');
    // an engine that cannot inspect: reported, never fatal
    class Offline extends SpyEngine {
      override async inspect(): Promise<never> {
        throw new Error('engine offline');
      }
    }
    const broken = new EngineRegistry([new Offline('spy-inspect', new NativeEngine({ ...deps, sessions }), {})]);
    const [v2] = await inspectAgents({ agents, engines: broken }, runId);
    assert.deepEqual(v2!.engine, { error: 'engine offline' });
  });
});
