import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import { HypertestError, type SqlDatabase, type SqlExecutor, type SqlParam, type SqlQueryResult } from '@hypertest/core';

type PgliteLike = {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[]; affectedRows?: number }> }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

function normalizeParams(params: readonly SqlParam[] | undefined): unknown[] | undefined {
  if (!params) return undefined;
  return params.map((p) => (p !== null && typeof p === 'object' && !(p instanceof Date) && !(p instanceof Uint8Array) && !Array.isArray(p) ? JSON.stringify(p) : p));
}

function wrapError(e: unknown, sql: string): HypertestError {
  const err = e as { code?: string; message?: string };
  if (err?.code === '23505') return new HypertestError('conflict', err.message ?? 'unique violation', { cause: e, details: { sql: sql.slice(0, 200) } });
  if (e instanceof HypertestError) return e;
  return new HypertestError('internal', `sql error: ${err?.message ?? String(e)}`, { cause: e, details: { sql: sql.slice(0, 200), pgCode: err?.code } });
}

class PgliteExecutor implements SqlExecutor {
  readonly #q: { query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[]; affectedRows?: number }> };
  constructor(q: { query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[]; affectedRows?: number }> }) {
    this.#q = q;
  }
  async query<R = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<SqlQueryResult<R>> {
    try {
      const r = await this.#q.query<R>(sql, normalizeParams(params));
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    } catch (e) {
      throw wrapError(e, sql);
    }
  }
}

/**
 * PGlite-backed database. PGlite has a single connection, so transactions are serialized with a
 * promise chain; a nested transaction() inside an active one reuses it (tracked via AsyncLocalStorage).
 */
export class PgliteDatabase implements SqlDatabase {
  readonly kind = 'pglite' as const;
  readonly #db: PgliteLike;
  #chain: Promise<unknown> = Promise.resolve();
  readonly #als: AsyncLocalStorage<SqlExecutor>;
  readonly #root: SqlExecutor;

  constructor(db: PgliteLike, als: AsyncLocalStorage<SqlExecutor>) {
    this.#db = db;
    this.#als = als;
    this.#root = new PgliteExecutor(db);
  }

  query<R = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<SqlQueryResult<R>> {
    const active = this.#als.getStore();
    if (active) return active.query<R>(sql, params);
    // Serialize with transactions so a non-transactional query never interleaves inside another tx.
    const run = this.#chain.then(() => this.#root.query<R>(sql, params));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const active = this.#als.getStore();
    if (active) return fn(active);
    const run = this.#chain.then(() =>
      this.#db.transaction(async (tx) => {
        const exec = new PgliteExecutor(tx);
        return this.#als.run(exec, () => fn(exec));
      }),
    );
    this.#chain = run.catch(() => undefined);
    return run as Promise<T>;
  }

  async exec(sql: string): Promise<void> {
    await this.#db.exec(sql);
  }

  async close(): Promise<void> {
    await this.#chain.catch(() => undefined);
    await this.#db.close();
  }
}

export async function createRawPglite(options: { dataDir?: string; extensions?: Array<'vector'> }): Promise<PgliteLike & { clone(): Promise<unknown> }> {
  const extensions: Record<string, unknown> = {};
  if (options.extensions?.includes('vector')) {
    const mod = (await import('@electric-sql/pglite-pgvector')) as { vector: unknown };
    extensions['vector'] = mod.vector;
  }
  const createOptions: Record<string, unknown> = { extensions };
  if (options.dataDir) createOptions['dataDir'] = options.dataDir;
  const db = (await PGlite.create(createOptions as never)) as unknown as PgliteLike & { clone(): Promise<unknown> };
  if (options.extensions?.includes('vector')) await db.exec('CREATE EXTENSION IF NOT EXISTS vector');
  return db;
}

export function wrapPglite(raw: unknown): PgliteDatabase {
  return new PgliteDatabase(raw as PgliteLike, new AsyncLocalStorage<SqlExecutor>());
}

export async function openPglite(options: { dataDir?: string; extensions?: Array<'vector'> }): Promise<PgliteDatabase> {
  return wrapPglite(await createRawPglite(options));
}
