/**
 * (F[12]) Suite versioning (hermetic): the committed suite lock pins the content fingerprint of every built-in suite
 * revision — a suite whose tasks or sources changed under its old revision fails here (bump the revision, record the
 * fingerprint, re-baseline). Plus the fingerprint itself (task definitions, sources, extra sources), the lock problems and
 * the per-trial environment digest.
 *
 * Updating the lock after a deliberate revision bump:
 *   HYPERTEST_UPDATE_SUITE_LOCK=1 node --test packages/eval/test/suite-versions.test.ts
 * (refused while any suite changed without a new revision).
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import * as ev from '../src/index.ts';
import { SUITE_LOCK_PATH, currentSuiteLock, environmentDigestOf, filesDigest, readSuiteLock, renderSuiteLock, suiteFingerprint, suiteLockProblems, type EvalSuite, type SuiteLock } from '../src/index.ts';

/** The built-in suite factories (`<id>Suite`, like the CLI discovers them), by suite id. */
function builtinSuites(): Record<string, () => EvalSuite> {
  const out: Record<string, () => EvalSuite> = {};
  for (const [name, value] of Object.entries(ev)) {
    if (!/^[a-z][A-Za-z0-9]*Suite$/.test(name) || typeof value !== 'function') continue;
    if (/^(run|summarize|sanity|load|create|render)([A-Z]|Suite$)/.test(name)) continue;
    const suite = (value as () => EvalSuite)();
    out[suite.suiteId] = value as () => EvalSuite;
  }
  return out;
}

describe('the suite lock', () => {
  test('every built-in suite revision is pinned to its content (a change under an old revision fails)', () => {
    const now = currentSuiteLock(builtinSuites());
    assert.ok(Object.keys(now.suites).length >= 15, Object.keys(now.suites).join(', '));
    if (process.env['HYPERTEST_UPDATE_SUITE_LOCK'] === '1') {
      let lock: SuiteLock = { suites: {} };
      try {
        lock = readSuiteLock();
      } catch {
        // first lock
      }
      const unbumped = suiteLockProblems(lock, now).filter((p) => /but its revision is still/.test(p));
      assert.deepEqual(unbumped, [], 'bump the revision of every changed suite before updating the lock');
      writeFileSync(SUITE_LOCK_PATH, renderSuiteLock(now));
      return;
    }
    assert.deepEqual(suiteLockProblems(readSuiteLock(), now), []);
  });

  test('changed content under the same revision, a bump without a change, missing and stale entries are reported', () => {
    const now: SuiteLock = { suites: { a: { revision: '1', fingerprint: 'f2' }, b: { revision: '2', fingerprint: 'fb' }, c: { revision: '2', fingerprint: 'fc2' }, d: { revision: '1', fingerprint: 'fd' } } };
    const lock: SuiteLock = { suites: { a: { revision: '1', fingerprint: 'f1' }, b: { revision: '1', fingerprint: 'fb' }, c: { revision: '1', fingerprint: 'fc1' }, gone: { revision: '1', fingerprint: 'x' } } };
    const problems = suiteLockProblems(lock, now);
    assert.equal(problems.length, 5, problems.join('\n'));
    assert.match(problems[0]!, /^suite a changed .* but its revision is still 1: bump the suite revision/);
    assert.match(problems[1]!, /^suite b: revision 1 → 2 without a change of its content/);
    assert.match(problems[2]!, /^suite c: new revision 2 \(was 1\) is not recorded in the lock yet/);
    assert.match(problems[3]!, /^suite d \(revision 1\) is not in the lock/);
    assert.match(problems[4]!, /^the lock names suite gone, which no longer exists/);
  });
});

describe('suite fingerprints', () => {
  test('the fingerprint changes with the revision, a task definition, the task list or the extra sources', () => {
    const base = ev.coreSuite();
    const fp = suiteFingerprint(base);
    assert.match(fp, /^[0-9a-f]{64}$/);
    assert.equal(suiteFingerprint(ev.coreSuite()), fp, 'deterministic');
    assert.notEqual(suiteFingerprint({ ...base, revision: 'core-x' }), fp);
    assert.notEqual(suiteFingerprint({ ...base, tasks: base.tasks.slice(1) }), fp);
    assert.notEqual(suiteFingerprint({ ...base, tasks: [{ ...base.tasks[0]!, expectedVerdict: 'fail' }, ...base.tasks.slice(1)] }), fp, 'a weakened expectation is a different suite');
    assert.notEqual(suiteFingerprint({ ...base, tasks: [{ ...base.tasks[0]!, graders: base.tasks[0]!.graders.slice(1) }, ...base.tasks.slice(1)] }), fp, 'a dropped grader is a different suite');
    assert.notEqual(suiteFingerprint(base, 'extra'), fp);
  });

  test('a suite run records its fingerprint on the result and on every trial', async () => {
    const suite: EvalSuite = { suiteId: 'fp', revision: '1', tasks: [] };
    const r = await ev.runSuite(suite, { arms: [ev.scriptedMultiLlmArm], trials: 1, workDir: '/tmp/unused-fp' });
    assert.equal(r.suiteFingerprint, suiteFingerprint(suite));
  });

  test('the environment digest of a trial: the image digest the task names, else the fixture files, else none', async () => {
    const dir = await tempDir('ht-envdigest-');
    try {
      await mkdir(join(dir.path, 'fx'), { recursive: true });
      await writeFile(join(dir.path, 'fx', 'a.txt'), 'one');
      const files = environmentDigestOf({ fixtureFiles: ['fx'] }, dir.path);
      assert.equal(files, `files:${filesDigest(['fx'], dir.path)}`);
      await writeFile(join(dir.path, 'fx', 'a.txt'), 'two');
      assert.notEqual(environmentDigestOf({ fixtureFiles: ['fx'] }, dir.path), files, 'a changed fixture is a different environment');
      assert.equal(environmentDigestOf({ environmentImageDigest: `sha256:${'a'.repeat(64)}` }), `sha256:${'a'.repeat(64)}`);
      assert.equal(environmentDigestOf({}), undefined);
      assert.throws(() => environmentDigestOf({ environmentImageDigest: 'latest' }), /environmentImageDigest must be sha256:<64 hex>/);
    } finally {
      await dir.cleanup();
    }
  });
});
