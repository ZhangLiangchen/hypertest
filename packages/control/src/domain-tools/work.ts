import { canonicalJson, isValidSchema, validateJson, type JsonSchema, type JsonValue } from '@hypertest/core';
import { WORK_COMPLETION_SCHEMA, workItemFingerprint, type ActorRef, type Ref } from '@hypertest/domain';
import type { NewWorkItem } from '@hypertest/collab';
import type { ToolSpec } from '@hypertest/tools';
import type { ApprovalRequest } from '@hypertest/policy';
import type { TerminalSignal } from '@hypertest/runtime';
import type { ControlDeps } from '../deps.ts';
import { WorkFactory } from '../work-factory.ts';
import { workBudgetFor } from '../util.ts';
import { Caller, checkEvidence, checkRecords, domainTool, refuse, success } from './common.ts';

/** Operation id a delegating agent waits on: the child work item. */
export function delegationOperationId(childWorkItemId: string): string {
  return `work:${childWorkItemId}`;
}

export function parseDelegationOperationId(operationId: string): string | undefined {
  return operationId.startsWith('work:') ? operationId.slice('work:'.length) : undefined;
}

interface DelegateInput {
  role: string;
  objective: string;
  title?: string;
  expectedOutput?: JsonSchema;
  inputRefs?: Ref[];
}

interface CompleteInput {
  summary: string;
  output?: JsonValue;
  evidenceRefs?: string[];
  recordRefs?: string[];
}

const REF_ITEMS = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id'],
  properties: {
    kind: { type: 'string', enum: ['run', 'record', 'evidence', 'artifact', 'work_item', 'plan', 'file', 'commit', 'url', 'oracle', 'experiment', 'test_artifact', 'system_model', 'operation', 'decision'] },
    id: { type: 'string', minLength: 1 },
    note: { type: 'string' },
  },
} as const;

export function workTools(deps: ControlDeps): ToolSpec[] {
  const { roles, approvals, evidence } = deps;
  const factory = new WorkFactory(deps);

  return [
    domainTool<DelegateInput>({
      id: 'delegate',
      title: 'Delegate a sub-task',
      description:
        'Delegate a small, bounded sub-task to a role you may delegate to. A child work item is created and you WAIT (the call is pending) until it finishes; you then receive only its summary and cited ids, never its transcript. Several delegate calls in one turn run in parallel.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'objective'],
        properties: {
          role: { type: 'string', minLength: 1 },
          objective: { type: 'string', minLength: 1, maxLength: 4000 },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          expectedOutput: { type: 'object' },
          inputRefs: { type: 'array', items: REF_ITEMS },
        },
      } as JsonSchema,
      area: 'work',
      async execute(input, ctx) {
        const caller = new Caller(deps, ctx);
        const mine = roles.require(ctx.role);
        const target = roles.get(input.role);
        if (!target) return refuse('invalid_argument', `unknown role ${input.role}`);
        if (!mine.canDelegateTo.includes(input.role)) return refuse('permission_denied', `role ${ctx.role} may not delegate to ${input.role} (allowed: ${mine.canDelegateTo.join(', ') || 'none'})`);
        const agent = await caller.agent();
        const run = await caller.run();
        const cap = Math.min(mine.maxDepth, run.budget.maxAgentDepth);
        if (agent.depth + 1 > cap) return refuse('permission_denied', `delegation depth ${agent.depth + 1} exceeds the cap ${cap} (min of role maxDepth ${mine.maxDepth} and run maxAgentDepth ${run.budget.maxAgentDepth})`);
        if (input.expectedOutput !== undefined && !isValidSchema(input.expectedOutput)) return refuse('invalid_argument', 'expectedOutput is not a valid JSON schema');
        const parent = await caller.item();
        const inputRefs = input.inputRefs ?? [];
        const item: NewWorkItem = {
          runId: ctx.runId,
          kind: 'delegation',
          origin: { kind: 'delegation', parentWorkItemId: parent.workItemId, parentAgentId: agent.agentId },
          title: input.title ?? `${input.role}: ${input.objective.slice(0, 120)}`,
          objective: input.objective,
          role: input.role,
          objectiveIds: parent.objectiveIds,
          capabilityRequirements: [],
          inputRefs,
          evidenceRequirements: [],
          dependsOn: [],
          budget: workBudgetFor(target),
          priority: Math.min(100, parent.priority + 1),
          parentWorkItemId: parent.workItemId,
          depth: parent.depth + 1,
          // the invocation id is retry-stable: a replayed delegate call finds the same child
          fingerprint: workItemFingerprint({ runId: ctx.runId, role: input.role, objective: input.objective, originKey: `delegate:${ctx.invocationId}`, inputRefs }),
          resourceClaims: [],
          state: 'ready',
        };
        const expectedOutput = input.expectedOutput ?? target.outputSchema;
        if (expectedOutput !== undefined) item.expectedOutput = expectedOutput;
        const r = await factory.create(item, ctx.eventContext);
        if (r.status === 'capped') return refuse('budget_exhausted', r.reason);
        const operationId = delegationOperationId(r.workItem.workItemId);
        return {
          status: 'pending',
          operationId,
          structured: { workItemId: r.workItem.workItemId, role: input.role, operationId },
          text: `delegated to ${input.role} as work item ${r.workItem.workItemId}; you will receive its result summary when it finishes (operation ${operationId})`,
        };
      },
    }),

    domainTool<{ kind: ApprovalRequest['kind']; subject: JsonValue; rationale: string }>({
      id: 'request_approval',
      title: 'Request an approval',
      description: 'Request an independent (human or governance) approval for a step you must not take on your own: a destructive environment action, a product fix, an oracle or test change, a budget increase, a manual review. Returns the approvalId.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'subject', 'rationale'],
        properties: {
          kind: { type: 'string', enum: ['action', 'oracle_change', 'test_change', 'budget', 'manual_review'] },
          subject: {},
          rationale: { type: 'string', minLength: 1, maxLength: 4000 },
        },
      } as JsonSchema,
      area: 'approvals',
      async execute(input, ctx) {
        // the same pending request of this agent (e.g. a replayed call) is returned, not filed twice
        const pending = (await approvals.list({ runId: ctx.runId, status: ['pending'] })).find(
          (a: ApprovalRequest) =>
            a.kind === input.kind && a.requestedBy.id === ctx.agentId && a.rationale === input.rationale && canonicalJson(a.subject as JsonValue) === canonicalJson(input.subject),
        );
        if (pending) return success({ approvalId: pending.approvalId, status: pending.status, deduplicated: true });
        // the requester with its current model provider: an agent approver must be independent of it (I8)
        const epoch = await new Caller(deps, ctx).epoch();
        const requestedBy: ActorRef = { kind: 'agent', id: ctx.agentId, role: ctx.role };
        if (epoch.provider !== undefined) requestedBy.modelProvider = epoch.provider;
        const approval = await approvals.request({ runId: ctx.runId, kind: input.kind, subject: input.subject, requestedBy, rationale: input.rationale }, ctx.eventContext);
        return success({ approvalId: approval.approvalId, status: approval.status });
      },
    }),

    domainTool<CompleteInput>({
      id: 'complete_work',
      title: 'Complete the work item',
      description:
        'Finish your work item with a summary, the structured output required by your output contract (validated against the work item\'s expected output) and the evidence/record ids you relied on. Refused (you may continue) when the output is invalid or the work item\'s evidence requirements are not met by evidence you produced.',
      inputSchema: WORK_COMPLETION_SCHEMA,
      area: 'work',
      async execute(input, ctx) {
        const caller = new Caller(deps, ctx);
        const item = await caller.item();
        const problems: string[] = [];
        if (item.expectedOutput !== undefined) {
          if (input.output === undefined) problems.push('output is required by this work item\'s expected output schema');
          else {
            const v = validateJson(item.expectedOutput, input.output);
            if (!v.valid) problems.push(...v.issues.map((i) => `output${i.path === '/' ? '' : i.path} ${i.message}`));
          }
        }
        const missing: string[] = [];
        for (const req of item.evidenceRequirements) {
          const found = await evidence.query({ runId: ctx.runId, workItemId: item.workItemId, evidenceType: req.evidenceType });
          if (found.length < req.minCount) missing.push(`${req.minCount}× ${req.evidenceType} (found ${found.length})`);
        }
        if (missing.length) problems.push(`evidence requirements not met by this work item's own evidence: ${missing.join(', ')}`);
        const evidenceRefs = [...new Set(input.evidenceRefs ?? [])];
        const recordRefs = [...new Set(input.recordRefs ?? [])];
        const ev = await checkEvidence(deps, ctx.runId, evidenceRefs);
        if (!ev.ok) problems.push(...ev.problems);
        problems.push(...(await checkRecords(deps, ctx.runId, recordRefs)));
        if (problems.length > 0) {
          return refuse('completion_refused', `complete_work refused; fix and call it again:\n- ${problems.join('\n- ')}`, { problems, missingEvidence: missing });
        }
        const terminal: TerminalSignal = { kind: 'complete', summary: input.summary, evidenceRefs, recordRefs };
        if (input.output !== undefined) terminal.output = input.output;
        return success({ terminal }, 'work item completed');
      },
    }),

    domainTool<{ reason: string; message: string }>({
      id: 'fail_work',
      title: 'Fail the work item',
      description: 'End your work item as failed with a precise reason (access denied, evidence unobtainable, contradictory instructions, budget nearly spent).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['reason', 'message'],
        properties: { reason: { type: 'string', minLength: 1, maxLength: 200 }, message: { type: 'string', minLength: 1, maxLength: 4000 } },
      },
      area: 'work',
      async execute(input) {
        const terminal: TerminalSignal = { kind: 'fail', reason: input.reason, message: input.message };
        return success({ terminal }, 'work item failed');
      },
    }),
  ];
}
