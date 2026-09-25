import { canonicalJson, sha256Hex } from '@hypertest/core';
import type { EvidenceRecord, EvidenceSeal } from '@hypertest/domain';
import type { ArtifactStore, EvidenceProblem, EvidenceVerification } from './contracts.ts';
import { isSha256Hex, merkleRootUnchecked } from './hash.ts';
import { verifyEd25519 } from './signer.ts';

/**
 * The hashed metadata of a record: every stored field except metadataHash, previousRecordHash and
 * recordHash. Absent optional fields are omitted (canonicalJson drops undefined members).
 */
export function evidenceMetadata(record: Omit<EvidenceRecord, 'metadataHash' | 'previousRecordHash' | 'recordHash'>): Record<string, unknown> {
  return {
    evidenceId: record.evidenceId,
    runId: record.runId,
    seq: record.seq,
    evidenceType: record.evidenceType,
    artifact: { uri: record.artifact.uri, sha256: record.artifact.sha256, size: record.artifact.size, mimeType: record.artifact.mimeType },
    summary: record.summary,
    structured: record.structured,
    workItemId: record.workItemId,
    agentId: record.agentId,
    toolInvocationId: record.toolInvocationId,
    operationId: record.operationId,
    environment: record.environment,
    parentEvidenceIds: record.parentEvidenceIds,
    classification: record.classification,
    retentionPolicy: record.retentionPolicy,
    producer: record.producer,
    provenance: record.provenance,
    traceId: record.traceId,
    capturedAt: record.capturedAt,
  };
}

/** metadataHash = sha256(canonicalJson(metadata)). */
export function computeMetadataHash(record: Omit<EvidenceRecord, 'metadataHash' | 'previousRecordHash' | 'recordHash'>): string {
  return sha256Hex(canonicalJson(evidenceMetadata(record)));
}

/** recordHash = sha256(metadataHash + artifactSha256 + (previousRecordHash ?? '')). */
export function computeRecordHash(metadataHash: string, artifactSha256: string, previousRecordHash?: string): string {
  return sha256Hex(metadataHash + artifactSha256 + (previousRecordHash ?? ''));
}

/** The exact bytes a seal signs: canonicalJson({runId, rootHash, count, lastSeq}). */
export function sealMessage(seal: Pick<EvidenceSeal, 'runId' | 'rootHash' | 'count' | 'lastSeq'>): string {
  return canonicalJson({ runId: seal.runId, rootHash: seal.rootHash, count: seal.count, lastSeq: seal.lastSeq });
}

export interface VerifyRecordsOptions {
  /** When given, every distinct artifact is re-hashed through the store. */
  artifacts?: ArtifactStore;
  /** Trusted seal keys keyId → SPKI PEM. A seal whose key is not trusted is a `seal_signature` problem. */
  publicKeys?: Record<string, string>;
}

/**
 * Pure (offline-capable) verifier over a run's records and seals: seq continuity, metadata hashes,
 * record hashes, the previous-hash chain, artifact bytes (optional) and every seal's root, count and
 * signature. Problems are reported precisely; nothing is repaired.
 */
export async function verifyEvidenceRecords(
  runId: string,
  records: readonly EvidenceRecord[],
  seals: readonly EvidenceSeal[] = [],
  options: VerifyRecordsOptions = {},
): Promise<EvidenceVerification> {
  const problems: EvidenceProblem[] = [];
  const sorted = [...records].sort((a, b) => a.seq - b.seq);

  let expectedSeq = 1;
  let previous: EvidenceRecord | undefined;
  for (const r of sorted) {
    if (r.runId !== runId) {
      problems.push({ kind: 'chain_break', evidenceId: r.evidenceId, seq: r.seq, detail: `record belongs to run ${r.runId}, not ${runId}` });
    }
    if (r.seq !== expectedSeq) {
      problems.push({ kind: 'seq_gap', evidenceId: r.evidenceId, seq: r.seq, detail: `expected seq ${expectedSeq}, found ${r.seq}` });
    }
    const metadataHash = computeMetadataHash(r);
    if (metadataHash !== r.metadataHash) {
      problems.push({ kind: 'metadata_hash', evidenceId: r.evidenceId, seq: r.seq, detail: `stored metadataHash ${r.metadataHash} but metadata hashes to ${metadataHash}` });
    }
    const expectedPrevious = previous?.recordHash;
    if (r.previousRecordHash !== expectedPrevious) {
      problems.push({
        kind: 'chain_break',
        evidenceId: r.evidenceId,
        seq: r.seq,
        detail: previous
          ? `previousRecordHash ${r.previousRecordHash ?? '<none>'} does not match recordHash ${expectedPrevious} of seq ${previous.seq}`
          : `first record has previousRecordHash ${r.previousRecordHash ?? '<none>'}; expected none`,
      });
    }
    const recordHash = computeRecordHash(r.metadataHash, r.artifact.sha256, r.previousRecordHash);
    if (recordHash !== r.recordHash) {
      problems.push({ kind: 'record_hash', evidenceId: r.evidenceId, seq: r.seq, detail: `stored recordHash ${r.recordHash} but recomputes to ${recordHash}` });
    }
    previous = r;
    expectedSeq = r.seq + 1;
  }

  let artifactsChecked = 0;
  if (options.artifacts) {
    const results = new Map<string, 'ok' | 'missing' | 'modified'>();
    for (const r of sorted) {
      // A stored digest that is not even a sha256 hex string was tampered with: report it (the store
      // would reject it as an invalid locator and abort the whole verification).
      if (!isSha256Hex(r.artifact.sha256)) {
        problems.push({ kind: 'artifact_hash', evidenceId: r.evidenceId, seq: r.seq, detail: `artifact digest ${JSON.stringify(String(r.artifact.sha256).slice(0, 80))} is not a sha256 hex digest` });
        continue;
      }
      const key = `${r.artifact.sha256}:${r.artifact.size}`;
      let status = results.get(key);
      if (status === undefined) {
        artifactsChecked++;
        if (await options.artifacts.verify(r.artifact)) status = 'ok';
        else status = (await options.artifacts.exists(r.artifact.sha256)) ? 'modified' : 'missing';
        results.set(key, status);
      }
      if (status === 'missing') {
        problems.push({ kind: 'artifact_missing', evidenceId: r.evidenceId, seq: r.seq, detail: `artifact sha256:${r.artifact.sha256} is missing from the ${options.artifacts.kind} store` });
      } else if (status === 'modified') {
        problems.push({ kind: 'artifact_hash', evidenceId: r.evidenceId, seq: r.seq, detail: `artifact sha256:${r.artifact.sha256} (${r.artifact.size} bytes) no longer matches its stored bytes` });
      }
    }
  }

  const trusted = options.publicKeys ?? {};
  for (const seal of seals) {
    const covered = sorted.filter((r) => r.seq <= seal.lastSeq);
    const root = merkleRootUnchecked(covered.map((r) => r.recordHash));
    if (seal.runId !== runId) {
      problems.push({ kind: 'seal_root', seq: seal.lastSeq, detail: `seal belongs to run ${seal.runId}, not ${runId}` });
    }
    if (covered.length !== seal.count || (covered.length > 0 ? covered[covered.length - 1]!.seq : 0) !== seal.lastSeq || root !== seal.rootHash) {
      problems.push({
        kind: 'seal_root',
        seq: seal.lastSeq,
        detail: `seal (${seal.sealedAt}) covers ${seal.count} records up to seq ${seal.lastSeq} with root ${seal.rootHash}; ledger has ${covered.length} records up to that seq with root ${root}`,
      });
    }
    const pem = trusted[seal.keyId];
    if (seal.algorithm !== 'ed25519') {
      problems.push({ kind: 'seal_signature', seq: seal.lastSeq, detail: `unsupported seal algorithm ${String(seal.algorithm)}` });
    } else if (pem === undefined) {
      problems.push({ kind: 'seal_signature', seq: seal.lastSeq, detail: `seal key ${seal.keyId} is not a trusted key; signature cannot be accepted` });
    } else if (!verifyEd25519(pem, sealMessage(seal), seal.signature)) {
      problems.push({ kind: 'seal_signature', seq: seal.lastSeq, detail: `seal signature by ${seal.keyId} does not verify` });
    }
  }

  return {
    ok: problems.length === 0,
    runId,
    count: sorted.length,
    rootHash: merkleRootUnchecked(sorted.map((r) => r.recordHash)),
    problems,
    sealsChecked: seals.length,
    artifactsChecked,
  };
}
