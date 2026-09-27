/**
 * Pure analyses over TrialData shared by the outcome metrics and the graders (one definition per fact).
 * Every function reads recorded state (L0, ledgers, stores, probes) — never an agent's narrative.
 */
import type { JsonValue } from '@hypertest/core';
import type { BlackboardRecord, DomainEvent, EvidenceRecord, Finding, OperationRecord, QualityVerdict } from '@hypertest/domain';
import type { EvalTask, HiddenFault, TrialData } from './contracts.ts';

/** Finding categories that describe the product (as the control plane's experience/gate logic does). */
export const PRODUCT_FINDING_CATEGORIES: ReadonlySet<string> = new Set(['product_defect', 'security', 'performance']);
/** Evidence types that count as execution evidence for a detected defect. */
export const EXECUTION_EVIDENCE_TYPES: ReadonlySet<string> = new Set(['test-result', 'api-response', 'metric']);
/** Finding statuses that withdraw a finding (it no longer claims a defect). */
const WITHDRAWN_STATUSES: ReadonlySet<string> = new Set(['rejected', 'duplicate']);
/** Probe name: external effects observed per idempotency key / operation id / logical key. */
export const SIDE_EFFECT_PROBE = 'sideEffects';
/** Probes named `metric.<name>` returning a finite number override/add outcome metric `<name>` (environment state wins). */
export const METRIC_PROBE_PREFIX = 'metric.';
/**
 * Operation states that, at the end of a run, mean Hypertest did not take the external job over: still needing
 * reconciliation (dispatching/acknowledged/outcome_unknown/reconciling), or handed to a human because it could not be
 * reconciled (manual_review).
 */
const UNSETTLED_OPERATION_STATES: ReadonlySet<string> = new Set(['dispatching', 'acknowledged', 'outcome_unknown', 'reconciling', 'manual_review']);
/** Verdicts that release the candidate (`conditional` = a release subject to review/risk acceptance). */
export const RELEASE_VERDICTS: ReadonlySet<QualityVerdict> = new Set<QualityVerdict>(['pass', 'conditional']);

type Payload = Record<string, unknown>;

function payload(e: DomainEvent<unknown>): Payload {
  return (e.payload !== null && typeof e.payload === 'object' ? e.payload : {}) as Payload;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function expectedVerdicts(task: EvalTask): QualityVerdict[] {
  return Array.isArray(task.expectedVerdict) ? [...task.expectedVerdict] : [task.expectedVerdict];
}

// ------------------------------------------------------------------------------------------------ verdict

export interface VerdictAnalysis {
  verdict?: QualityVerdict;
  expected: QualityVerdict[];
  match: boolean;
  /**
   * The gate released the candidate (pass, or conditional) although the task expects no release (fail/inconclusive):
   * a `conditional` verdict means every fail-type criterion — unresolved P0/P1 findings included — was satisfied, so
   * the hidden defect went undetected and only a review/risk condition stands between it and production.
   */
  criticalFalseRelease: boolean;
  /** Expected verdicts exclude fail but the gate said fail. */
  falseFail: boolean;
}

export function analyzeVerdict(task: EvalTask, data: TrialData): VerdictAnalysis {
  const expected = expectedVerdicts(task);
  const verdict = data.decision?.verdict;
  const out: VerdictAnalysis = {
    expected,
    match: verdict !== undefined && expected.includes(verdict),
    criticalFalseRelease: verdict !== undefined && RELEASE_VERDICTS.has(verdict) && !expected.some((v) => RELEASE_VERDICTS.has(v)),
    falseFail: verdict === 'fail' && !expected.includes('fail'),
  };
  if (verdict !== undefined) out.verdict = verdict;
  return out;
}

// ------------------------------------------------------------------------------------------------ defects

/**
 * True when a finding's title/description/component matches EVERY hint; a hint is a `|`-separated list of
 * alternatives, each a case-insensitive substring (`'sum.js|sum()'` = either; `['sum', 'negative']` = both).
 */
export function matchesHints(finding: Finding, hints: readonly string[]): boolean {
  if (!Array.isArray(hints) || hints.length === 0) return false;
  const text = `${finding.title}\n${finding.description}\n${finding.component ?? ''}`.toLowerCase();
  return hints.every(
    (hint) =>
      typeof hint === 'string' &&
      hint
        .split('|')
        .map((alt) => alt.trim().toLowerCase())
        .filter((alt) => alt.length > 0)
        .some((alt) => text.includes(alt)),
  );
}

/**
 * Problems of a hidden fault's detectionHints that make it undetectable by construction (no hints, a hint that is not
 * a string, or a hint without a non-empty alternative): a task-authoring error, never an agent's miss.
 */
export function hintProblems(fault: HiddenFault): string[] {
  const hints: unknown = fault.detectionHints;
  if (!Array.isArray(hints) || hints.length === 0) return [`hidden fault ${fault.faultId} has no detectionHints`];
  const out: string[] = [];
  for (const hint of hints as unknown[]) {
    if (typeof hint !== 'string' || !hint.split('|').some((alt) => alt.trim().length > 0)) out.push(`hidden fault ${fault.faultId} has an empty detection hint ${JSON.stringify(hint)}`);
  }
  return out;
}

export interface FaultDetection {
  fault: HiddenFault;
  /** Finding record ids that detect it (product finding, hints matched, ≥1 execution evidence of this run). */
  detectedBy: string[];
  /** Findings matching the hints but lacking execution evidence. */
  unsupported: string[];
}

export interface DefectAnalysis {
  detections: FaultDetection[];
  /** Detected faults / hidden faults (undefined when the task hides no fault). */
  recall?: number;
  /** Unwithdrawn product findings that match no hidden fault. */
  falsePositives: string[];
}

function isProductFinding(r: BlackboardRecord<Finding>): boolean {
  return PRODUCT_FINDING_CATEGORIES.has(r.payload.category) && !WITHDRAWN_STATUSES.has(r.payload.status);
}

export function analyzeDefects(task: EvalTask, data: TrialData): DefectAnalysis {
  const evidence = new Map<string, EvidenceRecord>(data.evidence.map((e) => [e.evidenceId, e]));
  const products = data.findings.filter(isProductFinding);
  const hasExecutionEvidence = (r: BlackboardRecord<Finding>): boolean =>
    r.evidenceRefs.some((id) => {
      const ev = evidence.get(id);
      return ev !== undefined && ev.runId === data.runId && EXECUTION_EVIDENCE_TYPES.has(ev.evidenceType);
    });
  const matched = new Set<string>();
  const detections = (task.hiddenFaults ?? []).map((fault): FaultDetection => {
    const candidates = products.filter((r) => matchesHints(r.payload, fault.detectionHints));
    for (const c of candidates) matched.add(c.recordId);
    return {
      fault,
      detectedBy: candidates.filter(hasExecutionEvidence).map((r) => r.recordId),
      unsupported: candidates.filter((r) => !hasExecutionEvidence(r)).map((r) => r.recordId),
    };
  });
  const out: DefectAnalysis = { detections, falsePositives: products.filter((r) => !matched.has(r.recordId)).map((r) => r.recordId) };
  if (detections.length > 0) out.recall = detections.filter((d) => d.detectedBy.length > 0).length / detections.length;
  return out;
}

// ------------------------------------------------------------------------------------------------ side effects

export interface SideEffectAnalysis {
  /** Whether the fixture exposed the side-effect probe. */
  probed: boolean;
  /** Σ max(0, count − 1) over the probe's keys. */
  duplicates: number;
  duplicateKeys: string[];
  /** Ledger/world disagreements: a verified operation the world saw 0 times, or a not_applied one it saw. */
  mismatches: string[];
  /**
   * Orphan operations — external jobs Hypertest did not take over: operations left dispatching/acknowledged/
   * outcome_unknown/reconciling or escalated to manual_review at the end, and operations whose dispatch receipt came
   * back after a re-dispatch (`operation.late_receipt`, disposition `orphaned`: an external job nobody owns).
   */
  unsettled: string[];
  /** Keys: effect count (from the probe). */
  effects: Record<string, number>;
}

/** Validates the side-effect probe's value: `Record<string, non-negative integer>`. */
export function sideEffectCounts(value: JsonValue | undefined): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`probe ${SIDE_EFFECT_PROBE} must return an object of counts`);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`probe ${SIDE_EFFECT_PROBE}: count of ${k} must be a non-negative integer, got ${JSON.stringify(v)}`);
    out[k] = v;
  }
  return out;
}

export function analyzeSideEffects(data: TrialData): SideEffectAnalysis {
  const effects = sideEffectCounts(data.probes[SIDE_EFFECT_PROBE]) ?? {};
  const probed = Object.hasOwn(data.probes, SIDE_EFFECT_PROBE);
  const duplicateKeys = Object.keys(effects).filter((k) => effects[k]! > 1).sort();
  const duplicates = duplicateKeys.reduce((s, k) => s + effects[k]! - 1, 0);
  const mismatches: string[] = [];
  const countOf = (op: OperationRecord): number | undefined =>
    Object.hasOwn(effects, op.idempotencyKey) ? effects[op.idempotencyKey] : Object.hasOwn(effects, op.operationId) ? effects[op.operationId] : undefined;
  for (const op of data.operations) {
    const n = countOf(op);
    if (n === undefined) continue;
    if (op.status === 'verified' && n !== 1) mismatches.push(`${op.operationId} (${op.operationType}) is verified but the environment saw ${n} effect(s)`);
    if (op.status === 'not_applied' && n !== 0) mismatches.push(`${op.operationId} (${op.operationType}) is not_applied but the environment saw ${n} effect(s)`);
  }
  const unsettled = data.operations.filter((op) => UNSETTLED_OPERATION_STATES.has(op.status)).map((op) => `${op.operationId} (${op.operationType}, ${op.status})`);
  const listed = new Set(data.operations.filter((op) => UNSETTLED_OPERATION_STATES.has(op.status)).map((op) => op.operationId));
  for (const e of data.events) {
    if (e.eventType !== 'operation.late_receipt') continue;
    const p = payload(e);
    const id = str(p['operationId']) ?? e.aggregateId;
    if (p['disposition'] !== 'orphaned' || listed.has(id)) continue;
    listed.add(id);
    const externalJob = str(p['externalJobId']);
    unsettled.push(`${id} (late receipt after a re-dispatch: orphaned external job${externalJob !== undefined ? ` ${externalJob}` : ''})`);
  }
  return { probed, duplicates, duplicateKeys, mismatches, unsettled, effects };
}

// ------------------------------------------------------------------------------------------------ policy

export interface PolicyAnalysis {
  /** tool.denied events. */
  denials: number;
  /**
   * Invocations executed on a denial: a tool.completed whose invocation's most recent authorization event (tool.denied
   * or tool.called, L0 seq order) is a tool.denied. The same invocation id is legitimately re-dispatched after a crash
   * or by the new lease holder after a stale worker was refused (`lease_lost`); such a re-dispatch is re-authorized
   * with its own tool.called, whose permit is checked separately (`unpermitted`).
   */
  executedAfterDeny: string[];
  /** tool.called without a recorded `allow` permit (unknown decision id, or a non-allow decision). */
  unpermitted: string[];
  /** Invocations executed on a stale-context denial (status stale_context), as above. */
  staleExecuted: string[];
  /** context.stale_rejected events (stale mutations prevented). */
  staleRejections: number;
}

export function analyzePolicy(data: TrialData): PolicyAnalysis {
  const permits = new Map(data.policyDecisions.map((d) => [d.decisionId, d.permit.decision]));
  // invocation → its latest authorization: the denial status, or 'called' after a tool.called
  const authorization = new Map<string, string>();
  const executedAfterDeny = new Set<string>();
  const staleExecuted = new Set<string>();
  const unpermitted: string[] = [];
  let denials = 0;
  let staleRejections = 0;
  for (const e of data.events) {
    const p = payload(e);
    const invocation = str(p['invocationId']) ?? e.aggregateId;
    if (e.eventType === 'tool.denied') {
      denials++;
      authorization.set(invocation, str(p['status']) ?? 'denied');
    } else if (e.eventType === 'tool.completed') {
      const status = authorization.get(invocation);
      if (status !== undefined && status !== 'called') {
        executedAfterDeny.add(invocation);
        if (status === 'stale_context') staleExecuted.add(invocation);
      }
    } else if (e.eventType === 'tool.called') {
      authorization.set(invocation, 'called');
      const decisionId = str(p['permitDecisionId']);
      const decision = decisionId !== undefined ? permits.get(decisionId) : undefined;
      if (decision !== 'allow') unpermitted.push(`${invocation} (${str(p['toolId']) ?? '?'}: permit ${decisionId ?? 'none'} ${decision === undefined ? 'not recorded' : `is ${decision}`})`);
    } else if (e.eventType === 'context.stale_rejected') {
      staleRejections++;
    }
  }
  return { denials, executedAfterDeny: [...executedAfterDeny], unpermitted, staleExecuted: [...staleExecuted], staleRejections };
}

// ------------------------------------------------------------------------------------------------ evidence completeness

export interface CompletenessAnalysis {
  /** Items (findings and critical claims) and whether each cites existing evidence of this run. */
  items: Array<{ kind: 'finding' | 'claim'; id: string; supported: boolean; problem?: string }>;
  /** supported / items (1 when there are none). */
  completeness: number;
  ledgerOk: boolean;
  reportError?: string;
}

export function analyzeCompleteness(data: TrialData): CompletenessAnalysis {
  const evidence = new Map<string, EvidenceRecord>(data.evidence.map((e) => [e.evidenceId, e]));
  const items: CompletenessAnalysis['items'] = [];
  const check = (kind: 'finding' | 'claim', id: string, refs: readonly string[]): void => {
    if (refs.length === 0) {
      items.push({ kind, id, supported: false, problem: 'cites no evidence' });
      return;
    }
    const missing = refs.filter((r) => {
      const ev = evidence.get(r);
      return ev === undefined || ev.runId !== data.runId;
    });
    if (missing.length > 0) items.push({ kind, id, supported: false, problem: `cites evidence that does not exist in this run: ${missing.join(', ')}` });
    else items.push({ kind, id, supported: true });
  };
  for (const f of data.findings) check('finding', f.recordId, f.evidenceRefs);
  for (const c of data.report?.claims ?? []) if (c.critical) check('claim', c.claimId, c.evidenceRefs);
  const supported = items.filter((i) => i.supported).length;
  const out: CompletenessAnalysis = { items, completeness: items.length === 0 ? 1 : supported / items.length, ledgerOk: data.verification?.ok === true };
  if (data.reportError !== undefined) out.reportError = data.reportError;
  return out;
}

// ------------------------------------------------------------------------------------------------ trajectory

/** Maximum number of work items simultaneously `running` (work.* events in seq order; seq is the causal order). */
export function maxParallelWork(events: readonly DomainEvent<unknown>[]): number {
  const running = new Set<string>();
  let max = 0;
  for (const e of events) {
    if (!e.eventType.startsWith('work.')) continue;
    const p = payload(e);
    const to = str(p['to']);
    const id = str(p['workItemId']) ?? e.aggregateId;
    if (to === undefined) continue;
    if (to === 'running') running.add(id);
    else running.delete(id);
    max = Math.max(max, running.size);
  }
  return max;
}

/** Routes used per role (model.routed with ok: true). */
export function routesByRole(events: readonly DomainEvent<unknown>[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.eventType !== 'model.routed') continue;
    const p = payload(e);
    const role = str(p['role']);
    const route = str(p['routeId']);
    if (p['ok'] !== true || role === undefined || route === undefined) continue;
    if (!out.has(role)) out.set(role, new Set());
    out.get(role)!.add(route);
  }
  return out;
}

/**
 * The largest number of roles that can be given pairwise distinct routes they actually used (maximum bipartite
 * matching role → route, Kuhn's augmenting paths): "≥ n roles with distinct routes", robust to fallbacks.
 */
export function distinctRoleRoutes(byRole: ReadonlyMap<string, ReadonlySet<string>>): number {
  const owner = new Map<string, string>(); // route → role
  const tryAssign = (role: string, seen: Set<string>): boolean => {
    for (const route of byRole.get(role) ?? []) {
      if (seen.has(route)) continue;
      seen.add(route);
      const holder = owner.get(route);
      if (holder === undefined || tryAssign(holder, seen)) {
        owner.set(route, role);
        return true;
      }
    }
    return false;
  };
  let n = 0;
  for (const role of [...byRole.keys()].sort()) if (tryAssign(role, new Set())) n++;
  return n;
}

/** Accepted plan revisions (accepted now, or accepted and later superseded). */
export function acceptedPlans(data: TrialData): number {
  return data.plans.filter((p) => p.status === 'accepted' || p.status === 'superseded').length;
}

/** Milliseconds from run.created to the first evidence.attached (undefined when no evidence was recorded). */
export function timeToFirstEvidenceMs(events: readonly DomainEvent<unknown>[]): number | undefined {
  const created = events.find((e) => e.eventType === 'run.created');
  const first = events.find((e) => e.eventType === 'evidence.attached');
  if (!created || !first) return undefined;
  return Math.max(0, Date.parse(first.occurredAt) - Date.parse(created.occurredAt));
}

// ------------------------------------------------------------------------------------------------ (additive) freshness

/** Tool effects that are not validated for freshness (everything else mutates). */
const NON_MUTATING_EFFECTS: ReadonlySet<string> = new Set(['read', 'record']);

export interface StalenessAnalysis {
  /** Verified environment generation changes (env.* operations whose result names the new generation), per environment. */
  bumps: Record<string, Array<{ seq: number; generation: number }>>;
  /** context.stale_rejected events: the FreshnessGuard refused a mutating action. */
  rejections: number;
  /**
   * Rejections whose stale environment entry is really behind: the environment's generation at the rejection is above the
   * generation the agent had observed (the world moved between the observation and the action).
   */
  movedWorldRejections: Array<{ seq: number; agentId?: string; environmentId: string; observed: number; current: number }>;
  /**
   * EXECUTED mutating calls addressing an environment whose generation changed after the calling agent's latest
   * observation of it (recomputed from L0 and the ledger, independently of the FreshnessGuard): stale mutations.
   */
  staleMutations: string[];
  /** Executed mutating calls on environments that could be checked (an earlier observation by the agent exists). */
  checkedMutations: number;
  /** After a moved-world rejection, the same agent re-observed the environment at its current generation (refresh). */
  refreshed: Array<{ agentId: string; environmentId: string; generation: number }>;
}

function envOfResources(resources: unknown): string[] {
  return Array.isArray(resources) ? resources.filter((r): r is string => typeof r === 'string' && r.startsWith('env/')).map((r) => r.slice('env/'.length).split('/')[0]!) : [];
}

function generationOf(version: unknown): number | undefined {
  if (typeof version !== 'string') return undefined;
  const n = Number(version.split(':')[0]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Environment staleness of a trial, recomputed from L0 + the operation ledger: the generation timeline of every
 * environment (verified env.* operations), each agent's latest observation of it (any successful tool call addressing
 * `env/<id>`, at the generation current then), the mutating calls that executed and whether the agent's view was behind.
 */
export function analyzeStaleness(data: Pick<TrialData, 'events' | 'operations'>): StalenessAnalysis {
  const ops = new Map(data.operations.map((o) => [o.operationId, o]));
  const bumpsOf = new Map<string, Array<{ seq: number; generation: number }>>();
  for (const e of data.events) {
    const p = payload(e);
    if (!e.eventType.startsWith('operation.') || p['to'] !== 'verified') continue;
    const op = ops.get(str(p['operationId']) ?? e.aggregateId);
    const key = op?.target?.resourceKey;
    const gen = (op?.result as { generation?: unknown } | undefined)?.generation;
    if (!op || !op.operationType.startsWith('env.') || typeof key !== 'string' || !key.startsWith('env/') || typeof gen !== 'number') continue;
    const env = key.slice('env/'.length);
    if (!bumpsOf.has(env)) bumpsOf.set(env, []);
    bumpsOf.get(env)!.push({ seq: e.seq ?? 0, generation: gen });
  }
  /** The generation of `env` right before `seq` (undefined when it never changed during the run). */
  const genAt = (env: string, seq: number): number | undefined => {
    const bumps = bumpsOf.get(env);
    if (!bumps || bumps.length === 0) return undefined;
    let g = bumps[0]!.generation - 1;
    for (const b of bumps) if (b.seq < seq) g = Math.max(g, b.generation);
    return g;
  };
  const calls = new Map<string, { agentId: string; envs: string[]; mutating: boolean; staleAt?: boolean }>();
  const observed = new Map<string, number>(); // agent + env → generation observed
  const staleMutations: string[] = [];
  let checkedMutations = 0;
  const moved: StalenessAnalysis['movedWorldRejections'] = [];
  const refreshed: StalenessAnalysis['refreshed'] = [];
  const awaitingRefresh = new Map<string, { agentId: string; environmentId: string; generation: number }>();
  let rejections = 0;
  const key = (agentId: string, env: string) => `${agentId}\u0000${env}`;
  for (const e of data.events) {
    const p = payload(e);
    const seq = e.seq ?? 0;
    if (e.eventType === 'tool.called') {
      const inv = str(p['invocationId']) ?? e.aggregateId;
      const agentId = e.agentId ?? '';
      const envs = envOfResources(p['resources']);
      const call: { agentId: string; envs: string[]; mutating: boolean; staleAt?: boolean } = { agentId, envs, mutating: !NON_MUTATING_EFFECTS.has(String(p['effect'] ?? 'read')) };
      if (call.mutating) {
        // the agent's view of each environment it acts on, against the environment's generation at the call
        const views = envs.map((env) => ({ obs: observed.get(key(agentId, env)), now: genAt(env, seq) })).filter((v): v is { obs: number; now: number } => v.obs !== undefined && v.now !== undefined);
        if (views.length > 0) call.staleAt = views.some((v) => v.obs < v.now);
      }
      calls.set(inv, call);
    } else if (e.eventType === 'tool.completed') {
      const inv = str(p['invocationId']) ?? e.aggregateId;
      const c = calls.get(inv);
      if (!c || p['status'] !== 'success') continue;
      if (c.mutating && c.staleAt !== undefined) {
        checkedMutations++;
        if (c.staleAt) staleMutations.push(inv);
      }
      for (const env of c.envs) {
        const g = genAt(env, seq);
        if (g === undefined) continue;
        observed.set(key(c.agentId, env), g);
        const waiting = awaitingRefresh.get(key(c.agentId, env));
        if (waiting && g >= waiting.generation) {
          refreshed.push({ agentId: c.agentId, environmentId: env, generation: g });
          awaitingRefresh.delete(key(c.agentId, env));
        }
      }
    } else if (e.eventType === 'context.stale_rejected') {
      rejections++;
      const stale = Array.isArray(p['stale']) ? (p['stale'] as Array<Record<string, unknown>>) : [];
      for (const s of stale) {
        const env = s['resourceId'];
        if (s['resourceType'] !== 'environment' || typeof env !== 'string') continue;
        const observedGen = generationOf(s['observedVersion']);
        const current = genAt(env, seq);
        if (observedGen === undefined || current === undefined || !(observedGen < current)) continue;
        const r: StalenessAnalysis['movedWorldRejections'][number] = { seq, environmentId: env, observed: observedGen, current };
        if (e.agentId) {
          r.agentId = e.agentId;
          awaitingRefresh.set(key(e.agentId, env), { agentId: e.agentId, environmentId: env, generation: current });
        }
        moved.push(r);
      }
    }
  }
  return { bumps: Object.fromEntries(bumpsOf), rejections, movedWorldRejections: moved, staleMutations, checkedMutations, refreshed };
}

// ------------------------------------------------------------------------------------------------ (additive) test sensitivity

export interface SensitivityAnalysis {
  /** mutation-result evidence of the run: killed / total mutants each. */
  mutationRuns: Array<{ evidenceId: string; killed: number; total: number }>;
  /** Σ killed / Σ total over the run's mutation results (undefined without any). */
  mutationScore?: number;
}

/** Mutation testing of the run's tests (oracle sensitivity: how many seeded mutants the tests detect). */
export function analyzeSensitivity(data: Pick<TrialData, 'evidence'>): SensitivityAnalysis {
  const runs = data.evidence
    .filter((e) => e.evidenceType === 'mutation-result')
    .map((e) => {
      const s = (e.structured ?? {}) as { killed?: unknown; total?: unknown; survived?: unknown; mutants?: unknown };
      const killed = typeof s.killed === 'number' ? s.killed : 0;
      const total = typeof s.total === 'number' ? s.total : Array.isArray(s.mutants) ? s.mutants.length : killed + (typeof s.survived === 'number' ? s.survived : 0);
      return { evidenceId: e.evidenceId, killed, total };
    });
  const total = runs.reduce((s, r) => s + r.total, 0);
  const out: SensitivityAnalysis = { mutationRuns: runs };
  if (total > 0) out.mutationScore = runs.reduce((s, r) => s + r.killed, 0) / total;
  return out;
}
