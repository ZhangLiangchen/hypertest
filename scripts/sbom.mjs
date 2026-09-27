#!/usr/bin/env node
// Software bill of materials (technology-selection §许可证策略: "SBOM"; §关键风险: "lockfile/SBOM/signature/CVE scan").
//
//   node scripts/sbom.mjs [--out .hypertest-sbom.json] [--omit dev] [--lockfile package-lock.json] [--fallback-only]
//
// Uses `npm sbom --sbom-format cyclonedx` (npm ≥ 10.1) and writes its CycloneDX JSON. When npm cannot produce one (an older
// npm, no node_modules, a failing command) the SBOM is built from package-lock.json instead: a CycloneDX 1.5 document with
// one component per installed package (purl, version, license expression, SHA-512 hash from the lockfile integrity,
// resolved URL, required/optional scope) — the lockfile is the provenance record either way. The document names its
// source in metadata.properties (`hypertest:sbom:source` = npm | package-lock.json).
// Exit code: 0 written, 2 usage / unreadable lockfile.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule, licenseExpression, lockPackages, parseSpdx } from './license-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SBOM_FILE = '.hypertest-sbom.json';

/** The package URL of an npm package (`@scope/name` ⇒ `pkg:npm/%40scope/name@version`). */
export function purlFor(name, version) {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

/** A lockfile integrity (`sha512-<base64>`, possibly several) ⇒ CycloneDX hashes (hex). Unknown algorithms are dropped. */
export function integrityHashes(integrity) {
  if (typeof integrity !== 'string') return [];
  const algs = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' };
  return integrity
    .split(/\s+/)
    .map((part) => /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(part))
    .filter(Boolean)
    .map((m) => ({ alg: algs[m[1]], content: Buffer.from(m[2], 'base64').toString('hex') }));
}

/**
 * CycloneDX licenses of an expression: a single SPDX id ⇒ `{license: {id}}`, a compound SPDX expression ⇒ `{expression}`,
 * anything that is not an SPDX expression ("SEE LICENSE IN …") ⇒ `{license: {name}}` (never an invalid `expression`).
 */
export function cyclonedxLicenses(expression) {
  if (!expression) return [];
  const tree = parseSpdx(expression);
  if (!tree) return [{ license: { name: expression } }];
  if (tree.type === 'license' && tree.exception === undefined) return [{ license: { id: tree.id } }];
  return [{ expression }];
}

/** Whether a parsed document is a CycloneDX BOM with a components array. */
export function isCycloneDx(doc) {
  return !!doc && typeof doc === 'object' && doc.bomFormat === 'CycloneDX' && typeof doc.specVersion === 'string' && Array.isArray(doc.components);
}

/**
 * A CycloneDX 1.5 SBOM from a lockfile v2/v3: metadata (root component, tool, timestamp, source) and one library component
 * per installed package (scoped names split into group + name, like npm's own output).
 */
export function lockfileSbom(lock, options = {}) {
  const root = lock.packages?.[''] ?? {};
  const rootName = root.name ?? lock.name ?? 'unknown';
  const rootVersion = root.version ?? lock.version ?? '0.0.0';
  const seen = new Set();
  const components = [];
  for (const pkg of lockPackages(lock, { omitDev: options.omitDev === true })) {
    const ref = `${pkg.name}@${pkg.version}`;
    if (seen.has(ref)) continue; // the same version installed at several paths is one component
    seen.add(ref);
    const entry = lock.packages[pkg.path];
    const slash = pkg.name.startsWith('@') ? pkg.name.indexOf('/') : -1;
    const component = {
      type: 'library',
      'bom-ref': ref,
      ...(slash > 0 ? { group: pkg.name.slice(0, slash), name: pkg.name.slice(slash + 1) } : { name: pkg.name }),
      version: pkg.version,
      scope: pkg.dev || pkg.optional ? 'optional' : 'required',
      purl: purlFor(pkg.name, pkg.version),
      licenses: cyclonedxLicenses(licenseExpression(entry)),
      hashes: integrityHashes(entry.integrity),
      externalReferences: typeof entry.resolved === 'string' ? [{ type: 'distribution', url: entry.resolved }] : [],
      properties: [{ name: 'cdx:npm:package:path', value: pkg.path }, ...(pkg.dev ? [{ name: 'cdx:npm:package:development', value: 'true' }] : [])],
    };
    components.push(component);
  }
  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${options.uuid ?? randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: options.timestamp ?? new Date().toISOString(),
      tools: { components: [{ type: 'application', name: 'hypertest-sbom', version: rootVersion }] },
      component: { type: 'application', 'bom-ref': `${rootName}@${rootVersion}`, name: rootName, version: rootVersion, purl: purlFor(rootName, rootVersion) },
      properties: [{ name: 'hypertest:sbom:source', value: 'package-lock.json' }, ...(options.omitDev ? [{ name: 'hypertest:sbom:omit', value: 'dev' }] : [])],
    },
    components,
  };
}

/** Runs `npm sbom`; the parsed CycloneDX document, or the reason it is unusable. */
export function npmSbom(options = {}, run = spawnSync) {
  const args = ['sbom', '--sbom-format', 'cyclonedx', ...(options.omitDev ? ['--omit', 'dev'] : [])];
  const r = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: options.cwd ?? ROOT, encoding: 'utf8', timeout: 180_000, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { ok: false, reason: `npm sbom could not run: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, reason: `npm sbom exited ${r.status}: ${String(r.stderr ?? '').trim().split('\n').slice(-3).join(' ')}` };
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch (e) {
    return { ok: false, reason: `npm sbom printed no JSON: ${e.message}` };
  }
  if (!isCycloneDx(doc)) return { ok: false, reason: 'npm sbom printed no CycloneDX document' };
  doc.metadata = doc.metadata ?? {};
  doc.metadata.properties = [...(Array.isArray(doc.metadata.properties) ? doc.metadata.properties : []), { name: 'hypertest:sbom:source', value: 'npm' }];
  return { ok: true, doc };
}

function parseArgs(argv) {
  const o = { out: join(ROOT, DEFAULT_SBOM_FILE), lockfile: join(ROOT, 'package-lock.json'), omitDev: false, fallbackOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--out') o.out = resolve(value());
    else if (a === '--lockfile') o.lockfile = resolve(value());
    else if (a === '--omit') {
      if (value() !== 'dev') throw new Error('--omit supports only dev');
      o.omitDev = true;
    } else if (a === '--omit=dev') o.omitDev = true;
    else if (a === '--fallback-only') o.fallbackOnly = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

export function main(argv = process.argv.slice(2), io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, run = spawnSync) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    io.err(`sbom: ${e.message}\n`);
    return 2;
  }
  let doc;
  let source = 'npm';
  const npm = o.fallbackOnly ? { ok: false, reason: '--fallback-only' } : npmSbom({ omitDev: o.omitDev }, run);
  if (npm.ok) doc = npm.doc;
  else {
    source = 'package-lock.json';
    io.err(`sbom: ${npm.reason}; building the SBOM from ${o.lockfile}\n`);
    try {
      doc = lockfileSbom(JSON.parse(readFileSync(o.lockfile, 'utf8')), { omitDev: o.omitDev });
    } catch (e) {
      io.err(`sbom: ${o.lockfile}: ${e.message}\n`);
      return 2;
    }
  }
  writeFileSync(o.out, `${JSON.stringify(doc, null, 2)}\n`);
  io.out(`sbom: ${doc.components.length} component(s) from ${source} → ${o.out}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(main());
