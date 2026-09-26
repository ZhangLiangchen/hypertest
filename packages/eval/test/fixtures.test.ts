/**
 * The PoC systems under test (local processes on loopback, no external infra): the ledger repository seeds exactly the
 * intended regression (its own suite stays green on the candidate, the designed contract test fails on the candidate
 * and passes on the base), the bank API carries the negative-transfer defect with ground-truth effects, kv-service runs
 * under its own supervisor process (restarts idempotent per operation id and persisted; its latency independent of the
 * harness's event loop), and the observation/load-job readers tolerate partial state. Every spawned process is stopped.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { tempDir } from '@hypertest/testkit';
import { FIXTURES_DIR, createLedgerRepo, gitShowFile, isLoadWorker, killLoadWorkers, loadJobs, readObservations, startBankApi, startKvService } from '../src/index.ts';

const exec = promisify(execFile);
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-eval-fixtures-')));
after(async () => root.cleanup());

/** `node --test` in a directory, isolated from this runner (exit code 0 = every test passed). */
async function nodeTest(cwd: string, files: string[] = []): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await exec(process.execPath, ['--test', ...files], { cwd, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } });
    return { code: 0, out: stdout };
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    return { code: typeof err.code === 'number' ? err.code : -1, out: err.stdout ?? '' };
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();
}

describe('ledger repository', () => {
  test('two commits: the candidate hides the regression from its own suite; the designed contract test catches it and passes on the base', async () => {
    const repo = await createLedgerRepo(join(root.path, 'a'));
    assert.match(repo.base, /^[0-9a-f]{40}$/);
    assert.notEqual(repo.base, repo.head);
    assert.equal(await git(repo.path, ['rev-parse', 'HEAD']), repo.head);
    assert.equal(await git(repo.path, ['log', '--format=%s']), 'refactor pagination\ninitial ledger library');
    assert.equal(await git(repo.path, ['diff', '--name-only', repo.base, repo.head]), 'src/ledger.js');
    assert.equal(await git(repo.path, ['status', '--porcelain']), '');
    assert.equal((await nodeTest(repo.path)).code, 0, 'the original suite is green on the candidate');
    copyFileSync(join(FIXTURES_DIR, 'ledger', 'designed', 'paginate-pages.test.js'), join(repo.path, 'tests', 'paginate-pages.test.js'));
    copyFileSync(join(FIXTURES_DIR, 'ledger', 'designed', 'transfer-conservation.test.js'), join(repo.path, 'tests', 'transfer-conservation.test.js'));
    const candidate = await nodeTest(repo.path, ['tests/paginate-pages.test.js', 'tests/transfer-conservation.test.js']);
    assert.equal(candidate.code, 1);
    assert.match(candidate.out, /not ok \d+ - paginate returns every item exactly once across pages/);
    assert.match(candidate.out, /\nok \d+ - transfer conserves the total balance/);
    await git(repo.path, ['checkout', '-q', repo.base, '--', 'src/ledger.js']);
    assert.equal((await nodeTest(repo.path, ['tests/paginate-pages.test.js', 'tests/transfer-conservation.test.js'])).code, 0, 'the designed tests pass on the known-good base');
  });

  test('the oracle-robustness variant: the pagination test is part of the base commit and fails on the candidate; gitShowFile is byte-exact', async () => {
    const repo = await createLedgerRepo(join(root.path, 'b'), { withPaginationTest: true });
    const file = readFileSync(join(repo.path, 'tests', 'pagination.test.js'), 'utf8');
    assert.equal(await gitShowFile(repo.path, repo.base, 'tests/pagination.test.js'), file);
    assert.equal(await gitShowFile(repo.path, repo.head, 'tests/pagination.test.js'), file);
    assert.ok(file.endsWith('\n'));
    const run = await nodeTest(repo.path);
    assert.equal(run.code, 1);
    assert.match(run.out, /not ok \d+ - paginate returns every item exactly once across pages/);
    await assert.rejects(gitShowFile(repo.path, repo.head, 'tests/missing.test.js'));
  });
});

describe('bank API', () => {
  test('the hidden defect: zero is rejected, a negative amount is accepted and moves money backwards; effects are counted per Idempotency-Key', async () => {
    const bank = await startBankApi();
    try {
      const post = async (path: string, body: unknown, key?: string) => {
        const res = await fetch(`${bank.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      const a = await post('/accounts', { owner: 'alice', balance: 100 }, 'k-a');
      const b = await post('/accounts', { owner: 'bob', balance: 50 }, 'k-b');
      assert.deepEqual([a.status, a.body], [201, { id: 'acc-1', owner: 'alice', balance: 100 }]);
      assert.equal((await post('/transfers', { from: 'acc-1', to: 'acc-2', amount: 0 }, 'k-0')).status, 400);
      assert.deepEqual(await post('/transfers', { from: 'acc-1', to: 'acc-2', amount: -30 }, 'k-neg'), { status: 201, body: { transferId: 'tx-1', from: 'acc-1', to: 'acc-2', amount: -30 } });
      assert.deepEqual(await post('/transfers', { from: 'acc-1', to: 'acc-2', amount: -30 }, 'k-neg'), { status: 201, body: { transferId: 'tx-2', from: 'acc-1', to: 'acc-2', amount: -30 } });
      assert.equal(b.status, 201);
      const alice = (await (await fetch(`${bank.url}/accounts/acc-1`)).json()) as { balance: number };
      assert.equal(alice.balance, 160, 'the sender gained money');
      // money is conserved: the defect is invisible to the total
      assert.deepEqual(await bank.health(), { status: 'ok', accounts: 2, total: 150, deposited: 150, balanceConserved: true });
      assert.deepEqual(await bank.effects(), { 'k-a': 1, 'k-b': 1, 'k-0': 1, 'k-neg': 2 });
      assert.equal((await post('/accounts', { owner: '', balance: 1 })).status, 400);
    } finally {
      await bank.close();
    }
    assert.throws(() => process.kill(bank.pid, 0), /ESRCH/, 'the server process is gone');
    await bank.close(); // idempotent
  });
});

describe('kv-service', () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test('under its own supervisor process: kv API, Prometheus metrics, restarts idempotent per operation id and persisted; close stops both processes', async () => {
    const kv = await startKvService({ stateDir: join(root.path, 'kv-1') });
    let servicePid: number | undefined;
    try {
      assert.notEqual(kv.pid, process.pid);
      assert.match(kv.controlUrl, /\/__hypertest#token=[A-Za-z0-9_-]{16,}$/);
      const get = async (path: string) => {
        const res = await fetch(`${kv.url}${path}`);
        return { status: res.status, body: (await res.json()) as unknown };
      };
      assert.deepEqual(await get('/kv/k1'), { status: 200, body: { key: 'k1', value: 'v1' } });
      assert.deepEqual(await get('/kv/nope'), { status: 404, body: { error: 'not_found', key: 'nope' } });
      const put = await fetch(`${kv.url}/kv/k9`, { method: 'PUT', body: 'v9' });
      assert.deepEqual([put.status, await put.json()], [200, { key: 'k9', value: 'v9' }]);
      const metrics = await (await fetch(`${kv.url}/metrics`)).text();
      assert.match(metrics, /kv_requests_total\{method="GET",status="200"\} 1\n/);
      assert.match(metrics, /kv_request_duration_seconds_count 3\n/);
      servicePid = ((await (await fetch(`${kv.controlBaseUrl}/status`)).json()) as { childPid: number }).childPid;
      assert.equal(await kv.generation(), 1);
      assert.deepEqual(kv.operations(), []);
      // a restart through the control API (token + operation id), sent twice: ONE restart, recorded once
      const token = kv.controlUrl.split('#token=')[1]!;
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${kv.controlBaseUrl}/restart`, { method: 'POST', headers: { 'x-hypertest-control-token': token, 'x-hypertest-operation': 'op_kvrestart1', 'content-type': 'application/json' }, body: '{}' });
        assert.equal(res.status, 200);
      }
      assert.equal(await kv.generation(), 2);
      assert.deepEqual(kv.operations().map((o) => [o.operationId, o.kind, o.state, o.generation]), [['op_kvrestart1', 'restart', 'completed', 2]]);
      assert.equal(alive(servicePid), false, 'the restart replaced the service process');
      servicePid = ((await (await fetch(`${kv.controlBaseUrl}/status`)).json()) as { childPid: number }).childPid;
      assert.deepEqual(await get('/kv/k1'), { status: 200, body: { key: 'k1', value: 'v1' } });
    } finally {
      await kv.close();
    }
    assert.equal(alive(kv.pid), false, 'the supervisor process is gone');
    assert.equal(alive(servicePid!), false, 'the service process is gone');
    await kv.close(); // idempotent
  });

  test("the service's latency does not depend on the harness's event loop (a blocked launcher never delays its requests)", async () => {
    const kv = await startKvService({ stateDir: join(root.path, 'kv-2') });
    // an independent client process times one request, sent 200 ms after it reported ready — while THIS process is
    // blocked for 800 ms (a supervisor proxy hosted here would hold the request until the block ends)
    const client = spawn(process.execPath, ['--input-type=module', '-e', [
      "await (await fetch('data:,warm')).arrayBuffer();",
      "process.stdout.write('ready\\n');",
      'await new Promise((r) => setTimeout(r, 200));',
      'const t = performance.now();',
      `const res = await fetch(${JSON.stringify(`${kv.url}/kv/k1`)});`,
      'await res.arrayBuffer();',
      "process.stdout.write(JSON.stringify({ status: res.status, ms: performance.now() - t }) + '\\n');",
    ].join('\n')], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      let out = '';
      const lines: string[] = [];
      const next = () => new Promise<string>((resolve, reject) => {
        const check = () => {
          const nl = out.indexOf('\n');
          if (nl >= 0) {
            client.stdout!.off('data', onData);
            const line = out.slice(0, nl);
            out = out.slice(nl + 1);
            resolve(line);
          }
        };
        const onData = (d: Buffer) => {
          out += d.toString('utf8');
          check();
        };
        client.stdout!.on('data', onData);
        client.once('exit', (code) => reject(new Error(`client exited (${String(code)})`)));
        check();
      });
      lines.push(await next());
      assert.equal(lines[0], 'ready');
      const until = Date.now() + 800;
      while (Date.now() < until) {
        // busy: this event loop is blocked
      }
      const r = JSON.parse(await next()) as { status: number; ms: number };
      assert.equal(r.status, 200);
      assert.ok(r.ms < 400, `the request took ${r.ms.toFixed(0)} ms while the launcher was blocked`);
    } finally {
      client.kill('SIGKILL');
      await kv.close();
    }
  });
});

describe('readers', () => {
  test('readObservations: JSON lines, a broken line skipped, a missing file is empty', () => {
    const file = join(root.path, 'obs.jsonl');
    assert.deepEqual(readObservations(file), []);
    writeFileSync(file, `${JSON.stringify({ role: 'executor', step: 0 })}\n{broken\n\n`);
    appendFileSync(file, `${JSON.stringify({ role: 'rca', step: 1 })}\n`);
    assert.deepEqual(readObservations(file), [{ role: 'executor', step: 0 }, { role: 'rca', step: 1 }]);
  });

  test('loadJobs lists job directories (pid and state when recorded); killLoadWorkers kills the recorded workers', async () => {
    const stateDir = join(root.path, 'state');
    assert.deepEqual(loadJobs(stateDir), []);
    const jobDir = join(stateDir, 'loadjobs', 'op_b');
    mkdirSync(jobDir, { recursive: true });
    // like the load adapter's worker: the job directory is its last argument
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', jobDir], { stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => worker.once('exit', (_c, signal) => resolve(signal)));
    try {
      writeFileSync(join(jobDir, 'pid'), `${worker.pid}\n`);
      writeFileSync(join(jobDir, 'status.json'), JSON.stringify({ state: 'running' }));
      mkdirSync(join(stateDir, 'loadjobs', 'op_a'), { recursive: true });
      writeFileSync(join(stateDir, 'loadjobs', 'op_a', 'pid'), 'garbage');
      writeFileSync(join(stateDir, 'loadjobs', 'op_a', 'status.json'), '{not json');
      assert.deepEqual(loadJobs(stateDir), [{ operationId: 'op_a' }, { operationId: 'op_b', pid: worker.pid, state: 'running' }]);
      assert.equal(isLoadWorker(worker.pid!, { operationId: 'op_b', state: 'running' }), true);
      await killLoadWorkers(stateDir);
      assert.equal(await exited, 'SIGKILL');
      assert.equal(isLoadWorker(worker.pid!, { operationId: 'op_b', state: 'running' }), false, 'a dead worker is no worker');
      await killLoadWorkers(stateDir); // already gone: no throw
    } finally {
      worker.kill('SIGKILL');
    }
  });

  test('killLoadWorkers never signals a process that merely reused a recorded worker pid (pids are recycled)', { skip: existsSync('/proc/self/cmdline') ? false : 'needs /proc to tell a worker from a reused pid' }, async () => {
    const stateDir = join(root.path, 'state-reused');
    // an unrelated process now holds the pids recorded for a finished job and for a job that still claims to run
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exit = new Promise<NodeJS.Signals | null>((resolve) => stranger.once('exit', (_c, signal) => resolve(signal)));
    try {
      for (const [op, state] of [['op_done', 'completed'], ['op_live', 'running']] as const) {
        mkdirSync(join(stateDir, 'loadjobs', op), { recursive: true });
        writeFileSync(join(stateDir, 'loadjobs', op, 'pid'), `${stranger.pid}\n`);
        writeFileSync(join(stateDir, 'loadjobs', op, 'status.json'), JSON.stringify({ state }));
      }
      assert.equal(isLoadWorker(stranger.pid!, { operationId: 'op_live', state: 'running' }), false);
      await killLoadWorkers(stateDir);
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual([stranger.exitCode, stranger.signalCode], [null, null], 'the stranger must survive the cleanup');
    } finally {
      stranger.kill('SIGKILL');
      await exit;
    }
  });
});
