import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { InMemoryEventSink } from '@hypertest/domain';
import { eventCtx } from '@hypertest/testkit';
import { PowerContextClient, contextMigrations, createExperienceStore, listenMemoryService, withExperienceEvents, type DurableMemory, type MemoryServiceServer } from '../src/index.ts';
import { openDb, type Db } from './helpers.ts';

/**
 * (B[4]) The memory-service HTTP API (in process here; packages/app/test/memory-service.e2e.test.ts runs it as its own
 * process): request validation and error mapping round-trip to the client's HypertestError codes; withExperienceEvents
 * records a remote decision on the local L0 exactly once.
 */
let env: Db;
let server: MemoryServiceServer;
let mem: DurableMemory;
const KEY = 'svc-key-0123456789abcdef';

before(async () => {
  env = await openDb(contextMigrations);
  mem = createExperienceStore({ ...env.deps });
  server = await listenMemoryService({ memory: mem, apiKey: KEY, maxBodyBytes: 4096 });
});
after(async () => {
  await server?.close();
  await env?.dispose();
});

test('validation and error mapping', async () => {
  const h = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
  const post = (path: string, body: string) => fetch(`${server.url}${path}`, { method: 'POST', headers: h, body });
  const err = async (r: Response) => [r.status, ((await r.json()) as { error: { code: string } }).error.code];
  assert.deepEqual(await err(await post('/v1/experiences', '{not json')), [400, 'invalid_argument']);
  assert.deepEqual(await err(await post('/v1/experiences', JSON.stringify({ content: 'x'.repeat(5000) }))), [413, 'invalid_argument']);
  assert.deepEqual(await err(await post('/v1/experiences', JSON.stringify({ scope: {}, kind: 'lesson', content: '', sourceRunId: 'r', evidenceRefs: [], createdBy: 'a' }))), [400, 'invalid_argument']);
  assert.deepEqual(await err(await post('/v1/experiences/xp_1/review', JSON.stringify({ decision: 'approve' }))), [400, 'invalid_argument']);
  assert.deepEqual(await err(await fetch(`${server.url}/v1/experiences?status=bogus`, { headers: h })), [400, 'invalid_argument']);
  assert.deepEqual(await err(await fetch(`${server.url}/v1/nothing`, { headers: h })), [404, 'not_found']);
  assert.deepEqual(await err(await fetch(`${server.url}/v1/experiences`, { headers: { authorization: `Bearer ${KEY}x` } })), [401, 'permission_denied']);
  // an actor header that is not valid percent-encoding is a client error, never a crash
  assert.deepEqual(await err(await fetch(`${server.url}/v1/experiences`, { method: 'POST', headers: { ...h, 'x-hypertest-actor-id': '%E0%A4%A' }, body: '{}' })), [400, 'invalid_argument']);
});

test('a non-ASCII actor round-trips; withExperienceEvents appends each remote decision once on the local L0', async () => {
  const sink = new InMemoryEventSink();
  const events = Object.assign(sink, { get: async (id: string) => sink.events.find((e) => e.eventId === id) });
  const client = withExperienceEvents(new PowerContextClient({ baseUrl: server.url, apiKey: KEY, timeoutMs: 5_000 }), { events });
  const ctx = { ...eventCtx('run_svc'), actorId: 'agent:规划' };
  const item = await client.propose({ scope: {}, kind: 'lesson', content: 'lesson body', sourceRunId: 'run_svc', evidenceRefs: [], createdBy: 'agent:规划' }, ctx);
  // the service sees the true calling actor (URI-encoded header), so a fresh client cannot self-review by naming someone else
  await assert.rejects(new PowerContextClient({ baseUrl: server.url, apiKey: KEY, timeoutMs: 5_000 }).review(item.experienceId, 'approve', 'human:x', ctx), (e: Error & { code?: string }) => e.code === 'permission_denied');
  const reviewCtx = { ...ctx, actorId: 'human:张三' };
  await client.review(item.experienceId, 'approve', 'human:张三', reviewCtx);
  await client.review(item.experienceId, 'approve', 'human:张三', reviewCtx); // an idempotent retry
  assert.deepEqual(sink.events.map((e) => [e.eventType, e.aggregateId, e.runId]), [['experience.proposed', item.experienceId, 'run_svc'], ['experience.reviewed', item.experienceId, 'run_svc']]);
});
