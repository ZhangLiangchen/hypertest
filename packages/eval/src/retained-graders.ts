/**
 * (F[12], item 18) RETAINED grader revisions: "grader bug ⇒ do not edit v8 → publish v9 → run v8 and v9 on a bridge
 * dataset" needs v8 to still exist. A grader whose revision changed keeps its previous revision here, verbatim, so a
 * bridge run (`hypertest eval bridge <suite> --grader <id> --from <revision>`) grades the SAME trials with both
 * revisions; the bridge report (old → new) is what lets the release gate compare results across the change
 * (no discontinuity) or what documents a re-baseline (discontinuity).
 *
 * generatedTestsGoverned@1 is the revision before wave 1 (packages/eval/src/core-graders.ts at 5b70ef4): sensitivity from
 * a selector match, eligibility ⇔ sensitivity.
 */
import { HypertestError, type JsonValue } from '@hypertest/core';
import { isEligibleTestArtifact, type EvidenceRecord, type TestArtifact } from '@hypertest/domain';
import type { Grader, GraderResult, TrialData, VersionedGrader } from './contracts.ts';
import { RELEASE_VERDICTS } from './analysis.ts';
import { GRADER_REVISIONS } from './grader-revisions.ts';

type Check = { name: string; ok: boolean; detail?: string };

function list(items: readonly string[]): string {
  const shown = items.slice(0, 8).join('; ');
  return items.length > 8 ? `${shown}; … (${items.length - 8} more)` : shown;
}

function fromChecks(graderId: string, checks: Check[]): GraderResult {
  const failed = checks.filter((c) => !c.ok);
  const score = checks.length === 0 ? 1 : (checks.length - failed.length) / checks.length;
  const detail = failed.length === 0 ? `all ${checks.length} checks passed` : `${failed.length}/${checks.length} checks failed: ${list(failed.map((c) => (c.detail ? `${c.name}: ${c.detail}` : c.name)))}`;
  return { graderId, pass: failed.length === 0, score, detail };
}

function noRun(graderId: string, data: TrialData): GraderResult | undefined {
  return data.run ? undefined : { graderId, pass: false, score: 0, detail: 'no run was recorded for this trial' };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function latestArtifacts(artifacts: readonly TestArtifact[]): TestArtifact[] {
  const m = new Map<string, TestArtifact>();
  for (const a of artifacts) {
    const prev = m.get(a.artifactId);
    if (!prev || a.revision > prev.revision) m.set(a.artifactId, a);
  }
  return [...m.values()];
}

function structured(e: EvidenceRecord | undefined): Record<string, unknown> {
  return e?.structured !== null && typeof e?.structured === 'object' && !Array.isArray(e?.structured) ? (e.structured as Record<string, unknown>) : {};
}

/** v1: mutation runs of an artifact (a mutation-result whose selector names the artifact's test) that killed ≥ 1 mutant. */
function killedMutantsV1(a: TestArtifact, evidence: readonly EvidenceRecord[]): number {
  let killed = 0;
  for (const e of evidence) {
    if (e.evidenceType !== 'mutation-result') continue;
    const s = structured(e);
    const selector = str(s['selector']);
    if (selector === undefined || !(selector === a.runner.selector || selector.includes(a.path))) continue;
    if (typeof s['killed'] === 'number') killed = Math.max(killed, s['killed']);
  }
  return killed;
}

/** v1: the known-bad evidence of an artifact really failed on a case. */
function failedKnownBadV1(a: TestArtifact, evidence: ReadonlyMap<string, EvidenceRecord>): boolean {
  const v = a.validations.knownBad;
  if (v?.status !== 'passed') return false;
  return v.evidenceRefs.some((id) => {
    const s = structured(evidence.get(id));
    const cases = Array.isArray(s['cases']) ? (s['cases'] as Array<{ status?: unknown }>) : [];
    return evidence.get(id)?.evidenceType === 'test-result' && (s['passed'] === false || cases.some((c) => c.status === 'failed'));
  });
}

function taintedBy(e: EvidenceRecord, a: TestArtifact): boolean {
  const s = structured(e);
  if (s['testArtifactId'] === a.artifactId) return true;
  const delta = s['workspaceDelta'];
  const files = delta && typeof delta === 'object' && !Array.isArray(delta) ? (delta as Record<string, JsonValue>)['testFiles'] : undefined;
  return Array.isArray(files) && files.some((f) => f !== null && typeof f === 'object' && !Array.isArray(f) && (f as Record<string, JsonValue>)['sha256'] === a.artifactDigest);
}

const EVIDENCE_CRITERIA: ReadonlySet<string> = new Set(['C3', 'C4', 'C8']);

/** generatedTestsGoverned revision 1 (verbatim behaviour of 5b70ef4). */
export const generatedTestsGovernedV1: Grader = async (ctx) => {
  const missing = noRun('generatedTestsGoverned', ctx.data);
  if (missing) return missing;
  const artifacts = latestArtifacts(await ctx.ht.services.specs.listTestArtifacts(ctx.data.runId!)).filter((a) => a.sourceType === 'generated');
  if (artifacts.length === 0) throw new HypertestError('precondition_failed', 'generatedTestsGoverned: the run registered no generated test artifact');
  const byId = new Map(ctx.data.evidence.map((e) => [e.evidenceId, e]));
  const checks: Check[] = [];
  const ineligible: TestArtifact[] = [];
  for (const a of artifacts) {
    const killed = killedMutantsV1(a, ctx.data.evidence);
    const sensitive = killed > 0 || failedKnownBadV1(a, byId);
    const eligible = isEligibleTestArtifact(a);
    if (!eligible) ineligible.push(a);
    checks.push({ name: `${a.path} (${a.artifactId}) is eligible exactly when it proved sensitivity`, ok: eligible === sensitive, detail: `eligible ${eligible} (${a.approvalState}), killed ${killed} seeded mutant(s), known-bad ${a.validations.knownBad?.status ?? 'none'}` });
  }
  const d = ctx.data.decision;
  if (d) {
    const supporting = new Set(d.satisfiedCriteria.filter((c) => EVIDENCE_CRITERIA.has(c.criterionId)).flatMap((c) => c.evidenceRefs));
    const tainted = ineligible.flatMap((a) => ctx.data.evidence.filter((e) => supporting.has(e.evidenceId) && taintedBy(e, a)).map((e) => `${e.evidenceId} (${a.path})`));
    checks.push({ name: 'no satisfied criterion rests on evidence of an insensitive generated test', ok: tainted.length === 0, detail: list(tainted) });
    const released = RELEASE_VERDICTS.has(d.verdict);
    const eligibleCount = artifacts.length - ineligible.length;
    checks.push({ name: 'a release needs an eligible generated test', ok: !released || eligibleCount > 0, detail: `verdict ${d.verdict} with ${eligibleCount} eligible generated test(s)` });
  }
  return fromChecks('generatedTestsGoverned', checks);
};

/** `graderId@revision` → the retained revision (never the current one). */
export const RETAINED_GRADERS: Readonly<Record<string, VersionedGrader>> = Object.freeze({
  'generatedTestsGoverned@1': { revision: '1', grader: generatedTestsGovernedV1, description: 'sensitivity from a selector match; eligibility ⇔ sensitivity (before D-0/D-1)' },
});

/** A retained revision `graderId@revision` (refused when unknown or when it is the current revision). */
export function retainedGrader(spec: string): { graderId: string; versioned: VersionedGrader } {
  const m = /^([A-Za-z][A-Za-z0-9]*)@([A-Za-z0-9._-]+)$/.exec(spec);
  if (!m) throw new HypertestError('invalid_argument', `a retained grader is <graderId>@<revision> (got ${JSON.stringify(spec)})`);
  const [, graderId, revision] = m;
  if (GRADER_REVISIONS[graderId!] === revision) throw new HypertestError('invalid_argument', `${spec} is the CURRENT revision of ${graderId}: a bridge compares it with an earlier one`);
  const v = RETAINED_GRADERS[spec];
  if (!v) throw new HypertestError('not_found', `no retained revision ${spec} (retained: ${Object.keys(RETAINED_GRADERS).join(', ') || 'none'})`);
  return { graderId: graderId!, versioned: v };
}
