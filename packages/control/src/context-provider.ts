import { estimateTokens, textOf, type ChatMessage, type ContextSnapshot, type EventContext, type OperationStatus, type ReadSetEntry, type TestRun, type WorkItem } from '@hypertest/domain';
import {
  CONTEXT_HEADER, PromptAssembler, deterministicSummarizer, environmentVersion, findingWithdrawalVersion, planResourceId, shownLineEntries, softCondensationDue,
  type Compaction, type ObservedEntry, type PromptSection, type Summarizer,
} from '@hypertest/context';
import { prepareProtocolContext } from '@hypertest/policy';
import { renderRolePrompt, type RoleDefinition } from '@hypertest/agents';
import type { RouteRequest } from '@hypertest/model';
import type { ContextProvider, ToolDispatcher } from '@hypertest/runtime';
import type { WorkspaceHandle } from '@hypertest/tools';
import type { ControlDeps, ResolvedControlConfig } from './deps.ts';
import { summaryFor } from './clearance.ts';
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
  /**
   * (additive) A cap on this assembly's working-view budget (tokens), set by the worker when the remaining run/work
   * budget cannot hold the turn: the view's HARD/SOFT pressure is then measured against the budget, not only the window.
   */
  viewBudgetCap?: number;
  /** (additive) Tokens of the working view the last assembly produced (read by the worker's budget fit). */
  viewTokens?: number;
  /** (additive) The level of the compaction the last assembly made, if it made one. */
  compactedLevel?: 'soft' | 'hard';
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

/**
 * (B[5]) Token budget of each optional L1 section's content (the header is not counted): the assembler truncates a section to
 * its budget, then drops optional sections from the least important when the whole context does not fit; the task section
 * is required (truncated, never dropped).
 */
export const SECTION_BUDGETS = Object.freeze({ plan: 2500, blackboard: 3000, code: 1500, experience: 800, skills: 2000, evidence: 1000, oracles: 800, tools: 700 });

/** (B[2]) toolId of the observations a prompt delivered (ObservationLog source). */
export const PROMPT_OBSERVER_TOOL_ID = 'context.assemble';

/** Sections whose content carries versions that are pinned once delivered (left out when they cannot be recorded). */
const PINNED_SECTIONS: ReadonlySet<string> = new Set(['plan', 'blackboard', 'code', 'experience', 'skills', 'evidence', 'oracles']);

/** (B[2]) What a section delivers once `token` reaches the model: pinned entries, or workspace lines (content-verified pins). */
interface Delivery {
  section: string;
  token: string;
  entries?: ObservedEntry[];
  lines?: Array<{ path: string; line: number; text?: string }>;
}

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
        // the condensation is a model call of the run: its tokens AND its USD cost count against the run budget (a USD
        // budget that missed condenser calls could be overrun unseen)
        const charged: { tokens: number; costUsd?: number } = { tokens: used };
        if (typeof out.response.usage.costUsd === 'number' && Number.isFinite(out.response.usage.costUsd)) charged.costUsd = out.response.usage.costUsd;
        await budget.charge([runScope(input.run.runId)], charged, `condense:${input.item.workItemId}`).catch((e: unknown) => logger.error('the condenser call could not be charged to the run budget', { runId: input.run.runId, error: (e as Error).message }));
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

  /**
   * (B[0]/B[2]) The L1 sections of the turn and what each one DELIVERS: the versions of the records, findings, files,
   * evidence, plan, environments and oracles it shows. Once the assembled prompt is known, the deliveries whose token reached
   * the model are recorded in the ObservationLog under the turn's snapshot (see recordDeliveries): the FreshnessGuard then
   * validates every mutating action of the turn against them too, and the next snapshot pins them.
   * Section budgets (tokens, header excluded): SECTION_BUDGETS; the assembler drops optional sections from the least
   * important when the whole context does not fit.
   */
  async function sections(deliveries: Delivery[]): Promise<PromptSection[]> {
    const out: PromptSection[] = [];
    const at = clock.isoNow();
    const exact = { kind: 'exact_version' } as const;
    const pin = (resourceType: string, resourceId: string, observedVersion: string, freshness: ObservedEntry['freshness'] = exact): ObservedEntry => ({ kind: 'read', resourceType, resourceId, observedVersion, observedAt: at, freshness });
    // what this agent observed before (its latest observation per resource): the prompt tells it what changed since
    const known = deps.observations ? await deps.observations.latest({ runId: run.runId, agentId: input.agentId }).catch(() => []) : [];
    const knownVersion = new Map(known.map((o) => [`${o.resourceType}\u0000${o.resourceId}`, o.observedVersion]));
    /**
     * Pins of a record head the prompt shows: its lineage version as `record` (re-checked for the actions that name the
     * lineage) and, for a finding, its withdrawal state (`finding_withdrawal`: ALWAYS re-checked — B[2]). The always-checked
     * `finding` version is pinned only for a finding the agent acts on — a work item input (`acting`), or one it already
     * holds as `finding` (read in full or posted): it is told the current version. (review) A finding merely LISTED among the
     * open records is not pinned as `finding`: any update of any of up to 60 listed findings (a review confirming one, new
     * evidence) would otherwise refuse every mutating action of every agent that saw the list.
     */
    const recordPins = (rec: { recordType: string; lineageId: string; recordId: string; payload: unknown }, acting = false): ObservedEntry[] => {
      const out = [pin('record', rec.lineageId, rec.recordId)];
      if (rec.recordType !== 'finding') return out;
      if (acting || knownVersion.has(`finding\u0000${rec.lineageId}`)) out.push(pin('finding', rec.lineageId, rec.recordId));
      out.push(pin('finding_withdrawal', rec.lineageId, findingWithdrawalVersion({ payload: rec.payload }) ?? 'active'));
      return out;
    };

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
    // environments: their generation/build as of this turn (a redeploy since the agent last saw one is called out)
    const envLines: string[] = [];
    for (const listed of environments.list().slice(0, 20)) {
      const env = await authoritativeEnvironment(deps, listed.environmentId);
      if (!env) continue;
      const version = environmentVersion(env);
      const before = knownVersion.get(`environment\u0000${env.environmentId}`);
      const token = `Environment ${env.environmentId}: generation ${env.generation}`;
      envLines.push(`${token}${env.buildDigest ? `, build ${env.buildDigest}` : ''}${before !== undefined && before !== version ? ` (CHANGED since you last saw it: was ${before})` : ''}`);
      deliveries.push({ section: 'task', token, entries: [pin('environment', env.environmentId, version)] });
    }
    if (envLines.length > 0) task.push(`Environments:\n${envLines.map((l) => `- ${l}`).join('\n')}`);
    out.push({ id: 'task', title: 'Task', content: task.join('\n\n'), priority: 0, required: true });

    if (item.role === 'lead' || item.role === 'reviewer') {
      const plan = await blackboard.latestAcceptedPlan(run.runId);
      const items = await blackboard.listWorkItems({ runId: run.runId });
      const planToken = plan ? `Plan v${plan.revision} ` : 'No plan revision accepted yet.';
      const lines = [plan ? `${planToken}(readyForGate ${plan.readyForGate}): ${clip(plan.rationale, 600)}` : planToken];
      deliveries.push({ section: 'plan', token: planToken, entries: [pin('plan', planResourceId(run.runId), String(plan?.revision ?? 0))] });
      for (const o of plan?.objectives ?? []) lines.push(`- objective ${o.objectiveId} [${o.priority}, ${o.status}] ${clip(o.description, 300)}`);
      lines.push('Work items:');
      for (const w of items.slice(-60)) lines.push(`- ${w.workItemId} ${w.role} [${w.state}] ${clip(w.title, 120)}${w.result ? ` — ${clip(summaryFor(deps.roles, item.role, w.role, w.result.summary), 200)}` : ''}`);
      out.push({ id: 'plan', title: 'Plan & objectives', content: lines.join('\n'), priority: 1, maxTokens: SECTION_BUDGETS.plan });
    }

    const open = await blackboard.query<Record<string, unknown>>({ runId: run.runId, recordType: ['finding', 'risk', 'hypothesis', 'coverage_gap'], status: ['open', 'confirmed', 'supported'] });
    const bb: string[] = [];
    const shown = new Set<string>();
    const label = (recordType: string, p: Record<string, unknown>) =>
      recordType === 'finding' ? `[${String(p['severity'])}, ${String(p['category'])}, ${String(p['status'])}] ${String(p['title'])}` : recordType === 'risk' ? `[${String(p['level'])}, ${String(p['status'])}] ${String(p['title'])}` : recordType === 'hypothesis' ? `[${String(p['status'])}] ${clip(String(p['statement']), 200)}` : recordType === 'coverage_gap' ? `[${String(p['status'])}] ${String(p['area'])}` : clip(JSON.stringify(p), 200);
    const changedNote = (type: string, lineageId: string, recordId: string) => {
      const before = knownVersion.get(`${type}\u0000${lineageId}`) ?? knownVersion.get(`record\u0000${lineageId}`);
      return before !== undefined && before !== recordId ? ` (UPDATED since you saw ${before})` : '';
    };
    for (const r of open.slice(-60)) {
      const type = r.recordType === 'finding' ? 'finding' : 'record';
      bb.push(`- ${r.recordType} ${r.recordId}: ${clip(label(r.recordType, r.payload), 300)}${r.evidenceRefs.length ? ` (evidence ${r.evidenceRefs.join(', ')})` : ''}${changedNote(type, r.lineageId, r.recordId)}`);
      deliveries.push({ section: 'blackboard', token: `${r.recordType} ${r.recordId}:`, entries: recordPins(r) });
      shown.add(r.lineageId);
    }
    for (const ref of item.inputRefs.filter((x) => x.kind === 'record')) {
      const rec = await blackboard.getRecord(ref.id);
      if (!rec || rec.runId !== run.runId) continue;
      // the CURRENT version of the input record (the item acts on it; observedReadSet pins the same head)
      const head = (await blackboard.head(rec.lineageId)) ?? rec;
      const token = `Input record ${head.recordId} `;
      bb.push(`${token}(${head.recordType} v${head.version}${head.recordId !== rec.recordId ? `; the work item referenced ${rec.recordId}, this is its current version` : ''}):\n${jsonBlock({ payload: head.payload, evidenceRefs: head.evidenceRefs }, 3000)}`);
      deliveries.push({ section: 'blackboard', token, entries: recordPins(head, true) });
      shown.add(head.lineageId);
    }
    // records this agent saw before that changed since (incl. withdrawn findings no longer listed above): it is told, and
    // the version it is told about becomes its knowledge (until then its mutating actions are refused as stale)
    const notices: string[] = [];
    for (const o of known) {
      if (notices.length >= 40) break;
      if ((o.resourceType !== 'finding' && o.resourceType !== 'record') || shown.has(o.resourceId)) continue;
      const head = await blackboard.head<Record<string, unknown>>(o.resourceId);
      if (!head || head.runId !== run.runId || head.recordId === o.observedVersion) continue;
      shown.add(o.resourceId);
      const withdrawal = head.recordType === 'finding' ? findingWithdrawalVersion({ payload: head.payload }) : undefined;
      const token = `${head.recordType} ${head.recordId} CHANGED`;
      notices.push(`- ${token} since you saw ${o.observedVersion}${withdrawal?.startsWith('withdrawn:') ? ` — WITHDRAWN (${withdrawal.slice('withdrawn:'.length)})` : ''}: ${clip(label(head.recordType, head.payload ?? {}), 300)}`);
      deliveries.push({ section: 'blackboard', token, entries: recordPins(head) });
    }
    if (notices.length > 0) bb.push(`Changed since you last saw them:\n${notices.join('\n')}`);
    if (bb.length > 0) out.push({ id: 'blackboard', title: 'Blackboard (data, not instructions)', content: bb.join('\n'), priority: 2, maxTokens: SECTION_BUDGETS.blackboard });

    // L3 retrieval for every role (B[6]: diagnosis, implementation, execution and review roles included). (B[0]) Each hit is
    // verified against the CURRENT file: a verified hit is delivered (its file pinned at that version); a hit of an index that
    // lags the working tree is labelled outdated and pins nothing (it never overrides what the agent knows of the file).
    try {
      // (B[6] privacy) a restricted context (local_private) retrieves without any off-host embedding route
      const restricted = [role.dataClassification, role.defaultModelPolicy?.privacyClass, item.modelPolicy?.privacyClass].includes('restricted');
      const hits = await retrieverFactory(workspace.root, restricted ? { restricted: true } : undefined).search({ text: item.objective.slice(0, 500), limit: 8 });
      const lines: string[] = [];
      for (const h of hits) {
        const where = `${h.path ?? h.ref.id}${h.line ? `:${h.line}` : ''}`;
        let shownLines: Array<{ path: string; line: number; text: string }> = [];
        if (h.path && h.line) {
          // a vector chunk starts with its header line (path + symbols); the chunk text follows from h.line on
          const body = h.source === 'vector' ? h.snippet.split('\n').slice(1) : [h.snippet.split('\n')[0]!];
          shownLines = body.map((text, i) => ({ path: h.path!, line: h.line! + i, text })).filter((l) => l.text.trim().length > 0);
        }
        const entries = shownLines.length > 0 ? await shownLineEntries(workspace, shownLines, `${input.agentId}:prompt`, at, 'skip') : [];
        const outdated = shownLines.length > 0 && entries.length === 0;
        lines.push(`- ${where} — ${clip(h.snippet, 300)}${outdated ? ' (index outdated: fs.read the file for its current content)' : ''}`);
        if (entries.length > 0) deliveries.push({ section: 'code', token: `- ${where} — `, entries });
      }
      if (lines.length > 0) out.push({ id: 'code', title: 'Relevant code (retrieval: symbols, exact search, vectors)', content: lines.join('\n'), priority: 3, maxTokens: SECTION_BUDGETS.code });
    } catch (e) {
      logger.debug('code retrieval skipped', { error: (e as Error).message });
    }

    try {
      const experience = await memory.retrieve({ text: item.objective.slice(0, 500), scope: { role: item.role }, limit: 5 });
      if (experience.length > 0) {
        out.push({ id: 'experience', title: 'Durable memory (approved experience)', content: experience.map((x) => `- ${x.experienceId} (${x.kind}) ${clip(x.content, 400)}`).join('\n'), priority: 4, maxTokens: SECTION_BUDGETS.experience });
        for (const x of experience) deliveries.push({ section: 'experience', token: `- ${x.experienceId} `, entries: [pin('experience', x.experienceId, x.experienceId, { kind: 'immutable' })] });
      }
    } catch (e) {
      logger.debug('experience retrieval skipped', { error: (e as Error).message });
    }

    // (B[7]) published skills of the active registry only (a candidate skill never reaches a prompt)
    if (deps.skills) {
      try {
        const skills = await deps.skills.forPrompt({ role: item.role, text: `${item.title}\n${item.objective}`.slice(0, 1000), limit: 3 });
        if (skills.length > 0) {
          out.push({ id: 'skills', title: 'Skills (published, validated by eval)', content: skills.map((k) => `### ${k.name} (${k.skillId} r${k.revision})\n${k.description}\n${clip(k.body, 2000)}`).join('\n\n'), priority: 3, maxTokens: SECTION_BUDGETS.skills });
          for (const k of skills) deliveries.push({ section: 'skills', token: `(${k.skillId} r${k.revision})`, entries: [pin('skill', k.skillId, `${k.revision}:${k.digest}`, { kind: 'immutable' })] });
        }
      } catch (e) {
        logger.debug('skill retrieval skipped', { error: (e as Error).message });
      }
    }

    const mine = await evidence.query({ runId: run.runId, workItemId: item.workItemId });
    if (mine.length > 0) {
      const shownEvidence = mine.slice(-20);
      out.push({ id: 'evidence', title: 'Evidence recorded by this work item', content: shownEvidence.map((e) => `- ${e.evidenceId} ${e.evidenceType}: ${clip(e.summary, 200)}`).join('\n'), priority: 3, maxTokens: SECTION_BUDGETS.evidence });
      for (const e of shownEvidence) deliveries.push({ section: 'evidence', token: `- ${e.evidenceId} `, entries: [pin('evidence', e.evidenceId, e.evidenceId, { kind: 'immutable' })] });
    }
    const pinned = Object.entries(run.oracleRevisions);
    if (pinned.length > 0 && !item.expectedOutput) {
      const lines: string[] = [];
      for (const [id, rev] of pinned) {
        const o = await specs.getOracle(id, rev);
        if (!o) continue;
        lines.push(`- ${id}@${rev}: ${o.assertions.map((a) => `${a.assertionId} (${a.severity})`).join(', ')}`);
        deliveries.push({ section: 'oracles', token: `- ${id}@${rev}:`, entries: [pin('oracle', id, String(rev))] });
      }
      if (lines.length) out.push({ id: 'oracles', title: 'Oracles in force', content: lines.join('\n'), priority: 3, maxTokens: SECTION_BUDGETS.oracles });
    }

    // (B[5]) the tools this agent may call (the definitions travel with the request; this is the compact index)
    const toolLines = input.tools.definitions().map((d) => {
      const id = d.name.replaceAll('__', '.');
      const spec = deps.registry.get(id);
      const effect = spec ? (typeof spec.effect === 'function' ? 'varies' : spec.effect) : 'unknown';
      return `- ${id} (${effect})`;
    });
    if (toolLines.length > 0) {
      out.push({ id: 'tools', title: 'Available tools (capability-checked; mutating tools are freshness-checked against what you observed)', content: toolLines.join('\n'), priority: 5, maxTokens: SECTION_BUDGETS.tools });
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

  /**
   * Persists a compaction and its L0 event (context.compacted) in ONE transaction. (B[8]) The event carries the whole
   * compaction (summary, createdAt, summary artifact): L0 alone rebuilds the working context (rebuildWorkingContext).
   */
  async function recordCompaction(sessionId: string, turn: number, compaction: Compaction): Promise<void> {
    await deps.db.transaction(async (tx) => {
      await sessions.addCompaction(sessionId, compaction);
      await events.append([
        event(eventContext, 'context.compacted', 'context', sessionId, {
          sessionId, compactionId: compaction.compactionId, level: compaction.level, upToTurn: compaction.upToTurn, evidenceRefs: compaction.evidenceRefs, turn,
          summary: compaction.summary, createdAt: compaction.createdAt, summaryArtifact: compaction.summaryArtifact,
        }),
      ], tx);
    });
    turnState.compactedLevel = compaction.level === 'soft' ? 'soft' : 'hard';
  }

  /**
   * (B[0]/B[2]) Records what the assembled prompt DELIVERED (the deliveries whose token is in the context message the model
   * receives — a dropped or truncated-away section delivers nothing) as `read` observations of this agent under the turn's
   * snapshot (toolId `context.assemble`). Returns false when they cannot be recorded (the caller then leaves the versioned
   * sections out: fail closed). No ObservationLog ⇒ nothing to record (true).
   */
  async function recordDeliveries(sessionId: string, turn: number, snapshot: ContextSnapshot, assembled: { messages: ChatMessage[] }, deliveries: Delivery[]): Promise<boolean> {
    const log = deps.observations;
    if (!log || deliveries.length === 0) return true;
    const contextMessage = assembled.messages.find((m) => m.role === 'user' && textOf(m).startsWith(CONTEXT_HEADER));
    const text = contextMessage ? textOf(contextMessage) : '';
    try {
      const entries: ObservedEntry[] = [];
      const lines: Array<{ path: string; line: number; text?: string }> = [];
      for (const d of deliveries) {
        if (!text.includes(d.token)) continue;
        if (d.entries) entries.push(...d.entries);
        if (d.lines) lines.push(...d.lines);
      }
      if (lines.length > 0) entries.push(...(await shownLineEntries(workspace, lines, `${sessionId}:${turn}:prompt`, clock.isoNow())));
      if (entries.length === 0) return true;
      const source: Parameters<typeof log.record>[0] = { runId: run.runId, agentId: input.agentId, workItemId: item.workItemId, snapshotId: snapshot.snapshotId, toolId: PROMPT_OBSERVER_TOOL_ID, invocationId: `${sessionId}:${turn}:prompt` };
      await log.record(source, entries);
      return true;
    } catch (e) {
      logger.error('prompt deliveries could not be recorded in the read set; versioned sections withheld (fail closed)', { workItemId: item.workItemId, sessionId, turn, error: (e as Error).message });
      return false;
    }
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
      delete turnState.compactedLevel;

      const window = epoch && catalog ? catalog.get(epoch.routeId)?.contextWindow : undefined;
      const windowBudget = config.maxInlineContextTokens ?? (window ? Math.floor(window * 0.6) : DEFAULT_VIEW_TOKENS);
      const viewBudget = turnState.viewBudgetCap !== undefined && turnState.viewBudgetCap > 0 ? Math.min(windowBudget, Math.floor(turnState.viewBudgetCap)) : windowBudget;
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
      turnState.viewTokens = view.tokens;
      const protocolContext = prepareProtocolContext(protocol, { taskId: run.runId, role: item.role, phase: role.phase }).render.content;
      const rolePrompt = `${agentHeader(item)}\n${renderRolePrompt(role, { objective: item.objective, runGoal: run.goal, protocol: protocolContext })}`;
      const deliveries: Delivery[] = [];
      const built = await sections(deliveries);
      const assemblyInput = {
        rolePrompt,
        sections: built,
        transcript: view.messages,
        budgetTokens: viewBudget + Math.min(SECTION_TOKENS, window ? Math.floor(window * 0.25) : SECTION_TOKENS) + estimateTokens([{ role: 'system', content: rolePrompt }]),
        snapshotId: snapshot.snapshotId,
      };
      let assembled = assembler.assemble(assemblyInput);
      if (!(await recordDeliveries(sessionId, turn, snapshot, assembled, deliveries))) {
        // fail closed: what the prompt would show cannot be pinned, so the sections carrying versioned content are left out
        assembled = assembler.assemble({ ...assemblyInput, sections: built.filter((x) => !PINNED_SECTIONS.has(x.id)) });
      }
      return { messages: assembled.messages, tools: input.tools.definitions(), snapshot };
    },
  };
}

