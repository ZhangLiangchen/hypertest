import { HypertestError, type JsonValue, type SqlExecutor } from '@hypertest/core';
import type { EvidenceInput, EvidenceRecord, ReportClaim } from '@hypertest/domain';
import type { ArtifactStore, ClaimResolution, EvidenceEventOptions, EvidenceLedger, RecordEvidenceInput, ResolveClaimOptions } from './contracts.ts';
import { computeMetadataHash, computeRecordHash } from './records.ts';

/** Stores the bytes in the ArtifactStore, then appends the evidence record that references them. */
export async function recordEvidence(
  ledger: EvidenceLedger,
  artifacts: ArtifactStore,
  input: RecordEvidenceInput,
  tx?: SqlExecutor,
  options?: EvidenceEventOptions,
): Promise<EvidenceRecord> {
  if (!input || typeof input !== 'object') throw new HypertestError('invalid_argument', 'recordEvidence input must be an object');
  const { data, mimeType, ...rest } = input;
  const putOptions: { mimeType: string; classification?: NonNullable<EvidenceInput['classification']> } = { mimeType };
  if (rest.classification !== undefined) putOptions.classification = rest.classification;
  const artifact = await artifacts.put(data, putOptions);
  return ledger.append({ ...rest, artifact }, tx, options);
}

function hasPath(value: JsonValue | undefined, path: string): boolean {
  let cur: unknown = value;
  for (const segment of path.split('.')) {
    if (segment === '') return false;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(segment)) return false;
      const idx = Number(segment);
      if (idx >= cur.length) return false;
      cur = cur[idx];
    } else if (cur !== null && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, segment)) return false;
      cur = (cur as Record<string, unknown>)[segment];
    } else {
      return false;
    }
  }
  return cur !== undefined;
}

/**
 * A claim is supported iff it references at least one evidence record, every reference exists and
 * its stored hashes recompute (metadata + record hash), all references belong to one run
 * (`options.runId` when given), and each record matches the claim's evidenceQuery: `evidenceType`
 * and `workItemId` when set, and — when `field` is set — the record's structured payload contains
 * that dot path. Problems are listed; nothing is inferred.
 */
export async function resolveClaim(ledger: EvidenceLedger, claim: ReportClaim, options: ResolveClaimOptions = {}): Promise<ClaimResolution> {
  if (!claim || typeof claim !== 'object' || !Array.isArray(claim.evidenceRefs)) {
    throw new HypertestError('invalid_argument', 'claim must have an evidenceRefs array');
  }
  const problems: string[] = [];
  const refs = [...new Set(claim.evidenceRefs)];
  if (refs.length === 0) problems.push('claim has no evidence references');
  const evidence = refs.length > 0 ? await ledger.getMany(refs) : [];
  const found = new Set(evidence.map((e) => e.evidenceId));
  for (const ref of refs) if (!found.has(ref)) problems.push(`evidence ${ref} not found`);

  if (options.runId !== undefined) {
    for (const e of evidence) if (e.runId !== options.runId) problems.push(`evidence ${e.evidenceId} belongs to run ${e.runId}, not ${options.runId}`);
  } else {
    const runs = [...new Set(evidence.map((e) => e.runId))];
    if (runs.length > 1) problems.push(`evidence spans multiple runs: ${runs.join(', ')}`);
  }

  const q = claim.evidenceQuery ?? {};
  for (const e of evidence) {
    // A claim must not be supported by a record whose stored hashes no longer recompute (it was
    // rewritten behind the ledger). Chain links and artifact bytes are checked by verify().
    const metadataHash = computeMetadataHash(e);
    if (metadataHash !== e.metadataHash) {
      problems.push(`evidence ${e.evidenceId} fails its integrity check (metadata hash mismatch)`);
    } else if (computeRecordHash(e.metadataHash, e.artifact.sha256, e.previousRecordHash) !== e.recordHash) {
      problems.push(`evidence ${e.evidenceId} fails its integrity check (record hash mismatch)`);
    }
    if (q.evidenceType !== undefined && e.evidenceType !== q.evidenceType) {
      problems.push(`evidence ${e.evidenceId} has type ${e.evidenceType}, claim requires ${q.evidenceType}`);
    }
    if (q.workItemId !== undefined && e.workItemId !== q.workItemId) {
      problems.push(`evidence ${e.evidenceId} belongs to work item ${e.workItemId ?? '<none>'}, claim requires ${q.workItemId}`);
    }
    if (q.field !== undefined && !hasPath(e.structured, q.field)) {
      problems.push(`evidence ${e.evidenceId} has no structured field ${q.field}`);
    }
  }
  return { claim, supported: problems.length === 0, evidence, problems };
}
