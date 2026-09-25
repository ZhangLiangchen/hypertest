import type { JsonValue } from '@hypertest/core';
import type { DataClassification } from './common.ts';
import type { EnvironmentRef } from './testing.ts';

export type EvidenceType =
  | 'test-result'
  | 'stdout'
  | 'stderr'
  | 'metric'
  | 'trace'
  | 'log'
  | 'screenshot'
  | 'video'
  | 'pcap'
  | 'coverage'
  | 'mutation-result'
  | 'git-diff'
  | 'database-snapshot'
  | 'api-response'
  | 'environment-manifest'
  | 'tool-output'
  | 'model-output'
  | 'report'
  | (string & {});

/** Content-addressed artifact: the bytes behind evidence. */
export interface ArtifactRef {
  /** e.g. `cas://sha256/<hex>` (fs) or `s3://bucket/sha256/<hex>`. */
  uri: string;
  sha256: string;
  size: number;
  mimeType: string;
}

export interface Provenance {
  toolId?: string;
  toolInvocationId?: string;
  command?: string[];
  commit?: string;
  workspaceId?: string;
  target?: string;
  inputsHash?: string;
}

export interface EvidenceProducer {
  agentId?: string;
  workerId: string;
  imageDigest?: string;
  runtimeManifestId: string;
}

/** Input to EvidenceLedger.append. */
export interface EvidenceInput {
  runId: string;
  evidenceType: EvidenceType;
  artifact: ArtifactRef;
  summary: string;
  structured?: JsonValue;
  workItemId?: string;
  agentId?: string;
  toolInvocationId?: string;
  operationId?: string;
  environment?: EnvironmentRef;
  parentEvidenceIds?: string[];
  classification?: DataClassification;
  retentionPolicy?: string;
  producer: EvidenceProducer;
  provenance: Provenance;
  traceId?: string;
}

/**
 * Append-only, hash-chained evidence record (tamper-evident lineage, I6):
 * recordHash = sha256(metadataHash || artifact.sha256 || previousRecordHash ?? '').
 */
export interface EvidenceRecord extends Required<Pick<EvidenceInput, 'runId' | 'evidenceType' | 'artifact' | 'summary' | 'producer' | 'provenance'>> {
  evidenceId: string;
  seq: number;
  structured?: JsonValue;
  workItemId?: string;
  agentId?: string;
  toolInvocationId?: string;
  operationId?: string;
  environment?: EnvironmentRef;
  parentEvidenceIds: string[];
  classification: DataClassification;
  retentionPolicy: string;
  traceId?: string;
  capturedAt: string;
  metadataHash: string;
  previousRecordHash?: string;
  recordHash: string;
}

/** Signed Merkle root over a run's evidence records. */
export interface EvidenceSeal {
  runId: string;
  rootHash: string;
  count: number;
  lastSeq: number;
  keyId: string;
  algorithm: 'ed25519';
  signature: string;
  sealedAt: string;
}

/** A report claim must reference evidence; reports never contain unreferenced numbers. */
export interface ReportClaim {
  claimId: string;
  statement: string;
  value?: JsonValue;
  evidenceQuery: { evidenceType?: string; workItemId?: string; field?: string; aggregation?: string };
  evidenceRefs: string[];
  critical: boolean;
}
