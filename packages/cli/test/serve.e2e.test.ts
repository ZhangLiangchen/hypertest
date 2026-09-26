/**
 * `hypertest serve` over a real instance: the API on a free loopback port until the signal, bearer tokens from the
 * environment only, runs started over the API driven by the serving process, incomplete runs resumed at start, and
 * failure paths (missing token variable, non-loopback host without a token, scripted providers without brains).
 * `hypertest worker` refuses configurations that are not Temporal (the Temporal worker itself: worker.int.test.ts).
 */
import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { TestRun } from '@hypertest/domain';
import { tempDir } from '@hypertest/testkit';
import { BRAINS, GOAL, cli, parseJson, sumRepo, writeProject, type CliResult, type TestProject } from './helpers.ts';

interface Served {
  url: string;
  manifestId: string;
  resumed: string[];
  authenticated: boolean;
}

/** Starts `hypertest serve --json …` and resolves once the server printed its address. */
function serve(argv: string[], options: { cwd: string; env: Record<string, string | undefined> }): { ready: Promise<Served>; stop(): Promise<CliResult> } {
  const ctrl = new AbortController();
  let resolveReady!: (s: Served) => void;
  const ready = new Promise<Served>((resolve) => {
    resolveReady = resolve;
  });
  const done = cli(['serve', '--json', '--port', '0', ...argv], {
    ...options,
    signal: ctrl.signal,
    onStdout: (text) => {
      try {
        resolveReady(JSON.parse(text) as Served);
      } catch {
        // not complete yet
      }
    },
  });
  return {
    ready: Promise.race([ready, done.then((r) => Promise.reject(new Error(`serve exited ${r.code}: ${r.stderr}`)))]),
    stop: async () => {
      ctrl.abort();
      return done;
    },
  };
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('hypertest serve', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let project: TestProject;
  let env: Record<string, string | undefined>;

  before(async () => {
    dir = await tempDir('ht-cli-serve-');
    repo = await sumRepo(true);
    project = await writeProject(dir.path);
    env = { ...project.env, HT_CLI_SCENARIO: 'pass', HYPERTEST_API_TOKEN: undefined };
  });
  after(async () => {
    await project?.dispose();
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('serves the API until the signal (exit 0); a run started over the API is driven by the serving process', async () => {
    const server = serve(['--scripted-brains', BRAINS], { cwd: dir.path, env });
    let runId = '';
    try {
      const s = await server.ready;
      assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.deepEqual([s.resumed, s.authenticated], [[], false]);
      const health = (await (await fetch(`${s.url}/health`)).json()) as { ok: boolean; manifestId: string; durable: string };
      assert.deepEqual(health, { ok: true, manifestId: s.manifestId, durable: 'local' });
      const res = await fetch(`${s.url}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } }) });
      assert.equal(res.status, 202);
      runId = ((await res.json()) as { run: TestRun }).run.runId;
      const finished = await until(async () => {
        const r = ((await (await fetch(`${s.url}/runs/${runId}`)).json()) as { run: TestRun }).run;
        return r.status === 'completed' ? r : undefined;
      }, 90_000);
      assert.equal(finished.runtimeManifestId, s.manifestId);
      // human decisions over the API need a token this server does not have
      const denied = await fetch(`${s.url}/approvals/appr_x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: true, by: 'alice', rationale: 'x' }) });
      assert.equal(denied.status, 403);
      await denied.body?.cancel();
    } finally {
      const r = await server.stop();
      assert.equal(r.code, 0, r.stderr);
    }
    // the server is gone and the store is released: the CLI reads the run's verdict
    const s = parseJson<{ decision: { verdict: string } }>(await cli(['status', runId, '--json'], { cwd: dir.path, env }));
    assert.equal(s.decision.verdict, 'pass');
  });

  test('a bearer token comes from the environment (HYPERTEST_API_TOKEN or --token-env); requests without it are refused', async () => {
    const token = 'serve-test-token-0123456789';
    const server = serve(['--token-env', 'HT_CLI_TOKEN', '--scripted-brains', BRAINS], { cwd: dir.path, env: { ...env, HT_CLI_TOKEN: token } });
    try {
      const s = await server.ready;
      assert.equal(s.authenticated, true);
      const anonymous = await fetch(`${s.url}/health`);
      assert.equal(anonymous.status, 401);
      await anonymous.body?.cancel();
      const authorized = await fetch(`${s.url}/health`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(authorized.status, 200);
      await authorized.body?.cancel();
    } finally {
      assert.equal((await server.stop()).code, 0);
    }
  });

  test('an interrupted run is resumed when the server starts and completes there', async () => {
    const stop = new AbortController();
    const interrupted = await cli(['run', GOAL, '--repo', repo.path, '--commit', 'HEAD', '--scripted-brains', BRAINS], {
      cwd: dir.path, env, signal: stop.signal, onStderr: (t) => (/run run_\S+ started/.test(t) ? stop.abort() : undefined),
    });
    assert.equal(interrupted.code, 130);
    const runId = /run (run_\S+) started/.exec(interrupted.stderr)![1]!;
    const server = serve(['--scripted-brains', BRAINS], { cwd: dir.path, env });
    try {
      const s = await server.ready;
      assert.deepEqual(s.resumed, [runId]);
      await until(async () => {
        const r = ((await (await fetch(`${s.url}/runs/${runId}`)).json()) as { run: TestRun }).run;
        return r.status === 'completed' ? r : undefined;
      }, 90_000);
    } finally {
      assert.equal((await server.stop()).code, 0);
    }
  });

  test('failure paths: a missing token variable, a non-loopback host without a token, a scripted provider without brains', async () => {
    const missing = await cli(['serve', '--token-env', 'HT_CLI_NO_SUCH_TOKEN'], { cwd: dir.path, env, signal: new AbortController().signal });
    assert.deepEqual([missing.code, missing.stderr], [1, 'hypertest serve: --token-env HT_CLI_NO_SUCH_TOKEN: the variable is not set [precondition_failed]\n']);
    const open = await cli(['serve', '--host', '0.0.0.0', '--port', '0', '--scripted-brains', BRAINS], { cwd: dir.path, env, signal: new AbortController().signal });
    assert.equal(open.code, 1);
    assert.equal(open.stderr, 'hypertest serve: refusing to serve the API on non-loopback host 0.0.0.0 without a token (set HYPERTEST_API_TOKEN or --token-env) [invalid_argument]\n');
    const short = await cli(['serve', '--port', '0', '--scripted-brains', BRAINS], { cwd: dir.path, env: { ...env, HYPERTEST_API_TOKEN: 'too-short' }, signal: new AbortController().signal });
    assert.deepEqual([short.code, short.stderr], [1, 'hypertest serve: the API token in HYPERTEST_API_TOKEN must be at least 16 characters [invalid_argument]\n']);
    const stopped = new AbortController();
    stopped.abort();
    const early = await cli(['serve', '--port', '0', '--scripted-brains', BRAINS], { cwd: dir.path, env, signal: stopped.signal });
    assert.deepEqual([early.code, early.stdout, early.stderr], [0, '', 'stopping: interrupted before the server started\n']);
    const noBrains = await cli(['serve', '--port', '0'], { cwd: dir.path, env, signal: new AbortController().signal });
    assert.equal(noBrains.code, 2);
    assert.match(noBrains.stderr, /^hypertest serve: model provider sim is scripted: pass --scripted-brains <module> exporting brains\.sim\n/);
    // every failed start released the store
    assert.equal((await cli(['status'], { cwd: dir.path, env })).code, 0);
  });

  test('a server that cannot listen resumes nothing: the interrupted run is untouched and still resumable', async () => {
    const stop = new AbortController();
    const interrupted = await cli(['run', GOAL, '--repo', repo.path, '--commit', 'HEAD', '--scripted-brains', BRAINS], {
      cwd: dir.path, env, signal: stop.signal, onStderr: (t) => (/run run_\S+ started/.test(t) ? stop.abort() : undefined),
    });
    assert.equal(interrupted.code, 130);
    const runId = /run (run_\S+) started/.exec(interrupted.stderr)![1]!;
    const eventsBefore = (await cli(['events', runId, '--json'], { cwd: dir.path, env })).stdout;
    const statusBefore = parseJson<{ run: TestRun }>(await cli(['status', runId, '--json'], { cwd: dir.path, env })).run;

    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    const port = (busy.address() as AddressInfo).port;
    try {
      const r = await cli(['serve', '--port', String(port), '--scripted-brains', BRAINS], { cwd: dir.path, env, signal: new AbortController().signal });
      assert.equal(r.code, 1);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
    // no run loop was started by the failed server: not one event, the status unchanged
    assert.equal((await cli(['events', runId, '--json'], { cwd: dir.path, env })).stdout, eventsBefore);
    const statusAfter = parseJson<{ run: TestRun }>(await cli(['status', runId, '--json'], { cwd: dir.path, env })).run;
    assert.deepEqual(statusAfter, statusBefore);
    // the run is resumed (and completed) by a server that does start
    const server = serve(['--scripted-brains', BRAINS], { cwd: dir.path, env });
    try {
      const s = await server.ready;
      assert.deepEqual(s.resumed, [runId]);
      await until(async () => {
        const run = ((await (await fetch(`${s.url}/runs/${runId}`)).json()) as { run: TestRun }).run;
        return run.status === 'completed' ? run : undefined;
      }, 90_000);
    } finally {
      assert.equal((await server.stop()).code, 0);
    }
  });

  test('hypertest worker needs durable.kind temporal (exit 1, no worker started)', async () => {
    const r = await cli(['worker', '--scripted-brains', BRAINS], { cwd: dir.path, env, signal: new AbortController().signal });
    assert.equal(r.code, 1);
    assert.equal(r.stderr, 'hypertest worker: `hypertest worker` hosts Temporal activities: the configuration\'s durable.kind is local (set durable: { kind: temporal, address: ..., workerMode: external }) [precondition_failed]\n');
  });
});
