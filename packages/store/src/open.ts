import { randomBytes } from 'node:crypto';
import { HypertestError, type SqlDatabase } from '@hypertest/core';
import type { DatabaseOptions, TestDatabase, TestDatabaseOptions } from './contracts.ts';
import { migrate } from './migrate.ts';
import { createRawPglite, openPglite, wrapPglite } from './pglite.ts';
import { sha256Hex } from '@hypertest/core';
import { openPostgres } from './postgres.ts';

export async function openDatabase(options: DatabaseOptions): Promise<SqlDatabase> {
  if (options.kind === 'pglite') {
    const o: { dataDir?: string; extensions?: Array<'vector'> } = {};
    if (options.dataDir !== undefined) o.dataDir = options.dataDir;
    if (options.extensions !== undefined) o.extensions = options.extensions;
    return openPglite(o);
  }
  if (options.kind === 'postgres') {
    const o: { url: string; schema?: string; maxConnections?: number } = { url: options.url };
    if (options.schema !== undefined) o.schema = options.schema;
    if (options.maxConnections !== undefined) o.maxConnections = options.maxConnections;
    return openPostgres(o);
  }
  throw new HypertestError('invalid_argument', 'unknown database kind');
}

/**
 * Fresh database for a test. Default: in-memory PGlite. With HYPERTEST_TEST_DB=postgres (and
 * HYPERTEST_TEST_PG_URL) a uniquely named schema is created and dropped on dispose.
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const kind = options.kind ?? (process.env['HYPERTEST_TEST_DB'] === 'postgres' ? 'postgres' : 'pglite');
  if (kind === 'postgres') {
    const url = process.env['HYPERTEST_TEST_PG_URL'];
    if (!url) throw new HypertestError('unavailable', 'HYPERTEST_TEST_PG_URL is not set');
    const schema = `ht_test_${randomBytes(6).toString('hex')}`;
    const db = await openPostgres({ url, schema, maxConnections: 5 });
    if (options.migrations) await migrate(db, options.migrations);
    return {
      db,
      dispose: async () => {
        await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
        await db.close();
      },
    };
  }
  // PGlite cold start is ~2-4s; clone a per-process migrated template instead (~0.5s).
  const key = sha256Hex(JSON.stringify({ e: options.extensions ?? [], m: (options.migrations ?? []).map((m) => [m.id, sha256Hex(m.sql)]) }));
  let template = templates.get(key);
  if (!template) {
    template = (async () => {
      const pgliteOptions: { extensions?: Array<'vector'> } = {};
      if (options.extensions) pgliteOptions.extensions = options.extensions;
      const raw = await createRawPglite(pgliteOptions);
      if (options.migrations) await migrate(wrapPglite(raw), options.migrations);
      return raw;
    })();
    templates.set(key, template);
  }
  const raw = await template;
  const db = wrapPglite(await raw.clone());
  return { db, dispose: () => db.close() };
}

const templates = new Map<string, Promise<Awaited<ReturnType<typeof createRawPglite>>>>();
