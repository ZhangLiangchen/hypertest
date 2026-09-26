/**
 * Admission of pi's concurrent tool executions under the host's parallel-safety policy (package-private).
 *
 * pi-agent-core's `executionMode` is decided per BATCH (one sequential tool serializes the whole batch), while the
 * AgentEngine contract orders dispatches per CALL: consecutive `isParallelSafe` calls run concurrently (at most
 * `limit` in flight), every other call runs alone, in call order. PiEngine therefore runs pi's loop in `parallel` mode
 * (pi prepares every call, then starts every execution) and each AgentTool execution first acquires this gate:
 *   - calls are grouped into segments (a run of consecutive parallel-safe calls, or one exclusive call);
 *   - a call starts only when every admitted call of an earlier segment has finished, fewer than `limit` calls of its
 *     segment are running and every admitted call before it in its segment has started (NativeEngine's in-order pull);
 *   - an abort or a dispatch fault wakes every waiter, which then does not dispatch.
 * Only calls pi actually prepared (`admit`) are waited for, so a call pi never executes cannot block later ones.
 */
import { HypertestError } from '@hypertest/core';

export type GateAdmission = 'go' | 'aborted' | 'refused';

export class DispatchGate {
  readonly #segment = new Map<number, number>();
  readonly #limit: number;
  readonly #signal: AbortSignal;
  readonly #admitted = new Set<number>();
  readonly #started = new Set<number>();
  readonly #running = new Set<number>();
  readonly #finished = new Set<number>();
  #refused = false;
  #waiters: Array<() => void> = [];

  /** `calls`: the calls to dispatch, in call order (their index in the response and whether they are parallel-safe). */
  constructor(calls: ReadonlyArray<{ index: number; parallelSafe: boolean }>, limit: number, signal: AbortSignal) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new HypertestError('invalid_argument', `gate limit must be a positive integer (got ${limit})`);
    this.#limit = limit;
    this.#signal = signal;
    let segment = -1;
    let previousParallel = false;
    for (const c of calls) {
      if (!(c.parallelSafe && previousParallel)) segment += 1;
      this.#segment.set(c.index, segment);
      previousParallel = c.parallelSafe;
    }
    if (!signal.aborted) signal.addEventListener('abort', () => this.#wake(), { once: true });
  }

  has(index: number): boolean {
    return this.#segment.has(index);
  }

  /** pi prepared the call (it will be executed unless the turn aborts). */
  admit(index: number): void {
    this.#segmentOf(index);
    this.#admitted.add(index);
  }

  /** Waits until the call may be dispatched; 'aborted'/'refused' mean it must not be dispatched. */
  async acquire(index: number): Promise<GateAdmission> {
    const segment = this.#segmentOf(index);
    this.#admitted.add(index);
    for (;;) {
      if (this.#signal.aborted) return 'aborted';
      if (this.#refused) return 'refused';
      if (this.#mayStart(index, segment)) {
        this.#started.add(index);
        this.#running.add(index);
        // A later call of this segment may have been waiting for this one to start (in-order start).
        this.#wake();
        return 'go';
      }
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  /** The call finished (settled, aborted or failed). */
  release(index: number): void {
    this.#running.delete(index);
    this.#finished.add(index);
    this.#wake();
  }

  /** A dispatch fault: no further call starts. */
  refuse(): void {
    this.#refused = true;
    this.#wake();
  }

  #mayStart(index: number, segment: number): boolean {
    let runningInSegment = 0;
    for (const j of this.#admitted) {
      if (j === index) continue;
      const s = this.#segment.get(j)!;
      if (s < segment && !this.#finished.has(j)) return false;
      if (s === segment) {
        if (this.#running.has(j)) runningInSegment += 1;
        if (j < index && !this.#started.has(j)) return false;
      }
    }
    return runningInSegment < this.#limit;
  }

  #segmentOf(index: number): number {
    const s = this.#segment.get(index);
    if (s === undefined) throw new HypertestError('internal', `tool call #${index} is not scheduled for dispatch in this turn`);
    return s;
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }
}
