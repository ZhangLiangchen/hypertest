import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { collabMigrations, createEventStore } from '@hypertest/collab';
import { contextMigrations, createWorkingContextManager, rebuildWorkingContext, TRANSCRIPT_RECORDED_EVENT } from '@hypertest/context';
import type { SqlParam } from '@hypertest/core';
import { createTestDatabase } from '@hypertest/store';
import { createGitRepo } from '@hypertest/testkit';
import { call, createHarness, runItem, type Harness } from './harness.ts';

/**
 * (B[8], CONFORMANCE "L0 event store: PostgreSQL append-only immutable history" — "它是 Context 重建的根"): every transcript entry
 * an agent session commits is on L0 (immutable at the database level), every compaction too (with its summary), and an
 * agent's working context is rebuilt from L0 ALONE — the events copied into an empty database, no session store.
 */

const BIG = Array.from({ length: 400 }, (_, i) => `export const value${i} = ${i}; // ${'x'.repeat(24)}`).join('\n') + '\n';

describe('L0 is the root of context reconstruction', () => {
  let h: Harness;
  let repo: Awaited<ReturnType<typeof createGitRepo>>;
  let reads = 0;
  before(async () => {
    repo = await createGitRepo({ 'package.json': '{ "name": "big", "type": "module", "private": true }\n', 'src/big.js': BIG });
    h = await createHarness({
      transcriptL0: true,
      // a small working-view budget: the lead's view crosses HARD pressure after a few large reads ⇒ a compaction
      config: { maxInlineContextTokens: 3_000 },
      brains: {
        lead: () => {
          // a counter, not the view's step: a compaction folds earlier assistant turns into its summary
          reads++;
          if (reads <= 5) return call('fs.read', { path: 'src/big.js', startLine: reads * 10 });
          return call('complete_work', { summary: 'read', output: { summary: 'read the module', planProposed: false, readyForGate: false, objectives: [] } });
        },
      },
    });
  });
  after(async () => {
    await h.dispose();
    await repo.cleanup();
  });

  test('transcripts and compactions are on L0; rebuilt from L0 alone they equal the session store (and the working view)', async () => {
    const run = await h.control.startRun({ goal: 'read a big module', target: { repoPath: repo.path, commit: repo.commits[0]! } });
    const d = (await h.control.tick(run.runId)).dispatched[0]!;
    const status = await runItem(h.control, d.workItemId, d.fencingToken);
    assert.equal(status, 'completed', JSON.stringify((await h.deps.blackboard.getWorkItem(d.workItemId))?.failure));
    const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
    const storeTranscript = await h.deps.sessions.transcript(agent.sessionId);
    const storeCompactions = await h.deps.sessions.compactions(agent.sessionId);
    assert.ok(storeTranscript.length >= 12, `a long transcript (${storeTranscript.length} entries)`);
    assert.ok(storeCompactions.length >= 1, 'the working view was compacted');

    // copy L0 (ht_events of the run, nothing else) into an EMPTY database and rebuild there
    const fresh = await createTestDatabase({ migrations: [...collabMigrations, ...contextMigrations] });
    try {
      const rows = await h.db.query<Record<string, SqlParam>>('SELECT * FROM ht_events WHERE run_id = $1 ORDER BY seq', [run.runId]);
      const columns = ['event_id', 'run_id', 'seq', 'event_type', 'aggregate_type', 'aggregate_id', 'correlation_id', 'causation_id', 'actor_id', 'work_item_id', 'agent_id', 'schema_version', 'payload', 'occurred_at'];
      for (const r of rows.rows) {
        const values: SqlParam[] = columns.map((c) => (c === 'payload' ? JSON.stringify(typeof r[c] === 'string' ? JSON.parse(r[c] as string) : r[c]) : (r[c] ?? null)));
        await fresh.db.query(`INSERT INTO ht_events (${columns.join(', ')}) VALUES (${columns.map((c, i) => `$${i + 1}${c === 'payload' ? '::jsonb' : ''}`).join(', ')})`, values);
      }
      const l0 = createEventStore({ ids: h.ids, clock: h.clock, logger: h.logger, db: fresh.db });
      const rebuilt = await rebuildWorkingContext(l0, run.runId, agent.sessionId);
      assert.deepEqual(rebuilt.transcript, storeTranscript, 'every transcript entry, in order, from L0 alone');
      assert.deepEqual(rebuilt.compactions.map((c) => ({ ...c, createdAt: new Date(c.createdAt).toISOString() })), storeCompactions.map((c) => ({ ...c, createdAt: new Date(c.createdAt).toISOString() })), 'every compaction with its summary');
      const wc = createWorkingContextManager();
      const budget = 3_000;
      assert.deepEqual(wc.view({ transcript: rebuilt.transcript, compactions: rebuilt.compactions, budgetTokens: budget }), wc.view({ transcript: storeTranscript, compactions: storeCompactions, budgetTokens: budget }), 'the same working view');
    } finally {
      await fresh.dispose();
    }

    // L0 is immutable in the database: a transcript event can be neither rewritten nor removed
    await assert.rejects(h.db.query(`UPDATE ht_events SET payload = '{}'::jsonb WHERE event_type = $1`, [TRANSCRIPT_RECORDED_EVENT]), /append-only table ht_events/);
    await assert.rejects(h.db.query('DELETE FROM ht_events WHERE event_type = $1', [TRANSCRIPT_RECORDED_EVENT]), /append-only table ht_events/);
    // a gap in L0 is an integrity violation, never a silently shorter context
    const partial = { read: async (runId: string, o?: { types?: string[] }) => (await h.deps.events.read(runId, o)).filter((e) => (e.payload as { ordinal?: number }).ordinal !== 3) };
    await assert.rejects(rebuildWorkingContext(partial, run.runId, agent.sessionId), /misses transcript entry #3/);
  });
});
