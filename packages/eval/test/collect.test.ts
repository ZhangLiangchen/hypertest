/**
 * Trial-data collection over a stub instance (hermetic): only the run's FINAL decision is its verdict (an interim
 * feedback-loop decision is kept for the audit but never graded), and fixture probes fail closed.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HypertestError, type JsonValue } from '@hypertest/core';
import type { QualityDecision, TestRun } from '@hypertest/domain';
import { collectTrialData, evidenceIntegrityGrader, runProbes, verdictGrader, type TrialFixture } from '../src/index.ts';
import { RUN_ID, ctx, decision, manifest, run, task } from './helpers.ts';

const HARNESS = { restarts: 0, injectedModelTimeouts: 0, duplicateDelivery: false, timedOut: false };

/** A HypertestInstance stub over one run and its decisions (newest first), with empty stores otherwise. */
function instance(r: TestRun, decisions: QualityDecision[]): Parameters<typeof collectTrialData>[0] {
  const byId = new Map(decisions.map((d) => [d.decisionId, d]));
  const stub = {
    services: {
      runs: { get: async (id: string) => (id === r.runId ? r : undefined) },
      events: { read: async () => [] },
      decisions: { latestForRun: async () => decisions[0], get: async (id: string) => byId.get(id) },
      operations: { list: async () => [] },
      blackboard: { query: async () => [], listPlans: async () => [], listWorkItems: async () => [] },
      evidence: {
        query: async () => [],
        verify: async () => ({ ok: true, runId: r.runId, count: 0, rootHash: 'r', problems: [] }),
        latestSeal: async () => undefined,
        seal: async () => ({ runId: r.runId, rootHash: 'r', count: 0, lastSeq: 0, keyId: 'k', algorithm: 'ed25519', signature: 's', sealedAt: 'now' }),
        count: async () => 0,
      },
      decisionLog: { list: async () => [] },
      publicKeys: {},
      db: {
        query: async (sql: string) => (sql.includes('ht_manifests') ? { rows: [{ manifest: manifest() }] } : { rows: [] }),
      },
    },
    verifyEvidence: async () => ({ ok: true, problems: [] }),
    report: async () => ({ claims: [] }),
  };
  return stub as unknown as Parameters<typeof collectTrialData>[0];
}

describe('collectTrialData: the verdict is the run\'s final decision only', () => {
  test('a cancelled run with an interim (feedback-loop) inconclusive decision has NO verdict — never a pass for expected inconclusive', async () => {
    const interim = decision('inconclusive', { decisionId: 'qd_interim' });
    const cancelled = run({ status: 'cancelled' }); // no decisionId: the gate asked for more evidence, then the run was cancelled
    const data = await collectTrialData(instance(cancelled, [interim]), { runId: RUN_ID, probes: {}, harness: HARNESS });
    assert.equal(data.decision, undefined);
    assert.deepEqual(data.decisions.map((d) => d.decisionId), ['qd_interim'], 'kept for the audit (every decision has gate.evaluated)');
    const expectsInconclusive = task({ expectedVerdict: 'inconclusive' });
    assert.deepEqual(await verdictGrader(ctx(data, expectsInconclusive)), { graderId: 'verdict', pass: false, score: 0, detail: 'no verdict (run status cancelled); expected inconclusive' });
    // the integrity grader cannot vouch for a decision the run does not have
    const integrity = await evidenceIntegrityGrader(ctx(data, expectsInconclusive, instance(cancelled, [interim])));
    assert.equal(integrity.detail, '2/4 checks failed: decision signed and bound to its evidence: the run has no decision; the decision root was sealed: no seal');
  });

  test('a completed run: its decisionId names the verdict (the interim one before it stays an audit record)', async () => {
    const interim = decision('inconclusive', { decisionId: 'qd_1', revision: 1 });
    const final = decision('fail', { decisionId: 'qd_2', revision: 2, supersedes: 'qd_1' });
    const data = await collectTrialData(instance(run({ status: 'completed', decisionId: 'qd_2' }), [final, interim]), { runId: RUN_ID, probes: {}, harness: HARNESS });
    assert.equal(data.decision?.decisionId, 'qd_2');
    assert.deepEqual(data.decisions.map((d) => d.decisionId), ['qd_2', 'qd_1']);
    assert.equal((await verdictGrader(ctx(data))).detail, 'verdict fail (expected fail)');
  });

  test('no run id, or an unknown run: empty data (graders then fail on the missing run)', async () => {
    const i = instance(run(), []);
    const none = await collectTrialData(i, { probes: { p: 1 }, harness: HARNESS });
    assert.deepEqual([none.runId, none.run, none.events, none.probes], [undefined, undefined, [], { p: 1 }]);
    const unknown = await collectTrialData(i, { runId: 'run_unknown', probes: {}, harness: HARNESS });
    assert.deepEqual([unknown.runId, unknown.run], ['run_unknown', undefined]);
  });
});

describe('runProbes: environment state or a precondition failure', () => {
  const fixture = (probes: Record<string, () => Promise<JsonValue>>): TrialFixture => ({ target: {}, probes, cleanup: async () => undefined });
  const precondition = (re: RegExp) => (e: unknown): boolean => e instanceof HypertestError && e.code === 'precondition_failed' && re.test((e as Error).message);

  test('every probe once, in name order, normalised to JSON (undefined ⇒ null)', async () => {
    const order: string[] = [];
    const out = await runProbes(fixture({
      b: async () => (order.push('b'), { n: 1 }),
      a: async () => (order.push('a'), undefined as never),
    }));
    assert.deepEqual(order, ['a', 'b']);
    assert.deepEqual(out, { a: null, b: { n: 1 } });
    assert.deepEqual(await runProbes({ target: {}, cleanup: async () => undefined }), {});
  });

  test('a throwing, hanging or non-JSON probe fails closed (the environment state is unknown)', async () => {
    await assert.rejects(runProbes(fixture({ x: async () => Promise.reject(new Error('port closed')) })), precondition(/^probe x failed: port closed$/));
    const started = Date.now();
    await assert.rejects(runProbes(fixture({ slow: () => new Promise<JsonValue>(() => undefined) }), 50), precondition(/^probe slow failed: timed out after 50 ms$/));
    assert.ok(Date.now() - started < 5000);
    await assert.rejects(runProbes(fixture({ big: async () => 10n as never })), precondition(/^probe big failed: /));
  });
});
