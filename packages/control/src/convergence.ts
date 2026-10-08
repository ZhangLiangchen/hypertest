import { canonicalJson, isHypertestError, sha256Hex, type JsonValue } from '@hypertest/core';
import {
  EVENT_TYPES, isTerminalWorkState, workItemFingerprint,
  type BlackboardRecord, type CoverageGap, type EventContext, type EvidenceRecord, type Finding, type Hypothesis, type PlanRevision, type QualityDecision, type Review, type Risk,
  type TestRun, type WorkItem,
} from '@hypertest/domain';
import {
  DEFAULT_GATE_SPEC, acceptanceFacts, applyPhasePermit, withPolicyHold, type EnvironmentFacts, type ExperimentActionFacts, type ExperimentFacts, type GateInput, type GateOperation,
} from '@hypertest/policy';
import type { NewWorkItem } from '@hypertest/collab';
import { EVIDENCE_PRODUCER_ROLES } from '@hypertest/agents';
import type { ConvergenceState } from './contracts.ts';
import type { ControlDeps, ResolvedControlConfig } from './deps.ts';
import { acceptedPlanCount } from './domain-tools/plan.ts';
import { createPhaseGovernor } from './phases.ts';
import { ControlStore, type GateFeedback, type ReplanState } from './store.ts';
import { WorkFactory, runScope } from './work-factory.ts';
import { experimentWallClockLimit, type RunExhaustion } from './budget-exhaustion.ts';
import { experimentScope } from './domain-tools/specs.ts';
import { CRITICAL_FINDING_REPLAN_CONSUMER, criticalFindingTriggers } from './reactors.ts';
import { authorizedGateWeakenings, clip, compact, event, gateReference, runCtx, workBudgetFor } from './util.ts';

/**
 * Criteria whose `unknown` status a replan can address by gathering more evidence (gate feedback loop): critical oracles,
 * required evidence, review, coverage, and (D-3 / D-11 / coverage-1) experiment validity, environment validity and the
 * domain contracts (a missing SystemModel or experiment the lead can still record / define and re-run).
 */
export const FEEDBACK_CRITERIA: ReadonlySet<string> = new Set(['C3', 'C4', 'C6', 'C8', 'C10', 'C11', 'C12']);
/** Gate evaluations per run: the first may send the lead back for more evidence, the second is final. */
export const MAX_GATE_ATTEMPTS = 2;
/**
 * Roles whose model providers produced findings/tests/evidence/fixes (reviewer independence input of the gate, C6). The
 * agents catalog's EVIDENCE_PRODUCER_ROLES — the very list the reviewer's routing avoids (independentFromRoles) — so the
 * gate and the router always count the same producers (H10: metrics_analyst and environment included).
 */
export const PRODUCER_ROLES: readonly string[] = EVIDENCE_PRODUCER_ROLES;
const PRODUCT_CATEGORIES: ReadonlySet<string> = new Set(['product_defect', 'security', 'performance']);

/**
 * Why the lead replans (BLUEPRINT §4.1 step 3): the plan drained with objectives open, QualityGate feedback, (coverage-17)
 * a new unresolved P0/P1 product finding, or (D-10) a pinned oracle changed revision during the run (the run is re-pinned
 * and its evidence must be re-evaluated in new work/experiments under the new revision).
 */
export type ReplanReason = 'plan_drained' | 'gate_feedback' | 'critical_finding' | 'oracle_changed';

export interface ReplanOutcome {
  scheduled: boolean;
  reason?: ReplanReason;
  workItemId?: string;
  /** Why no replan could be scheduled although one was due. */
  blocked?: 'lead_active' | 'max_plan_revisions' | 'livelock' | 'work_item_cap';
}

export interface GateOutcome {
  /** Absent when the outcome was abandoned (the run left `gating` while the gate was evaluated). */
  decision?: QualityDecision;
  final: boolean;
  run: TestRun;
  /** Why the gate's outcome was not applied (e.g. the run was paused or quarantined during evaluation). */
  abandoned?: string;
}

/** Thrown inside the gate transaction to roll it back when the run is no longer `gating`. */
class GateAbandoned extends Error {
  readonly run: TestRun;
  constructor(run: TestRun) {
    super(`run ${run.runId} left gating during gate evaluation (now ${run.status}${run.pauseReason ? `/${run.pauseReason}` : ''})`);
    this.run = run;
  }
}

export interface ConvergenceMonitor {
  /** Budget/wall-clock exhaustion of the run (never a silent downgrade: the run converges to the gate). */
  exhaustion(run: TestRun): Promise<'budget' | 'wall_clock' | undefined>;
  /**
   * (additive, E[3] / item 10) WHICH budget dimension is exhausted (scope, dimension, limit, used): every run dimension —
   * model tokens and USD (a refused call at the current limit included), tool calls, compute, artifact bytes, wall clock.
   * `caps` adds the work-item cap and the experiments' own budgets (a refusal at the current limit): those refuse the call
   * under the `gate` policy (the run goes on with the work it has) and pause the run under `pause` / `approval`.
   */
  exhaustionDetail?(run: TestRun, options?: { caps?: boolean }): Promise<RunExhaustion | undefined>;
  /** Replan triggers: plan drained (latest plan not readyForGate) or pending gate feedback; at most one active lead item. */
  maybeReplan(run: TestRun, items: WorkItem[]): Promise<ReplanOutcome>;
  /** Classifies the run's state after a tick's scheduling steps. */
  evaluate(run: TestRun, items: WorkItem[], info: { pendingEvents: number; exhausted?: 'budget' | 'wall_clock'; replan: ReplanOutcome }): Promise<ConvergenceState>;
  /** True when the state allows the gate: drained/stalled/exhausted with nothing active or runnable and no pending events. */
  gateReady(state: ConvergenceState, items: WorkItem[], pendingEvents: number): boolean;
  /** running → converging → gating → QualityGate → decision (signed, sealed) → completed, or back to running with feedback. */
  gate(run: TestRun): Promise<GateOutcome>;
  /** Replan digest shown to the lead (exported for tests and reports). */
  digest(run: TestRun, items: WorkItem[], reason: ReplanReason, ordinal: number, replans: ReplanState, extra?: { findings?: string[]; oracles?: string[] }): Promise<string>;
  /**
   * (H7) Before the gate: when the run's gate requires an independent review and no review of the run (or of a decision)
   * exists, emits `review.requested` for the run — once per gate attempt (deterministic event id) — so the reviewer's
   * subscription creates the run-level review work. True when it was emitted now (the gate waits for the review); the
   * gate still fails safe (C6) when the review never arrives.
   */
  requestRunReview(run: TestRun): Promise<boolean>;
}

/** (H7) Deterministic id of the run-level `review.requested` of one gate attempt. */
export function runReviewRequestEventId(runId: string, gateAttempt: number): string {
  return `evt_review_run_${sha256Hex(`review.requested\u0000${runId}\u0000${gateAttempt}`).slice(0, 32)}`;
}

function objectiveLine(o: PlanRevision['objectives'][number]): string {
  return `- ${o.objectiveId} [${o.priority}, ${o.status}] ${clip(o.description, 300)}`;
}

export function createConvergenceMonitor(deps: ControlDeps, config: ResolvedControlConfig): ConvergenceMonitor {
  const { db, blackboard, runs, specs, decisions, evidence, epochs, budget, gate, signer, memory, events, ids, clock, logger, roles } = deps;
  const store = new ControlStore(db);
  const factory = new WorkFactory(deps);
  const phases = createPhaseGovernor(deps, config);
  const workerId = config.workerId;

  async function exhaustion(run: TestRun): Promise<'budget' | 'wall_clock' | undefined> {
    return (await exhaustionDetail(run))?.kind;
  }

  async function exhaustionDetail(run: TestRun, options: { caps?: boolean } = {}): Promise<RunExhaustion | undefined> {
    const scope = runScope(run.runId);
    const elapsed = clock.nowMs() - Date.parse(run.createdAt);
    if (elapsed > run.budget.maxWallClockMs) return { kind: 'wall_clock', dimension: 'wallClockMs', scope, reason: 'wall_clock', limit: run.budget.maxWallClockMs, used: elapsed };
    const usage = await budget.usage(scope);
    if (!usage) return undefined;
    // conformance-5: sandbox compute and stored artifact bytes are consumable run budgets too (never a silent overrun)
    for (const d of ['tokens', 'costUsd', 'toolCalls', 'computeMs', 'artifactBytes'] as const) {
      const limit = usage.limits[d];
      if (limit !== undefined && (usage.used[d] ?? 0) >= limit) return { kind: 'budget', dimension: d, scope, reason: `${d}_spent`, limit, used: usage.used[d] ?? 0 };
    }
    // No model call fits any more: even the output reserve of one call exceeds what is left. Reservations of calls in
    // flight are NOT subtracted: they settle to their actual use, so they make room scarce only transiently — and this
    // verdict is permanent (pending work is cancelled).
    const tokens = usage.limits.tokens;
    if (tokens !== undefined && tokens - (usage.used.tokens ?? 0) < config.maxOutputTokens) {
      return { kind: 'budget', dimension: 'tokens', scope, reason: 'model_tokens', limit: tokens, used: usage.used.tokens ?? 0, requested: config.maxOutputTokens };
    }
    // item 10: a model call was refused by the run scope at the CURRENT limit of its dimension — tokens or USD — while no
    // other call held a reservation (an operator raising that limit clears it; a refusal caused by concurrent
    // reservations is transient). A USD-exhausted run ($0.99 of $1 spent, the next call needs more) is exhausted.
    const markers = await events.read(run.runId, { types: ['budget.exhausted'] });
    for (const e of markers) {
      const p = (e.payload ?? {}) as { scope?: string; reason?: string; dimension?: string; limit?: number; used?: number; requested?: number; reservedByOthers?: number; policyKey?: string };
      if (p.scope !== scope || p.policyKey !== undefined || typeof p.limit !== 'number' || (p.reservedByOthers ?? 0) !== 0) continue;
      const d = p.reason === 'model_tokens' ? 'tokens' : p.reason === 'model_cost' ? 'costUsd' : undefined;
      if (!d) continue;
      const current = usage.limits[d];
      if (current !== undefined && current <= p.limit) {
        const out: RunExhaustion = { kind: 'budget', dimension: d, scope, reason: p.reason!, limit: current, used: usage.used[d] ?? 0 };
        if (typeof p.requested === 'number') out.requested = p.requested;
        return out;
      }
    }
    if (!options.caps) return undefined;
    // the work-item cap: a creation was refused at the current cap (after the last raise)
    const raisedAt = Math.max(0, ...(await events.read(run.runId, { types: [EVENT_TYPES.budgetRaised] })).map((e) => e.seq ?? 0));
    const cap = usage.limits.workItems;
    if (cap !== undefined && (usage.used.workItems ?? 0) >= cap) {
      const refused = markers.some((e) => (e.seq ?? 0) > raisedAt && (e.payload as { scope?: string; dimension?: string; policyKey?: string } | undefined)?.dimension === 'workItems' && (e.payload as { scope?: string }).scope === scope && (e.payload as { policyKey?: string }).policyKey === undefined);
      if (refused) return { kind: 'budget', dimension: 'workItems', scope, reason: 'work_item_cap', limit: cap, used: usage.used.workItems ?? 0 };
    }
    // the experiments' own budgets: a call of the experiment was refused at its CURRENT limit (a raise clears it)
    for (const e of markers) {
      const p = (e.payload ?? {}) as { reason?: string; experimentId?: string; policyKey?: string; limit?: number };
      if (p.policyKey !== undefined || typeof p.experimentId !== 'string' || typeof p.limit !== 'number') continue;
      if (p.reason === 'experiment_tool_calls') {
        const u = await budget.usage(experimentScope(p.experimentId));
        const limit = u?.limits.toolCalls;
        if (limit !== undefined && limit <= p.limit && (u?.used.toolCalls ?? 0) >= limit) return { kind: 'budget', dimension: 'experiment.toolCalls', scope: experimentScope(p.experimentId), reason: p.reason, limit, used: u?.used.toolCalls ?? 0, experimentId: p.experimentId };
      } else if (p.reason === 'experiment_wall_clock') {
        const spec = await specs.getExperiment(p.experimentId);
        const limit = await experimentWallClockLimit(deps, run.runId, p.experimentId);
        if (spec && limit !== undefined && limit <= p.limit && clock.nowMs() - Date.parse(spec.createdAt) > limit) {
          return { kind: 'budget', dimension: 'experiment.wallClockMs', scope: experimentScope(p.experimentId), reason: p.reason, limit, used: clock.nowMs() - Date.parse(spec.createdAt), experimentId: p.experimentId };
        }
      }
    }
    return undefined;
  }

  async function replanBlocker(run: TestRun, items: WorkItem[], plans: PlanRevision[], replans: ReplanState): Promise<ReplanOutcome['blocked']> {
    if (items.some((w) => w.role === 'lead' && !isTerminalWorkState(w.state))) return 'lead_active';
    if (acceptedPlanCount(plans) >= run.budget.maxPlanRevisions) return 'max_plan_revisions';
    if (replans.revisionCount >= run.budget.maxPlanRevisions) return 'livelock';
    if ((await factory.remainingWorkItems(run.runId)) < 1) return 'work_item_cap';
    return undefined;
  }

  async function digest(run: TestRun, items: WorkItem[], reason: ReplanReason, ordinal: number, replans: ReplanState, extra?: { findings?: string[]; oracles?: string[] }): Promise<string> {
    const plan = await blackboard.latestAcceptedPlan(run.runId);
    const since = plan?.decidedAt ?? plan?.createdAt;
    const lines: string[] = [];
    lines.push(`Replan #${ordinal} (reason: ${reason}) of run ${run.runId}.`);
    lines.push(`Run goal: ${clip(run.goal, 1000)}`);
    lines.push('');
    lines.push(plan ? `### Objectives of plan v${plan.revision} (readyForGate ${plan.readyForGate})` : '### Objectives: no plan revision has been accepted yet');
    for (const o of plan?.objectives ?? []) lines.push(objectiveLine(o));
    lines.push('');
    lines.push('### Work items');
    for (const w of items.filter((x) => x.role !== 'lead').slice(-60)) {
      const tail = w.state === 'completed' ? ` — ${clip(w.result?.summary ?? '', 240)}` : w.failure ? ` — ${w.failure.reason}: ${clip(w.failure.message, 200)}` : '';
      lines.push(`- ${w.workItemId} ${w.role} [${w.state}] ${clip(w.title, 120)}${tail}`);
    }
    const records = await blackboard.query<unknown>({ runId: run.runId, recordType: ['finding', 'risk', 'hypothesis', 'coverage_gap', 'review'] });
    const recent = since ? records.filter((r) => r.createdAt >= since) : records;
    lines.push('');
    lines.push(`### Blackboard changes ${plan ? `since plan v${plan.revision}` : 'so far'}`);
    if (recent.length === 0) lines.push('- none');
    for (const r of recent.slice(-80)) {
      const p = r.payload as Record<string, unknown>;
      switch (r.recordType) {
        case 'finding': {
          const f = p as unknown as Finding;
          lines.push(`- finding ${r.recordId} [${f.severity}, ${f.category}, ${f.status}] ${clip(f.title, 160)} (evidence: ${r.evidenceRefs.join(', ') || 'none'})`);
          break;
        }
        case 'risk': {
          const k = p as unknown as Risk;
          lines.push(`- risk ${r.recordId} [${k.level}, ${k.status}] ${clip(k.title, 160)}`);
          break;
        }
        case 'hypothesis': {
          const h = p as unknown as Hypothesis;
          lines.push(`- hypothesis ${r.recordId} [${h.status}, confidence ${h.confidence}] ${clip(h.statement, 200)}`);
          break;
        }
        case 'coverage_gap': {
          const g = p as unknown as CoverageGap;
          lines.push(`- coverage gap ${r.recordId} [${g.status}] ${clip(g.area, 120)}: ${clip(g.description, 160)}`);
          break;
        }
        case 'review': {
          const v = p as unknown as Review;
          lines.push(`- review ${r.recordId} [${v.verdict}] of ${v.subjectRef.kind}:${v.subjectRef.id}`);
          break;
        }
        default:
          break;
      }
    }
    const failed = items.filter((w) => w.state === 'failed' || w.state === 'cancelled');
    lines.push('');
    lines.push('### Failed / cancelled work');
    if (failed.length === 0) lines.push('- none');
    for (const w of failed) lines.push(`- ${w.workItemId} ${w.role} [${w.state}] ${clip(w.title, 120)}${w.failure ? ` — ${w.failure.reason}: ${clip(w.failure.message, 200)}` : ''}`);
    if (reason === 'critical_finding' && extra?.findings?.length) {
      lines.push('');
      lines.push('### New unresolved P0/P1 findings (the reason for this replan)');
      for (const f of extra.findings) lines.push(`- ${f}`);
      lines.push('Plan the response: root-cause analysis, a regression test bound to the violated oracle assertion, independent verification, and whether the release objective can still be met.');
    }
    if (reason === 'oracle_changed' && extra?.oracles?.length) {
      lines.push('');
      lines.push('### Oracle revisions changed during the run (the reason for this replan)');
      for (const o of extra.oracles) lines.push(`- ${o}`);
      lines.push('The run is now pinned to the new revision(s). Evidence gathered under the old revision is re-judged by the gate against the new one; experiments defined under it are no longer valid evidence — define NEW experiments (experiment.define) and re-run the critical tests under the new revision. Never rewrite the history of the old one.');
    }
    if (reason === 'gate_feedback' && replans.feedback) {
      const fb = replans.feedback;
      lines.push('');
      lines.push(`### QualityGate feedback (decision ${fb.decisionId}, verdict ${fb.verdict})`);
      for (const c of fb.unknownCriteria) lines.push(`- unknown ${c.criterionId} ${c.description}: ${clip(c.detail ?? '', 300)}`);
      for (const c of fb.violatedCriteria) lines.push(`- violated ${c.criterionId} ${c.description}: ${clip(c.detail ?? '', 300)}`);
      for (const r of fb.reasons.slice(0, 20)) lines.push(`  · ${clip(r, 300)}`);
    }
    const usage = await budget.usage(runScope(run.runId));
    const plans = await blackboard.listPlans(run.runId);
    lines.push('');
    lines.push('### Remaining budget');
    const u = (d: 'tokens' | 'toolCalls' | 'workItems') => `${usage?.used[d] ?? 0}/${usage?.limits[d] ?? '∞'}`;
    lines.push(`- model tokens ${u('tokens')}, tool calls ${u('toolCalls')}, work items ${u('workItems')}, accepted plans ${acceptedPlanCount(plans)}/${run.budget.maxPlanRevisions}`);
    lines.push('');
    lines.push(
      'Decide the next plan revision with plan.propose_revision: add, change or cancel work to cover the open objectives and the gaps above (never duplicate existing work), or set readyForGate when every objective is satisfied by cited evidence or explicitly unsatisfiable/dropped. Then finish with complete_work.',
    );
    return clip(lines.join('\n'), 12_000);
  }

  /** (D-10) The latest re-pins of the run (from L0), for a replan that could not be scheduled when they happened. */
  async function lastRepins(run: TestRun): Promise<Array<{ oracleId: string; from: number; to: number }>> {
    const evs = await events.read(run.runId, { types: [EVENT_TYPES.runOracleRepinned] });
    return evs.map((e) => e.payload as { oracleId: string; from: number; to: number }).filter((p) => run.oracleRevisions[p.oracleId] === p.to);
  }

  /** (D-10) A re-pin that no replan has answered yet (the replan was blocked when the re-pin happened). */
  async function pendingOracleChange(run: TestRun): Promise<boolean> {
    const repins = await lastRepins(run);
    if (repins.length === 0) return false;
    const key = `oracle_changed:${repins.map((c) => `${c.oracleId}@${c.to}`).sort().join(',')}`;
    const fp = workItemFingerprint({ runId: run.runId, role: 'lead', objective: `replan #${(await store.replans(run.runId)).revisionCount + 1}`, originKey: key });
    const items = await blackboard.listWorkItems({ runId: run.runId });
    const answered = (await events.read(run.runId, { types: [EVENT_TYPES.replanTriggered] })).some((e) => (e.payload as { reason?: string; oracles?: string[] }).reason === 'oracle_changed' && repins.every((c) => ((e.payload as { oracles?: string[] }).oracles ?? []).includes(`${c.oracleId}: revision ${c.from} → ${c.to}`)));
    return !answered && !items.some((w) => w.fingerprint === fp);
  }

  /**
   * (D-10) Re-pins the run to the newest APPROVED revision of every pinned oracle that changed during the run (append-only:
   * the run's record moves forward, `run.oracle_repinned` is on L0, decisions of this run on the old revision are marked
   * needs_reassessment). Returns the changes ("oracleId r1 → r2").
   */
  async function repinOracles(run: TestRun): Promise<{ run: TestRun; changes: Array<{ oracleId: string; from: number; to: number }> }> {
    const changes: Array<{ oracleId: string; from: number; to: number }> = [];
    const next: Record<string, number> = { ...run.oracleRevisions };
    for (const [oracleId, pinned] of Object.entries(run.oracleRevisions ?? {})) {
      const latest = await specs.getOracle(oracleId);
      if (!latest || latest.revision <= pinned || latest.status !== 'approved') continue;
      next[oracleId] = latest.revision;
      changes.push({ oracleId, from: pinned, to: latest.revision });
    }
    if (changes.length === 0) return { run, changes };
    const ctx = runCtx(run.runId, workerId);
    const updated = await runs.update(run.runId, { oracleRevisions: next }, ctx);
    for (const c of changes) {
      await events.append([event(ctx, EVENT_TYPES.runOracleRepinned, 'run', run.runId, { oracleId: c.oracleId, from: c.from, to: c.to })]);
      for (const d of await decisions.findByOracleRevision(c.oracleId, c.from)) {
        if (d.runId !== run.runId) continue; // other runs: the oracle governance marks them per the change policy
        await decisions.markNeedsReassessment(d.decisionId, `the run was re-pinned from oracle ${c.oracleId} revision ${c.from} to ${c.to}: re-evaluated under the new revision`, ctx);
      }
      logger.info('run re-pinned to a new oracle revision', { runId: run.runId, oracleId: c.oracleId, from: c.from, to: c.to });
    }
    return { run: updated, changes };
  }

  async function maybeReplan(start: TestRun, items: WorkItem[]): Promise<ReplanOutcome> {
    const replans = await store.replans(start.runId);
    const plans = await blackboard.listPlans(start.runId);
    const latest = await blackboard.latestAcceptedPlan(start.runId);
    const repinned = await repinOracles(start);
    const run = repinned.run;
    let reason: ReplanReason | undefined;
    let originKey: string | undefined;
    const extra: { findings?: string[]; oracles?: string[] } = {};
    let triggers: string[] = [];
    if (replans.feedbackPending) reason = 'gate_feedback';
    else if (repinned.changes.length > 0 || (await pendingOracleChange(run))) {
      reason = 'oracle_changed';
      const changes = repinned.changes.length > 0 ? repinned.changes : await lastRepins(run);
      extra.oracles = changes.map((c) => `${c.oracleId}: revision ${c.from} → ${c.to}`);
      originKey = `oracle_changed:${changes.map((c) => `${c.oracleId}@${c.to}`).sort().join(',')}`;
    } else {
      const critical = await criticalFindingTriggers(deps, run.runId);
      if (critical.length > 0) {
        reason = 'critical_finding';
        triggers = critical.map((t) => t.eventId);
        extra.findings = critical.map((t) => `${t.recordId} [${t.severity} ${t.category}] ${clip(t.title, 200)}`);
        originKey = `critical_finding:${[...triggers].sort()[0]}`;
      } else if (items.every((w) => isTerminalWorkState(w.state)) && !latest?.readyForGate) reason = 'plan_drained';
    }
    if (!reason) return { scheduled: false };
    const blocked = await replanBlocker(run, items, plans, replans);
    if (blocked) return { scheduled: false, reason, blocked };
    const lead = roles.require('lead');
    const ctx = runCtx(run.runId, workerId);
    const ordinal = replans.revisionCount + 1;
    const objective = await digest(run, items, reason, ordinal, replans, extra);
    const titles: Record<ReplanReason, string> = { gate_feedback: 'address QualityGate feedback', plan_drained: 'plan drained', critical_finding: 'new P0/P1 finding', oracle_changed: 'oracle revision changed' };
    const item: NewWorkItem = {
      runId: run.runId,
      kind: 'replan',
      origin: { kind: 'system', reason: `replan:${reason}` },
      title: `Replan #${ordinal}: ${titles[reason]}`,
      objective,
      role: 'lead',
      objectiveIds: [],
      capabilityRequirements: [],
      inputRefs: [],
      evidenceRequirements: [],
      dependsOn: [],
      budget: workBudgetFor(lead),
      priority: 90,
      depth: 0,
      fingerprint: workItemFingerprint({ runId: run.runId, role: 'lead', objective: `replan #${ordinal}`, originKey: originKey ?? `replan:${ordinal}` }),
      resourceClaims: [],
      state: 'ready',
    };
    if (lead.outputSchema !== undefined) item.expectedOutput = lead.outputSchema;
    const created = await db.transaction(async (tx) => {
      const r = await factory.create(item, ctx, tx);
      if (r.status === 'capped') return undefined;
      // a concurrent tick already scheduled this ordinal (fingerprint duplicate): count the replan once
      if (r.status === 'created') {
        await store.recordReplan(run.runId, reason, clock.isoNow(), tx);
        // coverage-17: each triggering finding event is consumed once (inbox, I5) — a redelivered or re-read event never
        // schedules a second replan
        for (const id of triggers) await deps.inbox.tryConsume(CRITICAL_FINDING_REPLAN_CONSUMER, id, tx);
        if (reason === 'critical_finding' || reason === 'oracle_changed') {
          await events.append([event(ctx, EVENT_TYPES.replanTriggered, 'work_item', r.workItem.workItemId, { reason, workItemId: r.workItem.workItemId, triggers, findings: extra.findings, oracles: extra.oracles })], tx);
        }
      }
      return r.workItem.workItemId;
    });
    if (!created) return { scheduled: false, reason, blocked: 'work_item_cap' };
    logger.info('replan scheduled', { runId: run.runId, reason, ordinal, workItemId: created });
    return { scheduled: true, reason, workItemId: created };
  }

  async function evaluate(run: TestRun, items: WorkItem[], info: { pendingEvents: number; exhausted?: 'budget' | 'wall_clock'; replan: ReplanOutcome }): Promise<ConvergenceState> {
    const count = (s: WorkItem['state'][]) => items.filter((w) => s.includes(w.state)).length;
    const runnable = count(['ready']);
    const running = count(['claimed', 'running']);
    const waiting = count(['waiting']);
    const blocked = count(['blocked', 'proposed']);
    if (info.exhausted) return { state: 'exhausted', reason: info.exhausted };
    if (runnable + running + waiting > 0 || info.pendingEvents > 0) return { state: 'active', runnable, running, waiting, pendingEvents: info.pendingEvents };
    if (blocked > 0) return { state: 'stalled', reason: 'blocked_dependencies' };
    const latest = await blackboard.latestAcceptedPlan(run.runId);
    if (latest?.readyForGate) return { state: 'drained', reason: 'ready_for_gate' };
    if (info.replan.blocked === 'max_plan_revisions') return { state: 'stalled', reason: 'max_plan_revisions' };
    if (info.replan.blocked === 'livelock') return { state: 'stalled', reason: 'livelock' };
    return { state: 'drained', reason: 'plan_drained' };
  }

  function gateReady(state: ConvergenceState, items: WorkItem[], pendingEvents: number): boolean {
    if (state.state === 'active') return false;
    if (pendingEvents > 0) return false;
    return !items.some((w) => w.state === 'claimed' || w.state === 'running' || w.state === 'waiting' || w.state === 'ready');
  }

  /**
   * conformance-11: the run's approved gate waivers (approvals of kind `gate_exception`). The gate applies only those
   * decided by a human/system actor, unexpired, and never for C1.
   */
  async function gateExceptions(runId: string): Promise<GateInput['exceptions']> {
    const out: GateInput['exceptions'] = [];
    for (const a of await deps.approvals.list({ runId, status: ['approved'] })) {
      if (a.kind !== 'gate_exception' || !a.decidedBy) continue;
      const subject = (a.subject ?? {}) as { criterionId?: unknown; expiresAt?: unknown };
      if (typeof subject.criterionId !== 'string') continue;
      const ex: GateInput['exceptions'][number] = { criterionId: subject.criterionId, approvedBy: a.decidedBy, rationale: a.rationale ?? '' };
      if (typeof subject.expiresAt === 'string') ex.expiresAt = subject.expiresAt;
      out.push(ex);
    }
    return out;
  }

  /**
   * (D-3 / D-4 / D-11) What the run did to the outside world, for the gate (C10, C11, C12): every operation of a tool whose
   * effect is external or destructive, with its experiment and — from the `experiment.action` records — what the call did.
   */
  async function gateOperations(runId: string): Promise<GateOperation[]> {
    const actions = new Map<string, ExperimentActionFacts>();
    for (const e of await events.read(runId, { types: [EVENT_TYPES.experimentAction] })) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (typeof p['invocationId'] !== 'string') continue;
      const f: ExperimentActionFacts = {};
      if (typeof p['kind'] === 'string') f.kind = p['kind'];
      if (typeof p['target'] === 'string') f.target = p['target'];
      if (p['params'] && typeof p['params'] === 'object' && !Array.isArray(p['params'])) f.params = p['params'] as Record<string, JsonValue>;
      for (const k of ['ratePerSecond', 'durationMs', 'concurrency'] as const) if (typeof p[k] === 'number') f[k] = p[k] as number;
      actions.set(p['invocationId'], f);
    }
    const out: GateOperation[] = [];
    for (const op of await deps.ledger.list({ runId })) {
      const spec = deps.registry.get(op.operationType);
      const effect = spec === undefined ? 'external' : typeof spec.effect === 'function' ? 'external' : spec.effect;
      if (effect !== 'external' && effect !== 'destructive') continue;
      const g: GateOperation = { operationId: op.operationId, toolId: op.operationType, effect, workItemId: op.workItemId, status: op.status, resourceKey: op.target.resourceKey, createdAt: op.createdAt };
      const experimentId = (op as { experimentId?: string }).experimentId;
      if (experimentId !== undefined) g.experimentId = experimentId;
      if (op.toolInvocationId !== undefined) {
        g.toolInvocationId = op.toolInvocationId;
        const a = actions.get(op.toolInvocationId);
        if (a) g.action = a;
      }
      out.push(g);
    }
    return out;
  }

  /** (D-3) Admission lapses and recorded stops of the run's experiments (C10). */
  async function experimentFacts(runId: string, experimentIds: string[]): Promise<ExperimentFacts[]> {
    const lapses = await events.read(runId, { types: [EVENT_TYPES.admissionLapsed, EVENT_TYPES.experimentStopped] });
    return experimentIds.map((id) => {
      const mine = lapses.filter((e) => e.aggregateId === id);
      const f: ExperimentFacts = {
        experimentId: id,
        lapses: mine.filter((e) => e.eventType === EVENT_TYPES.admissionLapsed).map((e) => ({ at: e.occurredAt, conflicts: ((e.payload as { conflicts?: string[] } | undefined)?.conflicts ?? []).map(String) })),
      };
      const stop = mine.find((e) => e.eventType === EVENT_TYPES.experimentStopped);
      if (stop) {
        const p = (stop.payload ?? {}) as { at?: string; condition?: string; reason?: string };
        f.stopped = { at: p.at ?? stop.occurredAt, condition: p.condition ?? 'manual', reason: p.reason ?? '' };
      }
      return f;
    });
  }

  /** (D-11) The registry's view of every environment the run's evidence, experiments, target or actions name (C11). */
  async function environmentFacts(run: TestRun, evidenceRecords: EvidenceRecord[], experimentEnvs: string[], operations: GateOperation[]): Promise<EnvironmentFacts[]> {
    const ids = new Set<string>(experimentEnvs);
    for (const e of evidenceRecords) if (e.environment?.environmentId) ids.add(e.environment.environmentId);
    if (run.target.environmentId !== undefined) ids.add(run.target.environmentId);
    for (const o of operations) if (o.resourceKey.startsWith('env/')) ids.add(o.resourceKey.slice(4).split('/')[0]!);
    const out: EnvironmentFacts[] = [];
    for (const id of [...ids].sort()) {
      const env = (deps.environments.load ? await deps.environments.load(id).catch(() => undefined) : undefined) ?? deps.environments.get(id);
      if (!env) {
        out.push({ environmentId: id, registered: false });
        continue;
      }
      const f: EnvironmentFacts = { environmentId: id, registered: true, generation: env.generation };
      if (env.buildDigest !== undefined) f.buildDigest = env.buildDigest;
      if (env.isolation !== undefined) f.dedicated = env.isolation.dedicated;
      out.push(f);
    }
    return out;
  }

  /**
   * (area-C-0) Parsed JSON artifacts of evidence referenced by claims whose field is not in the record's structured payload
   * (the store checks the digest), so the gate evaluates such claims too.
   */
  async function claimData(claims: GateInput['claims'], evidenceRecords: EvidenceRecord[]): Promise<Record<string, JsonValue>> {
    const byId = new Map(evidenceRecords.map((e) => [e.evidenceId, e]));
    const out: Record<string, JsonValue> = {};
    for (const c of claims) {
      const field = c.evidenceQuery?.field;
      if (c.value === undefined || typeof field !== 'string') continue;
      for (const ref of c.evidenceRefs) {
        const e = byId.get(ref);
        if (!e || Object.hasOwn(out, ref) || !/^application\/(json|x-ndjson)/.test(e.artifact.mimeType)) continue;
        const structured = e.structured;
        if (structured && typeof structured === 'object' && !Array.isArray(structured) && field.split('.')[0]! in structured) continue;
        try {
          out[ref] = JSON.parse(new TextDecoder().decode(await deps.artifacts.get(e.artifact))) as JsonValue;
        } catch {
          // unreadable: the claim stays unevaluable (unknown) at the gate
        }
      }
    }
    return out;
  }

  async function gateInput(run: TestRun, ctx: EventContext): Promise<GateInput> {
    const runId = run.runId;
    const gateSpec = (await store.getGate(runId)) ?? DEFAULT_GATE_SPEC;
    const plan = await blackboard.latestAcceptedPlan(runId);
    const oracles = [];
    /** conformance-4: pinned oracles approved in a newer revision meanwhile (the gate reports them superseded). */
    const currentOracleRevisions: Record<string, number> = {};
    for (const [oracleId, revision] of Object.entries(run.oracleRevisions)) {
      const o = await specs.getOracle(oracleId, revision);
      if (o) oracles.push(o);
      const latest = await specs.getOracle(oracleId);
      // D-10: a pinned revision declared invalid since (a newer `invalid` revision) is handed to the gate (C0 unknown)
      if (latest && latest.revision > revision && latest.status === 'invalid') oracles.push(latest);
      for (let rev = latest?.revision ?? 0; rev > revision; rev--) {
        const cand = rev === latest?.revision ? latest : await specs.getOracle(oracleId, rev);
        if (cand?.status === 'approved') {
          currentOracleRevisions[oracleId] = rev;
          break;
        }
      }
    }
    // Bind the decision to a sealed root when a signer is available (latestSeal() is unverified: use seal()'s result).
    let root: { rootHash: string; count: number; lastSeq: number };
    if (signer) {
      try {
        const seal = await evidence.seal(runId, { eventContext: { correlationId: ctx.correlationId, actorId: ctx.actorId } });
        root = { rootHash: seal.rootHash, count: seal.count, lastSeq: seal.lastSeq };
      } catch (e) {
        logger.warn('evidence could not be sealed; binding the decision to the unsealed root', { runId, error: (e as Error).message });
        root = await evidence.rootHash(runId);
      }
    } else {
      root = await evidence.rootHash(runId);
    }
    const allEvidence = (await evidence.query({ runId })).filter((e) => e.seq <= root.lastSeq);
    const latestDecision = await decisions.latestForRun(runId);
    const experiments = await specs.listExperiments(runId);
    const operations = await gateOperations(runId);
    const claims = await store.claims(runId);
    const systemModel = await specs.latestSystemModel(runId);
    const input: GateInput = {
      run,
      gate: gateSpec,
      objectives: plan?.objectives ?? [],
      oracles,
      ...(Object.keys(currentOracleRevisions).length > 0 ? { currentOracleRevisions } : {}),
      experiments,
      // with history (D-11: a critical finding cleared by an agent is judged from its lineage)
      findings: await blackboard.query<Finding>({ runId, recordType: 'finding', includeSuperseded: true }),
      risks: await blackboard.query<Risk>({ runId, recordType: 'risk' }),
      // with history: an artifact's oracle consistency review is found by its record id (D-1)
      reviews: await blackboard.query<Review>({ runId, recordType: 'review', includeSuperseded: true }),
      coverageGaps: await blackboard.query<CoverageGap>({ runId, recordType: 'coverage_gap' }),
      testArtifacts: await specs.listTestArtifacts(runId),
      evidence: allEvidence,
      evidenceRoot: { rootHash: root.rootHash, count: root.count },
      workItems: await blackboard.listWorkItems({ runId }),
      claims,
      exceptions: await gateExceptions(runId),
      operations,
      experimentFacts: await experimentFacts(runId, experiments.map((x) => x.experimentId)),
      environments: await environmentFacts(run, allEvidence, experiments.map((x) => x.environment.environmentId).filter((id) => id !== 'local'), operations),
      claimData: await claimData(claims, allEvidence),
      runtimeManifestId: run.runtimeManifestId,
      policyRevision: run.policyRevision,
      decisionId: ids.next('qd'),
      now: clock.isoNow(),
      producerProviders: await epochs.providersUsedByRoles(runId, [...PRODUCER_ROLES]),
      revision: (latestDecision?.revision ?? 0) + 1,
    };
    if (latestDecision) input.supersedes = latestDecision.decisionId;
    if (systemModel) input.systemModel = systemModel;
    return input;
  }

  async function proposeExperience(run: TestRun, ctx: EventContext): Promise<void> {
    try {
      const findings = await blackboard.query<Finding>({ runId: run.runId, recordType: 'finding', status: ['open', 'confirmed'] });
      const existing = new Set((await memory.list({ sourceRunId: run.runId })).map((x) => x.content));
      for (const f of findings as Array<BlackboardRecord<Finding>>) {
        const p = f.payload;
        if (!PRODUCT_CATEGORIES.has(p.category) || !['P0', 'P1', 'P2'].includes(p.severity)) continue;
        const content = clip(
          `${p.severity} ${p.category}${p.component ? ` in ${p.component}` : ''}: ${p.title}. ${p.description}${p.expected ? ` Expected: ${p.expected}.` : ''}${p.actual ? ` Actual: ${p.actual}.` : ''} (finding ${f.recordId}, run ${run.runId})`,
          4000,
        );
        if (existing.has(content)) continue;
        const scope: { project?: string; topic?: string } = {};
        const project = run.labels['project'];
        if (project !== undefined) scope.project = project;
        if (p.component !== undefined) scope.topic = p.component;
        // candidates only: never auto-approved (agent output must not silently become future testing policy)
        await memory.propose({ scope, kind: 'pitfall', content, sourceRunId: run.runId, evidenceRefs: f.evidenceRefs, createdBy: `system:control:${workerId}` }, ctx);
      }
    } catch (e) {
      logger.warn('experience candidates could not be proposed', { runId: run.runId, error: (e as Error).message });
    }
  }

  async function gateRun(start: TestRun): Promise<GateOutcome> {
    const ctx = runCtx(start.runId, workerId);
    // the run as stored now (a re-pin earlier in this tick moved its oracle revisions)
    let run = (await runs.get(start.runId)) ?? start;
    // BUGate before_transition (run → gating), every gate attempt: the scheduler keeps convergence authority (the run is
    // gated regardless), but a refusal withholds the verdict (at best inconclusive, human review)
    const items = await blackboard.listWorkItems({ runId: run.runId });
    const byState: Record<string, number> = {};
    for (const w of items) byState[w.state] = (byState[w.state] ?? 0) + 1;
    const gating = await phases.beforeTransition({
      runId: run.runId,
      transition: { subject: 'run', subjectId: run.runId, from: run.status, to: 'gating', details: { workItems: byState, attempt: (await store.replans(run.runId)).gateAttempts + 1 } },
      ctx,
    });
    if (run.status === 'running' || run.status === 'paused') run = await runs.update(run.runId, { status: 'converging' }, ctx);
    if (run.status === 'converging') run = await runs.update(run.runId, { status: 'gating' }, ctx);
    const input = await gateInput(run, ctx);
    let decision = gate.evaluate(input);
    // conformance-9: the recorded authority of a weakened gate is part of the signed decision; a weakening it does not
    // cover withholds the verdict — a gate row written around startRun (no authority, or none on record at all: then the
    // configured base is the reference), an authority record that is not a human/system one with a rationale, or a gate
    // weakened beyond what the authority was given for
    const recorded = await store.gateAuthority(run.runId);
    const judged = authorizedGateWeakenings(gateReference(recorded?.baseGate, config.defaultGate, DEFAULT_GATE_SPEC), input.gate, recorded);
    if (judged.authority) {
      const { by, rationale } = judged.authority;
      decision = { ...decision, reasons: [...decision.reasons, `gate override authorized by ${by.kind}:${by.id}: ${rationale}${judged.authorized.length > 0 ? ` (weakened: ${judged.authorized.join('; ')})` : ''}`] };
    }
    if (judged.unauthorized.length > 0) {
      decision = withPolicyHold(decision, {
        criterionId: 'gate.override_authority',
        description: 'gate override authority',
        detail: `the run's gate is weakened without a recorded human/system authority: ${judged.unauthorized.join('; ')}`,
      });
    }
    decision = applyPhasePermit(decision, gating, 'before_transition', 'run:gating');
    // BUGate before_acceptance: the gate input digest and the verdict go to the policy; a refusal caps the verdict
    const acceptanceAuthority = judged.authority ? { ...judged.authority, weakened: judged.authorized } : undefined;
    const acceptance = await phases.beforeAcceptance({
      runId: run.runId,
      facts: acceptanceFacts(input, decision, { flaggedActions: await phases.flaggedActions(run.runId), ...(acceptanceAuthority ? { gateOverrideAuthority: acceptanceAuthority } : {}) }),
      ctx,
    });
    decision = applyPhasePermit(decision, acceptance, 'before_acceptance');
    if (signer) {
      const { signature: _s, ...unsigned } = decision;
      const value = await signer.sign(canonicalJson(unsigned));
      decision = { ...decision, signature: { keyId: signer.keyId, algorithm: signer.algorithm, value } };
    }
    const replans = await store.replans(run.runId);
    const attempts = replans.gateAttempts + 1;
    const plans = await blackboard.listPlans(run.runId);
    const exhausted = await exhaustion(run);
    const feedbackCriteria = decision.unknownCriteria.filter((c) => FEEDBACK_CRITERIA.has(c.criterionId));
    // the feedback loop only when a replan can actually be scheduled (else the next tick would gate the same input again)
    const loop =
      decision.verdict === 'inconclusive' &&
      feedbackCriteria.length > 0 &&
      acceptedPlanCount(plans) < run.budget.maxPlanRevisions &&
      replans.revisionCount < run.budget.maxPlanRevisions &&
      exhausted === undefined &&
      attempts < MAX_GATE_ATTEMPTS &&
      (await factory.remainingWorkItems(run.runId)) >= 1;
    const feedback: GateFeedback | undefined = loop
      ? {
          decisionId: decision.decisionId,
          verdict: decision.verdict,
          unknownCriteria: decision.unknownCriteria.map((c) => compact({ criterionId: c.criterionId, description: c.description, detail: c.detail }) as GateFeedback['unknownCriteria'][number]),
          violatedCriteria: decision.violatedCriteria.map((c) => compact({ criterionId: c.criterionId, description: c.description, detail: c.detail }) as GateFeedback['violatedCriteria'][number]),
          reasons: decision.reasons,
        }
      : undefined;

    // Experience candidates BEFORE the final commit: a crash between the two cannot lose them (a re-gate after a crash
    // proposes nothing twice: candidates are deduplicated by content).
    if (!loop) await proposeExperience(run, ctx);
    let saved: { decision: QualityDecision; run: TestRun };
    try {
      saved = await db.transaction(async (tx) => {
      // Lock the run and re-check it: a pause/quarantine/cancel committed while the gate was being evaluated must win —
      // applying this outcome would silently undo it (e.g. the feedback loop's paused → running).
      const current = await runs.update(run.runId, {}, ctx, tx);
      if (current.status !== 'gating') throw new GateAbandoned(current);
      const d = await decisions.save(decision, ctx, tx);
      const payload = {
        decisionId: d.decisionId,
        revision: d.revision,
        verdict: d.verdict,
        gateId: d.gateId,
        requiresHumanReview: d.requiresHumanReview,
        evidenceRootHash: d.evidenceRootHash,
        evidenceCount: d.evidenceCount,
        satisfied: d.satisfiedCriteria.map((c) => c.criterionId),
        violated: d.violatedCriteria.map((c) => c.criterionId),
        unknown: d.unknownCriteria.map((c) => c.criterionId),
        signed: d.signature !== undefined,
        attempt: attempts,
        final: !loop,
        // BUGate: the phase decisions this verdict passed through (and any hold they put on it)
        policy: { gating: gating.decisionId, acceptance: acceptance.decisionId, holds: d.unknownCriteria.filter((c) => !c.criterionId.startsWith('C')).map((c) => c.criterionId) },
        ...(acceptanceAuthority ? { gateOverrideBy: acceptanceAuthority.by } : {}),
      };
      await events.append(
        [event(ctx, 'gate.evaluated', 'decision', d.decisionId, payload), event(ctx, d.verdict === 'pass' ? 'gate.passed' : 'gate.failed', 'decision', d.decisionId, { decisionId: d.decisionId, verdict: d.verdict, final: !loop })],
        tx,
      );
      await store.recordGateAttempt(run.runId, feedback, clock.isoNow(), tx);
      const next = loop
        ? await runs.update(run.runId, { status: 'running' }, ctx, tx)
        : await runs.update(run.runId, { status: 'completed', decisionId: d.decisionId }, ctx, tx);
      return { decision: d, run: next };
      });
    } catch (e) {
      if (!(e instanceof GateAbandoned)) throw e;
      logger.warn('quality gate outcome abandoned: the run left gating during evaluation', { runId: run.runId, status: e.run.status, pauseReason: e.run.pauseReason });
      return { final: false, run: e.run, abandoned: e.message };
    }
    logger.info('quality gate evaluated', { runId: run.runId, decisionId: saved.decision.decisionId, verdict: saved.decision.verdict, attempt: attempts, final: !loop });
    return { decision: saved.decision, final: !loop, run: saved.run };
  }

  async function requestRunReview(run: TestRun): Promise<boolean> {
    const gateSpec = (await store.getGate(run.runId)) ?? DEFAULT_GATE_SPEC;
    if (!gateSpec.requireIndependentReview) return false;
    // a review of the run (or of a decision) already exists — whatever its verdict, the gate judges it
    const reviews = await blackboard.query<Review>({ runId: run.runId, recordType: 'review' });
    if (reviews.some((r) => r.payload.subjectRef.kind === 'decision' || (r.payload.subjectRef.kind === 'run' && r.payload.subjectRef.id === run.runId))) return false;
    // nobody would react (no reviewer subscription): the gate fails safe on C6 instead of waiting
    if (!roles.subscriptions().some((sub) => sub.eventTypes.includes(EVENT_TYPES.reviewRequested))) return false;
    const attempt = (await store.replans(run.runId)).gateAttempts + 1;
    const eventId = runReviewRequestEventId(run.runId, attempt);
    if (await events.get(eventId)) return false; // requested for this gate attempt already (the review failed or was capped)
    const subjectRef = { kind: 'run', id: run.runId };
    const payload = {
      subjectRef,
      title: `run ${run.runId} before quality gate attempt ${attempt}`,
      summary: `The QualityGate requires an independent review of the run and none exists. Review the run as a whole: judge its recorded execution evidence (test results, HTTP exchanges, metrics) and its findings against the oracles in force — never the producers' narrative — and record the verdict with blackboard.post_review on subjectRef {"kind":"run","id":"${run.runId}"}.`,
      attempt,
      requiredBy: gateSpec.gateId,
    };
    await events.append([{ ...event(runCtx(run.runId, workerId), EVENT_TYPES.reviewRequested, 'run', run.runId, payload), eventId }]);
    logger.info('independent run review requested before the gate', { runId: run.runId, attempt });
    return true;
  }

  return {
    exhaustion,
    exhaustionDetail,
    maybeReplan,
    evaluate,
    gateReady,
    digest,
    requestRunReview,
    async gate(run) {
      try {
        return await gateRun(run);
      } catch (e) {
        if (isHypertestError(e)) logger.error('gate evaluation failed', { runId: run.runId, code: e.code, error: e.message });
        throw e;
      }
    },
  };
}

