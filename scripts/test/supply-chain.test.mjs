// Supply-chain scripts (hermetic): SPDX parsing and the license policy (OR/AND/WITH, copyleft, unknown, exceptions with a
// rationale pinned to version and license), lockfile traversal, and the SBOM (purl, integrity hashes, CycloneDX shape,
// npm output validation and the lockfile fallback).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, test } from 'node:test';
import {
  DEFAULT_ALLOWED, checkLicenses, evaluateLicense, isMainModule, licenseExpression, lockPackages, main as licenseMain, packageNameFromPath, parseSpdx, validateExceptions,
} from '../license-check.mjs';
import { cyclonedxLicenses, integrityHashes, isCycloneDx, lockfileSbom, main as sbomMain, npmSbom, purlFor } from '../sbom.mjs';

const dir = mkdtempSync(join(tmpdir(), 'ht-supply-chain-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const LOCK = {
  name: 'demo', version: '1.0.0', lockfileVersion: 3,
  packages: {
    '': { name: 'demo', version: '1.0.0', workspaces: ['packages/*'] },
    'packages/core': { name: '@demo/core', version: '1.0.0' },
    'node_modules/@demo/core': { resolved: 'packages/core', link: true },
    'node_modules/left': { version: '1.2.0', license: 'MIT', integrity: 'sha512-AAAA', resolved: 'https://registry.npmjs.org/left/-/left-1.2.0.tgz' },
    'node_modules/@scope/dual': { version: '2.0.0', license: '(MIT OR GPL-3.0-only)', integrity: 'sha1-AAAA sha512-/w==' },
    'node_modules/gpl-lib': { version: '3.0.0', license: 'GPL-3.0-only' },
    'node_modules/weird': { version: '0.1.0', license: 'WTFPL' },
    'node_modules/nolicense': { version: '4.6.0' },
    'node_modules/devtool': { version: '9.9.9', license: 'LGPL-2.1', dev: true },
    'node_modules/left/node_modules/inner': { version: '0.0.1', licenses: [{ type: 'MIT' }, { type: 'Apache 2.0' }] },
  },
};

describe('SPDX expressions', () => {
  test('parse precedence (AND binds tighter than OR), parentheses, WITH, + suffixes; garbage is null', () => {
    assert.deepEqual(parseSpdx('MIT'), { type: 'license', id: 'MIT' });
    assert.deepEqual(parseSpdx('MIT OR Apache-2.0 AND BSD-3-Clause'), { type: 'or', left: { type: 'license', id: 'MIT' }, right: { type: 'and', left: { type: 'license', id: 'Apache-2.0' }, right: { type: 'license', id: 'BSD-3-Clause' } } });
    assert.deepEqual(parseSpdx('(MIT OR Apache-2.0) AND ISC').type, 'and');
    assert.deepEqual(parseSpdx('GPL-2.0-only WITH Classpath-exception-2.0'), { type: 'license', id: 'GPL-2.0-only', exception: 'Classpath-exception-2.0' });
    assert.equal(parseSpdx('GPL-2.0+')?.id, 'GPL-2.0+');
    for (const bad of ['', 'MIT OR', '(MIT', 'MIT)', 'AND MIT', 'MIT WITH', 'SEE LICENSE IN LICENSE.md', 'a b']) assert.equal(parseSpdx(bad), null, bad);
  });

  test('evaluation: OR needs one allowed branch, AND all; copyleft vs merely not allowlisted; unknown', () => {
    assert.equal(evaluateLicense('(MIT OR GPL-3.0-only)').status, 'allowed');
    assert.equal(evaluateLicense('Apache-2.0 AND MIT').status, 'allowed');
    assert.equal(evaluateLicense('MIT AND GPL-3.0-only').status, 'copyleft');
    assert.equal(evaluateLicense('LGPL-2.1').status, 'copyleft');
    assert.equal(evaluateLicense('MPL-2.0').status, 'copyleft');
    assert.equal(evaluateLicense('GPL-2.0-only WITH Classpath-exception-2.0').status, 'copyleft', 'an exception clause does not make copyleft permissive');
    assert.equal(evaluateLicense('WTFPL').status, 'denied');
    for (const u of [undefined, 'UNLICENSED', 'SEE LICENSE IN LICENSE.md', 'not ( valid']) assert.equal(evaluateLicense(u).status, 'unknown', String(u));
    assert.equal(evaluateLicense('WTFPL', [...DEFAULT_ALLOWED, 'WTFPL']).status, 'allowed', '--allow extends the allowlist');
    for (const id of ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0', 'CC-BY-4.0']) assert.equal(evaluateLicense(id).status, 'allowed', id);
  });

  test('license fields: string, object, legacy array (OR) and common aliases', () => {
    assert.equal(licenseExpression({ license: 'MIT' }), 'MIT');
    assert.equal(licenseExpression({ license: { type: 'ISC' } }), 'ISC');
    assert.equal(licenseExpression({ licenses: [{ type: 'MIT' }, { type: 'Apache 2.0' }] }), '(MIT OR Apache-2.0)');
    assert.equal(licenseExpression({ license: 'Apache 2.0' }), 'Apache-2.0');
    assert.equal(licenseExpression({}), undefined);
  });

  test('ambiguous spellings are never mapped onto an allowed license: "BSD" (which clause set?) and "Public Domain" need a review', () => {
    // "BSD" may be the 4-clause (advertising) license; "Public Domain" is not a license id at all
    assert.equal(evaluateLicense(licenseExpression({ license: 'BSD' })).status, 'denied');
    assert.equal(evaluateLicense(licenseExpression({ license: 'Public Domain' })).status, 'unknown');
    assert.equal(evaluateLicense(licenseExpression({ licenses: [{ type: 'BSD' }] })).status, 'denied');
  });
});

describe('the lockfile and the policy', () => {
  test('lockPackages skips the root, workspaces and links; names nested paths; --omit dev', () => {
    const all = lockPackages(LOCK);
    assert.deepEqual(all.map((p) => `${p.name}@${p.version}`), ['@scope/dual@2.0.0', 'devtool@9.9.9', 'gpl-lib@3.0.0', 'inner@0.0.1', 'left@1.2.0', 'nolicense@4.6.0', 'weird@0.1.0']);
    assert.equal(lockPackages(LOCK, { omitDev: true }).some((p) => p.name === 'devtool'), false);
    assert.equal(packageNameFromPath('node_modules/@a/b/node_modules/@c/d'), '@c/d');
    assert.throws(() => lockPackages({ lockfileVersion: 1, dependencies: {} }), /not a lockfile v2\/v3/);
  });

  test('violations: copyleft, not allowlisted and unknown fail unless an exception with a rationale pins name, version and license', () => {
    const r = checkLicenses(lockPackages(LOCK));
    assert.deepEqual(r.violations.map((v) => `${v.name}:${v.status}`), ['devtool:copyleft', 'gpl-lib:copyleft', 'nolicense:unknown', 'weird:denied']);
    const exceptions = validateExceptions({
      exceptions: [
        { package: 'nolicense', version: '4.6.0', license: 'UNKNOWN', rationale: 'LICENSE file is the Unlicense; reviewed by the maintainers' },
        { package: 'weird', version: '9.9.9', license: 'WTFPL', rationale: 'reviewed for another version only, must not apply' },
        { package: 'gone', license: 'MIT', rationale: 'a package that is no longer installed at all here' },
      ],
    });
    const r2 = checkLicenses(lockPackages(LOCK, { omitDev: true }), { exceptions });
    assert.deepEqual(r2.violations.map((v) => v.name), ['gpl-lib', 'weird']);
    assert.deepEqual(r2.excepted.map((e) => e.name), ['nolicense']);
    assert.deepEqual(r2.unusedExceptions.map((e) => e.package), ['weird', 'gone']);
    // a license change after the review is reviewed again
    const changed = { ...LOCK, packages: { ...LOCK.packages, 'node_modules/nolicense': { version: '4.6.0', license: 'SSPL-1.0' } } };
    assert.deepEqual(checkLicenses(lockPackages(changed, { omitDev: true }), { exceptions }).violations.map((v) => `${v.name}:${v.status}`), ['gpl-lib:copyleft', 'nolicense:copyleft', 'weird:denied']);
  });

  test('exceptions need a package and a real rationale', () => {
    assert.throws(() => validateExceptions({ exceptions: [{ package: 'x', rationale: 'ok' }] }), /rationale of at least 20 characters/);
    assert.throws(() => validateExceptions({ exceptions: [{ rationale: 'a long enough rationale text here' }] }), /package must name a package/);
    assert.throws(() => validateExceptions([]), /must be \{"exceptions"/);
    assert.throws(() => validateExceptions({ exceptions: [{ package: 'x', license: 'MIT', rationale: 'a long enough rationale text here', version: '' }] }), /version must be a non-empty string/);
  });

  test('an exception must pin the reviewed license: an unpinned one would silently accept a later copyleft relicensing', () => {
    assert.throws(() => validateExceptions({ exceptions: [{ package: 'x', version: '1.0.0', rationale: 'a long enough rationale text here' }] }), /license must pin the reviewed license expression/);
    assert.throws(() => validateExceptions({ exceptions: [{ package: 'x', license: ' ', rationale: 'a long enough rationale text here' }] }), /license must pin the reviewed license expression/);
    // the CLI refuses such an exceptions file (exit 2) instead of applying it
    const lockfile = join(dir, 'unpinned-lock.json');
    const exceptions = join(dir, 'unpinned-exceptions.json');
    writeFileSync(lockfile, JSON.stringify(LOCK));
    writeFileSync(exceptions, JSON.stringify({ exceptions: [{ package: 'gpl-lib', rationale: 'reviewed once, for whatever license it has' }] }));
    const out = [];
    assert.equal(licenseMain(['--lockfile', lockfile, '--exceptions', exceptions], { out: (s) => out.push(s), err: (s) => out.push(s) }), 2);
    assert.match(out.join(''), /exceptions\[0\] \(gpl-lib\): license must pin/);
  });

  test('the CLI: exit 1 with the violations, 0 once excepted, 2 on unreadable input; --json', () => {
    const lockfile = join(dir, 'lock.json');
    const exceptions = join(dir, 'exceptions.json');
    writeFileSync(lockfile, JSON.stringify(LOCK));
    writeFileSync(exceptions, JSON.stringify({ exceptions: [] }));
    const out = [];
    const io = { out: (s) => out.push(s), err: (s) => out.push(s) };
    assert.equal(licenseMain(['--lockfile', lockfile, '--exceptions', exceptions], io), 1);
    assert.match(out.join(''), /VIOLATION gpl-lib@3\.0\.0 GPL-3\.0-only \(copyleft\)/);
    out.length = 0;
    assert.equal(licenseMain(['--lockfile', lockfile, '--exceptions', exceptions, '--json', '--allow', 'MIT,GPL-3.0-only,WTFPL,LGPL-2.1'], io), 1);
    assert.deepEqual(JSON.parse(out.join('')).violations.map((v) => v.name), ['nolicense']);
    assert.equal(licenseMain(['--lockfile', join(dir, 'missing.json'), '--exceptions', exceptions], io), 2);
    assert.equal(licenseMain(['--bogus'], io), 2);
  });

  test('the repository itself passes its license policy (with its committed exceptions)', () => {
    const out = [];
    assert.equal(licenseMain([], { out: (s) => out.push(s), err: (s) => out.push(s) }), 0, out.join(''));
  });
});

describe('running the scripts as programs', () => {
  const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..');

  test('isMainModule compares real paths: a symlinked checkout or an escaped path is still the main module', () => {
    const real = join(scriptsDir, 'license-check.mjs');
    assert.equal(isMainModule(pathToFileURL(real).href, real), true);
    const alias = join(dir, 'alias dir');
    symlinkSync(scriptsDir, alias, 'dir');
    assert.equal(isMainModule(pathToFileURL(real).href, join(alias, 'license-check.mjs')), true);
    assert.equal(isMainModule(pathToFileURL(real).href, join(scriptsDir, 'sbom.mjs')), false);
    assert.equal(isMainModule(pathToFileURL(real).href, undefined), false);
    assert.equal(isMainModule(pathToFileURL(real).href, join(dir, 'missing.mjs')), false);
  });

  test('started through a symlink or a path with spaces, both scripts still run (never a silent exit 0 that skips the check)', () => {
    for (const name of ['link', 'with space']) {
      const alias = join(dir, name);
      symlinkSync(scriptsDir, alias, 'dir');
      const missing = join(dir, 'missing-lock.json');
      const license = spawnSync(process.execPath, [join(alias, 'license-check.mjs'), '--lockfile', missing], { encoding: 'utf8' });
      assert.equal(license.status, 2, `license-check via ${name}: ${license.stdout}${license.stderr}`);
      assert.match(license.stderr, /license-check: .*missing-lock\.json/);
      const sbom = spawnSync(process.execPath, [join(alias, 'sbom.mjs'), '--fallback-only', '--lockfile', missing, '--out', join(dir, `${name}.json`)], { encoding: 'utf8' });
      assert.equal(sbom.status, 2, `sbom via ${name}: ${sbom.stdout}${sbom.stderr}`);
      assert.match(sbom.stderr, /sbom: .*missing-lock\.json/);
    }
  });
});

describe('SBOM', () => {
  test('purl, integrity hashes (hex), licenses as ids or expressions', () => {
    assert.equal(purlFor('@scope/name', '1.0.0'), 'pkg:npm/%40scope/name@1.0.0');
    assert.equal(purlFor('left', '1.2.0'), 'pkg:npm/left@1.2.0');
    assert.deepEqual(integrityHashes('sha1-AAAA sha512-/w== md5-xx'), [{ alg: 'SHA-1', content: '000000' }, { alg: 'SHA-512', content: 'ff' }]);
    assert.deepEqual(integrityHashes(undefined), []);
    assert.deepEqual(cyclonedxLicenses('MIT'), [{ license: { id: 'MIT' } }]);
    assert.deepEqual(cyclonedxLicenses('(MIT OR Apache-2.0)'), [{ expression: '(MIT OR Apache-2.0)' }]);
    assert.deepEqual(cyclonedxLicenses(undefined), []);
    // not an SPDX expression: a named license, never an invalid CycloneDX `expression`
    assert.deepEqual(cyclonedxLicenses('SEE LICENSE IN LICENSE.md'), [{ license: { name: 'SEE LICENSE IN LICENSE.md' } }]);
  });

  test('the lockfile fallback is a CycloneDX 1.5 document: one component per package version, scoped names split, provenance', () => {
    const bom = lockfileSbom(LOCK, { uuid: '00000000-0000-4000-8000-000000000000', timestamp: '2026-01-01T00:00:00.000Z' });
    assert.ok(isCycloneDx(bom));
    assert.deepEqual([bom.specVersion, bom.serialNumber, bom.metadata.component.name, bom.metadata.properties[0]], ['1.5', 'urn:uuid:00000000-0000-4000-8000-000000000000', 'demo', { name: 'hypertest:sbom:source', value: 'package-lock.json' }]);
    assert.equal(bom.components.length, 7);
    const dual = bom.components.find((c) => c['bom-ref'] === '@scope/dual@2.0.0');
    assert.deepEqual([dual.group, dual.name, dual.purl, dual.scope, dual.licenses, dual.hashes.map((h) => h.alg)], ['@scope', 'dual', 'pkg:npm/%40scope/dual@2.0.0', 'required', [{ expression: '(MIT OR GPL-3.0-only)' }], ['SHA-1', 'SHA-512']]);
    const left = bom.components.find((c) => c.name === 'left');
    assert.deepEqual(left.externalReferences, [{ type: 'distribution', url: 'https://registry.npmjs.org/left/-/left-1.2.0.tgz' }]);
    assert.equal(bom.components.find((c) => c.name === 'devtool').scope, 'optional');
    assert.equal(lockfileSbom(LOCK, { omitDev: true }).components.some((c) => c.name === 'devtool'), false);
  });

  test('npm sbom output is used only when it is a CycloneDX document; otherwise the lockfile fallback is written', () => {
    const fake = (status, stdout, error) => () => ({ status, stdout, stderr: 'npm ERR! boom', error });
    assert.equal(npmSbom({}, fake(0, JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [] }))).ok, true);
    assert.match(npmSbom({}, fake(1, '')).reason, /exited 1: npm ERR! boom/);
    assert.match(npmSbom({}, fake(0, 'not json')).reason, /printed no JSON/);
    assert.match(npmSbom({}, fake(0, '{"bomFormat":"SPDX"}')).reason, /no CycloneDX document/);
    assert.match(npmSbom({}, fake(null, '', new Error('ENOENT'))).reason, /could not run: ENOENT/);
    const lockfile = join(dir, 'sbom-lock.json');
    writeFileSync(lockfile, JSON.stringify(LOCK));
    const out = join(dir, 'sbom.json');
    const lines = [];
    assert.equal(sbomMain(['--lockfile', lockfile, '--out', out], { out: (s) => lines.push(s), err: (s) => lines.push(s) }, fake(1, '')), 0);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual([isCycloneDx(doc), doc.metadata.properties[0].value, doc.components.length], [true, 'package-lock.json', 7]);
    assert.match(lines.join(''), /building the SBOM from/);
    const viaNpm = join(dir, 'npm.json');
    assert.equal(sbomMain(['--out', viaNpm], { out: () => undefined, err: () => undefined }, fake(0, JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [{ name: 'x' }] }))), 0);
    assert.deepEqual(JSON.parse(readFileSync(viaNpm, 'utf8')).metadata.properties, [{ name: 'hypertest:sbom:source', value: 'npm' }]);
    assert.equal(sbomMain(['--lockfile', join(dir, 'missing.json'), '--fallback-only', '--out', out], { out: () => undefined, err: () => undefined }), 2);
    assert.equal(sbomMain(['--omit', 'prod'], { out: () => undefined, err: () => undefined }), 2);
  });
});
