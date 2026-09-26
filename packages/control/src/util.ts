import { HypertestError, type JsonValue } from '@hypertest/core';
import {
  CLASSIFICATION_ORDER, DEFAULT_WORK_BUDGET, RISK_ORDER, eventFrom,
  type DomainEventInput, type EventContext, type ModelPolicy, type RiskClass, type TestRun, type WorkBudget, type WorkItem,
} from '@hypertest/domain';
import type { RoleDefinition } from '@hypertest/agents';

/** Shallow merge that ignores `undefined` values (a partial never erases a default with undefined). */
export function mergeDefined<T extends object>(...parts: Array<Partial<T> | undefined>): T {
  const out: Record<string, unknown> = {};
  for (const p of parts) {
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/** A work item budget: DEFAULT_WORK_BUDGET ⊕ role default ⊕ overrides. */
export function workBudgetFor(role: Pick<RoleDefinition, 'defaultBudget'> | undefined, ...overrides: Array<Partial<WorkBudget> | undefined>): WorkBudget {
  return mergeDefined<WorkBudget>(DEFAULT_WORK_BUDGET, role?.defaultBudget, ...overrides);
}

export function systemActor(workerId: string): string {
  return `system:control:${workerId}`;
}

/** Event context of a control-plane action on a run (correlated by run). */
export function runCtx(runId: string, workerId: string, causationId?: string): EventContext {
  const ctx: EventContext = { runId, correlationId: runId, actorId: systemActor(workerId) };
  if (causationId !== undefined) ctx.causationId = causationId;
  return ctx;
}

/** Event context of an action on/for a work item (correlated by work item; I10). */
export function itemCtx(item: Pick<WorkItem, 'runId' | 'workItemId' | 'causationEventId'>, actorId: string, agentId?: string): EventContext {
  const ctx: EventContext = { runId: item.runId, correlationId: item.workItemId, actorId, workItemId: item.workItemId };
  if (agentId !== undefined) ctx.agentId = agentId;
  if (item.causationEventId !== undefined) ctx.causationId = item.causationEventId;
  return ctx;
}

export function event(ctx: EventContext, type: string, aggregateType: DomainEventInput['aggregateType'], aggregateId: string, payload: Record<string, unknown>): DomainEventInput<unknown> {
  return eventFrom(ctx, type, aggregateType, aggregateId, compact(payload) as unknown as JsonValue) as DomainEventInput<unknown>;
}

/** Copies only defined values. */
export function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

export function maxRisk(risks: Iterable<RiskClass>): RiskClass {
  let best: RiskClass = 'low';
  for (const r of risks) if (RISK_ORDER[r] > RISK_ORDER[best]) best = r;
  return best;
}

/** Truncates to at most `max` characters, marking the cut. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 14))}…[truncated]`;
}

export function isTerminalRunStatus(status: TestRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function notFound(what: string, id: string): HypertestError {
  return new HypertestError('not_found', `${what} ${id} not found`, { details: { id } });
}

/**
 * Per-key in-process serialization (ticks of one run, agent creation for one work item). Cross-process
 * exclusion comes from leases and fencing; this only prevents two calls in the same process from racing.
 */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => gate);
    this.#tails.set(key, tail);
    try {
      await prev.catch(() => undefined);
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

/** Renders a JSON value for a prompt, bounded. */
export function jsonBlock(value: unknown, max = 4000): string {
  let s: string;
  try {
    s = JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  return clip(s ?? 'null', max);
}

/** Maps a free-form failure reason onto the domain's WorkFailureReason union. */
export function failureReason(reason: string | undefined): NonNullable<WorkItem['failure']>['reason'] {
  switch (reason) {
    case 'budget_exhausted':
    case 'model_unavailable':
    case 'policy_denied':
    case 'invalid_output':
    case 'dependency_failed':
    case 'lease_lost':
    case 'cancelled':
    case 'manual_review':
    case 'internal_error':
      return reason;
    default:
      return 'agent_failed';
  }
}

/** Deterministic string sort. */
export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function union<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] | undefined {
  return a === undefined && b === undefined ? undefined : [...new Set([...(a ?? []), ...(b ?? [])])];
}

/**
 * The model policy of a work item's agent: the role's policy TIGHTENED by the item's (a plan may never weaken what the
 * role requires — I3 routing order is security → capability → role suitability → quality): required capabilities,
 * prohibited providers and reviewer-independence roles are unions, allowed providers an intersection, the quality floor
 * the max, the privacy class the stricter, the cost cap the min, `fail_closed` wins. Preferences (routes, latency,
 * reasoning effort, temperature) may be set by the item.
 */
export function tightenModelPolicy(role: ModelPolicy, item: ModelPolicy | undefined): ModelPolicy {
  if (!item) return { ...role };
  const out: ModelPolicy = { ...role };
  if (item.preferredRoutes !== undefined) out.preferredRoutes = item.preferredRoutes;
  if (item.latencyBudgetMs !== undefined) out.latencyBudgetMs = item.latencyBudgetMs;
  if (item.reasoningEffort !== undefined) out.reasoningEffort = item.reasoningEffort;
  if (item.temperature !== undefined) out.temperature = item.temperature;
  const caps = union(role.requiredCapabilities, item.requiredCapabilities);
  if (caps) out.requiredCapabilities = caps;
  const prohibited = union(role.prohibitedProviders, item.prohibitedProviders);
  if (prohibited) out.prohibitedProviders = prohibited;
  const independent = union(role.independentFromRoles, item.independentFromRoles);
  if (independent) out.independentFromRoles = independent;
  if (item.allowedProviders !== undefined) out.allowedProviders = role.allowedProviders === undefined ? [...item.allowedProviders] : role.allowedProviders.filter((p) => item.allowedProviders!.includes(p));
  if (item.minQuality !== undefined) out.minQuality = Math.max(role.minQuality ?? 0, item.minQuality);
  if (item.maxCostPerCallUsd !== undefined) out.maxCostPerCallUsd = role.maxCostPerCallUsd === undefined ? item.maxCostPerCallUsd : Math.min(role.maxCostPerCallUsd, item.maxCostPerCallUsd);
  if (item.privacyClass !== undefined) {
    out.privacyClass = role.privacyClass === undefined || CLASSIFICATION_ORDER[item.privacyClass] > CLASSIFICATION_ORDER[role.privacyClass] ? item.privacyClass : role.privacyClass;
  }
  if (item.fallback !== undefined) out.fallback = role.fallback === 'fail_closed' || item.fallback === 'fail_closed' ? 'fail_closed' : item.fallback;
  return out;
}
