import { HypertestError, type JsonSchema, type JsonValue } from '@hypertest/core';
import type { EnvironmentDescriptor, ToolSpec } from '../contracts.ts';
import { ENV_ID_SCHEMA, requireEnvironment, runCommand } from './common.ts';

/**
 * (wave 3, row 248) `db.introspect` — the schema of a registered environment's SQL database: tables / views, columns
 * (type, nullability, default), constraints (primary / foreign keys, unique, check) and indexes, recorded as
 * `database-snapshot` evidence. READ-ONLY and through the database's own client, never the Hypertest store:
 *  - postgres: `psql` with the connection taken from the variable the operator NAMED (`database.urlEnv`; passed as PG*
 *    variables, never on the command line), a read-only transaction (`default_transaction_read_only=on`) and a statement
 *    timeout; one fixed catalog query (information_schema + pg_catalog);
 *  - sqlite: the file opened with `mode=ro` (python3's sqlite3 module): sqlite_master + table_info / foreign_key_list /
 *    index_list;
 *  - mysql: the `mysql` client (password in MYSQL_PWD) on information_schema.
 * Agents never pass SQL, hosts or credentials: only the environment, an optional schema and table name.
 */

export interface DbIntrospectInput {
  environmentId: string;
  schema?: string;
  table?: string;
  timeoutMs?: number;
}

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  position: number;
}

export interface DbTable {
  schema: string;
  name: string;
  type: string;
  columns: DbColumn[];
  constraints: Array<{ name: string; type: string; definition: string }>;
  indexes: Array<{ name: string; definition: string; unique?: boolean }>;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

function sqlList(names: readonly string[]): string {
  for (const n of names) if (!IDENT_RE.test(n)) throw new HypertestError('invalid_argument', `invalid identifier ${JSON.stringify(n)}`);
  return names.map((n) => `'${n}'`).join(', ');
}

/** The connection URL of the environment's database, from the variable it NAMES (never logged or returned). */
function connectionUrl(env: EnvironmentDescriptor, vars: Record<string, string | undefined>): URL {
  const name = env.database?.urlEnv;
  if (!name) throw new HypertestError('precondition_failed', `environment ${env.environmentId} declares no database.urlEnv`);
  const raw = vars[name];
  if (!raw) throw new HypertestError('precondition_failed', `the variable ${name} (database of environment ${env.environmentId}) is not set`);
  try {
    return new URL(raw);
  } catch {
    throw new HypertestError('precondition_failed', `the variable ${name} does not hold a connection URL`);
  }
}

function postgresQuery(schemas: string[], table: string | undefined): string {
  const inSchemas = sqlList(schemas);
  const tableFilter = table !== undefined ? ` and %T = '${table}'` : '';
  const t = (col: string) => tableFilter.replace('%T', col);
  return `select json_build_object(
  'tables', (select coalesce(json_agg(json_build_object('schema', table_schema, 'name', table_name, 'type', table_type) order by table_schema, table_name), '[]'::json) from information_schema.tables where table_schema in (${inSchemas})${t('table_name')}),
  'columns', (select coalesce(json_agg(json_build_object('schema', table_schema, 'table', table_name, 'name', column_name, 'type', data_type, 'nullable', is_nullable = 'YES', 'default', column_default, 'position', ordinal_position) order by table_schema, table_name, ordinal_position), '[]'::json) from information_schema.columns where table_schema in (${inSchemas})${t('table_name')}),
  'constraints', (select coalesce(json_agg(json_build_object('schema', n.nspname, 'table', c.relname, 'name', con.conname, 'type', case con.contype when 'p' then 'primary_key' when 'f' then 'foreign_key' when 'u' then 'unique' when 'c' then 'check' when 'x' then 'exclusion' else con.contype::text end, 'definition', pg_get_constraintdef(con.oid)) order by n.nspname, c.relname, con.conname), '[]'::json) from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname in (${inSchemas})${t('c.relname')}),
  'indexes', (select coalesce(json_agg(json_build_object('schema', schemaname, 'table', tablename, 'name', indexname, 'definition', indexdef) order by schemaname, tablename, indexname), '[]'::json) from pg_indexes where schemaname in (${inSchemas})${t('tablename')})
)`;
}

const SQLITE_SCRIPT = `
import json, sqlite3, sys
path, table = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None)
con = sqlite3.connect('file:' + path + '?mode=ro', uri=True)
con.execute('PRAGMA query_only = ON')
q = lambda sql, *a: con.execute(sql, a).fetchall()
out = {'tables': [], 'columns': [], 'constraints': [], 'indexes': []}
for name, typ, sql in q("select name, type, sql from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name"):
    if table and name != table: continue
    out['tables'].append({'schema': 'main', 'name': name, 'type': 'VIEW' if typ == 'view' else 'BASE TABLE', 'sql': sql})
    for cid, cname, ctype, notnull, dflt, pk in q('select * from pragma_table_info(?)', name):
        out['columns'].append({'schema': 'main', 'table': name, 'name': cname, 'type': ctype, 'nullable': not notnull and not pk, 'default': dflt, 'position': cid + 1})
        if pk: out['constraints'].append({'schema': 'main', 'table': name, 'name': name + '_pk_' + cname, 'type': 'primary_key', 'definition': 'PRIMARY KEY (' + cname + ')'})
    for row in q('select * from pragma_foreign_key_list(?)', name):
        out['constraints'].append({'schema': 'main', 'table': name, 'name': name + '_fk_' + str(row[0]) + '_' + row[3], 'type': 'foreign_key', 'definition': 'FOREIGN KEY (' + row[3] + ') REFERENCES ' + row[2] + '(' + str(row[4]) + ')'})
    for seq, iname, unique, origin, partial in q('select * from pragma_index_list(?)', name):
        cols = [r[2] for r in q('select * from pragma_index_info(?)', iname)]
        out['indexes'].append({'schema': 'main', 'table': name, 'name': iname, 'definition': ('UNIQUE ' if unique else '') + 'INDEX ' + iname + ' ON ' + name + ' (' + ', '.join(c or '?' for c in cols) + ')', 'unique': bool(unique)})
        if unique and origin == 'u': out['constraints'].append({'schema': 'main', 'table': name, 'name': iname, 'type': 'unique', 'definition': 'UNIQUE (' + ', '.join(c or '?' for c in cols) + ')'})
print(json.dumps(out))
`;

function mysqlQuery(database: string, table: string | undefined): string {
  sqlList([database]);
  const t = (col: string) => (table !== undefined ? ` and ${col} = '${table}'` : '');
  return `select json_object(
  'tables', (select coalesce(json_arrayagg(json_object('schema', table_schema, 'name', table_name, 'type', table_type)), json_array()) from information_schema.tables where table_schema = '${database}'${t('table_name')}),
  'columns', (select coalesce(json_arrayagg(json_object('schema', table_schema, 'table', table_name, 'name', column_name, 'type', column_type, 'nullable', is_nullable = 'YES', 'default', column_default, 'position', ordinal_position)), json_array()) from information_schema.columns where table_schema = '${database}'${t('table_name')}),
  'constraints', (select coalesce(json_arrayagg(json_object('schema', tc.table_schema, 'table', tc.table_name, 'name', tc.constraint_name, 'type', lower(replace(tc.constraint_type, ' ', '_')), 'definition', tc.constraint_type)), json_array()) from information_schema.table_constraints tc where tc.table_schema = '${database}'${t('tc.table_name')}),
  'indexes', (select coalesce(json_arrayagg(json_object('schema', table_schema, 'table', table_name, 'name', index_name, 'definition', concat(index_name, '(', column_name, ')'), 'unique', non_unique = 0)), json_array()) from information_schema.statistics where table_schema = '${database}'${t('table_name')})
)`;
}

type Raw = { tables: Array<{ schema: string; name: string; type: string }>; columns: Array<DbColumn & { schema: string; table: string }>; constraints: Array<{ schema: string; table: string; name: string; type: string; definition: string }>; indexes: Array<{ schema: string; table: string; name: string; definition: string; unique?: boolean }> };

/** Groups the flat catalog rows per table. */
export function groupCatalog(raw: Raw): DbTable[] {
  return raw.tables.map((t) => ({
    schema: t.schema, name: t.name, type: t.type,
    columns: raw.columns.filter((c) => c.schema === t.schema && c.table === t.name).sort((a, b) => a.position - b.position).map((c) => ({ name: c.name, type: c.type, nullable: c.nullable === true, default: c.default ?? null, position: c.position })),
    constraints: raw.constraints.filter((c) => c.schema === t.schema && c.table === t.name).map((c) => ({ name: c.name, type: c.type, definition: c.definition })),
    indexes: raw.indexes.filter((i) => i.schema === t.schema && i.table === t.name).map((i) => ({ name: i.name, definition: i.definition, ...(i.unique !== undefined ? { unique: i.unique } : {}) })),
  }));
}

export function dbIntrospectTool(options: { env?: Record<string, string | undefined>; psql?: string; mysql?: string; python?: string } = {}): ToolSpec<DbIntrospectInput> {
  return {
    id: 'db.introspect',
    title: 'Database schema',
    description:
      'Read the schema of a registered environment\'s SQL database (read-only, through its own client): tables and views, columns, primary/foreign keys, unique and check constraints, indexes — recorded as database-snapshot evidence. Optional schema / table narrow it. No SQL is accepted.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['environmentId'],
      properties: {
        environmentId: ENV_ID_SCHEMA,
        schema: { type: 'string', pattern: IDENT_RE.source },
        table: { type: 'string', pattern: IDENT_RE.source },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 120_000 },
      },
    } as JsonSchema,
    effect: 'read',
    riskClass: 'low',
    resources: (input) => [`env/${input.environmentId}`],
    environmentClass: (input, ctx) => requireEnvironment(ctx.environments, input.environmentId).environmentClass,
    evidenceTypes: ['database-snapshot'],
    timeoutMs: 180_000,
    async execute(input, ctx) {
      try {
        const env = requireEnvironment(ctx.environments, input.environmentId);
        const db = env.database;
        if (!db) throw new HypertestError('precondition_failed', `environment ${env.environmentId} declares no database`);
        const vars = options.env ?? process.env;
        const timeoutMs = input.timeoutMs ?? 60_000;
        let raw: Raw;
        let client: string;
        if (db.kind === 'postgres') {
          const url = connectionUrl(env, vars);
          const schemas = input.schema !== undefined ? [input.schema] : db.schemas && db.schemas.length > 0 ? db.schemas : ['public'];
          if (input.schema !== undefined && db.schemas && db.schemas.length > 0 && !db.schemas.includes(input.schema)) throw new HypertestError('permission_denied', `schema ${input.schema} is not among the schemas of environment ${env.environmentId} (${db.schemas.join(', ')})`);
          const pgEnv: Record<string, string> = {
            PATH: process.env['PATH'] ?? '/usr/bin:/bin',
            PGHOST: decodeURIComponent(url.hostname.replace(/^\[|\]$/g, '')) || 'localhost',
            PGPORT: url.port || '5432',
            PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
            PGOPTIONS: `-c default_transaction_read_only=on -c statement_timeout=${timeoutMs}`,
            PGCONNECT_TIMEOUT: '10',
            PGAPPNAME: 'hypertest-db-introspect',
          };
          if (url.username) pgEnv['PGUSER'] = decodeURIComponent(url.username);
          if (url.password) pgEnv['PGPASSWORD'] = decodeURIComponent(url.password);
          const ssl = url.searchParams.get('sslmode');
          if (ssl) pgEnv['PGSSLMODE'] = ssl;
          client = 'psql (read-only transaction)';
          const r = await runCommand(options.psql ?? 'psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', postgresQuery(schemas, input.table)], { timeoutMs, signal: ctx.signal, env: pgEnv });
          if (r.exitCode !== 0) throw new HypertestError(r.spawnError ? 'unsupported' : 'unavailable', r.spawnError ? `psql is not available on this host: ${r.spawnError}` : `psql failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 500)}`);
          raw = JSON.parse(r.stdout.trim()) as Raw;
        } else if (db.kind === 'sqlite') {
          client = 'python3 sqlite3 (mode=ro)';
          const r = await runCommand(options.python ?? 'python3', ['-I', '-c', SQLITE_SCRIPT, db.path!, input.table ?? ''], { timeoutMs, signal: ctx.signal });
          if (r.exitCode !== 0) throw new HypertestError(r.spawnError ? 'unsupported' : 'unavailable', `sqlite introspection failed: ${(r.spawnError ?? r.stderr).trim().slice(0, 500)}`);
          raw = JSON.parse(r.stdout.trim()) as Raw;
        } else {
          const url = connectionUrl(env, vars);
          const database = input.schema ?? decodeURIComponent(url.pathname.replace(/^\//, ''));
          if (!database) throw new HypertestError('precondition_failed', 'the mysql connection URL names no database');
          const args = ['--batch', '--raw', '--skip-column-names', '-h', url.hostname || 'localhost', '-P', url.port || '3306', ...(url.username ? ['-u', decodeURIComponent(url.username)] : []), '-e', mysqlQuery(database, input.table)];
          client = 'mysql';
          const r = await runCommand(options.mysql ?? 'mysql', args, { timeoutMs, signal: ctx.signal, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...(url.password ? { MYSQL_PWD: decodeURIComponent(url.password) } : {}) } });
          if (r.exitCode !== 0) throw new HypertestError(r.spawnError ? 'unsupported' : 'unavailable', r.spawnError ? `mysql is not available on this host: ${r.spawnError}` : `mysql failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 500)}`);
          raw = JSON.parse(r.stdout.trim()) as Raw;
        }
        const tables = groupCatalog(raw);
        if (input.table !== undefined && tables.length === 0) throw new HypertestError('not_found', `no table ${input.table} in the database of environment ${env.environmentId}`);
        const doc = { kind: db.kind, client, tableCount: tables.length, tables };
        const evidence = await ctx.recordEvidence({
          evidenceType: 'database-snapshot',
          data: JSON.stringify(doc),
          mimeType: 'application/json',
          summary: `schema of the ${db.kind} database of ${env.environmentId}: ${tables.length} table(s)${input.table ? ` (table ${input.table})` : ''}`,
          structured: doc as unknown as JsonValue,
          provenance: { target: `env/${env.environmentId}` },
        });
        const text = tables.map((t) => `${t.schema}.${t.name} (${t.type}): ${t.columns.map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' not null'}`).join(', ')}${t.constraints.length ? `\n  constraints: ${t.constraints.map((c) => `${c.name} ${c.definition}`).join('; ')}` : ''}`).join('\n');
        return { status: 'success', structured: { kind: db.kind, tableCount: tables.length, tables: tables as unknown as JsonValue, evidenceId: evidence.evidenceId }, text: `${text}\n(evidence ${evidence.evidenceId})`, evidenceRefs: [evidence.evidenceId] };
      } catch (e) {
        if (e instanceof HypertestError) return { status: 'failed', error: { code: e.code, message: e.message } };
        if (e instanceof SyntaxError) return { status: 'failed', error: { code: 'unavailable', message: `the database client returned no catalog JSON: ${e.message}` } };
        throw e;
      }
    },
  };
}
