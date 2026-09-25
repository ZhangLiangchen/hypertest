import { deepFreeze, type JsonValue } from '@hypertest/core';
import {
  RISK_ORDER, SEVERITY_ORDER, atLeastAsSevere, isEligibleTestArtifact, isUnresolvedFinding,
  type ApprovedException, type BlackboardRecord, type Comparator, type CriterionResult, type EvidenceRecord, type Finding, type GateSpec,
  type OracleAssertion, type OracleCheck, type OracleSpec, type QualityDecision, type QualityVerdict, type Review, type ReviewerDecision,
  type TestArtifact,
} from '@hypertest/domain';
import type { GateInput } from './contracts.ts';

/**
 * The deterministic QualityGate (I7). Pure: the decision depends only on the input (no clock, no
 * randomness, stable ordering), so the same input always yields the same QualityDecision.
 *
 * Criteria, evaluated in order (each satisfied | violated | unknown):
 *   C1 evidence_integrity   – ledger root count equals the evidence handed in, no foreign-run evidence, and
 *                             at least one ELIGIBLE evidence record (a pass with zero evidence, or with only
 *                             evidence from ineligible generated tests, is impossible). Not waivable.
 *   C2 unresolved_findings  – unresolved product/security/performance/unknown findings at or above
 *                             gate.failOnUnresolvedSeverity ⇒ violated (fail); unresolved test/infra/environment
 *                             findings at that severity ⇒ unknown (the evidence itself is in doubt).
 *   C3 critical_oracles     – every approved P0/P1 oracle assertion needs deterministic supporting evidence;
 *                             a matching evidence that contradicts it ⇒ violated (fail); LLM-only/no support ⇒ unknown.
 *   C4 required_evidence    – gate.requiredEvidence + critical WorkItem.evidenceRequirements ⇒ missing ⇒ unknown.
 *   C5 failed_work          – failed or unfinished work items serving open P0/P1 objectives ⇒ unknown.
 *   C6 independent_review   – reject ⇒ violated (conditional + human review); needs_more_evidence ⇒ unknown;
 *                             no independent approval ⇒ violated (conditional + human review).
 *   C7 unresolved_risks     – open risks at or above gate.conditionalOnRiskLevel ⇒ violated (conditional).
 *   C8 coverage             – latest coverage evidence below gate.minCoverage ⇒ violated (fail); none ⇒ unknown.
 *   C9 critical_claims      – critical report claims without resolvable evidence ⇒ unknown.
 * Verdict: fail-type violation ⇒ fail; else unknown ⇒ inconclusive; else conditional-type violation ⇒
 * conditional; else pass. Unexpired exceptions approved by a human/system actor waive a criterion (never C1).
 */

export const GATE_CRITERIA = [
  { id: 'C1', name: 'evidence_integrity', violation: 'fail' },
  { id: 'C2', name: 'unresolved_findings', violation: 'fail' },
  { id: 'C3', name: 'critical_oracles', violation: 'fail' },
  { id: 'C4', name: 'required_evidence', violation: 'fail' },
  { id: 'C5', name: 'failed_work', violation: 'fail' },
  { id: 'C6', name: 'independent_review', violation: 'conditional' },
  { id: 'C7', name: 'unresolved_risks', violation: 'conditional' },
  { id: 'C8', name: 'coverage', violation: 'fail' },
  { id: 'C9', name: 'critical_claims', violation: 'fail' },
] as const;

type CriterionId = (typeof GATE_CRITERIA)[number]['id'];

export const DEFAULT_GATE_SPEC: GateSpec = deepFreeze<GateSpec>({
  gateId: 'hypertest.default',
  description: 'Default release gate: no unresolved P0/P1 defects, deterministic evidence for critical oracles, independent review.',
  failOnUnresolvedSeverity: 'P1',
  conditionalOnRiskLevel: 'high',
  requiredEvidence: [{ evidenceType: 'test-result', minCount: 1, critical: true }],
  requireDeterministicForCritical: true,
  requireIndependentReview: true,
});

const PRODUCT_CATEGORIES: ReadonlySet<Finding['category']> = new Set(['product_defect', 'security', 'performance', 'unknown']);

interface Outcome {
  status: CriterionResult['status'];
  evidenceRefs: string[];
  detail: string;
  reasons: string[];
  /** C6 only: the review outcome demands a human. */
  humanReview?: boolean;
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const uniqSorted = (xs: Iterable<string>) => [...new Set(xs)].sort(byString);

/** Latest version per lineage (records superseded by another record in the list are dropped). */
export function currentRecords<T>(records: readonly BlackboardRecord<T>[]): BlackboardRecord<T>[] {
  const superseded = new Set(records.map((r) => r.supersedes).filter((x): x is string => x !== undefined));
  const byLineage = new Map<string, BlackboardRecord<T>>();
  for (const r of records) {
    if (superseded.has(r.recordId)) continue;
    const prev = byLineage.get(r.lineageId);
    if (!prev || r.version > prev.version || (r.version === prev.version && (r.revision > prev.revision || (r.revision === prev.revision && r.recordId > prev.recordId)))) {
      byLineage.set(r.lineageId, r);
    }
  }
  return [...byLineage.values()].sort((a, b) => byString(a.recordId, b.recordId));
}

function getField(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let cur: JsonValue | undefined = value;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, JsonValue>)[key];
  }
  return cur;
}

function compare(actual: JsonValue | undefined, comparator: Comparator, expected: number | string | boolean): boolean | undefined {
  if (actual === undefined || actual === null) return undefined;
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return undefined;
    switch (comparator) {
      case '<': return actual < expected;
      case '<=': return actual <= expected;
      case '>': return actual > expected;
      case '>=': return actual >= expected;
      case '==': return actual === expected;
      case '!=': return actual !== expected;
    }
  }
  if (typeof actual !== typeof expected) return undefined;
  if (comparator === '==') return actual === expected;
  if (comparator === '!=') return actual !== expected;
  if (typeof expected === 'string' && typeof actual === 'string') {
    switch (comparator) {
      case '<': return actual < expected;
      case '<=': return actual <= expected;
      case '>': return actual > expected;
      case '>=': return actual >= expected;
    }
  }
  return undefined;
}

function globRe(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

interface CaseLike {
  id?: string;
  name?: string;
  file?: string;
  status?: string;
}

function caseMatches(selector: string, c: CaseLike): boolean {
  const candidates = [c.id, c.name, c.file !== undefined && c.name !== undefined ? `${c.file}::${c.name}` : undefined].filter((x): x is string => typeof x === 'string');
  if (selector.includes('*')) {
    const re = globRe(selector);
    return candidates.some((x) => re.test(x));
  }
  return candidates.includes(selector);
}

/** Build identity of an evidence record (latest build wins when evidence spans a fix). */
function buildKey(e: EvidenceRecord): string {
  return e.environment?.buildDigest ?? e.provenance.commit ?? '';
}

/** Restricts evidence to the build of the most recent record (by ledger seq). */
function latestBuild(evs: readonly EvidenceRecord[]): EvidenceRecord[] {
  if (evs.length === 0) return [];
  const newest = evs.reduce((m, e) => (e.seq > m.seq ? e : m));
  const key = buildKey(newest);
  return evs.filter((e) => buildKey(e) === key);
}

function metricValue(structured: JsonValue | undefined, metric: string, aggregation: string | undefined): JsonValue | undefined {
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return undefined;
  const s = structured as Record<string, JsonValue>;
  const pick = (m: JsonValue | undefined): JsonValue | undefined => {
    if (typeof m === 'number') return aggregation === undefined ? m : undefined;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined;
    const o = m as Record<string, JsonValue>;
    if (aggregation !== undefined) return o[aggregation] ?? getField(o['values'], aggregation);
    return o['value'];
  };
  if (s['metric'] === metric || s['name'] === metric) return pick(s);
  const metrics = s['metrics'];
  if (metrics && typeof metrics === 'object' && !Array.isArray(metrics)) return pick((metrics as Record<string, JsonValue>)[metric]);
  return undefined;
}

type CheckOutcome = { status: 'satisfied' | 'violated' | 'unknown'; refs: string[]; detail: string };

function evaluateCheck(check: OracleCheck, evidence: readonly EvidenceRecord[]): CheckOutcome {
  switch (check.type) {
    case 'test_outcome': {
      const relevant = latestBuild(
        evidence.filter((e) => e.evidenceType === 'test-result' && Array.isArray(getField(e.structured, 'cases')) && (getField(e.structured, 'cases') as JsonValue[]).some((c) => c !== null && typeof c === 'object' && caseMatches(check.testSelector, c as CaseLike))),
      );
      if (relevant.length === 0) return { status: 'unknown', refs: [], detail: `no test-result evidence for ${check.testSelector}` };
      const statuses: Array<{ status: string; ref: string }> = [];
      for (const e of relevant) {
        for (const c of getField(e.structured, 'cases') as JsonValue[]) {
          if (c !== null && typeof c === 'object' && caseMatches(check.testSelector, c as CaseLike)) statuses.push({ status: String((c as CaseLike).status), ref: e.evidenceId });
        }
      }
      const failed = statuses.filter((s) => s.status === 'failed' || s.status === 'xfail');
      if (failed.length) return { status: 'violated', refs: uniqSorted(failed.map((s) => s.ref)), detail: `${check.testSelector}: ${failed.map((s) => s.status).join(',')}` };
      const errored = statuses.filter((s) => s.status === 'error');
      if (errored.length) return { status: 'unknown', refs: uniqSorted(errored.map((s) => s.ref)), detail: `${check.testSelector}: harness error (not an assertion outcome)` };
      const passed = statuses.filter((s) => s.status === 'passed');
      if (passed.length) return { status: 'satisfied', refs: uniqSorted(passed.map((s) => s.ref)), detail: `${check.testSelector}: passed` };
      return { status: 'unknown', refs: uniqSorted(statuses.map((s) => s.ref)), detail: `${check.testSelector}: ${uniqSorted(statuses.map((s) => s.status)).join(',')} (not a pass)` };
    }
    case 'evidence_predicate': {
      const relevant = latestBuild(evidence.filter((e) => e.evidenceType === check.evidenceType && getField(e.structured, check.field) !== undefined));
      if (relevant.length === 0) return { status: 'unknown', refs: [], detail: `no ${check.evidenceType} evidence with field ${check.field}` };
      const results = relevant.map((e) => ({ ok: compare(getField(e.structured, check.field), check.comparator, check.value), ref: e.evidenceId }));
      const bad = results.filter((r) => r.ok === false);
      if (bad.length) return { status: 'violated', refs: uniqSorted(bad.map((r) => r.ref)), detail: `${check.field} ${check.comparator} ${String(check.value)} violated` };
      if (results.some((r) => r.ok === undefined)) return { status: 'unknown', refs: uniqSorted(results.map((r) => r.ref)), detail: `${check.field} not comparable` };
      return { status: 'satisfied', refs: uniqSorted(results.map((r) => r.ref)), detail: `${check.field} ${check.comparator} ${String(check.value)}` };
    }
    case 'metric_threshold': {
      const relevant = latestBuild(evidence.filter((e) => e.evidenceType === 'metric' && metricValue(e.structured, check.metric, check.aggregation) !== undefined));
      if (relevant.length === 0) return { status: 'unknown', refs: [], detail: `no metric evidence for ${check.metric}${check.aggregation ? `.${check.aggregation}` : ''}` };
      const results = relevant.map((e) => ({ ok: compare(metricValue(e.structured, check.metric, check.aggregation), check.comparator, check.threshold), ref: e.evidenceId }));
      const bad = results.filter((r) => r.ok === false);
      if (bad.length) return { status: 'violated', refs: uniqSorted(bad.map((r) => r.ref)), detail: `${check.metric} ${check.comparator} ${check.threshold} violated` };
      if (results.some((r) => r.ok === undefined)) return { status: 'unknown', refs: uniqSorted(results.map((r) => r.ref)), detail: `${check.metric} not numeric` };
      return { status: 'satisfied', refs: uniqSorted(results.map((r) => r.ref)), detail: `${check.metric} ${check.comparator} ${check.threshold}` };
    }
    case 'http_expectation': {
      const relevant = latestBuild(
        evidence.filter((e) => {
          if (e.evidenceType !== 'api-response') return false;
          const method = getField(e.structured, 'method') ?? getField(e.structured, 'request.method');
          const path = getField(e.structured, 'path') ?? getField(e.structured, 'request.path');
          return typeof method === 'string' && method.toUpperCase() === check.method.toUpperCase() && path === check.path;
        }),
      );
      if (relevant.length === 0) return { status: 'unknown', refs: [], detail: `no api-response evidence for ${check.method} ${check.path}` };
      const results = relevant.map((e) => {
        const status = getField(e.structured, 'status') ?? getField(e.structured, 'response.status');
        const body = getField(e.structured, 'body') ?? getField(e.structured, 'bodyExcerpt') ?? getField(e.structured, 'response.body');
        let ok: boolean | undefined = true;
        if (check.expectStatus !== undefined) ok = typeof status === 'number' ? status === check.expectStatus : undefined;
        if (ok === true && check.expectBodyContains !== undefined) ok = typeof body === 'string' ? body.includes(check.expectBodyContains) : undefined;
        return { ok, ref: e.evidenceId };
      });
      const bad = results.filter((r) => r.ok === false);
      if (bad.length) return { status: 'violated', refs: uniqSorted(bad.map((r) => r.ref)), detail: `${check.method} ${check.path} expectation violated` };
      if (results.some((r) => r.ok === undefined)) return { status: 'unknown', refs: uniqSorted(results.map((r) => r.ref)), detail: `${check.method} ${check.path} response incomplete` };
      return { status: 'satisfied', refs: uniqSorted(results.map((r) => r.ref)), detail: `${check.method} ${check.path} as expected` };
    }
    case 'llm_rubric':
      return { status: 'unknown', refs: [], detail: 'llm rubric' };
  }
}

function isLlmOnly(a: OracleAssertion): boolean {
  return a.kind === 'llm_semantic' || a.check === undefined || a.check.type === 'llm_rubric';
}

/** Latest approved revision per oracle id. */
function currentOracles(oracles: readonly OracleSpec[]): OracleSpec[] {
  const m = new Map<string, OracleSpec>();
  for (const o of oracles) {
    if (o.status !== 'approved') continue;
    const prev = m.get(o.oracleId);
    if (!prev || o.revision > prev.revision) m.set(o.oracleId, o);
  }
  return [...m.values()].sort((a, b) => byString(a.oracleId, b.oracleId));
}

function latestArtifacts(artifacts: readonly TestArtifact[]): Map<string, TestArtifact> {
  const m = new Map<string, TestArtifact>();
  for (const a of artifacts) {
    const prev = m.get(a.artifactId);
    if (!prev || a.revision > prev.revision) m.set(a.artifactId, a);
  }
  return m;
}

export class QualityGate {
  evaluate(input: GateInput): QualityDecision {
    const { run, gate } = input;
    const allEvidence = [...input.evidence].sort((a, b) => a.seq - b.seq || byString(a.evidenceId, b.evidenceId));
    const runEvidence = allEvidence.filter((e) => e.runId === run.runId);
    const evidenceIds = new Set(runEvidence.map((e) => e.evidenceId));

    // Evidence from generated tests that never demonstrated sensitivity does not count (nor does evidence
    // pointing at an unknown artifact).
    const artifacts = latestArtifacts(input.testArtifacts);
    const ignored: string[] = [];
    const eligible = runEvidence.filter((e) => {
      const id = getField(e.structured, 'testArtifactId');
      if (id === undefined) return true;
      const a = typeof id === 'string' ? artifacts.get(id) : undefined;
      if (a && isEligibleTestArtifact(a)) return true;
      ignored.push(`${e.evidenceId} (test artifact ${String(id)} ${a ? 'not eligible' : 'unknown'})`);
      return false;
    });

    const findings = currentRecords(input.findings).filter((r) => r.runId === run.runId);
    const risks = currentRecords(input.risks).filter((r) => r.runId === run.runId);
    const reviews = currentRecords(input.reviews).filter((r) => r.runId === run.runId);

    const outcomes = new Map<CriterionId, Outcome>();

    // C1 evidence_integrity
    {
      const reasons: string[] = [];
      let status: Outcome['status'] = 'satisfied';
      const foreign = allEvidence.filter((e) => e.runId !== run.runId).map((e) => e.evidenceId);
      if (input.evidenceRoot.count !== allEvidence.length) {
        status = 'unknown';
        reasons.push(`evidence root covers ${input.evidenceRoot.count} records but ${allEvidence.length} were provided`);
      }
      if (foreign.length) {
        status = 'unknown';
        reasons.push(`evidence from other runs: ${foreign.join(', ')}`);
      }
      if (allEvidence.length === 0) {
        status = 'unknown';
        reasons.push('no evidence recorded');
      } else if (eligible.length === 0) {
        status = 'unknown';
        reasons.push(`no eligible evidence: all ${runEvidence.length} run evidence records come from ineligible or unknown generated tests`);
      }
      outcomes.set('C1', { status, evidenceRefs: [], detail: status === 'satisfied' ? `${allEvidence.length} evidence records match root ${input.evidenceRoot.rootHash}` : reasons.join('; '), reasons });
    }

    // C2 unresolved_findings
    const unresolvedFindings: string[] = [];
    {
      const reasons: string[] = [];
      const blocking = findings.filter((r) => isUnresolvedFinding(r.payload) && atLeastAsSevere(r.payload.severity, gate.failOnUnresolvedSeverity));
      const product = blocking.filter((r) => PRODUCT_CATEGORIES.has(r.payload.category));
      const infra = blocking.filter((r) => !PRODUCT_CATEGORIES.has(r.payload.category));
      for (const r of product) {
        unresolvedFindings.push(r.recordId);
        reasons.push(`unresolved ${r.payload.severity} ${r.payload.category} finding ${r.recordId}: ${r.payload.title}`);
        if (r.evidenceRefs.length === 0) reasons.push(`unevidenced finding ${r.recordId} (still blocking)`);
      }
      for (const r of infra) reasons.push(`unresolved ${r.payload.severity} ${r.payload.category} finding ${r.recordId} casts doubt on the evidence: ${r.payload.title}`);
      const status: Outcome['status'] = product.length ? 'violated' : infra.length ? 'unknown' : 'satisfied';
      outcomes.set('C2', {
        status,
        evidenceRefs: uniqSorted([...product, ...infra].flatMap((r) => r.evidenceRefs)),
        detail: status === 'satisfied' ? `no unresolved findings at or above ${gate.failOnUnresolvedSeverity}` : `${product.length} product and ${infra.length} test/infrastructure findings unresolved`,
        reasons,
      });
    }

    // C3 critical_oracles
    {
      const reasons: string[] = [];
      const refs: string[] = [];
      let violated = 0;
      let unknown = 0;
      let checked = 0;
      for (const o of currentOracles(input.oracles)) {
        const deterministicRequired = gate.requireDeterministicForCritical || o.judgePolicy.deterministicRequiredForCritical || !o.judgePolicy.allowLlmOnlyDecision;
        for (const a of [...o.assertions].sort((x, y) => byString(x.assertionId, y.assertionId))) {
          if (SEVERITY_ORDER[a.severity] > SEVERITY_ORDER.P1) continue;
          const label = `${o.oracleId}@${o.revision}/${a.assertionId} (${a.severity})`;
          checked++;
          if (isLlmOnly(a)) {
            if (deterministicRequired) {
              unknown++;
              reasons.push(a.check === undefined ? `${label}: no machine-checkable check; deterministic evidence required` : `${label}: only LLM/semantic support; deterministic evidence required`);
            } else reasons.push(`${label}: LLM-only assertion not gate-evaluable (allowed by gate and oracle policy)`);
            continue;
          }
          const r = evaluateCheck(a.check!, eligible);
          refs.push(...r.refs);
          if (r.status === 'violated') {
            violated++;
            reasons.push(`${label} violated: ${r.detail}`);
          } else if (r.status === 'unknown') {
            unknown++;
            reasons.push(`${label} unproven: ${r.detail}`);
          }
        }
      }
      const status: Outcome['status'] = violated ? 'violated' : unknown ? 'unknown' : 'satisfied';
      outcomes.set('C3', { status, evidenceRefs: uniqSorted(refs), detail: `${checked} critical assertions: ${violated} violated, ${unknown} unproven`, reasons });
    }

    // C4 required_evidence
    {
      const reasons: string[] = [];
      const refs: string[] = [];
      let missing = 0;
      const reqs: Array<{ label: string; type: string; min: number; workItemId?: string }> = [];
      for (const r of gate.requiredEvidence) reqs.push({ label: `gate requires ${r.minCount}× ${r.evidenceType}`, type: r.evidenceType, min: r.minCount });
      for (const w of [...input.workItems].sort((a, b) => byString(a.workItemId, b.workItemId))) {
        if (w.state === 'cancelled') continue;
        for (const r of w.evidenceRequirements) {
          if (r.critical === true) reqs.push({ label: `work item ${w.workItemId} requires ${r.minCount}× ${r.evidenceType}`, type: r.evidenceType, min: r.minCount, workItemId: w.workItemId });
        }
      }
      for (const q of reqs) {
        const found = eligible.filter((e) => e.evidenceType === q.type && (q.workItemId === undefined || e.workItemId === q.workItemId));
        refs.push(...found.map((e) => e.evidenceId));
        if (found.length < q.min) {
          missing++;
          reasons.push(`${q.label}: found ${found.length}`);
        }
      }
      outcomes.set('C4', { status: missing ? 'unknown' : 'satisfied', evidenceRefs: uniqSorted(refs), detail: `${reqs.length} requirements, ${missing} unmet`, reasons });
    }

    // C5 failed_work
    {
      const reasons: string[] = [];
      const critical = new Set(input.objectives.filter((o) => o.status === 'open' && atLeastAsSevere(o.priority, 'P1')).map((o) => o.objectiveId));
      const bad = [...input.workItems]
        .sort((a, b) => byString(a.workItemId, b.workItemId))
        .filter((w) => w.state !== 'cancelled' && w.state !== 'completed' && w.objectiveIds.some((id) => critical.has(id)));
      for (const w of bad) {
        reasons.push(w.state === 'failed'
          ? `work item ${w.workItemId} failed${w.failure ? ` (${w.failure.reason}: ${w.failure.message})` : ''} for open critical objective(s) ${w.objectiveIds.filter((id) => critical.has(id)).join(', ')}`
          : `work item ${w.workItemId} is ${w.state} (not finished) for open critical objective(s) ${w.objectiveIds.filter((id) => critical.has(id)).join(', ')}`);
      }
      outcomes.set('C5', { status: bad.length ? 'unknown' : 'satisfied', evidenceRefs: [], detail: bad.length ? `${bad.length} work items unfinished for critical objectives` : 'no failed work for open critical objectives', reasons });
    }

    // C6 independent_review
    const reviewerDecisions: ReviewerDecision[] = reviews.map((r) => {
      const d: ReviewerDecision = { reviewRecordId: r.recordId, reviewerAgentId: r.createdBy, verdict: r.payload.verdict };
      if (r.payload.modelProvider !== undefined) d.modelProvider = r.payload.modelProvider;
      return d;
    });
    {
      const reasons: string[] = [];
      const producers = new Set(input.producerProviders ?? []);
      const onSubject = reviews.filter((r) => {
        const kind = r.payload.subjectRef.kind as string;
        return kind === 'decision' || (kind === 'run' && r.payload.subjectRef.id === run.runId);
      });
      const independent = (r: BlackboardRecord<Review>) => (producers.size === 0 ? true : r.payload.modelProvider !== undefined && !producers.has(r.payload.modelProvider));
      const rejects = onSubject.filter((r) => r.payload.verdict === 'reject');
      const more = onSubject.filter((r) => r.payload.verdict === 'needs_more_evidence');
      const approvals = onSubject.filter((r) => r.payload.verdict === 'approve' && independent(r));
      const dependentApprovals = onSubject.filter((r) => r.payload.verdict === 'approve' && !independent(r));
      for (const r of dependentApprovals) reasons.push(`review ${r.recordId} not independent (provider ${r.payload.modelProvider ?? 'unknown'} also produced findings/tests)`);
      if (producers.size === 0 && approvals.length) reasons.push('reviewer heterogeneity unverified: producerProviders not supplied');
      let outcome: Outcome;
      if (!gate.requireIndependentReview) {
        outcome = { status: 'satisfied', evidenceRefs: [], detail: 'independent review not required by the gate', reasons: [] };
      } else if (rejects.length) {
        outcome = { status: 'violated', evidenceRefs: uniqSorted(rejects.flatMap((r) => r.payload.checkedEvidenceRefs)), detail: `rejected by review ${rejects.map((r) => r.recordId).join(', ')}`, reasons: [...rejects.map((r) => `review ${r.recordId} rejected: ${r.payload.rationale}`), ...reasons], humanReview: true };
      } else if (more.length) {
        outcome = { status: 'unknown', evidenceRefs: uniqSorted(more.flatMap((r) => r.payload.checkedEvidenceRefs)), detail: `review ${more.map((r) => r.recordId).join(', ')} needs more evidence`, reasons: [...more.map((r) => `review ${r.recordId} needs more evidence: ${r.payload.rationale}`), ...reasons] };
      } else if (approvals.length) {
        outcome = { status: 'satisfied', evidenceRefs: uniqSorted(approvals.flatMap((r) => r.payload.checkedEvidenceRefs)), detail: `approved by independent review ${approvals.map((r) => r.recordId).join(', ')}`, reasons };
      } else {
        outcome = { status: 'violated', evidenceRefs: [], detail: 'no independent approving review', reasons: ['no independent approving review of the run/decision', ...reasons], humanReview: true };
      }
      outcomes.set('C6', outcome);
    }

    // C7 unresolved_risks
    const unresolvedRisks: string[] = [];
    {
      const reasons: string[] = [];
      const open = risks.filter((r) => r.payload.status === 'open' && RISK_ORDER[r.payload.level] >= RISK_ORDER[gate.conditionalOnRiskLevel]);
      for (const r of open) {
        unresolvedRisks.push(r.recordId);
        reasons.push(`open ${r.payload.level} risk ${r.recordId}: ${r.payload.title}`);
      }
      outcomes.set('C7', { status: open.length ? 'violated' : 'satisfied', evidenceRefs: uniqSorted(open.flatMap((r) => r.evidenceRefs)), detail: open.length ? `${open.length} open risks at or above ${gate.conditionalOnRiskLevel}` : `no open risks at or above ${gate.conditionalOnRiskLevel}`, reasons });
    }

    // C8 coverage
    {
      const min = gate.minCoverage;
      if (!min || (min.lines === undefined && min.branches === undefined)) {
        outcomes.set('C8', { status: 'satisfied', evidenceRefs: [], detail: 'no coverage threshold', reasons: [] });
      } else {
        const cov = eligible.filter((e) => e.evidenceType === 'coverage');
        const latest = cov.length ? cov[cov.length - 1]! : undefined;
        const reasons: string[] = [];
        let status: Outcome['status'] = 'satisfied';
        if (!latest) {
          status = 'unknown';
          reasons.push('coverage threshold set but no coverage evidence');
        } else {
          for (const kind of ['lines', 'branches'] as const) {
            const want = min[kind];
            if (want === undefined) continue;
            const threshold = want > 1 ? want / 100 : want;
            const t = getField(latest.structured, `totals.${kind}`);
            const covered = getField(t, 'covered');
            const total = getField(t, 'total');
            if (typeof covered !== 'number' || typeof total !== 'number' || total <= 0) {
              if (status !== 'violated') status = 'unknown';
              reasons.push(`${kind} coverage unknown in ${latest.evidenceId}`);
              continue;
            }
            const ratio = covered / total;
            if (ratio < threshold) {
              status = 'violated';
              reasons.push(`${kind} coverage ${(ratio * 100).toFixed(2)}% < ${(threshold * 100).toFixed(2)}% (${latest.evidenceId})`);
            }
          }
        }
        outcomes.set('C8', { status, evidenceRefs: latest ? [latest.evidenceId] : [], detail: status === 'satisfied' ? `coverage meets threshold (${latest?.evidenceId})` : reasons.join('; '), reasons });
      }
    }

    // C9 critical_claims
    {
      const reasons: string[] = [];
      const refs: string[] = [];
      let bad = 0;
      for (const c of [...input.claims].sort((a, b) => byString(a.claimId, b.claimId))) {
        if (!c.critical) continue;
        if (c.evidenceRefs.length === 0) {
          bad++;
          reasons.push(`critical claim ${c.claimId} has no evidence: ${c.statement}`);
          continue;
        }
        const dangling = c.evidenceRefs.filter((r) => !evidenceIds.has(r));
        if (dangling.length) {
          bad++;
          reasons.push(`critical claim ${c.claimId} cites unknown evidence ${dangling.join(', ')}`);
        }
        refs.push(...c.evidenceRefs.filter((r) => evidenceIds.has(r)));
      }
      outcomes.set('C9', { status: bad ? 'unknown' : 'satisfied', evidenceRefs: uniqSorted(refs), detail: bad ? `${bad} critical claims without resolvable evidence` : 'all critical claims cite evidence', reasons });
    }

    // exceptions (waivers) — never C1, never agent-approved, never expired
    const nowMs = Date.parse(input.now);
    const applied: ApprovedException[] = [];
    const exceptionReasons: string[] = [];
    const waived = new Map<CriterionId, ApprovedException>();
    for (const ex of input.exceptions) {
      const crit = GATE_CRITERIA.find((c) => c.id === ex.criterionId || c.name === ex.criterionId);
      if (!crit) {
        exceptionReasons.push(`exception for unknown criterion ${ex.criterionId} ignored`);
        continue;
      }
      if (crit.id === 'C1') {
        exceptionReasons.push('exception for C1 evidence_integrity ignored (not waivable)');
        continue;
      }
      if (ex.approvedBy.kind === 'agent') {
        exceptionReasons.push(`exception for ${crit.id} approved by agent ${ex.approvedBy.id} ignored`);
        continue;
      }
      if (ex.expiresAt !== undefined && !(Date.parse(ex.expiresAt) > nowMs)) {
        exceptionReasons.push(`exception for ${crit.id} expired at ${ex.expiresAt}`);
        continue;
      }
      const o = outcomes.get(crit.id)!;
      if (o.status === 'satisfied') continue;
      if (!waived.has(crit.id)) {
        waived.set(crit.id, ex);
        applied.push(ex);
      }
    }

    const satisfiedCriteria: CriterionResult[] = [];
    const violatedCriteria: CriterionResult[] = [];
    const unknownCriteria: CriterionResult[] = [];
    const reasons: string[] = [];
    let failType = false;
    let unknownAny = false;
    let conditionalType = false;
    let requiresHumanReview = false;
    for (const c of GATE_CRITERIA) {
      const o = outcomes.get(c.id)!;
      const ex = waived.get(c.id);
      const description = `${c.id} ${c.name}`;
      for (const r of o.reasons) reasons.push(`${c.id} ${r}`);
      if (ex) {
        satisfiedCriteria.push({ criterionId: c.id, description, status: 'satisfied', evidenceRefs: o.evidenceRefs, detail: `waived by exception (${ex.approvedBy.kind}:${ex.approvedBy.id}: ${ex.rationale}); original status ${o.status}: ${o.detail}` });
        reasons.push(`${c.id} waived by ${ex.approvedBy.kind}:${ex.approvedBy.id}: ${ex.rationale}`);
        continue;
      }
      const result: CriterionResult = { criterionId: c.id, description, status: o.status, evidenceRefs: o.evidenceRefs, detail: o.detail };
      if (o.status === 'satisfied') satisfiedCriteria.push(result);
      else if (o.status === 'unknown') {
        unknownCriteria.push(result);
        unknownAny = true;
      } else {
        violatedCriteria.push(result);
        if (c.violation === 'fail') failType = true;
        else conditionalType = true;
      }
      if (o.humanReview) requiresHumanReview = true;
    }
    reasons.push(...exceptionReasons);
    if (ignored.length) reasons.push(`ignored evidence from ineligible generated tests: ${ignored.join(', ')}`);

    const verdict: QualityVerdict = failType ? 'fail' : unknownAny ? 'inconclusive' : conditionalType ? 'conditional' : 'pass';
    reasons.push(`verdict ${verdict}: ${verdictWhy(verdict, violatedCriteria, unknownCriteria)}`);

    const oracleRevisions: Record<string, number> = {};
    for (const o of currentOracles(input.oracles)) oracleRevisions[o.oracleId] = o.revision;
    const experimentRevisions: Record<string, number> = {};
    for (const e of [...input.experiments].sort((a, b) => byString(a.experimentId, b.experimentId))) {
      experimentRevisions[e.experimentId] = Math.max(experimentRevisions[e.experimentId] ?? 0, e.revision);
    }

    const decision: QualityDecision = {
      decisionId: input.decisionId,
      runId: run.runId,
      revision: input.revision ?? 1,
      gateId: gate.gateId,
      scope: { description: run.goal, objectiveIds: input.objectives.map((o) => o.objectiveId) },
      verdict,
      requiresHumanReview,
      oracleRevisions,
      experimentRevisions,
      evidenceRootHash: input.evidenceRoot.rootHash,
      evidenceCount: input.evidenceRoot.count,
      satisfiedCriteria,
      violatedCriteria,
      unknownCriteria,
      unresolvedFindings: uniqSorted(unresolvedFindings),
      unresolvedRisks: uniqSorted(unresolvedRisks),
      exceptions: applied,
      reviewerDecisions,
      reasons,
      runtimeManifestId: input.runtimeManifestId,
      policyRevision: input.policyRevision,
      decidedAt: input.now,
    };
    if (input.supersedes !== undefined) decision.supersedes = input.supersedes;
    if (run.systemModelRevision !== undefined) decision.systemModelRevision = run.systemModelRevision;
    return decision;
  }
}

function verdictWhy(verdict: QualityVerdict, violated: CriterionResult[], unknown: CriterionResult[]): string {
  if (verdict === 'pass') return 'all criteria satisfied';
  if (verdict === 'fail') return `violated ${violated.map((c) => c.criterionId).join(', ')}`;
  if (verdict === 'inconclusive') return `insufficient evidence for ${unknown.map((c) => c.criterionId).join(', ')}`;
  return `conditional on ${violated.map((c) => c.criterionId).join(', ')}`;
}
