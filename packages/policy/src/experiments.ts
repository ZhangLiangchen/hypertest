import type { JsonValue } from '@hypertest/core';
import type { EvidenceRecord, ExperimentSpec, FaultSpec, OracleSpec, StopCondition } from '@hypertest/domain';

/**
 * (D-3 / D-4 / D-5, coverage-13) Deterministic experiment governance, pure and shared by the control plane (the
 * dispatcher refuses actions that would break an experiment) and the QualityGate (criterion C10 experiment_validity judges
 * what happened). Inputs are facts read from the ledgers by the caller (operations of the run with their experiment id
 * and what each call did, admission lapses, recorded stops), never agent claims.
 */

/** A write / fault-injection / load action of the run: an operation of a tool whose effect is external or destructive. */
export interface GateOperation {
  operationId: string;
  /** The tool / operation type (e.g. `env.inject_fault`, `load.start`, `http.request`). */
  toolId: string;
  effect: 'external' | 'destructive';
  workItemId: string;
  experimentId?: string;
  status: string;
  /** The operation's target resource key (e.g. `env/kv`, `url/127.0.0.1:8080`). */
  resourceKey: string;
  toolInvocationId?: string;
  createdAt: string;
  /** What the call did, from its `experiment.action` record (absent ⇒ unverifiable). */
  action?: ExperimentActionFacts;
}

export interface ExperimentActionFacts {
  /** Fault kind (latency, error_rate, restart …) or workload kind. */
  kind?: string;
  /** The environment / URL the call acted on. */
  target?: string;
  params?: Record<string, JsonValue>;
  ratePerSecond?: number;
  durationMs?: number;
  concurrency?: number;
}

export interface ExperimentFacts {
  experimentId: string;
  /** `admission.lapsed` of the experiment's claims (another holder took them while it was live). */
  lapses: Array<{ at: string; conflicts: string[] }>;
  /** `experiment.stopped` (a met stop condition or a manual stop), when recorded. */
  stopped?: { at: string; condition: string; reason: string };
}

/** Operation states in which the action may have happened (everything but "never applied" / failed before dispatch). */
export const ACTION_MAY_HAVE_HAPPENED: ReadonlySet<string> = new Set(['dispatching', 'acknowledged', 'verified', 'outcome_unknown', 'reconciling', 'manual_review', 'compensating', 'compensated']);
/** Tools that inject faults (their action must be in the experiment's fault plan). */
export const FAULT_TOOL_IDS: readonly string[] = ['env.inject_fault', 'env.restart'];
/** Tools that drive load (their action must be within the experiment's workload). */
export const LOAD_TOOL_IDS: readonly string[] = ['load.start'];

function obj(v: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, JsonValue>) : undefined;
}

function canonical(v: JsonValue): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, JsonValue>)[k]!)}`).join(',')}}`;
}

/** The environment id an action/fault target names (`kv`, `env/kv`). */
function envIdOf(target: string | undefined): string | undefined {
  if (target === undefined) return undefined;
  return target.startsWith('env/') ? target.slice(4) : target;
}

const FAULT_KIND_OF_TOOL: Record<string, string[]> = {
  'env.restart': ['restart', 'process_kill'],
};

/**
 * Whether one executed fault matches one declared FaultSpec: same kind (env.restart matches `restart`/`process_kill`), same
 * target environment, and — when the declaration names params — exactly those param values.
 */
export function faultMatches(spec: FaultSpec, toolId: string, action: ExperimentActionFacts): boolean {
  const kinds = FAULT_KIND_OF_TOOL[toolId] ?? (action.kind !== undefined ? [action.kind] : []);
  if (!kinds.includes(spec.kind)) return false;
  if (envIdOf(spec.target) !== envIdOf(action.target)) return false;
  if (spec.params !== undefined) {
    for (const [k, v] of Object.entries(spec.params)) {
      if (action.params?.[k] === undefined || canonical(action.params[k]!) !== canonical(v as JsonValue)) return false;
    }
  }
  return true;
}

/** Why a planned action falls outside the experiment's declared plan (undefined: it is within the plan). */
export function planViolation(spec: ExperimentSpec, toolId: string, action: ExperimentActionFacts): string | undefined {
  if (FAULT_TOOL_IDS.includes(toolId)) {
    const declared = spec.faultPlan ?? [];
    if (declared.length === 0) return `experiment ${spec.experimentId} declares no fault plan; ${toolId} would inject an undeclared fault`;
    if (!declared.some((f) => faultMatches(f, toolId, action))) {
      return `${toolId} ${action.kind ?? ''} on ${action.target ?? '?'}${action.params ? ` ${canonical(action.params as JsonValue)}` : ''} is not in the fault plan of experiment ${spec.experimentId} (${declared.map((f) => `${f.kind}@${f.target}${f.params ? ` ${canonical(f.params as JsonValue)}` : ''}`).join('; ')})`;
    }
    return undefined;
  }
  if (LOAD_TOOL_IDS.includes(toolId)) {
    const w = spec.workload;
    if (!w) return `experiment ${spec.experimentId} declares no workload; ${toolId} would run undeclared load`;
    const bad: string[] = [];
    if (w.ratePerSecond !== undefined && (action.ratePerSecond === undefined || action.ratePerSecond > w.ratePerSecond)) bad.push(`ratePerSecond ${action.ratePerSecond ?? '?'} > declared ${w.ratePerSecond}`);
    if (w.durationMs !== undefined && (action.durationMs === undefined || action.durationMs > w.durationMs)) bad.push(`durationMs ${action.durationMs ?? '?'} > declared ${w.durationMs}`);
    if (w.concurrency !== undefined && action.concurrency !== undefined && action.concurrency > w.concurrency) bad.push(`concurrency ${action.concurrency} > declared ${w.concurrency}`);
    if (w.targetUrl !== undefined && action.target !== undefined && !sameTarget(w.targetUrl, action.target)) bad.push(`target ${action.target} is not the declared ${w.targetUrl}`);
    return bad.length > 0 ? `${toolId} exceeds the workload of experiment ${spec.experimentId}: ${bad.join('; ')}` : undefined;
  }
  return undefined;
}

function sameTarget(declared: string, actual: string): boolean {
  if (declared === actual) return true;
  try {
    const a = new URL(declared);
    const b = new URL(actual);
    return a.host === b.host && (b.pathname === a.pathname || b.pathname.startsWith(a.pathname.endsWith('/') ? a.pathname : `${a.pathname}/`) || a.pathname === '/');
  } catch {
    return envIdOf(declared) === envIdOf(actual);
  }
}

/** The error rate an evidence record observed (errorRate, error_rate, errors / sent|requests|total), when it states one. */
export function observedErrorRate(e: Pick<EvidenceRecord, 'structured'>): number | undefined {
  const s = obj(e.structured);
  if (!s) return undefined;
  for (const k of ['errorRate', 'error_rate']) if (typeof s[k] === 'number' && Number.isFinite(s[k])) return s[k] as number;
  const errors = s['errors'];
  const total = [s['sent'], s['requests'], s['total']].find((x) => typeof x === 'number' && (x as number) > 0) as number | undefined;
  if (typeof errors === 'number' && total !== undefined) return errors / total;
  const m = obj(obj(s['metrics'])?.['error_rate']);
  if (m && typeof m['value'] === 'number') return m['value'];
  return undefined;
}

function observedMetric(e: Pick<EvidenceRecord, 'structured'>, metric: string): number | undefined {
  const s = obj(e.structured);
  if (!s) return undefined;
  if ((s['metric'] === metric || s['name'] === metric) && typeof s['value'] === 'number') return s['value'];
  if (typeof s[metric] === 'number') return s[metric] as number;
  const m = obj(s['metrics'])?.[metric];
  if (typeof m === 'number') return m;
  const mo = obj(m);
  if (mo && typeof mo['value'] === 'number') return mo['value'];
  return undefined;
}

export type StopEvaluation = { met: false } | { met: true; condition: StopCondition; at: string; observed: string };

/**
 * The earliest stop condition of `spec` that is met (pure): `duration` — `value` ms after the experiment's first action;
 * `error_rate_above` — an evidence record of the experiment observed an error rate above `value`; `metric_threshold` — its
 * evidence observed `metric` ≥ `value`; `manual` — a manual stop was recorded. `actions` are the experiment's actions
 * (createdAt), `evidence` its evidence records; `now` the evaluation time.
 */
export function evaluateStopConditions(
  spec: Pick<ExperimentSpec, 'stopConditions'>,
  evidence: ReadonlyArray<Pick<EvidenceRecord, 'evidenceId' | 'structured' | 'capturedAt' | 'seq'>>,
  actions: ReadonlyArray<{ createdAt: string }>,
  now: string,
  manual?: { at: string; reason: string },
): StopEvaluation {
  const met: Array<{ condition: StopCondition; at: string; observed: string }> = [];
  const nowMs = Date.parse(now);
  const firstAction = actions.length > 0 ? Math.min(...actions.map((a) => Date.parse(a.createdAt))) : undefined;
  const sorted = [...evidence].sort((a, b) => a.seq - b.seq);
  for (const c of spec.stopConditions ?? []) {
    switch (c.kind) {
      case 'duration': {
        if (firstAction === undefined || typeof c.value !== 'number') break;
        const end = firstAction + c.value;
        if (nowMs >= end) met.push({ condition: c, at: new Date(end).toISOString(), observed: `${c.value} ms elapsed since the first action` });
        break;
      }
      case 'error_rate_above': {
        if (typeof c.value !== 'number') break;
        const hit = sorted.find((e) => (observedErrorRate(e) ?? -Infinity) > c.value!);
        if (hit) met.push({ condition: c, at: hit.capturedAt, observed: `error rate ${observedErrorRate(hit)} > ${c.value} in ${hit.evidenceId}` });
        break;
      }
      case 'metric_threshold': {
        if (typeof c.value !== 'number' || typeof c.metric !== 'string') break;
        const hit = sorted.find((e) => (observedMetric(e, c.metric!) ?? -Infinity) >= c.value!);
        if (hit) met.push({ condition: c, at: hit.capturedAt, observed: `${c.metric} ${observedMetric(hit, c.metric)} ≥ ${c.value} in ${hit.evidenceId}` });
        break;
      }
      case 'manual':
        if (manual) met.push({ condition: c, at: manual.at, observed: `manual stop: ${manual.reason}` });
        break;
    }
  }
  if (manual && !met.some((m) => m.condition.kind === 'manual')) met.push({ condition: { kind: 'manual' }, at: manual.at, observed: `manual stop: ${manual.reason}` });
  if (met.length === 0) return { met: false };
  met.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { met: true, ...met[0]! };
}

function keyCovers(claimKey: string, resourceKey: string): boolean {
  return resourceKey === claimKey || resourceKey.startsWith(`${claimKey}/`);
}

function overlaps(a: string, b: string): boolean {
  return keyCovers(a, b) || keyCovers(b, a);
}

/** The resource keys an experiment holds exclusively: its write/fault claims and every contamination rule's resources. */
export function exclusiveResourcesOf(spec: ExperimentSpec): string[] {
  const keys = new Set<string>();
  for (const c of spec.isolation.resourceClaims) if (c.mode !== 'read_shared') keys.add(c.resourceKey);
  for (const r of spec.contaminationRules ?? []) for (const k of r.exclusiveResources) keys.add(k);
  for (const chk of spec.isolation.plan?.contaminationChecks ?? []) for (const k of chk.resources ?? []) keys.add(k);
  return [...keys].sort();
}

export interface ExperimentValidity {
  experimentId: string;
  /** Contradictions of validity (fail-type). */
  violations: string[];
  /** Missing or unverifiable facts (unknown). */
  unknowns: string[];
}

export interface ExperimentValidityInput {
  spec: ExperimentSpec;
  /** Evidence of the experiment (provenance.experimentId). */
  evidence: ReadonlyArray<EvidenceRecord>;
  /** Every write/fault/load operation of the run. */
  operations: ReadonlyArray<GateOperation>;
  facts?: ExperimentFacts;
  /** The oracle revisions in force for the run. */
  oraclesInForce: ReadonlyArray<Pick<OracleSpec, 'oracleId' | 'revision'>>;
  /** Whether the experiment's environment is registered as dedicated (for isolation mode dedicated_environment). */
  environmentDedicated?: boolean;
  now: string;
}

/**
 * Validity of one experiment (criterion C10): isolation held for its duration (no lapse, no foreign action on its exclusive
 * resources), environment generation unchanged (only its own verified restarts/deploys may bump it), executed faults ==
 * declared fault plan and load within the declared workload, evidence requirements met, stop conditions honoured (no
 * action after the earliest met condition), a dedicated environment really dedicated, and its oracle revisions still in
 * force. Contradictions ⇒ `violations`; missing or unverifiable facts ⇒ `unknowns`.
 */
export function experimentValidity(input: ExperimentValidityInput): ExperimentValidity {
  const { spec, evidence, operations } = input;
  const id = spec.experimentId;
  const out: ExperimentValidity = { experimentId: id, violations: [], unknowns: [] };
  const own = operations.filter((o) => o.experimentId === id && ACTION_MAY_HAVE_HAPPENED.has(o.status)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  // isolation held
  for (const l of input.facts?.lapses ?? []) out.violations.push(`its claims lapsed at ${l.at} (taken by ${l.conflicts.join(', ') || 'another holder'}): isolation did not hold`);
  const exclusive = exclusiveResourcesOf(spec);
  const start = Date.parse(spec.createdAt);
  const endCandidates = [...own.map((o) => Date.parse(o.createdAt)), ...evidence.map((e) => Date.parse(e.capturedAt))].filter((x) => Number.isFinite(x));
  const end = endCandidates.length > 0 ? Math.max(...endCandidates) : start;
  for (const o of operations) {
    if (o.experimentId === id || !ACTION_MAY_HAVE_HAPPENED.has(o.status)) continue;
    const at = Date.parse(o.createdAt);
    if (at < start || at > end) continue;
    const hit = exclusive.find((k) => overlaps(k, o.resourceKey));
    if (hit) out.violations.push(`contamination: ${o.toolId} operation ${o.operationId} of ${o.experimentId ? `experiment ${o.experimentId}` : `work item ${o.workItemId}`} acted on ${o.resourceKey} (held exclusively: ${hit}) during the experiment`);
  }
  if (spec.isolation.mode === 'dedicated_environment' && input.environmentDedicated !== true) {
    out.unknowns.push(`isolation mode dedicated_environment but environment ${spec.environment.environmentId} is not registered as dedicated`);
  }

  // environment generation unchanged (own verified restarts/deploys may bump it)
  const envId = spec.environment.environmentId;
  const ownBumps = own.filter((o) => (o.toolId === 'env.restart' || o.toolId === 'env.deploy') && o.status === 'verified' && envIdOf(o.resourceKey) === envId).length;
  const g0 = spec.environment.generation;
  for (const e of evidence) {
    if (!e.environment || e.environment.environmentId !== envId) continue;
    if (e.environment.generation < g0 || e.environment.generation > g0 + ownBumps) {
      out.violations.push(`evidence ${e.evidenceId} was captured on generation ${e.environment.generation} of ${envId}; the experiment ran on generation ${g0}${ownBumps ? ` (+${ownBumps} own bump(s))` : ''}: the environment changed under it`);
    }
  }

  // declared plan == executed actions
  for (const o of own) {
    if (!FAULT_TOOL_IDS.includes(o.toolId) && !LOAD_TOOL_IDS.includes(o.toolId)) continue;
    if (!o.action) {
      out.unknowns.push(`${o.toolId} operation ${o.operationId} has no recorded action: what it did cannot be compared with the plan`);
      continue;
    }
    const v = planViolation(spec, o.toolId, o.action);
    if (v) out.violations.push(v);
  }
  for (const f of spec.faultPlan ?? []) {
    const done = own.some((o) => FAULT_TOOL_IDS.includes(o.toolId) && o.action !== undefined && faultMatches(f, o.toolId, o.action));
    if (!done) out.unknowns.push(`declared fault ${f.kind}@${f.target} was never executed: the hypothesis was not tested as planned`);
  }
  if (spec.workload !== undefined && !own.some((o) => LOAD_TOOL_IDS.includes(o.toolId))) out.unknowns.push('the declared workload was never started');

  // evidence requirements
  for (const r of spec.evidenceRequirements ?? []) {
    const n = evidence.filter((e) => e.evidenceType === r.evidenceType).length;
    if (n < r.minCount) out.unknowns.push(`evidence requirement ${r.minCount}× ${r.evidenceType}: found ${n}`);
  }

  // stop conditions honoured
  const stop = evaluateStopConditions(spec, evidence, own, input.now, input.facts?.stopped ? { at: input.facts.stopped.at, reason: input.facts.stopped.reason } : undefined);
  if (stop.met) {
    const after = own.filter((o) => Date.parse(o.createdAt) > Date.parse(stop.at) && (FAULT_TOOL_IDS.includes(o.toolId) || LOAD_TOOL_IDS.includes(o.toolId)));
    for (const o of after) out.violations.push(`${o.toolId} operation ${o.operationId} ran at ${o.createdAt}, after stop condition ${stop.condition.kind} was met at ${stop.at} (${stop.observed})`);
  }

  // oracle revision in force
  for (const ref of spec.oracleRefs ?? []) {
    const cur = input.oraclesInForce.find((o) => o.oracleId === ref.oracleId);
    if (cur && cur.revision !== ref.revision) out.unknowns.push(`it ran under oracle ${ref.oracleId} revision ${ref.revision}; revision ${cur.revision} is in force — re-run it as a new experiment`);
  }
  return out;
}
