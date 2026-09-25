import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HypertestError } from '@hypertest/core';
import { createTestDatabase, migrate, splitSql } from '../src/index.ts';

const MIGRATIONS = [
  { id: 'store/001-t', sql: `CREATE TABLE ht_t (id text PRIMARY KEY, n bigint NOT NULL, j jsonb, at timestamptz DEFAULT now());
CREATE FUNCTION ht_noop() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;` },
];

test('splitSql respects quotes, comments and dollar quoting', () => {
  const parts = splitSql(`SELECT 'a;b'; -- c;d\nSELECT $$x;y$$; SELECT "q;"`);
  assert.deepEqual(parts, [`SELECT 'a;b'`, `SELECT $$x;y$$`, `SELECT "q;"`]);
});

test('pglite: migrate is idempotent and detects changed migrations', async () => {
  const { db, dispose } = await createTestDatabase({ kind: 'pglite' });
  try {
    assert.deepEqual((await migrate(db, MIGRATIONS)).applied, ['store/001-t']);
    assert.deepEqual((await migrate(db, MIGRATIONS)).skipped, ['store/001-t']);
    await assert.rejects(migrate(db, [{ id: 'store/001-t', sql: 'SELECT 1' }]), (e: unknown) => e instanceof HypertestError && e.code === 'integrity_violation');
  } finally {
    await dispose();
  }
});

test('pglite: bigint as number, json params, rollback and conflict mapping', async () => {
  const { db, dispose } = await createTestDatabase({ kind: 'pglite', migrations: MIGRATIONS });
  try {
    await db.query('INSERT INTO ht_t (id, n, j) VALUES ($1, $2, $3)', ['a', 41, { x: [1, 2] }]);
    const r = await db.query<{ n: number; j: { x: number[] }; at: Date }>('SELECT n + 1 AS n, j, at FROM ht_t WHERE id = $1', ['a']);
    assert.equal(r.rows[0]!.n, 42);
    assert.deepEqual(r.rows[0]!.j, { x: [1, 2] });
    await assert.rejects(db.transaction(async (tx) => {
      await tx.query('INSERT INTO ht_t (id, n) VALUES ($1, $2)', ['b', 1]);
      throw new Error('boom');
    }));
    assert.equal((await db.query('SELECT * FROM ht_t WHERE id = $1', ['b'])).rows.length, 0);
    await assert.rejects(db.query('INSERT INTO ht_t (id, n) VALUES ($1, $2)', ['a', 1]), (e: unknown) => e instanceof HypertestError && e.code === 'conflict');
    // nested transactions reuse the outer one
    await db.transaction(async () => {
      await db.transaction(async (tx2) => {
        await tx2.query('INSERT INTO ht_t (id, n) VALUES ($1, $2)', ['c', 3]);
      });
      await db.query('INSERT INTO ht_t (id, n) VALUES ($1, $2)', ['d', 4]);
    });
    assert.equal((await db.query('SELECT count(*)::int AS c FROM ht_t')).rows[0]!['c'], 3);
  } finally {
    await dispose();
  }
});

test('pglite: concurrent transactions are serialized', async () => {
  const { db, dispose } = await createTestDatabase({ kind: 'pglite', migrations: MIGRATIONS });
  try {
    await db.query('INSERT INTO ht_t (id, n) VALUES ($1, 0)', ['ctr']);
    await Promise.all(Array.from({ length: 20 }, () => db.transaction(async (tx) => {
      const r = await tx.query<{ n: number }>('SELECT n FROM ht_t WHERE id = $1', ['ctr']);
      await tx.query('UPDATE ht_t SET n = $1 WHERE id = $2', [r.rows[0]!.n + 1, 'ctr']);
    })));
    assert.equal((await db.query<{ n: number }>('SELECT n FROM ht_t WHERE id = $1', ['ctr'])).rows[0]!.n, 20);
  } finally {
    await dispose();
  }
});
