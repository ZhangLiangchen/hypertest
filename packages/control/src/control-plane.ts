import { HypertestError, isHypertestError, type BaseDeps, type Subscription } from '@hypertest/core';
import {
  DEFAULT_BUDGET, isTerminalWorkState, workItemFingerprint,
  type BudgetEnvelope, type EventContext, type GateSpec, type TestRun, type WorkItem,
} from '@hypertest/domain';
import { DEFAULT_GATE_SPEC } from '@hypertest/policy';
import { environmentResolver, experimentResolver, leaseResolver, oracleResolver, recordResolver } from '@hypertest/context';
import type { NewWorkItem } from '@hypertest/collab';
import type { ControlPlane, ConvergenceState, ExecuteTurnOptions, RunReport, StartRunInput, TickResult, TurnOutcome } from './contracts.ts';
import { resolveConfig, type ControlDeps, type ResolvedControlConfig } from './deps.ts';
import { createConvergenceMonitor, type ConvergenceMonitor } from './convergence.ts';
import { createDomainTools } from './domain-tools/index.ts';
import { createReactorService, REACTOR_CONSUMER, REACTOR_SUBJECTS, type ReactorService } from './reactors.ts';
import { createReportBuilder } from './report.ts';
import { createScheduler, workLeaseKey, type Scheduler } from './scheduler.ts';
import { ControlStore } from './store.ts';
import { createAgentWorker, type AgentWorker } from './worker.ts';
import { WorkFactory, runScope } from './work-factory.ts';
import { KeyedMutex, event, isTerminalRunStatus, mergeDefined, notFound, runCtx, systemActor, workBudgetFor } from './util.ts';

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
}

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
  if (!r.get('environment')) r.register(environmentResolver((id) => deps.environments.get(id)));
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

  async function finalResult(run: TestRun): Promise<TickResult> {
    const decision = run.decisionId ? await decisions.get(run.decisionId) : undefined;
    const partial: Partial<TickResult> & { convergence: ConvergenceState; idleMs: number } = { convergence: { state: 'drained', reason: 'ready_for_gate' }, final: true, idleMs: 0 };
    if (decision) partial.decision = decision;
    return result(run, partial);
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

  async function doTick(runId: string): Promise<TickResult> {
    await ensureSubscribed();
    let run = await mustRun(runId);
    if (isTerminalRunStatus(run.status)) return finalResult(run);
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
      dispatched = await scheduler.admit(run, items);
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
      const g = await convergence.gate(run);
      idle.delete(runId);
      return result(g.run, { convergence: state, decision: g.decision, final: g.final, idleMs: 0, replanScheduled: replan.scheduled });
    }
    if (state.state === 'exhausted' && !exhausted) state = { state: 'active', runnable: 0, running: 0, waiting: 0, pendingEvents };
    run = await mustRun(runId);
    return result(run, { dispatched, waiting, replanScheduled: replan.scheduled, convergence: state, idleMs: nextIdle(runId, progressed) });
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

    tick(runId) {
      return tickMutex.run(runId, () => doTick(runId));
    },

    executeTurn(workItemId, fencingToken, signal, options) {
      return worker.executeTurn(workItemId, fencingToken, signal, options);
    },

    observeWaiting(workItemId, signal) {
      return worker.observeWaiting(workItemId, signal);
    },

    async recover(runId, signal) {
      const run = await mustRun(runId);
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
      for (const w of await blackboard.listWorkItems({ runId, states: ['claimed', 'running', 'waiting'] })) {
        const live = await leases.current(workLeaseKey(w.workItemId));
        const leasedHere = !!w.claim && !!live && live.owner === config.workerId && live.fencingToken === w.claim.fencingToken && w.claim.ownerId === config.workerId;
        if (leasedHere && (w.state === 'waiting' || issued.has(claimKey(w.workItemId, w.claim!.fencingToken)))) continue;
        const wctx = { ...ctx, workItemId: w.workItemId, correlationId: w.workItemId };
        try {
          if (w.state === 'waiting') {
            // its operations were reconciled above; re-take its claim under this worker (new fencing token)
            const l = await leases.acquire({ resourceKey: workLeaseKey(w.workItemId), owner: config.workerId, ttlMs: config.leaseTtlMs });
            if (l) {
              await blackboard.transitionWorkItem(w.workItemId, 'waiting', { claim: { ownerId: config.workerId, leaseId: l.leaseId, fencingToken: l.fencingToken, expiresAt: l.expiresAt } }, wctx, { expectedFrom: ['waiting'] });
              issued.add(claimKey(w.workItemId, l.fencingToken));
            }
            continue;
          }
          const to = await scheduler.requeue(w, ctx, `orphaned by ${w.claim?.ownerId ?? 'an unknown worker'} (recovered by ${config.workerId})`);
          if (live && live.owner === config.workerId) await leases.release(live.leaseId);
          if (to === 'ready') requeued.push(w.workItemId);
        } catch (e) {
          if (!isHypertestError(e, 'conflict') && !isHypertestError(e, 'stale_fence')) throw e;
        }
      }
      logger.info('run recovered', { runId, examined: report.examined, verified: report.verified.length, notApplied: report.notApplied.length, manualReview: report.manualReview.length, compensated, requeued: requeued.length });
      return { reconciled: report.examined + compensated, requeued };
    },

    async cancelRun(runId, reason) {
      const run = await mustRun(runId);
      if (run.status === 'completed' || run.status === 'failed') return;
      const ctx = runCtx(runId, config.workerId);
      // 1 the run first: ticks, reactions and executeTurn stop acting on it (a concurrent tick can no longer admit or
      //   create work behind the sweep below)
      if (run.status !== 'cancelled') await runs.update(runId, { status: 'cancelled' }, ctx);
      // 2 every agent still active/waiting — children of already settled parents included (the cascade from a root
      //   interrupts its subtree; interrupted agents are skipped)
      for (const a of await agents.list({ runId, status: ['active', 'waiting'] })) {
        const cur = await agents.get(a.agentId);
        if (!cur || (cur.status !== 'active' && cur.status !== 'waiting')) continue;
        await subagents.interrupt(a.agentId, reason, ctx).catch((e: unknown) => logger.warn('interrupt failed', { agentId: a.agentId, error: (e as Error).message }));
      }
      // 3 sweep the open work (idempotent: a retried cancelRun of a cancelled run completes an interrupted sweep)
      for (const w of await blackboard.listWorkItems({ runId })) {
        if (isTerminalWorkState(w.state)) continue;
        try {
          await blackboard.transitionWorkItem(w.workItemId, 'cancelled', { failure: { reason: 'cancelled', message: reason } }, { ...ctx, workItemId: w.workItemId, correlationId: w.workItemId }, { expectedFrom: [w.state] });
          await scheduler.release(w);
        } catch (e) {
          if (!isHypertestError(e, 'conflict')) throw e;
        }
      }
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
      await mustRun(runId);
      return deps.snapshotBuilder.build({ runId }, runCtx(runId, config.workerId));
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

