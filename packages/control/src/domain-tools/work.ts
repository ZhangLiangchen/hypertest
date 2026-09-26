import { canonicalJson, isValidSchema, sha256Hex, validateJson, type JsonSchema, type JsonValue } from '@hypertest/core';
import { WORK_COMPLETION_SCHEMA, isTerminalWorkState, workItemFingerprint, type ActorRef, type CapabilityRequirement, type Ref } from '@hypertest/domain';
import type { NewWorkItem } from '@hypertest/collab';
import type { ToolSpec } from '@hypertest/tools';
import type { ApprovalRequest } from '@hypertest/policy';
import type { TerminalSignal } from '@hypertest/runtime';
import type { ControlDeps } from '../deps.ts';
import { CAPABILITY_REQUIREMENT_SCHEMA, requirementProblems } from '../capability-grant.ts';
import { delegationChatMessage, delegationOperationId, delegationSettled, isAwaitingInput, unreadMessages } from '../delegation.ts';
import { createPhaseGovernor } from '../phases.ts';
import { ControlStore, type Delegation, type DelegationMessage } from '../store.ts';
import { WorkFactory } from '../work-factory.ts';
import { clip, event, workBudgetFor } from '../util.ts';
import { Caller, checkEvidence, checkRecords, domainTool, refuse, success } from './common.ts';

export { delegationOperationId, parseDelegationOperationId } from '../delegation.ts';

interface DelegateInput {
  role: string;
  objective: string;
  title?: string;
  expectedOutput?: JsonSchema;
  inputRefs?: Ref[];
  /** (additive) Return at once; the child runs while the parent keeps working (delegate.status / delegate.collect). */
  background?: boolean;
  /** (additive) The child waits for more input after each task until released (delegate.message / delegate.release). */
  continuable?: boolean;
  /** (additive) What the child needs (I2: granted only within the parent's capability; the excess is reported to it). */
  capabilityRequirements?: CapabilityRequirement[];
}

interface CompleteInput {
  summary: string;
  output?: JsonValue;
  evidenceRefs?: string[];
  recordRefs?: string[];
}

const CHILD_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['childWorkItemId'],
  properties: { childWorkItemId: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

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
  const { roles, approvals, evidence, blackboard, agents, subagents, db, clock, events } = deps;
  const factory = new WorkFactory(deps);
  const store = new ControlStore(db);
  const phases = createPhaseGovernor(deps, deps.config);

  /** The caller's own delegated child (a child of another work item is never visible: not_found). */
  async function myChild(childWorkItemId: string, callerWorkItemId: string): Promise<Delegation | undefined> {
    const d = await store.delegation(childWorkItemId);
    return d && d.parentWorkItemId === callerWorkItemId ? d : undefined;
  }

  return [
    domainTool<DelegateInput>({
      id: 'delegate',
      title: 'Delegate a sub-task',
      description:
        'Delegate a small, bounded sub-task to a role you may delegate to. A child work item is created and, by default, you WAIT (the call is pending) until it finishes; you then receive only its summary and cited ids, never its transcript. Several delegate calls in one turn run in parallel. background: true returns at once with the child id and you keep working (delegate.status / delegate.collect; you are told when it finishes). continuable: true keeps the child for follow-up questions after each task (delegate.message) until you release it (delegate.release; it is released when your work item ends). capabilityRequirements narrow what the child may do (never beyond your own capability).',
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
          background: { type: 'boolean' },
          continuable: { type: 'boolean' },
          capabilityRequirements: { type: 'array', maxItems: 20, items: CAPABILITY_REQUIREMENT_SCHEMA },
        },
      } as JsonSchema,
      area: 'work',
      async execute(input, ctx) {
        const caller = new Caller(deps, ctx);
        const mine = roles.require(ctx.role);
        const requirementIssues = requirementProblems(input.capabilityRequirements ?? []);
        if (requirementIssues.length > 0) return refuse('invalid_argument', `invalid capabilityRequirements: ${requirementIssues.join('; ')}`);
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
          capabilityRequirements: input.capabilityRequirements ?? [],
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
        const background = input.background === true;
        const continuable = input.continuable === true;
        // the child and its delegation record commit together (a replay finds both)
        const r = await db.transaction(async (tx) => {
          const created = await factory.create(item, ctx.eventContext, tx);
          if (created.status !== 'capped') {
            await store.putDelegation(
              { childWorkItemId: created.workItem.workItemId, runId: ctx.runId, parentWorkItemId: parent.workItemId, parentAgentId: agent.agentId, background, continuable, createdAt: clock.isoNow() },
              tx,
            );
          }
          return created;
        });
        if (r.status === 'capped') return refuse('budget_exhausted', r.reason);
        const childId = r.workItem.workItemId;
        const mode = `${continuable ? 'continuable: after each task it waits for delegate.message until you delegate.release it (or your work item ends)' : 'one task'}`;
        if (background) {
          return success(
            { workItemId: childId, role: input.role, background: true, continuable },
            `delegated to ${input.role} in the BACKGROUND as work item ${childId} (${mode}); keep working — check it with delegate.status / delegate.collect, you are also told in your inbox when it finishes`,
          );
        }
        const operationId = delegationOperationId(childId);
        return {
          status: 'pending',
          operationId,
          structured: { workItemId: childId, role: input.role, operationId, ...(continuable ? { continuable: true } : {}) },
          text: `delegated to ${input.role} as work item ${childId}; you will receive its result summary when it finishes (operation ${operationId})${continuable ? `; ${mode}` : ''}`,
        };
      },
    }),

    domainTool<{ childWorkItemId: string }>({
      id: 'delegate.status',
      title: 'Status of a delegated child',
      description: 'The state of a child you delegated (running, waiting for your input, completed, failed …), whether its task result is available, whether it is continuable/released and how many of your messages it has not read yet. Never its transcript.',
      inputSchema: CHILD_INPUT as JsonSchema,
      effect: 'read',
      area: 'work',
      async execute(input, ctx) {
        const d = await myChild(input.childWorkItemId, ctx.workItemId);
        if (!d) return refuse('not_found', `work item ${input.childWorkItemId} is not a child you delegated`);
        const child = await blackboard.getWorkItem(d.childWorkItemId);
        if (!child) return refuse('not_found', `work item ${input.childWorkItemId} does not exist`);
        const agent = await agents.byWorkItem(child.workItemId);
        return success({
          workItemId: child.workItemId,
          role: child.role,
          state: child.state,
          background: d.background,
          continuable: d.continuable,
          released: d.releasedAt !== undefined,
          ...(d.releaseReason !== undefined ? { releaseReason: d.releaseReason } : {}),
          awaitingInput: isAwaitingInput(child),
          resultAvailable: delegationSettled(child),
          agentStatus: agent?.status ?? 'not_started',
          unreadMessages: (await unreadMessages(deps, d, agent)).length,
        });
      },
    }),

    domainTool<{ childWorkItemId: string }>({
      id: 'delegate.collect',
      title: 'Collect a delegated child\'s result',
      description: 'The latest task result of a child you delegated: its summary, structured output and cited evidence/record ids (or its failure) — only the result channel, never its transcript. Before the child finished a task it reports settled: false.',
      inputSchema: CHILD_INPUT as JsonSchema,
      effect: 'read',
      area: 'work',
      async execute(input, ctx) {
        const d = await myChild(input.childWorkItemId, ctx.workItemId);
        if (!d) return refuse('not_found', `work item ${input.childWorkItemId} is not a child you delegated`);
        const child = await blackboard.getWorkItem(d.childWorkItemId);
        if (!child) return refuse('not_found', `work item ${input.childWorkItemId} does not exist`);
        if (!delegationSettled(child)) return success({ workItemId: child.workItemId, state: child.state, settled: false }, `child ${child.workItemId} (${child.role}) is ${child.state}: no task result yet`);
        const agent = await agents.byWorkItem(child.workItemId);
        const r = agent ? await subagents.collect(agent.agentId) : undefined;
        const summary = r?.summary ?? child.result?.summary;
        const output = r?.output ?? child.result?.output;
        const failure = r?.failure ?? child.failure;
        const out: Record<string, unknown> = {
          workItemId: child.workItemId,
          role: child.role,
          state: child.state,
          settled: true,
          awaitingInput: isAwaitingInput(child),
          evidenceRefs: r?.evidenceRefs ?? child.result?.evidenceRefs ?? [],
          recordRefs: r?.recordRefs ?? child.result?.recordRefs ?? [],
        };
        if (summary !== undefined) out['summary'] = clip(summary, 4000);
        if (output !== undefined) out['output'] = output;
        if (failure !== undefined) out['failure'] = failure;
        return success(out, `result of child ${child.workItemId} (${child.role}, ${isAwaitingInput(child) ? 'waiting for more input' : child.state})`, (out['evidenceRefs'] as string[]).length ? (out['evidenceRefs'] as string[]) : undefined);
      },
    }),

    domainTool<{ childWorkItemId: string; text: string }>({
      id: 'delegate.message',
      title: 'Message a continuable child',
      description: 'Queue a follow-up message for a continuable child you delegated (a question or a new bounded sub-task). A child waiting for input resumes with it; a busy child reads it at its next turn. Its answer arrives as its next task result (delegate.collect, and a note in your inbox).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['childWorkItemId', 'text'],
        properties: { childWorkItemId: { type: 'string', minLength: 1, maxLength: 128 }, text: { type: 'string', minLength: 1, maxLength: 4000 } },
      },
      area: 'work',
      async execute(input, ctx) {
        const d0 = await myChild(input.childWorkItemId, ctx.workItemId);
        if (!d0) return refuse('not_found', `work item ${input.childWorkItemId} is not a child you delegated`);
        if (!d0.continuable) return refuse('precondition_failed', `child ${input.childWorkItemId} is not continuable: it takes no follow-up messages (delegate with continuable: true)`);
        if (d0.releasedAt !== undefined) return refuse('precondition_failed', `child ${input.childWorkItemId} was released (${d0.releaseReason ?? 'released'}); delegate a new child instead`);
        const child = await blackboard.getWorkItem(input.childWorkItemId);
        if (!child || isTerminalWorkState(child.state)) return refuse('precondition_failed', `child ${input.childWorkItemId} is ${child?.state ?? 'missing'}; it takes no more messages`);
        // retry-stable id: a replayed call queues its message once
        const messageId = `dmsg_${sha256Hex(`delegate.message\u0000${ctx.invocationId}`).slice(0, 20)}`;
        const outcome = await db.transaction(async (tx) => {
          const d = (await store.delegation(input.childWorkItemId, tx, true))!;
          if (d.messages.some((m) => m.messageId === messageId)) return { deduplicated: true, enqueued: d.messages.find((m) => m.messageId === messageId)!.enqueued };
          const message: DelegationMessage = { messageId, text: input.text, from: { agentId: ctx.agentId, role: ctx.role, workItemId: ctx.workItemId }, at: clock.isoNow(), enqueued: false };
          const agent = await agents.byWorkItem(input.childWorkItemId);
          if (agent && agent.status !== 'disposed' && agent.status !== 'failed') {
            // queued input of the child's session (SubagentRuntime.message); a child not spawned yet gets it with its task
            await subagents.message(agent.agentId, delegationChatMessage(message));
            message.enqueued = true;
          }
          await store.setDelegationMessages(input.childWorkItemId, [...d.messages, message], tx);
          await events.append([event(ctx.eventContext, 'delegation.message_queued', 'work_item', input.childWorkItemId, { childWorkItemId: input.childWorkItemId, messageId, enqueued: message.enqueued, bytes: Buffer.byteLength(input.text) })], tx);
          return { deduplicated: false, enqueued: message.enqueued };
        });
        return success(
          { childWorkItemId: input.childWorkItemId, messageId, queued: true, ...outcome },
          `message ${messageId} queued for child ${input.childWorkItemId}${isAwaitingInput(child) ? ' (it resumes with it)' : outcome.enqueued ? ' (read at its next turn)' : ' (handed over when it starts)'}`,
        );
      },
    }),

    domainTool<{ childWorkItemId: string }>({
      id: 'delegate.release',
      title: 'Release a continuable child',
      description: 'Release a continuable child you delegated: it takes no more messages and its work item completes with its last task result (at once when it waits for input, else after its current task). Children are released automatically when your own work item ends.',
      inputSchema: CHILD_INPUT as JsonSchema,
      area: 'work',
      async execute(input, ctx) {
        const d = await myChild(input.childWorkItemId, ctx.workItemId);
        if (!d) return refuse('not_found', `work item ${input.childWorkItemId} is not a child you delegated`);
        if (!d.continuable) return refuse('invalid_argument', `child ${input.childWorkItemId} is not continuable: it ends with its task (nothing to release)`);
        const reason = `released by ${ctx.role} ${ctx.agentId}`;
        const released = await db.transaction(async (tx) => {
          const changed = await store.releaseDelegation(input.childWorkItemId, reason, clock.isoNow(), tx);
          if (changed) {
            await events.append([event(ctx.eventContext, 'delegation.released', 'work_item', input.childWorkItemId, { childWorkItemId: input.childWorkItemId, parentWorkItemId: ctx.workItemId, reason, auto: false })], tx);
          }
          return changed;
        });
        const child = await blackboard.getWorkItem(input.childWorkItemId);
        return success(
          { childWorkItemId: input.childWorkItemId, released: true, alreadyReleased: !released, state: child?.state ?? 'missing' },
          `child ${input.childWorkItemId} released${released ? '' : ' (already)'}; it completes with its last result`,
        );
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
        // BUGate before_transition (work_item → completed): the policy may refuse the completion (e.g. the item's calls
        // were flagged after action); decided and logged like every permit
        const own = await evidence.query({ runId: ctx.runId, workItemId: item.workItemId });
        const byType: Record<string, number> = {};
        for (const e of own) byType[e.evidenceType] = (byType[e.evidenceType] ?? 0) + 1;
        const permit = await phases.beforeTransition({
          runId: ctx.runId,
          transition: {
            subject: 'work_item', subjectId: item.workItemId, from: item.state, to: 'completed',
            details: { role: item.role, kind: item.kind, evidenceByType: byType, citedEvidence: evidenceRefs.length, citedRecords: recordRefs.length, structuredOutput: input.output !== undefined },
          },
          workItemId: item.workItemId,
          requestedBy: { agentId: ctx.agentId, role: ctx.role },
          ctx: ctx.eventContext,
        });
        if (permit.decision !== 'allow') {
          return refuse(
            'policy_denied',
            `complete_work refused by policy (before_transition work_item:completed, ${permit.decision}, decision ${permit.decisionId}): ${permit.reasons.join('; ') || 'no reason given'}. ${permit.decision === 'approval_required' ? 'Request an approval (request_approval) or ' : ''}finish with fail_work if this cannot be resolved.`,
            { decisionId: permit.decisionId, decision: permit.decision, reasons: permit.reasons },
          );
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
