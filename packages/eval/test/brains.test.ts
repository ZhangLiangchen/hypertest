/**
 * Scripted-brain helpers (hermetic): the request view a role brain sees, role dispatch (a role without a brain fails
 * its work item instead of hanging), tool-call wire names, id extraction, and the chaos model-timeout injection
 * (exactly the N-th model call of the trial, counted across providers and restarts).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HypertestError } from '@hypertest/core';
import type { ModelCallRequest, ScriptedBrain } from '@hypertest/model';
import { evidenceIdsIn, operationIdsIn, recordIdsIn, roleRouter, toolCall, viewOf, withModelTimeoutInjection, type BrainView, type ModelCallCounter } from '../src/index.ts';

const INFO = { callIndex: 0, routeModel: 'm' };

function request(role: string, extra: ModelCallRequest['messages'] = []): ModelCallRequest {
  return {
    model: 'm',
    messages: [
      { role: 'system', content: `[hypertest role=${role} work_item=wi_1 kind=task run=run_1]\nYou are the ${role}.` },
      { role: 'user', content: 'objective' },
      ...extra,
    ],
  };
}

describe('viewOf / roleRouter / toolCall', () => {
  test('the view: header fields, step = assistant messages so far, user text, tool results in order', () => {
    const v = viewOf(
      request('executor', [
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'test__run', arguments: {} }] },
        { role: 'tool', toolCallId: 'c1', toolName: 'test__run', content: 'failed ev_1', isError: false },
        { role: 'user', content: 'Results of pending operations' },
      ] as never),
    );
    assert.deepEqual([v.role, v.workItemId, v.kind, v.runId, v.step, v.userText], ['executor', 'wi_1', 'task', 'run_1', 1, 'objective\nResults of pending operations']);
    assert.deepEqual(v.toolResults, [{ name: 'test__run', content: 'failed ev_1', isError: false }]);
    assert.throws(() => viewOf({ model: 'm', messages: [{ role: 'system', content: 'no header' }] }), /request without a hypertest agent header/);
  });

  test('roleRouter dispatches on the role; a role without a brain fails its work item (fail_work) instead of hanging', async () => {
    const calls: BrainView[] = [];
    const brain = roleRouter({ lead: () => toolCall('plan.propose_revision', { rationale: 'r' }) }, calls);
    assert.deepEqual(await brain(request('lead'), INFO), { toolCalls: [{ name: 'plan__propose_revision', arguments: { rationale: 'r' } }] });
    assert.deepEqual(await brain(request('reviewer'), INFO), { toolCalls: [{ name: 'fail_work', arguments: { reason: 'agent_failed', message: 'no scripted brain for role reviewer' } }] });
    assert.deepEqual(calls.map((c) => c.role), ['lead', 'reviewer']);
    // an inherited property is not a brain
    assert.deepEqual(await roleRouter({})(request('constructor'), INFO), { toolCalls: [{ name: 'fail_work', arguments: { reason: 'agent_failed', message: 'no scripted brain for role constructor' } }] });
  });

  test('id extraction: deduplicated, in order of appearance, whole tokens only', () => {
    const text = 'ev_01A and ev_01B, again ev_01A; rec_9 op_X1 (operation op_X1) xev_nope';
    assert.deepEqual([evidenceIdsIn(text), recordIdsIn(text), operationIdsIn(text)], [['ev_01A', 'ev_01B'], ['rec_9'], ['op_X1']]);
    assert.deepEqual(evidenceIdsIn(''), []);
  });
});

describe('withModelTimeoutInjection', () => {
  test('exactly the N-th model call of the trial (across providers and restarts) is a provider timeout', async () => {
    const seen: string[] = [];
    const brains: Record<string, ScriptedBrain> = {
      a: () => (seen.push('a'), { text: 'a' }),
      b: () => (seen.push('b'), { text: 'b' }),
    };
    const counter: ModelCallCounter = { calls: 0, injected: 0 };
    const injectedAt: number[] = [];
    const first = withModelTimeoutInjection(brains, 3, counter, (n) => injectedAt.push(n));
    assert.deepEqual(await first['a']!(request('lead'), INFO), { text: 'a' });
    assert.deepEqual(await first['b']!(request('lead'), INFO), { text: 'b' });
    assert.deepEqual(await first['a']!(request('lead'), INFO), { error: 'timeout', message: 'eval chaos: injected model timeout on call 3' });
    // a restarted instance shares the counter: the injection never repeats
    const second = withModelTimeoutInjection(brains, 3, counter);
    assert.deepEqual(await second['b']!(request('lead'), INFO), { text: 'b' });
    assert.deepEqual([counter, injectedAt, seen], [{ calls: 4, injected: 1 }, [3], ['a', 'b', 'b']]);
  });

  test('no plan: the brains are returned unchanged; an invalid plan is invalid_argument', () => {
    const brains: Record<string, ScriptedBrain> = { a: () => ({ text: 'a' }) };
    assert.equal(withModelTimeoutInjection(brains, undefined), brains);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => withModelTimeoutInjection(brains, bad), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument', String(bad));
    }
  });
});
