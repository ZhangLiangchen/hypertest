import { HypertestError, hashCanonical, isHypertestError, type JsonValue } from '@hypertest/core';
import { EVENT_TYPES, type ActorRef, type BudgetEnvelope, type BudgetExhaustionPolicy, type EventContext, type TestRun } from '@hypertest/domain';
import type { ApprovalRequest } from '@hypertest/policy';
import type { BudgetRaiseInput } from './contracts.ts';
import type { ControlConfig, ControlDeps } from './deps.ts';
import { experimentScope } from './domain-tools/specs.ts';
import { event, isTerminalRunStatus } from './util.ts';
import { WorkFactory, runScope } from './work-factory.ts';

/**
 * (E[3], stubs[2]) Budget exhaustion is POLICY-SELECTED — never a silent downgrade:
 *  - `gate` (CONDITIONAL_STOP, default): the run converges to the QualityGate (pending work cancelled, active work ends);
 *  - `pause` (PAUSED_BUDGET): the run pauses (pauseReason `budget`) until an operator raises the budget
 *    (`hypertest resume <runId> --raise-…`, POST /runs/:id/resume `{ raise }`) and resumes it; resumed WITHOUT a raise the
 *    same exhaustion converges to the gate (a resume is never a way around the budget);
 *  - `approval` (NEEDS_APPROVAL): the run pauses (pauseReason `approval`) on a budget-extension approval request (kind
 *    `budget`, decided only by a human or the system: `hypertest approve|reject`); approved ⇒ the budget is extended by the
 *    approved amount (the request's `raise`) and the run resumes; rejected / expired ⇒ it converges to the gate.
 * The policy is the run's `budget.onExhausted` (configuration `budget.onExhausted` ⊕ the run's own override), else the
 * control plane's `onBudgetExhausted`. It applies to every RUN budget dimension (model tokens and USD, tool calls,
 * compute, artifact bytes, wall clock, the work-item cap) and to the experiments' own budgets (tool calls, wall clock).
 * Under `gate` a work-item cap or an experiment budget refuses the call (recorded on L0) and the run goes on with the
 * work it has — the refusal is the stop; under `pause` / `approval` such a refusal pauses the run so it can be raised.
 */

export const BUDGET_EXHAUSTION_POLICIES: readonly BudgetExhaustionPolicy[] = Object.freeze(['gate', 'pause', 'approval']);

/** The policy a run applies (its own `budget.onExhausted`, else the control plane's default, else `gate`). */
export function exhaustionPolicy(run: Pick<TestRun, 'budget'>, config: Pick<ControlConfig, 'onBudgetExhausted'>): BudgetExhaustionPolicy {
  return run.budget.onExhausted ?? config.onBudgetExhausted ?? 'gate';
}

/** The budget fields a raise may extend (amounts are ADDED to the run's current limits). */
export const RAISABLE_BUDGET_FIELDS = Object.freeze(['maxModelTokens', 'maxModelCostUsd', 'maxToolCalls', 'maxWallClockMs', 'maxWorkItems', 'maxComputeMinutes', 'maxArtifactBytes'] as const);
export type RaisableBudgetField = (typeof RAISABLE_BUDGET_FIELDS)[number];
const INTEGRAL_FIELDS: ReadonlySet<string> = new Set(['maxModelTokens', 'maxToolCalls', 'maxWallClockMs', 'maxWorkItems', 'maxArtifactBytes']);
/** Optional dimensions: absent = unlimited (a raise of an unlimited dimension is refused). */
const OPTIONAL_FIELDS: ReadonlySet<string> = new Set(['maxModelCostUsd', 'maxComputeMinutes', 'maxArtifactBytes']);

/** A budget raise: amounts added to the run's limits; `experiments` extends experiments' own budgets. */
export type BudgetRaise = BudgetRaiseInput;

/** Problems of a raise (empty when valid): known fields only, amounts > 0 (integers where the limit is integral), at least one. */
export function budgetRaiseProblems(raise: unknown): string[] {
  const out: string[] = [];
  if (!raise || typeof raise !== 'object' || Array.isArray(raise)) return ['raise must be an object of amounts to add to the run budget'];
  const r = raise as Record<string, unknown>;
  let amounts = 0;
  const amount = (path: string, v: unknown, integral: boolean) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || (integral && !Number.isSafeInteger(v))) out.push(`${path} must be ${integral ? 'an integer' : 'a number'} > 0 (got ${JSON.stringify(v)})`);
    else amounts++;
  };
  for (const [k, v] of Object.entries(r)) {
    if (k === 'experiments') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        out.push('raise.experiments must map experiment ids to { maxToolCalls?, maxWallClockMs? }');
        continue;
      }
      for (const [id, e] of Object.entries(v as Record<string, unknown>)) {
        if (!e || typeof e !== 'object' || Array.isArray(e)) {
          out.push(`raise.experiments.${id} must be an object`);
          continue;
        }
        for (const [f, x] of Object.entries(e as Record<string, unknown>)) {
          if (f !== 'maxToolCalls' && f !== 'maxWallClockMs') out.push(`raise.experiments.${id}.${f}: unknown field (maxToolCalls, maxWallClockMs)`);
          else amount(`raise.experiments.${id}.${f}`, x, true);
        }
      }
      continue;
    }
    if (!(RAISABLE_BUDGET_FIELDS as readonly string[]).includes(k)) {
      out.push(`raise.${k}: not a raisable budget field (${RAISABLE_BUDGET_FIELDS.join(', ')}, experiments)`);
      continue;
    }
    amount(`raise.${k}`, v, INTEGRAL_FIELDS.has(k));
  }
  if (out.length === 0 && amounts === 0) out.push('raise names no amount');
  return out;
}

/** One exhausted budget dimension of a run (or of one of its experiments). */
export interface RunExhaustion {
  kind: 'budget' | 'wall_clock';
  /** tokens | costUsd | toolCalls | computeMs | artifactBytes | wallClockMs | workItems | experiment.toolCalls | experiment.wallClockMs */
  dimension: string;
  /** The budget scope (`run:<id>` or `experiment:<id>`). */
  scope: string;
  reason: string;
  limit?: number;
  used?: number;
  /** What the refused call needed (a refusal marker's `requested`). */
  requested?: number;
  experimentId?: string;
}

/** Identity of an exhaustion at the CURRENT limit: a raise of that dimension makes it another exhaustion. */
export function exhaustionKey(x: RunExhaustion): string {
  return hashCanonical({ scope: x.scope, dimension: x.dimension, limit: x.limit ?? null });
}

/** Default extension a NEEDS_APPROVAL request proposes: half the exhausted limit (at least what the refused call needed). */
export const DEFAULT_EXTENSION_FACTOR = 0.5;

/** The raise an approval request proposes for exhaustion `x` (the amount an approval grants). */
export function proposedRaise(run: Pick<TestRun, 'budget'>, x: RunExhaustion): BudgetRaise {
  const half = (n: number | undefined, integral = true) => {
    const v = Math.max((n ?? 0) * DEFAULT_EXTENSION_FACTOR, x.requested ?? 0, integral ? 1 : 0.01);
    return integral ? Math.ceil(v) : Math.ceil(v * 100) / 100;
  };
  switch (x.dimension) {
    case 'tokens':
      return { maxModelTokens: half(run.budget.maxModelTokens) };
    case 'costUsd':
      return { maxModelCostUsd: half(run.budget.maxModelCostUsd, false) };
    case 'toolCalls':
      return { maxToolCalls: half(run.budget.maxToolCalls) };
    case 'computeMs':
      return { maxComputeMinutes: Math.max(1, Math.ceil((run.budget.maxComputeMinutes ?? 1) * DEFAULT_EXTENSION_FACTOR)) };
    case 'artifactBytes':
      return { maxArtifactBytes: half(run.budget.maxArtifactBytes) };
    case 'wallClockMs':
      return { maxWallClockMs: half(run.budget.maxWallClockMs) };
    case 'workItems':
      return { maxWorkItems: half(run.budget.maxWorkItems) };
    case 'experiment.toolCalls':
      return { experiments: { [x.experimentId!]: { maxToolCalls: Math.max(1, Math.ceil((x.limit ?? 1) * DEFAULT_EXTENSION_FACTOR)) } } };
    case 'experiment.wallClockMs':
      return { experiments: { [x.experimentId!]: { maxWallClockMs: Math.max(1, Math.ceil((x.limit ?? 1) * DEFAULT_EXTENSION_FACTOR)) } } };
    default:
      throw new HypertestError('invalid_argument', `no budget raise is defined for dimension ${x.dimension}`);
  }
}

/** The outcome of applying the run's exhaustion policy to an exhaustion. */
export type ExhaustionOutcome =
  | { outcome: 'gate'; reason: string }
  | { outcome: 'paused'; pauseReason: 'budget' | 'approval'; approvalId?: string }
  /** The limit was raised since the refusal: not exhausted any more (retry). */
  | { outcome: 'raised' };

type Deps = Pick<ControlDeps, 'db' | 'events' | 'runs' | 'budget' | 'approvals' | 'specs' | 'clock' | 'logger'> & { config: Pick<ControlConfig, 'onBudgetExhausted'> };

const SOURCE = 'budget_exhaustion';

function payloadOf(e: { payload?: unknown }): Record<string, unknown> {
  return (e.payload ?? {}) as Record<string, unknown>;
}

/** The requester of every budget-extension request (an actor no agent can be: request_approval files as `agent:<id>`). */
export const BUDGET_EXTENSION_REQUESTER: Readonly<ActorRef> = Object.freeze({ kind: 'system', id: 'budget' });

/**
 * The budget-extension approvals the control plane requested for this run (newest last). (review) Only requests the
 * control plane itself filed (requester `system:budget`): an agent can file a `budget` approval imitating one (same
 * subject, another raise), and such a look-alike — even approved — never extends the budget nor ends the wait.
 */
export async function budgetExtensionApprovals(deps: Pick<ControlDeps, 'approvals'>, runId: string): Promise<ApprovalRequest[]> {
  return (await deps.approvals.list({ runId })).filter(
    (a) => a.kind === 'budget' && a.requestedBy.kind === BUDGET_EXTENSION_REQUESTER.kind && a.requestedBy.id === BUDGET_EXTENSION_REQUESTER.id && (a.subject as { source?: unknown } | null)?.source === SOURCE,
  );
}

/** The current limit of the exhausted dimension (undefined: unlimited / unknown). */
async function currentLimit(deps: Deps, run: TestRun, x: RunExhaustion): Promise<number | undefined> {
  if (x.dimension === 'wallClockMs') return run.budget.maxWallClockMs;
  if (x.dimension === 'experiment.wallClockMs') return x.experimentId ? await experimentWallClockLimit(deps, run.runId, x.experimentId) : undefined;
  const usage = await deps.budget.usage(x.scope);
  const dim = x.dimension.startsWith('experiment.') ? x.dimension.slice('experiment.'.length) : x.dimension;
  return (usage?.limits as Record<string, number | undefined> | undefined)?.[dim];
}

/**
 * Applies the run's exhaustion policy to exhaustion `x` (idempotent per exhaustion at its current limit):
 *  - `gate` ⇒ `{ outcome: 'gate' }` (the caller converges the run to the gate);
 *  - `pause` ⇒ the run is paused (pauseReason budget, L0 `budget.exhausted` with `policyOutcome: 'paused'`); the same
 *    exhaustion seen again on a run that was resumed WITHOUT a raise ⇒ `gate` (recorded `policyOutcome: 'gate'`);
 *  - `approval` ⇒ a budget-extension approval request (kind budget, the proposed raise) and the run paused (pauseReason
 *    approval); pending ⇒ paused; rejected/expired ⇒ `gate`.
 * `raised`: the dimension's limit is above the refusal's limit now (raised meanwhile) — not exhausted any more.
 */
export async function applyExhaustionPolicy(deps: Deps, run0: TestRun, x: RunExhaustion, ctx: EventContext): Promise<ExhaustionOutcome> {
  const policy = exhaustionPolicy(run0, deps.config);
  if (policy === 'gate') return { outcome: 'gate', reason: 'policy gate' };
  const factory = new WorkFactory(deps as unknown as ControlDeps);
  return deps.db.transaction(async (tx) => {
    // serialized per run with work creation and other exhaustion decisions (one approval, one pause, one gate marker)
    await factory.lock(run0.runId, tx);
    const run = (await deps.runs.get(run0.runId)) ?? run0;
    if (isTerminalRunStatus(run.status)) return { outcome: 'gate', reason: `run ${run.status}` };
    const limitNow = await currentLimit(deps, run, x);
    if (x.limit !== undefined && limitNow !== undefined && limitNow > x.limit) return { outcome: 'raised' };
    const at: RunExhaustion = limitNow !== undefined ? { ...x, limit: limitNow } : x;
    const key = exhaustionKey(at);
    const markers = (await deps.events.read(run.runId, { types: [EVENT_TYPES.budgetExhausted] })).filter((e) => payloadOf(e)['policyKey'] === key);
    const base = { scope: at.scope, dimension: at.dimension, reason: at.reason, limit: at.limit, used: at.used, requested: at.requested, experimentId: at.experimentId, policy, policyKey: key };
    const gate = async (why: string, extra: Record<string, unknown> = {}): Promise<ExhaustionOutcome> => {
      if (!markers.some((e) => payloadOf(e)['policyOutcome'] === 'gate')) {
        await deps.events.append([event(ctx, EVENT_TYPES.budgetExhausted, 'budget', at.scope, { ...base, ...extra, policyOutcome: 'gate', detail: why })], tx);
      }
      deps.logger.warn('budget exhausted: the run converges to the gate', { runId: run.runId, dimension: at.dimension, policy, why });
      return { outcome: 'gate', reason: why };
    };
    const pause = async (pauseReason: 'budget' | 'approval'): Promise<void> => {
      if (run.status === 'running') await deps.runs.update(run.runId, { status: 'paused', pauseReason }, ctx, tx);
    };
    if (markers.some((e) => payloadOf(e)['policyOutcome'] === 'gate')) return gate('already decided: the run converges to the gate');

    if (policy === 'pause') {
      const pausedBefore = markers.some((e) => payloadOf(e)['policyOutcome'] === 'paused');
      if (pausedBefore) {
        if (run.status === 'paused') return { outcome: 'paused', pauseReason: 'budget' };
        // resumed without raising the exhausted dimension: a resume is never a way around the budget
        return gate(`the run was resumed without raising ${at.dimension} (limit ${at.limit ?? 'n/a'}): converging to the gate`);
      }
      await deps.events.append([event(ctx, EVENT_TYPES.budgetExhausted, 'budget', at.scope, { ...base, policyOutcome: 'paused' })], tx);
      await pause('budget');
      deps.logger.warn('budget exhausted: the run is PAUSED until an operator raises its budget (onExhausted pause)', { runId: run.runId, dimension: at.dimension, limit: at.limit });
      return { outcome: 'paused', pauseReason: 'budget' };
    }

    // policy === 'approval'
    const requests = (await budgetExtensionApprovals(deps, run.runId)).filter((a) => (a.subject as { policyKey?: unknown }).policyKey === key);
    const latest = requests.at(-1);
    if (latest) {
      if (latest.status === 'pending' && !approvalExpired(latest, deps.clock.nowMs())) {
        await pause('approval');
        return { outcome: 'paused', pauseReason: 'approval', approvalId: latest.approvalId };
      }
      if (latest.status === 'approved') {
        // approved but not applied yet (resolveBudgetApproval applies it): keep the run paused until it is
        if (!(await raisedBy(deps, run.runId, latest.approvalId))) {
          await pause('approval');
          return { outcome: 'paused', pauseReason: 'approval', approvalId: latest.approvalId };
        }
        return gate(`the approved extension ${latest.approvalId} was applied but ${at.dimension} is exhausted again at the same limit`, { approvalId: latest.approvalId });
      }
      return gate(`the budget extension ${latest.approvalId} was ${latest.status === 'pending' ? 'expired' : latest.status}${latest.decidedBy ? ` by ${latest.decidedBy.kind}:${latest.decidedBy.id}` : ''}`, { approvalId: latest.approvalId });
    }
    const raise = proposedRaise(run, at);
    const expiresAt = new Date(deps.clock.nowMs() + DEFAULT_BUDGET_APPROVAL_TTL_MS).toISOString();
    const subject = { source: SOURCE, policyKey: key, scope: at.scope, dimension: at.dimension, reason: at.reason, limit: at.limit ?? null, used: at.used ?? null, raise, expiresAt } as unknown as JsonValue;
    const requestedBy: ActorRef = { ...BUDGET_EXTENSION_REQUESTER };
    const approval = await deps.approvals.request({ runId: run.runId, kind: 'budget', subject, requestedBy, rationale: `run budget exhausted (${at.dimension}${at.limit !== undefined ? `, limit ${at.limit}` : ''}): extend it by ${JSON.stringify(raise)}?` }, ctx);
    await deps.events.append([event(ctx, EVENT_TYPES.budgetExhausted, 'budget', at.scope, { ...base, policyOutcome: 'approval_requested', approvalId: approval.approvalId, raise })], tx);
    await pause('approval');
    deps.logger.warn('budget exhausted: the run waits for a budget-extension approval (onExhausted approval)', { runId: run.runId, approvalId: approval.approvalId, dimension: at.dimension, raise });
    return { outcome: 'paused', pauseReason: 'approval', approvalId: approval.approvalId };
  });
}

/** Validity of a budget-extension request (its `subject.expiresAt`): undecided past it ⇒ expired ⇒ the run converges to the gate. */
export const DEFAULT_BUDGET_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

function approvalExpired(a: ApprovalRequest, nowMs: number): boolean {
  const until = (a.subject as { expiresAt?: unknown } | null)?.expiresAt;
  return typeof until === 'string' && Number.isFinite(Date.parse(until)) && Date.parse(until) <= nowMs;
}

async function raisedBy(deps: Pick<ControlDeps, 'events'>, runId: string, approvalId: string): Promise<boolean> {
  return (await deps.events.read(runId, { types: [EVENT_TYPES.budgetRaised] })).some((e) => payloadOf(e)['approvalId'] === approvalId);
}

/** The effective wall-clock limit of an experiment: its spec's plus every raise of it (undefined: none declared). */
export async function experimentWallClockLimit(deps: Pick<ControlDeps, 'events' | 'specs'>, runId: string, experimentId: string): Promise<number | undefined> {
  const spec = await deps.specs.getExperiment(experimentId);
  const base = spec?.budget?.maxWallClockMs;
  if (base === undefined) return undefined;
  let extra = 0;
  for (const e of await deps.events.read(runId, { types: [EVENT_TYPES.budgetRaised] })) {
    const r = (payloadOf(e)['raise'] as BudgetRaise | undefined)?.experiments?.[experimentId]?.maxWallClockMs;
    if (typeof r === 'number') extra += r;
  }
  return base + extra;
}

/**
 * Raises the run's budget by `raise` (amounts added to the current limits): the run's envelope, the ledger limits of the
 * run scope (and of the raised experiments) and L0 `budget.raised` `{ raise, before, after, by, rationale, approvalId? }`.
 * Idempotent per approval. Refused for a finished run, an unlimited dimension or an unknown experiment.
 */
export async function raiseRunBudget(
  deps: Pick<ControlDeps, 'db' | 'events' | 'runs' | 'budget' | 'specs' | 'logger'>,
  runId: string,
  raise: BudgetRaise,
  by: ActorRef,
  rationale: string,
  ctx: EventContext,
  approvalId?: string,
): Promise<TestRun> {
  const problems = budgetRaiseProblems(raise);
  if (problems.length > 0) throw new HypertestError('invalid_argument', `invalid budget raise: ${problems.join('; ')}`, { details: { problems } });
  if (typeof rationale !== 'string' || rationale.trim() === '') throw new HypertestError('invalid_argument', 'a budget raise needs a rationale');
  const factory = new WorkFactory(deps as unknown as ControlDeps);
  return deps.db.transaction(async (tx) => {
    await factory.lock(runId, tx);
    const run = await deps.runs.get(runId);
    if (!run) throw new HypertestError('not_found', `run ${runId} not found`);
    if (isTerminalRunStatus(run.status)) throw new HypertestError('conflict', `run ${runId} is ${run.status}: its budget can no longer be raised`, { details: { runId, status: run.status } });
    if (approvalId !== undefined && (await raisedBy(deps, runId, approvalId))) return run;
    const before: Partial<BudgetEnvelope> = {};
    const after: BudgetEnvelope = { ...run.budget };
    for (const f of RAISABLE_BUDGET_FIELDS) {
      const add = raise[f];
      if (add === undefined) continue;
      const cur = run.budget[f];
      if (cur === undefined && OPTIONAL_FIELDS.has(f)) throw new HypertestError('invalid_argument', `budget.${f} of run ${runId} is not limited: there is nothing to raise`, { details: { field: f } });
      before[f] = cur as number;
      (after as unknown as Record<string, number>)[f] = INTEGRAL_FIELDS.has(f) ? (cur ?? 0) + add : Math.round(((cur ?? 0) + add) * 1e6) / 1e6;
    }
    // the ledger limits of the run scope follow the envelope
    const usage = await deps.budget.usage(runScope(runId));
    if (usage && Object.keys(before).length > 0) {
      const limits = { ...usage.limits } as Record<string, number>;
      limits['tokens'] = after.maxModelTokens;
      limits['toolCalls'] = after.maxToolCalls;
      limits['workItems'] = after.maxWorkItems;
      if (after.maxModelCostUsd !== undefined) limits['costUsd'] = after.maxModelCostUsd;
      if (after.maxComputeMinutes !== undefined) limits['computeMs'] = Math.round(after.maxComputeMinutes * 60_000);
      if (after.maxArtifactBytes !== undefined) limits['artifactBytes'] = after.maxArtifactBytes;
      await deps.budget.open(runScope(runId), limits);
    }
    for (const [experimentId, e] of Object.entries(raise.experiments ?? {})) {
      const spec = await deps.specs.getExperiment(experimentId);
      if (!spec || spec.runId !== runId) throw new HypertestError('invalid_argument', `experiment ${experimentId} is not an experiment of run ${runId}`, { details: { experimentId } });
      if (e.maxWallClockMs !== undefined && spec.budget?.maxWallClockMs === undefined) throw new HypertestError('invalid_argument', `experiment ${experimentId} has no wall-clock budget to raise`);
      if (e.maxToolCalls !== undefined) {
        const u = await deps.budget.usage(experimentScope(experimentId));
        if (u?.limits.toolCalls === undefined) throw new HypertestError('invalid_argument', `experiment ${experimentId} has no tool-call budget to raise`);
        const limits = { ...u.limits, toolCalls: u.limits.toolCalls + e.maxToolCalls };
        try {
          await deps.budget.open(experimentScope(experimentId), limits, runScope(runId));
        } catch (err) {
          if (!isHypertestError(err, 'conflict') && !isHypertestError(err, 'not_found')) throw err;
          await deps.budget.open(experimentScope(experimentId), limits); // an experiment scope opened as a root
        }
      }
    }
    const updated = Object.keys(before).length > 0 ? await deps.runs.update(runId, { budget: after }, ctx, tx) : run;
    const afterSubset: Record<string, number> = {};
    for (const f of Object.keys(before)) afterSubset[f] = (after as unknown as Record<string, number>)[f]!;
    await deps.events.append([event(ctx, EVENT_TYPES.budgetRaised, 'budget', runScope(runId), { raise, before, after: afterSubset, by: `${by.kind}:${by.id}`, rationale, approvalId })], tx);
    deps.logger.info('run budget raised', { runId, raise, by: `${by.kind}:${by.id}`, approvalId });
    return updated;
  });
}

/**
 * Applies the decision on the run's open budget-extension request (NEEDS_APPROVAL), idempotently:
 *  - approved ⇒ the budget is raised by the approved amount (the request's `raise`) and the run resumes → `raised`;
 *  - rejected, or expired undecided ⇒ the gate marker is recorded and the run resumes to converge to the gate → `gate`;
 *  - still pending ⇒ `pending`; no open request (or the run is not paused for one) ⇒ `none`.
 */
export async function resolveBudgetApproval(deps: Deps & Pick<ControlDeps, 'specs'>, runId: string, ctx: EventContext): Promise<'raised' | 'gate' | 'pending' | 'none'> {
  const run = await deps.runs.get(runId);
  if (!run || run.status !== 'paused' || run.pauseReason !== 'approval') return 'none';
  // the run waits on its latest request (a new one is only made once the previous one was applied at another limit)
  const a = (await budgetExtensionApprovals(deps, runId)).at(-1);
  if (!a) return 'none';
  const resume = async () => {
    const cur = await deps.runs.get(runId);
    if (cur?.status === 'paused' && cur.pauseReason === 'approval') await deps.runs.update(runId, { status: 'running' }, ctx);
  };
  // already applied (a crash between the raise and the resume, or another process): finish the resume only
  if (await raisedBy(deps, runId, a.approvalId)) {
    await resume();
    return 'raised';
  }
  if ((await deps.events.read(runId, { types: [EVENT_TYPES.budgetExhausted] })).some((e) => payloadOf(e)['approvalId'] === a.approvalId && payloadOf(e)['policyOutcome'] === 'gate')) {
    await resume();
    return 'gate';
  }
  const subject = a.subject as { raise?: BudgetRaise; policyKey?: string; scope?: string; dimension?: string; limit?: number | null };
  if (a.status === 'pending') {
    if (!approvalExpired(a, deps.clock.nowMs())) return 'pending';
    if (deps.approvals.expire) await deps.approvals.expire(a.approvalId, ctx);
  }
  if (a.status === 'approved') {
    const by = a.decidedBy ?? { kind: 'system' as const, id: 'approval' };
    await raiseRunBudget(deps, runId, subject.raise ?? {}, by, `approved budget extension ${a.approvalId}${a.rationale ? `: ${a.rationale}` : ''}`, ctx, a.approvalId);
    await resume();
    deps.logger.info('budget extension approved and applied: the run resumes', { runId, approvalId: a.approvalId, raise: subject.raise });
    return 'raised';
  }
  const why = `the budget extension ${a.approvalId} was ${a.status === 'pending' || a.status === 'expired' ? 'not decided in time (expired)' : `denied${a.decidedBy ? ` by ${a.decidedBy.kind}:${a.decidedBy.id}` : ''}${a.rationale ? ` (${a.rationale})` : ''}`}`;
  await deps.events.append([
    event(ctx, EVENT_TYPES.budgetExhausted, 'budget', subject.scope ?? runScope(runId), {
      scope: subject.scope ?? runScope(runId), dimension: subject.dimension, limit: subject.limit ?? undefined, policy: 'approval', policyKey: subject.policyKey, policyOutcome: 'gate', approvalId: a.approvalId, detail: why,
    }),
  ]);
  await resume();
  deps.logger.warn('budget extension not granted: the run converges to the gate', { runId, approvalId: a.approvalId, why });
  return 'gate';
}
