import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry } from '@hypertest/operation';
import { ToolRegistry, blackboxTools, builtinSideEffectAdapters, builtinTools, createEnvironmentRegistry, type ToolSpec } from '../src/index.ts';
import { fakeContext } from './blackbox-helpers.ts';

const envs = createEnvironmentRegistry([
  { environmentId: 'env_a', environmentClass: 'sandbox', generation: 3, baseUrl: 'http://10.0.0.5:8080/api', control: { kind: 'process', target: 'http://10.0.0.5:9000/__hypertest' } },
]);

test('blackboxTools: the catalog registers cleanly (ids, schemas) with the expected effect/risk classes', () => {
  const specs = blackboxTools({ stateDir: '/tmp/ht-state' });
  const registry = new ToolRegistry(specs);
  // (wave 3) + gRPC tools and the observation tools (logs, traces, packet capture)
  assert.deepEqual(registry.list().map((s) => s.id).sort(), [
    'db.introspect', 'env.deploy', 'env.inject_fault', 'env.restart', 'grpc.call', 'grpc.describe', 'grpc.query', 'http.request', 'load.observe', 'load.start', 'load.stop', 'logs.query', 'metrics.query', 'metrics.scrape',
    'net.capture', 'trace.query',
  ]);
  const byId = new Map(specs.map((s) => [s.id, s as ToolSpec]));
  const cls = (id: string, input: unknown) => {
    const s = byId.get(id)!;
    return [typeof s.effect === 'function' ? s.effect(input) : s.effect, typeof s.riskClass === 'function' ? s.riskClass(input) : s.riskClass];
  };
  assert.deepEqual(cls('metrics.query', {}), ['read', 'low']);
  assert.deepEqual(cls('metrics.scrape', {}), ['read', 'low']);
  assert.deepEqual(cls('load.start', {}), ['external', 'high']);
  assert.deepEqual(cls('load.observe', {}), ['read', 'low']);
  assert.deepEqual(cls('load.stop', {}), ['external', 'medium']);
  assert.deepEqual(cls('env.restart', {}), ['destructive', 'high']);
  assert.deepEqual(cls('env.inject_fault', {}), ['destructive', 'high']);
  assert.deepEqual(cls('env.deploy', {}), ['destructive', 'critical']);
  assert.deepEqual(cls('logs.query', {}), ['read', 'low']);
  assert.deepEqual(cls('db.introspect', {}), ['read', 'low']);
  assert.deepEqual(cls('trace.query', {}), ['read', 'low']);
  assert.deepEqual(cls('net.capture', {}), ['read', 'medium']);
  assert.deepEqual(cls('grpc.call', {}), ['external', 'medium']);
  assert.deepEqual(cls('grpc.query', {}), ['read', 'low']);
  assert.deepEqual(
    ['load.start', 'load.stop', 'env.restart', 'env.inject_fault', 'env.deploy'].map((id) => [id, byId.get(id)!.sideEffect?.adapterId, byId.get(id)!.sideEffect?.operationType]),
    [
      ['load.start', 'load.http', 'load.start'],
      ['load.stop', 'load.http.stop', 'load.stop'],
      ['env.restart', 'env.control', 'env.restart'],
      ['env.inject_fault', 'env.control', 'env.inject_fault'],
      ['env.deploy', 'env.control', 'env.deploy'],
    ],
  );
  assert.equal(blackboxTools({ stateDir: '/tmp/x', enableBrowser: true }).filter((s) => s.id.startsWith('browser.')).length, 5);
  // (wave 3, item 8) approval-gated tools describe the real loop: call the tool, approval_required waits for the human
  for (const id of ['env.restart', 'env.inject_fault', 'env.deploy']) {
    assert.match(byId.get(id)!.description, /returns approval_required and the work waits for a human decision on exactly this call \(do not file an approval yourself\)/, id);
    assert.doesNotMatch(byId.get(id)!.description, /request_approval/, id);
  }
});

test('resources and environment classes come from the registry; the target resource of env tools is env/<id>', () => {
  const byId = new Map(blackboxTools({ stateDir: '/tmp/x' }).map((s) => [s.id, s as ToolSpec]));
  const { ctx } = fakeContext({ environments: envs });
  const rctx = { workspace: ctx.workspace, runId: ctx.runId, environments: envs };
  assert.deepEqual(byId.get('env.restart')!.resources({ environmentId: 'env_a', reason: 'r' }, rctx), ['env/env_a']);
  assert.equal(byId.get('env.restart')!.environmentClass!({ environmentId: 'env_a' }, { environments: envs }), 'sandbox');
  assert.deepEqual(byId.get('env.restart')!.sideEffect!.target({ environmentId: 'env_a' }, ctx), { resourceKey: 'env/env_a', kind: 'environment' });
  assert.deepEqual(byId.get('load.start')!.resources({ environmentId: 'env_a', path: '/p', method: 'GET', ratePerSecond: 1, durationMs: 100 }, rctx), ['env/env_a', 'loadgen/10.0.0.5:8080']);
  assert.deepEqual(byId.get('load.start')!.resources({ targetUrl: 'http://127.0.0.1:9/x', method: 'GET', ratePerSecond: 1, durationMs: 100 }, rctx), ['url/127.0.0.1:9', 'loadgen/127.0.0.1:9']);
  assert.equal(byId.get('load.start')!.environmentClass!({ targetUrl: 'http://127.0.0.1:9/x' }, { environments: envs }), 'local');
  assert.equal(byId.get('load.start')!.environmentClass!({ targetUrl: 'http://10.0.0.5:8080/x' }, { environments: envs }), 'sandbox', 'a URL on a registered environment gets its class');
  assert.equal(byId.get('load.start')!.environmentClass!({ targetUrl: 'https://internet.example/x' }, { environments: envs }), undefined);
  assert.throws(() => byId.get('env.restart')!.environmentClass!({ environmentId: 'env_missing' }, { environments: envs }), /not registered/);
});

test('side-effect-bound tools never execute outside the runtime gateway', async () => {
  const { ctx } = fakeContext({ environments: envs });
  for (const s of blackboxTools({ stateDir: '/tmp/x' }).filter((t) => t.sideEffect)) {
    const out = await s.execute({}, ctx);
    assert.equal(out.status, 'failed', s.id);
    assert.equal(out.error?.code, 'precondition_failed', s.id);
  }
});

test('builtinSideEffectAdapters register in the AdapterRegistry with the declared capabilities', () => {
  const adapters = builtinSideEffectAdapters({ stateDir: '/tmp/x', environments: envs, docker: '/usr/bin/false', kubectl: '/usr/bin/false' });
  const registry = new AdapterRegistry(adapters);
  assert.deepEqual(registry.list().map((a) => a.adapterId), ['load.http', 'load.http.stop', 'env.control', 'env.process', 'env.docker', 'env.kubectl', 'tool.effect', 'tool.effect.resendable']);
  const caps = Object.fromEntries(registry.list().map((a) => [a.adapterId, a.capabilities]));
  assert.deepEqual(caps['load.http'], { supportsNativeIdempotency: true, supportsExternalLookupByOperationId: true, supportsFencing: false, supportsCompensation: true, reconciliationClass: 'deterministic', riskClass: 'high' });
  assert.deepEqual(caps['env.docker'], { supportsNativeIdempotency: false, supportsExternalLookupByOperationId: false, supportsFencing: false, supportsCompensation: false, reconciliationClass: 'best_effort', riskClass: 'high' });
  assert.equal(caps['env.kubectl']!.supportsExternalLookupByOperationId, true);
  assert.equal(caps['env.process']!.reconciliationClass, 'deterministic');
  // conformance-7: the record-only adapters — an unknown outcome is never blindly retried (manual review), except a
  // resend the target deduplicates
  assert.deepEqual(caps['tool.effect'], { supportsNativeIdempotency: false, supportsExternalLookupByOperationId: false, supportsFencing: false, supportsCompensation: false, reconciliationClass: 'non_reconcilable', riskClass: 'high' });
  assert.deepEqual(caps['tool.effect.resendable'], { supportsNativeIdempotency: true, supportsExternalLookupByOperationId: true, supportsFencing: false, supportsCompensation: false, reconciliationClass: 'best_effort', riskClass: 'medium' });
});

test('the white-box builtinTools() coordination point includes the black-box catalog', () => {
  const ids = builtinTools({ sandbox: {} as never, workspaces: {} as never }).map((s) => s.id);
  for (const id of ['http.request', 'metrics.query', 'metrics.scrape', 'load.start', 'load.observe', 'load.stop', 'env.restart', 'env.inject_fault', 'env.deploy']) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids across both halves');
});
