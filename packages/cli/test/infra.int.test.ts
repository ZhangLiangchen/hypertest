/**
 * The CLI against the local infrastructure (`npm run infra:up`; each test skips with the reason when its services are
 * not configured):
 *   - `doctor` probes the configured PostgreSQL, NATS, Temporal and OPA (reachable ⇒ ok; unreachable ⇒ error, exit 1);
 *   - `hypertest worker` hosts the Temporal worker for clients with `workerMode: external`: `run` waits for the verdict
 *     computed by the worker, `run --detach` returns at once and the worker completes the run, `resume --detach`
 *     restarts workflows idempotently.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { MemoryLogger } from '@hypertest/core';
import { createHypertest, loadConfig, manifestTaskQueue } from '@hypertest/app';
import type { TestRun } from '@hypertest/domain';
import { openDatabase } from '@hypertest/store';
import { infraEnv, skipUnless, tempDir } from '@hypertest/testkit';
import { clientOnlyConfig, type DoctorReport } from '../src/index.ts';
import { BRAINS, GOAL, SIM_ROUTE, SUM_ORACLE, cli, parseJson, sumRepo, type CliResult } from './helpers.ts';

const infra = infraEnv();
const exec = promisify(execFile);

async function dropSchema(url: string, schema: string): Promise<void> {
  const db = await openDatabase({ kind: 'postgres', url });
  try {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await db.close();
  }
}

describe('hypertest doctor against the local infrastructure', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => {
    dir = await tempDir('ht-cli-doctor-int-');
  });
  after(async () => {
    await dir.cleanup();
  });

  test(
    'reachable PostgreSQL, NATS, Temporal and OPA are ok (exit 0); the store URL comes from urlEnv and is never printed',
    skipUnless(!!infra.pgUrl && !!infra.natsUrl && !!infra.temporalAddress && !!infra.opaUrl, 'HYPERTEST_TEST_PG_URL / _NATS_URL / _TEMPORAL_ADDRESS / _OPA_URL not set (run npm run infra:up)'),
    async () => {
      await writeFile(join(dir.path, 'hypertest.config.yaml'), JSON.stringify({
        version: 1,
        store: { kind: 'postgres', urlEnv: 'HT_CLI_DOCTOR_PG' },
        bus: { kind: 'nats', servers: infra.natsUrl },
        durable: { kind: 'temporal', address: infra.temporalAddress },
        policy: { capabilitySecretEnv: 'HT_CLI_DOCTOR_CAP', opa: { url: infra.opaUrl } },
        models: { providers: [{ id: 'sim', kind: 'scripted' }], routes: [SIM_ROUTE] },
      }));
      const r = await cli(['doctor', '--json'], { cwd: dir.path, env: { HT_CLI_DOCTOR_PG: infra.pgUrl!, HT_CLI_DOCTOR_CAP: 'capability-secret-0123456789' } });
      const report = parseJson<DoctorReport>(r);
      assert.equal(r.code, 0, JSON.stringify(report.checks, null, 2));
      const byName = (n: string) => report.checks.filter((c) => c.name === n);
      assert.deepEqual(byName('store').map((c) => [c.status, c.detail]), [['ok', 'PostgreSQL is reachable']]);
      assert.equal(byName('bus')[0]!.status, 'ok');
      assert.match(byName('bus')[0]!.detail, /^NATS 127\.0\.0\.1:\d+ is reachable$/);
      assert.match(byName('durable')[0]!.detail, /^Temporal 127\.0\.0\.1:\d+ is reachable$/);
      assert.match(byName('policy')[0]!.detail, /^OPA http:\/\/127\.0\.0\.1:\d+\/health is reachable \(HTTP 200\)$/);
      assert.equal(r.stdout.includes(infra.pgUrl!), false, 'the store URL was printed');
    },
  );

  test('unreachable infrastructure is an error per service (exit 1)', skipUnless(!!infra.pgUrl, 'HYPERTEST_TEST_PG_URL not set (run npm run infra:up)'), async () => {
    const closed = 'postgres://postgres@127.0.0.1:1/none';
    await writeFile(join(dir.path, 'hypertest.config.yaml'), JSON.stringify({
      version: 1,
      store: { kind: 'postgres', urlEnv: 'HT_CLI_DOCTOR_PG' },
      bus: { kind: 'nats', servers: 'nats://127.0.0.1:1' },
      durable: { kind: 'temporal', address: '127.0.0.1:1' },
      policy: { capabilitySecretEnv: 'HT_CLI_DOCTOR_CAP' },
      models: { providers: [{ id: 'sim', kind: 'scripted' }], routes: [SIM_ROUTE] },
    }));
    const r = await cli(['doctor', '--json', '--timeout-ms', '2000'], { cwd: dir.path, env: { HT_CLI_DOCTOR_PG: closed, HT_CLI_DOCTOR_CAP: 'capability-secret-0123456789' } });
    assert.equal(r.code, 1);
    const report = parseJson<DoctorReport>(r);
    const errors = report.checks.filter((c) => c.status === 'error').map((c) => c.name);
    assert.deepEqual(errors, ['store', 'bus', 'durable']);
    assert.match(report.checks.find((c) => c.name === 'bus')!.detail, /^NATS 127\.0\.0\.1:1 is not reachable: /);
  });
});

describe('hypertest worker (Temporal, workerMode external) over PostgreSQL', () => {
  const ready = !!infra.pgUrl && !!infra.temporalAddress;
  const reason = 'HYPERTEST_TEST_PG_URL / HYPERTEST_TEST_TEMPORAL_ADDRESS not set (run npm run infra:up)';
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  const schema = `ht_cli_worker_${randomBytes(4).toString('hex')}`;
  const env: Record<string, string> = { HT_CLI_SCENARIO: 'pass', HT_CLI_WORKER_PG: infra.pgUrl ?? '', HT_CLI_WORKER_CAP: 'worker-capability-secret-0123456789' };
  let worker: { done: Promise<CliResult>; stop(): Promise<CliResult> } | undefined;

  before(async () => {
    if (!ready) return;
    dir = await tempDir('ht-cli-worker-');
    repo = await sumRepo(true);
    await writeFile(join(dir.path, 'hypertest.config.yaml'), JSON.stringify({
      version: 1,
      project: { name: 'cli-worker', dataDir: '.hypertest' },
      store: { kind: 'postgres', urlEnv: 'HT_CLI_WORKER_PG', schema },
      durable: { kind: 'temporal', address: infra.temporalAddress, namespace: 'default', taskQueue: `ht-cli-${schema}`, workerMode: 'external' },
      policy: { capabilitySecretEnv: 'HT_CLI_WORKER_CAP' },
      models: { providers: [{ id: 'sim', kind: 'scripted' }], routes: [SIM_ROUTE] },
      gate: { requireIndependentReview: false },
      oracles: [SUM_ORACLE],
    }));
    const ctrl = new AbortController();
    let resolveReady!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const done = cli(['worker', '--scripted-brains', BRAINS, '--json'], {
      cwd: dir.path, env, signal: ctrl.signal, onStdout: (t) => (t.trimEnd().endsWith('}') ? resolveReady() : undefined),
    });
    worker = { done, stop: async () => (ctrl.abort(), done) };
    await Promise.race([started, done.then((r) => Promise.reject(new Error(`worker exited ${r.code}: ${r.stderr}`)))]);
  });
  after(async () => {
    if (!ready) return;
    if (worker) {
      const r = await worker.stop();
      assert.equal(r.code, 0, r.stderr);
    }
    await dropSchema(infra.pgUrl!, schema);
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('run waits for the verdict the worker computes (exit 0)', skipUnless(ready, reason), async () => {
    const r = await cli(['run', GOAL, '--repo', repo.path, '--commit', 'HEAD', '--scripted-brains', BRAINS, '--json', '--timeout-ms', '180000'], { cwd: dir.path, env });
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<{ status: string; verdict: string }>(r);
    assert.deepEqual([out.status, out.verdict], ['completed', 'pass']);
  });

  test('run --detach returns at once; the worker completes the run; resume --detach is idempotent', skipUnless(ready, reason), async () => {
    const r = await cli(['run', GOAL, '--repo', repo.path, '--commit', 'HEAD', '--scripted-brains', BRAINS, '--detach', '--json'], { cwd: dir.path, env });
    assert.equal(r.code, 0, r.stderr);
    const started = parseJson<{ runId: string; detached: boolean }>(r);
    assert.equal(started.detached, true);
    const deadline = Date.now() + 180_000;
    let run: TestRun | undefined;
    for (;;) {
      run = parseJson<{ run: TestRun }>(await cli(['status', started.runId, '--json'], { cwd: dir.path, env })).run;
      if (run.status === 'completed' || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(run.status, 'completed');
    const resumed = await cli(['resume', '--detach', '--scripted-brains', BRAINS, '--json'], { cwd: dir.path, env });
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.deepEqual(parseJson(resumed), { resumed: [], outcomes: [] });
  });
});

describe('short-lived commands never host a Temporal worker (durable.workerMode embedded, the default)', () => {
  const temporalCli = infra.infraBin ? join(infra.infraBin, 'temporal') : '';
  const ready = !!infra.pgUrl && !!infra.temporalAddress && temporalCli !== '' && existsSync(temporalCli);
  const reason = 'HYPERTEST_TEST_PG_URL / HYPERTEST_TEST_TEMPORAL_ADDRESS / HYPERTEST_INFRA_BIN (temporal CLI) not set (run npm run infra:up)';
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  const schema = `ht_cli_client_${randomBytes(4).toString('hex')}`;
  const taskQueue = `ht-cli-${schema}`;
  const env: Record<string, string> = { HT_CLI_SCENARIO: 'pass', HT_CLI_CLIENT_PG: infra.pgUrl ?? '', HT_CLI_CLIENT_CAP: 'client-capability-secret-0123456789' };
  let runId: string | undefined;

  /** The runtime's effective task queue (durability-6: scoped to the runtime manifest). */
  let effectiveQueue = taskQueue;
  /** The pollers Temporal recorded on the task queue (kept for 5 minutes after their last poll). */
  async function pollers(type: 'workflow' | 'activity'): Promise<unknown[]> {
    const { stdout } = await exec(temporalCli, ['task-queue', 'describe', '--task-queue', effectiveQueue, '--task-queue-type', type, '--address', infra.temporalAddress!, '-o', 'json'], { timeout: 20_000 });
    return ((JSON.parse(stdout) as { pollers?: unknown[] | null }).pollers ?? []);
  }

  before(async () => {
    if (!ready) return;
    dir = await tempDir('ht-cli-client-');
    repo = await sumRepo(true);
    await writeFile(join(dir.path, 'hypertest.config.yaml'), JSON.stringify({
      version: 1,
      project: { name: 'cli-client', dataDir: '.hypertest' },
      store: { kind: 'postgres', urlEnv: 'HT_CLI_CLIENT_PG', schema },
      // workerMode is not set: embedded, i.e. a process that drives runs hosts the worker
      durable: { kind: 'temporal', address: infra.temporalAddress, namespace: 'default', taskQueue },
      policy: { capabilitySecretEnv: 'HT_CLI_CLIENT_CAP' },
      models: { providers: [{ id: 'sim', kind: 'scripted' }], routes: [SIM_ROUTE] },
      gate: { requireIndependentReview: false },
    }));
  });
  after(async () => {
    if (!ready) return;
    // nothing ever polls this queue: end the run's workflow explicitly
    if (runId) await exec(temporalCli, ['workflow', 'terminate', '--workflow-id', `run-${runId}`, '--reason', 'test cleanup', '--address', infra.temporalAddress!], { timeout: 20_000 }).catch(() => undefined);
    await dropSchema(infra.pgUrl!, schema);
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('run --detach (no brains needed), approve and cancel only start and signal workflows: no poller ever appears on the task queue', skipUnless(ready, reason), async () => {
    const started = await cli(['run', GOAL, '--repo', repo.path, '--commit', 'HEAD', '--detach', '--json'], { cwd: dir.path, env });
    assert.equal(started.code, 0, started.stderr);
    const out = parseJson<{ runId: string; detached: boolean; status: string }>(started);
    runId = out.runId;
    assert.equal(out.detached, true);
    assert.ok(['created', 'running'].includes(out.status), out.status);

    // an approval request of an agent of the run, filed through the application services (no durable call here)
    const config = clientOnlyConfig(await loadConfig(join(dir.path, 'hypertest.config.yaml'), { env }));
    const ht = await createHypertest(config, { env, scriptedBrains: { sim: () => ({ text: 'unused' }) }, logger: new MemoryLogger() });
    let approvalId: string;
    effectiveQueue = (ht.durable as unknown as { taskQueue: string }).taskQueue;
    assert.equal(effectiveQueue, manifestTaskQueue(taskQueue, ht.manifest.manifestId), 'the queue the CLI commands used');
    try {
      approvalId = (await ht.services.approvals.request(
        { runId, kind: 'action', subject: { tool: 'env.restart', target: 'staging' }, requestedBy: { kind: 'agent', id: 'ag_requester', role: 'environment' }, rationale: 'restart staging' },
        { runId, correlationId: runId, actorId: 'agent:ag_requester' },
      )).approvalId;
    } finally {
      await ht.close();
    }
    const approved = await cli(['approve', approvalId, '--by', 'alice', '--reason', 'window agreed'], { cwd: dir.path, env });
    assert.equal(approved.code, 0, approved.stderr);
    const cancelled = await cli(['cancel', runId, '--reason', 'withdrawn'], { cwd: dir.path, env });
    assert.deepEqual([cancelled.code, cancelled.stdout], [0, `run ${runId} cancelled\n`], cancelled.stderr);

    assert.deepEqual(await pollers('workflow'), [], 'a short-lived command polled for workflow tasks (hosted a worker)');
    assert.deepEqual(await pollers('activity'), [], 'a short-lived command polled for activity tasks (hosted a worker)');
    const s = parseJson<{ run: TestRun }>(await cli(['status', runId, '--json'], { cwd: dir.path, env }));
    assert.equal(s.run.status, 'cancelled');
  });
});
