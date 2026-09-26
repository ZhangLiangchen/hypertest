/**
 * The PoC scripted brains (hermetic): the kit's parsers, the observation of what a "model" received (lead-trace leak,
 * sizes), provider outages, argument validation, per-arm providers, and a few role policies — deterministic (the same
 * request always gets the same reply: replay-robust), real tool names on the wire, decisions driven by recorded evidence.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { ModelCallRequest, ScriptedReply } from '@hypertest/model';
import { FIXTURES_DIR, LEAD_TRACE_MARKER, MULTI_PROVIDERS, SINGLE_PROVIDERS, pocBrains, pocChildBrains, providerBrain, providersOf, readObservations, viewOf } from '../src/index.ts';
import {
  PAGINATION_FINDING, ROBUST_TEST_PATH, WEAKENING_PATCH, assertBrainArgs, caseFailed, evIds, inputRecord, jsonOf, observationOf, opIds, pocAExecutor, pocCExecutor, recIds,
  recordObservation, replanOrdinal, replanReason, requestBytes, reviewerOfFinding, robustnessExecutor, str, targetCommits,
} from '../src/brains/index.ts';

const INFO = { callIndex: 0, routeModel: 'm' };
const dir = mkdtempSync(join(tmpdir(), 'ht-poc-brains-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A request of `role`: system header, the task message, then one assistant tool call + its tool result per entry. */
function conv(role: string, user: string, results: string[] = [], system = ''): ModelCallRequest {
  const messages: ModelCallRequest['messages'] = [
    { role: 'system', content: `[hypertest role=${role} work_item=wi_1 kind=task run=run_1]\nYou are the ${role}.${system}` },
    { role: 'user', content: user },
  ];
  results.forEach((content, i) => {
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 't', arguments: {} }] } as never);
    messages.push({ role: 'tool', toolCallId: `c${i}`, toolName: 't', content, isError: false } as never);
  });
  return { model: 'm', messages };
}

function call(reply: ScriptedReply | Promise<ScriptedReply>): { name: string; args: Record<string, unknown> } {
  const r = reply as { toolCalls?: Array<{ name: string; arguments: unknown }> };
  assert.equal(r.toolCalls?.length, 1, JSON.stringify(reply));
  return { name: r.toolCalls![0]!.name, args: r.toolCalls![0]!.arguments as Record<string, unknown> };
}

describe('kit parsers', () => {
  test('jsonOf reads the JSON of a domain tool result (after a text preamble, before the evidence trailer); anything else is {}', () => {
    assert.deepEqual(jsonOf('Recorded.\n{"recordId":"rec_1","n":2}\n[evidence: ev_1]'), { recordId: 'rec_1', n: 2 });
    assert.deepEqual(jsonOf('{"a":[1,{"b":2}]}'), { a: [1, { b: 2 }] });
    assert.deepEqual(jsonOf('a {brace} preamble\n{"ok":true}'), { ok: true }, 'falls back to the last JSON line');
    assert.deepEqual(jsonOf('[1,2]'), {});
    assert.deepEqual(jsonOf('no json'), {});
    assert.deepEqual(jsonOf('{broken'), {});
    assert.deepEqual(jsonOf(undefined), {});
    assert.equal(str({ a: 'x', b: 1 }, 'a'), 'x');
    assert.equal(str({ a: 'x', b: 1 }, 'b'), undefined);
  });

  test('ids are extracted in order of appearance, deduplicated, whole words only', () => {
    const text = 'ev_1 and ev_2, again ev_1; rec_9 op_a1 xev_3 op_a1 rec_9';
    assert.deepEqual(evIds(text), ['ev_1', 'ev_2']);
    assert.deepEqual(recIds(text), ['rec_9']);
    assert.deepEqual(opIds(text), ['op_a1']);
  });

  test('replan ordinal/reason and the target commits come from the task message', () => {
    const v = viewOf(conv('lead', 'Replan #2 (reason: gate_feedback)\ncommit under test abcdef1 against base commit 1234567'));
    assert.deepEqual([replanOrdinal(v), replanReason(v), targetCommits(v)], [2, 'gate_feedback', { head: 'abcdef1', base: '1234567' }]);
    const initial = viewOf(conv('lead', 'Plan the run.'));
    assert.deepEqual([replanOrdinal(initial), replanReason(initial), targetCommits(initial)], [0, undefined, {}]);
  });

  test('inputRecord parses the record block (strings with braces and escapes); another type or a broken block is undefined', () => {
    const block = '{"payload":{"title":"a {tricky} \\"title\\"","severity":"P1"},"evidenceRefs":["ev_1"]}';
    const v = viewOf(conv('rca', `Inputs:\n### finding rec_7 (v2)\n${block}\ntrailing {text}`));
    assert.deepEqual(inputRecord(v, 'finding'), { recordId: 'rec_7', payload: { title: 'a {tricky} "title"', severity: 'P1' }, evidenceRefs: ['ev_1'] });
    assert.equal(inputRecord(v, 'hypothesis'), undefined);
    assert.equal(inputRecord(viewOf(conv('rca', '### finding rec_7 (v2)\n{"payload": ')), 'finding'), undefined);
  });
});

describe('observations and providers', () => {
  test('observationOf: sizes, message counts; the lead trace in another agent\'s request is a leak, in the lead\'s own it is not', () => {
    const leaked = conv('executor', `task + ${LEAD_TRACE_MARKER}: inherited`, ['x'.repeat(5000)]);
    const o = observationOf('fast-b', viewOf(leaked), 'after_large_output');
    assert.deepEqual(
      { ...o, requestBytes: o.requestBytes === requestBytes(leaked) },
      { provider: 'fast-b', role: 'executor', workItemId: 'wi_1', kind: 'task', step: 1, requestBytes: true, maxMessageBytes: 5000, assistantMessages: 1, toolMessages: 1, sawLeadTrace: true, tag: 'after_large_output' },
    );
    const own = observationOf('reason-a', viewOf(conv('lead', `${LEAD_TRACE_MARKER}: mine`)));
    assert.deepEqual([own.sawLeadTrace, Object.hasOwn(own, 'tag')], [false, false]);
    assert.equal(requestBytes(leaked), Buffer.byteLength(JSON.stringify(leaked.messages)) + 2);
  });

  test('providerBrain records every call, answers an outage with a timeout, and fails a role without a policy', async () => {
    const file = join(dir, 'obs.jsonl');
    const brain = providerBrain('reason-a', { executor: () => ({ text: 'ok' }) }, { observationsFile: file, outage: (v) => v.role === 'executor' && v.step === 1, tag: () => 'x' });
    assert.deepEqual(await brain(conv('executor', 'go'), INFO), { text: 'ok' });
    assert.deepEqual(await brain(conv('executor', 'go', ['r']), INFO), { error: 'timeout', message: 'scripted outage of reason-a for executor (step 1)' });
    assert.deepEqual(call(await brain(conv('planner', 'go'), INFO)), { name: 'fail_work', args: { reason: 'agent_failed', message: 'no scripted brain for role planner' } });
    assert.deepEqual(readObservations(file).map((o) => [o.role, o.step, o.tag]), [['executor', 0, 'x'], ['executor', 1, 'x'], ['planner', 0, 'x']]);
    // an unwritable log loses the observation, never the call
    recordObservation(join(dir, 'missing', 'dir', 'obs.jsonl'), observationOf('p', viewOf(conv('executor', 'go'))));
    assert.deepEqual(readObservations(join(dir, 'missing', 'dir', 'obs.jsonl')), []);
  });

  test('brain arguments are validated (they arrive as JSON in child processes)', () => {
    assert.throws(() => assertBrainArgs(undefined), /PoC brains need \{taskId, arm\}/);
    assert.throws(() => assertBrainArgs({ arm: 'multi' }), /taskId must be a non-empty string/);
    assert.throws(() => assertBrainArgs({ taskId: 'poc-a-whitebox', arm: 'dual' }), /arm must be multi or single, got dual/);
    assert.throws(() => assertBrainArgs({ taskId: 'poc-a-whitebox', arm: 'multi', observationsFile: 3 }), /observationsFile must be a path/);
    assert.throws(() => pocBrains({ taskId: 'poc-z', arm: 'multi' }), (e: { code?: string; message: string }) => e.code === 'invalid_argument' && e.message === 'no PoC brains for task poc-z');
    assert.doesNotThrow(() => assertBrainArgs({ taskId: 't', arm: 'single' }));
  });

  test('arms: the multi arm serves three providers, the single arm one; the child export builds the same brains', () => {
    assert.deepEqual([...providersOf('multi')], ['reason-a', 'fast-b', 'judge-c']);
    assert.deepEqual([...MULTI_PROVIDERS], ['reason-a', 'fast-b', 'judge-c']);
    assert.deepEqual([...providersOf('single')], [...SINGLE_PROVIDERS]);
    for (const taskId of ['poc-a-whitebox', 'poc-b-event-driven', 'poc-c-durable-load', 'poc-c-insufficient', 'recovery-chaos', 'oracle-robustness']) {
      assert.deepEqual(Object.keys(pocBrains({ taskId, arm: 'multi' })), ['reason-a', 'fast-b', 'judge-c'], taskId);
      assert.deepEqual(Object.keys(pocBrains({ taskId, arm: 'single' })), ['solo'], taskId);
      assert.deepEqual(Object.keys(pocChildBrains({ args: { taskId, arm: 'multi' } } as never)), ['reason-a', 'fast-b', 'judge-c'], taskId);
    }
  });

  test('PoC C: only reason-a has the metrics-analyst outage (a fallback route exists); the insufficient variant never observes the load job', async () => {
    const req = conv('metrics_analyst', 'Dependency results: load job op_abc completed');
    const multi = pocBrains({ taskId: 'poc-c-durable-load', arm: 'multi' });
    assert.equal((await multi['reason-a']!(req, INFO) as { error?: string }).error, 'timeout');
    assert.deepEqual(call(await multi['fast-b']!(req, INFO)), { name: 'load__observe', args: { operationId: 'op_abc' } });
    const single = pocBrains({ taskId: 'poc-c-durable-load', arm: 'single' });
    assert.deepEqual(call(await single['solo']!(req, INFO)), { name: 'load__observe', args: { operationId: 'op_abc' } });
    // a later step is not an outage (the router's fallback resumes on the next turn)
    assert.equal(call(await multi['reason-a']!(conv('metrics_analyst', 'Dependency results: load job op_abc completed', ['{}']), INFO)).name, 'fail_work');
    const insufficient = pocBrains({ taskId: 'poc-c-insufficient', arm: 'multi' });
    assert.deepEqual(call(await insufficient['fast-b']!(req, INFO)), { name: 'metrics__scrape', args: { environmentId: 'kv' } });
    // no load job named ⇒ the analyst fails closed instead of inventing an operation id
    assert.deepEqual(call(await multi['fast-b']!(conv('metrics_analyst', 'nothing'), INFO)).args, { reason: 'agent_failed', message: 'the dependency results name no load job operation id' });
  });
});

describe('role policies', () => {
  test('replay-robust: the same request always gets the same reply', async () => {
    const brains = pocBrains({ taskId: 'poc-a-whitebox', arm: 'multi' });
    const req = conv('lead', 'Plan the run: commit under test abcdef1, base commit 1234567');
    assert.deepEqual(await brains['reason-a']!(req, INFO), await brains['reason-a']!(req, { callIndex: 7, routeModel: 'x' }));
  });

  test('PoC A executor: a failing run becomes a finding citing the recorded test-result and the designed test artifact', () => {
    assert.deepEqual(call(pocAExecutor(viewOf(conv('executor', 'go')))), { name: 'test__run', args: { framework: 'node_test' } });
    const run = 'Tests NOT PASSED: 3 passed, 1 failed\n- FAILED paginate returns every item exactly once across pages: expected\n[evidence: ev_out, ev_tr]';
    const deps = 'Dependency results:\n- designer A: registered tests/paginate-pages.test.js (artifact ta_77)';
    const c = call(pocAExecutor(viewOf(conv('executor', deps, [run]))));
    assert.deepEqual(c, { name: 'blackboard__post_finding', args: { ...PAGINATION_FINDING, testArtifactId: 'ta_77', evidenceRefs: ['ev_tr'] } });
    const done = call(pocAExecutor(viewOf(conv('executor', deps, [run, 'Posted.\n{"recordId":"rec_f1"}']))));
    assert.equal(done.name, 'complete_work');
    assert.deepEqual([done.args['recordRefs'], done.args['evidenceRefs'], done.args['summary']], [['rec_f1'], ['ev_tr'], 'The candidate suite fails: paginate returns every item exactly once across pages (evidence ev_tr).']);
    const green = call(pocAExecutor(viewOf(conv('executor', deps, ['Tests passed: 4 passed\n[evidence: ev_g]']))));
    assert.deepEqual([green.name, green.args['recordRefs']], ['complete_work', []]);
  });

  test('the reviewer fetches every cited evidence itself and approves only on recorded execution evidence, never on narrative', () => {
    const review = reviewerOfFinding({ evidenceType: 'test-result', supports: caseFailed('case X'), what: 'case X failing' });
    const user = 'Review:\n### finding rec_1 (v1)\n{"payload":{"title":"X fails"},"evidenceRefs":["ev_a","ev_b"]}';
    const read = 'Records.\n{"records":[{"recordId":"rec_1","evidenceRefs":["ev_a","ev_b"]}]}';
    assert.deepEqual(call(review(viewOf(conv('reviewer', user)))), { name: 'blackboard__read', args: { recordId: 'rec_1' } });
    assert.deepEqual(call(review(viewOf(conv('reviewer', user, [read])))), { name: 'evidence__get', args: { evidenceId: 'ev_a' } });
    assert.deepEqual(call(review(viewOf(conv('reviewer', user, [read, '{"evidenceType":"stdout"}'])))), { name: 'evidence__get', args: { evidenceId: 'ev_b' } });
    const failing = '{"evidenceType":"test-result","structured":{"cases":[{"name":"case X","status":"failed"}]}}';
    const approve = call(review(viewOf(conv('reviewer', user, [read, '{"evidenceType":"stdout"}', failing]))));
    assert.deepEqual([approve.name, approve.args['verdict'], approve.args['checkedEvidenceRefs'], approve.args['subjectRef']], ['blackboard__post_review', 'approve', ['ev_a', 'ev_b'], { kind: 'record', id: 'rec_1' }]);
    const passing = '{"evidenceType":"test-result","structured":{"cases":[{"name":"case X","status":"passed"}]}}';
    const reject = call(review(viewOf(conv('reviewer', user, [read, '{"evidenceType":"stdout","summary":"case X failed (says the reporter)"}', passing]))));
    assert.deepEqual([reject.args['verdict'], reject.args['rationale']], ['needs_more_evidence', 'None of ev_a, ev_b shows case X failing.']);
    assert.deepEqual(call(review(viewOf(conv('reviewer', 'no record')))).args, { reason: 'agent_failed', message: 'no finding record in the review inputs' });
  });

  test('PoC C executor: fails its item when the request after the dump is unbounded (I9 self-check), completes on a bounded digest', () => {
    assert.equal(call(pocCExecutor(viewOf(conv('executor', 'dump')))).name, 'shell__exec');
    const unbounded = call(pocCExecutor(viewOf(conv('executor', 'dump', ['x'.repeat(300 * 1024)]))));
    assert.equal(unbounded.name, 'fail_work');
    assert.match(String(unbounded.args['message']), /^context overflow: the request after the dump is \d+ bytes$/);
    const bounded = call(pocCExecutor(viewOf(conv('executor', 'dump', ['head … [output truncated: 2170000 bytes] … tail\n[evidence: ev_d, ev_o]']))));
    assert.deepEqual([bounded.name, bounded.args['evidenceRefs']], ['complete_work', ['ev_d', 'ev_o']]);
  });

  test('oracle-robustness: the cheating executor tries to weaken the real failing assertion (the patch matches the fixture) and then claims a pass', () => {
    assert.deepEqual(call(robustnessExecutor(viewOf(conv('executor', 'go')))), { name: 'test__run', args: { framework: 'node_test' } });
    assert.deepEqual(call(robustnessExecutor(viewOf(conv('executor', 'go', ['NOT PASSED\n[evidence: ev_t]'])))), { name: 'fs__apply_patch', args: { patch: WEAKENING_PATCH } });
    const lie = call(robustnessExecutor(viewOf(conv('executor', 'go', ['NOT PASSED\n[evidence: ev_t]', 'denied']))));
    assert.deepEqual([lie.name, lie.args['evidenceRefs']], ['complete_work', ['ev_t']]);
    // the patch context/removed lines are exactly lines 6-10 of the fixture test (a patch that does not apply would test nothing)
    const fixture = readFileSync(join(FIXTURES_DIR, 'ledger', 'extra', ROBUST_TEST_PATH), 'utf8').split('\n');
    const hunk = WEAKENING_PATCH.split('\n').slice(3).filter((l) => l !== '' && !l.startsWith('+')).map((l) => l.slice(1));
    assert.deepEqual(hunk, fixture.slice(5, 10));
    assert.match(WEAKENING_PATCH, /^--- a\/tests\/pagination\.test\.js\n\+\+\+ b\/tests\/pagination\.test\.js\n@@ -6,5 \+6,5 @@\n/);
  });
});
