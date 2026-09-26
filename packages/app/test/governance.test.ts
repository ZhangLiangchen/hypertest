import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EvidenceRecord, Finding, OracleAssertion, OracleChangeProposal, OracleSpec } from '@hypertest/domain';
import { changedAssertions, recordedFailureFlipDetector, testCaseMatches } from '../src/index.ts';

const assertion = (id: string, expected: 'pass' | 'fail' = 'pass'): OracleAssertion =>
  ({ assertionId: id, description: id, kind: 'deterministic_invariant', severity: 'P1', check: { type: 'test_outcome', testSelector: `*${id}*`, expected } }) as OracleAssertion;

const oracle: OracleSpec = { oracleId: 'oracle.pricing', revision: 1, assertions: [assertion('a1'), assertion('a2')] } as unknown as OracleSpec;

function proposal(assertions: OracleAssertion[], relatedEvidenceRefs: string[] = []): OracleChangeProposal {
  return {
    proposalId: 'ocp_1', runId: 'run_1', oracleId: 'oracle.pricing', fromRevision: 1, proposedAssertions: assertions, rationale: 'r',
    proposedBy: { kind: 'agent', id: 'ag_1' }, relatedEvidenceRefs, wouldFlipRecordedFailure: false, status: 'pending', createdAt: '2026-01-01T00:00:00.000Z',
  } as OracleChangeProposal;
}

function finding(p: Partial<Finding>): { payload: Finding } {
  return { payload: { title: 't', description: 'd', severity: 'P1', category: 'product_defect', status: 'open', fingerprint: 'f', ...p } as Finding };
}

function detector(findings: Array<{ payload: Finding }>, evidence: EvidenceRecord[] = [], base: OracleSpec | null = oracle, testResults?: EvidenceRecord[]) {
  return recordedFailureFlipDetector({
    getOracle: async () => base ?? undefined,
    findings: async () => findings,
    getEvidence: async (ids) => evidence.filter((e) => ids.includes(e.evidenceId)),
    ...(testResults ? { testResults: async (runId: string) => testResults.filter((e) => e.runId === runId) } : {}),
  });
}

const testResult = (id: string, runId: string, cases: Array<{ id?: string; name?: string; file?: string; status: string }>): EvidenceRecord =>
  ({ evidenceId: id, runId, evidenceType: 'test-result', structured: { passed: cases.every((c) => c.status === 'passed'), cases } }) as unknown as EvidenceRecord;

describe('recorded-failure flip detection (I8)', () => {
  test('changedAssertions: modified and removed assertions of the base revision; additions change nothing recorded', () => {
    assert.deepEqual(changedAssertions(oracle, proposal([assertion('a1', 'fail'), assertion('a3')])), ['a1', 'a2']);
    assert.deepEqual(changedAssertions(oracle, proposal([assertion('a1'), assertion('a2'), assertion('a3')])), []);
  });

  test('a finding of the run citing a changed assertion (or the whole oracle) is a flip', async () => {
    const weaken = proposal([assertion('a1', 'fail'), assertion('a2')]);
    assert.equal(await detector([finding({ oracleRef: { oracleId: 'oracle.pricing', revision: 1, assertionId: 'a1' } })])(weaken), true);
    assert.equal(await detector([finding({ oracleRef: { oracleId: 'oracle.pricing', revision: 1 } })])(weaken), true);
  });

  test('no flip: untouched assertion, other oracle, rejected finding, pure additions', async () => {
    const weaken = proposal([assertion('a1', 'fail'), assertion('a2')]);
    assert.equal(await detector([finding({ oracleRef: { oracleId: 'oracle.pricing', revision: 1, assertionId: 'a2' } })])(weaken), false);
    assert.equal(await detector([finding({ oracleRef: { oracleId: 'oracle.other', revision: 1, assertionId: 'a1' } })])(weaken), false);
    assert.equal(await detector([finding({ status: 'rejected', oracleRef: { oracleId: 'oracle.pricing', revision: 1, assertionId: 'a1' } })])(weaken), false);
    const add = proposal([assertion('a1'), assertion('a2'), assertion('a3')]);
    assert.equal(await detector([finding({ oracleRef: { oracleId: 'oracle.pricing', revision: 1, assertionId: 'a1' } })])(add), false);
  });

  test('cited failed test-result evidence of the same run is a flip; passing or foreign evidence is not', async () => {
    const ev = (id: string, runId: string, passed: boolean): EvidenceRecord => ({ evidenceId: id, runId, evidenceType: 'test-result', structured: { passed } }) as unknown as EvidenceRecord;
    const evidence = [ev('ev_fail', 'run_1', false), ev('ev_pass', 'run_1', true), ev('ev_foreign', 'run_2', false)];
    assert.equal(await detector([], evidence)(proposal([assertion('a1', 'fail')], ['ev_fail'])), true);
    assert.equal(await detector([], evidence)(proposal([assertion('a1', 'fail')], ['ev_pass'])), false);
    assert.equal(await detector([], evidence)(proposal([assertion('a1', 'fail')], ['ev_foreign'])), false);
  });

  test('an unknown base revision fails closed (treated as a flip)', async () => {
    assert.equal(await detector([], [], null)(proposal([assertion('a1')])), true);
  });

  test('a failed test case of the run matching a changed assertion is a flip even when the proposer cites nothing', async () => {
    const weaken = proposal([assertion('a1', 'fail'), assertion('a2')]); // changes a1 (selector *a1*), cites no evidence
    const failing = [testResult('ev_1', 'run_1', [{ id: 'test/pricing.test.js::a1 holds', status: 'failed' }])];
    assert.equal(await detector([], [], oracle, failing)(weaken), true);
    assert.equal(await detector([], [], oracle, [testResult('ev_1', 'run_1', [{ name: 'a1 holds', status: 'xfail' }])])(weaken), true, 'xfail records a known failure');
    // without the run scan (the previous behaviour) the same proposal passed as "no flip"
    assert.equal(await detector([], [], oracle)(weaken), false);
  });

  test('no flip from the run scan: passing or skipped cases, cases of other selectors, other runs, untouched assertions', async () => {
    const weaken = proposal([assertion('a1', 'fail'), assertion('a2')]);
    assert.equal(await detector([], [], oracle, [testResult('ev_1', 'run_1', [{ id: 'a1 ok', status: 'passed' }, { id: 'a1 skipped', status: 'skipped' }])])(weaken), false);
    assert.equal(await detector([], [], oracle, [testResult('ev_1', 'run_1', [{ id: 'a2 broken', status: 'failed' }])])(weaken), false, 'a2 is unchanged');
    assert.equal(await detector([], [], oracle, [testResult('ev_1', 'run_2', [{ id: 'a1 broken', status: 'failed' }])])(weaken), false, 'another run');
  });

  test('a finding revision that cited the assertion counts even when a later revision rejected it (the detector gets every revision)', async () => {
    const weaken = proposal([assertion('a1', 'fail'), assertion('a2')]);
    const revisions = [finding({ status: 'open', oracleRef: { oracleId: 'oracle.pricing', revision: 1, assertionId: 'a1' } }), finding({ status: 'rejected', oracleRef: { oracleId: 'oracle.pricing', revision: 1, assertionId: 'a1' } })];
    assert.equal(await detector(revisions)(weaken), true);
  });

  test('testCaseMatches follows the QualityGate: id, name or file::name; * matches any sequence (also /)', () => {
    assert.equal(testCaseMatches('*discount*', { id: 'test/pricing.test.js::10% discount' }), true);
    assert.equal(testCaseMatches('test/pricing.test.js::10% discount', { file: 'test/pricing.test.js', name: '10% discount' }), true);
    assert.equal(testCaseMatches('discount', { id: 'discount 10' }), false, 'no wildcard: exact match only');
    assert.equal(testCaseMatches('a.b*', { id: 'axb-1' }), false, 'regex metacharacters are literal');
  });
});
