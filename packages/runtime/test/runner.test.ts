import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { HypertestError, isHypertestError, type SqlDatabase } from '@hypertest/core';
import { type ActionCapability, type ChatMessage, type EventContext, type ToolCall, type ToolDefinition, type WorkBudget } from '@hypertest/domain';
import { ModelCatalog, ProviderRegistry, ScriptedProvider, createModelRouter, type ScriptedBrain } from '@hypertest/model';
import { BuiltinPolicyEngine, DEFAULT_POLICY_RULES, createPolicyDecisionLog, createRootCapability, policyMigrations } from '@hypertest/policy';
import { PromptAssembler, contextMigrations, createSnapshotStore, createWorkingContextManager, type SnapshotStore } from '@hypertest/context';
import {
  ToolRegistry, createEnvironmentRegistry, createToolRuntime, createWorkspaceManager, toolNameToId,
  type ToolRuntime, type ToolRuntimeDeps, type ToolSpec, type WorkspaceHandle,
} from '@hypertest/tools';
import { createTestDatabase } from '@hypertest/store';
import { tempDir } from '@hypertest/testkit';
import {
  EngineRegistry, FakeDispatcher, FakeModelInvoker, NativeEngine, buildRuntimeManifest, completeWorkTool, createAgentRepository, createAgentRunner, createEpochManager,
  createModelInvoker, createSessionStore, createSubagentRuntime, fakeHost, runtimeMigrations,
  type AgentRepository, type AgentRunner, type BudgetPort, type ContextProvider, type DispatchResult, type EngineHost, type EpochManager, type SessionStore, type SpawnRequest,
  type SubagentRuntime, type TerminalSignal, type ToolDispatcher, type TurnContext, type TurnLimits, type TurnRecord,
} from '../src/index.ts';
import { recoveredResult, recoveredWaiting } from '../src/runner.ts';
import { baseDeps } from './helpers.ts';

const SECRET = 'runtime-runner-capability-secret';
const FAR = '2099-01-01T00:00:00.000Z';
const LIMITS: TurnLimits = { maxToolCallsPerTurn: 8, repetitionThreshold: 3 };
const BUDGET: WorkBudget = { maxTurns: 10, maxTokens: 1_000_000, maxToolCalls: 50, maxWallClockMs: 3_600_000 };

describe('AgentRunner', () => {
  let db: SqlDatabase;
  let dispose: () => Promise<void>;
  let deps: ReturnType<typeof baseDeps>;
  let sessions: SessionStore;
  let agents: AgentRepository;
  let subagents: SubagentRuntime;
  let runner: AgentRunner;
  let epochs: EpochManager;
  let engines: EngineRegistry;
  let n = 0;

  before(async () => {
    ({ db, dispose } = await createTestDatabase({ migrations: [...runtimeMigrations, ...contextMigrations, ...policyMigrations] }));
    deps = baseDeps('2026-07-01T00:00:00.000Z');
    sessions = createSessionStore({ ...deps, db });
    agents = createAgentRepository({ ...deps, db });
    engines = new EngineRegistry([new NativeEngine({ ...deps, sessions })]);
    subagents = createSubagentRuntime({ ...deps, db, agents, sessions, engines, defaultEngineKind: 'native', maxAgentsPerRun: 50 });
    runner = createAgentRunner({ ...deps, db, agents, sessions, engines, subagents });
    epochs = createEpochManager({ ...deps, db, sessions });
  });
  after(async () => dispose());

  const ctx = (runId: string, agentId?: string): EventContext => {
    const c: EventContext = { runId, correlationId: `corr_${runId}`, actorId: 'system:worker' };
    if (agentId) c.agentId = agentId;
    return c;
  };

  async function spawn(overrides: Partial<SpawnRequest> = {}, capture?: (cap: ActionCapability) => void) {
    n += 1;
    const runId = overrides.runId ?? `run_r${n}`;
    const workItemId = overrides.workItemId ?? `wi_r${n}`;
    const request: SpawnRequest = {
      runId,
      workItemId,
      role: 'executor',
      depth: 0,
      maxDepth: 2,
      capability: (agentId) => {
        const cap = createRootCapability({ runId, subjectAgentId: agentId, workItemId, profile: 'test_executor', tools: ['calc.add'], expiresAt: FAR }, SECRET);
        capture?.(cap);
        return cap;
      },
      modelPolicy: {},
      toolPolicy: { allow: ['*'] },
      contextSnapshotId: 'cs_spawn',
      initialMessages: [{ role: 'user', content: 'Compute 2+3 with the calculator, then complete the work with {"sum": <result>}.' }],
      continuable: false,
      background: false,
      budget: BUDGET,
      ...overrides,
    };
    return subagents.spawn(request, ctx(runId));
  }

  const fakeFactory = (model: FakeModelInvoker, tools: FakeDispatcher) => async (): Promise<EngineHost> => fakeHost({ sessions, model, tools, events: deps.events });
  const loop = (agentId: string, model: FakeModelInvoker, tools: FakeDispatcher, budget: Partial<WorkBudget> = {}, signal = new AbortController().signal) =>
    runner.run(agentId, fakeFactory(model, tools), { limits: LIMITS, budget: { ...BUDGET, ...budget }, signal });

  test('run loops turns until completion and settles the result for the parent', async () => {
    const agent = await spawn();
    const tools = new FakeDispatcher([{ name: 'probe', handler: (c) => ({ content: `probed ${JSON.stringify(c.arguments)}` }) }, completeWorkTool()]);
    const model = new FakeModelInvoker([
      { text: 'let me look' },
      { toolCalls: [{ name: 'probe', arguments: { path: '/health' } }] },
      { toolCalls: [{ name: 'complete_work', arguments: { summary: 'health ok', output: { healthy: true }, evidenceRefs: ['ev_h'] } }] },
    ]);
    const out = await loop(agent.agentId, model, tools);
    assert.equal(out.result.status, 'completed');
    assert.equal(out.result.turn, 3);
    assert.equal(out.agent.status, 'completed');
    assert.deepEqual(await subagents.collect(agent.agentId), { agentId: agent.agentId, status: 'completed', summary: 'health ok', output: { healthy: true }, evidenceRefs: ['ev_h'], recordRefs: [] });
    await assert.rejects(runner.step(agent.agentId, await fakeFactory(model, tools)(), { limits: LIMITS, signal: new AbortController().signal }), (e: unknown) => isHypertestError(e, 'precondition_failed'));
  });

  test('turn budget: the loop ends as failed/budget_exhausted — never silently', async () => {
    const agent = await spawn();
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const model = new FakeModelInvoker((_req, i) => ({ toolCalls: [{ name: 'probe', arguments: { page: i } }] }));
    const out = await loop(agent.agentId, model, tools, { maxTurns: 3 });
    assert.equal(model.callCount, 3);
    assert.equal(out.result.status, 'failed');
    assert.deepEqual(out.result.failure, { reason: 'budget_exhausted', message: 'maxTurns 3 reached' });
    assert.equal(out.result.turn, 3);
    assert.equal(out.agent.status, 'failed');
    assert.equal((await sessions.get(agent.sessionId))?.status, 'failed');
    assert.deepEqual((await subagents.collect(agent.agentId)).failure, { reason: 'budget_exhausted', message: 'maxTurns 3 reached' });
  });

  test('tool-call budget clamps the per-turn limit, then exhausts', async () => {
    const agent = await spawn();
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const model = new FakeModelInvoker((_req, i) => ({ toolCalls: [{ name: 'probe', arguments: { i, k: 1 } }, { name: 'probe', arguments: { i, k: 2 } }] }));
    const out = await loop(agent.agentId, model, tools, { maxToolCalls: 3 });
    assert.equal(tools.calls.length, 3, 'exactly the budgeted number of calls was dispatched');
    const t2 = await sessions.getTurn(agent.sessionId, 2);
    assert.equal(t2?.toolCalls[1]?.result?.isError, true);
    assert.match(t2?.toolCalls[1]?.result?.content ?? '', /too many tool calls in one turn \(limit 1\)/);
    assert.deepEqual(out.result.failure, { reason: 'budget_exhausted', message: 'maxToolCalls 3 reached' });
  });

  test('token and wall-clock budgets', async () => {
    const a1 = await spawn();
    const m1 = new FakeModelInvoker((_req, i) => ({ toolCalls: [{ name: 'probe', arguments: { i } }], usage: { inputTokens: 600, outputTokens: 500 } }));
    const o1 = await loop(a1.agentId, m1, new FakeDispatcher([{ name: 'probe' }]), { maxTokens: 2000 });
    assert.equal(m1.callCount, 2);
    assert.deepEqual(o1.result.failure, { reason: 'budget_exhausted', message: 'maxTokens 2000 reached (2200 used)' });

    const a2 = await spawn();
    const slow = new FakeDispatcher([{ name: 'probe', handler: () => { deps.clock.advance(40_000); return { content: 'slow' }; } }]);
    const m2 = new FakeModelInvoker((_req, i) => ({ toolCalls: [{ name: 'probe', arguments: { i } }] }));
    const o2 = await loop(a2.agentId, m2, slow, { maxWallClockMs: 60_000 });
    assert.equal(m2.callCount, 2);
    assert.deepEqual(o2.result.failure, { reason: 'budget_exhausted', message: 'maxWallClockMs 60000 reached' });
  });

  test('a turn with a recorded response is finished first, whatever the budget says', async () => {
    const agent = await spawn();
    const model = new FakeModelInvoker([{ toolCalls: [{ id: 'k1', name: 'probe', arguments: {} }] }]);
    const crashing = new FakeDispatcher([{ name: 'probe', handler: () => { throw new Error('worker crashed'); } }]);
    await assert.rejects(loop(agent.agentId, model, crashing, { maxTurns: 1 }), /worker crashed/);
    const healthy = new FakeDispatcher([{ name: 'probe' }]);
    const out = await loop(agent.agentId, new FakeModelInvoker([]), healthy, { maxTurns: 1 });
    assert.deepEqual(healthy.calls.map((c) => c.invocationId), [`${agent.sessionId}:1:k1`], 'the replay settled the pending call');
    assert.equal((await sessions.getTurn(agent.sessionId, 1))?.status, 'completed');
    assert.deepEqual(out.result.failure, { reason: 'budget_exhausted', message: 'maxTurns 1 reached' });
  });

  test('waiting, boundaries and interrupts set the agent status', async () => {
    const agent = await spawn();
    const tools = new FakeDispatcher([{ name: 'load_start', handler: () => ({ pendingOperationId: 'op_9' }) }]);
    const model = new FakeModelInvoker([
      { toolCalls: [{ name: 'load_start', arguments: {} }] },
      { boundary: 'retry_next_turn', message: 'route A down' },
      { text: 'on route B now' },
      { boundary: 'model_unavailable', message: 'nothing eligible' },
    ]);
    const w = await loop(agent.agentId, model, tools);
    assert.equal(w.result.status, 'waiting');
    assert.deepEqual(w.result.waitingOn, ['op_9']);
    assert.equal(w.agent.status, 'waiting');
    // retry_next_turn is followed (the next turn uses the fallback); model_unavailable pauses the loop
    const b = await loop(agent.agentId, model, tools);
    assert.equal(model.callCount, 4);
    assert.equal(b.result.status, 'boundary');
    assert.equal(b.result.boundary, 'model_unavailable');
    assert.equal(b.agent.status, 'active');

    const ctrl = new AbortController();
    const hanging = new FakeModelInvoker([{ hangUntilAborted: true }]);
    const p = loop(agent.agentId, hanging, tools, {}, ctrl.signal);
    while (hanging.callCount === 0) await new Promise((r) => setTimeout(r, 2));
    ctrl.abort(new Error('activity cancelled'));
    const aborted = await p;
    assert.equal(aborted.result.status, 'interrupted');
    assert.equal(aborted.agent.status, 'active', 'an aborted activity is retryable, not an operator interrupt');

    await subagents.interrupt(agent.agentId, 'operator', ctx(agent.runId));
    await assert.rejects(loop(agent.agentId, new FakeModelInvoker([]), tools), (e: unknown) => isHypertestError(e, 'precondition_failed') && /resume it first/.test(e.message));
  });

  test('crash between the terminal turn and the settle: the next step settles the recorded completion without running a turn', async () => {
    const agent = await spawn();
    const died: SubagentRuntime = { ...subagents, settle: async () => { throw new Error('process died before the settle'); } };
    const crashed = createAgentRunner({ ...deps, db, agents, sessions, engines, subagents: died });
    const tools = new FakeDispatcher([completeWorkTool()]);
    const model = new FakeModelInvoker([{ toolCalls: [{ name: 'complete_work', arguments: { summary: 'health ok', output: { healthy: true }, evidenceRefs: ['ev_c'] } }] }]);
    const signal = new AbortController().signal;
    await assert.rejects(crashed.step(agent.agentId, await fakeFactory(model, tools)(), { limits: LIMITS, signal }), /process died/);
    assert.equal((await sessions.get(agent.sessionId))?.status, 'completed');
    assert.equal((await agents.get(agent.agentId))?.status, 'active', 'the agent was never settled');

    const noModel = new FakeModelInvoker([]);
    const out = await runner.step(agent.agentId, await fakeFactory(noModel, tools)(), { limits: LIMITS, signal });
    assert.equal(noModel.callCount, 0, 'no turn was run');
    assert.equal(tools.calls.length, 1, 'complete_work was not re-dispatched');
    assert.equal(out.result.status, 'completed');
    assert.equal(out.result.replayed, true);
    assert.equal(out.result.turn, 1);
    assert.deepEqual(out.result.completion, { kind: 'complete', summary: 'health ok', output: { healthy: true }, evidenceRefs: ['ev_c'], recordRefs: [] });
    assert.equal(out.agent.status, 'completed');
    assert.deepEqual(await subagents.collect(agent.agentId), { agentId: agent.agentId, status: 'completed', summary: 'health ok', output: { healthy: true }, evidenceRefs: ['ev_c'], recordRefs: [] });
  });

  test('run() settles the recorded failure of a crashed settle (repetitive_loop) — the turn budget never overrides it', async () => {
    const agent = await spawn();
    const died: SubagentRuntime = { ...subagents, settle: async () => { throw new Error('process died before the settle'); } };
    const crashed = createAgentRunner({ ...deps, db, agents, sessions, engines, subagents: died });
    const tools = new FakeDispatcher([{ name: 'probe' }]);
    const same = { toolCalls: [{ name: 'probe', arguments: { q: 1 } }] };
    await assert.rejects(crashed.run(agent.agentId, fakeFactory(new FakeModelInvoker([same, same, same]), tools), { limits: LIMITS, budget: BUDGET, signal: new AbortController().signal }), /process died/);
    assert.equal((await sessions.get(agent.sessionId))?.status, 'failed');
    const out = await loop(agent.agentId, new FakeModelInvoker([]), tools, { maxTurns: 3 });
    const failure = { reason: 'repetitive_loop', message: 'the last 3 turns issued identical tool calls' };
    assert.deepEqual(out.result.failure, failure, 'not budget_exhausted: the engine had already decided');
    assert.equal(out.agent.status, 'failed');
    assert.deepEqual((await subagents.collect(agent.agentId)).failure, failure);
  });

  test('crash after a committed waiting turn: the retried step/run waits (no extra turn) instead of running ahead of the operation', async () => {
    const tools = new FakeDispatcher([{ name: 'load_start', handler: () => ({ pendingOperationId: 'op_w' }) }]);
    const died: AgentRepository = { ...agents, update: async (id, patch) => { if (patch.status === 'waiting') throw new Error('process died before the agent update'); return agents.update(id, patch); } };
    const crashed = createAgentRunner({ ...deps, db, agents: died, sessions, engines, subagents });
    const signal = new AbortController().signal;
    const crashOnce = async () => {
      const agent = await spawn();
      await assert.rejects(crashed.step(agent.agentId, await fakeFactory(new FakeModelInvoker([{ toolCalls: [{ name: 'load_start', arguments: {} }] }]), tools)(), { limits: LIMITS, signal }), /process died/);
      assert.equal((await sessions.get(agent.sessionId))?.status, 'waiting');
      assert.equal((await agents.get(agent.agentId))?.status, 'active');
      return agent;
    };

    const a = await crashOnce();
    const noModel = new FakeModelInvoker([]);
    const out = await runner.step(a.agentId, await fakeFactory(noModel, tools)(), { limits: LIMITS, signal });
    assert.equal(noModel.callCount, 0, 'no turn ran ahead of the operation');
    assert.deepEqual([out.result.status, out.result.waitingOn, out.result.turn, out.result.replayed, out.agent.status], ['waiting', ['op_w'], 1, true, 'waiting']);
    // the normal resume path is unchanged: with the operation result queued, the waiting agent runs its next turn
    await subagents.message(a.agentId, { role: 'user', content: 'operation op_w verified' });
    const next = await runner.step(a.agentId, await fakeFactory(new FakeModelInvoker([{ text: 'reading the result' }]), tools)(), { limits: LIMITS, signal });
    assert.deepEqual([next.result.turn, next.result.status, next.agent.status], [2, 'continue', 'active']);

    const b = await crashOnce();
    const idle = new FakeModelInvoker([]);
    const viaRun = await loop(b.agentId, idle, tools, { maxTurns: 1 });
    assert.equal(idle.callCount, 0);
    assert.deepEqual([viaRun.result.status, viaRun.agent.status], ['waiting', 'waiting'], 'not budget_exhausted: the agent is waiting on op_w');
  });

  test('recovery without a recorded outcome uses the terminal signals and never fabricates a completion', () => {
    const settledCall = (terminal?: TerminalSignal): TurnRecord['toolCalls'][number] => {
      const c: TurnRecord['toolCalls'][number] = { toolCallId: 'c1', name: 'x', invocationId: 's:1:c1', status: 'settled', result: { role: 'tool', toolCallId: 'c1', toolName: 'x', content: 'ok' } };
      if (terminal) c.terminal = terminal;
      return c;
    };
    const turn = (terminal?: TerminalSignal): TurnRecord => ({ sessionId: 's', turn: 4, status: 'completed', toolCalls: [settledCall(terminal)], startedAt: '2026-01-01T00:00:00.000Z' });
    const complete: TerminalSignal = { kind: 'complete', summary: 's', evidenceRefs: [], recordRefs: [] };
    assert.deepEqual(recoveredResult('completed', turn(complete)).completion, complete);
    assert.deepEqual(recoveredResult('failed', turn({ kind: 'fail', reason: 'blocked', message: 'm' })).failure, { reason: 'blocked', message: 'm' });
    assert.deepEqual(recoveredResult('failed', turn()).failure, { reason: 'failed', message: 'the engine session ended failed without a recorded reason' });
    assert.throws(() => recoveredResult('completed', turn()), (e: unknown) => isHypertestError(e, 'internal'));
    const pendingTurn: TurnRecord = { ...turn(), toolCalls: [{ ...settledCall(), pendingOperationId: 'op_3' }] };
    assert.deepEqual(recoveredWaiting(pendingTurn)?.waitingOn, ['op_3'], 'derived from the settled pending operations');
    assert.equal(recoveredWaiting(turn()), undefined);
    assert.equal(recoveredWaiting({ ...pendingTurn, outcome: { status: 'continue' } }), undefined, 'the recorded outcome wins');
    assert.equal(recoveredWaiting({ ...pendingTurn, status: 'model_responded' }), undefined);
  });

  test('an engine that reports completed without a completion signal is a fault; nothing is settled', async () => {
    const agent = await spawn();
    const native = engines.get('native');
    const bogus = { kind: native.kind, version: native.version, capabilities: native.capabilities, createSession: () => native.createSession({ runId: 'x', agentId: 'x', initialMessages: [] }),
      runTurn: async () => ({ status: 'completed' as const, turn: 1, appended: [], toolResults: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, replayed: false }),
      spawnChild: native.spawnChild.bind(native), resumeChild: native.resumeChild.bind(native), interrupt: native.interrupt.bind(native), inspect: native.inspect.bind(native), dispose: native.dispose.bind(native) };
    const r = createAgentRunner({ ...deps, db, agents, sessions, engines: new EngineRegistry([bogus]), subagents });
    await assert.rejects(r.step(agent.agentId, fakeHost({ sessions, model: new FakeModelInvoker([]), tools: new FakeDispatcher([]) }), { limits: LIMITS, signal: new AbortController().signal }), (e: unknown) => isHypertestError(e, 'internal'));
    assert.equal((await agents.get(agent.agentId))?.status, 'active');
    assert.equal((await subagents.collect(agent.agentId)).summary, undefined);
  });

  test('budget validation', async () => {
    const agent = await spawn();
    await assert.rejects(loop(agent.agentId, new FakeModelInvoker([]), new FakeDispatcher([]), { maxTurns: Number.NaN }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
    await assert.rejects(runner.step('ag_missing', fakeHost({ sessions, model: new FakeModelInvoker([]), tools: new FakeDispatcher([]) }), { limits: LIMITS, signal: new AbortController().signal }), (e: unknown) => isHypertestError(e, 'not_found'));
  });

  // ----------------------------------------------------------------------------- the honest stack

  describe('full stack: ModelRouter + ScriptedProvider → NativeEngine → ToolRuntime (capability + policy permit)', () => {
    let ws: WorkspaceHandle;
    let cleanup: () => Promise<void>;
    before(async () => {
      const dir = await tempDir('ht-runtime-ws-');
      cleanup = dir.cleanup;
      ws = await createWorkspaceManager({ ...deps, baseDir: dir.path, defaultSandbox: { kind: 'local', network: 'none', envAllowlist: [] } }).scratch({ runId: 'run_stack', workItemId: 'wi_stack' });
    });
    after(async () => cleanup());

    const executed: string[] = [];
    const arith = (id: string, op: (a: number, b: number) => number): ToolSpec<{ a: number; b: number }> => ({
      id,
      title: id,
      description: `${id}: integer arithmetic`,
      inputSchema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { result: { type: 'integer' } }, required: ['result'] },
      effect: 'read',
      riskClass: 'low',
      resources: (_input, c) => [`run/${c.runId}/calc`],
      timeoutMs: 5000,
      execute: async (input) => {
        executed.push(id);
        const result = op(input.a, input.b);
        return { status: 'success', structured: { result }, text: `result=${result}` };
      },
    });

    const unsupported = new Proxy({}, { get: (_t, p) => (p === 'kind' ? 'memory' : () => Promise.reject(new HypertestError('unsupported', `not needed by the calculator: ${String(p)}`))) });

    const COMPLETE: ToolDefinition = {
      name: 'complete_work',
      description: 'Finish the work item with the structured output.',
      inputSchema: { type: 'object', properties: { summary: { type: 'string' }, output: { type: 'object' } }, required: ['summary', 'output'] },
    };

    /** The host's dispatcher: domain tool complete_work + every other call through the governed ToolRuntime. */
    function runtimeDispatcher(runtime: ToolRuntime, registry: ToolRegistry, capability: ActionCapability, agent: { agentId: string; runId: string; workItemId: string }, eventContext: EventContext): ToolDispatcher {
      return {
        definitions: () => [...registry.definitionsFor(capability, ['*']), COMPLETE],
        isParallelSafe: (name) => registry.getByName(name)?.effect === 'read',
        async dispatch(call: ToolCall, meta): Promise<DispatchResult> {
          if (call.name === 'complete_work') {
            const a = call.arguments as { summary: string; output: { sum: number } };
            return { message: { role: 'tool', toolCallId: call.id, toolName: call.name, content: 'completed' }, terminal: { kind: 'complete', summary: a.summary, output: a.output, evidenceRefs: [], recordRefs: [] } };
          }
          const execution = await runtime.execute({
            toolId: toolNameToId(call.name),
            input: call.arguments,
            invocationId: meta.invocationId!,
            runId: agent.runId,
            workItemId: agent.workItemId,
            agentId: agent.agentId,
            role: 'executor',
            capability,
            workspace: ws,
            eventContext,
            signal: meta.signal,
          });
          return { message: { role: 'tool', toolCallId: call.id, toolName: call.name, content: execution.modelText, isError: execution.status !== 'success' }, execution };
        },
      };
    }

    /** L1/L2 from @hypertest/context: a content-addressed snapshot per turn, working view, prompt assembly. */
    function assemblingContext(snapshots: SnapshotStore, runId: string, manifestId: string, tools: () => ToolDefinition[], ctx: EventContext): ContextProvider {
      const working = createWorkingContextManager();
      const assembler = new PromptAssembler();
      return {
        async assemble(input): Promise<TurnContext> {
          const snapshot = await snapshots.create(
            { runId, eventSeq: input.turn, blackboardRevision: 0, planRevision: 1, runtimeManifestId: manifestId, oracleRevisions: {}, experimentRevisions: {}, policyRevision: 'policy-rev-1', evidenceRootHash: '0'.repeat(64), readSet: [] },
            ctx,
          );
          const view = working.view({ transcript: input.transcript, compactions: input.compactions, budgetTokens: 16_000 });
          const assembled = assembler.assemble({ rolePrompt: 'You are the executor. Use tools; finish with complete_work.', sections: [], transcript: view.messages, budgetTokens: 32_000, snapshotId: snapshot.snapshotId });
          return { messages: assembled.messages, tools: tools(), snapshot };
        },
      };
    }

    test('an executor computes with a governed tool and completes; every decision is on the record', async () => {
      const brain: ScriptedBrain = (req, { callIndex }) => {
        if (callIndex === 0) {
          const names = (req.tools ?? []).map((t) => t.name).sort();
          if (names.join() !== 'calc__add,complete_work') return { text: `unexpected tools ${names.join()}` };
          return { toolCalls: [{ name: 'calc__add', arguments: { a: 2, b: 3 } }, { name: 'calc__mul', arguments: { a: 2, b: 3 } }] };
        }
        const results = req.messages.filter((m) => m.role === 'tool').map((m) => (m.role === 'tool' ? m.content : ''));
        const sum = /result=(\d+)/.exec(results[0] ?? '')?.[1];
        if (!sum || !/denied/.test(results[1] ?? '')) return { toolCalls: [{ name: 'complete_work', arguments: { summary: `unexpected: ${results.join(' | ')}`, output: {} } }] };
        return { toolCalls: [{ name: 'complete_work', arguments: { summary: `2+3=${sum}`, output: { sum: Number(sum) } } }] };
      };
      const provider = new ScriptedProvider({ providerId: 'local', brain });
      const catalog = new ModelCatalog([
        {
          routeId: 'local-exec', provider: 'local', model: 'exec-1', capabilities: ['tool_use'], structuredOutput: 'prompted', reasoning: 'none', contextWindow: 64_000, maxOutputTokens: 1024,
          continuationCompatibilityClass: 'local:exec-1', maxDataClassification: 'restricted', quality: { default: 0.7 }, toolReliability: 0.9, costPerMillionInputUsd: 0.5, costPerMillionOutputUsd: 1,
          typicalLatencyMs: 50, maxActionRisk: 'medium', enabled: true,
        },
      ]);
      const router = createModelRouter({ ...deps, catalog, providers: new ProviderRegistry([provider]), events: deps.events });
      const registry = new ToolRegistry([arith('calc.add', (a, b) => a + b), arith('calc.mul', (a, b) => a * b)]);
      const policy = new BuiltinPolicyEngine(DEFAULT_POLICY_RULES, 'policy-rev-1', { clock: deps.clock, capabilitySecret: SECRET, newId: () => deps.ids.next('pdec') });
      const decisionLog = createPolicyDecisionLog({ ...deps, db, events: deps.events });
      const toolDeps: ToolRuntimeDeps = {
        ...deps,
        registry,
        policy,
        decisionLog,
        artifacts: unsupported as ToolRuntimeDeps['artifacts'],
        evidence: unsupported as ToolRuntimeDeps['evidence'],
        events: deps.events,
        environments: createEnvironmentRegistry([]),
        runtimeManifestId: 'rm_pending',
        workerId: 'worker_1',
        capabilitySecret: SECRET,
      };
      const manifest = buildRuntimeManifest(
        {
          hypertest: { version: '0.3.0-dev' },
          agentEngines: [{ kind: 'native', version: '0.3.0-dev' }],
          providerAdapters: new ProviderRegistry([provider]).adapters(),
          modelCatalogRevision: catalog.revision,
          schemas: { event: '1', contextSnapshot: '1', tool: '1', operation: '1', evidence: '1' },
          policyBundleRevision: policy.revision,
          toolCatalogRevision: registry.revision(),
        },
        deps.clock.isoNow(),
      );
      toolDeps.runtimeManifestId = manifest.manifestId;
      const toolRuntime = createToolRuntime(toolDeps);
      const snapshots = createSnapshotStore({ ...deps, db, events: deps.events });
      const budgetLog: string[] = [];
      const budget: BudgetPort = {
        async reserve(_s, a) { budgetLog.push(`reserve:${a.tokens}`); return { ok: true as const, reservationId: `r${budgetLog.length}` }; },
        async settle(id, a) { budgetLog.push(`settle:${id}:${a.tokens}`); },
        async release(id) { budgetLog.push(`release:${id}`); },
      };

      let capability!: ActionCapability;
      const runId = 'run_stack';
      const agent = await spawn({ runId, workItemId: 'wi_stack' }, (c) => (capability = c));
      const eventContext = ctx(runId, agent.agentId);
      const invoker = createModelInvoker({
        ...deps, router, epochs, sessions, budget, budgetScopes: [`run/${runId}`], agent: { agentId: agent.agentId, runId, role: 'executor', sessionId: agent.sessionId },
        policy: {}, taskType: 'execute_tests', dataClassification: 'internal', actionRisk: 'low', maxOutputTokens: 256, eventContext,
      });
      const hostFactory = async (): Promise<EngineHost> => {
        const tools = runtimeDispatcher(toolRuntime, registry, capability, { agentId: agent.agentId, runId, workItemId: 'wi_stack' }, eventContext);
        return { model: invoker, tools, context: assemblingContext(snapshots, runId, manifest.manifestId, () => tools.definitions(), eventContext), sessions, eventContext, events: deps.events };
      };

      const before = deps.events.events.length;
      const out = await runner.run(agent.agentId, hostFactory, { limits: LIMITS, budget: BUDGET, signal: new AbortController().signal });
      assert.equal(out.result.status, 'completed', JSON.stringify(out.result.completion ?? out.result.failure));
      assert.deepEqual(out.result.completion, { kind: 'complete', summary: '2+3=5', output: { sum: 5 }, evidenceRefs: [], recordRefs: [] });
      assert.equal(out.agent.status, 'completed');
      assert.deepEqual(await subagents.collect(agent.agentId), { agentId: agent.agentId, status: 'completed', summary: '2+3=5', output: { sum: 5 }, evidenceRefs: [], recordRefs: [] });

      // I1: the out-of-capability call was denied by the pipeline and never executed
      assert.deepEqual(executed, ['calc.add']);
      const t1 = await sessions.getTurn(agent.sessionId, 1);
      assert.deepEqual(t1?.toolCalls.map((c) => [c.name, c.invocationId, c.result?.isError === true]), [
        ['calc__add', `${agent.sessionId}:1:call_1`, false],
        ['calc__mul', `${agent.sessionId}:1:call_2`, true],
      ]);
      assert.match(t1?.toolCalls[1]?.result?.content ?? '', /tool_not_permitted: calc\.mul/);
      const decisions = await decisionLog.list(runId);
      assert.deepEqual(decisions.map((d) => [d.request.tool, d.permit.decision]), [['calc.add', 'allow']]);

      // I3 / I10: one epoch pinned to the turn-1 snapshot; the audit trail is complete and correlated
      const eps = await epochs.list(agent.sessionId);
      assert.deepEqual(eps.map((e) => [e.routeId, e.switchReason, e.startedAtTurn, e.contextSnapshotId === t1?.snapshotId]), [['local-exec', 'initial', 1, true]]);
      assert.equal(provider.callCount, 2);
      assert.equal(budgetLog.filter((l) => l.startsWith('reserve')).length, 2);
      assert.equal(budgetLog.filter((l) => l.startsWith('settle')).length, 2);
      assert.equal(budgetLog.filter((l) => l.startsWith('release')).length, 0);
      const mine = deps.events.events.slice(before).filter((e) => e.runId === runId);
      const types = mine.map((e) => e.eventType);
      for (const t of ['model.routed', 'model.epoch_started', 'model.invoked', 'agent.turn_started', 'agent.turn_completed', 'tool.called', 'tool.completed', 'tool.denied', 'context.snapshot_created']) {
        assert.ok(types.includes(t), `missing ${t} in ${types.join(', ')}`);
      }
      assert.equal(types.filter((t) => t === 'model.invoked').length, 2);
      for (const e of mine.filter((x) => x.eventType.startsWith('model.') || x.eventType.startsWith('tool.') || x.eventType.startsWith('agent.turn'))) {
        assert.equal(e.correlationId, `corr_${runId}`, e.eventType);
        assert.equal(e.agentId, agent.agentId, e.eventType);
      }
      const toolCalled = mine.find((e) => e.eventType === 'tool.called')!;
      assert.equal((toolCalled.payload as { invocationId: string }).invocationId, `${agent.sessionId}:1:call_1`);
      const firstPrompt = provider.requests[0]!.messages as ChatMessage[];
      assert.equal(firstPrompt[0]?.role, 'system');
      assert.match(firstPrompt[0]?.role === 'system' ? firstPrompt[0].content : '', /Context snapshot: cs_/);
    });
  });
});
