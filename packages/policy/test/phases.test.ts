/**
 * BUGate four time points (technology-selection §BUGate): the PolicyEngine is evaluated before an action, after it,
 * before a state transition and before final acceptance. Default rules per phase, phase-scoped matching (a rule written
 * for actions never judges another phase), fail-closed facts, the decision log (phase on L0, replayable) and the
 * acceptance hold (a withheld verdict is at best inconclusive, never pass).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FixedClock, type JsonValue, type SqlDatabase } from '@hypertest/core';
import type { EvidenceRecord, QualityDecision, TestRun } from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';
import { eventCtx, testDeps } from '@hypertest/testkit';
import {
  BuiltinPolicyEngine, DEFAULT_GATE_SPEC, DEFAULT_POLICY_RULES, POLICY_RULE_SCHEMA, QualityGate, acceptanceFacts, actionOutcomeFacts, applyPhasePermit, createPolicyDecisionLog,
  createRootCapability, flaggedActionsOf, requestPhase, withPolicyHold,
  type AcceptanceFacts, type ActionPermit, type ActionRequest, type GateInput, type PolicyRule, type TransitionFacts,
} from '../src/index.ts';
import { validateJson } from '@hypertest/core';
import { NOW, SECRET, SqlEventSink, cap, migrations, request } from './helpers.ts';

let n = 0;
const engine = (rules: PolicyRule[] = DEFAULT_POLICY_RULES, options: { clock?: FixedClock; capabilitySecret?: string } = {}) =>
  new BuiltinPolicyEngine(rules, 'builtin@phases', { clock: options.clock ?? new FixedClock(NOW), newId: () => `pdec_ph_${++n}`, ...(options.capabilitySecret ? { capabilitySecret: options.capabilitySecret } : {}) });

const transition = (t: Partial<TransitionFacts> = {}): TransitionFacts => ({ subject: 'work_item', subjectId: 'wi_1', from: 'running', to: 'completed', flaggedActions: 0, ...t });

function acceptance(a: Partial<AcceptanceFacts> = {}): AcceptanceFacts {
  return {
    gateId: 'hypertest.default', gateOverrides: [], verdict: 'pass', requiresHumanReview: false, satisfiedCriteria: ['C0'], violatedCriteria: [], unknownCriteria: [],
    evidence: { count: 1, rootHash: 'r', byType: { 'test-result': 1 } }, findings: { total: 0, unresolved: [] }, risks: { total: 0, unresolved: [] }, reviews: [],
    oracleRevisions: {}, workItems: { completed: 1 }, claims: { total: 0, critical: 0 }, exceptions: [], flaggedActions: 0, ...a,
  };
}

const system = (overrides: Partial<ActionRequest> = {}): ActionRequest => request({ tool: 'transition.work_item', effect: 'record', riskClass: 'low', resources: ['run/run_1/work/wi_1'], ...overrides });

describe('phase-scoped rules', () => {
  test('a request without phase is before_action; a rule without phases is an action rule and never judges another phase', async () => {
    assert.equal(requestPhase(request()), 'before_action');
    const denyAll: PolicyRule = { id: 'deny-shell', description: 'no shell', match: { tools: ['shell.exec'] }, decision: 'deny' };
    const e = engine([...DEFAULT_POLICY_RULES, denyAll]);
    const shell = request({ tool: 'shell.exec', effect: 'execute', riskClass: 'medium' });
    assert.equal((await e.evaluate(shell)).decision, 'deny');
    assert.equal((await e.evaluate({ ...shell, phase: 'before_action' })).decision, 'deny');
    // the same action judged after it ran: only after_action rules apply (the action rule is not a flag)
    const after = await e.evaluate({ ...shell, phase: 'after_action', outcome: actionOutcomeFacts({ status: 'success', produced: [{ evidenceId: 'ev_1', evidenceType: 'stdout' }], declared: ['stdout', 'stderr'] }) });
    assert.equal(after.decision, 'allow');
    assert.deepEqual(after.reasons, ['rule:allow-after-action: an executed call whose outcome no rule flags passes the after_action check']);
  });

  test('a phase no rule speaks to is denied (fail closed): an engine with action rules only refuses transitions and acceptance', async () => {
    const actionOnly = engine(DEFAULT_POLICY_RULES.filter((r) => r.match.phases === undefined));
    for (const phase of ['after_action', 'before_transition', 'before_acceptance'] as const) {
      const p = await actionOnly.evaluate(system({ phase, transition: transition(), acceptance: acceptance(), outcome: actionOutcomeFacts({ status: 'success', produced: [] }) }));
      assert.equal(p.decision, 'deny', phase);
      assert.match(p.reasons[0]!, /^no_matching_rule/);
    }
  });

  test('custom rules: transitions patterns, verdicts and flagged actions match only the facts they name', async () => {
    const rules: PolicyRule[] = [
      ...DEFAULT_POLICY_RULES,
      { id: 'hold-plans-without-review', description: 'plans need approval', match: { phases: ['before_transition'], transitions: ['plan:*'] }, decision: 'approval_required' },
      { id: 'deny-conditional-pass', description: 'no conditional releases', match: { phases: ['before_acceptance'], verdicts: ['conditional'] }, decision: 'deny' },
    ];
    const e = engine(rules);
    assert.equal((await e.evaluate(system({ phase: 'before_transition', transition: transition({ subject: 'plan', to: 'accepted' }) }))).decision, 'approval_required');
    assert.equal((await e.evaluate(system({ phase: 'before_transition', transition: transition() }))).decision, 'allow', 'work_item:completed is not plan:*');
    // a transition rule never matches a request that carries no transition facts
    assert.equal((await e.evaluate(system({ phase: 'before_transition' }))).decision, 'allow');
    assert.equal((await e.evaluate(system({ phase: 'before_acceptance', acceptance: acceptance({ verdict: 'conditional' }) }))).decision, 'deny');
    assert.equal((await e.evaluate(system({ phase: 'before_acceptance', acceptance: acceptance({ verdict: 'pass' }) }))).decision, 'allow');
    assert.equal((await e.evaluate(system({ phase: 'before_acceptance' }))).decision, 'allow', 'a verdicts rule never matches without acceptance facts');
  });

  test('rule schema: phase fields are validated (unknown phase or verdict refused); a malformed phase request is denied', async () => {
    assert.equal(validateJson(POLICY_RULE_SCHEMA, { id: 'x', description: 'x', match: { phases: ['after_action'], undeclaredEvidence: true }, decision: 'deny' }).valid, true);
    assert.equal(validateJson(POLICY_RULE_SCHEMA, { id: 'x', description: 'x', match: { phases: ['during_action'] }, decision: 'deny' }).valid, false);
    assert.equal(validateJson(POLICY_RULE_SCHEMA, { id: 'x', description: 'x', match: { verdicts: ['maybe'] }, decision: 'deny' }).valid, false);
    assert.equal(validateJson(POLICY_RULE_SCHEMA, { id: 'x', description: 'x', match: { phases: [] }, decision: 'deny' }).valid, false);
    assert.throws(() => engine([{ id: 'x', description: 'x', match: { phases: ['whenever' as never] }, decision: 'allow' }]), { code: 'invalid_argument' });
    const bad = await engine().evaluate({ ...request(), phase: 'during_action' as never });
    assert.equal(bad.decision, 'deny');
    assert.match(bad.reasons[0]!, /^malformed_request: phase during_action/);
    const badOutcome = await engine().evaluate({ ...request(), phase: 'after_action', outcome: { status: 'success' } as never });
    assert.equal(badOutcome.decision, 'deny');
    assert.match(badOutcome.reasons[0]!, /^malformed_request: outcome/);
  });
});

describe('default rules per phase', () => {
  test('after_action: evidence of a type the tool does not declare is flagged; declared, implicit tool-output and undeclared tools pass', async () => {
    const e = engine();
    const judged = (produced: Array<{ evidenceId: string; evidenceType: string }>, declared?: string[]) =>
      e.evaluate(request({ tool: 'shell.exec', effect: 'execute', riskClass: 'medium', phase: 'after_action', outcome: actionOutcomeFacts(declared ? { status: 'success', produced, declared } : { status: 'success', produced }) }));
    assert.equal((await judged([{ evidenceId: 'ev_1', evidenceType: 'stdout' }, { evidenceId: 'ev_2', evidenceType: 'tool-output' }], ['stdout', 'stderr'])).decision, 'allow');
    const forged = await judged([{ evidenceId: 'ev_1', evidenceType: 'stdout' }, { evidenceId: 'ev_3', evidenceType: 'test-result' }], ['stdout', 'stderr']);
    assert.equal(forged.decision, 'deny');
    assert.match(forged.reasons[0]!, /^rule:flag-undeclared-evidence/);
    // a tool that declares nothing is not judged (no facts, no flag)
    assert.equal((await judged([{ evidenceId: 'ev_3', evidenceType: 'test-result' }])).decision, 'allow');
    const facts = actionOutcomeFacts({ status: 'failed', produced: [{ evidenceId: 'ev_b', evidenceType: 'metric' }, { evidenceId: 'ev_a', evidenceType: 'metric' }, { evidenceId: 'ev_c', evidenceType: 'log' }], declared: ['metric'] });
    assert.deepEqual(facts, { status: 'failed', evidenceTypes: ['log', 'metric'], evidenceIds: ['ev_a', 'ev_b', 'ev_c'], declaredEvidenceTypes: ['metric', 'tool-output'], undeclaredEvidenceTypes: ['log'] });
  });

  test('before_transition: allowed by default; a work item with flagged calls cannot complete (other transitions are not refused by it)', async () => {
    const e = engine();
    assert.equal((await e.evaluate(system({ phase: 'before_transition', transition: transition() }))).decision, 'allow');
    const flagged = await e.evaluate(system({ phase: 'before_transition', transition: transition({ flaggedActions: 2 }) }));
    assert.equal(flagged.decision, 'deny');
    assert.match(flagged.reasons[0]!, /^rule:deny-completion-with-flagged-actions/);
    assert.equal((await e.evaluate(system({ phase: 'before_transition', transition: transition({ subject: 'plan', to: 'accepted', flaggedActions: 2 }) }))).decision, 'allow');
    assert.equal((await e.evaluate(system({ phase: 'before_transition', transition: transition({ subject: 'run', to: 'gating', flaggedActions: 1 }) }))).decision, 'allow');
  });

  test('before_acceptance: the verdict stands by default; a run with flagged calls goes to human review', async () => {
    const e = engine();
    assert.equal((await e.evaluate(system({ phase: 'before_acceptance', acceptance: acceptance() }))).decision, 'allow');
    const flagged = await e.evaluate(system({ phase: 'before_acceptance', acceptance: acceptance({ flaggedActions: 1 }) }));
    assert.equal(flagged.decision, 'approval_required');
    assert.match(flagged.reasons[0]!, /^rule:review-flagged-actions/);
  });

  test('fail closed: a malformed flagged-actions count counts as flagged', async () => {
    assert.equal(flaggedActionsOf({ transition: transition({ flaggedActions: Number.NaN }) }), 1);
    assert.equal(flaggedActionsOf({ acceptance: acceptance({ flaggedActions: -3 }) }), 1);
    assert.equal(flaggedActionsOf({ acceptance: acceptance({ flaggedActions: '0' as never }) }), 1);
    assert.equal(flaggedActionsOf({}), 0);
    const p = await engine().evaluate(system({ phase: 'before_transition', transition: transition({ flaggedActions: 'none' as never }) }));
    assert.equal(p.decision, 'deny');
  });

  test('the capability is checked in every phase: an expired or foreign system capability is denied before any rule', async () => {
    const e = engine(DEFAULT_POLICY_RULES, { capabilitySecret: SECRET });
    const good = createRootCapability(
      { runId: 'run_1', subjectAgentId: 'system:control:w1', workItemId: 'run_1', profile: { name: 'phase', allowedEffects: ['record'], maxRiskClass: 'low', resourceScopes: ['run/run_1/**'], environmentClasses: [], credentialScopes: [] }, tools: ['transition.*'], expiresAt: '2026-01-01T00:05:00.000Z' },
      SECRET,
    );
    const req = system({ agentId: 'system:control:w1', workItemId: 'run_1', capability: good, phase: 'before_transition', transition: transition({ subject: 'run', subjectId: 'run_1', to: 'gating' }) });
    assert.equal((await e.evaluate(req)).decision, 'allow');
    const late = engine(DEFAULT_POLICY_RULES, { capabilitySecret: SECRET, clock: new FixedClock('2026-01-01T00:06:00.000Z') });
    assert.match((await late.evaluate(req)).reasons[0]!, /capability_expired/);
    assert.match((await e.evaluate({ ...req, capability: { ...good, signature: 'forged' } })).reasons[0]!, /capability_signature_invalid/);
  });
});

describe('decision log: the phase is on L0 and every phase decision is replayable', () => {
  let db: SqlDatabase;
  let dispose: () => Promise<void>;
  let sink: SqlEventSink;
  before(async () => {
    ({ db, dispose } = await createTestDatabase({ migrations }));
    sink = new SqlEventSink(db);
  });
  after(async () => dispose());

  test('record + re-evaluate the stored request (same rules, clock at decidedAt) ⇒ the same decision and reasons, for each phase', async () => {
    const runId = 'run_phases_log';
    const log = createPolicyDecisionLog({ ...testDeps(), db, events: sink });
    const e = engine();
    const requests: ActionRequest[] = [
      request({ runId, capability: cap({ runId }), requestId: 'r_before' }),
      request({ runId, capability: cap({ runId }), requestId: 'r_after', tool: 'shell.exec', effect: 'execute', riskClass: 'medium', phase: 'after_action', outcome: actionOutcomeFacts({ status: 'success', produced: [{ evidenceId: 'ev_1', evidenceType: 'test-result' }], declared: ['stdout'] }) }),
      system({ runId, capability: cap({ runId }), requestId: 'r_transition', phase: 'before_transition', transition: transition({ flaggedActions: 1 }) }),
      system({ runId, capability: cap({ runId }), requestId: 'r_acceptance', phase: 'before_acceptance', acceptance: acceptance({ flaggedActions: 1 }) }),
    ];
    const permits: ActionPermit[] = [];
    for (const r of requests) {
      const p = await e.evaluate(r);
      permits.push(p);
      await log.record(r, p, eventCtx(runId));
    }
    assert.deepEqual(permits.map((p) => p.decision), ['allow', 'deny', 'deny', 'approval_required']);
    const events = await sink.rows(runId);
    assert.deepEqual(events.map((x) => x.payload['phase']), ['before_action', 'after_action', 'before_transition', 'before_acceptance']);
    for (const rec of await log.list(runId)) {
      const replay = await engine(DEFAULT_POLICY_RULES, { clock: new FixedClock(rec.decidedAt) }).evaluate(rec.request);
      assert.equal(replay.decision, rec.permit.decision, rec.request.requestId);
      assert.deepEqual(replay.reasons, rec.permit.reasons, rec.request.requestId);
      assert.equal(rec.permit.policyRevision, 'builtin@phases');
    }
  });
});

// ------------------------------------------------------------------------------------------------ acceptance

const RUN = 'run_accept';
const run: TestRun = {
  runId: RUN, goal: 'g', target: {}, status: 'gating', budget: { maxWallClockMs: 1, maxAgentConcurrency: 1, maxModelTokens: 1, maxToolCalls: 1, maxWorkItems: 1, maxAgentDepth: 1, maxPlanRevisions: 1 },
  runtimeManifestId: 'rm_1', policyRevision: 'builtin@1', currentPlanRevision: 1, oracleRevisions: {}, experimentIds: [], labels: {}, createdAt: NOW, updatedAt: NOW,
};

function evidence(evidenceId: string, seq: number, evidenceType: string, structured: JsonValue): EvidenceRecord {
  return {
    evidenceId, seq, runId: RUN, evidenceType, artifact: { uri: `cas://sha256/${evidenceId}`, sha256: evidenceId, size: 1, mimeType: 'application/json' }, summary: evidenceId, structured,
    producer: { workerId: 'w1', runtimeManifestId: 'rm_1' }, provenance: {}, parentEvidenceIds: [], classification: 'internal', retentionPolicy: 'run', capturedAt: NOW, metadataHash: 'm', recordHash: `h_${evidenceId}`,
  };
}

function gateInput(): GateInput {
  const ev = [evidence('ev_t', 1, 'test-result', { cases: [{ id: 'x', status: 'passed' }], secretPayload: 'NEVER-IN-FACTS' }), evidence('ev_s', 2, 'stdout', null), evidence('ev_t2', 3, 'test-result', { cases: [] })];
  return {
    run, gate: { ...DEFAULT_GATE_SPEC, requireIndependentReview: false, requireOracle: false }, objectives: [], oracles: [], experiments: [], findings: [], risks: [], reviews: [], coverageGaps: [],
    testArtifacts: [], evidence: ev, evidenceRoot: { rootHash: 'root', count: ev.length }, workItems: [], claims: [], exceptions: [], runtimeManifestId: 'rm_1', policyRevision: 'builtin@1',
    decisionId: 'qd_1', now: NOW,
  };
}

describe('before_acceptance: facts and holds', () => {
  test('acceptanceFacts: a bounded digest of the gate input and the gate verdict (evidence counted by type, never its payloads)', () => {
    const input = gateInput();
    const decision = new QualityGate().evaluate(input);
    assert.equal(decision.verdict, 'pass', decision.reasons.join('\n'));
    const facts = acceptanceFacts(input, decision, { flaggedActions: 2, gateOverrideAuthority: { by: { kind: 'human', id: 'alice' }, rationale: 'black-box run', weakened: ['requireOracle=false'] } });
    assert.equal(facts.verdict, 'pass');
    assert.deepEqual(facts.evidence, { count: 3, rootHash: 'root', byType: { stdout: 1, 'test-result': 2 } });
    assert.deepEqual(facts.gateOverrides, ['requireIndependentReview=false', 'requireOracle=false']);
    assert.equal(facts.gateSpecDigest, decision.gateSpecDigest);
    assert.equal(facts.flaggedActions, 2);
    assert.deepEqual(facts.gateOverrideAuthority, { by: { kind: 'human', id: 'alice' }, rationale: 'black-box run', weakened: ['requireOracle=false'] });
    assert.ok(!JSON.stringify(facts).includes('NEVER-IN-FACTS'), 'evidence payloads never reach the policy input');
    assert.deepEqual(facts.satisfiedCriteria, decision.satisfiedCriteria.map((c) => c.criterionId));
  });

  test('a withheld acceptance caps the verdict: pass/conditional ⇒ inconclusive + human review; fail stays fail; allow changes nothing', () => {
    const decision = new QualityGate().evaluate(gateInput());
    const allow: ActionPermit = { decision: 'allow', decisionId: 'pdec_a', reasons: ['ok'], policyRevision: 'p@1' };
    assert.equal(applyPhasePermit(decision, allow, 'before_acceptance'), decision);
    for (const verdict of ['pass', 'conditional', 'inconclusive', 'fail'] as const) {
      for (const d of ['deny', 'approval_required'] as const) {
        const held = applyPhasePermit({ ...decision, verdict }, { decision: d, decisionId: 'pdec_x', reasons: ['rule:r: flagged'], policyRevision: 'p@1' }, 'before_acceptance');
        assert.equal(held.verdict, verdict === 'fail' ? 'fail' : 'inconclusive', `${verdict}/${d}`);
        assert.equal(held.requiresHumanReview, true);
        const hold = held.unknownCriteria.find((c) => c.criterionId === 'policy.before_acceptance')!;
        assert.equal(hold.status, 'unknown');
        assert.match(hold.detail!, new RegExp(`^${d} by policy decision pdec_x \\(policy p@1\\): rule:r: flagged$`));
        assert.notEqual(held.verdict, 'pass');
      }
    }
    // a malformed permit is not an allow
    assert.equal(applyPhasePermit(decision, { ...allow, decision: 'maybe' as never }, 'before_transition', 'run:gating').verdict, 'inconclusive');
    const held: QualityDecision = withPolicyHold(decision, { criterionId: 'gate.override_authority', description: 'gate override authority', detail: 'no authority' });
    assert.deepEqual(held.unknownCriteria.map((c) => c.criterionId), ['gate.override_authority']);
    assert.match(held.reasons[held.reasons.length - 1]!, /^verdict inconclusive: gate override authority withholds the gate's pass/);
  });
});
