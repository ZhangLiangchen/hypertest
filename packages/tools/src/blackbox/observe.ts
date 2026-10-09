import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HypertestError, abortReason, isHypertestError, type JsonSchema, type JsonValue } from '@hypertest/core';
import type { EnvironmentDescriptor, ToolContext, ToolOutcome, ToolSpec } from '../contracts.ts';
import { CONTROL_TOKEN_HEADER, ENV_ID_SCHEMA, checkHost, errorMessage, readBodyLimited, redactUrl, requireEnvironment, runCommand, splitControlTarget, tailFile } from './common.ts';
import { mintControlToken } from './secrets.ts';
import { redactSecrets } from '../whitebox/runtime.ts';
import { OPERATION_HEADER } from './process-supervisor.ts';

/**
 * (wave 3, row 249) Black-box observation tools of registered environments — all reads (`read`/low), anchored to the
 * environment (resource `env/<id>`, evidence provenance at its generation), secrets scrubbed from what they record:
 *  - `logs.query`: the environment's logs — the process supervisor's captured child output (`GET <control>/logs`,
 *    authorized with an operation-bound control token), `docker logs` of its container, `kubectl logs` of its deployment,
 *    or one of the files the operator declared (`logs.files`) — recorded as `log` evidence;
 *  - `trace.query`: distributed traces from the environment's trace backend (`traces`): an OTLP/JSON export file, the
 *    Jaeger query API or the Tempo HTTP API, normalized to spans (service, name, timing, status, attributes) and recorded
 *    as `trace` evidence;
 *  - `net.capture`: a packet capture (pcap) of the environment's traffic for a time window through `tcpdump` (filtered to
 *    the environment's host and port), recorded as `pcap` evidence. It needs tcpdump and the capture privilege on the
 *    Hypertest host; without them the call fails `unsupported` / `permission_denied` with the reason. HTTP exchanges are
 *    captured without tcpdump: http.request / browser.navigate evidence, and the sandbox egress relay (`captureNetwork`
 *    of test.run / shell.exec records every relayed exchange of the call as `network-capture` evidence).
 */

const MAX_LOG_LINES = 5000;
const MAX_TRACE_BYTES = 32 * 1024 * 1024;
const MAX_PCAP_BYTES = 64 * 1024 * 1024;
/** How long net.capture waits for tcpdump to report "listening on …" before its capture window starts anyway. */
const CAPTURE_START_GRACE_MS = 10_000;

function failure(e: unknown): ToolOutcome {
  if (isHypertestError(e)) return { status: 'failed', error: { code: e.code, message: e.message } };
  throw e;
}

const scrubber = (ctx: ToolContext) => (t: string): string => (ctx.secrets ? ctx.secrets.redact(t) : t);

// ----------------------------------------------------------------------------- logs.query

export interface LogsQueryInput {
  environmentId: string;
  /** `auto` (default): the control target's logs (supervisor / docker / kubectl), else the first declared file. */
  source?: 'auto' | 'supervisor' | 'docker' | 'kubectl' | 'file';
  /** One of the environment's `logs.files` (source `file`). */
  file?: string;
  /** Only lines from the last N seconds (docker / kubectl). */
  sinceSeconds?: number;
  /** The last N lines (default 200). */
  tail?: number;
  /** Keep only lines containing this text (applied to a window of the last 5000 lines). */
  contains?: string;
  timeoutMs?: number;
}

type LogSource = 'supervisor' | 'docker' | 'kubectl' | 'file';

function logSource(env: EnvironmentDescriptor, input: LogsQueryInput): { source: LogSource; file?: string } {
  const files = env.logs?.files ?? [];
  const want = input.source ?? 'auto';
  if (want === 'file' || (want === 'auto' && input.file !== undefined)) {
    const file = input.file ?? files[0];
    if (file === undefined) throw new HypertestError('precondition_failed', `environment ${env.environmentId} declares no log files (logs.files)`);
    if (!files.includes(file)) throw new HypertestError('permission_denied', `${file} is not a log file of environment ${env.environmentId} (declared: ${files.join(', ') || 'none'})`);
    return { source: 'file', file };
  }
  const kind = env.control?.kind;
  if (want === 'auto') {
    if (kind === 'process') return { source: 'supervisor' };
    if (kind === 'docker' || kind === 'kubectl') return { source: kind };
    if (files[0] !== undefined) return { source: 'file', file: files[0] };
    throw new HypertestError('precondition_failed', `environment ${env.environmentId} has no log source (no control target, no logs.files)`);
  }
  const needed = want === 'supervisor' ? 'process' : want;
  if (kind !== needed) throw new HypertestError('precondition_failed', `environment ${env.environmentId} is not controlled by ${needed} (control: ${kind ?? 'none'}): no ${want} logs`);
  return { source: want };
}

async function readLogs(env: EnvironmentDescriptor, src: { source: LogSource; file?: string }, window: number, input: LogsQueryInput, ctx: ToolContext): Promise<{ lines: string[]; truncated: boolean; origin: string }> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const since = input.sinceSeconds;
  if (src.source === 'file') {
    const t = tailFile(src.file!, window);
    return { lines: t.lines, truncated: t.truncated, origin: src.file! };
  }
  if (src.source === 'supervisor') {
    const { url, token } = splitControlTarget(env.control!.target, `environment ${env.environmentId} control target`);
    const endpoint = new URL(`${url.href.replace(/\/+$/, '')}/logs`);
    endpoint.searchParams.set('tail', String(window));
    const readId = `logs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const headers: Record<string, string> = { accept: 'application/json', [OPERATION_HEADER]: readId };
    if (token !== undefined) headers[CONTROL_TOKEN_HEADER] = mintControlToken(token, readId, Date.now());
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
    let res: Response;
    try {
      res = await fetch(endpoint, { headers, redirect: 'manual', signal });
    } catch (e) {
      if (ctx.signal.aborted) throw abortReason(ctx.signal);
      throw new HypertestError('unavailable', `the supervisor of ${env.environmentId} is unreachable: ${errorMessage(e)}`);
    }
    const body = await readBodyLimited(res, 16 * 1024 * 1024);
    const text = Buffer.from(body.bytes).toString('utf8');
    if (res.status !== 200) throw new HypertestError(res.status === 409 ? 'precondition_failed' : 'unavailable', `supervisor logs of ${env.environmentId}: HTTP ${res.status} ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text) as { lines: string[]; truncated: boolean };
    return { lines: parsed.lines, truncated: parsed.truncated, origin: `supervisor ${redactUrl(endpoint)}` };
  }
  let bin: string;
  let args: string[];
  if (src.source === 'docker') {
    bin = 'docker';
    args = ['logs', '--timestamps', '--tail', String(window), ...(since !== undefined ? ['--since', `${since}s`] : []), env.control!.target];
  } else {
    const parts = env.control!.target.split('/');
    const deployment = parts[0] === 'deployment' ? parts[1] : parts[0];
    const container = parts[0] === 'deployment' ? parts[2] : parts[1];
    if (!deployment) throw new HypertestError('precondition_failed', `environment ${env.environmentId} control target names no deployment`);
    bin = 'kubectl';
    args = [
      ...(env.control!.context ? ['--context', env.control!.context] : []), '-n', env.control!.namespace ?? 'default',
      'logs', `deployment/${deployment}`, ...(container ? ['-c', container] : []), '--timestamps', `--tail=${window}`, ...(since !== undefined ? [`--since=${since}s`] : []),
    ];
  }
  const r = await runCommand(bin, args, { timeoutMs, signal: ctx.signal });
  if (r.exitCode !== 0) {
    if (r.spawnError) throw new HypertestError('unsupported', `${bin} is not available on this host: ${r.spawnError}`);
    throw new HypertestError('unavailable', `${bin} ${args.filter((a) => !a.startsWith('--tail')).slice(0, 6).join(' ')} failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 500)}`);
  }
  // docker writes the container's stderr to its own stderr: both streams are the container's log
  const lines = `${r.stdout}${src.source === 'docker' ? r.stderr : ''}`.split('\n').filter((l) => l !== '');
  if (src.source === 'docker') lines.sort();
  return { lines: lines.slice(-window), truncated: lines.length >= window, origin: `${bin} ${args.join(' ')}` };
}

export function logsQueryTool(): ToolSpec<LogsQueryInput> {
  return {
    id: 'logs.query',
    title: 'Environment logs',
    description:
      'Read the recent logs of a registered environment and record them as log evidence: the supervised process output, `docker logs` of its container, `kubectl logs` of its deployment, or a log file the operator declared (logs.files). ' +
      'Filter with contains / sinceSeconds; tail bounds the lines returned.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['environmentId'],
      properties: {
        environmentId: ENV_ID_SCHEMA,
        source: { type: 'string', enum: ['auto', 'supervisor', 'docker', 'kubectl', 'file'] },
        file: { type: 'string', minLength: 1, maxLength: 4096 },
        sinceSeconds: { type: 'integer', minimum: 1, maximum: 7 * 86_400 },
        tail: { type: 'integer', minimum: 1, maximum: MAX_LOG_LINES },
        contains: { type: 'string', minLength: 1, maxLength: 1000 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
      },
    } as JsonSchema,
    effect: 'read',
    riskClass: 'low',
    resources: (input) => [`env/${input.environmentId}`],
    environmentClass: (input, ctx) => requireEnvironment(ctx.environments, input.environmentId).environmentClass,
    evidenceTypes: ['log'],
    timeoutMs: 120_000,
    async execute(input, ctx) {
      const scrub = scrubber(ctx);
      try {
        const env = requireEnvironment(ctx.environments, input.environmentId);
        const src = logSource(env, input);
        const tail = input.tail ?? 200;
        const read = await readLogs(env, src, input.contains !== undefined ? MAX_LOG_LINES : tail, input, ctx);
        const matched = input.contains !== undefined ? read.lines.filter((l) => l.includes(input.contains!)) : read.lines;
        const lines = matched.slice(-tail).map(scrub);
        const text = lines.join('\n');
        const evidence = await ctx.recordEvidence({
          evidenceType: 'log',
          data: text,
          mimeType: 'text/plain',
          summary: `${lines.length} log line(s) of ${env.environmentId} from ${src.source}${input.contains !== undefined ? ` containing ${JSON.stringify(input.contains.slice(0, 60))}` : ''}`.slice(0, 500),
          structured: {
            environmentId: env.environmentId, source: src.source, ...(src.file !== undefined ? { file: src.file } : {}), origin: scrub(read.origin),
            lineCount: lines.length, matchedLines: matched.length, windowTruncated: read.truncated,
            ...(input.contains !== undefined ? { contains: input.contains } : {}), ...(input.sinceSeconds !== undefined ? { sinceSeconds: input.sinceSeconds } : {}),
          } as JsonValue,
          provenance: { target: `env/${env.environmentId}` },
        });
        const shown = text.length > 16_000 ? `…${text.slice(-16_000)}` : text;
        return {
          status: 'success',
          structured: { source: src.source, lineCount: lines.length, matchedLines: matched.length, evidenceId: evidence.evidenceId } as JsonValue,
          text: `${lines.length} line(s) from ${src.source} (evidence ${evidence.evidenceId})\n${shown}`,
          evidenceRefs: [evidence.evidenceId],
        };
      } catch (e) {
        return failure(e);
      }
    },
  };
}

// ----------------------------------------------------------------------------- trace.query

export interface TraceQueryInput {
  environmentId: string;
  traceId?: string;
  service?: string;
  operation?: string;
  lookbackSeconds?: number;
  limit?: number;
  minDurationMs?: number;
  errorsOnly?: boolean;
  timeoutMs?: number;
}

/** A span normalized from OTLP/JSON, Jaeger or Tempo. */
export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string;
  name: string;
  startTime: string;
  durationMs: number;
  status: 'ok' | 'error' | 'unset';
  attributes: Record<string, string | number | boolean>;
}

export interface TraceSummary {
  traceId: string;
  rootService: string;
  rootName: string;
  startTime: string;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  spans: TraceSpan[];
}

type OtlpValue = { stringValue?: string; intValue?: string | number; boolValue?: boolean; doubleValue?: number; arrayValue?: unknown; kvlistValue?: unknown };

function otlpValue(v: OtlpValue | undefined): string | number | boolean {
  if (!v) return '';
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  return JSON.stringify(v.arrayValue ?? v.kvlistValue ?? '');
}

function attrs(list: Array<{ key: string; value?: OtlpValue }> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const a of list ?? []) if (a && typeof a.key === 'string') out[a.key] = otlpValue(a.value);
  return out;
}

/** OTLP ids are hex in OTLP/JSON (base64 in some exporters' protobuf-JSON); normalized to lower-case hex. */
function otlpId(id: unknown): string {
  if (typeof id !== 'string') return '';
  if (/^[0-9a-fA-F]+$/.test(id)) return id.toLowerCase();
  try {
    return Buffer.from(id, 'base64').toString('hex');
  } catch {
    return id;
  }
}

/** Spans of an OTLP/JSON document (`resourceSpans`, or Tempo's older `batches`). */
export function otlpSpans(doc: unknown): TraceSpan[] {
  const d = doc as { resourceSpans?: unknown[]; batches?: unknown[] } | null;
  const resources = (d?.resourceSpans ?? d?.batches ?? []) as Array<{ resource?: { attributes?: Array<{ key: string; value?: OtlpValue }> }; scopeSpans?: Array<{ spans?: unknown[] }>; instrumentationLibrarySpans?: Array<{ spans?: unknown[] }> }>;
  const out: TraceSpan[] = [];
  for (const rs of resources) {
    const service = String(attrs(rs.resource?.attributes)['service.name'] ?? 'unknown');
    for (const ss of [...(rs.scopeSpans ?? []), ...(rs.instrumentationLibrarySpans ?? [])]) {
      for (const raw of ss.spans ?? []) {
        const s = raw as { traceId?: string; spanId?: string; parentSpanId?: string; name?: string; startTimeUnixNano?: string | number; endTimeUnixNano?: string | number; status?: { code?: number | string }; attributes?: Array<{ key: string; value?: OtlpValue }> };
        const start = BigInt(String(s.startTimeUnixNano ?? '0'));
        const end = BigInt(String(s.endTimeUnixNano ?? s.startTimeUnixNano ?? '0'));
        const code = s.status?.code;
        const status = code === 2 || code === 'STATUS_CODE_ERROR' ? 'error' : code === 1 || code === 'STATUS_CODE_OK' ? 'ok' : 'unset';
        const parent = otlpId(s.parentSpanId);
        out.push({
          traceId: otlpId(s.traceId), spanId: otlpId(s.spanId), ...(parent ? { parentSpanId: parent } : {}), service, name: String(s.name ?? ''),
          startTime: new Date(Number(start / 1_000_000n)).toISOString(), durationMs: Number(end - start) / 1e6, status, attributes: attrs(s.attributes),
        });
      }
    }
  }
  return out;
}

/** Spans of a Jaeger query API trace (`data[]` of /api/traces). */
export function jaegerSpans(trace: unknown): TraceSpan[] {
  const t = trace as { spans?: unknown[]; processes?: Record<string, { serviceName?: string }> };
  return (t.spans ?? []).map((raw) => {
    const s = raw as { traceID: string; spanID: string; operationName?: string; startTime?: number; duration?: number; processID?: string; references?: Array<{ refType?: string; spanID?: string }>; tags?: Array<{ key: string; value: unknown }> };
    const tags: Record<string, string | number | boolean> = {};
    for (const tag of s.tags ?? []) tags[tag.key] = typeof tag.value === 'number' || typeof tag.value === 'boolean' ? tag.value : String(tag.value);
    const parent = (s.references ?? []).find((r) => r.refType === 'CHILD_OF')?.spanID;
    const status = tags['error'] === true || tags['error'] === 'true' || tags['otel.status_code'] === 'ERROR' ? 'error' : tags['otel.status_code'] === 'OK' ? 'ok' : 'unset';
    return {
      traceId: String(s.traceID).toLowerCase(), spanId: String(s.spanID).toLowerCase(), ...(parent ? { parentSpanId: parent.toLowerCase() } : {}),
      service: t.processes?.[s.processID ?? '']?.serviceName ?? 'unknown', name: s.operationName ?? '',
      startTime: new Date(Math.floor((s.startTime ?? 0) / 1000)).toISOString(), durationMs: (s.duration ?? 0) / 1000, status, attributes: tags,
    };
  });
}

/** Groups spans into traces (root = the span without a parent in the trace, else the earliest). */
export function summarizeTraces(spans: TraceSpan[]): TraceSummary[] {
  const byTrace = new Map<string, TraceSpan[]>();
  for (const s of spans) byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);
  const out: TraceSummary[] = [];
  for (const [traceId, list] of byTrace) {
    list.sort((a, b) => a.startTime.localeCompare(b.startTime));
    const ids = new Set(list.map((s) => s.spanId));
    const root = list.find((s) => !s.parentSpanId || !ids.has(s.parentSpanId)) ?? list[0]!;
    const start = Math.min(...list.map((s) => Date.parse(s.startTime)));
    const end = Math.max(...list.map((s) => Date.parse(s.startTime) + s.durationMs));
    out.push({ traceId, rootService: root.service, rootName: root.name, startTime: new Date(start).toISOString(), durationMs: Math.max(root.durationMs, end - start), spanCount: list.length, errorCount: list.filter((s) => s.status === 'error').length, spans: list });
  }
  return out.sort((a, b) => b.startTime.localeCompare(a.startTime));
}

async function getJson(url: URL, ctx: ToolContext, timeoutMs: number): Promise<{ status: number; json: unknown; raw: string }> {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'manual', signal });
  } catch (e) {
    if (ctx.signal.aborted) throw abortReason(ctx.signal);
    if (signal.aborted) throw new HypertestError('timeout', `GET ${redactUrl(url)} timed out after ${timeoutMs} ms`);
    throw new HypertestError('unavailable', `GET ${redactUrl(url)} failed: ${errorMessage(e)}`);
  }
  const body = await readBodyLimited(res, MAX_TRACE_BYTES);
  const raw = Buffer.from(body.bytes).toString('utf8');
  if (res.status === 404) return { status: 404, json: undefined, raw };
  if (res.status !== 200) throw new HypertestError('unavailable', `GET ${redactUrl(url)}: HTTP ${res.status} ${raw.slice(0, 300)}`);
  try {
    return { status: 200, json: JSON.parse(raw), raw };
  } catch {
    throw new HypertestError('unavailable', `GET ${redactUrl(url)} returned a non-JSON body`);
  }
}

function backendUrl(base: string, path: string): URL {
  const u = new URL(base);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}${path}`;
  u.search = '';
  return u;
}

async function querySpans(env: EnvironmentDescriptor, input: TraceQueryInput, ctx: ToolContext): Promise<{ spans: TraceSpan[]; source: string; raw: string }> {
  const cfg = env.traces;
  if (!cfg) throw new HypertestError('precondition_failed', `environment ${env.environmentId} declares no trace backend (traces)`);
  const timeoutMs = input.timeoutMs ?? 30_000;
  const service = input.service ?? cfg.service;
  const lookbackMs = (input.lookbackSeconds ?? 3600) * 1000;
  const limit = input.limit ?? 20;
  if (cfg.kind === 'otlp_file') {
    const t = tailFile(cfg.path!, 100_000, MAX_TRACE_BYTES);
    const spans: TraceSpan[] = [];
    for (const line of t.lines) {
      if (line.trim() === '') continue;
      try {
        spans.push(...otlpSpans(JSON.parse(line)));
      } catch {
        // a partial last line of a file being written
      }
    }
    return { spans, source: `otlp_file ${cfg.path}`, raw: '' };
  }
  // the backend is operator-configured (trusted origin); the permit's allowedHosts constraint still applies
  const backend = new URL(cfg.url!);
  const egress = checkHost(backend, { permitHosts: ctx.permit.constraints?.allowedHosts, trustedOrigins: [backend.origin] });
  if (!egress.allowed) throw new HypertestError('permission_denied', `trace backend refused: ${egress.reason}`);
  if (cfg.kind === 'jaeger') {
    if (input.traceId !== undefined) {
      const r = await getJson(backendUrl(cfg.url!, `/api/traces/${encodeURIComponent(input.traceId)}`), ctx, timeoutMs);
      return { spans: ((r.json as { data?: unknown[] } | undefined)?.data ?? []).flatMap(jaegerSpans), source: `jaeger ${redactUrl(new URL(cfg.url!))}`, raw: r.raw };
    }
    if (service === undefined) throw new HypertestError('invalid_argument', 'service is required (or traces.service of the environment) to search Jaeger');
    const u = backendUrl(cfg.url!, '/api/traces');
    u.searchParams.set('service', service);
    if (input.operation !== undefined) u.searchParams.set('operation', input.operation);
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('lookback', `${Math.ceil(lookbackMs / 1000)}s`);
    u.searchParams.set('start', String((Date.now() - lookbackMs) * 1000));
    u.searchParams.set('end', String(Date.now() * 1000));
    if (input.minDurationMs !== undefined) u.searchParams.set('minDuration', `${input.minDurationMs}ms`);
    const r = await getJson(u, ctx, timeoutMs);
    return { spans: ((r.json as { data?: unknown[] } | undefined)?.data ?? []).flatMap(jaegerSpans), source: `jaeger ${redactUrl(u)}`, raw: r.raw };
  }
  // tempo
  if (input.traceId !== undefined) {
    const r = await getJson(backendUrl(cfg.url!, `/api/traces/${encodeURIComponent(input.traceId)}`), ctx, timeoutMs);
    return { spans: r.json ? otlpSpans(r.json) : [], source: `tempo ${redactUrl(new URL(cfg.url!))}`, raw: r.raw };
  }
  const u = backendUrl(cfg.url!, '/api/search');
  const tags = [...(service !== undefined ? [`service.name=${service}`] : []), ...(input.operation !== undefined ? [`name=${input.operation}`] : []), ...(input.errorsOnly ? ['status.code=error'] : [])];
  if (tags.length > 0) u.searchParams.set('tags', tags.join(' '));
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('start', String(Math.floor((Date.now() - lookbackMs) / 1000)));
  u.searchParams.set('end', String(Math.ceil(Date.now() / 1000)));
  if (input.minDurationMs !== undefined) u.searchParams.set('minDuration', `${input.minDurationMs}ms`);
  const found = await getJson(u, ctx, timeoutMs);
  const ids = ((found.json as { traces?: Array<{ traceID?: string }> } | undefined)?.traces ?? []).map((t) => t.traceID).filter((x): x is string => typeof x === 'string').slice(0, limit);
  const spans: TraceSpan[] = [];
  for (const id of ids) {
    const r = await getJson(backendUrl(cfg.url!, `/api/traces/${encodeURIComponent(id)}`), ctx, timeoutMs);
    if (r.json) spans.push(...otlpSpans(r.json));
  }
  return { spans, source: `tempo ${redactUrl(u)}`, raw: found.raw };
}

export function traceQueryTool(): ToolSpec<TraceQueryInput> {
  return {
    id: 'trace.query',
    title: 'Trace query',
    description:
      'Query distributed traces of a registered environment from its trace backend (OTLP/JSON export file, Jaeger or Tempo, as the operator configured): by traceId, or search by service / operation / lookback / minDurationMs / errorsOnly. ' +
      'Returns traces with their spans (service, name, duration, status, attributes) and records them as trace evidence.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['environmentId'],
      properties: {
        environmentId: ENV_ID_SCHEMA,
        traceId: { type: 'string', pattern: '^[0-9a-fA-F]{8,64}$' },
        service: { type: 'string', minLength: 1, maxLength: 256 },
        operation: { type: 'string', minLength: 1, maxLength: 512 },
        lookbackSeconds: { type: 'integer', minimum: 1, maximum: 7 * 86_400 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        minDurationMs: { type: 'number', minimum: 0 },
        errorsOnly: { type: 'boolean' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
      },
    } as JsonSchema,
    effect: 'read',
    riskClass: 'low',
    resources: (input) => [`env/${input.environmentId}`],
    environmentClass: (input, ctx) => requireEnvironment(ctx.environments, input.environmentId).environmentClass,
    evidenceTypes: ['trace'],
    timeoutMs: 120_000,
    async execute(input, ctx) {
      const scrub = scrubber(ctx);
      try {
        const env = requireEnvironment(ctx.environments, input.environmentId);
        const q = await querySpans(env, input, ctx);
        const since = Date.now() - (input.lookbackSeconds ?? 3600) * 1000;
        const service = input.service ?? env.traces?.service;
        // secret-named attributes (db.password, auth tokens) and known secret values never land in evidence
        let traces = summarizeTraces(q.spans.map((s) => ({ ...s, attributes: JSON.parse(scrub(JSON.stringify(redactSecrets(s.attributes)))) as TraceSpan['attributes'] })));
        // the same filters on every backend (a file has no query API; the APIs may ignore some parameters)
        if (input.traceId !== undefined) traces = traces.filter((t) => t.traceId === input.traceId!.toLowerCase());
        else {
          traces = traces.filter((t) => Date.parse(t.startTime) >= since);
          if (service !== undefined) traces = traces.filter((t) => t.spans.some((s) => s.service === service));
          if (input.operation !== undefined) traces = traces.filter((t) => t.spans.some((s) => s.name === input.operation));
        }
        if (input.minDurationMs !== undefined) traces = traces.filter((t) => t.durationMs >= input.minDurationMs!);
        if (input.errorsOnly) traces = traces.filter((t) => t.errorCount > 0);
        traces = traces.slice(0, input.limit ?? 20);
        const doc = { backend: env.traces!.kind, source: q.source, query: { ...input }, traceCount: traces.length, traces };
        const evidence = await ctx.recordEvidence({
          evidenceType: 'trace',
          data: JSON.stringify(doc),
          mimeType: 'application/json',
          summary: `${traces.length} trace(s) of ${env.environmentId} from ${env.traces!.kind}${input.traceId ? ` (trace ${input.traceId})` : ''}${traces.some((t) => t.errorCount > 0) ? `, ${traces.filter((t) => t.errorCount > 0).length} with errors` : ''}`.slice(0, 500),
          structured: { backend: env.traces!.kind, traceCount: traces.length, traces: traces.map((t) => ({ ...t, spans: t.spans.slice(0, 200) })) } as unknown as JsonValue,
          provenance: { target: `env/${env.environmentId}` },
        });
        const lines = traces.map((t) => `${t.traceId} ${t.rootService} ${t.rootName} ${t.durationMs.toFixed(1)} ms, ${t.spanCount} span(s)${t.errorCount ? `, ${t.errorCount} error(s)` : ''}`);
        return {
          status: 'success',
          structured: { traceCount: traces.length, traces: traces.map((t) => ({ traceId: t.traceId, rootService: t.rootService, rootName: t.rootName, startTime: t.startTime, durationMs: t.durationMs, spanCount: t.spanCount, errorCount: t.errorCount })), evidenceId: evidence.evidenceId } as unknown as JsonValue,
          text: `${traces.length} trace(s) (evidence ${evidence.evidenceId})\n${lines.join('\n')}`,
          evidenceRefs: [evidence.evidenceId],
        };
      } catch (e) {
        return failure(e);
      }
    },
  };
}

// ----------------------------------------------------------------------------- net.capture

export interface NetCaptureInput {
  environmentId: string;
  durationMs: number;
  /** Capture interface (default `lo` for a loopback environment, else `any`). */
  interface?: string;
  maxPackets?: number;
}

/** Packet count of a classic pcap file (microsecond or nanosecond, either byte order); undefined for another format. */
export function pcapPacketCount(bytes: Buffer): number | undefined {
  if (bytes.byteLength < 24) return undefined;
  const magic = bytes.readUInt32LE(0);
  let le: boolean;
  if (magic === 0xa1b2c3d4 || magic === 0xa1b23c4d) le = true;
  else if (magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1) le = false;
  else return undefined;
  let off = 24;
  let n = 0;
  while (off + 16 <= bytes.byteLength) {
    const incl = le ? bytes.readUInt32LE(off + 8) : bytes.readUInt32BE(off + 8);
    off += 16 + incl;
    if (off > bytes.byteLength) break;
    n++;
  }
  return n;
}

export function netCaptureTool(options: { tcpdump?: string } = {}): ToolSpec<NetCaptureInput> {
  return {
    id: 'net.capture',
    title: 'Packet capture',
    description:
      'Capture the network traffic of a registered environment (its host and port) for durationMs with tcpdump and record it as pcap evidence (packet count in the result). ' +
      'Run it while traffic flows (e.g. after load.start). Needs tcpdump with capture privilege on the Hypertest host; otherwise it fails unsupported/permission_denied — HTTP exchanges are also recorded by http.request evidence and by test.run/shell.exec with captureNetwork.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['environmentId', 'durationMs'],
      properties: {
        environmentId: ENV_ID_SCHEMA,
        durationMs: { type: 'integer', minimum: 100, maximum: 120_000 },
        interface: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$' },
        maxPackets: { type: 'integer', minimum: 1, maximum: 1_000_000 },
      },
    } as JsonSchema,
    effect: 'read',
    riskClass: 'medium',
    resources: (input) => [`env/${input.environmentId}`],
    environmentClass: (input, ctx) => requireEnvironment(ctx.environments, input.environmentId).environmentClass,
    evidenceTypes: ['pcap'],
    timeoutMs: 180_000,
    async execute(input, ctx) {
      let dir: string | undefined;
      try {
        const env = requireEnvironment(ctx.environments, input.environmentId);
        if (!env.baseUrl) throw new HypertestError('precondition_failed', `environment ${env.environmentId} has no baseUrl: nothing to capture`);
        const base = new URL(env.baseUrl);
        const host = base.hostname.replace(/^\[|\]$/g, '');
        const port = base.port !== '' ? Number(base.port) : base.protocol === 'https:' ? 443 : 80;
        if (!/^[A-Za-z0-9.:_-]+$/.test(host)) throw new HypertestError('invalid_argument', `unsupported host ${host}`);
        const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.');
        const iface = input.interface ?? (loopback ? 'lo' : 'any');
        dir = mkdtempSync(join(tmpdir(), 'ht-pcap-'));
        const file = join(dir, 'capture.pcap');
        const args = ['-i', iface, '-n', '-U', '-s', '0', '-c', String(input.maxPackets ?? 100_000), '-w', file, 'host', host, 'and', 'tcp', 'port', String(port)];
        const bin = options.tcpdump ?? 'tcpdump';
        const result = await new Promise<{ code: number | null; stderr: string; spawnError?: string }>((resolve) => {
          const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
          let stderr = '';
          // the capture window starts when tcpdump has opened the device ("listening on …"): a SIGINT before that would
          // end a capture that never ran (and hide why it could not start, e.g. a missing privilege). A tcpdump that never
          // says so is given CAPTURE_START_GRACE_MS before the window starts anyway.
          let stop: NodeJS.Timeout | undefined;
          const startWindow = () => {
            if (stop !== undefined) return;
            clearTimeout(grace);
            stop = setTimeout(() => child.kill('SIGINT'), input.durationMs);
          };
          const grace = setTimeout(startWindow, CAPTURE_START_GRACE_MS);
          child.stderr.on('data', (c: Buffer) => {
            if (stderr.length < 8192) stderr += c.toString('utf8');
            if (/listening on /.test(stderr)) startWindow();
          });
          const abort = () => child.kill('SIGKILL');
          ctx.signal.addEventListener('abort', abort, { once: true });
          const settle = () => {
            clearTimeout(grace);
            if (stop !== undefined) clearTimeout(stop);
            ctx.signal.removeEventListener('abort', abort);
          };
          child.on('error', (e) => {
            settle();
            resolve({ code: null, stderr, spawnError: (e as NodeJS.ErrnoException).code ?? e.message });
          });
          child.on('close', (code) => {
            settle();
            resolve({ code, stderr });
          });
        });
        if (ctx.signal.aborted) throw abortReason(ctx.signal);
        if (result.spawnError === 'ENOENT') throw new HypertestError('unsupported', 'tcpdump is not installed on this host: packet capture is unavailable (HTTP exchanges are recorded by http.request evidence and by test.run/shell.exec captureNetwork)');
        if (result.spawnError) throw new HypertestError('unavailable', `tcpdump could not start: ${result.spawnError}`);
        let bytes: Buffer;
        try {
          bytes = readFileSync(file);
        } catch {
          bytes = Buffer.alloc(0);
        }
        if (bytes.byteLength === 0) {
          const denied = /permission|not permitted|privilege/i.test(result.stderr);
          throw new HypertestError(denied ? 'permission_denied' : 'unavailable', `tcpdump captured nothing (exit ${result.code}): ${result.stderr.trim().slice(0, 500)}`);
        }
        if (bytes.byteLength > MAX_PCAP_BYTES) bytes = bytes.subarray(0, MAX_PCAP_BYTES);
        const packets = pcapPacketCount(bytes);
        const evidence = await ctx.recordEvidence({
          evidenceType: 'pcap',
          data: bytes,
          mimeType: 'application/vnd.tcpdump.pcap',
          summary: `packet capture of ${env.environmentId} (${host}:${port} on ${iface}, ${input.durationMs} ms): ${packets ?? '?'} packet(s)`.slice(0, 500),
          structured: { environmentId: env.environmentId, host, port, interface: iface, durationMs: input.durationMs, packets: packets ?? null, bytes: bytes.byteLength, filter: args.slice(args.indexOf('host')).join(' ') } as JsonValue,
          provenance: { target: `env/${env.environmentId}`, command: [bin, ...args.map((a) => (a === file ? '<capture.pcap>' : a))] },
        });
        return {
          status: 'success',
          structured: { packets: packets ?? null, bytes: bytes.byteLength, evidenceId: evidence.evidenceId } as JsonValue,
          text: `captured ${packets ?? '?'} packet(s), ${bytes.byteLength} bytes (pcap evidence ${evidence.evidenceId})`,
          evidenceRefs: [evidence.evidenceId],
        };
      } catch (e) {
        return failure(e);
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The observation tools (logs.query, trace.query, net.capture). */
export function observeTools(options: { tcpdump?: string } = {}): ToolSpec[] {
  return [logsQueryTool(), traceQueryTool(), netCaptureTool(options)] as ToolSpec[];
}
