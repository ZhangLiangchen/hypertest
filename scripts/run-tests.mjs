#!/usr/bin/env node
// Runs the Hypertest test suites with the Node.js built-in test runner.
//
//   *.test.ts       unit tests: hermetic, no network, no external services
//   *.int.test.ts   integration tests: may use local infra (Postgres, NATS, Temporal, docker);
//                   each test SKIPS with an explicit reason when its infra is unavailable
//   *.e2e.test.ts   end-to-end tests: full Hypertest runs (scripted models) and PoC suites
//
//   scripts/test/*.test.mjs  unit tests of the repository scripts (supply chain: SBOM, license policy);
//                         run with the unit tests, or alone with --package scripts
//
// Usage: node scripts/run-tests.mjs [--unit|--integration|--e2e] [--package <name>] [extra node --test args]
// Infra connection variables are loaded from .infra/env when present (see scripts/infra.mjs).
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const kinds = new Set();
let onlyPackage;
const passthrough = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--unit') kinds.add('unit');
  else if (a === '--integration') kinds.add('integration');
  else if (a === '--e2e') kinds.add('e2e');
  else if (a === '--package') onlyPackage = args[++i];
  else passthrough.push(a);
}
if (kinds.size === 0) { kinds.add('unit'); kinds.add('integration'); kinds.add('e2e'); }

function walk(dir, out = [], suffix = '.test.ts') {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out, suffix);
    else if (name.endsWith(suffix)) out.push(p);
  }
  return out;
}

function kindOf(file) {
  if (file.endsWith('.int.test.ts')) return 'integration';
  if (file.endsWith('.e2e.test.ts')) return 'e2e';
  return 'unit';
}

const pkgsDir = join(ROOT, 'packages');
const pkgs = existsSync(pkgsDir) ? readdirSync(pkgsDir).filter((p) => !onlyPackage || p === onlyPackage) : [];
const scriptTests = kinds.has('unit') && (!onlyPackage || onlyPackage === 'scripts') ? walk(join(ROOT, 'scripts', 'test'), [], '.test.mjs') : [];
const files = [...pkgs.flatMap((p) => walk(join(pkgsDir, p, 'test'))).filter((f) => kinds.has(kindOf(f))), ...scriptTests].sort();
if (files.length === 0) {
  console.log('No test files matched.');
  process.exit(0);
}

const env = { ...process.env };
const infraEnv = join(ROOT, '.infra', 'env');
if (existsSync(infraEnv)) {
  for (const line of readFileSync(infraEnv, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
}

const concurrency = kinds.has('e2e') || kinds.has('integration') ? 2 : 4;
const res = spawnSync(process.execPath, ['--test', `--test-concurrency=${concurrency}`, '--test-reporter=spec', ...passthrough, ...files.map((f) => relative(ROOT, f))], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
