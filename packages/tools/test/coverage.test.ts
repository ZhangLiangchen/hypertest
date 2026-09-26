import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHypertestError } from '@hypertest/core';
import { detectCoverageFormat, parseCobertura, parseCoverageJson, parseGoCoverProfile, parseJunitCases, parseLcov, parseXml } from '../src/index.ts';

test('coverage.py JSON: summary counts; branches only when measured (never 0 for unmeasured)', () => {
  const withBranches = JSON.stringify({
    meta: { version: '7.4', branch_coverage: true },
    files: {
      'pkg/a.py': { executed_lines: [1, 2, 3], missing_lines: [4], summary: { covered_lines: 3, num_statements: 4, num_branches: 4, covered_branches: 3, missing_branches: 1 }, missing_branches: [[2, 4]] },
      'pkg\\b.py': { executed_lines: [1], missing_lines: [], summary: { covered_lines: 1, num_statements: 1, num_branches: 0, covered_branches: 0 } },
    },
  });
  const m = parseCoverageJson(withBranches);
  assert.equal(m.format, 'coverage.py');
  assert.deepEqual(m.files, [
    { path: 'pkg/a.py', lines: { covered: 3, total: 4 }, branches: { covered: 3, total: 4 } },
    { path: 'pkg/b.py', lines: { covered: 1, total: 1 }, branches: { covered: 0, total: 0 } },
  ]);
  assert.deepEqual(m.totals, { lines: { covered: 4, total: 5 }, branches: { covered: 3, total: 4 } });

  const noBranches = JSON.stringify({ meta: { branch_coverage: false }, files: { 'a.py': { executed_lines: [1, 2], missing_lines: [3], summary: { covered_lines: 2, num_statements: 3, percent_covered: 66.7 } } } });
  const n = parseCoverageJson(noBranches);
  assert.equal(n.files[0]!.branches, 'unknown');
  assert.equal(n.totals.branches, 'unknown');
  // no summary: fall back to the line and branch arrays
  const arrays = parseCoverageJson(JSON.stringify({ files: { 'c.py': { executed_lines: [1, 2, 3], missing_lines: [5], executed_branches: [[1, 2]], missing_branches: [[1, 5], [3, 4]] } } }));
  assert.deepEqual(arrays.files[0], { path: 'c.py', lines: { covered: 3, total: 4 }, branches: { covered: 1, total: 3 } });
  assert.throws(() => parseCoverageJson('{"nofiles":1}'), (e) => isHypertestError(e, 'invalid_argument'));
  assert.throws(() => parseCoverageJson('not json'), (e) => isHypertestError(e, 'invalid_argument'));
});

test('LCOV: LF/LH/BRF/BRH, DA/BRDA fallbacks, unknown branches, merged records', () => {
  const lcov = [
    'TN:', 'SF:src/a.js', 'DA:1,1', 'DA:2,0', 'DA:3,5', 'LF:3', 'LH:2', 'BRDA:1,0,0,1', 'BRDA:1,0,1,-', 'BRF:2', 'BRH:1', 'end_of_record',
    'SF:src/b.js', 'DA:1,1', 'DA:2,1', 'BRDA:2,0,0,0', 'BRDA:2,0,1,3', 'end_of_record',
    'SF:src/c.js', 'DA:1,0', 'end_of_record',
  ].join('\n');
  const m = parseLcov(lcov);
  assert.deepEqual(m.files, [
    { path: 'src/a.js', lines: { covered: 2, total: 3 }, branches: { covered: 1, total: 2 } },
    { path: 'src/b.js', lines: { covered: 2, total: 2 }, branches: { covered: 1, total: 2 } },
    { path: 'src/c.js', lines: { covered: 0, total: 1 }, branches: 'unknown' },
  ]);
  assert.deepEqual(m.totals, { lines: { covered: 4, total: 6 }, branches: 'unknown' }, 'one unknown file makes the branch total unknown');
  const twoOnly = parseLcov(lcov.split('SF:src/c.js')[0]!);
  assert.deepEqual(twoOnly.totals.branches, { covered: 2, total: 4 });
  const merged = parseLcov('SF:x.js\nLF:2\nLH:1\nBRF:0\nBRH:0\nend_of_record\nSF:x.js\nLF:3\nLH:3\nBRF:2\nBRH:2\nend_of_record\n');
  assert.deepEqual(merged.files, [{ path: 'x.js', lines: { covered: 4, total: 5 }, branches: { covered: 2, total: 2 } }]);
});

test('Cobertura: per-file lines and condition coverage; branch-rate="0" without condition data stays unknown', () => {
  const withBranches = `<?xml version="1.0" ?>
<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">
<coverage line-rate="0.75" branch-rate="0.5" lines-covered="3" lines-valid="4" branches-covered="1" branches-valid="2" version="7.4">
  <packages><package name="pkg"><classes>
    <class name="a.py" filename="pkg/a.py" line-rate="0.75" branch-rate="0.5">
      <lines>
        <line number="1" hits="1"/>
        <line number="2" hits="1" branch="true" condition-coverage="50% (1/2)" missing-branches="4"/>
        <line number="3" hits="0"/>
        <line number="4" hits="2"/>
      </lines>
    </class>
    <class name="b.py" filename="pkg/b.py" line-rate="1"><lines><line number="1" hits="1"/></lines></class>
  </classes></package></packages>
</coverage>`;
  const m = parseCobertura(withBranches);
  assert.deepEqual(m.files, [
    { path: 'pkg/a.py', lines: { covered: 3, total: 4 }, branches: { covered: 1, total: 2 } },
    { path: 'pkg/b.py', lines: { covered: 1, total: 1 }, branches: { covered: 0, total: 0 } },
  ]);
  assert.deepEqual(m.totals, { lines: { covered: 4, total: 5 }, branches: { covered: 1, total: 2 } });
  const noBranches = `<coverage line-rate="0.5" branch-rate="0" branches-covered="0" branches-valid="0"><packages><package><classes><class filename="x.py"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></class></classes></package></packages></coverage>`;
  const n = parseCobertura(noBranches);
  assert.deepEqual(n.files, [{ path: 'x.py', lines: { covered: 1, total: 2 }, branches: 'unknown' }]);
  assert.equal(n.totals.branches, 'unknown');
  assert.throws(() => parseCobertura('<report/>'), (e) => isHypertestError(e, 'invalid_argument'));
});

test('Go coverprofile: statement-weighted, duplicate blocks merged, branches unknown', () => {
  const profile = [
    'mode: set',
    'example.com/calc/calc.go:3.24,3.40 1 1',
    'example.com/calc/calc.go:4.24,5.11 2 1',
    'example.com/calc/calc.go:5.11,7.3 3 0',
    'example.com/calc/util.go:1.1,2.2 4 0',
    'example.com/calc/util.go:1.1,2.2 4 1',
    'garbage line',
  ].join('\n');
  const m = parseGoCoverProfile(profile);
  assert.deepEqual(m.files, [
    { path: 'example.com/calc/calc.go', lines: { covered: 3, total: 6 }, branches: 'unknown' },
    { path: 'example.com/calc/util.go', lines: { covered: 4, total: 4 }, branches: 'unknown' },
  ]);
  assert.deepEqual(m.totals, { lines: { covered: 7, total: 10 }, branches: 'unknown' });
  assert.throws(() => parseGoCoverProfile('no mode'), (e) => isHypertestError(e, 'invalid_argument'));
});

test('format detection', () => {
  assert.equal(detectCoverageFormat('mode: count\nx.go:1.1,2.2 1 0'), 'go');
  assert.equal(detectCoverageFormat('  {"files": {}}'), 'coverage.py');
  assert.equal(detectCoverageFormat('<?xml version="1.0"?>\n<coverage line-rate="1">'), 'cobertura');
  assert.equal(detectCoverageFormat('TN:\nSF:a.js\n'), 'lcov');
  assert.equal(detectCoverageFormat('hello'), undefined);
});

test('XML parser: entities, CDATA, comments, quotes with ">", self-closing, stray and missing close tags', () => {
  const doc = parseXml(`﻿<?xml version="1.0"?><!-- c --><!DOCTYPE x [<!ENTITY y "z">]><root a='1' b="x &gt; y &#65;&#x42;" c=bare><item name="a>b"/><![CDATA[<raw & text>]]>t&amp;u&unknown;</stray><open><deep>`);
  const root = doc.children[0]!;
  assert.equal(root.name, 'root');
  assert.deepEqual(root.attrs, { a: '1', b: 'x > y AB', c: 'bare' });
  assert.equal(root.children[0]!.attrs['name'], 'a>b');
  assert.equal(root.text, '<raw & text>t&u&unknown;');
  assert.equal(root.children[1]!.name, 'open');
  assert.equal(root.children[1]!.children[0]!.name, 'deep');
});

test('node:test junit: passing file-level pseudo-cases are not tests (fake green); failing ones are harness errors', () => {
  const xml = `<testsuites>
    <testcase name="empty.test.mjs" time="0.1" classname="test"/>
    <testcase name="real test" time="0.001" classname="test"/>
    <testcase name="crash.test.mjs" time="0.1" classname="test" failure="test failed"><failure type="testCodeFailure" message="test failed">[Error: test failed] { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause: 'test failed', exitCode: 1, signal: null }</failure></testcase>
    <testsuite name="outer"><testsuite name="inner"><testcase name="deep" classname="test"><failure type="cancelledByParent" message="cancelled"/></testcase></testsuite></testsuite>
  </testsuites>`;
  const cases = parseJunitCases(xml, { framework: 'node_test' });
  assert.deepEqual(cases.map((c) => [c.name, c.status]), [['real test', 'passed'], ['crash.test.mjs', 'error'], ['outer > inner > deep', 'error']]);
  assert.deepEqual(parseJunitCases('<testsuites><testcase name="only.test.mjs" classname="test"/></testsuites>', { framework: 'node_test' }), []);
});
