import { canonicalJson } from '@hypertest/core';
import type { EvidenceRecord, Finding, OracleAssertion, OracleChangeProposal, OracleSpec } from '@hypertest/domain';
import { evaluateOracleCheck } from '@hypertest/policy';

export interface FlipDetectorDeps {
  getOracle(oracleId: string, revision?: number): Promise<OracleSpec | undefined>;
  /** Findings of the run — every revision (superseded ones included: a failure recorded once stays recorded). */
  findings(runId: string): Promise<Array<{ payload: Finding }>>;
  getEvidence(evidenceIds: readonly string[]): Promise<EvidenceRecord[]>;
  /**
   * (additive, optional) The run's recorded test results (`test-result` evidence). With it, a changed `test_outcome`
   * assertion whose selector matches a failed test case recorded in the run is a flip even when the proposer cites
   * no evidence and no finding (the proposer chooses what it cites; the ledger is the record).
   */
  testResults?(runId: string): Promise<EvidenceRecord[]>;
  /**
   * (additive, optional; H8) Every evidence record of the run. With it, a changed or removed assertion of ANY check type
   * (metric_threshold, http_expectation, evidence_predicate, test_outcome) whose base check the recorded evidence violates
   * — judged by the QualityGate's own evaluator (`evaluateOracleCheck`) — is a flip when the proposed check no longer
   * reports a violation on the same evidence (or the assertion is removed).
   */
  evidence?(runId: string): Promise<EvidenceRecord[]>;
}

/** Assertion ids the proposal changes or removes relative to its base revision (additions change nothing recorded). */
export function changedAssertions(base: OracleSpec, proposal: Pick<OracleChangeProposal, 'proposedAssertions'>): string[] {
  const next = new Map(proposal.proposedAssertions.map((a) => [a.assertionId, canonicalJson(a)]));
  return base.assertions.filter((a) => next.get(a.assertionId) !== canonicalJson(a)).map((a) => a.assertionId);
}

/** Case statuses that record a failed assertion (the QualityGate treats both as a violation). */
const FAILED_CASE_STATUSES: ReadonlySet<string> = new Set(['failed', 'xfail']);

interface CaseLike {
  id?: unknown;
  name?: unknown;
  file?: unknown;
  status?: unknown;
}

/**
 * Whether a recorded test case matches an assertion's `testSelector`, with the QualityGate's semantics: the selector
 * is compared with the case id, its name and `<file>::<name>`; `*` matches any sequence (also `/`).
 */
export function testCaseMatches(selector: string, c: CaseLike): boolean {
  const candidates = [c.id, c.name, typeof c.file === 'string' && typeof c.name === 'string' ? `${c.file}::${c.name}` : undefined].filter((x): x is string => typeof x === 'string');
  if (!selector.includes('*')) return candidates.includes(selector);
  const re = new RegExp(`^${selector.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return candidates.some((x) => re.test(x));
}

function recordedCaseFailure(assertion: OracleAssertion, evidence: readonly EvidenceRecord[]): boolean {
  const check = assertion.check;
  if (!check || check.type !== 'test_outcome') return false;
  return evidence.some((e) => {
    const cases = (e.structured as { cases?: unknown } | undefined | null)?.cases;
    if (!Array.isArray(cases)) return false;
    return cases.some((c) => c !== null && typeof c === 'object' && FAILED_CASE_STATUSES.has(String((c as CaseLike).status)) && testCaseMatches(check.testSelector, c as CaseLike));
  });
}

/**
 * OracleGovernance's `wouldFlipRecordedFailure` hook (I8): a proposal that changes or removes assertions of its base
 * revision flips a recorded failure when, in the proposal's run,
 *  (a) a non-rejected revision of a finding cites that oracle (and one of the changed assertions, or no assertion);
 *  (b) the evidence the proposal cites records a failed test result; or
 *  (c) (with `testResults`) a changed `test_outcome` assertion's selector matches a failed/xfail test case recorded in
 *      the run's test-result evidence — whatever the proposer chose to cite; or
 *  (d) (with `evidence`; H8) a changed or removed assertion of any check type is violated by the run's recorded evidence
 *      under the base revision but not under the proposal (the QualityGate's evaluator, `evaluateOracleCheck`).
 * Such proposals require a human approver whenever the oracle's change policy accepts humans. Conservative by
 * construction: an unknown base revision is treated as a flip.
 */
export function recordedFailureFlipDetector(deps: FlipDetectorDeps): (proposal: OracleChangeProposal) => Promise<boolean> {
  return async (proposal) => {
    const base = await deps.getOracle(proposal.oracleId, proposal.fromRevision);
    if (!base) return true;
    const changed = new Set(changedAssertions(base, proposal));
    if (changed.size === 0) return false;
    const findings = await deps.findings(proposal.runId);
    const cited = findings.some((f) => {
      const ref = f.payload.oracleRef;
      if (!ref || ref.oracleId !== proposal.oracleId || f.payload.status === 'rejected') return false;
      return ref.assertionId === undefined || changed.has(ref.assertionId);
    });
    if (cited) return true;
    if (proposal.relatedEvidenceRefs.length > 0) {
      const evidence = await deps.getEvidence(proposal.relatedEvidenceRefs);
      const failed = evidence.some((e) => {
        if (e.runId !== proposal.runId || e.evidenceType !== 'test-result') return false;
        const s = e.structured as { passed?: unknown } | undefined;
        return s !== undefined && s !== null && typeof s === 'object' && s.passed === false;
      });
      if (failed) return true;
    }
    if (deps.evidence) {
      // (d) the gate's own semantics for every check type: a recorded violation of the base check that the proposal
      //     turns into a non-violation (loosened threshold, relaxed expectation) or removes
      const runEvidence = (await deps.evidence(proposal.runId)).filter((e) => e.runId === proposal.runId);
      if (flipsRecordedViolation(base, proposal, changed, runEvidence)) return true;
    }
    if (!deps.testResults) return false;
    const changedTestAssertions = base.assertions.filter((a) => changed.has(a.assertionId) && a.check?.type === 'test_outcome');
    if (changedTestAssertions.length === 0) return false;
    const results = (await deps.testResults(proposal.runId)).filter((e) => e.runId === proposal.runId && e.evidenceType === 'test-result');
    return changedTestAssertions.some((a) => recordedCaseFailure(a, results));
  };
}

/**
 * (H8) True when a changed or removed assertion's BASE check is `violated` on the run's recorded evidence (the
 * QualityGate's evaluator) while the proposed revision of that assertion is absent or not `violated` on the same evidence:
 * the change would turn a recorded failure into a non-failure.
 */
export function flipsRecordedViolation(
  base: Pick<OracleSpec, 'assertions'>,
  proposal: Pick<OracleChangeProposal, 'proposedAssertions'>,
  changed: ReadonlySet<string>,
  evidence: readonly EvidenceRecord[],
): boolean {
  const next = new Map(proposal.proposedAssertions.map((a) => [a.assertionId, a]));
  for (const a of base.assertions) {
    if (!changed.has(a.assertionId) || !a.check) continue;
    if (evaluateOracleCheck(a.check, evidence).status !== 'violated') continue;
    const proposed = next.get(a.assertionId);
    if (!proposed || !proposed.check) return true; // removed (or made uncheckable): the recorded failure disappears
    if (evaluateOracleCheck(proposed.check, evidence).status !== 'violated') return true;
  }
  return false;
}
