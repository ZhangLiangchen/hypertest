import { canonicalJson, deepFreeze, sha256Hex, type JsonValue } from '@hypertest/core';
import {
  RISK_ORDER, SEVERITY_ORDER, atLeastAsSevere, evaluateClaim, isUnresolvedFinding,
  type ApprovedException, type BlackboardRecord, type Comparator, type CriterionResult, type EvidenceRecord, type ExperimentSpec, type Finding, type GateSpec,
  type OracleAssertion, type OracleCheck, type OracleSpec, type QualityDecision, type QualityVerdict, type Review, type ReviewerDecision,
  type TestArtifact,
} from '@hypertest/domain';
import type { EnvironmentFacts, GateInput } from './contracts.ts';
import { experimentValidity, type GateOperation } from './experiments.ts';
import { artifactEligibility, caseInFile, executedTestsOf, isBaseRevisionRun, sameTestFile, type ArtifactEligibility, type EligibilityContext } from './sensitivity.ts';

/**
 * The deterministic QualityGate (I7). Pure: the decision depends only on the input (no clock, no
 * randomness, stable ordering), so the same input always yields the same QualityDecision.
 *
 * Criteria, evaluated in order (each satisfied | violated | unknown):
 *   C0 oracle_in_force      – (conformance-1) unless gate.requireOracle is false: at least one approved oracle pinned by
 *                             the run with at least one deterministic P0/P1 assertion (a machine check other than an LLM
 *                             rubric); otherwise unknown — a run judged against no correctness criterion is never `pass`.
 *                             (D-7) An oracle is in force only when its revision is governed as the design states: at
 *                             least one authority (known kind, non-empty sourceRef), approvedBy non-empty, an
 *                             `expert_approved` authority approved by a human, agent approvers only when the change policy
 *                             lists `independent_agent`, selfApprove false. (D-10) A pinned revision superseded by a newer
 *                             approved one, or declared invalid, is unknown.
 *   C1 evidence_integrity   – ledger root count equals the evidence handed in, no foreign-run evidence, and
 *                             at least one ELIGIBLE evidence record (a pass with zero evidence, or with only
 *                             evidence from ineligible generated tests, is impossible). Not waivable.
 *                             Eligibility (D-0/D-1, re-derived — no stored score or state is trusted): a declared
 *                             testArtifactId must name an eligible artifact, and evidence carrying a `workspaceDelta`
 *                             (test.run) counts only when every test file added/modified since the base commit is covered by
 *                             an artifact with that exact digest whose whole lifecycle is re-derived from the cited evidence
 *                             and review records (sensitivity.ts `artifactEligibility`: bound static check, bound known-good
 *                             pass or an explicit unavailability reason, bound known-bad failure or bound mutation kill,
 *                             independent oracle consistency review against the oracles in force). Runs on the BASE revision
 *                             (known-good validation runs) are never evidence about the candidate.
 *   C2 unresolved_findings  – unresolved product/security/performance/unknown findings at or above
 *                             gate.failOnUnresolvedSeverity ⇒ violated (fail); unresolved test/infra/environment
 *                             findings at that severity ⇒ unknown (the evidence itself is in doubt). (D-11) A finding that
 *                             once was a blocking product finding and was cleared (downgraded, re-categorised, rejected,
 *                             accepted) by an AGENT is unknown unless deterministic evidence supports the clearing (its
 *                             oracleRef assertion is satisfied in C3): a reviewer or RCA cannot bypass the gate.
 *   C3 critical_oracles     – every approved P0/P1 oracle assertion needs deterministic supporting evidence;
 *                             a matching evidence that contradicts it ⇒ violated (fail); LLM-only/no support ⇒ unknown.
 *                             Only critical-eligible evidence decides (an artifact whose known-good run is merely
 *                             "unavailable" never supports nor violates a P0/P1 assertion); evidence of an ineligible
 *                             generated test can neither satisfy nor violate it (named in the detail, the assertion stays
 *                             unknown). (D-11) A failing case of an eligible artifact bound to the assertion through its
 *                             oracleRefs violates it ("critical test failed"), whatever the oracle's selector matches.
 *   C4 required_evidence    – gate.requiredEvidence + critical WorkItem.evidenceRequirements + (D-3) the
 *                             evidenceRequirements of every started experiment (counted on its own evidence) ⇒ missing ⇒
 *                             unknown.
 *   C5 failed_work          – failed or unfinished work items serving open P0/P1 objectives ⇒ unknown.
 *   C6 independent_review   – required by gate.requireIndependentReview OR (D-7) by the judgePolicy of an oracle in force:
 *                             reject ⇒ violated (conditional + human review); needs_more_evidence ⇒ unknown;
 *                             no independent approval ⇒ violated (conditional + human review).
 *   C7 unresolved_risks     – open risks at or above gate.conditionalOnRiskLevel ⇒ violated (conditional).
 *   C8 coverage             – latest coverage evidence below gate.minCoverage ⇒ violated (fail); none ⇒ unknown.
 *   C9 critical_claims      – (area-C-0) every critical report claim is EVALUATED (domain `evaluateClaim`: the
 *                             evidenceQuery aggregation over the cited evidence compared with the claimed value): no or
 *                             dangling evidence, an unevaluable claim, or a critical claim stating no value (its fact
 *                             only in the prose of the statement) ⇒ unknown; a value the evidence contradicts ⇒
 *                             violated (fail).
 *   C10 experiment_validity – (D-3/D-4/D-5) every experiment whose actions or evidence support the decision is valid
 *                             (experiments.ts `experimentValidity`): claims never lapsed and no foreign action on its
 *                             exclusive resources, environment generation unchanged, executed faults/load == declared plan,
 *                             no action after a met stop condition ⇒ otherwise violated (fail); evidence requirements
 *                             unmet, declared faults never executed, unverifiable actions ⇒ unknown. (D-10) An experiment
 *                             that ran under an oracle revision no longer in force is superseded: its evidence never
 *                             counts (any criterion it would have supported stays unproven until a NEW experiment re-runs
 *                             it) and it is not judged.
 *   C11 environment_validity– (D-11) the environments the run used are valid: registered, no unresolved P0–P2
 *                             environment finding, no generation drift not explained by the run's own verified
 *                             restarts/deploys, no environment operation in an uncertain state (failed, outcome_unknown,
 *                             reconciling, manual_review) ⇒ otherwise unknown.
 *   C12 domain_contracts    – (coverage-1) unless gate.requireContracts is false: the run has a SystemModel revision (with
 *                             at least one component) and every write/fault/load action belongs to an ExperimentSpec of the
 *                             run ⇒ otherwise unknown.
 * Verdict: fail-type violation ⇒ fail; else unknown ⇒ inconclusive; else conditional-type violation ⇒
 * conditional; else pass. Unexpired exceptions approved by a human/system actor waive a criterion (never C1); an agent
 * (reviewer, RCA …) can never waive anything.
 */

export const GATE_CRITERIA = [
  { id: 'C0', name: 'oracle_in_force', violation: 'fail' },
  { id: 'C1', name: 'evidence_integrity', violation: 'fail' },
  { id: 'C2', name: 'unresolved_findings', violation: 'fail' },
  { id: 'C3', name: 'critical_oracles', violation: 'fail' },
  { id: 'C4', name: 'required_evidence', violation: 'fail' },
  { id: 'C5', name: 'failed_work', violation: 'fail' },
  { id: 'C6', name: 'independent_review', violation: 'conditional' },
  { id: 'C7', name: 'unresolved_risks', violation: 'conditional' },
  { id: 'C8', name: 'coverage', violation: 'fail' },
  { id: 'C9', name: 'critical_claims', violation: 'fail' },
  { id: 'C10', name: 'experiment_validity', violation: 'fail' },
  { id: 'C11', name: 'environment_validity', violation: 'fail' },
  { id: 'C12', name: 'domain_contracts', violation: 'fail' },
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
  requireOracle: true,
  requireContracts: true,
});

const PRODUCT_CATEGORIES: ReadonlySet<Finding['category']> = new Set(['product_defect', 'security', 'performance', 'unknown']);

/** (D-7) The authority kinds of the design (§OracleSpec). */
export const ORACLE_AUTHORITY_KINDS: ReadonlySet<string> = new Set(['formal_spec', 'approved_requirement', 'business_rule', 'known_good_reference', 'differential_reference', 'expert_approved']);

/** Operation states after which the environment's state is uncertain (C11). */
const UNCERTAIN_OPERATION_STATES: ReadonlySet<string> = new Set(['failed', 'outcome_unknown', 'reconciling', 'manual_review']);

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

/**
 * Restricts evidence to the build of the most recent record (by ledger seq). A record without a build identity (no
 * build digest, no commit: e.g. a request to a URL that names no registered environment) cannot say which build it is
 * about: it belongs to the build that was current when it was recorded (that of the latest identified record before
 * it). So it never becomes "the latest build" on its own and hides the failures recorded on the current build — it is
 * judged with them; evidence recorded before any identified build belongs to none (''). Without identified evidence,
 * everything is judged.
 */
function latestBuild(evs: readonly EvidenceRecord[]): EvidenceRecord[] {
  if (evs.length === 0) return [];
  const attributed = new Map<EvidenceRecord, string>();
  let current = '';
  for (const e of [...evs].sort((a, b) => a.seq - b.seq)) {
    const own = buildKey(e);
    if (own !== '') current = own;
    attributed.set(e, own !== '' ? own : current);
  }
  const newest = evs.reduce((m, e) => (e.seq > m.seq ? e : m));
  const key = attributed.get(newest)!;
  return evs.filter((e) => attributed.get(e) === key);
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

/** Outcome of one machine-checkable oracle check against evidence (see evaluateOracleCheck). */
export type OracleCheckOutcome = { status: 'satisfied' | 'violated' | 'unknown'; refs: string[]; detail: string };
type CheckOutcome = OracleCheckOutcome;

/**
 * (exported) The QualityGate's own evaluator of one oracle check (C3), so other deterministic consumers — e.g. the
 * oracle-change flip detector asking "does the recorded evidence violate the BASE assertion and satisfy the proposed
 * one?" — judge with exactly the gate's semantics instead of a re-implementation that drifts: `test_outcome` (case
 * selector; failed/xfail ⇒ violated, error ⇒ unknown), `evidence_predicate`, `metric_threshold` (metric/aggregation
 * lookup), `http_expectation`, each on the evidence of the latest build; `llm_rubric` ⇒ always unknown. Pure; the
 * caller decides which evidence is eligible (the gate passes only gate-eligible evidence).
 */
export function evaluateOracleCheck(check: OracleCheck, evidence: readonly EvidenceRecord[]): OracleCheckOutcome {
  return evaluateCheck(check, evidence);
}

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

/**
 * (D-7) Why an approved oracle revision is not governed as the design requires (empty: it is): authorities present with
 * known kinds and non-empty source refs, approvedBy non-empty, an `expert_approved` authority approved by a human, an agent
 * approver only when the change policy accepts independent agents, selfApprove false.
 */
export function oracleAuthorityProblems(o: OracleSpec): string[] {
  const out: string[] = [];
  const authorities = Array.isArray(o.authorities) ? o.authorities : [];
  if (authorities.length === 0) out.push('it names no authority (formal spec, approved requirement, business rule, reference, expert)');
  for (const a of authorities) {
    if (!a || typeof a.sourceRef !== 'string' || a.sourceRef.trim() === '') out.push('an authority has no sourceRef');
    else if (!ORACLE_AUTHORITY_KINDS.has(a.authority)) out.push(`authority ${a.sourceRef} has an unknown kind ${String(a.authority)}`);
  }
  const approvedBy = Array.isArray(o.approvedBy) ? o.approvedBy : [];
  if (approvedBy.length === 0) out.push('it records no approver (approvedBy is empty)');
  if (authorities.some((a) => a?.authority === 'expert_approved') && !approvedBy.some((a) => a.kind === 'human')) out.push('an expert_approved authority requires a human approver');
  if (approvedBy.some((a) => a.kind === 'agent') && !(o.changePolicy?.approvers ?? []).includes('independent_agent')) out.push('it was approved by an agent but its change policy accepts no agent approver');
  if (o.changePolicy?.selfApprove !== false) out.push('its change policy allows self-approval');
  return out;
}

/** The experiment an evidence record was produced for (`provenance.experimentId`). */
function experimentOf(e: EvidenceRecord): string | undefined {
  const id = (e.provenance as { experimentId?: unknown } | undefined)?.experimentId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function latestArtifacts(artifacts: readonly TestArtifact[]): Map<string, TestArtifact> {
  const m = new Map<string, TestArtifact>();
  for (const a of artifacts) {
    const prev = m.get(a.artifactId);
    if (!prev || a.revision > prev.revision) m.set(a.artifactId, a);
  }
  return m;
}

interface Eligibility {
  /** Why the record does not count (undefined: it counts). */
  problem?: string;
  /** It may support or violate a P0/P1 assertion. */
  critical: boolean;
}

/**
 * conformance-2 / D-0: eligibility of evidence from its recorded `workspaceDelta` (written by test.run from the workspace
 * itself — a derived linkage, never a caller claim). Every test file added or modified since the base commit must be
 * covered by the LATEST revision of an artifact with exactly that content digest whose lifecycle is re-derived as complete
 * (a changed "existing" file is judged as generated); an unavailable delta counts only for a read-only workspace (agents
 * cannot have written tests there). Evidence without a delta (other producers) is not judged here.
 */
function deltaEligibility(e: EvidenceRecord, byDigest: ReadonlyMap<string, TestArtifact[]>, judge: (a: TestArtifact, changed: boolean) => ArtifactEligibility): Eligibility {
  const delta = getField(e.structured, 'workspaceDelta');
  if (delta === undefined) return { critical: true };
  if (delta === null || typeof delta !== 'object' || Array.isArray(delta)) return { problem: 'malformed workspace delta', critical: false };
  const d = delta as Record<string, JsonValue>;
  if (d['status'] !== 'computed') {
    return d['readOnly'] === true ? { critical: true } : { problem: `workspace delta unavailable (${String(d['reason'] ?? 'unknown')}): the tests that ran cannot be tied to the base commit or to validated artifacts`, critical: false };
  }
  if (d['testFilesTruncated'] === true) return { problem: 'too many changed test files to verify', critical: false };
  const listed = d['testFiles'];
  if (!Array.isArray(listed)) return { problem: 'malformed workspace delta (no testFiles)', critical: false };
  // every changed test file is judged (a run may load more than it reports); the files the run EXECUTED are judged first,
  // so the problem names the test that actually ran
  const executed = (executedTestsOf(e)?.files ?? []).map((f) => f.path);
  const ran = (f: JsonValue): boolean => {
    const path = f !== null && typeof f === 'object' && !Array.isArray(f) ? (f as Record<string, JsonValue>)['path'] : undefined;
    return typeof path === 'string' && executed.some((x) => sameTestFile(x, path));
  };
  const files = [...listed.filter(ran), ...listed.filter((f) => !ran(f))];
  let critical = true;
  for (const f of files) {
    if (f === null || typeof f !== 'object' || Array.isArray(f)) return { problem: 'malformed workspace delta entry', critical: false };
    const { path, change, sha256 } = f as Record<string, JsonValue>;
    if (change === 'deleted') continue;
    if (typeof sha256 !== 'string' || sha256 === '') return { problem: `test file ${String(path)} (${String(change)}) has no content digest`, critical: false };
    const candidates = byDigest.get(sha256) ?? [];
    const judged = candidates.map((a) => judge(a, true));
    const covering = judged.filter((j) => j.eligible);
    if (covering.length === 0) {
      const why = judged.length === 0
        ? 'no test artifact has its content'
        : `its artifact ${candidates.map((a) => `${a.artifactId}@${a.revision}`).join(', ')} is not eligible: ${judged.flatMap((j) => j.reasons).slice(0, 3).join('; ')}`;
      return { problem: `test file ${String(path)} is ${String(change)} since the base commit and ${why} (sha256 ${sha256.slice(0, 12)})`, critical: false };
    }
    if (!covering.some((j) => j.criticalSupport)) critical = false;
  }
  return { critical };
}

function envIdOfResource(key: string): string | undefined {
  return key.startsWith('env/') ? key.slice(4).split('/')[0] : undefined;
}

export class QualityGate {
  evaluate(input: GateInput): QualityDecision {
    const { run, gate } = input;
    const allEvidence = [...input.evidence].sort((a, b) => a.seq - b.seq || byString(a.evidenceId, b.evidenceId));
    const runEvidence = allEvidence.filter((e) => e.runId === run.runId);
    const evidenceIds = new Set(runEvidence.map((e) => e.evidenceId));
    const evidenceById = new Map(runEvidence.map((e) => [e.evidenceId, e]));
    const allReviews = input.reviews.filter((r) => r.runId === run.runId);

    // ------------------------------------------------------------------------------------- oracles in force (C0, D-7)
    const authorityProblems = new Map<string, string[]>();
    for (const o of currentOracles(input.oracles)) {
      const p = oracleAuthorityProblems(o);
      if (p.length > 0) authorityProblems.set(o.oracleId, p);
    }
    const invalidated = new Map<string, OracleSpec>();
    for (const o of input.oracles) {
      const pinned = run.oracleRevisions?.[o.oracleId];
      if (o.status === 'invalid' && (pinned === undefined || o.revision > pinned)) {
        const prev = invalidated.get(o.oracleId);
        if (!prev || o.revision > prev.revision) invalidated.set(o.oracleId, o);
      }
    }
    /** Approved, governed and not declared invalid: the oracles C3 judges and artifacts must be consistent with. */
    const oraclesInForce = currentOracles(input.oracles).filter((o) => !authorityProblems.has(o.oracleId) && !invalidated.has(o.oracleId));

    // ------------------------------------------------------------------------------------- eligibility (C1, D-0/D-1)
    // Evidence from generated tests that did not complete their lifecycle does not count (nor does evidence pointing at an
    // unknown artifact, nor evidence of a run over new/changed test files no eligible artifact covers, nor a known-good
    // validation run on the base revision). Every stage is re-derived from the cited evidence and review records.
    // (D-10, review) experiments that ran under an oracle revision no longer in force: their evidence was gathered for a
    // replaced criterion — it never decides the verdict (re-run as a NEW experiment), and the experiment is not judged (C10)
    const experiments = latestExperiments(input.experiments.filter((x) => x.runId === undefined || x.runId === run.runId));
    const supersededExperiments = new Map<string, string>();
    for (const x of experiments) {
      for (const ref of x.oracleRefs ?? []) {
        const cur = oraclesInForce.find((o) => o.oracleId === ref.oracleId);
        if (cur && cur.revision !== ref.revision) {
          supersededExperiments.set(x.experimentId, `it ran under oracle ${ref.oracleId} revision ${ref.revision}; revision ${cur.revision} is in force`);
          break;
        }
      }
    }
    const supersededEvidence: string[] = [];

    const artifacts = latestArtifacts(input.testArtifacts);
    const eligibilityCtx: EligibilityContext = { evidence: evidenceById, reviews: allReviews, oraclesInForce, ...(run.target?.baseCommit !== undefined ? { baseCommit: run.target.baseCommit } : {}) };
    const memo = new Map<string, ArtifactEligibility>();
    const judge = (a: TestArtifact, changed: boolean): ArtifactEligibility => {
      const key = `${a.artifactId}@${a.revision}:${changed}`;
      let j = memo.get(key);
      if (!j) {
        j = artifactEligibility(changed && a.sourceType === 'existing' ? { ...a, sourceType: 'generated' } : a, eligibilityCtx);
        memo.set(key, j);
      }
      return j;
    };
    const byDigest = new Map<string, TestArtifact[]>();
    for (const a of artifacts.values()) byDigest.set(a.artifactDigest, [...(byDigest.get(a.artifactDigest) ?? []), a]);
    const ignored: string[] = [];
    const ineligible: EvidenceRecord[] = [];
    const validationOnly: string[] = [];
    const criticalOk = new Set<string>();
    const eligible = runEvidence.filter((e) => {
      const xid = experimentOf(e);
      if (xid !== undefined && supersededExperiments.has(xid)) {
        supersededEvidence.push(`${e.evidenceId} (experiment ${xid}: ${supersededExperiments.get(xid)!})`);
        return false;
      }
      if (isBaseRevisionRun(e)) {
        validationOnly.push(e.evidenceId);
        return false;
      }
      const d = deltaEligibility(e, byDigest, judge);
      if (d.problem !== undefined) {
        ignored.push(`${e.evidenceId} (${d.problem})`);
        ineligible.push(e);
        return false;
      }
      let critical = d.critical;
      const id = getField(e.structured, 'testArtifactId');
      if (id !== undefined) {
        const a = typeof id === 'string' ? artifacts.get(id) : undefined;
        const j = a ? judge(a, false) : undefined;
        if (!j || !j.eligible) {
          ignored.push(`${e.evidenceId} (test artifact ${String(id)} ${a ? `not eligible: ${j!.reasons.slice(0, 3).join('; ')}` : 'unknown'})`);
          ineligible.push(e);
          return false;
        }
        if (!j.criticalSupport) critical = false;
      }
      if (critical) criticalOk.add(e.evidenceId);
      return true;
    });
    const criticalEligible = eligible.filter((e) => criticalOk.has(e.evidenceId));

    const findingHistory = input.findings.filter((r) => r.runId === run.runId);
    const findings = currentRecords(findingHistory);
    const risks = currentRecords(input.risks).filter((r) => r.runId === run.runId);
    const reviews = currentRecords(allReviews);
    const operations = input.operations;

    const outcomes = new Map<CriterionId, Outcome>();

    // C0 oracle_in_force (conformance-1, D-7, D-10): the run is judged against a governed, deterministic correctness criterion
    {
      const superseded = Object.entries(run.oracleRevisions ?? {}).filter(([id, rev]) => {
        const current = input.currentOracleRevisions?.[id];
        return current !== undefined && current > rev;
      });
      const declaredInvalid = [...invalidated.values()].filter((o) => Object.hasOwn(run.oracleRevisions ?? {}, o.oracleId));
      if (superseded.length > 0) {
        // conformance-4: an oracle approved in a new revision during the run replaces the criterion this run pinned
        outcomes.set('C0', {
          status: 'unknown',
          evidenceRefs: [],
          detail: `${superseded.map(([id, rev]) => `oracle ${id} revision ${rev} is superseded by approved revision ${input.currentOracleRevisions![id]}`).join('; ')}: the verdict would rest on a replaced criterion — re-evaluate under the new revision (the control plane re-pins the run and replans)`,
          reasons: ['a pinned oracle was superseded during the run'],
        });
      } else if (declaredInvalid.length > 0) {
        outcomes.set('C0', {
          status: 'unknown',
          evidenceRefs: [],
          detail: declaredInvalid.map((o) => `oracle ${o.oracleId} revision ${o.invalidation?.revision ?? o.supersedes ?? '?'} was declared invalid (${o.invalidation?.reason ?? 'no reason recorded'})`).join('; '),
          reasons: ['a pinned oracle was declared invalid: re-judge under an approved revision'],
        });
      } else if (gate.requireOracle === false) {
        outcomes.set('C0', { status: 'satisfied', evidenceRefs: [], detail: 'no oracle required by the gate (gate.requireOracle false: a recorded override)', reasons: ['gate.requireOracle is false: the verdict rests on no oracle'] });
      } else {
        const pinnedAll = currentOracles(input.oracles).filter((o) => run.oracleRevisions?.[o.oracleId] === o.revision);
        const ungoverned = pinnedAll.filter((o) => authorityProblems.has(o.oracleId));
        const pinned = pinnedAll.filter((o) => !authorityProblems.has(o.oracleId));
        const critical = pinned.flatMap((o) =>
          o.assertions
            .filter((a) => SEVERITY_ORDER[a.severity] <= SEVERITY_ORDER.P1 && a.check !== undefined && a.check.type !== 'llm_rubric' && a.kind !== 'llm_semantic')
            .map((a) => `${o.oracleId}/${a.assertionId}`),
        );
        const ungovernedReasons = ungoverned.map((o) => `oracle ${o.oracleId}@${o.revision} is not in force: ${authorityProblems.get(o.oracleId)!.join('; ')}`);
        outcomes.set(
          'C0',
          critical.length > 0
            ? { status: 'satisfied', evidenceRefs: [], detail: `${critical.length} deterministic P0/P1 assertion(s) in force: ${critical.slice(0, 10).join(', ')}`, reasons: ungovernedReasons }
            : {
                status: 'unknown',
                evidenceRefs: [],
                detail: pinnedAll.length === 0 ? 'no approved oracle is pinned by the run' : pinned.length === 0 ? `the pinned oracles are not governed as required: ${ungovernedReasons.join('; ')}` : `the pinned oracles (${pinned.map((o) => o.oracleId).join(', ')}) have no deterministic P0/P1 assertion`,
                reasons: ['no oracle in force: establish one (human authority) and pin it to the run — correctness is never decided by the agents', ...ungovernedReasons],
              },
        );
      }
    }

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
        reasons.push(`no eligible evidence: none of the ${runEvidence.length} run evidence records is evidence about the candidate from an eligible source (ineligible generated tests, base-revision validation runs, experiments under a superseded oracle revision)`);
      }
      outcomes.set('C1', { status, evidenceRefs: [], detail: status === 'satisfied' ? `${allEvidence.length} evidence records match root ${input.evidenceRoot.rootHash}` : reasons.join('; '), reasons });
    }

    // C3 critical_oracles (evaluated before C2: a cleared critical finding may rest on its satisfied assertion)
    const assertionStatus = new Map<string, CriterionResult['status']>();
    {
      const reasons: string[] = [];
      const refs: string[] = [];
      let violated = 0;
      let unknown = 0;
      let checked = 0;
      const eligibleArtifacts = [...artifacts.values()].filter((a) => judge(a, a.sourceType !== 'existing').criticalSupport);
      for (const o of oraclesInForce) {
        const deterministicRequired = gate.requireDeterministicForCritical || o.judgePolicy.deterministicRequiredForCritical || !o.judgePolicy.allowLlmOnlyDecision;
        for (const a of [...o.assertions].sort((x, y) => byString(x.assertionId, y.assertionId))) {
          if (SEVERITY_ORDER[a.severity] > SEVERITY_ORDER.P1) continue;
          const label = `${o.oracleId}@${o.revision}/${a.assertionId} (${a.severity})`;
          const key = `${o.oracleId}/${a.assertionId}`;
          checked++;
          if (isLlmOnly(a)) {
            if (deterministicRequired) {
              unknown++;
              assertionStatus.set(key, 'unknown');
              reasons.push(a.check === undefined ? `${label}: no machine-checkable check; deterministic evidence required` : `${label}: only LLM/semantic support; deterministic evidence required`);
            } else reasons.push(`${label}: LLM-only assertion not gate-evaluable (allowed by gate and oracle policy)`);
            continue;
          }
          let r = evaluateCheck(a.check!, criticalEligible);
          // D-11 "critical test failed": an eligible artifact bound to this assertion whose own cases failed on the latest build
          const bound = eligibleArtifacts.filter((t) => t.oracleRefs.some((ref) => ref.oracleId === o.oracleId && ref.revision === o.revision && ref.assertionIds.includes(a.assertionId)));
          if (bound.length > 0) {
            const tests = latestBuild(criticalEligible.filter((e) => e.evidenceType === 'test-result'));
            const failures: Array<{ ref: string; path: string }> = [];
            for (const t of bound) {
              for (const e of tests) {
                const cases = getField(e.structured, 'cases');
                if (!Array.isArray(cases)) continue;
                if (cases.some((c) => caseInFile(c, t.path) && ['failed', 'xfail'].includes(String((c as CaseLike).status)))) failures.push({ ref: e.evidenceId, path: t.path });
              }
            }
            if (failures.length > 0) r = { status: 'violated', refs: uniqSorted(failures.map((f) => f.ref)), detail: `test artifact(s) bound to this assertion failed: ${uniqSorted(failures.map((f) => f.path)).join(', ')}` };
          }
          refs.push(...r.refs);
          assertionStatus.set(key, r.status);
          if (r.status === 'violated') {
            violated++;
            reasons.push(`${label} violated: ${r.detail}`);
          } else if (r.status === 'unknown') {
            unknown++;
            // evidence that is not critical-eligible never decides; say which records would have
            const shadow = evaluateCheck(a.check!, [...ineligible, ...eligible.filter((e) => !criticalOk.has(e.evidenceId))]);
            const note = shadow.status !== 'unknown' ? ` (ignored: ${shadow.refs.join(', ')} from ineligible or non-critical generated tests would have ${shadow.status === 'violated' ? 'violated' : 'satisfied'} it — they neither satisfy nor violate a critical assertion)` : '';
            reasons.push(`${label} unproven: ${r.detail}${note}`);
          }
        }
      }
      const status: Outcome['status'] = violated ? 'violated' : unknown ? 'unknown' : 'satisfied';
      outcomes.set('C3', { status, evidenceRefs: uniqSorted(refs), detail: `${checked} critical assertions: ${violated} violated, ${unknown} unproven`, reasons });
    }

    // C2 unresolved_findings
    const unresolvedFindings: string[] = [];
    {
      const reasons: string[] = [];
      // (H3) fail closed on a threshold the gate cannot interpret: every unresolved finding blocks, and C2 is at best unknown
      const thresholdKnown = typeof gate.failOnUnresolvedSeverity === 'string' && Object.hasOwn(SEVERITY_ORDER, gate.failOnUnresolvedSeverity);
      const threshold = thresholdKnown ? gate.failOnUnresolvedSeverity : 'P3';
      if (!thresholdKnown) reasons.push(`gate.failOnUnresolvedSeverity ${JSON.stringify(gate.failOnUnresolvedSeverity)} is not a severity (${Object.keys(SEVERITY_ORDER).join(', ')}): every unresolved finding blocks`);
      const blocks = (f: Finding) => isUnresolvedFinding(f) && atLeastAsSevere(f.severity, threshold);
      const blocking = findings.filter((r) => blocks(r.payload));
      const product = blocking.filter((r) => PRODUCT_CATEGORIES.has(r.payload.category));
      const infra = blocking.filter((r) => !PRODUCT_CATEGORIES.has(r.payload.category));
      for (const r of product) {
        unresolvedFindings.push(r.recordId);
        reasons.push(`unresolved ${r.payload.severity} ${r.payload.category} finding ${r.recordId}: ${r.payload.title}`);
        if (r.evidenceRefs.length === 0) reasons.push(`unevidenced finding ${r.recordId} (still blocking)`);
      }
      for (const r of infra) reasons.push(`unresolved ${r.payload.severity} ${r.payload.category} finding ${r.recordId} casts doubt on the evidence: ${r.payload.title}`);
      // D-11: a blocking product finding cleared by an agent without deterministic support stays in doubt
      const blockingLineages = new Set(product.map((r) => r.lineageId));
      const cleared: Array<BlackboardRecord<Finding>> = [];
      for (const cur of findings) {
        if (blocks(cur.payload) && PRODUCT_CATEGORIES.has(cur.payload.category)) continue;
        const history = findingHistory.filter((r) => r.lineageId === cur.lineageId);
        if (!history.some((r) => blocks(r.payload) && PRODUCT_CATEGORIES.has(r.payload.category))) continue;
        if (/^(human|system):/.test(cur.createdBy)) continue;
        if (cur.payload.status === 'duplicate' && cur.payload.duplicateOf !== undefined) {
          // a duplicate of a finding that still blocks keeps the defect represented
          const target = findingHistory.find((r) => r.recordId === cur.payload.duplicateOf);
          if (target && blockingLineages.has(target.lineageId)) continue;
        }
        const ref = cur.payload.oracleRef;
        if (ref?.assertionId !== undefined && assertionStatus.get(`${ref.oracleId}/${ref.assertionId}`) === 'satisfied') continue;
        cleared.push(cur);
        reasons.push(`finding ${cur.recordId} was a blocking product finding and was cleared by agent ${cur.createdBy} (now ${cur.payload.severity} ${cur.payload.category} ${cur.payload.status}) without deterministic support: needs a satisfied oracle assertion (oracleRef) or a human decision`);
      }
      const status: Outcome['status'] = product.length ? 'violated' : infra.length || cleared.length || !thresholdKnown ? 'unknown' : 'satisfied';
      outcomes.set('C2', {
        status,
        evidenceRefs: uniqSorted([...product, ...infra, ...cleared].flatMap((r) => r.evidenceRefs)),
        detail:
          status === 'satisfied'
            ? `no unresolved findings at or above ${threshold}`
            : !thresholdKnown && product.length + infra.length + cleared.length === 0
              ? `unknown severity threshold ${JSON.stringify(gate.failOnUnresolvedSeverity)}`
              : `${product.length} product and ${infra.length} test/infrastructure findings unresolved${cleared.length ? `, ${cleared.length} critical finding(s) cleared by an agent without deterministic support` : ''}`,
        reasons,
      });
    }

    // experiments in scope: started (an action or evidence of their own)
    const experimentEvidence = new Map<string, EvidenceRecord[]>();
    for (const e of runEvidence) {
      const x = experimentOf(e);
      if (x !== undefined) experimentEvidence.set(x, [...(experimentEvidence.get(x) ?? []), e]);
    }
    const startedAll = experiments.filter((x) => (experimentEvidence.get(x.experimentId)?.length ?? 0) > 0 || (operations ?? []).some((o) => o.experimentId === x.experimentId));
    const started = startedAll.filter((x) => !supersededExperiments.has(x.experimentId));

    // C4 required_evidence
    {
      const reasons: string[] = [];
      const refs: string[] = [];
      let missing = 0;
      const reqs: Array<{ label: string; type: string; min: number; workItemId?: string; experimentId?: string }> = [];
      for (const r of gate.requiredEvidence) reqs.push({ label: `gate requires ${r.minCount}× ${r.evidenceType}`, type: r.evidenceType, min: r.minCount });
      for (const w of [...input.workItems].sort((a, b) => byString(a.workItemId, b.workItemId))) {
        if (w.state === 'cancelled') continue;
        for (const r of w.evidenceRequirements) {
          if (r.critical === true) reqs.push({ label: `work item ${w.workItemId} requires ${r.minCount}× ${r.evidenceType}`, type: r.evidenceType, min: r.minCount, workItemId: w.workItemId });
        }
      }
      for (const x of started) {
        for (const r of x.evidenceRequirements ?? []) reqs.push({ label: `experiment ${x.experimentId} requires ${r.minCount}× ${r.evidenceType}`, type: r.evidenceType, min: r.minCount, experimentId: x.experimentId });
      }
      for (const q of reqs) {
        const found = eligible.filter((e) => e.evidenceType === q.type && (q.workItemId === undefined || e.workItemId === q.workItemId) && (q.experimentId === undefined || experimentOf(e) === q.experimentId));
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
      // D-7: an oracle in force whose judgePolicy requires an independent reviewer requires it whatever the gate says
      const requiredBy = oraclesInForce.filter((o) => o.judgePolicy?.independentReviewerRequired === true).map((o) => `${o.oracleId}@${o.revision}`);
      const required = gate.requireIndependentReview || requiredBy.length > 0;
      if (!gate.requireIndependentReview && requiredBy.length > 0) reasons.push(`independent review required by the judgePolicy of oracle ${requiredBy.join(', ')} (the gate's requireIndependentReview false does not override an oracle's judge policy)`);
      let outcome: Outcome;
      if (!required) {
        outcome = { status: 'satisfied', evidenceRefs: [], detail: 'independent review not required by the gate or any oracle in force', reasons: [] };
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
      // (H3) an uninterpretable risk level fails closed: every open risk counts, and C7 is at best unknown
      const levelKnown = typeof gate.conditionalOnRiskLevel === 'string' && Object.hasOwn(RISK_ORDER, gate.conditionalOnRiskLevel);
      const level = levelKnown ? gate.conditionalOnRiskLevel : 'low';
      if (!levelKnown) reasons.push(`gate.conditionalOnRiskLevel ${JSON.stringify(gate.conditionalOnRiskLevel)} is not a risk level (${Object.keys(RISK_ORDER).join(', ')}): every open risk counts`);
      const open = risks.filter((r) => r.payload.status === 'open' && RISK_ORDER[r.payload.level] >= RISK_ORDER[level]);
      for (const r of open) {
        unresolvedRisks.push(r.recordId);
        reasons.push(`open ${r.payload.level} risk ${r.recordId}: ${r.payload.title}`);
      }
      outcomes.set('C7', {
        status: open.length ? 'violated' : levelKnown ? 'satisfied' : 'unknown',
        evidenceRefs: uniqSorted(open.flatMap((r) => r.evidenceRefs)),
        detail: open.length ? `${open.length} open risks at or above ${level}` : levelKnown ? `no open risks at or above ${level}` : `unknown risk level ${JSON.stringify(gate.conditionalOnRiskLevel)}`,
        reasons,
      });
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

    // C9 critical_claims (area-C-0): every critical claim is evaluated against its evidence
    {
      const reasons: string[] = [];
      const refs: string[] = [];
      let unknownClaims = 0;
      let contradicted = 0;
      const data = new Map(Object.entries(input.claimData ?? {}));
      for (const c of [...input.claims].sort((a, b) => byString(a.claimId, b.claimId))) {
        const cited = (c.evidenceRefs ?? []).filter((r) => evidenceIds.has(r));
        const dangling = (c.evidenceRefs ?? []).filter((r) => !evidenceIds.has(r));
        const evaluation = dangling.length === 0 && cited.length > 0 ? evaluateClaim(c, cited.map((r) => evidenceById.get(r)!), data) : undefined;
        if (!c.critical) {
          if (evaluation?.status === 'mismatch') reasons.push(`(non-critical) claim ${c.claimId} contradicts its evidence: ${evaluation.detail}`);
          continue;
        }
        if ((c.evidenceRefs ?? []).length === 0) {
          unknownClaims++;
          reasons.push(`critical claim ${c.claimId} has no evidence: ${c.statement}`);
          continue;
        }
        if (dangling.length) {
          unknownClaims++;
          reasons.push(`critical claim ${c.claimId} cites unknown evidence ${dangling.join(', ')}`);
          continue;
        }
        refs.push(...cited);
        if (evaluation?.status === 'mismatch') {
          contradicted++;
          reasons.push(`critical claim ${c.claimId} ("${c.statement}") is contradicted by its evidence: ${evaluation.detail}`);
        } else if (evaluation?.status === 'unevaluable') {
          unknownClaims++;
          reasons.push(`critical claim ${c.claimId} cannot be evaluated: ${evaluation.detail}`);
        } else if (evaluation?.status === 'reference') {
          // a critical claim whose fact lives only in the prose of its statement is not machine-verifiable
          unknownClaims++;
          reasons.push(`critical claim ${c.claimId} ("${c.statement}") states no value to evaluate against its evidence: a statement alone is not verifiable`);
        }
      }
      const status: Outcome['status'] = contradicted ? 'violated' : unknownClaims ? 'unknown' : 'satisfied';
      outcomes.set('C9', {
        status,
        evidenceRefs: uniqSorted(refs),
        detail: status === 'satisfied' ? 'every critical claim is supported by its evaluated evidence' : `${contradicted} critical claim(s) contradicted, ${unknownClaims} without evaluable evidence`,
        reasons,
      });
    }

    // C10 experiment_validity (D-3/D-4/D-5)
    {
      const reasons: string[] = [];
      let violated = 0;
      let unknown = 0;
      const refs: string[] = [];
      for (const x of started) {
        if (operations === undefined) {
          unknown++;
          reasons.push(`experiment ${x.experimentId}: the run's actions were not supplied; its validity cannot be judged`);
          continue;
        }
        const facts = input.experimentFacts?.find((f) => f.experimentId === x.experimentId);
        const env = input.environments?.find((e) => e.environmentId === x.environment?.environmentId);
        const v = experimentValidity({
          spec: x, evidence: experimentEvidence.get(x.experimentId) ?? [], operations, ...(facts ? { facts } : {}), oraclesInForce,
          ...(env?.dedicated !== undefined ? { environmentDedicated: env.dedicated } : {}), now: input.now,
        });
        refs.push(...(experimentEvidence.get(x.experimentId) ?? []).map((e) => e.evidenceId));
        if (v.violations.length) violated++;
        else if (v.unknowns.length) unknown++;
        for (const m of v.violations) reasons.push(`experiment ${x.experimentId} invalid: ${m}`);
        for (const m of v.unknowns) reasons.push(`experiment ${x.experimentId} unproven: ${m}`);
      }
      const superseded = startedAll.filter((x) => supersededExperiments.has(x.experimentId));
      for (const x of superseded) reasons.push(`experiment ${x.experimentId} is superseded (${supersededExperiments.get(x.experimentId)!}): not judged, its evidence does not count — re-run it as a new experiment under the revision in force`);
      const status: Outcome['status'] = violated ? 'violated' : unknown ? 'unknown' : 'satisfied';
      outcomes.set('C10', {
        status,
        evidenceRefs: uniqSorted(refs),
        detail: started.length === 0 ? `no experiment ran${superseded.length ? ` under the oracle revisions in force (${superseded.length} superseded)` : ''}` : `${started.length} experiment(s): ${violated} invalid, ${unknown} unproven${superseded.length ? `; ${superseded.length} superseded` : ''}`,
        reasons,
      });
    }

    // C11 environment_validity (D-11)
    {
      const reasons: string[] = [];
      const used = new Set<string>();
      for (const e of runEvidence) if (e.environment?.environmentId) used.add(e.environment.environmentId);
      for (const x of experiments) {
        const id = x.environment?.environmentId;
        if (id !== undefined && (id !== 'local' || input.environments?.some((f) => f.environmentId === 'local'))) used.add(id);
      }
      if (run.target.environmentId !== undefined) used.add(run.target.environmentId);
      for (const o of operations ?? []) {
        const id = envIdOfResource(o.resourceKey);
        if (id !== undefined) used.add(id);
      }
      let problems = 0;
      if (used.size > 0 && input.environments === undefined) {
        problems++;
        reasons.push(`the environment registry's view was not supplied: ${[...used].sort().join(', ')} cannot be checked`);
      }
      for (const id of [...used].sort()) {
        if (input.environments === undefined) break;
        const facts: EnvironmentFacts | undefined = input.environments.find((f) => f.environmentId === id);
        if (!facts || !facts.registered) {
          problems++;
          reasons.push(`environment ${id} is not registered: its state cannot be established`);
          continue;
        }
        const gens = runEvidence.filter((e) => e.environment?.environmentId === id).map((e) => e.environment!.generation);
        for (const x of experiments) if (x.environment?.environmentId === id && typeof x.environment.generation === 'number') gens.push(x.environment.generation);
        if (gens.length > 0 && facts.generation !== undefined) {
          const gMin = Math.min(...gens);
          const gMax = Math.max(...gens, facts.generation);
          const explained = (operations ?? []).filter((o) => (o.toolId === 'env.restart' || o.toolId === 'env.deploy') && o.status === 'verified' && envIdOfResource(o.resourceKey) === id).length;
          if (gMax - gMin > explained) {
            problems++;
            reasons.push(`environment ${id} drifted during the run: generation ${gMin} → ${gMax} but the run itself verified only ${explained} restart/deploy(s)`);
          }
        }
      }
      for (const o of operations ?? []) {
        if (!o.toolId.startsWith('env.') || !UNCERTAIN_OPERATION_STATES.has(o.status)) continue;
        problems++;
        reasons.push(`${o.toolId} operation ${o.operationId} on ${o.resourceKey} is ${o.status}: the environment's state is uncertain`);
      }
      const envFindings = findings.filter((r) => r.payload.category === 'environment' && isUnresolvedFinding(r.payload) && SEVERITY_ORDER[r.payload.severity] <= SEVERITY_ORDER.P2);
      for (const r of envFindings) {
        problems++;
        reasons.push(`unresolved ${r.payload.severity} environment finding ${r.recordId}: ${r.payload.title}`);
      }
      outcomes.set('C11', {
        status: problems ? 'unknown' : 'satisfied',
        evidenceRefs: uniqSorted(envFindings.flatMap((r) => r.evidenceRefs)),
        detail: problems ? `${problems} environment problem(s)` : used.size === 0 ? 'no environment in use' : `environments valid: ${[...used].sort().join(', ')}`,
        reasons,
      });
    }

    // C12 domain_contracts (coverage-1)
    {
      const reasons: string[] = [];
      if (gate.requireContracts === false) {
        outcomes.set('C12', { status: 'satisfied', evidenceRefs: [], detail: 'domain contracts not required by the gate (gate.requireContracts false: a recorded override)', reasons: ['gate.requireContracts is false: the verdict may rest on no SystemModel / no ExperimentSpec'] });
      } else {
        const sm = input.systemModel;
        if (run.systemModelRevision === undefined || !sm) reasons.push('the run has no SystemModel revision: record the system under test (system_model.record) before judging it');
        else if (sm.revision !== run.systemModelRevision) reasons.push(`the run names SystemModel revision ${run.systemModelRevision} but revision ${sm.revision} was supplied`);
        else if (!Array.isArray(sm.components) || sm.components.length === 0) reasons.push(`SystemModel ${sm.systemModelId}@${sm.revision} has no component`);
        if (operations === undefined) reasons.push("the run's write/fault/load actions were not supplied: their ExperimentSpecs cannot be checked");
        else {
          const known = new Set(experiments.map((x) => x.experimentId));
          const loose = operations.filter((o) => o.experimentId === undefined || !known.has(o.experimentId));
          for (const o of loose.slice(0, 10)) reasons.push(`${o.toolId} operation ${o.operationId} (${o.effect}) on ${o.resourceKey} ${o.experimentId === undefined ? 'belongs to no ExperimentSpec' : `names unknown experiment ${o.experimentId}`}`);
          if (loose.length > 10) reasons.push(`… and ${loose.length - 10} more action(s) without an ExperimentSpec`);
        }
        outcomes.set('C12', {
          status: reasons.length ? 'unknown' : 'satisfied',
          evidenceRefs: [],
          detail: reasons.length ? `${reasons.length} domain contract gap(s)` : `SystemModel ${sm!.systemModelId}@${sm!.revision}; every action belongs to an ExperimentSpec`,
          reasons,
        });
      }
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
    if (supersededEvidence.length) reasons.push(`ignored evidence of experiments under a superseded oracle revision: ${supersededEvidence.join(', ')}`);
    if (validationOnly.length) reasons.push(`validation-only evidence (known-good runs on the base revision, never evidence about the candidate): ${validationOnly.join(', ')}`);

    const verdict: QualityVerdict = failType ? 'fail' : unknownAny ? 'inconclusive' : conditionalType ? 'conditional' : 'pass';
    reasons.push(`verdict ${verdict}: ${verdictWhy(verdict, violatedCriteria, unknownCriteria)}`);

    const oracleRevisions: Record<string, number> = {};
    for (const o of currentOracles(input.oracles)) oracleRevisions[o.oracleId] = o.revision;
    const experimentRevisions: Record<string, number> = {};
    for (const e of [...input.experiments].sort((a, b) => byString(a.experimentId, b.experimentId))) {
      experimentRevisions[e.experimentId] = Math.max(experimentRevisions[e.experimentId] ?? 0, e.revision);
    }
    const testArtifactRevisions: Record<string, number> = {};
    for (const a of [...artifacts.values()].sort((x, y) => byString(x.artifactId, y.artifactId))) testArtifactRevisions[a.artifactId] = a.revision;
    const builds = new Set<string>();
    for (const b of input.systemModel?.subject.buildDigests ?? []) builds.add(b);
    for (const x of experiments) for (const s of x.subjects ?? []) if (s.buildDigest && s.buildDigest !== 'unknown') builds.add(s.buildDigest);

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
      testArtifactRevisions,
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
      gateSpecDigest: sha256Hex(canonicalJson(gate as unknown as JsonValue)),
      gateOverrides: gateOverrides(gate),
      decidedAt: input.now,
    };
    if (builds.size > 0) decision.buildDigests = uniqSorted(builds);
    if (input.supersedes !== undefined) decision.supersedes = input.supersedes;
    if (run.systemModelRevision !== undefined) decision.systemModelRevision = run.systemModelRevision;
    if (input.systemModel !== undefined) decision.systemModelId = input.systemModel.systemModelId;
    return decision;
  }
}

/** Latest revision per experiment id. */
function latestExperiments(experiments: readonly ExperimentSpec[]): ExperimentSpec[] {
  const m = new Map<string, ExperimentSpec>();
  for (const x of experiments) {
    const prev = m.get(x.experimentId);
    if (!prev || x.revision > prev.revision) m.set(x.experimentId, x);
  }
  return [...m.values()].sort((a, b) => byString(a.experimentId, b.experimentId));
}

/** conformance-9: the effective gate's fields that differ from DEFAULT_GATE_SPEC, as `field=<canonical JSON>`. */
export function gateOverrides(gate: GateSpec): string[] {
  const base = DEFAULT_GATE_SPEC as unknown as Record<string, unknown>;
  const eff = gate as unknown as Record<string, unknown>;
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(base), ...Object.keys(eff)])].sort()) {
    const a = eff[k] === undefined ? undefined : canonicalJson(eff[k] as JsonValue);
    const b = base[k] === undefined ? undefined : canonicalJson(base[k] as JsonValue);
    if (a !== b) out.push(`${k}=${a ?? 'unset'}`);
  }
  return out;
}

function verdictWhy(verdict: QualityVerdict, violated: CriterionResult[], unknown: CriterionResult[]): string {
  if (verdict === 'pass') return 'all criteria satisfied';
  if (verdict === 'fail') return `violated ${violated.map((c) => c.criterionId).join(', ')}`;
  if (verdict === 'inconclusive') return `insufficient evidence for ${unknown.map((c) => c.criterionId).join(', ')}`;
  return `conditional on ${violated.map((c) => c.criterionId).join(', ')}`;
}

export type { GateOperation };
