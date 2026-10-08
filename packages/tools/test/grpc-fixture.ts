// gRPC fixture server for the grpc.* tool tests (not a test file): the shop.Catalog service of fixtures/shop.proto on an
// ephemeral loopback port, with an optional server-reflection service (grpc.reflection.v1) implemented over the same
// protobufjs root. Records every call (method, request, metadata) it served.
import { fileURLToPath } from 'node:url';
import * as grpcNs from '@grpc/grpc-js';
import protobufNs from 'protobufjs';
import 'protobufjs/ext/descriptor/index.js';

const grpc = ((grpcNs as unknown as { default?: typeof grpcNs }).default ?? grpcNs) as typeof grpcNs;
const protobuf = protobufNs as unknown as typeof import('protobufjs');

export const SHOP_PROTO = fileURLToPath(new URL('./fixtures/shop.proto', import.meta.url));

export interface GrpcFixture {
  target: string;
  calls: Array<{ method: string; request: Record<string, unknown>; metadata: Record<string, string> }>;
  close(): Promise<void>;
}

const REFLECTION = {
  nested: {
    r: {
      nested: {
        Req: { oneofs: { m: { oneof: ['fileByFilename', 'fileContainingSymbol', 'listServices'] } }, fields: { host: { type: 'string', id: 1 }, fileByFilename: { type: 'string', id: 3 }, fileContainingSymbol: { type: 'string', id: 4 }, listServices: { type: 'string', id: 7 } } },
        Res: { fields: { validHost: { type: 'string', id: 1 }, originalRequest: { type: 'Req', id: 2 }, fileDescriptorResponse: { type: 'Fdr', id: 4 }, listServicesResponse: { type: 'Lsr', id: 6 }, errorResponse: { type: 'Err', id: 7 } } },
        Fdr: { fields: { fileDescriptorProto: { rule: 'repeated', type: 'bytes', id: 1 } } },
        Lsr: { fields: { service: { rule: 'repeated', type: 'Svc', id: 1 } } },
        Svc: { fields: { name: { type: 'string', id: 1 } } },
        Err: { fields: { errorCode: { type: 'int32', id: 1 }, errorMessage: { type: 'string', id: 2 } } },
      },
    },
  },
};

export async function startGrpcFixture(options: { reflection?: boolean } = {}): Promise<GrpcFixture> {
  const root = await new protobuf.Root().load(SHOP_PROTO, { keepCase: true });
  root.resolveAll();
  const calls: GrpcFixture['calls'] = [];
  const server = new grpc.Server();
  const type = (n: string) => root.lookupType(n);
  const handler = (method: string, reqType: string, resType: string, impl: (req: Record<string, unknown>) => Record<string, unknown> | { error: { code: number; details: string } } | Promise<never>) =>
    server.register(
      `/shop.Catalog/${method}`,
      (call: grpcNs.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>, callback: grpcNs.sendUnaryData<Record<string, unknown>>) => {
        const metadata: Record<string, string> = {};
        for (const [k, v] of Object.entries(call.metadata.getMap())) metadata[k] = String(v);
        calls.push({ method, request: call.request, metadata });
        Promise.resolve(impl(call.request)).then(
          (out) => {
            if ('error' in out) callback({ code: (out.error as { code: number }).code, details: (out.error as { details: string }).details } as grpcNs.ServiceError, null);
            else callback(null, out as Record<string, unknown>);
          },
          () => undefined,
        );
      },
      (m: Record<string, unknown>) => Buffer.from(type(resType).encode(type(resType).fromObject(m)).finish()),
      (b: Buffer) => type(reqType).toObject(type(reqType).decode(b), { longs: String, defaults: true }) as Record<string, unknown>,
      'unary',
    );
  handler('GetPrice', 'shop.PriceRequest', 'shop.PriceReply', (req) => {
    if (req['sku'] !== 'apple') return { error: { code: grpc.status.NOT_FOUND, details: `unknown sku ${String(req['sku'])}` } };
    return { sku: 'apple', total_cents: 120 * Number(req['qty']) };
  });
  handler('PlaceOrder', 'shop.OrderRequest', 'shop.OrderReply', (req) => ({ order_id: `ord-${calls.length}`, status: `placed ${String(req['qty'])} ${String(req['sku'])}` }));
  handler('Slow', 'shop.PriceRequest', 'shop.PriceReply', () => new Promise<never>(() => undefined));

  if (options.reflection) {
    const refl = protobuf.Root.fromJSON(REFLECTION);
    const Req = refl.lookupType('r.Req');
    const Res = refl.lookupType('r.Res');
    const set = (root as unknown as { toDescriptor(syntax: string): { file: unknown[] } }).toDescriptor('proto3');
    const FileDescriptorProto = (protobuf as unknown as { descriptor: { FileDescriptorProto: { encode(m: unknown): { finish(): Uint8Array } } } }).descriptor.FileDescriptorProto;
    const files = set.file.map((f) => Buffer.from(FileDescriptorProto.encode(f).finish()));
    server.register(
      '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo',
      (stream: grpcNs.ServerDuplexStream<Record<string, unknown>, Record<string, unknown>>) => {
        stream.on('data', (req: Record<string, unknown>) => {
          if (req['listServices'] !== undefined) stream.write({ listServicesResponse: { service: [{ name: 'shop.Catalog' }, { name: 'grpc.reflection.v1.ServerReflection' }] } });
          else if (req['fileContainingSymbol'] !== undefined || req['fileByFilename'] !== undefined) stream.write({ fileDescriptorResponse: { fileDescriptorProto: files } });
          else stream.write({ errorResponse: { errorCode: 12, errorMessage: 'unsupported request' } });
        });
        stream.on('end', () => stream.end());
      },
      (m: Record<string, unknown>) => Buffer.from(Res.encode(Res.fromObject(m)).finish()),
      (b: Buffer) => Req.toObject(Req.decode(b)) as Record<string, unknown>,
      'bidi',
    );
  }
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
  return {
    target: `127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((r) => server.tryShutdown(() => r())).then(() => server.forceShutdown()),
  };
}
