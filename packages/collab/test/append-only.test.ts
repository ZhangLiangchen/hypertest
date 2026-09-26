import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { eventCtx } from '@hypertest/testkit';
import { decision, openEnv, type Env } from './helpers.ts';

/**
 * conformance-15: the L0 event store and the revisioned Domain Contract history are append-only in the DATABASE
 * (triggers, SQLSTATE 42501), not only in application code. Runs on PGlite, and on PostgreSQL 16 with
 * HYPERTEST_TEST_DB=postgres.
 */
let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

const APPEND_ONLY = /append-only table/;
const NOW = '2026-01-01T00:00:00.000Z';

test('L0: events can be appended but never updated, deleted or truncated', async () => {
  const runId = 'ao-events';
  const [e] = await env.events.append([{ runId, eventType: 'run.created', aggregateType: 'run', aggregateId: runId, correlationId: 'c', actorId: 'system', payload: { goal: 'g' } }]);
  assert.ok(e);
  await assert.rejects(env.db.query("UPDATE ht_events SET payload = '{}'::jsonb WHERE event_id = $1", [e.eventId]), APPEND_ONLY);
  await assert.rejects(env.db.query('UPDATE ht_events SET event_type = $2 WHERE event_id = $1', [e.eventId, 'run.completed']), APPEND_ONLY);
  await assert.rejects(env.db.query('DELETE FROM ht_events WHERE event_id = $1', [e.eventId]), APPEND_ONLY);
  await assert.rejects(env.db.query('TRUNCATE ht_events'), APPEND_ONLY);
  const back = await env.events.read(runId);
  assert.deepEqual(back.map((x) => [x.eventId, x.eventType, x.payload]), [[e.eventId, 'run.created', { goal: 'g' }]]);
  // appending keeps working
  await env.events.append([{ runId, eventType: 'run.completed', aggregateType: 'run', aggregateId: runId, correlationId: 'c', actorId: 'system', payload: {} }]);
  assert.equal((await env.events.read(runId)).length, 2);
});

test('revision tables (system models, oracles, experiments, test artifacts) accept new revisions only', async () => {
  await env.db.query("INSERT INTO ht_system_models (system_model_id, revision, run_id, model, created_at) VALUES ('sm-ao', 1, 'ao-rev', '{}'::jsonb, $1)", [NOW]);
  await env.db.query("INSERT INTO ht_oracles (oracle_id, revision, status, spec, created_at) VALUES ('or-ao', 1, 'approved', '{}'::jsonb, $1)", [NOW]);
  await env.db.query("INSERT INTO ht_experiments (experiment_id, revision, run_id, spec, created_at) VALUES ('ex-ao', 1, 'ao-rev', '{}'::jsonb, $1)", [NOW]);
  await env.db.query("INSERT INTO ht_test_artifacts (artifact_id, revision, run_id, approval_state, artifact, created_at) VALUES ('ta-ao', 1, 'ao-rev', 'draft', '{}'::jsonb, $1)", [NOW]);
  const tables: Array<[string, string, string]> = [
    ['ht_system_models', 'system_model_id', 'sm-ao'],
    ['ht_oracles', 'oracle_id', 'or-ao'],
    ['ht_experiments', 'experiment_id', 'ex-ao'],
    ['ht_test_artifacts', 'artifact_id', 'ta-ao'],
  ];
  for (const [table, key, id] of tables) {
    await assert.rejects(env.db.query(`UPDATE ${table} SET revision = 7 WHERE ${key} = $1`, [id]), APPEND_ONLY, `${table} update`);
    await assert.rejects(env.db.query(`DELETE FROM ${table} WHERE ${key} = $1`, [id]), APPEND_ONLY, `${table} delete`);
    await assert.rejects(env.db.query(`TRUNCATE ${table}`), APPEND_ONLY, `${table} truncate`);
  }
  // the oracle status of a revision (e.g. approved) and a test artifact's approval state cannot be flipped in place
  await assert.rejects(env.db.query("UPDATE ht_oracles SET status = 'draft' WHERE oracle_id = 'or-ao'"), APPEND_ONLY);
  await assert.rejects(env.db.query("UPDATE ht_test_artifacts SET approval_state = 'validated' WHERE artifact_id = 'ta-ao'"), APPEND_ONLY);
  // new revisions are still accepted
  await env.db.query("INSERT INTO ht_oracles (oracle_id, revision, status, spec, created_at) VALUES ('or-ao', 2, 'approved', '{}'::jsonb, $1)", [NOW]);
  const r = await env.db.query<{ n: number }>("SELECT count(*)::int AS n FROM ht_oracles WHERE oracle_id = 'or-ao'");
  assert.equal(r.rows[0]!.n, 2);
});

test('decisions: immutable except the one-way reassessment flag; never deleted or truncated', async () => {
  const runId = 'ao-dec';
  const ctx = eventCtx(runId);
  await env.decisions.save(decision(runId, 'qd_ao'), ctx);
  // the document, the verdict and the chain position cannot be rewritten
  await assert.rejects(env.db.query("UPDATE ht_decisions SET verdict = 'pass' WHERE decision_id = 'qd_ao'"), APPEND_ONLY);
  await assert.rejects(env.db.query("UPDATE ht_decisions SET decision = '{}'::jsonb WHERE decision_id = 'qd_ao'"), APPEND_ONLY);
  await assert.rejects(env.db.query("UPDATE ht_decisions SET oracle_revisions = '{}'::jsonb WHERE decision_id = 'qd_ao'"), APPEND_ONLY);
  await assert.rejects(env.db.query("UPDATE ht_decisions SET revision = 9 WHERE decision_id = 'qd_ao'"), APPEND_ONLY);
  await assert.rejects(env.db.query("UPDATE ht_decisions SET verdict = 'pass', needs_reassessment = true WHERE decision_id = 'qd_ao'"), APPEND_ONLY, 'piggy-backing on the flag');
  await assert.rejects(env.db.query("DELETE FROM ht_decisions WHERE decision_id = 'qd_ao'"), APPEND_ONLY);
  await assert.rejects(env.db.query('TRUNCATE ht_decisions'), APPEND_ONLY);
  // the governed path still works: false → true with its reason
  await env.decisions.markNeedsReassessment('qd_ao', 'oracle or-1 revision 1 was invalidated', ctx);
  assert.deepEqual(await env.decisions.reassessment('qd_ao'), { needsReassessment: true, reason: 'oracle or-1 revision 1 was invalidated' });
  // …and is one-way: the flag cannot be cleared nor its reason rewritten
  await assert.rejects(env.db.query("UPDATE ht_decisions SET needs_reassessment = false WHERE decision_id = 'qd_ao'"), APPEND_ONLY);
  await assert.rejects(env.db.query("UPDATE ht_decisions SET reassessment_reason = 'nothing happened' WHERE decision_id = 'qd_ao'"), APPEND_ONLY);
  assert.equal((await env.decisions.get('qd_ao'))!.verdict, 'fail');
});
