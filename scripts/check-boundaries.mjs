#!/usr/bin/env node
// Enforces the Hypertest package dependency DAG and third-party containment.
//
// Rules (see docs/architecture/BLUEPRINT.md §3):
//   1. A package's src/ may import only the @hypertest packages listed in ALLOWED[pkg].
//   2. Imports of another package must go through its root ("@hypertest/x"), never "@hypertest/x/src/...".
//   3. Relative imports must stay inside the importing package.
//   4. Selected third-party SDKs are confined to the package that adapts them (CONTAINED).
//   5. Every @hypertest import used in src/ must be declared in that package's package.json dependencies.
//   6. Tests may additionally import @hypertest/store and @hypertest/testkit and any declared devDependency.
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, dirname, sep } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');

export const ALLOWED = {
  core: [],
  domain: ['core'],
  store: ['core'],
  testkit: ['core', 'domain', 'store'],
  evidence: ['core', 'domain'],
  operation: ['core', 'domain'],
  collab: ['core', 'domain'],
  policy: ['core', 'domain'],
  model: ['core', 'domain'],
  context: ['core', 'domain', 'collab', 'evidence'],
  tools: ['core', 'domain', 'evidence', 'operation', 'policy'],
  runtime: ['core', 'domain', 'model', 'context', 'tools', 'policy'],
  'runtime-pi': ['core', 'domain', 'model', 'runtime'],
  'runtime-dsh': ['core', 'domain', 'model', 'runtime'],
  agents: ['core', 'domain'],
  control: ['core', 'domain', 'collab', 'operation', 'policy', 'evidence', 'model', 'context', 'tools', 'runtime', 'agents'],
  durable: ['core', 'domain', 'control'],
  app: ['core', 'domain', 'store', 'collab', 'operation', 'policy', 'evidence', 'model', 'context', 'tools', 'runtime', 'runtime-pi', 'runtime-dsh', 'agents', 'control', 'durable'],
  eval: ['core', 'domain', 'store', 'model', 'evidence', 'collab', 'operation', 'policy', 'control', 'app', 'agents', 'tools', 'runtime'],
  cli: ['core', 'domain', 'app', 'eval', 'evidence', 'store'],
};

// third-party module prefix -> packages allowed to import it
export const CONTAINED = [
  { prefix: '@earendil-works/pi-agent-core', allowed: ['runtime-pi'] },
  { prefix: '@earendil-works/pi-ai', allowed: ['runtime-pi', 'model'] },
  { prefix: '@deepseek-ai/', allowed: ['runtime-dsh'] },
  { prefix: '@temporalio/', allowed: ['durable'] },
  { prefix: '@nats-io/', allowed: ['collab'] },
  { prefix: 'pg', exact: true, allowed: ['store'] },
  { prefix: '@electric-sql/', allowed: ['store'] },
  { prefix: '@aws-sdk/', allowed: ['evidence'] },
  { prefix: 'playwright', allowed: ['tools'] },
  { prefix: 'playwright-core', allowed: ['tools'] },
  { prefix: '@modelcontextprotocol/', allowed: ['tools'] },
  { prefix: 'ajv', allowed: ['core'] },
  { prefix: 'yaml', exact: true, allowed: ['app', 'policy', 'cli', 'eval'] },
];

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;(=])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;])import\s*['"]([^'"]+)['"]/gm;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

export function checkBoundaries() {
  const errors = [];
  if (!existsSync(PACKAGES_DIR)) return errors;
  const pkgs = readdirSync(PACKAGES_DIR).filter((d) => existsSync(join(PACKAGES_DIR, d, 'package.json')));
  for (const pkg of pkgs) {
    if (!(pkg in ALLOWED)) {
      errors.push(`packages/${pkg}: not registered in scripts/check-boundaries.mjs ALLOWED (add it with its allowed dependencies)`);
      continue;
    }
    const pkgDir = join(PACKAGES_DIR, pkg);
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    if (manifest.name !== `@hypertest/${pkg}`) errors.push(`packages/${pkg}/package.json: name must be @hypertest/${pkg}`);
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const declaredDev = new Set(Object.keys(manifest.devDependencies ?? {}));
    for (const area of ['src', 'test']) {
      for (const file of walk(join(pkgDir, area))) {
        const rel = relative(ROOT, file);
        const src = stripComments(readFileSync(file, 'utf8'));
        for (const m of src.matchAll(IMPORT_RE)) {
          const spec = m[1] ?? m[2] ?? m[3];
          if (!spec) continue;
          if (spec.startsWith('.')) {
            const target = resolve(dirname(file), spec);
            if (!target.startsWith(pkgDir + sep)) errors.push(`${rel}: relative import escapes package: ${spec}`);
            if (/\.js$/.test(spec) && area === 'src') errors.push(`${rel}: import TypeScript sources with the .ts extension: ${spec}`);
            continue;
          }
          if (spec.startsWith('@hypertest/')) {
            const [, name, ...rest] = spec.split('/');
            if (rest.length > 0) errors.push(`${rel}: deep import into @hypertest/${name}; import the package root instead`);
            if (name === pkg) { errors.push(`${rel}: package imports itself via @hypertest/${name}; use a relative import`); continue; }
            const allowed = new Set(ALLOWED[pkg]);
            if (area === 'test') { allowed.add('store'); allowed.add('testkit'); }
            const okByDev = area === 'test' && declaredDev.has(`@hypertest/${name}`);
            if (!allowed.has(name) && !okByDev) errors.push(`${rel}: @hypertest/${pkg} may not depend on @hypertest/${name}`);
            if (area === 'src' && !declared.has(`@hypertest/${name}`)) errors.push(`${rel}: @hypertest/${name} is not declared in packages/${pkg}/package.json dependencies`);
            continue;
          }
          if (spec.startsWith('node:')) continue;
          for (const rule of CONTAINED) {
            const hit = rule.exact ? (spec === rule.prefix || spec.startsWith(rule.prefix + '/')) : spec.startsWith(rule.prefix);
            if (hit && !rule.allowed.includes(pkg)) errors.push(`${rel}: ${spec} is confined to ${rule.allowed.map((p) => '@hypertest/' + p).join(', ')}`);
          }
        }
      }
    }
  }
  return errors;
}

/** True when this module is the process entry point (robust to symlinked checkouts and paths with spaces). */
function isMainModule() {
  const argv1 = process.argv[1];
  if (typeof argv1 !== 'string' || argv1 === '') return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(argv1));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const errors = checkBoundaries();
  if (errors.length) {
    console.error(`Boundary check failed (${errors.length}):`);
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('Boundary check passed.');
}
