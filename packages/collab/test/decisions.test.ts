import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { eventCtx } from '@hypertest/testkit';
import { decision, openEnv, rejectsWith, types, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

test('decisions are append-only: a re-decision gets revision+1 and supersedes the previous decision', async () => {
  const runId = 'qd-1';
  const ctx = eventCtx(runId);
  const d1 = await env.decisions.save(decision(runId, 'qd_1a', { verdict: 'inconclusive' }), ctx);
  const d2 = await env.decisions.save(decision(runId, 'qd_1b', { verdict: 'fail', revision: 1 }), ctx);
  assert.deepEqual([d1.revision, d1.supersedes, d2.revision, d2.supersedes], [1, undefined, 2, 'qd_1a']);
  assert.deepEqual(await env.decisions.latestForRun(runId), d2);
  assert.deepEqual(await env.decisions.get('qd_1a'), d1, 'the superseded decision is unchanged');
  assert.equal(await env.decisions.latestForRun('qd-none'), undefined);
  const evs = await env.events.read(runId);
  assert.deepEqual(types(evs), ['decision.recorded', 'decision.recorded']);
  assert.deepEqual(evs[1]!.payload, { decisionId: 'qd_1b', revision: 2, supersedes: 'qd_1a', verdict: 'fail', gateId: 'release', requiresHumanReview: false, evidenceRootHash: 'root-1' });
});

test('a recorded decision cannot be rewritten; an identical re-save is idempotent', async () => {
  const runId = 'qd-2';
  const ctx = eventCtx(runId);
  const d = await env.decisions.save(decision(runId, 'qd_2'), ctx);
  assert.deepEqual(await env.decisions.save(decision(runId, 'qd_2'), ctx), d);
  await rejectsWith(env.decisions.save(decision(runId, 'qd_2', { verdict: 'pass' }), ctx), 'conflict');
  assert.equal((await env.decisions.get('qd_2'))!.verdict, 'fail');
  assert.equal((await env.events.read(runId)).length, 1);
});

test('a signed decision must already carry the chain position (the store never rewrites signed content)', async () => {
  const runId = 'qd-3';
  const ctx = eventCtx(runId);
  const signature = { keyId: 'k1', algorithm: 'ed25519', value: 'sig' };
  await env.decisions.save(decision(runId, 'qd_3a', { signature }), ctx);
  const err = await rejectsWith(env.decisions.save(decision(runId, 'qd_3b', { signature, revision: 1 }), ctx), 'conflict');
  assert.deepEqual([err.details['expectedRevision'], err.details['expectedSupersedes']], [2, 'qd_3a']);
  const ok = await env.decisions.save(decision(runId, 'qd_3b', { signature, revision: 2, supersedes: 'qd_3a' }), ctx);
  assert.equal(ok.revision, 2);
  await rejectsWith(env.decisions.save(decision(runId, 'qd_3c'), eventCtx('qd-elsewhere')), 'invalid_argument');
});

test('findByOracleRevision finds exactly the decisions that used that oracle revision', async () => {
  const ctxA = eventCtx('qd-4a');
  const ctxB = eventCtx('qd-4b');
  await env.decisions.save(decision('qd-4a', 'qd_4a', { oracleRevisions: { 'or-q4': 1, 'or-other': 3 } }), ctxA);
  await env.decisions.save(decision('qd-4b', 'qd_4b', { oracleRevisions: { 'or-q4': 2 } }), ctxB);
  await env.decisions.save(decision('qd-4b', 'qd_4c', { oracleRevisions: { 'or-q4': 1 } }), ctxB);
  assert.deepEqual((await env.decisions.findByOracleRevision('or-q4', 1)).map((d) => d.decisionId), ['qd_4a', 'qd_4c']);
  assert.deepEqual((await env.decisions.findByOracleRevision('or-q4', 2)).map((d) => d.decisionId), ['qd_4b']);
  assert.deepEqual(await env.decisions.findByOracleRevision('or-q4', 9), []);
  assert.deepEqual((await env.decisions.findByOracleRevision('or-other', 3)).map((d) => d.decisionId), ['qd_4a']);
});

test('markNeedsReassessment flags the decision once and records it in the decision run', async () => {
  const ctx = eventCtx('qd-5');
  await env.decisions.save(decision('qd-5', 'qd_5'), ctx);
  assert.deepEqual(await env.decisions.reassessment('qd_5'), { needsReassessment: false });
  const governance = eventCtx('qd-5-governance', { actorId: 'human:alice', causationId: 'evt_approval' });
  await env.decisions.markNeedsReassessment('qd_5', 'oracle or-1 revision 1 was invalidated', governance);
  await env.decisions.markNeedsReassessment('qd_5', 'second call', governance);
  assert.deepEqual(await env.decisions.reassessment('qd_5'), { needsReassessment: true, reason: 'oracle or-1 revision 1 was invalidated' });
  assert.equal((await env.decisions.get('qd_5'))!.verdict, 'fail', 'the decision document itself is immutable');
  const flagged = (await env.events.read('qd-5')).filter((e) => (e.payload as Record<string, unknown>)['needsReassessment'] === true);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0]!.eventType, 'decision.recorded');
  assert.equal(flagged[0]!.actorId, 'human:alice');
  assert.equal(flagged[0]!.causationId, 'evt_approval');
  assert.deepEqual(flagged[0]!.payload, { decisionId: 'qd_5', revision: 1, needsReassessment: true, reason: 'oracle or-1 revision 1 was invalidated', requestedInRun: 'qd-5-governance' });
  await rejectsWith(env.decisions.markNeedsReassessment('qd_missing', 'x', governance), 'not_found');
  assert.equal(await env.decisions.reassessment('qd_missing'), undefined);
});
