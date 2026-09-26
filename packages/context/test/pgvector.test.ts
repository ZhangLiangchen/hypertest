import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestDatabase } from '@hypertest/store';
import { HashEmbedder, createPgVectorIndex } from '../src/index.ts';
import { rejectsWith } from './helpers.ts';
import { exercisePgVector } from './pgvector-shared.ts';

test('pgvector index on PGlite (vector extension loaded)', async () => {
  const { db, dispose } = await createTestDatabase({ kind: 'pglite', extensions: ['vector'] });
  try {
    await exercisePgVector(db);
  } finally {
    await dispose();
  }
});

test('createPgVectorIndex throws unsupported when the vector extension is unavailable', async () => {
  const { db, dispose } = await createTestDatabase({ kind: 'pglite' });
  try {
    const err = await rejectsWith(createPgVectorIndex(db, new HashEmbedder()), 'unsupported');
    assert.match(err.message, /pgvector is not available/);
    const r = await db.query<{ n: unknown }>("SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'ht_vectors'");
    assert.equal(Number(r.rows[0]!.n), 0, 'no table is created without the extension');
  } finally {
    await dispose();
  }
});

test('pgvector: a table from the earlier revision (primary key on id alone) is upgraded to (model_id, id)', async () => {
  const { db, dispose } = await createTestDatabase({ kind: 'pglite', extensions: ['vector'] });
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');
    await db.query(`CREATE TABLE ht_vectors (id text PRIMARY KEY, namespace text NOT NULL, model_id text NOT NULL, ref jsonb NOT NULL, path text,
      line integer, text text NOT NULL, embedding vector(256) NOT NULL)`);
    const a = await createPgVectorIndex(db, new HashEmbedder());
    const b = await createPgVectorIndex(db, { dims: 256, modelId: 'model-b', embed: (t) => new HashEmbedder().embed(t) });
    const doc = { id: 'same', text: 'checkout cart', ref: { kind: 'file' as const, id: 'a.ts' }, namespace: 'code' };
    await a.upsert([doc]);
    await b.upsert([doc]);
    assert.equal((await a.search({ text: 'checkout' })).length, 1);
    assert.equal((await b.search({ text: 'checkout' })).length, 1);
    const pk = await db.query<{ col: string }>(
      `SELECT a.attname AS col FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'ht_vectors'::regclass AND i.indisprimary ORDER BY a.attname`,
    );
    assert.deepEqual(pk.rows.map((r) => r.col), ['id', 'model_id']);
  } finally {
    await dispose();
  }
});
