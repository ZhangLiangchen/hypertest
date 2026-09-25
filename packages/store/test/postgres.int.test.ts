import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, migrate } from '../src/index.ts';

const url = process.env['HYPERTEST_TEST_PG_URL'];
const skip = url ? false : 'HYPERTEST_TEST_PG_URL not set (run `npm run infra:up`)';

test('postgres: schema-isolated database, migrations, bigint parsing, concurrency', { skip }, async () => {
  const { db, dispose } = await createTestDatabase({ kind: 'postgres' });
  try {
    await migrate(db, [{ id: 'store/001-t', sql: 'CREATE TABLE ht_t (id text PRIMARY KEY, n bigint NOT NULL)' }]);
    await db.query('INSERT INTO ht_t VALUES ($1, $2)', ['ctr', 0]);
    await Promise.all(Array.from({ length: 10 }, () => db.transaction(async (tx) => {
      const r = await tx.query<{ n: number }>('SELECT n FROM ht_t WHERE id = $1 FOR UPDATE', ['ctr']);
      await tx.query('UPDATE ht_t SET n = $1 WHERE id = $2', [r.rows[0]!.n + 1, 'ctr']);
    })));
    const r = await db.query<{ n: number }>('SELECT n FROM ht_t WHERE id = $1', ['ctr']);
    assert.equal(r.rows[0]!.n, 10);
    assert.equal(typeof r.rows[0]!.n, 'number');
  } finally {
    await dispose();
  }
});
