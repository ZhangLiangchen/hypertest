import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isHypertestError } from '@hypertest/core';
import { DispatchGate } from '../src/gate.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('DispatchGate (host parallel-safety order over pi’s concurrent execution)', () => {
  test('consecutive parallel-safe calls share a segment; an exclusive call waits for them and blocks later calls', async () => {
    // 0,1 parallel | 2 exclusive | 3 parallel
    const gate = new DispatchGate([{ index: 0, parallelSafe: true }, { index: 1, parallelSafe: true }, { index: 2, parallelSafe: false }, { index: 3, parallelSafe: true }], 4, new AbortController().signal);
    for (const i of [0, 1, 2, 3]) gate.admit(i);
    const order: string[] = [];
    const acquire = (i: number) => gate.acquire(i).then((a) => order.push(`${a}:${i}`));
    const pending = [acquire(3), acquire(2), acquire(1), acquire(0)];
    await tick();
    assert.deepEqual(order, ['go:0', 'go:1'], 'only the first segment started, in call order (1 waited for 0 to start)');
    gate.release(0);
    await tick();
    assert.equal(order.length, 2, 'the exclusive call waits for every call of the earlier segment');
    gate.release(1);
    await tick();
    assert.deepEqual(order.slice(2), ['go:2']);
    gate.release(2);
    await tick();
    assert.deepEqual(order.slice(3), ['go:3']);
    gate.release(3);
    await Promise.all(pending);
  });

  test('a segment runs at most `limit` calls, started in call order', async () => {
    const calls = Array.from({ length: 5 }, (_, index) => ({ index, parallelSafe: true }));
    const gate = new DispatchGate(calls, 2, new AbortController().signal);
    for (const c of calls) gate.admit(c.index);
    const started: number[] = [];
    const all = [4, 3, 2, 1, 0].map((i) => gate.acquire(i).then(() => started.push(i)));
    await tick();
    assert.deepEqual([...started].sort(), [0, 1]);
    gate.release(1);
    await tick();
    assert.deepEqual(started.slice(2), [2], 'the next call in order, not any waiter');
    gate.release(0);
    gate.release(2);
    await tick();
    assert.deepEqual([...started.slice(3)].sort(), [3, 4]);
    await Promise.all(all);
  });

  test('an abort wakes every waiter, which must not dispatch', async () => {
    const ctrl = new AbortController();
    const gate = new DispatchGate([{ index: 0, parallelSafe: false }, { index: 1, parallelSafe: false }], 4, ctrl.signal);
    gate.admit(0);
    gate.admit(1);
    assert.equal(await gate.acquire(0), 'go');
    const waiting = gate.acquire(1);
    await tick();
    ctrl.abort();
    assert.equal(await waiting, 'aborted');
    assert.equal(await gate.acquire(0), 'aborted');
  });

  test('a dispatch fault refuses every later start', async () => {
    const gate = new DispatchGate([{ index: 0, parallelSafe: false }, { index: 1, parallelSafe: false }], 4, new AbortController().signal);
    gate.admit(0);
    gate.admit(1);
    assert.equal(await gate.acquire(0), 'go');
    const waiting = gate.acquire(1);
    gate.refuse();
    gate.release(0);
    assert.equal(await waiting, 'refused');
  });

  test('a call pi never prepared cannot block later calls', async () => {
    const gate = new DispatchGate([{ index: 0, parallelSafe: false }, { index: 1, parallelSafe: false }], 4, new AbortController().signal);
    gate.admit(1);
    assert.equal(await gate.acquire(1), 'go');
  });

  test('unscheduled calls and bad limits are faults', () => {
    const gate = new DispatchGate([{ index: 0, parallelSafe: true }], 1, new AbortController().signal);
    assert.equal(gate.has(0), true);
    assert.equal(gate.has(7), false);
    assert.throws(() => gate.admit(7), (e: unknown) => isHypertestError(e, 'internal'));
    assert.throws(() => new DispatchGate([], 0, new AbortController().signal), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  });
});
