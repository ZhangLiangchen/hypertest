import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HypertestError, noopLogger, type ErrorCode, type JsonValue, type Logger } from '@hypertest/core';
import { isTerminalRun, type TestRun } from '@hypertest/domain';
import type { StartRunInput } from '@hypertest/control';
import type { ApiServer, ApiServerOptions, Hypertest, HypertestInstance } from './contracts.ts';

/**
 * The Hypertest REST API (node:http, JSON in and out, JSON errors `{ error: { code, message } }`).
 *
 *   GET  /health                          liveness + pinned manifest id
 *   POST /runs                            StartRunInput → 202 { run } (the run proceeds in the background)
 *   GET  /runs[?status=a,b&limit=n]       { runs }
 *   GET  /runs/:id                        { run }
 *   GET  /runs/:id/events[?afterSeq=n]    Server-Sent Events: every L0 event (`id` = seq, `event` = type, `data` = the
 *                                         DomainEvent), polled every 500 ms from the last seq (Last-Event-ID resumes);
 *                                         `event: end` once the run is terminal and every event was sent
 *   GET  /runs/:id/report[?format=markdown]  RunReport JSON (or its markdown)
 *   GET  /runs/:id/evidence/verify        { ok, problems }
 *   POST /runs/:id/cancel                 { reason } → { ok }
 *   (additive) POST /runs/:id/resume      → { ok, releasedPauses }  (releases model pauses, resumes a paused run; an
 *                                          operator decision: requires the API token)
 *   (additive) GET  /runs/:id/agents      { agents } — each agent's engine.inspect state, epoch, model pause (A[4])
 *   (additive) POST /runs/:id/model-switch { target, routeId, by, reason? } → { switch } (manual model switch, A[3];
 *                                          an operator decision: requires the API token)
 *   GET  /approvals[?runId=&status=a,b]   { approvals }
 *   POST /approvals/:id                   { approve, by, rationale } → { ok }  (human decision)
 *   POST /oracle-proposals/:id            { approve, by, rationale } → { ok }  (human decision)
 *
 * Security: binds 127.0.0.1 by default and has no authentication there; the Host header must name the loopback
 * listener (DNS-rebinding guard) and request bodies must be `application/json` (no simple cross-site form posts).
 * A non-loopback host is refused unless `token` is set, which then requires `Authorization: Bearer <token>` on every
 * request. HUMAN DECISIONS (POST /approvals/:id, POST /oracle-proposals/:id) always require the token: loopback is not
 * a trust boundary on a Hypertest host — agents reach loopback services of `local` environments through
 * `http.request`, and the code under test runs in the local sandbox — so without a token any of them could approve
 * its own side effect or oracle change as a "human" (I1, I8). A server without a token answers them 403.
 */

const STATUS: Partial<Record<ErrorCode, number>> = {
  invalid_argument: 400,
  schema_violation: 400,
  permission_denied: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 409,
  stale_fence: 409,
  stale_context: 409,
  budget_exhausted: 409,
  cancelled: 409,
  rate_limited: 429,
  unsupported: 501,
  provider_error: 502,
  unavailable: 503,
  timeout: 504,
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

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_NAMES.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

function sendError(res: ServerResponse, e: unknown, logger: Logger): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (e instanceof HttpError) {
    sendJson(res, e.status, { error: { code: e.code, message: e.message } });
    return;
  }
  if (e instanceof HypertestError) {
    const status = STATUS[e.code] ?? 500;
    if (status >= 500) logger.error('API request failed', { code: e.code, error: e.message });
    sendJson(res, status, { error: { code: e.code, message: e.message } });
    return;
  }
  logger.error('API request failed with an unexpected error', { error: (e as Error)?.message ?? String(e) });
  sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } });
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'request bodies must be application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'payload_too_large', `request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_argument', 'request body must be a JSON object');
  return body as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, 'invalid_argument', `${key} must be a non-empty string`);
  return v;
}

function decisionBody(body: Record<string, unknown>): { approve: boolean; by: string; rationale: string } {
  if (typeof body['approve'] !== 'boolean') throw new HttpError(400, 'invalid_argument', 'approve must be a boolean');
  return { approve: body['approve'], by: requireString(body, 'by'), rationale: requireString(body, 'rationale') };
}

function startRunInput(body: Record<string, unknown>): StartRunInput {
  const allowed = new Set(['goal', 'target', 'budget', 'gate', 'labels', 'oracleIds', 'runId']);
  for (const k of Object.keys(body)) if (!allowed.has(k)) throw new HttpError(400, 'invalid_argument', `unknown field '${k}'`);
  const input: StartRunInput = { goal: requireString(body, 'goal'), target: body['target'] as StartRunInput['target'] };
  if (body['target'] === null || typeof body['target'] !== 'object' || Array.isArray(body['target'])) throw new HttpError(400, 'invalid_argument', 'target must be an object');
  for (const k of ['budget', 'gate', 'labels'] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'invalid_argument', `${k} must be an object`);
    (input as unknown as Record<string, unknown>)[k] = v;
  }
  if (body['oracleIds'] !== undefined) {
    const ids = body['oracleIds'];
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw new HttpError(400, 'invalid_argument', 'oracleIds must be a list of strings');
    input.oracleIds = ids as string[];
  }
  if (body['runId'] !== undefined) input.runId = requireString(body, 'runId');
  return input;
}

function listParam(url: URL, key: string): string[] | undefined {
  const v = url.searchParams.get(key);
  if (v === null || v === '') return undefined;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function intParam(url: URL, key: string, min: number): number | undefined {
  const v = url.searchParams.get(key);
  if (v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new HttpError(400, 'invalid_argument', `${key} must be an integer ≥ ${min}`);
  return n;
}

function need<T>(fn: T | undefined, what: string): T {
  if (fn === undefined) throw new HttpError(501, 'not_implemented', `this Hypertest instance does not provide ${what}`);
  return fn;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Starts the REST API over a Hypertest instance (see the module comment for endpoints and security). */
export async function startApiServer(ht: Hypertest, options: ApiServerOptions): Promise<ApiServer> {
  const host = options.host ?? '127.0.0.1';
  const loopback = isLoopbackHost(host);
  if (!loopback && !options.token) throw new HypertestError('invalid_argument', `refusing to serve the API on non-loopback host ${host} without a token (set options.token)`);
  if (options.token !== undefined && options.token.length < 16) throw new HypertestError('invalid_argument', 'the API token must be at least 16 characters');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new HypertestError('invalid_argument', `invalid port ${options.port}`);
  const pollMs = options.eventPollMs ?? 500;
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const logger = (ht as Partial<HypertestInstance>).services?.logger?.child({ component: 'api' }) ?? noopLogger;
  const streams = new Set<() => void>();
  let port = options.port;

  /** Human decisions need an authenticated operator (the bearer check itself runs first for every request). */
  function requireDecisionToken(): void {
    if (options.token === undefined) {
      throw new HttpError(403, 'token_required', 'human decisions over the API require an API token (start the server with a token and send Authorization: Bearer <token>)');
    }
  }

  async function mustRun(runId: string): Promise<TestRun> {
    const run = await ht.status(runId);
    if (!run) throw new HttpError(404, 'not_found', `run ${runId} not found`);
    return run;
  }

  async function events(req: IncomingMessage, res: ServerResponse, runId: string, url: URL): Promise<void> {
    await mustRun(runId);
    const read = need(ht.events?.bind(ht), 'the event log');
    const resume = req.headers['last-event-id'];
    let last = intParam(url, 'afterSeq', 0) ?? (typeof resume === 'string' && /^\d+$/.test(resume) ? Number(resume) : 0);
    /** Consecutive polls that saw the run terminal BEFORE reading and then found no new event. */
    let quietAfterEnd = 0;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': hypertest event stream\n\n');
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let lastWrite = Date.now();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      streams.delete(stop);
      if (!res.writableEnded) res.end();
    };
    streams.add(stop);
    // the response closes when the client goes away (or after end()): never write to a closed stream
    res.on('close', stop);
    const poll = async (): Promise<void> => {
      if (stopped) return;
      try {
        // the status is read BEFORE the events: the events committed with (or before) the terminal transition are then
        // visible to the read below, so `end` never overtakes the run's last events (gate.evaluated, run.completed)
        const run = await ht.status(runId);
        if (stopped) return;
        const terminal = run !== undefined && isTerminalRun(run.status);
        const batch = await read(runId, { afterSeq: last, limit: 500 });
        if (stopped) return;
        for (const e of batch) {
          res.write(`id: ${e.seq ?? last}\nevent: ${e.eventType}\ndata: ${JSON.stringify(e)}\n\n`);
          last = e.seq ?? last;
          lastWrite = Date.now();
        }
        quietAfterEnd = terminal && batch.length === 0 ? quietAfterEnd + 1 : 0;
        if (batch.length === 0) {
          // one more quiet poll after the terminal status: events written right after it (e.g. the cancel sweep) still go out
          if (quietAfterEnd >= 2) {
            res.write(`event: end\ndata: ${JSON.stringify({ runId, status: run!.status, lastSeq: last })}\n\n`);
            stop();
            return;
          }
          if (Date.now() - lastWrite > 15_000) {
            res.write(': keep-alive\n\n');
            lastWrite = Date.now();
          }
        }
      } catch (e) {
        logger.warn('event stream poll failed; closing the stream', { runId, error: (e as Error).message });
        stop();
        return;
      }
      if (!stopped) timer = setTimeout(() => void poll(), pollMs);
    };
    await poll();
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (options.token !== undefined && !tokenMatches(req.headers['authorization'], options.token)) throw new HttpError(401, 'unauthenticated', 'a valid bearer token is required');
    if (loopback) {
      const hostHeader = (req.headers['host'] ?? '').toLowerCase();
      const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${host}:${port}`.toLowerCase()];
      if (!allowed.includes(hostHeader)) throw new HttpError(403, 'forbidden_host', 'the Host header must name the loopback listener');
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        throw new HttpError(400, 'invalid_argument', 'malformed percent-encoding in the request path');
      }
    });
    const method = req.method ?? 'GET';
    const allow = (...methods: string[]): void => {
      if (!methods.includes(method)) {
        res.setHeader('allow', methods.join(', '));
        throw new HttpError(405, 'method_not_allowed', `${method} is not allowed on ${url.pathname}`);
      }
    };
    const [head, id, sub, sub2] = parts;

    if (head === 'health' && parts.length === 1) {
      allow('GET');
      sendJson(res, 200, { ok: true, manifestId: ht.manifest?.manifestId ?? null, durable: ht.durable.kind });
      return;
    }
    if (head === 'runs' && parts.length === 1) {
      allow('GET', 'POST');
      if (method === 'POST') {
        const run = await ht.start(startRunInput(await readJson(req, maxBody)));
        sendJson(res, 202, { run });
        return;
      }
      const filter: { status?: TestRun['status'][]; limit?: number } = {};
      const status = listParam(url, 'status');
      if (status) filter.status = status as TestRun['status'][];
      const limit = intParam(url, 'limit', 1);
      if (limit !== undefined) filter.limit = limit;
      sendJson(res, 200, { runs: await need(ht.listRuns?.bind(ht), 'run listing')(filter) });
      return;
    }
    if (head === 'runs' && id !== undefined) {
      if (parts.length === 2) {
        allow('GET');
        sendJson(res, 200, { run: await mustRun(id) });
        return;
      }
      if (sub === 'events' && parts.length === 3) {
        allow('GET');
        await events(req, res, id, url);
        return;
      }
      if (sub === 'report' && parts.length === 3) {
        allow('GET');
        await mustRun(id);
        const report = await ht.report(id);
        const wantsMarkdown = url.searchParams.get('format') === 'markdown' || (req.headers['accept'] ?? '').includes('text/markdown');
        if (wantsMarkdown) {
          res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
          res.end(report.markdown);
          return;
        }
        sendJson(res, 200, report as unknown as JsonValue);
        return;
      }
      if (sub === 'evidence' && sub2 === 'verify' && parts.length === 4) {
        allow('GET');
        await mustRun(id);
        sendJson(res, 200, await ht.verifyEvidence(id));
        return;
      }
      if (sub === 'resume' && parts.length === 3) {
        allow('POST');
        // an operator decision (it un-pauses a run an operator or the budget paused): an agent reaching the loopback API
        // must not resume runs (I1)
        requireDecisionToken();
        await mustRun(id);
        const r = await need((ht as Partial<HypertestInstance>).resume?.bind(ht), 'resume')(id);
        sendJson(res, 200, { ok: true, releasedPauses: r.releasedPauses });
        return;
      }
      if (sub === 'agents' && parts.length === 3) {
        allow('GET');
        await mustRun(id);
        sendJson(res, 200, { agents: (await need((ht as Partial<HypertestInstance>).agents?.bind(ht), 'agent inspection')(id)) as unknown as JsonValue });
        return;
      }
      if (sub === 'model-switch' && parts.length === 3) {
        allow('POST');
        // an operator decision: an agent reaching the loopback API must not re-route models (I1)
        requireDecisionToken();
        const body = await readJson(req, maxBody);
        for (const k of Object.keys(body)) if (!['target', 'routeId', 'by', 'reason'].includes(k)) throw new HttpError(400, 'invalid_argument', `unknown field '${k}'`);
        await mustRun(id);
        const reason = body['reason'];
        if (reason !== undefined && typeof reason !== 'string') throw new HttpError(400, 'invalid_argument', 'reason must be a string');
        const sw = await need((ht as Partial<HypertestInstance>).requestModelSwitch?.bind(ht), 'model switches')(id, requireString(body, 'target'), requireString(body, 'routeId'), { kind: 'human', id: requireString(body, 'by') }, reason as string | undefined);
        sendJson(res, 200, { switch: sw as unknown as JsonValue });
        return;
      }
      if (sub === 'cancel' && parts.length === 3) {
        allow('POST');
        const body = await readJson(req, maxBody);
        await mustRun(id);
        await need(ht.cancel?.bind(ht), 'cancellation')(id, requireString(body, 'reason'));
        sendJson(res, 200, { ok: true });
        return;
      }
    }
    if (head === 'approvals' && parts.length === 1) {
      allow('GET');
      const filter: { runId?: string; status?: Array<'pending' | 'approved' | 'denied' | 'expired'> } = {};
      const runId = url.searchParams.get('runId');
      if (runId) filter.runId = runId;
      const status = listParam(url, 'status');
      if (status) filter.status = status as Array<'pending' | 'approved' | 'denied' | 'expired'>;
      sendJson(res, 200, { approvals: await need(ht.listApprovals?.bind(ht), 'approval listing')(filter) });
      return;
    }
    if (head === 'approvals' && id !== undefined && parts.length === 2) {
      allow('POST');
      requireDecisionToken();
      const d = decisionBody(await readJson(req, maxBody));
      await ht.approve(id, d.approve, { kind: 'human', id: d.by }, d.rationale);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (head === 'oracle-proposals' && id !== undefined && parts.length === 2) {
      allow('POST');
      requireDecisionToken();
      const d = decisionBody(await readJson(req, maxBody));
      await ht.decideOracleProposal(id, d.approve, { kind: 'human', id: d.by }, d.rationale);
      sendJson(res, 200, { ok: true });
      return;
    }
    throw new HttpError(404, 'not_found', `no route for ${method} ${url.pathname}`);
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => sendError(res, e, logger));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const shownHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${shownHost}:${port}`,
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const stop of [...streams]) stop();
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
