import { isHypertestError } from '@hypertest/core';
import {
  EVENT_TYPES, isTerminalWorkState,
  type EventContext, type ExperimentSpec, type ResourceClaim, type TestRun, type ToolEffect, type WorkItem,
} from '@hypertest/domain';
import type { BudgetExhaustion, OpenReservation } from '@hypertest/operation';
import type { ControlDeps, ResolvedControlConfig } from './deps.ts';
import { runScope, workScope } from './work-factory.ts';
import { event, isTerminalRunStatus, runCtx } from './util.ts';

/**
 * Unit B2 — experiment isolation (conformance-6) and budget leases (conformance-5) of the control plane.
 *
 * Experiments: `experiment.define` admits the experiment's `isolation.resourceClaims` through ResourceAdmission with the
 * experiment as holder (holder = experimentId). While an OWNER of the experiment is live — the work item that defined it
 * or any work item that declares it (`inputRefs` kind `experiment`) — the scheduler renews the claims every tick; once no
 * owner is live, or the run ended, they are released. A write/fault tool call (effect `external` / `destructive`) of a
 * work item that runs for experiments needs those claims held (dispatcher; `experiment_claims_missing`).
 *
 * External QPS: `load.start` reserves its request rate (`externalQps`, key `qps:<invocationId>`) against the run's
 * `maxExternalQps` while the job runs; the reservation is released when the job's operation settles (completed, failed,
 * stopped, never applied), when `load.stop` stopped it, when its work item ended without a job, or when the run ended.
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
 * The declared experiments of a work item that are experiments OF ITS RUN (the only ones whose claims it may share:
 * declaring another run's experiment id never lets an item past that experiment's claims).
 */
export async function runExperimentIds(deps: Pick<ControlDeps, 'specs'>, item: Pick<WorkItem, 'inputRefs' | 'runId'>): Promise<string[]> {
  const out: string[] = [];
  for (const id of declaredExperimentIds(item)) {
    const spec = await deps.specs.getExperiment(id);
    if (spec && spec.runId === item.runId) out.push(id);
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
 * (conformance-6) Keeps the claims of the run's experiments in step with their owners: renewed (TTL extended, or
 * re-admitted) while the defining work item or a work item declaring the experiment is not terminal; released once none
 * is (`admission.released`, reason `owners_ended`) or the run ended. A renewal refused by another holder is recorded
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
    const live = !isTerminalRunStatus(run.status) && owners.some((o) => {
      const w = byId.get(o);
      return w !== undefined && !isTerminalWorkState(w.state);
    });
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

// ---------------------------------------------------------------------------------------------------- external QPS

export const QPS_KEY_PREFIX = 'qps:';

export function qpsKey(invocationId: string): string {
  return `${QPS_KEY_PREFIX}${invocationId}`;
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
    const invocationId = r.idempotencyKey!.slice(QPS_KEY_PREFIX.length);
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
