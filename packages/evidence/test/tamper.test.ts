import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isHypertestError, type SqlDatabase } from '@hypertest/core';
import { InMemoryEventSink, type EvidenceRecord } from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';
import { tempDir, testDeps } from '@hypertest/testkit';
import {
  EMPTY_ROOT,
  Ed25519Signer,
  FsArtifactStore,
  computeMetadataHash,
  computeRecordHash,
  createEvidenceLedger,
  sealMessage,
  verifyEd25519,
  verifyEvidenceRecords,
  type EvidenceLedger,
  type EvidenceProblem,
} from '../src/index.ts';
import { asAttacker, evidenceInput, migrations } from './helpers.ts';

let db: SqlDatabase;
let dispose: () => Promise<void>;
let dir: { path: string; cleanup(): Promise<void> };
let artifacts: FsArtifactStore;
let ledger: EvidenceLedger;
let unsignedLedger: EvidenceLedger;
const signer = Ed25519Signer.generate();
const attackerKey = Ed25519Signer.generate();
const deps = testDeps();
const events = new InMemoryEventSink();

before(async () => {
  ({ db, dispose } = await createTestDatabase({ migrations }));
  dir = await tempDir('ht-evidence-tamper-');
  artifacts = new FsArtifactStore(join(dir.path, 'cas'), { fsync: false });
  ledger = createEvidenceLedger({ ...deps, db, artifacts, signer, events });
  unsignedLedger = createEvidenceLedger({ ...deps, db, artifacts });
});
after(async () => {
  await dispose();
  await dir.cleanup();
});

async function seedRun(runId: string, count: number): Promise<EvidenceRecord[]> {
  const out: EvidenceRecord[] = [];
  for (let i = 1; i <= count; i++) {
    const a = await artifacts.put(`${runId} evidence ${i}`, { mimeType: 'text/plain' });
    out.push(await ledger.append(evidenceInput(runId, a, { summary: `${runId} #${i}`, structured: { i } })));
  }
  return out;
}

function kinds(problems: EvidenceProblem[]): Array<[string, number | undefined, string | undefined]> {
  return problems.map((p) => [p.kind, p.seq, p.evidenceId]);
}

test('baseline: an untouched, sealed run verifies clean (chain, artifacts, seal)', async () => {
  const runId = 'run_baseline';
  await seedRun(runId, 5);
  const seal = await ledger.seal(runId);
  const v = await ledger.verify(runId);
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  assert.equal(v.count, 5);
  assert.equal(v.sealsChecked, 1);
  assert.equal(v.artifactsChecked, 5);
  assert.equal(v.rootHash, seal.rootHash);
});

test('I6: SQL UPDATE of a record field ⇒ metadata_hash problem on exactly that record', async () => {
  const runId = 'run_tamper_update';
  const recs = await seedRun(runId, 4);
  assert.equal(await asAttacker(db, 'UPDATE ht_evidence SET summary = $1 WHERE evidence_id = $2', ['all green (rewritten)', recs[1]!.evidenceId]), 1);
  const v = await ledger.verify(runId);
  assert.equal(v.ok, false);
  assert.deepEqual(kinds(v.problems), [['metadata_hash', 2, recs[1]!.evidenceId]]);
});

test('I6: tampering a jsonb payload (structured result) is detected too', async () => {
  const runId = 'run_tamper_jsonb';
  const recs = await seedRun(runId, 3);
  await asAttacker(db, `UPDATE ht_evidence SET structured = '{"i": 99}'::jsonb WHERE evidence_id = $1`, [recs[2]!.evidenceId]);
  assert.deepEqual(kinds((await ledger.verify(runId)).problems), [['metadata_hash', 3, recs[2]!.evidenceId]]);
});

test('I6: attacker who also recomputes metadata_hash ⇒ record_hash problem', async () => {
  const runId = 'run_tamper_metadata';
  const recs = await seedRun(runId, 3);
  const target = recs[1]!;
  const forgedMetadataHash = computeMetadataHash({ ...target, summary: 'forged' });
  await asAttacker(db, 'UPDATE ht_evidence SET summary = $1, metadata_hash = $2 WHERE evidence_id = $3', ['forged', forgedMetadataHash, target.evidenceId]);
  const v = await ledger.verify(runId);
  assert.deepEqual(kinds(v.problems), [['record_hash', 2, target.evidenceId]]);
});

test('I6: attacker who rewrites the whole chain consistently is caught by the seal', async () => {
  const sealedRun = 'run_rewrite_sealed';
  const unsealedRun = 'run_rewrite_unsealed';
  for (const runId of [sealedRun, unsealedRun]) {
    const recs = await seedRun(runId, 4);
    if (runId === sealedRun) await ledger.seal(runId);
    // Rewrite record 2 and re-link every following record so all hashes are self-consistent.
    let previous = recs[0]!.recordHash;
    for (const r of recs.slice(1)) {
      const summary = r.seq === 2 ? 'forged but consistent' : r.summary;
      const metadataHash = computeMetadataHash({ ...r, summary });
      const recordHash = computeRecordHash(metadataHash, r.artifact.sha256, previous);
      await asAttacker(db, 'UPDATE ht_evidence SET summary = $1, metadata_hash = $2, previous_record_hash = $3, record_hash = $4 WHERE evidence_id = $5', [
        summary,
        metadataHash,
        previous,
        recordHash,
        r.evidenceId,
      ]);
      previous = recordHash;
    }
  }
  const sealed = await ledger.verify(sealedRun);
  assert.deepEqual(kinds(sealed.problems), [['seal_root', 4, undefined]]);
  // Documented limit: without a seal (or an externally anchored root) a full, consistent rewrite by
  // someone who controls the database cannot be detected from the database alone.
  assert.deepEqual((await ledger.verify(unsealedRun)).problems, []);
});

test('I6: deleting a middle record ⇒ seq_gap + chain_break at the next record', async () => {
  const runId = 'run_tamper_delete';
  const recs = await seedRun(runId, 5);
  assert.equal(await asAttacker(db, 'DELETE FROM ht_evidence WHERE evidence_id = $1', [recs[2]!.evidenceId]), 1);
  const v = await ledger.verify(runId);
  assert.deepEqual(kinds(v.problems), [
    ['seq_gap', 4, recs[3]!.evidenceId],
    ['chain_break', 4, recs[3]!.evidenceId],
  ]);
  assert.equal(v.count, 4);
});

test('I6: deleting the first record ⇒ seq_gap + chain_break on the new first record', async () => {
  const runId = 'run_tamper_delete_first';
  const recs = await seedRun(runId, 3);
  await asAttacker(db, 'DELETE FROM ht_evidence WHERE evidence_id = $1', [recs[0]!.evidenceId]);
  assert.deepEqual(kinds((await ledger.verify(runId)).problems), [
    ['seq_gap', 2, recs[1]!.evidenceId],
    ['chain_break', 2, recs[1]!.evidenceId],
  ]);
});

test('I6: renumbering seq to hide a deletion ⇒ metadata_hash + chain_break', async () => {
  const runId = 'run_tamper_renumber';
  const recs = await seedRun(runId, 4);
  await asAttacker(db, 'DELETE FROM ht_evidence WHERE evidence_id = $1', [recs[1]!.evidenceId]);
  await asAttacker(db, 'UPDATE ht_evidence SET seq = seq - 1 WHERE run_id = $1 AND seq > 2', [runId]);
  const v = await ledger.verify(runId);
  assert.deepEqual(kinds(v.problems), [
    ['metadata_hash', 2, recs[2]!.evidenceId],
    ['chain_break', 2, recs[2]!.evidenceId],
    ['metadata_hash', 3, recs[3]!.evidenceId],
  ]);
});

test('I6: deleting the tail after a seal ⇒ seal_root (the seal pins count and lastSeq)', async () => {
  const runId = 'run_tamper_tail';
  const recs = await seedRun(runId, 4);
  await ledger.seal(runId);
  await asAttacker(db, 'DELETE FROM ht_evidence WHERE evidence_id = $1', [recs[3]!.evidenceId]);
  const v = await ledger.verify(runId);
  assert.deepEqual(kinds(v.problems), [['seal_root', 4, undefined]]);
});

test('I6: artifact bytes modified on disk ⇒ artifact_hash; removed ⇒ artifact_missing', async () => {
  const runId = 'run_tamper_bytes';
  const recs = await seedRun(runId, 3);
  const modified = artifacts.pathFor(recs[0]!.artifact.sha256);
  await chmod(modified, 0o644);
  await writeFile(modified, 'forged test output: all passed');
  await rm(artifacts.pathFor(recs[2]!.artifact.sha256), { force: true });

  const v = await ledger.verify(runId);
  assert.deepEqual(kinds(v.problems), [
    ['artifact_hash', 1, recs[0]!.evidenceId],
    ['artifact_missing', 3, recs[2]!.evidenceId],
  ]);
  assert.equal(v.artifactsChecked, 3);
  const metadataOnly = await ledger.verify(runId, { checkArtifacts: false });
  assert.deepEqual(metadataOnly.problems, [], 'metadata-only verification skips artifact bytes');
  assert.equal(metadataOnly.artifactsChecked, 0);
});

test('I6: artifact digest rewritten to a non-digest ⇒ reported as problems, verify() does not abort', async () => {
  const runId = 'run_tamper_digest';
  const recs = await seedRun(runId, 3);
  await asAttacker(db, 'UPDATE ht_evidence SET artifact_sha256 = $1 WHERE evidence_id = $2', ['../../etc/passwd', recs[1]!.evidenceId]);
  const v = await ledger.verify(runId);
  assert.equal(v.ok, false);
  assert.deepEqual(kinds(v.problems), [
    ['metadata_hash', 2, recs[1]!.evidenceId],
    ['record_hash', 2, recs[1]!.evidenceId],
    ['artifact_hash', 2, recs[1]!.evidenceId],
  ]);
  assert.equal(v.artifactsChecked, 2, 'the two intact artifacts are still re-hashed');
});

test('I6: an artifact object replaced by a directory ⇒ artifact_missing (verify does not abort)', async () => {
  const runId = 'run_tamper_dir';
  const recs = await seedRun(runId, 2);
  const path = artifacts.pathFor(recs[0]!.artifact.sha256);
  await rm(path, { force: true });
  await mkdir(path);
  assert.deepEqual(kinds((await ledger.verify(runId)).problems), [['artifact_missing', 1, recs[0]!.evidenceId]]);
});

test('I6: forged seal signature ⇒ seal_signature', async () => {
  const runId = 'run_tamper_seal_sig';
  await seedRun(runId, 2);
  const seal = await ledger.seal(runId);
  const forged = await attackerKey.sign(sealMessage(seal));
  await asAttacker(db, 'UPDATE ht_evidence_seals SET signature = $1 WHERE run_id = $2', [forged, runId]);
  const v = await ledger.verify(runId);
  assert.deepEqual(kinds(v.problems), [['seal_signature', 2, undefined]]);
  assert.match(v.problems[0]!.detail, /does not verify/);
});

test('I6: a seal appended by an attacker with their own key is not trusted', async () => {
  const runId = 'run_tamper_seal_key';
  await seedRun(runId, 2);
  const { rootHash, count, lastSeq } = await ledger.rootHash(runId);
  const signature = await attackerKey.sign(sealMessage({ runId, rootHash, count, lastSeq }));
  // INSERT is permitted by the append-only triggers: no bypass needed.
  await db.query(
    `INSERT INTO ht_evidence_seals (seal_id, run_id, seal_no, root_hash, record_count, last_seq, key_id, algorithm, signature, sealed_at)
     VALUES ('seal_attacker', $1, 1, $2, $3, $4, $5, 'ed25519', $6, now())`,
    [runId, rootHash, count, lastSeq, attackerKey.keyId, signature],
  );
  const v = await ledger.verify(runId);
  assert.deepEqual(kinds(v.problems), [['seal_signature', 2, undefined]]);
  assert.match(v.problems[0]!.detail, /not a trusted key/);
  // Only an explicit decision to trust the attacker's key would accept it.
  assert.equal((await ledger.verify(runId, { publicKeys: { [attackerKey.keyId]: attackerKey.publicKeyPem() } })).ok, true);
});

test('I6: tampered seal root ⇒ seal_root and seal_signature', async () => {
  const runId = 'run_tamper_seal_root';
  await seedRun(runId, 3);
  await ledger.seal(runId);
  await asAttacker(db, 'UPDATE ht_evidence_seals SET root_hash = $1 WHERE run_id = $2', [EMPTY_ROOT, runId]);
  assert.deepEqual(kinds((await ledger.verify(runId)).problems), [
    ['seal_root', 3, undefined],
    ['seal_signature', 3, undefined],
  ]);
});

test('verify: explicit publicKeys replace the default trust (a verifier without the signer)', async () => {
  const runId = 'run_public_keys';
  await seedRun(runId, 2);
  await ledger.seal(runId);
  const untrusted = await unsignedLedger.verify(runId);
  assert.deepEqual(kinds(untrusted.problems), [['seal_signature', 2, undefined]], 'no trusted key ⇒ fail closed');
  assert.equal((await unsignedLedger.verify(runId, { publicKeys: { [signer.keyId]: signer.publicKeyPem() } })).ok, true);
  const wrong = await unsignedLedger.verify(runId, { publicKeys: { [signer.keyId]: attackerKey.publicKeyPem() } });
  assert.deepEqual(kinds(wrong.problems), [['seal_signature', 2, undefined]]);
});

test('seal: requires a signer', async () => {
  await assert.rejects(unsignedLedger.seal('run_no_signer'), (e: unknown) => isHypertestError(e, 'precondition_failed'));
});

test('seal: refuses to certify a chain that already fails verification', async () => {
  const runId = 'run_seal_refuse';
  const recs = await seedRun(runId, 3);
  await asAttacker(db, 'UPDATE ht_evidence SET summary = $1 WHERE evidence_id = $2', ['x', recs[0]!.evidenceId]);
  await assert.rejects(ledger.seal(runId), (e: unknown) => isHypertestError(e, 'integrity_violation') && Array.isArray(e.details['problems']));
  assert.equal(await ledger.latestSeal(runId), undefined);
});

test('seal: a forged seal row claiming the signer\'s key id is never returned; a genuine seal supersedes it', async () => {
  const runId = 'run_seal_forged_row';
  await seedRun(runId, 2);
  const { rootHash, count, lastSeq } = await ledger.rootHash(runId);
  // Plain INSERT (allowed by the append-only triggers): same root/count/lastSeq and our key id,
  // but signed by the attacker.
  const forgedSignature = await attackerKey.sign(sealMessage({ runId, rootHash, count, lastSeq }));
  await db.query(
    `INSERT INTO ht_evidence_seals (seal_id, run_id, seal_no, root_hash, record_count, last_seq, key_id, algorithm, signature, sealed_at)
     VALUES ('seal_forged_row', $1, 1, $2, $3, $4, $5, 'ed25519', $6, now())`,
    [runId, rootHash, count, lastSeq, signer.keyId, forgedSignature],
  );
  const seal = await ledger.seal(runId);
  assert.notEqual(seal.signature, forgedSignature, 'the idempotent path must not hand out the forged seal');
  assert.equal(verifyEd25519(signer.publicKeyPem(), sealMessage(seal), seal.signature), true);
  assert.deepEqual(await ledger.latestSeal(runId), seal, 'the genuine seal is now the latest');
  assert.deepEqual(await ledger.seal(runId), seal, 'and is itself idempotent');
  const v = await ledger.verify(runId);
  assert.deepEqual(kinds(v.problems), [['seal_signature', 2, undefined]], 'the forged row stays visible');
  assert.equal(v.sealsChecked, 2);
});

test('seal: refuses to re-certify a chain truncated behind the triggers (earlier seal contradicted)', async () => {
  const runId = 'run_seal_truncated';
  const recs = await seedRun(runId, 4);
  const original = await ledger.seal(runId);
  await asAttacker(db, 'DELETE FROM ht_evidence WHERE evidence_id = $1', [recs[3]!.evidenceId]);
  await assert.rejects(
    ledger.seal(runId),
    (e: unknown) => isHypertestError(e, 'integrity_violation') && /earlier seal/.test(e.message) && (e.details['problems'] as EvidenceProblem[])[0]!.kind === 'seal_root',
  );
  assert.deepEqual(await ledger.latestSeal(runId), original, 'no seal legitimizes the truncation');
  assert.deepEqual(kinds((await ledger.verify(runId)).problems), [['seal_root', 4, undefined]]);
});

test('seal: seals by other keys do not block sealing (no denial of service by INSERTing a bogus seal)', async () => {
  const runId = 'run_seal_bogus_other_key';
  await seedRun(runId, 2);
  await db.query(
    `INSERT INTO ht_evidence_seals (seal_id, run_id, seal_no, root_hash, record_count, last_seq, key_id, algorithm, signature, sealed_at)
     VALUES ('seal_bogus', $1, 1, $2, 99, 99, $3, 'ed25519', 'AAAA', now())`,
    [runId, EMPTY_ROOT, attackerKey.keyId],
  );
  const seal = await ledger.seal(runId);
  assert.equal(seal.count, 2);
  assert.deepEqual(kinds((await ledger.verify(runId)).problems), [
    ['seal_root', 99, undefined],
    ['seal_signature', 99, undefined],
  ]);
});

test('seal: signs canonical {runId, rootHash, count, lastSeq}; idempotent; new evidence ⇒ new seal; emits evidence.sealed', async () => {
  const runId = 'run_seal_lifecycle';
  await seedRun(runId, 3);
  const s1 = await ledger.seal(runId);
  const root = await ledger.rootHash(runId);
  assert.deepEqual({ runId: s1.runId, rootHash: s1.rootHash, count: s1.count, lastSeq: s1.lastSeq, keyId: s1.keyId, algorithm: s1.algorithm }, {
    runId,
    rootHash: root.rootHash,
    count: 3,
    lastSeq: 3,
    keyId: signer.keyId,
    algorithm: 'ed25519',
  });
  assert.equal(sealMessage(s1), JSON.stringify({ count: 3, lastSeq: 3, rootHash: root.rootHash, runId }));
  deps.clock.advance(1000);
  assert.deepEqual(await ledger.seal(runId), s1, 'nothing new ⇒ the existing seal is returned');
  assert.deepEqual(await ledger.latestSeal(runId), s1);

  const a = await artifacts.put('late evidence', { mimeType: 'text/plain' });
  await ledger.append(evidenceInput(runId, a));
  const s2 = await ledger.seal(runId);
  assert.equal(s2.count, 4);
  assert.equal(s2.lastSeq, 4);
  assert.notEqual(s2.rootHash, s1.rootHash);
  assert.deepEqual(await ledger.latestSeal(runId), s2);
  const v = await ledger.verify(runId);
  assert.deepEqual(v.problems, []);
  assert.equal(v.sealsChecked, 2, 'every seal is re-checked, not only the latest');

  const sealedEvents = events.ofType('evidence.sealed').filter((e) => e.runId === runId);
  assert.equal(sealedEvents.length, 2);
  assert.deepEqual((sealedEvents[1]!.payload as { count: number; lastSeq: number; rootHash: string }).rootHash, s2.rootHash);
  assert.equal(sealedEvents[0]!.actorId, `signer:${signer.keyId}`);
});

test('seal: an empty run can be sealed (attests "no evidence") and verifies', async () => {
  const s = await ledger.seal('run_seal_empty');
  assert.equal(s.rootHash, EMPTY_ROOT);
  assert.equal(s.count, 0);
  assert.equal(s.lastSeq, 0);
  assert.equal((await ledger.verify('run_seal_empty')).ok, true);
});

test('verifyEvidenceRecords: offline verification of exported records and seals', async () => {
  const runId = 'run_offline';
  await seedRun(runId, 3);
  const seal = await ledger.seal(runId);
  const exported = await ledger.query({ runId });
  const keys = { [signer.keyId]: signer.publicKeyPem() };
  const clean = await verifyEvidenceRecords(runId, [...exported].reverse(), [seal], { publicKeys: keys, artifacts });
  assert.deepEqual(clean.problems, []);
  const tampered = exported.map((r) => (r.seq === 3 ? { ...r, summary: 'edited in the export' } : r));
  assert.deepEqual(kinds((await verifyEvidenceRecords(runId, tampered, [seal], { publicKeys: keys })).problems), [['metadata_hash', 3, exported[2]!.evidenceId]]);
  const foreign = await verifyEvidenceRecords('run_other', exported, [], {});
  assert.deepEqual(foreign.problems.map((p) => p.kind), ['chain_break', 'chain_break', 'chain_break']);
});
