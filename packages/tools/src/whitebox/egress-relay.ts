import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { toHypertestError, type JsonValue, type Logger, type SqlExecutor } from '@hypertest/core';
import type { EventContext } from '@hypertest/domain';
import type { ArtifactStore } from '@hypertest/evidence';
import type { SideEffectGateway } from '@hypertest/operation';
import type { EgressEndpointPolicy, EgressWritePolicy, EnvironmentRegistry, ToolContext } from '../contracts.ts';
import { CONTROL_PATH_PREFIX, redactHeaders, storableText } from '../blackbox/common.ts';
import { RECORD_EFFECT_ADAPTER_ID, RECORD_EFFECT_RESENDABLE_ADAPTER_ID, bindRecordEffect, type RecordedToolOutcome } from './record-effects.ts';

/**
 * (E[2], I4) Protocol-aware egress of sandboxed commands to the system under test.
 *
 * The local sandbox relays the registered environments' loopback endpoints into a command's namespace. The relay speaks
 * HTTP/1.x and decides per request:
 *  - safe methods (GET, HEAD, OPTIONS) are forwarded as they are (no side effect) — (review) unless a method-override
 *    header (X-HTTP-Method-Override, X-HTTP-Method, X-Method-Override) names another method: the request is then treated
 *    as that method (a GET that a framework executes as a DELETE is a write);
 *  - (review) any request to the environment-control namespace (`/__hypertest…`, the supervisor's endpoints) is refused:
 *    environment control runs only through the governed env.* tools;
 *  - any other method is a side effect on the SUT. (review) It is AUTHORIZED first like a tool call of its own: the
 *    capability bounds the CALL (its tool grant and effect, the risk ceiling, the environment's class — `relayedWrite`),
 *    the policy judges the external effect on that class (`approval_required` refuses it: a sandboxed command cannot wait
 *    for a human — no approval request is recorded), the permit's allowedHosts apply. (Freshness: the call that runs the
 *    command was validated before it started; its writes are part of that one decision — re-validating each write mid-run
 *    would cut a test run in half.) A refused or unsettled write is reported to the call (`refused`): the call ends as a
 *    tool fault (`egress_refused`), never as an outcome of the system under test.
 *    Policy `ledger` (default): it then runs as an operation of the Operation
 *    Ledger through the SideEffectGateway (record-only adapter) — keyed by the tool invocation that runs the command plus
 *    the request's digest and occurrence (stable across durable replays), sent with `Idempotency-Key: <operationId>`,
 *    recorded as `api-response` evidence, its claim re-validated at the commit point (the work claim) and admitted on the
 *    environment's resource (the dispatcher's egress guard). A replay of the same invocation answers the recorded response
 *    WITHOUT sending again (test.run / shell.exec replays never re-execute side effects). Policy `refuse` (stricter): the
 *    request is refused with 403 and the exact reason;
 *  - a request outside any tool call (no call context), without a gateway, or refused by the egress guard: 403 (fail
 *    closed) with the reason;
 *  - non-HTTP traffic (a TLS handshake to an https endpoint, a database protocol), CONNECT tunnels and protocol upgrades
 *    are refused (the connection is closed) unless the environment's operator allowed raw egress for that endpoint
 *    (`EgressEndpointPolicy.raw`, an unledgered relay the operator accepts explicitly).
 */

/** Methods a sandboxed command may send to the SUT without a ledgered operation. */
export const SAFE_EGRESS_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];
/** Operation type of a ledgered request relayed for a sandboxed command. */
export const SANDBOX_HTTP_OPERATION = 'sandbox.http';
/** Response header naming the operation a relayed write ran as. */
export const EGRESS_OPERATION_HEADER = 'x-hypertest-operation-id';
/** Largest request body a ledgered relay accepts (the request must be digested before it is sent). */
export const MAX_EGRESS_BODY_BYTES = 8 * 1024 * 1024;
/** Largest response body a ledgered relay records and replays. */
export const MAX_EGRESS_RESPONSE_BYTES = 32 * 1024 * 1024;

const HOP_BY_HOP: ReadonlySet<string> = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authenticate', 'proxy-authorization', 'content-length']);

/** The tool call a sandboxed command runs for (set by the ToolRuntime around a tool's execution). */
export interface EgressCallContext {
  runId: string;
  workItemId: string;
  agentId: string;
  invocationId: string;
  eventContext: EventContext;
  /** The gateway that ledgers relayed writes (absent: they are refused). */
  gateway?: SideEffectGateway;
  artifacts: ArtifactStore;
  environments: EnvironmentRegistry;
  recordEvidence: ToolContext['recordEvidence'];
  /** E[0]: the work claim re-validated at the commit point of every relayed write. */
  commitGuard?: (tx: SqlExecutor) => Promise<string | undefined>;
  /** E[1]: admits the call's claim on the written resource; a returned reason refuses the write. */
  egressGuard?: (resource: string) => Promise<string | undefined>;
  /**
   * (review, I-chain) Authorizes one relayed write as an `external` effect of the calling tool on `resource`: capability →
   * policy permit (no approval request) → permit constraints → freshness. A returned reason refuses it (403, nothing sent);
   * absent: every write is refused (fail closed).
   */
  authorize?: (write: EgressWrite) => Promise<string | undefined>;
  experimentId?: string;
  /** Runs `fn` inside the call's metering context (evidence bytes are charged to the call). */
  within<T>(fn: () => Promise<T>): Promise<T>;
  /** Occurrences per request digest within this call (the stable key of the n-th identical request). */
  readonly occurrences: Map<string, number>;
  /**
   * (review) Collects every write of this call's commands that was refused or left unsettled (status and exact reason):
   * the runtime then ends the call as a tool fault (`egress_refused`) — a test whose writes governance refused tells
   * nothing about the system under test (never a fake FAIL).
   */
  refused?: string[];
  logger?: Logger;
}

/** (review) One state-changing request a sandboxed command sends through the relay (what `authorize` decides on). */
export interface EgressWrite {
  method: string;
  /** The full URL (origin + path, query included). */
  url: string;
  /** The resource its effect is keyed on (`env/<id>`, or `url/<host>` for an allowlisted origin). */
  resource: string;
  bodySha256: string;
  /** The stable key of this write (`<invocationId>#egress:<digest>:<n>`): its operation's tool invocation id. */
  key: string;
}

/** (review) Method-override headers some frameworks honour: a safe-method request carrying one is not safe. */
export const METHOD_OVERRIDE_HEADERS: readonly string[] = ['x-http-method-override', 'x-http-method', 'x-method-override'];

/** (review) The method a request is executed as: its own, or the one a method-override header names. */
export function effectiveMethod(method: string, headers: http.IncomingHttpHeaders): string {
  for (const h of METHOD_OVERRIDE_HEADERS) {
    const v = headers[h];
    const named = (Array.isArray(v) ? v[0] : v)?.trim().toUpperCase();
    if (named) return named;
  }
  return method;
}

const egressContext = new AsyncLocalStorage<EgressCallContext>();

/** Runs `fn` with `ctx` as the current egress call context (what a sandbox started inside it ledgers its writes for). */
export function runWithEgressContext<T>(ctx: EgressCallContext, fn: () => Promise<T>): Promise<T> {
  return egressContext.run(ctx, fn);
}

/** The egress call context of the code running now (undefined outside a tool call). */
export function currentEgressContext(): EgressCallContext | undefined {
  return egressContext.getStore();
}

/** The resource an origin's effects are keyed on when the policy names none: `url/<host>`. */
export function egressResource(origin: string): string {
  try {
    return `url/${new URL(origin).host.toLowerCase()}`;
  } catch {
    return `url/${origin}`;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), 'x-hypertest-egress': 'refused', ...extra });
  res.end(text);
}

async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.byteLength;
    if (size > max) return undefined;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function forwardHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}

/** One upstream exchange (the relay's own HTTP client: no redirects followed, body bounded). */
function upstream(target: { host: string; port: number }, method: string, path: string, headers: Record<string, string | string[]>, body: Buffer | undefined, signal: AbortSignal): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: target.host, port: target.port, method, path, headers: { ...headers, ...(body !== undefined ? { 'content-length': String(body.byteLength) } : {}) }, signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      res.on('data', (c: Buffer) => {
        size += c.byteLength;
        if (size > MAX_EGRESS_RESPONSE_BYTES) {
          truncated = true;
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(', ') : v;
        resolve({ status: res.statusCode ?? 502, statusText: res.statusMessage ?? '', headers: h, body: Buffer.concat(chunks), truncated });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

/**
 * A relay server for one endpoint (listen it on the unix socket the namespace connects to): HTTP-aware, as described in
 * the module header. `call`: the tool call the command runs for (captured when the command was started).
 */
export function createEgressHttpServer(endpoint: { host: string; port: number; policy: EgressEndpointPolicy }, mode: EgressWritePolicy, call: EgressCallContext | undefined): http.Server {
  const resource = endpoint.policy.resource ?? egressResource(endpoint.policy.origin);
  const origin = endpoint.policy.origin.replace(/\/+$/, '');
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      call?.logger?.warn('sandbox egress relay failed', { origin, error: (e as Error).message });
      sendJson(res, 502, { error: 'hypertest_egress_failed', reason: `the relay could not complete the request: ${(e as Error).message}` });
    });
  });
  // non-HTTP traffic (a TLS handshake, a database protocol) is refused: the connection is closed
  server.on('clientError', (_err, socket) => socket.destroy());
  const refuseTunnel = (req: http.IncomingMessage, socket: import('node:stream').Duplex) => {
    const body = JSON.stringify({ error: 'hypertest_egress_refused', reason: `${req.method ?? 'CONNECT'} tunnels and protocol upgrades from sandboxed commands to ${origin} are refused (only HTTP requests are relayed)` });
    socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  };
  server.on('connect', refuseTunnel);
  server.on('upgrade', refuseTunnel);

  /**
   * (review) Answers the command; a refused or unsettled write is also reported to the call (EgressCallContext.refused): the
   * call then ends as a tool fault (`egress_refused`), never as an outcome of the system under test.
   */
  function reply(res: http.ServerResponse, status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): void {
    if (call?.refused && (body['error'] === 'hypertest_egress_refused' || body['error'] === 'hypertest_egress_unsettled')) call.refused.push(`${status} ${String(body['reason'] ?? body['error'])}`.slice(0, 1000));
    sendJson(res, status, body, extra);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = req.url && req.url.startsWith('/') ? req.url : '/';
    const headers = forwardHeaders(req.headers);
    // (review) the environment-control namespace is never reachable from a sandboxed command (any method): env.* tools only
    const pathname = path.split('?')[0] ?? path;
    const controlPrefix = CONTROL_PATH_PREFIX.replace(/\/+$/, '');
    if (pathname === controlPrefix || pathname.startsWith(`${controlPrefix}/`)) {
      req.resume();
      return reply(res, 403, { error: 'hypertest_egress_refused', reason: `${method} ${origin}${path} from a sandboxed command refused: ${CONTROL_PATH_PREFIX} is the reserved environment-control namespace; use the env.* tools` });
    }
    // (review) a safe method whose method-override header names a non-safe one is a write
    if (SAFE_EGRESS_METHODS.includes(method) && SAFE_EGRESS_METHODS.includes(effectiveMethod(method, req.headers))) {
      // no side effect: relayed as is (streamed both ways)
      const up = http.request({ host: endpoint.host, port: endpoint.port, method, path, headers: { ...headers, ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}) } }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.statusMessage ?? '', forwardHeaders(r.headers));
        r.pipe(res);
      });
      up.on('error', (e) => reply(res, 502, { error: 'hypertest_egress_failed', reason: `${origin} unreachable: ${e.message}` }));
      req.pipe(up);
      return;
    }
    const asMethod = effectiveMethod(method, req.headers);
    const what = `${method}${asMethod !== method ? ` (as ${asMethod})` : ''} ${origin}${path}`;
    if (mode === 'refuse') {
      req.resume();
      return reply(res, 403, {
        error: 'hypertest_egress_refused',
        reason: `state-changing request ${what} from a sandboxed command refused (sandbox.egressWrites: refuse): side effects on the system under test run only through the http.request tool (a ledgered operation with an Idempotency-Key)`,
      });
    }
    if (!call || !call.gateway) {
      req.resume();
      return reply(res, 403, {
        error: 'hypertest_egress_refused',
        reason: `state-changing request ${what} from a sandboxed command refused: ${!call ? 'the command runs outside a governed tool call' : 'no SideEffectGateway is configured'}, so it cannot be recorded in the Operation Ledger (I4)`,
      });
    }
    const body = await readBody(req, MAX_EGRESS_BODY_BYTES);
    if (body === undefined) return reply(res, 413, { error: 'hypertest_egress_refused', reason: `request body of ${what} exceeds ${MAX_EGRESS_BODY_BYTES} bytes: not relayed` });
    const bodySha256 = createHash('sha256').update(body).digest('hex');
    const digest = createHash('sha256').update(`${method}${asMethod !== method ? `>${asMethod}` : ''}\u0000${origin}${path}\u0000${bodySha256}`).digest('hex').slice(0, 16);
    const n = (call.occurrences.get(digest) ?? 0) + 1;
    call.occurrences.set(digest, n);
    const key = `${call.invocationId}#egress:${digest}:${n}`;
    // (review) a durable REPLAY of a write this call already dispatched only settles its operation (the recorded response is
    // answered, nothing is sent again): it was authorized when it was dispatched — re-deciding it on a view that moved on
    // since would hide the recorded outcome from the replayed command
    let replay = false;
    if (call.gateway.find) {
      try {
        const prior = await call.gateway.find(key, SANDBOX_HTTP_OPERATION, call.runId);
        replay = prior !== undefined && prior.status !== 'prepared' && prior.status !== 'not_applied';
      } catch (e) {
        call.logger?.warn('egress relay: operation lookup failed; the write is decided as a new one', { key, error: (e as Error).message });
      }
    }
    // (review, I-chain) capability → policy permit → constraints → freshness, before any claim or ledger record
    if (!replay) {
      let problem: string | undefined;
      if (!call.authorize) problem = 'the relayed write cannot be authorized (no capability/policy check is configured for this call)';
      else {
        try {
          problem = await call.authorize({ method: asMethod, url: `${origin}${path}`, resource, bodySha256, key });
        } catch (e) {
          problem = `the relayed write could not be authorized: ${(e as Error).message}`;
        }
      }
      if (problem !== undefined) return reply(res, 403, { error: 'hypertest_egress_refused', reason: `${what} refused: ${problem}` });
    }
    // E[1]: the call's ResourceClaim on the written resource (after the authorization: a refused write holds nothing)
    if (call.egressGuard && !replay) {
      let problem: string | undefined;
      try {
        problem = await call.egressGuard(resource);
      } catch (e) {
        problem = `the resource claim could not be admitted: ${(e as Error).message}`;
      }
      if (problem !== undefined) return reply(res, 403, { error: 'hypertest_egress_refused', reason: `${what} refused: ${problem}` });
    }
    const target = { host: endpoint.host, port: endpoint.port };
    const unbind = bindRecordEffect(call.runId, key, (signal, operationId) => call.within(async () => {
      const sent = { ...headers };
      if (!Object.keys(sent).some((k) => k.toLowerCase() === 'idempotency-key')) sent['idempotency-key'] = operationId;
      const r = await upstream(target, method, path, sent, body, signal);
      // the environment the exchange was captured in (provenance anchor: evidence → environment/generation)
      const envId = resource.startsWith('env/') ? resource.slice('env/'.length) : undefined;
      const envNow = envId !== undefined ? (call.environments.load ? await call.environments.load(envId).catch(() => call.environments.get(envId)) : call.environments.get(envId)) : undefined;
      const evidence = await call.recordEvidence({
        ...(envNow ? { environment: { environmentId: envNow.environmentId, environmentClass: envNow.environmentClass, generation: envNow.generation, ...(envNow.buildDigest !== undefined ? { buildDigest: envNow.buildDigest } : {}) } } : {}),
        evidenceType: 'api-response',
        data: r.body,
        mimeType: r.headers['content-type'] ?? 'application/octet-stream',
        summary: `${what} → ${r.status} ${r.statusText} (relayed for a sandboxed command; operation ${operationId})`.slice(0, 500),
        structured: {
          relayed: true,
          request: { method, url: `${origin}${path}`, path: path.split('?')[0] ?? path, headers: redactHeaders(Object.entries(sent).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v] as [string, string])), body: storableText(body.subarray(0, 1024 * 1024).toString('utf8')), bodyBytes: body.byteLength },
          response: { status: r.status, statusText: r.statusText, headers: redactHeaders(r.headers), bodyBytes: r.body.byteLength, bodyTruncated: r.truncated },
        } as unknown as JsonValue,
        operationId,
        provenance: { target: what },
      });
      const outcome: RecordedToolOutcome = {
        status: 'success',
        structured: { status: r.status, statusText: r.statusText, headers: r.headers, bodySha256: evidence.artifact.sha256, bodyBytes: r.body.byteLength },
        evidenceRefs: [evidence.evidenceId],
      };
      return outcome;
    }));
    try {
      const out = await call.gateway.run({
        runId: call.runId,
        workItemId: call.workItemId,
        agentId: call.agentId,
        toolInvocationId: key,
        operationType: SANDBOX_HTTP_OPERATION,
        adapterId: endpoint.policy.honoursIdempotencyKey === true ? RECORD_EFFECT_RESENDABLE_ADAPTER_ID : RECORD_EFFECT_ADAPTER_ID,
        input: { method, ...(asMethod !== method ? { executedAs: asMethod } : {}), url: `${origin}${path}`, bodySha256, invocationId: call.invocationId, occurrence: n },
        target: { resourceKey: resource, kind: 'http_endpoint' },
        ctx: call.eventContext,
        signal: AbortSignal.timeout(120_000),
        ...(call.commitGuard ? { commitGuard: call.commitGuard } : {}),
        ...(call.experimentId !== undefined ? { experimentId: call.experimentId } : {}),
        // a replay settles the operation it dispatched before; it never dispatches again
        ...(replay ? { reconcileOnly: true } : {}),
      });
      const opHeader = { [EGRESS_OPERATION_HEADER]: out.operation.operationId };
      if (out.status !== 'verified') {
        const reason = 'reason' in out ? out.reason : `operation ${out.operation.operationId} is ${out.operation.status}`;
        return reply(res, out.status === 'stale_fence' ? 403 : 409, { error: 'hypertest_egress_unsettled', operationId: out.operation.operationId, operationStatus: out.operation.status, reason }, opHeader);
      }
      const rec = (out.result ?? {}) as RecordedToolOutcome;
      const s = (rec['structured'] ?? {}) as { status?: number; statusText?: string; headers?: Record<string, string>; bodySha256?: string };
      if (rec.status !== 'success' || typeof s.status !== 'number') {
        const err = rec['error'] as { message?: string } | undefined;
        return reply(res, 502, { error: 'hypertest_egress_failed', operationId: out.operation.operationId, reason: err?.message ?? `the relayed request ended ${rec.status}` }, opHeader);
      }
      const bytes = s.bodySha256 ? Buffer.from(await call.artifacts.get(s.bodySha256)) : Buffer.alloc(0);
      const resHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.headers ?? {})) if (!HOP_BY_HOP.has(k.toLowerCase())) resHeaders[k] = v;
      res.writeHead(s.status, s.statusText ?? '', { ...resHeaders, 'content-length': String(bytes.byteLength), ...opHeader });
      res.end(method === 'HEAD' ? undefined : bytes);
    } catch (e) {
      const err = toHypertestError(e);
      reply(res, 502, { error: 'hypertest_egress_failed', reason: `${what}: ${err.code}: ${err.message}` });
    } finally {
      unbind();
    }
  }
  return server;
}
