import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { isHypertestError, sha256Hex, type JsonValue, type SqlExecutor } from '@hypertest/core';
import {
  type ActorRef,
  EFFECT_ORDER, EVENT_TYPES, RISK_ORDER, isTerminalWorkState,
  type ActionCapability, type ContextSnapshot, type EventContext, type RiskClass, type TestArtifact, type ToolCall, type ToolEffect, type ToolResultMessage, type WorkClaim,
} from '@hypertest/domain';
import { categoryDecision, classifyTestChange, holdsProductFix, parseUnifiedDiff, type ApprovalRequest, type SelfHealDecision, type TestChangeClassification } from '@hypertest/policy';
import { toolNameToId, type ToolExecutionRequest, type WorkspaceHandle } from '@hypertest/tools';
import type { BudgetExhaustion, LedgerOperationRecord } from '@hypertest/operation';
import type { DispatchResult, TerminalSignal, ToolDispatcher } from '@hypertest/runtime';
import type { ControlDeps } from './deps.ts';
import { roleClassification } from './clearance.ts';
import type { TurnState } from './context-provider.ts';
import { TERMINAL_TOOL_IDS } from './domain-tools/index.ts';
import { approvalWaitOperationId } from './approvals.ts';
import { diffSections, invertSection, sectionPaths, unifiedDiff } from './diff.ts';
import { workLeaseKey } from './scheduler.ts';
import { ControlStore, type WorkspaceQuarantine } from './store.ts';
import { WorkFactory, workScope } from './work-factory.ts';
import { clip, event, maxRisk } from './util.ts';
import { POLICY_FLAGGED_EVENT, createPhaseGovernor, flagEventId, type ActionDescription } from './phases.ts';
import {
  EXPERIMENT_EXEMPT_TOOLS, EXPERIMENT_GUARDED_EFFECTS, JOB_MAY_RUN, QPS_REASON_PREFIX, admitEffectClaim, callScopes, declaredExperimentIds, exhaustedScope, experimentActionCheck,
  experimentClaimsProblem, experimentResourceProblem, lastingEffectMs, onToolBudgetExhausted, qpsJobMayRun, qpsKey, releaseEffectClaims, settleExternalQps,
} from './isolation.ts';
import { experimentScope } from './domain-tools/specs.ts';

/** (E[1]) Slack added to an effect claim's TTL beyond the call's timeout (+ the effect's own duration). */
export const EFFECT_CLAIM_MARGIN_MS = 5_000;

/**
 * (E[1]) Whether a call's effect claim must outlive the call: a time-boxed effect that started (a fault in force, a load
 * job), an effect whose outcome is not settled (pending, a timeout, an unsettled or manual-review operation) — the claim
 * then expires with its TTL. Released at once otherwise (nothing happened, or the effect is complete).
 */
export function effectClaimOutlivesCall(execution: { status: string; operationId?: string; structured?: unknown }, lastingMs: number | undefined): boolean {
  if (execution.status === 'success') return lastingMs !== undefined;
  if (execution.status === 'pending' || execution.status === 'timeout') return true;
  if (execution.status !== 'failed') return false;
  const opStatus = obj(execution.structured)['operationStatus'];
  return execution.operationId !== undefined && (typeof opStatus !== 'string' || JOB_MAY_RUN.has(opStatus));
}

/** (review B2) Re-reservations of one load.start invocation's rate before the call is refused (fail closed). */
const MAX_QPS_REKEYS = 16;

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
  /** (durability-2) The turn's claim state: once `lost` is set (resource claims taken), every further call is refused. */
  claimGuard?: { lost?: string };
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

/**
 * (H4) Owner of the side-effect leases a tool call takes under a work claim: `<workerId>:<workItemId>:<fencingToken>`. A
 * re-granted claim (new token) is a different owner, so a stale worker never shares the live claim's resource lease.
 */
export function claimLeaseOwner(workerId: string, workItemId: string, fencingToken: number): string {
  return `${workerId}:${workItemId}:${fencingToken}`;
}

/**
 * (E[0], I4) The commit-point check of the external effects of a call made under a work claim — handed to the
 * SideEffectGateway as `commitGuard` and run INSIDE the transaction that records `→ dispatching`: the run's work-creation
 * lock (lock order, as the fenced domain tools), then the work item row is locked by a change-free fenced transition (the
 * claim must still carry the token and the item be claimed/running), then the claim's lease must still be the live one.
 * A requeue, a takeover or a cancellation that commits first refuses the effect atomically (nothing is sent: 0 successes
 * for an expired worker); one that commits after it waits for this transaction (the effect was decided while the claim
 * was held). The exact reason, or undefined while the claim is held.
 */
export function claimCommitGuard(deps: ControlDeps, claim: { runId: string; workItemId: string; fencingToken: number }, ctx: EventContext): (tx: SqlExecutor) => Promise<string | undefined> {
  const factory = new WorkFactory(deps);
  const { runId, workItemId, fencingToken } = claim;
  return async (tx) => {
    await factory.lock(runId, tx);
    const item = await deps.blackboard.getWorkItem(workItemId);
    if (!item || item.runId !== runId) return `work item ${workItemId} is not a work item of run ${runId}`;
    if (!item.claim || item.claim.fencingToken !== fencingToken) return `work item ${workItemId} is no longer held with fencing token ${fencingToken} (current claim: ${item.claim ? `token ${item.claim.fencingToken} of ${item.claim.ownerId}` : 'none'}, state ${item.state})`;
    if (item.state !== 'claimed' && item.state !== 'running') return `work item ${workItemId} is ${item.state}`;
    try {
      await deps.blackboard.transitionWorkItem(workItemId, item.state, {}, { ...ctx, runId, workItemId }, { expectedFencingToken: fencingToken, expectedFrom: ['claimed', 'running'], tx });
    } catch (e) {
      if (isHypertestError(e, 'stale_fence') || isHypertestError(e, 'conflict') || isHypertestError(e, 'precondition_failed')) return `work item ${workItemId}: ${e.message}`;
      throw e;
    }
    if (!(await deps.leases.checkFence(workLeaseKey(workItemId), fencingToken))) return `the work lease of ${workItemId} with fencing token ${fencingToken} is no longer the live one (expired or taken over)`;
    return undefined;
  };
}

/** (H5) The deterministic event id of a test.run invocation's `test.passed` / `test.failed` event. */
export function testOutcomeEventId(invocationId: string): string {
  return `evt_test_${sha256Hex(`test.outcome\u0000${invocationId}`).slice(0, 32)}`;
}

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
  const phases = createPhaseGovernor(deps, deps.config);
  const definitions = registry.definitionsFor(input.capability, input.allow, input.deny);
  const offered = new Set(definitions.map((d) => d.name));
  const productFixAuthorized = holdsProductFix(input.capability);
  const ws = input.workspace;
  const driftGuarded = ws.kind === 'isolated_worktree' && !ws.readOnly && ws.baseCommit !== undefined;
  let quarantine: WorkspaceQuarantine | undefined = input.quarantine;
  let pendingGuard = input.guard;
  /**
   * (conformance-6) Experiments this item runs for: declared (inputRefs) + defined by this agent. `known` are experiments
   * of this run (the only ones a call is attributed to); a declared id unknown to the run is kept in `all`, so write/fault
   * calls fail closed on it. Reset by experiment.define.
   */
  let experimentsCache: { all: string[]; known: string[] } | undefined;

  async function itemExperiments(): Promise<{ all: string[]; known: string[] }> {
    if (experimentsCache === undefined) {
      const item = await deps.blackboard.getWorkItem(input.workItemId);
      const declared = item ? declaredExperimentIds(item) : [];
      const ofRun = await specs.listExperiments(input.runId);
      const defined = ofRun.filter((e) => e.createdBy === input.agentId).map((e) => e.experimentId);
      const all = [...new Set([...declared, ...defined])];
      const runIds = new Set(ofRun.map((e) => e.experimentId));
      experimentsCache = { all, known: all.filter((id) => runIds.has(id)) };
    }
    return experimentsCache;
  }

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

  /** How the call is classified when its before_action decision is not on record (best effort; failures fail closed). */
  function describeAction(toolId: string, args: unknown): ActionDescription {
    const spec = registry.get(toolId);
    const out: ActionDescription = { effect: effectOf(toolId, args) ?? 'execute', riskClass: 'high', resources: [] };
    if (!spec) return out;
    try {
      const r = typeof spec.riskClass === 'function' ? spec.riskClass(args as never) : spec.riskClass;
      if (Object.hasOwn(RISK_ORDER, r)) out.riskClass = r;
    } catch {
      // unknown risk: high
    }
    try {
      out.resources = spec.resources(args as never, { workspace: ws, runId: input.runId, environments: deps.environments });
    } catch {
      out.resources = [];
    }
    try {
      const c = spec.environmentClass?.(args as never, { environments: deps.environments });
      if (c !== undefined) out.environmentClass = c;
    } catch {
      // no environment class
    }
    return out;
  }

  /**
   * BUGate after_action: what the executed call produced is judged (e.g. evidence of a type its tool does not declare).
   * A flagged call gets a note in its result (the model sees why its evidence will not back a completion). The action
   * already happened: a failure of the check never re-runs it — it is flagged instead (fail closed), best effort.
   */
  async function afterAction(toolId: string, invocationId: string, args: unknown, execution: Awaited<ReturnType<typeof toolRuntime.execute>>, snapshotId: string | undefined): Promise<string | undefined> {
    try {
      const judged = await phases.afterAction({
        runId: input.runId, workItemId: input.workItemId, agentId: input.agentId, role: input.role, capability: input.capability, toolId, invocationId, execution,
        eventContext: input.eventContext, ...(snapshotId !== undefined ? { snapshotId } : {}), describe: () => describeAction(toolId, args),
      });
      if (!judged?.flagged) return undefined;
      return `[flagged after action by policy decision ${judged.permit.decisionId} (${judged.permit.decision}): ${judged.permit.reasons.join('; ') || 'no reason given'}${judged.facts.undeclaredEvidenceTypes.length ? `; undeclared evidence types: ${judged.facts.undeclaredEvidenceTypes.join(', ')}` : ''}. This work item can no longer complete on it.]`;
    } catch (e) {
      logger.error('after_action policy check failed; flagging the call (fail closed)', { toolId, invocationId, error: (e as Error).message });
      try {
        const eventId = flagEventId(invocationId);
        if (!(await events.get(eventId))) {
          await events.append([{ ...event(input.eventContext, POLICY_FLAGGED_EVENT, 'policy', invocationId, { phase: 'after_action', decision: 'deny', toolId, invocationId, reasons: [`after_action_unavailable: ${clip((e as Error).message, 500)}`] }), eventId }]);
        }
      } catch (inner) {
        logger.error('the after_action flag could not be recorded', { toolId, invocationId, error: (inner as Error).message });
      }
      return `[flagged after action: the policy check could not be completed (${clip((e as Error).message, 300)})]`;
    }
  }

  /**
   * (addendum, D-0) A precise hint when a test file the run executed differs from the content its test artifact was
   * registered with: that run's evidence will not count for the artifact (nor for the gate) until it is re-registered and
   * validated again.
   */
  async function artifactDriftHint(structured: Record<string, unknown>): Promise<string | undefined> {
    const files = (obj(structured['executedTests'])['files'] ?? []) as unknown[];
    if (!Array.isArray(files) || files.length === 0) return undefined;
    const artifacts = await specs.listTestArtifacts(input.runId);
    const notes: string[] = [];
    for (const f of files) {
      const rec = obj(f);
      const path = typeof rec['path'] === 'string' ? normalizeRel(rec['path']) : undefined;
      if (path === undefined) continue;
      const a = artifacts.find((x) => normalizeRel(x.path) === path);
      if (a && typeof rec['sha256'] === 'string' && rec['sha256'] !== a.artifactDigest) {
        notes.push(`${path} now has content ${String(rec['sha256']).slice(0, 12)}…, but test artifact ${a.artifactId} (revision ${a.revision}, ${a.approvalState}) was registered with ${a.artifactDigest.slice(0, 12)}…`);
      }
    }
    return notes.length ? `[test artifact mismatch: ${notes.join('; ')}. This run's evidence does not count for those artifacts — re-register the file (test_artifact.register) and validate the new content again.]` : undefined;
  }

  /** A dispatcher-level refusal: the call never reaches the ToolRuntime, but it is on L0 like any tool call (I10). */
  async function deny(call: ToolCall, toolId: string, invocationId: string, errorCode: string, text: string): Promise<DispatchResult> {
    await events.append([event(input.eventContext, 'tool.denied', 'tool', invocationId, { toolId, invocationId, status: 'denied', errorCode, reason: clip(text, 2000) })]);
    return { message: toolMessage(call, text, true) };
  }

  /**
   * (conformance-5, review B2) Reserves the request rate of a load.start call under its invocation's key. A keyed reserve
   * returns an earlier reservation of the same call as is — also one already given back (released after a failed or
   * refused first dispatch, or when its job was found ended): a replayed call must never run a job on it, so a released
   * reservation is re-reserved under the next key (`qpsKey(invocationId, n)`). 'unavailable' when that keeps happening.
   */
  async function reserveQps(invocationId: string, rate: number, extraScopes: string[] = []): Promise<{ ok: true; reservationId: string } | { ok: false; exhausted: BudgetExhaustion } | 'unavailable'> {
    const scope = workScope(input.workItemId);
    for (let attempt = 1; attempt <= MAX_QPS_REKEYS; attempt++) {
      // D-3: a load job of an experiment with maxExternalQps also reserves against the experiment's scope
      const r = await budget.reserve([scope, ...extraScopes], { externalQps: rate }, `${QPS_REASON_PREFIX}${invocationId}`, { idempotencyKey: qpsKey(invocationId, attempt) });
      if (!r.ok || !budget.openReservations) return r;
      if ((await budget.openReservations(scope)).some((o) => o.reservationId === r.reservationId)) return r;
      logger.info('the QPS reservation of a replayed load.start was already given back: reserving its rate again', { invocationId, reservationId: r.reservationId, attempt });
    }
    return 'unavailable';
  }

  /**
   * (conformance-5) After a call: charge what it consumed (sandbox wall time, artifact bytes) to the work item and its
   * run — recorded in full even past a limit — and apply the exhaustion policy; give back the QPS reservation of a
   * load.start whose job does not run, and of jobs load.observe / load.stop found ended. Returns notes for the model.
   */
  async function settleCallBudget(
    toolId: string,
    invocationId: string,
    args: Record<string, unknown>,
    execution: Awaited<ReturnType<typeof toolRuntime.execute>>,
    call: { qpsReservation: string | undefined; computeCapMs: number | undefined; experimentScopes?: string[] },
  ): Promise<string[]> {
    const notes: string[] = [];
    const scopes = callScopes(input.runId, input.workItemId);
    const u = execution.usage;
    if (u && (u.computeMs > 0 || u.artifactBytes > 0) && budget.consume) {
      const amounts: { computeMs?: number; artifactBytes?: number } = {};
      if (u.computeMs > 0) amounts.computeMs = u.computeMs;
      if (u.artifactBytes > 0) amounts.artifactBytes = u.artifactBytes;
      // D-3: an experiment action also settles against the experiment's budget scope (when it has one)
      const consumed = await budget.consume([workScope(input.workItemId), ...(call.experimentScopes ?? [])], amounts, `tool:${invocationId}`);
      if (consumed.exhausted) {
        const x = consumed.exhausted;
        const compute = x.dimension === 'computeMs';
        await onToolBudgetExhausted(deps, input.eventContext, input.runId, x, { reason: compute ? 'compute' : 'artifact_bytes', toolId, invocationId });
        notes.push(`[budget_exhausted: the ${compute ? 'compute' : 'artifact'} budget of ${x.scope} is spent (${x.used}/${x.limit} ${compute ? 'ms of sandbox time' : 'bytes'}); ${compute ? 'no further execution tools run' : 'no further artifacts or evidence can be stored'} — finish with complete_work or fail_work]`);
      }
    }
    if (execution.error?.code === 'budget_exhausted') {
      // a put refused before it was stored (the call's artifact headroom was spent)
      const x = await exhaustedScope(deps, scopes, 'artifactBytes');
      if (x) await onToolBudgetExhausted(deps, input.eventContext, input.runId, x, { reason: 'artifact_bytes', toolId, invocationId });
    }
    if (call.computeCapMs !== undefined && execution.status === 'timeout') {
      const spec = registry.get(toolId);
      if (spec && call.computeCapMs < spec.timeoutMs) notes.push(`[budget: this call was limited to the ${call.computeCapMs} ms of compute budget left]`);
    }
    if (call.qpsReservation !== undefined) {
      const opStatus = obj(execution.structured)['operationStatus'];
      const mayRun = execution.operationId !== undefined && (execution.status === 'pending' || (execution.status !== 'success' && (typeof opStatus !== 'string' || JOB_MAY_RUN.has(opStatus))));
      if (!mayRun) await budget.release(call.qpsReservation);
    }
    if ((toolId === 'load.observe' || toolId === 'load.stop') && typeof args['operationId'] === 'string') {
      const opId = args['operationId'];
      await settleExternalQps(deps, input.runId, toolId === 'load.stop' && execution.status === 'success' ? { stopped: [opId] } : { operationIds: [opId] });
    }
    return notes;
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
      let heldClaim: WorkClaim | undefined;
      if (input.fencingToken !== undefined) {
        // fencing (I4) before any effect: a worker whose claim was revoked (lease expired, item requeued, item ended by
        // a cancellation that kept the claim for the audit) acts no more
        const item = await deps.blackboard.getWorkItem(input.workItemId);
        heldClaim = item?.claim;
        const held = !!item?.claim && item.claim.fencingToken === input.fencingToken && (item.state === 'claimed' || item.state === 'running');
        if (!held || !(await deps.leases.checkFence(workLeaseKey(input.workItemId), input.fencingToken))) {
          const why = item && isTerminalWorkState(item.state) ? `work item ${input.workItemId} is ${item.state}` : `work item ${input.workItemId} is no longer held with fencing token ${input.fencingToken}`;
          await events.append([event(input.eventContext, 'tool.denied', 'tool', invocationId, { toolId, invocationId, status: 'denied', errorCode: 'lease_lost', reason: why })]);
          return { message: toolMessage(call, `[denied] lease_lost: ${why}; stop working on it`, true) };
        }
      }
      if (input.claimGuard?.lost && !TERMINAL_TOOL_IDS.includes(toolId)) {
        return deny(call, toolId, invocationId, 'resource_claim_lost', `[denied] resource_claim_lost: ${input.claimGuard.lost}; no further tool calls run on them in this turn`);
      }
      let args = obj(call.arguments);
      // D-1: a known-good run on the base revision runs on the RUN's base commit (target.baseCommit), never on a commit the
      // agent names — the control plane sets it (an agent-supplied value is overridden)
      if (toolId === 'test.run' && args['revision'] === 'base') {
        const base = (await deps.runs.get(input.runId))?.target.baseCommit;
        if (base === undefined) {
          return deny(call, toolId, invocationId, 'no_base_revision', `[denied] no_base_revision: the run names no base commit (target.baseCommit), so there is no base revision to run on. Record knownGoodUnavailableReason with test_artifact.validate (a generated test then never supports or violates a P0/P1 assertion). test.run was NOT executed.`);
        }
        args = { ...args, baseCommit: base };
      }
      if (toolId === 'load.start') {
        // conformance-5: the run's maxExternalQps bounds every load job it starts (a user's cap on load against a
        // shared environment is never silently ignored)
        const cap = (await deps.runs.get(input.runId))?.budget.maxExternalQps;
        const rate = args['ratePerSecond'];
        if (cap !== undefined && typeof rate === 'number' && rate > cap) {
          return deny(call, toolId, invocationId, 'external_qps_exceeded', `[denied] external_qps_exceeded: load.start ratePerSecond ${rate} exceeds the run's maxExternalQps ${cap}; start the job at ≤ ${cap} requests per second`);
        }
      }
      const effect = effectOf(toolId, call.arguments);
      // conformance-6: a write/fault call of a work item that runs for experiments needs their admitted claims held —
      // two experiments must never invalidate each other (a lapsed or released claim is never acted on regardless)
      const experiments = await itemExperiments();
      /** The item's experiments whose claims cover this write/fault call (attribution when it runs for several). */
      let covering: string[] = [];
      /** (D-3/D-4) The one experiment a write/fault/load call is attributed to (its action, budget and evidence). */
      let attributed: string | undefined;
      let experimentBudgetScopes: string[] = [];
      if (effect !== undefined && EXPERIMENT_GUARDED_EFFECTS.has(effect) && !EXPERIMENT_EXEMPT_TOOLS.includes(toolId)) {
        // D-4: a write-to-environment / fault-injection / load call needs an ACTIVE ExperimentSpec of this work item —
        // the experiment records build, environment, data, workload and faults without depending on the model's cooperation
        if (experiments.all.length === 0) {
          // a resource another experiment holds is named first (the more specific refusal: its holder is named)
          const conflict = await experimentResourceProblem(deps, {
            workItemId: input.workItemId,
            experimentIds: [],
            toolId,
            resources: () => registry.get(toolId)?.resources(args as never, { workspace: ws, runId: input.runId, environments: deps.environments }) ?? [],
          });
          if (!conflict.ok) {
            return deny(call, toolId, invocationId, conflict.code, `[denied] ${conflict.code}: ${conflict.problem}. ${toolId} was NOT executed; do not work around it (another experiment may be using these resources).`);
          }
          return deny(
            call, toolId, invocationId, 'experiment_required',
            `[denied] experiment_required: ${toolId} acts on the environment (effect ${effect}) and work item ${input.workItemId} runs for no experiment. Define one first with experiment.define (hypothesis, environment, workload / fault plan, stop conditions, evidence requirements) — or work on an item that declares one (inputRefs kind experiment). ${toolId} was NOT executed.`,
          );
        }
        const problem = await experimentClaimsProblem(deps, input.runId, experiments.all, toolId);
        if (problem !== undefined) {
          return deny(call, toolId, invocationId, 'experiment_claims_missing', `[denied] experiment_claims_missing: ${problem}. ${toolId} was NOT executed; do not work around it (another experiment may be using these resources).`);
        }
        // review B2: held claims license a write/fault only on the resources they claim, and no work item — running for an
        // experiment or not — writes to / faults a resource another experiment holds (its recorded contamination rule)
        const verdict = await experimentResourceProblem(deps, {
          workItemId: input.workItemId,
          experimentIds: experiments.all,
          toolId,
          resources: () => registry.get(toolId)?.resources(args as never, { workspace: ws, runId: input.runId, environments: deps.environments }) ?? [],
        });
        if (!verdict.ok) {
          return deny(call, toolId, invocationId, verdict.code, `[denied] ${verdict.code}: ${verdict.problem}. ${toolId} was NOT executed; do not work around it (another experiment may be using these resources).`);
        }
        covering = verdict.covering.filter((id) => experiments.known.includes(id));
        attributed = experiments.known.length === 1 ? experiments.known[0] : covering.length === 1 ? covering[0] : undefined;
        if (attributed === undefined) {
          return deny(
            call, toolId, invocationId, 'experiment_ambiguous',
            `[denied] experiment_ambiguous: work item ${input.workItemId} runs for experiments ${experiments.known.join(', ') || experiments.all.join(', ')} and ${covering.length === 0 ? 'none' : `${covering.join(', ')}`} of them cover${covering.length === 1 ? 's' : ''} ${toolId} unambiguously: the action could not be attributed to exactly one experiment. Act only on resources one experiment claims. ${toolId} was NOT executed.`,
          );
        }
        const spec = await specs.getExperiment(attributed);
        if (!spec) return deny(call, toolId, invocationId, 'experiment_claims_missing', `[denied] experiment_claims_missing: experiment ${attributed} does not exist. ${toolId} was NOT executed.`);
        // D-3: the experiment must be ACTIVE (not stopped, stop conditions not met), the call within its plan and budget
        const active = await experimentActionCheck(deps, input.eventContext, spec, { toolId, invocationId, args, workItemId: input.workItemId });
        if (!active.ok) return deny(call, toolId, invocationId, active.code, `[denied] ${active.code}: ${active.problem}. ${toolId} was NOT executed.`);
        if (spec.budget?.maxExternalQps !== undefined || spec.budget?.maxComputeMinutes !== undefined) experimentBudgetScopes = [experimentScope(spec.experimentId)];
      }
      const guarded = driftGuarded && effect === 'execute';
      if (quarantine && (QUARANTINE_BLOCKED_TOOL_IDS.includes(toolId) || (guarded && toolId !== QUARANTINE_RESTORE_TOOL))) {
        const refusal = await quarantineRefusal(toolId);
        if (refusal) return deny(call, toolId, invocationId, 'quarantined_worktree', refusal);
      }
      if (!TERMINAL_TOOL_IDS.includes(toolId)) {
        // idempotent per invocation (H5): a replayed call (durable retry, re-dispatch after a crash) is charged once
        const charged = await budget.charge([workScope(input.workItemId)], { toolCalls: 1 }, `tool:${invocationId}`, { idempotencyKey: `tool:${invocationId}` });
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
      // conformance-5: compute and artifact headroom (enforced before the resource is spent) …
      const budgeted = !TERMINAL_TOOL_IDS.includes(toolId);
      const scopes = callScopes(input.runId, input.workItemId);
      let computeCapMs: number | undefined;
      let maxArtifactBytes: number | undefined;
      if (budgeted && budget.remaining) {
        const left = await budget.remaining([workScope(input.workItemId)]);
        if (effect === 'execute' && left.computeMs !== undefined) {
          if (left.computeMs <= 0) {
            const exhausted = (await exhaustedScope(deps, scopes, 'computeMs')) ?? { scope: workScope(input.workItemId), dimension: 'computeMs' as const, limit: 0, used: 0, reserved: 0, requested: 0 };
            await onToolBudgetExhausted(deps, input.eventContext, input.runId, exhausted, { reason: 'compute', toolId, invocationId });
            return deny(call, toolId, invocationId, 'budget_exhausted', `[denied] budget_exhausted: the compute budget of ${exhausted.scope} is spent (${exhausted.used}/${exhausted.limit} ms of sandbox time); no further execution tools run — finish with complete_work or fail_work`);
          }
          computeCapMs = Math.max(1, Math.floor(left.computeMs));
        }
        if (left.artifactBytes !== undefined) {
          // review B2: a write/fault call whose evidence cannot be stored any more must not act at all — its side effect would
          // happen unevidenced and the failed call invite a retry (a second effect); ending an effect (load.stop) stays possible
          if (left.artifactBytes <= 0 && effect !== undefined && EXPERIMENT_GUARDED_EFFECTS.has(effect) && !EXPERIMENT_EXEMPT_TOOLS.includes(toolId)) {
            const exhausted = (await exhaustedScope(deps, scopes, 'artifactBytes')) ?? { scope: workScope(input.workItemId), dimension: 'artifactBytes' as const, limit: 0, used: 0, reserved: 0, requested: 0 };
            await onToolBudgetExhausted(deps, input.eventContext, input.runId, exhausted, { reason: 'artifact_bytes', toolId, invocationId });
            return deny(call, toolId, invocationId, 'budget_exhausted', `[denied] budget_exhausted: the artifact budget of ${exhausted.scope} is spent (${exhausted.used}/${exhausted.limit} bytes); ${toolId} was NOT executed (its evidence could not be stored) — finish with complete_work or fail_work`);
          }
          maxArtifactBytes = left.artifactBytes;
        }
      }
      // … and the request rate of a load job, reserved across the run's concurrent jobs while it runs
      let qpsReservation: string | undefined;
      if (toolId === 'load.start') {
        const cap = (await deps.runs.get(input.runId))?.budget.maxExternalQps;
        const rate = args['ratePerSecond'];
        if ((cap !== undefined || experimentBudgetScopes.length > 0) && typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) {
          const reserved = await reserveQps(invocationId, rate, experimentBudgetScopes);
          if (reserved === 'unavailable') {
            return deny(call, toolId, invocationId, 'budget_unavailable', `[denied] budget_unavailable: the request rate of ${toolId} could not be reserved (the call was replayed ${MAX_QPS_REKEYS} times after its rate was given back); the job was NOT started`);
          }
          if (!reserved.ok) {
            await onToolBudgetExhausted(deps, input.eventContext, input.runId, reserved.exhausted, { reason: 'external_qps', toolId, invocationId });
            const left = Math.max(0, reserved.exhausted.limit - reserved.exhausted.used - reserved.exhausted.reserved);
            return deny(call, toolId, invocationId, 'external_qps_exhausted', `[denied] external_qps_exhausted: running load jobs of this run already hold ${reserved.exhausted.reserved} of its maxExternalQps ${reserved.exhausted.limit} requests per second; ${rate} more do not fit (${left} left). Wait for a job to end (load.observe) or stop one (load.stop), or start this one at ≤ ${left} rps.`);
          }
          qpsReservation = reserved.reservationId;
        }
      }
      // E[1]: every write/fault/load action against an environment runs under an ADMITTED ResourceClaim covering its target
      // (call-scoped, independent of experiments), held for the effect's whole window (a time-boxed fault / load job)
      let effectHolder: string | undefined;
      let lastingMs: number | undefined;
      if (effect !== undefined && EXPERIMENT_GUARDED_EFFECTS.has(effect) && !EXPERIMENT_EXEMPT_TOOLS.includes(toolId)) {
        const spec = registry.get(toolId);
        lastingMs = lastingEffectMs(toolId, args);
        const claim = await admitEffectClaim(deps, {
          runId: input.runId, workItemId: input.workItemId, toolId, invocationId, group: attributed ?? input.workItemId, experimentIds: experiments.all,
          resources: () => spec?.resources(args as never, { workspace: ws, runId: input.runId, environments: deps.environments }) ?? [],
          ttlMs: (spec?.timeoutMs ?? 60_000) + (lastingMs ?? 0) + EFFECT_CLAIM_MARGIN_MS,
        });
        if (!claim.ok) {
          if (qpsReservation !== undefined) await budget.release(qpsReservation);
          await events.append([event(input.eventContext, EVENT_TYPES.admissionRefused, 'tool', invocationId, { toolId, invocationId, phase: 'effect', problem: clip(claim.problem, 2000) })]);
          return deny(call, toolId, invocationId, 'resource_claim_conflict', `[denied] resource_claim_conflict: ${claim.problem}. ${toolId} was NOT executed; wait until the holder's effect ended (or act on other resources).`);
        }
        if (claim.holderId !== undefined) {
          effectHolder = claim.holderId;
          await events.append([event(input.eventContext, EVENT_TYPES.admissionGranted, 'tool', invocationId, { toolId, invocationId, phase: 'effect', holderId: claim.holderId, claims: claim.claims, ...(lastingMs !== undefined ? { lastingMs } : {}) })]);
        }
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
            if (qpsReservation !== undefined) await budget.release(qpsReservation);
            if (effectHolder !== undefined) await deps.admission.release(effectHolder);
            return deny(call, toolId, invocationId, 'governance_unavailable', `[denied] ${toolId} cannot run: the worktree diff needed for test-change governance is unavailable (${d.message})`);
          }
          before = d;
          await store.setGuard(input.agentId, { invocationId, before });
        }
      }
      const snapshot = await snapshotFor(meta.turn);
      const request: ToolExecutionRequest = {
        toolId,
        input: toolId === 'test.run' && args['revision'] === 'base' ? args : call.arguments,
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
      // privacy: evidence of this call is recorded at the calling role's classification (read back only with clearance)
      request.dataClassification = roleClassification(deps.roles, input.role);
      // conformance-6: the call's evidence and operations name the experiment it runs for (one declared experiment)
      if (attributed !== undefined) request.experimentId = attributed;
      else if (experiments.known.length === 1) request.experimentId = experiments.known[0]!;
      else if (covering.length === 1) request.experimentId = covering[0]!;
      // (review, coverage-1/C12) ending an effect (load.stop) belongs to the experiment of the job it ends, whoever stops it
      if (request.experimentId === undefined && EXPERIMENT_EXEMPT_TOOLS.includes(toolId) && typeof args['operationId'] === 'string') {
        const job = (await deps.ledger.get(args['operationId']).catch(() => undefined)) as (LedgerOperationRecord | undefined);
        if (job !== undefined && job.runId === input.runId && job.experimentId !== undefined) request.experimentId = job.experimentId;
      }
      // D-8: evidence names the SystemModel revision it was gathered under
      const runNow = await deps.runs.get(input.runId);
      if (runNow?.systemModelRevision !== undefined) request.systemModelRevision = runNow.systemModelRevision;
      if (computeCapMs !== undefined) request.timeoutMs = computeCapMs;
      if (maxArtifactBytes !== undefined) request.limits = { maxArtifactBytes };
      if (input.fencingToken !== undefined) {
        // (H4, I4) the call runs under the work claim: side-effect leases are owned by THIS claim (a stale worker of the
        // same agent is another owner and never reuses the live claim's lease), and record-effect tools re-check the
        // claim's fencing token inside their own write transaction
        request.leaseOwner = claimLeaseOwner(heldClaim?.ownerId ?? deps.config.workerId, input.workItemId, input.fencingToken);
        request.claim = { workItemId: input.workItemId, fencingToken: input.fencingToken, ownerId: heldClaim?.ownerId ?? deps.config.workerId };
        if (heldClaim?.leaseId) request.claim.leaseId = heldClaim.leaseId;
        // E[0]: every external effect of the call re-validates the claim at the gateway's commit point
        request.commitGuard = claimCommitGuard(deps, { runId: input.runId, workItemId: input.workItemId, fencingToken: input.fencingToken }, input.eventContext);
      }
      // E[2]/E[1]: a state-changing request a sandboxed command of this call sends to an environment (relayed and ledgered by
      // the sandbox) runs under an admitted ResourceClaim on that environment too — the call's holder, released after it
      let egressHolder: string | undefined;
      const callTimeout = registry.get(toolId)?.timeoutMs ?? 60_000;
      request.egressGuard = async (resource) => {
        const claim = await admitEffectClaim(deps, {
          runId: input.runId, workItemId: input.workItemId, toolId: 'sandbox.http', invocationId, group: request.experimentId ?? input.workItemId, experimentIds: experiments.all,
          resources: () => [resource], ttlMs: callTimeout + EFFECT_CLAIM_MARGIN_MS,
        });
        if (!claim.ok) return claim.problem;
        if (claim.holderId !== undefined) egressHolder = claim.holderId;
        return undefined;
      };
      let execution: Awaited<ReturnType<typeof toolRuntime.execute>>;
      try {
        execution = await toolRuntime.execute(request);
      } catch (e) {
        // review B2: the call may have dispatched its job before it failed (e.g. an audit write after the launch): the rate
        // is given back only when no job can run (none prepared, or it ended); a replay reuses (or re-reserves) it
        if (qpsReservation !== undefined && !(await qpsJobMayRun(deps, input.runId, invocationId))) await budget.release(qpsReservation).catch(() => undefined);
        throw e;
      }
      // E[1]: the call's claim is given back unless its effect lasts (or its outcome is not settled: then it expires); a
      // lasting effect that started keeps it for exactly its window (a fault until it expires — `effectUntil` — a load job
      // for its duration from now: it started before the call returned)
      if (effectHolder !== undefined) {
        if (!effectClaimOutlivesCall(execution, lastingMs)) await deps.admission.release(effectHolder);
        else if (execution.status === 'success' && lastingMs !== undefined && deps.admission.retime) {
          const until = obj(execution.structured)['effectUntil'];
          const untilMs = typeof until === 'string' && Number.isFinite(Date.parse(until)) ? Date.parse(until) : deps.clock.nowMs() + lastingMs;
          const ttl = untilMs - deps.clock.nowMs();
          if (ttl > 0) await deps.admission.retime(effectHolder, ttl);
          else await deps.admission.release(effectHolder);
        }
      }
      // relayed writes of sandboxed commands are settled when the call returns (each is a recorded operation)
      if (egressHolder !== undefined && egressHolder !== effectHolder) await deps.admission.release(egressHolder);
      // ending a load job frees the resources its load.start claimed for its window
      if (toolId === 'load.stop' && execution.status === 'success' && typeof args['operationId'] === 'string') {
        const job = await deps.ledger.get(args['operationId']).catch(() => undefined);
        if (job?.toolInvocationId !== undefined && job.runId === input.runId) await releaseEffectClaims(deps, job.toolInvocationId, input.runId);
      }
      const budgetNotes = await settleCallBudget(toolId, invocationId, args, execution, { qpsReservation, computeCapMs, experimentScopes: experimentBudgetScopes });
      if (toolId === 'experiment.define' && execution.status === 'success') experimentsCache = undefined;
      const drift = before !== undefined ? await checkDrift(toolId, invocationId, before) : undefined;
      if (before !== undefined) {
        pendingGuard = undefined;
        await store.setGuard(input.agentId, null);
      }
      const flag = await afterAction(toolId, invocationId, call.arguments, execution, snapshot?.snapshotId);
      if ((toolId === 'test.run' || toolId === 'mutation.run') && execution.status === 'success') {
        const hint = await artifactDriftHint(obj(execution.structured));
        if (hint) budgetNotes.push(hint);
      }
      const noted = budgetNotes.length > 0 ? `${execution.modelText}\n${budgetNotes.join('\n')}` : execution.modelText;
      const body = flag !== undefined ? `${noted}\n${flag}` : noted;
      const result: DispatchResult = {
        message: drift !== undefined
          ? toolMessage(call, `${drift}\n--- tool output ---\n${clip(body, 4000)}`, true)
          : toolMessage(call, body, execution.status !== 'success' && execution.status !== 'pending'),
        execution,
      };
      const structured = obj(execution.structured);
      if (execution.status === 'success' && TERMINAL_TOOL_IDS.includes(toolId) && structured['terminal']) {
        result.terminal = structured['terminal'] as TerminalSignal;
      }
      if (execution.status === 'pending' && execution.operationId) result.pendingOperationId = execution.operationId;
      // stubs[8]: an operation escalated to manual review (its outcome could not be established) ⇒ the item WAITS for a
      // human's resolution (`hypertest operations resolve`) instead of guessing; it resumes with the resolved outcome
      if (execution.status === 'failed' && execution.error?.code === 'manual_review' && execution.operationId) {
        result.pendingOperationId = execution.operationId;
        result.message = toolMessage(call, `${execution.modelText}\n[waiting for a human manual review of operation ${execution.operationId}: this work item resumes with the outcome they record (do not re-send the action)]`, false);
      }
      // E[8]: approval_required with a recorded approval request ⇒ the item WAITS (durably) for the human decision instead
      // of failing; observeWaiting resumes it when the approval is decided (approved: the same call runs once)
      if (execution.status === 'denied' && execution.error?.code === 'approval_required' && execution.permit?.approvalId !== undefined) {
        result.pendingOperationId = approvalWaitOperationId(execution.permit.approvalId);
        result.message = toolMessage(call, `${execution.modelText}\n[waiting for approval ${execution.permit.approvalId}: this work item resumes once an independent human decides it]`, false);
      }
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
        // one test outcome per invocation on L0 (H5): a replayed test.run keeps the first recorded outcome event
        const eventId = testOutcomeEventId(invocationId);
        if (!(await events.get(eventId))) {
          await events.append([{ ...event(input.eventContext, structured['passed'] === true ? 'test.passed' : 'test.failed', 'tool', invocationId, payload), eventId }]);
        }
      }
      return result;
    },
  };
}
