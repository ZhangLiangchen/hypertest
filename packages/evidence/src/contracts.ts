import type { BaseDeps, SqlDatabase, SqlExecutor } from '@hypertest/core';
import type { ArtifactRef, DataClassification, DomainEventSink, EvidenceInput, EvidenceRecord, EvidenceSeal, ReportClaim } from '@hypertest/domain';

/**
 * @hypertest/evidence — content-addressed artifacts + tamper-evident evidence ledger (I6).
 *
 * Implementations to export from src/index.ts:
 *   class FsArtifactStore implements ArtifactStore           (root dir; files at <root>/sha256/<ab>/<hex>)
 *   class MemoryArtifactStore implements ArtifactStore
 *   class S3ArtifactStore implements ArtifactStore           (@aws-sdk/client-s3; endpoint/bucket/prefix; forcePathStyle for MinIO;
 *                                                             Object Lock retention header when `objectLockDays` set)
 *   createEvidenceLedger(deps: EvidenceLedgerDeps): EvidenceLedger
 *   class Ed25519Signer implements Signer                    (fromSeed/generate/fromPem; keyId = sha256(pubkey) prefix)
 *   verifyEd25519(publicKeyPem, data, signatureBase64): boolean
 *   merkleRoot(leafHashes: string[]): string                 (sha256 pairwise, duplicate last on odd; empty ⇒ sha256(''))
 *   recordEvidence(ledger, artifacts, input: RecordEvidenceInput): Promise<EvidenceRecord>   (put + append)
 *   resolveClaim(ledger, claim): Promise<ClaimResolution>
 *   evidenceMigrations: Migration[]                          (tables ht_evidence, ht_evidence_seals)
 *
 * Ledger rules:
 *  - append() serializes per run (pg_advisory_xact_lock(hashtext(runId))) to assign seq = last+1 and
 *    chain previousRecordHash; metadataHash = sha256(canonicalJson(metadata without hashes));
 *    recordHash = sha256(metadataHash + artifact.sha256 + (previousRecordHash ?? '')).
 *  - append() verifies the artifact exists in the ArtifactStore (integrity_violation otherwise) and
 *    emits `evidence.attached` via the sink in the same transaction when a tx is supplied.
 *  - There is no update/delete API. verify() detects chain breaks, metadata tampering (recompute),
 *    artifact byte tampering (re-hash) and bad seal signatures.
 */
export interface ArtifactPutOptions {
  mimeType: string;
  classification?: DataClassification;
}

export interface ArtifactStore {
  readonly kind: 'fs' | 's3' | 'memory';
  put(data: Uint8Array | string, options: ArtifactPutOptions): Promise<ArtifactRef>;
  /** Streams a local file into the store. */
  putFile(path: string, options: ArtifactPutOptions): Promise<ArtifactRef>;
  /** Accepts an ArtifactRef, a uri, or a sha256 hex digest. Throws not_found. */
  get(ref: ArtifactRef | string): Promise<Uint8Array>;
  getText(ref: ArtifactRef | string, maxBytes?: number): Promise<string>;
  exists(sha256: string): Promise<boolean>;
  /** Re-hashes stored bytes; false when missing or modified. */
  verify(ref: ArtifactRef): Promise<boolean>;
}

export interface EvidenceQuery {
  runId: string;
  evidenceType?: string | string[];
  workItemId?: string;
  agentId?: string;
  operationId?: string;
  toolInvocationId?: string;
  afterSeq?: number;
  limit?: number;
}

export interface EvidenceProblem {
  kind: 'chain_break' | 'metadata_hash' | 'record_hash' | 'artifact_missing' | 'artifact_hash' | 'seal_signature' | 'seal_root' | 'seq_gap';
  evidenceId?: string;
  seq?: number;
  detail: string;
}

export interface EvidenceVerification {
  ok: boolean;
  runId: string;
  count: number;
  rootHash: string;
  problems: EvidenceProblem[];
}

export interface Signer {
  readonly keyId: string;
  readonly algorithm: 'ed25519';
  sign(data: string | Uint8Array): Promise<string>;
  publicKeyPem(): string;
}

export interface EvidenceLedgerDeps extends BaseDeps {
  db: SqlDatabase;
  artifacts: ArtifactStore;
  events?: DomainEventSink;
  signer?: Signer;
}

export interface EvidenceLedger {
  append(input: EvidenceInput, tx?: SqlExecutor): Promise<EvidenceRecord>;
  get(evidenceId: string): Promise<EvidenceRecord | undefined>;
  getMany(evidenceIds: readonly string[]): Promise<EvidenceRecord[]>;
  query(query: EvidenceQuery): Promise<EvidenceRecord[]>;
  count(runId: string): Promise<number>;
  rootHash(runId: string, uptoSeq?: number): Promise<{ rootHash: string; count: number; lastSeq: number }>;
  verify(runId: string, options?: { checkArtifacts?: boolean; publicKeys?: Record<string, string> }): Promise<EvidenceVerification>;
  /** Signs the current Merkle root (requires a signer). */
  seal(runId: string): Promise<EvidenceSeal>;
  latestSeal(runId: string): Promise<EvidenceSeal | undefined>;
}

export interface RecordEvidenceInput extends Omit<EvidenceInput, 'artifact'> {
  data: Uint8Array | string;
  mimeType: string;
}

export interface ClaimResolution {
  claim: ReportClaim;
  supported: boolean;
  evidence: EvidenceRecord[];
  problems: string[];
}
