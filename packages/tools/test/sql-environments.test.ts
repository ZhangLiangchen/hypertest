import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isHypertestError, type SqlDatabase } from '@hypertest/core';
import type { OperationRecord } from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';
import { testDeps } from '@hypertest/testkit';
import { DockerEnvAdapter, createSqlEnvironmentRegistry, toolsMigrations, type EnvironmentDescriptor, type EnvironmentRegistry } from '../src/index.ts';

/**
 * H12: the SQL-backed EnvironmentRegistry (core SqlDatabase port + toolsMigrations). Two registry instances over one
 * database model two worker processes. Runs on PGlite, and on PostgreSQL 16 with HYPERTEST_TEST_DB=postgres.
 */
let db: SqlDatabase;
let dispose: () => Promise<void>;
before(async () => {
  ({ db, dispose } = await createTestDatabase({ migrations: toolsMigrations }));
});
after(async () => dispose());

const deps = () => ({ db, ...testDeps() });
const config = (id: string, extra: Partial<EnvironmentDescriptor> = {}): EnvironmentDescriptor => ({
  environmentId: id, environmentClass: 'staging', generation: 0, baseUrl: 'http://127.0.0.1:9', control: { kind: 'process', target: 'http://127.0.0.1:9/#token=secret' }, ...extra,
});
const code = (c: string) => (e: unknown) => isHypertestError(e, c as never);

test('H12: a restarted process never forgets a bump (the stored generation wins over the configured one); descriptors are never stored', async () => {
  const a = await createSqlEnvironmentRegistry(deps(), [config('env_r')]);
  assert.equal(a.get('env_r')?.generation, 0);
  const bumped = await a.bumpGenerationAsync('env_r', 'sha-1', 'op_r1');
  assert.deepEqual([bumped.generation, bumped.buildDigest, bumped.baseUrl], [1, 'sha-1', 'http://127.0.0.1:9']);
  // "restart": a fresh registry from the same configuration (generation 0)
  const b = await createSqlEnvironmentRegistry(deps(), [config('env_r', { baseUrl: 'http://127.0.0.1:10' })]);
  assert.deepEqual([b.get('env_r')?.generation, b.get('env_r')?.buildDigest, b.get('env_r')?.baseUrl], [1, 'sha-1', 'http://127.0.0.1:10'], 'generation from the store, descriptor from the configuration');
  const cols = await db.query<Record<string, unknown>>("SELECT * FROM ht_environments WHERE environment_id = 'env_r'");
  assert.deepEqual(Object.keys(cols.rows[0]!).sort(), ['build_digest', 'environment_id', 'generation', 'updated_at']);
  assert.doesNotMatch(JSON.stringify(cols.rows), /secret|127\.0\.0\.1/, 'no URL or control token in the database');
  // a configuration AHEAD of the store moves the store forward
  const c = await createSqlEnvironmentRegistry(deps(), [config('env_r', { generation: 5, buildDigest: 'sha-5' })]);
  assert.equal(c.get('env_r')?.generation, 5);
  assert.equal((await b.load('env_r'))?.generation, 5);
});

test('H12: one operation bumps once ACROSS processes; distinct operations never lose an update', async () => {
  const a = await createSqlEnvironmentRegistry(deps(), [config('env_x')]);
  const b = await createSqlEnvironmentRegistry(deps(), [config('env_x')]);
  const first = await a.bumpGenerationAsync('env_x', undefined, 'op_x1');
  assert.equal(first.generation, 1);
  // a reconciliation in another process re-verifies the same operation: the recorded bump, no second bump
  const again = await b.bumpGenerationAsync('env_x', undefined, 'op_x1');
  assert.equal(again.generation, 1);
  assert.equal((await b.load('env_x'))?.generation, 1);
  // concurrent bumps of distinct operations from two processes: serialized by the row lock
  const outs = await Promise.all([
    a.bumpGenerationAsync('env_x', undefined, 'op_x2'), b.bumpGenerationAsync('env_x', undefined, 'op_x3'),
    a.bumpGenerationAsync('env_x', undefined, 'op_x4'), b.bumpGenerationAsync('env_x', undefined, 'op_x5'),
  ]);
  assert.deepEqual(outs.map((o) => o.generation).sort(), [2, 3, 4, 5]);
  assert.equal((await a.load('env_x'))?.generation, 5);
  // an operation id names one environment
  const other = await createSqlEnvironmentRegistry(deps(), [config('env_y')]);
  await assert.rejects(other.bumpGenerationAsync('env_y', undefined, 'op_x1'), code('conflict'));
  await assert.rejects(a.bumpGenerationAsync('env_unknown'), code('not_found'));
});

test('H12: get() is the local view, load()/refresh() read the store; the sync members queue durable writes (flush)', async () => {
  const a = await createSqlEnvironmentRegistry(deps(), [config('env_v')]);
  const b = await createSqlEnvironmentRegistry(deps(), [config('env_v')]);
  await a.bumpGenerationAsync('env_v');
  assert.equal(b.get('env_v')?.generation, 0, 'the local view of another process lags');
  assert.equal((await b.load('env_v'))?.generation, 1, 'load() is authoritative');
  assert.equal(b.get('env_v')?.generation, 1, 'and refreshes the view');
  // the sync EnvironmentRegistry members (contract compatibility) persist through the queue
  const next = a.bumpGeneration('env_v', 'sha-sync', 'op_sync');
  assert.equal(next.generation, 2);
  assert.equal(a.bumpGeneration('env_v', 'sha-sync', 'op_sync').generation, 2, 're-verification in this process returns its bump');
  await a.flush();
  await b.refresh();
  assert.deepEqual([b.get('env_v')?.generation, b.get('env_v')?.buildDigest], [2, 'sha-sync']);
  a.register(config('env_new', { generation: 3 }));
  await a.flush();
  const c = await createSqlEnvironmentRegistry(deps(), [config('env_new')]);
  assert.equal(c.get('env_new')?.generation, 3);
  // the in-memory registry's rules hold
  assert.throws(() => a.register(config('env_v', { generation: 1 })), code('conflict'));
  await assert.rejects(a.registerAsync(config('env_v', { generation: 1 })), code('conflict'));
  assert.throws(() => a.register({ ...config('env_bad'), environmentClass: '' }), code('invalid_argument'));
  assert.equal(await a.load('env_not_registered_here'), undefined);
  assert.deepEqual(a.list().map((e) => e.environmentId), ['env_new', 'env_v']);
  // a failed queued write surfaces at flush()
  const broken = await createSqlEnvironmentRegistry({ ...deps(), db: { ...db, kind: db.kind, query: async () => { throw new Error('db down'); }, transaction: async () => { throw new Error('db down'); }, close: async () => undefined } }, []);
  broken.register(config('env_b'));
  await assert.rejects(broken.flush(), /db down/);
  await broken.flush();
});

test('H12: the env.* adapters bump through bumpGenerationAsync when the registry has one (atomic across processes)', async () => {
  const sql = await createSqlEnvironmentRegistry(deps(), [config('env_d', { control: { kind: 'docker', target: 'svc' } })]);
  const syncForbidden: EnvironmentRegistry = {
    get: (id) => sql.get(id), list: () => sql.list(), register: (e) => sql.register(e),
    bumpGeneration: () => {
      throw new Error('the sync bump must not be used when an atomic one exists');
    },
    bumpGenerationAsync: (id, digest, op) => sql.bumpGenerationAsync(id, digest, op),
  };
  const adapter = new DockerEnvAdapter({ environments: syncForbidden, docker: '/usr/bin/false' });
  const op = { operationId: 'op_docker_1', runId: 'r', workItemId: 'w', operationType: 'env.restart', adapterId: 'env.docker', target: { resourceKey: 'env/env_d', kind: 'environment' } } as unknown as OperationRecord;
  const v = await adapter.verify({ container: 'svc', status: 'running', running: true, startedAt: '2026-01-01T00:00:00Z', restarted: true } as never, 'h', { operation: op, signal: new AbortController().signal });
  assert.equal(v.status, 'verified');
  assert.equal((v as { result: { generation: number } }).result.generation, 1);
  // a second adapter instance (another process) re-verifying the same operation: no second bump
  const again = await new DockerEnvAdapter({ environments: syncForbidden, docker: '/usr/bin/false' }).verify({ container: 'svc', status: 'running', running: true, startedAt: '2026-01-01T00:00:00Z', restarted: true } as never, 'h', { operation: op, signal: new AbortController().signal });
  assert.equal((again as { result: { generation: number } }).result.generation, 1);
  assert.equal((await sql.load('env_d'))?.generation, 1);
});
