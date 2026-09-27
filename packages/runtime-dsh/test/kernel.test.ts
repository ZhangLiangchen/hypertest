import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MemoryLogger, isHypertestError } from '@hypertest/core';
import { PARALLEL_TOOL_CONCURRENCY } from '@hypertest/runtime';
import { turnMarker } from '../src/convert.ts';
import { DshKernel } from '../src/kernel.ts';

describe('DSH kernel', () => {
  test('a kernel that cannot boot fails closed: boot rejects and DSH’s own error log reaches the Hypertest logger', async () => {
    const logger = new MemoryLogger();
    // dsh-agent-loop refuses a non-positive tool-call pool while its service starts
    await assert.rejects(DshKernel.boot({ maxParallelToolCalls: 0, logger }));
    assert.ok(logger.entries.some((e) => e.level === 'warn' && e.msg.startsWith('dsh: ') && e.fields['level'] === 'error'), JSON.stringify(logger.entries));
  });

  test('a model request of a DSH session no Hypertest turn serves fails that step (nothing reaches a provider)', async () => {
    const kernel = await DshKernel.boot({ maxParallelToolCalls: PARALLEL_TOOL_CONCURRENCY, logger: new MemoryLogger() });
    try {
      let requests = 0;
      const handle = await kernel.createAgent({
        sessionId: 'dsh_orphan',
        seed: [],
        setup: () => undefined,
        step: async function* () {
          requests += 1;
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      });
      kernel.release('dsh_orphan');
      handle.agent.followup(turnMarker(1));
      await handle.agent.whenIdle();
      const end = handle.agent.session.events.find((e) => e.type === 'turn/end');
      assert.equal(requests, 0);
      assert.equal(end?.type === 'turn/end' && end.data.reason.kind, 'error');
      assert.match(JSON.stringify(end?.data), /no Hypertest turn serves DSH session dsh_orphan/);
      await handle.dispose();
      assert.equal(kernel.liveSessions(), 0);
    } finally {
      await kernel.close();
    }
  });

  test('a DSH session id is live once: a second agent on the same id is a conflict and leaves the first serving', async () => {
    const kernel = await DshKernel.boot({ maxParallelToolCalls: PARALLEL_TOOL_CONCURRENCY, logger: new MemoryLogger() });
    try {
      const served: string[] = [];
      const step = (label: string) =>
        async function* () {
          served.push(label);
          yield { type: 'block-start' as const, index: 0, blockType: 'text' as const };
          yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: label } };
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } };
        };
      const first = await kernel.createAgent({ sessionId: 'dsh_dup', seed: [], setup: () => undefined, step: step('first') });
      await assert.rejects(kernel.createAgent({ sessionId: 'dsh_dup', seed: [], setup: () => undefined, step: step('second') }), (e: unknown) => isHypertestError(e, 'conflict'));
      first.agent.followup(turnMarker(1));
      await first.agent.whenIdle();
      assert.deepEqual(served, ['first']);
      await first.dispose();
      kernel.release('dsh_dup');
    } finally {
      await kernel.close();
    }
  });

  test('an invalid seed is refused by DSH’s session boundary (the adapter reports it as a fault, never a partial agent)', async () => {
    const kernel = await DshKernel.boot({ maxParallelToolCalls: PARALLEL_TOOL_CONCURRENCY, logger: new MemoryLogger() });
    try {
      // not contiguous from seq 0; a message without identity (never produced by projectTranscript)
      const gap = [{ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }] as never;
      const unidentified = [{ type: 'user/message', seq: 0, time: 1, data: { role: 'user', content: 'x' }, surfaceOp: 'append' }] as never;
      for (const seed of [gap, unidentified]) {
        await assert.rejects(kernel.createAgent({ sessionId: 'dsh_bad_seed', seed, setup: () => undefined, step: async function* () {} }), /seed/);
      }
      assert.equal(kernel.liveSessions(), 0);
      // the id is free again
      const ok = await kernel.createAgent({ sessionId: 'dsh_bad_seed', seed: [], setup: () => undefined, step: async function* () {} });
      await ok.dispose();
      kernel.release('dsh_bad_seed');
    } finally {
      await kernel.close();
    }
  });
});
