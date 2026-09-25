import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isHypertestError } from '@hypertest/core';
import type { OperationRecord } from '@hypertest/domain';
import { FakeAdapter, crashingLedger, gatewayFor, openEnv, request, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

async function opFor(req: { toolInvocationId: string }): Promise<OperationRecord> {
  const op = await env.ledger.findByToolInvocation(req.toolInvocationId);
  assert.ok(op, `operation for ${req.toolInvocationId}`);
  return op;
}

test('I4: startup reconciliation settles every unsettled operation by observation, never by dispatch', async () => {
  const ok = new FakeAdapter({ adapterId: 'rc-ok' });
  const unc = new FakeAdapter({ adapterId: 'rc-unc' });
  const slow = new FakeAdapter({ adapterId: 'rc-slow' });
  const bad = new FakeAdapter({ adapterId: 'rc-bad' });
  const orphan = new FakeAdapter({ adapterId: 'rc-orphan' });
  const flaky = new FakeAdapter({ adapterId: 'rc-flaky' });
  ok.dispatchFaults = ['apply_then_throw', 'throw_before_apply', 'apply_then_throw', 'apply_then_throw'];
  unc.dispatchFaults = ['apply_then_throw'];
  slow.completeAfterObserves = 100;
  bad.dispatchFaults = ['apply_then_throw'];
  orphan.dispatchFaults = ['apply_then_throw'];
  flaky.dispatchFaults = ['apply_then_throw'];
  const all = [ok, unc, slow, bad, orphan, flaky];
  const { gateway } = gatewayFor(env, all);

  const reqA = request('run-rc', { adapterId: 'rc-ok' }); // effect exists
  const reqB = request('run-rc', { adapterId: 'rc-ok' }); // effect absent
  const reqC = request('run-rc', { adapterId: 'rc-unc' }); // lookup uncertain
  const reqD = request('run-rc', { adapterId: 'rc-slow' }); // acknowledged, still running
  const reqE = request('run-rc', { adapterId: 'rc-bad' }); // present but does not verify
  const reqF = request('run-rc', { adapterId: 'rc-orphan' }); // adapter not registered after restart
  const reqG = request('run-rc', { adapterId: 'rc-ok', lease: { resourceKey: 'env/rc-g', owner: 'worker-g', ttlMs: 60_000 } }); // lease still live
  const reqH = request('run-rc-other', { adapterId: 'rc-ok' }); // other run
  const reqI = request('run-rc', { adapterId: 'rc-ok' }); // crashed in dispatching
  const reqJ = request('run-rc', { adapterId: 'rc-flaky' }); // observe throws during reconcile
  for (const r of [reqA, reqB, reqC, reqD, reqE, reqF, reqG, reqH]) await gateway.run(r);
  await assert.rejects(gatewayFor(env, all, { ledger: crashingLedger(env.ledger, 'acknowledged') }).gateway.run(reqI), /simulated worker crash/);
  await gateway.run(reqJ);
  const [a, b, c, d, e, f, g, h, i, j] = await Promise.all([reqA, reqB, reqC, reqD, reqE, reqF, reqG, reqH, reqI, reqJ].map(opFor));
  assert.deepEqual(
    [a, b, c, d, e, f, g, h, i, j].map((o) => o!.status),
    ['outcome_unknown', 'outcome_unknown', 'outcome_unknown', 'acknowledged', 'outcome_unknown', 'outcome_unknown', 'outcome_unknown', 'outcome_unknown', 'dispatching', 'outcome_unknown'],
  );
  unc.observeFaults = ['uncertain'];
  bad.verifyFailure = 'job exited with code 3';
  flaky.observeFaults = ['throw'];
  const dispatchesBefore = all.map((x) => x.calls.dispatch);
  const observesOfGBefore = ok.calls.observe;

  // Restarted process: the orphan adapter is not registered.
  const { reconciler } = gatewayFor(env, [ok, unc, slow, bad, flaky]);
  const report = await reconciler.reconcile({ runId: 'run-rc' }, new AbortController().signal);
  assert.deepEqual(report, {
    examined: 9,
    verified: [a!.operationId, i!.operationId],
    notApplied: [b!.operationId],
    manualReview: [c!.operationId],
    stillPending: [d!.operationId, f!.operationId, g!.operationId, j!.operationId],
    failed: [e!.operationId],
  });
  assert.deepEqual(all.map((x) => x.calls.dispatch), dispatchesBefore, 'reconciliation never dispatches');
  assert.equal(ok.calls.observe - observesOfGBefore, 3, 'A, B and I were observed; G (live lease) was not');
  assert.equal((await env.ledger.get(g!.operationId))?.status, 'outcome_unknown');
  assert.equal((await env.ledger.get(h!.operationId))?.status, 'outcome_unknown', 'other runs are untouched');
  assert.equal((await env.ledger.get(j!.operationId))?.status, 'reconciling');
  assert.equal((await env.ledger.get(b!.operationId))?.status, 'not_applied');
  assert.equal(ok.target.created, 4, 'one job each for A, G, H and I; none for B');
  assert.deepEqual([unc, slow, bad, orphan, flaky].map((x) => x.target.created), [1, 1, 1, 1, 1]);

  // A reconciled not_applied operation is safely re-dispatched by the next run of its tool call.
  const retried = await gateway.run(reqB);
  assert.equal(retried.status, 'verified');
  assert.equal(ok.target.created, 5, 'A, G, H, I and the retried B: one job each');

  // Without a run filter, the remaining unsettled work (incl. other runs) is examined.
  const { reconciler: again } = gatewayFor(env, [ok, unc, slow, bad, flaky]);
  const second = await again.reconcile({}, new AbortController().signal);
  assert.ok(second.verified.includes(h!.operationId));
  assert.ok(second.verified.includes(j!.operationId), 'the flaky lookup succeeded on the second pass');
  assert.ok(second.stillPending.includes(d!.operationId));
});

test('an expired lease no longer shields its operation from reconciliation', async () => {
  const ok = new FakeAdapter({ adapterId: 'rc2' });
  ok.dispatchFaults = ['apply_then_throw'];
  const { gateway, reconciler } = gatewayFor(env, [ok]);
  const req = request('run-rc2', { adapterId: 'rc2', lease: { resourceKey: 'env/rc2', owner: 'w', ttlMs: 1_000 } });
  await gateway.run(req);
  const op = await opFor(req);
  assert.deepEqual((await reconciler.reconcile({ runId: 'run-rc2' }, new AbortController().signal)).stillPending, [op.operationId]);
  env.clock.advance(1_000);
  assert.deepEqual((await reconciler.reconcile({ runId: 'run-rc2' }, new AbortController().signal)).verified, [op.operationId]);
  assert.equal(ok.calls.dispatch, 1);
});

test('reconcile honours cancellation', async () => {
  const { reconciler } = gatewayFor(env, [new FakeAdapter()]);
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(reconciler.reconcile({}, ctrl.signal), (e: unknown) => isHypertestError(e, 'cancelled'));
});

test('reconciler events are attributed to the system reconciler with the operation run and work item', async () => {
  const ok = new FakeAdapter({ adapterId: 'rc3' });
  ok.dispatchFaults = ['apply_then_throw'];
  const { gateway, reconciler } = gatewayFor(env, [ok]);
  const req = request('run-rc3', { adapterId: 'rc3' });
  await gateway.run(req);
  const op = await opFor(req);
  await reconciler.reconcile({ runId: 'run-rc3' }, new AbortController().signal);
  const byReconciler = env.events.events.filter((e) => e.aggregateId === op.operationId && e.actorId === 'system:reconciler');
  assert.deepEqual(byReconciler.map((e) => e.eventType), ['operation.reconciling', 'operation.reconciled', 'operation.verified']);
  for (const e of byReconciler) {
    assert.equal(e.runId, 'run-rc3');
    assert.equal(e.workItemId, 'wi-run-rc3');
    assert.equal(e.agentId, 'agent-run-rc3');
    assert.equal(e.correlationId, op.operationId);
  }
});
