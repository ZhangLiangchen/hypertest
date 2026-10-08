import { deepFreeze, sha256Hex, type JsonValue } from '@hypertest/core';
import { EFFECT_ORDER, RISK_ORDER, type ActionCapability, type EventContext, type RiskClass, type ToolEffect } from '@hypertest/domain';
import {
  actionOutcomeFacts, createRootCapability, requestPhase,
  type AcceptanceFacts, type ActionOutcomeFacts, type ActionPermit, type ActionRequest, type PolicyPhase, type TransitionFacts,
} from '@hypertest/policy';
import type { ToolExecutionResult, ToolSpec } from '@hypertest/tools';
import type { ControlDeps, ResolvedControlConfig } from './deps.ts';
import { clip, event, systemActor } from './util.ts';

/**
 * BUGate four time points in the control plane (technology-selection §BUGate): the ToolRuntime evaluates the policy
 * BEFORE an action; the control plane evaluates it AFTER the action (the dispatcher), BEFORE the state transitions it
 * owns (work item completion in complete_work, plan acceptance in plan.propose_revision, run gating in the gate path) and
 * BEFORE final acceptance (the gate input digest + the gate verdict). Every decision is recorded in the policy decision
 * log (request + permit + policy revision: replayable) and emitted as `policy.decided` with its phase.
 *
 * Non-action phases are requested by the control plane itself: their capability is a short-lived, signed system
 * capability (subject `system:control:<workerId>`, effect `record` on `run/<runId>/**`, risk low, the one phase tool
 * `transition.<subject>` / `gate.accept`) — the same capability check as any request, never handed to an agent.
 */

/** L0 event of a call flagged at after_action (deterministic id per invocation: a replayed call is flagged once). */
export const POLICY_FLAGGED_EVENT = 'policy.flagged';

/** The deterministic event id of the `policy.flagged` event of one tool invocation. */
export function flagEventId(invocationId: string): string {
  return `evt_flag_${sha256Hex(`policy.flagged\u0000${invocationId}`).slice(0, 32)}`;
}

/**
 * The evidence types the built-in tools declare (what each may write to the ledger; the ToolRuntime's `tool-output`
 * offload is implicit for every tool). A tool spec carrying its own `evidenceTypes` list wins; domain tools, MCP bridge
 * tools and any other tool that declares nothing may write no evidence but `tool-output` (fail closed: an undeclared
 * producer is flagged at after_action — a deployment tool that records evidence must declare its types).
 */
export const TOOL_EVIDENCE_TYPES: Readonly<Record<string, readonly string[]>> = deepFreeze<Record<string, readonly string[]>>({
  'fs.read': [], 'fs.list': [], 'fs.search': [], 'fs.write': [], 'fs.apply_patch': [],
  'git.status': [], 'git.diff': ['git-diff'], 'git.log': [], 'git.show': [], 'git.blame': [], 'git.commit': [],
  // (E[2]) a sandboxed command's state-changing request to the SUT is relayed as a ledgered operation whose exchange the
  // runtime records as `api-response` evidence of the call (never written by the agent)
  'shell.exec': ['stdout', 'stderr', 'api-response'],
  'test.run': ['test-result', 'stdout', 'stderr', 'coverage', 'api-response'],
  'coverage.collect': ['coverage', 'api-response'],
  'mutation.run': ['mutation-result', 'api-response'],
  'code.symbols': [], 'code.references': [],
  'http.request': ['api-response'],
  'metrics.query': ['metric'], 'metrics.scrape': ['metric'],
  'load.start': ['metric'], 'load.observe': ['metric'], 'load.stop': ['metric'],
  'browser.navigate': [], 'browser.click': [], 'browser.fill': [], 'browser.text': [], 'browser.screenshot': ['screenshot'],
});

/**
 * The evidence types `toolId` declares (see TOOL_EVIDENCE_TYPES). A tool that declares none — a domain or MCP tool, or a
 * tool neither listed nor carrying a well-formed `evidenceTypes` — declares the empty list: it is judged like any tool,
 * so evidence it writes (beyond the implicit `tool-output`) is undeclared and flagged. Never undefined (fail closed).
 */
export function declaredEvidenceTypes(deps: Pick<ControlDeps, 'registry'>, toolId: string): string[] {
  const own = (deps.registry.get(toolId) as (ToolSpec & { evidenceTypes?: unknown }) | undefined)?.evidenceTypes;
  if (Array.isArray(own) && own.every((t) => typeof t === 'string')) return [...(own as string[])];
  if (Object.hasOwn(TOOL_EVIDENCE_TYPES, toolId)) return [...TOOL_EVIDENCE_TYPES[toolId]!];
  return [];
}

/** How an executed call was classified (the request its before_action permit was given for, when it is on record). */
export interface ActionDescription {
  effect: ToolEffect;
  riskClass: RiskClass;
  resources: string[];
  environmentClass?: string;
  input?: JsonValue;
}

export interface AfterActionInput {
  runId: string;
  workItemId: string;
  agentId: string;
  role: string;
  capability: ActionCapability;
  toolId: string;
  invocationId: string;
  execution: ToolExecutionResult;
  eventContext: EventContext;
  snapshotId?: string;
  /** How to classify the call when its before_action decision is not on record. */
  describe(): ActionDescription;
}

export interface AfterActionOutcome {
  permit: ActionPermit;
  facts: ActionOutcomeFacts;
  /** True when the call was flagged (permit not `allow`). */
  flagged: boolean;
}

export interface TransitionInput {
  runId: string;
  transition: Omit<TransitionFacts, 'flaggedActions'>;
  /** The work item the request is bound to (the subject's own item, or the proposer's for a plan); default the run. */
  workItemId?: string;
  /** The requesting agent (role-based rules see its role). */
  requestedBy?: { agentId: string; role: string };
  ctx: EventContext;
}

export interface PhaseGovernor {
  /**
   * after_action: judges what an executed call produced; undefined when the call never ran (denied / stale) or has no
   * outcome to judge (no evidence written or cited, and its tool declares no evidence types).
   */
  afterAction(input: AfterActionInput): Promise<AfterActionOutcome | undefined>;
  /** before_transition: may the work item complete / the plan be accepted / the run be gated? */
  beforeTransition(input: TransitionInput): Promise<ActionPermit>;
  /** before_acceptance: may the run claim its gate verdict? */
  beforeAcceptance(input: { runId: string; facts: AcceptanceFacts; ctx: EventContext }): Promise<ActionPermit>;
  /** Calls flagged at after_action: of one work item, or of the whole run. */
  flaggedActions(runId: string, workItemId?: string): Promise<number>;
}

const SYSTEM_CAPABILITY_TTL_MS = 5 * 60_000;

export function createPhaseGovernor(deps: ControlDeps, config: Pick<ResolvedControlConfig, 'capabilitySecret' | 'workerId'>): PhaseGovernor {
  const { policy, decisionLog, events, evidence, ids, clock, logger } = deps;
  const actor = systemActor(config.workerId);

  /** Evaluates fail closed (an engine error or a malformed permit is a deny) and records the decision. */
  async function decide(request: ActionRequest, ctx: EventContext): Promise<ActionPermit> {
    let permit: ActionPermit;
    try {
      permit = await policy.evaluate(request);
      if (!permit || (permit.decision !== 'allow' && permit.decision !== 'deny' && permit.decision !== 'approval_required') || typeof permit.decisionId !== 'string' || permit.decisionId === '' || !Array.isArray(permit.reasons)) {
        throw new Error('policy engine returned a malformed permit');
      }
    } catch (e) {
      logger.error('policy evaluation failed; denying (fail closed)', { phase: requestPhase(request), requestId: request.requestId, error: (e as Error).message });
      permit = { decision: 'deny', decisionId: ids.next('pdec'), reasons: [`policy_engine_error: ${(e as Error).message}`], policyRevision: policy.revision };
    }
    await decisionLog.record(request, permit, ctx);
    return permit;
  }

  function systemRequest(runId: string, workItemId: string, tool: string, resource: string, phase: PolicyPhase, requestId: string): ActionRequest {
    const capability = createRootCapability(
      {
        runId,
        subjectAgentId: actor,
        workItemId,
        profile: { name: 'control_phase', allowedEffects: ['record'], maxRiskClass: 'low', resourceScopes: [`run/${runId}/**`], environmentClasses: [], credentialScopes: [] },
        tools: [tool],
        expiresAt: new Date(clock.nowMs() + SYSTEM_CAPABILITY_TTL_MS).toISOString(),
      },
      config.capabilitySecret,
    );
    return { requestId, runId, workItemId, agentId: actor, tool, effect: 'record', riskClass: 'low', resources: [resource], capability, phase };
  }

  async function flaggedActions(runId: string, workItemId?: string): Promise<number> {
    const flagged = await events.read(runId, { types: [POLICY_FLAGGED_EVENT] });
    return new Set(flagged.filter((e) => workItemId === undefined || e.workItemId === workItemId).map((e) => e.aggregateId)).size;
  }

  return {
    flaggedActions,

    async afterAction(input) {
      const { execution } = input;
      // only a call that ran is judged after the fact: one refused before the action (no allow permit) never executed.
      // A call the tool itself ended as denied / stale is judged when it wrote evidence all the same (whatever a call
      // wrote is judged, whatever status it reports).
      if (!execution.permit || execution.permit.decision !== 'allow') return undefined;
      const evidenceRefs = Array.isArray(execution.evidenceRefs) ? execution.evidenceRefs : [];
      if ((execution.status === 'denied' || execution.status === 'stale_context') && evidenceRefs.length === 0) return undefined;
      const declared = declaredEvidenceTypes(deps, input.toolId);
      // …and only a call with an outcome to judge: it wrote or cited evidence (the runtime lists every record the call
      // wrote in evidenceRefs), or its tool is an evidence producer (a declared producer that produced nothing is judged
      // too). Bookkeeping calls (blackboard, plan, reads) that touch no evidence have no after_action decision.
      if (evidenceRefs.length === 0 && declared.length === 0) return undefined;
      const produced = await evidence.query({ runId: input.runId, toolInvocationId: input.invocationId });
      const facts = actionOutcomeFacts({ status: execution.status, produced, declared });
      // exactly what was authorized before the action (the recorded request), else the dispatcher's classification
      const prior = await decisionLog.get(execution.permit.decisionId).catch(() => undefined);
      const action: ActionDescription = prior?.request ?? input.describe();
      const request: ActionRequest = {
        requestId: `${input.invocationId}#after_action`,
        runId: input.runId,
        workItemId: input.workItemId,
        agentId: input.agentId,
        role: input.role,
        tool: input.toolId,
        effect: Object.hasOwn(EFFECT_ORDER, action.effect) ? action.effect : 'execute',
        riskClass: Object.hasOwn(RISK_ORDER, action.riskClass) ? action.riskClass : 'high',
        resources: Array.isArray(action.resources) ? [...action.resources] : [],
        capability: input.capability,
        phase: 'after_action',
        outcome: facts,
      };
      if (action.environmentClass !== undefined) request.environmentClass = action.environmentClass;
      if (action.input !== undefined) request.input = action.input;
      if (input.snapshotId !== undefined) request.snapshotId = input.snapshotId;
      const permit = await decide(request, input.eventContext);
      const flagged = permit.decision !== 'allow';
      if (flagged) {
        const eventId = flagEventId(input.invocationId);
        if (!(await events.get(eventId))) {
          await events.append([
            {
              ...event(input.eventContext, POLICY_FLAGGED_EVENT, 'policy', input.invocationId, {
                phase: 'after_action', decisionId: permit.decisionId, decision: permit.decision, toolId: input.toolId, invocationId: input.invocationId,
                reasons: permit.reasons.map((r) => clip(r, 500)), evidenceIds: facts.evidenceIds, undeclaredEvidenceTypes: facts.undeclaredEvidenceTypes, policyRevision: permit.policyRevision,
              }),
              eventId,
            },
          ]);
        }
        logger.warn('tool call flagged after action', { runId: input.runId, workItemId: input.workItemId, toolId: input.toolId, invocationId: input.invocationId, decision: permit.decision, undeclared: facts.undeclaredEvidenceTypes });
      }
      return { permit, facts, flagged };
    },

    async beforeTransition(input) {
      const t = input.transition;
      const flagged = await flaggedActions(input.runId, t.subject === 'work_item' ? t.subjectId : undefined);
      const workItemId = input.workItemId ?? input.runId;
      const resource = t.subject === 'run' ? `run/${input.runId}` : `run/${input.runId}/${t.subject}/${t.subjectId}`;
      const request = systemRequest(input.runId, workItemId, `transition.${t.subject}`, resource, 'before_transition', `${t.subject}:${t.subjectId}:${t.to}:${ids.next('ptr')}`);
      request.transition = { ...t, flaggedActions: flagged };
      if (input.requestedBy) {
        request.transition.requestedBy = { ...input.requestedBy };
        request.role = input.requestedBy.role;
      }
      return decide(request, input.ctx);
    },

    async beforeAcceptance(input) {
      const request = systemRequest(input.runId, input.runId, 'gate.accept', `run/${input.runId}`, 'before_acceptance', `acceptance:${input.runId}:${ids.next('pacc')}`);
      request.acceptance = input.facts;
      return decide(request, input.ctx);
    },
  };
}
