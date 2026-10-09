/**
 * (stubs[3] / E[7] / row 249) A fault experiment on a DOCKER environment in a real run of the production composition
 * (PGlite, or PostgreSQL 16 with HYPERTEST_TEST_DB=postgres). The environment operator defines an experiment whose fault
 * plan declares `pause` on the container, injects it (env.inject_fault: claim-admitted, a ledgered operation verified with
 * its effect window), checks the service, and the detached reverter unpauses the container when the time box ends. docker
 * is a FAKE binary on PATH recording its argv (no docker daemon on the verification host). Before the fix the experiment
 * could not declare a container fault (fault-plan kinds were process faults only) and docker environments refused
 * env.inject_fault.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, defaultConfig, type HypertestConfig, type HypertestConfigInput } from '../src/index.ts';
import { FULL_ROUTE, call, evidenceIds, roleRouter, testStore, type BrainView, type RoleBrain } from './helpers.ts';

const ENV_ID = 'shop-docker';
const OBJECTIVE = { objectiveId: 'obj-pause', description: 'The shop answers health checks again after its container was paused.', priority: 'P1', acceptanceCriteria: ['health evidence after a time-boxed pause'] };
const ORACLE = {
  oracleId: 'shop-health',
  scope: { components: ['shop'], description: 'health endpoint' },
  assertions: [{ assertionId: 'healthy', description: 'GET /health answers 200', kind: 'requirement', severity: 'P1', check: { type: 'http_expectation', method: 'GET', path: '/health', expectStatus: 200 } }],
  judgePolicy: { independentReviewerRequired: false },
  establishedBy: 'alice',
} as const;

const lead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) return call('system_model.record', { components: [{ componentId: 'shop', name: 'shop container', kind: 'service', paths: [] }] });
    if (v.step === 1) {
      return call('plan.propose_revision', {
        rationale: 'Pause the container for a bounded window and confirm the service recovers.', objectives: [OBJECTIVE],
        workItems: [{ localId: 'pause', title: 'Pause the shop container', role: 'environment', dependsOn: [], objectiveIds: ['obj-pause'], objective: `On environment ${ENV_ID}: pause the container for 600 ms under an experiment, then check /health.` }],
      });
    }
    return call('complete_work', { summary: 'Plan v1', output: { summary: 'Plan v1', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-pause', status: 'open', evidenceRefs: [] }] } });
  }
  if (v.step === 0) return call('evidence.query', { evidenceType: 'api-response' });
  const ev = evidenceIds(v.toolResults[0]?.content ?? '');
  if (v.step === 1) return call('plan.propose_revision', { rationale: 'Fault applied and reverted; health evidence recorded.', objectives: [{ ...OBJECTIVE, status: 'satisfied' }], workItems: [], readyForGate: true });
  return call('complete_work', { summary: 'ready', evidenceRefs: ev.slice(0, 1), output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-pause', status: 'satisfied', evidenceRefs: ev.slice(0, 1) }] } });
};

function operator(results: Array<{ name: string; content: string; isError: boolean }>, operationIds: string[]): RoleBrain {
  return (v: BrainView) => {
    const last = v.toolResults.at(-1);
    if (last) results.push(last);
    switch (v.step) {
      case 0: return call('experiment.define', {
        hypothesis: 'the shop recovers after a 600 ms container pause', environmentId: ENV_ID,
        faultPlan: [{ kind: 'pause', target: ENV_ID }],
        isolation: { mode: 'exclusive_write', resourceClaims: [] }, evidenceRequirements: [{ evidenceType: 'api-response', minCount: 1 }],
      });
      case 1: return call('env.inject_fault', { environmentId: ENV_ID, kind: 'pause', params: {}, durationMs: 600 });
      case 2: {
        const op = /operation (op_[A-Za-z0-9]+)/.exec(v.toolResults[1]?.content ?? '')?.[1];
        if (op) operationIds.push(op);
        return call('http.request', { method: 'GET', environmentId: ENV_ID, path: '/health' });
      }
      default: {
        const health = evidenceIds(v.toolResults[2]?.content ?? '');
        return call('complete_work', {
          summary: 'pause injected (time-boxed), health checked', evidenceRefs: health,
          output: { summary: 'pause applied and reverted by its time box', environmentReady: true, actions: [{ action: 'env.inject_fault pause', target: ENV_ID, status: 'verified', evidenceIds: health }] },
        });
      }
    }
  };
}

describe('a docker fault experiment in a real run (fake docker on PATH)', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  let server: Server;
  let url = '';
  let logPath = '';
  const ORIGINAL_PATH = process.env['PATH'];

  before(async () => {
    dir = await tempDir('ht-app-faults-');
    db = await testStore();
    server = createServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const bin = join(dir.path, 'bin');
    mkdirSync(bin);
    logPath = join(dir.path, 'docker-argv.log');
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(logPath)}\nexit 0\n`);
    chmodSync(join(bin, 'docker'), 0o755);
    process.env['PATH'] = `${bin}:${ORIGINAL_PATH ?? ''}`;
  });
  after(async () => {
    process.env['PATH'] = ORIGINAL_PATH;
    await new Promise<void>((r) => server.close(() => r()));
    await db?.dispose();
    await dir?.cleanup();
  });

  test('experiment with a pause fault plan → claim-admitted, ledgered, verified with its effect window, reverted at expiry, judged', async () => {
    const results: Array<{ name: string; content: string; isError: boolean }> = [];
    const operationIds: string[] = [];
    const c = defaultConfig({
      project: { name: 'container-faults', dataDir: join(dir.path, 'data') },
      models: { providers: [{ id: 'sim', kind: 'scripted' }], routes: [{ routeId: 'sim-large', provider: 'sim', model: 'sim-1', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities], quality: { ...FULL_ROUTE.quality } }] },
      gate: { requireIndependentReview: false, requiredEvidence: [{ evidenceType: 'api-response', minCount: 1 }] },
      observability: { logLevel: 'warn' },
      oracles: [ORACLE],
      environments: [{ environmentId: ENV_ID, environmentClass: 'local', baseUrl: url, generation: 0, control: { kind: 'docker', target: 'shop-api' } }],
    } as unknown as HypertestConfigInput);
    const config: HypertestConfig = db.store ? { ...c, store: db.store } : c;
    const ht = await createHypertest(config, { scriptedBrains: { sim: roleRouter({ lead, environment: operator(results, operationIds) }) }, logger: new MemoryLogger() });
    try {
      const outcome = await ht.run({ goal: 'Does the shop recover from a container pause?', target: { environmentId: ENV_ID } }, { timeoutMs: 120_000 });
      assert.deepEqual(results.filter((r) => r.isError).map((r) => r.content), [], 'every call of the operator succeeded');
      const ops = (await ht.services.operations.list({ runId: outcome.runId })).filter((o) => o.operationType === 'env.inject_fault');
      assert.equal(ops.length, 1);
      assert.equal(ops[0]!.status, 'verified');
      assert.ok(typeof (ops[0]!.result as { effectUntil?: string }).effectUntil === 'string', 'the effect window is on the operation');
      assert.ok((ops[0] as { experimentId?: string }).experimentId, 'the fault ran for the experiment (LedgerOperationRecord.experimentId)');
      const actions = await ht.events(outcome.runId, { types: ['experiment.action'] });
      assert.deepEqual(actions.map((e) => (e.payload as { toolId: string; kind?: string }).toolId + ':' + (e.payload as { kind?: string }).kind), ['env.inject_fault:pause']);
      // the reverter ends the time box (it outlives nothing: 600 ms)
      for (let i = 0; i < 100 && !(existsSync(logPath) && readFileSync(logPath, 'utf8').includes('unpause')); i++) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(readFileSync(logPath, 'utf8').trim().split('\n'), ['pause shop-api', 'unpause shop-api']);
      assert.equal(outcome.decision?.verdict, 'pass', JSON.stringify(outcome.decision?.reasons));
    } finally {
      await ht.close();
    }
  });
});
