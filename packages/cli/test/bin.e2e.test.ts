/**
 * The real executable (`bin/hypertest.js` → main): the process exit code is the command's (verdict-aware), the
 * process exits on its own after a run (no leaked handles: timers, sockets, database, workers), and SIGINT interrupts
 * a foreground run with 130, leaving it resumable.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HYPERTEST_VERSION } from '@hypertest/app';
import { tempDir } from '@hypertest/testkit';
import { BRAINS, GOAL, cli, parseJson, sumRepo, writeProject, type TestProject } from './helpers.ts';

const BIN = join(import.meta.dirname, '..', '..', '..', 'bin', 'hypertest.js');

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Spawns the executable; `onStderr` may signal it. Rejects when it has not exited within `timeoutMs`. */
function hypertest(args: string[], options: { cwd: string; env: Record<string, string | undefined>; timeoutMs?: number; onStderr?: (text: string, kill: (s: NodeJS.Signals) => void) => void }): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      options.onStderr?.(stderr, (s) => child.kill(s));
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`hypertest ${args.join(' ')} did not exit within ${options.timeoutMs ?? 90_000} ms (leaked handles?)\nstderr:\n${stderr}`));
    }, options.timeoutMs ?? 90_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      // 'exit' may precede the last pipe data: wait for the streams to close
      let open = 2;
      const done = () => {
        if (--open === 0) resolve({ code, signal, stdout, stderr });
      };
      if (child.stdout.readableEnded) done();
      else child.stdout.once('end', done);
      if (child.stderr.readableEnded) done();
      else child.stderr.once('end', done);
    });
  });
}

describe('bin/hypertest.js', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let project: TestProject;

  before(async () => {
    dir = await tempDir('ht-cli-bin-');
    repo = await sumRepo(true);
    project = await writeProject(dir.path);
  });
  after(async () => {
    await project?.dispose();
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('--version and a usage error set the process exit code', async () => {
    const v = await hypertest(['--version'], { cwd: dir.path, env: {} });
    assert.deepEqual([v.code, v.stdout], [0, `${HYPERTEST_VERSION}\n`]);
    const u = await hypertest(['status', '--bogus'], { cwd: dir.path, env: {} });
    assert.equal(u.code, 2);
  });

  test('a run exits with its verdict code (inconclusive ⇒ 5) and the process ends on its own', async () => {
    const r = await hypertest(['run', GOAL, '--repo', repo.path, '--commit', 'HEAD', '--scripted-brains', BRAINS], { cwd: dir.path, env: { ...project.env, HT_CLI_SCENARIO: 'inconclusive' } });
    assert.equal(r.code, 5, r.stderr);
    assert.match(r.stdout, /\nverdict INCONCLUSIVE {2}decision qd_\S+\n/);
  });

  test('SIGINT interrupts a foreground run (exit 130, resumable); resume completes it', async () => {
    const env = { ...project.env, HT_CLI_SCENARIO: 'pass' };
    let sent = false;
    const r = await hypertest(['run', GOAL, '--repo', repo.path, '--commit', 'HEAD', '--scripted-brains', BRAINS], {
      cwd: dir.path,
      env,
      onStderr: (text, kill) => {
        if (!sent && /run run_\S+ started/.test(text)) {
          sent = true;
          kill('SIGINT');
        }
      },
    });
    assert.equal(r.code, 130, r.stderr);
    const runId = /run (run_\S+) started/.exec(r.stderr)![1]!;
    assert.match(r.stderr, new RegExp(`interrupted: run ${runId} is resumable with \`hypertest resume\`\\n$`));
    const resumed = await cli(['resume', '--scripted-brains', BRAINS, '--json', '--timeout-ms', '120000'], { cwd: dir.path, env });
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.deepEqual(parseJson(resumed), { resumed: [runId], outcomes: [{ runId, status: 'completed', verdict: 'pass' }] });
  });
});
