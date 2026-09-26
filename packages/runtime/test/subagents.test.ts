import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isHypertestError, type SqlDatabase } from '@hypertest/core';
import { InMemoryEventSink, type ActionCapability, type ChatMessage, type EventContext } from '@hypertest/domain';
import { attenuateCapability, createRootCapability } from '@hypertest/policy';
import { createTestDatabase } from '@hypertest/store';
import {
  EngineRegistry, FakeDispatcher, FakeModelInvoker, NativeEngine, createAgentRepository, createSessionStore, createSubagentRuntime, fakeHost, runtimeMigrations,
  type AgentRepository, type SessionStore, type SpawnRequest, type SubagentRuntime,
} from '../src/index.ts';
import { baseDeps, faultyDb } from './helpers.ts';

const SECRET = 'runtime-test-capability-secret';
const FAR = '2099-01-01T00:00:00.000Z';
const code = (c: string) => (e: unknown) => isHypertestError(e, c as never);

describe('SubagentRuntime', () => {
  let db: SqlDatabase;
  let dispose: () => Promise<void>;
  let deps: ReturnType<typeof baseDeps>;
  let sessions: SessionStore;
  let agents: AgentRepository;
  let engine: NativeEngine;
  let subagents: SubagentRuntime;
  let n = 0;

  before(async () => {
    ({ db, dispose } = await createTestDatabase({ migrations: runtimeMigrations }));
    deps = baseDeps('2026-06-01T00:00:00.000Z');
    sessions = createSessionStore({ ...deps, db });
    agents = createAgentRepository({ ...deps, db });
    engine = new NativeEngine({ ...deps, sessions });
    subagents = createSubagentRuntime({ ...deps, db, agents, sessions, engines: new EngineRegistry([engine]), defaultEngineKind: 'native', maxAgentsPerRun: 4 });
  });
  after(async () => dispose());

  const ctx = (runId: string): EventContext => ({ runId, correlationId: `corr_${runId}`, actorId: 'system:scheduler' });
  const rootCap = (runId: string, workItemId: string) => (agentId: string) =>
    createRootCapability({ runId, subjectAgentId: agentId, workItemId, profile: 'test_executor', tools: ['*'], expiresAt: FAR }, SECRET);
  const childCap = (parent: ActionCapability, workItemId: string) => (agentId: string) =>
    attenuateCapability(parent, { tools: ['fs.*'] }, { subjectAgentId: agentId, workItemId }, { secret: SECRET });

  function request(runId: string, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
    return {
      runId,
      workItemId: 'wi_root',
      role: 'lead',
      depth: 0,
      maxDepth: 2,
      capability: rootCap(runId, overrides.workItemId ?? 'wi_root'),
      modelPolicy: {},
      toolPolicy: { allow: ['*'] },
      contextSnapshotId: 'cs_1',
      initialMessages: [{ role: 'user', content: `task for ${overrides.role ?? 'lead'}` }],
      continuable: false,
      background: false,
      budget: { maxTurns: 5, maxTokens: 10_000, maxToolCalls: 10, maxWallClockMs: 60_000 },
      ...overrides,
    };
  }

  async function count(runId: string): Promise<{ agents: number; sessions: number }> {
    const a = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM ht_agents WHERE run_id = $1`, [runId]);
    const s = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM ht_sessions WHERE run_id = $1`, [runId]);
    return { agents: Number(a.rows[0]!.n), sessions: Number(s.rows[0]!.n) };
  }

  /** Spawns root → child → grandchild with properly attenuated capabilities. */
  async function family(runId: string) {
    let rootCapability!: ActionCapability;
    const root = await subagents.spawn(request(runId, { capability: (id) => (rootCapability = rootCap(runId, 'wi_root')(id)) }), ctx(runId));
    let childCapability!: ActionCapability;
    const child = await subagents.spawn(
      request(runId, { workItemId: 'wi_child', role: 'executor', parentAgentId: root.agentId, depth: 1, capability: (id) => (childCapability = childCap(rootCapability, 'wi_child')(id)) }),
      ctx(runId),
    );
    const grandchild = await subagents.spawn(
      request(runId, { workItemId: 'wi_grand', role: 'rca', parentAgentId: child.agentId, depth: 2, capability: childCap(childCapability, 'wi_grand') }),
      ctx(runId),
    );
    return { root, child, grandchild, rootCapability };
  }

  test('spawn persists the identity, binds the capability and gives the child only its task context', async () => {
    const runId = `run_sa${++n}`;
    const before = deps.events.events.length;
    let granted: ActionCapability | undefined;
    const root = await subagents.spawn(request(runId, { capability: (id) => (granted = rootCap(runId, 'wi_root')(id)) }), ctx(runId));
    assert.equal(granted?.subjectAgentId, root.agentId);
    assert.equal(root.capabilityId, granted?.capabilityId);
    assert.deepEqual(
      { status: root.status, depth: root.depth, role: root.role, engineKind: root.engineKind, workItemId: root.workItemId, parent: root.parentAgentId },
      { status: 'active', depth: 0, role: 'lead', engineKind: 'native', workItemId: 'wi_root', parent: undefined },
    );
    assert.deepEqual(await agents.get(root.agentId), root);
    await sessions.appendTranscript(root.sessionId, [{ turn: 1, message: { role: 'user', content: 'PARENT-TRACE: internal deliberation' } }]);

    const childTask: ChatMessage = { role: 'user', content: 'verify POST /orders returns 201' };
    const child = await subagents.spawn(
      request(runId, { workItemId: 'wi_c', role: 'executor', parentAgentId: root.agentId, depth: 1, capability: childCap(granted!, 'wi_c'), initialMessages: [childTask] }),
      ctx(runId),
    );
    assert.equal(child.parentAgentId, root.agentId);
    assert.deepEqual(await sessions.transcript(child.sessionId), [{ turn: 0, message: childTask }], 'nothing of the parent transcript');
    assert.deepEqual((await subagents.children(root.agentId)).map((a) => a.agentId), [child.agentId]);
    assert.equal((await agents.byWorkItem('wi_c'))?.agentId, child.agentId);

    const spawned = deps.events.events.slice(before).filter((e) => e.eventType === 'agent.spawned');
    assert.equal(spawned.length, 2);
    assert.deepEqual(spawned[1]!.payload, {
      agentId: child.agentId, role: 'executor', workItemId: 'wi_c', parentAgentId: root.agentId, depth: 1, engineKind: 'native', sessionId: child.sessionId,
      capabilityId: child.capabilityId, contextSnapshotId: 'cs_1', continuable: false, background: false,
      budget: { maxTurns: 5, maxTokens: 10_000, maxToolCalls: 10, maxWallClockMs: 60_000 },
    });
    assert.equal(spawned[1]!.agentId, child.agentId);
    assert.equal(spawned[1]!.correlationId, `corr_${runId}`);
  });

  test('a capability granted to another subject is rejected and nothing is created', async () => {
    const runId = `run_sa${++n}`;
    const foreign = createRootCapability({ runId, subjectAgentId: 'ag_someone_else', workItemId: 'wi_root', profile: 'test_executor', expiresAt: FAR }, SECRET);
    await assert.rejects(subagents.spawn(request(runId, { capability: foreign }), ctx(runId)), (e: unknown) => isHypertestError(e, 'permission_denied') && /granted to ag_someone_else, not to the new agent ag_/.test(e.message));
    await assert.rejects(subagents.spawn(request(runId, { capability: (id) => ({ ...rootCap(runId, 'wi_root')(id), workItemId: 'wi_other' }) }), ctx(runId)), (e: unknown) => isHypertestError(e, 'permission_denied') && /is bound to .*\/wi_other/.test(e.message));
    await assert.rejects(subagents.spawn(request(runId, { capability: () => { throw new Error('no grant'); } }), ctx(runId)), code('permission_denied'));
    assert.deepEqual(await count(runId), { agents: 0, sessions: 0 });

    const root = await subagents.spawn(request(runId), ctx(runId));
    // a child capability NOT attenuated from the parent's (I2: never amplified by minting a fresh root)
    await assert.rejects(
      subagents.spawn(request(runId, { workItemId: 'wi_c', parentAgentId: root.agentId, depth: 1, capability: rootCap(runId, 'wi_c') }), ctx(runId)),
      (e: unknown) => isHypertestError(e, 'permission_denied') && /not derived from the parent/.test(e.message),
    );
    assert.deepEqual(await count(runId), { agents: 1, sessions: 1 });
  });

  test('I2: a child capability that names the parent but grants more than the parent\'s recorded capability is refused', async () => {
    const runId = `run_sa${++n}`;
    let rootCapability!: ActionCapability;
    const root = await subagents.spawn(request(runId, { capability: (id) => (rootCapability = createRootCapability({ runId, subjectAgentId: id, workItemId: 'wi_root', profile: 'test_executor', tools: ['fs.read', 'git.*'], expiresAt: FAR }, SECRET)) }), ctx(runId));
    assert.deepEqual(await subagents.capabilityOf!(root.agentId), rootCapability, 'the granted capability is on record');
    const derived = (id: string) => attenuateCapability(rootCapability, {}, { subjectAgentId: id, workItemId: 'wi_c' });
    const amplifications: Array<[string, (c: ActionCapability) => ActionCapability]> = [
      ['tool pattern *', (c) => ({ ...c, tools: ['*'] })],
      ['tool pattern fs.write', (c) => ({ ...c, tools: ['fs.read', 'fs.write'] })],
      ['resource scope', (c) => ({ ...c, resourceScopes: [...c.resourceScopes, 'cluster/**'] })],
      ['effect', (c) => ({ ...c, allowedEffects: [...c.allowedEffects, 'destructive'] })],
      ['credential scope', (c) => ({ ...c, credentialScopes: [...c.credentialScopes, 'prod-admin'] })],
      ['environment class', (c) => ({ ...c, environmentClasses: [...c.environmentClasses, 'production'] })],
      ['maxRiskClass', (c) => ({ ...c, maxRiskClass: 'critical' })],
      ['expiresAt', (c) => ({ ...c, expiresAt: '2199-01-01T00:00:00.000Z' })],
    ];
    for (const [what, amplify] of amplifications) {
      await assert.rejects(
        subagents.spawn(request(runId, { workItemId: 'wi_c', parentAgentId: root.agentId, depth: 1, capability: (id) => amplify(derived(id)) }), ctx(runId)),
        (e: unknown) => isHypertestError(e, 'permission_denied') && /amplifies the parent/.test(e.message),
        what,
      );
    }
    assert.deepEqual(await count(runId), { agents: 1, sessions: 1 }, 'nothing was created by a refused spawn');
    // a genuine attenuation (narrower tools, shorter expiry, lower risk) is accepted
    const ok = await subagents.spawn(
      request(runId, { workItemId: 'wi_c', parentAgentId: root.agentId, depth: 1, capability: (id) => attenuateCapability(rootCapability, { tools: ['git.diff'], maxRiskClass: 'low', expiresAt: '2098-01-01T00:00:00.000Z' }, { subjectAgentId: id, workItemId: 'wi_c' }) }),
      ctx(runId),
    );
    assert.deepEqual((await subagents.capabilityOf!(ok.agentId))?.tools, ['git.diff']);
  });

  test('I2: a child of an agent whose capability is not on record is refused (the attenuation cannot be verified)', async () => {
    const runId = `run_sa${++n}`;
    const orphan = await agents.create({
      agentId: `ag_manual${n}`, runId, role: 'lead', workItemId: 'wi_root', depth: 0, engineKind: 'native', sessionId: (await engine.createSession({ runId, agentId: `ag_manual${n}`, initialMessages: [] })).sessionId,
      status: 'active', capabilityId: 'cap_unrecorded', continuable: false, background: false, createdAt: deps.clock.isoNow(), updatedAt: deps.clock.isoNow(),
    });
    await assert.rejects(
      subagents.spawn(request(runId, { workItemId: 'wi_c', parentAgentId: orphan.agentId, depth: 1, capability: (id) => ({ ...rootCap(runId, 'wi_c')(id), parentCapabilityId: 'cap_unrecorded' }) }), ctx(runId)),
      (e: unknown) => isHypertestError(e, 'permission_denied') && /not on record/.test(e.message),
    );
  });

  test('with capabilitySecret, an unsigned or tampered capability is refused; a signed one is accepted', async () => {
    const strict = createSubagentRuntime({ ...deps, db, agents, sessions, engines: new EngineRegistry([engine]), defaultEngineKind: 'native', maxAgentsPerRun: 10, capabilitySecret: SECRET });
    const runId = `run_sa${++n}`;
    await assert.rejects(strict.spawn(request(runId, { capability: (id) => { const { signature: _s, ...unsigned } = rootCap(runId, 'wi_root')(id); return unsigned; } }), ctx(runId)), (e: unknown) => isHypertestError(e, 'permission_denied') && /signature/.test(e.message));
    await assert.rejects(strict.spawn(request(runId, { capability: (id) => ({ ...rootCap(runId, 'wi_root')(id), tools: ['*', 'shell.exec'] }) }), ctx(runId)), (e: unknown) => isHypertestError(e, 'permission_denied') && /signature/.test(e.message));
    await assert.rejects(strict.spawn(request(runId, { capability: (id) => createRootCapability({ runId, subjectAgentId: id, workItemId: 'wi_root', profile: 'test_executor', expiresAt: FAR }, 'another-secret') }), ctx(runId)), code('permission_denied'));
    assert.deepEqual(await count(runId), { agents: 0, sessions: 0 });
    assert.equal((await strict.spawn(request(runId), ctx(runId))).status, 'active');
  });

  test('spawn validates the work budget it records', async () => {
    const runId = `run_sa${++n}`;
    await assert.rejects(subagents.spawn(request(runId, { budget: { maxTurns: -1, maxTokens: 1, maxToolCalls: 1, maxWallClockMs: 1 } }), ctx(runId)), code('invalid_argument'));
    await assert.rejects(subagents.spawn(request(runId, { budget: undefined as never }), ctx(runId)), code('invalid_argument'));
    assert.deepEqual(await count(runId), { agents: 0, sessions: 0 });
  });

  test('depth cap (I12): depth > maxDepth is refused; depth must be parent depth + 1', async () => {
    const runId = `run_sa${++n}`;
    const depthDenied = (e: unknown) => isHypertestError(e, 'permission_denied') && /exceeds maxDepth/.test(e.message);
    await assert.rejects(subagents.spawn(request(runId, { depth: 3, maxDepth: 2 }), ctx(runId)), depthDenied);
    const { root, child, grandchild } = await family(runId);
    assert.deepEqual([root.depth, child.depth, grandchild.depth], [0, 1, 2]);
    const gcCap = (await db.query<{ capability_id: string }>(`SELECT capability_id FROM ht_agents WHERE agent_id = $1`, [grandchild.agentId])).rows[0]!.capability_id;
    const fakeParentCap = { capabilityId: gcCap } as ActionCapability;
    await assert.rejects(
      subagents.spawn(request(runId, { workItemId: 'wi_x', parentAgentId: grandchild.agentId, depth: 3, maxDepth: 2, capability: (id) => ({ ...rootCap(runId, 'wi_x')(id), parentCapabilityId: fakeParentCap.capabilityId }) }), ctx(runId)),
      depthDenied,
    );
    await assert.rejects(
      subagents.spawn(request(runId, { workItemId: 'wi_y', parentAgentId: root.agentId, depth: 0, capability: rootCap(runId, 'wi_y') }), ctx(runId)),
      code('invalid_argument'),
      'a child cannot claim depth 0 to dodge the cap',
    );
    assert.deepEqual(await count(runId), { agents: 3, sessions: 3 });
  });

  test('depth cap (I12) is inherited: a descendant cannot raise the cap its ancestor was spawned with', async () => {
    const runId = `run_sa${++n}`;
    let rootCapability!: ActionCapability;
    const root = await subagents.spawn(request(runId, { maxDepth: 1, capability: (id) => (rootCapability = rootCap(runId, 'wi_root')(id)) }), ctx(runId));
    let childCapability!: ActionCapability;
    const child = await subagents.spawn(
      request(runId, { workItemId: 'wi_child', parentAgentId: root.agentId, depth: 1, maxDepth: 1, capability: (id) => (childCapability = childCap(rootCapability, 'wi_child')(id)) }),
      ctx(runId),
    );
    await assert.rejects(
      subagents.spawn(request(runId, { workItemId: 'wi_grand', parentAgentId: child.agentId, depth: 2, maxDepth: 9, capability: childCap(childCapability, 'wi_grand') }), ctx(runId)),
      (e: unknown) => isHypertestError(e, 'permission_denied') && /exceeds the inherited maxDepth 1/.test(e.message),
    );
    assert.deepEqual(await count(runId), { agents: 2, sessions: 2 });
  });

  test('agent-count cap (I12): the run never exceeds maxAgentsPerRun, even with concurrent spawns', async () => {
    const runId = `run_sa${++n}`;
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => subagents.spawn(request(runId, { workItemId: `wi_${i}`, capability: rootCap(runId, `wi_${i}`) }), ctx(runId))));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter((r) => r.status === 'rejected' && isHypertestError(r.reason, 'budget_exhausted')).length;
    assert.equal(ok, 4);
    assert.equal(refused, 2);
    assert.deepEqual(await count(runId), { agents: 4, sessions: 4 }, 'no orphan session for a refused spawn');
  });

  test('interrupt cascades to every descendant and aborts a running turn', async () => {
    const runId = `run_sa${++n}`;
    const { root, child, grandchild } = await family(runId);
    const model = new FakeModelInvoker([{ hangUntilAborted: true }]);
    const running = engine.runTurn({ session: { sessionId: grandchild.sessionId, engineKind: 'native' }, host: fakeHost({ sessions, model, tools: new FakeDispatcher([]) }), limits: { maxToolCallsPerTurn: 4, repetitionThreshold: 3 }, signal: new AbortController().signal });
    while (model.callCount === 0) await new Promise((r) => setTimeout(r, 2));
    const before = deps.events.events.length;
    await subagents.interrupt(root.agentId, 'plan revised', ctx(runId));
    assert.equal((await running).status, 'interrupted');
    for (const a of [root, child, grandchild]) {
      assert.equal((await agents.get(a.agentId))?.status, 'interrupted', a.role);
      assert.equal((await sessions.get(a.sessionId))?.status, 'interrupted', a.role);
    }
    const evs = deps.events.events.slice(before).filter((e) => e.eventType === 'agent.interrupted');
    assert.deepEqual(evs.map((e) => [e.aggregateId, (e.payload as { cascadedFrom: string | null }).cascadedFrom]), [
      [grandchild.agentId, root.agentId],
      [child.agentId, root.agentId],
      [root.agentId, null],
    ]);
    // interrupting again is a no-op
    await subagents.interrupt(root.agentId, 'again', ctx(runId));
    assert.equal(deps.events.events.slice(before).filter((e) => e.eventType === 'agent.interrupted').length, 3);
    // resume reactivates one agent (not the subtree)
    assert.equal((await subagents.resume(child.agentId)).status, 'active');
    assert.equal((await sessions.get(child.sessionId))?.status, 'active');
    assert.equal((await agents.get(grandchild.agentId))?.status, 'interrupted');
  });

  test('interrupt leaves settled (completed) descendants untouched', async () => {
    const runId = `run_sa${++n}`;
    const { root, child } = await family(runId);
    await subagents.settle(child.agentId, { status: 'completed', summary: 'done', evidenceRefs: [], recordRefs: [] }, ctx(runId));
    await subagents.interrupt(root.agentId, 'stop', ctx(runId));
    assert.equal((await agents.get(child.agentId))?.status, 'completed');
    assert.equal((await agents.get(root.agentId))?.status, 'interrupted');
  });

  test('collect returns only what settle recorded — never the child trace', async () => {
    const runId = `run_sa${++n}`;
    const { root, rootCapability } = await family(runId);
    const child = await subagents.spawn(
      request(runId, { workItemId: 'wi_trace', role: 'executor', parentAgentId: root.agentId, depth: 1, capability: childCap(rootCapability, 'wi_trace') }),
      ctx(runId),
    );
    const tools = new FakeDispatcher([{ name: 'probe', handler: () => ({ content: 'CHILD-TRACE: raw 4MB stack dump' }) }]);
    const model = new FakeModelInvoker([{ text: 'CHILD-TRACE: chain of thought', toolCalls: [{ name: 'probe', arguments: {} }] }]);
    await engine.runTurn({ session: { sessionId: child.sessionId, engineKind: 'native' }, host: fakeHost({ sessions, model, tools }), limits: { maxToolCallsPerTurn: 4, repetitionThreshold: 3 }, signal: new AbortController().signal });
    assert.ok(JSON.stringify(await sessions.transcript(child.sessionId)).includes('CHILD-TRACE'));

    assert.deepEqual(await subagents.collect(child.agentId), { agentId: child.agentId, status: 'active', evidenceRefs: [], recordRefs: [] });
    const settled = { status: 'completed' as const, summary: 'POST /orders returns 201', output: { passed: 3 }, evidenceRefs: ['ev_7'], recordRefs: ['rec_2'] };
    await subagents.settle(child.agentId, settled, ctx(runId));
    const collected = await subagents.collect(child.agentId);
    assert.deepEqual(collected, { agentId: child.agentId, status: 'completed', summary: 'POST /orders returns 201', output: { passed: 3 }, evidenceRefs: ['ev_7'], recordRefs: ['rec_2'] });
    assert.ok(!JSON.stringify(collected).includes('CHILD-TRACE'));
    await subagents.settle(child.agentId, settled, ctx(runId));
    await assert.rejects(subagents.settle(child.agentId, { ...settled, summary: 'different' }, ctx(runId)), code('conflict'));
    await assert.rejects(subagents.settle(child.agentId, { ...settled, status: 'weird' as never }, ctx(runId)), code('invalid_argument'));
  });

  test('a continuable agent settles a new result after resume; collect never returns the stale one as current', async () => {
    const runId = `run_sa${++n}`;
    const a = await subagents.spawn(request(runId, { continuable: true }), ctx(runId));
    await subagents.settle(a.agentId, { status: 'completed', summary: 'first answer', evidenceRefs: ['ev_1'], recordRefs: [] }, ctx(runId));
    assert.equal((await subagents.resume(a.agentId)).status, 'active');
    assert.deepEqual(await subagents.collect(a.agentId), { agentId: a.agentId, status: 'active', evidenceRefs: [], recordRefs: [] }, 'the previous result is no longer current');
    await subagents.settle(a.agentId, { status: 'completed', summary: 'second answer', evidenceRefs: ['ev_2'], recordRefs: [] }, ctx(runId));
    assert.deepEqual(await subagents.collect(a.agentId), { agentId: a.agentId, status: 'completed', summary: 'second answer', evidenceRefs: ['ev_2'], recordRefs: [] });
    // an interrupted (settled) agent can be resumed and settled again too
    await subagents.settle(a.agentId, { status: 'completed', summary: 'second answer', evidenceRefs: ['ev_2'], recordRefs: [] }, ctx(runId));
    const b = await subagents.spawn(request(runId, { workItemId: 'wi_b', capability: rootCap(runId, 'wi_b') }), ctx(runId));
    await subagents.settle(b.agentId, { status: 'interrupted', evidenceRefs: [], recordRefs: [] }, ctx(runId));
    await subagents.resume(b.agentId);
    await subagents.settle(b.agentId, { status: 'failed', failure: { reason: 'blocked', message: 'env down' }, evidenceRefs: [], recordRefs: [] }, ctx(runId));
    assert.deepEqual((await subagents.collect(b.agentId)).failure, { reason: 'blocked', message: 'env down' });
  });

  test('resume is atomic: a failed agent update leaves the session and the settled result untouched', async () => {
    const runId = `run_sa${++n}`;
    const a = await subagents.spawn(request(runId, { continuable: true }), ctx(runId));
    await subagents.settle(a.agentId, { status: 'completed', summary: 'kept', evidenceRefs: [], recordRefs: [] }, ctx(runId));
    await sessions.setStatus(a.sessionId, 'completed');
    const faulty = faultyDb(db, (sql) => sql.includes('UPDATE ht_agents SET status'));
    const flaky = createSubagentRuntime({ ...deps, db: faulty, agents: createAgentRepository({ ...deps, db: faulty }), sessions: createSessionStore({ ...deps, db: faulty }), engines: new EngineRegistry([engine]), defaultEngineKind: 'native', maxAgentsPerRun: 10 });
    await assert.rejects(flaky.resume(a.agentId), /injected fault/);
    assert.equal((await sessions.get(a.sessionId))?.status, 'completed', 'session reactivation rolled back');
    assert.equal((await subagents.collect(a.agentId)).summary, 'kept', 'result clearing rolled back');
  });

  test('interrupt commits the status change and its L0 event together; a retry emits the event once', async () => {
    const runId = `run_sa${++n}`;
    let failOnce = true;
    const sink = new InMemoryEventSink();
    const flakyEvents = {
      emit: async (evs: Parameters<InMemoryEventSink['emit']>[0]) => {
        if (failOnce && evs.some((e) => e.eventType === 'agent.interrupted')) {
          failOnce = false;
          throw new Error('event store unavailable');
        }
        return sink.emit(evs);
      },
    };
    const rt = createSubagentRuntime({ ...deps, events: flakyEvents, db, agents, sessions, engines: new EngineRegistry([engine]), defaultEngineKind: 'native', maxAgentsPerRun: 10 });
    const a = await rt.spawn(request(runId), ctx(runId));
    await assert.rejects(rt.interrupt(a.agentId, 'stop', ctx(runId)), /event store unavailable/);
    assert.equal((await agents.get(a.agentId))?.status, 'active', 'no status change without its event');
    await rt.interrupt(a.agentId, 'stop', ctx(runId));
    assert.equal((await agents.get(a.agentId))?.status, 'interrupted');
    assert.equal(sink.events.filter((e) => e.eventType === 'agent.interrupted' && e.aggregateId === a.agentId).length, 1);
  });

  test('message queues input for the next turn; closed agents refuse messages and resumes', async () => {
    const runId = `run_sa${++n}`;
    const a = await subagents.spawn(request(runId), ctx(runId));
    const note: ChatMessage = { role: 'user', content: 'peer: the DB migration finished' };
    await subagents.message(a.agentId, note);
    const model = new FakeModelInvoker([{ text: 'ack' }]);
    await engine.runTurn({ session: { sessionId: a.sessionId, engineKind: 'native' }, host: fakeHost({ sessions, model, tools: new FakeDispatcher([]) }), limits: { maxToolCallsPerTurn: 4, repetitionThreshold: 3 }, signal: new AbortController().signal });
    assert.deepEqual(model.requests[0]!.messages.at(-1), note);

    await subagents.settle(a.agentId, { status: 'completed', summary: 'ok', evidenceRefs: [], recordRefs: [] }, ctx(runId));
    await assert.rejects(subagents.message(a.agentId, note), code('precondition_failed'));
    await assert.rejects(subagents.resume(a.agentId), code('precondition_failed'));

    const c = await subagents.spawn(request(runId, { workItemId: 'wi_cont', continuable: true, capability: rootCap(runId, 'wi_cont') }), ctx(runId));
    await subagents.settle(c.agentId, { status: 'completed', summary: 'first answer', evidenceRefs: [], recordRefs: [] }, ctx(runId));
    await subagents.message(c.agentId, { role: 'user', content: 'follow-up question' });
    assert.equal((await subagents.resume(c.agentId)).status, 'active', 'a continuable child can be resumed after completing');
    await assert.rejects(subagents.message('ag_missing', note), code('not_found'));
  });

  test('dispose cascades and is terminal', async () => {
    const runId = `run_sa${++n}`;
    const { root, child, grandchild } = await family(runId);
    const before = deps.events.events.length;
    await subagents.dispose(child.agentId, ctx(runId));
    assert.equal((await agents.get(child.agentId))?.status, 'disposed');
    assert.equal((await agents.get(grandchild.agentId))?.status, 'disposed');
    assert.equal((await sessions.get(grandchild.sessionId))?.status, 'disposed');
    assert.equal((await agents.get(root.agentId))?.status, 'active');
    assert.deepEqual(deps.events.events.slice(before).filter((e) => e.eventType === 'agent.disposed').map((e) => e.aggregateId), [grandchild.agentId, child.agentId]);
    await assert.rejects(agents.update(child.agentId, { status: 'active' }), code('conflict'));
    await assert.rejects(subagents.spawn(request(runId, { workItemId: 'wi_z', parentAgentId: grandchild.agentId, depth: 3, maxDepth: 5, capability: rootCap(runId, 'wi_z') }), ctx(runId)), code('precondition_failed'));
  });

  test('AgentRepository list filters by status', async () => {
    const runId = `run_sa${++n}`;
    const { root, child } = await family(runId);
    await subagents.settle(child.agentId, { status: 'failed', failure: { reason: 'boom', message: 'x' }, evidenceRefs: [], recordRefs: [] }, ctx(runId));
    assert.deepEqual((await agents.list({ runId, status: ['failed'] })).map((a) => a.agentId), [child.agentId]);
    assert.equal((await agents.list({ runId })).length, 3);
    assert.deepEqual(await agents.list({ runId, status: [] }), []);
    assert.equal((await agents.list({ runId, status: ['active'] }))[0]?.agentId, root.agentId);
  });
});
