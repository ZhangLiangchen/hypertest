/**
 * (row 246/249: HTTP/gRPC) The gRPC tools against a real grpc-js server (fixtures/shop.proto): definitions from the
 * operator's .proto files or the server's reflection service; grpc.query sends only methods the environment declares
 * read-only (anything else is refused before it is sent); grpc.call is an external effect the runtime ledgers (the call
 * carries `idempotency-key: <operationId>`); every exchange is grpc-response evidence; a non-OK status is a result; the
 * call's own deadline is a timeout.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createEnvironmentRegistry, grpcTools, type EnvironmentDescriptor, type ToolSpec } from '../src/index.ts';
import { fakeContext, newGateway, newRuntime, openBlackboxEnv, toolRequest, type BlackboxEnv } from './blackbox-helpers.ts';
import { SHOP_PROTO, startGrpcFixture, type GrpcFixture } from './grpc-fixture.ts';

describe('grpc.* tools', () => {
  let server: GrpcFixture;
  let reflecting: GrpcFixture;
  let env: BlackboxEnv;
  let tools: Map<string, ToolSpec>;
  let shop: EnvironmentDescriptor;

  before(async () => {
    server = await startGrpcFixture();
    reflecting = await startGrpcFixture({ reflection: true });
    shop = { environmentId: 'shop', environmentClass: 'local', generation: 1, grpc: { target: server.target, protoFiles: [SHOP_PROTO], readMethods: ['shop.Catalog/Get*', 'shop.Catalog/Slow'] } };
    env = await openBlackboxEnv({ environments: [shop, { environmentId: 'shop-refl', environmentClass: 'local', generation: 1, grpc: { target: reflecting.target, reflection: true, readMethods: ['shop.Catalog/GetPrice'] } }, { environmentId: 'plain', environmentClass: 'local', generation: 1, baseUrl: 'http://127.0.0.1:1' }] });
    tools = new Map(grpcTools().map((t) => [t.id, t]));
  });
  after(async () => {
    await server?.close();
    await reflecting?.close();
    await env?.dispose();
  });

  test('grpc.query: a declared read is sent, decoded and recorded as grpc-response evidence anchored to the environment', async () => {
    const runtime = newRuntime(env, [...tools.values()]);
    const r = await runtime.execute(toolRequest('grpc.query', { environmentId: 'shop', method: 'shop.Catalog/GetPrice', request: { sku: 'apple', qty: 3 }, metadata: { authorization: 'Bearer hidden-token' } }));
    assert.equal(r.status, 'success', r.modelText);
    assert.deepEqual((r.structured as { response: unknown }).response, { sku: 'apple', total_cents: '360' });
    assert.equal((r.structured as { status: { name: string } }).status.name, 'OK');
    const [ev] = await env.evidence.getMany(r.evidenceRefs);
    assert.equal(ev!.evidenceType, 'grpc-response');
    assert.equal(ev!.environment?.environmentId, 'shop');
    const rec = ev!.structured as { method: string; read: boolean; metadata: Record<string, string>; request: unknown };
    assert.deepEqual([rec.method, rec.read, rec.metadata['authorization']], ['shop.Catalog/GetPrice', true, '[REDACTED]']);
    assert.equal(server.calls.at(-1)?.metadata['authorization'], 'Bearer hidden-token', 'the metadata reached the server');
    assert.equal(server.calls.at(-1)?.metadata['idempotency-key'], undefined, 'reads carry no idempotency key');
  });

  test('grpc.query refuses a method the environment does not declare read-only (nothing is sent)', async () => {
    const before = server.calls.length;
    const r = await newRuntime(env, [...tools.values()]).execute(toolRequest('grpc.query', { environmentId: 'shop', method: 'shop.Catalog/PlaceOrder', request: { sku: 'apple', qty: 1 } }));
    assert.equal(r.status, 'failed');
    assert.equal(r.error?.code, 'permission_denied');
    assert.equal(server.calls.length, before);
  });

  test('grpc.call: a write is one ledgered operation; the server sees idempotency-key = operation id', async () => {
    const { gateway, ledger } = newGateway(env, []);
    const runtime = newRuntime(env, [...tools.values()], gateway);
    const req = toolRequest('grpc.call', { environmentId: 'shop', method: 'shop.Catalog/PlaceOrder', request: { sku: 'pear', qty: 2 } });
    const r = await runtime.execute(req);
    assert.equal(r.status, 'success', r.modelText);
    assert.ok(r.operationId, 'the call ran as an operation');
    const op = await ledger.get(r.operationId!);
    assert.equal(op?.status, 'verified');
    assert.equal(server.calls.at(-1)?.metadata['idempotency-key'], r.operationId);
    // a durable replay of the same invocation answers from the ledger; the server is not called again
    const calls = server.calls.length;
    const again = await runtime.execute({ ...req, signal: new AbortController().signal });
    assert.equal(again.status, 'success');
    assert.equal(server.calls.length, calls);
  });

  test('a non-OK status is the server\'s answer (success with the status); unknown methods and missing endpoints fail', async () => {
    const { ctx } = fakeContext({ environments: env.environments });
    const missing = await tools.get('grpc.query')!.execute({ environmentId: 'shop', method: 'shop.Catalog/GetPrice', request: { sku: 'kiwi', qty: 1 } }, ctx);
    assert.equal(missing.status, 'success');
    assert.equal((missing.structured as { status: { name: string; details: string } }).status.name, 'NOT_FOUND');
    assert.match((missing.structured as { status: { details: string } }).status.details, /unknown sku kiwi/);
    const unknown = await tools.get('grpc.call')!.execute({ environmentId: 'shop', method: 'shop.Catalog/Refund', request: {} }, ctx);
    assert.equal(unknown.error?.code, 'invalid_argument');
    const plain = await tools.get('grpc.call')!.execute({ environmentId: 'plain', method: 'shop.Catalog/GetPrice' }, ctx);
    assert.equal(plain.error?.code, 'precondition_failed');
    const badRequest = await tools.get('grpc.query')!.execute({ environmentId: 'shop', method: 'shop.Catalog/GetPrice', request: { qty: 'many' } }, ctx);
    assert.equal(badRequest.error?.code, 'invalid_argument');
  });

  test('the call\'s own deadline is a timeout (with evidence of the attempt)', async () => {
    const { ctx, evidence } = fakeContext({ environments: env.environments });
    const r = await tools.get('grpc.query')!.execute({ environmentId: 'shop', method: 'shop.Catalog/Slow', request: { sku: 'apple', qty: 1 }, timeoutMs: 200 }, ctx);
    assert.equal(r.status, 'timeout');
    assert.equal((evidence.at(-1)!.input.structured as { status: { name: string } }).status.name, 'DEADLINE_EXCEEDED');
  });

  test('server reflection: grpc.describe lists the services; grpc.query encodes from the reflected definitions', async () => {
    const { ctx } = fakeContext({ environments: env.environments });
    const d = await tools.get('grpc.describe')!.execute({ environmentId: 'shop-refl' }, ctx);
    assert.equal(d.status, 'success', JSON.stringify(d.error));
    const services = (d.structured as { services: Array<{ service: string; methods: Array<{ name: string; read: boolean }> }> }).services;
    assert.deepEqual(services.map((s) => s.service), ['shop.Catalog']);
    assert.deepEqual(services[0]!.methods.map((m) => [m.name, m.read]), [['GetPrice', true], ['PlaceOrder', false], ['Slow', false]]);
    const r = await tools.get('grpc.query')!.execute({ environmentId: 'shop-refl', method: 'shop.Catalog/GetPrice', request: { sku: 'apple', qty: 2 } }, ctx);
    assert.equal(r.status, 'success', JSON.stringify(r.error));
    assert.equal((r.structured as { response: { total_cents?: string; totalCents?: string } }).response.total_cents ?? (r.structured as { response: { totalCents?: string } }).response.totalCents, '240');
    assert.equal(reflecting.calls.at(-1)?.method, 'GetPrice');
  });

  test('classification: grpc.call is external on env/<id>, grpc.query and grpc.describe read', () => {
    const ctx = { workspace: undefined as never, runId: 'r', environments: createEnvironmentRegistry([shop]) };
    for (const [id, effect] of [['grpc.call', 'external'], ['grpc.query', 'read'], ['grpc.describe', 'read']] as const) {
      const t = tools.get(id)!;
      assert.equal(t.effect, effect, id);
      assert.deepEqual(t.resources({ environmentId: 'shop', method: 'shop.Catalog/GetPrice' }, ctx), ['env/shop']);
      assert.equal(t.environmentClass!({ environmentId: 'shop', method: 'x/y' }, { environments: ctx.environments }), 'local');
    }
  });
});
