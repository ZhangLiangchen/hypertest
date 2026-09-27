import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { AssistantMessage, ChatMessage } from '@hypertest/domain';
import { TEXT_ONLY_NUDGE } from '@hypertest/runtime';
import {
  HOST_MODEL, HOST_PROVIDER, NO_RECORDED_RESULT, fromDshToolName, projectTranscript, responseChunks, toDshArguments, toDshAssistant, toDshToolName, turnMarker, viewOfTurn,
} from '../src/convert.ts';

/** DSH's own derived message view of a seed, reduced to comparable facts. */
function derived(events: ReturnType<typeof projectTranscript>['seed']): unknown[] {
  const session = Session.create(SessionId('sess_convert'), events);
  return session.deriveMessages().map((m) => ({
    role: m.role,
    source: m.source.kind === 'plugin' ? `plugin:${m.source.plugin}:${'form' in m.source ? m.source.form : ''}` : m.source.kind,
    content: m.content.map((b) => {
      switch (b.type) {
        case 'text':
          return b.text;
        case 'reasoning':
          return `reasoning:${b.text}`;
        case 'tool-call':
          return `call:${b.id}:${b.name}:${b.arguments}`;
        case 'tool-result':
          return `result:${b.toolCallId}:${b.isError === true}:${b.content.map((c) => (c.type === 'text' ? c.text : '?')).join('')}`;
        default:
          return `?${b.type}`;
      }
    }),
  }));
}

describe('IR → DSH projection', () => {
  test('tool names are escaped bijectively (DSH reserves run_code; empty and prefixed names are escaped too)', () => {
    for (const name of ['probe', 'fs.read', 'blackboard.post_record', 'run_code', '', 'hypertest:', 'hypertest:x', 'hypertest:run_code', 'x:hypertest:', 'run_code_2']) {
      assert.equal(fromDshToolName(toDshToolName(name)), name, JSON.stringify(name));
    }
    assert.equal(toDshToolName('fs.read'), 'fs.read', 'ordinary names are unchanged');
    assert.equal(toDshToolName('run_code'), 'hypertest:run_code');
    assert.equal(toDshToolName(''), 'hypertest:');
    assert.equal(toDshToolName('hypertest:x'), 'hypertest:hypertest:x');
    const escaped = ['run_code', '', 'hypertest:x'].map(toDshToolName);
    assert.equal(new Set(escaped).size, 3);
    assert.ok(!escaped.includes('run_code'));
  });

  test('argument text: the provider’s unparsable text verbatim, else the JSON of the IR arguments (lossless for DSH: no -0)', () => {
    assert.equal(toDshArguments({ arguments: { a: 1, b: [true, null] } }), '{"a":1,"b":[true,null]}');
    assert.equal(toDshArguments({ arguments: null, rawArguments: '{"a":' }), '{"a":');
    assert.equal(toDshArguments({ arguments: { a: 1 }, rawArguments: '' }), '', 'raw text wins even when empty');
    assert.equal(toDshArguments({ arguments: [1, 2] }), '[1,2]');
    assert.equal(toDshArguments({ arguments: 'text' }), '"text"');
    assert.equal(toDshArguments({ arguments: { n: -0 } }), '{"n":0}');
    assert.equal(toDshArguments({ arguments: undefined as never }), 'null');
  });

  test('a rich transcript projects into a valid DSH seed: one DSH turn per model response, inputs cut at responses', () => {
    const opaque = { compatibilityClass: 'anthropic:x', data: { blocks: [{ thinking: 'hmm', signature: 's1' }], n: -0 } };
    const first: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'considering' }, { type: 'image', mimeType: 'image/png', dataBase64: 'AAAA' }],
      reasoning: { text: 'hmm', opaque },
      toolCalls: [{ id: 'c1', name: 'probe', arguments: { a: 1 } }, { id: 'c2', name: 'run_code', arguments: null, rawArguments: '{"a":' }, { id: 'c3', name: 'probe', arguments: [1, 2] }],
    };
    const entries: Array<{ turn: number; message: ChatMessage }> = [
      { turn: 0, message: { role: 'system', content: 'be careful' } },
      { turn: 0, message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/jpeg', artifactUri: 'artifact://sha256/abc' }] } },
      { turn: 1, message: first },
      { turn: 1, message: { role: 'tool', toolCallId: 'c1', toolName: 'probe', content: 'ok' } },
      { turn: 1, message: { role: 'tool', toolCallId: 'c2', toolName: 'run_code', content: 'malformed', isError: true } },
      // c3 has no recorded result (an incomplete foreign transcript): DSH gets a synthetic error result, never a dangling call
      { turn: 2, message: { role: 'user', content: 'operation op_1 verified' } }, // a boundary turn: input, no response
      { turn: 3, message: { role: 'user', content: TEXT_ONLY_NUDGE } },
      { turn: 3, message: { role: 'assistant', content: [] } }, // an empty text-only response
      { turn: 4, message: { role: 'assistant', content: [], toolCalls: [{ id: 'c1', name: 'probe', arguments: { again: true } }] } }, // an id reused across turns
      { turn: 4, message: { role: 'tool', toolCallId: 'c1', toolName: 'probe', content: '' } },
      { turn: 4, message: { role: 'tool', toolCallId: 'zz', toolName: 'probe', content: 'orphan' } }, // no matching call
      { turn: 5, message: { role: 'user', content: '' } },
    ];
    const { seed, inputs, turns } = projectTranscript(entries, 1_700_000_000_000);
    assert.equal(turns, 3);
    assert.deepEqual(seed.map((e) => e.seq), seed.map((_, i) => i), 'contiguous from seq 0');
    assert.ok(seed.every((e) => e.time === 1_700_000_000_000));
    assert.deepEqual(seed.filter((e) => e.type === 'turn/start' || e.type === 'turn/end').map((e) => `${e.type}:${(e.data as { turn: number }).turn}`), [
      'turn/start:1', 'turn/end:1', 'turn/start:2', 'turn/end:2', 'turn/start:3', 'turn/end:3',
    ]);
    // DSH accepts the seed and derives this history from it
    assert.deepEqual(derived(seed), [
      { role: 'user', source: 'plugin:hypertest:instructions', content: ['be careful'] },
      { role: 'user', source: 'user', content: ['look', '[image image/jpeg artifact://sha256/abc]'] },
      { role: 'assistant', source: 'model', content: ['reasoning:hmm', 'considering', '[image image/png]', 'call:c1:probe:{"a":1}', 'call:c2:hypertest:run_code:{"a":', 'call:c3:probe:[1,2]'] },
      { role: 'user', source: 'tool', content: ['result:c1:false:ok'] },
      { role: 'user', source: 'tool', content: ['result:c2:true:malformed'] },
      { role: 'user', source: 'tool', content: [`result:c3:true:${NO_RECORDED_RESULT}`] },
      { role: 'user', source: 'user', content: ['operation op_1 verified'] },
      { role: 'user', source: 'user', content: [TEXT_ONLY_NUDGE] },
      // (the empty text-only response is logged but, having no content, stays out of DSH's derived history)
      { role: 'assistant', source: 'model', content: ['call:c1:probe:{"again":true}'] },
      { role: 'user', source: 'tool', content: ['result:c1:false:'] },
    ]);
    const assistants = seed.filter((e) => e.type === 'assistant/message');
    assert.equal(assistants.length, 3);
    assert.ok(assistants.every((e) => e.type === 'assistant/message' && e.data.message.source.kind === 'model' && e.data.message.source.provider === HOST_PROVIDER && e.data.message.source.model === HOST_MODEL));
    assert.ok(!JSON.stringify(seed).includes('signature'), 'opaque continuation state is never projected into DSH');
    // the inputs after the last response enter the live DSH turn
    assert.deepEqual(inputs.map((m) => [m.source.kind, m.content.map((b) => (b.type === 'text' ? b.text : '?')).join('')]), [
      ['plugin', '[tool result probe zz] orphan'],
      ['user', ''],
    ]);
  });

  test('any Clock reading stamps a seed DSH accepts (fractional, non-finite and out-of-range ms are normalized)', () => {
    const entries: Array<{ turn: number; message: ChatMessage }> = [
      { turn: 0, message: { role: 'user', content: 'task' } },
      { turn: 1, message: { role: 'assistant', content: [], toolCalls: [{ id: 'c1', name: 'probe', arguments: {} }] } },
      { turn: 1, message: { role: 'tool', toolCallId: 'c1', toolName: 'probe', content: 'ok' } },
    ];
    for (const [ms, expected] of [
      [1_700_000_000_000.75, 1_700_000_000_000], // a performance-based clock
      [0.5, 0],
      [-1.5, -1],
      [Number.NaN, 0], // e.g. a FixedClock over an unparsable date
      [Number.POSITIVE_INFINITY, 0],
      [2 ** 60, Number.MAX_SAFE_INTEGER],
    ] as const) {
      const { seed } = projectTranscript(entries, ms);
      assert.ok(seed.length > 0);
      assert.ok(seed.every((e) => e.time === expected), `${ms} → ${expected}`);
      assert.doesNotThrow(() => Session.create(SessionId('sess_time'), seed), `DSH accepts the seed stamped from ${ms}`);
    }
  });

  test('an empty transcript projects to no seed; turn-0 input alone is the live input', () => {
    assert.deepEqual(projectTranscript([], 1), { seed: [], inputs: [], turns: 0 });
    const { seed, inputs, turns } = projectTranscript([{ turn: 0, message: { role: 'user', content: 'task' } }], 1);
    assert.deepEqual([seed, turns], [[], 0]);
    assert.deepEqual(inputs.map((m) => m.content), [[{ type: 'text', text: 'task' }]]);
    assert.doesNotThrow(() => Session.create(SessionId('sess_empty'), seed));
  });

  test('the turn marker is a plugin notice (never a user prompt)', () => {
    const m = turnMarker(7);
    assert.equal(m.role, 'user');
    assert.deepEqual(m.source, { kind: 'plugin', plugin: 'hypertest', form: 'notice', summary: 'Hypertest turn 7' });
    assert.deepEqual(m.content, [{ type: 'text', text: '[Hypertest turn 7]' }]);
  });

  test('response chunks assemble (DSH BlockAssembler) into exactly the projected message; finish is tool-calls or stop, never max-tokens', () => {
    const responses: AssistantMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: '' }], reasoning: { text: 'r' }, toolCalls: [{ id: 'x', name: 'run_code', arguments: { n: -0 } }, { id: 'y', name: 'p', arguments: null, rawArguments: '[' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'only text' }] },
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [], reasoning: { text: '' }, toolCalls: [] },
    ];
    for (const response of responses) {
      const chunks = responseChunks(response);
      const assembler = new BlockAssembler();
      for (const c of chunks) assembler.push(c);
      assert.deepEqual(assembler.blocks(), toDshAssistant(response).content);
      assert.deepEqual(assembler.finish, { kind: (response.toolCalls ?? []).length > 0 ? 'tool-calls' : 'stop' });
      assert.equal(chunks.at(-1)!.type, 'finish');
      assert.ok(!chunks.some((c) => c.type === 'finish' && c.reason.kind === 'max-tokens'));
    }
    assert.deepEqual(toDshAssistant(responses[0]!).content.map((b) => b.type), ['reasoning', 'text', 'text', 'tool-call', 'tool-call']);
  });

  test('the DSH view of a turn: calls with unescaped names, results with error flags, steps and a compact trace', () => {
    const { seed } = projectTranscript(
      [
        { turn: 0, message: { role: 'user', content: 'task' } },
        { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 't' }], toolCalls: [{ id: 'k', name: 'run_code', arguments: { a: 1 } }, { id: 'm', name: 'probe', arguments: null, rawArguments: '{' }] } },
        { turn: 1, message: { role: 'tool', toolCallId: 'k', toolName: 'run_code', content: 'done' } },
        { turn: 1, message: { role: 'tool', toolCallId: 'm', toolName: 'probe', content: 'bad', isError: true } },
      ],
      5,
    );
    const view = viewOfTurn(seed, 0);
    assert.equal(view.steps, 1);
    assert.deepEqual(view.calls, [{ id: 'k', name: 'run_code', arguments: '{"a":1}' }, { id: 'm', name: 'probe', arguments: '{' }]);
    assert.deepEqual(view.results, [{ toolCallId: 'k', content: 'done', isError: false }, { toolCallId: 'm', content: 'bad', isError: true }]);
    assert.equal(view.end, 'completed');
    assert.deepEqual(view.trace, ['turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call:k', 'tool/result:k', 'tool/call:m', 'tool/result:m:error', 'step/end', 'turn/end:completed']);
    assert.deepEqual(viewOfTurn(seed, seed.length), { steps: 0, calls: [], results: [], trace: [] }, 'events before fromSeq are ignored');
  });
});
