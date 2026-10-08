/**
 * (row 246: Remote Worker) A second process — `hypertest tool-worker` started from the CLI entry point (bin/hypertest.js)
 * with its own configuration — executes http.request for a Hypertest deployment that lists it under
 * `tools.remoteWorkers` (shared secret by variable NAME). In a real run (PGlite, or PostgreSQL 16 with
 * HYPERTEST_TEST_DB=postgres): the executor's calls pass capability → permit → freshness → Operation Ledger HERE, their
 * bodies run in the worker process, the SUT sees the operation id created here (`Idempotency-Key`), the evidence is
 * recorded in this deployment's ledger (`provenance.executedBy = remote:edge`) and the QualityGate judges it. A deployment
 * holding the wrong secret gets no execution at all.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, defaultConfig, type HypertestConfig, type HypertestConfigInput } from '../src/index.ts';
import { FULL_ROUTE, call, evidenceIds, roleRouter, testStore, type RoleBrain } from './helpers.ts';

const BIN = fileURLToPath(new URL('../../../bin/hypertest.js', import.meta.url));
const SECRET = 'remote-worker-e2e-shared-secret-42';

const ORDERS_ORACLE = {
  oracleId: 'orders',
  scope: { components: ['orders'], description: 'an order is created with 201' },
  assertions: [{ assertionId: 'create-201', description: 'POST /orders answers 201', kind: 'requirement', severity: 'P1', check: { type: 'http_expectation', method: 'POST', path: '/orders', expectStatus: 201 } }],
  judgePolicy: { independentReviewerRequired: false },
  establishedBy: 'alice',
} as const;

const OBJECTIVE = { objectiveId: 'obj-orders', description: 'Orders can be created.', priority: 'P1', acceptanceCriteria: ['api-response evidence'] };

async function startSut(): Promise<{ url: string; requests: Array<{ method: string; url: string; key?: string }>; close(): Promise<void> }> {
  const requests: Array<{ method: string; url: string; key?: string }> = [];
  const server: Server = createServer((req, res) => {
    const key = req.headers['idempotency-key'];
    requests.push({ method: req.method ?? '', url: req.url ?? '', ...(typeof key === 'string' ? { key } : {}) });
    req.resume();
    req.on('end', () => {
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function baseConfig(dataDir: string, sutUrl: string): HypertestConfigInput {
  return {
    project: { name: 'remote-worker', dataDir },
    models: { providers: [{ id: 'sim', kind: 'scripted' }], routes: [{ routeId: 'sim-large', provider: 'sim', model: 'sim-1', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities], quality: { ...FULL_ROUTE.quality } }] },
    gate: { requireIndependentReview: false, requiredEvidence: [{ evidenceType: 'api-response', minCount: 1 }] },
    observability: { logLevel: 'warn' },
    oracles: [ORDERS_ORACLE],
    environments: [{ environmentId: 'orders', environmentClass: 'local', baseUrl: sutUrl, generation: 0 }],
  } as unknown as HypertestConfigInput;
}

async function startWorkerProcess(dir: string, sutUrl: string): Promise<{ url: string; child: ChildProcess }> {
  const configPath = join(dir, 'worker.config.json');
  await writeFile(configPath, JSON.stringify({ ...defaultConfig(baseConfig(join(dir, 'worker-data'), sutUrl)) }, null, 2));
  const child = spawn(process.execPath, [BIN, '-c', configPath, '--json', 'tool-worker', '--tools', 'http.request', '--id', 'edge', '--listen', '127.0.0.1:0', '--secret-env', 'HT_WORKER_SECRET'], {
    env: { ...process.env, HT_WORKER_SECRET: SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  const url = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      const line = buf.split('\n').find((l) => l.startsWith('{'));
      if (line) resolve((JSON.parse(line) as { url: string }).url);
    });
    child.once('exit', (code) => reject(new Error(`tool-worker exited (${code}): ${stderr}`)));
  });
  return { url, child };
}

const lead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) return call('system_model.record', { components: [{ componentId: 'orders', name: 'orders API', kind: 'service', paths: [] }] });
    if (v.step === 1) {
      return call('plan.propose_revision', {
        rationale: 'Create an order on the orders API.', objectives: [OBJECTIVE],
        workItems: [{ localId: 'create', title: 'Create an order', objective: 'POST /orders on environment orders and read it back.', role: 'executor', dependsOn: [], objectiveIds: ['obj-orders'], evidenceRequirements: [{ evidenceType: 'api-response', minCount: 1, critical: true }] }],
      });
    }
    return call('complete_work', { summary: 'Plan v1', output: { summary: 'Plan v1', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-orders', status: 'open', evidenceRefs: [] }] } });
  }
  if (v.step === 0) return call('evidence.query', { evidenceType: 'api-response' });
  const ev = evidenceIds(v.toolResults[0]?.content ?? '');
  if (v.step === 1) return call('plan.propose_revision', { rationale: 'done', objectives: [{ ...OBJECTIVE, status: 'satisfied' }], workItems: [], readyForGate: true });
  return call('complete_work', { summary: 'ready', evidenceRefs: ev.slice(0, 1), output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-orders', status: 'satisfied', evidenceRefs: ev.slice(0, 1) }] } });
};

function executor(results: Array<{ name: string; content: string; isError: boolean }>): RoleBrain {
  return (v) => {
    const last = v.toolResults.at(-1);
    if (last) results.push(last);
    if (v.step === 0) return call('experiment.define', { hypothesis: 'POST /orders creates an order', environmentId: 'orders', isolation: { mode: 'exclusive_write', resourceClaims: [] }, evidenceRequirements: [{ evidenceType: 'api-response', minCount: 1 }] });
    if (v.step === 1) return call('http.request', { method: 'POST', environmentId: 'orders', path: '/orders', json: { sku: 'apple' } });
    if (v.step === 2) return call('http.request', { method: 'GET', environmentId: 'orders', path: '/orders/1' });
    const ids = [1, 2].flatMap((i) => evidenceIds(v.toolResults[i]?.content ?? ''));
    return call('complete_work', { summary: 'order created', evidenceRefs: ids, output: { summary: 'created', executed: [{ selector: 'POST /orders', passed: true, outcome: 'passed', evidenceIds: ids }], findings: [] } });
  };
}

describe('remote tool worker in a second process (hypertest tool-worker)', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let sut: Awaited<ReturnType<typeof startSut>>;
  let worker: Awaited<ReturnType<typeof startWorkerProcess>>;
  let db: Awaited<ReturnType<typeof testStore>>;

  before(async () => {
    dir = await tempDir('ht-app-remote-');
    sut = await startSut();
    worker = await startWorkerProcess(dir.path, sut.url);
    db = await testStore();
  });
  after(async () => {
    worker?.child.kill('SIGTERM');
    await new Promise((r) => (worker?.child.exitCode !== null ? r(undefined) : worker.child.once('exit', r)));
    await db?.dispose();
    await sut?.close();
    await dir?.cleanup();
  });

  function config(dataDir: string, secretEnv: string): HypertestConfig {
    const c = defaultConfig({ ...baseConfig(dataDir, sut.url), tools: { remoteWorkers: [{ id: 'edge', url: worker.url, secretEnv, tools: ['http.request'] }] } } as unknown as HypertestConfigInput);
    return db.store ? { ...c, store: db.store } : c;
  }

  test('the calls run in the worker process; ledger, operation ids and evidence stay with the deployment', async () => {
    const results: Array<{ name: string; content: string; isError: boolean }> = [];
    const ht = await createHypertest(config(join(dir.path, 'main'), 'HT_MAIN_WORKER_SECRET'), {
      scriptedBrains: { sim: roleRouter({ lead, executor: executor(results) }) }, logger: new MemoryLogger(), env: { ...process.env, HT_MAIN_WORKER_SECRET: SECRET },
    });
    try {
      const outcome = await ht.run({ goal: 'Can orders be created?', target: { environmentId: 'orders' } }, { timeoutMs: 120_000 });
      assert.deepEqual(results.filter((r) => r.isError).map((r) => r.content), []);
      const health = (await (await fetch(`${worker.url}/v1/health`)).json()) as { workerId: string; executed: number; tools: string[] };
      assert.deepEqual([health.workerId, health.tools], ['edge', ['http.request']]);
      assert.equal(health.executed, 2, 'both calls executed in the worker process');
      const ops = (await ht.services.operations.list({ runId: outcome.runId })).filter((o) => o.operationType === 'http.request');
      assert.equal(ops.length, 1, 'the POST is one operation of THIS deployment\'s ledger');
      assert.equal(ops[0]!.status, 'verified');
      const post = sut.requests.find((r) => r.method === 'POST');
      assert.equal(post?.key, ops[0]!.operationId, 'the operation id created here reached the SUT through the worker');
      const ev = await ht.services.evidence.query({ runId: outcome.runId, evidenceType: 'api-response' });
      assert.equal(ev.length, 2);
      assert.ok(ev.every((e) => (e.provenance as { executedBy?: string }).executedBy === 'remote:edge'));
      assert.ok((await ht.verifyEvidence(outcome.runId)).ok);
      assert.equal(outcome.decision?.verdict, 'pass', JSON.stringify(outcome.decision?.reasons));
    } finally {
      await ht.close();
    }
  });

  test('failure path: a deployment holding the wrong secret gets no execution (and the SUT no request)', async () => {
    const results: Array<{ name: string; content: string; isError: boolean }> = [];
    const own = await testStore();
    const before = sut.requests.length;
    const c = { ...config(join(dir.path, 'wrong'), 'HT_WRONG_SECRET'), ...(own.store ? { store: own.store } : {}) };
    const ht = await createHypertest(c, { scriptedBrains: { sim: roleRouter({ lead, executor: executor(results) }) }, logger: new MemoryLogger(), env: { ...process.env, HT_WRONG_SECRET: 'not-the-shared-secret-of-edge' } });
    try {
      await ht.run({ goal: 'Can orders be created?', target: { environmentId: 'orders' } }, { timeoutMs: 120_000 });
      const post = results.find((r) => /http/.test(r.name) && r.isError);
      assert.ok(post, JSON.stringify(results));
      assert.match(post!.content, /integrity_violation|not authentic/);
      assert.equal(sut.requests.length, before, 'the worker executed nothing');
    } finally {
      await ht.close();
      await own.dispose();
    }
  });
});
