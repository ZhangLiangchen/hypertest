import { HypertestError, isHypertestError } from '@hypertest/core';
import type { ToolSpec } from '@hypertest/tools';
import type { ControlDeps } from '../deps.ts';
import { WorkFactory } from '../work-factory.ts';
import { refuse } from './common.ts';
import { blackboardTools } from './blackboard.ts';
import { evidenceTools } from './evidence.ts';
import { planTools } from './plan.ts';
import { specTools } from './specs.ts';
import { workTools } from './work.ts';

export { findingFingerprint, CONFIRMING_ROLES, EVIDENCE_REQUIRED_CATEGORIES, RESOLVING_FINDING_STATUSES } from './blackboard.ts';
export { acceptedPlanCount } from './plan.ts';
export { delegationOperationId, parseDelegationOperationId } from './work.ts';
export { artifactContent } from './specs.ts';

/** Ids of the tools that end a work item; the dispatcher reads their structured `terminal` signal. */
export const TERMINAL_TOOL_IDS: readonly string[] = ['complete_work', 'fail_work'];

/**
 * The control plane's domain tools (blackboard.*, plan.*, work.propose, system_model.record, oracle.*,
 * experiment.define, test_artifact.*, evidence.*, delegate, request_approval, complete_work, fail_work). Each is an
 * ordinary ToolSpec: it runs through the ToolRuntime pipeline (capability → permit → events) like any built-in
 * tool, is scoped to `run/<runId>/<area>`, validates its input with the domain schemas and returns structured
 * results with ids. Domain refusals (unknown evidence, invalid plan, missing evidence requirements) are failed
 * tool results the model can react to — never thrown faults.
 */
export function createDomainTools(deps: ControlDeps): ToolSpec[] {
  return [...blackboardTools(deps), ...planTools(deps), ...specTools(deps), ...evidenceTools(deps), ...workTools(deps)].map((spec) => claimFenced(deps, spec));
}

/**
 * (H4, I4) A record-effect domain tool called under a work claim (`ToolContext.claim`, set by the dispatcher) writes in ONE
 * transaction that first re-validates the claim: the run's work-creation lock (lock order: before any run counter lock),
 * then the work item row is locked and its claim's fencing token compared (a same-state, change-free fenced transition).
 * A worker whose claim was revoked while the call was in flight (lease expiry → requeue → new token) therefore never
 * writes, and concurrent executions of one replayed invocation serialize (the second finds the first's write: I5).
 * Read tools and calls without a claim (tests, system callers) are unchanged.
 */
export function claimFenced(deps: ControlDeps, spec: ToolSpec): ToolSpec {
  if (spec.effect === 'read') return spec;
  const inner = spec.execute;
  const factory = new WorkFactory(deps);
  const fenced: ToolSpec = {
    ...spec,
    execute: async (input, ctx) => {
      const claim = ctx.claim;
      if (!claim) return inner(input, ctx);
      try {
        return await deps.db.transaction(async (tx) => {
          await factory.lock(ctx.runId, tx);
          const item = await deps.blackboard.getWorkItem(claim.workItemId);
          if (!item || item.runId !== ctx.runId || claim.workItemId !== ctx.workItemId) throw new HypertestError('permission_denied', `claim_work_item_mismatch: ${claim.workItemId} is not this call's work item`);
          await deps.blackboard.transitionWorkItem(item.workItemId, item.state, {}, { ...ctx.eventContext, workItemId: item.workItemId }, {
            expectedFencingToken: claim.fencingToken,
            expectedFrom: ['claimed', 'running'],
            tx,
          });
          return inner(input, ctx);
        });
      } catch (e) {
        if (isHypertestError(e, 'stale_fence') || isHypertestError(e, 'conflict') || isHypertestError(e, 'precondition_failed') || isHypertestError(e, 'permission_denied')) {
          return refuse('lease_lost', `${spec.id} refused: the work claim (fencing token ${claim.fencingToken}) is no longer held (${e.message}); stop working on this item`);
        }
        throw e;
      }
    },
  };
  return fenced;
}
