import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidSchema } from '@hypertest/core';
import {
  canTransitionWorkItem, canTransitionOperation, canTransitionRun, workItemFingerprint, claimsConflict, riskLevel,
  isEligibleTestArtifact, atLeastAsSevere, PLAN_PROPOSAL_SCHEMA, FINDING_INPUT_SCHEMA, HYPOTHESIS_INPUT_SCHEMA,
  COVERAGE_GAP_INPUT_SCHEMA, RISK_INPUT_SCHEMA, REVIEW_INPUT_SCHEMA, ORACLE_CHANGE_INPUT_SCHEMA, TEST_ARTIFACT_INPUT_SCHEMA,
  SYSTEM_MODEL_INPUT_SCHEMA, WORK_COMPLETION_SCHEMA, type TestArtifact,
} from '../src/index.ts';

test('state machines allow only declared transitions', () => {
  assert.ok(canTransitionWorkItem('ready', 'claimed'));
  assert.ok(!canTransitionWorkItem('completed', 'running'));
  assert.ok(canTransitionOperation('dispatching', 'outcome_unknown'));
  assert.ok(!canTransitionOperation('outcome_unknown', 'dispatching'), 'unknown outcomes must reconcile before re-dispatch');
  assert.ok(!canTransitionOperation('verified', 'dispatching'));
  // never dispatched (e.g. refused as resource_busy) ⇒ recorded not_applied, re-dispatchable; but never back to prepared
  assert.ok(canTransitionOperation('prepared', 'not_applied'));
  assert.ok(canTransitionOperation('not_applied', 'dispatching'));
  assert.ok(!canTransitionOperation('not_applied', 'prepared'));
  assert.ok(canTransitionRun('gating', 'completed'));
  assert.ok(!canTransitionRun('completed', 'running'));
});

test('work fingerprints are stable under whitespace/case and ref order', () => {
  const a = workItemFingerprint({ runId: 'r', role: 'rca', objective: 'Investigate  Finding X', originKey: 'rec_1', inputRefs: [{ kind: 'record', id: 'b' }, { kind: 'record', id: 'a' }] });
  const b = workItemFingerprint({ runId: 'r', role: 'rca', objective: 'investigate finding x', originKey: 'rec_1', inputRefs: [{ kind: 'record', id: 'a' }, { kind: 'record', id: 'b' }] });
  assert.equal(a, b);
  assert.notEqual(a, workItemFingerprint({ runId: 'r', role: 'test_designer', objective: 'investigate finding x', originKey: 'rec_1' }));
});

test('resource claims conflict on overlapping exclusive keys only', () => {
  assert.ok(!claimsConflict({ resourceKey: 'service/payment', mode: 'read_shared' }, { resourceKey: 'service/payment', mode: 'read_shared' }));
  assert.ok(claimsConflict({ resourceKey: 'service/payment', mode: 'fault_exclusive' }, { resourceKey: 'service/payment', mode: 'read_shared' }));
  assert.ok(claimsConflict({ resourceKey: 'cluster/a', mode: 'write_exclusive' }, { resourceKey: 'cluster/a/ns/x', mode: 'read_shared' }));
  assert.ok(!claimsConflict({ resourceKey: 'cluster/a', mode: 'write_exclusive' }, { resourceKey: 'cluster/ab', mode: 'write_exclusive' }));
});

test('risk levels and severities order correctly', () => {
  assert.equal(riskLevel('high', 'critical'), 'critical');
  assert.equal(riskLevel('low', 'low'), 'low');
  assert.ok(atLeastAsSevere('P0', 'P1'));
  assert.ok(!atLeastAsSevere('P2', 'P1'));
});

test('generated tests need demonstrated sensitivity to be eligible', () => {
  const base: TestArtifact = {
    artifactId: 'ta_1', runId: 'r', revision: 1, path: 't.test.js', artifactDigest: 'x', sourceType: 'generated',
    oracleRefs: [], runner: { framework: 'node_test', selector: 't.test.js' }, validations: {}, approvalState: 'validated', createdAt: '',
  };
  assert.equal(isEligibleTestArtifact(base), false);
  // D-1: sensitivity alone is not enough — every lifecycle stage and an approving oracle consistency review are required
  assert.equal(isEligibleTestArtifact({ ...base, validations: { knownBad: { status: 'passed', evidenceRefs: ['e'] } } }), false);
  const passed = { status: 'passed' as const, evidenceRefs: ['e'] };
  const review = { reviewRecordId: 'rec_r', reviewerAgentId: 'agent_r', reviewerRole: 'reviewer', verdict: 'approve' as const, artifactDigest: 'x', oracleRevisions: {}, at: '' };
  const complete: TestArtifact = { ...base, approvalState: 'approved', oracleReview: review, validations: { static: passed, knownGood: passed, knownBad: passed } };
  assert.equal(isEligibleTestArtifact(complete), true);
  assert.equal(isEligibleTestArtifact({ ...complete, validations: { static: passed, knownGood: passed, mutation: passed } }), true, 'mutation is sensitivity too');
  assert.equal(isEligibleTestArtifact({ ...complete, approvalState: 'validated' }), false, 'no oracle review');
  assert.equal(isEligibleTestArtifact({ ...complete, oracleReview: { ...review, artifactDigest: 'other' } }), false, 'review of other content');
  assert.equal(isEligibleTestArtifact({ ...complete, validations: { knownGood: passed, knownBad: passed } }), false, 'no static check');
  assert.equal(isEligibleTestArtifact({ ...complete, validations: { static: passed, knownBad: passed } }), false, 'no known-good');
  assert.equal(isEligibleTestArtifact({ ...complete, validations: { static: passed, knownBad: passed, knownGoodUnavailable: { reason: 'no base behaviour', recordedBy: 'a', at: '' } } }), true, 'an explicit unavailability reason');
  assert.equal(isEligibleTestArtifact({ ...base, sourceType: 'existing' }), true);
  assert.equal(isEligibleTestArtifact({ ...base, sourceType: 'existing', approvalState: 'quarantined' }), false);
});

test('all LLM-facing schemas compile', () => {
  for (const s of [PLAN_PROPOSAL_SCHEMA, FINDING_INPUT_SCHEMA, HYPOTHESIS_INPUT_SCHEMA, COVERAGE_GAP_INPUT_SCHEMA, RISK_INPUT_SCHEMA, REVIEW_INPUT_SCHEMA, ORACLE_CHANGE_INPUT_SCHEMA, TEST_ARTIFACT_INPUT_SCHEMA, SYSTEM_MODEL_INPUT_SCHEMA, WORK_COMPLETION_SCHEMA]) {
    assert.ok(isValidSchema(s));
  }
});
