import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hashCanonical, type SqlDatabase } from '@hypertest/core';
import { createTestDatabase, migrate } from '@hypertest/store';
import { eventCtx, infraEnv, skipUnless, testDeps } from '@hypertest/testkit';
import { createApprovalService, createPolicyDecisionLog, policyMigrations, type ApprovalService, type PolicyDecisionLog } from '../src/index.ts';
import { SqlEventSink, migrations, request } from './helpers.ts';

// Real PostgreSQL 16: pooled connections make concurrent deciders genuinely race (PGlite serializes).
const pgUrl = infraEnv().pgUrl;
const skip = skipUnless(!!pgUrl, 'HYPERTEST_TEST_PG_URL is not set (no local PostgreSQL; run npm run infra:up)');

let db: SqlDatabase | undefined;
let dispose: (() => Promise<void>) | undefined;
let sink: SqlEventSink;
let approvals: ApprovalService;
let log: PolicyDecisionLog;

before(async () => {
  if (!pgUrl) return;
  process.env['HYPERTEST_TEST_PG_URL'] ??= pgUrl;
  ({ db, dispose } = await createTestDatabase({ kind: 'postgres', migrations }));
  sink = new SqlEventSink(db);
  approvals = createApprovalService({ ...testDeps(), db, events: sink });
  log = createPolicyDecisionLog({ ...testDeps(), db, events: sink });
});
after(async () => {
  await dispose?.();
});

test('postgres: policy migrations are idempotent', skip, async () => {
  const report = await migrate(db!, policyMigrations);
  assert.deepEqual(report.applied, []);
  assert.deepEqual(report.skipped, policyMigrations.map((m) => m.id));
});

test('postgres: 12 concurrent deciders — exactly one wins, the rest get precondition_failed, one grant event', skip, async () => {
  const runId = 'run_pg_race';
  const a = await approvals.request({ runId, kind: 'action', subject: { tool: 'env.restart' }, requestedBy: { kind: 'agent', id: 'agent_env' } }, eventCtx(runId));
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => approvals.decide(a.approvalId, i % 2 === 0, { kind: 'human', id: `user_${i}` }, `decider ${i}`, eventCtx(runId))),
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 11);
  for (const f of failed) assert.equal((f.reason as { code?: string }).code, 'precondition_failed');
  const final = await approvals.get(a.approvalId);
  const winner = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<ApprovalService['decide']>>>).value;
  assert.deepEqual(final, winner);
  const events = (await sink.rows(runId)).map((e) => e.event_type);
  assert.equal(events.filter((e) => e === 'approval.granted' || e === 'approval.denied').length, 1);
});

test('postgres: decision log round trip, append-only trigger and jsonb fidelity', skip, async () => {
  const runId = 'run_pg_dlog';
  const req = request({ runId, input: { path: 'src/ü.ts', n: 1.5, nested: { a: [1, 'b', null] } } });
  const rec = await log.record(req, { decision: 'deny', decisionId: 'pdec_pg_1', reasons: ['no_matching_rule: x'], policyRevision: 'builtin@1' }, eventCtx(runId));
  assert.deepEqual(await log.get('pdec_pg_1'), rec);
  assert.deepEqual((await log.get('pdec_pg_1'))?.request, req);
  await assert.rejects(db!.query(`UPDATE ht_policy_decisions SET decision = 'allow'`), /append-only/);
  await assert.rejects(db!.query(`TRUNCATE ht_policy_decisions`), /append-only/);
});

test('postgres: NUL characters in tool input are stored (sanitized) and the row re-verifies', skip, async () => {
  const runId = 'run_pg_nul';
  const req = request({ runId, input: { content: 'a\u0000b' } });
  const rec = await log.record(req, { decision: 'allow', decisionId: 'pdec_pg_nul', reasons: ['x'], policyRevision: 'builtin@1' }, eventCtx(runId));
  assert.deepEqual((await log.get('pdec_pg_nul'))?.request.input, { content: 'a�b' });
  assert.equal(rec.requestHash, hashCanonical((await log.get('pdec_pg_nul'))!.request));
});

test('postgres: an agent cannot decide an action approval even under concurrency with a human (the human wins)', skip, async () => {
  const runId = 'run_pg_agent';
  const a = await approvals.request({ runId, kind: 'action', subject: { tool: 'env.restart' }, requestedBy: { kind: 'agent', id: 'agent_env', role: 'environment', modelProvider: 'openai' } }, eventCtx(runId));
  const [agent, person] = await Promise.allSettled([
    approvals.decide(a.approvalId, true, { kind: 'agent', id: 'agent_rev', role: 'reviewer', modelProvider: 'anthropic' }, 'go', eventCtx(runId)),
    approvals.decide(a.approvalId, false, { kind: 'human', id: 'user_ops' }, 'not now', eventCtx(runId)),
  ]);
  assert.equal(agent.status, 'rejected');
  assert.equal(((agent as PromiseRejectedResult).reason as { code?: string }).code, 'permission_denied');
  assert.equal(person.status, 'fulfilled');
  assert.equal((await approvals.get(a.approvalId))?.status, 'denied');
});
