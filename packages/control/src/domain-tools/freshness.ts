import type { JsonValue } from '@hypertest/core';
import type { StaleEntry } from '@hypertest/context';
import { findingWithdrawalResolver, planResolver, planResourceId, recordResolver } from '@hypertest/context';
import type { ToolContext, ToolOutcome, ToolSpec } from '@hypertest/tools';
import type { ControlDeps } from '../deps.ts';

/**
 * (B[1], I1) Marker of a ToolSpec whose record effect is validated by the FreshnessGuard inside the tool (see
 * freshnessChecked). The tool runtime validates every other mutating effect (write_workspace, execute, external,
 * destructive) itself; `record` effects — the domain tools that change the canonical Blackboard, plan, oracle, experiment and
 * work state — are validated here. A test enumerates the whole tool catalog against this rule.
 */
export const FRESHNESS_CHECKED: unique symbol = Symbol.for('hypertest.control.freshnessChecked');

/** True when the spec's record effect is validated by freshnessChecked. */
export function isFreshnessChecked(spec: ToolSpec): boolean {
  return (spec as unknown as Record<symbol, unknown>)[FRESHNESS_CHECKED] === true;
}

type Hint = (input: Record<string, unknown>, ctx: ToolContext, deps: ControlDeps) => Promise<string[]>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** `finding:<lineage>` / `record:<lineage>` / `finding_withdrawal:<lineage>` of the run records the input names. */
async function recordResources(deps: ControlDeps, runId: string, recordIds: Array<string | undefined>): Promise<string[]> {
  const out: string[] = [];
  for (const id of new Set(recordIds.filter((x): x is string => x !== undefined))) {
    const rec = await deps.blackboard.getRecord(id);
    if (!rec || rec.runId !== runId) continue;
    out.push(`record:${rec.lineageId}`, `finding:${rec.lineageId}`, `finding_withdrawal:${rec.lineageId}`);
  }
  return out;
}

/**
 * The resources a record tool's action names beyond its `run/<runId>/<area>` scope, so the guard re-validates exactly what
 * the action builds on: the record lineage it supersedes or relates to (record/finding entries the agent observed), the
 * plan it revises (`plan` entry: a compare-and-set against the plan revision the agent saw).
 */
const HINTS: Record<string, Hint> = {
  'plan.propose_revision': async (_input, ctx) => [planResourceId(ctx.runId)],
  'blackboard.post_finding': async (i, ctx, deps) => recordResources(deps, ctx.runId, [str(i['updatesRecordId']), str(i['duplicateOf'])]),
  'blackboard.post_hypothesis': async (i, ctx, deps) => recordResources(deps, ctx.runId, [str(i['updatesRecordId']), str(i['findingRecordId'])]),
  'blackboard.report_coverage_gap': async (i, ctx, deps) => recordResources(deps, ctx.runId, [str(i['updatesRecordId']), str(i['relatedFindingRecordId']), str(i['relatedRiskRecordId'])]),
  'blackboard.post_risk': async (i, ctx, deps) => recordResources(deps, ctx.runId, [str(i['updatesRecordId'])]),
  'blackboard.post_strategy': async (i, ctx, deps) => recordResources(deps, ctx.runId, [str(i['updatesRecordId'])]),
  'blackboard.post_decision': async (i, ctx, deps) => recordResources(deps, ctx.runId, [str(i['updatesRecordId'])]),
  'blackboard.post_review': async (i, ctx, deps) => {
    const subject = i['subjectRef'] && typeof i['subjectRef'] === 'object' ? (i['subjectRef'] as Record<string, unknown>) : {};
    return subject['kind'] === 'record' ? recordResources(deps, ctx.runId, [str(subject['id'])]) : [];
  },
};

/** What the agent should do about the stale resources (the refusal text the model sees). */
function refreshHint(stale: readonly StaleEntry[]): string {
  const steps = new Set<string>();
  for (const s of stale) {
    if (s.resourceType === 'finding' || s.resourceType === 'finding_withdrawal' || s.resourceType === 'record') steps.add('re-read the changed records with blackboard.read (lineageId) — a withdrawn finding must be acknowledged before you act');
    else if (s.resourceType === 'plan') steps.add('read the current plan with plan.read and base the revision on it');
    else if (s.resourceType === 'file') steps.add('re-read the changed files with fs.read');
    else if (s.resourceType === 'metric_window') steps.add('query the metrics again (your metric data is older than its window)');
    else if (s.resourceType === 'oracle') steps.add('read the oracle again with oracle.get (it was upgraded: act on the revision in force)');
    else if (s.resourceType === 'environment' || s.resourceType === 'build') steps.add('the environment was redeployed or restarted since you saw it (your next prompt lists its current generation): re-check it before acting on it');
    else if (s.resourceType === 'lease') steps.add('the side-effect lease of an operation you started is held by another owner now: stop acting on that operation');
  }
  steps.add('a new context snapshot is fixed at your next turn');
  return `Refresh your view of these resources before retrying the mutating action: ${[...steps].join('; ')}.`;
}

function staleOutcome(message: string, hint: string, structured?: JsonValue): ToolOutcome {
  const out: ToolOutcome = { status: 'stale_context', error: { code: 'stale_context', message }, text: hint };
  if (structured !== undefined) out.structured = structured;
  return out;
}

/**
 * (B[1], I1: "所有 state-changing tool 必须通过 FreshnessGuard") A record-effect tool validates the calling agent's turn
 * snapshot — its ReadSet (everything it observed) refined by the observations of the turn — with the FreshnessGuard right
 * before it writes (inside the claim-fenced transaction of the write when the call runs under a work claim, as agent calls
 * do): the guard checks the always-checked types (environment, build, oracle, experiment, lease, finding,
 * finding_withdrawal) and the entries the action names (its `run/<runId>/<area>` scope and the HINTS above). Stale ⇒ the call
 * is refused with status `stale_context`, the exact stale resources and a refresh hint (context.stale_rejected on L0);
 * nothing is written. No snapshot with a configured guard ⇒ refused (fail closed). A guard that cannot validate ⇒ refused.
 * A call that passed and took effect records a FreshnessPass in the same transaction, so a durable replay of the same
 * invocation is never refused as stale by its own effect (it returns its recorded outcome). Without a configured guard the
 * tool runs unchanged (the runtime's rule for the other effects).
 */
export function freshnessChecked(deps: ControlDeps, spec: ToolSpec): ToolSpec {
  if (spec.effect !== 'record' && typeof spec.effect !== 'function') return spec;
  if (isFreshnessChecked(spec)) return spec;
  const inner = spec.execute;
  const checked: ToolSpec = {
    ...spec,
    execute: async (input, ctx) => {
      const effect = typeof spec.effect === 'function' ? spec.effect(input) : spec.effect;
      const guard = deps.freshness;
      if (effect !== 'record' || !guard) return inner(input, ctx);
      // runs inside the claim-fenced write transaction when the call holds a work claim (claimFenced wraps this tool), so the
      // validation, the write and the pass record commit together
      {
        // a durable replay of a call that already passed and took effect: its own write must not make it stale
        if (deps.freshnessPasses && (await deps.freshnessPasses.get(ctx.invocationId))) return inner(input, ctx);
        if (!ctx.snapshot) {
          return staleOutcome('no context snapshot supplied for a mutating action; freshness cannot be validated', 'The runtime must execute mutating tools against the current turn snapshot.');
        }
        const resources = [...spec.resources(input, { workspace: ctx.workspace, runId: ctx.runId, environments: ctx.environments })];
        const hint = HINTS[spec.id];
        if (hint) resources.push(...(await hint((input ?? {}) as Record<string, unknown>, ctx, deps)));
        let result: Awaited<ReturnType<typeof guard.validate>>;
        try {
          result = await guard.validate(ctx.snapshot, { tool: spec.id, resources: [...new Set(resources)], mutating: true }, ctx.eventContext);
        } catch (e) {
          deps.logger.error('freshness validation of a record tool failed; not executing', { toolId: spec.id, invocationId: ctx.invocationId, error: (e as Error).message });
          return staleOutcome(`freshness could not be validated: ${(e as Error).message}`, 'Retry the action at your next turn.');
        }
        if (!result.fresh) {
          const stale = result.stale;
          return staleOutcome(
            `stale context (snapshot ${ctx.snapshot.snapshotId}): ${stale.map((s) => `${s.resourceType}/${s.resourceId}: ${s.reason}${s.currentVersion !== undefined ? ` (now ${s.currentVersion})` : ''}`).join('; ')}`,
            refreshHint(stale),
            { stale: stale.map((s) => ({ resourceType: s.resourceType, resourceId: s.resourceId, reason: s.reason, ...(s.currentVersion !== undefined ? { currentVersion: s.currentVersion } : {}) })) } as unknown as JsonValue,
          );
        }
        const out = await inner(input, ctx);
        if (deps.freshnessPasses && (out.status === 'success' || out.status === 'pending')) {
          const pass: Parameters<NonNullable<ControlDeps['freshnessPasses']>['record']>[0] = { invocationId: ctx.invocationId, runId: ctx.runId, agentId: ctx.agentId, toolId: spec.id, checked: result.checked };
          pass.snapshotId = ctx.snapshot.snapshotId;
          await deps.freshnessPasses.record(pass);
        }
        return out;
      }
    },
  };
  (checked as unknown as Record<symbol, unknown>)[FRESHNESS_CHECKED] = true;
  return checked;
}

/**
 * The FreshnessGuard resolvers the record tools' read sets need (registered once, never replacing a composition's own):
 * `plan` (latest accepted revision), `finding_withdrawal`, `record` and `finding` (lineage heads).
 */
export function ensureFreshnessResolvers(deps: ControlDeps): void {
  const r = deps.resolvers;
  const { blackboard } = deps;
  if (!r.get('plan')) r.register(planResolver((runId) => blackboard.latestAcceptedPlan(runId)));
  if (!r.get('finding_withdrawal')) r.register(findingWithdrawalResolver((lineage) => blackboard.head(lineage)));
  if (!r.get('record')) r.register(recordResolver((lineage) => blackboard.head(lineage)));
  if (!r.get('finding')) r.register(recordResolver((lineage) => blackboard.head(lineage), { resourceType: 'finding' }));
}
