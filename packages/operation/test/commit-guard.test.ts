/**
 * Side-effect governance at the gateway (wave 2):
 *  - E[0] the caller's authority (its work claim) is re-validated at the COMMIT POINT — inside the transaction that records
 *    `dispatching` — so an expired worker never reaches the target (0 successes);
 *  - E[1] a verified effect that lasts (a time-boxed fault: `effectUntil`) keeps its resource lease until its window ends,
 *    so a second overlapping effect on the same resource is refused as busy.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlExecutor } from '@hypertest/core';
import type { VerificationResult } from '../src/index.ts';
import { effectHoldUntil } from '../src/index.ts';
import { FakeAdapter, gatewayFor, openEnv, request, type Env, type Job } from './helpers.ts';

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

test('E[0]: a commit guard that refuses ⇒ nothing is dispatched, the operation is not_applied with the exact reason, outcome stale_fence', async () => {
  const adapter = new FakeAdapter();
  const { gateway } = gatewayFor(env, [adapter]);
  const out = await gateway.run(request('run-claim-gone', { commitGuard: async () => 'work item wi-1 is no longer held with fencing token 3' }));
  assert.equal(out.status, 'stale_fence');
  assert.ok('reason' in out);
  assert.match(out.reason, /^claim_fenced: work item wi-1 is no longer held with fencing token 3; nothing was dispatched$/);
  assert.equal(out.operation.status, 'not_applied');
  assert.match(out.operation.lastError ?? '', /claim_fenced: work item wi-1/);
  assert.equal(adapter.calls.dispatch, 0, 'the target was never contacted');
  assert.equal(adapter.target.created, 0);
});

test('E[0]: the guard runs INSIDE the dispatching transaction (it sees the operation still prepared; a refusal leaves no dispatching record)', async () => {
  const adapter = new FakeAdapter();
  const { gateway } = gatewayFor(env, [adapter]);
  const seen: string[] = [];
  const guard = async (tx: SqlExecutor) => {
    const r = await tx.query<{ status: string }>("SELECT status FROM ht_operations WHERE run_id = 'run-guard-tx'");
    seen.push(r.rows.map((x) => x.status).join(','));
    return undefined;
  };
  const out = await gateway.run(request('run-guard-tx', { commitGuard: guard }));
  assert.equal(out.status, 'verified');
  assert.deepEqual(seen, ['prepared'], 'checked once, before the → dispatching write of the same transaction');
  assert.equal(adapter.calls.dispatch, 1);
});

test('E[0]: a guard that throws refuses (fail closed); a replay with a held claim dispatches the not_applied operation once', async () => {
  const adapter = new FakeAdapter();
  const { gateway } = gatewayFor(env, [adapter]);
  const req = request('run-guard-throws', { commitGuard: async () => {
    throw new Error('blackboard unreachable');
  } });
  const refused = await gateway.run(req);
  assert.equal(refused.status, 'stale_fence');
  assert.ok('reason' in refused);
  assert.match(refused.reason, /claim_fenced: the caller's authority could not be verified \(internal\): blackboard unreachable/);
  assert.equal(adapter.calls.dispatch, 0);
  // the rightful holder replays the same invocation (same input): a fresh decision, dispatched once
  const ok = await gateway.run({ ...req, commitGuard: async () => undefined });
  assert.equal(ok.status, 'verified');
  assert.equal(ok.operation.operationId, refused.operation.operationId);
  assert.equal(adapter.calls.dispatch, 1);
  assert.equal(adapter.target.created, 1);
});

test('E[0]: a re-dispatch after reconciliation (absent) is guarded too: a claim lost meanwhile sends nothing', async () => {
  const adapter = new FakeAdapter();
  adapter.dispatchFaults = ['throw_before_apply'];
  const { gateway } = gatewayFor(env, [adapter]);
  let held = true;
  const req = request('run-guard-redispatch', { commitGuard: async () => (held ? undefined : 'claim revoked while the outcome was unknown') });
  const first = await gateway.run(req);
  assert.equal(first.status, 'pending');
  assert.equal(first.operation.status, 'outcome_unknown');
  held = false;
  const second = await gateway.run(req);
  assert.equal(second.status, 'stale_fence');
  assert.equal(second.operation.status, 'not_applied', 'reconciled absent, then the re-dispatch was refused');
  assert.equal(adapter.calls.dispatch, 1, 'only the first (failed) attempt ever reached the adapter');
  assert.equal(adapter.target.created, 0);
});

/** A fake whose verification declares an effect window (a time-boxed fault). */
class TimeBoxedAdapter extends FakeAdapter {
  until: string;
  constructor(until: string) {
    super({ adapterId: 'timeboxed' });
    this.until = until;
  }
  override async verify(observation: Job, desiredStateHash: string): Promise<VerificationResult> {
    const v = await super.verify(observation, desiredStateHash);
    return v.status === 'verified' ? { ...v, effectUntil: this.until } : v;
  }
}

test('E[1]: a verified time-boxed effect holds its resource lease until effectUntil — an overlapping effect of another owner is refused busy; after the window it is free', async () => {
  const until = new Date(env.clock.nowMs() + 600_000).toISOString();
  const adapter = new TimeBoxedAdapter(until);
  const { gateway } = gatewayFor(env, [adapter]);
  const lease = { resourceKey: 'env/svc-fault', ttlMs: 30_000 };
  const a = await gateway.run(request('run-fault-a', { adapterId: 'timeboxed', target: { resourceKey: 'env/svc-fault', kind: 'environment' }, lease: { ...lease, owner: 'worker:item-a:1' } }));
  assert.equal(a.status, 'verified');
  assert.equal((a.result as { effectUntil?: string }).effectUntil, until, 'the window is recorded with the result');
  assert.equal(effectHoldUntil(a.operation, env.clock.nowMs()), until);
  const live = await env.leases.current('env/svc-fault');
  assert.ok(live, 'the lease is NOT released when the operation settles');
  assert.equal(live.owner, 'worker:item-a:1');
  assert.equal(live.expiresAt, until, 'it was extended to the end of the effect window');

  const b = await gateway.run(request('run-fault-b', { adapterId: 'timeboxed', target: { resourceKey: 'env/svc-fault', kind: 'environment' }, lease: { ...lease, owner: 'worker:item-b:1' } }));
  assert.equal(b.status, 'failed');
  assert.ok('reason' in b);
  assert.equal(b.reason, 'resource_busy');
  assert.equal(adapter.target.created, 1, 'the overlapping effect was never dispatched');

  env.clock.advance(600_001);
  const c = await gateway.run(request('run-fault-c', { adapterId: 'timeboxed', target: { resourceKey: 'env/svc-fault', kind: 'environment' }, lease: { ...lease, owner: 'worker:item-c:1' } }));
  assert.equal(c.status, 'verified', 'the window ended: the resource is free again');
});

test('E[1]: compensating the lasting effect releases its lease at once; holdLeaseForEffect:false releases on settle', async () => {
  const until = new Date(env.clock.nowMs() + 600_000).toISOString();
  const adapter = new TimeBoxedAdapter(until);
  const { gateway } = gatewayFor(env, [adapter]);
  const a = await gateway.run(request('run-fault-comp', { adapterId: 'timeboxed', target: { resourceKey: 'env/svc-comp', kind: 'environment' }, lease: { resourceKey: 'env/svc-comp', ttlMs: 30_000, owner: 'o-a' } }));
  assert.equal(a.status, 'verified');
  assert.ok(await env.leases.current('env/svc-comp'));
  const undone = await gateway.compensate(a.operation.operationId, request('run-fault-comp').ctx, new AbortController().signal);
  assert.equal(undone.operation.status, 'compensated');
  assert.equal(await env.leases.current('env/svc-comp'), undefined, 'the effect was undone: the resource is free');

  const free = await gateway.run(request('run-fault-nohold', { adapterId: 'timeboxed', holdLeaseForEffect: false, target: { resourceKey: 'env/svc-nohold', kind: 'environment' }, lease: { resourceKey: 'env/svc-nohold', ttlMs: 30_000, owner: 'o-b' } }));
  assert.equal(free.status, 'verified');
  assert.equal(await env.leases.current('env/svc-nohold'), undefined);
});
