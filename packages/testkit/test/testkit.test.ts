import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitRepo, testDeps, eventCtx } from '../src/index.ts';

test('createGitRepo builds history with deletions', async () => {
  const repo = await createGitRepo({ 'a.txt': '1', 'b.txt': 'x' }, [{ message: 'change', files: { 'a.txt': '2', 'b.txt': null } }]);
  try {
    assert.equal(repo.commits.length, 2);
    assert.equal(readFileSync(join(repo.path, 'a.txt'), 'utf8'), '2');
    assert.equal(existsSync(join(repo.path, 'b.txt')), false);
  } finally {
    await repo.cleanup();
  }
});

test('testDeps are deterministic', () => {
  const d = testDeps();
  assert.equal(d.ids.next('run'), 'run_000001');
  assert.equal(d.clock.isoNow(), '2026-01-01T00:00:00.000Z');
  assert.equal(eventCtx('r').correlationId, 'r');
});
