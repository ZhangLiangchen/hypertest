import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { HypertestError, abortReason, noopLogger, type JsonValue, type Logger } from '@hypertest/core';
import type { EvidenceRecord, Provenance } from '@hypertest/domain';
import { MemoryArtifactStore } from '@hypertest/evidence';
import { matchesToolPattern, type ActionPermit } from '@hypertest/policy';
import type { EnvironmentRegistry, SecretBroker, ToolContext, ToolOutcome, ToolSpec, WorkspaceHandle } from '../contracts.ts';
import { callScopedSecrets } from '../whitebox/runtime.ts';

/**
 * Remote tool workers (technology-selection §Tool Runtime "Remote Worker"): the BODY of a tool call executes in another
 * process — e.g. a worker inside the SUT's network — while everything that governs it stays here. The local registry holds
 * a remote spec (`remoteToolSpec`) with the very classification of the local tool (schemas, effect, risk, resources,
 * environment class, credential scopes, grant); the local ToolRuntime runs capability → policy permit → freshness →
 * Operation Ledger (record-only adapter for external effects: the operation id is created HERE) → and only then the
 * execute step POSTs the call to the worker: tool id, input, invocation id, operation id (preserved: the worker hands
 * it to the tool, so an http.request carries `Idempotency-Key: <operationId>`), run / work item / agent, the permit's
 * constraints. The worker executes the tool with its own environments and secret broker and returns the outcome and the
 * evidence it produced; the evidence is recorded in THIS deployment's ledger (`provenance.executedBy = remote:<id>`).
 *
 * Authentication: HMAC-SHA256 over `timestamp \n method \n path \n sha256(body)` with a shared secret (from a variable
 * the operator names; never configured inline), both directions — a request outside ±5 minutes, with a bad signature, or
 * a response whose signature does not verify is refused. (review) A response's signature also covers the digest of the
 * request it answers (`responseSignature`): a genuine answer to one call can never be replayed as the answer to another. Idempotency: the worker remembers each invocation's result (by
 * invocation id and request digest): a resend (a durable retry) gets the recorded result and never executes twice; the
 * same invocation id with another request is a conflict. Only tools without a side-effect binding may be delegated (their
 * effect is the call itself; bound tools' adapters keep running here).
 */

export const REMOTE_PROTOCOL_PATH = '/v1/tools/execute';
export const REMOTE_HEALTH_PATH = '/v1/health';
const SIGNATURE_HEADER = 'x-hypertest-signature';
const TIMESTAMP_HEADER = 'x-hypertest-timestamp';
const WORKER_HEADER = 'x-hypertest-worker';
/** Accepted clock skew of signed requests / responses. */
export const REMOTE_MAX_SKEW_MS = 5 * 60_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CACHED = 10_000;

/** The signature of one message: `v1=<hex>` of HMAC-SHA256(secret, `timestamp\nmethod\npath\nsha256(body)`). */
export function remoteSignature(secret: string, timestamp: string, method: string, path: string, body: string | Buffer): string {
  const digest = createHash('sha256').update(body).digest('hex');
  return `v1=${createHmac('sha256', secret).update(`${timestamp}\n${method.toUpperCase()}\n${path}\n${digest}`).digest('hex')}`;
}

/**
 * (review) The signature of a worker's ANSWER: bound to the sha256 of the request it answers (`requestDigest`, `none` when
 * the request body could not be read), so a captured genuine answer is never accepted for another call.
 */
export function responseSignature(secret: string, timestamp: string, requestDigest: string, body: string | Buffer): string {
  return remoteSignature(secret, timestamp, 'RESPONSE', `${REMOTE_PROTOCOL_PATH}#${requestDigest}`, body);
}

/** Verifies a signature and its timestamp; the reason when it fails. */
export function verifyRemoteSignature(secret: string, headers: { timestamp?: string | undefined; signature?: string | undefined }, method: string, path: string, body: string | Buffer, nowMs = Date.now()): string | undefined {
  const ts = headers.timestamp;
  if (!ts || !/^\d{1,16}$/.test(ts)) return 'missing or malformed timestamp';
  if (Math.abs(nowMs - Number(ts)) > REMOTE_MAX_SKEW_MS) return 'timestamp outside the accepted window';
  const given = headers.signature ?? '';
  const expected = remoteSignature(secret, ts, method, path, body);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'signature does not verify';
  return undefined;
}

/** True when a tool may run on a remote worker: no side-effect binding (its adapter would have to run remotely). */
export function delegableTool(spec: Pick<ToolSpec, 'sideEffect'>): boolean {
  return spec.sideEffect === undefined;
}

/** The body of a delegated call. */
export interface RemoteExecuteRequest {
  toolId: string;
  input: JsonValue;
  invocationId: string;
  operationId?: string;
  runId: string;
  workItemId: string;
  agentId: string;
  role: string;
  experimentId?: string;
  permit: { decisionId: string; constraints?: ActionPermit['constraints'] };
  timeoutMs: number;
}

/** One evidence record the worker produced (recorded by the caller in its ledger). */
export interface RemoteEvidence {
  evidenceType: string;
  dataBase64: string;
  mimeType: string;
  summary: string;
  structured?: JsonValue;
  operationId?: string;
  parentEvidenceIds?: string[];
  provenance?: Provenance;
  environment?: Parameters<ToolContext['recordEvidence']>[0]['environment'];
}

export interface RemoteExecuteResponse {
  outcome: Pick<ToolOutcome, 'status' | 'structured' | 'text' | 'error'>;
  evidence: RemoteEvidence[];
  worker: { workerId: string; durationMs: number };
  replayed: boolean;
}

export interface RemoteToolWorkerOptions {
  workerId: string;
  /** The tools this worker executes (only delegable ones are accepted). */
  tools: ToolSpec[];
  secret: string;
  environments: EnvironmentRegistry;
  secrets?: SecretBroker;
  logger?: Logger;
  host?: string;
  port?: number;
  /** Results remembered for resends (oldest dropped first; default 10000). */
  maxCached?: number;
}

export interface RemoteToolWorker {
  url: string;
  workerId: string;
  /** Calls executed (resends answered from the record are not counted). */
  readonly executed: number;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HypertestError('invalid_argument', 'request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** A scratch handle for the worker side (delegable tools never touch a workspace). */
function scratchHandle(workerId: string): WorkspaceHandle {
  return { workspaceId: `remote-${workerId}`, kind: 'scratch', root: tmpdir(), readOnly: true, sandbox: { kind: 'local', network: 'none', envAllowlist: [] }, resourcePrefix: `workspace/remote-${workerId}` };
}

/**
 * Starts a remote tool worker (HTTP). The caller's process composes the tools (with this worker's environments and
 * secret broker); the worker executes only them, only for signed requests, at most once per invocation.
 */
export async function startRemoteToolWorker(options: RemoteToolWorkerOptions): Promise<RemoteToolWorker> {
  if (!options.secret || options.secret.length < 16) throw new HypertestError('invalid_argument', 'a remote tool worker needs a shared secret of at least 16 characters');
  const logger = options.logger ?? noopLogger;
  const tools = new Map<string, ToolSpec>();
  for (const t of options.tools) {
    if (!delegableTool(t)) throw new HypertestError('invalid_argument', `tool ${t.id} has a side-effect binding and cannot run on a remote worker`);
    tools.set(t.id, t);
  }
  const done = new Map<string, { digest: string; result: Promise<RemoteExecuteResponse> }>();
  const max = options.maxCached ?? DEFAULT_MAX_CACHED;
  let executed = 0;

  // (review) every answer is signed together with the digest of the request it answers (never replayable for another call)
  const send = (res: ServerResponse, status: number, payload: unknown, requestDigest = 'none') => {
    const body = JSON.stringify(payload);
    const ts = String(Date.now());
    res.writeHead(status, { 'content-type': 'application/json', [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: responseSignature(options.secret, ts, requestDigest, body), [WORKER_HEADER]: options.workerId });
    res.end(body);
  };

  async function execute(request: RemoteExecuteRequest, signal: AbortSignal): Promise<RemoteExecuteResponse> {
    const spec = tools.get(request.toolId)!;
    const started = Date.now();
    const evidence: RemoteEvidence[] = [];
    const artifacts = new MemoryArtifactStore();
    const ctx: ToolContext = {
      runId: request.runId,
      workItemId: request.workItemId,
      agentId: request.agentId,
      role: request.role,
      invocationId: request.invocationId,
      workspace: scratchHandle(options.workerId),
      artifacts,
      async recordEvidence(input) {
        const data = typeof input.data === 'string' ? Buffer.from(input.data, 'utf8') : Buffer.from(input.data);
        const e: RemoteEvidence = { evidenceType: input.evidenceType, dataBase64: data.toString('base64'), mimeType: input.mimeType, summary: input.summary };
        if (input.structured !== undefined) e.structured = input.structured;
        if (input.operationId !== undefined) e.operationId = input.operationId;
        if (input.parentEvidenceIds !== undefined) e.parentEvidenceIds = input.parentEvidenceIds;
        if (input.provenance !== undefined) e.provenance = input.provenance;
        if (input.environment !== undefined) e.environment = input.environment;
        evidence.push(e);
        // the caller's ledger assigns the real id; a placeholder lets the tool reference "its" evidence in its result
        return { evidenceId: `remote_ev_${evidence.length}` } as EvidenceRecord;
      },
      eventContext: { runId: request.runId, correlationId: request.invocationId, actorId: `remote-worker:${options.workerId}`, workItemId: request.workItemId, agentId: request.agentId },
      permit: { decision: 'allow', decisionId: request.permit.decisionId, reasons: [], policyRevision: 'remote', ...(request.permit.constraints ? { constraints: request.permit.constraints } : {}) },
      signal,
      logger: logger.child({ toolId: request.toolId, invocationId: request.invocationId }),
      environments: options.environments,
    };
    if (options.secrets) {
      // (review) as on the caller's side: the tool mints only the credentials its input declares (what the caller's
      // capability and permit were checked against), narrowed by the permit's credentialScope — never the worker's whole
      // broker — and only for this run and invocation
      let declared: string[] = [];
      try {
        declared = spec.credentialScopes?.(request.input as never, { environments: options.environments }) ?? [];
      } catch {
        declared = [];
      }
      const permitted = request.permit.constraints?.credentialScope;
      const authorized = declared.filter((c) => typeof c === 'string' && (permitted === undefined || permitted.some((p) => matchesToolPattern(p, c))));
      ctx.secrets = callScopedSecrets(options.secrets, authorized, request.runId, request.invocationId);
    }
    if (request.operationId !== undefined) ctx.operationId = request.operationId;
    if (request.experimentId !== undefined) ctx.experimentId = request.experimentId;
    let outcome: ToolOutcome;
    try {
      outcome = await spec.execute(request.input as never, ctx);
    } catch (e) {
      if (signal.aborted) outcome = { status: 'timeout', error: { code: 'timeout', message: `remote execution aborted: ${(abortReason(signal) as Error)?.message ?? 'aborted'}` } };
      else outcome = { status: 'failed', error: { code: e instanceof HypertestError ? e.code : 'internal', message: (e as Error).message } };
    }
    executed++;
    const out: RemoteExecuteResponse['outcome'] = { status: outcome.status };
    if (outcome.structured !== undefined) out.structured = outcome.structured;
    if (outcome.text !== undefined) out.text = outcome.text;
    if (outcome.error !== undefined) out.error = outcome.error;
    return { outcome: out, evidence, worker: { workerId: options.workerId, durationMs: Date.now() - started }, replayed: false };
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://worker');
      if (req.method === 'GET' && url.pathname === REMOTE_HEALTH_PATH) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ workerId: options.workerId, tools: [...tools.keys()].sort(), executed }));
        return;
      }
      if (req.method !== 'POST' || url.pathname !== REMOTE_PROTOCOL_PATH) {
        res.writeHead(404).end();
        return;
      }
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch (e) {
        send(res, 413, { error: { code: 'invalid_argument', message: (e as Error).message } });
        return;
      }
      const digest = createHash('sha256').update(body).digest('hex');
      const why = verifyRemoteSignature(options.secret, { timestamp: req.headers[TIMESTAMP_HEADER] as string | undefined, signature: req.headers[SIGNATURE_HEADER] as string | undefined }, 'POST', REMOTE_PROTOCOL_PATH, body);
      if (why !== undefined) {
        logger.warn('remote tool worker: refused an unauthenticated request', { reason: why });
        send(res, 401, { error: { code: 'permission_denied', message: `unauthenticated: ${why}` } }, digest);
        return;
      }
      let request: RemoteExecuteRequest;
      try {
        request = JSON.parse(body.toString('utf8')) as RemoteExecuteRequest;
      } catch {
        send(res, 400, { error: { code: 'invalid_argument', message: 'malformed JSON' } }, digest);
        return;
      }
      if (typeof request?.toolId !== 'string' || typeof request.invocationId !== 'string' || typeof request.runId !== 'string' || !request.permit || typeof request.permit.decisionId !== 'string') {
        send(res, 400, { error: { code: 'invalid_argument', message: 'malformed execute request' } }, digest);
        return;
      }
      if (!tools.has(request.toolId)) {
        send(res, 404, { error: { code: 'not_found', message: `tool ${request.toolId} is not executed by worker ${options.workerId}` } }, digest);
        return;
      }
      const key = `${request.runId}\u0000${request.invocationId}`;
      const prior = done.get(key);
      if (prior) {
        if (prior.digest !== digest) {
          send(res, 409, { error: { code: 'conflict', message: `invocation ${request.invocationId} was already executed with another request` } }, digest);
          return;
        }
        // a resend of the same invocation: the recorded result, never a second execution (I4)
        const recorded = await prior.result;
        send(res, 200, { ...recorded, replayed: true }, digest);
        return;
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new HypertestError('timeout', `remote execution exceeded ${request.timeoutMs} ms`)), Math.max(1, Math.min(request.timeoutMs ?? 300_000, 600_000)));
      timer.unref();
      res.on('close', () => {
        if (!res.writableFinished) ac.abort(new HypertestError('cancelled', 'the caller went away'));
      });
      const result = execute(request, ac.signal).finally(() => clearTimeout(timer));
      done.set(key, { digest, result });
      if (done.size > max) done.delete(done.keys().next().value!);
      send(res, 200, await result, digest);
    })().catch((e: unknown) => {
      logger.error('remote tool worker: request failed', { error: (e as Error).message });
      if (!res.headersSent) send(res, 500, { error: { code: 'internal', message: (e as Error).message } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  logger.info('remote tool worker listening', { workerId: options.workerId, url: `http://${host}:${addr.port}`, tools: [...tools.keys()] });
  return {
    url: `http://${host}:${addr.port}`,
    workerId: options.workerId,
    get executed() {
      return executed;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Where a remote spec sends its calls. `secret` undefined: the worker's secret is not configured (calls fail closed). */
export interface RemoteToolTarget {
  workerId: string;
  url: string;
  secret: string | undefined;
  /** Why the worker is unusable (e.g. its secret variable is not set); calls fail `unavailable` with it. */
  unavailableReason?: string;
  fetch?: typeof fetch;
}

/**
 * The local spec of a tool delegated to a remote worker: the local tool's classification (so capability, permit,
 * freshness and ledger decide exactly as for the local tool) with an execute step that sends the signed call, verifies
 * the signed answer and records the worker's evidence in this deployment's ledger.
 */
export function remoteToolSpec(local: ToolSpec, target: RemoteToolTarget): ToolSpec {
  if (!delegableTool(local)) throw new HypertestError('invalid_argument', `tool ${local.id} has a side-effect binding and cannot be delegated to a remote worker`);
  const doFetch = target.fetch ?? fetch;
  return {
    ...local,
    description: `${local.description} (executed by remote worker ${target.workerId})`,
    async execute(input, ctx) {
      if (target.unavailableReason !== undefined || target.secret === undefined) {
        return { status: 'failed', error: { code: 'unavailable', message: `remote worker ${target.workerId} is unavailable: ${target.unavailableReason ?? 'no shared secret'}` } };
      }
      const request: RemoteExecuteRequest = {
        toolId: local.id,
        input: (input ?? null) as JsonValue,
        invocationId: ctx.invocationId,
        runId: ctx.runId,
        workItemId: ctx.workItemId,
        agentId: ctx.agentId,
        role: ctx.role,
        permit: { decisionId: ctx.permit.decisionId, ...(ctx.permit.constraints ? { constraints: ctx.permit.constraints } : {}) },
        timeoutMs: local.timeoutMs,
      };
      if (ctx.operationId !== undefined) request.operationId = ctx.operationId;
      if (ctx.experimentId !== undefined) request.experimentId = ctx.experimentId;
      const body = JSON.stringify(request);
      const ts = String(Date.now());
      let res: Response;
      try {
        res = await doFetch(`${target.url.replace(/\/+$/, '')}${REMOTE_PROTOCOL_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: remoteSignature(target.secret, ts, 'POST', REMOTE_PROTOCOL_PATH, body), 'x-request-id': randomUUID() },
          body,
          signal: ctx.signal,
        });
      } catch (e) {
        if (ctx.signal.aborted) throw abortReason(ctx.signal);
        return { status: 'failed', error: { code: 'unavailable', message: `remote worker ${target.workerId} unreachable: ${(e as Error).message}` } };
      }
      const raw = Buffer.from(await res.arrayBuffer());
      // (review) the answer must be the worker's answer to THIS request (its signature covers the request digest)
      const requestDigest = createHash('sha256').update(body).digest('hex');
      const why = verifyRemoteSignature(target.secret, { timestamp: res.headers.get(TIMESTAMP_HEADER) ?? undefined, signature: res.headers.get(SIGNATURE_HEADER) ?? undefined }, 'RESPONSE', `${REMOTE_PROTOCOL_PATH}#${requestDigest}`, raw);
      if (why !== undefined) {
        // an answer we cannot authenticate is never trusted (its evidence could be forged)
        return { status: 'failed', error: { code: 'integrity_violation', message: `the answer of remote worker ${target.workerId} is not authentic: ${why}` } };
      }
      let parsed: RemoteExecuteResponse & { error?: { code: string; message: string } };
      try {
        parsed = JSON.parse(raw.toString('utf8')) as typeof parsed;
      } catch {
        return { status: 'failed', error: { code: 'unavailable', message: `remote worker ${target.workerId} sent a malformed answer` } };
      }
      if (!res.ok) return { status: 'failed', error: { code: parsed.error?.code ?? 'unavailable', message: `remote worker ${target.workerId}: ${parsed.error?.message ?? `HTTP ${res.status}`}` } };
      // the worker's evidence becomes evidence of THIS call in this deployment's ledger (placeholders mapped to real ids)
      const ids = new Map<string, string>();
      const refs: string[] = [];
      for (const [i, e] of (parsed.evidence ?? []).entries()) {
        const recorded = await ctx.recordEvidence({
          evidenceType: e.evidenceType,
          data: new Uint8Array(Buffer.from(e.dataBase64, 'base64')),
          mimeType: e.mimeType,
          summary: e.summary,
          ...(e.structured !== undefined ? { structured: e.structured } : {}),
          ...(e.operationId !== undefined ? { operationId: e.operationId } : {}),
          ...(e.parentEvidenceIds !== undefined ? { parentEvidenceIds: e.parentEvidenceIds.map((p) => ids.get(p) ?? p) } : {}),
          provenance: { ...(e.provenance ?? {}), executedBy: `remote:${target.workerId}` },
          ...(e.environment !== undefined ? { environment: e.environment } : {}),
        });
        ids.set(`remote_ev_${i + 1}`, recorded.evidenceId);
        refs.push(recorded.evidenceId);
      }
      const rewrite = (s: string): string => s.replace(/\bremote_ev_\d+\b/g, (m) => ids.get(m) ?? m);
      const outcome: ToolOutcome = { status: parsed.outcome.status, evidenceRefs: refs };
      if (parsed.outcome.structured !== undefined) outcome.structured = JSON.parse(rewrite(JSON.stringify(parsed.outcome.structured))) as JsonValue;
      if (parsed.outcome.text !== undefined) outcome.text = rewrite(parsed.outcome.text);
      if (parsed.outcome.error !== undefined) outcome.error = parsed.outcome.error;
      return outcome;
    },
  };
}
