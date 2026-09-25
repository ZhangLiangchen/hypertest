import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { canonicalJson, isHypertestError, sha256Hex, type SqlDatabase } from '@hypertest/core';
import type { ArtifactRef, EvidenceRecord } from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';
import { testDeps } from '@hypertest/testkit';
import { EMPTY_ROOT, Ed25519Signer, MemoryArtifactStore, createEvidenceLedger, merkleRoot, type EvidenceLedger } from '../src/index.ts';
import { SqlEventSink, asAttacker, evidenceInput, migrations } from './helpers.ts';

let db: SqlDatabase;
let dispose: () => Promise<void>;
let artifacts: MemoryArtifactStore;
let sink: SqlEventSink;
let ledger: EvidenceLedger;
let n = 0;
const deps = testDeps();

async function artifact(content?: string): Promise<ArtifactRef> {
  return artifacts.put(content ?? `artifact #${++n}`, { mimeType: 'text/plain' });
}

before(async () => {
  ({ db, dispose } = await createTestDatabase({ migrations }));
  artifacts = new MemoryArtifactStore();
  sink = new SqlEventSink(db);
  ledger = createEvidenceLedger({ ...deps, db, artifacts, events: sink });
});
after(async () => {
  await dispose();
});

test('append: seq, previous-hash chain and the exact hash formulas', async () => {
  const runId = 'run_formula';
  const a1 = await artifact('first');
  const a2 = await artifact('second');
  const r1 = await ledger.append(evidenceInput(runId, a1));
  const r2 = await ledger.append(evidenceInput(runId, a2, { evidenceType: 'stdout', summary: 'second' }));

  assert.equal(r1.seq, 1);
  assert.equal(r2.seq, 2);
  assert.match(r1.evidenceId, /^ev_/);
  assert.equal(r1.previousRecordHash, undefined);
  assert.equal(r2.previousRecordHash, r1.recordHash);
  assert.equal(r1.capturedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(r1.classification, 'internal');
  assert.equal(r1.retentionPolicy, 'default');

  // Independent recomputation: metadata = every stored field except the three hashes.
  const metadata1 = {
    evidenceId: r1.evidenceId,
    runId,
    seq: 1,
    evidenceType: 'test-result',
    artifact: { uri: a1.uri, sha256: a1.sha256, size: a1.size, mimeType: 'text/plain' },
    summary: 'unit suite: 12 passed, 0 failed',
    parentEvidenceIds: [],
    classification: 'internal',
    retentionPolicy: 'default',
    producer: { workerId: 'worker-1', runtimeManifestId: 'rm_000001' },
    provenance: { toolId: 'test.run', command: ['node', '--test'] },
    capturedAt: '2026-01-01T00:00:00.000Z',
  };
  assert.equal(r1.metadataHash, sha256Hex(canonicalJson(metadata1)));
  assert.equal(r1.recordHash, sha256Hex(r1.metadataHash + a1.sha256));
  assert.equal(r2.recordHash, sha256Hex(r2.metadataHash + a2.sha256 + r1.recordHash));

  assert.deepEqual(await ledger.get(r1.evidenceId), r1, 'stored record round-trips exactly');
  assert.deepEqual(await ledger.get(r2.evidenceId), r2);
  assert.equal(await ledger.get('ev_unknown'), undefined);
});

test('append: optional fields round-trip byte-exactly (JSON null vs absent, environment, parents, numbers)', async () => {
  const runId = 'run_roundtrip';
  const parent = await ledger.append(evidenceInput(runId, await artifact()));
  const full = await ledger.append(
    evidenceInput(runId, await artifact(), {
      structured: { latencyMs: 12.5, big: 1e21, small: 1e-7, zero: -0, text: 'ü ✓ "quoted"', nested: { arr: [1, null, 'x'], t: true } },
      workItemId: 'wi_1',
      agentId: 'agent_exec',
      toolInvocationId: 'ti_1',
      operationId: 'op_1',
      environment: { environmentId: 'env_1', environmentClass: 'staging', generation: 3, buildDigest: 'sha256:abc' },
      parentEvidenceIds: [parent.evidenceId, parent.evidenceId],
      classification: 'confidential',
      retentionPolicy: 'release-7y',
      traceId: 'trace_1',
      producer: { workerId: 'worker-2', runtimeManifestId: 'rm_2', agentId: 'agent_exec', imageDigest: 'sha256:img' },
    }),
  );
  const nullStructured = await ledger.append(evidenceInput(runId, await artifact(), { structured: null }));
  const noStructured = await ledger.append(evidenceInput(runId, await artifact()));

  assert.deepEqual(full.parentEvidenceIds, [parent.evidenceId], 'duplicate parents are collapsed');
  assert.deepEqual(await ledger.get(full.evidenceId), full);
  const gotNull = await ledger.get(nullStructured.evidenceId);
  assert.ok(gotNull && 'structured' in gotNull && gotNull.structured === null, 'JSON null payload survives');
  const gotAbsent = await ledger.get(noStructured.evidenceId);
  assert.ok(gotAbsent && !('structured' in gotAbsent), 'absent payload stays absent');
  assert.notEqual(nullStructured.metadataHash, noStructured.metadataHash);

  const v = await ledger.verify(runId);
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  assert.equal(v.count, 4);
});

test('append: artifact missing from the store ⇒ integrity_violation, nothing written, no event', async () => {
  const runId = 'run_missing_artifact';
  await ledger.append(evidenceInput(runId, await artifact()));
  const ghost: ArtifactRef = { uri: `cas://sha256/${sha256Hex('ghost')}`, sha256: sha256Hex('ghost'), size: 5, mimeType: 'text/plain' };
  await assert.rejects(ledger.append(evidenceInput(runId, ghost)), (e: unknown) => isHypertestError(e, 'integrity_violation') && e.details['sha256'] === ghost.sha256);
  assert.equal(await ledger.count(runId), 1);
  assert.equal((await sink.rows(runId)).length, 1);
  const next = await ledger.append(evidenceInput(runId, await artifact()));
  assert.equal(next.seq, 2, 'failed append leaves no gap');
});

test('append: declared artifact size that differs from the stored object ⇒ integrity_violation', async () => {
  const a = await artifact('sized');
  await assert.rejects(ledger.append(evidenceInput('run_size', { ...a, size: a.size + 10 })), (e: unknown) => isHypertestError(e, 'integrity_violation'));
  assert.equal(await ledger.count('run_size'), 0);
});

test('append: stores that only implement exists() are still checked', async () => {
  const minimal = {
    kind: 'memory' as const,
    put: artifacts.put.bind(artifacts),
    putFile: artifacts.putFile.bind(artifacts),
    get: artifacts.get.bind(artifacts),
    getText: artifacts.getText.bind(artifacts),
    exists: artifacts.exists.bind(artifacts),
    verify: artifacts.verify.bind(artifacts),
  };
  const l = createEvidenceLedger({ ...deps, db, artifacts: minimal });
  const ok = await l.append(evidenceInput('run_minimal_store', await artifact()));
  assert.equal(ok.seq, 1);
  const ghost: ArtifactRef = { uri: `cas://sha256/${sha256Hex('ghost-2')}`, sha256: sha256Hex('ghost-2'), size: 1, mimeType: 'text/plain' };
  await assert.rejects(l.append(evidenceInput('run_minimal_store', ghost)), (e: unknown) => isHypertestError(e, 'integrity_violation'));
});

test('append: unknown parent evidence id ⇒ integrity_violation (no dangling lineage)', async () => {
  await assert.rejects(
    ledger.append(evidenceInput('run_parent', await artifact(), { parentEvidenceIds: ['ev_does_not_exist'] })),
    (e: unknown) => isHypertestError(e, 'integrity_violation') && (e.details['missing'] as string[])[0] === 'ev_does_not_exist',
  );
  assert.equal(await ledger.count('run_parent'), 0);
});

test('append: invalid input ⇒ invalid_argument', async () => {
  const a = await artifact();
  const bad = [
    evidenceInput('', a),
    evidenceInput('run_bad', { ...a, sha256: 'xyz' }),
    evidenceInput('run_bad', { ...a, size: -1 }),
    evidenceInput('run_bad', a, { evidenceType: '' }),
    evidenceInput('run_bad', a, { producer: { workerId: '', runtimeManifestId: 'rm' } }),
    evidenceInput('run_bad', a, { classification: 'top-secret' as never }),
    evidenceInput('run_bad', a, { summary: 'nul \u0000 byte' }),
    evidenceInput('run_bad', a, { structured: { k: 'nul \u0000' } }),
    evidenceInput('run_bad', a, { structured: { n: 10n } as never }),
  ];
  for (const input of bad) {
    await assert.rejects(ledger.append(input), (e: unknown) => isHypertestError(e, 'invalid_argument'), JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? 'bigint' : v)));
  }
  assert.equal(await ledger.count('run_bad'), 0);
});

test('append: lone UTF-16 surrogates are stored as U+FFFD — no false tamper alarm, the run stays sealable', async () => {
  const runId = 'run_surrogates';
  const signed = createEvidenceLedger({ ...deps, db, artifacts, signer: Ed25519Signer.generate() });
  const cut = '😀'.slice(0, 1); // an emoji truncated mid-pair, as naive output truncation produces
  const r = await signed.append(
    evidenceInput(runId, await artifact(), {
      summary: `stdout: ok ${cut}`,
      workItemId: `wi_${'\udc00'}`,
      structured: { line: `x${'\udfff'}y`, [`k${'\ud800'}`]: [cut], intact: 'emoji 😀 stays' },
      provenance: { toolId: 'shell.exec', command: ['echo', cut] },
    }),
  );
  assert.equal(r.summary, 'stdout: ok \ufffd');
  assert.equal(r.workItemId, 'wi_\ufffd');
  assert.deepEqual(r.structured, { line: 'x\ufffdy', 'k\ufffd': ['\ufffd'], intact: 'emoji 😀 stays' });
  assert.deepEqual(r.provenance.command, ['echo', '\ufffd']);
  assert.deepEqual(await signed.get(r.evidenceId), r, 'the returned record is exactly what was stored');
  const v = await signed.verify(runId);
  assert.deepEqual(v.problems, [], 'an untouched record must not verify as tampered');
  const seal = await signed.seal(runId);
  assert.equal(seal.count, 1);
});

test('append: payload keys that collide after surrogate normalization ⇒ invalid_argument', async () => {
  await assert.rejects(
    ledger.append(evidenceInput('run_key_collision', await artifact(), { structured: { 'a\ud800': 1, 'a\ufffd': 2 } })),
    (e: unknown) => isHypertestError(e, 'invalid_argument') && /collide/.test(e.message),
  );
  assert.equal(await ledger.count('run_key_collision'), 0);
});

test('append: a literal "__proto__" payload key stays an own member and round-trips', async () => {
  const structured = JSON.parse('{"__proto__": {"polluted": true}, "n": 1}') as Record<string, unknown>;
  const r = await ledger.append(evidenceInput('run_proto_key', await artifact(), { structured: structured as never }));
  assert.ok(Object.prototype.hasOwnProperty.call(r.structured, '__proto__'));
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'no prototype pollution');
  assert.deepEqual(await ledger.get(r.evidenceId), r);
  assert.deepEqual((await ledger.verify('run_proto_key')).problems, []);
});

test('append: classification must be an own classification name (inherited Object members are rejected)', async () => {
  const a = await artifact();
  for (const classification of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    await assert.rejects(
      ledger.append(evidenceInput('run_bad_classification', a, { classification: classification as never })),
      (e: unknown) => isHypertestError(e, 'invalid_argument') && /classification/.test(e.message),
      classification,
    );
  }
  assert.equal(await ledger.count('run_bad_classification'), 0);
  assert.equal((await ledger.append(evidenceInput('run_bad_classification', a, { classification: 'restricted' }))).classification, 'restricted');
});

test('append: artifact.uri must locate the declared digest', async () => {
  const runId = 'run_uri';
  const a = await artifact('uri target');
  const other = sha256Hex('some other content');
  await assert.rejects(
    ledger.append(evidenceInput(runId, { ...a, uri: `cas://sha256/${other}` })),
    (e: unknown) => isHypertestError(e, 'integrity_violation') && e.details['uriSha256'] === other,
  );
  await assert.rejects(ledger.append(evidenceInput(runId, { ...a, uri: `s3://bucket/p/sha256/${other}` })), (e: unknown) => isHypertestError(e, 'integrity_violation'));
  for (const uri of ['http://evil.example/x', 'file:///etc/passwd', `cas://sha256/${a.sha256}/../x`]) {
    await assert.rejects(ledger.append(evidenceInput(runId, { ...a, uri })), (e: unknown) => isHypertestError(e, 'invalid_argument'), uri);
  }
  await assert.rejects(ledger.append(evidenceInput(runId, { ...a, uri: 42 as never })), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  assert.equal(await ledger.count(runId), 0);

  const s3 = await ledger.append(evidenceInput(runId, { ...a, uri: `s3://evidence/ht/sha256/${a.sha256.toUpperCase()}` }));
  assert.equal(s3.artifact.uri, `s3://evidence/ht/sha256/${a.sha256.toUpperCase()}`, 'a uri naming the same digest is kept as given');
  const defaulted = await ledger.append(evidenceInput(runId, { ...a, uri: '' }));
  assert.equal(defaulted.artifact.uri, `cas://sha256/${a.sha256}`);
  assert.deepEqual((await ledger.verify(runId)).problems, []);
});

test('append: emits evidence.attached in the ledger transaction with the documented payload', async () => {
  const runId = 'run_event';
  const before = sink.txSeen.length;
  const r = await ledger.append(evidenceInput(runId, await artifact(), { traceId: 'trace_42', workItemId: 'wi_9', agentId: 'agent_a' }));
  assert.notEqual(sink.txSeen[before], undefined, 'the sink receives the transaction executor');
  const rows = await sink.rows(runId);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    event_type: 'evidence.attached',
    actor_id: 'agent_a',
    correlation_id: 'trace_42',
    work_item_id: 'wi_9',
    agent_id: 'agent_a',
    causation_id: null,
    payload: { evidenceId: r.evidenceId, evidenceType: 'test-result', seq: 1, summary: r.summary },
  });
  await ledger.append(evidenceInput(runId, await artifact()), undefined, { eventContext: { correlationId: 'corr_x', causationId: 'evt_cause', actorId: 'system:tools' } });
  const second = (await sink.rows(runId))[1]!;
  assert.equal(second.correlation_id, 'corr_x');
  assert.equal(second.causation_id, 'evt_cause');
  assert.equal(second.actor_id, 'system:tools');
});

test('append: an event sink failure rolls the evidence row back (atomic)', async () => {
  const runId = 'run_sink_fail';
  await ledger.append(evidenceInput(runId, await artifact()));
  sink.failNext = true;
  await assert.rejects(ledger.append(evidenceInput(runId, await artifact())), /sink failure/);
  assert.equal(await ledger.count(runId), 1);
  assert.equal((await ledger.append(evidenceInput(runId, await artifact()))).seq, 2);
  assert.equal((await ledger.verify(runId)).ok, true);
});

test('append: caller-supplied transaction — rollback discards both evidence and event; commit keeps both', async () => {
  const runId = 'run_caller_tx';
  await assert.rejects(
    db.transaction(async (tx) => {
      await ledger.append(evidenceInput(runId, await artifact()), tx);
      throw new Error('business step failed');
    }),
    /business step failed/,
  );
  assert.equal(await ledger.count(runId), 0);
  assert.equal((await sink.rows(runId)).length, 0);

  const r = await db.transaction(async (tx) => ledger.append(evidenceInput(runId, await artifact()), tx));
  assert.equal(r.seq, 1);
  assert.equal(await ledger.count(runId), 1);
  assert.equal((await sink.rows(runId)).length, 1);
});

function assertGapFreeChain(records: EvidenceRecord[], expected: number): void {
  const sorted = [...records].sort((x, y) => x.seq - y.seq);
  assert.deepEqual(
    sorted.map((r) => r.seq),
    Array.from({ length: expected }, (_, i) => i + 1),
  );
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i]!.previousRecordHash, sorted[i - 1]!.recordHash, `chain link at seq ${i + 1}`);
  assert.equal(new Set(sorted.map((r) => r.evidenceId)).size, expected);
}

test('I6: 25 concurrent appends to one run are gap-free and correctly chained', async () => {
  const runId = 'run_concurrent';
  const refs = await Promise.all(Array.from({ length: 25 }, (_, i) => artifact(`concurrent ${i}`)));
  const records = await Promise.all(refs.map((a, i) => ledger.append(evidenceInput(runId, a, { summary: `c${i}` }))));
  assertGapFreeChain(records, 25);
  assert.equal(await ledger.count(runId), 25);
  const v = await ledger.verify(runId);
  assert.deepEqual(v.problems, []);
  assert.equal(v.count, 25);
});

test('I6: concurrent appends across runs keep independent sequences', async () => {
  const jobs = [];
  for (let i = 0; i < 10; i++) for (const runId of ['run_multi_a', 'run_multi_b']) jobs.push(artifact(`${runId}-${i}`).then((a) => ledger.append(evidenceInput(runId, a))));
  const records = await Promise.all(jobs);
  assertGapFreeChain(records.filter((r) => r.runId === 'run_multi_a'), 10);
  assertGapFreeChain(records.filter((r) => r.runId === 'run_multi_b'), 10);
});

test('query / getMany / count', async () => {
  const runId = 'run_query';
  const r1 = await ledger.append(evidenceInput(runId, await artifact(), { workItemId: 'wi_a', agentId: 'agent_1', operationId: 'op_1' }));
  const r2 = await ledger.append(evidenceInput(runId, await artifact(), { evidenceType: 'metric', workItemId: 'wi_b', toolInvocationId: 'ti_2' }));
  const r3 = await ledger.append(evidenceInput(runId, await artifact(), { evidenceType: 'log', workItemId: 'wi_a', agentId: 'agent_2' }));
  await ledger.append(evidenceInput('run_query_other', await artifact(), { workItemId: 'wi_a' }));

  const ids = (rs: EvidenceRecord[]) => rs.map((r) => r.evidenceId);
  assert.deepEqual(ids(await ledger.query({ runId })), [r1.evidenceId, r2.evidenceId, r3.evidenceId]);
  assert.deepEqual(ids(await ledger.query({ runId, evidenceType: 'metric' })), [r2.evidenceId]);
  assert.deepEqual(ids(await ledger.query({ runId, evidenceType: ['log', 'test-result'] })), [r1.evidenceId, r3.evidenceId]);
  assert.deepEqual(ids(await ledger.query({ runId, evidenceType: [] })), []);
  assert.deepEqual(ids(await ledger.query({ runId, workItemId: 'wi_a' })), [r1.evidenceId, r3.evidenceId]);
  assert.deepEqual(ids(await ledger.query({ runId, agentId: 'agent_2' })), [r3.evidenceId]);
  assert.deepEqual(ids(await ledger.query({ runId, operationId: 'op_1' })), [r1.evidenceId]);
  assert.deepEqual(ids(await ledger.query({ runId, toolInvocationId: 'ti_2' })), [r2.evidenceId]);
  assert.deepEqual(ids(await ledger.query({ runId, afterSeq: 1 })), [r2.evidenceId, r3.evidenceId]);
  assert.deepEqual(ids(await ledger.query({ runId, afterSeq: 1, limit: 1 })), [r2.evidenceId]);
  await assert.rejects(ledger.query({ runId, limit: 0 }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  await assert.rejects(ledger.query({ runId: '' }), (e: unknown) => isHypertestError(e, 'invalid_argument'));

  assert.deepEqual(ids(await ledger.getMany([r3.evidenceId, 'ev_missing', r1.evidenceId, r3.evidenceId])), [r3.evidenceId, r1.evidenceId]);
  assert.deepEqual(await ledger.getMany([]), []);
  assert.equal(await ledger.count(runId), 3);
  assert.equal(await ledger.count('run_never_used'), 0);
});

test('rootHash: Merkle root over record hashes by seq, with an optional upper bound', async () => {
  const runId = 'run_root';
  const records: EvidenceRecord[] = [];
  for (let i = 0; i < 5; i++) records.push(await ledger.append(evidenceInput(runId, await artifact())));
  const hashes = records.map((r) => r.recordHash);
  assert.deepEqual(await ledger.rootHash(runId), { rootHash: merkleRoot(hashes), count: 5, lastSeq: 5 });
  assert.deepEqual(await ledger.rootHash(runId, 3), { rootHash: merkleRoot(hashes.slice(0, 3)), count: 3, lastSeq: 3 });
  assert.deepEqual(await ledger.rootHash(runId, 1), { rootHash: hashes[0], count: 1, lastSeq: 1 });
  assert.deepEqual(await ledger.rootHash('run_empty_root'), { rootHash: EMPTY_ROOT, count: 0, lastSeq: 0 });
  assert.equal((await ledger.verify(runId)).rootHash, merkleRoot(hashes));
});

test('I6: the database itself refuses UPDATE, DELETE and TRUNCATE of evidence and seals', async () => {
  const runId = 'run_db_append_only';
  const r = await ledger.append(evidenceInput(runId, await artifact()));
  await assert.rejects(db.query('UPDATE ht_evidence SET summary = $1 WHERE evidence_id = $2', ['rewritten', r.evidenceId]), /append-only/);
  await assert.rejects(db.query('DELETE FROM ht_evidence WHERE evidence_id = $1', [r.evidenceId]), /append-only/);
  await assert.rejects(db.query('TRUNCATE ht_evidence'), /append-only/);
  await db.query(`INSERT INTO ht_evidence_seals (seal_id, run_id, seal_no, root_hash, record_count, last_seq, key_id, algorithm, signature, sealed_at)
                  VALUES ('seal_x', $1, 1, 'r', 0, 0, 'k', 'ed25519', 's', now())`, [runId]);
  await assert.rejects(db.query(`UPDATE ht_evidence_seals SET signature = 'forged' WHERE seal_id = 'seal_x'`), /append-only/);
  await assert.rejects(db.query(`DELETE FROM ht_evidence_seals WHERE seal_id = 'seal_x'`), /append-only/);
  assert.deepEqual(await ledger.get(r.evidenceId), r);
  // The attacker helper really bypasses the triggers (so tamper tests exercise verify(), not the triggers).
  assert.equal(await asAttacker(db, `DELETE FROM ht_evidence_seals WHERE seal_id = 'seal_x'`), 1);
});

test('I6: the ledger exposes no update or delete API', () => {
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(ledger)).filter((m) => m !== 'constructor').sort();
  assert.deepEqual(methods, ['append', 'count', 'get', 'getMany', 'latestSeal', 'query', 'rootHash', 'seal', 'verify']);
});
