import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HypertestError, isHypertestError, type JsonValue } from '@hypertest/core';
import {
  EVENT_TYPES, isTerminalWorkState, type ActionCapability, type AgentInstance, type ChatMessage, type EventContext, type ModelPolicy, type PermissionProfile, type TestRun,
  type WorkItem, type WorkResult,
} from '@hypertest/domain';
import {
  PERMISSION_PROFILES, attenuateCapability, createRootCapability, intersectPatterns, resourcePatternCovers, signCapability, type CapabilityConstraints, type PermissionProfileName,
} from '@hypertest/policy';
import { createModelInvoker, type EngineHost, type SpawnRequest } from '@hypertest/runtime';
import type { RoleDefinition } from '@hypertest/agents';
import type { WorkspaceHandle } from '@hypertest/tools';
import type { ExecuteTurnOptions, TurnOutcome } from './contracts.ts';
import type { ControlDeps, ResolvedControlConfig } from './deps.ts';
import { createContextProvider, type TurnState } from './context-provider.ts';
import { createToolDispatcher, offeredRisk } from './dispatcher.ts';
import { createPhaseGovernor } from './phases.ts';
import { describeUnmet, unmetRequirements, workItemConstraint, type UnmetRequirement } from './capability-grant.ts';
import {
  delegationChatMessage, delegationSettled, inputWaitOperationId, isAwaitingInput, parseDelegationOperationId, unreadMessages,
} from './delegation.ts';
import { workLeaseKey, yieldWorkClaim } from './scheduler.ts';
import { runExperimentIds } from './isolation.ts';
import { ControlStore, type AgentHostSpec, type Delegation, type WorkspaceRecipe } from './store.ts';
import { runScope, workScope } from './work-factory.ts';
import { KeyedMutex, assertRunPinned, clip, event, failureReason, itemCtx, jsonBlock, notFound, systemActor, tightenModelPolicy } from './util.ts';

export interface AgentWorker {
  /** The work item's agent: reused when it exists, else spawned with its workspace, capability and task context. */
  ensureAgent(item: WorkItem, run: TestRun, fencingToken: number): Promise<{ agent: AgentInstance; spec: AgentHostSpec }>;
  /** The EngineHost of one turn (model invoker, governed tool dispatcher, context provider). */
  buildHost(item: WorkItem, run: TestRun, agent: AgentInstance, spec: AgentHostSpec, fencingToken?: number, claimGuard?: ClaimGuard): Promise<EngineHost>;
  executeTurn(workItemId: string, fencingToken: number, signal?: AbortSignal, options?: ExecuteTurnOptions): Promise<TurnOutcome>;
  observeWaiting(workItemId: string, signal?: AbortSignal): Promise<TurnOutcome>;
  /** (H6) Keeps a held, not-yet-running claim alive (ControlPlane.renewClaim). */
  renewClaim(workItemId: string, fencingToken: number): Promise<boolean>;
  /** Stops an item's agent after a cancellation. */
  interruptAgent(workItemId: string, reason: string, ctx: EventContext): Promise<void>;
}

/**
 * (durability-2) State of the claim a turn runs under, shared by the lease heartbeat and the tool dispatcher: once the
 * item's resource claims could not be renewed (another holder took them), `lost` says why and every further tool call of
 * the turn is refused — two conflicting experiments never run on the same resources.
 */
export interface ClaimGuard {
  lost?: string;
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

/**
 * A root capability narrowed by a further constraint (the work item's): attenuation semantics (never amplified), but the
 * result keeps the root's identity and has no parent grant (a root agent has none), re-signed.
 */
function narrowRoot(root: ActionCapability, constraint: CapabilityConstraints, secret: string): ActionCapability {
  const narrowed = attenuateCapability(root, [constraint], { subjectAgentId: root.subjectAgentId, workItemId: root.workItemId, capabilityId: root.capabilityId });
  const { parentCapabilityId: _p, signature: _s, ...body } = narrowed;
  return signCapability(body, secret);
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
  const phases = createPhaseGovernor(deps, config);

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

  async function taskMessage(item: WorkItem, run: TestRun, unmet: readonly UnmetRequirement[] = [], delegation?: Delegation): Promise<string> {
    const lines: string[] = [`# Work item ${item.workItemId}: ${item.title}`, `Role: ${item.role}; kind: ${item.kind}; priority ${item.priority}.`, '', '## Objective', item.objective];
    if (unmet.length > 0) {
      // I2: the grant is parent ∩ role ∩ work-item requirements ∩ environment policy — the excess is reported, never granted
      lines.push('', '## Capability requirements NOT granted');
      lines.push('Your capability is your parent\'s (or your role\'s) ∩ your role policy ∩ this work item\'s requirements ∩ the environment policy. These requirements of your work item exceed it and were not granted: calls that need them are denied. Do not work around this — finish with what you may do, or fail_work naming the missing capability.');
      for (const line of describeUnmet(unmet)) lines.push(`- ${line}`);
    }
    if (delegation?.continuable) {
      lines.push('', '## Continuable delegation', 'You are a continuable subagent: after complete_work you wait for more input from your parent (its messages arrive as `[delegate.message …]`); answer each with complete_work again. Your parent releases you when done.');
    }
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
      // I2 (H9): child = parent ∩ role ∩ … ∩ ENVIRONMENT policy — the role's environment classes narrowed to the classes
      // of the environments actually registered, plus `local` (this host, always present): a run whose only environments
      // are sandboxes never carries a staging- or production-capable token
      const registeredClasses = new Set(['local', ...deps.environments.list().map((e) => e.environmentClass)]);
      const environmentClasses = profile.environmentClasses.filter((c) => registeredClasses.has(c));
      const expiresAt = new Date(clock.nowMs() + item.budget.maxWallClockMs).toISOString();
      const ctx = itemCtx(item, workerActor);
      // I2: … ∩ WORK ITEM requirements (baseline: its own workspace and the run's records) ∩ environment policy
      const requirements = item.capabilityRequirements ?? [];
      const workItemC = workItemConstraint(requirements, [`${ws.resourcePrefix}/**`, `run/${run.runId}/**`]);
      const environmentC: CapabilityConstraints = { environmentClasses: [...registeredClasses].sort() };
      const delegation = item.origin.kind === 'delegation' ? await store.delegation(item.workItemId) : undefined;

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
          // I2: a child is attenuated from its parent's recorded capability, never granted a root one:
          // parent ∩ role ∩ work item ∩ environment policy
          const roleC: CapabilityConstraints = {
            tools: allow, resourceScopes: scopes, allowedEffects: profile.allowedEffects, environmentClasses: profile.environmentClasses, credentialScopes: profile.credentialScopes,
            maxRiskClass: profile.maxRiskClass, expiresAt,
          };
          granted = attenuateCapability(parentCapability, [roleC, ...(workItemC ? [workItemC] : []), environmentC], { subjectAgentId: agentId, workItemId: item.workItemId }, { secret: config.capabilitySecret });
        } else {
          // root: role profile ∩ environment policy, then ∩ work item (narrowed in place: a root has no parent grant)
          const root = createRootCapability(
            { runId: run.runId, subjectAgentId: agentId, workItemId: item.workItemId, profile: { ...profile, name: role.permissionProfile as PermissionProfileName, resourceScopes: scopes, environmentClasses }, tools: allow, expiresAt },
            config.capabilitySecret,
          );
          granted = workItemC ? narrowRoot(root, workItemC, config.capabilitySecret) : root;
        }
        return granted;
      };
      // what the work item asks for but the grant does not cover (the grant does not depend on the agent id)
      const unmet = requirements.length > 0 ? unmetRequirements(capability('ag_preview'), requirements) : [];
      const snapshot = await snapshotBuilder.build({ runId: run.runId }, ctx);
      const initialMessages: ChatMessage[] = [{ role: 'user', content: await taskMessage(item, run, unmet, delegation) }];
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
        continuable: delegation?.continuable === true,
        background: delegation?.background === true,
        budget: item.budget,
        engineKind: config.defaultEngineKind,
      };
      if (parent) request.parentAgentId = parent.agentId;
      if (item.expectedOutput) request.outputSchema = item.expectedOutput;
      const result = await db.transaction(async (tx) => {
        // the parent's messages sent before this child existed start its session (locked: none is lost or doubled)
        const d = delegation ? await store.delegation(item.workItemId, tx, true) : undefined;
        const queued = d?.messages.filter((m) => !m.enqueued) ?? [];
        request.initialMessages = [...initialMessages, ...queued.map(delegationChatMessage)];
        const agent = await subagents.spawn(request, ctx);
        if (d && queued.length > 0) await store.setDelegationMessages(item.workItemId, d.messages.map((m) => (m.enqueued ? m : { ...m, enqueued: true })), tx);
        if (unmet.length > 0) {
          await events.append(
            [event({ ...ctx, agentId: agent.agentId }, 'capability.requirements_unmet', 'work_item', item.workItemId, { workItemId: item.workItemId, agentId: agent.agentId, capabilityId: agent.capabilityId, unmet: describeUnmet(unmet) })],
            tx,
          );
        }
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

  async function buildHost(item: WorkItem, run: TestRun, agent: AgentInstance, spec: AgentHostSpec, fencingToken?: number, claimGuard?: ClaimGuard): Promise<EngineHost> {
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
      ...(claimGuard ? { claimGuard } : {}),
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

  /** (H2, I11) EngineRegistry.assertPinned when the registry offers it (the runtime's EngineRegistry does). */
  function assertEnginePinned(kind: string): void {
    const registry = deps.engines as typeof deps.engines & { assertPinned?(manifest: typeof config.runtimeManifest, kind: string): unknown };
    if (typeof registry.assertPinned === 'function') registry.assertPinned(config.runtimeManifest, kind);
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
    if (item.origin.kind === 'delegation') {
      const d = await store.delegation(item.workItemId);
      if (d) await notifyParent(d, item, `failed (${reason}: ${clip(message, 500)})`);
    }
  }

  /**
   * A background delegation (or a continuable child answering a parent's message) reports to its parent's inbox when a
   * task ends — summary and cited ids only, never the child's trace. A foreground child's first result reaches the parent
   * through its pending delegate call instead. A parent that already ended is not told.
   */
  async function notifyParent(d: Delegation, child: WorkItem, what: string, result?: WorkResult): Promise<void> {
    if (!d.background && d.messages.length === 0) return;
    const parent = await agents.get(d.parentAgentId);
    if (!parent || (parent.status !== 'active' && parent.status !== 'waiting')) return;
    const refs = result && result.evidenceRefs.length > 0 ? `; evidence ${result.evidenceRefs.join(', ')}` : '';
    const records = result && result.recordRefs.length > 0 ? `; records ${result.recordRefs.join(', ')}` : '';
    const content = `[delegation ${child.workItemId} (${child.role}) ${what}]${result ? ` ${clip(result.summary, 2000)}${refs}${records}` : ''}`;
    try {
      await subagents.message(parent.agentId, { role: 'user', content });
    } catch (e) {
      if (!isHypertestError(e, 'precondition_failed')) throw e;
    }
  }

  /**
   * A task finished (complete_work). A continuable delegation that was not released waits for more input on
   * `input:<id>` (its result recorded on the item and settled for delegate.collect); every other item completes. A released
   * continuable child completes and its agent is disposed (it takes no more input).
   */
  async function finishTask(item: WorkItem, agent: AgentInstance, workResult: WorkResult, token: number, ctx: EventContext, from?: WorkItem['state'][]): Promise<TurnOutcome> {
    // BUGate before_transition at the transition itself: complete_work was decided on the calls made before it, but a
    // call of the same turn may run after it (the engine dispatches a turn's calls in order) and be flagged after
    // action. A task whose calls are flagged is judged again here, on the current facts — flagged work never completes
    // (nor settles a continuable task) unless the policy allows it.
    const flagged = await phases.flaggedActions(item.runId, item.workItemId);
    if (flagged > 0) {
      const permit = await phases.beforeTransition({
        runId: item.runId,
        transition: {
          subject: 'work_item', subjectId: item.workItemId, from: item.state, to: 'completed',
          details: { role: item.role, kind: item.kind, citedEvidence: workResult.evidenceRefs.length, citedRecords: workResult.recordRefs.length, structuredOutput: workResult.output !== undefined, recheck: true },
        },
        workItemId: item.workItemId,
        requestedBy: { agentId: agent.agentId, role: item.role },
        ctx,
      });
      if (permit.decision !== 'allow') {
        logger.warn('work item completion refused by policy at the transition (flagged calls)', { workItemId: item.workItemId, flagged, decisionId: permit.decisionId, decision: permit.decision });
        await failItem(item, token, 'policy_denied', `completion refused by policy (before_transition work_item:completed, ${permit.decision}, decision ${permit.decisionId}): ${permit.reasons.join('; ') || 'no reason given'}`, ctx);
        return { status: 'failed', workItemId: item.workItemId };
      }
    }
    const d = item.origin.kind === 'delegation' ? await store.delegation(item.workItemId) : undefined;
    const opts = { expectedFencingToken: token, ...(from ? { expectedFrom: from } : {}) };
    if (d?.continuable && d.releasedAt === undefined) {
      const op = inputWaitOperationId(item.workItemId);
      await fenced(() =>
        db.transaction(async () => {
          await blackboard.transitionWorkItem(item.workItemId, 'waiting', { waitingOn: [op], result: workResult }, ctx, opts);
          await notifyParent(d, item, 'finished a task and waits for more input', workResult);
        }),
      );
      logger.info('continuable delegation finished a task; it waits for more input', { workItemId: item.workItemId, parentWorkItemId: d.parentWorkItemId });
      return { status: 'waiting', workItemId: item.workItemId, operationIds: [op] };
    }
    const done = await fenced(() => blackboard.transitionWorkItem(item.workItemId, 'completed', { result: workResult }, ctx, opts));
    await release(done);
    if (d) {
      await notifyParent(d, item, 'completed', workResult);
      if (d.continuable) await subagents.dispose(agent.agentId, ctx).catch((e: unknown) => logger.warn('released child could not be disposed', { agentId: agent.agentId, error: (e as Error).message }));
    }
    return { status: 'completed', workItemId: item.workItemId };
  }

  /** Renews the lease (and the claim's expiry) while a turn runs; stops before the result is written. */
  function heartbeat(item: WorkItem, leaseId: string, token: number, ctx: EventContext, guard: ClaimGuard): () => Promise<void> {
    let inflight: Promise<void> | undefined;
    const beat = () => {
      if (inflight) return;
      inflight = (async () => {
        const lease = await leases.renew(leaseId, config.leaseTtlMs);
        const cur = await blackboard.getWorkItem(item.workItemId);
        if (!cur?.claim || cur.claim.fencingToken !== token || isTerminalWorkState(cur.state)) return;
        await blackboard.transitionWorkItem(item.workItemId, cur.state, { claim: { ...cur.claim, expiresAt: lease.expiresAt } }, ctx, { expectedFencingToken: token, expectedFrom: [cur.state] });
        // durability-2: a resource claim that could not be renewed stops the turn's tool calls (never ignored)
        if (!guard.lost && !(await renewResourceClaims(cur, ctx, 'heartbeat'))) guard.lost = 'the resource claims of this work item were taken by another holder';
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

  /**
   * Keeps the item's resource claims alive with its lease. `false` when they lapsed and another holder took them
   * (durability-2: recorded on L0 as `admission.lapsed`; the caller stops the item's work — never runs on regardless).
   */
  async function renewResourceClaims(item: WorkItem, ctx: EventContext, phase: string): Promise<boolean> {
    if (item.resourceClaims.length === 0) return true;
    // (conformance-6) an item that runs for experiments shares their admitted claims
    const r = await admission.admit({ holderId: item.workItemId, runId: item.runId, claims: item.resourceClaims, ttlMs: config.leaseTtlMs, compatibleHolders: await runExperimentIds(deps, item) });
    if (r.admitted) return true;
    const conflicts = r.conflicts.map((c) => `${c.requested.resourceKey}@${c.heldBy}`).sort();
    logger.warn('resource claims of a held work item could not be renewed (taken by another holder); the item stops', { workItemId: item.workItemId, conflicts, phase });
    await events.append([event({ ...ctx, workItemId: item.workItemId }, EVENT_TYPES.admissionLapsed, 'work_item', item.workItemId, { workItemId: item.workItemId, conflicts, claims: item.resourceClaims, phase })]);
    return false;
  }

  /** (H13, durability-2) Gives the claim back without consuming an attempt; a claim already gone is not an error. */
  async function yieldClaim(item: WorkItem, token: number, ctx: EventContext, reason: string): Promise<void> {
    try {
      await yieldWorkClaim(deps, item, token, ctx, reason);
    } catch (e) {
      if (!isHypertestError(e, 'conflict') && !isHypertestError(e, 'stale_fence')) throw e;
    }
  }

  async function renewClaim(workItemId: string, token: number): Promise<boolean> {
    const item = await blackboard.getWorkItem(workItemId);
    if (!item || !item.claim || item.claim.fencingToken !== token || (item.state !== 'claimed' && item.state !== 'running')) return false;
    if (!(await leases.checkFence(workLeaseKey(workItemId), token))) return false;
    const ctx = itemCtx(item, workerActor);
    try {
      const renewed = await leases.renew(item.claim.leaseId, config.leaseTtlMs);
      await blackboard.transitionWorkItem(workItemId, item.state, { claim: { ...item.claim, expiresAt: renewed.expiresAt } }, ctx, { expectedFencingToken: token, expectedFrom: [item.state] });
    } catch (e) {
      if (isHypertestError(e, 'stale_fence') || isHypertestError(e, 'conflict') || isHypertestError(e, 'precondition_failed')) return false;
      throw e;
    }
    if (!(await renewResourceClaims(item, ctx, 'queued'))) {
      await yieldClaim(item, token, ctx, 'resource claims lapsed while the claim waited for an executor');
      return false;
    }
    return true;
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
    assertRunPinned(run, config.runtimeManifest.manifestId); // I11 (H2): never run a turn of a live run pinned elsewhere
    if (run.status === 'paused') {
      // H13: a pause never costs a work attempt — the held claim is given back (ready, attempts unchanged; its lease and
      // resource claims released) and the scheduler re-admits the item when the run resumes (its session continues)
      if ((item0.state === 'claimed' || item0.state === 'running') && item0.claim?.fencingToken === fencingToken && (await leases.checkFence(workLeaseKey(workItemId), fencingToken))) {
        await yieldClaim(item0, fencingToken, itemCtx(item0, workerActor), `run ${run.runId} paused`);
      }
      return { status: 'paused', workItemId, reason: run.pauseReason ?? 'operator' };
    }
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
      if (!(await renewResourceClaims(item, ctx, 'turn'))) {
        // durability-2: its resources are held by another item now — no turn runs on them; the claim is given back
        // (attempts unchanged) and admission re-admits the item once the conflicting holder releases them
        if (item.state !== 'waiting') {
          await yieldClaim(item, fencingToken, ctx, 'resource claims lapsed and were taken by another holder');
          return { status: 'lease_lost', workItemId };
        }
      }
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
      // I11 (H2): the agent's engine must be the one (and the version) the run's manifest pins
      assertEnginePinned(agent.engineKind);
      const agentCtx = itemCtx(item, workerActor, agent.agentId);
      if (agent.status === 'completed' || agent.status === 'failed') {
        // The agent already settled (e.g. a previous owner's turn completed but its fenced item write was refused, or
        // a crash between the settle and the item write): adopt the durable result instead of running another turn.
        const settled = await subagents.collect(agent.agentId);
        if (agent.status === 'completed') {
          const workResult: WorkResult = { summary: settled.summary ?? '', evidenceRefs: settled.evidenceRefs, recordRefs: settled.recordRefs };
          if (settled.output !== undefined) workResult.output = settled.output;
          return await finishTask(item, agent, workResult, fencingToken, agentCtx);
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
      const guard: ClaimGuard = {};
      const host = await buildHost(item, run, agent, spec, fencingToken, guard);
      const stop = heartbeat(item, claim.leaseId, fencingToken, agentCtx, guard);
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
          return await finishTask(item, agent, workResult, fencingToken, agentCtx, ['running']);
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
    const run = await runs.get(item0.runId);
    if (!run) throw notFound('run', item0.runId);
    assertRunPinned(run, config.runtimeManifest.manifestId); // I11 (H2)
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
    // the external operation still occupies its resources: keep the item's resource claims alive with the lease (a lapse
    // is recorded; the in-flight operation is still observed to its outcome)
    await renewResourceClaims(item, ctx, 'waiting');
    // a continuable delegation between tasks: more input from its parent resumes it; its release completes it
    if (isAwaitingInput(item)) return awaitInput(item, agent, run, token, ctx, lastTurn);

    const lines: string[] = [];
    const evidenceIds: string[] = [];
    let settled = true;
    const pending: string[] = [];
    for (const op of item.waitingOn) {
      const childId = parseDelegationOperationId(op);
      if (childId !== undefined) {
        const child = await blackboard.getWorkItem(childId);
        if (!child) {
          lines.push(`- delegation ${op}: the child work item does not exist`);
          continue;
        }
        // a continuable child's task result counts as settled while it waits for more input (it is not terminal)
        if (!delegationSettled(child)) {
          settled = false;
          pending.push(op);
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
          `- delegation ${op} (${child.role}) ${isAwaitingInput(child) ? 'completed its task (continuable: it waits for delegate.message or delegate.release)' : child.state}: ${summary ? clip(summary, 2000) : failure ? `${failure.reason}: ${failure.message}` : 'no summary'}${refs.length ? `; evidence ${refs.join(', ')}` : ''}${records.length ? `; records ${records.join(', ')}` : ''}`,
        );
      } else {
        const outcome = await gateway.observe(op, ctx, signal ?? new AbortController().signal);
        if (outcome.status === 'pending') {
          settled = false;
          pending.push(op);
          continue;
        }
        const refs = outcome.operation.evidenceRefs;
        evidenceIds.push(...refs);
        const detail = outcome.status === 'verified' ? `verified${outcome.result !== undefined ? `: ${clip(JSON.stringify(outcome.result), 1500)}` : ''}` : `${outcome.status}: ${outcome.reason}`;
        lines.push(`- operation ${op} (${outcome.operation.operationType}) ${detail}${refs.length ? `; evidence ${refs.join(', ')}` : ''}`);
      }
    }
    if (!settled) {
      // durability-7: a wait has a deadline — the item's maxWallClockMs (counted from its agent's start) and the run's
      // wall clock. Past it the item fails (budget_exhausted) instead of keeping the run from its gate forever; the
      // unsettled operations stay in the ledger for reconciliation (never blindly retried).
      const now = clock.nowMs();
      const expired =
        now - Date.parse(agent.createdAt) >= item.budget.maxWallClockMs
          ? `the work item's maxWallClockMs (${item.budget.maxWallClockMs} ms)`
          : now - Date.parse(run.createdAt) > run.budget.maxWallClockMs
            ? `the run's maxWallClockMs (${run.budget.maxWallClockMs} ms)`
            : undefined;
      if (!expired) return { status: 'waiting', workItemId, operationIds: item.waitingOn };
      const message = `waited past ${expired} for ${pending.join(', ')}: still unsettled (left in the operation ledger for reconciliation)`;
      try {
        const done = await blackboard.transitionWorkItem(workItemId, 'failed', { failure: { reason: 'budget_exhausted', message } }, ctx, { expectedFencingToken: token, expectedFrom: ['waiting'] });
        await release(done);
      } catch (e) {
        if (isHypertestError(e, 'stale_fence') || isHypertestError(e, 'conflict')) return { status: 'lease_lost', workItemId };
        throw e;
      }
      await interruptAgent(workItemId, message, ctx).catch((e: unknown) => logger.warn('interrupt after a wait deadline failed', { workItemId, error: (e as Error).message }));
      logger.warn('waiting work item timed out', { runId: item.runId, workItemId, pending });
      return { status: 'failed', workItemId };
    }
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

  /**
   * observeWaiting of a continuable child between tasks: released (by its parent, its parent's end or its wall clock) ⇒ it
   * completes with its last result and its agent is disposed; unread parent messages ⇒ the ones not yet handed over are
   * queued (SubagentRuntime.message), the agent is resumed and the item runs its next turn; otherwise it keeps waiting.
   */
  async function awaitInput(item: WorkItem, agent: AgentInstance, run: TestRun, token: number, ctx: EventContext, lastTurn: number): Promise<TurnOutcome> {
    const workItemId = item.workItemId;
    const d = await store.delegation(workItemId);
    const now = clock.nowMs();
    const expired =
      now - Date.parse(agent.createdAt) >= item.budget.maxWallClockMs ? `the work item's maxWallClockMs (${item.budget.maxWallClockMs} ms)` : now - Date.parse(run.createdAt) > run.budget.maxWallClockMs ? `the run's maxWallClockMs` : undefined;
    let releasedBy = d === undefined ? 'no delegation on record' : d.releasedAt !== undefined ? (d.releaseReason ?? 'released') : undefined;
    if (releasedBy === undefined && expired !== undefined) {
      releasedBy = `waited for input past ${expired}`;
      if (await store.releaseDelegation(workItemId, releasedBy, clock.isoNow())) {
        await events.append([event(ctx, 'delegation.released', 'work_item', workItemId, { childWorkItemId: workItemId, parentWorkItemId: d!.parentWorkItemId, reason: releasedBy, auto: true })]);
      }
    }
    if (releasedBy !== undefined) {
      let result = item.result;
      if (!result) {
        const r = await subagents.collect(agent.agentId);
        result = { summary: r.summary ?? '', evidenceRefs: r.evidenceRefs, recordRefs: r.recordRefs };
        if (r.output !== undefined) result.output = r.output;
      }
      let done: WorkItem;
      try {
        done = await db.transaction(async () => {
          await blackboard.transitionWorkItem(workItemId, 'running', { waitingOn: [] }, ctx, { expectedFencingToken: token, expectedFrom: ['waiting'] });
          return blackboard.transitionWorkItem(workItemId, 'completed', { result: result! }, ctx, { expectedFencingToken: token, expectedFrom: ['running'] });
        });
      } catch (e) {
        if (isHypertestError(e, 'stale_fence') || isHypertestError(e, 'conflict')) return { status: 'lease_lost', workItemId };
        throw e;
      }
      await release(done);
      await subagents.dispose(agent.agentId, ctx).catch((e: unknown) => logger.warn('released child could not be disposed', { agentId: agent.agentId, error: (e as Error).message }));
      logger.info('continuable delegation released: completed with its last result', { workItemId, reason: releasedBy });
      return { status: 'completed', workItemId };
    }
    if ((await unreadMessages(deps, d!, agent)).length === 0) return { status: 'waiting', workItemId, operationIds: item.waitingOn };
    try {
      await db.transaction(async (tx) => {
        const locked = (await store.delegation(workItemId, tx, true))!;
        const handOver = locked.messages.filter((m) => !m.enqueued);
        for (const m of handOver) await subagents.message(agent.agentId, delegationChatMessage(m));
        if (handOver.length > 0) await store.setDelegationMessages(workItemId, locked.messages.map((m) => (m.enqueued ? m : { ...m, enqueued: true })), tx);
        await subagents.resume(agent.agentId);
        await blackboard.transitionWorkItem(workItemId, 'running', { waitingOn: [] }, ctx, { expectedFencingToken: token, expectedFrom: ['waiting'] });
      });
    } catch (e) {
      if (isHypertestError(e, 'stale_fence') || isHypertestError(e, 'conflict')) return { status: 'lease_lost', workItemId };
      throw e;
    }
    logger.info('continuable delegation resumed with its parent\'s input', { workItemId });
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
    renewClaim,
    interruptAgent,
  };
}
