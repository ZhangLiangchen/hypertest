import { HypertestError, isHypertestError, type BaseDeps, type Subscription } from '@hypertest/core';
import {
  DEFAULT_BUDGET, EVENT_TYPES, isTerminalWorkState, workItemFingerprint,
  type BudgetEnvelope, type EventContext, type GateSpec, type TestRun, type WorkItem,
} from '@hypertest/domain';
import { DEFAULT_GATE_SPEC } from '@hypertest/policy';
import { environmentResolver, experimentResolver, leaseResolver, oracleResolver, recordResolver } from '@hypertest/context';
import type { NewWorkItem } from '@hypertest/collab';
import type { ControlPlane, ConvergenceState, ExecuteTurnOptions, RunReport, StartRunInput, TickOptions, TickResult, TurnOutcome } from './contracts.ts';
import { resolveConfig, type ControlDeps, type ResolvedControlConfig } from './deps.ts';
import { environmentReadSet, targetEnvironment } from './context-provider.ts';
import { claimLeaseOwner } from './dispatcher.ts';
import { createConvergenceMonitor, type ConvergenceMonitor } from './convergence.ts';
import { createDomainTools } from './domain-tools/index.ts';
import { createReactorService, REACTOR_CONSUMER, REACTOR_SUBJECTS, type ReactorService } from './reactors.ts';
import { createReportBuilder } from './report.ts';
import { createScheduler, workLeaseKey, type Scheduler } from './scheduler.ts';
import { ControlStore } from './store.ts';
import { createAgentWorker, type AgentWorker } from './worker.ts';
import { WorkFactory, runScope, workScope } from './work-factory.ts';
import { KeyedMutex, assertRunPinned, event, gateSpecProblems, isTerminalRunStatus, mergeDefined, notFound, runCtx, systemActor, workBudgetFor } from './util.ts';

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
    if (run.status === 'paused') {
      return result(run, { convergence: { state: 'active', runnable: 0, running: 0, waiting: 0, pendingEvents: 0 }, idleMs: nextIdle(runId, false) });
    }
    if (run.status === 'converging' || run.status === 'gating') {
      // a crash between the gate transitions: evaluate again (the decision store keeps every revision)
      const g = await convergence.gate(run);
      return result(g.run, { convergence: { state: 'drained', reason: 'ready_for_gate' }, decision: g.decision, final: g.final, idleMs: 0 });
    }

    let progressed = false;
    // b exhaustion (wall clock / run budget): stop admitting; pending work is cancelled; active work finishes
    const exhausted = await convergence.exhaustion(run);
    // c reactors
    const caught = await reactors.catchUp(runId);
    if (caught.created.length > 0) progressed = true;
    let items = await blackboard.listWorkItems({ runId });
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
      return result(g.run, { convergence: state, decision: g.decision, final: g.final, idleMs: 0, replanScheduled: replan.scheduled });
    }
    if (state.state === 'exhausted' && !exhausted) state = { state: 'active', runnable: 0, running: 0, waiting: 0, pendingEvents };
    run = await mustRun(runId);
    return result(run, { dispatched, waiting, replanScheduled: replan.scheduled, convergence: state, idleMs: nextIdle(runId, progressed) });
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
      if (open.length === 0) return;
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
      const gateSpec = mergeDefined<GateSpec>(DEFAULT_GATE_SPEC, config.defaultGate, input.gate);
      // H3: never store a gate the QualityGate would misread as weaker (e.g. an unknown severity threshold disables C2)
      const gateProblems = gateSpecProblems(gateSpec);
      if (gateProblems.length > 0) throw new HypertestError('invalid_argument', `startRun: invalid gate:\n  - ${gateProblems.join('\n  - ')}`, { details: { errors: gateProblems } });
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
      const limits: { tokens: number; toolCalls: number; workItems: number; costUsd?: number } = {
        tokens: budgetEnvelope.maxModelTokens,
        toolCalls: budgetEnvelope.maxToolCalls,
        workItems: budgetEnvelope.maxWorkItems,
      };
      if (budgetEnvelope.maxModelCostUsd !== undefined) limits.costUsd = budgetEnvelope.maxModelCostUsd;
      const started = await db.transaction(async (tx) => {
        await factory.lock(runId, tx); // lock order: work creation lock before any event append of the run
        await store.putManifest(config.runtimeManifest, now, tx);
        await runs.create(run, ctx, tx);
        await store.putGate(runId, gateSpec, tx);
        await budget.open(runScope(runId), limits);
        await events.append([event(ctx, 'budget.reserved', 'budget', runScope(runId), { scope: runScope(runId), limits })], tx);
        const running = await runs.update(runId, { status: 'running' }, ctx, tx);
        const r = await factory.create(leadItem, ctx, tx);
        if (r.status === 'capped') throw new HypertestError('invalid_argument', 'startRun: maxWorkItems must allow at least the lead work item');
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
      //   process is gone): released, so the retried turn is not refused by its own leak
      for (const { workItemId } of superseded) {
        const freed = (await budget.releaseOpen?.(workScope(workItemId))) ?? [];
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
      const run = await mustRun(runId);
      if (run.status !== 'paused') return;
      await runs.update(runId, { status: 'running' }, runCtx(runId, config.workerId));
      idle.delete(runId);
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

