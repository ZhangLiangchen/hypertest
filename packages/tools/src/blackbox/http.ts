import { performance } from 'node:perf_hooks';
import { HypertestError, abortReason, isHypertestError, sha256Hex, type JsonSchema, type JsonValue } from '@hypertest/core';
import type { EvidenceRecord } from '@hypertest/domain';
import type { EnvironmentRegistry, ToolContext, ToolOutcome, ToolSpec } from '../contracts.ts';
import {
  ENV_ID_SCHEMA, checkEgress, environmentClassForUrl, environmentOrigins, errorMessage, hostSegment, isTextualContentType, joinUrl, parseHttpUrl, readBodyLimited, redactHeaders,
  redactJsonSecrets, redactUrl, requireEnvironment, storableText,
} from './common.ts';
import { credentialScope } from './secrets.ts';

export const HTTP_READ_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];
export const HTTP_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];
/** Methods that get an `Idempotency-Key: <operationId>` header (the invocation id when unledgered) unless the caller sets one. */
export const NON_IDEMPOTENT_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** Response body bytes kept inline in the evidence `structured` payload (the artifact holds the full body). */
export const EVIDENCE_BODY_LIMIT = 1024 * 1024;
/** Hard cap on the bytes read from a response (protects the worker; the excess is cancelled). */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Body preview returned to the model. */
export const BODY_PREVIEW_BYTES = 4 * 1024;
/** Parsed JSON is returned in the structured result up to this body size. */
const MAX_JSON_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpRequestInput {
  method: string;
  url?: string;
  environmentId?: string;
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  json?: JsonValue;
  body?: string;
  timeoutMs?: number;
  expectJson?: boolean;
  /**
   * (additive, E[4]) The NAME of a brokered credential of the environment (environmentId required): the secret broker
   * mints a short-lived credential for this one request and sends it in its header — the agent never sees a value.
   */
  credential?: string;
}

export interface HttpRequestResult {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  json?: JsonValue;
  jsonError?: string;
  bodyPreview: string;
  bodyBytes: number;
  bodyTruncated: boolean;
  /** Set when the body broke off after the status line (reset, timeout): the body is partial. */
  bodyError?: string;
  contentType?: string;
  durationMs: number;
  evidenceId: string;
}

const scalar: JsonSchema = { type: ['string', 'number', 'boolean'] };

export const HTTP_REQUEST_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    method: { type: 'string', enum: [...HTTP_METHODS], description: 'HTTP method.' },
    url: { type: 'string', minLength: 1, maxLength: 8192, description: 'Absolute http(s) URL (mutually exclusive with environmentId).' },
    environmentId: { ...ENV_ID_SCHEMA, description: 'Registered environment; the request goes to its baseUrl + path.' },
    path: { type: 'string', maxLength: 8192, pattern: '^/(?!/)', description: 'Path (and optional ?query) relative to the environment baseUrl.' },
    headers: { type: 'object', additionalProperties: { type: 'string', maxLength: 16384 }, maxProperties: 100 },
    query: { type: 'object', additionalProperties: { anyOf: [scalar, { type: 'array', items: scalar, maxItems: 100 }] }, maxProperties: 100 },
    json: { description: 'JSON request body (sets content-type application/json).' },
    body: { type: 'string', maxLength: 8 * 1024 * 1024, description: 'Raw request body.' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 300_000 },
    expectJson: { type: 'boolean', description: 'Parse the response body as JSON even without a JSON content type.' },
    credential: {
      type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
      description: 'Name of a brokered credential of the environment (needs environmentId): a short-lived credential is minted for this request and sent in its header. You never see or send credential values yourself.',
    },
  },
  required: ['method'],
  allOf: [
    { anyOf: [{ required: ['url'] }, { required: ['environmentId'] }] },
    { not: { required: ['url', 'environmentId'] } },
    { not: { required: ['json', 'body'] } },
    { not: { required: ['url', 'path'] } },
  ],
};

export const HTTP_REQUEST_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['status', 'headers', 'bodyPreview', 'durationMs', 'evidenceId'],
  properties: {
    status: { type: 'integer' },
    statusText: { type: 'string' },
    url: { type: 'string' },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    json: {},
    jsonError: { type: 'string' },
    bodyPreview: { type: 'string' },
    bodyBytes: { type: 'integer' },
    bodyTruncated: { type: 'boolean' },
    bodyError: { type: 'string' },
    contentType: { type: 'string' },
    durationMs: { type: 'number' },
    evidenceId: { type: 'string' },
  },
};

/** Resolves the request URL and the origins trusted for it (the addressed environment's own origins). */
export function resolveTarget(input: { url?: string; environmentId?: string; path?: string }, envs: EnvironmentRegistry | undefined, urlField: 'baseUrl' | 'metricsUrl' | 'prometheusUrl' = 'baseUrl'): { url: URL; trustedOrigins: string[]; environmentClass: string | undefined } {
  if (input.environmentId !== undefined) {
    const env = requireEnvironment(envs, input.environmentId);
    const base = env[urlField];
    if (!base) throw new HypertestError('precondition_failed', `environment ${env.environmentId} has no ${urlField}`);
    const url = urlField === 'baseUrl' ? joinUrl(base, input.path, `environment ${env.environmentId} ${urlField}`) : parseHttpUrl(base, `environment ${env.environmentId} ${urlField}`);
    return { url, trustedOrigins: environmentOrigins(env), environmentClass: env.environmentClass };
  }
  if (input.url === undefined) throw new HypertestError('invalid_argument', 'either url or environmentId is required');
  if (input.path !== undefined) throw new HypertestError('invalid_argument', 'path is only valid together with environmentId');
  const url = parseHttpUrl(input.url);
  return { url, trustedOrigins: [], environmentClass: environmentClassForUrl(url, envs) };
}

/** Resource keys of a URL/environment addressed tool: `env/<id>` or `url/<host>`. */
export function targetResources(input: { url?: string; environmentId?: string }): string[] {
  if (input.environmentId !== undefined) return [`env/${input.environmentId}`];
  if (input.url !== undefined) return [`url/${hostSegment(parseHttpUrl(input.url))}`];
  throw new HypertestError('invalid_argument', 'either url or environmentId is required');
}

export function targetEnvironmentClass(input: { url?: string; environmentId?: string }, envs: EnvironmentRegistry): string | undefined {
  if (input.environmentId !== undefined) return requireEnvironment(envs, input.environmentId).environmentClass;
  if (input.url !== undefined) return environmentClassForUrl(parseHttpUrl(input.url), envs);
  return undefined;
}

/**
 * `http.request` — black-box API probe. Non-2xx responses are SUCCESSFUL tool calls (the status is a
 * domain outcome). Every exchange (including timeouts and connection failures) is recorded as
 * `api-response` evidence: the artifact holds the full response body, `structured` the redacted request
 * and response (body text truncated at 1 MiB). Redirects are not followed (a redirect could leave the
 * allowlist); the 3xx is returned as is. The supervisor control namespace (`/__hypertest`) and the control
 * targets of registered process environments are never addressed (restarts/faults only via env.*). Secret-named
 * JSON request fields are redacted in the evidence (like credential headers).
 *
 * Non-idempotent methods (POST/PUT/PATCH/DELETE) are `external` effects: with a gateway configured the ToolRuntime
 * records the call in the Operation Ledger (record-only adapter, keyed by the invocation id — conformance-7): a
 * durable replay returns the recorded response instead of sending again, and a call interrupted between sending and
 * recording goes to manual review instead of being re-sent. An `Idempotency-Key: <operationId>` header is added unless
 * the caller sets one (E[9]: the ledger's idempotencyKey; the operation id is stable across durable retries and resends —
 * the invocation id is used only when the call runs without a gateway); for an environment declaring
 * `honoursIdempotencyKey` such an interrupted call is re-sent once with the same key (`resendable`).
 */
export function httpRequestTool(options: { httpAllowlist?: string[] }): ToolSpec<HttpRequestInput> {
  return {
    id: 'http.request',
    title: 'HTTP request',
    description:
      'Send one HTTP request to the system under test (url, or environmentId + path) and record the exchange as api-response evidence. ' +
      'Non-2xx statuses are returned as results, not errors. Redirects are not followed. Hosts must be allowlisted.',
    inputSchema: HTTP_REQUEST_INPUT_SCHEMA,
    outputSchema: HTTP_REQUEST_OUTPUT_SCHEMA,
    effect: (input) => (HTTP_READ_METHODS.includes(input.method) ? 'read' : 'external'),
    riskClass: (input) => (HTTP_READ_METHODS.includes(input.method) ? 'low' : 'medium'),
    resources: (input) => targetResources(input),
    environmentClass: (input, ctx) => targetEnvironmentClass(input, ctx.environments),
    // a resend carries the same Idempotency-Key (the invocation id, or the caller's own header — same input)
    resendable: (input, ctx) => NON_IDEMPOTENT_METHODS.includes(input.method.toUpperCase()) && input.environmentId !== undefined && ctx.environments.get(input.environmentId)?.honoursIdempotencyKey === true,
    // E[4]: a brokered credential is a capability scope (`credential:<environmentId>/<name>`), checked before anything runs
    credentialScopes: (input) => {
      if (input.credential === undefined) return [];
      if (input.environmentId === undefined) throw new HypertestError('invalid_argument', 'credential needs environmentId (a brokered credential belongs to a registered environment)');
      return [credentialScope(input.environmentId, input.credential)];
    },
    timeoutMs: 300_000,
    async execute(input, ctx) {
      return executeHttpRequest(input, ctx, options.httpAllowlist);
    },
  };
}

async function executeHttpRequest(input: HttpRequestInput, ctx: ToolContext, allowlist: string[] | undefined): Promise<ToolOutcome> {
  let target: ReturnType<typeof resolveTarget>;
  try {
    target = resolveTarget(input, ctx.environments);
  } catch (e) {
    if (isHypertestError(e)) return { status: 'failed', error: { code: e.code, message: e.message } };
    throw e;
  }
  const url = target.url;
  for (const [k, v] of Object.entries(input.query ?? {})) {
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
  }
  const decision = checkEgress(url, { allowlist, permitHosts: ctx.permit.constraints?.allowedHosts, environmentClass: target.environmentClass, trustedOrigins: target.trustedOrigins }, ctx.environments);
  if (!decision.allowed) return { status: 'failed', error: { code: 'permission_denied', message: decision.reason } };

  const method = input.method.toUpperCase();
  if ((method === 'GET' || method === 'HEAD') && (input.json !== undefined || input.body !== undefined)) {
    return { status: 'failed', error: { code: 'invalid_argument', message: `${method} requests cannot carry a body` } };
  }
  const headers = new Headers();
  try {
    for (const [k, v] of Object.entries(input.headers ?? {})) headers.set(k, v);
  } catch (e) {
    return { status: 'failed', error: { code: 'invalid_argument', message: `invalid header: ${errorMessage(e)}` } };
  }
  // E[4]: a brokered credential, minted for this request (short-lived, scoped); its value never reaches the model
  if (input.credential !== undefined) {
    if (input.environmentId === undefined) return { status: 'failed', error: { code: 'invalid_argument', message: 'credential needs environmentId' } };
    if (!ctx.secrets) return { status: 'failed', error: { code: 'unavailable', message: `no secret broker is configured: credential ${input.credential} cannot be minted` } };
    let minted: Awaited<ReturnType<NonNullable<ToolContext['secrets']>['mint']>>;
    try {
      minted = await ctx.secrets.mint({ environmentId: input.environmentId, name: input.credential, runId: ctx.runId, invocationId: ctx.invocationId, signal: ctx.signal });
    } catch (e) {
      if (isHypertestError(e)) return { status: 'failed', error: { code: e.code, message: e.message } };
      throw e;
    }
    if (headers.has(minted.header)) return { status: 'failed', error: { code: 'invalid_argument', message: `the ${minted.header} header is set by the credential broker (credential ${input.credential}); do not set it yourself` } };
    headers.set(minted.header, minted.value);
  }
  // E[4]: no long-lived secret and no minted credential reaches the evidence or the model (any header name, any echo)
  const scrub = (t: string): string => (ctx.secrets ? ctx.secrets.redact(t) : t);
  let body: string | undefined = input.body;
  if (input.json !== undefined) {
    body = JSON.stringify(input.json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  // E[9]: idempotencyKey = operationId — the key the Operation Ledger records for this call is the one the target sees (the
  // invocation id only for a call that runs unledgered, without a gateway); stable across a resend of the same operation
  if (NON_IDEMPOTENT_METHODS.includes(method) && !headers.has('idempotency-key')) headers.set('idempotency-key', ctx.operationId ?? ctx.invocationId);
  if (!headers.has('user-agent')) headers.set('user-agent', 'hypertest-blackbox/0.3');

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeout]);
  // Evidence keeps the request as sent, minus credentials: secret-named JSON fields are redacted like headers.
  const evidenceBody = input.json !== undefined ? JSON.stringify(redactJsonSecrets(input.json)) : body;
  const requestRecord = {
    method,
    url: redactUrl(url),
    // the path an oracle names (QualityGate http_expectation.path): environment-relative, without query
    path: requestPath(input, url, ctx.environments),
    headers: Object.fromEntries(Object.entries(redactHeaders(headers.entries())).map(([k, v]) => [k, scrub(v)])),
    ...(evidenceBody !== undefined && body !== undefined ? { body: storableText(truncateUtf8Bytes(evidenceBody, EVIDENCE_BODY_LIMIT)), bodyBytes: Buffer.byteLength(body) } : {}),
  };
  const started = performance.now();
  let res: Response;
  try {
    const init: RequestInit = { method, headers, redirect: 'manual', signal };
    if (body !== undefined) init.body = body;
    res = await fetch(url, init);
  } catch (e) {
    if (ctx.signal.aborted) throw abortReason(ctx.signal); // the runtime's timeout/cancellation: not an observation
    const durationMs = round(performance.now() - started);
    const timedOut = timeout.aborted;
    const code = timedOut ? 'timeout' : 'unavailable';
    const message = timedOut ? `no response within ${timeoutMs} ms` : `request failed: ${describeFetchError(e)}`;
    const evidence = await recordExchange(ctx, method, url, { request: requestRecord, response: null, error: { code, message }, durationMs }, JSON.stringify({ request: requestRecord, error: { code, message } }), 'application/json', `${method} ${redactUrl(url)} → ${code} after ${durationMs} ms`);
    return {
      status: timedOut ? 'timeout' : 'failed',
      error: { code, message },
      evidenceRefs: [evidence.evidenceId],
      text: `${method} ${redactUrl(url)}: ${message} (evidence ${evidence.evidenceId})`,
    };
  }

  const read = await readBodyLimited(res, MAX_RESPONSE_BYTES);
  let bodyError: string | undefined;
  if (read.error !== undefined) {
    if (ctx.signal.aborted) throw abortReason(ctx.signal);
    // Status and headers arrived; the body broke off. Keep what was read and say so (never a silent short body).
    bodyError = timeout.aborted ? `body incomplete: no end of body within ${timeoutMs} ms` : `body incomplete: ${describeFetchError(read.error)}`;
    ctx.logger.warn('http.request: response body could not be read completely', { error: bodyError, bytesRead: read.totalRead });
  }
  const durationMs = round(performance.now() - started);
  const contentType = res.headers.get('content-type') ?? undefined;
  // E[4]: whatever the SUT echoes back, no long-lived secret and no minted credential reaches the evidence or the model
  const responseHeaders = Object.fromEntries(Object.entries(redactHeaders(res.headers.entries())).map(([k, v]) => [k, scrub(v)]));
  const textual = isTextualContentType(contentType);
  const rawText = textual ? Buffer.from(read.bytes).toString('utf8') : '';
  const fullText = scrub(rawText);
  if (fullText !== rawText) read.bytes = new Uint8Array(Buffer.from(fullText, 'utf8'));
  const evidenceText = textual ? storableText(truncateUtf8Bytes(fullText, EVIDENCE_BODY_LIMIT)) : null;
  const responseRecord = {
    status: res.status,
    statusText: res.statusText,
    headers: responseHeaders,
    body: evidenceText,
    bodyBytes: read.totalRead,
    bodyTruncated: read.truncated || (textual && Buffer.byteLength(fullText) > EVIDENCE_BODY_LIMIT),
    bodyEncoding: textual ? 'utf-8' : 'binary',
    bodySha256: sha256Hex(read.bytes),
    ...(bodyError !== undefined ? { bodyError } : {}),
  };
  const evidence = await recordExchange(
    ctx,
    method,
    url,
    { request: requestRecord, response: responseRecord, durationMs },
    read.bytes,
    contentType ?? 'application/octet-stream',
    `${method} ${redactUrl(url)} → ${res.status} ${res.statusText} (${durationMs} ms, ${read.totalRead} bytes)`,
  );

  const result: HttpRequestResult = {
    status: res.status,
    statusText: res.statusText,
    url: redactUrl(url),
    headers: responseHeaders,
    bodyPreview: textual ? storableText(truncateUtf8Bytes(fullText, BODY_PREVIEW_BYTES)) : `[binary ${contentType ?? 'body'}: ${read.totalRead} bytes]`,
    bodyBytes: read.totalRead,
    bodyTruncated: read.truncated,
    durationMs,
    evidenceId: evidence.evidenceId,
  };
  if (contentType !== undefined) result.contentType = contentType;
  if (bodyError !== undefined) result.bodyError = bodyError;
  const wantsJson = input.expectJson === true || (contentType !== undefined && /[/+]json\b/i.test(contentType));
  if (wantsJson && textual && method !== 'HEAD') {
    if (bodyError !== undefined) result.jsonError = `${bodyError}; not parsed`;
    else if (read.truncated) result.jsonError = `body truncated at ${MAX_RESPONSE_BYTES} bytes; not parsed`;
    else if (read.totalRead > MAX_JSON_BYTES) result.jsonError = `body of ${read.totalRead} bytes exceeds ${MAX_JSON_BYTES}; see evidence ${evidence.evidenceId}`;
    else if (fullText.trim() === '') result.jsonError = 'empty body';
    else {
      try {
        result.json = JSON.parse(fullText) as JsonValue;
      } catch (e) {
        result.jsonError = `invalid JSON: ${errorMessage(e)}`;
      }
    }
  }
  const headerLines = ['content-type', 'location', 'retry-after'].filter((h) => responseHeaders[h] !== undefined).map((h) => `${h}: ${responseHeaders[h]}`);
  const text = [`HTTP ${res.status} ${res.statusText} — ${method} ${result.url} (${durationMs} ms, ${read.totalRead} bytes; evidence ${evidence.evidenceId})`, ...headerLines, '', result.bodyPreview].join('\n');
  return { status: 'success', structured: result as unknown as JsonValue, text, evidenceRefs: [evidence.evidenceId] };
}

/**
 * The request path as an oracle names it (`http_expectation.path`): for an environment-addressed request the path below
 * the environment's baseUrl path prefix (`/api/` + `/ok` ⇒ `/ok`), else the URL's pathname; never the query.
 */
function requestPath(input: HttpRequestInput, url: URL, envs: ToolContext['environments']): string {
  if (input.environmentId === undefined) return url.pathname;
  const base = envs.get(input.environmentId)?.baseUrl;
  const prefix = base ? new URL(base).pathname.replace(/\/+$/, '') : '';
  return prefix !== '' && url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : url.pathname;
}

async function recordExchange(ctx: ToolContext, method: string, url: URL, structured: Record<string, unknown>, data: string | Uint8Array, mimeType: string, summary: string): Promise<EvidenceRecord> {
  return ctx.recordEvidence({
    evidenceType: 'api-response',
    data,
    mimeType,
    summary: summary.slice(0, 500),
    structured: JSON.parse(JSON.stringify(structured)) as JsonValue,
    provenance: { target: `${method} ${redactUrl(url)}` },
  });
}

function describeFetchError(e: unknown): string {
  const cause = (e as { cause?: unknown }).cause;
  const code = (cause as { code?: string } | undefined)?.code;
  const msg = errorMessage(e);
  return code ? `${msg} (${code})` : cause instanceof Error ? `${msg}: ${cause.message}` : msg;
}

function truncateUtf8Bytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return s;
  let n = maxBytes;
  while (n > 0 && (buf[n]! & 0xc0) === 0x80) n--;
  return buf.subarray(0, n).toString('utf8');
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
