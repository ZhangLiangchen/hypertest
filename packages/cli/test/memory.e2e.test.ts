/**
 * (B[4]) `hypertest memory serve`: the L4 durable-memory service in the foreground — its own storage, the HTTP API
 * PowerContextClient speaks, a bearer token from the environment; refusals before anything is opened.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { cli, type CliResult } from './helpers.ts';

function serve(argv: string[], options: { cwd: string; env: Record<string, string | undefined> }): { ready: Promise<{ url: string; dataDir: string; authenticated: boolean }>; stop(): Promise<CliResult> } {
  const ctrl = new AbortController();
  let resolveReady!: (s: { url: string; dataDir: string; authenticated: boolean }) => void;
  const ready = new Promise<{ url: string; dataDir: string; authenticated: boolean }>((resolve) => {
    resolveReady = resolve;
  });
  let out = '';
  const done = cli(['memory', 'serve', '--json', '--port', '0', ...argv], {
    ...options,
    signal: ctrl.signal,
    onStdout: (text) => {
      out += text;
      try {
        resolveReady(JSON.parse(out) as { url: string; dataDir: string; authenticated: boolean });
      } catch {
        // not complete yet
      }
    },
  });
  return {
    ready: Promise.race([ready, done.then((r) => Promise.reject(new Error(`memory serve exited ${r.code}: ${r.stderr}`)))]),
    stop: async () => {
      ctrl.abort();
      return done;
    },
  };
}

describe('hypertest memory serve', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => {
    dir = await tempDir('ht-cli-memory-');
  });
  after(async () => dir?.cleanup());

  test('serves the memory API over its own storage with the token from the environment', async () => {
    const token = 'memory-token-0123456789abcdef';
    const s = serve(['--data-dir', join(dir.path, 'mem'), '--api-key-env', 'HT_TEST_MEMORY_TOKEN'], { cwd: dir.path, env: { HT_TEST_MEMORY_TOKEN: token } });
    try {
      const served = await s.ready;
      assert.deepEqual([served.dataDir, served.authenticated], [join(dir.path, 'mem'), true]);
      assert.equal((await fetch(`${served.url}/v1/experiences`)).status, 401);
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const proposed = await fetch(`${served.url}/v1/experiences`, { method: 'POST', headers, body: JSON.stringify({ scope: {}, kind: 'lesson', content: 'c', sourceRunId: 'r', evidenceRefs: [], createdBy: 'agent:a' }) });
      assert.equal(proposed.status, 201);
      const item = (await proposed.json()) as { experienceId: string; status: string };
      assert.equal(item.status, 'candidate');
      const self = await fetch(`${served.url}/v1/experiences/${item.experienceId}/review`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve', reviewer: 'agent:a' }) });
      assert.equal(self.status, 403);
      assert.match(((await self.json()) as { error: { code: string } }).error.code, /permission_denied/);
      const listed = (await (await fetch(`${served.url}/v1/experiences?status=candidate`, { headers })).json()) as { items: Array<{ experienceId: string }> };
      assert.deepEqual(listed.items.map((i) => i.experienceId), [item.experienceId]);
    } finally {
      const r = await s.stop();
      assert.equal(r.code, 0, r.stderr);
    }
  });

  test('refusals', async () => {
    const signal = new AbortController().signal;
    const noKey = await cli(['memory', 'serve', '--host', '0.0.0.0', '--data-dir', join(dir.path, 'x')], { cwd: dir.path, env: { HYPERTEST_MEMORY_API_KEY: undefined }, signal });
    assert.equal(noKey.code, 1);
    assert.match(noKey.stderr, /refusing to serve the memory service on non-loopback host 0\.0\.0\.0 without an API key/);
    const unset = await cli(['memory', 'serve', '--api-key-env', 'HT_NO_SUCH_MEMORY_TOKEN', '--data-dir', join(dir.path, 'x')], { cwd: dir.path, env: {}, signal });
    assert.match(unset.stderr, /--api-key-env HT_NO_SUCH_MEMORY_TOKEN: the variable is not set/);
    const short = await cli(['memory', 'serve', '--data-dir', join(dir.path, 'x')], { cwd: dir.path, env: { HYPERTEST_MEMORY_API_KEY: 'short' }, signal });
    assert.match(short.stderr, /the memory service API key must be at least 16 characters/);
    assert.match((await cli(['memory', 'start'], { cwd: dir.path, signal })).stderr, /unknown sub-command "start" \(memory serve\)/);
    assert.match((await cli(['memory', 'serve'], { cwd: dir.path, env: { HYPERTEST_CONFIG: undefined }, signal })).stderr, /no hypertest\.config\.yaml found/);
  });
});
