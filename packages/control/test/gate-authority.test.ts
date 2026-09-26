/**
 * conformance-9: weakening a run's gate relative to DEFAULT_GATE_SPEC ⊕ configuration needs a recorded human/system
 * authority (StartRunInput.gateOverrideBy + gateOverrideRationale): recorded with the run's gate, on L0 and in every
 * signed QualityDecision of the run. A missing authority is invalid_argument; an agent (as the named authority or as the
 * caller) is permission_denied. Re-targeting required evidence between deterministic execution types is not a weakening;
 * a weakened gate row without an authority (written around startRun) withholds the verdict.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalJson, isHypertestError } from '@hypertest/core';
import type { GateSpec } from '@hypertest/domain';
import { verifyEd25519 } from '@hypertest/evidence';
import { DEFAULT_GATE_SPEC } from '@hypertest/policy';
import { ControlStore, createControlPlane, gateWeakenings } from '../src/index.ts';
import { call, createHarness, drive, type Harness } from './harness.ts';

const gate = (g: Partial<GateSpec> = {}): GateSpec => ({ ...DEFAULT_GATE_SPEC, ...g });

describe('gateWeakenings: what counts as weakening the gate', () => {
  test('each weakened dimension is named; stricter or re-labelled gates are not weakenings', () => {
    assert.deepEqual(gateWeakenings(gate(), gate()), []);
    assert.deepEqual(gateWeakenings(gate(), gate({ gateId: 'release.v2', description: 'renamed' })), []);
    assert.deepEqual(gateWeakenings(gate(), gate({ failOnUnresolvedSeverity: 'P2', conditionalOnRiskLevel: 'medium', minCoverage: { lines: 0.8 } })), [], 'stricter');
    assert.deepEqual(gateWeakenings(gate(), gate({ failOnUnresolvedSeverity: 'P0' })), ['failOnUnresolvedSeverity: P1 → P0 (fewer unresolved findings fail the gate)']);
    assert.deepEqual(gateWeakenings(gate(), gate({ conditionalOnRiskLevel: 'critical' })), ['conditionalOnRiskLevel: high → critical (fewer open risks make the verdict conditional)']);
    assert.deepEqual(gateWeakenings(gate(), gate({ requireIndependentReview: false, requireDeterministicForCritical: false, requireOracle: false })), [
      'requireDeterministicForCritical: true → false',
      'requireIndependentReview: true → false',
      'requireOracle: true → false',
    ]);
    // a legacy gate without requireOracle requires an oracle: clearing it is a weakening too
    const { requireOracle: _r, ...legacy } = gate();
    assert.deepEqual(gateWeakenings(legacy as GateSpec, gate({ requireOracle: false })), ['requireOracle: true → false']);
    // coverage thresholds compare as ratios (80 = 0.8)
    assert.deepEqual(gateWeakenings(gate({ minCoverage: { lines: 80 } }), gate({ minCoverage: { lines: 0.8 } })), []);
    assert.deepEqual(gateWeakenings(gate({ minCoverage: { lines: 80, branches: 0.5 } }), gate({ minCoverage: { lines: 0.7 } })), ['minCoverage.lines: 80 → 0.7', 'minCoverage.branches: 0.5 → null']);
  });

  test('required evidence: removal, lower counts or a switch to narrative output weaken; re-targeting between execution evidence types does not', () => {
    const one = (evidenceType: string, minCount = 1) => ({ evidenceType, minCount, critical: true });
    // PoC B / C: a black-box or load run requires api-response / metric instead of test-result
    assert.deepEqual(gateWeakenings(gate(), gate({ requiredEvidence: [one('api-response')] })), []);
    assert.deepEqual(gateWeakenings(gate(), gate({ requiredEvidence: [one('metric')] })), []);
    assert.deepEqual(gateWeakenings(gate(), gate({ requiredEvidence: [one('test-result', 2), one('coverage')] })), []);
    assert.deepEqual(gateWeakenings(gate(), gate({ requiredEvidence: [] })), ['requiredEvidence: 1× test-result is no longer required (none required)']);
    assert.deepEqual(gateWeakenings(gate(), gate({ requiredEvidence: [one('stdout')] })), ['requiredEvidence: 1× test-result is no longer required (required: 1× stdout)']);
    assert.deepEqual(gateWeakenings(gate({ requiredEvidence: [one('test-result', 3)] }), gate({ requiredEvidence: [one('test-result', 2)] })), ['requiredEvidence: 3× test-result is no longer required (required: 2× test-result)']);
    // one effective requirement cannot stand in for two base requirements (a matching, not a cover)
    assert.deepEqual(gateWeakenings(gate({ requiredEvidence: [one('test-result'), one('metric')] }), gate({ requiredEvidence: [one('api-response', 5)] })), [
      'requiredEvidence: 1× metric is no longer required (required: 5× api-response)',
    ]);
    // the matching finds the assignment that works (greedy would fail here)
    assert.deepEqual(gateWeakenings(gate({ requiredEvidence: [one('metric'), one('test-result', 2)] }), gate({ requiredEvidence: [one('test-result', 2), one('api-response')] })), []);
  });
});

const LEAD: Parameters<typeof createHarness>[0] = {
  brains: {
    lead: (v) => {
      if (v.step === 0) return call('plan.propose_revision', { rationale: 'nothing to do', objectives: [{ objectiveId: 'o', description: 'd', priority: 'P3', status: 'dropped' }], workItems: [], readyForGate: true });
      return call('complete_work', { summary: 'ready', output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'o', status: 'dropped', evidenceRefs: [] }] } });
    },
  },
};

async function rejects(p: Promise<unknown>, code: string, re: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => isHypertestError(e, code as never) && re.test((e as Error).message));
}

describe('startRun: a weakening gate override needs a recorded human/system authority', () => {
  test('missing, malformed, agent-named or agent-made authority is refused and creates nothing', async () => {
    const h = await createHarness(LEAD);
    try {
      const weak = { goal: 'weak', target: {}, gate: { requireIndependentReview: false, requiredEvidence: [] } };
      await rejects(h.control.startRun(weak), 'invalid_argument', /weakens the run's gate and needs a recorded human\/system authority[\s\S]*requireIndependentReview: true → false[\s\S]*1× test-result is no longer required/);
      await rejects(h.control.startRun({ ...weak, gateOverrideBy: { kind: 'agent', id: 'ag_lead', role: 'lead' }, gateOverrideRationale: 'I say so' }), 'permission_denied', /never authorized by an agent \(gateOverrideBy is agent ag_lead\)/);
      await rejects(h.control.startRun({ ...weak, gateOverrideBy: { kind: 'human', id: 'alice' }, gateOverrideRationale: 'ok' }, { agentId: 'ag_lead', actorId: 'ag_lead' }), 'permission_denied', /the call is made by agent ag_lead/);
      await rejects(h.control.startRun(weak, { agentId: 'ag_lead' }), 'invalid_argument', /needs a recorded human\/system authority/);
      await rejects(h.control.startRun({ ...weak, gateOverrideBy: { kind: 'human', id: 'alice' } }), 'invalid_argument', /gateOverrideRationale is required/);
      await rejects(h.control.startRun({ ...weak, gateOverrideBy: { kind: 'human', id: 'alice' }, gateOverrideRationale: '   ' }), 'invalid_argument', /gateOverrideRationale is required/);
      await rejects(h.control.startRun({ ...weak, gateOverrideRationale: 'why' }), 'invalid_argument', /without gateOverrideBy/);
      await rejects(h.control.startRun({ ...weak, gateOverrideBy: { kind: 'human', id: '' }, gateOverrideRationale: 'x' }), 'invalid_argument', /non-empty id/);
      await rejects(h.control.startRun({ ...weak, gateOverrideBy: { kind: 'robot' as never, id: 'r2' }, gateOverrideRationale: 'x' }), 'invalid_argument', /must be human or system/);
      assert.deepEqual(await h.deps.runs.list({}), [], 'no run was created');
      // a stricter override needs no authority; a system authority is accepted
      assert.equal((await h.control.startRun({ goal: 'stricter', target: {}, gate: { failOnUnresolvedSeverity: 'P2' } })).status, 'running');
      assert.equal((await h.control.startRun({ ...weak, goal: 'ci', gateOverrideBy: { kind: 'system', id: 'ci:nightly' }, gateOverrideRationale: 'smoke run' })).status, 'running');
    } finally {
      await h.dispose();
    }
  });

  test('the configuration is the base: a weakening configured by the operator needs no per-run authority', async () => {
    const h = await createHarness({ ...LEAD, config: { defaultGate: { requireIndependentReview: false } } });
    try {
      const run = await h.control.startRun({ goal: 'configured', target: {}, gate: { requireIndependentReview: false } });
      assert.equal(run.status, 'running');
      assert.deepEqual((await new ControlStore(h.db).gateAuthority(run.runId))!.weakened, []);
      // relative to that base, clearing requireOracle is still a weakening
      await rejects(h.control.startRun({ goal: 'no oracle', target: {}, gate: { requireOracle: false } }), 'invalid_argument', /requireOracle: true → false/);
    } finally {
      await h.dispose();
    }
  });

  test('the authority is recorded with the gate and on L0, and signed into every decision of the run', async () => {
    const h: Harness = await createHarness(LEAD);
    try {
      const run = await h.control.startRun({ goal: 'authorized', target: {}, gate: { requireIndependentReview: false }, gateOverrideBy: { kind: 'human', id: 'alice' }, gateOverrideRationale: 'no reviewer model deployed yet' });
      const recorded = (await new ControlStore(h.db).gateAuthority(run.runId))!;
      assert.deepEqual(recorded.by, { kind: 'human', id: 'alice' });
      assert.equal(recorded.rationale, 'no reviewer model deployed yet');
      assert.deepEqual(recorded.weakened, ['requireIndependentReview: true → false']);
      assert.deepEqual(recorded.baseGate, DEFAULT_GATE_SPEC);
      const events = await h.deps.events.read(run.runId, { types: ['gate.override_authorized'] });
      assert.equal(events.length, 1);
      assert.deepEqual(events[0]!.payload as Record<string, unknown>, {
        gateId: DEFAULT_GATE_SPEC.gateId, weakened: ['requireIndependentReview: true → false'], overrides: ['requireIndependentReview=false'], by: { kind: 'human', id: 'alice' }, rationale: 'no reviewer model deployed yet',
      });
      const decision = (await drive(h, run.runId, 20)).final!.decision!;
      const line = 'gate override authorized by human:alice: no reviewer model deployed yet (weakened: requireIndependentReview: true → false)';
      assert.ok(decision.reasons.includes(line), decision.reasons.join('\n'));
      assert.deepEqual(decision.gateOverrides, ['requireIndependentReview=false']);
      const { signature, ...unsigned } = decision;
      assert.equal(verifyEd25519(h.deps.signer!.publicKeyPem(), canonicalJson(unsigned), signature!.value), true, 'the authority is inside the signed content');
      assert.equal(verifyEd25519(h.deps.signer!.publicKeyPem(), canonicalJson({ ...unsigned, reasons: unsigned.reasons.filter((r) => r !== line) }), signature!.value), false);
      assert.deepEqual(((await h.deps.events.read(run.runId, { types: ['gate.evaluated'] })).at(-1)!.payload as Record<string, unknown>)['gateOverrideBy'], { kind: 'human', id: 'alice' });
    } finally {
      await h.dispose();
    }
  });

  test('defense in depth: a weakened gate row without an authority (written around startRun) withholds the verdict', async () => {
    const h = await createHarness(LEAD);
    try {
      const run = await h.control.startRun({ goal: 'tampered', target: {}, gate: { requireIndependentReview: false }, gateOverrideBy: { kind: 'human', id: 'alice' }, gateOverrideRationale: 'r' });
      await h.db.query('UPDATE ht_run_gates SET override_by = NULL, override_rationale = NULL WHERE run_id = $1', [run.runId]);
      const decision = (await drive(h, run.runId, 20)).final!.decision!;
      assert.equal(decision.requiresHumanReview, true);
      const hold = decision.unknownCriteria.find((c) => c.criterionId === 'gate.override_authority');
      assert.ok(hold, decision.unknownCriteria.map((c) => c.criterionId).join(','));
      assert.match(hold.detail!, /weakened without a recorded human\/system authority: requireIndependentReview: true → false/);
      assert.notEqual(decision.verdict, 'pass');
    } finally {
      await h.dispose();
    }
  });

  test('defense in depth: tampering with the recorded authority or weakening the gate further never passes as authorized', async () => {
    const holdOf = (d: { unknownCriteria: Array<{ criterionId: string; detail?: string }> }) => d.unknownCriteria.find((c) => c.criterionId === 'gate.override_authority');
    // (a) the gate is weakened further after start: the authority covers only what it was given for
    const h = await createHarness(LEAD);
    try {
      const run = await h.control.startRun({ goal: 'further', target: {}, gate: { requireIndependentReview: false }, gateOverrideBy: { kind: 'human', id: 'alice' }, gateOverrideRationale: 'r' });
      await h.db.query(`UPDATE ht_run_gates SET gate = jsonb_set(gate, '{requiredEvidence}', '[]'::jsonb) WHERE run_id = $1`, [run.runId]);
      const decision = (await drive(h, run.runId, 20)).final!.decision!;
      assert.equal(decision.requiresHumanReview, true);
      assert.notEqual(decision.verdict, 'pass');
      const hold = holdOf(decision);
      assert.ok(hold, decision.unknownCriteria.map((c) => c.criterionId).join(','));
      assert.match(hold.detail!, /without a recorded human\/system authority: requiredEvidence: 1× test-result is no longer required \(none required\)$/);
      assert.ok(decision.reasons.includes('gate override authorized by human:alice: r (weakened: requireIndependentReview: true → false)'), decision.reasons.join('\n'));
      const markdown = (await h.control.report(run.runId)).markdown;
      assert.match(markdown, /\*\*Gate override authority:\*\* human:alice — r \(weakened: requireIndependentReview: true → false\)\n/, 'the authorized part');
      assert.match(markdown, /\*\*Gate override authority:\*\* NONE recorded for a weakened gate \(requiredEvidence: 1× test-result is no longer required/);
    } finally {
      await h.dispose();
    }
    // (b) the whole authority record is gone (no base, no weakenings): the configured base is the reference
    const g = await createHarness(LEAD);
    try {
      const run = await g.control.startRun({ goal: 'gone', target: {}, gate: { requireIndependentReview: false }, gateOverrideBy: { kind: 'human', id: 'alice' }, gateOverrideRationale: 'r' });
      await g.db.query('UPDATE ht_run_gates SET base_gate = NULL, weakened = NULL, override_by = NULL, override_rationale = NULL WHERE run_id = $1', [run.runId]);
      const decision = (await drive(g, run.runId, 20)).final!.decision!;
      assert.equal(decision.requiresHumanReview, true);
      assert.notEqual(decision.verdict, 'pass');
      assert.match(holdOf(decision)?.detail ?? '', /without a recorded human\/system authority: requireIndependentReview: true → false$/);
    } finally {
      await g.dispose();
    }
    // (c) the recorded authority names an agent: it authorizes nothing
    const k = await createHarness(LEAD);
    try {
      const run = await k.control.startRun({ goal: 'agent', target: {}, gate: { requireIndependentReview: false }, gateOverrideBy: { kind: 'human', id: 'alice' }, gateOverrideRationale: 'r' });
      await k.db.query(`UPDATE ht_run_gates SET override_by = '{"kind":"agent","id":"ag_lead","role":"lead"}'::jsonb WHERE run_id = $1`, [run.runId]);
      const decision = (await drive(k, run.runId, 20)).final!.decision!;
      assert.equal(decision.requiresHumanReview, true);
      assert.match(holdOf(decision)?.detail ?? '', /requireIndependentReview: true → false$/);
      assert.ok(!decision.reasons.some((r) => r.startsWith('gate override authorized by')), decision.reasons.join('\n'));
    } finally {
      await k.dispose();
    }
  });

  test('an idempotent retry of an authorized run returns it; another runtime\'s control plane checks the authority the same way', async () => {
    const h = await createHarness(LEAD);
    try {
      const input = { goal: 'retry', target: {}, gate: { requireOracle: false }, gateOverrideBy: { kind: 'human' as const, id: 'alice' }, gateOverrideRationale: 'exploration' };
      const run = await h.control.startRun(input);
      assert.deepEqual(await h.control.startRun({ ...input, runId: run.runId }), await h.deps.runs.get(run.runId));
      const other = createControlPlane({ ...h.deps });
      try {
        await rejects(other.startRun({ goal: 'retry', target: {}, gate: { requireOracle: false } }), 'invalid_argument', /requireOracle: true → false/);
      } finally {
        await other.close();
      }
    } finally {
      await h.dispose();
    }
  });
});
