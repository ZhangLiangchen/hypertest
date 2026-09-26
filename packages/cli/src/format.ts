import type { DomainEvent, QualityDecision, QualityVerdict, TestRun } from '@hypertest/domain';

/** Left-aligned columns separated by two spaces (the last column is not padded). */
export function table(headers: string[], rows: string[][]): string[] {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  return all.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ').trimEnd());
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function verdictLabel(verdict: QualityVerdict | 'pending' | undefined): string {
  return verdict ? verdict.toUpperCase() : '-';
}

/**
 * Human summary of a TestRun (status command). `decision` is the run's FINAL decision (its verdict); `interim` a gate
 * decision of the feedback loop while the run continues (shown as such, never as the verdict).
 */
export function runLines(run: TestRun, decision: QualityDecision | undefined, reassessment?: { needsReassessment: boolean; reason?: string }, interim?: QualityDecision): string[] {
  const lines = [
    `run        ${run.runId}`,
    `status     ${run.status}${run.pauseReason ? ` (${run.pauseReason})` : ''}`,
    `goal       ${run.goal}`,
  ];
  const t = run.target;
  const target = [
    t.repoPath ? `repo ${t.repoPath}` : '',
    t.commit ? `commit ${t.commit}` : '',
    t.baseCommit ? `base ${t.baseCommit}` : '',
    t.sutUrl ? `url ${t.sutUrl}` : '',
    t.environmentId ? `environment ${t.environmentId}` : '',
  ].filter(Boolean);
  if (target.length > 0) lines.push(`target     ${target.join(', ')}`);
  lines.push(`plan       revision ${run.currentPlanRevision}`);
  lines.push(`manifest   ${run.runtimeManifestId}`);
  lines.push(`created    ${run.createdAt}`);
  lines.push(`updated    ${run.updatedAt}`);
  if (run.completedAt) lines.push(`completed  ${run.completedAt}`);
  const labels = Object.entries(run.labels ?? {});
  if (labels.length > 0) lines.push(`labels     ${labels.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (decision) {
    lines.push(`verdict    ${verdictLabel(decision.verdict)}${decision.requiresHumanReview ? ' (requires human review)' : ''}`);
    lines.push(`decision   ${decision.decisionId} (revision ${decision.revision}, ${decision.decidedAt})`);
    if (reassessment?.needsReassessment) lines.push(`           NEEDS REASSESSMENT${reassessment.reason ? `: ${reassessment.reason}` : ''}`);
  } else {
    lines.push('verdict    -');
    if (interim) lines.push(`interim    ${verdictLabel(interim.verdict)} (decision ${interim.decisionId}, revision ${interim.revision}; not final: the gate asked for more evidence)`);
  }
  return lines;
}

/** The verdict block printed after `run` / `resume`. */
export function decisionLines(decision: QualityDecision): string[] {
  const lines = [`verdict ${verdictLabel(decision.verdict)}${decision.requiresHumanReview ? ' (requires human review)' : ''}  decision ${decision.decisionId}`];
  // descriptions read `C2 unresolved_findings`; the detail says why
  const criterion = (c: QualityDecision['violatedCriteria'][number]) => `${c.description.startsWith(c.criterionId) ? c.description : `${c.criterionId} ${c.description}`}${c.detail ? `: ${c.detail}` : ''}`;
  for (const c of decision.violatedCriteria) lines.push(`  violated  ${criterion(c)}`);
  for (const c of decision.unknownCriteria) lines.push(`  unknown   ${criterion(c)}`);
  if (decision.unresolvedFindings.length > 0) lines.push(`  unresolved findings: ${decision.unresolvedFindings.join(', ')}`);
  lines.push(`  evidence root ${decision.evidenceRootHash} (${decision.evidenceCount} records)`);
  return lines;
}

export function eventLine(e: DomainEvent<unknown>): string {
  const parts = [String(e.seq ?? '-').padStart(5), e.occurredAt, e.eventType.padEnd(24), e.actorId];
  if (e.workItemId) parts.push(`work=${e.workItemId}`);
  if (e.agentId && e.agentId !== e.actorId) parts.push(`agent=${e.agentId}`);
  return parts.join('  ');
}
