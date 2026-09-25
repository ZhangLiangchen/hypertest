import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { hashCanonical, isHypertestError } from '@hypertest/core';
import { eventCtx } from '@hypertest/testkit';
import { AdapterRegistry, createOperationLedger, type SideEffectOutcome } from '../src/index.ts';
import { FakeAdapter, FakeTarget, crashingLedger, eventTypesFor, gatewayFor, openEnv, request, type Env } from './helpers.ts';

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

test('happy path: prepare → dispatch → acknowledge → verify; a retry replays the recorded result without touching the target', async () => {
  const adapter = new FakeAdapter();
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-happy');
  const out = await gateway.run(req);
  assertStatus(out, 'verified');
  assert.deepEqual(out.result, { jobId: 'job-1', name: 'job' });
  assert.equal(out.operation.status, 'verified');
  assert.equal(out.operation.attempt, 1);
  assert.equal(out.operation.externalJobId, 'job-1');
  assert.equal(out.operation.externalReceipt, 'receipt-job-1');
  assert.equal(out.operation.idempotencyKey, out.operation.operationId);
  assert.equal(out.operation.desiredStateHash, hashCanonical({ name: 'job' }));
  assert.equal(adapter.target.jobs.get(out.operation.operationId)?.jobId, 'job-1', 'the external job is labelled with the operation id');

  const again = await gateway.run(req);
  assertStatus(again, 'verified');
  assert.equal(again.operation.operationId, out.operation.operationId);
  assert.deepEqual(again.result, out.result);
  assert.deepEqual(adapter.calls, { prepare: 1, dispatch: 1, observe: 1, verify: 1, compensate: 0 });
  assert.equal(adapter.target.created, 1);

  assert.deepEqual(eventTypesFor(env, out.operation.operationId), ['operation.prepared', 'operation.dispatched', 'operation.acknowledged', 'operation.verified']);
  for (const e of env.events.events.filter((x) => x.aggregateId === out.operation.operationId)) {
    assert.equal(e.runId, 'run-happy');
    assert.equal(e.workItemId, 'wi-run-happy');
    assert.equal(e.agentId, 'agent-run-happy');
    assert.equal(e.correlationId, 'run-happy');
    assert.equal(e.aggregateType, 'operation');
  }
});

test('I4: external success then lost response ⇒ outcome_unknown (not failed); a retry reconciles to verified without a second job', async () => {
  const adapter = new FakeAdapter();
  adapter.dispatchFaults = ['apply_then_throw'];
  const req = request('run-lost-response');
  const first = await gatewayFor(env, [adapter]).gateway.run(req);
  assertStatus(first, 'pending');
  assert.equal(first.operation.status, 'outcome_unknown');
  assert.match(first.operation.lastError ?? '', /outcome unknown .*socket hang up/);
  assert.equal(adapter.target.created, 1);

  // A fresh worker (new gateway instance) retries the same tool invocation.
  const second = await gatewayFor(env, [adapter]).gateway.run(req);
  assertStatus(second, 'verified');
  assert.equal(second.operation.operationId, first.operation.operationId);
  assert.equal(second.operation.attempt, 1, 'no second dispatch attempt');
  assert.equal(adapter.target.created, 1, 'exactly one external side effect');
  assert.equal(adapter.calls.dispatch, 1);
  assert.deepEqual(eventTypesFor(env, first.operation.operationId), [
    'operation.prepared',
    'operation.dispatched',
    'operation.outcome_unknown',
    'operation.reconciling',
    'operation.reconciled',
    'operation.verified',
  ]);
});

test('I4: worker crash after the external effect but before the ack is persisted ⇒ reconcile attaches, never re-creates', async () => {
  const target = new FakeTarget();
  const crashy = crashingLedger(env.ledger, 'acknowledged');
  const worker1 = new FakeAdapter({ target });
  const req = request('run-crash-before-ack');
  await assert.rejects(gatewayFor(env, [worker1], { ledger: crashy }).gateway.run(req), /simulated worker crash before persisting acknowledged/);
  const stuck = await env.ledger.findByToolInvocation(req.toolInvocationId, req.operationType);
  assert.equal(stuck?.status, 'dispatching');
  assert.equal(target.created, 1);

  const worker2 = new FakeAdapter({ target });
  const out = await gatewayFor(env, [worker2]).gateway.run(req);
  assertStatus(out, 'verified');
  assert.equal(out.operation.operationId, stuck.operationId);
  assert.equal(worker2.calls.dispatch, 0, 'the restarted worker never dispatches');
  assert.equal(target.created, 1, 'exactly one external side effect');
  assert.equal(out.operation.lastError, 'dispatch interrupted before a receipt was recorded');
});

test('I4: ack persisted, crash before verify ⇒ the retry attaches to the recorded job and verifies it', async () => {
  const target = new FakeTarget();
  const crashy = crashingLedger(env.ledger, 'verified');
  const worker1 = new FakeAdapter({ target });
  const req = request('run-crash-before-verify');
  await assert.rejects(gatewayFor(env, [worker1], { ledger: crashy }).gateway.run(req), /simulated worker crash before persisting verified/);
  const acked = await env.ledger.findByToolInvocation(req.toolInvocationId);
  assert.equal(acked?.status, 'acknowledged');
  assert.equal(acked.externalJobId, 'job-1');

  const worker2 = new FakeAdapter({ target });
  const out = await gatewayFor(env, [worker2]).gateway.run(req);
  assertStatus(out, 'verified');
  assert.equal(out.operation.externalJobId, 'job-1', 'attached to the original job');
  assert.equal(worker2.calls.dispatch, 0);
  assert.equal(worker1.calls.dispatch + worker2.calls.dispatch, 1);
  assert.equal(target.created, 1);
  assert.equal(out.operation.attempt, 1);
});

test('I4: stale worker after lease expiry and a new owner ⇒ stale_fence with zero dispatches', async () => {
  const adapter = new FakeAdapter();
  const { gateway } = gatewayFor(env, [adapter]);
  const leaseA = await env.leases.acquire({ resourceKey: 'env/stale-1', owner: 'worker-a', ttlMs: 1_000 });
  assert.ok(leaseA);
  const req = request('run-stale-1');
  // The scheduler prepared the operation under worker A's lease (token 1).
  const prepared = await env.ledger.prepare(
    {
      runId: req.runId,
      workItemId: req.workItemId,
      toolInvocationId: req.toolInvocationId,
      operationType: req.operationType,
      adapterId: 'fake',
      target: { resourceKey: 'loadgen/job', kind: 'load_job' },
      desiredStateHash: hashCanonical({ name: 'job' }),
      inputHash: hashCanonical(req.input),
      lease: { leaseId: leaseA.leaseId, resourceKey: leaseA.resourceKey, fencingToken: leaseA.fencingToken },
    },
    req.ctx,
  );
  env.clock.advance(1_001);
  const leaseB = await env.leases.acquire({ resourceKey: 'env/stale-1', owner: 'worker-b', ttlMs: 60_000 });
  assert.equal(leaseB?.fencingToken, leaseA.fencingToken + 1);

  // Worker A wakes up and retries with its recorded (now stale) fence.
  const out = await gateway.run(req);
  assertStatus(out, 'stale_fence');
  assert.match(out.reason, /stale fencing token 1 for env\/stale-1/);
  assert.equal(out.operation.status, 'prepared');
  assert.equal(out.operation.attempt, 0);
  assert.equal(adapter.calls.dispatch, 0);
  assert.equal(adapter.target.created, 0);
  assert.equal(await env.leases.checkFence('env/stale-1', leaseA.fencingToken), false);

  // The new owner proceeds with its own, newer token.
  const b = await gateway.run({ ...req, lease: { resourceKey: 'env/stale-1', owner: 'worker-b', ttlMs: 60_000 } });
  assertStatus(b, 'verified');
  assert.equal(b.operation.operationId, prepared.operationId);
  assert.equal(b.operation.lease?.fencingToken, leaseB.fencingToken);
  assert.deepEqual(adapter.dispatchedFences, [leaseB.fencingToken]);
  assert.equal(adapter.target.created, 1);
});

test('I4: lease lost while the worker was paused in prepare ⇒ stale_fence before any dispatch', async () => {
  const adapter = new FakeAdapter();
  let paused = false;
  adapter.onPrepare = async () => {
    if (paused) return;
    paused = true;
    env.clock.advance(5_000); // e.g. a long GC pause / network partition
    assert.ok(await env.leases.acquire({ resourceKey: 'env/stale-2', owner: 'worker-b', ttlMs: 60_000 }));
  };
  const out = await gatewayFor(env, [adapter]).gateway.run(request('run-stale-2', { lease: { resourceKey: 'env/stale-2', owner: 'worker-a', ttlMs: 1_000 } }));
  assertStatus(out, 'stale_fence');
  assert.equal(out.operation.status, 'prepared');
  assert.equal(out.operation.lease?.fencingToken, 1);
  assert.equal(adapter.calls.dispatch, 0);
  assert.equal(adapter.target.created, 0);
});

test('I4: a stale worker cannot drive reconciliation of its own unknown outcome; the new owner reconciles without a second job', async () => {
  const adapter = new FakeAdapter();
  adapter.dispatchFaults = ['apply_then_throw'];
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-stale-3', { lease: { resourceKey: 'env/stale-3', owner: 'worker-a', ttlMs: 1_000 } });
  const first = await gateway.run(req);
  assertStatus(first, 'pending');
  assert.equal(first.operation.status, 'outcome_unknown');
  assert.equal(first.operation.lease?.fencingToken, 1);

  env.clock.advance(2_000);
  assert.equal((await env.leases.acquire({ resourceKey: 'env/stale-3', owner: 'worker-b', ttlMs: 60_000 }))?.fencingToken, 2);

  // Worker A retries under its own identity: the resource is held by B.
  const busy = await gateway.run(req);
  assertStatus(busy, 'failed');
  assert.equal(busy.reason, 'resource_busy');
  // Worker A retries with its recorded token only: refused as stale, and it does not even observe.
  const { lease: _ignored, ...withoutLease } = req;
  const stale = await gateway.run(withoutLease);
  assertStatus(stale, 'stale_fence');
  assert.equal(stale.operation.status, 'outcome_unknown');
  assert.equal(adapter.calls.observe, 0);

  const b = await gateway.run({ ...req, lease: { resourceKey: 'env/stale-3', owner: 'worker-b', ttlMs: 60_000 } });
  assertStatus(b, 'verified');
  assert.equal(adapter.calls.dispatch, 1);
  assert.equal(adapter.target.created, 1);
});

test('resource busy: another live owner ⇒ failed/resource_busy with no dispatch; succeeds after release', async () => {
  const adapter = new FakeAdapter();
  const { gateway } = gatewayFor(env, [adapter]);
  const other = await env.leases.acquire({ resourceKey: 'env/busy', owner: 'worker-x', ttlMs: 60_000 });
  assert.ok(other);
  const req = request('run-busy', { lease: { resourceKey: 'env/busy', owner: 'worker-y', ttlMs: 60_000 } });
  const busy = await gateway.run(req);
  assertStatus(busy, 'failed');
  assert.equal(busy.reason, 'resource_busy');
  assert.equal(busy.operation.status, 'prepared', 'the ledger keeps the intent, not a failure');
  assert.equal(adapter.calls.dispatch, 0);
  await env.leases.release(other.leaseId);
  const ok = await gateway.run(req);
  assertStatus(ok, 'verified');
  assert.equal(ok.operation.operationId, busy.operation.operationId);
  assert.equal(adapter.calls.dispatch, 1);
});

test('the same owner reuses its live lease (renewed, same token) across retries', async () => {
  const adapter = new FakeAdapter();
  adapter.completeAfterObserves = 1;
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-reuse', { lease: { resourceKey: 'env/reuse', owner: 'worker-r', ttlMs: 10_000 } });
  const first = await gateway.run(req);
  assertStatus(first, 'pending');
  const token = first.operation.lease?.fencingToken;
  env.clock.advance(5_000);
  const second = await gateway.run(req);
  assertStatus(second, 'verified');
  assert.equal(second.operation.lease?.fencingToken, token);
  const live = await env.leases.current('env/reuse');
  assert.equal(live?.fencingToken, token);
  assert.equal(live?.expiresAt, new Date(env.clock.nowMs() + 10_000).toISOString(), 'the reused lease was renewed');
});

test('I4: absent on reconcile ⇒ not_applied ⇒ exactly one safe re-dispatch per run', async () => {
  const adapter = new FakeAdapter();
  adapter.dispatchFaults = ['throw_before_apply', 'throw_before_apply'];
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-absent');
  const first = await gateway.run(req);
  assertStatus(first, 'pending');
  assert.equal(first.operation.status, 'outcome_unknown');
  assert.equal(adapter.target.created, 0);

  // Reconcile finds nothing ⇒ one re-dispatch, which again loses its outcome ⇒ pending (no loop).
  const second = await gateway.run(req);
  assertStatus(second, 'pending');
  assert.equal(second.operation.status, 'outcome_unknown');
  assert.equal(adapter.calls.dispatch, 2);
  assert.equal(second.operation.attempt, 2);

  const third = await gateway.run(req);
  assertStatus(third, 'verified');
  assert.equal(adapter.calls.dispatch, 3);
  assert.equal(third.operation.attempt, 3);
  assert.equal(adapter.target.created, 1, 'only the effective dispatch produced a job');
  const types = eventTypesFor(env, first.operation.operationId);
  assert.equal(types.filter((t) => t === 'operation.dispatched').length, 3);
  assert.equal(types.filter((t) => t === 'operation.reconciled').length, 2, 'two absent reconciliations');
  assert.deepEqual(types.slice(-3), ['operation.dispatched', 'operation.acknowledged', 'operation.verified']);
});

test('I4: an uncertain reconciliation ⇒ manual_review, and nothing is retried afterwards', async () => {
  const adapter = new FakeAdapter();
  adapter.dispatchFaults = ['apply_then_throw'];
  adapter.observeFaults = ['uncertain'];
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-uncertain');
  assertStatus(await gateway.run(req), 'pending');
  const review = await gateway.run(req);
  assertStatus(review, 'manual_review');
  assert.match(review.reason, /reconciliation uncertain: target API answered 503/);
  assert.equal(review.operation.status, 'manual_review');
  const again = await gateway.run(req);
  assertStatus(again, 'manual_review');
  assert.deepEqual({ dispatch: adapter.calls.dispatch, observe: adapter.calls.observe }, { dispatch: 1, observe: 1 });
  assert.equal(adapter.target.created, 1);
  assert.ok(eventTypesFor(env, review.operation.operationId).includes('operation.manual_review'));
});

test('I4: high-risk adapter without lookup ⇒ an unknown dispatch outcome goes straight to manual_review (no blind retry)', async () => {
  const adapter = new FakeAdapter({ adapterId: 'fake-blind', capabilities: { supportsExternalLookupByOperationId: false, reconciliationClass: 'non_reconcilable', riskClass: 'high' } });
  adapter.dispatchFaults = ['apply_then_throw'];
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-blind', { adapterId: 'fake-blind' });
  const out = await gateway.run(req);
  assertStatus(out, 'manual_review');
  assert.equal(out.operation.status, 'manual_review');
  assert.match(out.reason, /cannot look up effects by operationId, refusing blind retry/);
  const retry = await gateway.run(req);
  assertStatus(retry, 'manual_review');
  assert.equal(adapter.calls.dispatch, 1);
  assert.equal(adapter.calls.observe, 0);
});

test('I4: crash mid-dispatch with a high-risk non-lookup adapter ⇒ manual_review without observing or re-dispatching', async () => {
  const target = new FakeTarget();
  const caps = { supportsExternalLookupByOperationId: false, reconciliationClass: 'best_effort' as const, riskClass: 'critical' as const };
  const w1 = new FakeAdapter({ adapterId: 'fake-crit', capabilities: caps, target });
  const req = request('run-crit', { adapterId: 'fake-crit' });
  await assert.rejects(gatewayFor(env, [w1], { ledger: crashingLedger(env.ledger, 'acknowledged') }).gateway.run(req), /simulated worker crash/);
  const w2 = new FakeAdapter({ adapterId: 'fake-crit', capabilities: caps, target });
  const out = await gatewayFor(env, [w2]).gateway.run(req);
  assertStatus(out, 'manual_review');
  assert.equal(w2.calls.observe, 0);
  assert.equal(w2.calls.dispatch, 0);
  assert.equal(target.created, 1);
});

test('I4: non_reconcilable high-risk operation observed absent ⇒ manual_review, never re-dispatched', async () => {
  const adapter = new FakeAdapter({ adapterId: 'fake-nr', capabilities: { reconciliationClass: 'non_reconcilable', riskClass: 'high' } });
  adapter.dispatchFaults = ['throw_before_apply'];
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-nr', { adapterId: 'fake-nr' });
  assertStatus(await gateway.run(req), 'pending');
  const out = await gateway.run(req);
  assertStatus(out, 'manual_review');
  assert.match(out.reason, /absence cannot be trusted, refusing re-dispatch/);
  assert.equal(adapter.calls.dispatch, 1);
  assert.equal(adapter.target.created, 0);
});

test('a low-risk non_reconcilable adapter may re-dispatch after an absent observation', async () => {
  const adapter = new FakeAdapter({ adapterId: 'fake-nr-low', capabilities: { reconciliationClass: 'non_reconcilable', riskClass: 'low' } });
  adapter.dispatchFaults = ['throw_before_apply'];
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-nr-low', { adapterId: 'fake-nr-low' });
  assertStatus(await gateway.run(req), 'pending');
  assertStatus(await gateway.run(req), 'verified');
  assert.equal(adapter.calls.dispatch, 2);
  assert.equal(adapter.target.created, 1);
});

test('receipt.accepted=false ⇒ not_applied; the next run safely re-dispatches', async () => {
  const adapter = new FakeAdapter();
  adapter.dispatchFaults = ['reject'];
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-reject');
  const first = await gateway.run(req);
  assertStatus(first, 'not_applied');
  assert.equal(first.reason, 'target quota exceeded');
  assert.equal(first.operation.status, 'not_applied');
  const second = await gateway.run(req);
  assertStatus(second, 'verified');
  assert.equal(second.operation.attempt, 2);
  assert.equal(adapter.target.created, 1);
});

test('verification failure ⇒ failed (terminal); a retry returns the recorded failure without dispatching', async () => {
  const adapter = new FakeAdapter();
  adapter.verifyFailure = 'job crashed during warm-up';
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-verify-fail');
  const out = await gateway.run(req);
  assertStatus(out, 'failed');
  assert.equal(out.reason, 'job crashed during warm-up');
  assert.equal(out.operation.status, 'failed');
  const again = await gateway.run(req);
  assertStatus(again, 'failed');
  assert.equal(again.reason, 'job crashed during warm-up');
  assert.equal(adapter.calls.dispatch, 1);
});

test('pending verification: run returns pending, observe() polls until verified; no re-dispatch', async () => {
  const adapter = new FakeAdapter();
  adapter.completeAfterObserves = 2;
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-pending');
  const first = await gateway.run(req);
  assertStatus(first, 'pending');
  assert.equal(first.operation.status, 'acknowledged');
  assert.deepEqual(first.progress, { state: 'running', observed: 1 });
  const ctx = eventCtx('run-pending');
  assertStatus(await gateway.observe(first.operation.operationId, ctx, new AbortController().signal), 'pending');
  const done = await gateway.observe(first.operation.operationId, ctx, new AbortController().signal);
  assertStatus(done, 'verified');
  assert.deepEqual(done.result, { jobId: 'job-1', name: 'job' });
  assert.equal(adapter.calls.dispatch, 1);
  assert.equal(adapter.calls.observe, 3);
});

test('verifyWithinMs polls observe until verified within one run', async () => {
  const adapter = new FakeAdapter();
  adapter.completeAfterObserves = 2;
  const { gateway } = gatewayFor(env, [adapter], { pollIntervalMs: 2 });
  const out = await gateway.run(request('run-poll', { verifyWithinMs: 20 }));
  assertStatus(out, 'verified');
  assert.equal(adapter.calls.observe, 3);
});

test('an acknowledged job not yet observable stays pending (never treated as not applied)', async () => {
  const adapter = new FakeAdapter();
  adapter.observeFaults = ['absent', 'throw'];
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-ack-absent');
  const first = await gateway.run(req);
  assertStatus(first, 'pending');
  assert.deepEqual(first.progress, { reason: 'not_yet_observable' });
  assert.equal(first.operation.status, 'acknowledged');
  const second = await gateway.run(req);
  assertStatus(second, 'pending');
  assert.deepEqual(second.progress, { reason: 'observe_failed' });
  const third = await gateway.run(req);
  assertStatus(third, 'verified');
  assert.equal(adapter.calls.dispatch, 1);
});

test('I4: a dispatch timeout records outcome_unknown, never failed', async () => {
  const adapter = new FakeAdapter();
  adapter.dispatchFaults = ['hang'];
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-timeout', { dispatchTimeoutMs: 20 });
  const out = await gateway.run(req);
  assertStatus(out, 'pending');
  assert.equal(out.operation.status, 'outcome_unknown');
  assert.match(out.operation.lastError ?? '', /\(timeout\).*timed out after 20ms/);
  // The hung request never reached the target: reconciliation proves absence and re-dispatches once.
  const retry = await gateway.run(req);
  assertStatus(retry, 'verified');
  assert.equal(adapter.target.created, 1);
});

test('I4: aborting the worker mid-dispatch records outcome_unknown; observe() does not reconcile under an in-flight dispatch', async () => {
  const adapter = new FakeAdapter();
  adapter.dispatchFaults = ['hang'];
  const { gateway } = gatewayFor(env, [adapter]);
  const ctrl = new AbortController();
  const req = request('run-abort', { signal: ctrl.signal });
  const running = gateway.run(req);
  let op = await env.ledger.findByToolInvocation(req.toolInvocationId);
  for (let i = 0; i < 200 && op?.status !== 'dispatching'; i++) {
    await new Promise((r) => setTimeout(r, 2));
    op = await env.ledger.findByToolInvocation(req.toolInvocationId);
  }
  assert.equal(op?.status, 'dispatching');
  const peek = await gateway.observe(op.operationId, eventCtx('run-abort'), new AbortController().signal);
  assertStatus(peek, 'pending');
  assert.equal(peek.operation.status, 'dispatching');
  assert.equal(adapter.calls.observe, 0);
  ctrl.abort(new Error('worker shutting down'));
  const out = await running;
  assertStatus(out, 'pending');
  assert.equal(out.operation.status, 'outcome_unknown');
  assert.match(out.operation.lastError ?? '', /cancelled/);
});

test('I4: a receipt that arrives after another process reconciled the operation as not_applied is never duplicated', async () => {
  const adapter = new FakeAdapter();
  let release!: () => void;
  adapter.dispatchGate = new Promise<void>((r) => (release = r));
  const worker = gatewayFor(env, [adapter]).gateway;
  const req = request('run-late-receipt');
  const running = worker.run(req);
  let op = await env.ledger.findByToolInvocation(req.toolInvocationId);
  for (let i = 0; i < 200 && op?.status !== 'dispatching'; i++) {
    await new Promise((r) => setTimeout(r, 2));
    op = await env.ledger.findByToolInvocation(req.toolInvocationId);
  }
  assert.equal(op?.status, 'dispatching');
  // Another process (its own ledger instance, so no in-process guard) reconciles too early.
  const otherProcess = gatewayFor(env, [adapter], { ledger: createOperationLedger(env.deps) }).gateway;
  const early = await otherProcess.observe(op.operationId, eventCtx('run-late-receipt'), new AbortController().signal);
  assertStatus(early, 'not_applied');
  release();
  const out = await running;
  assertStatus(out, 'manual_review');
  assert.match(out.reason, /arrived after reconciliation recorded not_applied/);
  assert.equal(out.operation.status, 'failed', 'terminal: the effect exists, so it must never be re-dispatched');
  assert.equal(out.operation.externalJobId, 'job-1');
  const retry = await worker.run(req);
  assertStatus(retry, 'failed');
  assert.equal(adapter.calls.dispatch, 1);
  assert.equal(adapter.target.created, 1);
});

test('observe() of a never-dispatched operation reports not_applied/not_dispatched without adapter calls', async () => {
  const adapter = new FakeAdapter();
  const { gateway } = gatewayFor(env, [adapter]);
  const op = await env.ledger.prepare(
    { runId: 'run-obs-prepared', workItemId: 'wi', operationType: 'load.start', adapterId: 'fake', target: { resourceKey: 'loadgen/job', kind: 'load_job' }, desiredStateHash: 'd', inputHash: 'i' },
    eventCtx('run-obs-prepared'),
  );
  const out = await gateway.observe(op.operationId, eventCtx('run-obs-prepared'), new AbortController().signal);
  assertStatus(out, 'not_applied');
  assert.equal(out.reason, 'not_dispatched');
  assert.equal(adapter.calls.observe, 0);
});

test('an already-aborted request is refused before anything is recorded', async () => {
  const adapter = new FakeAdapter();
  const ctrl = new AbortController();
  ctrl.abort();
  const req = request('run-pre-abort', { signal: ctrl.signal });
  await assert.rejects(gatewayFor(env, [adapter]).gateway.run(req), (e: unknown) => isHypertestError(e, 'cancelled'));
  assert.equal(await env.ledger.findByToolInvocation(req.toolInvocationId), undefined);
  assert.equal(adapter.calls.prepare, 0);
});

test('reusing a tool invocation id with a different input is a conflict and dispatches nothing new', async () => {
  const adapter = new FakeAdapter();
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-mismatch');
  assertStatus(await gateway.run(req), 'verified');
  await assert.rejects(gateway.run({ ...req, input: { name: 'other' } }), (e: unknown) => isHypertestError(e, 'conflict'));
  assert.equal(adapter.calls.dispatch, 1);
});

test('I4: ten concurrent duplicate deliveries of one tool call ⇒ one operation, one external side effect', async () => {
  const adapter = new FakeAdapter();
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-dup');
  const outs = await Promise.all(Array.from({ length: 10 }, () => gateway.run({ ...req, signal: new AbortController().signal })));
  for (const o of outs) assertStatus(o, 'verified');
  assert.equal(new Set(outs.map((o) => o.operation.operationId)).size, 1);
  assert.equal(adapter.calls.dispatch, 1);
  assert.equal(adapter.target.created, 1);
  assert.equal((await env.ledger.list({ runId: 'run-dup' })).length, 1);
});

test('I4: duplicate delivery to two workers with distinct lease owners ⇒ exactly one dispatch', async () => {
  const target = new FakeTarget();
  const a = new FakeAdapter({ target });
  const b = new FakeAdapter({ target });
  const req = request('run-two-workers');
  const [oa, ob] = await Promise.all([
    gatewayFor(env, [a]).gateway.run({ ...req, lease: { resourceKey: 'env/two', owner: 'worker-1', ttlMs: 60_000 } }),
    gatewayFor(env, [b]).gateway.run({ ...req, lease: { resourceKey: 'env/two', owner: 'worker-2', ttlMs: 60_000 } }),
  ]);
  // One worker wins the lease and dispatches; the other is refused as busy, or (if it arrives after
  // completion) receives the recorded verified result. Never a second dispatch.
  assert.ok(oa.status === 'verified' || ob.status === 'verified');
  for (const o of [oa, ob]) {
    if (o.status !== 'verified') {
      assertStatus(o, 'failed');
      assert.equal(o.reason, 'resource_busy');
    }
  }
  assert.equal(oa.operation.operationId, ob.operation.operationId);
  assert.equal(a.calls.dispatch + b.calls.dispatch, 1);
  assert.equal(target.created, 1);
});

test('compensation: only from verified; verified → compensating → compensated; idempotent afterwards', async () => {
  const adapter = new FakeAdapter();
  const { gateway } = gatewayFor(env, [adapter]);
  const signal = new AbortController().signal;
  const ctx = eventCtx('run-comp');
  const out = await gateway.run(request('run-comp'));
  assertStatus(out, 'verified');
  const comp = await gateway.compensate(out.operation.operationId, ctx, signal);
  assertStatus(comp, 'not_applied');
  assert.equal(comp.reason, 'compensated');
  assert.equal(comp.operation.status, 'compensated');
  assert.equal(adapter.target.jobs.has(out.operation.operationId), false);
  const again = await gateway.compensate(out.operation.operationId, ctx, signal);
  assertStatus(again, 'not_applied');
  assert.equal(adapter.calls.compensate, 1);
  const types = eventTypesFor(env, out.operation.operationId);
  assert.deepEqual(types.slice(-2), ['operation.compensating', 'operation.compensated']);
});

test('compensation is refused while the original outcome is unknown (no simultaneous redo and undo)', async () => {
  const adapter = new FakeAdapter();
  adapter.dispatchFaults = ['apply_then_throw'];
  const { gateway } = gatewayFor(env, [adapter]);
  const out = await gateway.run(request('run-comp-unknown'));
  assertStatus(out, 'pending');
  await assert.rejects(gateway.compensate(out.operation.operationId, eventCtx('run-comp-unknown'), new AbortController().signal), (e: unknown) => isHypertestError(e, 'precondition_failed'));
  assert.equal(adapter.calls.compensate, 0);
  assert.equal((await env.ledger.get(out.operation.operationId))?.status, 'outcome_unknown');
});

test('a failed or unconfirmed compensation ⇒ manual_review, the original record is kept', async () => {
  for (const fault of ['throw', 'not_confirmed'] as const) {
    const adapter = new FakeAdapter();
    adapter.compensateFault = fault;
    const { gateway } = gatewayFor(env, [adapter]);
    const out = await gateway.run(request(`run-comp-${fault}`));
    assertStatus(out, 'verified');
    const comp = await gateway.compensate(out.operation.operationId, eventCtx(`run-comp-${fault}`), new AbortController().signal);
    assertStatus(comp, 'manual_review');
    assert.match(comp.reason, fault === 'throw' ? /compensation failed \(internal\): delete call timed out/ : /compensation not confirmed: job still terminating/);
    assert.equal(comp.operation.status, 'manual_review');
    assert.equal(comp.operation.externalJobId, 'job-1');
  }
});

test('an interrupted compensation is resumed by looking the effect up', async () => {
  const adapter = new FakeAdapter();
  const crashy = crashingLedger(env.ledger, 'compensated');
  const out = await gatewayFor(env, [adapter]).gateway.run(request('run-comp-resume'));
  assertStatus(out, 'verified');
  const ctx = eventCtx('run-comp-resume');
  await assert.rejects(gatewayFor(env, [adapter], { ledger: crashy }).gateway.compensate(out.operation.operationId, ctx, new AbortController().signal), /simulated worker crash/);
  assert.equal((await env.ledger.get(out.operation.operationId))?.status, 'compensating');
  const resumed = await gatewayFor(env, [adapter]).gateway.compensate(out.operation.operationId, ctx, new AbortController().signal);
  assertStatus(resumed, 'not_applied');
  assert.equal(resumed.operation.status, 'compensated');
  assert.equal(adapter.calls.compensate, 1, 'the effect was already gone, no second compensation call');
});

test('compensation requires adapter support', async () => {
  const adapter = new FakeAdapter({ adapterId: 'fake-nocomp', capabilities: { supportsCompensation: false } });
  const { gateway } = gatewayFor(env, [adapter]);
  const out = await gateway.run(request('run-nocomp', { adapterId: 'fake-nocomp' }));
  assertStatus(out, 'verified');
  await assert.rejects(gateway.compensate(out.operation.operationId, eventCtx('run-nocomp'), new AbortController().signal), (e: unknown) => isHypertestError(e, 'unsupported'));
});

test('observe/compensate of an unknown operation id is not_found; unknown adapters are not_found', async () => {
  const { gateway } = gatewayFor(env, [new FakeAdapter()]);
  const signal = new AbortController().signal;
  await assert.rejects(gateway.observe('op_missing', eventCtx('r'), signal), (e: unknown) => isHypertestError(e, 'not_found'));
  await assert.rejects(gateway.compensate('op_missing', eventCtx('r'), signal), (e: unknown) => isHypertestError(e, 'not_found'));
  await assert.rejects(gateway.run(request('run-no-adapter', { adapterId: 'nope' })), (e: unknown) => isHypertestError(e, 'not_found'));
});

test('AdapterRegistry: get throws not_found, duplicate ids conflict, invalid capabilities are rejected', () => {
  const registry = new AdapterRegistry([new FakeAdapter({ adapterId: 'a' })]);
  assert.equal(registry.has('a'), true);
  assert.equal(registry.get('a').adapterId, 'a');
  assert.throws(() => registry.get('b'), (e: unknown) => isHypertestError(e, 'not_found'));
  assert.throws(() => registry.register(new FakeAdapter({ adapterId: 'a' })), (e: unknown) => isHypertestError(e, 'conflict'));
  assert.throws(() => registry.register(new FakeAdapter({ adapterId: 'c', capabilities: { riskClass: 'extreme' as never } })), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  // Inherited Object.prototype keys are not risk classes (they would compare as "not high risk").
  for (const bogus of ['toString', 'constructor', '__proto__']) {
    assert.throws(() => registry.register(new FakeAdapter({ adapterId: `c-${bogus}`, capabilities: { riskClass: bogus as never } })), (e: unknown) => isHypertestError(e, 'invalid_argument'), bogus);
  }
  assert.throws(() => registry.register(new FakeAdapter({ adapterId: 'c-rc', capabilities: { reconciliationClass: 'toString' as never } })), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  const noComp = new FakeAdapter({ adapterId: 'd' }) as unknown as { compensate?: unknown };
  noComp.compensate = undefined;
  assert.throws(() => registry.register(noComp as never), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  assert.deepEqual(registry.list().map((a) => a.adapterId), ['a']);
});
