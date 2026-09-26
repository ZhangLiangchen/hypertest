/**
 * security-H1b: a process an agent starts through the LOCAL sandbox (shell.exec's runner) carries HYPERTEST_SANDBOX, so
 * the hypertest CLI it can reach refuses human decisions (`approve`, `oracle decide`) before opening any store — an agent
 * cannot approve its own side effect or oracle change as `human:<name>`.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { FixedClock, MemoryLogger, SequentialIdGenerator } from '@hypertest/core';
import { createLocalSandbox, createWorkspaceManager } from '@hypertest/tools';
import { tempDir } from '@hypertest/testkit';

const BIN = join(import.meta.dirname, '..', '..', '..', 'bin', 'hypertest.js');

test('security-H1b: the hypertest CLI run from inside the local sandbox refuses approve / oracle decide (the sandbox marker is set)', async () => {
  const dir = await tempDir('ht-app-sbx-');
  try {
    const workspaces = createWorkspaceManager({ ids: new SequentialIdGenerator(), clock: new FixedClock('2026-01-01T00:00:00.000Z'), logger: new MemoryLogger(), baseDir: dir.path, defaultSandbox: { kind: 'local', network: 'loopback', envAllowlist: [] } });
    const ws = await workspaces.scratch({ runId: 'run_sbx', workItemId: 'wi_1' });
    const sandbox = createLocalSandbox();
    // the caller even tries to clear the marker: it is set last and cannot be removed
    const run = (args: string[]) => sandbox.run(ws, [process.execPath, BIN, ...args], { timeoutMs: 60_000, signal: new AbortController().signal, env: { HYPERTEST_SANDBOX: '' } });
    const approve = await run(['approve', 'apr_self', '--by', 'mallory', '--reason', 'looks fine to me']);
    assert.notEqual(approve.exitCode, 0);
    assert.match(approve.stderr, /approve is a human decision and cannot be taken from inside a Hypertest sandbox \(HYPERTEST_SANDBOX is set\).*\[permission_denied\]/);
    const decide = await run(['oracle', 'decide', 'ocp_self', '--by', 'mallory', '--reason', 'loosen it']);
    assert.notEqual(decide.exitCode, 0);
    assert.match(decide.stderr, /cannot be taken from inside a Hypertest sandbox/);
  } finally {
    await dir.cleanup();
  }
});
