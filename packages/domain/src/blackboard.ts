import type { Ref, RiskClass, Severity } from './common.ts';

export type BlackboardRecordType = 'finding' | 'hypothesis' | 'coverage_gap' | 'risk' | 'review' | 'test_strategy' | 'decision' | 'note';

/**
 * Structured, versioned collaboration record. Records are immutable; an update writes a new record
 * that `supersedes` the previous one (same `lineageId`). `revision` is the run-wide blackboard revision
 * assigned at write time (monotonic), used by ContextSnapshots.
 */
export interface BlackboardRecord<T = unknown> {
  recordId: string;
  lineageId: string;
  recordType: BlackboardRecordType;
  runId: string;
  revision: number;
  version: number;
  createdBy: string;
  workItemId?: string;
  payload: T;
  evidenceRefs: string[];
  supersedes?: string;
  createdAt: string;
}

export type FindingCategory = 'product_defect' | 'test_defect' | 'infrastructure' | 'environment' | 'performance' | 'security' | 'unknown';
export type FindingStatus = 'open' | 'confirmed' | 'rejected' | 'fixed' | 'verified_fixed' | 'accepted_risk' | 'duplicate';

export interface Finding {
  title: string;
  description: string;
  severity: Severity;
  category: FindingCategory;
  status: FindingStatus;
  component?: string;
  oracleRef?: { oracleId: string; revision: number; assertionId?: string };
  experimentId?: string;
  testArtifactId?: string;
  reproduction?: string;
  expected?: string;
  actual?: string;
  /** Dedupe key for the same symptom (e.g. hash of failing test id + message class). */
  fingerprint: string;
  duplicateOf?: string;
}

export interface Hypothesis {
  findingLineageId?: string;
  statement: string;
  status: 'open' | 'supported' | 'refuted' | 'inconclusive';
  confidence: number;
  suggestedChecks: string[];
}

export interface CoverageGap {
  area: string;
  description: string;
  relatedFindingLineageId?: string;
  relatedRiskLineageId?: string;
  status: 'open' | 'addressed' | 'accepted';
}

export interface Risk {
  title: string;
  description: string;
  likelihood: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high' | 'critical';
  level: RiskClass;
  componentRefs: string[];
  source: 'change_analysis' | 'architecture' | 'history' | 'runtime' | 'review' | 'requirement';
  status: 'open' | 'mitigated' | 'verified' | 'accepted';
}

export type ReviewVerdict = 'approve' | 'reject' | 'needs_more_evidence' | 'unknown';

export interface Review {
  subjectRef: Ref;
  verdict: ReviewVerdict;
  rationale: string;
  checkedEvidenceRefs: string[];
  reviewerRole: string;
  modelRouteId?: string;
  modelProvider?: string;
}

export interface TestStrategy {
  objectiveIds: string[];
  approach: 'white_box' | 'black_box' | 'hybrid';
  techniques: string[];
  description: string;
}

export interface DecisionNote {
  topic: string;
  decision: string;
  rationale: string;
}

export interface BlackboardPayloads {
  finding: Finding;
  hypothesis: Hypothesis;
  coverage_gap: CoverageGap;
  risk: Risk;
  review: Review;
  test_strategy: TestStrategy;
  decision: DecisionNote;
  note: { text: string };
}

export function riskLevel(likelihood: Risk['likelihood'], impact: Risk['impact']): RiskClass {
  const l = { low: 0, medium: 1, high: 2 }[likelihood];
  const i = { low: 0, medium: 1, high: 2, critical: 3 }[impact];
  if (i === 3 && l >= 1) return 'critical';
  const s = l + i;
  if (s >= 4) return 'high';
  if (s >= 2) return 'medium';
  return 'low';
}

/** Findings that block a pass verdict when unresolved. */
export function isUnresolvedFinding(f: Finding): boolean {
  return f.status === 'open' || f.status === 'confirmed' || f.status === 'fixed';
}
