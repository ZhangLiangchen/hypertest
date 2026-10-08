import type { ApprovalRequest } from '@hypertest/policy';

/**
 * (E[8], coverage[0]) The human approval loop of the control plane.
 *
 * A tool call whose permit is `approval_required` is not executed: the policy's approval gate recorded an approval request
 * bound to the exact action (ApprovalGatedPolicyEngine). The dispatcher turns the call into a WAIT on `approval:<id>` (the
 * turn ends `waiting`, the work item waits durably — its state is in SQL, so a restart resumes the wait; Temporal children
 * observe it, an ApprovalSignal wakes them). `observeWaiting` resumes the item once the approval is decided:
 *  - approved ⇒ the agent is told to issue the SAME call again: it runs once (the gate consumes the approval);
 *  - denied / expired ⇒ the agent is told the action must not run (a retry is denied).
 * Approvals of kind `action` are decided only by humans (CLI `hypertest approve|reject`, HTTP API) or the system, never by
 * an agent, never from inside a sandbox.
 */

const PREFIX = 'approval:';

/** The operation id a work item waits on while an action approval is pending. */
export function approvalWaitOperationId(approvalId: string): string {
  return `${PREFIX}${approvalId}`;
}

/** The approval a wait id names (undefined for other waits). */
export function parseApprovalWaitOperationId(operationId: string): string | undefined {
  return operationId.startsWith(PREFIX) && operationId.length > PREFIX.length ? operationId.slice(PREFIX.length) : undefined;
}

/** True while the approval is undecided and its validity window is open. */
export function approvalPending(a: Pick<ApprovalRequest, 'status' | 'subject'>, nowMs: number): boolean {
  if (a.status !== 'pending') return false;
  const until = (a.subject as { expiresAt?: unknown } | null)?.expiresAt;
  return !(typeof until === 'string' && Number.isFinite(Date.parse(until)) && Date.parse(until) <= nowMs);
}

/** What the waiting agent is told once the approval is decided (or expired). */
export function approvalOutcomeLine(a: ApprovalRequest, nowMs: number): string {
  const s = (a.subject ?? {}) as { tool?: unknown; expiresAt?: unknown };
  const tool = typeof s.tool === 'string' ? s.tool : 'the action';
  const by = a.decidedBy ? `${a.decidedBy.kind}:${a.decidedBy.id}` : 'its decider';
  if (a.status === 'approved') {
    return `- approval ${a.approvalId} (${a.kind}) APPROVED by ${by}${a.rationale ? ` — ${a.rationale}` : ''}: issue exactly the same ${tool} call again (identical arguments); it runs once`;
  }
  if (a.status === 'denied') return `- approval ${a.approvalId} (${a.kind}) DENIED by ${by}${a.rationale ? ` — ${a.rationale}` : ''}: ${tool} must not run; continue without it or finish with fail_work`;
  if (a.status === 'expired' || !approvalPending(a, nowMs)) return `- approval ${a.approvalId} (${a.kind}) EXPIRED undecided${typeof s.expiresAt === 'string' ? ` at ${s.expiresAt}` : ''}: ${tool} must not run; continue without it or finish with fail_work`;
  return `- approval ${a.approvalId} (${a.kind}) is still pending`;
}
