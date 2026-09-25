import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  intersectPatterns, matchesGlob, matchesPattern, matchesResourcePattern, matchesToolPattern, resourcePatternCovers, toolPatternCovers,
} from '../src/index.ts';
import { prng } from './helpers.ts';

test('tool patterns: exact, prefix glob and *', () => {
  assert.equal(matchesToolPattern('fs.read', 'fs.read'), true);
  assert.equal(matchesToolPattern('fs.read', 'fs.readdir'), false);
  assert.equal(matchesToolPattern('git.*', 'git.diff'), true);
  assert.equal(matchesToolPattern('git.*', 'git'), false);
  assert.equal(matchesToolPattern('git.*', 'gitx.diff'), false);
  assert.equal(matchesToolPattern('oracle.approve*', 'oracle.approve_change'), true);
  assert.equal(matchesToolPattern('oracle.approve*', 'oracle.propose'), false);
  assert.equal(matchesToolPattern('*', 'anything.at.all'), true);
});

test('resource patterns: * is exactly one segment, ** zero or more', () => {
  assert.equal(matchesResourcePattern('workspace/*', 'workspace/wt_1'), true);
  assert.equal(matchesResourcePattern('workspace/*', 'workspace/wt_1/a.ts'), false);
  assert.equal(matchesResourcePattern('workspace/*', 'workspace'), false);
  assert.equal(matchesResourcePattern('workspace/**', 'workspace'), true);
  assert.equal(matchesResourcePattern('workspace/**', 'workspace/wt_1/src/a.ts'), true);
  assert.equal(matchesResourcePattern('workspace/**', 'workspaces/wt_1'), false);
  assert.equal(matchesResourcePattern('workspace/*/src/**', 'workspace/wt_1/src/a/b.ts'), true);
  assert.equal(matchesResourcePattern('workspace/*/src/**', 'workspace/wt_1/test/a.ts'), false);
  assert.equal(matchesResourcePattern('**/secrets/*', 'env/staging/secrets/db'), true);
  assert.equal(matchesResourcePattern('**', ''), true);
  assert.equal(matchesResourcePattern('env/staging', 'env/staging'), true);
  assert.equal(matchesResourcePattern('env/staging', 'env/production'), false);
});

test('matchesPattern infers the kind and honours an explicit kind', () => {
  assert.equal(matchesPattern('git.*', 'git.diff'), true);
  assert.equal(matchesPattern('workspace/**', 'workspace/wt_1/x'), true);
  // '*' as a resource pattern does not cross segments; as a tool pattern it matches everything
  assert.equal(matchesPattern('*', 'env/staging'), false);
  assert.equal(matchesPattern('*', 'env/staging', 'tool'), true);
  assert.equal(matchesPattern('git.*', 'git.diff', 'resource'), false);
});

test('tool coverage is sound and handles globs', () => {
  assert.equal(toolPatternCovers('*', 'fs.read'), true);
  assert.equal(toolPatternCovers('fs.*', 'fs.read'), true);
  assert.equal(toolPatternCovers('fs.*', 'fs.re*'), true);
  assert.equal(toolPatternCovers('fs.re*', 'fs.*'), false);
  assert.equal(toolPatternCovers('fs.read', 'fs.*'), false);
  assert.equal(toolPatternCovers('fs.read', '*'), false);
  assert.equal(toolPatternCovers('git.*', 'fs.read'), false);
});

test('resource coverage is sound for literal, * and ** segments', () => {
  assert.equal(resourcePatternCovers('**', 'workspace/**'), true);
  assert.equal(resourcePatternCovers('workspace/**', 'workspace/*/src/**'), true);
  assert.equal(resourcePatternCovers('workspace/*/**', 'workspace/**'), false); // outer needs ≥1 segment
  assert.equal(resourcePatternCovers('workspace/*', 'workspace/**'), false);
  assert.equal(resourcePatternCovers('workspace/*', 'workspace/wt_1'), true);
  assert.equal(resourcePatternCovers('workspace/wt_1/**', 'workspace/*/a'), false);
  assert.equal(resourcePatternCovers('env/*', 'env/staging'), true);
  assert.equal(resourcePatternCovers('env/staging', 'env/*'), false);
});

test('property: whenever coverage says outer ⊇ inner, every sampled value matched by inner is matched by outer', () => {
  const rnd = prng(0xc0ffee);
  const segs = ['a', 'b', 'c', '*', '**'];
  const vals = ['a', 'b', 'c', 'd'];
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const pattern = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(segs)).join('/');
  const value = () => Array.from({ length: Math.floor(rnd() * 5) }, () => pick(vals)).join('/');
  let covered = 0;
  for (let i = 0; i < 3000; i++) {
    const outer = pattern();
    const inner = pattern();
    if (!resourcePatternCovers(outer, inner)) continue;
    covered++;
    for (let j = 0; j < 40; j++) {
      const v = value();
      if (matchesResourcePattern(inner, v)) assert.equal(matchesResourcePattern(outer, v), true, `${outer} ⊇ ${inner} but ${v}`);
    }
  }
  assert.ok(covered > 100, `property exercised (${covered})`);
});

test('intersectPatterns keeps only patterns covered by both sides', () => {
  assert.deepEqual(intersectPatterns(['fs.read'], ['*'], 'tool'), ['fs.read']);
  assert.deepEqual(intersectPatterns(['*'], ['git.*', 'fs.read'], 'tool'), ['fs.read', 'git.*']);
  assert.deepEqual(intersectPatterns(['fs.*'], ['git.*'], 'tool'), []);
  assert.deepEqual(intersectPatterns(['workspace/**'], ['workspace/wt_1/**', 'env/**'], 'resource'), ['workspace/wt_1/**']);
  assert.deepEqual(intersectPatterns(['workspace/wt_1/**'], ['**'], 'resource'), ['workspace/wt_1/**']);
});

test('file globs used for test path detection', () => {
  assert.equal(matchesGlob('**/*.test.*', 'a.test.ts'), true);
  assert.equal(matchesGlob('**/*.test.*', 'src/deep/a.test.tsx'), true);
  assert.equal(matchesGlob('**/*.test.*', 'src/atest.ts'), false);
  assert.equal(matchesGlob('**/tests/**', 'tests/unit/x.py'), true);
  assert.equal(matchesGlob('**/tests/**', 'pkg/tests/x.py'), true);
  assert.equal(matchesGlob('**/tests/**', 'pkg/testsuite/x.py'), false);
  assert.equal(matchesGlob('**/test_*.py', 'test_api.py'), true);
  assert.equal(matchesGlob('**/*_test.go', 'internal/x/handler_test.go'), true);
  assert.equal(matchesGlob('**/conftest.py', 'conftest.py'), true);
});
