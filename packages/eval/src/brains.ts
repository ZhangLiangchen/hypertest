/**
 * Building blocks for scripted brains (deterministic `ScriptedProvider` policies per role) used by eval arms, PoC
 * suites and tests, plus the chaos wrapper that injects a model timeout on the Nth model call of a trial.
 *
 * A brain sees exactly what a real model would: the request messages. The machine-readable agent header (first line of
 * the system prompt, `[hypertest role=… work_item=… kind=… run=…]`) tells it which role and work item it plays.
 */
import { HypertestError, type JsonValue } from '@hypertest/core';
import type { ChatMessage } from '@hypertest/domain';
import type { ModelCallRequest, ScriptedBrain, ScriptedReply } from '@hypertest/model';
import { parseAgentHeader } from '@hypertest/control';

/** What a role brain sees of one model call. */
export interface BrainView {
  role: string;
  kind: string;
  workItemId: string;
  runId: string;
  /** Assistant messages already in the transcript (0 on the first turn of a work item). */
  step: number;
  /** All user-message text, joined. */
  userText: string;
  /** Tool results in transcript order. */
  toolResults: Array<{ name: string; content: string; isError: boolean }>;
  request: ModelCallRequest;
}

export type RoleBrain = (view: BrainView) => ScriptedReply | Promise<ScriptedReply>;

/** Parses a model request into a BrainView; throws when the request carries no Hypertest agent header. */
export function viewOf(request: ModelCallRequest): BrainView {
  const system = request.messages[0]?.role === 'system' ? request.messages[0].content : '';
  const header = parseAgentHeader(system);
  if (!header) throw new Error(`request without a hypertest agent header: ${system.slice(0, 120)}`);
  const toolResults = request.messages
    .filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool')
    .map((m) => ({ name: m.toolName, content: m.content, isError: m.isError === true }));
  const userText = request.messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')))
    .join('\n');
  return { ...header, step: request.messages.filter((m) => m.role === 'assistant').length, userText, toolResults, request };
}

/**
 * One brain for every agent: dispatches on the header's role. Roles without a brain fail their work item
 * (`fail_work`, reason agent_failed) instead of hanging. `calls` (optional) records every view.
 */
export function roleRouter(brains: Record<string, RoleBrain>, calls?: BrainView[]): ScriptedBrain {
  return (request) => {
    const view = viewOf(request);
    calls?.push(view);
    const brain = Object.hasOwn(brains, view.role) ? brains[view.role] : undefined;
    if (!brain) return toolCall('fail_work', { reason: 'agent_failed', message: `no scripted brain for role ${view.role}` });
    return brain(view);
  };
}

/** A reply with one tool call (`plan.propose_revision` is sent on the wire as `plan__propose_revision`). */
export function toolCall(name: string, args: JsonValue): ScriptedReply {
  return { toolCalls: [{ name: name.split('.').join('__'), arguments: args }] };
}

/** Evidence ids (`ev_…`) mentioned in a text, deduplicated in order of appearance. */
export function evidenceIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\bev_[0-9A-Za-z]+\b/g)].map((m) => m[0]))];
}

/** Record ids (`rec_…`) mentioned in a text. */
export function recordIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\brec_[0-9A-Za-z]+\b/g)].map((m) => m[0]))];
}

/** Operation ids (`op_…`) mentioned in a text. */
export function operationIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\bop_[0-9A-Za-z]+\b/g)].map((m) => m[0]))];
}

/** Counters shared by the brains of one trial (across restarts of an in-process trial). */
export interface ModelCallCounter {
  calls: number;
  injected: number;
}

/**
 * Wraps every brain so that the `onCall`-th model call of the trial (1-based, counted across all providers) fails
 * with a provider `timeout` (chaos: injectModelTimeoutOnCall). The router retries or falls back exactly as for a
 * real provider timeout. Without `onCall` the brains are returned unchanged.
 */
export function withModelTimeoutInjection(
  brains: Record<string, ScriptedBrain>,
  onCall: number | undefined,
  counter: ModelCallCounter = { calls: 0, injected: 0 },
  onInject?: (call: number) => void,
): Record<string, ScriptedBrain> {
  if (onCall === undefined) return brains;
  if (!Number.isSafeInteger(onCall) || onCall < 1) throw new HypertestError('invalid_argument', `injectModelTimeoutOnCall must be a positive integer, got ${String(onCall)}`);
  const out: Record<string, ScriptedBrain> = {};
  for (const [providerId, brain] of Object.entries(brains)) {
    out[providerId] = (request, info) => {
      counter.calls++;
      if (counter.calls === onCall) {
        counter.injected++;
        onInject?.(onCall);
        return { error: 'timeout', message: `eval chaos: injected model timeout on call ${onCall}` };
      }
      return brain(request, info);
    };
  }
  return out;
}
