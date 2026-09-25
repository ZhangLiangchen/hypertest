import type { CollabDeps, Inbox } from './contracts.ts';
import { requireString } from './sql.ts';

/**
 * Consumer-side dedupe (I5). Call tryConsume inside the handler's transaction together with the side effect:
 * the first delivery inserts (consumer, eventId) and performs the effect; a duplicate delivery gets false
 * (and, when concurrent, waits for the first transaction's unique-key lock, then sees the committed row).
 * If the handler transaction rolls back, the inbox row rolls back with it, so a redelivery retries.
 */
export function createInbox(deps: CollabDeps): Inbox {
  const { db, clock } = deps;
  return {
    async tryConsume(consumer, eventId, tx) {
      requireString(consumer, 'consumer');
      requireString(eventId, 'eventId');
      const r = await (tx ?? db).query(
        'INSERT INTO ht_inbox (consumer, event_id, consumed_at) VALUES ($1, $2, $3) ON CONFLICT (consumer, event_id) DO NOTHING',
        [consumer, eventId, clock.isoNow()],
      );
      return r.rowCount === 1;
    },
    async consumed(consumer, eventId) {
      const r = await db.query('SELECT 1 FROM ht_inbox WHERE consumer = $1 AND event_id = $2', [consumer, eventId]);
      return r.rows.length > 0;
    },
  };
}
