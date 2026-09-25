import { HypertestError, sha256Hex, type Migration, type SqlDatabase } from '@hypertest/core';
import type { MigrationReport } from './contracts.ts';

const LOCK_KEY = 72_021_977;

export async function migrate(db: SqlDatabase, migrations: readonly Migration[]): Promise<MigrationReport> {
  const ids = new Set<string>();
  for (const m of migrations) {
    if (ids.has(m.id)) throw new HypertestError('invalid_argument', `duplicate migration id ${m.id}`);
    ids.add(m.id);
  }
  const sorted = [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await db.query(`CREATE TABLE IF NOT EXISTS ht_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const report: MigrationReport = { applied: [], skipped: [] };
  for (const m of sorted) {
    const checksum = sha256Hex(m.sql);
    await db.transaction(async (tx) => {
      if (db.kind === 'postgres') await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const existing = await tx.query<{ checksum: string }>('SELECT checksum FROM ht_migrations WHERE id = $1', [m.id]);
      const row = existing.rows[0];
      if (row) {
        if (row.checksum !== checksum) throw new HypertestError('integrity_violation', `migration ${m.id} changed after being applied`);
        report.skipped.push(m.id);
        return;
      }
      for (const stmt of splitSql(m.sql)) await tx.query(stmt);
      await tx.query('INSERT INTO ht_migrations (id, checksum) VALUES ($1, $2)', [m.id, checksum]);
      report.applied.push(m.id);
    });
  }
  return report;
}

/** Splits a migration into statements on semicolons outside quotes/dollar-quoted bodies/comments. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let quote: string | null = null;
  let dollarTag: string | null = null;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        cur += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (quote) {
      cur += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          cur += quote;
          i += 2;
          continue;
        }
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl + 1;
      cur += '\n';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        dollarTag = m[0];
        cur += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
