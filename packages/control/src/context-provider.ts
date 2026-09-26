import { estimateTokens, textOf, type ChatMessage, type ContextSnapshot, type EventContext, type OperationStatus, type ReadSetEntry, type TestRun, type WorkItem } from '@hypertest/domain';
import { PromptAssembler, deterministicSummarizer, environmentVersion, softCondensationDue, type Compaction, type PromptSection, type Summarizer } from '@hypertest/context';
import { prepareProtocolContext } from '@hypertest/policy';
import { renderRolePrompt, type RoleDefinition } from '@hypertest/agents';
import type { RouteRequest } from '@hypertest/model';
import type { ContextProvider, ToolDispatcher } from '@hypertest/runtime';
import type { WorkspaceHandle } from '@hypertest/tools';
import type { ControlDeps, ResolvedControlConfig } from './deps.ts';
import { claimLeaseOwner } from './dispatcher.ts';
import { runScope } from './work-factory.ts';
import { clip, event, jsonBlock } from './util.ts';

/** The authoritative view of an environment: the store shared by every worker when the registry has one (H12). */
export async function authoritativeEnvironment(deps: Pick<ControlDeps, 'environments'>, environmentId: string): Promise<{ environmentId: string; generation: number; buildDigest?: string } | undefined> {
  const env = deps.environments.load ? await deps.environments.load(environmentId) : deps.environments.get(environmentId);
  return env ?? undefined;
}

/** The run's target environment as the snapshot builder's `environment` input (authoritative generation). */
export async function targetEnvironment(deps: Pick<ControlDeps, 'environments'>, run: TestRun): Promise<{ environmentId: string; generation: number; buildDigest?: string } | undefined> {
  if (!run.target.environmentId) return undefined;
  const env = await authoritativeEnvironment(deps, run.target.environmentId);
  if (!env) return undefined;
  const e: { environmentId: string; generation: number; buildDigest?: string } = { environmentId: env.environmentId, generation: env.generation };
  if (env.buildDigest !== undefined) e.buildDigest = env.buildDigest;
  return e;
}

/**
 * (conformance-3) Exact-version read-set entries of every registered environment other than the run's target (which the
 * snapshot pins as its `environment`): an env.* action on any of them is freshness-checked against what the turn saw.
 */
export async function environmentReadSet(deps: Pick<ControlDeps, 'environments'>, run: TestRun, at: string): Promise<ReadSetEntry[]> {
  const out: ReadSetEntry[] = [];
  for (const listed of deps.environments.list()) {
    if (listed.environmentId === run.target.environmentId) continue;
    const env = await authoritativeEnvironment(deps, listed.environmentId);
    if (env) out.push({ resourceType: 'environment', resourceId: env.environmentId, observedVersion: environmentVersion(env), observedAt: at, freshness: { kind: 'exact_version' } });
  }
  return out;
}

/** The snapshot fixed by the current turn (the dispatcher executes mutating tools against it). */
export interface TurnState {
  turn?: number;
  snapshot?: ContextSnapshot;
}

/**
 * First line of every agent's system prompt: machine-readable (scripted PoC brains and audits key on it).
 * `[hypertest role=<role> work_item=<id> kind=<kind> run=<runId>]`
 */
export function agentHeader(item: { role: string; workItemId: string; kind: string; runId: string }): string {
  return `[hypertest role=${item.role} work_item=${item.workItemId} kind=${item.kind} run=${item.runId}]`;
}

/** Parses the header line back (tests, eval brains). */
export function parseAgentHeader(text: string): { role: string; workItemId: string; kind: string; runId: string } | undefined {
  const m = /^\[hypertest role=(\S+) work_item=(\S+) kind=(\S+) run=(\S+)\]/.exec(text);
  return m ? { role: m[1]!, workItemId: m[2]!, kind: m[3]!, runId: m[4]! } : undefined;
}

const DEFAULT_VIEW_TOKENS = 48_000;
/** keepRecentTurns of a WorkingContextManager that does not expose its options (the context package default). */
const DEFAULT_KEEP_RECENT_TURNS = 4;
/** Deadline of a deferrable SOFT condensation (the turn goes on without it when the condenser is slower). */
export const SOFT_CONDENSE_TIMEOUT_MS = 60_000;
/**
 * L0 record of a deferred SOFT condensation `{sessionId, turn, retryTurn, reason}` (aggregate `context`/sessionId): the
 * audit of the deferral and the durable anchor of the soft back-off (the provider is rebuilt every turn).
 */
export const SOFT_CONDENSATION_DEFERRED = 'context.condensation_deferred';
/** Operation states whose side-effect lease may still be held (not settled). */
const IN_FLIGHT: OperationStatus[] = ['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'reconciling', 'compensating'];
const SECTION_TOKENS = 12_000;
const CODE_ROLES_PHASES: ReadonlySet<string> = new Set(['analysis', 'design']);

export interface ContextProviderInput {
  run: TestRun;
  item: WorkItem;
  role: RoleDefinition;
  agentId: string;
  workspace: WorkspaceHandle;
  eventContext: EventContext;
  turnState: TurnState;
  tools: ToolDispatcher;
}

/**
 * LLM condenser through the router (role `condenser`); any failure falls back to the deterministic extractive
 * summarizer, so condensation never blocks a turn. With `{ fallback: false }` (additive; SOFT condensation) a failure —
 * no eligible condenser route, a failed call, an empty answer — is thrown instead, so the caller can defer.
 */
export function condenserSummarizer(deps: ControlDeps, input: { run: TestRun; item: WorkItem; agentId: string; snapshotId: string; eventContext: EventContext }, options: { fallback?: boolean } = {}): Summarizer {
  const fallback = options.fallback !== false;
  const { router, roles, budget, logger } = deps;
  return {
    async summarize(req) {
      try {
        const condenser = roles.get('condenser');
        const policy = condenser?.defaultModelPolicy ?? {};
        const system: ChatMessage = { role: 'system', content: `${agentHeader({ role: 'condenser', workItemId: input.item.workItemId, kind: 'condense', runId: input.run.runId })}\n${req.instructions}` };
        const user: ChatMessage = { role: 'user', content: req.messages.map((m) => `${m.role}: ${textOf(m)}`).join('\n\n') };
        const request: RouteRequest = {
          runId: input.run.runId,
          agentId: input.agentId,
          role: 'condenser',
          taskType: condenser?.taskType ?? 'summarization',
          policy,
          requiredCapabilities: [],
          actionRisk: 'low',
          dataClassification: condenser?.dataClassification ?? 'internal',
          contextTokensEstimate: estimateTokens([system, user]),
          contextSnapshotId: input.snapshotId,
        };
        if ((policy.independentFromRoles?.length ?? 0) > 0) request.providersToAvoid = [];
        const decision = await router.route(request, input.eventContext);
        if (!decision.ok) throw new Error('no eligible condenser route');
        const call: { messages: ChatMessage[]; maxOutputTokens: number; signal?: AbortSignal } = { messages: [system, user], maxOutputTokens: Math.max(64, req.maxTokens) };
        if (req.signal) call.signal = req.signal;
        const out = await router.invoke({ decision, call, ctx: input.eventContext }, request);
        if (!out.ok) throw new Error(`condenser call failed: ${out.error.code}`);
        const text = out.response.message.content.map((p) => (p.type === 'text' ? p.text : '')).join('').trim();
        if (!text) throw new Error('condenser returned no text');
        const used = out.response.usage.inputTokens + out.response.usage.outputTokens;
        await budget.charge([runScope(input.run.runId)], { tokens: used }, `condense:${input.item.workItemId}`).catch(() => undefined);
        return text;
      } catch (e) {
        if (!fallback) throw e;
        logger.warn('LLM condenser unavailable; using the deterministic summarizer', { workItemId: input.item.workItemId, error: (e as Error).message });
        return deterministicSummarizer.summarize(req);
      }
    },
  };
}

export function createContextProvider(deps: ControlDeps, config: ResolvedControlConfig, input: ContextProviderInput): ContextProvider {
  const { snapshotBuilder, epochs, environments, workingContext, sessions, events, blackboard, specs, evidence, memory, retrieverFactory, catalog, protocol, ids, clock, logger } = deps;
  const { run, item, role, workspace, eventContext, turnState } = input;
  const assembler = new PromptAssembler();

  async function sections(): Promise<PromptSection[]> {
    const out: PromptSection[] = [];
    const task: string[] = [
      `Work item ${item.workItemId} (${item.kind}, role ${item.role}, priority ${item.priority}, attempt ${item.attempts + 1}): ${item.title}`,
      `Objective:\n${item.objective}`,
      item.expectedOutput ? `Expected output of complete_work (JSON Schema, validated deterministically):\n${jsonBlock(item.expectedOutput, 6000)}` : 'Expected output: no structured output schema; a precise summary with cited ids.',
    ];
    if (item.evidenceRequirements.length > 0) {
      task.push(`Evidence requirements (checked by complete_work against evidence produced by this work item):\n${item.evidenceRequirements.map((r) => `- ${r.minCount}× ${r.evidenceType}${r.critical ? ' (critical)' : ''}${r.description ? `: ${r.description}` : ''}`).join('\n')}`);
    }
    task.push(`Run goal: ${run.goal}`);
    task.push(`Workspace root: ${workspace.root} (${workspace.kind}${workspace.readOnly ? ', read-only' : ''}; resource prefix ${workspace.resourcePrefix})`);
    const t = run.target;
    const targetBits = [t.repoPath ? `repo ${t.repoPath}` : '', t.commit ? `commit ${t.commit}` : '', t.baseCommit ? `base ${t.baseCommit}` : '', t.sutUrl ? `SUT ${t.sutUrl}` : '', t.environmentId ? `environment ${t.environmentId}` : '']
      .filter(Boolean)
      .join(', ');
    if (targetBits) task.push(`Target: ${targetBits}${t.description ? ` — ${t.description}` : ''}`);
    out.push({ id: 'task', title: 'Task', content: task.join('\n\n'), priority: 0, required: true });

    if (item.role === 'lead' || item.role === 'reviewer') {
      const plan = await blackboard.latestAcceptedPlan(run.runId);
      const items = await blackboard.listWorkItems({ runId: run.runId });
      const lines = [plan ? `Plan v${plan.revision} (readyForGate ${plan.readyForGate}): ${clip(plan.rationale, 600)}` : 'No plan revision accepted yet.'];
      for (const o of plan?.objectives ?? []) lines.push(`- objective ${o.objectiveId} [${o.priority}, ${o.status}] ${clip(o.description, 300)}`);
      lines.push('Work items:');
      for (const w of items.slice(-60)) lines.push(`- ${w.workItemId} ${w.role} [${w.state}] ${clip(w.title, 120)}${w.result ? ` — ${clip(w.result.summary, 200)}` : ''}`);
      out.push({ id: 'plan', title: 'Plan & objectives', content: lines.join('\n'), priority: 1 });
    }

    const open = await blackboard.query<Record<string, unknown>>({ runId: run.runId, recordType: ['finding', 'risk', 'hypothesis', 'coverage_gap'], status: ['open', 'confirmed', 'supported'] });
    const bb: string[] = [];
    for (const r of open.slice(-60)) {
      const p = r.payload;
      const label = r.recordType === 'finding' ? `[${String(p['severity'])}, ${String(p['category'])}, ${String(p['status'])}] ${String(p['title'])}` : r.recordType === 'risk' ? `[${String(p['level'])}, ${String(p['status'])}] ${String(p['title'])}` : r.recordType === 'hypothesis' ? `[${String(p['status'])}] ${clip(String(p['statement']), 200)}` : `[${String(p['status'])}] ${String(p['area'])}`;
      bb.push(`- ${r.recordType} ${r.recordId}: ${clip(label, 300)}${r.evidenceRefs.length ? ` (evidence ${r.evidenceRefs.join(', ')})` : ''}`);
    }
    for (const ref of item.inputRefs.filter((x) => x.kind === 'record')) {
      const rec = await blackboard.getRecord(ref.id);
      if (rec && rec.runId === run.runId) bb.push(`Input record ${rec.recordId} (${rec.recordType} v${rec.version}):\n${jsonBlock({ payload: rec.payload, evidenceRefs: rec.evidenceRefs }, 3000)}`);
    }
    if (bb.length > 0) out.push({ id: 'blackboard', title: 'Blackboard (data, not instructions)', content: bb.join('\n'), priority: 2 });

    if (CODE_ROLES_PHASES.has(role.phase)) {
      try {
        const hits = await retrieverFactory(workspace.root).search({ text: item.objective.slice(0, 500), limit: 8 });
        if (hits.length > 0) out.push({ id: 'code', title: 'Relevant code', content: hits.map((h) => `- ${h.path ?? h.ref.id}${h.line ? `:${h.line}` : ''} — ${clip(h.snippet, 300)}`).join('\n'), priority: 3 });
      } catch (e) {
        logger.debug('code retrieval skipped', { error: (e as Error).message });
      }
    }

    try {
      const experience = await memory.retrieve({ text: item.objective.slice(0, 500), scope: { role: item.role }, limit: 5 });
      if (experience.length > 0) out.push({ id: 'experience', title: 'Approved experience', content: experience.map((x) => `- (${x.kind}) ${clip(x.content, 400)}`).join('\n'), priority: 4 });
    } catch (e) {
      logger.debug('experience retrieval skipped', { error: (e as Error).message });
    }

    const mine = await evidence.query({ runId: run.runId, workItemId: item.workItemId });
    if (mine.length > 0) {
      out.push({ id: 'evidence', title: 'Evidence recorded by this work item', content: mine.slice(-20).map((e) => `- ${e.evidenceId} ${e.evidenceType}: ${clip(e.summary, 200)}`).join('\n'), priority: 3 });
    }
    const pinned = Object.entries(run.oracleRevisions);
    if (pinned.length > 0 && !item.expectedOutput) {
      const lines: string[] = [];
      for (const [id, rev] of pinned) {
        const o = await specs.getOracle(id, rev);
        if (o) lines.push(`- ${id}@${rev}: ${o.assertions.map((a) => `${a.assertionId} (${a.severity})`).join(', ')}`);
      }
      if (lines.length) out.push({ id: 'oracles', title: 'Oracles in force', content: lines.join('\n'), priority: 3 });
    }
    return out;
  }

  const currentEnvironment = (environmentId: string) => authoritativeEnvironment(deps, environmentId);

  /**
   * (conformance-3, I1) What the agent works against beyond the run's oracles and target environment, pinned in each
   * turn's ContextSnapshot so the FreshnessGuard re-validates it before every mutating action of the turn:
   *  - every registered environment's generation/build (an env.* action on ANY environment — not only the run target —
   *    is refused when that environment was restarted/redeployed since the turn started);
   *  - the current head of every record the item takes as input: findings as `finding` (always re-checked: a fix or
   *    test built on a finding that was rejected or superseded meanwhile is refused), other records as `record`
   *    (record resolver; checked for actions naming them);
   *  - the side-effect leases held by THIS claim for the item's in-flight operations (`lease`, `<owner>:<fencingToken>`):
   *    a mutating action is refused once another owner took one of them over.
   * Beyond these, the snapshot builder joins everything the agent OBSERVED through its tool calls (`observer`: files it
   * read or wrote, records it read or posted, metric windows, environment generations) when the composition gives it an
   * ObservationLog; the FreshnessGuard also sees the observations of the current turn.
   * The item's own work claim is NOT pinned here: a turn replayed after a crash runs under a new claim against the
   * snapshot it was recorded with; the claim is fenced at dispatch and re-checked inside every record write (I4, H4).
   */
  async function observedReadSet(): Promise<ReadSetEntry[]> {
    const at = clock.isoNow();
    const exact = { kind: 'exact_version' } as const;
    const out: ReadSetEntry[] = await environmentReadSet(deps, run, at);
    for (const ref of item.inputRefs) {
      if (ref.kind !== 'record') continue;
      const rec = await blackboard.getRecord(ref.id);
      if (!rec || rec.runId !== run.runId) continue;
      const head = (await blackboard.head(rec.lineageId)) ?? rec;
      out.push({ resourceType: rec.recordType === 'finding' ? 'finding' : 'record', resourceId: rec.lineageId, observedVersion: head.recordId, observedAt: at, freshness: exact });
    }
    out.push(...(await heldLeases(at)));
    return out;
  }

  /** Live side-effect leases of the item's in-flight operations that the item's CURRENT claim owns. */
  async function heldLeases(at: string): Promise<ReadSetEntry[]> {
    const claim = (await blackboard.getWorkItem(item.workItemId))?.claim;
    if (!claim) return [];
    const owner = claimLeaseOwner(claim.ownerId, item.workItemId, claim.fencingToken);
    const out: ReadSetEntry[] = [];
    const seen = new Set<string>();
    for (const op of await deps.ledger.list({ runId: run.runId, workItemId: item.workItemId, status: IN_FLIGHT })) {
      if (!op.lease || seen.has(op.lease.resourceKey)) continue;
      seen.add(op.lease.resourceKey);
      const live = await deps.leases.current(op.lease.resourceKey);
      if (!live || live.owner !== owner) continue;
      out.push({ resourceType: 'lease', resourceId: live.resourceKey, observedVersion: `${live.owner}:${live.fencingToken}`, observedAt: at, freshness: { kind: 'exact_version' } });
    }
    return out;
  }

  /**
   * SOFT back-off: after a deferral at turn t the next soft attempt of the session waits until turn t + keepRecentTurns
   * + 2 (as many new turns as the due rule asks for), so a failing or hanging condenser never costs every turn its
   * deadline (HARD pressure still condenses whenever it arises). Read from L0: the deferrals of this session.
   */
  async function softRetryTurn(sessionId: string): Promise<number> {
    let retry = Number.NEGATIVE_INFINITY;
    for (const e of await events.read(run.runId, { types: [SOFT_CONDENSATION_DEFERRED] })) {
      const p = e.payload as { sessionId?: unknown; retryTurn?: unknown };
      if (p.sessionId === sessionId && typeof p.retryTurn === 'number' && p.retryTurn > retry) retry = p.retryTurn;
    }
    return retry;
  }

  /** Persists a compaction and its L0 event (context.compacted, with its level). */
  async function recordCompaction(sessionId: string, turn: number, compaction: Compaction): Promise<void> {
    await sessions.addCompaction(sessionId, compaction);
    await events.append([
      event(eventContext, 'context.compacted', 'context', sessionId, {
        sessionId, compactionId: compaction.compactionId, level: compaction.level, upToTurn: compaction.upToTurn, evidenceRefs: compaction.evidenceRefs, turn,
      }),
    ]);
  }

  return {
    async assemble({ sessionId, turn, transcript, compactions, signal }) {
      const epoch = await epochs.current(sessionId);
      // the observer: this agent's tool observations join the read set (when the builder has an ObservationLog)
      const buildInput: Parameters<typeof snapshotBuilder.build>[0] = { runId: run.runId, observer: { agentId: input.agentId } };
      if (epoch) buildInput.modelEpochId = epoch.epochId;
      const target = await targetEnvironment(deps, run);
      if (target) buildInput.environment = target;
      const readSet = await observedReadSet();
      if (readSet.length > 0) buildInput.readSet = readSet;
      const snapshot = await snapshotBuilder.build(buildInput, eventContext);
      turnState.turn = turn;
      turnState.snapshot = snapshot;

      const window = epoch && catalog ? catalog.get(epoch.routeId)?.contextWindow : undefined;
      const viewBudget = config.maxInlineContextTokens ?? (window ? Math.floor(window * 0.6) : DEFAULT_VIEW_TOKENS);
      let view = workingContext.view({ transcript, compactions, budgetTokens: viewBudget });
      const keepRecentTurns = workingContext.options?.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
      const condenserInput = { run, item, agentId: input.agentId, snapshotId: snapshot.snapshotId, eventContext };
      if (view.pressure === 'hard') {
        // HARD: mandatory — the LLM condenser, else the deterministic summarizer; the turn cannot go on without it
        const summarizer = condenserSummarizer(deps, condenserInput);
        const condenseInput: Parameters<typeof workingContext.condense>[0] = { transcript, compactions, level: 'hard', summarizer, budgetTokens: viewBudget, ids, now: clock.isoNow() };
        if (signal) condenseInput.signal = signal;
        const compaction = await workingContext.condense(condenseInput);
        await recordCompaction(sessionId, turn, compaction);
        view = workingContext.view({ transcript, compactions: [...compactions, compaction], budgetTokens: viewBudget });
      } else if (view.pressure === 'soft' && softCondensationDue({ transcript, compactions }, keepRecentTurns) && turn >= (await softRetryTurn(sessionId))) {
        // SOFT: deferrable — only with an available condenser route and enough turns since the last cut; any failure
        // (no route, failed or empty answer, nothing to condense, the soft deadline) defers it: the turn goes on as is,
        // and the next soft attempt of the session backs off (SOFT_CONDENSATION_DEFERRED on L0)
        let compaction: Compaction | undefined;
        const softSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(SOFT_CONDENSE_TIMEOUT_MS)]) : AbortSignal.timeout(SOFT_CONDENSE_TIMEOUT_MS);
        try {
          compaction = await workingContext.condense({ transcript, compactions, level: 'soft', summarizer: condenserSummarizer(deps, condenserInput, { fallback: false }), budgetTokens: viewBudget, ids, now: clock.isoNow(), signal: softSignal });
        } catch (e) {
          if (signal?.aborted) throw e;
          const retryTurn = turn + keepRecentTurns + 2;
          const reason = clip((e as Error)?.message ?? String(e), 500);
          logger.info('soft condensation deferred', { workItemId: item.workItemId, sessionId, turn, retryTurn, error: reason });
          try {
            await events.append([event(eventContext, SOFT_CONDENSATION_DEFERRED, 'context', sessionId, { sessionId, turn, retryTurn, reason })]);
          } catch (inner) {
            // the back-off is best effort: a deferral never fails the turn
            logger.warn('soft condensation deferral could not be recorded', { sessionId, turn, error: (inner as Error).message });
          }
        }
        if (compaction) {
          await recordCompaction(sessionId, turn, compaction);
          view = workingContext.view({ transcript, compactions: [...compactions, compaction], budgetTokens: viewBudget });
        }
      }
      const protocolContext = prepareProtocolContext(protocol, { taskId: run.runId, role: item.role, phase: role.phase }).render.content;
      const rolePrompt = `${agentHeader(item)}\n${renderRolePrompt(role, { objective: item.objective, runGoal: run.goal, protocol: protocolContext })}`;
      const assembled = assembler.assemble({
        rolePrompt,
        sections: await sections(),
        transcript: view.messages,
        budgetTokens: viewBudget + Math.min(SECTION_TOKENS, window ? Math.floor(window * 0.25) : SECTION_TOKENS) + estimateTokens([{ role: 'system', content: rolePrompt }]),
        snapshotId: snapshot.snapshotId,
      });
      return { messages: assembled.messages, tools: input.tools.definitions(), snapshot };
    },
  };
}

