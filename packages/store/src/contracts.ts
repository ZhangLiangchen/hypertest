import type { Migration, SqlDatabase } from '@hypertest/core';

/**
 * @hypertest/store — SqlDatabase implementations and the migrator.
 *
 * Implementations to export from src/index.ts:
 *   openDatabase(options: DatabaseOptions): Promise<SqlDatabase>
 *   migrate(db: SqlDatabase, migrations: readonly Migration[]): Promise<MigrationReport>
 *   createTestDatabase(options?: TestDatabaseOptions): Promise<TestDatabase>
 *
 * Semantics:
 *  - PGlite: `dataDir` omitted ⇒ in-memory; otherwise persisted to the directory. Transactions are
 *    serialized (single connection); nested `transaction()` calls reuse the outer transaction.
 *  - Postgres: node-postgres Pool; `transaction()` checks out one client, BEGIN/COMMIT/ROLLBACK;
 *    bigint (int8) columns are returned as JS numbers via a type parser; json/jsonb parsed.
 *  - `schema` (postgres only) sets search_path so tests can isolate in a fresh schema.
 *  - migrate(): creates `ht_migrations(id text primary key, checksum text, applied_at timestamptz)`,
 *    applies pending migrations sorted by id, each in its own transaction, and fails if an applied
 *    migration's checksum changed (integrity_violation). Concurrent migrators are serialized with
 *    pg_advisory_xact_lock.
 */
export type DatabaseOptions =
  | { kind: 'pglite'; dataDir?: string; extensions?: Array<'vector'> }
  | { kind: 'postgres'; url: string; schema?: string; maxConnections?: number };

export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

export interface TestDatabaseOptions {
  /** Defaults to env HYPERTEST_TEST_DB ('pglite' | 'postgres'); postgres requires HYPERTEST_TEST_PG_URL. */
  kind?: 'pglite' | 'postgres';
  migrations?: readonly Migration[];
  extensions?: Array<'vector'>;
}

export interface TestDatabase {
  db: SqlDatabase;
  /** Drops the schema (postgres) / closes (pglite). */
  dispose(): Promise<void>;
}
