/**
 * (row 248) White-box code intelligence through the governed runtime:
 *  - lsp.definitions / lsp.references / lsp.diagnostics: the TypeScript language service over the workspace project
 *    (type-aware: follows imports, finds every reference), confined to the workspace (paths and symlinks out are refused);
 *  - analysis.run: tsc (in-process), eslint (the workspace's own, run in the sandbox), pyflakes else a Python compile
 *    check, go vet — findings recorded as static-analysis evidence; analyzers that do not apply / cannot run say why;
 *  - db.introspect: the schema of a registered environment's database, read-only through its own client — PostgreSQL via
 *    psql (live, the test server's own throwaway schema; skipped with the reason when no server is configured), sqlite via
 *    python3 (mode=ro), mysql via a FAKE client on PATH (argv and the password channel checked).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinTools, createEnvironmentRegistry, dbIntrospectTool, type ToolSpec, type WorkspaceHandle } from '../src/index.ts';
import { openToolEnv, request, runtimeFor, tempDir, type ToolEnv } from './helpers.ts';

describe('lsp.* and analysis.run', () => {
  let env: ToolEnv;
  let ws: WorkspaceHandle;

  before(async () => {
    env = await openToolEnv();
    ws = await env.workspaces.scratch({ runId: 'run_tools', workItemId: 'wi_lsp' });
    const w = (p: string, text: string) => {
      mkdirSync(join(ws.root, p, '..'), { recursive: true });
      writeFileSync(join(ws.root, p), text);
    };
    w('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, allowImportingTsExtensions: true }, include: ['src'] }));
    w('src/math.ts', 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
    w('src/use.ts', "import { add } from './math.ts';\n\nexport const three = add(1, 2);\nexport const five = add(2, 3);\n");
    w('src/bad.ts', "import { add } from './math.ts';\n\nexport const oops: string = add(1, 2);\n");
    w('scripts/broken.py', 'def f(:\n    pass\n');
    w('scripts/ok.py', 'import os\nprint(os.getcwd())\n');
    w('go.mod', 'module example.com/vet\n\ngo 1.21\n');
    w('main.go', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Printf("%d\\n", "not a number")\n}\n');
    w('eslint.config.mjs', 'export default [];\n');
    symlinkSync('/etc/hostname', join(ws.root, 'src', 'escape.ts'));
  });
  after(async () => {
    await env.dispose();
  });

  const rt = () => runtimeFor(env, builtinTools({ sandbox: env.sandbox, workspaces: env.workspaces }));

  test('lsp.definitions follows the import to the declaration; lsp.references finds every use across files', async () => {
    const def = await rt().execute(request('lsp.definitions', { path: 'src/use.ts', line: 3, symbol: 'add' }, ws));
    assert.equal(def.status, 'success', def.modelText);
    const defs = (def.structured as { definitions: Array<{ path: string; line: number; name: string; kind: string }> }).definitions;
    assert.deepEqual(defs.map((d) => [d.path, d.line, d.name, d.kind]), [['src/math.ts', 1, 'add', 'function']]);
    const refs = await rt().execute(request('lsp.references', { path: 'src/math.ts', line: 1, column: 17 }, ws));
    assert.equal(refs.status, 'success', refs.modelText);
    const list = (refs.structured as { references: Array<{ path: string; line: number; isDefinition: boolean }> }).references;
    assert.deepEqual(list.map((r) => `${r.path}:${r.line}${r.isDefinition ? '*' : ''}`).sort(), ['src/bad.ts:1', 'src/bad.ts:3', 'src/math.ts:1*', 'src/use.ts:1', 'src/use.ts:3', 'src/use.ts:4'].sort());
  });

  test('lsp.diagnostics reports the type error with its position and code', async () => {
    const out = await rt().execute(request('lsp.diagnostics', {}, ws));
    assert.equal(out.status, 'success', out.modelText);
    const s = out.structured as { errors: number; diagnostics: Array<{ path: string; line: number; code: string; message: string }> };
    assert.equal(s.errors, 1, out.modelText);
    assert.deepEqual([s.diagnostics[0]!.path, s.diagnostics[0]!.line, s.diagnostics[0]!.code], ['src/bad.ts', 3, 'TS2322']);
    assert.match(s.diagnostics[0]!.message, /Type 'number' is not assignable to type 'string'/);
  });

  test('lsp confinement: a path outside the workspace and a symlink out of it are refused', async () => {
    const up = await rt().execute(request('lsp.definitions', { path: '../outside.ts', line: 1, column: 1 }, ws));
    assert.deepEqual([up.status, up.error?.code], ['failed', 'permission_denied'], up.modelText);
    assert.match(up.error!.message, /outside the workspace/);
    const link = await rt().execute(request('lsp.definitions', { path: 'src/escape.ts', line: 1, column: 1 }, ws));
    assert.equal(link.error?.code, 'permission_denied', link.modelText);
    assert.match(link.error!.message, /resolves outside the workspace/);
  });

  test('analysis.run: tsc, eslint (configured, not installed), pyflakes→compile check, go vet — findings as static-analysis evidence', async () => {
    const out = await rt().execute(request('analysis.run', {}, ws, { invocationId: 'sess_an:1:x' }));
    assert.equal(out.status, 'success', out.modelText);
    const s = out.structured as { analyzers: Array<{ analyzer: string; status: string; reason?: string; findings: number }>; findings: Array<{ analyzer: string; path: string; line: number; severity: string; rule: string; message: string }> };
    const by = Object.fromEntries(s.analyzers.map((a) => [a.analyzer, a]));
    assert.equal(by['tsc']!.status, 'ran');
    assert.equal(by['eslint']!.status, 'unavailable');
    assert.match(by['eslint']!.reason!, /not installed in the workspace/);
    assert.equal(by['pyflakes']!.status, 'unavailable', 'pyflakes is not installed here: said so, and the compile check runs instead');
    assert.equal(by['compileall']!.status, 'ran');
    assert.deepEqual(s.findings.filter((f) => f.analyzer === 'tsc').map((f) => [f.path, f.line, f.rule]), [['src/bad.ts', 3, 'TS2322']]);
    assert.deepEqual(s.findings.filter((f) => f.analyzer === 'compileall').map((f) => [f.path, f.line, f.severity]), [['scripts/broken.py', 1, 'error']]);
    assert.equal(by['go_vet']!.status, 'ran', JSON.stringify(by['go_vet']));
    {
      const vet = s.findings.filter((f) => f.analyzer === 'go_vet');
      assert.equal(vet.length, 1, JSON.stringify(s.findings));
      assert.match(vet[0]!.message, /Printf format %d has arg "not a number" of wrong type string/);
      assert.equal(vet[0]!.path, 'main.go');
    }
    const ev = (await env.evidence.query({ runId: 'run_tools', evidenceType: 'static-analysis' })).find((e) => e.toolInvocationId === 'sess_an:1:x')!;
    assert.ok(out.evidenceRefs.includes(ev.evidenceId));
    assert.equal((ev.structured as { errorCount: number }).errorCount, s.findings.filter((f) => f.severity === 'error').length);
  });

  test('analysis.run: the workspace eslint runs in the sandbox and its JSON report becomes findings', async () => {
    const ws2 = await env.workspaces.scratch({ runId: 'run_tools', workItemId: 'wi_eslint' });
    mkdirSync(join(ws2.root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(ws2.root, 'eslint.config.mjs'), 'export default [];\n');
    writeFileSync(join(ws2.root, 'app.js'), 'var unused = 1;\n');
    const report = JSON.stringify([{ filePath: join(ws2.root, 'app.js'), messages: [{ ruleId: 'no-unused-vars', severity: 2, message: "'unused' is assigned a value but never used.", line: 1, column: 5 }] }]);
    writeFileSync(join(ws2.root, 'node_modules', '.bin', 'eslint'), `#!/bin/sh\necho "$@" > eslint-args.txt\nprintf '%s' '${report}'\nexit 1\n`);
    chmodSync(join(ws2.root, 'node_modules', '.bin', 'eslint'), 0o755);
    const out = await rt().execute(request('analysis.run', { analyzers: ['eslint'] }, ws2));
    assert.equal(out.status, 'success', out.modelText);
    const s = out.structured as { analyzers: Array<{ status: string; exitCode: number }>; findings: Array<{ path: string; line: number; column: number; severity: string; rule: string }> };
    assert.deepEqual([s.analyzers[0]!.status, s.analyzers[0]!.exitCode], ['ran', 1]);
    assert.deepEqual(s.findings.map((f) => [f.path, f.line, f.column, f.severity, f.rule]), [['app.js', 1, 5, 'error', 'no-unused-vars']]);
    assert.equal(readFileSync(join(ws2.root, 'eslint-args.txt'), 'utf8').trim(), '-f json .');
  });
});

describe('db.introspect', () => {
  let env: ToolEnv;
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let ws: WorkspaceHandle;
  const PG = process.env['HYPERTEST_TEST_PG_URL'];
  const schema = `ht_introspect_${process.pid}`;

  before(async () => {
    env = await openToolEnv();
    dir = await tempDir('ht-dbi-');
    ws = await env.workspaces.scratch({ runId: 'run_tools', workItemId: 'wi_db' });
    execFileSync('python3', ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript('create table customers(id integer primary key, email text not null unique); create table orders(id integer primary key, customer_id integer not null references customers(id), total real check (total >= 0)); create index orders_customer on orders(customer_id);'); c.commit()", join(dir.path, 'shop.db')]);
    if (PG) {
      execFileSync('psql', [PG, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', `drop schema if exists ${schema} cascade; create schema ${schema}; create table ${schema}.accounts(id bigserial primary key, email text not null unique, balance numeric not null default 0 check (balance >= 0)); create table ${schema}.transfers(id bigserial primary key, from_id bigint not null references ${schema}.accounts(id), amount numeric not null); create index transfers_from on ${schema}.transfers(from_id);`]);
    }
    const bin = join(dir.path, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'mysql'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(dir.path, 'mysql-args.txt'))}\necho "pwd=$MYSQL_PWD" > ${JSON.stringify(join(dir.path, 'mysql-env.txt'))}\necho '{"tables":[{"schema":"shop","name":"items","type":"BASE TABLE"}],"columns":[{"schema":"shop","table":"items","name":"id","type":"int","nullable":false,"default":null,"position":1}],"constraints":[{"schema":"shop","table":"items","name":"PRIMARY","type":"primary_key","definition":"PRIMARY KEY"}],"indexes":[]}'\n`);
    chmodSync(join(bin, 'mysql'), 0o755);
    env.environments.register({ environmentId: 'db_sqlite', environmentClass: 'local', generation: 1, database: { kind: 'sqlite', path: join(dir.path, 'shop.db') } });
    env.environments.register({ environmentId: 'db_pg', environmentClass: 'local', generation: 1, database: { kind: 'postgres', urlEnv: 'SHOP_DB_URL', schemas: [schema] } });
    env.environments.register({ environmentId: 'db_mysql', environmentClass: 'local', generation: 1, database: { kind: 'mysql', urlEnv: 'MYSQL_URL' } });
  });
  after(async () => {
    if (PG) execFileSync('psql', [PG, '-X', '-q', '-c', `drop schema if exists ${schema} cascade`]);
    await env.dispose();
    await dir.cleanup();
  });

  const vars = (): Record<string, string | undefined> => ({ SHOP_DB_URL: PG, MYSQL_URL: 'mysql://reader:s3cr3t@db.internal:3307/shop' });
  const rt = (o: Parameters<typeof dbIntrospectTool>[0] = {}) => runtimeFor(env, [dbIntrospectTool({ env: vars(), ...o }) as ToolSpec]);

  test('sqlite (read-only): tables, columns, primary/foreign keys, unique, index — database-snapshot evidence', async () => {
    const out = await rt().execute(request('db.introspect', { environmentId: 'db_sqlite' }, ws, { invocationId: 'sess_db:1:x' }));
    assert.equal(out.status, 'success', out.modelText);
    const tables = (out.structured as { tables: Array<{ name: string; columns: Array<{ name: string; nullable: boolean }>; constraints: Array<{ type: string; definition: string }>; indexes: Array<{ name: string }> }> }).tables;
    assert.deepEqual(tables.map((t) => t.name), ['customers', 'orders']);
    const orders = tables[1]!;
    assert.deepEqual(orders.columns.map((c) => [c.name, c.nullable]), [['id', false], ['customer_id', false], ['total', true]]);
    assert.ok(orders.constraints.some((c) => c.type === 'foreign_key' && c.definition === 'FOREIGN KEY (customer_id) REFERENCES customers(id)'));
    assert.ok(orders.indexes.some((i) => i.name === 'orders_customer'));
    assert.ok(tables[0]!.constraints.some((c) => c.type === 'unique'));
    const ev = (await env.evidence.query({ runId: 'run_tools', evidenceType: 'database-snapshot' })).find((e) => e.toolInvocationId === 'sess_db:1:x')!;
    assert.equal(ev.environment?.environmentId, 'db_sqlite');
  });

  test('postgres (live, read-only psql): the throwaway schema with its constraints and indexes; a schema outside the declared ones is refused', async (t) => {
    if (!PG) return t.skip('HYPERTEST_TEST_PG_URL is not set: no PostgreSQL server for the live introspection');
    const out = await rt().execute(request('db.introspect', { environmentId: 'db_pg' }, ws));
    assert.equal(out.status, 'success', out.modelText);
    const tables = (out.structured as { tables: Array<{ name: string; columns: Array<{ name: string; default: string | null }>; constraints: Array<{ type: string; definition: string }>; indexes: Array<{ name: string }> }> }).tables;
    assert.deepEqual(tables.map((x) => x.name), ['accounts', 'transfers']);
    assert.ok(tables[0]!.constraints.some((c) => c.type === 'check' && /balance >= /.test(c.definition)));
    assert.ok(tables[1]!.constraints.some((c) => c.type === 'foreign_key' && c.definition.includes(`REFERENCES ${schema}.accounts(id)`)));
    assert.ok(tables[1]!.indexes.some((i) => i.name === 'transfers_from'));
    assert.equal(tables[0]!.columns.find((c) => c.name === 'balance')!.default, '0');
    assert.ok(!out.modelText.includes(new URL(PG).password || '\u0000'), 'the connection secret never reaches the model');
    const other = await rt().execute(request('db.introspect', { environmentId: 'db_pg', schema: 'public' }, ws));
    assert.deepEqual([other.status, other.error?.code], ['failed', 'permission_denied']);
  });

  test('mysql: the client gets the password through MYSQL_PWD (never argv); missing variable / client fail with the reason', async () => {
    const out = await rt({ mysql: join(dir.path, 'bin', 'mysql') }).execute(request('db.introspect', { environmentId: 'db_mysql', table: 'items' }, ws));
    assert.equal(out.status, 'success', out.modelText);
    const args = readFileSync(join(dir.path, 'mysql-args.txt'), 'utf8').split('\n');
    assert.deepEqual(args.slice(0, 9), ['--batch', '--raw', '--skip-column-names', '-h', 'db.internal', '-P', '3307', '-u', 'reader']);
    assert.ok(!args.join(' ').includes('s3cr3t'), 'no password on the command line');
    assert.equal(readFileSync(join(dir.path, 'mysql-env.txt'), 'utf8').trim(), 'pwd=s3cr3t');
    assert.ok(!out.modelText.includes('s3cr3t'));
    const unset = await runtimeFor(env, [dbIntrospectTool({ env: {} }) as ToolSpec]).execute(request('db.introspect', { environmentId: 'db_mysql' }, ws));
    assert.deepEqual([unset.status, unset.error?.code], ['failed', 'precondition_failed']);
    const noClient = await rt({ mysql: join(dir.path, 'no-mysql') }).execute(request('db.introspect', { environmentId: 'db_mysql' }, ws));
    assert.deepEqual([noClient.status, noClient.error?.code], ['failed', 'unsupported']);
  });

  test('no database declared ⇒ precondition_failed', async () => {
    env.environments.register({ environmentId: 'no_db', environmentClass: 'local', generation: 1 });
    const out = await rt().execute(request('db.introspect', { environmentId: 'no_db' }, ws));
    assert.deepEqual([out.status, out.error?.code], ['failed', 'precondition_failed']);
    assert.ok(createEnvironmentRegistry);
  });
});
