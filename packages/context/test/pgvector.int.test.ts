import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlDatabase } from '@hypertest/core';
import { createTestDatabase } from '@hypertest/store';
import { infraEnv } from '@hypertest/testkit';
import { HashEmbedder, createPgVectorIndex } from '../src/index.ts';
import { rejectsWith } from './helpers.ts';
import { exercisePgVector } from './pgvector-shared.ts';

const pgUrl = infraEnv().pgUrl;
const NO_PG = 'HYPERTEST_TEST_PG_URL is not set (run `npm run infra:up`)';

async function withPg(fn: (db: SqlDatabase, hasVector: boolean) => Promise<void>): Promise<void> {
  process.env['HYPERTEST_TEST_PG_URL'] ??= pgUrl;
  const { db, dispose } = await createTestDatabase({ kind: 'postgres' });
  try {
    const r = await db.query<{ n: unknown }>("SELECT count(*) AS n FROM pg_available_extensions WHERE name = 'vector'");
    await fn(db, Number(r.rows[0]!.n) > 0);
  } finally {
    await dispose();
  }
}

test('pgvector index on PostgreSQL 16 (when the server ships the vector extension)', { skip: pgUrl ? false : NO_PG }, async (t) => {
  await withPg(async (db, hasVector) => {
    if (!hasVector) {
      t.skip('the PostgreSQL server has no pgvector extension installed (pg_available_extensions lacks "vector")');
      return;
    }
    await exercisePgVector(db);
  });
});

test('PostgreSQL without pgvector: createPgVectorIndex fails closed with unsupported', { skip: pgUrl ? false : NO_PG }, async (t) => {
  await withPg(async (db, hasVector) => {
    if (hasVector) {
      t.skip('this server has pgvector; the unsupported path cannot be observed here');
      return;
    }
    const err = await rejectsWith(createPgVectorIndex(db, new HashEmbedder()), 'unsupported');
    assert.match(err.message, /pgvector is not available/);
  });
});
