import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { isHypertestError, sha256Hex, type SqlDatabase } from '@hypertest/core';
import type { ReportClaim } from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';
import { testDeps } from '@hypertest/testkit';
import { MemoryArtifactStore, computeMetadataHash, createEvidenceLedger, recordEvidence, resolveClaim, type EvidenceLedger } from '../src/index.ts';
import { asAttacker, migrations } from './helpers.ts';

let db: SqlDatabase;
let dispose: () => Promise<void>;
let artifacts: MemoryArtifactStore;
let ledger: EvidenceLedger;

before(async () => {
  ({ db, dispose } = await createTestDatabase({ migrations }));
  artifacts = new MemoryArtifactStore();
  ledger = createEvidenceLedger({ ...testDeps(), db, artifacts });
});
after(async () => {
  await dispose();
});

const producer = { workerId: 'worker-1', runtimeManifestId: 'rm_1' };

function claim(evidenceRefs: string[], evidenceQuery: ReportClaim['evidenceQuery'] = {}): ReportClaim {
  return { claimId: 'claim_1', statement: 'p95 latency is 120ms', value: 120, evidenceQuery, evidenceRefs, critical: true };
}

test('recordEvidence: puts the bytes and appends a record referencing them', async () => {
  const r = await recordEvidence(ledger, artifacts, {
    runId: 'run_record',
    evidenceType: 'metric',
    data: '{"p95":120}',
    mimeType: 'application/json',
    summary: 'p95 latency',
    structured: { p95: 120, window: { seconds: 60 } },
    classification: 'confidential',
    producer,
    provenance: { toolId: 'metrics.query' },
  });
  assert.equal(r.seq, 1);
  assert.equal(r.artifact.sha256, sha256Hex('{"p95":120}'));
  assert.equal(r.artifact.mimeType, 'application/json');
  assert.equal(r.classification, 'confidential');
  assert.equal(await artifacts.getText(r.artifact), '{"p95":120}');
  assert.deepEqual(await ledger.get(r.evidenceId), r);
});

test('resolveClaim: supported when every reference exists in one run and matches the query', async () => {
  const runId = 'run_claims_ok';
  const m1 = await recordEvidence(ledger, artifacts, { runId, evidenceType: 'metric', data: 'm1', mimeType: 'text/plain', summary: 'm1', structured: { latency: { p95: 120 } }, workItemId: 'wi_load', producer, provenance: {} });
  const m2 = await recordEvidence(ledger, artifacts, { runId, evidenceType: 'metric', data: 'm2', mimeType: 'text/plain', summary: 'm2', structured: { latency: { p95: 118 } }, workItemId: 'wi_load', producer, provenance: {} });
  const res = await resolveClaim(ledger, claim([m1.evidenceId, m2.evidenceId, m1.evidenceId], { evidenceType: 'metric', workItemId: 'wi_load', field: 'latency.p95' }), { runId });
  assert.equal(res.supported, true);
  assert.deepEqual(res.problems, []);
  assert.deepEqual(res.evidence.map((e) => e.evidenceId), [m1.evidenceId, m2.evidenceId]);
  assert.equal((await resolveClaim(ledger, claim([m1.evidenceId]))).supported, true, 'no query constraints, single run');
});

test('resolveClaim: unsupported — no references, unknown reference, wrong type, wrong work item, missing field', async () => {
  const runId = 'run_claims_bad';
  const log = await recordEvidence(ledger, artifacts, { runId, evidenceType: 'log', data: 'log line', mimeType: 'text/plain', summary: 'log', structured: { lines: [1] }, workItemId: 'wi_a', producer, provenance: {} });

  const empty = await resolveClaim(ledger, claim([]));
  assert.equal(empty.supported, false);
  assert.deepEqual(empty.problems, ['claim has no evidence references']);

  const unknown = await resolveClaim(ledger, claim([log.evidenceId, 'ev_missing']));
  assert.equal(unknown.supported, false);
  assert.deepEqual(unknown.problems, ['evidence ev_missing not found']);
  assert.deepEqual(unknown.evidence.map((e) => e.evidenceId), [log.evidenceId]);

  const wrongType = await resolveClaim(ledger, claim([log.evidenceId], { evidenceType: 'metric' }));
  assert.equal(wrongType.supported, false);
  assert.deepEqual(wrongType.problems, [`evidence ${log.evidenceId} has type log, claim requires metric`]);

  const wrongWorkItem = await resolveClaim(ledger, claim([log.evidenceId], { workItemId: 'wi_b' }));
  assert.deepEqual(wrongWorkItem.problems, [`evidence ${log.evidenceId} belongs to work item wi_a, claim requires wi_b`]);

  const missingField = await resolveClaim(ledger, claim([log.evidenceId], { field: 'latency.p95' }));
  assert.deepEqual(missingField.problems, [`evidence ${log.evidenceId} has no structured field latency.p95`]);
  assert.equal((await resolveClaim(ledger, claim([log.evidenceId], { field: 'lines.0' }))).supported, true, 'array index paths resolve');
  assert.equal((await resolveClaim(ledger, claim([log.evidenceId], { field: 'lines.1' }))).supported, false);
});

test('resolveClaim: evidence from another run is rejected', async () => {
  const a = await recordEvidence(ledger, artifacts, { runId: 'run_claim_a', evidenceType: 'metric', data: 'a', mimeType: 'text/plain', summary: 'a', producer, provenance: {} });
  const b = await recordEvidence(ledger, artifacts, { runId: 'run_claim_b', evidenceType: 'metric', data: 'b', mimeType: 'text/plain', summary: 'b', producer, provenance: {} });
  const mixed = await resolveClaim(ledger, claim([a.evidenceId, b.evidenceId]));
  assert.equal(mixed.supported, false);
  assert.deepEqual(mixed.problems, ['evidence spans multiple runs: run_claim_a, run_claim_b']);
  const pinned = await resolveClaim(ledger, claim([b.evidenceId]), { runId: 'run_claim_a' });
  assert.equal(pinned.supported, false);
  assert.deepEqual(pinned.problems, [`evidence ${b.evidenceId} belongs to run run_claim_b, not run_claim_a`]);
});

test('resolveClaim: a referenced record rewritten behind the ledger does not support the claim', async () => {
  const runId = 'run_claim_tampered';
  const good = await recordEvidence(ledger, artifacts, { runId, evidenceType: 'metric', data: 'good', mimeType: 'text/plain', summary: 'p95 = 480ms', structured: { p95: 480 }, producer, provenance: {} });
  const edited = await recordEvidence(ledger, artifacts, { runId, evidenceType: 'metric', data: 'edited', mimeType: 'text/plain', summary: 'p95 = 480ms', structured: { p95: 480 }, producer, provenance: {} });
  const rehashed = await recordEvidence(ledger, artifacts, { runId, evidenceType: 'metric', data: 'rehashed', mimeType: 'text/plain', summary: 'p95 = 480ms', structured: { p95: 480 }, producer, provenance: {} });
  assert.equal((await resolveClaim(ledger, claim([good.evidenceId, edited.evidenceId, rehashed.evidenceId], { evidenceType: 'metric', field: 'p95' }), { runId })).supported, true);

  // The numbers are rewritten to make a latency claim pass; the second attacker also fixes metadata_hash.
  await asAttacker(db, `UPDATE ht_evidence SET structured = '{"p95": 120}'::jsonb WHERE evidence_id = $1`, [edited.evidenceId]);
  const forged = computeMetadataHash({ ...rehashed, structured: { p95: 120 } });
  await asAttacker(db, `UPDATE ht_evidence SET structured = '{"p95": 120}'::jsonb, metadata_hash = $1 WHERE evidence_id = $2`, [forged, rehashed.evidenceId]);

  const res = await resolveClaim(ledger, claim([good.evidenceId, edited.evidenceId, rehashed.evidenceId], { evidenceType: 'metric', field: 'p95' }), { runId });
  assert.equal(res.supported, false);
  assert.deepEqual(res.problems, [
    `evidence ${edited.evidenceId} fails its integrity check (metadata hash mismatch)`,
    `evidence ${rehashed.evidenceId} fails its integrity check (record hash mismatch)`,
  ]);
});

test('resolveClaim: malformed claim ⇒ invalid_argument', async () => {
  await assert.rejects(resolveClaim(ledger, { claimId: 'c' } as unknown as ReportClaim), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});
