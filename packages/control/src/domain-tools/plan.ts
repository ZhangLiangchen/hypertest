import { HypertestError, sha256Hex, type JsonSchema } from '@hypertest/core';
import {
  PLAN_PROPOSAL_SCHEMA, isTerminalWorkState, workItemFingerprint,
  type Assumption, type Objective, type PlanRevision, type PlannedWorkItem, type Ref, type WorkItem,
} from '@hypertest/domain';
import type { NewWorkItem } from '@hypertest/collab';
import type { ToolSpec } from '@hypertest/tools';
import type { ControlDeps } from '../deps.ts';
import { validatePlan } from '../plan-validator.ts';
import { WorkFactory, workScope } from '../work-factory.ts';
import { workBudgetFor } from '../util.ts';
import { Caller, domainTool, refuse, success } from './common.ts';

interface ProposalInput {
  rationale: string;
  objectives: Array<Omit<Objective, 'riskRefs' | 'acceptanceCriteria' | 'status'> & Partial<Pick<Objective, 'riskRefs' | 'acceptanceCriteria' | 'status'>>>;
  workItems: PlannedWorkItem[];
  cancelWorkItems?: string[];
  assumptions?: Array<{ statement: string; status?: Assumption['status'] }>;
  readyForGate?: boolean;
}

interface ProposeWorkInput {
  title: string;
  objective: string;
  role: string;
  rationale: string;
  priority?: number;
  inputRefs?: Ref[];
}

/** Number of plan revisions ever accepted in the run (superseded plans were accepted before). */
export function acceptedPlanCount(plans: readonly PlanRevision[]): number {
  return plans.filter((p) => p.status === 'accepted' || p.status === 'superseded').length;
}

function planSummary(p: PlanRevision): Record<string, unknown> {
  return {
    revision: p.revision,
    status: p.status,
    rationale: p.rationale,
    readyForGate: p.readyForGate,
    objectives: p.objectives,
    workItems: p.workItems.map((w) => ({ localId: w.localId, role: w.role, title: w.title, dependsOn: w.dependsOn, objectiveIds: w.objectiveIds })),
    cancelWorkItems: p.cancelWorkItems,
    validationIssues: p.validationIssues,
  };
}

export function planTools(deps: ControlDeps): ToolSpec[] {
  const { blackboard, runs, roles, ids, db, leases, admission, subagents, agents } = deps;
  const factory = new WorkFactory(deps);

  /** The result a replayed plan.propose_revision call returns: the outcome recorded by its first execution. */
  async function replayedOutcome(plan: PlanRevision) {
    if (plan.status === 'rejected') {
      return success(
        { accepted: false, revision: plan.revision, issues: plan.validationIssues, workItemIds: [], replayed: true },
        `plan revision ${plan.revision} REJECTED:\n- ${plan.validationIssues.join('\n- ')}\nFix the issues and propose again.`,
      );
    }
    const items = (await blackboard.listWorkItems({ runId: plan.runId, planRevision: plan.revision })).filter((w) => w.origin.kind === 'plan' && w.origin.planRevision === plan.revision);
    const order = new Map(plan.workItems.map((w, i) => [w.localId, i]));
    const workItemIds = items
      .sort((a, b) => (order.get(a.origin.kind === 'plan' ? a.origin.localId : '') ?? 0) - (order.get(b.origin.kind === 'plan' ? b.origin.localId : '') ?? 0))
      .map((w) => w.workItemId);
    return success({ accepted: true, revision: plan.revision, issues: [], workItemIds, readyForGate: plan.readyForGate, replayed: true });
  }

  return [
    domainTool<{ revision?: number }>({
      id: 'plan.read',
      title: 'Read the plan',
      description: 'Read a plan revision (default: the latest accepted one), the list of all revisions with their status, and every work item of the run with its role, state and result summary.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { revision: { type: 'integer', minimum: 1 } } },
      effect: 'read',
      area: 'plan',
      async execute(input, ctx) {
        const plans = await blackboard.listPlans(ctx.runId);
        const plan = input.revision !== undefined ? plans.find((p) => p.revision === input.revision) : await blackboard.latestAcceptedPlan(ctx.runId);
        if (input.revision !== undefined && !plan) return refuse('not_found', `plan revision ${input.revision} does not exist`);
        const items = await blackboard.listWorkItems({ runId: ctx.runId });
        return success({
          plan: plan ? planSummary(plan) : null,
          revisions: plans.map((p) => ({ revision: p.revision, status: p.status, readyForGate: p.readyForGate, workItems: p.workItems.length })),
          workItems: items.map((w) => ({
            workItemId: w.workItemId, kind: w.kind, role: w.role, title: w.title, state: w.state, planRevision: w.planRevision, objectiveIds: w.objectiveIds,
            dependsOn: w.dependsOn, resultSummary: w.result?.summary, failure: w.failure,
          })),
        });
      },
    }),

    domainTool<ProposalInput>({
      id: 'plan.propose_revision',
      title: 'Propose a plan revision',
      description:
        'Lead only. Propose the next typed plan revision (Plan IR): rationale, objectives, workItems (localId, title, objective, role, dependsOn, objectiveIds, optional inputRefs, expectedOutput, evidenceRequirements, budget, priority, toolPolicy, resourceClaims), cancelWorkItems, assumptions, readyForGate. The revision is validated deterministically; a valid revision is accepted and its work items are created at once, an invalid one is recorded as rejected with its issues.',
      inputSchema: PLAN_PROPOSAL_SCHEMA,
      area: 'plan',
      async execute(input, ctx) {
        const caller = new Caller(deps, ctx);
        const run = await caller.run();
        const evCtx = ctx.eventContext;
        // Retry-stable plan id: a replayed call (crash after the plan committed, before the tool call settled) finds
        // the revision it already recorded instead of accepting a second copy with duplicate work (I5).
        const planId = `plan_${sha256Hex(`${run.runId}\u0000${ctx.invocationId}`).slice(0, 26)}`;
        const objectives: Objective[] = input.objectives.map((o) => ({
          objectiveId: o.objectiveId,
          description: o.description,
          priority: o.priority,
          riskRefs: o.riskRefs ?? [],
          acceptanceCriteria: o.acceptanceCriteria ?? [],
          status: o.status ?? 'open',
        }));
        const proposal: Pick<PlanRevision, 'objectives' | 'workItems' | 'cancelWorkItems' | 'readyForGate' | 'rationale'> = {
          rationale: input.rationale,
          objectives,
          workItems: input.workItems,
          cancelWorkItems: input.cancelWorkItems ?? [],
          readyForGate: input.readyForGate ?? false,
        };
        const toInterrupt: WorkItem[] = [];
        // (H4) the replay lookup, the validation and the write happen under the run's work-creation lock in ONE
        // transaction: two concurrent executions of one replayed invocation cannot both accept a revision
        const outcome = await db.transaction(async (tx) => {
          await factory.lock(run.runId, tx); // lock order: work creation lock before the plan's event appends
          const recorded = (await blackboard.listPlans(run.runId)).find((p) => p.planId === planId);
          if (recorded) return { kind: 'replayed' as const, plan: recorded };
          const existing = await blackboard.listWorkItems({ runId: run.runId });
          const plans = await blackboard.listPlans(run.runId);
          const latest = await blackboard.latestAcceptedPlan(run.runId);
          const validation = validatePlan({ run, proposal, existingWorkItems: existing, roles, acceptedPlanCount: acceptedPlanCount(plans), proposerRole: ctx.role });
          const base: Omit<PlanRevision, 'revision' | 'status' | 'createdAt' | 'validationIssues' | 'decidedAt'> = {
            planId,
            runId: run.runId,
            rationale: proposal.rationale,
            objectives,
            workItems: proposal.workItems,
            cancelWorkItems: proposal.cancelWorkItems,
            assumptions: (input.assumptions ?? []).map((a) => ({ statement: a.statement, status: a.status ?? 'unverified' })),
            readyForGate: proposal.readyForGate,
            createdFromSnapshot: ctx.snapshot?.snapshotId ?? 'none',
            proposedBy: ctx.agentId,
          };
          if (latest) base.parentRevision = latest.revision;

          if (!validation.valid) {
            const p = await blackboard.proposePlan(base, evCtx, tx);
            const rejected = await blackboard.decidePlan(run.runId, p.revision, 'rejected', validation.issues, evCtx, tx);
            return { kind: 'rejected' as const, revision: rejected.revision, issues: validation.issues };
          }

          const byId = new Map(existing.map((w) => [w.workItemId, w]));
          const p = await blackboard.proposePlan(base, evCtx, tx);
          await blackboard.decidePlan(run.runId, p.revision, 'accepted', [], evCtx, tx);
          const localToId = new Map(proposal.workItems.map((w) => [w.localId, ids.next('wi')]));
          const created: string[] = [];
          for (const w of proposal.workItems) {
            const role = roles.require(w.role);
            const dependsOn = w.dependsOn.map((d) => localToId.get(d) ?? d);
            const ready = dependsOn.every((d) => byId.get(d)?.state === 'completed');
            const inputRefs = w.inputRefs ?? [];
            const item: NewWorkItem = {
              workItemId: localToId.get(w.localId)!,
              runId: run.runId,
              kind: 'task',
              origin: { kind: 'plan', planRevision: p.revision, localId: w.localId },
              title: w.title,
              objective: w.objective,
              role: w.role,
              objectiveIds: w.objectiveIds,
              capabilityRequirements: w.capabilityRequirements ?? [],
              inputRefs,
              evidenceRequirements: w.evidenceRequirements ?? [],
              dependsOn,
              budget: workBudgetFor(role, w.budget),
              priority: w.priority ?? 50,
              planRevision: p.revision,
              depth: 0,
              fingerprint: workItemFingerprint({ runId: run.runId, role: w.role, objective: w.objective, originKey: `plan:${p.revision}:${w.localId}`, inputRefs }),
              resourceClaims: w.resourceClaims ?? [],
              state: ready ? 'ready' : 'blocked',
            };
            const expectedOutput = w.expectedOutput ?? role.outputSchema;
            if (expectedOutput !== undefined) item.expectedOutput = expectedOutput;
            if (w.toolPolicy !== undefined) item.toolPolicy = w.toolPolicy;
            if (w.modelPolicy !== undefined) item.modelPolicy = w.modelPolicy;
            const r = await factory.create(item, evCtx, tx);
            if (r.status === 'capped') throw new HypertestError('budget_exhausted', r.reason);
            created.push(r.workItem.workItemId);
          }
          for (const id of proposal.cancelWorkItems) {
            const cur = await blackboard.getWorkItem(id);
            if (!cur || isTerminalWorkState(cur.state)) continue;
            if (cur.state === 'waiting') throw new HypertestError('precondition_failed', `work item ${id} started waiting on side effects; it cannot be cancelled`);
            await blackboard.transitionWorkItem(id, 'cancelled', { failure: { reason: 'cancelled', message: `cancelled by plan revision ${p.revision}` } }, evCtx, { tx });
            if (cur.state === 'claimed' || cur.state === 'running') toInterrupt.push(cur);
          }
          await runs.update(run.runId, { currentPlanRevision: p.revision }, evCtx, tx);
          return { kind: 'accepted' as const, revision: p.revision, workItemIds: created };
        });
        if (outcome.kind === 'replayed') return replayedOutcome(outcome.plan);
        if (outcome.kind === 'rejected') {
          return success(
            { accepted: false, revision: outcome.revision, issues: outcome.issues, workItemIds: [] },
            `plan revision ${outcome.revision} REJECTED:\n- ${outcome.issues.join('\n- ')}\nFix the issues and propose again.`,
          );
        }
        // Cancelled work: stop its agents and free its leases/claims (outside the plan transaction).
        for (const w of toInterrupt) {
          const agent = await agents.byWorkItem(w.workItemId);
          if (agent) await subagents.interrupt(agent.agentId, `cancelled by plan revision ${outcome.revision}`, evCtx).catch(() => undefined);
          if (w.claim) await leases.release(w.claim.leaseId);
          await admission.release(w.workItemId);
        }
        return success({ accepted: true, revision: outcome.revision, issues: [], workItemIds: outcome.workItemIds, readyForGate: proposal.readyForGate });
      },
    }),

    domainTool<ProposeWorkInput>({
      id: 'work.propose',
      title: 'Propose extra work',
      description:
        'Propose one extra work item between plan revisions for a role you may delegate to (or reviewer / rca), with a self-contained objective and your rationale. Subject to the run caps; identical proposals are not duplicated.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'objective', 'role', 'rationale'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          objective: { type: 'string', minLength: 1, maxLength: 4000 },
          role: { type: 'string', minLength: 1 },
          rationale: { type: 'string', minLength: 1, maxLength: 4000 },
          priority: { type: 'integer', minimum: 0, maximum: 100 },
          inputRefs: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['kind', 'id'], properties: { kind: { type: 'string' }, id: { type: 'string', minLength: 1 }, note: { type: 'string' } } },
          },
        },
      } as JsonSchema,
      area: 'work',
      async execute(input, ctx) {
        const caller = new Caller(deps, ctx);
        if (input.role === 'lead') return refuse('permission_denied', 'lead work is created by the scheduler (replans), never proposed');
        const target = roles.get(input.role);
        if (!target) return refuse('invalid_argument', `unknown role ${input.role}`);
        const mine = roles.require(ctx.role);
        const allowed = new Set([...mine.canDelegateTo, 'reviewer', 'rca']);
        if (!allowed.has(input.role)) return refuse('permission_denied', `role ${ctx.role} may propose work only for ${[...allowed].join(', ')}`);
        const parent = await caller.item();
        const run = await caller.run();
        // causal-depth guard (I12): proposals of proposals cannot chain beyond the run's agent depth
        if (parent.depth + 1 > run.budget.maxAgentDepth) {
          return refuse('permission_denied', `proposed work would have depth ${parent.depth + 1}, beyond the run's maxAgentDepth ${run.budget.maxAgentDepth}`);
        }
        const inputRefs = input.inputRefs ?? [];
        const objective = `${input.objective}\n\nRationale (proposed by ${ctx.role} ${ctx.agentId}): ${input.rationale}`;
        const item: NewWorkItem = {
          runId: ctx.runId,
          kind: 'task',
          origin: { kind: 'system', reason: `proposed_by:${ctx.agentId}` },
          title: input.title,
          objective,
          role: input.role,
          objectiveIds: parent.objectiveIds,
          capabilityRequirements: [],
          inputRefs,
          evidenceRequirements: [],
          dependsOn: [],
          budget: workBudgetFor(target),
          priority: input.priority ?? 50,
          depth: parent.depth + 1,
          fingerprint: workItemFingerprint({ runId: ctx.runId, role: input.role, objective: input.objective, originKey: `proposed:${ctx.agentId}`, inputRefs }),
          resourceClaims: [],
          state: 'ready',
          parentWorkItemId: parent.workItemId,
        };
        if (target.outputSchema !== undefined) item.expectedOutput = target.outputSchema;
        const r = await factory.create(item, ctx.eventContext);
        if (r.status === 'capped') return refuse('budget_exhausted', r.reason);
        return success({ workItemId: r.workItem.workItemId, created: r.status === 'created', scope: workScope(r.workItem.workItemId) });
      },
    }),
  ];
}
