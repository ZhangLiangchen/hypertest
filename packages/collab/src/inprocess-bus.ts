import {
  HypertestError,
  noopLogger,
  subjectMatches,
  toHypertestError,
  type DeliveredEvent,
  type EventBus,
  type EventEnvelope,
  type Logger,
  type SubscribeOptions,
  type Subscription,
} from '@hypertest/core';
import type { InProcessBusOptions } from './contracts.ts';

const DEFAULT_ACK_WAIT_MS = 30_000;
const DEFAULT_MAX_DELIVER = 5;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_GRACE_MS = 5_000;

interface StoredMessage {
  streamSeq: number;
  eventId: string;
  eventType: string;
  subject: string;
  /** Serialized envelope: every delivery parses a private copy, like a real broker. */
  json: string;
}

interface Delivery {
  msg: StoredMessage;
  deliveryCount: number;
}

interface Subscriber {
  id: number;
  handler: SubscribeOptions['handler'];
  busy: boolean;
  /** Settles when the subscriber's current handler invocation (if any) has returned. */
  inflight: Promise<void> | undefined;
}

interface ConsumerGroup {
  name: string;
  subjects: string[];
  ackWaitMs: number;
  maxDeliver: number;
  onDeadLetter: SubscribeOptions['onDeadLetter'];
  /** Deliveries ready to dispatch, ordered by (streamSeq, deliveryCount). */
  ready: Delivery[];
  /** Redeliveries waiting for their delay timer. */
  scheduled: number;
  /** Handler invocations that have not returned yet (including ones whose ack wait expired). */
  running: number;
  subscribers: Subscriber[];
  rr: number;
}

/**
 * In-process EventBus with JetStream-like semantics, used by tests, the local runtime and eval arms.
 *
 * - The stream retains every published message. A durable consumer (keyed by `durableName`) is created on
 *   the first subscribe and starts from the beginning of the stream (deliver policy "all") filtered by its
 *   subjects; later subscribes with the same name join it (queue semantics: each delivery goes to exactly
 *   one subscriber, round robin over idle subscribers) and update its config. Unsubscribing every
 *   subscriber keeps the durable's position; re-subscribing resumes it.
 * - First deliveries are dispatched in stream order; every subscriber handles one delivery at a time.
 * - A handler that throws is redelivered after `ackWaitMs`; one that does not finish within `ackWaitMs` is
 *   redelivered immediately (its late completion is ignored). `deliveryCount` increments per delivery.
 *   After `maxDeliver` failed deliveries the message is dropped and reported through `onDeadLetter`.
 * - Fault injection (I5): when `duplicateDelivery` (a predicate, or a probability) selects a message, each consumer
 *   receives it twice as two separate deliveries (the second with deliveryCount 2). `delayedAck` delays the ack of
 *   a handled delivery; past ackWaitMs the handled message is redelivered. Publishes are NOT deduplicated.
 * - drain() waits until every consumer with subscribers has nothing ready, scheduled or running, and rejects
 *   with a `timeout` HypertestError otherwise (never a silent partial drain).
 * - unsubscribe() and close() wait (at most `closeGraceMs`) for handler invocations still running, so a caller
 *   may release what the handlers use (e.g. the database) once they resolve.
 */
export class InProcessEventBus implements EventBus {
  readonly kind = 'inprocess' as const;
  readonly #options: InProcessBusOptions;
  readonly #logger: Logger;
  readonly #stream: StoredMessage[] = [];
  readonly #groups = new Map<string, ConsumerGroup>();
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #waiters = new Set<{ resolve: () => void; reject: (e: unknown) => void }>();
  /** Handler invocations that have not returned yet (awaited by close()). */
  readonly #inflight = new Set<Promise<void>>();
  /** Pending delayed-ack waits; close() releases them. */
  readonly #ackDelays = new Set<() => void>();
  readonly #closeGraceMs: number;
  readonly #random: () => number;
  #nextSubscriberId = 1;
  #closed = false;

  constructor(options: InProcessBusOptions = {}) {
    const dup = options.duplicateDelivery;
    if (typeof dup === 'number' && !(dup >= 0 && dup <= 1)) throw new HypertestError('invalid_argument', 'duplicateDelivery probability must be within [0, 1]');
    if (options.closeGraceMs !== undefined && !(options.closeGraceMs >= 0)) throw new HypertestError('invalid_argument', 'closeGraceMs must be >= 0');
    this.#options = options;
    this.#logger = options.logger ?? noopLogger;
    this.#closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.#random = options.random ?? Math.random;
  }

  /** Number of messages retained in the stream (diagnostics). */
  get streamLength(): number {
    return this.#stream.length;
  }

  async publish(event: EventEnvelope): Promise<void> {
    this.#assertOpen();
    if (typeof event?.eventId !== 'string' || event.eventId.length === 0) throw new HypertestError('invalid_argument', 'envelope.eventId is required');
    if (typeof event.subject !== 'string' || event.subject.length === 0) throw new HypertestError('invalid_argument', 'envelope.subject is required');
    let json: string;
    try {
      json = JSON.stringify(event);
    } catch (e) {
      throw new HypertestError('invalid_argument', `envelope is not JSON-serializable: ${(e as Error).message}`, { cause: e });
    }
    const msg: StoredMessage = { streamSeq: this.#stream.length + 1, eventId: event.eventId, eventType: event.eventType, subject: event.subject, json };
    this.#stream.push(msg);
    for (const group of this.#groups.values()) {
      if (this.#matches(group, msg)) {
        this.#enqueueFirst(group, msg);
        this.#pump(group);
      }
    }
  }

  async subscribe(options: SubscribeOptions): Promise<Subscription> {
    this.#assertOpen();
    if (typeof options.durableName !== 'string' || options.durableName.length === 0) throw new HypertestError('invalid_argument', 'durableName is required');
    if (!Array.isArray(options.subjects) || options.subjects.length === 0) throw new HypertestError('invalid_argument', 'at least one subject filter is required');
    if (typeof options.handler !== 'function') throw new HypertestError('invalid_argument', 'handler must be a function');
    const ackWaitMs = options.ackWaitMs ?? this.#options.defaultAckWaitMs ?? DEFAULT_ACK_WAIT_MS;
    const maxDeliver = options.maxDeliver ?? this.#options.defaultMaxDeliver ?? DEFAULT_MAX_DELIVER;
    if (!(ackWaitMs > 0)) throw new HypertestError('invalid_argument', 'ackWaitMs must be positive');
    if (!Number.isInteger(maxDeliver) || maxDeliver < 1) throw new HypertestError('invalid_argument', 'maxDeliver must be a positive integer');

    let group = this.#groups.get(options.durableName);
    if (!group) {
      group = {
        name: options.durableName,
        subjects: [...options.subjects],
        ackWaitMs,
        maxDeliver,
        onDeadLetter: options.onDeadLetter,
        ready: [],
        scheduled: 0,
        running: 0,
        subscribers: [],
        rr: 0,
      };
      this.#groups.set(group.name, group);
      for (const msg of this.#stream) if (this.#matches(group, msg)) this.#enqueueFirst(group, msg);
    } else {
      // Consumer update: the latest subscribe defines the durable's filter and delivery policy.
      group.subjects = [...options.subjects];
      group.ackWaitMs = ackWaitMs;
      group.maxDeliver = maxDeliver;
      group.onDeadLetter = options.onDeadLetter;
    }
    const sub: Subscriber = { id: this.#nextSubscriberId++, handler: options.handler, busy: false, inflight: undefined };
    group.subscribers.push(sub);
    this.#pump(group);
    const g = group;
    let active = true;
    return {
      unsubscribe: async () => {
        if (!active) return;
        active = false;
        const i = g.subscribers.indexOf(sub);
        if (i >= 0) g.subscribers.splice(i, 1);
        this.#checkIdle();
        // Like the NATS bus: return once this subscriber's running handler has finished (bounded).
        if (sub.inflight) await this.#awaitBounded([sub.inflight], `subscriber of ${g.name}`);
      },
    };
  }

  drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
    if (this.#closed || this.#idle()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          this.#waiters.delete(waiter);
          resolve();
        },
        reject: (e: unknown) => {
          clearTimeout(timer);
          this.#waiters.delete(waiter);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        waiter.reject(new HypertestError('timeout', `event bus not drained after ${timeoutMs}ms`, { details: { pending: this.#pendingSummary() } }));
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    for (const release of [...this.#ackDelays]) release();
    for (const g of this.#groups.values()) {
      g.ready = [];
      g.subscribers = [];
      g.scheduled = 0;
    }
    for (const w of [...this.#waiters]) w.resolve();
    // Handlers still running may be using resources the caller releases right after close() (e.g. the database):
    // wait for them, bounded, instead of returning while they run.
    if (this.#inflight.size > 0) await this.#awaitBounded([...this.#inflight], 'close');
  }

  // ------------------------------------------------------------------------------------------ internals

  #assertOpen(): void {
    if (this.#closed) throw new HypertestError('unavailable', 'event bus is closed');
  }

  #matches(group: ConsumerGroup, msg: StoredMessage): boolean {
    return group.subjects.some((f) => subjectMatches(f, msg.subject));
  }

  async #awaitBounded(promises: Array<Promise<void>>, what: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    // Deliberately ref'd: a caller is awaiting this bounded wait, and a stuck handler keeps nothing else alive.
    const grace = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.#closeGraceMs);
    });
    const outcome = await Promise.race([Promise.allSettled(promises).then(() => 'done' as const), grace]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') this.#logger.warn('detached from event handlers that did not finish in time', { what, graceMs: this.#closeGraceMs });
  }

  #enqueueFirst(group: ConsumerGroup, msg: StoredMessage): void {
    this.#enqueue(group, { msg, deliveryCount: 1 });
    let duplicate = false;
    const dup = this.#options.duplicateDelivery;
    try {
      duplicate = typeof dup === 'number' ? this.#random() < dup : (dup?.({ eventId: msg.eventId, eventType: msg.eventType }) ?? false);
    } catch (e) {
      this.#logger.warn('duplicateDelivery predicate threw; not duplicating', { error: toHypertestError(e).message });
    }
    if (duplicate) this.#enqueue(group, { msg, deliveryCount: 2 });
  }

  /** Fault injection: resolves after the configured ack delay (immediately when none), or when the bus closes. */
  #ackDelay(d: Delivery): Promise<void> | undefined {
    let ms = 0;
    try {
      ms = this.#options.delayedAck?.({ eventId: d.msg.eventId, eventType: d.msg.eventType, deliveryCount: d.deliveryCount }) ?? 0;
    } catch (e) {
      this.#logger.warn('delayedAck callback threw; acking without delay', { error: toHypertestError(e).message });
    }
    if (!(ms > 0) || this.#closed) return undefined;
    return new Promise<void>((resolve) => {
      const release = () => {
        clearTimeout(t);
        this.#ackDelays.delete(release);
        resolve();
      };
      const t = setTimeout(release, ms);
      t.unref();
      this.#ackDelays.add(release);
    });
  }

  #enqueue(group: ConsumerGroup, d: Delivery): void {
    let i = group.ready.length;
    while (i > 0) {
      const prev = group.ready[i - 1]!;
      if (prev.msg.streamSeq < d.msg.streamSeq || (prev.msg.streamSeq === d.msg.streamSeq && prev.deliveryCount <= d.deliveryCount)) break;
      i--;
    }
    group.ready.splice(i, 0, d);
  }

  #nextIdle(group: ConsumerGroup): Subscriber | undefined {
    const n = group.subscribers.length;
    for (let k = 0; k < n; k++) {
      const idx = (group.rr + k) % n;
      const s = group.subscribers[idx]!;
      if (!s.busy) {
        group.rr = (idx + 1) % n;
        return s;
      }
    }
    return undefined;
  }

  #pump(group: ConsumerGroup): void {
    if (this.#closed) return;
    while (group.ready.length > 0) {
      const sub = this.#nextIdle(group);
      if (!sub) break;
      this.#dispatch(group, sub, group.ready.shift()!);
    }
    this.#checkIdle();
  }

  #dispatch(group: ConsumerGroup, sub: Subscriber, d: Delivery): void {
    sub.busy = true;
    group.running++;
    let settled = false;
    const ackTimer = setTimeout(() => {
      this.#timers.delete(ackTimer);
      if (settled) return;
      settled = true;
      this.#fail(group, d, new HypertestError('timeout', `handler did not ack within ${group.ackWaitMs}ms`), 0);
    }, group.ackWaitMs);
    ackTimer.unref();
    this.#timers.add(ackTimer);

    const event: DeliveredEvent = { ...(JSON.parse(d.msg.json) as EventEnvelope), deliveryCount: d.deliveryCount };
    const run = Promise.resolve()
      .then(() => sub.handler(event))
      .then(() => this.#ackDelay(d))
      .then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(ackTimer);
          this.#timers.delete(ackTimer);
        },
        (e: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(ackTimer);
          this.#timers.delete(ackTimer);
          this.#logger.debug('handler failed; message will be redelivered', { consumer: group.name, eventId: d.msg.eventId, deliveryCount: d.deliveryCount, error: toHypertestError(e).message });
          this.#fail(group, d, e, group.ackWaitMs);
        },
      )
      .finally(() => {
        sub.busy = false;
        group.running--;
        this.#inflight.delete(run);
        if (sub.inflight === run) sub.inflight = undefined;
        this.#pump(group);
      });
    this.#inflight.add(run);
    sub.inflight = run;
  }

  #fail(group: ConsumerGroup, d: Delivery, error: unknown, delayMs: number): void {
    if (this.#closed) return;
    if (d.deliveryCount >= group.maxDeliver) {
      const event: DeliveredEvent = { ...(JSON.parse(d.msg.json) as EventEnvelope), deliveryCount: d.deliveryCount };
      try {
        group.onDeadLetter?.(event, error);
      } catch (e) {
        this.#logger.error('onDeadLetter callback threw', { consumer: group.name, eventId: d.msg.eventId, error: toHypertestError(e).message });
      }
      this.#logger.warn('message dead-lettered after maxDeliver deliveries', { consumer: group.name, eventId: d.msg.eventId, deliveries: d.deliveryCount });
      this.#checkIdle();
      return;
    }
    const next: Delivery = { msg: d.msg, deliveryCount: d.deliveryCount + 1 };
    if (delayMs <= 0) {
      this.#enqueue(group, next);
      this.#pump(group);
      return;
    }
    group.scheduled++;
    const t = setTimeout(() => {
      this.#timers.delete(t);
      group.scheduled--;
      this.#enqueue(group, next);
      this.#pump(group);
    }, delayMs);
    t.unref();
    this.#timers.add(t);
  }

  #idle(): boolean {
    for (const g of this.#groups.values()) {
      if (g.running > 0) return false;
      if (g.subscribers.length > 0 && (g.ready.length > 0 || g.scheduled > 0)) return false;
    }
    return true;
  }

  #pendingSummary(): Record<string, { ready: number; scheduled: number; running: number; subscribers: number }> {
    const out: Record<string, { ready: number; scheduled: number; running: number; subscribers: number }> = {};
    for (const g of this.#groups.values()) out[g.name] = { ready: g.ready.length, scheduled: g.scheduled, running: g.running, subscribers: g.subscribers.length };
    return out;
  }

  #checkIdle(): void {
    if (this.#waiters.size === 0 || !this.#idle()) return;
    for (const w of [...this.#waiters]) w.resolve();
  }
}
