import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { sha256Hex, type JsonValue } from '@hypertest/core';
import {
  type ActorRef,
  EFFECT_ORDER, RISK_ORDER, isTerminalWorkState,
  type ActionCapability, type ContextSnapshot, type EventContext, type RiskClass, type TestArtifact, type ToolCall, type ToolEffect, type ToolResultMessage,
} from '@hypertest/domain';
import { categoryDecision, classifyTestChange, holdsProductFix, parseUnifiedDiff, type ApprovalRequest, type SelfHealDecision, type TestChangeClassification } from '@hypertest/policy';
import { toolNameToId, type ToolExecutionRequest, type WorkspaceHandle } from '@hypertest/tools';
import type { DispatchResult, TerminalSignal, ToolDispatcher } from '@hypertest/runtime';
import type { ControlDeps } from './deps.ts';
import type { TurnState } from './context-provider.ts';
import { TERMINAL_TOOL_IDS } from './domain-tools/index.ts';
import { diffSections, invertSection, sectionPaths, unifiedDiff } from './diff.ts';
import { workLeaseKey } from './scheduler.ts';
import { ControlStore, type WorkspaceQuarantine } from './store.ts';
import { workScope } from './work-factory.ts';
import { clip, event, maxRisk } from './util.ts';

/** Tools whose effect on test code is classified BEFORE they execute (I8 self-heal governance). */
export const GOVERNED_TOOL_IDS: readonly string[] = ['fs.write', 'fs.apply_patch', 'git.commit'];

/**
 * Tools refused while a worktree is quarantined (besides every `execute` tool other than shell.exec): they would turn
 * an ungoverned test change into commits, registered artifacts or a completed work item.
 */
export const QUARANTINE_BLOCKED_TOOL_IDS: readonly string[] = ['git.commit', 'test_artifact.register', 'complete_work'];

/** The one execution tool still allowed in quarantine (to restore the files, e.g. `git checkout -- <path>`). */
const QUARANTINE_RESTORE_TOOL = 'shell.exec';

export interface DispatcherInput {
  runId: string;
  workItemId: string;
  agentId: string;
  role: string;
  sessionId: string;
  capability: ActionCapability;
  allow: string[];
  deny: string[];
  workspace: WorkspaceHandle;
  eventContext: EventContext;
  turnState: TurnState;
  /** The work-item claim this host was built for: a reassigned item refuses further tool calls (stale worker). */
  fencingToken?: number;
  /** The worktree's recorded quarantine (from the agent's host spec), if any. */
  quarantine?: WorkspaceQuarantine;
  /** The recorded pre-execution diff of a guarded call that was in flight when the previous host stopped. */
  guard?: { invocationId: string; before: string };
}

export type GovernanceVerdict =
  | { allowed: true; classification?: TestChangeClassification; paths: string[] }
  | { allowed: false; text: string; classification: TestChangeClassification; approvalId?: string };

function toolMessage(call: ToolCall, content: string, isError: boolean): ToolResultMessage {
  const m: ToolResultMessage = { role: 'tool', toolCallId: call.id, toolName: call.name, content };
  if (isError) m.isError = true;
  return m;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/**
 * The canonical workspace-relative path of `abs` (a path already confined to the workspace): `..`/`.` segments and
 * symlinks are resolved, so `test/../src/x.js` or a test-dir symlink into product code is classified as what it
 * really writes (I8: the classifier decides test vs product code by path).
 */
async function canonicalRel(root: string, abs: string): Promise<string> {
  const realRoot = await realpath(root).catch(() => root);
  const rest: string[] = [];
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      return toPosix(relative(realRoot, rest.length ? join(real, ...rest.reverse()) : real));
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return toPosix(relative(realRoot, abs));
      rest.push(basename(probe));
      probe = parent;
    }
  }
}

const DECISION_RANK: Record<SelfHealDecision, number> = { auto_allowed: 0, conditional: 1, approval_required: 2, forbidden: 3 };

/** Highest risk class among the offered tools (dynamic risks are evaluated on an empty input, else assumed high). */
export function offeredRisk(deps: ControlDeps, toolIds: string[]): RiskClass {
  const risks: RiskClass[] = [];
  for (const id of toolIds) {
    const spec = deps.registry.get(id);
    if (!spec) continue;
    if (typeof spec.riskClass !== 'function') risks.push(spec.riskClass);
    else {
      try {
        const r = spec.riskClass({} as never);
        risks.push(Object.hasOwn(RISK_ORDER, r) ? r : 'high');
      } catch {
        risks.push('high');
      }
    }
  }
  return maxRisk(risks);
}

/** The drift a command caused in a worktree, classified like a patch (files the base does not have are build outputs). */
export interface DriftVerdict {
  decision: SelfHealDecision;
  categories: string[];
  findings: string[];
  /** Section headers of the governed (test) files the command changed, with their pre-command text. */
  expected: Record<string, string>;
  paths: string[];
  /** Test paths changed in a merely conditional way (their artifacts need re-validation). */
  conditionalPaths: string[];
}

/**
 * Classifies what changed between two cumulative worktree diffs (before/after one command). A section that appeared
 * or changed is classified as is (base → now, conservative); a section that disappeared is classified as its inverse
 * (the command undid a change, e.g. deleted a test the run had added) — except a section brought back to the text a
 * quarantine recorded for it (`restoring`): that is the restoration the quarantine asks for. Test code is governed like a
 * patch; so is product code the base commit HAS (a command must not "fix" the product under test behind the fix
 * governance: the evidence would no longer be about the candidate); files the base does not have (build outputs,
 * caches, generated reports) are legitimate command effects and not classified.
 */
export function classifyDrift(before: string, after: string, productFixAuthorized: boolean, restoring?: Record<string, string>): DriftVerdict {
  const b = diffSections(before);
  const a = diffSections(after);
  const changed = [...new Set([...b.keys(), ...a.keys()])]
    .filter((k) => (a.get(k) ?? '') !== (b.get(k) ?? ''))
    // back to a quarantine's recorded pre-command text: undoing an ungoverned change is not a new change
    .filter((k) => !(restoring && Object.hasOwn(restoring, k) && (a.get(k) ?? '') === restoring[k]))
    .sort();
  const text = changed.map((k) => a.get(k) ?? invertSection(b.get(k)!)).join('');
  const classification = classifyTestChange(text, { productFixAuthorized });
  const isNewFile = (sec: string | undefined) => sec !== undefined && /^(?:new file mode |--- \/dev\/null$)/m.test(sec);
  const untracked = new Set(changed.filter((k) => isNewFile(a.get(k)) || isNewFile(b.get(k))).flatMap(sectionPaths));
  const governed = classification.findings.filter((f) => f.category !== 'product_code' || !untracked.has(f.file));
  let decision: SelfHealDecision = 'auto_allowed';
  for (const f of governed) {
    const d = categoryDecision(f.category, productFixAuthorized);
    if (DECISION_RANK[d] > DECISION_RANK[decision]) decision = d;
  }
  const blocking = governed.filter((f) => DECISION_RANK[categoryDecision(f.category, productFixAuthorized)] >= DECISION_RANK.approval_required);
  const conditional = governed.filter((f) => categoryDecision(f.category, productFixAuthorized) === 'conditional');
  const keysOf = (files: Set<string>, all: boolean) => changed.filter((k) => all || sectionPaths(k).some((p) => files.has(p)));
  const blockingFiles = new Set(blocking.map((f) => f.file));
  const expected: Record<string, string> = {};
  // an unattributable finding (unparseable diff) quarantines every changed section
  for (const k of keysOf(blockingFiles, blockingFiles.has(''))) expected[k] = b.get(k) ?? '';
  const paths = [...new Set(Object.keys(expected).flatMap(sectionPaths))].sort();
  const conditionalPaths = [...new Set(conditional.map((f) => f.file).filter((f) => f !== ''))].sort();
  return {
    decision,
    categories: [...new Set(governed.map((f) => f.category))].sort(),
    findings: governed.map((f) => `${f.file}${f.line !== undefined ? `:${f.line}` : ''} ${f.category}: ${f.detail}`),
    expected,
    paths,
    conditionalPaths,
  };
}

/** True when the worktree is back to the quarantine's recorded pre-command state for every governed section. */
export function quarantineLifted(q: WorkspaceQuarantine, currentDiff: string): boolean {
  if (q.expectedDiff !== undefined) return currentDiff === q.expectedDiff;
  const now = diffSections(currentDiff);
  return Object.entries(q.expected).every(([k, text]) => (now.get(k) ?? '') === text);
}

/**
 * The host's ToolDispatcher: every call goes through the governed ToolRuntime (capability → permit → freshness →
 * operation ledger → evidence → events) with the turn's ContextSnapshot. Before that, the dispatcher enforces the
 * agent's tool definitions, the work-item fence, the tool-call budget (I12) and, for workspace writes, test-change
 * governance (I8). Execution tools in a writable worktree are checked AFTER they run: a command that rewrote governed
 * test code quarantines the worktree until the files are restored.
 */
export function createToolDispatcher(deps: ControlDeps, input: DispatcherInput): ToolDispatcher {
  const { registry, toolRuntime, snapshots, sessions, budget, events, approvals, specs, workspaces, logger } = deps;
  const store = new ControlStore(deps.db);
  const definitions = registry.definitionsFor(input.capability, input.allow, input.deny);
  const offered = new Set(definitions.map((d) => d.name));
  const productFixAuthorized = holdsProductFix(input.capability);
  const ws = input.workspace;
  const driftGuarded = ws.kind === 'isolated_worktree' && !ws.readOnly && ws.baseCommit !== undefined;
  let quarantine: WorkspaceQuarantine | undefined = input.quarantine;
  let pendingGuard = input.guard;

  /**
   * The requesting agent as an approval subject: role and the model provider of its current epoch — what an independent
   * agent approver must differ from (I8; without the provider, independence can never be established: fail closed).
   */
  async function requester(): Promise<ActorRef> {
    const actor: ActorRef = { kind: 'agent', id: input.agentId, role: input.role };
    const epoch = await deps.epochs.current(input.sessionId);
    if (epoch?.provider) actor.modelProvider = epoch.provider;
    return actor;
  }

  async function snapshotFor(turn: number): Promise<ContextSnapshot | undefined> {
    if (input.turnState.turn === turn && input.turnState.snapshot) return input.turnState.snapshot;
    // replayed turn (no context assembly): the snapshot the turn was recorded against
    const record = await sessions.getTurn(input.sessionId, turn);
    if (record?.snapshotId) return snapshots.get(record.snapshotId);
    return input.turnState.snapshot;
  }

  function effectOf(toolId: string, args: unknown): ToolEffect | undefined {
    const spec = registry.get(toolId);
    if (!spec) return undefined;
    if (typeof spec.effect !== 'function') return spec.effect;
    try {
      const e = spec.effect(args as never);
      return Object.hasOwn(EFFECT_ORDER, e) ? e : 'execute';
    } catch {
      return 'execute';
    }
  }

  async function diffFor(toolId: string, args: Record<string, unknown>): Promise<string | undefined> {
    if (toolId === 'fs.write') {
      if (typeof args['path'] !== 'string' || typeof args['content'] !== 'string') return undefined;
      let abs: string;
      try {
        abs = await workspaces.resolvePath(ws, args['path']);
      } catch {
        return undefined; // the tool refuses the path itself (confinement)
      }
      // classify what is REALLY written: `test/../src/x.js` or a symlinked test path is product code
      const path = await canonicalRel(ws.root, abs);
      let old = '';
      let exists = true;
      try {
        old = await readFile(abs, 'utf8');
      } catch {
        exists = false;
      }
      return unifiedDiff(path, old, args['content'], { oldExists: exists });
    }
    if (toolId === 'fs.apply_patch') {
      if (args['check'] === true) return undefined; // validation only, nothing changes
      return typeof args['patch'] === 'string' ? args['patch'] : undefined;
    }
    if (toolId === 'git.commit') return workspaces.diff(ws);
    return undefined;
  }

  async function govern(toolId: string, args: Record<string, unknown>, invocationId: string): Promise<GovernanceVerdict> {
    const diff = await diffFor(toolId, args);
    if (diff === undefined || diff.trim() === '') return { allowed: true, paths: [] };
    const classification = classifyTestChange(diff, { productFixAuthorized });
    const paths = [...new Set(parseUnifiedDiff(diff).map((f) => f.newPath ?? f.oldPath).filter((p): p is string => p !== null))];
    const findings = classification.findings.map((f) => `${f.file}${f.line !== undefined ? `:${f.line}` : ''} ${f.category}: ${f.detail}`);
    const categories = classification.categories.join(', ');
    if (classification.decision === 'forbidden') {
      await events.append([
        event(input.eventContext, 'policy.decided', 'policy', invocationId, {
          decision: 'deny', reason: 'test_change_forbidden', toolId, invocationId, categories: classification.categories, findings: findings.slice(0, 20), paths,
        }),
      ]);
      return { allowed: false, classification, text: `forbidden test change (${categories}): ${findings.join('; ')}` };
    }
    if (classification.decision === 'approval_required') {
      const diffSha256 = sha256Hex(diff);
      const known = (await approvals.list({ runId: input.runId, status: ['pending', 'approved'] })).filter(
        (a: ApprovalRequest) => a.kind === 'test_change' && obj(a.subject)['diffSha256'] === diffSha256,
      );
      if (known.some((a) => a.status === 'approved')) return { allowed: true, classification, paths };
      const pending = known.find((a) => a.status === 'pending');
      const approval =
        pending ??
        (await approvals.request(
          {
            runId: input.runId,
            kind: 'test_change',
            subject: { toolId, invocationId, workItemId: input.workItemId, diffSha256, paths, categories: classification.categories, findings: findings.slice(0, 20), diff: clip(diff, 20_000) } as JsonValue,
            requestedBy: await requester(),
            rationale: `test change classified ${classification.decision} (${categories}) by the self-heal policy`,
          },
          input.eventContext,
        ));
      return {
        allowed: false,
        classification,
        approvalId: approval.approvalId,
        text: `test change requires independent approval (approvalId ${approval.approvalId}; ${categories}): ${findings.join('; ')}. The change was NOT applied; do not work around it.`,
      };
    }
    return { allowed: true, classification, paths };
  }

  /** A conditional test change invalidates the sensitivity proof of registered artifacts at those paths. */
  async function markDraft(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const wanted = new Set(paths.map(normalizeRel));
    for (const a of await specs.listTestArtifacts(input.runId)) {
      if (!wanted.has(normalizeRel(a.path)) || a.approvalState === 'draft') continue;
      const { revision: _r, createdAt: _c, supersedes: _s, ...rest } = a;
      const next: Omit<TestArtifact, 'revision' | 'createdAt'> = { ...rest, approvalState: 'draft', validations: {} };
      await specs.saveTestArtifact(next, input.eventContext);
      logger.info('test artifact reset to draft after a conditional test change', { artifactId: a.artifactId, path: a.path });
    }
  }

  /** The worktree diff, or an Error (the guard fails closed when it cannot see what a command did). */
  async function worktreeDiff(): Promise<string | Error> {
    try {
      return await workspaces.diff(ws);
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  }

  /** Lifts a quarantine whose files were restored; returns the refusal text while it holds. */
  async function quarantineRefusal(toolId: string): Promise<string | undefined> {
    if (!quarantine) return undefined;
    const now = await worktreeDiff();
    if (typeof now === 'string' && quarantineLifted(quarantine, now)) {
      logger.info('worktree quarantine lifted: governed files restored', { workItemId: input.workItemId, paths: quarantine.paths });
      quarantine = undefined;
      await store.setQuarantine(input.agentId, null);
      return undefined;
    }
    return `[denied] quarantined_worktree: ${toolId} is refused because ${quarantine.toolId} (invocation ${quarantine.invocationId}) changed governed code (${quarantine.categories.join(', ')}): ${quarantine.findings.slice(0, 10).join('; ')}. Restore exactly ${quarantine.paths.join(', ') || 'the changed files'} (e.g. shell.exec git checkout -- <path>, or remove files the command created), or finish with fail_work.`;
  }

  /** Post-execution I8 check of an execution tool in a writable worktree. Returns the refusal text on a violation. */
  async function checkDrift(toolId: string, invocationId: string, before: string): Promise<string | undefined> {
    const after = await worktreeDiff();
    if (typeof after === 'string' && after === before) return undefined;
    let verdict: DriftVerdict;
    if (typeof after !== 'string') {
      verdict = { decision: 'approval_required', categories: ['unknown'], findings: [`worktree diff unavailable after the command: ${after.message}`], expected: {}, paths: [], conditionalPaths: [] };
    } else {
      verdict = classifyDrift(before, after, productFixAuthorized, quarantine?.expected);
      if (verdict.decision === 'conditional') await markDraft(verdict.conditionalPaths);
      if (DECISION_RANK[verdict.decision] < DECISION_RANK.approval_required) {
        if (quarantine && quarantineLifted(quarantine, after)) {
          logger.info('worktree quarantine lifted: governed files restored', { workItemId: input.workItemId, paths: quarantine.paths, by: invocationId });
          quarantine = undefined;
          await store.setQuarantine(input.agentId, null);
        }
        return undefined;
      }
    }
    const q: WorkspaceQuarantine = { toolId, invocationId, categories: verdict.categories, findings: verdict.findings.slice(0, 20), paths: verdict.paths, expected: verdict.expected, at: deps.clock.isoNow() };
    if (typeof after !== 'string') q.expectedDiff = before;
    else if (quarantine) {
      // an earlier quarantine still holds: keep its (older) pre-command state for the sections it names
      q.expected = { ...q.expected, ...quarantine.expected };
      q.paths = [...new Set([...quarantine.paths, ...q.paths])].sort();
      if (quarantine.expectedDiff !== undefined) q.expectedDiff = quarantine.expectedDiff;
    }
    quarantine = q;
    await store.setQuarantine(input.agentId, q);
    await events.append([
      event(input.eventContext, 'policy.decided', 'policy', invocationId, {
        decision: 'deny', reason: verdict.decision === 'forbidden' ? 'test_change_forbidden' : 'test_change_unapproved', phase: 'post_execution', toolId, invocationId,
        categories: verdict.categories, findings: verdict.findings.slice(0, 20), paths: verdict.paths,
      }),
    ]);
    logger.warn('an execution tool changed governed code; worktree quarantined', { workItemId: input.workItemId, toolId, invocationId, categories: verdict.categories, paths: verdict.paths });
    return `[denied] ${verdict.decision === 'forbidden' ? 'forbidden' : 'unapproved'} change by ${toolId} (${verdict.categories.join(', ')}): ${verdict.findings.slice(0, 10).join('; ')}. The worktree is quarantined: test execution, commits, artifact registration and complete_work are refused until ${verdict.paths.join(', ') || 'the changed files'} are restored exactly (e.g. shell.exec git checkout -- <path>); otherwise finish with fail_work. Test and product code may only change through fs.write / fs.apply_patch (governed).`;
  }

  /** A dispatcher-level refusal: the call never reaches the ToolRuntime, but it is on L0 like any tool call (I10). */
  async function deny(call: ToolCall, toolId: string, invocationId: string, errorCode: string, text: string): Promise<DispatchResult> {
    await events.append([event(input.eventContext, 'tool.denied', 'tool', invocationId, { toolId, invocationId, status: 'denied', errorCode, reason: clip(text, 2000) })]);
    return { message: toolMessage(call, text, true) };
  }

  return {
    definitions: () => definitions,

    isParallelSafe(name) {
      const spec = registry.get(toolNameToId(name));
      return spec !== undefined && spec.effect === 'read';
    },

    async dispatch(call, meta): Promise<DispatchResult> {
      const toolId = toolNameToId(call.name);
      const invocationId = meta.invocationId ?? `${meta.sessionId}:${meta.turn}:${call.id}`;
      if (!offered.has(call.name)) {
        return deny(call, toolId, invocationId, 'not_offered', `[denied] tool ${call.name} is not available to this agent (not in its tool policy/capability)`);
      }
      if (input.fencingToken !== undefined) {
        // fencing (I4) before any effect: a worker whose claim was revoked (lease expired, item requeued, item ended by
        // a cancellation that kept the claim for the audit) acts no more
        const item = await deps.blackboard.getWorkItem(input.workItemId);
        const held = !!item?.claim && item.claim.fencingToken === input.fencingToken && (item.state === 'claimed' || item.state === 'running');
        if (!held || !(await deps.leases.checkFence(workLeaseKey(input.workItemId), input.fencingToken))) {
          const why = item && isTerminalWorkState(item.state) ? `work item ${input.workItemId} is ${item.state}` : `work item ${input.workItemId} is no longer held with fencing token ${input.fencingToken}`;
          await events.append([event(input.eventContext, 'tool.denied', 'tool', invocationId, { toolId, invocationId, status: 'denied', errorCode: 'lease_lost', reason: why })]);
          return { message: toolMessage(call, `[denied] lease_lost: ${why}; stop working on it`, true) };
        }
      }
      const args = obj(call.arguments);
      const effect = effectOf(toolId, call.arguments);
      const guarded = driftGuarded && effect === 'execute';
      if (quarantine && (QUARANTINE_BLOCKED_TOOL_IDS.includes(toolId) || (guarded && toolId !== QUARANTINE_RESTORE_TOOL))) {
        const refusal = await quarantineRefusal(toolId);
        if (refusal) return deny(call, toolId, invocationId, 'quarantined_worktree', refusal);
      }
      if (!TERMINAL_TOOL_IDS.includes(toolId)) {
        const charged = await budget.charge([workScope(input.workItemId)], { toolCalls: 1 }, `tool:${invocationId}`);
        if (!charged.ok) {
          await events.append([event(input.eventContext, 'budget.exhausted', 'budget', workScope(input.workItemId), { ...charged.exhausted, reason: 'tool_calls', invocationId, toolId })]);
          return deny(call, toolId, invocationId, 'budget_exhausted', `[denied] budget_exhausted: the tool-call budget of ${charged.exhausted.scope} is spent (${charged.exhausted.used}/${charged.exhausted.limit}); finish with complete_work or fail_work`);
        }
      }
      let verdict: GovernanceVerdict = { allowed: true, paths: [] };
      if (GOVERNED_TOOL_IDS.includes(toolId)) {
        verdict = await govern(toolId, args, invocationId);
        if (!verdict.allowed) return deny(call, toolId, invocationId, verdict.classification.decision === 'forbidden' ? 'test_change_forbidden' : 'approval_required', `[denied] ${verdict.text}`);
      }
      let before: string | undefined;
      if (guarded) {
        if (pendingGuard?.invocationId === invocationId) {
          // a re-dispatch after a crash: the first execution may already have changed the worktree
          before = pendingGuard.before;
        } else {
          const d = await worktreeDiff();
          if (typeof d !== 'string') {
            // fail closed: what the command does to test code could not be checked afterwards
            return deny(call, toolId, invocationId, 'governance_unavailable', `[denied] ${toolId} cannot run: the worktree diff needed for test-change governance is unavailable (${d.message})`);
          }
          before = d;
          await store.setGuard(input.agentId, { invocationId, before });
        }
      }
      const snapshot = await snapshotFor(meta.turn);
      const request: ToolExecutionRequest = {
        toolId,
        input: call.arguments,
        invocationId,
        runId: input.runId,
        workItemId: input.workItemId,
        agentId: input.agentId,
        role: input.role,
        capability: input.capability,
        workspace: ws,
        eventContext: input.eventContext,
        signal: meta.signal,
      };
      if (snapshot) request.snapshot = snapshot;
      const execution = await toolRuntime.execute(request);
      const drift = before !== undefined ? await checkDrift(toolId, invocationId, before) : undefined;
      if (before !== undefined) {
        pendingGuard = undefined;
        await store.setGuard(input.agentId, null);
      }
      const result: DispatchResult = {
        message: drift !== undefined
          ? toolMessage(call, `${drift}\n--- tool output ---\n${clip(execution.modelText, 4000)}`, true)
          : toolMessage(call, execution.modelText, execution.status !== 'success' && execution.status !== 'pending'),
        execution,
      };
      const structured = obj(execution.structured);
      if (execution.status === 'success' && TERMINAL_TOOL_IDS.includes(toolId) && structured['terminal']) {
        result.terminal = structured['terminal'] as TerminalSignal;
      }
      if (execution.status === 'pending' && execution.operationId) result.pendingOperationId = execution.operationId;
      if (execution.status === 'success' && verdict.allowed && verdict.classification?.decision === 'conditional') await markDraft(verdict.paths);
      if (toolId === 'test.run' && execution.status === 'success' && typeof structured['passed'] === 'boolean') {
        const totals = obj(structured['totals']);
        const payload = {
          selector: typeof args['selector'] === 'string' ? args['selector'] : '(all)',
          framework: structured['framework'],
          passed: typeof totals['passed'] === 'number' ? totals['passed'] : 0,
          failed: typeof totals['failed'] === 'number' ? totals['failed'] : 0,
          errors: typeof totals['error'] === 'number' ? totals['error'] : 0,
          total: typeof totals['total'] === 'number' ? totals['total'] : 0,
          harnessError: structured['harnessError'],
          evidenceIds: execution.evidenceRefs,
          toolInvocationId: invocationId,
        };
        await events.append([event(input.eventContext, structured['passed'] === true ? 'test.passed' : 'test.failed', 'tool', invocationId, payload)]);
      }
      return result;
    },
  };
}
