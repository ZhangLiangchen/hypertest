import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTokens, type ChatMessage } from '@hypertest/domain';
import { PromptAssembler, type AssemblyInput, type PromptSection } from '../src/index.ts';
import { rejectsWith, result, say, user } from './helpers.ts';

const assembler = new PromptAssembler();
const text = (n: number, ch = 'x') => ch.repeat(n);
const section = (id: string, priority: number, chars: number, extra: Partial<PromptSection> = {}): PromptSection => ({ id, title: id.toUpperCase(), content: text(chars, id[0]), priority, ...extra });

function input(overrides: Partial<AssemblyInput> = {}): AssemblyInput {
  return { rolePrompt: 'You are the executor.', sections: [], transcript: [], budgetTokens: 10_000, snapshotId: 'cs_abc', ...overrides };
}

function contextOf(messages: ChatMessage[]): string {
  const m = messages.find((x) => x.role === 'user' && typeof x.content === 'string' && x.content.startsWith('# Context'));
  return m ? (m.content as string) : '';
}

test('layout: system (role + BUGate + policy + snapshot), one Context message by priority, transcript verbatim', () => {
  const transcript = [user('run the suite'), say('Running.', [{ id: 'c1', name: 'test.run' }]), result('c1', 'test.run', 'ok')];
  const r = assembler.assemble(input({
    protocolContext: 'Layer 2 gate: oracle mapping required.',
    policyNotes: ['no destructive tools', 'staging only'],
    sections: [
      { id: 'wi', title: 'Work item', content: 'Verify checkout.', priority: 1 },
      { id: 'goal', title: 'Objective', content: 'Assess releasability.', priority: 0 },
    ],
    transcript,
  }));
  assert.equal(r.messages.length, 5);
  assert.deepEqual(r.messages[0], {
    role: 'system',
    content: 'You are the executor.\n\n## Testing methodology protocol (BUGate)\nLayer 2 gate: oracle mapping required.\n\n## Policy\n- no destructive tools\n- staging only\n\nContext snapshot: cs_abc',
  });
  assert.deepEqual(r.messages[1], { role: 'user', content: '# Context\n\n## Objective\nAssess releasability.\n\n## Work item\nVerify checkout.' });
  assert.equal(r.messages[2], transcript[0]);
  assert.equal(r.messages[3], transcript[1]);
  assert.equal(r.messages[4], transcript[2]);
  assert.equal(r.tokens, estimateTokens(r.messages));
  assert.deepEqual(r.droppedSections, []);
  assert.deepEqual(r.truncatedSections, []);

  const bare = assembler.assemble(input({ sections: [] }));
  assert.deepEqual(bare.messages, [{ role: 'system', content: 'You are the executor.\n\nContext snapshot: cs_abc' }]);
});

test('over budget: non-required sections are dropped from the least important upward', () => {
  const sections = [section('req', 0, 400, { required: true }), section('s1', 1, 400), section('s2', 2, 400), section('s3', 3, 400)];
  const full = assembler.assemble(input({ sections }));
  const oneSection = Math.ceil((400 + '## REQ\n\n\n'.length) / 4);
  // Room for two sections (+ a little slack: per-part estimates round up, so the assembler is conservative).
  const budget = full.tokens - 2 * oneSection + 10;
  const r = assembler.assemble(input({ sections, budgetTokens: budget }));
  assert.deepEqual(r.droppedSections, ['s3', 's2']);
  assert.deepEqual(r.truncatedSections, []);
  const ctx = contextOf(r.messages);
  assert.ok(ctx.includes('## REQ') && ctx.includes('## S1') && !ctx.includes('## S2') && !ctx.includes('## S3'));
  assert.ok(r.tokens <= budget, `${r.tokens} ≤ ${budget}`);
  // Priority ties: the later section is the less important one.
  const tie = assembler.assemble(input({ sections: [section('a', 1, 400), section('b', 1, 400)], budgetTokens: assembler.assemble(input({ sections: [section('a', 1, 400)] })).tokens + 5 }));
  assert.deepEqual(tie.droppedSections, ['b']);
});

test('required sections are never dropped: they are truncated (least important first) with a [truncated] marker', () => {
  const sections = [section('r0', 0, 800, { required: true }), section('opt', 1, 800), section('r5', 5, 800, { required: true })];
  const withoutOpt = assembler.assemble(input({ sections: [sections[0]!, sections[2]!] }));
  // 100 tokens short once `opt` is gone ⇒ only r5 (less important) is truncated.
  const budget = withoutOpt.tokens - 100;
  const r = assembler.assemble(input({ sections, budgetTokens: budget }));
  assert.deepEqual(r.droppedSections, ['opt']);
  assert.deepEqual(r.truncatedSections, ['r5']);
  const ctx = contextOf(r.messages);
  assert.ok(ctx.includes(`## R0\n${text(800, 'r')}\n\n## R5\n`), 'r0 is intact and first');
  assert.ok(ctx.endsWith('\n…[truncated]'));
  assert.ok(r.tokens <= budget, `${r.tokens} ≤ ${budget}`);

  // A tiny budget: both required sections survive as header + marker, everything optional is dropped.
  const tiny = assembler.assemble(input({ sections, budgetTokens: 30 }));
  assert.deepEqual(tiny.droppedSections, ['opt']);
  assert.deepEqual(tiny.truncatedSections, ['r0', 'r5']);
  assert.equal(contextOf(tiny.messages), '# Context\n\n## R0\n…[truncated]\n\n## R5\n…[truncated]');
});

test('per-section maxTokens truncates content even when the total budget is ample', () => {
  const r = assembler.assemble(input({ sections: [section('big', 0, 1000, { maxTokens: 25 }), section('small', 1, 10)] }));
  assert.deepEqual(r.truncatedSections, ['big']);
  assert.deepEqual(r.droppedSections, []);
  const ctx = contextOf(r.messages);
  const big = ctx.slice(ctx.indexOf('## BIG\n') + '## BIG\n'.length, ctx.indexOf('\n\n## SMALL'));
  assert.ok(big.endsWith('…[truncated]'));
  assert.ok(Math.ceil(big.length / 4) <= 25, `content ${big.length} chars ≤ 25 tokens`);
  assert.equal(big, text(100 - '\n…[truncated]'.length, 'b') + '\n…[truncated]');
});

test('a transcript larger than the budget is still returned whole (the caller must condense)', () => {
  const transcript = Array.from({ length: 10 }, (_, i) => user(`message ${i} ${text(400)}`));
  const r = assembler.assemble(input({ sections: [section('req', 0, 100, { required: true }), section('opt', 1, 100)], transcript, budgetTokens: 200 }));
  assert.deepEqual(r.messages.slice(-10), transcript);
  assert.deepEqual(r.droppedSections, ['opt']);
  assert.deepEqual(r.truncatedSections, ['req']);
  assert.ok(r.tokens > 200);
  assert.equal(r.tokens, estimateTokens(r.messages));
});

test('invalid input is rejected', async () => {
  await rejectsWith(() => assembler.assemble(input({ budgetTokens: 0 })), 'invalid_argument');
  await rejectsWith(() => assembler.assemble(input({ snapshotId: '' })), 'invalid_argument');
  await rejectsWith(() => assembler.assemble(input({ sections: [section('a', 0, 1), section('a', 1, 1)] })), 'invalid_argument');
  await rejectsWith(() => assembler.assemble(input({ sections: [section('a', Number.NaN, 1)] })), 'invalid_argument');
});
