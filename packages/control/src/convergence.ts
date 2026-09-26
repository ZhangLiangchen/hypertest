import { canonicalJson, isHypertestError, sha256Hex } from '@hypertest/core';
import {
  EVENT_TYPES, isTerminalWorkState, workItemFingerprint,
  type BlackboardRecord, type CoverageGap, type EventContext, type Finding, type Hypothesis, type PlanRevision, type QualityDecision, type Review, type Risk,
  type TestRun, type WorkItem,
} from '@hypertest/domain';
import { DEFAULT_GATE_SPEC, acceptanceFacts, applyPhasePermit, withPolicyHold, type GateInput } from '@hypertest/policy';
import type { NewWorkItem } from '@hypertest/collab';
import { EVIDENCE_PRODUCER_ROLES } from '@hypertest/agents';
import type { ConvergenceState } from './contracts.ts';
import type { ControlDeps, ResolvedControlConfig } from './deps.ts';
import { acceptedPlanCount } from './domain-tools/plan.ts';
import { createPhaseGovernor } from './phases.ts';
import { ControlStore, type GateFeedback, type ReplanState } from './store.ts';
import { WorkFactory, runScope } from './work-factory.ts';
import { authorizedGateWeakenings, clip, compact, event, gateReference, runCtx, workBudgetFor } from './util.ts';

/** Criteria whose `unknown` status a replan can address by gathering more evidence (gate feedback loop). */
export const FEEDBACK_CRITERIA: ReadonlySet<string> = new Set(['C3', 'C4', 'C6', 'C8']);
/** Gate evaluations per run: the first may send the lead back for more evidence, the second is final. */
export const MAX_GATE_ATTEMPTS = 2;
/**
 * Roles whose model providers produced findings/tests/evidence/fixes (reviewer independence input of the gate, C6). The
 * agents catalog's EVIDENCE_PRODUCER_ROLES — the very list the reviewer's routing avoids (independentFromRoles) — so the
 * gate and the router always count the same producers (H10: metrics_analyst and environment included).
 */
export const PRODUCER_ROLES: readonly string[] = EVIDENCE_PRODUCER_ROLES;
const PRODUCT_CATEGORIES: ReadonlySet<string> = new Set(['product_defect', 'security', 'performance']);

export type ReplanReason = 'plan_drained' | 'gate_feedback';

export interface ReplanOutcome {
  scheduled: boolean;
  reason?: ReplanReason;
  workItemId?: string;
  /** Why no replan could be scheduled although one was due. */
  blocked?: 'lead_active' | 'max_plan_revisions' | 'livelock' | 'work_item_cap';
}

export interface GateOutcome {
  decision: QualityDecision;
  final: boolean;
  run: TestRun;
}

export interface ConvergenceMonitor {
  /** Budget/wall-clock exhaustion of the run (never a silent downgrade: the run converges to the gate). */
  exhaustion(run: TestRun): Promise<'budget' | 'wall_clock' | undefined>;
  /** Replan triggers: plan drained (latest plan not readyForGate) or pending gate feedback; at most one active lead item. */
  maybeReplan(run: TestRun, items: WorkItem[]): Promise<ReplanOutcome>;
  /** Classifies the run's state after a tick's scheduling steps. */
  evaluate(run: TestRun, items: WorkItem[], info: { pendingEvents: number; exhausted?: 'budget' | 'wall_clock'; replan: ReplanOutcome }): Promise<ConvergenceState>;
  /** True when the state allows the gate: drained/stalled/exhausted with nothing active or runnable and no pending events. */
  gateReady(state: ConvergenceState, items: WorkItem[], pendingEvents: number): boolean;
  /** running → converging → gating → QualityGate → decision (signed, sealed) → completed, or back to running with feedback. */
  gate(run: TestRun): Promise<GateOutcome>;
  /** Replan digest shown to the lead (exported for tests and reports). */
  digest(run: TestRun, items: WorkItem[], reason: ReplanReason, ordinal: number, replans: ReplanState): Promise<string>;
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
    if (clock.nowMs() - Date.parse(run.createdAt) > run.budget.maxWallClockMs) return 'wall_clock';
    const usage = await budget.usage(runScope(run.runId));
    if (!usage) return undefined;
    // conformance-5: sandbox compute and stored artifact bytes are consumable run budgets too (never a silent overrun)
    for (const d of ['tokens', 'costUsd', 'toolCalls', 'computeMs', 'artifactBytes'] as const) {
      const limit = usage.limits[d];
      if (limit !== undefined && (usage.used[d] ?? 0) >= limit) return 'budget';
    }
    // No model call fits any more: even the output reserve of one call exceeds what is left. Reservations of calls in
    // flight are NOT subtracted: they settle to their actual use, so they make room scarce only transiently — and this
    // verdict is permanent (pending work is cancelled).
    const tokens = usage.limits.tokens;
    if (tokens !== undefined && tokens - (usage.used.tokens ?? 0) < config.maxOutputTokens) return 'budget';
    // a model call was refused by the run scope at the current limit while no other call held a reservation (an
    // operator raising the limit clears it; a refusal caused by concurrent reservations is transient)
    if (tokens !== undefined) {
      const refused = (await events.read(run.runId, { types: ['budget.exhausted'] })).some((e) => {
        const p = (e.payload ?? {}) as { scope?: string; reason?: string; limit?: number; reservedByOthers?: number };
        return p.scope === runScope(run.runId) && p.reason === 'model_tokens' && typeof p.limit === 'number' && tokens <= p.limit && (p.reservedByOthers ?? 0) === 0;
      });
      if (refused) return 'budget';
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

  async function digest(run: TestRun, items: WorkItem[], reason: ReplanReason, ordinal: number, replans: ReplanState): Promise<string> {
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

  async function maybeReplan(run: TestRun, items: WorkItem[]): Promise<ReplanOutcome> {
    const replans = await store.replans(run.runId);
    const plans = await blackboard.listPlans(run.runId);
    const latest = await blackboard.latestAcceptedPlan(run.runId);
    let reason: ReplanReason | undefined;
    if (replans.feedbackPending) reason = 'gate_feedback';
    else if (items.every((w) => isTerminalWorkState(w.state)) && !latest?.readyForGate) reason = 'plan_drained';
    if (!reason) return { scheduled: false };
    const blocked = await replanBlocker(run, items, plans, replans);
    if (blocked) return { scheduled: false, reason, blocked };
    const lead = roles.require('lead');
    const ctx = runCtx(run.runId, workerId);
    const ordinal = replans.revisionCount + 1;
    const objective = await digest(run, items, reason, ordinal, replans);
    const item: NewWorkItem = {
      runId: run.runId,
      kind: 'replan',
      origin: { kind: 'system', reason: `replan:${reason}` },
      title: `Replan #${ordinal}: ${reason === 'gate_feedback' ? 'address QualityGate feedback' : 'plan drained'}`,
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
      fingerprint: workItemFingerprint({ runId: run.runId, role: 'lead', objective: `replan #${ordinal}`, originKey: `replan:${ordinal}` }),
      resourceClaims: [],
      state: 'ready',
    };
    if (lead.outputSchema !== undefined) item.expectedOutput = lead.outputSchema;
    const created = await db.transaction(async (tx) => {
      const r = await factory.create(item, ctx, tx);
      if (r.status === 'capped') return undefined;
      // a concurrent tick already scheduled this ordinal (fingerprint duplicate): count the replan once
      if (r.status === 'created') await store.recordReplan(run.runId, reason, clock.isoNow(), tx);
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
    const input: GateInput = {
      run,
      gate: gateSpec,
      objectives: plan?.objectives ?? [],
      oracles,
      ...(Object.keys(currentOracleRevisions).length > 0 ? { currentOracleRevisions } : {}),
      experiments: await specs.listExperiments(runId),
      findings: await blackboard.query<Finding>({ runId, recordType: 'finding' }),
      risks: await blackboard.query<Risk>({ runId, recordType: 'risk' }),
      reviews: await blackboard.query<Review>({ runId, recordType: 'review' }),
      coverageGaps: await blackboard.query<CoverageGap>({ runId, recordType: 'coverage_gap' }),
      testArtifacts: await specs.listTestArtifacts(runId),
      evidence: allEvidence,
      evidenceRoot: { rootHash: root.rootHash, count: root.count },
      workItems: await blackboard.listWorkItems({ runId }),
      claims: await store.claims(runId),
      exceptions: await gateExceptions(runId),
      runtimeManifestId: run.runtimeManifestId,
      policyRevision: run.policyRevision,
      decisionId: ids.next('qd'),
      now: clock.isoNow(),
      producerProviders: await epochs.providersUsedByRoles(runId, [...PRODUCER_ROLES]),
      revision: (latestDecision?.revision ?? 0) + 1,
    };
    if (latestDecision) input.supersedes = latestDecision.decisionId;
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
    let run = start;
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
    const saved = await db.transaction(async (tx) => {
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

