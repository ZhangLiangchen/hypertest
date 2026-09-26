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
import { createHypertest, diagnose, type HypertestConfig, type HypertestInstance } from '../src/index.ts';
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
      assert.match(ht.services.policy.revision, new RegExp(`^builtin:[0-9a-f]{16}\\+opa:hypertest/${pkg}$`));

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
