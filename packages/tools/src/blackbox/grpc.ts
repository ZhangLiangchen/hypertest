import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { HypertestError, abortReason, sha256Hex, type JsonSchema, type JsonValue } from '@hypertest/core';
import type { EnvironmentDescriptor, ToolContext, ToolOutcome, ToolSpec } from '../contracts.ts';
import { ENV_ID_SCHEMA, errorMessage, redactHeaders, requireEnvironment } from './common.ts';
import { redactSecrets } from '../whitebox/runtime.ts';

/**
 * gRPC black-box tools (technology-selection §Tool Runtime "HTTP/gRPC"): `grpc.call` — one unary call to the gRPC endpoint
 * a registered environment declares (`EnvironmentDescriptor.grpc.target`; agents never name hosts), with the request
 * given as JSON and encoded from the service definition: the operator's `.proto` files (`grpc.protoFiles`) or, with
 * `grpc.reflection: true`, the server's own reflection service (grpc.reflection.v1, falling back to v1alpha). Every call
 * records `grpc-response` evidence (method, redacted request and metadata, status code and details, the decoded response).
 * A non-OK status is the server's answer — a successful tool call with the status in the result, like an HTTP 4xx/5xx —
 * except a deadline the call itself set (`timeout`). Methods the operator lists in `grpc.readMethods` are reads; every
 * other method is an external effect: the runtime ledgers it (record-only adapter) and the call carries
 * `idempotency-key: <operationId>` metadata. `grpc.describe` lists the services and methods (read, no evidence).
 */

/** Bytes of a decoded response kept inline in the evidence payload (the artifact holds it all). */
const GRPC_EVIDENCE_LIMIT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_.]*\/[A-Za-z_][A-Za-z0-9_]*$/;

export const GRPC_STATUS_NAMES: readonly string[] = Object.freeze([
  'OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION',
  'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED',
]);

export interface GrpcCallInput {
  environmentId: string;
  /** `package.Service/Method`. */
  method: string;
  request?: Record<string, JsonValue>;
  metadata?: Record<string, string>;
  timeoutMs?: number;
}

/** Glob of `readMethods` (`pkg.Service/Get*`, `pkg.Service/*`). */
function methodMatches(pattern: string, method: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return method.startsWith(pattern.slice(0, -1));
  return pattern === method;
}

function grpcConfig(env: EnvironmentDescriptor): NonNullable<EnvironmentDescriptor['grpc']> {
  if (!env.grpc || typeof env.grpc.target !== 'string' || env.grpc.target === '') throw new HypertestError('precondition_failed', `environment ${env.environmentId} declares no gRPC endpoint (grpc.target)`);
  return env.grpc;
}

/** True when the operator declared the method a read (`grpc.readMethods`). */
export function grpcMethodIsRead(env: EnvironmentDescriptor | undefined, method: string): boolean {
  return (env?.grpc?.readMethods ?? []).some((p) => methodMatches(p, method));
}

type ProtobufModule = typeof import('protobufjs');
type ProtoRoot = import('protobufjs').Root;
type GrpcModule = typeof import('@grpc/grpc-js');

let modules: Promise<{ protobuf: ProtobufModule; grpc: GrpcModule }> | undefined;
async function load(): Promise<{ protobuf: ProtobufModule; grpc: GrpcModule }> {
  modules ??= (async () => {
    const protobuf = ((await import('protobufjs')) as unknown as { default?: ProtobufModule }).default ?? ((await import('protobufjs')) as unknown as ProtobufModule);
    // registers Root.fromDescriptor on the same protobufjs instance
    await import('protobufjs/ext/descriptor/index.js');
    const grpc = ((await import('@grpc/grpc-js')) as unknown as { default?: GrpcModule }).default ?? ((await import('@grpc/grpc-js')) as unknown as GrpcModule);
    return { protobuf, grpc };
  })();
  return modules;
}

/** The server-reflection messages (grpc.reflection.v1 / v1alpha share the wire format). */
const REFLECTION_JSON = {
  nested: {
    reflection: {
      nested: {
        ServerReflectionRequest: {
          oneofs: { messageRequest: { oneof: ['fileByFilename', 'fileContainingSymbol', 'listServices'] } },
          fields: { host: { type: 'string', id: 1 }, fileByFilename: { type: 'string', id: 3 }, fileContainingSymbol: { type: 'string', id: 4 }, listServices: { type: 'string', id: 7 } },
        },
        ServerReflectionResponse: {
          fields: {
            validHost: { type: 'string', id: 1 },
            fileDescriptorResponse: { type: 'FileDescriptorResponse', id: 4 },
            listServicesResponse: { type: 'ListServiceResponse', id: 6 },
            errorResponse: { type: 'ErrorResponse', id: 7 },
          },
        },
        FileDescriptorResponse: { fields: { fileDescriptorProto: { rule: 'repeated', type: 'bytes', id: 1 } } },
        ListServiceResponse: { fields: { service: { rule: 'repeated', type: 'ServiceResponse', id: 1 } } },
        ServiceResponse: { fields: { name: { type: 'string', id: 1 } } },
        ErrorResponse: { fields: { errorCode: { type: 'int32', id: 1 }, errorMessage: { type: 'string', id: 2 } } },
      },
    },
  },
};

/** The definitions of an environment's services, cached per environment and generation (a redeploy re-reads them). */
export class GrpcDefinitions {
  readonly #cache = new Map<string, Promise<ProtoRoot>>();

  root(env: EnvironmentDescriptor, signal?: AbortSignal): Promise<ProtoRoot> {
    const cfg = grpcConfig(env);
    const key = `${env.environmentId}\u0000${env.generation}\u0000${cfg.target}`;
    let pending = this.#cache.get(key);
    if (!pending) {
      pending = (cfg.protoFiles && cfg.protoFiles.length > 0 ? this.#fromProtoFiles(cfg) : cfg.reflection === true ? this.#fromReflection(env, signal) : Promise.reject(new HypertestError('precondition_failed', `environment ${env.environmentId}: grpc needs protoFiles or reflection: true`)));
      pending.catch(() => this.#cache.delete(key));
      this.#cache.set(key, pending);
    }
    return pending;
  }

  async #fromProtoFiles(cfg: NonNullable<EnvironmentDescriptor['grpc']>): Promise<ProtoRoot> {
    const { protobuf } = await load();
    const root = new protobuf.Root();
    const includeDirs = cfg.includeDirs ?? [];
    if (includeDirs.length > 0) {
      const original = root.resolvePath.bind(root);
      root.resolvePath = (origin: string, target: string) => {
        for (const dir of includeDirs) {
          const candidate = `${dir.replace(/\/+$/, '')}/${target}`;
          if (existsSync(candidate)) return candidate;
        }
        return original(origin, target);
      };
    }
    try {
      await root.load(cfg.protoFiles!, { keepCase: true });
      root.resolveAll();
    } catch (e) {
      throw new HypertestError('precondition_failed', `the gRPC definitions could not be loaded: ${errorMessage(e)}`, { cause: e });
    }
    return root;
  }

  async #fromReflection(env: EnvironmentDescriptor, signal?: AbortSignal): Promise<ProtoRoot> {
    const { protobuf, grpc } = await load();
    const cfg = grpcConfig(env);
    const refl = protobuf.Root.fromJSON(REFLECTION_JSON);
    const Req = refl.lookupType('reflection.ServerReflectionRequest');
    const Res = refl.lookupType('reflection.ServerReflectionResponse');
    const client = new grpc.Client(cfg.target, cfg.tls === true ? grpc.credentials.createSsl() : grpc.credentials.createInsecure());
    try {
      const ask = async (version: 'v1' | 'v1alpha', requests: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> =>
        new Promise((resolve, reject) => {
          const call = client.makeBidiStreamRequest(
            `/grpc.reflection.${version}.ServerReflection/ServerReflectionInfo`,
            (m: Record<string, unknown>) => Buffer.from(Req.encode(Req.fromObject(m)).finish()),
            (b: Buffer) => Res.toObject(Res.decode(b), { bytes: Buffer as unknown as StringConstructor, defaults: false }) as Record<string, unknown>,
            new grpc.Metadata(),
            { deadline: Date.now() + 15_000 },
          );
          const out: Array<Record<string, unknown>> = [];
          const onAbort = () => call.cancel();
          signal?.addEventListener('abort', onAbort, { once: true });
          call.on('data', (d: Record<string, unknown>) => out.push(d));
          call.on('error', (e: Error) => {
            signal?.removeEventListener('abort', onAbort);
            reject(e);
          });
          call.on('end', () => {
            signal?.removeEventListener('abort', onAbort);
            resolve(out);
          });
          for (const r of requests) call.write(r);
          call.end();
        });
      let version: 'v1' | 'v1alpha' = 'v1';
      let listed: Array<Record<string, unknown>>;
      try {
        listed = await ask('v1', [{ listServices: '*' }]);
      } catch (e) {
        if ((e as { code?: number }).code !== grpc.status.UNIMPLEMENTED) throw e;
        version = 'v1alpha';
        listed = await ask('v1alpha', [{ listServices: '*' }]);
      }
      const services = ((listed[0]?.['listServicesResponse'] as { service?: Array<{ name: string }> } | undefined)?.service ?? []).map((s) => s.name).filter((n) => !n.startsWith('grpc.reflection.'));
      const files = new Map<string, Uint8Array>();
      const decodeFiles = (responses: Array<Record<string, unknown>>) => {
        for (const r of responses) {
          const err = r['errorResponse'] as { errorMessage?: string } | undefined;
          if (err) throw new HypertestError('unavailable', `gRPC reflection error: ${err.errorMessage ?? 'unknown'}`);
          for (const bytes of ((r['fileDescriptorResponse'] as { fileDescriptorProto?: Uint8Array[] } | undefined)?.fileDescriptorProto ?? [])) {
            const fd = (protobuf as unknown as { descriptor: { FileDescriptorProto: { decode(b: Uint8Array): { name?: string; dependency?: string[] } } } }).descriptor.FileDescriptorProto.decode(bytes);
            if (fd.name && !files.has(fd.name)) files.set(fd.name, bytes);
          }
        }
      };
      decodeFiles(await ask(version, services.map((s) => ({ fileContainingSymbol: s }))));
      // dependencies the server did not send with them (well-known types are built in)
      for (let round = 0; round < 8; round++) {
        const descriptor = (protobuf as unknown as { descriptor: { FileDescriptorProto: { decode(b: Uint8Array): { dependency?: string[] } } } }).descriptor;
        const missing = [...new Set([...files.values()].flatMap((b) => descriptor.FileDescriptorProto.decode(b).dependency ?? []))].filter((d) => !files.has(d) && !d.startsWith('google/protobuf/'));
        if (missing.length === 0) break;
        decodeFiles(await ask(version, missing.map((f) => ({ fileByFilename: f }))));
      }
      const set = { file: [...files.values()].map((b) => (protobuf as unknown as { descriptor: { FileDescriptorProto: { decode(b: Uint8Array): unknown } } }).descriptor.FileDescriptorProto.decode(b)) };
      const root = (protobuf.Root as unknown as { fromDescriptor(set: unknown): ProtoRoot }).fromDescriptor(set);
      root.resolveAll();
      return root;
    } catch (e) {
      if (e instanceof HypertestError) throw e;
      throw new HypertestError('unavailable', `gRPC server reflection of ${cfg.target} failed: ${errorMessage(e)}`, { cause: e });
    } finally {
      client.close();
    }
  }
}

/** Services (full names) and their methods of a definitions root. */
export function grpcServices(root: ProtoRoot): Array<{ service: string; methods: Array<{ name: string; requestType: string; responseType: string; requestStream: boolean; responseStream: boolean }> }> {
  const out: Array<{ service: string; methods: Array<{ name: string; requestType: string; responseType: string; requestStream: boolean; responseStream: boolean }> }> = [];
  const walk = (ns: { nestedArray?: unknown[] }) => {
    for (const n of ns.nestedArray ?? []) {
      const node = n as { constructor: { name: string }; fullName: string; methodsArray?: Array<{ name: string; requestType: string; responseType: string; requestStream?: boolean; responseStream?: boolean; resolvedRequestType?: { fullName: string } | null; resolvedResponseType?: { fullName: string } | null }>; nestedArray?: unknown[] };
      if (Array.isArray(node.methodsArray)) {
        out.push({
          service: node.fullName.replace(/^\./, ''),
          methods: node.methodsArray.map((m) => ({
            name: m.name, requestType: (m.resolvedRequestType?.fullName ?? m.requestType).replace(/^\./, ''), responseType: (m.resolvedResponseType?.fullName ?? m.responseType).replace(/^\./, ''),
            requestStream: m.requestStream === true, responseStream: m.responseStream === true,
          })),
        });
      }
      if (Array.isArray(node.nestedArray)) walk(node);
    }
  };
  walk(root as unknown as { nestedArray?: unknown[] });
  return out.sort((a, b) => (a.service < b.service ? -1 : 1));
}

const GRPC_CALL_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['environmentId', 'method'],
  properties: {
    environmentId: { ...ENV_ID_SCHEMA, description: 'Registered environment whose gRPC endpoint is called.' },
    method: { type: 'string', pattern: METHOD_RE.source, maxLength: 512, description: 'Full method name: package.Service/Method (see grpc.describe).' },
    request: { type: 'object', description: 'The request message as JSON (field names as in the .proto).' },
    metadata: { type: 'object', additionalProperties: { type: 'string', maxLength: 8192 }, maxProperties: 50 },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 300_000 },
  },
};

/**
 * The gRPC tools: `grpc.call` (external/medium — any unary method; ledgered by the runtime), `grpc.query` (read/low — only
 * the methods the operator declared read in `grpc.readMethods`; any other method is refused before anything is sent) and
 * `grpc.describe` (read).
 */
export function grpcTools(options: { definitions?: GrpcDefinitions } = {}): ToolSpec[] {
  const definitions = options.definitions ?? new GrpcDefinitions();

  const call: ToolSpec<GrpcCallInput> = {
    id: 'grpc.call',
    title: 'gRPC unary call',
    description:
      'Call one unary gRPC method on a registered environment\'s gRPC endpoint (method = package.Service/Method, request as JSON) and record the exchange as grpc-response evidence. A state-changing call: it runs as a ledgered operation of an active experiment. A non-OK status is a result, not an error. For methods the environment declares read-only use grpc.query; see grpc.describe.',
    inputSchema: GRPC_CALL_SCHEMA,
    effect: 'external',
    riskClass: 'medium',
    resources: (input) => [`env/${input.environmentId}`],
    environmentClass: (input, ctx) => requireEnvironment(ctx.environments, input.environmentId).environmentClass,
    evidenceTypes: ['grpc-response'],
    timeoutMs: 300_000,
    execute: (input, ctx) => executeGrpcCall(definitions, input, ctx, false),
  };

  const query: ToolSpec<GrpcCallInput> = {
    id: 'grpc.query',
    title: 'gRPC read-only call',
    description:
      'Call one unary gRPC method that the environment declares read-only (grpc.readMethods) and record the exchange as grpc-response evidence. Any other method is refused (use grpc.call).',
    inputSchema: GRPC_CALL_SCHEMA,
    effect: 'read',
    riskClass: 'low',
    resources: (input) => [`env/${input.environmentId}`],
    environmentClass: (input, ctx) => requireEnvironment(ctx.environments, input.environmentId).environmentClass,
    evidenceTypes: ['grpc-response'],
    timeoutMs: 300_000,
    execute: (input, ctx) => executeGrpcCall(definitions, input, ctx, true),
  };

  const describe: ToolSpec<{ environmentId: string; service?: string }> = {
    id: 'grpc.describe',
    title: 'gRPC: describe services',
    description: 'List the gRPC services and methods of a registered environment (from its .proto files or server reflection), with request/response types.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['environmentId'], properties: { environmentId: ENV_ID_SCHEMA, service: { type: 'string', maxLength: 512 } } },
    effect: 'read',
    riskClass: 'low',
    resources: (input) => [`env/${input.environmentId}`],
    environmentClass: (input, ctx) => requireEnvironment(ctx.environments, input.environmentId).environmentClass,
    evidenceTypes: [],
    timeoutMs: 60_000,
    async execute(input, ctx) {
      try {
        const env = requireEnvironment(ctx.environments, input.environmentId);
        const root = await definitions.root(env, ctx.signal);
        const services = grpcServices(root).filter((s) => input.service === undefined || s.service === input.service);
        const readMethods = env.grpc?.readMethods ?? [];
        const structured = { target: env.grpc!.target, services: services.map((s) => ({ ...s, methods: s.methods.map((m) => ({ ...m, read: readMethods.some((p) => methodMatches(p, `${s.service}/${m.name}`)) })) })) };
        return { status: 'success', structured: structured as unknown as JsonValue };
      } catch (e) {
        if (ctx.signal.aborted) throw abortReason(ctx.signal);
        if (e instanceof HypertestError) return { status: 'failed', error: { code: e.code, message: e.message } };
        return { status: 'failed', error: { code: 'unavailable', message: errorMessage(e) } };
      }
    },
  };
  return [call, query, describe] as ToolSpec[];
}

async function executeGrpcCall(definitions: GrpcDefinitions, input: GrpcCallInput, ctx: ToolContext, readOnly: boolean): Promise<ToolOutcome> {
  let env: EnvironmentDescriptor;
  let root: ProtoRoot;
  try {
    env = requireEnvironment(ctx.environments, input.environmentId);
    grpcConfig(env);
    root = await definitions.root(env, ctx.signal);
  } catch (e) {
    if (ctx.signal.aborted) throw abortReason(ctx.signal);
    if (e instanceof HypertestError) return { status: 'failed', error: { code: e.code, message: e.message } };
    return { status: 'failed', error: { code: 'unavailable', message: errorMessage(e) } };
  }
  const cfg = env.grpc!;
  const read = grpcMethodIsRead(env, input.method);
  // classification is the operator's: grpc.query sends only declared reads (a write classified as a read is never sent)
  if (readOnly && !read) {
    return { status: 'failed', error: { code: 'permission_denied', message: `${input.method} is not declared read-only for environment ${env.environmentId} (grpc.readMethods); use grpc.call (a ledgered external effect)` } };
  }
  const [serviceName, methodName] = input.method.split('/') as [string, string];
  let method: { resolvedRequestType: import('protobufjs').Type | null; resolvedResponseType: import('protobufjs').Type | null; requestStream?: boolean; responseStream?: boolean };
  try {
    const service = root.lookupService(serviceName);
    const m = service.methods[methodName];
    if (!m) throw new HypertestError('invalid_argument', `service ${serviceName} has no method ${methodName}`);
    m.resolve();
    method = m as unknown as typeof method;
  } catch (e) {
    return { status: 'failed', error: { code: 'invalid_argument', message: `unknown gRPC method ${input.method}: ${errorMessage(e)}` } };
  }
  if (method.requestStream || method.responseStream) return { status: 'failed', error: { code: 'invalid_argument', message: `${input.method} is a streaming method; grpc.call makes unary calls only` } };
  const RequestType = method.resolvedRequestType!;
  const ResponseType = method.resolvedResponseType!;
  const problem = RequestType.verify(input.request ?? {});
  if (problem) return { status: 'failed', error: { code: 'invalid_argument', message: `request does not match ${RequestType.fullName.replace(/^\./, '')}: ${problem}` } };
  const { grpc } = await load();
  const metadata = new grpc.Metadata();
  for (const [k, v] of Object.entries(input.metadata ?? {})) {
    try {
      metadata.set(k.toLowerCase(), v);
    } catch (e) {
      return { status: 'failed', error: { code: 'invalid_argument', message: `invalid metadata ${k}: ${errorMessage(e)}` } };
    }
  }
  // E[9]: a ledgered (non-read) call carries its operation id; the target can deduplicate a resend of the same operation
  if (!read && metadata.get('idempotency-key').length === 0) metadata.set('idempotency-key', ctx.operationId ?? ctx.invocationId);
  const requestMessage = RequestType.fromObject(input.request ?? {});
  const encoded = Buffer.from(RequestType.encode(requestMessage).finish());
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new grpc.Client(cfg.target, cfg.tls === true ? grpc.credentials.createSsl() : grpc.credentials.createInsecure());
  const started = performance.now();
  const scrub = (t: string): string => (ctx.secrets ? ctx.secrets.redact(t) : t);
  let ownDeadline = false;
  const result = await new Promise<{ code: number; details: string; response?: Record<string, unknown>; trailers: Record<string, string> }>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const call = client.makeUnaryRequest(
      `/${serviceName}/${methodName}`,
      (b: Buffer) => b,
      (b: Buffer) => b,
      encoded,
      metadata,
      { deadline },
      (err: (Error & { code?: number; details?: string; metadata?: { getMap(): Record<string, unknown> } }) | null, value?: Buffer) => {
        signalOff();
        if (err) {
          if (err.code === grpc.status.DEADLINE_EXCEEDED && Date.now() >= deadline - 5) ownDeadline = true;
          resolve({ code: err.code ?? grpc.status.UNKNOWN, details: err.details ?? err.message, trailers: stringMap(err.metadata?.getMap()) });
          return;
        }
        const decoded = ResponseType.toObject(ResponseType.decode(value ?? Buffer.alloc(0)), { longs: String, enums: String, bytes: String, defaults: true, oneofs: true }) as Record<string, unknown>;
        resolve({ code: grpc.status.OK, details: 'OK', response: decoded, trailers: {} });
      },
    );
    const onAbort = () => call.cancel();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const signalOff = () => ctx.signal.removeEventListener('abort', onAbort);
  });
  client.close();
  if (ctx.signal.aborted) throw abortReason(ctx.signal);
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  const codeName = GRPC_STATUS_NAMES[result.code] ?? String(result.code);
  const responseJson = result.response !== undefined ? (JSON.parse(scrub(JSON.stringify(result.response))) as JsonValue) : null;
  const responseText = responseJson === null ? '' : JSON.stringify(responseJson);
  const record = {
    target: cfg.target,
    method: input.method,
    read,
    request: redactSecrets(input.request ?? {}),
    metadata: Object.fromEntries(Object.entries(redactHeaders(input.metadata ?? {})).map(([k, v]) => [k, scrub(v)])),
    status: { code: result.code, name: codeName, details: scrub(result.details) },
    response: Buffer.byteLength(responseText) > GRPC_EVIDENCE_LIMIT ? null : responseJson,
    responseBytes: Buffer.byteLength(responseText),
    responseSha256: sha256Hex(responseText),
    durationMs,
  };
  const evidence = await ctx.recordEvidence({
    evidenceType: 'grpc-response',
    data: JSON.stringify({ ...record, response: responseJson }),
    mimeType: 'application/json',
    summary: `gRPC ${input.method} → ${codeName}${result.code === 0 ? '' : ` (${scrub(result.details).slice(0, 120)})`} (${durationMs} ms)`.slice(0, 500),
    structured: JSON.parse(JSON.stringify(record)) as JsonValue,
    provenance: { target: `grpc ${cfg.target} ${input.method}` },
    ...(ctx.operationId !== undefined ? { operationId: ctx.operationId } : {}),
  });
  const structured = { method: input.method, status: record.status, response: responseJson, durationMs, evidenceId: evidence.evidenceId };
  if (ownDeadline) return { status: 'timeout', structured: structured as unknown as JsonValue, error: { code: 'timeout', message: `no answer within ${timeoutMs} ms` }, evidenceRefs: [evidence.evidenceId] };
  const text = `gRPC ${input.method} → ${codeName} ${result.code === 0 ? '' : scrub(result.details)} (${durationMs} ms; evidence ${evidence.evidenceId})\n${responseText.slice(0, 4096)}`;
  return { status: 'success', structured: structured as unknown as JsonValue, text, evidenceRefs: [evidence.evidenceId] };
}

function stringMap(m: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m ?? {})) out[k] = typeof v === 'string' ? v : Buffer.isBuffer(v) ? `[${v.length} bytes]` : String(v);
  return out;
}
