import type { CriterionResult, QualityDecision, QualityVerdict } from '@hypertest/domain';
import type { AcceptanceFacts, ActionOutcomeFacts, ActionPermit, ActionRequest, GateInput, PolicyPhase } from './contracts.ts';
import { currentRecords } from './gate.ts';

/**
 * The BUGate time points of the PolicyEngine (technology-selection §BUGate "四个时点"): before action, after action,
 * before a state transition and before final acceptance. Pure helpers shared by the engines (phase matching), the
 * control plane (building the phase facts) and the gate path (applying a withheld acceptance).
 */
export const POLICY_PHASES: readonly PolicyPhase[] = Object.freeze(['before_action', 'after_action', 'before_transition', 'before_acceptance'] as const);

/**
 * Evidence types every tool may produce without declaring them: the ToolRuntime offloads a large output as a
 * `tool-output` record of the call (I9) whatever the tool.
 */
export const IMPLICIT_EVIDENCE_TYPES: readonly string[] = Object.freeze(['tool-output']);

/** The phase of a request (absent ⇒ before_action, the action permit). */
export function requestPhase(request: Pick<ActionRequest, 'phase'>): PolicyPhase {
  return request.phase ?? 'before_action';
}

/**
 * Flagged calls a before_transition / before_acceptance request reports (0 when it carries no such facts). A count that
 * is not a finite non-negative number counts as flagged (fail closed: a malformed fact never clears a rule).
 */
export function flaggedActionsOf(request: Pick<ActionRequest, 'transition' | 'acceptance'>): number {
  const n: unknown = request.transition !== undefined ? request.transition.flaggedActions : request.acceptance !== undefined ? request.acceptance.flaggedActions : 0;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 1;
}

const uniqSorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/**
 * after_action facts of one executed call: the types of the evidence it wrote, judged against the types its tool
 * declares (plus IMPLICIT_EVIDENCE_TYPES). `declared` undefined: the tool declares nothing, so nothing is judged.
 */
export function actionOutcomeFacts(input: { status: string; produced: ReadonlyArray<{ evidenceId: string; evidenceType: string }>; declared?: readonly string[] }): ActionOutcomeFacts {
  const types = uniqSorted(input.produced.map((e) => e.evidenceType));
  const facts: ActionOutcomeFacts = { status: input.status, evidenceTypes: types, evidenceIds: uniqSorted(input.produced.map((e) => e.evidenceId)), undeclaredEvidenceTypes: [] };
  if (input.declared !== undefined) {
    const allowed = new Set([...input.declared, ...IMPLICIT_EVIDENCE_TYPES]);
    facts.declaredEvidenceTypes = [...allowed].sort();
    facts.undeclaredEvidenceTypes = types.filter((t) => !allowed.has(t));
  }
  return facts;
}

function counts(xs: Iterable<string>): Record<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The before_acceptance facts: a bounded digest of the QualityGate input (evidence counted by type — never the payloads
 * —, current findings/risks/reviews, work items by state, claims, oracle revisions, the gate spec's overrides and the
 * recorded override authority) and the deterministic gate's decision (verdict and criteria). Pure.
 */
export function acceptanceFacts(
  input: GateInput,
  decision: QualityDecision,
  extra: { flaggedActions: number; gateOverrideAuthority?: AcceptanceFacts['gateOverrideAuthority'] },
): AcceptanceFacts {
  const runId = input.run.runId;
  const findings = currentRecords(input.findings).filter((r) => r.runId === runId);
  const risks = currentRecords(input.risks).filter((r) => r.runId === runId);
  const reviews = currentRecords(input.reviews).filter((r) => r.runId === runId);
  const facts: AcceptanceFacts = {
    gateId: decision.gateId,
    gateOverrides: [...(decision.gateOverrides ?? [])],
    verdict: decision.verdict,
    requiresHumanReview: decision.requiresHumanReview,
    satisfiedCriteria: decision.satisfiedCriteria.map((c) => c.criterionId),
    violatedCriteria: decision.violatedCriteria.map((c) => c.criterionId),
    unknownCriteria: decision.unknownCriteria.map((c) => c.criterionId),
    evidence: { count: decision.evidenceCount, rootHash: decision.evidenceRootHash, byType: counts(input.evidence.filter((e) => e.runId === runId).map((e) => e.evidenceType)) },
    findings: { total: findings.length, unresolved: [...decision.unresolvedFindings] },
    risks: { total: risks.length, unresolved: [...decision.unresolvedRisks] },
    reviews: reviews.map((r) => {
      const out: AcceptanceFacts['reviews'][number] = { recordId: r.recordId, verdict: r.payload.verdict };
      if (r.payload.modelProvider !== undefined) out.modelProvider = r.payload.modelProvider;
      return out;
    }),
    oracleRevisions: { ...decision.oracleRevisions },
    workItems: counts(input.workItems.map((w) => w.state)),
    claims: { total: input.claims.length, critical: input.claims.filter((c) => c.critical).length },
    exceptions: decision.exceptions.map((e) => e.criterionId),
    flaggedActions: extra.flaggedActions,
  };
  if (decision.gateSpecDigest !== undefined) facts.gateSpecDigest = decision.gateSpecDigest;
  if (extra.gateOverrideAuthority !== undefined) {
    facts.gateOverrideAuthority = { by: { ...extra.gateOverrideAuthority.by }, rationale: extra.gateOverrideAuthority.rationale, weakened: [...extra.gateOverrideAuthority.weakened] };
  }
  return facts;
}

/** A reason the deterministic verdict may not be claimed as is (a policy hold on the decision). */
export interface PolicyHold {
  /** Pseudo-criterion id of the hold, e.g. `policy.before_acceptance` (listed in unknownCriteria). */
  criterionId: string;
  description: string;
  detail: string;
}

/**
 * Withholds a decision's verdict: `pass` / `conditional` / `inconclusive` become `inconclusive`, `fail` stays `fail` (a
 * hold never weakens a failure), requiresHumanReview is set, the hold is listed as an unknown criterion and explained in
 * the reasons. Pure; the caller signs the result.
 */
export function withPolicyHold(decision: QualityDecision, hold: PolicyHold): QualityDecision {
  const verdict: QualityVerdict = decision.verdict === 'fail' ? 'fail' : 'inconclusive';
  const unknown: CriterionResult = { criterionId: hold.criterionId, description: hold.description, status: 'unknown', evidenceRefs: [], detail: hold.detail };
  return {
    ...decision,
    verdict,
    requiresHumanReview: true,
    unknownCriteria: [...decision.unknownCriteria, unknown],
    reasons: [...decision.reasons, `${hold.criterionId} ${hold.detail}`, `verdict ${verdict}: ${hold.description} withholds the gate's ${decision.verdict} (human review required)`],
  };
}

/**
 * Applies a before_transition (run gating) or before_acceptance permit to a gate decision: `allow` leaves it unchanged,
 * `deny` / `approval_required` withhold it (withPolicyHold) — a policy can make a verdict stricter, never `pass`.
 */
export function applyPhasePermit(decision: QualityDecision, permit: ActionPermit, phase: Extract<PolicyPhase, 'before_transition' | 'before_acceptance'>, subject?: string): QualityDecision {
  if (permit.decision === 'allow') return decision;
  return withPolicyHold(decision, {
    criterionId: `policy.${phase}`,
    description: `policy ${phase}${subject !== undefined ? ` (${subject})` : ''}`,
    detail: `${permit.decision} by policy decision ${permit.decisionId} (policy ${permit.policyRevision}): ${permit.reasons.join('; ') || 'no reason given'}`,
  });
}
