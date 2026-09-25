import { HypertestError, toHypertestError, type EventEnvelope } from '@hypertest/core';
import type { OutboxRelay, OutboxRelayDeps } from './contracts.ts';
import { json, num } from './sql.ts';

const DEFAULT_POLL_MS = 250;
const DEFAULT_BATCH = 100;

/**
 * Publishes committed outbox rows to the bus in id order and marks them sent.
 *
 * Delivery is at-least-once: a row is marked sent only AFTER bus.publish resolved, so a crash (or a failed
 * mark) between publish and mark republishes the same envelope (same eventId) on the next flush; consumers
 * dedupe through the Inbox. A publish failure stops the flush at that row so later rows are not published
 * ahead of it; the row stays unsent and is retried by the next flush.
 */
export function createOutboxRelay(deps: OutboxRelayDeps): OutboxRelay {
  const { db, bus, clock, logger } = deps;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new HypertestError('invalid_argument', 'batchSize must be a positive integer');
  if (!(pollMs > 0)) throw new HypertestError('invalid_argument', 'pollMs must be positive');

  let inFlight: Promise<number> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  /** Bumped by every start()/stop(): a poll cycle of an earlier generation never reschedules itself. */
  let generation = 0;

  async function flushOnce(): Promise<number> {
    let published = 0;
    for (;;) {
      const r = await db.query<{ id: unknown; envelope: unknown }>(
        'SELECT id, envelope FROM ht_outbox WHERE sent_at IS NULL ORDER BY id LIMIT $1',
        [batchSize],
      );
      for (const row of r.rows) {
        const envelope = json<EventEnvelope>(row.envelope);
        await bus.publish({ ...envelope, publishedAt: clock.isoNow() });
        await db.query('UPDATE ht_outbox SET sent_at = $2 WHERE id = $1 AND sent_at IS NULL', [num(row.id), clock.isoNow()]);
        published++;
      }
      if (r.rows.length < batchSize) return published;
    }
  }

  function flush(): Promise<number> {
    // One flush at a time per relay: concurrent callers share the in-flight pass, then run their own.
    const previous = inFlight ?? Promise.resolve(0);
    const next = previous.catch(() => 0).then(flushOnce);
    const tracked = next.finally(() => {
      if (inFlight === tracked) inFlight = undefined;
    });
    inFlight = tracked;
    return tracked;
  }

  function schedule(gen: number): void {
    // Exactly one poll loop per generation: a stop() followed by start() while a flush is in flight must not leave
    // the old loop running next to the new one (it would keep publishing after the next stop()).
    if (!running || gen !== generation) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!running || gen !== generation) return;
      flush()
        .catch((e: unknown) => {
          const err = toHypertestError(e);
          logger.warn('outbox relay flush failed; rows stay unsent and are retried', { code: err.code, error: err.message });
        })
        .finally(() => schedule(gen));
    }, pollMs);
    timer.unref();
  }

  return {
    flush,
    start() {
      if (running) return;
      running = true;
      generation++;
      schedule(generation);
    },
    async stop() {
      running = false;
      generation++;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (inFlight) await inFlight.catch(() => 0);
    },
    async pending() {
      const r = await db.query<{ n: unknown }>('SELECT count(*) AS n FROM ht_outbox WHERE sent_at IS NULL');
      return num(r.rows[0]!.n);
    },
  };
}
