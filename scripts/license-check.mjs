#!/usr/bin/env node
// License policy check over package-lock.json (technology-selection §许可证策略: "license scanner"; "the main project is MIT,
// but plugins/models/drivers/SDKs may not share its terms").
//
//   node scripts/license-check.mjs [--lockfile package-lock.json] [--exceptions scripts/license-exceptions.json]
//                                  [--allow ID,ID…] [--omit dev] [--json]
//
// Every installed package's `license` (an SPDX expression) must be satisfiable from the allowlist: `A OR B` needs one
// allowed branch, `A AND B` needs both, `A WITH exception` is judged by A. Unknown (missing, unparseable, UNLICENSED,
// "SEE LICENSE IN …") and copyleft/non-allowlisted licenses FAIL unless a committed exception names the package and the
// recorded license expression it was reviewed for (mandatory: a later relicensing is reviewed again; optionally the exact
// version) with a rationale. Ambiguous spellings ("BSD", "Public Domain") are never mapped onto an allowed license. Stale
// exceptions are reported as warnings.
// Exit code: 0 ok, 1 violations, 2 usage / unreadable input.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Licenses allowed without an exception (permissive; CC-BY-4.0 for data such as caniuse-lite; Python-2.0 for argparse). */
export const DEFAULT_ALLOWED = Object.freeze([
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0', 'CC-BY-4.0',
]);

/** Copyleft (reciprocal) and non-commercial license families: never allowed by default. */
const COPYLEFT_RE = /^(A|L)?GPL-|^MPL-|^EPL-|^EUPL-|^CDDL-|^OSL-|^SSPL|^CC-BY-SA-|^CC-BY-NC|^CPAL-|^RPL-|^Sleepycat$|^Artistic-1\.0|^CECILL|^MS-RL$|^Watcom|^QPL-/;

/**
 * Common non-SPDX spellings found in package metadata → SPDX ids. Only UNAMBIGUOUS spellings: a bare "BSD" (2-, 3- or the
 * 4-clause advertising license?) or "Public Domain" (no license id at all) must be reviewed, never assumed permissive.
 */
const ALIASES = Object.freeze({
  'Apache 2.0': 'Apache-2.0', 'Apache License 2.0': 'Apache-2.0', 'Apache2': 'Apache-2.0', 'MIT/X11': 'MIT', 'CC0': 'CC0-1.0',
});

/**
 * Parses an SPDX license expression into a tree: {type: 'license', id, exception?} | {type: 'and'|'or', left, right}.
 * OR binds weaker than AND; parentheses group; `+` suffixes are kept in the id. Returns null when unparseable.
 */
export function parseSpdx(expression) {
  if (typeof expression !== 'string' || expression.trim() === '') return null;
  const tokens = expression.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  function primary() {
    const t = next();
    if (t === undefined) throw new Error('unexpected end');
    if (t === '(') {
      const inner = or();
      if (next() !== ')') throw new Error('missing )');
      return inner;
    }
    if (/^(AND|OR|WITH|\))$/i.test(t)) throw new Error(`unexpected ${t}`);
    if (!/^[A-Za-z0-9.+:-]+$/.test(t)) throw new Error(`bad license id ${t}`);
    const node = { type: 'license', id: t };
    if (peek()?.toUpperCase() === 'WITH') {
      next();
      const exception = next();
      if (exception === undefined || /^(AND|OR|WITH|\(|\))$/i.test(exception)) throw new Error('missing exception');
      node.exception = exception;
    }
    return node;
  }
  function and() {
    let left = primary();
    while (peek()?.toUpperCase() === 'AND') {
      next();
      left = { type: 'and', left, right: primary() };
    }
    return left;
  }
  function or() {
    let left = and();
    while (peek()?.toUpperCase() === 'OR') {
      next();
      left = { type: 'or', left, right: and() };
    }
    return left;
  }
  try {
    const tree = or();
    return i === tokens.length ? tree : null;
  } catch {
    return null;
  }
}

/** The license expression of a lockfile / package.json entry (`license` string or object, legacy `licenses` array ⇒ OR). */
export function licenseExpression(entry) {
  const one = (v) => (typeof v === 'string' ? v.trim() : v && typeof v === 'object' && typeof v.type === 'string' ? v.type.trim() : undefined);
  const l = one(entry?.license);
  if (l) return ALIASES[l] ?? l;
  if (Array.isArray(entry?.licenses)) {
    const ids = entry.licenses.map(one).filter(Boolean).map((x) => ALIASES[x] ?? x);
    if (ids.length > 0) return ids.length === 1 ? ids[0] : `(${ids.join(' OR ')})`;
  }
  return undefined;
}

function ids(tree) {
  return tree.type === 'license' ? [tree.id] : [...ids(tree.left), ...ids(tree.right)];
}

/**
 * Judges an expression against the allowlist: `allowed` (satisfiable), `copyleft` (not satisfiable and a copyleft id
 * is involved), `denied` (not satisfiable: licenses outside the allowlist) or `unknown` (missing or unparseable).
 */
export function evaluateLicense(expression, allowed = DEFAULT_ALLOWED) {
  const allow = new Set(allowed);
  if (expression === undefined || /^UNLICENSED$/i.test(expression) || /^SEE LICEN[CS]E IN /i.test(expression)) return { status: 'unknown', ids: [] };
  const tree = parseSpdx(expression);
  if (!tree) return { status: 'unknown', ids: [] };
  const ok = (t) => (t.type === 'license' ? allow.has(t.id) : t.type === 'and' ? ok(t.left) && ok(t.right) : ok(t.left) || ok(t.right));
  const all = ids(tree);
  if (ok(tree)) return { status: 'allowed', ids: all };
  return { status: all.some((id) => !allow.has(id) && COPYLEFT_RE.test(id)) ? 'copyleft' : 'denied', ids: all };
}

/** The package name of a lockfile path (`node_modules/@scope/a/node_modules/b` → `b`). */
export function packageNameFromPath(path) {
  const i = path.lastIndexOf('node_modules/');
  return i < 0 ? undefined : path.slice(i + 'node_modules/'.length);
}

/**
 * Installed third-party packages of a lockfile v2/v3 (`packages`): the root, workspace members and links are skipped;
 * `omitDev` drops dev-only packages. Each: {name, version, path, license, dev, optional}.
 */
export function lockPackages(lock, options = {}) {
  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') throw new Error('not a lockfile v2/v3 (no "packages")');
  const out = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || entry.link === true || !path.includes('node_modules/')) continue;
    if (options.omitDev && entry.dev === true) continue;
    out.push({ name: entry.name ?? packageNameFromPath(path), version: entry.version ?? '0.0.0', path, license: licenseExpression(entry), dev: entry.dev === true, optional: entry.optional === true });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.path.localeCompare(b.path));
}

/**
 * Validates an exceptions document: `{ exceptions: [{ package, license, version?, rationale, approvedBy? }] }`. A rationale
 * is mandatory (why the license is acceptable, where it is used), and so is `license`: it pins the recorded expression
 * that was reviewed (`UNKNOWN` for a package without one), so that a later license change — e.g. a relicensing to a
 * copyleft license — is a violation again instead of being waved through by the old review.
 */
export function validateExceptions(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.exceptions)) throw new Error('the exceptions file must be {"exceptions": [...]}');
  return doc.exceptions.map((e, i) => {
    if (!e || typeof e !== 'object') throw new Error(`exceptions[${i}] must be an object`);
    if (typeof e.package !== 'string' || e.package.trim() === '') throw new Error(`exceptions[${i}].package must name a package`);
    if (typeof e.rationale !== 'string' || e.rationale.trim().length < 20) throw new Error(`exceptions[${i}] (${e.package}): a rationale of at least 20 characters is required`);
    if (typeof e.license !== 'string' || e.license.trim() === '') {
      throw new Error(`exceptions[${i}] (${e.package}): license must pin the reviewed license expression (UNKNOWN for a package without one); an unpinned exception would accept any later license`);
    }
    for (const k of ['version', 'license', 'approvedBy']) if (e[k] !== undefined && (typeof e[k] !== 'string' || e[k].trim() === '')) throw new Error(`exceptions[${i}].${k} must be a non-empty string`);
    return e;
  });
}

function matches(exception, pkg) {
  if (exception.package !== pkg.name) return false;
  if (exception.version !== undefined && exception.version !== '*' && exception.version !== pkg.version) return false;
  // fail closed: an exception applies only to the exact license expression it was reviewed for
  return typeof exception.license === 'string' && exception.license === (pkg.license ?? 'UNKNOWN');
}

/** Applies the policy: violations (not allowed, not excepted), excepted packages, unused exceptions, counts per license. */
export function checkLicenses(packages, options = {}) {
  const allowed = options.allowed ?? DEFAULT_ALLOWED;
  const exceptions = options.exceptions ?? [];
  const used = new Set();
  const violations = [];
  const excepted = [];
  const counts = {};
  for (const pkg of packages) {
    const key = pkg.license ?? 'UNKNOWN';
    counts[key] = (counts[key] ?? 0) + 1;
    const verdict = evaluateLicense(pkg.license, allowed);
    if (verdict.status === 'allowed') continue;
    const e = exceptions.find((x) => matches(x, pkg));
    if (e) {
      used.add(e);
      excepted.push({ ...pkg, status: verdict.status, rationale: e.rationale });
      continue;
    }
    violations.push({ ...pkg, status: verdict.status });
  }
  return { checked: packages.length, violations, excepted, unusedExceptions: exceptions.filter((e) => !used.has(e)), counts };
}

function parseArgs(argv) {
  const o = { lockfile: join(ROOT, 'package-lock.json'), exceptions: join(ROOT, 'scripts', 'license-exceptions.json'), allowed: [...DEFAULT_ALLOWED], omitDev: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--lockfile') o.lockfile = resolve(value());
    else if (a === '--exceptions') o.exceptions = resolve(value());
    else if (a === '--allow') o.allowed = value().split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--omit') {
      const v = value();
      if (v !== 'dev') throw new Error('--omit supports only dev');
      o.omitDev = true;
    } else if (a === '--omit=dev') o.omitDev = true;
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

export function main(argv = process.argv.slice(2), io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let o;
  let lock;
  let exceptions;
  try {
    o = parseArgs(argv);
    lock = JSON.parse(readFileSync(o.lockfile, 'utf8'));
    exceptions = validateExceptions(JSON.parse(readFileSync(o.exceptions, 'utf8')));
  } catch (e) {
    io.err(`license-check: ${e.message}\n`);
    return 2;
  }
  let packages;
  try {
    packages = lockPackages(lock, { omitDev: o.omitDev });
  } catch (e) {
    io.err(`license-check: ${o.lockfile}: ${e.message}\n`);
    return 2;
  }
  const r = checkLicenses(packages, { allowed: o.allowed, exceptions });
  if (o.json) io.out(`${JSON.stringify({ ok: r.violations.length === 0, ...r, unusedExceptions: r.unusedExceptions.map((e) => e.package) }, null, 2)}\n`);
  else {
    const counts = Object.entries(r.counts).sort(([, a], [, b]) => b - a).map(([l, n]) => `${l} ${n}`).join(', ');
    io.out(`license-check: ${r.checked} package(s)${o.omitDev ? ' (dev omitted)' : ''}: ${counts}\n`);
    for (const e of r.excepted) io.out(`  excepted  ${e.name}@${e.version} (${e.license ?? 'UNKNOWN'}, ${e.status}): ${e.rationale}\n`);
    for (const e of r.unusedExceptions) io.out(`  warning   exception for ${e.package}${e.version ? `@${e.version}` : ''} matches no installed package (remove it)\n`);
    for (const v of r.violations) io.out(`  VIOLATION ${v.name}@${v.version} ${v.license ?? 'UNKNOWN'} (${v.status}) at ${v.path}\n`);
    io.out(r.violations.length === 0 ? 'license-check: ok\n' : `license-check: ${r.violations.length} violation(s): add an allowlisted alternative or a reviewed exception with a rationale to ${o.exceptions}\n`);
  }
  return r.violations.length === 0 ? 0 : 1;
}

/**
 * Whether the module at `moduleUrl` is the script node was started with (`node scripts/x.mjs`). Compares REAL paths:
 * a symlinked checkout (e.g. macOS /tmp → /private/tmp) or a path with spaces (URL-escaped in import.meta.url) must still
 * run the check — a string comparison of `file://${argv[1]}` silently skipped it and exited 0.
 */
export function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== 'string' || argv1 === '') return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(argv1));
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) process.exit(main());
