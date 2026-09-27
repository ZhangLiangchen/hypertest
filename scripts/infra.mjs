#!/usr/bin/env node
// Local development infrastructure for Hypertest integration tests and local durable runs.
//
//   node scripts/infra.mjs fetch   download pinned nats-server and temporal CLI into .infra/bin
//   node scripts/infra.mjs up      start PostgreSQL (system binaries), NATS JetStream and the Temporal dev server
//   node scripts/infra.mjs down    stop everything started by `up`
//   node scripts/infra.mjs status  print component status
//
// `up` writes .infra/env with HYPERTEST_TEST_PG_URL, HYPERTEST_TEST_NATS_URL and
// HYPERTEST_TEST_TEMPORAL_ADDRESS. scripts/run-tests.mjs loads it automatically.
// Every component is optional: missing binaries are reported and that component is skipped.
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INFRA = join(ROOT, '.infra');
const BIN = join(INFRA, 'bin');
const NATS_VERSION = '2.11.8';
const PORTS = { pg: 55432, nats: 54222, temporal: 57233, temporalUi: 58233, opa: 58181, minio: 59000, minioConsole: 59001 };
const PG_BIN_CANDIDATES = ['/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/pgsql/bin'];

function log(msg) { console.log(`[infra] ${msg}`); }
function pgBin() {
  for (const d of PG_BIN_CANDIDATES) if (existsSync(join(d, 'pg_ctl'))) return d;
  try { return dirname(execFileSync('which', ['pg_ctl']).toString().trim()); } catch { return undefined; }
}
function isRoot() { return typeof process.getuid === 'function' && process.getuid() === 0; }
function portOpen(port) {
  return new Promise((res) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
}
async function waitPort(port, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await portOpen(port)) return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
function download(url, dest) {
  const r = spawnSync('curl', ['-fsSL', '-o', dest, url], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`download failed: ${url}`);
}

async function fetchBins() {
  mkdirSync(BIN, { recursive: true });
  if (!existsSync(join(BIN, 'nats-server'))) {
    const tgz = join(INFRA, 'nats.tar.gz');
    download(`https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/nats-server-v${NATS_VERSION}-linux-amd64.tar.gz`, tgz);
    execFileSync('tar', ['xzf', tgz, '-C', INFRA]);
    execFileSync('cp', [join(INFRA, `nats-server-v${NATS_VERSION}-linux-amd64`, 'nats-server'), join(BIN, 'nats-server')]);
    rmSync(tgz, { force: true });
    log('nats-server fetched');
  }
  if (!existsSync(join(BIN, 'temporal'))) {
    const tgz = join(INFRA, 'temporal.tar.gz');
    download('https://temporal.download/cli/archive/latest?platform=linux&arch=amd64', tgz);
    execFileSync('tar', ['xzf', tgz, '-C', BIN, 'temporal']);
    chmodSync(join(BIN, 'temporal'), 0o755);
    rmSync(tgz, { force: true });
    log('temporal CLI fetched');
  }
  if (!existsSync(join(BIN, 'opa'))) {
    download('https://openpolicyagent.org/downloads/v1.9.0/opa_linux_amd64_static', join(BIN, 'opa'));
    chmodSync(join(BIN, 'opa'), 0o755);
    log('opa fetched');
  }
  // MinIO no longer publishes server binaries (HTTP 410). S3 tests use HYPERTEST_TEST_S3_ENDPOINT when
  // provided (any S3-compatible server); place a `minio` binary in .infra/bin manually to have `up` start it.
}

async function upOpa() {
  const exe = join(BIN, 'opa');
  if (!existsSync(exe)) { log('opa: binary missing (run `npm run infra:fetch`), skipped'); return undefined; }
  if (!(await portOpen(PORTS.opa))) {
    spawnDetached('opa', exe, ['run', '--server', '--addr', `127.0.0.1:${PORTS.opa}`, '--log-level', 'error']);
    if (!(await waitPort(PORTS.opa))) { log('opa: failed to start'); return undefined; }
  }
  log(`opa: up on ${PORTS.opa}`);
  return `http://127.0.0.1:${PORTS.opa}`;
}

async function upMinio() {
  const exe = join(BIN, 'minio');
  if (!existsSync(exe)) { log('minio: binary missing (run `npm run infra:fetch`), skipped'); return undefined; }
  if (!(await portOpen(PORTS.minio))) {
    mkdirSync(join(INFRA, 'minio'), { recursive: true });
    spawnDetached('minio', exe, ['server', join(INFRA, 'minio'), '--address', `127.0.0.1:${PORTS.minio}`, '--console-address', `127.0.0.1:${PORTS.minioConsole}`], {
      env: { ...process.env, MINIO_ROOT_USER: 'hypertest', MINIO_ROOT_PASSWORD: 'hypertest-dev-only' },
    });
    if (!(await waitPort(PORTS.minio, 60000))) { log('minio: failed to start'); return undefined; }
  }
  log(`minio: up on ${PORTS.minio}`);
  return `http://127.0.0.1:${PORTS.minio}`;
}

function spawnDetached(name, cmd, args, opts = {}) {
  mkdirSync(join(INFRA, 'logs'), { recursive: true });
  const out = openSync(join(INFRA, 'logs', `${name}.log`), 'a');
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', out, out], ...opts });
  child.unref();
  writeFileSync(join(INFRA, `${name}.pid`), String(child.pid));
  return child.pid;
}

async function upPostgres() {
  const bin = pgBin();
  if (!bin) { log('postgres: binaries not found, skipped'); return undefined; }
  const data = join(INFRA, 'pg', 'data');
  const asPg = (args) => {
    if (isRoot()) return spawnSync('su', ['postgres', '-s', '/bin/sh', '-c', args.map((a) => `'${a}'`).join(' ')], { stdio: 'inherit' });
    return spawnSync(args[0], args.slice(1), { stdio: 'inherit' });
  };
  if (!(await portOpen(PORTS.pg))) {
    if (!existsSync(join(data, 'PG_VERSION'))) {
      mkdirSync(data, { recursive: true });
      if (isRoot()) execFileSync('chown', ['-R', 'postgres:postgres', join(INFRA, 'pg')]);
      const r = asPg([join(bin, 'initdb'), '-D', data, '--auth=trust', '-U', 'postgres', '--encoding=UTF8', '--no-locale']);
      if (r.status !== 0) { log('postgres: initdb failed'); return undefined; }
    }
    const r = asPg([join(bin, 'pg_ctl'), '-D', data, '-l', join(INFRA, 'pg', 'server.log'), '-o', `-p ${PORTS.pg} -k /tmp -c listen_addresses=127.0.0.1 -c max_connections=200 -c fsync=on`, '-w', 'start']);
    if (r.status !== 0) { log('postgres: start failed'); return undefined; }
  }
  const psql = join(bin, 'psql');
  spawnSync(psql, ['-h', '127.0.0.1', '-p', String(PORTS.pg), '-U', 'postgres', '-c', 'CREATE DATABASE hypertest'], { stdio: 'ignore' });
  spawnSync(psql, ['-h', '127.0.0.1', '-p', String(PORTS.pg), '-U', 'postgres', '-c', 'CREATE DATABASE hypertest_test'], { stdio: 'ignore' });
  log(`postgres: up on ${PORTS.pg}`);
  return `postgres://postgres@127.0.0.1:${PORTS.pg}/hypertest_test`;
}

async function upNats() {
  const exe = join(BIN, 'nats-server');
  if (!existsSync(exe)) { log('nats: binary missing (run `npm run infra:fetch`), skipped'); return undefined; }
  if (!(await portOpen(PORTS.nats))) {
    mkdirSync(join(INFRA, 'nats'), { recursive: true });
    spawnDetached('nats', exe, ['-js', '-a', '127.0.0.1', '-p', String(PORTS.nats), '-sd', join(INFRA, 'nats')]);
    if (!(await waitPort(PORTS.nats))) { log('nats: failed to start'); return undefined; }
  }
  log(`nats: up on ${PORTS.nats}`);
  return `nats://127.0.0.1:${PORTS.nats}`;
}

async function upTemporal() {
  const exe = join(BIN, 'temporal');
  if (!existsSync(exe)) { log('temporal: binary missing (run `npm run infra:fetch`), skipped'); return undefined; }
  if (!(await portOpen(PORTS.temporal))) {
    mkdirSync(join(INFRA, 'temporal'), { recursive: true });
    spawnDetached('temporal', exe, ['server', 'start-dev', '--ip', '127.0.0.1', '--port', String(PORTS.temporal), '--ui-port', String(PORTS.temporalUi), '--db-filename', join(INFRA, 'temporal', 'dev.db'), '--log-level', 'warn']);
    if (!(await waitPort(PORTS.temporal, 60000))) { log('temporal: failed to start'); return undefined; }
  }
  log(`temporal: up on ${PORTS.temporal}`);
  return `127.0.0.1:${PORTS.temporal}`;
}

async function up() {
  mkdirSync(INFRA, { recursive: true });
  const pg = await upPostgres();
  const nats = await upNats();
  const temporal = await upTemporal();
  const opa = await upOpa();
  const minio = await upMinio();
  const lines = [];
  if (opa) lines.push(`HYPERTEST_TEST_OPA_URL=${opa}`);
  if (minio) lines.push(`HYPERTEST_TEST_S3_ENDPOINT=${minio}`, 'HYPERTEST_TEST_S3_ACCESS_KEY=hypertest', 'HYPERTEST_TEST_S3_SECRET_KEY=hypertest-dev-only');
  if (pg) lines.push(`HYPERTEST_TEST_PG_URL=${pg}`);
  if (nats) lines.push(`HYPERTEST_TEST_NATS_URL=${nats}`);
  if (temporal) lines.push(`HYPERTEST_TEST_TEMPORAL_ADDRESS=${temporal}`);
  lines.push(`HYPERTEST_INFRA_BIN=${BIN}`);
  writeFileSync(join(INFRA, 'env'), lines.join('\n') + '\n');
  log(`wrote ${join(INFRA, 'env')}`);
}

function killPid(name) {
  const f = join(INFRA, `${name}.pid`);
  if (!existsSync(f)) return;
  const pid = Number(readFileSync(f, 'utf8'));
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  rmSync(f, { force: true });
  log(`${name}: stopped`);
}

function down() {
  killPid('nats');
  killPid('temporal');
  killPid('opa');
  killPid('minio');
  const bin = pgBin();
  const data = join(INFRA, 'pg', 'data');
  if (bin && existsSync(join(data, 'PG_VERSION'))) {
    const cmd = [join(bin, 'pg_ctl'), '-D', data, '-m', 'fast', 'stop'];
    if (isRoot()) spawnSync('su', ['postgres', '-s', '/bin/sh', '-c', cmd.map((a) => `'${a}'`).join(' ')], { stdio: 'inherit' });
    else spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  }
  rmSync(join(INFRA, 'env'), { force: true });
}

async function status() {
  for (const [name, port] of Object.entries({ postgres: PORTS.pg, nats: PORTS.nats, temporal: PORTS.temporal, opa: PORTS.opa, minio: PORTS.minio })) {
    log(`${name}: ${(await portOpen(port)) ? 'up' : 'down'} (port ${port})`);
  }
}

const cmd = process.argv[2];
if (cmd === 'fetch') await fetchBins();
else if (cmd === 'up') await up();
else if (cmd === 'down') down();
else if (cmd === 'status') await status();
else { console.error('usage: infra.mjs fetch|up|down|status'); process.exit(2); }
