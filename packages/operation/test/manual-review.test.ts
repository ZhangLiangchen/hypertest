/**
 * stubs[8]: an operation escalated to manual_review leaves it only through a HUMAN's resolution (succeeded ⇒ verified,
 * failed ⇒ failed, compensated ⇒ compensated), audited on L0 (`operation.resolved`); agents never resolve operations.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isHypertestError } from '@hypertest/core';
import type { OperationRecord } from '@hypertest/domain';
import { eventCtx } from '@hypertest/testkit';
import { MANUAL_REVIEW_OUTCOMES, resolveManualReview } from '../src/index.ts';
import { eventTypesFor, openEnv, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

let n = 0;
/** An operation that went dispatching → outcome_unknown → reconciling → manual_review (holding a resource lease). */
async function inReview(runId: string): Promise<OperationRecord> {
  const ctx = eventCtx(runId);
  const lease = (await env.leases.acquire({ resourceKey: `env/svc-${++n}`, owner: 'worker-1', ttlMs: 60_000 }))!;
  let op = await env.ledger.prepare(
    {
      runId, workItemId: 'wi-1', operationType: 'env.restart', adapterId: 'env.control', target: { resourceKey: lease.resourceKey, kind: 'environment' }, desiredStateHash: 'h', inputHash: `i-${n}`,
      toolInvocationId: `sess:1:c${n}`, lease: { leaseId: lease.leaseId, resourceKey: lease.resourceKey, fencingToken: lease.fencingToken },
    },
    ctx,
  );
  for (const to of ['dispatching', 'outcome_unknown', 'reconciling', 'manual_review'] as const) op = await env.ledger.transition(op.operationId, to, { lastError: 'restart: lookup uncertain' }, ctx, { expectedFrom: [op.status] });
  return op;
}

const human = (id: string) => ({ kind: 'human' as const, id });

test('a human resolves each outcome: succeeded ⇒ verified, failed ⇒ failed, compensated ⇒ compensated (audited, lease released)', async () => {
  assert.deepEqual(MANUAL_REVIEW_OUTCOMES, ['succeeded', 'failed', 'compensated']);
  const expected = { succeeded: 'verified', failed: 'failed', compensated: 'compensated' } as const;
  for (const outcome of MANUAL_REVIEW_OUTCOMES) {
    const runId = `run-review-${outcome}`;
    const op = await inReview(runId);
    const resolved = await resolveManualReview({ db: env.db, ledger: env.ledger, events: env.events, leases: env.leases }, op.operationId, { outcome, by: human('alice'), note: `checked the target: ${outcome}` }, eventCtx(runId, { actorId: 'human:alice' }));
    assert.equal(resolved.status, expected[outcome]);
    assert.equal(resolved.lastError, `manual review by human:alice: ${outcome} — checked the target: ${outcome}`);
    if (outcome === 'succeeded') assert.deepEqual(resolved.result, { resolvedBy: 'human:alice', note: 'checked the target: succeeded' });
    const types = eventTypesFor(env, op.operationId);
    assert.deepEqual(types.slice(-2), [`operation.${expected[outcome]}`, 'operation.resolved']);
    const audit = env.events.events.filter((e) => e.eventType === 'operation.resolved' && e.aggregateId === op.operationId).map((e) => e.payload as Record<string, unknown>);
    assert.deepEqual(audit.map((p) => [p['outcome'], p['from'], p['to'], p['by'], p['previousReason']]), [[outcome, 'manual_review', expected[outcome], 'human:alice', 'restart: lookup uncertain']]);
    assert.equal(await env.leases.current(op.lease!.resourceKey), undefined, 'the resource lease the effect held is released');
  }
});

test('agents (and every non-human actor) are refused; a note is required; only manual_review operations are resolved; a repeat is a no-op', async () => {
  const runId = 'run-review-rules';
  const op = await inReview(runId);
  const deps = { db: env.db, ledger: env.ledger, events: env.events };
  const ctx = eventCtx(runId);
  await assert.rejects(resolveManualReview(deps, op.operationId, { outcome: 'succeeded', by: { kind: 'agent', id: 'ag_1', role: 'executor' }, note: 'it worked' }, ctx), (e: unknown) => isHypertestError(e, 'permission_denied'));
  await assert.rejects(resolveManualReview(deps, op.operationId, { outcome: 'succeeded', by: { kind: 'system', id: 'reconciler' }, note: 'it worked' }, ctx), (e: unknown) => isHypertestError(e, 'permission_denied'));
  await assert.rejects(resolveManualReview(deps, op.operationId, { outcome: 'succeeded', by: human('alice'), note: '  ' }, ctx), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  await assert.rejects(resolveManualReview(deps, op.operationId, { outcome: 'maybe' as never, by: human('alice'), note: 'x' }, ctx), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  await assert.rejects(resolveManualReview(deps, op.operationId, { outcome: 'failed', by: human('alice'), note: 'x' }, eventCtx('another-run')), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  await assert.rejects(resolveManualReview(deps, 'op_missing', { outcome: 'failed', by: human('alice'), note: 'x' }, ctx), (e: unknown) => isHypertestError(e, 'not_found'));
  assert.equal((await env.ledger.get(op.operationId))!.status, 'manual_review', 'nothing changed');
  const failed = await resolveManualReview(deps, op.operationId, { outcome: 'failed', by: human('bob'), note: 'the restart never happened' }, ctx);
  assert.equal(failed.status, 'failed');
  // the same resolution again: no-op (one audit record); another outcome: refused
  const again = await resolveManualReview(deps, op.operationId, { outcome: 'failed', by: human('bob'), note: 'again' }, ctx);
  assert.equal(again.status, 'failed');
  assert.equal(env.events.events.filter((e) => e.eventType === 'operation.resolved' && e.aggregateId === op.operationId).length, 1);
  await assert.rejects(resolveManualReview(deps, op.operationId, { outcome: 'succeeded', by: human('carol'), note: 'x' }, ctx), (e: unknown) => isHypertestError(e, 'precondition_failed'));
  // an operation never under review cannot be "resolved"
  const fresh = await env.ledger.prepare({ runId, workItemId: 'wi-1', operationType: 'env.restart', adapterId: 'env.control', target: { resourceKey: 'env/x', kind: 'environment' }, desiredStateHash: 'h', inputHash: 'fresh', toolInvocationId: 'sess:9:c9' }, ctx);
  await assert.rejects(resolveManualReview(deps, fresh.operationId, { outcome: 'succeeded', by: human('alice'), note: 'x' }, ctx), (e: unknown) => isHypertestError(e, 'precondition_failed'));
});

test('the ledger lists operations by status across runs (manual review queue)', async () => {
  const a = await inReview('run-queue-a');
  const b = await inReview('run-queue-b');
  const queue = (await env.ledger.listByStatus!(['manual_review'])).map((o) => o.operationId);
  assert.ok(queue.includes(a.operationId) && queue.includes(b.operationId));
  assert.ok(queue.indexOf(a.operationId) < queue.indexOf(b.operationId), 'oldest first');
  await assert.rejects(env.ledger.listByStatus!([]), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});
