/**
 * The foreground wait of `run`/`resume` (waitForRun) against a fake instance: --follow prints each event once in seq
 * order including the ones committed with the terminal transition, a run paused for a human decision gets one notice
 * naming the pending approvals, interruption returns without waiting (and without an unhandled rejection), and a
 * timeout says the run is resumable.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HypertestError } from '@hypertest/core';
import type { HypertestInstance } from '@hypertest/app';
import type { DomainEvent, QualityDecision, TestRun } from '@hypertest/domain';
import { waitForRun, WAIT_POLL_MS } from '../src/commands/run.ts';
import { resolveIo, writer, type CommandContext } from '../src/context.ts';
import { collector } from './helpers.ts';

function ctxWith(signal: AbortSignal = new AbortController().signal) {
  const stdout = collector();
  const stderr = collector();
  const io = resolveIo({ stdout, stderr, env: {}, cwd: '/' });
  const ctx: CommandContext = { command: 'run', io, global: { json: false, help: false }, signal, out: writer(stdout), err: writer(stderr), json: () => undefined };
  return { ctx, stdout, stderr };
}

function event(seq: number, eventType: string): DomainEvent<unknown> {
  return { eventId: `ev${seq}`, eventType, aggregateType: 'run', aggregateId: 'r1', runId: 'r1', seq, correlationId: 'r1', actorId: 'system:test', schemaVersion: '1', payload: {}, occurredAt: `2026-01-01T00:00:0${seq}.000Z` };
}

interface Fake {
  ht: HypertestInstance;
  log: DomainEvent<unknown>[];
  finish(outcome: { status: TestRun['status']; decision?: QualityDecision }): void;
  fail(e: Error): void;
  status: { value: Partial<TestRun> };
}

function fakeInstance(options: { approvals?: Array<{ approvalId: string; kind: string; requestedBy: { kind: string; id: string } }> } = {}): Fake {
  const log: DomainEvent<unknown>[] = [];
  let settle!: (o: { runId: string; status: TestRun['status']; decision?: QualityDecision }) => void;
  let reject!: (e: Error) => void;
  const completion = new Promise<{ runId: string; status: TestRun['status']; decision?: QualityDecision }>((resolve, rej) => {
    settle = resolve;
    reject = rej;
  });
  const status = { value: { runId: 'r1', status: 'running' } as Partial<TestRun> };
  const ht = {
    config: { store: { kind: 'pglite' } },
    durable: { awaitCompletion: async (_runId: string, o: { timeoutMs?: number }) => (o.timeoutMs === 1 ? Promise.reject(new HypertestError('timeout', 'x')) : completion) },
    events: async (_runId: string, o: { afterSeq?: number; limit?: number }) => log.filter((e) => e.seq! > (o.afterSeq ?? 0)).slice(0, o.limit ?? 1000),
    status: async () => status.value,
    listApprovals: async () => options.approvals ?? [],
  } as unknown as HypertestInstance;
  return { ht, log, status, finish: (o) => settle({ runId: 'r1', ...o }), fail: (e) => reject(e) };
}

describe('waitForRun', () => {
  test('--follow prints every event once, in order, including those committed with the terminal transition', async () => {
    const fake = fakeInstance();
    const { ctx, stderr } = ctxWith();
    fake.log.push(event(1, 'run.created'), event(2, 'work.created'));
    const waiting = waitForRun(ctx, fake.ht, 'r1', { follow: true });
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS + 100));
    fake.log.push(event(3, 'gate.evaluated'), event(4, 'run.completed'));
    fake.finish({ status: 'completed' });
    const r = await waiting;
    assert.deepEqual(r, { interrupted: false, outcome: { runId: 'r1', status: 'completed' } });
    const types = stderr.text().trimEnd().split('\n').map((l) => l.trim().split(/\s+/)[2]);
    assert.deepEqual(types, ['run.created', 'work.created', 'gate.evaluated', 'run.completed']);
  });

  test('a run paused for a human decision gets exactly one notice naming the pending approvals', async () => {
    const fake = fakeInstance({ approvals: [{ approvalId: 'appr_1', kind: 'action', requestedBy: { kind: 'agent', id: 'ag_1' } }] });
    fake.status.value = { runId: 'r1', status: 'paused', pauseReason: 'approval' };
    const { ctx, stderr } = ctxWith();
    const waiting = waitForRun(ctx, fake.ht, 'r1', { follow: false });
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS * 2 + 200));
    fake.finish({ status: 'cancelled' });
    await waiting;
    assert.equal(
      stderr.text(),
      [
        'run r1 is waiting for a human decision:',
        '  approval appr_1 (action) requested by agent:ag_1',
        '  decide with `hypertest approve <approvalId> [--deny] --by <name> --reason "<text>"`',
        '  (the embedded store admits one process: stop this command first — the run stays resumable — then approve and `hypertest resume`)',
        '',
      ].join('\n'),
    );
  });

  test('interruption returns at once; the pending completion never becomes an unhandled rejection', async () => {
    const fake = fakeInstance();
    const stop = new AbortController();
    const { ctx } = ctxWith(stop.signal);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const waiting = waitForRun(ctx, fake.ht, 'r1', { follow: true });
      stop.abort();
      assert.deepEqual(await waiting, { interrupted: true });
      fake.fail(new HypertestError('cancelled', 'the durable runtime shut down'));
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a timeout names the run as resumable', async () => {
    const fake = fakeInstance();
    const { ctx } = ctxWith();
    await assert.rejects(waitForRun(ctx, fake.ht, 'r1', { follow: false, timeoutMs: 1 }), (e: unknown) => e instanceof HypertestError && e.code === 'timeout' && e.message === 'run r1 did not complete within 1 ms; it is resumable with `hypertest resume`');
  });
});
