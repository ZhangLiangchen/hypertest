import { HypertestError, type JsonValue, type SqlExecutor } from '@hypertest/core';
import { evaluateClaim, type EvidenceInput, type EvidenceRecord, type ReportClaim } from '@hypertest/domain';
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

/** Parsed JSON artifact of a record, when the artifact is JSON and readable (undefined otherwise). */
async function artifactJson(artifacts: ResolveClaimOptions['artifacts'], e: EvidenceRecord): Promise<JsonValue | undefined> {
  if (!artifacts || !/^application\/(json|x-ndjson)/.test(e.artifact.mimeType)) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(await artifacts.get(e.artifact))) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * A claim is supported iff it references at least one evidence record, every reference exists and
 * its stored hashes recompute (metadata + record hash), all references belong to one run
 * (`options.runId` when given), each record matches the claim's evidenceQuery (`evidenceType` and
 * `workItemId` when set; `field` — in the structured payload, or in the record's JSON artifact when
 * `options.artifacts` is given) and — (area-C-0) — the claim EVALUATES true: domain `evaluateClaim`
 * runs the evidenceQuery aggregation over the referenced values and compares it with `claim.value`
 * (a number the model invented and backed with a real evidence id is a `mismatch`, never supported).
 * Problems are listed; nothing is inferred.
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
  const data = new Map<string, JsonValue>();
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
      const fromArtifact = await artifactJson(options.artifacts, e);
      if (fromArtifact !== undefined && hasPath(fromArtifact, q.field)) data.set(e.evidenceId, fromArtifact);
      else problems.push(`evidence ${e.evidenceId} has no structured field ${q.field}`);
    }
  }
  if (problems.length > 0) return { claim, supported: false, evidence, problems };
  const evaluation = evaluateClaim(claim, evidence, data);
  if (evaluation.status === 'mismatch') problems.push(`claim value contradicts its evidence: ${evaluation.detail}`);
  else if (evaluation.status === 'unevaluable') problems.push(`claim cannot be evaluated against its evidence: ${evaluation.detail}`);
  return { claim, supported: problems.length === 0, evidence, problems, evaluation };
}
