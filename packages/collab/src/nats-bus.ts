import { createHash } from 'node:crypto';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import {
  AckPolicy,
  DeliverPolicy,
  JetStreamApiError,
  StorageType,
  jetstreamManager,
  type ConsumerConfig,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
} from '@nats-io/jetstream';
import {
  HypertestError,
  noopLogger,
  sleep,
  toHypertestError,
  type DeliveredEvent,
  type EventBus,
  type EventEnvelope,
  type Logger,
  type SubscribeOptions,
  type Subscription,
} from '@hypertest/core';
import type { NatsBusOptions } from './contracts.ts';

const DEFAULT_STREAM = 'HYPERTEST';
const CANONICAL_ROOT = 'ht';
const DEFAULT_ACK_WAIT_MS = 30_000;
const DEFAULT_MAX_DELIVER = 5;
const DEFAULT_PREFETCH = 16;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DUPLICATE_WINDOW_MS = 120_000;
/** unsubscribe()/close() wait at most this long for an in-flight handler before detaching from it. */
const CLOSE_GRACE_MS = 5_000;
/** JetStream API error code for "stream not found". */
const STREAM_NOT_FOUND = 10059;
const NAME_RE = /^[A-Za-z0-9_-]+$/;

const nanos = (ms: number): number => Math.round(ms * 1_000_000);

/**
 * Durable/stream names may not contain `.`, `*`, `>`, whitespace or path separators. A name that had to be
 * rewritten gets a short hash of the original appended, so two distinct durables (e.g. `rca.x` and `rca_x`) never
 * collapse into one JetStream consumer — that would silently split each one's messages between them.
 */
export function sanitizeDurableName(name: string): string {
  if (typeof name !== 'string' || name.length === 0) throw new HypertestError('invalid_argument', 'durableName is empty');
  if (NAME_RE.test(name)) return name;
  const digest = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 10);
  return `${name.replace(/[^A-Za-z0-9_-]/g, '_')}_${digest}`;
}

/** Rewrites a canonical subject/filter (`ht.…`) onto the configured wire root. */
export function toWireSubject(subject: string, prefix: string): string {
  if (prefix === CANONICAL_ROOT) return subject;
  const tokens = subject.split('.');
  if (tokens[0] === CANONICAL_ROOT) return [prefix, ...tokens.slice(1)].join('.');
  if (tokens[0] === '>' || tokens[0] === '*') return `${prefix}.${subject}`;
  throw new HypertestError('invalid_argument', `subject ${subject} is outside the '${CANONICAL_ROOT}.' root`);
}

interface LocalSubscription {
  durable: string;
  messages: ConsumerMessages;
  loop: Promise<void>;
  running: number;
  closed: boolean;
}

/**
 * NATS JetStream EventBus (at-least-once, explicit acks).
 *
 * - One stream (`stream`, default HYPERTEST) captures `<subjectPrefix>.>` with file storage and a 2 minute
 *   duplicate window; publish uses `msgID = eventId`, so a relay republish inside the window is dropped by the
 *   server (consumers still dedupe through the Inbox for everything outside it).
 * - subscribe() creates or updates a durable pull consumer (deliver policy all, explicit ack, ack_wait,
 *   max_deliver, filter subjects) and runs a consume loop: ack on success, nak with delay `ackWaitMs` on throw,
 *   term + onDeadLetter once `deliveryCount >= maxDeliver`. Subscribers sharing a durable name share work.
 * - drain() polls consumer info until num_pending + num_ack_pending is 0 for every local durable and no
 *   local handler is running; it rejects with `timeout` otherwise.
 */
class NatsJetStreamEventBus implements EventBus {
  readonly kind = 'nats' as const;
  readonly #nc: NatsConnection;
  readonly #jsm: JetStreamManager;
  readonly #js: JetStreamClient;
  readonly #stream: string;
  readonly #prefix: string;
  readonly #prefetch: number;
  readonly #logger: Logger;
  readonly #subs = new Set<LocalSubscription>();
  #closed = false;

  constructor(nc: NatsConnection, jsm: JetStreamManager, stream: string, prefix: string, prefetch: number, logger: Logger) {
    this.#nc = nc;
    this.#jsm = jsm;
    this.#js = jsm.jetstream();
    this.#stream = stream;
    this.#prefix = prefix;
    this.#prefetch = prefetch;
    this.#logger = logger;
  }

  async publish(event: EventEnvelope): Promise<void> {
    this.#assertOpen();
    if (typeof event?.eventId !== 'string' || event.eventId.length === 0) throw new HypertestError('invalid_argument', 'envelope.eventId is required');
    const subject = toWireSubject(event.subject, this.#prefix);
    try {
      await this.#js.publish(subject, JSON.stringify(event), { msgID: event.eventId });
    } catch (e) {
      throw new HypertestError('unavailable', `JetStream publish failed: ${(e as Error).message}`, { cause: e, details: { subject, eventId: event.eventId } });
    }
  }

  async subscribe(options: SubscribeOptions): Promise<Subscription> {
    this.#assertOpen();
    if (!Array.isArray(options.subjects) || options.subjects.length === 0) throw new HypertestError('invalid_argument', 'at least one subject filter is required');
    if (typeof options.handler !== 'function') throw new HypertestError('invalid_argument', 'handler must be a function');
    const durable = sanitizeDurableName(options.durableName ?? '');
    const ackWaitMs = options.ackWaitMs ?? DEFAULT_ACK_WAIT_MS;
    const maxDeliver = options.maxDeliver ?? DEFAULT_MAX_DELIVER;
    // Same validation as the in-process bus; a bad value would otherwise surface as a misleading consumer conflict.
    if (!(ackWaitMs > 0)) throw new HypertestError('invalid_argument', 'ackWaitMs must be positive');
    if (!Number.isInteger(maxDeliver) || maxDeliver < 1) throw new HypertestError('invalid_argument', 'maxDeliver must be a positive integer');
    const filters = options.subjects.map((s) => toWireSubject(s, this.#prefix));
    const filterConfig: Partial<ConsumerConfig> = filters.length === 1 ? { filter_subject: filters[0]! } : { filter_subjects: filters };

    try {
      await this.#jsm.consumers.add(this.#stream, {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        ack_wait: nanos(ackWaitMs),
        max_deliver: maxDeliver,
        ...filterConfig,
      });
    } catch (e) {
      // Existing durable with a different config: update the mutable fields (JetStream consumer update).
      if (!(e instanceof JetStreamApiError)) throw toUnavailable(e, 'consumer create');
      try {
        await this.#jsm.consumers.update(this.#stream, durable, {
          ack_wait: nanos(ackWaitMs),
          max_deliver: maxDeliver,
          ...(filters.length === 1 ? { filter_subject: filters[0]!, filter_subjects: [] } : { filter_subjects: filters, filter_subject: '' }),
        });
      } catch (e2) {
        throw new HypertestError('conflict', `cannot create or update durable consumer ${durable}: ${(e as Error).message} / ${(e2 as Error).message}`, { cause: e2 });
      }
    }

    const consumer = await this.#js.consumers.get(this.#stream, durable);
    const messages = await consumer.consume({ max_messages: this.#prefetch });
    const local: LocalSubscription = { durable, messages, loop: Promise.resolve(), running: 0, closed: false };
    local.loop = this.#consumeLoop(local, options, maxDeliver, ackWaitMs);
    this.#subs.add(local);
    return {
      unsubscribe: async () => {
        await this.#closeSubscription(local);
      },
    };
  }

  async drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
    if (this.#closed) return;
    const deadline = Date.now() + timeoutMs;
    let last: Record<string, number> = {};
    for (;;) {
      const active = [...this.#subs].filter((s) => !s.closed);
      const durables = [...new Set(active.map((s) => s.durable))];
      let outstanding = active.reduce((n, s) => n + s.running, 0);
      last = { running: outstanding };
      for (const d of durables) {
        let info: Awaited<ReturnType<JetStreamManager['consumers']['info']>>;
        try {
          info = await this.#jsm.consumers.info(this.#stream, d);
        } catch (e) {
          throw toUnavailable(e, `consumer ${d} info`);
        }
        const n = info.num_pending + info.num_ack_pending;
        last[d] = n;
        outstanding += n;
      }
      if (outstanding === 0) return;
      if (Date.now() >= deadline) throw new HypertestError('timeout', `event bus not drained after ${timeoutMs}ms`, { details: { pending: last } });
      await sleep(20);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const s of [...this.#subs]) await this.#closeSubscription(s);
    try {
      await this.#nc.drain();
    } catch {
      await this.#nc.close().catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------------------------------ internals

  #assertOpen(): void {
    if (this.#closed) throw new HypertestError('unavailable', 'event bus is closed');
  }

  async #closeSubscription(s: LocalSubscription): Promise<void> {
    if (s.closed) return;
    s.closed = true;
    this.#subs.delete(s);
    await s.messages.close().catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CLOSE_GRACE_MS);
      timer.unref();
    });
    const outcome = await Promise.race([s.loop.then(() => 'done' as const), grace]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') this.#logger.warn('detached from a JetStream handler that did not finish; its message will be redelivered', { durable: s.durable });
  }

  async #consumeLoop(local: LocalSubscription, options: SubscribeOptions, maxDeliver: number, ackWaitMs: number): Promise<void> {
    try {
      for await (const m of local.messages) {
        if (local.closed) {
          // Not handled here: let the server redeliver it to another subscriber.
          this.#reply('nak', m, () => m.nak());
          continue;
        }
        local.running++;
        try {
          await this.#handle(m, options, maxDeliver, ackWaitMs);
        } finally {
          local.running--;
        }
      }
    } catch (e) {
      if (!local.closed) this.#logger.error('JetStream consume loop ended', { durable: local.durable, error: toHypertestError(e).message });
    }
  }

  /**
   * Sends an ack/nak/term. These write to the connection and throw once it is closing; the server then redelivers
   * after ack_wait, so the failure is logged, never allowed to end the consume loop (which would silently stop the
   * subscription).
   */
  #reply(what: string, m: JsMsg, send: () => void): void {
    try {
      send();
    } catch (e) {
      this.#logger.warn(`JetStream ${what} failed; the server will redeliver after ack_wait`, { subject: m.subject, error: toHypertestError(e).message });
    }
  }

  async #handle(m: JsMsg, options: SubscribeOptions, maxDeliver: number, ackWaitMs: number): Promise<void> {
    let delivered: DeliveredEvent;
    try {
      delivered = { ...(m.json<EventEnvelope>()), deliveryCount: m.info.deliveryCount };
    } catch (e) {
      // A message that is not an envelope can never be handled: terminate instead of redelivering forever.
      this.#logger.error('dropping malformed JetStream message', { subject: m.subject, error: toHypertestError(e).message });
      this.#reply('term', m, () => m.term('malformed envelope'));
      return;
    }
    try {
      await options.handler(delivered);
    } catch (e) {
      if (delivered.deliveryCount >= maxDeliver) {
        try {
          options.onDeadLetter?.(delivered, e);
        } catch (cbErr) {
          this.#logger.error('onDeadLetter callback threw', { eventId: delivered.eventId, error: toHypertestError(cbErr).message });
        }
        this.#reply('term', m, () => m.term('max deliveries exceeded'));
      } else {
        this.#reply('nak', m, () => m.nak(ackWaitMs));
      }
      return;
    }
    try {
      await m.ackAck();
    } catch {
      this.#reply('ack', m, () => m.ack());
    }
  }
}

function toUnavailable(e: unknown, what: string): HypertestError {
  if (e instanceof HypertestError) return e;
  return new HypertestError('unavailable', `JetStream ${what} failed: ${(e as Error)?.message ?? String(e)}`, { cause: e });
}

async function ensureStream(jsm: JetStreamManager, stream: string, prefix: string): Promise<void> {
  const subject = `${prefix}.>`;
  try {
    const info = await jsm.streams.info(stream);
    if (!info.config.subjects.includes(subject)) {
      await jsm.streams.update(stream, { ...info.config, subjects: [...info.config.subjects, subject] });
    }
  } catch (e) {
    if (!(e instanceof JetStreamApiError) || e.code !== STREAM_NOT_FOUND) throw toUnavailable(e, `stream ${stream} lookup`);
    await jsm.streams.add({ name: stream, subjects: [subject], storage: StorageType.File, duplicate_window: nanos(DUPLICATE_WINDOW_MS) });
  }
}

/** Connects to NATS, ensures the JetStream stream exists and returns an EventBus over it. */
export async function connectNatsEventBus(options: NatsBusOptions): Promise<EventBus> {
  const stream = options.stream ?? DEFAULT_STREAM;
  const prefix = options.subjectPrefix ?? CANONICAL_ROOT;
  if (!NAME_RE.test(stream)) throw new HypertestError('invalid_argument', `invalid JetStream stream name: ${stream}`);
  if (!NAME_RE.test(prefix)) throw new HypertestError('invalid_argument', `invalid subject prefix: ${prefix}`);
  const prefetch = options.prefetch ?? DEFAULT_PREFETCH;
  if (!Number.isInteger(prefetch) || prefetch < 1) throw new HypertestError('invalid_argument', 'prefetch must be a positive integer');
  const logger = options.logger ?? noopLogger;
  let nc: NatsConnection;
  try {
    nc = await connect({ servers: options.servers, name: options.name ?? 'hypertest' });
  } catch (e) {
    throw new HypertestError('unavailable', `cannot connect to NATS at ${String(options.servers)}: ${(e as Error).message}`, { cause: e });
  }
  try {
    const jsm = await jetstreamManager(nc);
    await ensureStream(jsm, stream, prefix);
    return new NatsJetStreamEventBus(nc, jsm, stream, prefix, prefetch, logger);
  } catch (e) {
    await nc.close().catch(() => undefined);
    throw toUnavailable(e, 'setup');
  }
}
