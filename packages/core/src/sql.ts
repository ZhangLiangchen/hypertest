/**
 * Database port. Implementations live in @hypertest/store (PGlite embedded, node-postgres server).
 * SQL must be valid on both PGlite and PostgreSQL 16. Use $1..$n placeholders.
 */
export type SqlParam = string | number | boolean | null | Date | Uint8Array | SqlParam[] | { [k: string]: unknown };

export interface SqlQueryResult<R> {
  rows: R[];
  rowCount: number;
}

export interface SqlExecutor {
  query<R = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<SqlQueryResult<R>>;
}

export interface SqlDatabase extends SqlExecutor {
  readonly kind: 'pglite' | 'postgres';
  /** Runs fn inside a transaction (READ COMMITTED). Nested calls reuse the outer transaction. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A schema migration owned by one package. Ids are `<pkg>/<nnn>-<name>` and sort lexicographically. */
export interface Migration {
  id: string;
  sql: string;
}

/** Converts a PostgreSQL bigint column (string from node-postgres, number/bigint from PGlite) to number. */
export function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') return Number(v);
  if (v === null || v === undefined) return 0;
  throw new TypeError(`cannot convert ${typeof v} to number`);
}

/** Parses a json/jsonb column that may arrive as string or already-parsed value. */
export function fromJsonColumn<T>(v: unknown): T {
  if (typeof v === 'string') return JSON.parse(v) as T;
  return v as T;
}

/** Converts a timestamptz column (Date or string) to ISO string. */
export function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return new Date(v).toISOString();
  throw new TypeError('cannot convert to ISO timestamp');
}
