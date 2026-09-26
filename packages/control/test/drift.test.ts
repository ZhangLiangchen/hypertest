/**
 * Post-execution test-change governance (I8) building blocks on REAL worktree diffs: what an execution tool (shell.exec,
 * test.run, …) did to a writable worktree is classified like a patch; product/build outputs are out of scope, test code
 * is governed; a quarantine lifts only when the governed sections are back to their pre-command text.
 */
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { FixedClock, MemoryLogger, SequentialIdGenerator } from '@hypertest/core';
import { createWorkspaceManager, type WorkspaceHandle, type WorkspaceManager } from '@hypertest/tools';
import { tempDir } from '@hypertest/testkit';
import { classifyDrift, diffSections, invertSection, quarantineLifted, sectionPaths, type WorkspaceQuarantine } from '../src/index.ts';
import { PRICING_TEST, pricingRepo } from './fixture.ts';

const WEAKENED = PRICING_TEST.replace('assert.equal(applyDiscount(1000, 10), 900);', 'assert.equal(applyDiscount(1000, 10), 800);');
const NEW_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('regression', () => {\n  assert.equal(1 + 1, 2);\n});\n";

describe('classifyDrift / quarantine on real worktree diffs', () => {
  let repo: Awaited<ReturnType<typeof pricingRepo>>;
  let base: { path: string; cleanup(): Promise<void> };
  let workspaces: WorkspaceManager;
  let ws: WorkspaceHandle;
  let n = 0;

  before(async () => {
    repo = await pricingRepo();
    base = await tempDir('ht-drift-');
    workspaces = createWorkspaceManager({ ids: new SequentialIdGenerator(), clock: new FixedClock('2026-09-01T00:00:00.000Z'), logger: new MemoryLogger(), baseDir: base.path, defaultSandbox: { kind: 'local', network: 'none', envAllowlist: [] } });
  });
  after(async () => {
    await base.cleanup();
    await repo.cleanup();
  });

  async function freshWorktree(): Promise<WorkspaceHandle> {
    n++;
    return workspaces.isolatedWorktree({ runId: 'run_drift', workItemId: `wi_${n}`, repoPath: repo.path, baseCommit: repo.head });
  }

  test('a command that weakens an assertion ⇒ approval_required, quarantined section = the test file with its clean pre-state', async () => {
    ws = await freshWorktree();
    const beforeDiff = await workspaces.diff(ws);
    assert.equal(beforeDiff, '');
    await writeFile(join(ws.root, 'test/pricing.test.js'), WEAKENED);
    const afterDiff = await workspaces.diff(ws);
    const v = classifyDrift(beforeDiff, afterDiff, false);
    assert.equal(v.decision, 'approval_required');
    assert.deepEqual(v.categories, ['assertion']);
    assert.deepEqual(v.paths, ['test/pricing.test.js']);
    assert.deepEqual(Object.values(v.expected), ['']);
    assert.deepEqual(Object.keys(v.expected), ['diff --git a/test/pricing.test.js b/test/pricing.test.js']);
    const q: WorkspaceQuarantine = { toolId: 'shell.exec', invocationId: 'i', categories: v.categories, findings: v.findings, paths: v.paths, expected: v.expected, at: '' };
    assert.equal(quarantineLifted(q, afterDiff), false);
    await writeFile(join(ws.root, 'test/pricing.test.js'), PRICING_TEST);
    const restoredDiff = await workspaces.diff(ws);
    assert.equal(quarantineLifted(q, restoredDiff), true, 'restored exactly ⇒ lifted');
    // the restoring command itself is not a new violation (its inverse would read as "assertion changed" otherwise)
    assert.equal(classifyDrift(afterDiff, restoredDiff, false, q.expected).decision, 'auto_allowed');
    assert.equal(classifyDrift(afterDiff, restoredDiff, false).decision, 'approval_required', 'without the quarantine context the undo is classified');
  });

  test('a command that deletes a test the run had added ⇒ the inverse section is classified: test_deleted, forbidden', async () => {
    ws = await freshWorktree();
    await writeFile(join(ws.root, 'test/regression.test.js'), NEW_TEST);
    const beforeDiff = await workspaces.diff(ws);
    const header = [...diffSections(beforeDiff).keys()][0]!;
    assert.equal(header, 'diff --git a/test/regression.test.js b/test/regression.test.js');
    await rm(join(ws.root, 'test/regression.test.js'));
    const afterDiff = await workspaces.diff(ws);
    const v = classifyDrift(beforeDiff, afterDiff, false);
    assert.equal(v.decision, 'forbidden');
    assert.ok(v.categories.includes('test_deleted'), v.categories.join(','));
    assert.deepEqual(v.expected, { [header]: diffSections(beforeDiff).get(header) });
    const q: WorkspaceQuarantine = { toolId: 'shell.exec', invocationId: 'i', categories: v.categories, findings: v.findings, paths: v.paths, expected: v.expected, at: '' };
    assert.equal(quarantineLifted(q, afterDiff), false);
    await writeFile(join(ws.root, 'test/regression.test.js'), NEW_TEST);
    assert.equal(quarantineLifted(q, await workspaces.diff(ws)), true);
  });

  test('files the base lacks (build outputs, lockfiles) are not classified; tracked product code is; a new test file is conditional', async () => {
    ws = await freshWorktree();
    const beforeDiff = await workspaces.diff(ws);
    await writeFile(join(ws.root, 'package-lock.json'), '{}\n');
    await writeFile(join(ws.root, 'bundle.js'), 'console.log(1);\n');
    const outputs = classifyDrift(beforeDiff, await workspaces.diff(ws), false);
    assert.equal(outputs.decision, 'auto_allowed');
    assert.deepEqual(outputs.expected, {});
    await writeFile(join(ws.root, 'test/extra.test.js'), NEW_TEST);
    const withTest = classifyDrift(beforeDiff, await workspaces.diff(ws), false);
    assert.equal(withTest.decision, 'conditional');
    assert.deepEqual(withTest.conditionalPaths, ['test/extra.test.js']);
    assert.deepEqual(withTest.expected, {});
    // a command "fixing" the product under test: forbidden for a non-fixer, approval for a product fixer
    await writeFile(join(ws.root, 'src/pricing.js'), '// patched\n' + (await readFile(join(ws.root, 'src/pricing.js'), 'utf8')));
    const fixed = await workspaces.diff(ws);
    const byExecutor = classifyDrift(beforeDiff, fixed, false);
    assert.equal(byExecutor.decision, 'forbidden');
    assert.deepEqual(byExecutor.categories, ['product_code', 'test_implementation']);
    assert.deepEqual(byExecutor.paths, ['src/pricing.js']);
    assert.equal(classifyDrift(beforeDiff, fixed, true).decision, 'approval_required');
    assert.equal(classifyDrift(beforeDiff, beforeDiff, false).decision, 'auto_allowed', 'no change, nothing to classify');
  });

  test('invertSection swaps sides exactly (hunk lines that look like headers stay content) and is an involution', () => {
    const section = [
      'diff --git a/test/q.sql b/test/q.sql',
      'index 1111111..2222222 100644',
      '--- a/test/q.sql',
      '+++ b/test/q.sql',
      '@@ -1,3 +1,3 @@ header',
      ' select 1;',
      '--- a comment line that was removed',
      '+++ a comment line that was added',
      ' select 2;',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const inverse = invertSection(section);
    assert.equal(
      inverse,
      [
        'diff --git a/test/q.sql b/test/q.sql',
        'index 2222222..1111111 100644',
        '--- a/test/q.sql',
        '+++ b/test/q.sql',
        '@@ -1,3 +1,3 @@ header',
        ' select 1;',
        '+-- a comment line that was removed',
        '-++ a comment line that was added',
        ' select 2;',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
    assert.equal(invertSection(inverse), section);
    const created = 'diff --git a/test/n.test.js b/test/n.test.js\nnew file mode 100644\nindex 0000000..abcdef1\n--- /dev/null\n+++ b/test/n.test.js\n@@ -0,0 +1 @@\n+x\n';
    assert.equal(invertSection(created), 'diff --git a/test/n.test.js b/test/n.test.js\ndeleted file mode 100644\nindex abcdef1..0000000\n--- a/test/n.test.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n');
    assert.deepEqual(sectionPaths('diff --git a/test/a.js b/test/b.js'), ['test/a.js', 'test/b.js']);
  });
});
