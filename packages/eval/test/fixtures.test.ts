/**
 * The PoC systems under test (local processes on loopback, no external infra): the ledger repository seeds exactly the
 * intended regression (its own suite stays green on the candidate, the designed contract test fails on the candidate
 * and passes on the base), the bank API carries the negative-transfer defect with ground-truth effects, and the
 * observation/load-job readers tolerate partial state. Every spawned process is stopped.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { tempDir } from '@hypertest/testkit';
import { FIXTURES_DIR, createLedgerRepo, gitShowFile, killLoadWorkers, loadJobs, readObservations, startBankApi } from '../src/index.ts';

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
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => worker.once('exit', (_c, signal) => resolve(signal)));
    try {
      mkdirSync(join(stateDir, 'loadjobs', 'op_b'), { recursive: true });
      writeFileSync(join(stateDir, 'loadjobs', 'op_b', 'pid'), `${worker.pid}\n`);
      writeFileSync(join(stateDir, 'loadjobs', 'op_b', 'status.json'), JSON.stringify({ state: 'running' }));
      mkdirSync(join(stateDir, 'loadjobs', 'op_a'), { recursive: true });
      writeFileSync(join(stateDir, 'loadjobs', 'op_a', 'pid'), 'garbage');
      writeFileSync(join(stateDir, 'loadjobs', 'op_a', 'status.json'), '{not json');
      assert.deepEqual(loadJobs(stateDir), [{ operationId: 'op_a' }, { operationId: 'op_b', pid: worker.pid, state: 'running' }]);
      await killLoadWorkers(stateDir);
      assert.equal(await exited, 'SIGKILL');
      await killLoadWorkers(stateDir); // already gone: no throw
    } finally {
      worker.kill('SIGKILL');
    }
  });
});
