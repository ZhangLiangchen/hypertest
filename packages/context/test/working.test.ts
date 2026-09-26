import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SequentialIdGenerator, jsonClone } from '@hypertest/core';
import { estimateTokens, textOf, type ChatMessage, type ToolResultMessage } from '@hypertest/domain';
import { MemoryArtifactStore } from '@hypertest/evidence';
import { createWorkingContextManager, deterministicSummarizer, offloadToolResult, type Compaction, type Summarizer, type TranscriptEntry } from '../src/index.ts';
import { at, orphanedToolResults, rejectsWith, result, say, user } from './helpers.ts';

/**
 * Turns 0..7. Turn 2 issues two parallel calls; the result of c5 settles late and is recorded at turn 3.
 * Turn 5 issues c9 whose result is recorded at turn 6.
 */
function transcript(): TranscriptEntry[] {
  return [
    at(0, user('Goal: decide whether checkout change is releasable. Prior evidence ev_seed01.')),
    at(0, say('I will read the diff and the handler in parallel.', [{ id: 'c1', name: 'fs.read', args: { path: 'src/checkout.ts' } }, { id: 'c2', name: 'git.diff', args: { base: 'main' } }])),
    at(0, result('c1', 'fs.read', 'export function checkout() {}\n...')),
    at(0, result('c2', 'git.diff', 'diff --git a/src/checkout.ts ...')),
    at(1, say('Running the unit suite.', [{ id: 'c3', name: 'test.run', args: { selector: 'test/checkout.test.ts' } }])),
    at(1, result('c3', 'test.run', 'FAIL checkout rejects empty cart: expected 400 got 500 (evidence ev_run0001)', true)),
    at(2, say('Recording the finding and reproducing over HTTP.', [{ id: 'c4', name: 'blackboard.post', args: { type: 'finding' } }, { id: 'c5', name: 'http.request', args: { path: '/checkout' } }])),
    at(2, result('c4', 'blackboard.post', 'posted rec_find01 for work item wi_exec01')),
    at(3, result('c5', 'http.request', 'HTTP 500 (evidence ev_http0001)')),
    at(3, say('The HTTP reproduction confirms the defect.')),
    at(4, say('Asking RCA to analyse.', [{ id: 'c6', name: 'delegate', args: { role: 'rca' } }])),
    at(4, result('c6', 'delegate', 'spawned wi_rca001')),
    at(5, say('Waiting on RCA.', [{ id: 'c9', name: 'work.wait', args: { id: 'wi_rca001' } }])),
    at(6, result('c9', 'work.wait', 'RCA done: null deref in cart total (evidence ev_rca0001)')),
    at(6, say('Summarising results.')),
    at(7, say('Ready for the gate.')),
  ];
}

class RecordingSummarizer implements Summarizer {
  calls: Array<{ messages: ChatMessage[]; instructions: string; maxTokens: number }> = [];
  readonly reply: string;
  constructor(reply: string) {
    this.reply = reply;
  }
  async summarize(input: { messages: ChatMessage[]; instructions: string; maxTokens: number }): Promise<string> {
    this.calls.push(input);
    return this.reply;
  }
}

const ids = () => new SequentialIdGenerator();

test('view without compactions: every message in turn order, pressure from the ratios', () => {
  const m = createWorkingContextManager();
  const t = transcript();
  const v = m.view({ transcript: [...t].sort((a, b) => b.turn - a.turn), compactions: [], budgetTokens: 100_000 });
  assert.deepEqual(v.messages, t.map((e) => e.message), 'sorted by turn, original order inside a turn');
  assert.equal(v.tokens, estimateTokens(v.messages));
  assert.equal(v.pressure, 'none');
  assert.equal(m.view({ transcript: t, compactions: [], budgetTokens: Math.floor(v.tokens / 0.7) }).pressure, 'soft');
  assert.equal(m.view({ transcript: t, compactions: [], budgetTokens: Math.floor(v.tokens / 0.7) + 2 }).pressure, 'none');
  assert.equal(m.view({ transcript: t, compactions: [], budgetTokens: Math.floor(v.tokens / 0.95) }).pressure, 'hard');
  assert.equal(m.view({ transcript: t, compactions: [], budgetTokens: Math.floor(v.tokens / 0.95) + 2 }).pressure, 'soft');
});

test('view never orphans tool results: a cut that would split parallel calls from late results moves earlier', () => {
  const m = createWorkingContextManager();
  const t = transcript();
  const c: Compaction = { compactionId: 'cmp_1', level: 'soft', upToTurn: 2, summary: 'Earlier: found the defect.', evidenceRefs: ['ev_seed01', 'ev_run0001'], createdAt: '2026-01-01T00:00:00.000Z' };
  const v = m.view({ transcript: t, compactions: [c], budgetTokens: 100_000 });
  assert.deepEqual(v.messages[0], { role: 'user', content: 'Summary of earlier work (turns 0..2): Earlier: found the defect.\nEvidence referenced: ev_seed01, ev_run0001' });
  // c5's result sits at turn 3, its call at turn 2 ⇒ the turn-2 assistant message (and c4's result) stay verbatim.
  assert.deepEqual(v.messages[1], t[6]!.message);
  assert.deepEqual(orphanedToolResults(v.messages), []);

  // Property: for every cut and for the last compaction only, no view has orphaned tool results.
  for (let cut = -1; cut <= 7; cut++) {
    const older: Compaction = { ...c, compactionId: 'cmp_0', upToTurn: 0 };
    const view = m.view({ transcript: t, compactions: [older, { ...c, upToTurn: cut }], budgetTokens: 100_000 });
    assert.deepEqual(orphanedToolResults(view.messages.slice(1)), [], `cut ${cut}`);
    assert.ok(textOf(view.messages[0]!).startsWith(`Summary of earlier work (turns 0..${cut})`), 'the LAST compaction is used');
  }
});

test('condense: clean boundary, every evidence/record id preserved even when the summarizer drops them', async () => {
  const m = createWorkingContextManager({ keepRecentTurns: 2 });
  const t = transcript();
  const original = jsonClone(t);
  const s = new RecordingSummarizer('The agent investigated checkout and found a defect.');
  const c = await m.condense({ transcript: t, compactions: [], level: 'soft', summarizer: s, budgetTokens: 4000, ids: ids(), now: '2026-01-02T00:00:00.000Z' });
  // max turn 7 − 2 = 5, but c9 (turn 5) settles at turn 6 ⇒ the cut moves to 4.
  assert.equal(c.upToTurn, 4);
  assert.equal(c.compactionId, 'cmp_000001');
  assert.equal(c.level, 'soft');
  assert.equal(c.createdAt, '2026-01-02T00:00:00.000Z');
  assert.deepEqual(c.evidenceRefs, ['ev_seed01', 'ev_run0001', 'ev_http0001']);
  for (const id of ['ev_seed01', 'ev_run0001', 'ev_http0001', 'rec_find01', 'wi_exec01', 'wi_rca001']) assert.ok(c.summary.includes(id), `summary keeps ${id}`);
  assert.ok(!c.summary.includes('ev_rca0001'), 'ids outside the condensed range are not claimed');
  // The summarizer saw exactly turns 0..4 and the preservation instructions.
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0]!.messages, t.filter((e) => e.turn <= 4).map((e) => e.message));
  assert.equal(s.calls[0]!.maxTokens, 800);
  assert.match(s.calls[0]!.instructions, /evidence id \(ev_…\)/);
  assert.match(s.calls[0]!.instructions, /tool call made/);
  // Reversible: the transcript (L0/SessionStore) is untouched; the view is only a projection.
  assert.deepEqual(t, original);
  const v = m.view({ transcript: t, compactions: [c], budgetTokens: 4000 });
  assert.deepEqual(v.messages.slice(1), t.filter((e) => e.turn > 4).map((e) => e.message));
  assert.deepEqual(orphanedToolResults(v.messages), []);
  assert.deepEqual(m.view({ transcript: t, compactions: [], budgetTokens: 4000 }).messages, t.map((e) => e.message));
});

test('condense again: carries the previous summary and its evidence refs forward; soft with nothing new is refused', async () => {
  const m = createWorkingContextManager({ keepRecentTurns: 1 });
  const t = transcript();
  const first: Compaction = { compactionId: 'cmp_a', level: 'soft', upToTurn: 1, summary: 'turns 0-1 done', evidenceRefs: ['ev_seed01', 'ev_run0001'], createdAt: '2026-01-01T00:00:00.000Z' };
  const s = new RecordingSummarizer('Later work summarised (no ids).');
  const c = await m.condense({ transcript: t, compactions: [first], level: 'soft', summarizer: s, budgetTokens: 4000, ids: ids(), now: '2026-01-03T00:00:00.000Z' });
  assert.equal(c.upToTurn, 6);
  assert.deepEqual(c.evidenceRefs, ['ev_seed01', 'ev_run0001', 'ev_http0001', 'ev_rca0001']);
  for (const id of c.evidenceRefs) assert.ok(c.summary.includes(id));
  const seen = s.calls[0]!.messages;
  assert.equal(textOf(seen[0]!), 'Summary of earlier work (turns 0..1): turns 0-1 done\nEvidence referenced: ev_seed01, ev_run0001');
  assert.deepEqual(seen.slice(1), t.filter((e) => e.turn > 1 && e.turn <= 6).map((e) => e.message));

  const err = await rejectsWith(m.condense({ transcript: t, compactions: [first, c], level: 'soft', summarizer: s, budgetTokens: 4000, ids: ids(), now: 'x' }), 'precondition_failed');
  assert.equal(err.details['previousUpToTurn'], 6);
  await rejectsWith(m.condense({ transcript: [], compactions: [], level: 'hard', summarizer: s, budgetTokens: 4000, ids: ids(), now: 'x' }), 'precondition_failed');
});

test('hard condensation is mandatory: it keeps fewer recent turns until the view fits under the soft ratio', async () => {
  const m = createWorkingContextManager({ keepRecentTurns: 4 });
  const big = 'x'.repeat(4000); // ≈1000 tokens each
  const t: TranscriptEntry[] = [];
  for (let turn = 0; turn < 8; turn++) {
    t.push(at(turn, say(`step ${turn} ev_s${turn}`, [{ id: `k${turn}`, name: 'fs.read' }])));
    t.push(at(turn, result(`k${turn}`, 'fs.read', big)));
  }
  const budget = 4000;
  assert.equal(m.view({ transcript: t, compactions: [], budgetTokens: budget }).pressure, 'hard');
  const soft = await m.condense({ transcript: t, compactions: [], level: 'soft', summarizer: deterministicSummarizer, budgetTokens: budget, ids: ids(), now: 'n' });
  assert.equal(soft.upToTurn, 3, 'soft keeps the default 4 recent turns');
  assert.equal(m.view({ transcript: t, compactions: [soft], budgetTokens: budget }).pressure, 'hard', 'which is not enough here');
  const hard = await m.condense({ transcript: t, compactions: [], level: 'hard', summarizer: deterministicSummarizer, budgetTokens: budget, ids: ids(), now: 'n' });
  assert.ok(hard.upToTurn > soft.upToTurn);
  const v = m.view({ transcript: t, compactions: [hard], budgetTokens: budget });
  assert.equal(v.pressure, 'none', `tokens ${v.tokens} of ${budget}`);
  assert.deepEqual(orphanedToolResults(v.messages), []);
  for (let turn = 0; turn <= hard.upToTurn; turn++) assert.ok(hard.summary.includes(`ev_s${turn}`));
});

test('deterministicSummarizer: extractive, keeps tool names/status/errors/ids, bounded by maxTokens', async () => {
  const msgs = transcript().map((e) => e.message);
  const s = await deterministicSummarizer.summarize({ messages: msgs, instructions: '', maxTokens: 400 });
  assert.match(s, /Step 1: I will read the diff and the handler in parallel\./);
  assert.match(s, /call fs\.read \{"path":"src\/checkout\.ts"\}/);
  assert.match(s, /result test\.run \[error\]: FAIL checkout rejects empty cart/);
  assert.match(s, /Errors: test\.run: FAIL/);
  assert.match(s, /Evidence: ev_seed01, ev_run0001, ev_http0001, ev_rca0001/);
  assert.match(s, /Records: rec_find01, wi_exec01, wi_rca001/);
  assert.ok(Math.ceil(s.length / 4) <= 400);
  const tiny = await deterministicSummarizer.summarize({ messages: msgs, instructions: '', maxTokens: 40 });
  assert.ok(Math.ceil(tiny.length / 4) <= 40, `bounded: ${tiny.length} chars`);
  assert.match(tiny, /Evidence: ev_seed01/);
  const ctrl = new AbortController();
  ctrl.abort();
  await rejectsWith(deterministicSummarizer.summarize({ messages: msgs, instructions: '', maxTokens: 40, signal: ctrl.signal }), 'cancelled');
});

test('I9: large tool outputs are offloaded to the artifact store; the view bounds any oversized result', async () => {
  const artifacts = new MemoryArtifactStore();
  const huge = 'line of pytest output\n'.repeat(5000);
  const msg: ToolResultMessage = { role: 'tool', toolCallId: 'c1', toolName: 'test.run', content: huge };
  const r = await offloadToolResult(artifacts, msg, { thresholdBytes: 16 * 1024, previewBytes: 1024 });
  assert.ok(r.artifact);
  assert.equal(new TextDecoder().decode(await artifacts.get(r.artifact.sha256)), huge);
  assert.ok(Buffer.byteLength(r.message.content) < 1300);
  assert.ok(r.message.content.includes(r.artifact.uri) && r.message.content.includes(`sha256:${r.artifact.sha256}`));
  assert.equal(r.message.toolCallId, 'c1');
  const small = await offloadToolResult(artifacts, { ...msg, content: 'ok' });
  assert.equal(small.artifact, undefined);
  assert.equal(small.message.content, 'ok');

  const m = createWorkingContextManager({ maxToolResultTokens: 100 });
  const v = m.view({ transcript: [at(0, say('run', [{ id: 'c1', name: 'test.run' }])), at(0, msg)], compactions: [], budgetTokens: 10_000 });
  const shown = v.messages[1] as ToolResultMessage;
  assert.ok(Math.ceil(shown.content.length / 4) <= 100);
  assert.match(shown.content, /truncated in the working view: 110000 chars total/);
});

test('condense bounds oversized tool results handed to the summarizer but still collects their ids', async () => {
  const m = createWorkingContextManager({ keepRecentTurns: 0, maxToolResultTokens: 50 });
  const huge = 'x'.repeat(10_000) + ' trailing evidence ev_tail0001';
  const t = [at(0, say('run', [{ id: 'c1', name: 'test.run' }])), at(0, result('c1', 'test.run', huge)), at(1, say('done'))];
  const s = new RecordingSummarizer('ran the tests');
  const c = await m.condense({ transcript: t, compactions: [], level: 'hard', summarizer: s, budgetTokens: 10_000, ids: ids(), now: 'n' });
  const seen = s.calls[0]!.messages.find((x) => x.role === 'tool') as ToolResultMessage;
  assert.ok(Math.ceil(seen.content.length / 4) <= 50);
  assert.deepEqual(c.evidenceRefs, ['ev_tail0001']);
  assert.ok(c.summary.includes('ev_tail0001'));
});

test('options and inputs are validated', async () => {
  assert.throws(() => createWorkingContextManager({ softRatio: 0.99, hardRatio: 0.9 }), /ratios/);
  assert.throws(() => createWorkingContextManager({ keepRecentTurns: -1 }), /keepRecentTurns/);
  const m = createWorkingContextManager();
  assert.throws(() => m.view({ transcript: [], compactions: [], budgetTokens: 0 }), /budgetTokens/);
  const ctrl = new AbortController();
  ctrl.abort();
  await rejectsWith(m.condense({ transcript: transcript(), compactions: [], level: 'hard', summarizer: deterministicSummarizer, budgetTokens: 100, ids: ids(), now: 'n', signal: ctrl.signal }), 'cancelled');
});
