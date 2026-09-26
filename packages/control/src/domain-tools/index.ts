import type { ToolSpec } from '@hypertest/tools';
import type { ControlDeps } from '../deps.ts';
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
  return [...blackboardTools(deps), ...planTools(deps), ...specTools(deps), ...evidenceTools(deps), ...workTools(deps)];
}
