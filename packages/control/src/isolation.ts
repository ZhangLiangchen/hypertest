import { isHypertestError, sha256Hex, type JsonValue } from '@hypertest/core';
import {
  EVENT_TYPES, isTerminalWorkState,
  type EventContext, type ExperimentSpec, type OperationStatus, type ResourceClaim, type TestRun, type ToolEffect, type WorkItem,
} from '@hypertest/domain';
import type { BudgetExhaustion, OpenReservation } from '@hypertest/operation';
import { FAULT_TOOL_IDS, LOAD_TOOL_IDS, evaluateStopConditions, planViolation, type ExperimentActionFacts } from '@hypertest/policy';
import type { EnvironmentRegistry } from '@hypertest/tools';
import type { ControlDeps, ResolvedControlConfig } from './deps.ts';
import { experimentScope, experimentStopEventId, recordExperimentStop } from './domain-tools/specs.ts';
import { runScope, workScope } from './work-factory.ts';
import { event, isTerminalRunStatus, runCtx } from './util.ts';

/**
 * Unit B2 — experiment isolation (conformance-6) and budget leases (conformance-5) of the control plane.
 *
 * Experiments: `experiment.define` admits the experiment's `isolation.resourceClaims` through ResourceAdmission with the
 * experiment as holder (holder = experimentId). While an OWNER of the experiment is live — the work item that defined it
 * or any work item that declares it (`inputRefs` kind `experiment`) — the scheduler renews the claims every tick; once no
 * owner is live, or the run ended, they are released. A write/fault tool call (effect `external` / `destructive`) of a
 * work item that runs for experiments needs those claims held (dispatcher; `experiment_claims_missing`) and may act only
 * on the environments/URLs they cover; no work item's write/fault call may touch a resource another experiment holds
 * (`experiment_resource_conflict`; `experimentResourceProblem`).
 *
 * External QPS: `load.start` reserves its request rate (`externalQps`, key `qps:<invocationId>`, reason
 * `load:<invocationId>`) against the run's `maxExternalQps` while the job runs; the reservation is released when the
 * job's operation settles (completed, failed, stopped, never applied), when `load.stop` stopped it, when its work item
 * ended without a job, or when the run ended. A replayed call whose reservation was already given back reserves again
 * under `qpsKey(invocationId, n)`; a call that throws keeps the rate while its job may run (`qpsJobMayRun`).
 */

/** Effects that act on the outside world: inside an experiment they need its claims held. */
export const EXPERIMENT_GUARDED_EFFECTS: ReadonlySet<ToolEffect> = new Set<ToolEffect>(['external', 'destructive']);
/** Guarded tools that only END an effect (stopping a load job must stay possible even when the claims lapsed). */
export const EXPERIMENT_EXEMPT_TOOLS: readonly string[] = ['load.stop'];
/** Tools that inject faults: they need a `fault_exclusive` claim of the experiment. */
export const FAULT_TOOLS: readonly string[] = ['env.inject_fault'];

/** The ids of the experiments a work item declares (`inputRefs` of kind `experiment`), deduplicated, in order. */
export function declaredExperimentIds(item: Pick<WorkItem, 'inputRefs'>): string[] {
  return [...new Set((item.inputRefs ?? []).filter((r) => r.kind === 'experiment' && typeof r.id === 'string' && r.id.length > 0).map((r) => r.id))];
}

/**
 * The experiments OF ITS RUN a work item runs for (the only ones whose claims it may share: declaring another run's
 * experiment id never lets an item past that experiment's claims): the ones it declares, and — when `agents` is given
 * (D-4) — the ones its own agent defined (the experiment already shares its claims with its defining item, so the item's
 * own claims must share them back, or the item would lose its resources to its own experiment).
 */
export async function runExperimentIds(deps: Pick<ControlDeps, 'specs'> & Partial<Pick<ControlDeps, 'agents'>>, item: Pick<WorkItem, 'inputRefs' | 'runId'> & Partial<Pick<WorkItem, 'workItemId'>>): Promise<string[]> {
  const out: string[] = [];
  for (const id of declaredExperimentIds(item)) {
    const spec = await deps.specs.getExperiment(id);
    if (spec && spec.runId === item.runId) out.push(id);
  }
  if (deps.agents && item.workItemId !== undefined) {
    const agent = await deps.agents.byWorkItem(item.workItemId);
    if (agent && agent.runId === item.runId) {
      for (const e of await deps.specs.listExperiments(item.runId)) if (e.createdBy === agent.agentId && !out.includes(e.experimentId)) out.push(e.experimentId);
    }
  }
  return out;
}

function sameClaim(a: ResourceClaim, b: ResourceClaim): boolean {
  return a.resourceKey === b.resourceKey && a.mode === b.mode && (a.quantity ?? null) === (b.quantity ?? null);
}

/** The live claims of one holder (ResourceAdmission.held when available, else filtered from the run's active claims). */
export async function heldClaims(deps: Pick<ControlDeps, 'admission'>, holderId: string, runId: string): Promise<ResourceClaim[]> {
  if (deps.admission.held) return (await deps.admission.held(holderId)).map((h) => h.claim);
  return (await deps.admission.active(runId)).filter((a) => a.holderId === holderId).map((a) => a.claim);
}

/**
 * Why a write/fault call (effect `external`/`destructive`) of a work item running for `experimentIds` may NOT run: an
 * experiment unknown to the run, one without a write/fault claim (a read-only experiment cannot host writes; a fault
 * tool needs `fault_exclusive`), or one whose claims are not all held right now (lapsed, released, taken). undefined:
 * the call may run.
 */
export async function experimentClaimsProblem(deps: Pick<ControlDeps, 'admission' | 'specs'>, runId: string, experimentIds: readonly string[], toolId: string): Promise<string | undefined> {
  for (const id of experimentIds) {
    const spec = await deps.specs.getExperiment(id);
    if (!spec || spec.runId !== runId) return `experiment ${id} does not exist in run ${runId}`;
    const claims = spec.isolation.resourceClaims;
    if (FAULT_TOOLS.includes(toolId) ? !claims.some((c) => c.mode === 'fault_exclusive') : !claims.some((c) => c.mode !== 'read_shared')) {
      return `experiment ${id} holds no ${FAULT_TOOLS.includes(toolId) ? 'fault_exclusive' : 'write_exclusive or fault_exclusive'} claim (isolation ${spec.isolation.mode}: ${claims.map((c) => `${c.mode}(${c.resourceKey})`).join(', ') || 'no claims'}); define an experiment whose isolation claims the resources ${toolId} acts on`;
    }
    const held = await heldClaims(deps, id, runId);
    const missing = claims.filter((c) => !held.some((h) => sameClaim(c, h)));
    if (missing.length > 0) return `the claims of experiment ${id} are not held (${missing.map((c) => `${c.mode}(${c.resourceKey})`).join(', ')}: lapsed, released or taken by another experiment)`;
  }
  return undefined;
}

/**
 * Resource-key namespaces that address the system under test (environments, bare URLs). A write/fault call of a work item
 * running for experiments may act on such a resource only when one of its experiments claims it (the claim key equals
 * the resource key or is an ancestor of it): admission can only keep two experiments apart on resources they claim.
 */
export const EXPERIMENT_COVERED_PREFIXES: readonly string[] = ['env/', 'url/'];

function keyCovers(claimKey: string, resourceKey: string): boolean {
  return resourceKey === claimKey || resourceKey.startsWith(`${claimKey}/`);
}

function keysOverlap(a: string, b: string): boolean {
  return keyCovers(a, b) || keyCovers(b, a);
}

/**
 * The environment keys a `url/<host>` resource also addresses: `env/<id>` of every registered environment one of whose
 * URLs (base, metrics, prometheus) has that host — the same system under test named by URL instead of id. Other
 * resources have no alias.
 */
export function resourceAliases(resource: string, environments: Pick<EnvironmentRegistry, 'list'> | undefined): string[] {
  if (!resource.startsWith('url/') || !environments) return [];
  const host = resource.slice('url/'.length).toLowerCase();
  const out: string[] = [];
  for (const env of environments.list()) {
    const hosts = [env.baseUrl, env.metricsUrl, env.prometheusUrl].flatMap((u) => {
      if (!u) return [];
      try {
        return [new URL(u).host.toLowerCase()];
      } catch {
        return [];
      }
    });
    if (hosts.includes(host)) out.push(`env/${env.environmentId}`);
  }
  return out;
}

export type ExperimentResourceVerdict =
  | { ok: true; covering: string[] }
  | { ok: false; code: 'experiment_claims_missing' | 'experiment_resource_conflict'; problem: string };

/**
 * (conformance-6, review B2) What the resources of a write/fault call (effect `external`/`destructive`) say about experiment
 * isolation — checked on top of `experimentClaimsProblem`:
 *
 *  - coverage: a work item running for experiments acts only on SUT resources (EXPERIMENT_COVERED_PREFIXES) that one of
 *    its experiments claims — with `fault_exclusive` for a fault tool, `write_exclusive`/`fault_exclusive` otherwise.
 *    Otherwise `experiment_claims_missing` (held claims on OTHER resources never license a write/fault here).
 *  - contamination: no resource of the call may overlap (equal, ancestor or descendant key) a live claim of an experiment
 *    the item does not run for — whatever its mode (a write disturbs an observation too) and whichever run it belongs
 *    to. This enforces the recorded contamination rules ("no other experiment or work item may …") for every work
 *    item, also one that runs for no experiment: `experiment_resource_conflict`, naming the holding experiment.
 *
 * `covering`: the item's experiments whose claims cover the call's SUT resources (for attribution). The check reads the
 * live claims at call time (a claim admitted a moment later is not seen: claims are TTL leases renewed by the tick).
 */
export async function experimentResourceProblem(
  deps: Pick<ControlDeps, 'admission' | 'specs'> & { environments?: Pick<EnvironmentRegistry, 'list'> },
  call: { workItemId: string; experimentIds: readonly string[]; toolId: string; resources: () => string[] },
): Promise<ExperimentResourceVerdict> {
  const own = new Set<string>([call.workItemId, ...call.experimentIds]);
  const foreign: Array<{ holderId: string; runId: string; claim: ResourceClaim }> = [];
  const isExperiment = new Map<string, boolean>();
  for (const a of await deps.admission.active()) {
    if (own.has(a.holderId)) continue;
    let known = isExperiment.get(a.holderId);
    if (known === undefined) {
      known = (await deps.specs.getExperiment(a.holderId)) !== undefined;
      isExperiment.set(a.holderId, known);
    }
    if (known) foreign.push(a);
  }
  if (call.experimentIds.length === 0 && foreign.length === 0) return { ok: true, covering: [] };
  let resources: string[];
  try {
    resources = call.resources();
    if (!Array.isArray(resources) || resources.some((r) => typeof r !== 'string' || r.length === 0)) throw new Error('malformed resources');
  } catch (e) {
    // fail closed: what the call acts on is unknown, so it cannot be shown to stay inside (or away from) the claims
    return { ok: false, code: call.experimentIds.length > 0 ? 'experiment_claims_missing' : 'experiment_resource_conflict', problem: `the resources of ${call.toolId} cannot be determined (${(e as Error).message})` };
  }
  const covering = new Set<string>();
  if (call.experimentIds.length > 0) {
    const fault = FAULT_TOOLS.includes(call.toolId);
    const specs: ExperimentSpec[] = [];
    for (const id of call.experimentIds) {
      const spec = await deps.specs.getExperiment(id);
      if (spec) specs.push(spec);
    }
    for (const r of resources) {
      if (!EXPERIMENT_COVERED_PREFIXES.some((p) => r.startsWith(p))) continue;
      // a URL of a registered environment is covered by a claim on that environment too
      const names = [r, ...resourceAliases(r, deps.environments)];
      const by = specs.filter((s) => s.isolation.resourceClaims.some((c) => (fault ? c.mode === 'fault_exclusive' : c.mode !== 'read_shared') && names.some((n) => keyCovers(c.resourceKey, n))));
      if (by.length === 0) {
        const claims = specs.flatMap((s) => s.isolation.resourceClaims.map((c) => `${c.mode}(${c.resourceKey})`));
        return {
          ok: false,
          code: 'experiment_claims_missing',
          problem: `resource ${r} is outside the claims of experiment ${call.experimentIds.join(', ')} (${claims.join(', ') || 'no claims'}); ${call.toolId} needs a ${fault ? 'fault_exclusive' : 'write_exclusive or fault_exclusive'} claim on ${r} (or an ancestor key) — define an experiment that claims it`,
        };
      }
      for (const s of by) covering.add(s.experimentId);
    }
  }
  for (const r of resources) {
    // an environment addressed by URL is the environment: its claims apply (no alias bypass)
    const names = [r, ...resourceAliases(r, deps.environments)];
    const hit = foreign.find((a) => names.some((n) => keysOverlap(a.claim.resourceKey, n)));
    if (hit) {
      return {
        ok: false,
        code: 'experiment_resource_conflict',
        problem: `resource ${r} is claimed by experiment ${hit.holderId} of run ${hit.runId} (${hit.claim.mode}(${hit.claim.resourceKey})): a write/fault call there would invalidate that experiment`,
      };
    }
  }
  return { ok: true, covering: [...covering].sort() };
}

/** The work item that defined an experiment (its creator agent's work item), when known. */
async function definingWorkItem(deps: Pick<ControlDeps, 'agents'>, spec: ExperimentSpec): Promise<string | undefined> {
  const agent = await deps.agents.get(spec.createdBy);
  return agent && agent.runId === spec.runId ? agent.workItemId : undefined;
}

export interface ExperimentSync {
  renewed: string[];
  released: string[];
  lapsed: string[];
}

/**
 * (review B2) Whether an operation recorded for the experiment (`ht_operations.experiment_id`) may still act: not settled
 * (a running load job stays `acknowledged` until it ended). Fails closed: an unreadable ledger counts as running.
 */
export async function experimentEffectsRunning(deps: Pick<ControlDeps, 'ledger' | 'logger'>, runId: string, experimentId: string): Promise<boolean> {
  try {
    return (await deps.ledger.list({ runId, experimentId, status: [...JOB_MAY_RUN] as OperationStatus[] })).length > 0;
  } catch (e) {
    deps.logger.warn('experiment operations unreadable: its claims are kept', { runId, experimentId, error: (e as Error).message });
    return true;
  }
}

/**
 * (conformance-6) Keeps the claims of the run's experiments in step with their owners: renewed (TTL extended, or
 * re-admitted) while the defining work item or a work item declaring the experiment is not terminal — or an operation
 * recorded for the experiment may still act (review B2: e.g. its load job outlives the item that started it); released
 * once none is (`admission.released`, reason `owners_ended`) or the run ended. A renewal refused by another holder is recorded
 * once per conflict set (`admission.lapsed`, aggregate `experiment`): write/fault tools of the experiment are refused
 * from then on (the dispatcher finds its claims not held).
 */
export async function syncExperimentClaims(
  deps: ControlDeps,
  config: Pick<ResolvedControlConfig, 'leaseTtlMs' | 'workerId'>,
  run: TestRun,
  items: WorkItem[],
  lapseMemo: Map<string, string>,
): Promise<ExperimentSync> {
  const out: ExperimentSync = { renewed: [], released: [], lapsed: [] };
  const experiments = (await deps.specs.listExperiments(run.runId)).filter((e) => e.isolation.resourceClaims.length > 0);
  if (experiments.length === 0) return out;
  const byId = new Map(items.map((w) => [w.workItemId, w]));
  const ctx = runCtx(run.runId, config.workerId);
  for (const spec of experiments) {
    const id = spec.experimentId;
    const owners = items.filter((w) => declaredExperimentIds(w).includes(id)).map((w) => w.workItemId);
    const definer = await definingWorkItem(deps, spec);
    if (definer !== undefined) owners.push(definer);
    const ownerLive = owners.some((o) => {
      const w = byId.get(o);
      return w !== undefined && !isTerminalWorkState(w.state);
    });
    // review B2: an effect of the experiment that may still act (a load job outliving the item that started it) keeps the
    // experiment isolated — releasing its claims then would admit a competing experiment onto a resource under load
    const live = !isTerminalRunStatus(run.status) && (ownerLive || (await experimentEffectsRunning(deps, run.runId, id)));
    if (!live) {
      if ((await heldClaims(deps, id, run.runId)).length === 0) continue;
      await deps.admission.release(id);
      lapseMemo.delete(id);
      out.released.push(id);
      await deps.events.append([event(ctx, 'admission.released', 'experiment', id, { experimentId: id, claims: spec.isolation.resourceClaims, reason: isTerminalRunStatus(run.status) ? 'run_ended' : 'owners_ended' })]);
      deps.logger.info('experiment claims released: no live owner', { runId: run.runId, experimentId: id });
      continue;
    }
    const r = await deps.admission.admit({ holderId: id, runId: run.runId, claims: spec.isolation.resourceClaims, ttlMs: config.leaseTtlMs, compatibleHolders: [...new Set(owners)] });
    if (r.admitted) {
      lapseMemo.delete(id);
      out.renewed.push(id);
      continue;
    }
    const conflicts = r.conflicts.map((c) => `${c.requested.resourceKey}@${c.heldBy}`).sort();
    out.lapsed.push(id);
    const signature = conflicts.join('\u0000');
    if (lapseMemo.get(id) !== signature) {
      lapseMemo.set(id, signature);
      if (lapseMemo.size > 10_000) lapseMemo.delete(lapseMemo.keys().next().value!);
      deps.logger.warn('experiment claims could not be renewed (taken by another holder); its write/fault tools are refused', { runId: run.runId, experimentId: id, conflicts });
      await deps.events.append([event(ctx, EVENT_TYPES.admissionLapsed, 'experiment', id, { experimentId: id, conflicts, claims: spec.isolation.resourceClaims, phase: 'experiment_renewal' })]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- experiment governance

/** (D-3) Deterministic event id of the `experiment.action` record of one tool invocation. */
export function experimentActionEventId(invocationId: string): string {
  return `evt_expact_${sha256Hex(`experiment.action\u0000${invocationId}`).slice(0, 32)}`;
}

/** (D-3) What a write/fault/load call is about to do, from its (validated) arguments — compared with the experiment's plan. */
export function actionFacts(toolId: string, args: Record<string, unknown>): ExperimentActionFacts {
  const out: ExperimentActionFacts = {};
  const env = typeof args['environmentId'] === 'string' ? (args['environmentId'] as string) : undefined;
  if (toolId === 'env.inject_fault') {
    if (typeof args['kind'] === 'string') out.kind = args['kind'] as string;
    if (env !== undefined) out.target = env;
    if (args['params'] && typeof args['params'] === 'object' && !Array.isArray(args['params'])) out.params = args['params'] as Record<string, JsonValue>;
    if (typeof args['durationMs'] === 'number') out.durationMs = args['durationMs'] as number;
  } else if (toolId === 'env.restart' || toolId === 'env.deploy') {
    out.kind = toolId === 'env.restart' ? 'restart' : 'deploy';
    if (env !== undefined) out.target = env;
  } else if (toolId === 'load.start') {
    out.kind = 'http_load';
    if (typeof args['targetUrl'] === 'string') out.target = args['targetUrl'] as string;
    else if (env !== undefined) out.target = `env/${env}`;
    for (const k of ['ratePerSecond', 'durationMs', 'concurrency'] as const) if (typeof args[k] === 'number') out[k] = args[k] as number;
  } else {
    if (env !== undefined) out.target = env;
    else if (typeof args['url'] === 'string') out.target = args['url'] as string;
  }
  return out;
}

export type ExperimentActionVerdict = { ok: true } | { ok: false; code: 'experiment_stopped' | 'experiment_plan_violation' | 'experiment_budget_exhausted'; problem: string };

/**
 * (D-3 / D-4) Whether experiment `spec` is ACTIVE for one more write/fault/load call `toolId` (invocation `invocationId`):
 * not stopped (a recorded stop, or a stop condition met now — evaluated deterministically on its evidence and actions and
 * then recorded), within its declared plan (a fault must be in the fault plan, load within the workload), and within its
 * budget (wall clock since definition; tool calls charged to `experiment:<id>`). On success the call is recorded as an
 * `experiment.action` (one per invocation) — the facts the QualityGate compares with the plan (C10).
 */
export async function experimentActionCheck(
  deps: ControlDeps,
  ctx: EventContext,
  spec: ExperimentSpec,
  call: { toolId: string; invocationId: string; args: Record<string, unknown>; workItemId: string },
): Promise<ExperimentActionVerdict> {
  const id = spec.experimentId;
  const stopped = await deps.events.get(experimentStopEventId(id));
  if (stopped) {
    const p = (stopped.payload ?? {}) as { condition?: string; reason?: string };
    return { ok: false, code: 'experiment_stopped', problem: `experiment ${id} was stopped (${p.condition ?? 'manual'}: ${p.reason ?? ''}); its write, load and fault calls are refused — define a new experiment to continue` };
  }
  const evidence = (await deps.evidence.query({ runId: spec.runId })).filter((e) => (e.provenance as { experimentId?: string } | undefined)?.experimentId === id);
  const actions = await deps.ledger.list({ runId: spec.runId, experimentId: id });
  const stop = evaluateStopConditions(spec, evidence, actions, deps.clock.isoNow());
  if (stop.met) {
    await recordExperimentStop(deps, ctx, spec, { condition: stop.condition.kind, reason: `stop condition ${stop.condition.kind} met`, observed: stop.observed, at: stop.at });
    return { ok: false, code: 'experiment_stopped', problem: `stop condition ${stop.condition.kind} of experiment ${id} is met (${stop.observed}); the experiment is stopped and its write, load and fault calls are refused` };
  }
  const facts = actionFacts(call.toolId, call.args);
  if (FAULT_TOOL_IDS.includes(call.toolId) || LOAD_TOOL_IDS.includes(call.toolId)) {
    const v = planViolation(spec, call.toolId, facts);
    if (v) return { ok: false, code: 'experiment_plan_violation', problem: v };
  }
  const b = spec.budget;
  if (b?.maxWallClockMs !== undefined && deps.clock.nowMs() - Date.parse(spec.createdAt) > b.maxWallClockMs) {
    const scope = experimentScope(id);
    await deps.events.append([event(ctx, EVENT_TYPES.budgetExhausted, 'budget', scope, { scope, dimension: 'wallClockMs', limit: b.maxWallClockMs, used: deps.clock.nowMs() - Date.parse(spec.createdAt), reserved: 0, requested: 0, reason: 'experiment_wall_clock', experimentId: id, toolId: call.toolId, invocationId: call.invocationId })]);
    return { ok: false, code: 'experiment_budget_exhausted', problem: `the wall-clock budget of experiment ${id} (${b.maxWallClockMs} ms) is spent; its actions are refused` };
  }
  if (b?.maxToolCalls !== undefined) {
    const scope = experimentScope(id);
    const charged = await deps.budget.charge([scope], { toolCalls: 1 }, `experiment:${call.invocationId}`, { idempotencyKey: `exp:${call.invocationId}` });
    if (!charged.ok) {
      await deps.events.append([event(ctx, EVENT_TYPES.budgetExhausted, 'budget', scope, { ...charged.exhausted, reason: 'experiment_tool_calls', experimentId: id, toolId: call.toolId, invocationId: call.invocationId })]);
      return { ok: false, code: 'experiment_budget_exhausted', problem: `the tool-call budget of experiment ${id} is spent (${charged.exhausted.used}/${charged.exhausted.limit}); its actions are refused` };
    }
  }
  const eventId = experimentActionEventId(call.invocationId);
  if (!(await deps.events.get(eventId))) {
    try {
      await deps.events.append([{ ...event(ctx, EVENT_TYPES.experimentAction, 'experiment', id, { experimentId: id, toolId: call.toolId, invocationId: call.invocationId, workItemId: call.workItemId, ...facts }), eventId }]);
    } catch (e) {
      // (review) a concurrent replay of the same invocation recorded it first (same deterministic id)
      if (!(await deps.events.get(eventId))) throw e;
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------- external QPS

export const QPS_KEY_PREFIX = 'qps:';
/** Reason of a QPS reservation: `load:<invocationId>` (the reservation's link to its load.start call). */
export const QPS_REASON_PREFIX = 'load:';

/**
 * The idempotency key of a load.start call's QPS reservation. `attempt` > 1 (review B2): a replay of a call whose first
 * reservation was already given back reserves the rate again under a fresh key (a keyed reserve returns the old,
 * released reservation as is — a job must never run on it).
 */
export function qpsKey(invocationId: string, attempt = 1): string {
  return attempt <= 1 ? `${QPS_KEY_PREFIX}${invocationId}` : `${QPS_KEY_PREFIX}${invocationId}#${attempt}`;
}

/** The load.start invocation a QPS reservation belongs to (from its reason; the key of a re-reservation has a suffix). */
export function qpsInvocationId(r: Pick<OpenReservation, 'reason' | 'idempotencyKey'>): string {
  if (r.reason.startsWith(QPS_REASON_PREFIX)) return r.reason.slice(QPS_REASON_PREFIX.length);
  return (r.idempotencyKey ?? '').slice(QPS_KEY_PREFIX.length);
}

/** Load-operation states in which the job is certainly not running any more (its rate can be given back). */
const JOB_ENDED: ReadonlySet<string> = new Set(['verified', 'failed', 'not_applied', 'compensated']);
/** Operation states of a load.start call that still (or maybe) runs a job: its rate stays reserved. */
export const JOB_MAY_RUN: ReadonlySet<string> = new Set(['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'reconciling', 'compensating', 'manual_review']);

async function openQps(deps: Pick<ControlDeps, 'budget'>, runId: string): Promise<OpenReservation[]> {
  if (!deps.budget.openReservations) return [];
  return (await deps.budget.openReservations(runScope(runId))).filter((r) => r.idempotencyKey?.startsWith(QPS_KEY_PREFIX));
}

/**
 * (conformance-5) Gives back the QPS reservations of load jobs that no longer run. `stopped`: load.start operation ids a
 * verified `load.stop` ended (released whatever the job's own operation says). Otherwise a reservation is released when
 * its job's operation settled with the job ended (verified / failed / not_applied / compensated), or when no job was
 * ever recorded for it and its work item ended. `manual_review` keeps the rate reserved (the job may run) until the run
 * ends. Returns the released reservation ids.
 */
export async function settleExternalQps(deps: Pick<ControlDeps, 'budget' | 'ledger' | 'blackboard' | 'logger'>, runId: string, options: { stopped?: string[]; operationIds?: string[] } = {}): Promise<string[]> {
  const open = await openQps(deps, runId);
  if (open.length === 0) return [];
  const stopped = new Set(options.stopped ?? []);
  const only = options.operationIds ? new Set([...options.operationIds, ...stopped]) : undefined;
  const released: string[] = [];
  for (const r of open) {
    const invocationId = qpsInvocationId(r);
    const op = await deps.ledger.findByToolInvocation(invocationId, 'load.start');
    const mine = op && op.runId === runId ? op : undefined;
    if (only && (!mine || !only.has(mine.operationId))) continue;
    let release = false;
    if (mine) release = stopped.has(mine.operationId) || JOB_ENDED.has(mine.status);
    else {
      const workItemId = r.scopes.find((s) => s.startsWith('work:'))?.slice('work:'.length);
      const item = workItemId ? await deps.blackboard.getWorkItem(workItemId) : undefined;
      release = !item || isTerminalWorkState(item.state);
    }
    if (!release) continue;
    await deps.budget.release(r.reservationId);
    released.push(r.reservationId);
    deps.logger.info('external QPS reservation released: the load job ended', { runId, reservationId: r.reservationId, operationId: mine?.operationId, status: mine?.status });
  }
  return released;
}

/**
 * (review B2) Whether the load job of a load.start invocation may be running: its operation is recorded and not settled
 * as ended — or the ledger cannot be read (fail closed: the rate stays reserved; the tick, the item's end or the run's
 * end gives it back). false only when no operation was ever prepared for the call (nothing was dispatched) or it ended.
 */
export async function qpsJobMayRun(deps: Pick<ControlDeps, 'ledger' | 'logger'>, runId: string, invocationId: string): Promise<boolean> {
  try {
    const op = await deps.ledger.findByToolInvocation(invocationId, 'load.start');
    if (!op || op.runId !== runId) return false;
    return !JOB_ENDED.has(op.status);
  } catch (e) {
    deps.logger.warn('load job state unknown: its QPS reservation is kept', { runId, invocationId, error: (e as Error).message });
    return true;
  }
}

/**
 * (durability-1 × conformance-5) The open reservations of a work claim taken from a dead worker: its in-flight model
 * calls will never settle, so they are released — but NOT the QPS reservation of a load job it started: the external
 * job survives its worker (recovery re-attaches it) and keeps sending requests, so its rate stays reserved until the job
 * ended (`settleExternalQps`) or the run ended (`releaseRunIsolation`). Returns the released reservation ids.
 */
export async function releaseStrandedReservations(deps: Pick<ControlDeps, 'budget'>, scope: string): Promise<string[]> {
  // a ledger that cannot list its open reservations cannot tell a QPS lease apart: the old behaviour (release all)
  if (!deps.budget.openReservations) return (await deps.budget.releaseOpen?.(scope)) ?? [];
  const released: string[] = [];
  for (const r of await deps.budget.openReservations(scope)) {
    if (r.idempotencyKey?.startsWith(QPS_KEY_PREFIX)) continue;
    await deps.budget.release(r.reservationId);
    released.push(r.reservationId);
  }
  return released;
}

/**
 * (conformance-5/6) Everything a finished run still holds for isolation: its experiments' claims and the QPS reservations
 * of its load jobs (a model call still settling keeps its own reservation: it settles to its actual use). Idempotent.
 */
export async function releaseRunIsolation(deps: ControlDeps, runId: string, ctx: EventContext): Promise<{ experiments: string[]; reservations: string[] }> {
  const experiments: string[] = [];
  for (const spec of await deps.specs.listExperiments(runId)) {
    if (spec.isolation.resourceClaims.length === 0 || (await heldClaims(deps, spec.experimentId, runId)).length === 0) continue;
    await deps.admission.release(spec.experimentId);
    experiments.push(spec.experimentId);
    await deps.events.append([event(ctx, 'admission.released', 'experiment', spec.experimentId, { experimentId: spec.experimentId, claims: spec.isolation.resourceClaims, reason: 'run_ended' })]);
  }
  const reservations: string[] = [];
  for (const r of await openQps(deps, runId)) {
    await deps.budget.release(r.reservationId);
    reservations.push(r.reservationId);
  }
  if (experiments.length + reservations.length > 0) deps.logger.info('run ended: isolation released', { runId, experiments, reservations });
  return { experiments, reservations };
}

// ---------------------------------------------------------------------------------------------------- exhaustion

/**
 * (conformance-5) A typed budget exhaustion observed on a tool call (compute, artifact bytes, external QPS): recorded on
 * L0 (`budget.exhausted`) and handed to the exhaustion policy — never a silent downgrade. A RUN-scope exhaustion of a
 * consumable dimension pauses the run under `onBudgetExhausted: 'pause'`; under `'gate'` the convergence monitor sees the
 * exhausted run scope at the next tick (pending work is cancelled, the gate decides). A QPS refusal is transient (a rate
 * frees up when a job ends): recorded, never a pause.
 */
export async function onToolBudgetExhausted(
  deps: ControlDeps,
  ctx: EventContext,
  runId: string,
  exhausted: BudgetExhaustion,
  info: { reason: 'compute' | 'artifact_bytes' | 'external_qps'; toolId: string; invocationId: string },
): Promise<'paused' | 'recorded'> {
  await deps.events.append([event(ctx, 'budget.exhausted', 'budget', exhausted.scope, { ...exhausted, ...info })]);
  if (info.reason === 'external_qps' || exhausted.scope !== runScope(runId) || (deps.config.onBudgetExhausted ?? 'gate') !== 'pause') return 'recorded';
  try {
    const cur = await deps.runs.get(runId);
    if (cur?.status === 'running') await deps.runs.update(runId, { status: 'paused', pauseReason: 'budget' }, ctx);
  } catch (e) {
    if (!isHypertestError(e, 'conflict') && !isHypertestError(e, 'precondition_failed')) throw e;
  }
  deps.logger.warn('run paused: a tool call exhausted the run budget', { runId, ...exhausted, ...info });
  return 'paused';
}

/**
 * The first of `scopes` (then their ancestors, in chain order) whose `dimension` has no headroom left
 * (used + reserved ≥ limit), as a typed exhaustion; undefined when every limited scope still has some.
 */
export async function exhaustedScope(deps: Pick<ControlDeps, 'budget'>, scopes: string[], dimension: BudgetExhaustion['dimension']): Promise<BudgetExhaustion | undefined> {
  for (const scope of scopes) {
    const u = await deps.budget.usage(scope);
    const limit = u?.limits[dimension];
    if (!u || limit === undefined) continue;
    const used = u.used[dimension] ?? 0;
    const reserved = u.reserved[dimension] ?? 0;
    if (used + reserved >= limit) return { scope, dimension, limit, used, reserved, requested: 0 };
  }
  return undefined;
}

/** The budget scopes of a work item's calls, most specific first (work item, then its run). */
export function callScopes(runId: string, workItemId: string): string[] {
  return [workScope(workItemId), runScope(runId)];
}
