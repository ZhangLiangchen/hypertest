import { HypertestError, type JsonValue } from '@hypertest/core';
import {
  CLASSIFICATION_ORDER, DEFAULT_WORK_BUDGET, RISK_ORDER, SEVERITY_ORDER, eventFrom,
  type ActorRef, type DomainEventInput, type EventContext, type GateSpec, type ModelPolicy, type RiskClass, type TestRun, type WorkBudget, type WorkItem,
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

/**
 * (H3) Problems of an effective (merged) GateSpec. A value the QualityGate cannot interpret would silently weaken a
 * criterion (e.g. an unknown `failOnUnresolvedSeverity` compares as "nothing blocks" and disables C2), so startRun
 * refuses the run instead of storing such a gate.
 */
export function gateSpecProblems(gate: GateSpec): string[] {
  const out: string[] = [];
  const g = gate as unknown as Record<string, unknown>;
  if (typeof g['gateId'] !== 'string' || (g['gateId'] as string).trim() === '') out.push('gate.gateId must be a non-empty string');
  if (typeof g['description'] !== 'string') out.push('gate.description must be a string');
  if (typeof g['failOnUnresolvedSeverity'] !== 'string' || !Object.hasOwn(SEVERITY_ORDER, g['failOnUnresolvedSeverity'] as string)) {
    out.push(`gate.failOnUnresolvedSeverity must be one of ${Object.keys(SEVERITY_ORDER).join(', ')} (got ${JSON.stringify(g['failOnUnresolvedSeverity'])})`);
  }
  if (typeof g['conditionalOnRiskLevel'] !== 'string' || !Object.hasOwn(RISK_ORDER, g['conditionalOnRiskLevel'] as string)) {
    out.push(`gate.conditionalOnRiskLevel must be one of ${Object.keys(RISK_ORDER).join(', ')} (got ${JSON.stringify(g['conditionalOnRiskLevel'])})`);
  }
  for (const k of ['requireDeterministicForCritical', 'requireIndependentReview'] as const) {
    if (typeof g[k] !== 'boolean') out.push(`gate.${k} must be a boolean (got ${JSON.stringify(g[k])})`);
  }
  if (g['requireOracle'] !== undefined && typeof g['requireOracle'] !== 'boolean') out.push(`gate.requireOracle must be a boolean (got ${JSON.stringify(g['requireOracle'])})`);
  const required = g['requiredEvidence'];
  if (!Array.isArray(required)) out.push('gate.requiredEvidence must be a list');
  else {
    required.forEach((r: unknown, i) => {
      const e = r as Record<string, unknown> | null;
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        out.push(`gate.requiredEvidence[${i}] must be an object`);
        return;
      }
      if (typeof e['evidenceType'] !== 'string' || e['evidenceType'] === '') out.push(`gate.requiredEvidence[${i}].evidenceType must be a non-empty string`);
      if (!Number.isSafeInteger(e['minCount']) || (e['minCount'] as number) < 1) out.push(`gate.requiredEvidence[${i}].minCount must be an integer ≥ 1`);
      if (e['critical'] !== undefined && typeof e['critical'] !== 'boolean') out.push(`gate.requiredEvidence[${i}].critical must be a boolean`);
    });
  }
  const cov = g['minCoverage'];
  if (cov !== undefined) {
    if (!cov || typeof cov !== 'object' || Array.isArray(cov)) out.push('gate.minCoverage must be an object');
    else {
      for (const k of ['lines', 'branches'] as const) {
        const v = (cov as Record<string, unknown>)[k];
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)) out.push(`gate.minCoverage.${k} must be a number in [0, 100]`);
      }
    }
  }
  return out;
}

/**
 * Evidence types that are deterministic execution evidence (a test outcome, an HTTP exchange, a metric, coverage, a
 * mutation score, a trace, a database snapshot, a packet capture, a screen capture): a run may re-target a required
 * evidence of one such type to another (a black-box run requires api-response instead of test-result) without weakening
 * the gate; replacing it by narrative or bookkeeping output (stdout, tool-output, model-output, a report) weakens it.
 */
export const EXECUTION_EVIDENCE_TYPES: ReadonlySet<string> = new Set(['test-result', 'api-response', 'metric', 'coverage', 'mutation-result', 'trace', 'database-snapshot', 'pcap', 'screenshot', 'video']);

function coverageRatio(v: number | undefined): number | undefined {
  return v === undefined ? undefined : v > 1 ? v / 100 : v;
}

/**
 * (conformance-9) The fields in which `effective` is WEAKER than `base` (DEFAULT_GATE_SPEC ⊕ configuration), each as
 * `field: base → effective`. Weaker means the effective gate would pass something the base would not:
 *  - failOnUnresolvedSeverity lowered (P1 → P0: fewer unresolved findings fail), conditionalOnRiskLevel raised;
 *  - requireDeterministicForCritical / requireIndependentReview disabled, requireOracle set to false;
 *  - a minCoverage threshold lowered or removed;
 *  - required evidence removed: every base requirement must be matched by a distinct effective requirement with at least
 *    its minCount and the same type (or both deterministic execution evidence types: EXECUTION_EVIDENCE_TYPES).
 * Both specs must be well formed (gateSpecProblems); a stricter or merely re-labelled gate yields [].
 */
export function gateWeakenings(base: GateSpec, effective: GateSpec): string[] {
  const out: string[] = [];
  const j = (v: unknown) => JSON.stringify(v ?? null);
  const bSev = SEVERITY_ORDER[base.failOnUnresolvedSeverity];
  const eSev = SEVERITY_ORDER[effective.failOnUnresolvedSeverity];
  if (bSev !== undefined && eSev !== undefined && eSev < bSev) out.push(`failOnUnresolvedSeverity: ${base.failOnUnresolvedSeverity} → ${effective.failOnUnresolvedSeverity} (fewer unresolved findings fail the gate)`);
  const bRisk = RISK_ORDER[base.conditionalOnRiskLevel];
  const eRisk = RISK_ORDER[effective.conditionalOnRiskLevel];
  if (bRisk !== undefined && eRisk !== undefined && eRisk > bRisk) out.push(`conditionalOnRiskLevel: ${base.conditionalOnRiskLevel} → ${effective.conditionalOnRiskLevel} (fewer open risks make the verdict conditional)`);
  for (const k of ['requireDeterministicForCritical', 'requireIndependentReview'] as const) {
    if (base[k] === true && effective[k] !== true) out.push(`${k}: true → ${j(effective[k])}`);
  }
  if (base.requireOracle !== false && effective.requireOracle === false) out.push(`requireOracle: ${j(base.requireOracle ?? true)} → false`);
  for (const k of ['lines', 'branches'] as const) {
    const b = coverageRatio(base.minCoverage?.[k]);
    const e = coverageRatio(effective.minCoverage?.[k]);
    if (b !== undefined && b > 0 && (e === undefined || e < b)) out.push(`minCoverage.${k}: ${j(base.minCoverage?.[k])} → ${j(effective.minCoverage?.[k])}`);
  }
  // required evidence: a maximum bipartite matching of base requirements onto effective ones (Kuhn)
  const B = base.requiredEvidence ?? [];
  const E = effective.requiredEvidence ?? [];
  const covers = (e: (typeof E)[number], b: (typeof B)[number]) =>
    e.minCount >= b.minCount && (e.evidenceType === b.evidenceType || (EXECUTION_EVIDENCE_TYPES.has(e.evidenceType) && EXECUTION_EVIDENCE_TYPES.has(b.evidenceType)));
  const owner: number[] = E.map(() => -1);
  const assign = (bi: number, seen: boolean[]): boolean => {
    for (let ei = 0; ei < E.length; ei++) {
      if (seen[ei] || !covers(E[ei]!, B[bi]!)) continue;
      seen[ei] = true;
      if (owner[ei] === -1 || assign(owner[ei]!, seen)) {
        owner[ei] = bi;
        return true;
      }
    }
    return false;
  };
  for (let bi = 0; bi < B.length; bi++) {
    if (!assign(bi, E.map(() => false))) out.push(`requiredEvidence: ${B[bi]!.minCount}× ${B[bi]!.evidenceType} is no longer required (${E.length === 0 ? 'none required' : `required: ${E.map((e) => `${e.minCount}× ${e.evidenceType}`).join(', ')}`})`);
  }
  return out;
}

/** (conformance-9) The actor kinds that may authorize a weakened gate: a human or a system, never an agent. */
export const GATE_AUTHORITY_KINDS: ReadonlySet<string> = new Set(['human', 'system']);

/** What the gate path makes of a run's recorded gate authority (see authorizedGateWeakenings). */
export interface GateAuthorityJudgement {
  /** The recorded authority, when it is a well-formed human/system authority with a rationale. */
  authority?: { by: ActorRef; rationale: string };
  /** Weakenings of the effective gate that the recorded authority covers. */
  authorized: string[];
  /** Weakenings of the effective gate that no recorded authority covers (they withhold the verdict). */
  unauthorized: string[];
}

/**
 * (conformance-9, the gate side) Judges the effective gate against its reference — the base recorded with the run's gate
 * (DEFAULT_GATE_SPEC ⊕ configuration at start), else the current configured base — and the recorded authority: a
 * weakening is authorized only when a well-formed human/system authority is recorded AND it is one of the weakenings that
 * authority was given for (a gate weakened further after the fact, or an authority whose record is not human/system with
 * a rationale, authorizes nothing). Pure.
 */
export function authorizedGateWeakenings(
  reference: GateSpec,
  effective: GateSpec,
  recorded: { by?: ActorRef; rationale?: string; weakened?: readonly string[] } | undefined,
): GateAuthorityJudgement {
  const weakened = gateWeakenings(reference, effective);
  const by = recorded?.by;
  const valid =
    by !== undefined && by !== null && typeof by === 'object' && typeof by.kind === 'string' && GATE_AUTHORITY_KINDS.has(by.kind) && typeof by.id === 'string' && by.id.trim() !== '' &&
    typeof recorded?.rationale === 'string' && recorded.rationale.trim() !== '';
  if (!valid) return { authorized: [], unauthorized: weakened };
  const covered = new Set(Array.isArray(recorded!.weakened) ? recorded!.weakened : []);
  return { authority: { by: by!, rationale: recorded!.rationale! }, authorized: weakened.filter((w) => covered.has(w)), unauthorized: weakened.filter((w) => !covered.has(w)) };
}

/**
 * The reference a run's gate is judged against at the gate (conformance-9): the base recorded with it at start, else the
 * configured base DEFAULT_GATE_SPEC ⊕ `defaultGate` (DEFAULT_GATE_SPEC when that is unusable) — never nothing.
 */
export function gateReference(recordedBase: GateSpec | undefined, defaultGate: Partial<GateSpec> | undefined, defaults: GateSpec): GateSpec {
  if (recordedBase !== undefined) return recordedBase;
  const configured = mergeDefined<GateSpec>(defaults, defaultGate);
  return gateSpecProblems(configured).length === 0 ? configured : defaults;
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

/**
 * (H2, I11) A live run is driven only by the runtime whose RuntimeManifest it is pinned to: `precondition_failed` when a
 * non-terminal run names another manifest (never retried by the durable runtimes). Finished runs stay readable.
 */
export function assertRunPinned(run: Pick<TestRun, 'runId' | 'runtimeManifestId' | 'status'>, manifestId: string): void {
  if (run.runtimeManifestId === manifestId || isTerminalRunStatus(run.status)) return;
  throw new HypertestError(
    'precondition_failed',
    `run ${run.runId} is pinned to runtime manifest ${run.runtimeManifestId}; this runtime is ${manifestId} (I11: a live run is never driven by another runtime — resume it with the runtime it was created on, or cancel it)`,
    { details: { runId: run.runId, pinnedManifestId: run.runtimeManifestId, runtimeManifestId: manifestId } },
  );
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
