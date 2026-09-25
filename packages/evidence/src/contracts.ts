import type { BaseDeps, Clock, SqlDatabase, SqlExecutor } from '@hypertest/core';
import type { ArtifactRef, DataClassification, DomainEventSink, EventContext, EvidenceInput, EvidenceRecord, EvidenceSeal, ReportClaim } from '@hypertest/domain';

/**
 * @hypertest/evidence — content-addressed artifacts + tamper-evident evidence ledger (I6).
 *
 * Implementations to export from src/index.ts:
 *   class FsArtifactStore implements ArtifactStore           (root dir; files at <root>/sha256/<ab>/<hex>)
 *   class MemoryArtifactStore implements ArtifactStore
 *   class S3ArtifactStore implements ArtifactStore           (@aws-sdk/client-s3; endpoint/bucket/prefix; forcePathStyle for MinIO;
 *                                                             Object Lock retention header when `objectLockDays` set;
 *                                                             (additive) destroy() releases a client the store created)
 *   createEvidenceLedger(deps: EvidenceLedgerDeps): EvidenceLedger
 *   class Ed25519Signer implements Signer                    (fromSeed/generate/fromPem; keyId = sha256(pubkey) prefix)
 *   verifyEd25519(publicKeyPem, data, signatureBase64): boolean
 *   merkleRoot(leafHashes: string[]): string                 (sha256 pairwise, duplicate last on odd; empty ⇒ sha256(''))
 *   recordEvidence(ledger, artifacts, input: RecordEvidenceInput, tx?, options?): Promise<EvidenceRecord>   (put + append)
 *   resolveClaim(ledger, claim, options?: ResolveClaimOptions): Promise<ClaimResolution>
 *   evidenceMigrations: Migration[]                          (tables ht_evidence, ht_evidence_seals)
 *
 * Ledger rules:
 *  - append() serializes per run (pg_advisory_xact_lock(hashtext(runId))) to assign seq = last+1 and
 *    chain previousRecordHash; metadataHash = sha256(canonicalJson(metadata without hashes));
 *    recordHash = sha256(metadataHash + artifact.sha256 + (previousRecordHash ?? '')).
 *  - append() verifies the artifact exists in the ArtifactStore (integrity_violation otherwise) and
 *    emits `evidence.attached` via the sink in the same transaction when a tx is supplied.
 *    A non-empty artifact.uri must locate the declared digest (integrity_violation when it names
 *    another digest, invalid_argument when it is not a cas:// or s3:// content address). Strings
 *    (text fields and JSON payloads) are stored as they will be read back: lone UTF-16 surrogates
 *    become U+FFFD, NUL is rejected — so an untouched record always re-verifies.
 *  - There is no update/delete API. verify() detects chain breaks, metadata tampering (recompute),
 *    artifact byte tampering (re-hash) and bad seal signatures.
 *
 * Additive helpers also exported: ed25519KeyId, sealMessage, evidenceMetadata, computeMetadataHash,
 * computeRecordHash, verifyEvidenceRecords (pure/offline verifier), parseArtifactLocator, casUri.
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
  /**
   * (additive, optional) Size of the stored object without reading it; undefined when missing.
   * EvidenceLedger.append uses it (when present) to reject refs whose declared size is wrong.
   */
  head?(ref: ArtifactRef | string): Promise<ArtifactHead | undefined>;
}

/** (additive) Result of ArtifactStore.head. */
export interface ArtifactHead {
  sha256: string;
  size: number;
}

/** (additive) Minimal structural view of an S3 client (`S3Client` satisfies it; tests inject fakes). */
export interface S3ClientLike {
  send(command: object): Promise<unknown>;
}

/** (additive) Options for S3ArtifactStore. */
export interface S3ArtifactStoreOptions {
  /** Injected client (tests / custom middleware). When omitted an S3Client is built from the fields below. */
  client?: S3ClientLike;
  endpoint?: string;
  region: string;
  bucket: string;
  /** Key prefix; a trailing '/' is added when missing. Keys are `<prefix>sha256/<hex>`. */
  prefix?: string;
  /** Path-style addressing (MinIO and most S3-compatible stores). */
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** When set, every PutObject carries ObjectLockMode=COMPLIANCE and a retain-until date now+days (WORM). */
  objectLockDays?: number;
  /** Time source for Object Lock retention dates (default: system clock). */
  clock?: Clock;
}

/** (additive) Options for FsArtifactStore. */
export interface FsArtifactStoreOptions {
  /** fsync file + directory on write (default true). */
  fsync?: boolean;
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
  /** (additive) Number of seals whose root and signature were checked. */
  sealsChecked?: number;
  /** (additive) Number of distinct artifacts re-hashed (0 when checkArtifacts is false). */
  artifactsChecked?: number;
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

/** (additive) Correlation for the emitted `evidence.attached` / `evidence.sealed` events (I10). */
export interface EvidenceEventOptions {
  /**
   * Defaults: correlationId = input.traceId ?? runId; actorId = input.agentId ?? producer.agentId ??
   * producer.workerId (seal: `signer:<keyId>`); workItemId/agentId from the input.
   */
  eventContext?: Partial<Omit<EventContext, 'runId'>>;
}

/** (additive) Named form of the verify() options. */
export interface EvidenceVerifyOptions {
  /** Re-hash every referenced artifact through the ArtifactStore (default true). */
  checkArtifacts?: boolean;
  /** Trusted seal keys keyId → SPKI PEM. When omitted, the ledger signer's own public key is trusted. */
  publicKeys?: Record<string, string>;
}

export interface EvidenceLedger {
  /** `options` is an additive, optional third parameter. */
  append(input: EvidenceInput, tx?: SqlExecutor, options?: EvidenceEventOptions): Promise<EvidenceRecord>;
  get(evidenceId: string): Promise<EvidenceRecord | undefined>;
  getMany(evidenceIds: readonly string[]): Promise<EvidenceRecord[]>;
  query(query: EvidenceQuery): Promise<EvidenceRecord[]>;
  count(runId: string): Promise<number>;
  rootHash(runId: string, uptoSeq?: number): Promise<{ rootHash: string; count: number; lastSeq: number }>;
  verify(runId: string, options?: EvidenceVerifyOptions): Promise<EvidenceVerification>;
  /**
   * Signs the current Merkle root (requires a signer). Refuses (integrity_violation) to seal a chain
   * that fails record-level verification, or that contradicts an earlier seal made by this signer
   * (e.g. records deleted behind the triggers). Idempotent: returns the latest seal when it already
   * covers the same root/count/lastSeq with the same key AND its signature verifies under that key
   * (seal rows can be INSERTed by anyone with table access; a forged row is never returned).
   * `options` is additive.
   */
  seal(runId: string, options?: EvidenceEventOptions): Promise<EvidenceSeal>;
  /**
   * The most recent stored seal row, as stored: NOT signature-checked. Use verify() (or seal(), which
   * only returns a seal verified under the ledger signer) before trusting it.
   */
  latestSeal(runId: string): Promise<EvidenceSeal | undefined>;
}

export interface RecordEvidenceInput extends Omit<EvidenceInput, 'artifact'> {
  data: Uint8Array | string;
  mimeType: string;
}

/** (additive) Options for resolveClaim. */
export interface ResolveClaimOptions {
  /** Every referenced evidence must belong to this run (else: all references must share one run). */
  runId?: string;
}

/**
 * `supported` is false (with `problems`) unless every reference exists, matches the claim's query,
 * belongs to one run, and — additionally — its stored metadata/record hashes still recompute (a
 * record rewritten behind the ledger never supports a claim). Chain and artifact checks: verify().
 */
export interface ClaimResolution {
  claim: ReportClaim;
  supported: boolean;
  evidence: EvidenceRecord[];
  problems: string[];
}
