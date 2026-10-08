import { HypertestError, isHypertestError, type BaseDeps, type Subscription } from '@hypertest/core';
import {
  DEFAULT_BUDGET, EVENT_TYPES, isTerminalWorkState, workItemFingerprint,
  type BudgetEnvelope, type EventContext, type GateSpec, type TestRun, type WorkItem,
} from '@hypertest/domain';
import { DEFAULT_GATE_SPEC, gateOverrides } from '@hypertest/policy';
import { environmentResolver, experimentResolver, leaseResolver, oracleResolver, recordResolver } from '@hypertest/context';
import type { NewWorkItem } from '@hypertest/collab';
import type { ControlPlane, ConvergenceState, ExecuteTurnOptions, RunReport, StartRunInput, TickOptions, TickResult, TurnOutcome } from './contracts.ts';
import { resolveConfig, type ControlDeps, type ResolvedControlConfig } from './deps.ts';
import { environmentReadSet, targetEnvironment } from './context-provider.ts';
import { claimLeaseOwner } from './dispatcher.ts';
import { createConvergenceMonitor, type ConvergenceMonitor } from './convergence.ts';
import { createDomainTools } from './domain-tools/index.ts';
import type { ModelSwitchRequest } from '@hypertest/runtime';
import { releaseStrandedReservations } from './isolation.ts';
import { resolveManualReview } from '@hypertest/operation';
import { BUDGET_EXHAUSTION_POLICIES, applyExhaustionPolicy, budgetExtensionApprovals, budgetRaiseProblems, exhaustionPolicy, raiseRunBudget, resolveBudgetApproval, type BudgetRaise } from './budget-exhaustion.ts';
import { createReactorService, REACTOR_CONSUMER, REACTOR_SUBJECTS, type ReactorService } from './reactors.ts';
import { createReportBuilder } from './report.ts';
import { createScheduler, workLeaseKey, type Scheduler } from './scheduler.ts';
import { ControlStore, type GateAuthority } from './store.ts';
import { createAgentWorker, type AgentWorker } from './worker.ts';
import { WorkFactory, runScope, workScope } from './work-factory.ts';
import {
  GATE_AUTHORITY_KINDS, KeyedMutex, assertRunPinned, event, gateSpecProblems, gateWeakenings, isTerminalRunStatus, mergeDefined, notFound, runCtx, systemActor, workBudgetFor,
} from './util.ts';

const IDLE_BASE_MS = 100;
const IDLE_MAX_MS = 5000;

/** The assembled control plane (the ControlPlane facade plus its parts, for tests and the durable runtimes). */
export interface ControlPlaneInternals extends ControlPlane {
  readonly config: ResolvedControlConfig;
  readonly scheduler: Scheduler;
  readonly reactors: ReactorService;
  readonly convergence: ConvergenceMonitor;
  readonly worker: AgentWorker;
  executeTurn(workItemId: string, fencingToken: number, signal?: AbortSignal, options?: ExecuteTurnOptions): Promise<TurnOutcome>;
  /** Unsubscribes the reactors from the bus (when one is configured). */
  close(): Promise<void>;
  /** (durability-11) Sizes of the per-process bookkeeping (claims issued by this process, idle counters). */
  bookkeeping(): { issuedClaims: number; idleRuns: number };
}

/** Turn outcomes after which the claim that ran the turn is gone (terminal item, requeued, yielded or lost). */
const CLAIM_ENDED: ReadonlySet<TurnOutcome['status']> = new Set(['completed', 'failed', 'cancelled', 'paused', 'lease_lost']);

function leadObjective(input: StartRunInput): string {
  const t = input.target;
  const target = [
    t.repoPath ? `repository ${t.repoPath}` : '',
    t.commit ? `commit under test ${t.commit}` : '',
    t.baseCommit ? `base commit ${t.baseCommit}` : '',
    t.sutUrl ? `system under test at ${t.sutUrl}` : '',
    t.environmentId ? `environment ${t.environmentId}` : '',
  ].filter(Boolean);
  return [
    `Testing goal: ${input.goal}`,
    `Target: ${target.length ? target.join('; ') : 'not specified'}${t.description ? ` — ${t.description}` : ''}`,
    'Analyse the goal and the target (cheap repository survey, oracles in force), derive testable objectives with acceptance criteria, and propose Plan v1 with plan.propose_revision: typed work items for the other roles, their dependencies, evidence requirements and budgets. Do not execute tests yourself. Finish with complete_work.',
  ].join('\n');
}

/**
 * (conformance-9) The authority record of a run's gate. A weakening override (`weakened` non-empty) needs
 * `gateOverrideBy` — a human or system actor, never an agent (nor a call made in an agent's name) — and a rationale.
 * An authority given without a weakening is validated and recorded all the same.
 */
function overrideAuthority(input: StartRunInput, ctxIn: Partial<EventContext> | undefined, weakened: string[], baseGate: GateSpec): GateAuthority {
  const by = input.gateOverrideBy;
  const rationale = input.gateOverrideRationale;
  const agentCall = ctxIn?.agentId !== undefined;
  if (by !== undefined) {
    if (!by || typeof by !== 'object' || typeof by.kind !== 'string' || typeof by.id !== 'string' || by.id.trim() === '') {
      throw new HypertestError('invalid_argument', 'startRun: gateOverrideBy must be an actor { kind, id } with a non-empty id');
    }
    if (by.kind === 'agent' || agentCall) {
      throw new HypertestError('permission_denied', `startRun: a gate override is never authorized by an agent (${by.kind === 'agent' ? `gateOverrideBy is agent ${by.id}` : `the call is made by agent ${ctxIn!.agentId}`}); a human or system authority must record it`, {
        details: { weakened, gateOverrideBy: by.kind },
      });
    }
    if (!GATE_AUTHORITY_KINDS.has(by.kind)) throw new HypertestError('invalid_argument', `startRun: gateOverrideBy.kind must be human or system (got ${JSON.stringify(by.kind)})`);
    if (typeof rationale !== 'string' || rationale.trim() === '') throw new HypertestError('invalid_argument', 'startRun: gateOverrideRationale is required with gateOverrideBy');
  } else if (rationale !== undefined) {
    throw new HypertestError('invalid_argument', 'startRun: gateOverrideRationale without gateOverrideBy (name the human/system authority)');
  }
  if (weakened.length > 0 && by === undefined) {
    throw new HypertestError(
      'invalid_argument',
      `startRun: the gate override weakens the run's gate and needs a recorded human/system authority (gateOverrideBy + gateOverrideRationale):\n  - ${weakened.join('\n  - ')}`,
      { details: { weakened } },
    );
  }
  if (weakened.length > 0 && agentCall) {
    throw new HypertestError('permission_denied', `startRun: a gate override is never authorized by an agent (the call is made by agent ${ctxIn!.agentId})`, { details: { weakened } });
  }
  const out: GateAuthority = { baseGate, weakened };
  if (by !== undefined) {
    out.by = { ...by };
    out.rationale = rationale!;
  }
  return out;
}

/**
 * createControlPlane: wires the Lead + Dynamic Scheduler (control plane) and the Blackboard reactors
 * (collaboration plane), convergence, the gate and the report around already-constructed services.
 */
export function createControlPlane(deps: ControlDeps): ControlPlaneInternals {
  const config = resolveConfig(deps.config);
  if (!config.capabilitySecret) throw new HypertestError('invalid_argument', 'config.capabilitySecret is required');
  if (!config.workerId) throw new HypertestError('invalid_argument', 'config.workerId is required');
  if (!config.runtimeManifest?.manifestId) throw new HypertestError('invalid_argument', 'config.runtimeManifest must be a RuntimeManifest');
  const { db, runs, blackboard, specs, budget, leases, subagents, agents, reconciler, ledger, gateway, decisions, events, ids, clock, logger } = deps;
  const store = new ControlStore(db);
  const factory = new WorkFactory(deps);
  const scheduler = createScheduler(deps, config);
  const reactors = createReactorService(deps);
  const convergence = createConvergenceMonitor(deps, config);
  const reportBuilder = createReportBuilder(deps);
  const tickMutex = new KeyedMutex();
  const idle = new Map<string, number>();
  /** Claims handed out by THIS instance: after a process restart none are known, so orphaned claims are requeued. */
  const issued = new Set<string>();
  const claimKey = (workItemId: string, token: number) => `${workItemId}:${token}`;
  const worker = createAgentWorker(deps, config, { onClaim: (workItemId, token) => issued.add(claimKey(workItemId, token)) });
  const actor = systemActor(config.workerId);

  // Domain tools join the shared tool registry (idempotent: an app may have registered them already).
  for (const spec of createDomainTools(deps)) if (!deps.registry.get(spec.id)) deps.registry.register(spec);
  // FreshnessGuard resolvers for everything a snapshot pins (mutating tools fail closed with no_resolver otherwise).
  const r = deps.resolvers;
  if (!r.get('experiment')) r.register(experimentResolver((id) => specs.getExperiment(id)));
  // the authoritative generation: `load` reads the store shared by every worker when the registry has one (H12)
  if (!r.get('environment')) r.register(environmentResolver((id) => (deps.environments.load ? deps.environments.load(id) : deps.environments.get(id))));
  if (!r.get('oracle')) r.register(oracleResolver((id) => specs.getOracle(id)));
  if (!r.get('record')) r.register(recordResolver((lineage) => blackboard.head(lineage)));
  if (!r.get('finding')) r.register(recordResolver((lineage) => blackboard.head(lineage), { resourceType: 'finding' }));
  if (!r.get('lease')) r.register(leaseResolver((key) => leases.current(key)));

  let subscription: Promise<Subscription | undefined> | undefined;
  function ensureSubscribed(): Promise<Subscription | undefined> {
    if (!deps.bus) return Promise.resolve(undefined);
    subscription ??= deps.bus.subscribe({ durableName: REACTOR_CONSUMER, subjects: REACTOR_SUBJECTS, handler: (e) => reactors.handleDelivered(e) }).catch((e: unknown) => {
      subscription = undefined;
      logger.error('reactors could not subscribe to the event bus; relying on catch-up', { error: (e as Error).message });
      return undefined;
    });
    return subscription;
  }

  async function mustRun(runId: string): Promise<TestRun> {
    const run = await runs.get(runId);
    if (!run) throw notFound('run', runId);
    return run;
  }

  function nextIdle(runId: string, progressed: boolean): number {
    if (progressed) {
      idle.delete(runId);
      return 0;
    }
    const n = (idle.get(runId) ?? 0) + 1;
    idle.set(runId, n);
    return Math.min(IDLE_MAX_MS, IDLE_BASE_MS * 2 ** Math.min(n - 1, 10));
  }

  function result(run: TestRun, partial: Partial<TickResult> & { convergence: ConvergenceState; idleMs: number }): TickResult {
    const out: TickResult = {
      runId: run.runId,
      status: run.status,
      dispatched: partial.dispatched ?? [],
      waiting: partial.waiting ?? [],
      replanScheduled: partial.replanScheduled ?? false,
      convergence: partial.convergence,
      final: partial.final ?? false,
      idleMs: partial.idleMs,
    };
    if (partial.decision) out.decision = partial.decision;
    return out;
  }

  /** durability-11: forget the per-process bookkeeping of a claim that ended (or of every claim of an item). */
  function forgetClaims(workItemId: string, token?: number): void {
    if (token !== undefined) {
      issued.delete(claimKey(workItemId, token));
      return;
    }
    for (const k of issued) if (k.startsWith(`${workItemId}:`)) issued.delete(k);
  }

  async function finalResult(run: TestRun): Promise<TickResult> {
    // durability-11: an ended run keeps no per-process bookkeeping (long-lived serve/worker processes)
    idle.delete(run.runId);
    // conformance-5/6: nor claims or reservations (idempotent; covers a crash between the gate and the release)
    await scheduler.releaseRun?.(run.runId);
    // item 11: nor model pauses
    await closeModelPauses(run.runId, `run_${run.status}`);
    if (issued.size > 0) for (const w of await blackboard.listWorkItems({ runId: run.runId })) forgetClaims(w.workItemId);
    const decision = run.decisionId ? await decisions.get(run.decisionId) : undefined;
    const partial: Partial<TickResult> & { convergence: ConvergenceState; idleMs: number } = { convergence: { state: 'drained', reason: 'ready_for_gate' }, final: true, idleMs: 0 };
    if (decision) partial.decision = decision;
    return result(run, partial);
  }

  /**
   * (H4) Releases the live side-effect leases that superseded claims still hold on their items' unsettled operations
   * (owner `<ownerId>:<workItemId>:<token>`, or the item's agent id for operations recorded before claim-scoped owners).
   * Returns how many were released.
   */
  async function releaseSupersededEffectLeases(runId: string, superseded: Array<{ workItemId: string; claim: NonNullable<WorkItem['claim']> }>): Promise<number> {
    let released = 0;
    for (const { workItemId, claim } of superseded) {
      const owners = new Set([claimLeaseOwner(claim.ownerId, workItemId, claim.fencingToken)]);
      const agent = await agents.byWorkItem(workItemId);
      if (agent) owners.add(agent.agentId);
      for (const op of await ledger.listUnsettled(runId)) {
        if (op.workItemId !== workItemId || !op.lease) continue;
        const live = await leases.current(op.lease.resourceKey);
        if (!live || live.leaseId !== op.lease.leaseId || !owners.has(live.owner)) continue;
        await leases.release(live.leaseId);
        released++;
        logger.info('released the side-effect lease of a superseded claim', { runId, workItemId, operationId: op.operationId, resourceKey: live.resourceKey, owner: live.owner });
      }
    }
    return released;
  }

  async function cancelPending(run: TestRun, states: WorkItem['state'][], message: string): Promise<string[]> {
    const ctx = runCtx(run.runId, config.workerId);
    const out: string[] = [];
    for (const w of await blackboard.listWorkItems({ runId: run.runId, states })) {
      try {
        await blackboard.transitionWorkItem(w.workItemId, 'cancelled', { failure: { reason: 'cancelled', message } }, { ...ctx, workItemId: w.workItemId, correlationId: w.workItemId }, { expectedFrom: [w.state] });
        out.push(w.workItemId);
      } catch (e) {
        if (!isHypertestError(e, 'conflict')) throw e;
      }
    }
    return out;
  }

  /**
   * (A[0]) Releases the run's model pauses now (operator resume): each paused agent resumes at its next observation and
   * its next turn routes again (L0 `model.pauses_released`). Returns the released sessions.
   */
  async function releaseModelPauses(runId: string, by: string): Promise<string[]> {
    await mustRun(runId);
    if (!deps.epochs.releaseModelPauses) return [];
    const routes = [...new Set((deps.epochs.listModelPauses ? await deps.epochs.listModelPauses(runId) : []).flatMap((p) => p.routes))].sort();
    const released = await deps.epochs.releaseModelPauses(runId, clock.isoNow());
    if (released.length > 0) {
      // the open circuits of the paused routes may probe now (one call each; the breaker's verdict still decides)
      const probed = routes.length > 0 ? (deps.router.probeNow?.(routes) ?? []) : [];
      await events.append([event(runCtx(runId, config.workerId), EVENT_TYPES.modelPausesReleased, 'run', runId, { sessions: released, by, routes, probedCircuits: probed })]);
      idle.delete(runId);
      logger.info('model pauses released', { runId, sessions: released.length, by, probedCircuits: probed });
    }
    return released;
  }

  /**
   * (item 11) An ended run (cancelled, or decided) keeps no model pause: its agents will never route again, so their
   * pauses are closed (rows removed; L0 `model.pauses_released` with `closed: true`). `hypertest status` of the run then
   * shows no model-paused agent. Idempotent (nothing left ⇒ nothing recorded).
   */
  async function closeModelPauses(runId: string, by: string): Promise<string[]> {
    const { listModelPauses, clearModelPause } = deps.epochs;
    if (!listModelPauses || !clearModelPause) return [];
    const pauses = await listModelPauses.call(deps.epochs, runId);
    if (pauses.length === 0) return [];
    for (const p of pauses) await clearModelPause.call(deps.epochs, p.sessionId);
    const sessions = pauses.map((p) => p.sessionId).sort();
    const routes = [...new Set(pauses.flatMap((p) => p.routes))].sort();
    await events.append([event(runCtx(runId, config.workerId), EVENT_TYPES.modelPausesReleased, 'run', runId, { sessions, by, routes, probedCircuits: [], closed: true })]);
    logger.info('model pauses closed: the run ended', { runId, sessions: sessions.length, by });
    return sessions;
  }

  async function doTick(runId: string, options: TickOptions = {}): Promise<TickResult> {
    await ensureSubscribed();
    let run = await mustRun(runId);
    if (isTerminalRunStatus(run.status)) return finalResult(run);
    assertRunPinned(run, config.runtimeManifest.manifestId); // I11 in the control plane itself (H2), whatever the composer
    const lease = await scheduler.acquireRunLease(runId);
    if (!lease) {
      return result(run, { convergence: { state: 'active', runnable: 0, running: 0, waiting: 0, pendingEvents: 0 }, idleMs: nextIdle(runId, false) });
    }
    if (run.status === 'created') run = await runs.update(runId, { status: 'running' }, runCtx(runId, config.workerId));
    if (run.status === 'paused' && run.pauseReason === 'approval') {
      // E[3] NEEDS_APPROVAL: a decided budget-extension request is applied (approved ⇒ raised + resumed; rejected or
      // expired ⇒ resumed to converge to the gate) — idempotent, also applied by the approve() path itself
      const resolved = await resolveBudgetApproval(deps, runId, runCtx(runId, config.workerId));
      if (resolved === 'raised' || resolved === 'gate') run = await mustRun(runId);
    }
    if (run.status === 'paused') {
      return result(run, { convergence: { state: 'active', runnable: 0, running: 0, waiting: 0, pendingEvents: 0 }, idleMs: nextIdle(runId, false) });
    }
    if (run.status === 'converging' || run.status === 'gating') {
      // a crash between the gate transitions: evaluate again (the decision store keeps every revision)
      const g = await convergence.gate(run);
      return result(g.run, { convergence: { state: 'drained', reason: 'ready_for_gate' }, ...(g.decision ? { decision: g.decision } : {}), final: g.final, idleMs: g.abandoned ? nextIdle(runId, false) : 0 });
    }

    let progressed = false;
    // b exhaustion (wall clock / run budget): the run's policy decides (E[3]) — `gate`: stop admitting, pending work is
    //   cancelled, active work finishes, the gate decides; `pause` / `approval`: the run pauses (for a raise / for a
    //   budget-extension approval) and nothing is cancelled
    let exhausted = await convergence.exhaustion(run);
    if (exhaustionPolicy(run, config) !== 'gate') {
      const detail = await convergence.exhaustionDetail?.(run, { caps: true });
      if (detail) {
        const applied = await applyExhaustionPolicy(deps, run, detail, runCtx(runId, config.workerId));
        if (applied.outcome === 'paused') {
          run = await mustRun(runId);
          return result(run, { convergence: { state: 'active', runnable: 0, running: 0, waiting: 0, pendingEvents: 0 }, idleMs: nextIdle(runId, true) });
        }
        if (applied.outcome === 'gate') exhausted = detail.kind;
      }
    }
    // c reactors
    const caught = await reactors.catchUp(runId);
    if (caught.created.length > 0) progressed = true;
    let items = await blackboard.listWorkItems({ runId });
    // c2 continuable delegations whose parent work item ended are released (they complete with their last result)
    if ((await releaseOrphanedChildren(runId, items)).length > 0) progressed = true;
    // d unblock
    const unblocked = await scheduler.unblock(runId, items);
    // e lease expiry
    const requeued = await scheduler.expireLeases(runId, items);
    if (unblocked.readied.length + unblocked.failed.length + requeued.length > 0) {
      progressed = true;
      items = await blackboard.listWorkItems({ runId });
    }
    if (exhausted) {
      const cancelled = await cancelPending(run, ['ready', 'blocked', 'proposed'], `run ${exhausted === 'wall_clock' ? 'wall clock' : 'budget'} exhausted`);
      if (cancelled.length > 0) {
        progressed = true;
        await events.append([event(runCtx(runId, config.workerId), 'budget.exhausted', 'budget', runScope(runId), { scope: runScope(runId), reason: exhausted, cancelledWorkItems: cancelled })]);
        items = await blackboard.listWorkItems({ runId });
      }
    }
    // f replan triggers
    let replan: Awaited<ReturnType<ConvergenceMonitor['maybeReplan']>> = { scheduled: false };
    if (!exhausted) {
      replan = await convergence.maybeReplan(run, items);
      if (replan.scheduled) {
        progressed = true;
        items = await blackboard.listWorkItems({ runId });
      }
    }
    // f2 isolation upkeep (conformance-5/6): experiment claims follow their owners; ended load jobs free their QPS
    const isolation = await scheduler.syncIsolation?.(run, items);
    if (isolation && isolation.released.length + isolation.qpsReleased.length > 0) progressed = true;
    // g admission
    let dispatched: TickResult['dispatched'] = [];
    if (!exhausted) {
      dispatched = await scheduler.admit(run, items, options.maxDispatch);
      for (const d of dispatched) issued.add(claimKey(d.workItemId, d.fencingToken));
      if (dispatched.length > 0) {
        progressed = true;
        items = await blackboard.listWorkItems({ runId });
      }
    }
    // h convergence
    const pendingEvents = await reactors.pending(runId);
    let state = await convergence.evaluate(run, items, exhausted ? { pendingEvents, exhausted, replan } : { pendingEvents, replan });
    if (state.state === 'stalled' && state.reason === 'blocked_dependencies') {
      await cancelPending(run, ['blocked', 'proposed'], 'dependencies can no longer complete');
      items = await blackboard.listWorkItems({ runId });
    }
    const waiting = items.filter((w) => w.state === 'waiting').map((w) => ({ workItemId: w.workItemId, operationIds: w.waitingOn }));
    if (convergence.gateReady(state, items, pendingEvents)) {
      // H7: an independent run-level review the gate requires is requested first (its reviewer reacts on the next tick)
      if (!exhausted && (await convergence.requestRunReview(run))) {
        run = await mustRun(runId);
        return result(run, { dispatched, waiting, replanScheduled: replan.scheduled, convergence: { state: 'active', runnable: 0, running: 0, waiting: 0, pendingEvents: pendingEvents + 1 }, idleMs: nextIdle(runId, true) });
      }
      const g = await convergence.gate(run);
      idle.delete(runId);
      if (g.final) {
        await scheduler.releaseRun?.(runId);
        await closeModelPauses(runId, `run_${g.run.status}`);
      }
      return result(g.run, { convergence: state, ...(g.decision ? { decision: g.decision } : {}), final: g.final, idleMs: g.abandoned ? nextIdle(runId, false) : 0, replanScheduled: replan.scheduled });
    }
    if (state.state === 'exhausted' && !exhausted) state = { state: 'active', runnable: 0, running: 0, waiting: 0, pendingEvents };
    run = await mustRun(runId);
    return result(run, { dispatched, waiting, replanScheduled: replan.scheduled, convergence: state, idleMs: nextIdle(runId, progressed) });
  }

  /**
   * Auto-release (subagent runtime): a continuable child waits for more input only while its parent works; once the
   * parent's work item ended (completed, failed, cancelled — or is gone) the child is released and completes with its
   * last task result at its next observation. Returns the released child ids.
   */
  async function releaseOrphanedChildren(runId: string, items: WorkItem[]): Promise<string[]> {
    const byId = new Map(items.map((w) => [w.workItemId, w]));
    const released: string[] = [];
    for (const d of await store.delegations(runId)) {
      if (!d.continuable || d.releasedAt !== undefined) continue;
      const child = byId.get(d.childWorkItemId);
      if (!child || isTerminalWorkState(child.state)) continue;
      const parent = byId.get(d.parentWorkItemId);
      if (parent && !isTerminalWorkState(parent.state)) continue;
      const reason = parent ? `parent work item ${parent.workItemId} ${parent.state}` : `parent work item ${d.parentWorkItemId} is gone`;
      const ctx = { ...runCtx(runId, config.workerId), workItemId: d.childWorkItemId, correlationId: d.childWorkItemId };
      const changed = await db.transaction(async (tx) => {
        const ok = await store.releaseDelegation(d.childWorkItemId, reason, clock.isoNow(), tx);
        if (ok) await events.append([event(ctx, 'delegation.released', 'work_item', d.childWorkItemId, { childWorkItemId: d.childWorkItemId, parentWorkItemId: d.parentWorkItemId, reason, auto: true })], tx);
        return ok;
      });
      if (changed) {
        released.push(d.childWorkItemId);
        logger.info('continuable delegation auto-released: its parent ended', { runId, childWorkItemId: d.childWorkItemId, parentWorkItemId: d.parentWorkItemId, reason });
      }
    }
    return released;
  }

  async function cancelRunLocked(runId: string, reason: string): Promise<void> {
    const run = await mustRun(runId);
    if (run.status === 'completed' || run.status === 'failed') return;
    const ctx = runCtx(runId, config.workerId);
    // 1 the run first, under the run's work-creation lock (durability-8): a creation in flight elsewhere commits before
    //   the status changes and is swept below; every later creation sees the cancelled run and is refused
    //   (WorkFactory.create). Ticks, reactions and executeTurn stop acting on it.
    if (run.status !== 'cancelled') {
      await db.transaction(async (tx) => {
        await factory.lock(runId, tx);
        await runs.update(runId, { status: 'cancelled' }, ctx);
      });
    }
    // 2 every agent still active/waiting — children of already settled parents included (the cascade from a root
    //   interrupts its subtree; interrupted agents are skipped)
    for (const a of await agents.list({ runId, status: ['active', 'waiting'] })) {
      const cur = await agents.get(a.agentId);
      if (!cur || (cur.status !== 'active' && cur.status !== 'waiting')) continue;
      await subagents.interrupt(a.agentId, reason, ctx).catch((e: unknown) => logger.warn('interrupt failed', { agentId: a.agentId, error: (e as Error).message }));
    }
    // 3 sweep the open work until none is left (idempotent: a retried cancelRun of a cancelled run completes an
    //   interrupted sweep). An item another process moved meanwhile (ready → claimed by a tick that read the run before
    //   the cancel) is re-read and cancelled in its new state — never skipped on a conflict (durability-8).
    for (let pass = 0; pass < 10; pass++) {
      const open = (await blackboard.listWorkItems({ runId })).filter((w) => !isTerminalWorkState(w.state));
      if (open.length === 0) {
        // conformance-5/6: a cancelled run holds no experiment claims or budget reservations; item 11: nor model pauses
        await scheduler.releaseRun?.(runId);
        await closeModelPauses(runId, 'run_cancelled');
        return;
      }
      for (const w of open) {
        try {
          await blackboard.transitionWorkItem(w.workItemId, 'cancelled', { failure: { reason: 'cancelled', message: reason } }, { ...ctx, workItemId: w.workItemId, correlationId: w.workItemId }, { expectedFrom: [w.state] });
          await scheduler.release(w);
        } catch (e) {
          if (!isHypertestError(e, 'conflict')) throw e;
        }
      }
    }
    logger.warn('cancelRun: work items still open after repeated sweeps', { runId });
  }

  const plane: ControlPlaneInternals = {
    deps: { ids, clock, logger } as BaseDeps,
    config,
    scheduler,
    reactors,
    convergence,
    worker,

    async startRun(input: StartRunInput, ctxIn?: Partial<EventContext>): Promise<TestRun> {
      if (!input || typeof input.goal !== 'string' || input.goal.trim() === '') throw new HypertestError('invalid_argument', 'startRun: goal is required');
      if (!input.target || typeof input.target !== 'object') throw new HypertestError('invalid_argument', 'startRun: target is required');
      await ensureSubscribed();
      const runId = input.runId ?? ids.next('run');
      const oracleRevisions: Record<string, number> = {};
      for (const oracleId of input.oracleIds ?? []) {
        const o = await specs.getOracle(oracleId);
        if (!o) throw new HypertestError('invalid_argument', `startRun: unknown oracle ${oracleId}`, { details: { oracleId } });
        oracleRevisions[oracleId] = o.revision;
      }
      const budgetEnvelope = mergeDefined<BudgetEnvelope>(DEFAULT_BUDGET, config.defaultBudget, input.budget);
      // I12 caps must be meaningful: a zero/negative/non-integer cap would stall the run until its wall clock
      for (const k of ['maxWallClockMs', 'maxAgentConcurrency', 'maxModelTokens', 'maxToolCalls', 'maxWorkItems', 'maxPlanRevisions', 'maxAgentDepth'] as const) {
        const v = budgetEnvelope[k];
        const min = k === 'maxAgentDepth' ? 0 : 1;
        if (!Number.isSafeInteger(v) || v < min) throw new HypertestError('invalid_argument', `startRun: budget.${k} must be an integer ≥ ${min} (got ${String(v)})`, { details: { field: k } });
      }
      for (const k of ['maxModelCostUsd', 'maxComputeMinutes', 'maxExternalQps', 'maxArtifactBytes'] as const) {
        const v = budgetEnvelope[k];
        if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw new HypertestError('invalid_argument', `startRun: budget.${k} must be a finite number ≥ 0 (got ${String(v)})`, { details: { field: k } });
      }
      // E[3] the run's exhaustion policy (configuration budget.onExhausted ⊕ the run's own override)
      if (budgetEnvelope.onExhausted !== undefined && !BUDGET_EXHAUSTION_POLICIES.includes(budgetEnvelope.onExhausted)) {
        throw new HypertestError('invalid_argument', `startRun: budget.onExhausted must be one of ${BUDGET_EXHAUSTION_POLICIES.join(', ')} (got ${JSON.stringify(budgetEnvelope.onExhausted)})`, { details: { field: 'onExhausted' } });
      }
      const baseGate = mergeDefined<GateSpec>(DEFAULT_GATE_SPEC, config.defaultGate);
      const gateSpec = mergeDefined<GateSpec>(baseGate, input.gate);
      // H3: never store a gate the QualityGate would misread as weaker (e.g. an unknown severity threshold disables C2)
      const gateProblems = gateSpecProblems(gateSpec);
      if (gateProblems.length > 0) throw new HypertestError('invalid_argument', `startRun: invalid gate:\n  - ${gateProblems.join('\n  - ')}`, { details: { errors: gateProblems } });
      // conformance-9: a run-level override that weakens the gate needs a recorded human/system authority
      // (an unusable configured base is never a reason to skip the check: the default gate is the reference then)
      const reference = gateSpecProblems(baseGate).length === 0 ? baseGate : DEFAULT_GATE_SPEC;
      const gateAuthority = overrideAuthority(input, ctxIn, gateWeakenings(reference, gateSpec), reference);
      const now = clock.isoNow();
      const ctx: EventContext = { runId, correlationId: ctxIn?.correlationId ?? runId, actorId: ctxIn?.actorId ?? actor };
      if (ctxIn?.causationId !== undefined) ctx.causationId = ctxIn.causationId;
      const run: TestRun = {
        runId,
        goal: input.goal,
        target: input.target,
        status: 'created',
        budget: budgetEnvelope,
        runtimeManifestId: config.runtimeManifest.manifestId,
        policyRevision: deps.policy.revision,
        protocolBinding: { protocolId: deps.protocol.binding.protocolId, version: deps.protocol.binding.version, digest: deps.protocol.binding.digest },
        currentPlanRevision: 0,
        oracleRevisions,
        experimentIds: [],
        labels: input.labels ?? {},
        createdAt: now,
        updatedAt: now,
      };
      const existing = await runs.get(runId);
      if (existing) {
        if (existing.goal !== run.goal) throw new HypertestError('conflict', `run ${runId} already exists`, { details: { runId } });
        assertRunPinned(existing, config.runtimeManifest.manifestId); // (H2) never hand a live run of another runtime to a driver
        return existing; // idempotent retry of a durable startRun
      }
      const lead = deps.roles.require('lead');
      const objective = leadObjective(input);
      const leadItem: NewWorkItem = {
        runId,
        kind: 'initial_plan',
        origin: { kind: 'system', reason: 'initial_plan' },
        title: 'Plan v1: analyse the goal and propose the first plan',
        objective,
        role: 'lead',
        objectiveIds: [],
        capabilityRequirements: [],
        inputRefs: [],
        evidenceRequirements: [],
        dependsOn: [],
        budget: workBudgetFor(lead),
        priority: 100,
        depth: 0,
        fingerprint: workItemFingerprint({ runId, role: 'lead', objective, originKey: 'initial_plan' }),
        resourceClaims: [],
        state: 'ready',
      };
      if (lead.outputSchema !== undefined) leadItem.expectedOutput = lead.outputSchema;
      const limits: { tokens: number; toolCalls: number; workItems: number; costUsd?: number; computeMs?: number; artifactBytes?: number; externalQps?: number } = {
        tokens: budgetEnvelope.maxModelTokens,
        toolCalls: budgetEnvelope.maxToolCalls,
        workItems: budgetEnvelope.maxWorkItems,
      };
      if (budgetEnvelope.maxModelCostUsd !== undefined) limits.costUsd = budgetEnvelope.maxModelCostUsd;
      // conformance-5: sandbox compute, stored artifact bytes and concurrent external QPS are budget dimensions of the run
      if (budgetEnvelope.maxComputeMinutes !== undefined) limits.computeMs = Math.round(budgetEnvelope.maxComputeMinutes * 60_000);
      if (budgetEnvelope.maxArtifactBytes !== undefined) limits.artifactBytes = budgetEnvelope.maxArtifactBytes;
      if (budgetEnvelope.maxExternalQps !== undefined) limits.externalQps = budgetEnvelope.maxExternalQps;
      const started = await db.transaction(async (tx) => {
        await factory.lock(runId, tx); // lock order: work creation lock before any event append of the run
        await store.putManifest(config.runtimeManifest, now, tx);
        await runs.create(run, ctx, tx);
        await store.putGate(runId, gateSpec, tx, gateAuthority);
        await budget.open(runScope(runId), limits);
        await events.append([event(ctx, 'budget.reserved', 'budget', runScope(runId), { scope: runScope(runId), limits })], tx);
        const running = await runs.update(runId, { status: 'running' }, ctx, tx);
        const r = await factory.create(leadItem, ctx, tx);
        if (r.status === 'capped') throw new HypertestError('invalid_argument', 'startRun: maxWorkItems must allow at least the lead work item');
        // conformance-9: the recorded authority of the run's gate override is on L0 with the run's creation
        if (gateAuthority.by) {
          await events.append(
            [
              event(ctx, 'gate.override_authorized', 'run', runId, {
                gateId: gateSpec.gateId, weakened: gateAuthority.weakened, overrides: gateOverrides(gateSpec), by: gateAuthority.by, rationale: gateAuthority.rationale,
              }),
            ],
            tx,
          );
        }
        return running;
      });
      logger.info('run started', { runId, goal: input.goal, manifest: run.runtimeManifestId });
      return started;
    },

    tick(runId, options) {
      return tickMutex.run(runId, () => doTick(runId, options));
    },

    async executeTurn(workItemId, fencingToken, signal, options) {
      const out = await worker.executeTurn(workItemId, fencingToken, signal, options);
      if (CLAIM_ENDED.has(out.status)) forgetClaims(workItemId, fencingToken);
      return out;
    },

    async observeWaiting(workItemId, signal) {
      const out = await worker.observeWaiting(workItemId, signal);
      // a paused waiting item keeps its claim (its operations still run): only a settled item forgets it
      if (out.status !== 'paused' && CLAIM_ENDED.has(out.status)) forgetClaims(workItemId);
      return out;
    },

    bookkeeping() {
      return { issuedClaims: issued.size, idleRuns: idle.size };
    },

    renewClaim(workItemId, fencingToken) {
      return worker.renewClaim(workItemId, fencingToken);
    },

    async recover(runId, signal) {
      const run = await mustRun(runId);
      assertRunPinned(run, config.runtimeManifest.manifestId); // (H2) a live run of another manifest is not ours to recover
      const sig = signal ?? new AbortController().signal;
      const ctx = runCtx(runId, config.workerId);
      // 1 settle the external world first: nothing is re-dispatched before its unknown outcome is reconciled (I4)
      const report = await reconciler.reconcile({ runId }, sig);
      let compensated = 0;
      for (const op of await ledger.list({ runId, status: ['compensating'] })) {
        try {
          await gateway.compensate(op.operationId, ctx, sig);
          compensated++;
        } catch (e) {
          // one stuck compensation (adapter down) must not block the recovery of the run's work: it stays
          // `compensating` in the ledger (visible, retried by the next recover)
          if (sig.aborted) throw e;
          logger.error('interrupted compensation could not be resumed', { runId, operationId: op.operationId, error: (e as Error).message });
        }
      }
      if (isTerminalRunStatus(run.status)) return { reconciled: report.examined + compensated, requeued: [] };
      // 2 the run lease: only a free or expired lease can be taken over
      const lease = await scheduler.acquireRunLease(runId);
      if (!lease) {
        const holder = await leases.current(`run/${runId}`);
        throw new HypertestError('unavailable', `run ${runId} is owned by live worker ${holder?.owner ?? 'unknown'} until ${holder?.expiresAt ?? '?'}`, { retryable: true, details: { runId, owner: holder?.owner } });
      }
      // 3 orphaned work: requeue claimed/running items not leased by this worker (or leased by a previous process of
      //   this worker: nobody holds their fencing token any more); waiting items keep waiting under a fresh claim
      const requeued: string[] = [];
      // (audit) what this pass recovered: re-run items and waiting items re-attached to their operations (run.recovered)
      const requeuedAudit: Array<Record<string, unknown>> = [];
      const reattached: Array<Record<string, unknown>> = [];
      /** Claims this pass took away from their (dead) previous holders: their side-effect leases are released below. */
      const superseded: Array<{ workItemId: string; claim: NonNullable<WorkItem['claim']> }> = [];
      for (const w of await blackboard.listWorkItems({ runId, states: ['claimed', 'running', 'waiting'] })) {
        const live = await leases.current(workLeaseKey(w.workItemId));
        const leasedHere = !!w.claim && !!live && live.owner === config.workerId && live.fencingToken === w.claim.fencingToken && w.claim.ownerId === config.workerId;
        if (leasedHere && w.state === 'waiting') {
          // a waiting item this worker id still leases: this process continues it under the same claim — re-attached when
          // the claim was issued by an earlier process (a restart of the same worker)
          const key = claimKey(w.workItemId, w.claim!.fencingToken);
          if (!issued.has(key)) {
            issued.add(key);
            reattached.push({ workItemId: w.workItemId, role: w.role, waitingOn: w.waitingOn ?? [], fencingToken: w.claim!.fencingToken, claim: 'kept' });
          }
          continue;
        }
        if (leasedHere && issued.has(claimKey(w.workItemId, w.claim!.fencingToken))) continue;
        const wctx = { ...ctx, workItemId: w.workItemId, correlationId: w.workItemId };
        try {
          if (w.state === 'waiting') {
            // its operations were reconciled above; re-take its claim under this worker (new fencing token)
            const l = await leases.acquire({ resourceKey: workLeaseKey(w.workItemId), owner: config.workerId, ttlMs: config.leaseTtlMs });
            if (l) {
              await blackboard.transitionWorkItem(w.workItemId, 'waiting', { claim: { ownerId: config.workerId, leaseId: l.leaseId, fencingToken: l.fencingToken, expiresAt: l.expiresAt } }, wctx, { expectedFrom: ['waiting'] });
              issued.add(claimKey(w.workItemId, l.fencingToken));
              reattached.push({ workItemId: w.workItemId, role: w.role, waitingOn: w.waitingOn ?? [], fencingToken: l.fencingToken, claim: 'retaken' });
              if (w.claim) superseded.push({ workItemId: w.workItemId, claim: w.claim });
            }
            continue;
          }
          if (w.claim) superseded.push({ workItemId: w.workItemId, claim: w.claim });
          const to = await scheduler.requeue(w, ctx, `orphaned by ${w.claim?.ownerId ?? 'an unknown worker'} (recovered by ${config.workerId})`);
          if (live && live.owner === config.workerId) await leases.release(live.leaseId);
          if (to === 'ready') requeued.push(w.workItemId);
          requeuedAudit.push({ workItemId: w.workItemId, role: w.role, from: w.state, attempts: w.attempts + 1, to });
        } catch (e) {
          if (!isHypertestError(e, 'conflict') && !isHypertestError(e, 'stale_fence')) throw e;
        }
      }
      // 4 (H4) side-effect leases are owned by the CLAIM a call ran under: the claims taken away above belonged to dead
      //   holders, so their still-live leases on unsettled operations are released and those operations reconciled now —
      //   the item's next claim then finds them settled (or re-attaches) instead of refused as busy until the TTL
      // durability-1: the budget reservations of the superseded claims' in-flight model calls will never settle (their
      //   process is gone): released, so the retried turn is not refused by its own leak — except the QPS reservations
      //   of load jobs they started (conformance-5): the external job outlives its worker and keeps its rate reserved
      for (const { workItemId } of superseded) {
        const freed = await releaseStrandedReservations(deps, workScope(workItemId));
        if (freed.length > 0) logger.info('released the budget reservations of a superseded claim', { runId, workItemId, reservations: freed });
      }
      const released = await releaseSupersededEffectLeases(runId, superseded);
      if (released > 0) {
        const again = await reconciler.reconcile({ runId }, sig);
        report.verified.push(...again.verified.filter((id) => !report.verified.includes(id)));
        report.notApplied.push(...again.notApplied.filter((id) => !report.notApplied.includes(id)));
        report.manualReview.push(...again.manualReview.filter((id) => !report.manualReview.includes(id)));
        report.stillPending = report.stillPending.filter((id) => !again.verified.includes(id) && !again.notApplied.includes(id) && !again.manualReview.includes(id));
      }
      if (report.examined + compensated > 0 || requeuedAudit.length > 0 || reattached.length > 0) {
        const operations = {
          examined: report.examined, verified: report.verified, notApplied: report.notApplied, manualReview: report.manualReview, stillPending: report.stillPending, compensated,
        };
        await events.append([event(ctx, EVENT_TYPES.runRecovered, 'run', runId, { workerId: config.workerId, operations, requeued: requeuedAudit, reattached })]);
      }
      logger.info('run recovered', { runId, examined: report.examined, verified: report.verified.length, notApplied: report.notApplied.length, manualReview: report.manualReview.length, compensated, requeued: requeued.length, reattached: reattached.length });
      return { reconciled: report.examined + compensated, requeued };
    },

    async cancelRun(runId, reason) {
      // durability-8: serialized with this process's ticks of the run (a tick that read the run before the cancel can
      // no longer admit or replan behind the sweep); other processes are stopped by the work-creation lock below
      return tickMutex.run(runId, () => cancelRunLocked(runId, reason));
    },

    async pauseRun(runId, reason) {
      const run = await mustRun(runId);
      if (run.status === 'paused') return;
      const patch: Partial<TestRun> = { status: 'paused' };
      if (reason !== undefined) patch.pauseReason = reason;
      await runs.update(runId, patch, runCtx(runId, config.workerId));
    },

    async resumeRun(runId) {
      let run = await mustRun(runId);
      if (run.status === 'paused' && run.pauseReason === 'approval') {
        // E[3]: a run waiting for a budget-extension decision resumes through that decision, never around it
        const resolved = await resolveBudgetApproval(deps, runId, runCtx(runId, config.workerId));
        if (resolved === 'pending') {
          const open = (await budgetExtensionApprovals(deps, runId)).filter((a) => a.status === 'pending').map((a) => a.approvalId);
          throw new HypertestError('precondition_failed', `run ${runId} waits for the budget-extension approval ${open.join(', ') || '(pending)'}: decide it first (hypertest approve|reject)`, { details: { runId, approvals: open } });
        }
        run = await mustRun(runId);
      }
      // an operator resume also lets agents paused for model unavailability try their routes again (A[0])
      await releaseModelPauses(runId, 'operator:resume');
      if (run.status !== 'paused') return;
      await runs.update(runId, { status: 'running' }, runCtx(runId, config.workerId));
      idle.delete(runId);
    },

    async raiseBudget(runId, raise, by, rationale) {
      const problems = budgetRaiseProblems(raise);
      if (problems.length > 0) throw new HypertestError('invalid_argument', `invalid budget raise: ${problems.join('; ')}`, { details: { problems } });
      const actor = { kind: 'human' as const, id: by };
      const ctx = { ...runCtx(runId, config.workerId), actorId: `human:${by}` };
      const raised = await raiseRunBudget(deps, runId, raise as BudgetRaise, actor, rationale, ctx);
      idle.delete(runId);
      return raised;
    },

    resolveBudgetApproval(runId) {
      return resolveBudgetApproval(deps, runId, runCtx(runId, config.workerId));
    },

    async resolveOperation(operationId, outcome, by, note) {
      const op = await deps.ledger.get(operationId);
      if (!op) throw new HypertestError('not_found', `operation ${operationId} not found`);
      const ctx = { ...runCtx(op.runId, config.workerId), actorId: `human:${by}`, correlationId: operationId, ...(op.workItemId ? { workItemId: op.workItemId } : {}) };
      const resolved = await resolveManualReview({ db, ledger: deps.ledger, events, leases: deps.leases }, operationId, { outcome, by: { kind: 'human', id: by }, note }, ctx);
      idle.delete(op.runId);
      logger.info('operation resolved by manual review', { runId: op.runId, operationId, outcome, by });
      return resolved;
    },

    releaseModelPauses(runId, by) {
      return releaseModelPauses(runId, by ?? 'operator');
    },

    async requestModelSwitch(runId, target, routeId, requestedBy, reason) {
      const run = await mustRun(runId);
      if (isTerminalRunStatus(run.status)) throw new HypertestError('conflict', `run ${runId} is ${run.status}: no model switch applies`, { details: { runId, status: run.status } });
      if (!deps.epochs.requestSwitch) throw new HypertestError('unsupported', 'the EpochManager cannot record model switch requests');
      if (typeof routeId !== 'string' || routeId === '') throw new HypertestError('invalid_argument', 'routeId must be a non-empty string');
      if (deps.catalog && !deps.catalog.get(routeId)) {
        throw new HypertestError('invalid_argument', `route ${routeId} is not in the model catalog (${deps.catalog.list().map((p) => p.routeId).join(', ')})`, { details: { routeId } });
      }
      if (typeof requestedBy !== 'string' || requestedBy.trim() === '') throw new HypertestError('invalid_argument', 'requestedBy must name who asks for the switch');
      const agent = await agents.get(target);
      let switchTarget: ModelSwitchRequest['target'];
      if (agent) {
        if (agent.runId !== runId) throw new HypertestError('invalid_argument', `agent ${target} belongs to run ${agent.runId}, not ${runId}`);
        switchTarget = { kind: 'agent', agentId: target };
      } else if (deps.roles.get(target)) switchTarget = { kind: 'role', role: target };
      else throw new HypertestError('invalid_argument', `${target} is neither an agent of run ${runId} nor a role`, { details: { target } });
      const request: Parameters<NonNullable<typeof deps.epochs.requestSwitch>>[0] = { runId, target: switchTarget, routeId, requestedBy };
      if (reason !== undefined && reason !== '') request.reason = reason;
      const out = await deps.epochs.requestSwitch(request, runCtx(runId, requestedBy));
      idle.delete(runId);
      logger.info('manual model switch requested; applied at the target agents\' next safe turn boundary', { runId, target: switchTarget, routeId, switchId: out.switchId });
      return out;
    },

    async snapshot(runId) {
      const run = await mustRun(runId);
      // the run's world as of now: its oracles, its target environment and every registered environment (authoritative
      // generations: the shared store when the registry has one — H12, conformance-3)
      const input: Parameters<typeof deps.snapshotBuilder.build>[0] = { runId };
      const target = await targetEnvironment(deps, run);
      if (target) input.environment = target;
      const readSet = await environmentReadSet(deps, run, clock.isoNow());
      if (readSet.length > 0) input.readSet = readSet;
      return deps.snapshotBuilder.build(input, runCtx(runId, config.workerId));
    },

    report(runId): Promise<RunReport> {
      return reportBuilder.build(runId);
    },

    async close() {
      const sub = await subscription;
      subscription = undefined;
      if (sub) await sub.unsubscribe();
    },
  };
  return plane;
}

