import { HypertestError } from '@hypertest/core';
import type { AgentInstance, EventContext, WorkBudget } from '@hypertest/domain';
import type { AgentRunner, DispatchResult, EngineHost, RunnerDeps, RunTurnRequest, RunTurnResult, StepOutcome, TerminalSignal, TurnLimits, TurnRecord } from './contracts.ts';
import { zeroUsage } from './util.ts';
import { SETTLED_TURN_STATUSES, resumeState, setResumePending } from './agents.ts';

/** Consecutive `retry_next_turn` boundaries run() follows before handing control back (fallback chains are finite anyway). */
export const MAX_CONSECUTIVE_RETRY_BOUNDARIES = 4;

const NOT_RUNNABLE: ReadonlySet<AgentInstance['status']> = new Set(['completed', 'failed', 'disposed', 'interrupted']);

/** Failure recorded for a failed session whose engine did not record why (recovery only). */
const UNRECORDED_FAILURE = { reason: 'failed', message: 'the engine session ended failed without a recorded reason' };

export function validateBudget(b: WorkBudget): void {
  const fields: Array<keyof WorkBudget> = ['maxTurns', 'maxTokens', 'maxToolCalls', 'maxWallClockMs'];
  for (const f of fields) {
    const v = b?.[f];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new HypertestError('invalid_argument', `budget.${f} must be a finite non-negative number (got ${String(v)})`);
  }
  if (b.maxCostUsd !== undefined && (!Number.isFinite(b.maxCostUsd) || b.maxCostUsd < 0)) throw new HypertestError('invalid_argument', 'budget.maxCostUsd must be a finite non-negative number');
}

/**
 * Drives an agent's engine turn by turn. step() is the durable activity unit (exactly one runTurn); run() loops until
 * the agent completes, fails, waits, is interrupted or pauses at a boundary — enforcing the work budget (turns, tokens,
 * cost, tool calls, wall clock). Budget exhaustion ends the agent as failed/budget_exhausted (never silently downgraded).
 */
export function createAgentRunner(deps: RunnerDeps): AgentRunner {
  const { agents, sessions, engines, subagents, clock, logger } = deps;

  async function mustGet(agentId: string): Promise<AgentInstance> {
    const a = await agents.get(agentId);
    if (!a) throw new HypertestError('not_found', `agent ${agentId} not found`, { details: { agentId } });
    return a;
  }

  function assertRunnable(agent: AgentInstance): void {
    if (NOT_RUNNABLE.has(agent.status)) {
      throw new HypertestError('precondition_failed', `agent ${agent.agentId} is ${agent.status}${agent.status === 'interrupted' ? '; resume it first' : ''}`, {
        details: { agentId: agent.agentId, status: agent.status },
      });
    }
  }

  /** Records a terminal (completed/failed) turn result as the agent's settled SubagentResult. */
  async function settleTerminal(agentId: string, result: RunTurnResult, ctx: EventContext): Promise<void> {
    if (result.status === 'completed') {
      const c = result.completion;
      if (!c) throw new HypertestError('internal', `engine reported agent ${agentId} completed without a completion signal`, { details: { agentId, turn: result.turn } });
      const settled: Parameters<typeof subagents.settle>[1] = { status: 'completed', summary: c.summary, evidenceRefs: c.evidenceRefs, recordRefs: c.recordRefs };
      if (c.output !== undefined) settled.output = c.output;
      await subagents.settle(agentId, settled, ctx);
    } else {
      await subagents.settle(agentId, { status: 'failed', failure: result.failure ?? { reason: 'failed', message: 'the agent failed' }, evidenceRefs: [], recordRefs: [] }, ctx);
    }
  }

  /**
   * Crash recovery (a retried step after the engine committed a turn but before the agent was updated):
   *  - terminal: the session is completed/failed but the agent was never settled. Re-running the turn is impossible
   *    (the session is closed) and must not be attempted; the outcome recorded with the turn (TurnRecord.outcome, else
   *    the turn's terminal signals) is settled instead;
   *  - waiting: the session waits on operations but the agent is still `active`: the agent is put in `waiting` and the
   *    recorded outcome returned — no extra turn runs before the operations complete.
   * Returns undefined when there is nothing to recover.
   */
  async function recoverCommitted(agent: AgentInstance, ctx: EventContext): Promise<StepOutcome | undefined> {
    const session = await sessions.get(agent.sessionId);
    if (!session) return undefined;
    if (session.status === 'completed' || session.status === 'failed') {
      const last = await sessions.lastTurn(agent.sessionId);
      const result = recoveredResult(session.status, last);
      logger.warn('recovering the unsettled terminal outcome of an agent', { agentId: agent.agentId, sessionId: agent.sessionId, status: result.status, turn: result.turn });
      await settleTerminal(agent.agentId, result, ctx);
      return { result, agent: await mustGet(agent.agentId) };
    }
    if (session.status === 'waiting' && agent.status === 'active') {
      const last = await sessions.lastTurn(agent.sessionId);
      const result = recoveredWaiting(last);
      if (!result) return undefined;
      logger.warn('recovering the waiting state of an agent', { agentId: agent.agentId, sessionId: agent.sessionId, waitingOn: result.waitingOn, turn: result.turn });
      await agents.update(agent.agentId, { status: 'waiting' });
      return { result, agent: await mustGet(agent.agentId) };
    }
    return undefined;
  }

  /**
   * (A[4]) Whether the agent's next step resumes it through engine.resumeChild. A resume the engine already took over
   * before a crash left the flag set is consumed here, and the ordinary recovery then settles / replays / continues that
   * turn instead of running another one: the engine reactivated the session (it is `active` — a resume is only pending
   * for a session that is not), or a turn settled after the one settled at the resume (the resumed or replayed turn
   * committed, and the session closed again: completed / waiting / failed).
   */
  async function pendingResume(agent: AgentInstance): Promise<boolean> {
    const state = await resumeState(deps.db, agent.agentId);
    if (!state.pending) return false;
    const session = await sessions.get(agent.sessionId);
    const last = await sessions.lastTurn(agent.sessionId);
    const reactivated = session?.status === 'active';
    const settledAfter = state.afterTurn !== undefined && last !== undefined && SETTLED_TURN_STATUSES.has(last.status) && last.turn > state.afterTurn;
    if (reactivated || settledAfter) {
      await setResumePending(deps.db, agent.agentId, false);
      logger.warn('the engine already took over the resume of this agent before a crash: recovering that turn', {
        agentId: agent.agentId, afterTurn: state.afterTurn ?? null, lastTurn: last?.turn ?? null, lastTurnStatus: last?.status ?? null, sessionStatus: session?.status ?? null,
      });
      return false;
    }
    return true;
  }

  async function step(agentId: string, host: EngineHost, options: { limits: TurnLimits; signal: AbortSignal }): Promise<StepOutcome> {
    const agent = await mustGet(agentId);
    assertRunnable(agent);
    // A[4]: a resumed child (continuable / interrupted) continues through its engine's resumeChild, which reactivates the
    // child session (its previous `completed` session is not an unsettled outcome to recover)
    const resuming = await pendingResume(agent);
    if (!resuming) {
      const recovered = await recoverCommitted(agent, host.eventContext);
      if (recovered) return recovered;
    }
    const engine = engines.get(agent.engineKind);
    const request: RunTurnRequest = { session: { sessionId: agent.sessionId, engineKind: agent.engineKind }, host, limits: options.limits, signal: options.signal };
    let result: RunTurnResult;
    if (resuming) {
      result = await engine.resumeChild({ child: request.session, host, limits: options.limits, signal: options.signal });
      await setResumePending(deps.db, agentId, false);
    } else result = await engine.runTurn(request);

    const fresh = await mustGet(agentId);
    if (fresh.status === 'disposed') return { result, agent: fresh };
    switch (result.status) {
      case 'completed':
      case 'failed':
        await settleTerminal(agentId, result, host.eventContext);
        break;
      case 'waiting':
        if (fresh.status !== 'interrupted' && fresh.status !== 'waiting') await agents.update(agentId, { status: 'waiting' });
        break;
      case 'interrupted': {
        // An abort (e.g. a cancelled durable activity) leaves the agent runnable: the turn replays on the next step.
        // Only an explicit interrupt (session marked interrupted) makes the agent interrupted.
        const session = await sessions.get(agent.sessionId);
        if (session?.status === 'interrupted' && fresh.status !== 'interrupted') await agents.update(agentId, { status: 'interrupted' });
        break;
      }
      default:
        if (fresh.status === 'waiting') await agents.update(agentId, { status: 'active' });
    }
    return { result, agent: await mustGet(agentId) };
  }

  async function exhaust(agent: AgentInstance, message: string, host: EngineHost | undefined, lastTurn: number): Promise<StepOutcome> {
    logger.warn('agent work budget exhausted', { agentId: agent.agentId, reason: message });
    const failure = { reason: 'budget_exhausted', message };
    const ctx = host?.eventContext ?? { runId: agent.runId, correlationId: agent.agentId, actorId: 'system:runtime', agentId: agent.agentId, workItemId: agent.workItemId };
    await subagents.settle(agent.agentId, { status: 'failed', failure, evidenceRefs: [], recordRefs: [] }, ctx);
    const session = await sessions.get(agent.sessionId);
    if (session && session.status !== 'disposed' && session.status !== 'failed') await sessions.setStatus(agent.sessionId, 'failed');
    const result: RunTurnResult = { status: 'failed', turn: lastTurn, appended: [], toolResults: [], failure, usage: zeroUsage(), replayed: false };
    return { result, agent: await mustGet(agent.agentId) };
  }

  return {
    step,

    async run(agentId, hostFactory, options) {
      validateBudget(options.budget);
      const budget = options.budget;
      const startedMs = clock.nowMs();
      let tokens = 0;
      let costUsd = 0;
      let toolCalls = 0;
      let retries = 0;
      let last: StepOutcome | undefined;
      let host: EngineHost | undefined;
      for (;;) {
        const agent = await mustGet(agentId);
        if (last && NOT_RUNNABLE.has(agent.status)) return { result: last.result, agent };
        assertRunnable(agent);
        const session = await sessions.get(agent.sessionId);
        if (!session) throw new HypertestError('not_found', `session ${agent.sessionId} of agent ${agentId} not found`);
        if ((session.status === 'completed' || session.status === 'failed' || (session.status === 'waiting' && agent.status === 'active')) && !(await pendingResume(agent))) {
          // The engine already decided (an earlier attempt crashed before the agent was updated): settle / sync the
          // recorded outcome first. Budgets must not override a recorded completion.
          host = await hostFactory();
          const recovered = await recoverCommitted(agent, host.eventContext);
          if (recovered) return recovered;
        }
        const lastTurn = await sessions.lastTurn(agent.sessionId);
        // A turn whose response is recorded is finished first (a replay calls no model), whatever the budget says.
        if (lastTurn?.status !== 'model_responded') {
          let exhausted: string | undefined;
          if (session.turnCount >= budget.maxTurns) exhausted = `maxTurns ${budget.maxTurns} reached`;
          else if (clock.nowMs() - startedMs >= budget.maxWallClockMs) exhausted = `maxWallClockMs ${budget.maxWallClockMs} reached`;
          else if (tokens >= budget.maxTokens) exhausted = `maxTokens ${budget.maxTokens} reached (${tokens} used)`;
          else if (budget.maxCostUsd !== undefined && costUsd >= budget.maxCostUsd) exhausted = `maxCostUsd ${budget.maxCostUsd} reached ($${costUsd.toFixed(6)} used)`;
          else if (toolCalls >= budget.maxToolCalls) exhausted = `maxToolCalls ${budget.maxToolCalls} reached`;
          if (exhausted) return exhaust(agent, exhausted, host, lastTurn?.turn ?? 0);
        }
        host = await hostFactory();
        const remaining = Math.max(0, budget.maxToolCalls - toolCalls);
        const limits: TurnLimits = { ...options.limits, maxToolCallsPerTurn: Math.min(options.limits.maxToolCallsPerTurn, remaining) };
        last = await step(agentId, host, { limits, signal: options.signal });
        const r = last.result;
        tokens += r.usage.inputTokens + r.usage.outputTokens;
        costUsd += r.usage.costUsd ?? 0;
        toolCalls += r.toolResults.length;
        if (r.status === 'continue') {
          retries = 0;
          continue;
        }
        if (r.status === 'boundary' && r.boundary === 'retry_next_turn' && retries < MAX_CONSECUTIVE_RETRY_BOUNDARIES) {
          retries++;
          continue;
        }
        return last;
      }
    },
  };
}

function recordedResults(record: TurnRecord | undefined): DispatchResult[] {
  return (record?.toolCalls ?? [])
    .filter((c) => c.status === 'settled' && c.result !== undefined)
    .map((c) => {
      const r: DispatchResult = { message: c.result! };
      if (c.terminal !== undefined) r.terminal = c.terminal;
      if (c.pendingOperationId !== undefined) r.pendingOperationId = c.pendingOperationId;
      return r;
    });
}

/** The waiting RunTurnResult of the last turn (undefined when it did not end waiting on operations). */
export function recoveredWaiting(last: TurnRecord | undefined): RunTurnResult | undefined {
  if (!last || last.status !== 'completed') return undefined;
  const toolResults = recordedResults(last);
  const waitingOn = last.outcome !== undefined
    ? (last.outcome.status === 'waiting' ? last.outcome.waitingOn ?? [] : [])
    : toolResults.map((r) => r.pendingOperationId).filter((p): p is string => p !== undefined);
  if (waitingOn.length === 0) return undefined;
  return { status: 'waiting', turn: last.turn, appended: [], toolResults, waitingOn, usage: zeroUsage(), replayed: true };
}

function terminalOf(record: TurnRecord | undefined): TerminalSignal[] {
  return (record?.toolCalls ?? []).map((c) => c.terminal).filter((t): t is TerminalSignal => t !== undefined);
}

/** The RunTurnResult of the last (terminal) turn of a completed/failed session, from what the store recorded. */
export function recoveredResult(status: 'completed' | 'failed', last: TurnRecord | undefined): RunTurnResult {
  const toolResults = recordedResults(last);
  const result: RunTurnResult = { status, turn: last?.turn ?? 0, appended: [], toolResults, usage: zeroUsage(), replayed: true };
  const outcome = last?.outcome;
  const terminals = terminalOf(last);
  if (status === 'completed') {
    const completion = (outcome?.status === 'completed' ? outcome.completion : undefined) ?? terminals.find((t): t is Extract<TerminalSignal, { kind: 'complete' }> => t.kind === 'complete');
    // Never fabricate a completion: an unexplained completed session is an inconsistency for an operator.
    if (!completion) throw new HypertestError('internal', `session of turn ${result.turn} is completed but no completion was recorded`, { details: { turn: result.turn } });
    result.completion = completion;
  } else {
    const fail = terminals.find((t): t is Extract<TerminalSignal, { kind: 'fail' }> => t.kind === 'fail');
    result.failure = (outcome?.status === 'failed' ? outcome.failure : undefined) ?? (fail ? { reason: fail.reason, message: fail.message } : UNRECORDED_FAILURE);
  }
  return result;
}
