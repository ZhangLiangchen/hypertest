/**
 * Production wiring on the local infrastructure of `npm run infra:up`: a PostgreSQL store (fresh schema), the NATS
 * JetStream bus (private stream + subject prefix), the OPA policy engine composed with the built-in rules (a policy
 * uploaded to a private package), and the Temporal durable runtime (embedded worker, private task queue). Each test
 * skips with an explicit reason when its infrastructure is absent.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { openDatabase } from '@hypertest/store';
import { infraEnv, skipUnless, tempDir } from '@hypertest/testkit';
import { createHypertest, diagnose, opaPolicyRevision, type HypertestConfig, type HypertestInstance } from '../src/index.ts';
import { roleRouter, scriptedConfig, sumRepo, tinyRunBrains } from './helpers.ts';

const infra = infraEnv();
const suffix = randomBytes(4).toString('hex');
const cleanups: Array<() => Promise<void>> = [];

after(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => undefined);
});

async function freshSchema(tag: string): Promise<string> {
  const schema = `ht_app_int_${tag}_${suffix}`;
  cleanups.push(async () => {
    const db = await openDatabase({ kind: 'postgres', url: infra.pgUrl! });
    try {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await db.close();
    }
  });
  return schema;
}

async function fixture(tag: string, extra: Partial<HypertestConfig>): Promise<{ ht: HypertestInstance; config: HypertestConfig; env: Record<string, string>; target: { repoPath: string; commit: string } }> {
  const dir = await tempDir(`ht-app-int-${tag}-`);
  const repo = await sumRepo();
  cleanups.push(dir.cleanup, repo.cleanup);
  const env = { HT_INT_PG_URL: infra.pgUrl!, HT_INT_CAPABILITY_SECRET: randomBytes(24).toString('hex') };
  const config: HypertestConfig = {
    ...scriptedConfig(dir.path, { gate: { requireIndependentReview: false } }),
    store: { kind: 'postgres', urlEnv: 'HT_INT_PG_URL', schema: await freshSchema(tag) },
    policy: { capabilitySecretEnv: 'HT_INT_CAPABILITY_SECRET' },
    ...extra,
  };
  const ht = await createHypertest(config, { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger(), env });
  cleanups.push(() => ht.close());
  return { ht, config, env, target: { repoPath: repo.path, commit: repo.head } };
}

describe('production wiring (local infrastructure)', { concurrency: false }, () => {
  test(
    'PostgreSQL + NATS JetStream + OPA (composed with the built-in rules): the tiny run reaches its verdict',
    skipUnless(!!infra.pgUrl && !!infra.natsUrl && !!infra.opaUrl, 'HYPERTEST_TEST_PG_URL / HYPERTEST_TEST_NATS_URL / HYPERTEST_TEST_OPA_URL not set (run npm run infra:up)'),
    async () => {
      // a private OPA package allowing what the tiny run needs (reads, records, test execution)
      const pkg = `appint_${suffix}`;
      const policyId = `hypertest-app-int-${suffix}`;
      const rego = `package hypertest.${pkg}\n\ndefault allow := false\n\nallow if {\n  input.effect in {"read", "record", "execute"}\n}\n\nreasons contains "app integration policy" if allow\n`;
      const put = await fetch(`${infra.opaUrl}/v1/policies/${policyId}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: rego });
      assert.equal(put.status, 200, await put.text());
      cleanups.push(async () => void (await fetch(`${infra.opaUrl}/v1/policies/${policyId}`, { method: 'DELETE' })));

      const { ht, config, env, target } = await fixture('nats', {
        bus: { kind: 'nats', servers: infra.natsUrl!, stream: `HT_APP_INT_${suffix}`, subjectPrefix: `htappint${suffix}` },
        policy: { capabilitySecretEnv: 'HT_INT_CAPABILITY_SECRET', opa: { url: infra.opaUrl!, path: `hypertest/${pkg}` } },
      });
      assert.equal(ht.services.bus.kind, 'nats');
      assert.equal(ht.durable.kind, 'local');
      // conformance-12: the OPA part of the revision is the digest of the served policy modules of the decision package
      assert.match(ht.services.policy.revision, new RegExp(`^builtin:[0-9a-f]{16}\\+opa:hypertest/${pkg}@[0-9a-f]{16}$`));
      assert.equal(ht.services.policy.revision.split('+')[1], await opaPolicyRevision(infra.opaUrl!, `hypertest/${pkg}`));

      // a probe consumer on the bus: run events published by the outbox relay are delivered through JetStream
      const delivered: Array<{ runId: string; eventType: string }> = [];
      const probe = await ht.services.bus.subscribe({ durableName: `app-int-probe-${suffix}`, subjects: ['ht.*.run.>'], handler: async (e) => void delivered.push({ runId: e.runId, eventType: e.eventType }) });
      cleanups.push(() => probe.unsubscribe());
      const outcome = await ht.run({ goal: 'Is the sum module releasable?', target }, { timeoutMs: 120_000 });
      assert.equal(outcome.status, 'completed');
      assert.equal(outcome.decision!.verdict, 'pass');
      // every permit was decided by the composite engine (built-in rules AND the OPA document)
      const decisions = await ht.services.decisionLog.list(outcome.runId);
      assert.ok(decisions.length > 0);
      for (const d of decisions) assert.equal(d.permit.policyRevision, ht.services.policy.revision);
      assert.ok(decisions.some((d) => d.request.tool === 'test.run' && d.permit.decision === 'allow'));
      assert.deepEqual(await ht.verifyEvidence(outcome.runId), { ok: true, problems: [] });
      // the outbox relay published the run's events to NATS and they came back through JetStream
      const deadline = Date.now() + 10_000;
      while (!delivered.some((e) => e.runId === outcome.runId && e.eventType === 'run.completed') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.ok(delivered.some((e) => e.runId === outcome.runId && e.eventType === 'run.created'), 'run.created delivered via NATS');
      assert.ok(delivered.some((e) => e.runId === outcome.runId && e.eventType === 'run.completed'), 'run.completed delivered via NATS');
      await probe.unsubscribe();

      const report = await diagnose(config, { env, timeoutMs: 3000 });
      assert.deepEqual(report.checks.filter((c) => c.status === 'error'), []);
      assert.deepEqual(report.checks.filter((c) => ['store', 'bus', 'policy'].includes(c.name)).map((c) => [c.name, c.status]), [['store', 'ok'], ['bus', 'ok'], ['policy', 'ok']]);
    },
  );

  test(
    'Temporal durable runtime (embedded worker) over PostgreSQL: the tiny run reaches its verdict',
    skipUnless(!!infra.pgUrl && !!infra.temporalAddress, 'HYPERTEST_TEST_PG_URL / HYPERTEST_TEST_TEMPORAL_ADDRESS not set (run npm run infra:up)'),
    async () => {
      const { ht, target } = await fixture('temporal', { durable: { kind: 'temporal', address: infra.temporalAddress!, namespace: 'default', taskQueue: `ht-app-int-${suffix}` } });
      assert.equal(ht.durable.kind, 'temporal');
      const outcome = await ht.run({ goal: 'Is the sum module releasable?', target }, { timeoutMs: 180_000 });
      assert.equal(outcome.status, 'completed');
      assert.equal(outcome.decision!.verdict, 'pass');
      assert.equal((await ht.status(outcome.runId))!.runtimeManifestId, ht.manifest.manifestId);
    },
  );

  test(
    'doctor is read-only on PostgreSQL: a configured schema that does not exist is reported, never created',
    skipUnless(!!infra.pgUrl, 'HYPERTEST_TEST_PG_URL not set (run npm run infra:up)'),
    async () => {
      const dir = await tempDir('ht-app-int-doctor-');
      cleanups.push(dir.cleanup);
      const schema = `ht_app_int_absent_${suffix}`;
      cleanups.push(async () => {
        const db = await openDatabase({ kind: 'postgres', url: infra.pgUrl! });
        try {
          await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await db.close();
        }
      });
      const config: HypertestConfig = { ...scriptedConfig(dir.path), store: { kind: 'postgres', urlEnv: 'HT_INT_PG_URL', schema } };
      const report = await diagnose(config, { env: { HT_INT_PG_URL: infra.pgUrl! }, timeoutMs: 3000 });
      assert.deepEqual(report.checks.filter((c) => c.name === 'store'), [{ name: 'store', status: 'warn', detail: `PostgreSQL is reachable; schema ${schema} does not exist yet (created at the first start)` }]);
      const db = await openDatabase({ kind: 'postgres', url: infra.pgUrl! });
      try {
        const r = await db.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [schema]);
        assert.equal(r.rows.length, 0, 'doctor created nothing');
      } finally {
        await db.close();
      }
    },
  );
});

describe('H12: workers sharing one PostgreSQL store share environment generations', { concurrency: false }, () => {
  test(
    'a generation bump by worker A (a verified env.restart) makes worker B snapshot the new generation — separate data directories, no shared file',
    skipUnless(!!infra.pgUrl, 'HYPERTEST_TEST_PG_URL not set (run npm run infra:up)'),
    async () => {
      const schema = await freshSchema('h12');
      const secret = randomBytes(24).toString('hex');
      const environments = [{ environmentId: 'env-shared', environmentClass: 'sandbox', baseUrl: 'http://127.0.0.1:9', generation: 1 }];
      async function worker(tag: string): Promise<HypertestInstance> {
        const dir = await tempDir(`ht-app-int-h12-${tag}-`);
        cleanups.push(dir.cleanup);
        const env = { HT_INT_PG_URL: infra.pgUrl!, HT_INT_CAPABILITY_SECRET: secret };
        const config: HypertestConfig = {
          ...scriptedConfig(dir.path),
          store: { kind: 'postgres', urlEnv: 'HT_INT_PG_URL', schema },
          policy: { capabilitySecretEnv: 'HT_INT_CAPABILITY_SECRET' },
          environments: environments as never,
        };
        const ht = await createHypertest(config, { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger(), env, workerId: `worker:h12:${tag}` });
        cleanups.push(() => ht.close());
        return ht;
      }
      const a = await worker('a');
      const b = await worker('b');
      // A's env.restart adapter bumps the generation while verifying its operation (the durable, cross-process path)
      const bumped = await a.services.environments.bumpGenerationAsync!('env-shared', 'sha256:build-2', 'op_restart_1');
      assert.equal(bumped.generation, 2);
      // B never saw the bump in its own process; its freshness/snapshot resolver reads the shared store
      const run = await b.control.startRun({ goal: 'h12 freshness', target: { environmentId: 'env-shared' } });
      const snap = await b.control.snapshot(run.runId);
      const entry = snap.readSet.find((e) => e.resourceType === 'environment' && e.resourceId === 'env-shared');
      assert.ok(entry, 'the target environment is pinned');
      assert.equal(entry.observedVersion, '2:sha256:build-2', `snapshot pins generation 2, got ${entry.observedVersion}`);
      assert.equal((await b.services.environments.load!('env-shared'))!.generation, 2);
      // the same operation verified again by B does not bump twice
      assert.equal((await b.services.environments.bumpGenerationAsync!('env-shared', 'sha256:build-2', 'op_restart_1')).generation, 2);
      await b.cancel(run.runId, 'test done');
    },
  );
});

describe('durability-4: Temporal workers of one deployment share one identity', { concurrency: false }, () => {
  test(
    'a tick or an observation that lands on another worker process acts on the run (the run lease and the claims are the deployment\'s, not one process\'s)',
    skipUnless(!!infra.pgUrl, 'HYPERTEST_TEST_PG_URL not set (run npm run infra:up)'),
    async () => {
      const schema = await freshSchema('dur4');
      const secret = randomBytes(24).toString('hex');
      const repo = await sumRepo();
      cleanups.push(repo.cleanup);
      async function worker(tag: string): Promise<HypertestInstance> {
        const dir = await tempDir(`ht-app-int-dur4-${tag}-`);
        cleanups.push(dir.cleanup);
        const env = { HT_INT_PG_URL: infra.pgUrl!, HT_INT_CAPABILITY_SECRET: secret };
        const config: HypertestConfig = {
          ...scriptedConfig(dir.path, { gate: { requireIndependentReview: false } }),
          store: { kind: 'postgres', urlEnv: 'HT_INT_PG_URL', schema },
          policy: { capabilitySecretEnv: 'HT_INT_CAPABILITY_SECRET' },
          // external: nothing connects to Temporal here; the control planes are driven directly, as activities would be
          durable: { kind: 'temporal', address: '127.0.0.1:1', taskQueue: `dur4-${suffix}`, workerMode: 'external' },
        };
        const ht = await createHypertest(config, { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger(), env });
        cleanups.push(() => ht.close());
        return ht;
      }
      const a = await worker('a');
      const b = await worker('b');
      assert.equal(a.services.workerId, b.services.workerId);
      const run = await a.control.startRun({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } });
      const first = await a.control.tick(run.runId);
      assert.equal(first.dispatched.length, 1, 'worker A claimed the lead');
      // the next tick activity lands on worker B: it is not locked out by A's run lease (it used to be a no-op until the
      // lease expired — idle, nothing evaluated)
      const onB = await b.control.tick(run.runId);
      assert.equal(onB.convergence.state, 'active');
      assert.equal((onB.convergence as { running: number }).running, 1, 'B evaluated the run (it saw the claimed lead)');
      // …and B can run the turn A's tick dispatched (the claim belongs to the deployment's identity, fenced by its token)
      const d = first.dispatched[0]!;
      assert.notEqual((await b.control.executeTurn(d.workItemId, d.fencingToken)).status, 'lease_lost');
      await a.control.cancelRun(run.runId, 'test done');
    },
  );
});
