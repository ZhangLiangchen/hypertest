import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { HypertestError, isHypertestError } from '@hypertest/core';
import { eventCtx } from '@hypertest/testkit';
import { createOperationLedger, type SideEffectOutcome } from '../src/index.ts';
import { FakeAdapter, FakeTarget, crashingLedger, deferred, eventTypesFor, gatewayFor, openEnv, request, waitForStatus, type Env } from './helpers.ts';

// Adversarial review regressions: concurrency races, late receipts and non-cooperative adapters.

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

function assertStatus<S extends SideEffectOutcome['status']>(out: SideEffectOutcome, status: S): asserts out is SideEffectOutcome & { status: S } {
  assert.equal(out.status, status, `expected ${status}, got ${out.status} (${'reason' in out ? out.reason : ''})`);
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('I4: a duplicate delivery to a second gateway instance in the same process never reconciles underneath an in-flight dispatch', async () => {
  const target = new FakeTarget();
  const gate = deferred();
  const a = new FakeAdapter({ target });
  const b = new FakeAdapter({ target });
  a.dispatchGate = gate.promise;
  b.dispatchGate = gate.promise;
  // Two components of one process (e.g. tools and control) each built their own gateway over the shared ledger.
  const g1 = gatewayFor(env, [a]).gateway;
  const g2 = gatewayFor(env, [b]).gateway;
  const req = request('run-race-instances');
  const first = g1.run(req);
  await waitForStatus(env, req.toolInvocationId, 'dispatching');
  const second = g2.run({ ...req, signal: new AbortController().signal });
  await tick();
  assert.equal(b.calls.observe, 0, 'the second instance did not reconcile the in-flight dispatch');
  gate.resolve();
  const [o1, o2] = await Promise.all([first, second]);
  assertStatus(o1, 'verified');
  assertStatus(o2, 'verified');
  assert.equal(o1.operation.operationId, o2.operation.operationId);
  assert.equal(a.calls.dispatch + b.calls.dispatch, 1, 'exactly one dispatch');
  assert.equal(target.created, 1, 'exactly one external side effect');
  assert.equal(o2.operation.attempt, 1);
});

test('I4: a receipt arriving while another process is still reconciling is recorded (attach), so the reconciler cannot conclude not_applied', async () => {
  const adapter = new FakeAdapter();
  const gate = deferred();
  adapter.dispatchGate = gate.promise;
  const worker = gatewayFor(env, [adapter]).gateway;
  const req = request('run-late-reconciling');
  const running = worker.run(req);
  const op = await waitForStatus(env, req.toolInvocationId, 'dispatching');
  // Another process (its own ledger) started reconciling the "stuck" dispatch and is about to observe.
  const other = createOperationLedger(env.deps);
  const ctx = eventCtx('run-late-reconciling', { actorId: 'system:other-reconciler' });
  await other.transition(op.operationId, 'outcome_unknown', { lastError: 'presumed crashed' }, ctx, { expectedFrom: ['dispatching'] });
  const reconciling = await other.transition(op.operationId, 'reconciling', {}, ctx, { expectedFrom: ['outcome_unknown'] });
  gate.resolve();
  const out = await running;
  assertStatus(out, 'verified');
  assert.equal(out.operation.externalJobId, 'job-1', 'the late receipt was recorded');
  assert.equal(out.operation.attempt, 1);
  // The other process observed "absent" before the effect landed; its conclusion now loses the race.
  await assert.rejects(
    other.transition(op.operationId, 'not_applied', { lastError: 'absent' }, ctx, { expectedFrom: ['reconciling'], expectedAttempt: reconciling.attempt }),
    (e: unknown) => isHypertestError(e, 'conflict'),
  );
  // A later retry of the tool call returns the recorded result and never dispatches again.
  assertStatus(await worker.run(req), 'verified');
  assert.equal(adapter.calls.dispatch, 1);
  assert.equal(adapter.target.created, 1);
  assert.deepEqual(eventTypesFor(env, op.operationId).slice(-2), ['operation.reconciled', 'operation.verified']);
});

test('I4: a receipt arriving after another worker already re-dispatched is surfaced as an orphaned effect (manual_review + audit event), never silently dropped', async () => {
  const adapter = new FakeAdapter();
  const gate = deferred();
  adapter.dispatchGate = gate.promise;
  const worker = gatewayFor(env, [adapter]).gateway;
  const req = request('run-orphan');
  const running = worker.run(req);
  const op = await waitForStatus(env, req.toolInvocationId, 'dispatching');
  const other = createOperationLedger(env.deps);
  const ctx = eventCtx('run-orphan', { actorId: 'worker-2' });
  let cur = op;
  for (const to of ['outcome_unknown', 'reconciling', 'not_applied', 'dispatching'] as const) cur = await other.transition(op.operationId, to, {}, ctx, { expectedFrom: [cur.status] });
  assert.equal(cur.attempt, 2, 'worker 2 started attempt 2');
  gate.resolve();
  const out = await running;
  assertStatus(out, 'manual_review');
  assert.match(out.reason, /orphan.*job-1.*attempt 1.*attempt 2/);
  assert.equal(out.operation.status, 'dispatching', 'attempt 2 is left to its own worker');
  assert.equal(out.operation.attempt, 2);
  const audit = env.events.events.filter((e) => e.aggregateId === op.operationId && e.eventType === 'operation.late_receipt');
  assert.equal(audit.length, 1);
  assert.deepEqual(
    { ...(audit[0]!.payload as Record<string, unknown>) },
    { operationId: op.operationId, disposition: 'orphaned', dispatchedAttempt: 1, currentAttempt: 2, currentStatus: 'dispatching', externalJobId: 'job-1', externalReceipt: 'receipt-job-1' },
  );
  assert.ok(env.deps.logger.entries.some((e) => e.level === 'error' && e.fields['operationId'] === op.operationId && e.fields['externalJobId'] === 'job-1'));
});

test('I4: a late receipt for an operation already escalated to manual_review is kept in the audit log', async () => {
  const adapter = new FakeAdapter();
  const gate = deferred();
  adapter.dispatchGate = gate.promise;
  const worker = gatewayFor(env, [adapter]).gateway;
  const req = request('run-late-review');
  const running = worker.run(req);
  const op = await waitForStatus(env, req.toolInvocationId, 'dispatching');
  const other = createOperationLedger(env.deps);
  const ctx = eventCtx('run-late-review');
  let cur = op;
  for (const to of ['outcome_unknown', 'reconciling', 'manual_review'] as const) cur = await other.transition(op.operationId, to, { lastError: 'lookup uncertain' }, ctx, { expectedFrom: [cur.status] });
  gate.resolve();
  const out = await running;
  assertStatus(out, 'manual_review');
  assert.equal(out.operation.status, 'manual_review');
  const audit = env.events.events.filter((e) => e.aggregateId === op.operationId && e.eventType === 'operation.late_receipt');
  assert.equal(audit.length, 1);
  assert.equal((audit[0]!.payload as Record<string, unknown>)['disposition'], 'manual_review');
  assert.equal((audit[0]!.payload as Record<string, unknown>)['externalJobId'], 'job-1');
});

test('I4: a new dispatch attempt never inherits the previous attempt\'s externalJobId (high-risk no-lookup unknown ⇒ manual_review, no observe)', async () => {
  const target = new FakeTarget();
  const caps = { supportsExternalLookupByOperationId: false, reconciliationClass: 'best_effort' as const, riskClass: 'high' as const };
  const w1 = new FakeAdapter({ adapterId: 'fake-hr', capabilities: caps, target });
  w1.observeFaults = ['uncertain'];
  const req = request('run-stale-job-id', { adapterId: 'fake-hr' });
  const first = await gatewayFor(env, [w1]).gateway.run(req);
  assertStatus(first, 'manual_review');
  assert.equal(first.operation.externalJobId, 'job-1');
  // A human decided the job never ran: manual_review → not_applied. The next run re-dispatches (attempt 2).
  const ctx = eventCtx('run-stale-job-id', { actorId: 'human:operator' });
  const reopened = await env.ledger.transition(first.operation.operationId, 'not_applied', { lastError: 'operator: job never ran' }, ctx, { expectedFrom: ['manual_review'] });
  assert.equal(reopened.externalJobId, 'job-1', 'history is kept until a new attempt starts');
  await assert.rejects(gatewayFor(env, [w1], { ledger: crashingLedger(env.ledger, 'acknowledged') }).gateway.run(req), /simulated worker crash/);
  const stuck = await env.ledger.get(first.operation.operationId);
  assert.equal(stuck?.status, 'dispatching');
  assert.equal(stuck.attempt, 2);
  assert.equal(stuck.externalJobId, undefined, 'attempt 2 has no receipt yet');
  assert.equal(stuck.externalReceipt, undefined);
  // Attempt 2's outcome is unknown and the adapter cannot look it up: never observe by a stale job id, never retry.
  const w2 = new FakeAdapter({ adapterId: 'fake-hr', capabilities: caps, target });
  const out = await gatewayFor(env, [w2]).gateway.run(req);
  assertStatus(out, 'manual_review');
  assert.match(out.reason, /cannot look up effects by operationId/);
  assert.equal(w2.calls.observe, 0);
  assert.equal(w2.calls.dispatch, 0);
});

test('observe() never reconciles a dispatching operation whose lease is still live (the dispatcher may be alive in another process)', async () => {
  const adapter = new FakeAdapter();
  const gate = deferred();
  adapter.dispatchGate = gate.promise;
  const worker = gatewayFor(env, [adapter]).gateway;
  const req = request('run-observe-leased', { lease: { resourceKey: 'env/observe-leased', owner: 'worker-a', ttlMs: 5_000 } });
  const running = worker.run(req);
  const op = await waitForStatus(env, req.toolInvocationId, 'dispatching');
  const poller = gatewayFor(env, [adapter], { ledger: createOperationLedger(env.deps) }).gateway;
  const peek = await poller.observe(op.operationId, eventCtx('run-observe-leased'), new AbortController().signal);
  assertStatus(peek, 'pending');
  assert.equal(peek.operation.status, 'dispatching');
  assert.equal(adapter.calls.observe, 0);
  gate.resolve();
  assertStatus(await running, 'verified');
  assert.equal(adapter.target.created, 1);
});

test('observe() reconciles a dispatching operation once its lease has expired (crashed dispatcher)', async () => {
  const target = new FakeTarget();
  const w1 = new FakeAdapter({ target });
  const req = request('run-observe-expired', { lease: { resourceKey: 'env/observe-expired', owner: 'worker-a', ttlMs: 1_000 } });
  await assert.rejects(gatewayFor(env, [w1], { ledger: crashingLedger(env.ledger, 'acknowledged') }).gateway.run(req), /simulated worker crash/);
  const op = await env.ledger.findByToolInvocation(req.toolInvocationId);
  assert.equal(op?.status, 'dispatching');
  const w2 = new FakeAdapter({ target });
  const { gateway } = gatewayFor(env, [w2]);
  const early = await gateway.observe(op.operationId, eventCtx('run-observe-expired'), new AbortController().signal);
  assertStatus(early, 'pending');
  assert.equal(w2.calls.observe, 0);
  env.clock.advance(1_000);
  const settled = await gateway.observe(op.operationId, eventCtx('run-observe-expired'), new AbortController().signal);
  assertStatus(settled, 'verified');
  assert.equal(w2.calls.observe, 1);
  assert.equal(target.created, 1);
});

test('a non-cooperative observe() that ignores the abort signal does not hang run(): abort ⇒ pending', { timeout: 10_000 }, async () => {
  const adapter = new FakeAdapter();
  adapter.observeFaults = ['hang'];
  const ctrl = new AbortController();
  const running = gatewayFor(env, [adapter]).gateway.run(request('run-hang-observe', { signal: ctrl.signal }));
  for (let i = 0; i < 500 && adapter.calls.observe === 0; i++) await tick(2);
  assert.equal(adapter.calls.observe, 1);
  ctrl.abort(new Error('worker shutting down'));
  const out = await running;
  assertStatus(out, 'pending');
  assert.equal(out.operation.status, 'acknowledged');
  assert.equal(adapter.calls.dispatch, 1);
});

test('a non-cooperative observe() does not hang reconciliation: abort ⇒ the reconciler stops', { timeout: 10_000 }, async () => {
  const adapter = new FakeAdapter({ adapterId: 'rc-hang' });
  adapter.dispatchFaults = ['apply_then_throw'];
  const { gateway, reconciler } = gatewayFor(env, [adapter]);
  const first = await gateway.run(request('run-hang-reconcile', { adapterId: 'rc-hang' }));
  assertStatus(first, 'pending');
  adapter.observeFaults = ['hang'];
  const ctrl = new AbortController();
  const running = reconciler.reconcile({ runId: 'run-hang-reconcile' }, ctrl.signal);
  for (let i = 0; i < 500 && adapter.calls.observe === 0; i++) await tick(2);
  ctrl.abort(new Error('shutdown'));
  await assert.rejects(running, (e: unknown) => isHypertestError(e, 'cancelled'));
  assert.equal((await env.ledger.get(first.operation.operationId))?.status, 'reconciling', 'left for the next reconciliation');
  assert.equal(adapter.calls.dispatch, 1);
});

test('concurrent compensate() calls in one process run the compensation exactly once', { timeout: 10_000 }, async () => {
  const adapter = new FakeAdapter();
  const gate = deferred();
  const { gateway } = gatewayFor(env, [adapter]);
  const out = await gateway.run(request('run-comp-race'));
  assertStatus(out, 'verified');
  adapter.compensateGate = gate.promise;
  const ctx = eventCtx('run-comp-race');
  const c1 = gateway.compensate(out.operation.operationId, ctx, new AbortController().signal);
  for (let i = 0; i < 500 && adapter.calls.compensate === 0; i++) await tick(2);
  assert.equal(adapter.calls.compensate, 1);
  // A second request (e.g. a duplicate rollback delivery, or another gateway instance) arrives mid-compensation.
  const other = gatewayFor(env, [adapter]).gateway;
  const c2 = await other.compensate(out.operation.operationId, ctx, new AbortController().signal);
  assertStatus(c2, 'pending');
  assert.equal(c2.operation.status, 'compensating');
  gate.resolve();
  const done = await c1;
  assertStatus(done, 'not_applied');
  assert.equal(done.operation.status, 'compensated');
  assert.equal(adapter.calls.compensate, 1);
  assert.equal(adapter.calls.observe, 1, 'only the original verification observed the job');
});

test('an adapter.prepare() fault surfaces as a HypertestError and records nothing', async () => {
  const adapter = new FakeAdapter();
  adapter.prepareFault = new Error('template render failed');
  const req = request('run-prepare-fault');
  await assert.rejects(gatewayFor(env, [adapter]).gateway.run(req), (e: unknown) => e instanceof HypertestError && /template render failed/.test(e.message));
  assert.equal(await env.ledger.findByToolInvocation(req.toolInvocationId), undefined);
  assert.equal(adapter.calls.dispatch, 0);
  // A HypertestError from the adapter keeps its code.
  adapter.prepareFault = new HypertestError('invalid_argument', 'unknown load profile');
  await assert.rejects(gatewayFor(env, [adapter]).gateway.run(request('run-prepare-fault-2')), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});
