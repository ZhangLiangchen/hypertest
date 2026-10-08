import { isTerminalWorkState, type AgentInstance, type ChatMessage, type WorkItem } from '@hypertest/domain';
import type { ControlDeps } from './deps.ts';
import type { Delegation, DelegationMessage } from './store.ts';

/**
 * Subagent delegation semantics owned by the control plane (technology-selection §Subagent Runtime: spawn / resume /
 * message / collect, continuable, background):
 *  - foreground (default): the parent's delegate call is `pending` on `work:<child>` until the child's task is done;
 *  - background: delegate returns at once with the child id; the parent keeps working and reads the child with
 *    delegate.status / delegate.collect (summary only), and is told in its own inbox when a background task ends;
 *  - continuable: after completing a task the child does not end — its work item waits on `input:<child>` for more input
 *    (delegate.message, queued through SubagentRuntime.message) until the parent releases it (delegate.release) or the
 *    parent's own work item ends (auto-release); a released child completes with its last result and is disposed.
 */

/** Operation id a delegating parent waits on (a foreground delegation): the child work item. */
export function delegationOperationId(childWorkItemId: string): string {
  return `work:${childWorkItemId}`;
}

export function parseDelegationOperationId(operationId: string): string | undefined {
  return operationId.startsWith('work:') ? operationId.slice('work:'.length) : undefined;
}

/** Operation id a continuable child waits on between tasks: more input from its parent (or its release). */
export function inputWaitOperationId(childWorkItemId: string): string {
  return `input:${childWorkItemId}`;
}

export function parseInputWaitOperationId(operationId: string): string | undefined {
  return operationId.startsWith('input:') ? operationId.slice('input:'.length) : undefined;
}

/** A continuable child that finished its task and waits for more input. */
export function isAwaitingInput(item: Pick<WorkItem, 'workItemId' | 'state' | 'waitingOn'>): boolean {
  return item.state === 'waiting' && item.waitingOn.includes(inputWaitOperationId(item.workItemId));
}

/** The child's task result is available: its work item ended, or (continuable) it waits for more input. */
export function delegationSettled(child: Pick<WorkItem, 'workItemId' | 'state' | 'waitingOn'>): boolean {
  return isTerminalWorkState(child.state) || isAwaitingInput(child);
}

const MARKER = '[delegate.message ';

/** The user message a parent's delegate.message becomes in the child's session (the marker makes its reading visible). */
export function delegationChatMessage(m: DelegationMessage): ChatMessage {
  return { role: 'user', content: `${MARKER}${m.messageId} from ${m.from.role} ${m.from.agentId} (work item ${m.from.workItemId})]\n${m.text}` };
}

/** Message ids of the parent's messages that appear in the child's transcript (read by the child). */
async function readMessageIds(deps: Pick<ControlDeps, 'sessions'>, agent: AgentInstance): Promise<Set<string>> {
  const seen = new Set<string>();
  for (const e of await deps.sessions.transcript(agent.sessionId)) {
    const c = e.message.role === 'user' ? e.message.content : undefined;
    if (typeof c !== 'string' || !c.startsWith(MARKER)) continue;
    seen.add(c.slice(MARKER.length).split(' ', 1)[0]!);
  }
  return seen;
}

/** The parent's messages the child has not read yet (queued in its inbox, or not handed over at all). */
export async function unreadMessages(deps: Pick<ControlDeps, 'sessions'>, d: Delegation, agent: AgentInstance | undefined): Promise<DelegationMessage[]> {
  if (d.messages.length === 0) return [];
  const read = agent ? await readMessageIds(deps, agent) : new Set<string>();
  return d.messages.filter((m) => !read.has(m.messageId));
}

/**
 * (A[0]) Operation id a work item waits on while its agent is PAUSED for model unavailability (fallback pipeline end state
 * PAUSE): the agent's ModelPause (ht_model_pauses) says until when. Resumed by observeWaiting once the pause's resumeAt
 * has passed (a circuit's half-open time, a Retry-After, a backoff) or an operator released it (`hypertest resume`).
 */
export function modelWaitOperationId(agentId: string): string {
  return `model:${agentId}`;
}

export function parseModelWaitOperationId(operationId: string): string | undefined {
  return operationId.startsWith('model:') ? operationId.slice('model:'.length) : undefined;
}

/** A work item paused for model unavailability. */
export function isModelPaused(item: Pick<WorkItem, 'state' | 'waitingOn'>): boolean {
  return item.state === 'waiting' && item.waitingOn.some((op) => parseModelWaitOperationId(op) !== undefined);
}
