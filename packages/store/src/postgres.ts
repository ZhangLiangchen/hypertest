import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { HypertestError, type SqlDatabase, type SqlExecutor, type SqlParam, type SqlQueryResult } from '@hypertest/core';

// int8 → number (safe integers by construction: seq, revisions, fencing tokens, byte sizes).
pg.types.setTypeParser(20, (v: string) => Number(v));

function normalizeParams(params: readonly SqlParam[] | undefined): unknown[] | undefined {
  if (!params) return undefined;
  return params.map((p) => (p !== null && typeof p === 'object' && !(p instanceof Date) && !(p instanceof Uint8Array) && !Array.isArray(p) ? JSON.stringify(p) : p));
}

function wrapError(e: unknown, sql: string): HypertestError {
  const err = e as { code?: string; message?: string };
  if (err?.code === '23505') return new HypertestError('conflict', err.message ?? 'unique violation', { cause: e, details: { sql: sql.slice(0, 200) } });
  if (err?.code === '40001' || err?.code === '40P01') return new HypertestError('conflict', err.message ?? 'serialization failure', { cause: e, retryable: true });
  if (err?.code === 'ECONNREFUSED' || err?.code === '57P01') return new HypertestError('unavailable', err.message ?? 'database unavailable', { cause: e });
  return new HypertestError('internal', `sql error: ${err?.message ?? String(e)}`, { cause: e, details: { sql: sql.slice(0, 200), pgCode: err?.code } });
}

class ClientExecutor implements SqlExecutor {
  readonly #client: pg.PoolClient;
  constructor(client: pg.PoolClient) {
    this.#client = client;
  }
  async query<R = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<SqlQueryResult<R>> {
    try {
      const r = await this.#client.query(sql, normalizeParams(params));
      return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
    } catch (e) {
      throw wrapError(e, sql);
    }
  }
}

export class PostgresDatabase implements SqlDatabase {
  readonly kind = 'postgres' as const;
  readonly #pool: pg.Pool;
  readonly #als = new AsyncLocalStorage<SqlExecutor>();
  readonly #schema: string | undefined;

  constructor(pool: pg.Pool, schema?: string) {
    this.#pool = pool;
    this.#schema = schema;
  }

  get schema(): string | undefined {
    return this.#schema;
  }

  async query<R = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<SqlQueryResult<R>> {
    const active = this.#als.getStore();
    if (active) return active.query<R>(sql, params);
    try {
      const r = await this.#pool.query(sql, normalizeParams(params));
      return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
    } catch (e) {
      throw wrapError(e, sql);
    }
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const active = this.#als.getStore();
    if (active) return fn(active);
    const client = await this.#pool.connect();
    const exec = new ClientExecutor(client);
    try {
      await client.query('BEGIN');
      const result = await this.#als.run(exec, () => fn(exec));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export async function openPostgres(options: { url: string; schema?: string; maxConnections?: number }): Promise<PostgresDatabase> {
  const poolConfig: pg.PoolConfig = { connectionString: options.url, max: options.maxConnections ?? 10 };
  if (options.schema) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(options.schema)) throw new HypertestError('invalid_argument', `invalid schema name: ${options.schema}`);
    poolConfig.options = `-c search_path=${options.schema},public`;
  }
  const pool = new pg.Pool(poolConfig);
  pool.on('error', () => undefined);
  if (options.schema) {
    const admin = new pg.Client({ connectionString: options.url });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA IF NOT EXISTS ${options.schema}`);
    } finally {
      await admin.end();
    }
  }
  return new PostgresDatabase(pool, options.schema);
}
