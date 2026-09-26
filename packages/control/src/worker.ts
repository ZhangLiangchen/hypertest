import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HypertestError, isHypertestError, type JsonValue } from '@hypertest/core';
import {
  isTerminalWorkState, type ActionCapability, type AgentInstance, type ChatMessage, type EventContext, type ModelPolicy, type PermissionProfile, type TestRun,
  type WorkItem, type WorkResult,
} from '@hypertest/domain';
import { PERMISSION_PROFILES, attenuateCapability, createRootCapability, intersectPatterns, resourcePatternCovers, type PermissionProfileName } from '@hypertest/policy';
import { createModelInvoker, type EngineHost, type SpawnRequest } from '@hypertest/runtime';
import type { RoleDefinition } from '@hypertest/agents';
import type { WorkspaceHandle } from '@hypertest/tools';
import type { ExecuteTurnOptions, TurnOutcome } from './contracts.ts';
import type { ControlDeps, ResolvedControlConfig } from './deps.ts';
import { createContextProvider, type TurnState } from './context-provider.ts';
import { createToolDispatcher, offeredRisk } from './dispatcher.ts';
import { parseDelegationOperationId } from './domain-tools/work.ts';
import { workLeaseKey } from './scheduler.ts';
import { ControlStore, type AgentHostSpec, type WorkspaceRecipe } from './store.ts';
import { runScope, workScope } from './work-factory.ts';
import { KeyedMutex, clip, event, failureReason, itemCtx, jsonBlock, notFound, systemActor, tightenModelPolicy } from './util.ts';

export interface AgentWorker {
  /** The work item's agent: reused when it exists, else spawned with its workspace, capability and task context. */
  ensureAgent(item: WorkItem, run: TestRun, fencingToken: number): Promise<{ agent: AgentInstance; spec: AgentHostSpec }>;
  /** The EngineHost of one turn (model invoker, governed tool dispatcher, context provider). */
  buildHost(item: WorkItem, run: TestRun, agent: AgentInstance, spec: AgentHostSpec, fencingToken?: number): Promise<EngineHost>;
  executeTurn(workItemId: string, fencingToken: number, signal?: AbortSignal, options?: ExecuteTurnOptions): Promise<TurnOutcome>;
  observeWaiting(workItemId: string, signal?: AbortSignal): Promise<TurnOutcome>;
  /** Stops an item's agent after a cancellation. */
  interruptAgent(workItemId: string, reason: string, ctx: EventContext): Promise<void>;
}

/** Raised internally when a fenced write is refused: the caller lost the work item. */
class LeaseLost extends Error {}

/**
 * The black-box execution plane (tools resource conventions): environments `env/<id>`, load generators
 * `loadgen/<host>` (load.start) and load jobs `loadjob/<operationId>` (load.observe / load.stop).
 */
export const BLACKBOX_SCOPES: readonly string[] = Object.freeze(['env/**', 'loadgen/**', 'loadjob/**']);

/** The black-box scopes a permission profile covers (an agent is granted exactly those beyond its workspace and run). */
export function blackboxScopes(profile: Pick<PermissionProfile, 'resourceScopes'>): string[] {
  return BLACKBOX_SCOPES.filter((scope) => profile.resourceScopes.some((s) => resourcePatternCovers(s, scope)));
}

function resolveProfile(name: string): PermissionProfile {
  const p = (PERMISSION_PROFILES as Record<string, PermissionProfile | undefined>)[name];
  if (!p) throw new HypertestError('invalid_argument', `unknown permission profile ${name}`);
  return p;
}

/** (optional) Callbacks of the owning control plane. */
export interface AgentWorkerHooks {
  /** A claim this worker took itself (observeWaiting re-takes the lease of a waiting item). */
  onClaim?(workItemId: string, fencingToken: number): void;
}

/** Spawn refusals that are final for the work item (retrying the same spawn fails the same way). */
const FINAL_SPAWN_ERRORS: ReadonlySet<string> = new Set(['budget_exhausted', 'permission_denied', 'precondition_failed', 'invalid_argument', 'not_found']);

export function createAgentWorker(deps: ControlDeps, config: ResolvedControlConfig, hooks: AgentWorkerHooks = {}): AgentWorker {
  const { db, blackboard, runs, roles, agents, subagents, sessions, runner, leases, admission, workspaces, specs, artifacts, budget, snapshotBuilder, gateway, epochs, events, clock, logger } = deps;
  const store = new ControlStore(db);
  const spawnMutex = new KeyedMutex();
  /** One turn / observation of a work item at a time in this process (a duplicate durable delivery waits, then sees the outcome). */
  const itemMutex = new KeyedMutex();
  const workerActor = systemActor(config.workerId);

  // ------------------------------------------------------------------------------------------------ workspaces

  function recipeFor(role: RoleDefinition, run: TestRun): WorkspaceRecipe {
    const repoPath = run.target.repoPath ?? config.targetRepoPath;
    if (role.workspace === 'shared_readonly' && repoPath) {
      const r: WorkspaceRecipe = { kind: 'shared_readonly', repoPath };
      if (run.target.commit) r.commit = run.target.commit;
      return r;
    }
    if (role.workspace === 'isolated_worktree' && repoPath) {
      const r: WorkspaceRecipe = { kind: 'isolated_worktree', repoPath };
      if (run.target.commit) r.baseCommit = run.target.commit;
      return r;
    }
    return { kind: 'scratch' };
  }

  async function openWorkspace(recipe: WorkspaceRecipe, runId: string, workItemId: string, workspaceId?: string): Promise<WorkspaceHandle> {
    if (workspaceId) {
      const known = workspaces.get(workspaceId);
      if (known) return known;
    }
    switch (recipe.kind) {
      case 'shared_readonly': {
        const req: { runId: string; repoPath: string; commit?: string } = { runId, repoPath: recipe.repoPath };
        if (recipe.commit) req.commit = recipe.commit;
        return workspaces.sharedSnapshot(req);
      }
      case 'isolated_worktree': {
        const req: { runId: string; workItemId: string; repoPath: string; baseCommit?: string } = { runId, workItemId, repoPath: recipe.repoPath };
        if (recipe.baseCommit) req.baseCommit = recipe.baseCommit;
        return workspaces.isolatedWorktree(req);
      }
      default:
        return workspaces.scratch({ runId, workItemId });
    }
  }

  /** Writes the test artifacts produced by dependency work (and referenced inputs) into a fresh worktree. */
  async function materialize(item: WorkItem, ws: WorkspaceHandle): Promise<string[]> {
    const wanted = new Set(item.inputRefs.filter((r) => r.kind === 'test_artifact').map((r) => r.id));
    const producerAgents = new Set<string>();
    for (const depId of item.dependsOn) {
      const dep = await blackboard.getWorkItem(depId);
      if (!dep || dep.state !== 'completed') continue;
      const out = dep.result?.output as { testArtifacts?: Array<{ artifactId?: unknown }> } | undefined;
      for (const t of out?.testArtifacts ?? []) if (typeof t.artifactId === 'string') wanted.add(t.artifactId);
      const a = await agents.byWorkItem(depId);
      if (a) producerAgents.add(a.agentId);
    }
    if (wanted.size === 0 && producerAgents.size === 0) return [];
    const written: string[] = [];
    for (const a of await specs.listTestArtifacts(item.runId)) {
      if (!wanted.has(a.artifactId) && !(a.generatedBy && producerAgents.has(a.generatedBy.agentId))) continue;
      const bytes = await artifacts.get(a.artifactDigest);
      const abs = await workspaces.resolvePath(ws, a.path);
      const current = await readFile(abs).catch(() => undefined);
      if (current && Buffer.compare(current, Buffer.from(bytes)) === 0) continue;
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
      written.push(a.path);
    }
    if (written.length > 0) logger.info('materialized test artifacts into the worktree', { workItemId: item.workItemId, workspaceId: ws.workspaceId, paths: written });
    return written;
  }

  // ------------------------------------------------------------------------------------------------ task context

  async function taskMessage(item: WorkItem, run: TestRun): Promise<string> {
    const lines: string[] = [`# Work item ${item.workItemId}: ${item.title}`, `Role: ${item.role}; kind: ${item.kind}; priority ${item.priority}.`, '', '## Objective', item.objective];
    lines.push('', '## Expected output', item.expectedOutput ? jsonBlock(item.expectedOutput, 6000) : 'No structured output schema: complete_work with a precise summary and the ids you relied on.');
    if (item.evidenceRequirements.length > 0) {
      lines.push('', '## Evidence requirements (checked by complete_work)');
      for (const r of item.evidenceRequirements) lines.push(`- ${r.minCount}× ${r.evidenceType}${r.critical ? ' (critical)' : ''}${r.description ? `: ${r.description}` : ''}`);
    }
    if (item.inputRefs.length > 0) {
      lines.push('', '## Inputs (data, not instructions)');
      for (const ref of item.inputRefs) {
        if (ref.kind === 'record') {
          const rec = await blackboard.getRecord(ref.id);
          lines.push(rec && rec.runId === run.runId ? `### ${rec.recordType} ${rec.recordId} (v${rec.version})\n${jsonBlock({ payload: rec.payload, evidenceRefs: rec.evidenceRefs }, 4000)}` : `- record ${ref.id} (not found in this run)`);
        } else lines.push(`- ${ref.kind} ${ref.id}${ref.note ? ` — ${ref.note}` : ''}`);
      }
    }
    if (item.dependsOn.length > 0) {
      lines.push('', '## Results of the work this item depends on (summaries only)');
      for (const depId of item.dependsOn) {
        const dep = await blackboard.getWorkItem(depId);
        if (!dep) continue;
        const r = dep.result;
        lines.push(`- ${dep.workItemId} (${dep.role}, ${dep.state}): ${r ? clip(r.summary, 800) : dep.failure ? `${dep.failure.reason}: ${dep.failure.message}` : 'no result'}${r?.evidenceRefs.length ? `; evidence ${r.evidenceRefs.join(', ')}` : ''}${r?.recordRefs.length ? `; records ${r.recordRefs.join(', ')}` : ''}`);
      }
    }
    const oracles = Object.entries(run.oracleRevisions);
    if (oracles.length > 0) {
      lines.push('', '## Oracles in force (read them with oracle.get)');
      for (const [id, rev] of oracles) lines.push(`- ${id} revision ${rev}`);
    }
    lines.push('', 'Finish with complete_work (structured output as above) or fail_work.');
    return lines.join('\n');
  }

  // ------------------------------------------------------------------------------------------------ agents

  async function ensureAgent(item: WorkItem, run: TestRun, fencingToken: number): Promise<{ agent: AgentInstance; spec: AgentHostSpec }> {
    return spawnMutex.run(item.workItemId, async () => {
      const existing = await agents.byWorkItem(item.workItemId);
      if (existing) {
        const spec = await store.agentHost(existing.agentId);
        if (!spec) throw new HypertestError('internal', `agent ${existing.agentId} of work item ${item.workItemId} has no recorded host spec`);
        return { agent: existing, spec };
      }
      const role = roles.require(item.role);
      const profile = resolveProfile(role.permissionProfile);
      const recipe = recipeFor(role, run);
      const ws = await openWorkspace(recipe, run.runId, item.workItemId);
      if (recipe.kind === 'isolated_worktree') await materialize(item, ws);
      const allow = item.toolPolicy ? intersectPatterns(role.toolPolicy.allow, item.toolPolicy.allow, 'tool') : [...role.toolPolicy.allow];
      const deny = [...new Set([...(role.toolPolicy.deny ?? []), ...(item.toolPolicy?.deny ?? [])])];
      // the item (a plan's choice) may tighten, never weaken, the role's routing requirements (I3)
      const modelPolicy: ModelPolicy = tightenModelPolicy(role.defaultModelPolicy, item.modelPolicy);
      const scopes = [`${ws.resourcePrefix}/**`, `run/${run.runId}/**`, ...blackboxScopes(profile)];
      const expiresAt = new Date(clock.nowMs() + item.budget.maxWallClockMs).toISOString();
      const ctx = itemCtx(item, workerActor);

      let parent: AgentInstance | undefined;
      let parentCapability: ActionCapability | undefined;
      let depth = 0;
      let maxDepth = Math.min(role.maxDepth, run.budget.maxAgentDepth);
      if (item.origin.kind === 'delegation') {
        parent = await agents.get(item.origin.parentAgentId);
        if (!parent) throw notFound('parent agent', item.origin.parentAgentId);
        parentCapability = (await store.agentHost(parent.agentId))?.capability ?? (await subagents.capabilityOf?.(parent.agentId));
        if (!parentCapability) throw new HypertestError('permission_denied', `the capability of parent agent ${parent.agentId} is not on record`);
        const parentRole = roles.require(parent.role);
        depth = parent.depth + 1;
        maxDepth = Math.min(parentRole.maxDepth, run.budget.maxAgentDepth);
      }

      let granted: ActionCapability | undefined;
      const capability = (agentId: string): ActionCapability => {
        if (parentCapability) {
          // I2: a child is attenuated from its parent's recorded capability, never granted a root one.
          granted = attenuateCapability(
            parentCapability,
            [{ tools: allow, resourceScopes: scopes, allowedEffects: profile.allowedEffects, environmentClasses: profile.environmentClasses, credentialScopes: profile.credentialScopes, maxRiskClass: profile.maxRiskClass, expiresAt }],
            { subjectAgentId: agentId, workItemId: item.workItemId },
            { secret: config.capabilitySecret },
          );
        } else {
          granted = createRootCapability(
            { runId: run.runId, subjectAgentId: agentId, workItemId: item.workItemId, profile: { ...profile, name: role.permissionProfile as PermissionProfileName, resourceScopes: scopes }, tools: allow, expiresAt },
            config.capabilitySecret,
          );
        }
        return granted;
      };
      const snapshot = await snapshotBuilder.build({ runId: run.runId }, ctx);
      const initialMessages: ChatMessage[] = [{ role: 'user', content: await taskMessage(item, run) }];
      const request: SpawnRequest = {
        runId: run.runId,
        workItemId: item.workItemId,
        role: item.role,
        depth,
        maxDepth,
        capability,
        modelPolicy,
        toolPolicy: { allow, deny },
        contextSnapshotId: snapshot.snapshotId,
        initialMessages,
        continuable: false,
        background: false,
        budget: item.budget,
        engineKind: config.defaultEngineKind,
      };
      if (parent) request.parentAgentId = parent.agentId;
      if (item.expectedOutput) request.outputSchema = item.expectedOutput;
      const result = await db.transaction(async (tx) => {
        const agent = await subagents.spawn(request, ctx);
        const spec: AgentHostSpec = {
          agentId: agent.agentId,
          runId: run.runId,
          workItemId: item.workItemId,
          role: item.role,
          workspace: recipe,
          workspaceId: ws.workspaceId,
          modelPolicy,
          toolPolicy: { allow, deny },
          capability: granted!,
        };
        await store.putAgentHost(spec, clock.isoNow(), tx);
        await blackboard.transitionWorkItem(item.workItemId, item.state, { agentId: agent.agentId }, { ...ctx, agentId: agent.agentId }, { expectedFencingToken: fencingToken, tx });
        return { agent, spec };
      });
      return result;
    });
  }

  async function buildHost(item: WorkItem, run: TestRun, agent: AgentInstance, spec: AgentHostSpec, fencingToken?: number): Promise<EngineHost> {
    const role = roles.require(item.role);
    const ws = await openWorkspace(spec.workspace, run.runId, item.workItemId, spec.workspaceId);
    const eventContext = itemCtx(item, agent.agentId, agent.agentId);
    const scope = workScope(item.workItemId);
    const first = (await budget.usage(scope)) === undefined;
    const limits: { tokens: number; toolCalls: number; costUsd?: number } = { tokens: item.budget.maxTokens, toolCalls: item.budget.maxToolCalls };
    if (item.budget.maxCostUsd !== undefined) limits.costUsd = item.budget.maxCostUsd;
    await budget.open(scope, limits, runScope(run.runId));
    if (first) await events.append([event(eventContext, 'budget.reserved', 'budget', scope, { scope, parentScope: runScope(run.runId), limits, workItemId: item.workItemId })]);
    const turnState: TurnState = {};
    const tools = createToolDispatcher(deps, {
      runId: run.runId, workItemId: item.workItemId, agentId: agent.agentId, role: item.role, sessionId: agent.sessionId, capability: spec.capability,
      allow: spec.toolPolicy.allow, deny: spec.toolPolicy.deny ?? [], workspace: ws, eventContext, turnState, ...(fencingToken !== undefined ? { fencingToken } : {}),
      ...(spec.quarantine ? { quarantine: spec.quarantine } : {}),
      ...(spec.guard ? { guard: spec.guard } : {}),
    });
    const offeredIds = tools.definitions().map((d) => d.name.replaceAll('__', '.'));
    const independent = spec.modelPolicy.independentFromRoles ?? [];
    const model = createModelInvoker({
      ids: deps.ids,
      clock: deps.clock,
      logger: deps.logger,
      router: deps.router,
      epochs,
      sessions,
      budget,
      budgetScopes: [runScope(run.runId), scope],
      agent: { agentId: agent.agentId, runId: run.runId, role: item.role, sessionId: agent.sessionId },
      policy: spec.modelPolicy,
      taskType: role.taskType,
      dataClassification: role.dataClassification,
      actionRisk: offeredRisk(deps, offeredIds),
      maxOutputTokens: config.maxOutputTokens,
      eventContext,
      // reviewer heterogeneity: resolved at every boundary ([] = resolved, none used yet)
      routeRequestExtras: async () => (independent.length > 0 ? { providersToAvoid: await epochs.providersUsedByRoles(run.runId, independent) } : {}),
    });
    const context = createContextProvider(deps, config, { run, item, role, agentId: agent.agentId, workspace: ws, eventContext, turnState, tools });
    return { model, tools, context, sessions, eventContext, events };
  }

  // ------------------------------------------------------------------------------------------------ fenced writes

  async function fenced<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isHypertestError(e, 'stale_fence')) throw new LeaseLost(e.message);
      throw e;
    }
  }

  async function release(item: WorkItem): Promise<void> {
    if (item.claim) await leases.release(item.claim.leaseId).catch(() => undefined);
    if (item.resourceClaims.length > 0) await admission.release(item.workItemId);
  }

  async function settleAgentFailed(agent: AgentInstance, failure: { reason: string; message: string }, ctx: EventContext): Promise<void> {
    await subagents.settle(agent.agentId, { status: 'failed', failure, evidenceRefs: [], recordRefs: [] }, ctx).catch((e: unknown) => {
      if (!isHypertestError(e, 'conflict')) throw e;
    });
    const session = await sessions.get(agent.sessionId);
    if (session && session.status !== 'failed' && session.status !== 'disposed' && session.status !== 'completed') await sessions.setStatus(agent.sessionId, 'failed');
  }

  async function failItem(item: WorkItem, token: number, reason: NonNullable<WorkItem['failure']>['reason'], message: string, ctx: EventContext): Promise<void> {
    const done = await fenced(() => blackboard.transitionWorkItem(item.workItemId, 'failed', { failure: { reason, message } }, ctx, { expectedFencingToken: token }));
    await release(done);
  }

  /** Renews the lease (and the claim's expiry) while a turn runs; stops before the result is written. */
  function heartbeat(item: WorkItem, leaseId: string, token: number, ctx: EventContext): () => Promise<void> {
    let inflight: Promise<void> | undefined;
    const beat = () => {
      if (inflight) return;
      inflight = (async () => {
        const lease = await leases.renew(leaseId, config.leaseTtlMs);
        const cur = await blackboard.getWorkItem(item.workItemId);
        if (!cur?.claim || cur.claim.fencingToken !== token || isTerminalWorkState(cur.state)) return;
        await blackboard.transitionWorkItem(item.workItemId, cur.state, { claim: { ...cur.claim, expiresAt: lease.expiresAt } }, ctx, { expectedFencingToken: token, expectedFrom: [cur.state] });
        if (cur.resourceClaims.length > 0) await admission.admit({ holderId: cur.workItemId, runId: cur.runId, claims: cur.resourceClaims, ttlMs: config.leaseTtlMs });
      })()
        .catch((e: unknown) => logger.warn('lease heartbeat failed', { workItemId: item.workItemId, error: (e as Error).message }))
        .finally(() => {
          inflight = undefined;
        });
    };
    const timer = setInterval(beat, config.heartbeatMs);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await inflight;
    };
  }

  // ------------------------------------------------------------------------------------------------ executeTurn

  /** Keeps the item's resource claims alive with its lease (a claim that lapsed and was taken by another holder is logged). */
  async function renewResourceClaims(item: WorkItem): Promise<void> {
    if (item.resourceClaims.length === 0) return;
    const r = await admission.admit({ holderId: item.workItemId, runId: item.runId, claims: item.resourceClaims, ttlMs: config.leaseTtlMs });
    if (!r.admitted) logger.warn('resource claims of a held work item could not be renewed (taken by another holder)', { workItemId: item.workItemId, conflicts: r.conflicts.map((c) => `${c.requested.resourceKey}@${c.heldBy}`) });
  }

  /** The item ended while this worker held it (e.g. cancelled by a plan revision mid-turn): report its final state. */
  async function endedMeanwhile(workItemId: string): Promise<TurnOutcome | undefined> {
    const cur = await blackboard.getWorkItem(workItemId);
    if (!cur || !isTerminalWorkState(cur.state)) return undefined;
    return { status: cur.state as 'completed' | 'failed' | 'cancelled', workItemId };
  }

  async function executeTurn(workItemId: string, fencingToken: number, signal?: AbortSignal, options: ExecuteTurnOptions = {}): Promise<TurnOutcome> {
    const item0 = await blackboard.getWorkItem(workItemId);
    if (!item0) throw notFound('work item', workItemId);
    if (isTerminalWorkState(item0.state)) return { status: item0.state as 'completed' | 'failed' | 'cancelled', workItemId };
    const run = await runs.get(item0.runId);
    if (!run) throw notFound('run', item0.runId);
    if (run.status === 'paused') return { status: 'paused', workItemId, reason: run.pauseReason ?? 'operator' };
    // fencing (I4): the caller's token must be the item's claim AND the live lease of work/<id>
    if (!item0.claim || item0.claim.fencingToken !== fencingToken) return { status: 'lease_lost', workItemId };
    if (!(await leases.checkFence(workLeaseKey(workItemId), fencingToken))) return { status: 'lease_lost', workItemId };
    const claim = item0.claim;
    const ctx = itemCtx(item0, workerActor);
    try {
      if (run.status === 'cancelled' || run.status === 'completed' || run.status === 'failed') {
        // the run ended while this item was still held (e.g. a cancelRun that has not swept it yet): no turn runs
        const done = await fenced(() => blackboard.transitionWorkItem(workItemId, 'cancelled', { failure: { reason: 'cancelled', message: `run ${run.runId} is ${run.status}` } }, ctx, { expectedFencingToken: fencingToken }));
        await release(done);
        await interruptAgent(workItemId, `run ${run.runId} is ${run.status}`, ctx).catch((e: unknown) => logger.warn('interrupt failed', { workItemId, error: (e as Error).message }));
        return { status: 'cancelled', workItemId };
      }
      const renewed = await leases.renew(claim.leaseId, config.leaseTtlMs).catch((e: unknown) => {
        if (isHypertestError(e, 'stale_fence')) throw new LeaseLost((e as Error).message);
        throw e;
      });
      let item = await fenced(() => blackboard.transitionWorkItem(workItemId, item0.state, { claim: { ...claim, expiresAt: renewed.expiresAt } }, ctx, { expectedFencingToken: fencingToken }));
      await renewResourceClaims(item);
      if (item.state === 'waiting') return { status: 'waiting', workItemId, operationIds: item.waitingOn };
      if (item.state === 'claimed') item = await fenced(() => blackboard.transitionWorkItem(workItemId, 'running', {}, ctx, { expectedFencingToken: fencingToken, expectedFrom: ['claimed'] }));

      let ensured: { agent: AgentInstance; spec: AgentHostSpec };
      try {
        ensured = await ensureAgent(item, run, fencingToken);
      } catch (e) {
        // a refusal that every retry would repeat (agent cap, capability/depth violation, parent gone) ends the item:
        // re-dispatching it would livelock the run
        if (!isHypertestError(e) || !FINAL_SPAWN_ERRORS.has(e.code)) throw e;
        const ended = await endedMeanwhile(workItemId); // the refusal is the item having ended (e.g. cancelled) meanwhile
        if (ended) return ended;
        const reason = e.code === 'budget_exhausted' ? 'budget_exhausted' : e.code === 'permission_denied' ? 'policy_denied' : 'internal_error';
        logger.warn('the agent of a work item could not be spawned; the item fails', { workItemId, code: e.code, error: e.message });
        await failItem(item, fencingToken, reason, `agent spawn refused (${e.code}): ${e.message}`, ctx);
        return { status: 'failed', workItemId };
      }
      const { agent, spec } = ensured;
      const agentCtx = itemCtx(item, workerActor, agent.agentId);
      if (agent.status === 'completed' || agent.status === 'failed') {
        // The agent already settled (e.g. a previous owner's turn completed but its fenced item write was refused, or
        // a crash between the settle and the item write): adopt the durable result instead of running another turn.
        const settled = await subagents.collect(agent.agentId);
        if (agent.status === 'completed') {
          const workResult: WorkResult = { summary: settled.summary ?? '', evidenceRefs: settled.evidenceRefs, recordRefs: settled.recordRefs };
          if (settled.output !== undefined) workResult.output = settled.output;
          const done = await fenced(() => blackboard.transitionWorkItem(workItemId, 'completed', { result: workResult }, agentCtx, { expectedFencingToken: fencingToken }));
          await release(done);
          return { status: 'completed', workItemId };
        }
        const f = settled.failure ?? { reason: 'agent_failed', message: 'the agent failed' };
        await failItem(item, fencingToken, failureReason(f.reason), `${f.reason}: ${f.message}`, agentCtx);
        return { status: 'failed', workItemId };
      }
      // Crash window: the engine committed a turn that decided to WAIT (TurnRecord.outcome, recorded atomically with the
      // turn), but the process died before the item entered `waiting`. Another turn now would hand the model its
      // `[pending]` results without the operations' outcomes: re-enter waiting on the recorded operations instead
      // (observeWaiting reconciles them by id and resumes the item with their results).
      const unresumed = await unresumedWait(item, agent);
      if (unresumed) {
        logger.info('re-entering waiting: the last committed turn waits on operations the item never waited for', { workItemId, operationIds: unresumed });
        await fenced(() => blackboard.transitionWorkItem(workItemId, 'waiting', { waitingOn: unresumed }, agentCtx, { expectedFencingToken: fencingToken, expectedFrom: ['running'] }));
        return { status: 'waiting', workItemId, operationIds: unresumed };
      }
      if (options.expectedTurn !== undefined) {
        const session = await sessions.get(agent.sessionId);
        const last = await sessions.lastTurn(agent.sessionId);
        if (session && session.status === 'active' && last && last.status === 'completed' && last.turn >= options.expectedTurn) return { status: 'continue', workItemId, turn: last.turn };
      }
      const host = await buildHost(item, run, agent, spec, fencingToken);
      const stop = heartbeat(item, claim.leaseId, fencingToken, agentCtx);
      let step;
      try {
        step = await runner.step(agent.agentId, host, { limits: config.turnLimits, signal: signal ?? new AbortController().signal });
      } catch (e) {
        await stop();
        if (isHypertestError(e, 'precondition_failed')) {
          const a = await agents.get(agent.agentId);
          if (a && (a.status === 'interrupted' || a.status === 'disposed')) {
            const cur = await blackboard.getWorkItem(workItemId);
            if (cur && !isTerminalWorkState(cur.state)) {
              const done = await fenced(() => blackboard.transitionWorkItem(workItemId, 'cancelled', { failure: { reason: 'cancelled', message: `agent ${a.agentId} is ${a.status}` } }, agentCtx, { expectedFencingToken: fencingToken }));
              await release(done);
            }
            return { status: 'cancelled', workItemId };
          }
        }
        throw e;
      }
      await stop();
      const result = step.result;
      switch (result.status) {
        case 'continue': {
          const now = await blackboard.getWorkItem(workItemId);
          if (now && isTerminalWorkState(now.state)) return { status: now.state as 'completed' | 'failed' | 'cancelled', workItemId };
          if (!now?.claim || now.claim.fencingToken !== fencingToken) return { status: 'lease_lost', workItemId };
          const exhausted = await workBudgetExhausted(item, agent);
          if (exhausted) {
            await settleAgentFailed(agent, { reason: 'budget_exhausted', message: exhausted }, agentCtx);
            await failItem(item, fencingToken, 'budget_exhausted', exhausted, agentCtx);
            await events.append([event(agentCtx, 'budget.exhausted', 'budget', workScope(workItemId), { scope: workScope(workItemId), reason: exhausted })]);
            return { status: 'failed', workItemId };
          }
          return { status: 'continue', workItemId, turn: result.turn };
        }
        case 'completed': {
          const c = result.completion;
          if (!c) throw new HypertestError('internal', `agent ${agent.agentId} completed without a completion signal`);
          const workResult: WorkResult = { summary: c.summary, evidenceRefs: c.evidenceRefs, recordRefs: c.recordRefs };
          if (c.output !== undefined) workResult.output = c.output as JsonValue;
          const done = await fenced(() => blackboard.transitionWorkItem(workItemId, 'completed', { result: workResult }, agentCtx, { expectedFencingToken: fencingToken, expectedFrom: ['running'] }));
          await release(done);
          return { status: 'completed', workItemId };
        }
        case 'failed': {
          const f = result.failure ?? { reason: 'agent_failed', message: 'the agent failed' };
          await failItem(item, fencingToken, failureReason(f.reason), `${f.reason}: ${f.message}`, agentCtx);
          return { status: 'failed', workItemId };
        }
        case 'waiting': {
          const waitingOn = result.waitingOn ?? [];
          await fenced(() => blackboard.transitionWorkItem(workItemId, 'waiting', { waitingOn }, agentCtx, { expectedFencingToken: fencingToken, expectedFrom: ['running'] }));
          return { status: 'waiting', workItemId, operationIds: waitingOn };
        }
        case 'boundary': {
          if (result.boundary === 'retry_next_turn') return { status: 'continue', workItemId, turn: result.turn };
          if (result.boundary === 'cancelled') throw new HypertestError('cancelled', `turn of work item ${workItemId} was cancelled before the model call`);
          const reason = result.boundary === 'budget_exhausted' ? 'budget_exhausted' : 'model_unavailable';
          const message = `model boundary ${result.boundary}`;
          await settleAgentFailed(agent, { reason, message }, agentCtx);
          await failItem(item, fencingToken, reason, message, agentCtx);
          if (reason === 'budget_exhausted') {
            // Which scope refused the reservation: the item's own budget, or the run's. A run-scope refusal while other
            // agents held no reservation means no model call fits at this limit any more (convergence reads the marker;
            // a raised limit clears it); with reservations outstanding the refusal may be transient.
            const runUsage = await budget.usage(runScope(run.runId));
            const workUsage = await budget.usage(workScope(workItemId));
            const left = (u: typeof runUsage) => (u?.limits.tokens === undefined ? Number.POSITIVE_INFINITY : u.limits.tokens - (u.used.tokens ?? 0) - (u.reserved.tokens ?? 0));
            const runBound = left(runUsage) <= left(workUsage);
            const scope = runBound ? runScope(run.runId) : workScope(workItemId);
            const bound = runBound ? runUsage : workUsage;
            await events.append([
              event(agentCtx, 'budget.exhausted', 'budget', scope, {
                scope, reason: 'model_tokens', workItemId, limit: bound?.limits.tokens, remaining: runBound ? left(runUsage) : left(workUsage), reservedByOthers: bound?.reserved.tokens ?? 0,
              }),
            ]);
            if (runBound && config.onBudgetExhausted === 'pause') {
              const cur = await runs.get(run.runId);
              if (cur?.status === 'running') await runs.update(run.runId, { status: 'paused', pauseReason: 'budget' }, agentCtx);
              return { status: 'paused', workItemId, reason: 'budget' };
            }
          }
          return { status: 'failed', workItemId };
        }
        case 'interrupted': {
          const a = await agents.get(agent.agentId);
          if (a?.status === 'interrupted') {
            const cur = await blackboard.getWorkItem(workItemId);
            if (cur && !isTerminalWorkState(cur.state)) {
              const done = await fenced(() => blackboard.transitionWorkItem(workItemId, 'cancelled', { failure: { reason: 'cancelled', message: 'the agent was interrupted' } }, agentCtx, { expectedFencingToken: fencingToken }));
              await release(done);
            }
            return { status: 'cancelled', workItemId };
          }
          // A plain abort (e.g. a cancelled durable activity): the turn replays on the next attempt.
          throw new HypertestError('cancelled', `turn of work item ${workItemId} was aborted`);
        }
      }
    } catch (e) {
      if (e instanceof LeaseLost || isHypertestError(e, 'stale_fence')) return { status: 'lease_lost', workItemId };
      // a fenced write refused because the item ended meanwhile (cancelled by a plan revision or cancelRun mid-turn,
      // whose claim is kept for the audit): a domain outcome, not a fault
      if (isHypertestError(e, 'conflict') || isHypertestError(e, 'precondition_failed')) {
        const ended = await endedMeanwhile(workItemId);
        if (ended) return ended;
      }
      throw e;
    }
  }

  /**
   * The operations of the agent's last committed turn when that turn decided to wait but the item never waited for them
   * (no `work.waiting` of this item names them): a crash between the turn commit and the transition. Undefined otherwise
   * — including an item that waited and was resumed by observeWaiting (its results are queued for the next turn).
   */
  async function unresumedWait(item: WorkItem, agent: AgentInstance): Promise<string[] | undefined> {
    const last = await sessions.lastTurn(agent.sessionId);
    const ops = last?.status === 'completed' && last.outcome?.status === 'waiting' ? (last.outcome.waitingOn ?? []) : [];
    if (ops.length === 0) return undefined;
    const waits = await events.read(item.runId, { types: ['work.waiting'] });
    const waited = waits.some((e) => {
      if (e.aggregateId !== item.workItemId) return false;
      const on = (e.payload as { waitingOn?: unknown } | null)?.waitingOn;
      return Array.isArray(on) && ops.every((op) => on.includes(op));
    });
    return waited ? undefined : [...ops];
  }

  async function workBudgetExhausted(item: WorkItem, agent: AgentInstance): Promise<string | undefined> {
    const b = item.budget;
    const session = await sessions.get(agent.sessionId);
    if (session && session.turnCount >= b.maxTurns) return `maxTurns ${b.maxTurns} reached`;
    const usage = await budget.usage(workScope(item.workItemId));
    if (usage) {
      if ((usage.used.toolCalls ?? 0) >= b.maxToolCalls) return `maxToolCalls ${b.maxToolCalls} reached`;
      if ((usage.used.tokens ?? 0) >= b.maxTokens) return `maxTokens ${b.maxTokens} reached`;
      if (b.maxCostUsd !== undefined && (usage.used.costUsd ?? 0) >= b.maxCostUsd) return `maxCostUsd ${b.maxCostUsd} reached`;
    }
    if (clock.nowMs() - Date.parse(agent.createdAt) >= b.maxWallClockMs) return `maxWallClockMs ${b.maxWallClockMs} reached`;
    return undefined;
  }

  // ------------------------------------------------------------------------------------------------ observeWaiting

  async function observeWaiting(workItemId: string, signal?: AbortSignal): Promise<TurnOutcome> {
    const item0 = await blackboard.getWorkItem(workItemId);
    if (!item0) throw notFound('work item', workItemId);
    if (isTerminalWorkState(item0.state)) return { status: item0.state as 'completed' | 'failed' | 'cancelled', workItemId };
    const agent = await agents.byWorkItem(workItemId);
    const lastTurn = agent ? ((await sessions.lastTurn(agent.sessionId))?.turn ?? 0) : 0;
    if (item0.state !== 'waiting') return { status: 'continue', workItemId, turn: lastTurn };
    if (!agent) throw new HypertestError('internal', `waiting work item ${workItemId} has no agent`);
    const ctx = itemCtx(item0, workerActor, agent.agentId);

    // keep (or re-take) the claim of the waiting item under this worker
    let item = item0;
    const live = await leases.current(workLeaseKey(workItemId));
    if (item.claim && live && live.fencingToken === item.claim.fencingToken && live.owner === config.workerId) {
      const renewed = await leases.renew(live.leaseId, config.leaseTtlMs);
      item = await blackboard.transitionWorkItem(workItemId, 'waiting', { claim: { ...item.claim, expiresAt: renewed.expiresAt } }, ctx, { expectedFencingToken: item.claim.fencingToken, expectedFrom: ['waiting'] });
    } else {
      const lease = await leases.acquire({ resourceKey: workLeaseKey(workItemId), owner: config.workerId, ttlMs: config.leaseTtlMs });
      if (!lease) return { status: 'lease_lost', workItemId };
      item = await blackboard.transitionWorkItem(workItemId, 'waiting', { claim: { ownerId: config.workerId, leaseId: lease.leaseId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt } }, ctx, { expectedFrom: ['waiting'] });
      hooks.onClaim?.(workItemId, lease.fencingToken);
    }
    const token = item.claim!.fencingToken;
    // the external operation still occupies its resources: keep the item's resource claims alive with the lease
    await renewResourceClaims(item);

    const lines: string[] = [];
    const evidenceIds: string[] = [];
    let settled = true;
    for (const op of item.waitingOn) {
      const childId = parseDelegationOperationId(op);
      if (childId !== undefined) {
        const child = await blackboard.getWorkItem(childId);
        if (!child) {
          lines.push(`- delegation ${op}: the child work item does not exist`);
          continue;
        }
        if (!isTerminalWorkState(child.state)) {
          settled = false;
          continue;
        }
        const childAgent = await agents.byWorkItem(childId);
        const r = childAgent ? await subagents.collect(childAgent.agentId) : undefined;
        const summary = r?.summary ?? child.result?.summary;
        const failure = r?.failure ?? child.failure;
        const refs = r?.evidenceRefs ?? child.result?.evidenceRefs ?? [];
        const records = r?.recordRefs ?? child.result?.recordRefs ?? [];
        evidenceIds.push(...refs);
        lines.push(
          `- delegation ${op} (${child.role}) ${child.state}: ${summary ? clip(summary, 2000) : failure ? `${failure.reason}: ${failure.message}` : 'no summary'}${refs.length ? `; evidence ${refs.join(', ')}` : ''}${records.length ? `; records ${records.join(', ')}` : ''}`,
        );
      } else {
        const outcome = await gateway.observe(op, ctx, signal ?? new AbortController().signal);
        if (outcome.status === 'pending') {
          settled = false;
          continue;
        }
        const refs = outcome.operation.evidenceRefs;
        evidenceIds.push(...refs);
        const detail = outcome.status === 'verified' ? `verified${outcome.result !== undefined ? `: ${clip(JSON.stringify(outcome.result), 1500)}` : ''}` : `${outcome.status}: ${outcome.reason}`;
        lines.push(`- operation ${op} (${outcome.operation.operationType}) ${detail}${refs.length ? `; evidence ${refs.join(', ')}` : ''}`);
      }
    }
    if (!settled) return { status: 'waiting', workItemId, operationIds: item.waitingOn };
    const message: ChatMessage = { role: 'user', content: `Results of pending operations/delegations:\n${lines.join('\n')}${evidenceIds.length ? `\nEvidence ids: ${[...new Set(evidenceIds)].join(', ')}` : ''}` };
    try {
      await db.transaction(async () => {
        await sessions.enqueueInput(agent.sessionId, [message]);
        await blackboard.transitionWorkItem(workItemId, 'running', { waitingOn: [] }, ctx, { expectedFencingToken: token, expectedFrom: ['waiting'] });
      });
    } catch (e) {
      if (isHypertestError(e, 'stale_fence') || isHypertestError(e, 'conflict')) return { status: 'lease_lost', workItemId };
      throw e;
    }
    return { status: 'continue', workItemId, turn: lastTurn };
  }

  async function interruptAgent(workItemId: string, reason: string, ctx: EventContext): Promise<void> {
    const agent = await agents.byWorkItem(workItemId);
    if (agent && !['completed', 'failed', 'disposed', 'interrupted'].includes(agent.status)) await subagents.interrupt(agent.agentId, reason, ctx);
  }

  return {
    ensureAgent,
    buildHost,
    executeTurn: (workItemId, fencingToken, signal, options) => itemMutex.run(workItemId, () => executeTurn(workItemId, fencingToken, signal, options)),
    observeWaiting: (workItemId, signal) => itemMutex.run(workItemId, () => observeWaiting(workItemId, signal)),
    interruptAgent,
  };
}
