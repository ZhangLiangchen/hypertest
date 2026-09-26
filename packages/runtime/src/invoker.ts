import { HypertestError, isHypertestError } from '@hypertest/core';
import {
  CLASSIFICATION_ORDER, RISK_ORDER, estimateTokens, projectForRoute, type DataClassification, type ModelCapability, type ModelEpoch, type ModelPolicy, type ModelSwitchReason,
  type RiskClass,
} from '@hypertest/domain';
import type { InvokeRequest, RouteRequest } from '@hypertest/model';
import type { InvokerDeps, ModelInvocation, ModelInvoker, OkRouteDecision, PendingFallback } from './contracts.ts';
import { assertTurnNumber } from './util.ts';

/** Maps the router's failure code to the ModelEpoch switch reason of the fallback epoch. */
export function switchReasonFor(code: string): ModelSwitchReason {
  switch (code) {
    case 'rate_limited':
      return 'rate_limit';
    case 'precondition_failed':
      return 'policy';
    default:
      return 'unavailable';
  }
}

/** Rebuilds the decision of an epoch that was started without a stored decision (legacy/foreign EpochManager). */
export function decisionFromEpoch(epoch: ModelEpoch, policy: ModelPolicy): OkRouteDecision {
  const d: OkRouteDecision = {
    ok: true,
    routeId: epoch.routeId,
    provider: epoch.provider,
    model: epoch.model,
    fallbackChain: [],
    selectedByPolicy: 'epoch',
    capabilityProfileRevision: epoch.capabilityProfileRevision,
    continuationCompatibilityClass: epoch.continuationCompatibilityClass,
    rejected: [],
  };
  if (policy.reasoningEffort !== undefined) d.reasoningEffort = policy.reasoningEffort;
  return d;
}

/** The stricter of the configured value and an extra (extras may only tighten routing security, never relax it). */
function stricter<K extends string>(order: Record<K, number>, configured: K, extra: unknown, what: string): K {
  if (extra === undefined) return configured;
  if (typeof extra !== 'string' || !Object.hasOwn(order, extra)) throw new HypertestError('invalid_argument', `routeRequestExtras: unknown ${what} ${String(extra)}`);
  return order[extra as K] > order[configured] ? (extra as K) : configured;
}

function union<T>(...lists: ReadonlyArray<readonly T[] | undefined>): T[] {
  const out: T[] = [];
  for (const l of lists) for (const x of l ?? []) if (!out.includes(x)) out.push(x);
  return out;
}

/**
 * Per-agent ModelInvoker (runtime ownership of routing + epochs + budgets). Every call is a turn boundary:
 *   1. current epoch; a pending fallback (recorded by the previous failed call) starts a NEW epoch here — never mid-call;
 *      no epoch yet ⇒ route (security → capability → … ; fail closed) and start the initial epoch.
 *   2. budget reserve {tokens: estimate + maxOutputTokens, costUsd: estimate} ⇒ exhausted ⇒ boundary budget_exhausted.
 *   3. router.invoke on the epoch's decision (re-validated by the router against the current request) with messages
 *      projected for the route's continuation class; ok ⇒ settle actual usage; failure ⇒ release, store the router's
 *      fallback for the NEXT boundary (retry_next_turn) or model_unavailable; caller abort ⇒ cancelled.
 */
export function createModelInvoker(deps: InvokerDeps): ModelInvoker {
  const { router, epochs, agent, policy, logger } = deps;
  const memoryFallbacks = new Map<string, PendingFallback>();
  let warnedMemory = false;

  async function pendingFallback(sessionId: string): Promise<PendingFallback | undefined> {
    if (epochs.pendingFallback) return epochs.pendingFallback(sessionId);
    return memoryFallbacks.get(sessionId);
  }

  async function setPendingFallback(sessionId: string, fb: Omit<PendingFallback, 'createdAt'>): Promise<void> {
    if (epochs.setPendingFallback) return epochs.setPendingFallback(sessionId, fb);
    if (!warnedMemory) {
      warnedMemory = true;
      logger.warn('EpochManager cannot persist pending fallbacks; keeping them in process memory (lost on restart)', { sessionId });
    }
    memoryFallbacks.set(sessionId, { ...fb, createdAt: deps.clock.isoNow() });
  }

  return {
    async invoke(request): Promise<ModelInvocation> {
      assertTurnNumber(request?.turn);
      if (!Array.isArray(request.messages)) throw new HypertestError('invalid_argument', 'messages must be an array');
      const tools = request.tools ?? [];
      if (request.signal.aborted) return { ok: false, boundary: 'cancelled', message: 'model call cancelled before it started' };
      const sessionId = agent.sessionId;
      const current = await epochs.current(sessionId);
      const pending = await pendingFallback(sessionId);
      const snapshotId = request.snapshotId ?? current?.contextSnapshotId;
      if (!snapshotId) throw new HypertestError('invalid_argument', 'invoke: snapshotId is required to route (I3: the snapshot is fixed at the boundary)');

      const extras = deps.routeRequestExtras ? await deps.routeRequestExtras() : {};
      const contextTokensEstimate = estimateTokens(request.messages, tools);
      const derived: ModelCapability[] = [];
      if (tools.length > 0) derived.push('tool_use');
      if (request.responseFormat) derived.push('structured_output');
      // Identity, role, task and policy come from the invoker's deps; extras may only ADD restrictions (providers to
      // avoid, excluded routes, capabilities, structured output, a stricter risk/classification) — never relax them.
      const routeRequest: RouteRequest = {
        role: agent.role,
        taskType: deps.taskType,
        policy,
        actionRisk: stricter<RiskClass>(RISK_ORDER, deps.actionRisk, extras.actionRisk, 'actionRisk'),
        dataClassification: stricter<DataClassification>(CLASSIFICATION_ORDER, deps.dataClassification, extras.dataClassification, 'dataClassification'),
        runId: agent.runId,
        agentId: agent.agentId,
        requiredCapabilities: union(policy.requiredCapabilities, derived, extras.requiredCapabilities),
        contextTokensEstimate,
        contextSnapshotId: snapshotId,
      };
      if (request.responseFormat || extras.structuredOutput === true) routeRequest.structuredOutput = true;
      if (extras.providersToAvoid !== undefined) routeRequest.providersToAvoid = union(extras.providersToAvoid);
      if (extras.excludeRoutes !== undefined && extras.excludeRoutes.length > 0) routeRequest.excludeRoutes = union(extras.excludeRoutes);

      const identity = { runId: agent.runId, agentId: agent.agentId, sessionId };
      let epoch: ModelEpoch;
      let decision: OkRouteDecision;
      let excluded: string[];
      if (pending) {
        // The previous call failed and the router re-validated a fallback: switch HERE, at the turn boundary (I3).
        decision = pending.decision;
        excluded = pending.excludedRoutes;
        const input: Omit<ModelEpoch, 'epochId' | 'startedAt'> = {
          ...identity,
          routeId: decision.routeId,
          provider: decision.provider,
          model: decision.model,
          capabilityProfileRevision: decision.capabilityProfileRevision,
          continuationCompatibilityClass: decision.continuationCompatibilityClass,
          contextSnapshotId: snapshotId,
          switchReason: pending.reason,
          startedAtTurn: request.turn,
        };
        if (current) input.previousEpochId = current.epochId;
        epoch = await epochs.start(input, deps.eventContext, { decision, excludedRoutes: excluded, consumeFallback: true });
        memoryFallbacks.delete(sessionId);
      } else if (current) {
        const routing = epochs.routing ? await epochs.routing(current.epochId) : undefined;
        epoch = current;
        decision = routing?.decision ?? decisionFromEpoch(current, policy);
        excluded = routing?.excludedRoutes ?? [];
      } else {
        const routed = await router.route(routeRequest, deps.eventContext);
        if (!routed.ok) {
          const why = routed.rejected.map((r) => `${r.routeId}: ${r.stage} (${r.reason})`).join('; ');
          return { ok: false, boundary: 'model_unavailable', message: `no eligible model route for ${agent.role}/${deps.taskType}${why ? `: ${why}` : ''}` };
        }
        decision = routed;
        excluded = [];
        epoch = await epochs.start(
          {
            ...identity,
            routeId: decision.routeId,
            provider: decision.provider,
            model: decision.model,
            capabilityProfileRevision: decision.capabilityProfileRevision,
            continuationCompatibilityClass: decision.continuationCompatibilityClass,
            contextSnapshotId: snapshotId,
            switchReason: 'initial',
            startedAtTurn: request.turn,
          },
          deps.eventContext,
          { decision, excludedRoutes: [] },
        );
      }

      // Budget is a resource lease: reserve → call → settle (or release).
      let reservationId: string | undefined;
      if (deps.budget) {
        const amounts: { tokens: number; costUsd?: number } = { tokens: contextTokensEstimate + deps.maxOutputTokens };
        try {
          const cost = router.estimateCostUsd(decision.routeId, contextTokensEstimate, deps.maxOutputTokens);
          if (Number.isFinite(cost)) amounts.costUsd = cost;
          else logger.warn('model cost estimate is not finite; reserving tokens only', { routeId: decision.routeId });
        } catch (e) {
          // The route vanished from the catalog: the router refuses the call below (and computes a fallback).
          if (!isHypertestError(e, 'not_found')) throw e;
          logger.warn('model route unknown to the router cost estimator; reserving tokens only', { routeId: decision.routeId });
        }
        const reserved = await deps.budget.reserve(deps.budgetScopes, amounts, `model:${agent.agentId}:turn:${request.turn}`);
        if (!reserved.ok) {
          return { ok: false, boundary: 'budget_exhausted', message: `model budget exhausted for scopes ${deps.budgetScopes.join(', ')} (needed ${amounts.tokens} tokens${amounts.costUsd !== undefined ? `, $${amounts.costUsd.toFixed(6)}` : ''})` };
        }
        reservationId = reserved.reservationId;
      }
      const release = async (): Promise<void> => {
        if (!deps.budget || reservationId === undefined) return;
        try {
          await deps.budget.release(reservationId);
        } catch (e) {
          logger.error('budget release failed (the reservation stays held: over-counted, never under-counted)', { reservationId, error: String(e) });
        }
      };

      const call: InvokeRequest['call'] = {
        // Cross-model continuation rule: opaque reasoning only reaches routes of the same compatibility class.
        messages: projectForRoute(request.messages, decision.continuationCompatibilityClass),
        maxOutputTokens: deps.maxOutputTokens,
        signal: request.signal,
      };
      if (tools.length > 0) call.tools = tools;
      if (request.responseFormat) call.responseFormat = { type: 'json_schema', name: request.responseFormat.name, schema: request.responseFormat.schema };
      const invokeRouteRequest: RouteRequest = { ...routeRequest };
      const excludeRoutes = union(routeRequest.excludeRoutes, excluded);
      if (excludeRoutes.length > 0) invokeRouteRequest.excludeRoutes = excludeRoutes;

      let outcome;
      try {
        outcome = await router.invoke({ decision, call, ctx: deps.eventContext }, invokeRouteRequest);
      } catch (e) {
        await release();
        throw e;
      }

      if (outcome.ok) {
        const usage = outcome.response.usage;
        if (outcome.auditPending) {
          // The router could not append model.invoked after the provider answered (retried already). The call is paid:
          // keep the response and settle its usage below (durability-10); the gap in L0 is logged loudly here.
          logger.error('model.invoked audit event missing for a paid call; response kept and usage settled', {
            routeId: outcome.routeId, turn: request.turn, code: outcome.auditPending.code, error: outcome.auditPending.message,
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
          });
        }
        if (deps.budget && reservationId !== undefined) {
          const actual: { tokens: number; costUsd?: number } = { tokens: usage.inputTokens + usage.outputTokens };
          if (usage.costUsd !== undefined) actual.costUsd = usage.costUsd;
          try {
            await deps.budget.settle(reservationId, actual);
          } catch (e) {
            // Never lose a paid-for response over accounting: the reservation stays held (over-counted).
            logger.error('budget settle failed after a successful model call (reservation kept)', { reservationId, error: String(e) });
          }
        }
        return { ok: true, message: outcome.response.message, usage, routeId: outcome.routeId, epochId: epoch.epochId, stopReason: outcome.response.stopReason };
      }

      await release();
      const error = outcome.error;
      if (error.code === 'cancelled' || request.signal.aborted) return { ok: false, boundary: 'cancelled', message: error.message };
      if (outcome.fallback) {
        const fb: Omit<PendingFallback, 'createdAt'> = {
          decision: outcome.fallback,
          reason: switchReasonFor(error.code),
          fromRouteId: decision.routeId,
          fromEpochId: epoch.epochId,
          error: { code: error.code, message: error.message },
          excludedRoutes: union(excludeRoutes, [decision.routeId]),
        };
        await setPendingFallback(sessionId, fb);
        return {
          ok: false,
          boundary: 'retry_next_turn',
          message: `route ${decision.routeId} failed (${error.code}: ${error.message}); fallback ${outcome.fallback.routeId} starts a new epoch at the next turn`,
        };
      }
      return { ok: false, boundary: 'model_unavailable', message: `route ${decision.routeId} failed (${error.code}: ${error.message}); no eligible fallback` };
    },
  };
}
