import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isHypertestError, type SqlDatabase } from '@hypertest/core';
import type { AssistantMessage, ChatMessage, ToolResultMessage } from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';
import { createSessionStore, runtimeMigrations, type SessionStore } from '../src/index.ts';
import { baseDeps, faultyDb } from './helpers.ts';

const code = (c: string) => (e: unknown) => isHypertestError(e, c as never);
const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 };

function response(...ids: string[]): AssistantMessage {
  const m: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'calling tools' }] };
  if (ids.length > 0) m.toolCalls = ids.map((id) => ({ id, name: `tool_${id}`, arguments: { id } }));
  return m;
}
function rows(sessionId: string, turn: number, ...ids: string[]) {
  return ids.map((id) => ({ toolCallId: id, name: `tool_${id}`, invocationId: `${sessionId}:${turn}:${id}` }));
}
function result(id: string, content = `result ${id}`): ToolResultMessage {
  return { role: 'tool', toolCallId: id, toolName: `tool_${id}`, content };
}

describe('SessionStore', () => {
  let db: SqlDatabase;
  let dispose: () => Promise<void>;
  let store: SessionStore;
  let deps: ReturnType<typeof baseDeps>;
  let n = 0;

  before(async () => {
    ({ db, dispose } = await createTestDatabase({ migrations: runtimeMigrations }));
    deps = baseDeps();
    store = createSessionStore({ ...deps, db });
  });
  after(async () => dispose());

  async function fresh(): Promise<string> {
    n += 1;
    const sessionId = `sess_t${n}`;
    await store.create({ sessionId, runId: 'run_s', agentId: `agent_${n}`, engineKind: 'native' });
    return sessionId;
  }

  test('create/get round-trips and duplicates conflict', async () => {
    const id = await fresh();
    const s = await store.get(id);
    assert.deepEqual(s, { sessionId: id, runId: 'run_s', agentId: `agent_${n}`, engineKind: 'native', status: 'active', turnCount: 0, createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' });
    await assert.rejects(store.create({ sessionId: id, runId: 'run_s', agentId: 'x', engineKind: 'native' }), code('conflict'));
    assert.equal(await store.get('sess_missing'), undefined);
    await assert.rejects(store.transcript('sess_missing'), code('not_found'));
  });

  test('transcript keeps append order and turn tags', async () => {
    const id = await fresh();
    await store.appendTranscript(id, [{ turn: 0, message: { role: 'system', content: 's' } }, { turn: 0, message: { role: 'user', content: 'u' } }]);
    await store.appendTranscript(id, [{ turn: 1, message: { role: 'user', content: 'u2' } }]);
    assert.deepEqual((await store.transcript(id)).map((e) => [e.turn, e.message.role]), [[0, 'system'], [0, 'user'], [1, 'user']]);
    await assert.rejects(store.appendTranscript(id, [{ turn: -1, message: { role: 'user', content: 'x' } }]), code('invalid_argument'));
    await assert.rejects(store.appendTranscript(id, [{ turn: 1, message: { role: 'robot', content: 'x' } as unknown as ChatMessage }]), code('invalid_argument'));
  });

  test('beginTurn is idempotent and enforces turn order', async () => {
    const id = await fresh();
    await assert.rejects(store.beginTurn(id, 2, {}), code('precondition_failed'));
    const t1 = await store.beginTurn(id, 1, { snapshotId: 'cs_1' });
    assert.equal(t1.status, 'started');
    assert.equal(t1.snapshotId, 'cs_1');
    const again = await store.beginTurn(id, 1, { snapshotId: 'cs_other' });
    assert.deepEqual(again, t1, 'returns the existing record unchanged');
    await assert.rejects(store.beginTurn(id, 2, {}), code('precondition_failed'), 'turn 1 is not settled');
    await store.completeTurn(id, 1, 'boundary');
    assert.equal((await store.beginTurn(id, 2, {})).turn, 2);
    await assert.rejects(store.beginTurn('sess_missing', 1, {}), code('not_found'));
  });

  test('recordModelResponse persists the response and pending tool-call rows; idempotent; different response ⇒ conflict', async () => {
    const id = await fresh();
    await store.beginTurn(id, 1, {});
    const r = response('a', 'b');
    const t = await store.recordModelResponse(id, 1, r, usage, rows(id, 1, 'a', 'b'), { epochId: 'ep_1', routeId: 'route_1' });
    assert.equal(t.status, 'model_responded');
    assert.deepEqual(t.response, r);
    assert.deepEqual(t.usage, usage);
    assert.equal(t.epochId, 'ep_1');
    assert.equal(t.routeId, 'route_1');
    assert.deepEqual(t.toolCalls, [
      { toolCallId: 'a', name: 'tool_a', invocationId: `${id}:1:a`, status: 'pending' },
      { toolCallId: 'b', name: 'tool_b', invocationId: `${id}:1:b`, status: 'pending' },
    ]);
    assert.deepEqual(await store.recordModelResponse(id, 1, r, usage, rows(id, 1, 'a', 'b')), t);
    await assert.rejects(store.recordModelResponse(id, 1, response('a'), usage, rows(id, 1, 'a')), code('conflict'));
  });

  test('recordModelResponse validates that the rows are exactly the response tool calls', async () => {
    const id = await fresh();
    await store.beginTurn(id, 1, {});
    await assert.rejects(store.recordModelResponse(id, 1, response('a', 'b'), usage, rows(id, 1, 'a')), code('invalid_argument'));
    await assert.rejects(store.recordModelResponse(id, 1, response('a', 'b'), usage, rows(id, 1, 'b', 'a')), code('invalid_argument'));
    await assert.rejects(store.recordModelResponse(id, 1, response('a', 'a'), usage, rows(id, 1, 'a', 'a')), code('invalid_argument'));
    await assert.rejects(store.recordModelResponse(id, 2, response(), usage, []), code('not_found'));
    assert.equal((await store.getTurn(id, 1))?.status, 'started');
  });

  test('recordModelResponse is atomic: a failing tool-call insert leaves no response and no rows', async () => {
    const id = await fresh();
    await store.beginTurn(id, 1, {});
    const faulty = faultyDb(db, (sql, params) => sql.includes('INSERT INTO ht_tool_calls') && params?.[2] === 'b');
    const flaky = createSessionStore({ ...deps, db: faulty });
    await assert.rejects(flaky.recordModelResponse(id, 1, response('a', 'b'), usage, rows(id, 1, 'a', 'b')), /injected fault/);
    assert.equal(faulty.hits, 1);
    const t = await store.getTurn(id, 1);
    assert.equal(t?.status, 'started');
    assert.equal(t?.response, undefined);
    assert.deepEqual(t?.toolCalls, [], 'the first row inserted before the fault was rolled back');
    // after the fault the same call succeeds
    faulty.armed = false;
    assert.equal((await flaky.recordModelResponse(id, 1, response('a', 'b'), usage, rows(id, 1, 'a', 'b'))).toolCalls.length, 2);
  });

  test('a reused invocation id is refused and rolls the response back', async () => {
    const id = await fresh();
    await store.beginTurn(id, 1, {});
    await store.recordModelResponse(id, 1, response('a'), usage, rows(id, 1, 'a'));
    await store.settleToolCall(id, 1, 'a', { result: result('a') });
    await store.completeTurn(id, 1, 'completed');
    await store.beginTurn(id, 2, {});
    await assert.rejects(store.recordModelResponse(id, 2, response('z'), usage, [{ toolCallId: 'z', name: 'tool_z', invocationId: `${id}:1:a` }]), code('conflict'));
    const t2 = await store.getTurn(id, 2);
    assert.equal(t2?.status, 'started');
    assert.equal(t2?.response, undefined);
  });

  test('settleToolCall is idempotent; a different outcome conflicts; the result is required', async () => {
    const id = await fresh();
    await store.beginTurn(id, 1, {});
    await store.recordModelResponse(id, 1, response('a', 'b'), usage, rows(id, 1, 'a', 'b'));
    await assert.rejects(store.settleToolCall(id, 1, 'a', {}), code('invalid_argument'));
    await assert.rejects(store.settleToolCall(id, 1, 'a', { result: result('b') }), code('invalid_argument'));
    await assert.rejects(store.settleToolCall(id, 1, 'nope', { result: result('nope') }), code('not_found'));
    const terminal = { kind: 'complete' as const, summary: 'done', evidenceRefs: ['ev_1'], recordRefs: [] };
    await store.settleToolCall(id, 1, 'a', { result: result('a'), terminal, pendingOperationId: 'op_1' });
    await store.settleToolCall(id, 1, 'a', { result: result('a'), terminal, pendingOperationId: 'op_1' });
    await assert.rejects(store.settleToolCall(id, 1, 'a', { result: result('a', 'other text'), terminal, pendingOperationId: 'op_1' }), code('conflict'));
    await assert.rejects(store.settleToolCall(id, 1, 'a', { result: result('a') }), code('conflict'));
    const t = await store.getTurn(id, 1);
    assert.deepEqual(t?.toolCalls[0], { toolCallId: 'a', name: 'tool_a', invocationId: `${id}:1:a`, status: 'settled', result: result('a'), pendingOperationId: 'op_1', terminal });
    assert.equal(t?.toolCalls[1]?.status, 'pending');
  });

  test('completeTurn(completed) requires every tool call settled; boundary/failed do not', async () => {
    const id = await fresh();
    await store.beginTurn(id, 1, {});
    await assert.rejects(store.completeTurn(id, 1, 'completed'), code('precondition_failed'), 'no response yet');
    await store.recordModelResponse(id, 1, response('a', 'b'), usage, rows(id, 1, 'a', 'b'));
    await store.settleToolCall(id, 1, 'a', { result: result('a') });
    await assert.rejects(store.completeTurn(id, 1, 'completed'), (e: unknown) => isHypertestError(e, 'precondition_failed') && (e.details['pending'] as string[]).join() === 'b');
    assert.equal((await store.getTurn(id, 1))?.status, 'model_responded');
    await store.completeTurn(id, 1, 'failed');
    assert.equal((await store.getTurn(id, 1))?.status, 'failed');
    await store.completeTurn(id, 1, 'failed');
    await assert.rejects(store.completeTurn(id, 1, 'completed'), code('conflict'));
    await assert.rejects(store.settleToolCall(id, 1, 'b', { result: result('b') }), code('precondition_failed'));
    assert.equal((await store.get(id))?.turnCount, 1);
  });

  test('completeTurn applies transcript, queued input and session status in one transaction, once', async () => {
    const id = await fresh();
    await store.beginTurn(id, 1, {});
    await store.recordModelResponse(id, 1, response(), usage, []);
    const nudge: ChatMessage = { role: 'user', content: 'nudge' };
    const options = { append: [{ turn: 1, message: response() as ChatMessage }], enqueue: [nudge], sessionStatus: 'waiting' as const };

    const faulty = faultyDb(db, (sql) => sql.includes('INSERT INTO ht_agent_inbox'));
    await assert.rejects(createSessionStore({ ...deps, db: faulty }).completeTurn(id, 1, 'completed', options), /injected fault/);
    assert.equal((await store.getTurn(id, 1))?.status, 'model_responded', 'turn status rolled back');
    assert.deepEqual(await store.transcript(id), [], 'append rolled back');
    assert.equal((await store.get(id))?.status, 'active');

    await store.completeTurn(id, 1, 'completed', options);
    await store.completeTurn(id, 1, 'completed', options);
    assert.deepEqual((await store.transcript(id)).map((e) => e.turn), [1], 'a repeated completion appends nothing');
    assert.deepEqual(await store.drainInput(id), [nudge]);
    const s = await store.get(id);
    assert.equal(s?.status, 'waiting');
    assert.equal(s?.turnCount, 1);
  });

  test('drainInput hands every queued message out exactly once under concurrent drains', async () => {
    const id = await fresh();
    const msgs: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    await store.enqueueInput(id, msgs.slice(0, 10));
    await store.enqueueInput(id, msgs.slice(10));
    const drains = await Promise.all(Array.from({ length: 5 }, () => store.drainInput(id)));
    const all = drains.flat().map((m) => (m.role === 'user' ? m.content : ''));
    assert.equal(all.length, 20);
    assert.deepEqual([...all].sort(), msgs.map((m) => (m.role === 'user' ? m.content : '')).sort());
    for (const d of drains) {
      const order = d.map((m) => Number((m.role === 'user' ? m.content : '').slice(1)));
      assert.deepEqual(order, [...order].sort((a, b) => a - b), 'each drain returns messages in enqueue order');
    }
    assert.deepEqual(await store.drainInput(id), []);
    await assert.rejects(store.enqueueInput('sess_missing', msgs.slice(0, 1)), code('not_found'));
  });

  test('drainInputInto is atomic: a failed transcript append leaves the inputs queued', async () => {
    const id = await fresh();
    const msg: ChatMessage = { role: 'user', content: 'wake up' };
    await store.enqueueInput(id, [msg]);
    const faulty = faultyDb(db, (sql) => sql.includes('INSERT INTO ht_transcript'));
    await assert.rejects(createSessionStore({ ...deps, db: faulty }).drainInputInto!(id, 1, [{ role: 'user', content: 'extra' }]), /injected fault/);
    const entries = await store.drainInputInto!(id, 1, [{ role: 'user', content: 'extra' }]);
    assert.deepEqual(entries, [{ turn: 1, message: msg }, { turn: 1, message: { role: 'user', content: 'extra' } }]);
    assert.deepEqual(await store.transcript(id), entries);
  });

  test('create with an initial transcript is atomic: a failed transcript insert leaves no session', async () => {
    n += 1;
    const sessionId = `sess_t${n}`;
    const initial = [{ turn: 0, message: { role: 'user', content: 'the task' } as ChatMessage }];
    const faulty = faultyDb(db, (sql) => sql.includes('INSERT INTO ht_transcript'));
    await assert.rejects(createSessionStore({ ...deps, db: faulty }).create({ sessionId, runId: 'run_s', agentId: 'agent_atomic', engineKind: 'native' }, initial), /injected fault/);
    assert.equal(faulty.hits, 1);
    assert.equal(await store.get(sessionId), undefined, 'the session row was rolled back with the transcript');
    await store.create({ sessionId, runId: 'run_s', agentId: 'agent_atomic', engineKind: 'native' }, initial);
    assert.deepEqual(await store.transcript(sessionId), initial);
    await assert.rejects(store.create({ sessionId: `${sessionId}_bad`, runId: 'run_s', agentId: 'a', engineKind: 'native' }, [{ turn: -1, message: { role: 'user', content: 'x' } }]), code('invalid_argument'));
    assert.equal(await store.get(`${sessionId}_bad`), undefined);
  });

  test('completeTurn records the turn outcome (validated) with the completion, once', async () => {
    const id = await fresh();
    await store.beginTurn(id, 1, {});
    await store.recordModelResponse(id, 1, response('a'), usage, rows(id, 1, 'a'));
    const terminal = { kind: 'complete' as const, summary: 'done', evidenceRefs: ['ev_1'], recordRefs: [] };
    await store.settleToolCall(id, 1, 'a', { result: result('a'), terminal });
    await assert.rejects(store.completeTurn(id, 1, 'completed', { outcome: { status: 'finished' as never } }), code('invalid_argument'));
    const outcome = { status: 'completed' as const, completion: terminal };
    await store.completeTurn(id, 1, 'completed', { sessionStatus: 'completed', outcome });
    await store.completeTurn(id, 1, 'completed', { outcome: { status: 'failed', failure: { reason: 'x', message: 'y' } } });
    assert.deepEqual((await store.getTurn(id, 1))?.outcome, outcome, 'a repeated completion does not rewrite the outcome');
    assert.deepEqual((await store.lastTurn(id))?.outcome, outcome);
  });

  test('a turn completion never reactivates a session interrupted meanwhile; a terminal outcome still closes it; disposed is final', async () => {
    const completeWith = async (id: string, turn: number, sessionStatus: 'active' | 'waiting' | 'completed' | 'failed') => {
      await store.beginTurn(id, turn, {});
      await store.recordModelResponse(id, turn, response(), usage, []);
      await store.setStatus(id, 'interrupted'); // the interrupt lands while the turn runs (e.g. from another process)
      await store.completeTurn(id, turn, 'completed', { sessionStatus });
      return (await store.get(id))?.status;
    };
    const a = await fresh();
    assert.equal(await completeWith(a, 1, 'active'), 'interrupted');
    const b = await fresh();
    assert.equal(await completeWith(b, 1, 'waiting'), 'interrupted');
    const c = await fresh();
    assert.equal(await completeWith(c, 1, 'completed'), 'completed');
    const d = await fresh();
    assert.equal(await completeWith(d, 1, 'failed'), 'failed');
    const e = await fresh();
    await store.beginTurn(e, 1, {});
    await store.recordModelResponse(e, 1, response(), usage, []);
    await store.setStatus(e, 'disposed');
    await store.completeTurn(e, 1, 'completed', { sessionStatus: 'completed' });
    assert.equal((await store.get(e))?.status, 'disposed');
  });

  test('status, native state and compactions', async () => {
    const id = await fresh();
    await store.setNativeState(id, { compatibilityClass: 'pi:v1', data: { cursor: 3 } });
    assert.deepEqual((await store.get(id))?.nativeState, { compatibilityClass: 'pi:v1', data: { cursor: 3 } });
    await assert.rejects(store.setNativeState(id, { compatibilityClass: '', data: null }), code('invalid_argument'));
    await store.addCompaction(id, { compactionId: 'cmp_1', level: 'soft', upToTurn: 2, summary: 'did things', evidenceRefs: ['ev_9'], createdAt: '2026-02-01T00:00:00.000Z' });
    assert.deepEqual(await store.compactions(id), [{ compactionId: 'cmp_1', level: 'soft', upToTurn: 2, summary: 'did things', evidenceRefs: ['ev_9'], createdAt: '2026-02-01T00:00:00.000Z' }]);
    await store.setStatus(id, 'disposed');
    await assert.rejects(store.setStatus(id, 'active'), code('conflict'));
    await assert.rejects(store.beginTurn(id, 1, {}), code('precondition_failed'));
    await assert.rejects(store.setStatus('sess_missing', 'active'), code('not_found'));
  });
});
