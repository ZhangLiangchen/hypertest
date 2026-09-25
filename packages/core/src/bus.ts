/**
 * Event bus port: at-least-once delivery, explicit ack. The bus is a notification channel and never
 * the source of truth — consumers must dedupe by `eventId` through an inbox (see @hypertest/collab).
 */
export interface EventEnvelope {
  /** Globally unique id (from the outbox row); the dedupe key. */
  eventId: string;
  /** Dotted subject, e.g. `ht.run_01.finding.created`. */
  subject: string;
  eventType: string;
  runId: string;
  /** JSON payload (the full DomainEvent). */
  data: unknown;
  publishedAt: string;
}

export interface DeliveredEvent extends EventEnvelope {
  /** 1 on first delivery; >1 on redelivery. */
  deliveryCount: number;
}

export interface SubscribeOptions {
  /** Durable consumer name; deliveries are shared (queue semantics) between subscribers with the same name. */
  durableName: string;
  /** Subject filters; `*` matches one token, `>` matches the rest. */
  subjects: string[];
  handler: (event: DeliveredEvent) => Promise<void>;
  /** Redelivery delay when the handler throws or does not finish in time. */
  ackWaitMs?: number;
  /** After this many deliveries the message is dropped and reported via onDeadLetter. */
  maxDeliver?: number;
  onDeadLetter?: (event: DeliveredEvent, error: unknown) => void;
}

export interface Subscription {
  unsubscribe(): Promise<void>;
}

export interface EventBus {
  readonly kind: 'inprocess' | 'nats';
  publish(event: EventEnvelope): Promise<void>;
  subscribe(options: SubscribeOptions): Promise<Subscription>;
  /** Resolves when all currently published messages have been handled (best effort; used by tests/drivers). */
  drain(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

/** Subject matching with NATS semantics (`*` one token, `>` tail). */
export function subjectMatches(filter: string, subject: string): boolean {
  const f = filter.split('.');
  const s = subject.split('.');
  for (let i = 0; i < f.length; i++) {
    const tok = f[i];
    if (tok === '>') return s.length > i;
    if (i >= s.length) return false;
    if (tok !== '*' && tok !== s[i]) return false;
  }
  return f.length === s.length;
}

/** Canonical subject for a domain event: `ht.<runId>.<eventType>` (eventType dots preserved). */
export function eventSubject(runId: string, eventType: string): string {
  return `ht.${runId}.${eventType}`;
}
