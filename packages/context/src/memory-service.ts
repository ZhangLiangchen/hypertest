import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HypertestError, noopLogger, sha256Hex, type Logger } from '@hypertest/core';
import { EVENT_TYPES, eventFrom, type DomainEventInput, type DomainEventSink, type EventContext } from '@hypertest/domain';
import type { DurableMemory, ExperienceDecision, ExperienceItem, ExperienceStatus } from './contracts.ts';
import { DECISION_STATUS, EXPERIENCE_REVIEWED_EVENT, EXPERIENCE_STATUSES } from './experience.ts';
import { POWERCONTEXT_DEFAULT_PATHS } from './powercontext.ts';
import { isRecord } from './util.ts';

/**
 * (B[4]) The L4 durable-memory SERVICE: an HTTP endpoint with its own storage (the process that hosts it opens its own
 * store — `hypertest memory serve`, or the child process Hypertest starts for `memory.kind: service`) serving exactly the
 * API PowerContextClient speaks:
 *   GET  /v1/health                     → { status: 'ok', service: 'hypertest-memory' } (no auth)
 *   POST /v1/experiences                → propose (the new candidate)
 *   POST /v1/experiences/{id}/review    → { decision, reviewer } → the reviewed item
 *   POST /v1/context/prepare            → { query, scope, limit } → { items } (approved / published, in scope)
 *   GET  /v1/experiences?status=&sourceRunId= → { items }
 * Every invariant of the store holds server side (candidate on propose, reviewer ≠ creator — also against the calling actor
 * the client names in `x-hypertest-actor-id` / `x-hypertest-agent-id` —, only approved items retrievable); the client
 * re-checks them. Auth: `Authorization: Bearer <apiKey>` (constant-time compare) when an apiKey is set. Errors are
 * `{ error: { code, message } }` with the status PowerContextClient maps back to the same HypertestError code.
 */
export interface MemoryServiceOptions {
  memory: DurableMemory;
  apiKey?: string;
  logger?: Logger;
  /** Request body limit (default 1 MiB). */
  maxBodyBytes?: number;
}

const STATUS_OF: Record<string, number> = {
  invalid_argument: 400,
  permission_denied: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  rate_limited: 429,
  unavailable: 503,
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > limit) throw new HttpError(413, 'invalid_argument', `request body larger than ${limit} bytes`);
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_argument', 'request body is not valid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() !== '' ? s.trim() : undefined;
}

function authorized(req: IncomingMessage, apiKey: string | undefined): boolean {
  if (!apiKey) return true;
  const got = header(req, 'authorization') ?? '';
  const want = `Bearer ${apiKey}`;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function decoded(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  try {
    return decodeURIComponent(v);
  } catch {
    throw new HttpError(400, 'invalid_argument', 'malformed actor header');
  }
}

/** The EventContext of a request: the run and correlation the client names, the calling actor (default: `fallbackActor`). */
function contextOf(req: IncomingMessage, fallbackActor: string): EventContext {
  const runId = header(req, 'x-hypertest-run-id') ?? 'memory-service';
  const ctx: EventContext = { runId, correlationId: header(req, 'x-correlation-id') ?? runId, actorId: decoded(header(req, 'x-hypertest-actor-id')) ?? fallbackActor };
  const agentId = decoded(header(req, 'x-hypertest-agent-id'));
  if (agentId) ctx.agentId = agentId;
  return ctx;
}

const REVIEW_PATH = /^\/v1\/experiences\/([^/]+)\/review$/;

/** The request handler of the memory service (mount it on any node:http server). */
export function createMemoryServiceHandler(options: MemoryServiceOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { memory } = options;
  const logger = options.logger ?? noopLogger;
  const limit = options.maxBodyBytes ?? 1024 * 1024;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://memory.local');
    const method = req.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { status: 'ok', service: 'hypertest-memory', kind: memory.kind });
    if (!authorized(req, options.apiKey)) throw new HttpError(401, 'permission_denied', 'missing or wrong bearer token');
    if (method === 'POST' && url.pathname === POWERCONTEXT_DEFAULT_PATHS.propose) {
      const body = await readJson(req, limit);
      if (!isRecord(body)) throw new HttpError(400, 'invalid_argument', 'propose needs an experience object');
      const item = {
        scope: (isRecord(body['scope']) ? body['scope'] : {}) as ExperienceItem['scope'],
        kind: body['kind'] as ExperienceItem['kind'],
        content: body['content'] as string,
        sourceRunId: body['sourceRunId'] as string,
        evidenceRefs: (Array.isArray(body['evidenceRefs']) ? body['evidenceRefs'] : []) as string[],
        createdBy: body['createdBy'] as string,
      };
      return send(res, 201, await memory.propose(item, contextOf(req, String(body['createdBy'] ?? 'unknown'))));
    }
    const review = REVIEW_PATH.exec(url.pathname);
    if (method === 'POST' && review) {
      const body = await readJson(req, limit);
      if (!isRecord(body) || typeof body['decision'] !== 'string' || typeof body['reviewer'] !== 'string') throw new HttpError(400, 'invalid_argument', 'review needs { decision, reviewer }');
      const reviewer = body['reviewer'];
      return send(res, 200, await memory.review(decodeURIComponent(review[1]!), body['decision'] as ExperienceDecision, reviewer, contextOf(req, reviewer)));
    }
    if (method === 'POST' && url.pathname === POWERCONTEXT_DEFAULT_PATHS.retrieve) {
      const body = await readJson(req, limit);
      if (!isRecord(body)) throw new HttpError(400, 'invalid_argument', 'prepare needs { query, scope, limit }');
      const query: { text: string; scope?: ExperienceItem['scope']; limit?: number } = { text: typeof body['query'] === 'string' ? body['query'] : '' };
      if (isRecord(body['scope'])) query.scope = body['scope'] as ExperienceItem['scope'];
      if (body['limit'] !== undefined) query.limit = body['limit'] as number;
      return send(res, 200, { items: await memory.retrieve(query) });
    }
    if (method === 'GET' && url.pathname === POWERCONTEXT_DEFAULT_PATHS.list) {
      const filter: { status?: ExperienceStatus[]; sourceRunId?: string } = {};
      const status = url.searchParams.get('status');
      if (status) {
        const list = status.split(',').map((s) => s.trim()).filter(Boolean);
        const unknown = list.filter((s) => !EXPERIENCE_STATUSES.includes(s as ExperienceStatus));
        if (unknown.length > 0) throw new HttpError(400, 'invalid_argument', `unknown experience status ${unknown.join(', ')}`);
        filter.status = list as ExperienceStatus[];
      }
      const sourceRunId = url.searchParams.get('sourceRunId');
      if (sourceRunId !== null) filter.sourceRunId = sourceRunId;
      return send(res, 200, { items: await memory.list(filter) });
    }
    throw new HttpError(404, 'not_found', `no route ${method} ${url.pathname}`);
  }
  return (req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : e instanceof HypertestError ? (STATUS_OF[e.code] ?? 500) : 500;
      const code = e instanceof HttpError ? e.code : e instanceof HypertestError ? e.code : 'internal';
      const message = status === 500 && !(e instanceof HypertestError) ? 'internal error' : (e as Error).message;
      if (status >= 500) logger.error('memory service request failed', { method: req.method, path: req.url, error: (e as Error).message });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(res, status, { error: { code, message } });
    });
  };
}

export interface MemoryServiceServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Listens with the memory-service handler (default 127.0.0.1, any free port). */
export async function listenMemoryService(options: MemoryServiceOptions & { host?: string; port?: number }): Promise<MemoryServiceServer> {
  const server: Server = createServer(createMemoryServiceHandler(options));
  server.keepAliveTimeout = 1_000;
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const shownHost = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  return {
    url: `http://${shownHost}:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * (B[4]) L0 completeness with a remote memory: the experience decisions a service applied are appended to THIS deployment's
 * event store too (experience.proposed / experience.reviewed, deterministic ids so a retried call never appends twice), as
 * the SQL store does in the same transaction. The service stays the authority; the events record what it accepted.
 */
export function withExperienceEvents(memory: DurableMemory, deps: { events: DomainEventSink & { get?(eventId: string): Promise<unknown> } }): DurableMemory {
  const emitOnce = async (eventId: string, build: () => DomainEventInput<unknown>) => {
    if (deps.events.get && (await deps.events.get(eventId))) return;
    await deps.events.emit([{ ...build(), eventId }]);
  };
  return {
    kind: memory.kind,
    async propose(item, ctx) {
      const out = await memory.propose(item, ctx);
      await emitOnce(`evt_xpp_${sha256Hex(`experience.proposed\u0000${out.experienceId}`).slice(0, 32)}`, () => {
        const e = eventFrom(ctx, EVENT_TYPES.experienceProposed, 'context', out.experienceId, { experienceId: out.experienceId, kind: out.kind, scope: out.scope, createdBy: out.createdBy, evidenceRefs: out.evidenceRefs });
        e.runId = out.sourceRunId || ctx.runId;
        return e;
      });
      return out;
    },
    async review(experienceId, decision, reviewer, ctx) {
      const out = await memory.review(experienceId, decision, reviewer, ctx);
      const to = DECISION_STATUS[decision];
      await emitOnce(`evt_xpr_${sha256Hex(`experience.reviewed\u0000${experienceId}\u0000${to}\u0000${reviewer}`).slice(0, 32)}`, () => {
        const e = eventFrom(ctx, EXPERIENCE_REVIEWED_EVENT, 'context', experienceId, { experienceId, decision, reviewer, to });
        e.runId = out.sourceRunId || ctx.runId;
        return e;
      });
      return out;
    },
    retrieve: (query) => memory.retrieve(query),
    list: (filter) => memory.list(filter),
  };
}
