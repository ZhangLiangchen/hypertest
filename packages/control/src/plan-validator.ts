import { isValidSchema } from '@hypertest/core';
import { toolPatternCovers } from '@hypertest/policy';
import type { PlanValidationInput, PlanValidationResult } from './contracts.ts';

/**
 * Validates a proposed PlanRevision (typed Plan IR — never code) against the run and the role catalog. Pure and
 * deterministic: the same input yields the same issues, in a stable order. Checks:
 *  - only the lead proposes; accepted plans < maxPlanRevisions;
 *  - unique objective ids and localIds; objectiveIds reference the proposal's objectives;
 *  - roles exist in the catalog and are not `lead` (the lead replans itself);
 *  - dependsOn resolves to a localId of this revision or an existing, non-cancelled work item that is not being
 *    cancelled by this revision; no self-dependency; the localId graph is acyclic;
 *  - tool allow patterns ⊆ the role allowlist (and not role-denied);
 *  - per-item budgets within the run envelope; total work items after acceptance ≤ maxWorkItems;
 *  - expectedOutput is a valid JSON schema;
 *  - cancelWorkItems exist, are not lead planning work (the proposer's own item included) and are not waiting on
 *    side effects.
 */
export function validatePlan(input: PlanValidationInput): PlanValidationResult {
  const { run, proposal, existingWorkItems, roles, acceptedPlanCount, proposerRole } = input;
  const issues: string[] = [];
  const budget = run.budget;

  if (proposerRole !== 'lead') issues.push(`only the lead may propose plan revisions (proposer role: ${proposerRole})`);
  if (acceptedPlanCount >= budget.maxPlanRevisions) {
    issues.push(`plan revision cap reached: ${acceptedPlanCount} accepted plans (maxPlanRevisions ${budget.maxPlanRevisions})`);
  }

  const objectiveIds = new Set<string>();
  for (const o of proposal.objectives) {
    if (objectiveIds.has(o.objectiveId)) issues.push(`duplicate objectiveId ${o.objectiveId}`);
    objectiveIds.add(o.objectiveId);
  }

  const localIds = new Set<string>();
  for (const w of proposal.workItems) {
    if (localIds.has(w.localId)) issues.push(`duplicate localId ${w.localId}`);
    localIds.add(w.localId);
  }

  const existing = new Map(existingWorkItems.map((w) => [w.workItemId, w]));
  const cancel = new Set(proposal.cancelWorkItems ?? []);

  for (const w of proposal.workItems) {
    const at = `work item ${w.localId}`;
    const role = roles.get(w.role);
    if (!role) issues.push(`${at}: unknown role ${w.role}`);
    else if (w.role === 'lead') issues.push(`${at}: role lead cannot be planned as a task (the lead replans through plan revisions)`);

    for (const d of w.dependsOn) {
      if (d === w.localId) {
        issues.push(`${at}: depends on itself`);
        continue;
      }
      if (localIds.has(d)) continue;
      const dep = existing.get(d);
      if (!dep) issues.push(`${at}: dependency ${d} is neither a localId of this revision nor an existing work item`);
      else if (dep.state === 'cancelled') issues.push(`${at}: dependency ${d} is cancelled`);
      else if (cancel.has(d)) issues.push(`${at}: dependency ${d} is cancelled by this revision`);
    }

    for (const id of w.objectiveIds) {
      if (!objectiveIds.has(id)) issues.push(`${at}: objectiveId ${id} is not an objective of this revision`);
    }

    if (role && w.toolPolicy) {
      for (const p of w.toolPolicy.allow) {
        const allowed = role.toolPolicy.allow.some((r) => toolPatternCovers(r, p));
        const denied = (role.toolPolicy.deny ?? []).some((d) => toolPatternCovers(d, p) || toolPatternCovers(p, d));
        if (!allowed || denied) issues.push(`${at}: tool pattern ${p} is outside the ${w.role} tool allowlist`);
      }
    }

    const b = w.budget;
    if (b) {
      if (b.maxTokens !== undefined && b.maxTokens > budget.maxModelTokens) issues.push(`${at}: budget.maxTokens ${b.maxTokens} exceeds the run limit ${budget.maxModelTokens}`);
      if (b.maxToolCalls !== undefined && b.maxToolCalls > budget.maxToolCalls) issues.push(`${at}: budget.maxToolCalls ${b.maxToolCalls} exceeds the run limit ${budget.maxToolCalls}`);
      if (b.maxWallClockMs !== undefined && b.maxWallClockMs > budget.maxWallClockMs) issues.push(`${at}: budget.maxWallClockMs ${b.maxWallClockMs} exceeds the run limit ${budget.maxWallClockMs}`);
      if (b.maxCostUsd !== undefined && budget.maxModelCostUsd !== undefined && b.maxCostUsd > budget.maxModelCostUsd) {
        issues.push(`${at}: budget.maxCostUsd ${b.maxCostUsd} exceeds the run limit ${budget.maxModelCostUsd}`);
      }
    }

    if (w.expectedOutput !== undefined && !isValidSchema(w.expectedOutput)) issues.push(`${at}: expectedOutput is not a valid JSON schema`);
  }

  // acyclic dependency graph over this revision's localIds
  const deps = new Map(proposal.workItems.map((w) => [w.localId, w.dependsOn.filter((d) => localIds.has(d) && d !== w.localId)]));
  const state = new Map<string, 'visiting' | 'done'>();
  const reported = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') {
      const cycle = [...path.slice(path.indexOf(id)), id];
      const key = [...cycle].sort().join(',');
      if (!reported.has(key)) {
        reported.add(key);
        issues.push(`dependency cycle: ${cycle.join(' → ')}`);
      }
      return;
    }
    state.set(id, 'visiting');
    for (const d of deps.get(id) ?? []) visit(d, [...path, id]);
    state.set(id, 'done');
  };
  for (const w of proposal.workItems) visit(w.localId, []);

  const total = existingWorkItems.length + proposal.workItems.length;
  if (total > budget.maxWorkItems) issues.push(`total work items after acceptance ${total} exceed maxWorkItems ${budget.maxWorkItems}`);

  for (const id of proposal.cancelWorkItems ?? []) {
    const item = existing.get(id);
    if (!item) issues.push(`cancelWorkItems: unknown work item ${id}`);
    else if (item.role === 'lead') issues.push(`cancelWorkItems: work item ${id} is lead planning work and cannot be cancelled by a plan revision`);
    else if (item.state === 'waiting') issues.push(`cancelWorkItems: work item ${id} is waiting on side effects and cannot be cancelled`);
  }

  return { valid: issues.length === 0, issues };
}
