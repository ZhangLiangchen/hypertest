import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isHypertestError } from '@hypertest/core';
import { openEnv, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

const staleFence = (e: unknown) => isHypertestError(e, 'stale_fence');

async function highestAccepted(resourceKey: string): Promise<number> {
  const r = await env.db.query<{ h: number }>('SELECT highest_accepted::int AS h FROM ht_fences WHERE resource_key = $1', [resourceKey]);
  return r.rows[0]!.h;
}

test('acquire grants a lease with token 1; a different owner is refused while it is live', async () => {
  const a = await env.leases.acquire({ resourceKey: 'svc/l1', owner: 'w-a', ttlMs: 1_000 });
  assert.ok(a);
  assert.equal(a.fencingToken, 1);
  assert.equal(a.owner, 'w-a');
  assert.equal(a.acquiredAt, env.clock.isoNow());
  assert.equal(a.expiresAt, new Date(env.clock.nowMs() + 1_000).toISOString());
  assert.deepEqual(await env.leases.current('svc/l1'), a);
  assert.equal(await env.leases.acquire({ resourceKey: 'svc/l1', owner: 'w-b', ttlMs: 1_000 }), undefined);
  assert.equal((await env.leases.current('svc/l1'))?.owner, 'w-a');
});

test('I4: fencing tokens are strictly monotonic across 5 acquire/expire cycles', async () => {
  const tokens: number[] = [];
  const leaseIds = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const lease = await env.leases.acquire({ resourceKey: 'svc/cycles', owner: `w-${i}`, ttlMs: 100 });
    assert.ok(lease, `cycle ${i} granted`);
    tokens.push(lease.fencingToken);
    leaseIds.add(lease.leaseId);
    // Before expiry the next owner is refused.
    assert.equal(await env.leases.acquire({ resourceKey: 'svc/cycles', owner: `w-${i + 1}`, ttlMs: 100 }), undefined);
    env.clock.advance(100); // expiresAt == now ⇒ expired
    assert.equal(await env.leases.current('svc/cycles'), undefined);
  }
  assert.deepEqual(tokens, [1, 2, 3, 4, 5]);
  assert.equal(leaseIds.size, 5);
});

test('tokens are never reused: release does not reset the counter', async () => {
  const a = await env.leases.acquire({ resourceKey: 'svc/release', owner: 'w-a', ttlMs: 60_000 });
  assert.ok(a);
  await env.leases.release(a.leaseId);
  await env.leases.release(a.leaseId); // idempotent
  assert.equal(await env.leases.current('svc/release'), undefined);
  const b = await env.leases.acquire({ resourceKey: 'svc/release', owner: 'w-b', ttlMs: 60_000 });
  assert.equal(b?.fencingToken, a.fencingToken + 1);
  assert.equal(await env.leases.checkFence('svc/release', a.fencingToken), false);
});

test('a same-owner re-acquire supersedes the older lease with a newer token', async () => {
  const first = await env.leases.acquire({ resourceKey: 'svc/same', owner: 'w-a', ttlMs: 60_000 });
  const second = await env.leases.acquire({ resourceKey: 'svc/same', owner: 'w-a', ttlMs: 60_000 });
  assert.ok(first && second);
  assert.equal(second.fencingToken, first.fencingToken + 1);
  assert.notEqual(second.leaseId, first.leaseId);
  await assert.rejects(env.leases.renew(first.leaseId, 1_000), staleFence);
  assert.equal(await env.leases.checkFence('svc/same', first.fencingToken), false);
  assert.equal(await env.leases.checkFence('svc/same', second.fencingToken), true);
});

test('renew extends a live lease; renewing an expired or regranted lease is stale_fence', async () => {
  const a = await env.leases.acquire({ resourceKey: 'svc/renew', owner: 'w-a', ttlMs: 1_000 });
  assert.ok(a);
  env.clock.advance(800);
  const renewed = await env.leases.renew(a.leaseId, 1_000);
  assert.equal(renewed.fencingToken, a.fencingToken);
  assert.equal(renewed.expiresAt, new Date(env.clock.nowMs() + 1_000).toISOString());
  env.clock.advance(900);
  assert.equal((await env.leases.current('svc/renew'))?.leaseId, a.leaseId, 'renewal kept it alive');

  env.clock.advance(200); // expired
  await assert.rejects(env.leases.renew(a.leaseId, 1_000), (e: unknown) => staleFence(e) && /expired/.test((e as Error).message));
  const b = await env.leases.acquire({ resourceKey: 'svc/renew', owner: 'w-b', ttlMs: 1_000 });
  assert.equal(b?.fencingToken, a.fencingToken + 1);
  await assert.rejects(env.leases.renew(a.leaseId, 1_000), (e: unknown) => staleFence(e) && /no longer held/.test((e as Error).message));
  await assert.rejects(env.leases.renew('lease_unknown', 1_000), staleFence);
});

test('I4: checkFence accepts only the live lease token and records the highest accepted token', async () => {
  assert.equal(await env.leases.checkFence('svc/unknown', 1), false, 'unknown resource');
  const a = await env.leases.acquire({ resourceKey: 'svc/fence', owner: 'w-a', ttlMs: 1_000 });
  assert.ok(a);
  assert.equal(await env.leases.checkFence('svc/fence', a.fencingToken), true);
  assert.equal(await highestAccepted('svc/fence'), a.fencingToken);
  assert.equal(await env.leases.checkFence('svc/fence', a.fencingToken + 1), false, 'a token never issued');
  assert.equal(await env.leases.checkFence('svc/fence', 0), false);
  assert.equal(await env.leases.checkFence('svc/fence', -1), false);
  assert.equal(await env.leases.checkFence('svc/fence', 1.5), false);

  env.clock.advance(1_000);
  assert.equal(await env.leases.checkFence('svc/fence', a.fencingToken), false, 'expired lease');

  const b = await env.leases.acquire({ resourceKey: 'svc/fence', owner: 'w-b', ttlMs: 1_000 });
  assert.ok(b);
  assert.equal(await env.leases.checkFence('svc/fence', a.fencingToken), false, 'stale worker A is refused');
  assert.equal(await env.leases.checkFence('svc/fence', b.fencingToken), true);
  assert.equal(await highestAccepted('svc/fence'), b.fencingToken);
});

test('I4: a released lease token is refused', async () => {
  const a = await env.leases.acquire({ resourceKey: 'svc/released-fence', owner: 'w-a', ttlMs: 60_000 });
  assert.ok(a);
  await env.leases.release(a.leaseId);
  assert.equal(await env.leases.checkFence('svc/released-fence', a.fencingToken), false);
});

test('I4: concurrent acquires by different owners grant exactly one lease', async () => {
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => env.leases.acquire({ resourceKey: 'svc/race', owner: `w-${i}`, ttlMs: 60_000 })));
  const granted = results.filter((r) => r !== undefined);
  assert.equal(granted.length, 1);
  assert.equal(granted[0]!.fencingToken, 1);
});

test('invalid acquire/renew arguments are rejected', async () => {
  await assert.rejects(env.leases.acquire({ resourceKey: 'svc/x', owner: 'w', ttlMs: 0 }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  await assert.rejects(env.leases.acquire({ resourceKey: '', owner: 'w', ttlMs: 10 }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  await assert.rejects(env.leases.acquire({ resourceKey: 'svc/x', owner: '', ttlMs: 10 }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  await assert.rejects(env.leases.renew('lease_x', Number.NaN), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});
