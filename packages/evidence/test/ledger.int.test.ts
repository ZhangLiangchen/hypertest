import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { SqlDatabase } from '@hypertest/core';
import { createTestDatabase } from '@hypertest/store';
import { infraEnv, skipUnless, testDeps } from '@hypertest/testkit';
import { Ed25519Signer, MemoryArtifactStore, createEvidenceLedger, type EvidenceLedger } from '../src/index.ts';
import { SqlEventSink, asAttacker, evidenceInput, migrations } from './helpers.ts';

// Runs against a real PostgreSQL 16 (pooled connections ⇒ genuinely parallel transactions), unlike
// PGlite whose single connection serializes transactions.
const pgUrl = infraEnv().pgUrl;
const skip = skipUnless(!!pgUrl, 'HYPERTEST_TEST_PG_URL is not set (no local PostgreSQL; run npm run infra:up)');

let db: SqlDatabase | undefined;
let dispose: (() => Promise<void>) | undefined;
let ledger: EvidenceLedger;
let artifacts: MemoryArtifactStore;
let sink: SqlEventSink;
const signer = Ed25519Signer.generate();

before(async () => {
  if (!pgUrl) return;
  process.env['HYPERTEST_TEST_PG_URL'] ??= pgUrl;
  ({ db, dispose } = await createTestDatabase({ kind: 'postgres', migrations }));
  artifacts = new MemoryArtifactStore();
  sink = new SqlEventSink(db);
  ledger = createEvidenceLedger({ ...testDeps(), db, artifacts, signer, events: sink });
});
after(async () => {
  await dispose?.();
});

test('postgres: 40 parallel appends (advisory lock) produce a gap-free chain and one event each', skip, async () => {
  const runId = 'run_pg_parallel';
  const refs = await Promise.all(Array.from({ length: 40 }, (_, i) => artifacts.put(`pg ${i}`, { mimeType: 'text/plain' })));
  const records = await Promise.all(refs.map((a) => ledger.append(evidenceInput(runId, a))));
  const sorted = [...records].sort((x, y) => x.seq - y.seq);
  assert.deepEqual(sorted.map((r) => r.seq), Array.from({ length: 40 }, (_, i) => i + 1));
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i]!.previousRecordHash, sorted[i - 1]!.recordHash);
  assert.equal((await sink.rows(runId)).length, 40);
  await ledger.seal(runId);
  const v = await ledger.verify(runId);
  assert.deepEqual(v.problems, []);
  assert.equal(v.count, 40);
});

test('postgres: appends racing a seal never produce a false seal_root', skip, async () => {
  const runId = 'run_pg_seal_race';
  const jobs: Promise<unknown>[] = [];
  for (let i = 0; i < 20; i++) {
    jobs.push(artifacts.put(`race ${i}`, { mimeType: 'text/plain' }).then((a) => ledger.append(evidenceInput(runId, a))));
    if (i % 5 === 4) jobs.push(ledger.seal(runId));
  }
  await Promise.all(jobs);
  const v = await ledger.verify(runId);
  assert.deepEqual(v.problems, []);
  assert.equal(v.count, 20);
});

test('postgres: tampering is detected and the append-only trigger holds', skip, async () => {
  const runId = 'run_pg_tamper';
  const recs = [];
  for (let i = 0; i < 3; i++) recs.push(await ledger.append(evidenceInput(runId, await artifacts.put(`t ${i}`, { mimeType: 'text/plain' }))));
  await assert.rejects(db!.query('UPDATE ht_evidence SET summary = $1 WHERE evidence_id = $2', ['x', recs[1]!.evidenceId]), /append-only/);
  await asAttacker(db!, 'DELETE FROM ht_evidence WHERE evidence_id = $1', [recs[1]!.evidenceId]);
  const v = await ledger.verify(runId);
  assert.deepEqual(v.problems.map((p) => [p.kind, p.seq]), [
    ['seq_gap', 3],
    ['chain_break', 3],
  ]);
});

test('postgres: concurrent seal() calls under the advisory lock yield one seal row, returned to every caller', skip, async () => {
  const runId = 'run_pg_seal_concurrent';
  for (let i = 0; i < 3; i++) await ledger.append(evidenceInput(runId, await artifacts.put(`sc ${i}`, { mimeType: 'text/plain' })));
  const seals = await Promise.all(Array.from({ length: 6 }, () => ledger.seal(runId)));
  for (const s of seals) assert.deepEqual(s, seals[0]);
  const rows = await db!.query<{ n: unknown }>('SELECT count(*) AS n FROM ht_evidence_seals WHERE run_id = $1', [runId]);
  assert.equal(Number(rows.rows[0]!.n), 1);
  assert.equal((await ledger.verify(runId)).ok, true);
});

/** Polls pg_locks until the ledger's per-run advisory lock (pg_advisory_xact_lock(hashtext(runId))) is held / waited on. */
async function waitForAdvisoryLock(runId: string, state: 'held' | 'waiting'): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await db!.query<{ n: unknown }>(
      `SELECT count(*) AS n FROM pg_locks
        WHERE locktype = 'advisory' AND objsubid = 1 AND granted = $2
          AND objid = (hashtext($1)::bigint & 4294967295)::oid`,
      [runId, state === 'held'],
    );
    if (Number(res.rows[0]!.n) > 0) return;
    if (Date.now() > deadline) throw new Error(`advisory lock of ${runId} never ${state}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

for (const outcome of ['commit', 'rollback'] as const) {
  test(`postgres: a caller transaction holds the per-run lock until ${outcome}; the waiting append then chains gap-free`, skip, async () => {
    const runId = `run_pg_caller_tx_${outcome}`;
    const a1 = await artifacts.put(`${runId} held`, { mimeType: 'text/plain' });
    const a2 = await artifacts.put(`${runId} waiting`, { mimeType: 'text/plain' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = db!.transaction(async (tx) => {
      const r = await ledger.append(evidenceInput(runId, a1), tx);
      await gate;
      if (outcome === 'rollback') throw new Error('caller rolled back');
      return r;
    });
    const heldSettled = held.then(
      (r) => r,
      (e: unknown) => e,
    );
    let waitingDone = false;
    let waiting: Promise<Awaited<ReturnType<EvidenceLedger['append']>>> | undefined;
    try {
      await waitForAdvisoryLock(runId, 'held'); // the caller's append holds the lock before the second starts
      waiting = ledger.append(evidenceInput(runId, a2)).then((r) => {
        waitingDone = true;
        return r;
      });
      await waitForAdvisoryLock(runId, 'waiting');
      assert.equal(waitingDone, false, 'the second append is blocked while the caller transaction is open');
    } finally {
      release(); // always end the caller transaction, or dispose() would wait on its connection forever
    }
    const first = await heldSettled;
    const second = await waiting;
    if (outcome === 'commit') {
      assert.equal((first as { seq: number }).seq, 1);
      assert.equal(second.seq, 2);
      assert.equal(second.previousRecordHash, (first as { recordHash: string }).recordHash);
    } else {
      assert.match(String((first as Error).message), /caller rolled back/);
      assert.equal(second.seq, 1, 'the rolled-back seq is reused: no gap');
      assert.equal(second.previousRecordHash, undefined);
    }
    const v = await ledger.verify(runId);
    assert.deepEqual(v.problems, []);
    assert.equal(v.count, outcome === 'commit' ? 2 : 1);
    assert.equal((await sink.rows(runId)).length, v.count, 'events exist exactly for committed evidence');
  });
}
