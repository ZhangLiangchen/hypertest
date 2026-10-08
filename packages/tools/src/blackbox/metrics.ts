import { HypertestError, abortReason, isHypertestError, type JsonSchema, type JsonValue } from '@hypertest/core';
import type { ToolContext, ToolOutcome, ToolSpec } from '../contracts.ts';
import { ENV_ID_SCHEMA, checkEgress, errorMessage, readBodyLimited, redactUrl } from './common.ts';
import { resolveTarget, targetEnvironmentClass, targetResources } from './http.ts';
import { jsonSample, parsePrometheusApiResponse, parsePrometheusText, summarizeMetrics, type MetricsSummary, type PromQueryResult } from './prometheus.ts';

const MAX_METRICS_BYTES = 16 * 1024 * 1024;
const MAX_SERIES = 2000;
const MAX_SAMPLES_RETURNED = 500;
const DEFAULT_TIMEOUT_MS = 15_000;

const TIME_SCHEMA: JsonSchema = { anyOf: [{ type: 'number' }, { type: 'string', minLength: 1, maxLength: 64 }] };

export interface MetricsQueryInput {
  prometheusUrl?: string;
  environmentId?: string;
  query: string;
  time?: number | string;
  range?: { start: number | string; end: number | string; step: number | string };
  timeoutMs?: number;
}

export interface MetricsScrapeInput {
  url?: string;
  environmentId?: string;
  timeoutMs?: number;
}

function denied(reason: string): ToolOutcome {
  return { status: 'failed', error: { code: 'permission_denied', message: reason } };
}

function asFailure(e: unknown): ToolOutcome {
  if (isHypertestError(e)) return { status: 'failed', error: { code: e.code, message: e.message } };
  throw e;
}

async function fetchLimited(url: URL, accept: string, timeoutMs: number, ctx: ToolContext): Promise<{ status: number; text: string; truncated: boolean; contentType: string | undefined }> {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
  try {
    const res = await fetch(url, { method: 'GET', headers: { accept, 'user-agent': 'hypertest-blackbox/0.3' }, redirect: 'manual', signal });
    const body = await readBodyLimited(res, MAX_METRICS_BYTES);
    // a body that broke off mid-stream is not a scrape: partial metrics would silently drop series
    if (body.error !== undefined) throw body.error;
    return { status: res.status, text: Buffer.from(body.bytes).toString('utf8'), truncated: body.truncated, contentType: res.headers.get('content-type') ?? undefined };
  } catch (e) {
    if (ctx.signal.aborted) throw abortReason(ctx.signal);
    if (signal.aborted) throw new HypertestError('timeout', `GET ${redactUrl(url)} timed out after ${timeoutMs} ms`);
    throw new HypertestError('unavailable', `GET ${redactUrl(url)} failed: ${errorMessage(e)}${(e as { cause?: { code?: string } }).cause?.code ? ` (${(e as { cause: { code: string } }).cause.code})` : ''}`);
  }
}

/**
 * `metrics.query` — PromQL instant (`time`) or range (`range`) query against the Prometheus HTTP API of
 * `prometheusUrl` or the environment's `prometheusUrl`. Result series are returned with numeric values
 * (non-finite spelled `NaN`/`+Inf`/`-Inf`); the raw API JSON is recorded as `metric` evidence.
 */
export function metricsQueryTool(options: { httpAllowlist?: string[] }): ToolSpec<MetricsQueryInput> {
  return {
    id: 'metrics.query',
    title: 'Prometheus query',
    description: 'Run a PromQL instant or range query against Prometheus (prometheusUrl, or the environment\'s Prometheus) and record the raw result as metric evidence.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prometheusUrl: { type: 'string', minLength: 1, maxLength: 2048 },
        environmentId: ENV_ID_SCHEMA,
        query: { type: 'string', minLength: 1, maxLength: 20_000 },
        time: TIME_SCHEMA,
        range: {
          type: 'object',
          additionalProperties: false,
          properties: { start: TIME_SCHEMA, end: TIME_SCHEMA, step: TIME_SCHEMA },
          required: ['start', 'end', 'step'],
        },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
      },
      required: ['query'],
      allOf: [{ anyOf: [{ required: ['prometheusUrl'] }, { required: ['environmentId'] }] }, { not: { required: ['prometheusUrl', 'environmentId'] } }, { not: { required: ['time', 'range'] } }],
    },
    effect: 'read',
    riskClass: 'low',
    resources: (input, ctx) => targetResources(input.environmentId !== undefined ? { environmentId: input.environmentId } : { url: input.prometheusUrl! }, ctx.environments),
    environmentClass: (input, ctx) => targetEnvironmentClass(input.environmentId !== undefined ? { environmentId: input.environmentId } : { url: input.prometheusUrl! }, ctx.environments),
    timeoutMs: 120_000,
    async execute(input, ctx) {
      let target: ReturnType<typeof resolveTarget>;
      try {
        target = resolveTarget(input.environmentId !== undefined ? { environmentId: input.environmentId } : { url: input.prometheusUrl! }, ctx.environments, 'prometheusUrl');
      } catch (e) {
        return asFailure(e);
      }
      const base = target.url;
      const url = new URL(base.href);
      url.pathname = base.pathname.replace(/\/+$/, '') + (input.range ? '/api/v1/query_range' : '/api/v1/query');
      const check = checkEgress(url, { allowlist: options.httpAllowlist, permitHosts: ctx.permit.constraints?.allowedHosts, environmentClass: target.environmentClass, trustedOrigins: target.trustedOrigins }, ctx.environments);
      if (!check.allowed) return denied(check.reason);
      url.search = '';
      url.searchParams.set('query', input.query);
      if (input.range) {
        url.searchParams.set('start', String(input.range.start));
        url.searchParams.set('end', String(input.range.end));
        url.searchParams.set('step', String(input.range.step));
      } else if (input.time !== undefined) url.searchParams.set('time', String(input.time));

      let res: Awaited<ReturnType<typeof fetchLimited>>;
      try {
        res = await fetchLimited(url, 'application/json', input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx);
      } catch (e) {
        return asFailure(e);
      }
      let json: unknown;
      try {
        json = JSON.parse(res.text);
      } catch {
        return { status: 'failed', error: { code: 'unavailable', message: `Prometheus returned HTTP ${res.status} with a non-JSON body${res.truncated ? ' (truncated)' : ''}` } };
      }
      let parsed: PromQueryResult;
      try {
        parsed = parsePrometheusApiResponse(json);
      } catch (e) {
        if (isHypertestError(e) && e.code === 'invalid_argument') {
          const errorType = String((e.details as { errorType?: string }).errorType ?? 'error');
          return { status: 'failed', error: { code: `prometheus_${errorType}`, message: e.message } };
        }
        return asFailure(e);
      }
      const truncated = parsed.series.length > MAX_SERIES;
      const series = truncated ? parsed.series.slice(0, MAX_SERIES) : parsed.series;
      const summary = input.range ? `PromQL range query (${parsed.resultType}, ${parsed.series.length} series): ${input.query}` : `PromQL query (${parsed.resultType}, ${parsed.series.length} series): ${input.query}`;
      const evidence = await ctx.recordEvidence({
        evidenceType: 'metric',
        data: res.text,
        mimeType: 'application/json',
        summary: summary.slice(0, 500),
        structured: {
          source: 'prometheus-api',
          url: redactUrl(url),
          query: input.query,
          ...(input.time !== undefined ? { time: input.time } : {}),
          ...(input.range ? { range: input.range } : {}),
          resultType: parsed.resultType,
          seriesCount: parsed.series.length,
        } as JsonValue,
        provenance: { target: redactUrl(url) },
      });
      const structured = { resultType: parsed.resultType, series, seriesCount: parsed.series.length, truncated, evidenceId: evidence.evidenceId };
      return { status: 'success', structured: structured as unknown as JsonValue, evidenceRefs: [evidence.evidenceId] };
    },
  };
}

/**
 * `metrics.scrape` — GET a Prometheus text exposition endpoint (`url`, or the environment's `metricsUrl`),
 * parse it, derive p50/p95/p99 per histogram family (linear interpolation over cumulative buckets summed
 * across label sets) and counter totals, and record the raw text as `metric` evidence with that summary.
 */
export function metricsScrapeTool(options: { httpAllowlist?: string[] }): ToolSpec<MetricsScrapeInput> {
  return {
    id: 'metrics.scrape',
    title: 'Scrape metrics endpoint',
    description: 'Scrape a Prometheus text exposition endpoint (url, or the environment metricsUrl), returning families, histogram quantiles (p50/p95/p99) and counters; records metric evidence.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 2048 },
        environmentId: ENV_ID_SCHEMA,
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
      },
      allOf: [{ anyOf: [{ required: ['url'] }, { required: ['environmentId'] }] }, { not: { required: ['url', 'environmentId'] } }],
    },
    effect: 'read',
    riskClass: 'low',
    resources: (input, ctx) => targetResources(input, ctx.environments),
    environmentClass: (input, ctx) => targetEnvironmentClass(input, ctx.environments),
    timeoutMs: 120_000,
    async execute(input, ctx) {
      let target: ReturnType<typeof resolveTarget>;
      try {
        target = resolveTarget(input.environmentId !== undefined ? { environmentId: input.environmentId } : { url: input.url! }, ctx.environments, 'metricsUrl');
      } catch (e) {
        return asFailure(e);
      }
      const check = checkEgress(target.url, { allowlist: options.httpAllowlist, permitHosts: ctx.permit.constraints?.allowedHosts, environmentClass: target.environmentClass, trustedOrigins: target.trustedOrigins }, ctx.environments);
      if (!check.allowed) return denied(check.reason);
      let res: Awaited<ReturnType<typeof fetchLimited>>;
      try {
        res = await fetchLimited(target.url, 'text/plain;version=0.0.4;q=1,*/*;q=0.1', input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx);
      } catch (e) {
        return asFailure(e);
      }
      if (res.status < 200 || res.status > 299) {
        return { status: 'failed', error: { code: 'unavailable', message: `metrics endpoint ${redactUrl(target.url)} returned HTTP ${res.status}` } };
      }
      const parsed = parsePrometheusText(res.text);
      const summary: MetricsSummary = summarizeMetrics(parsed);
      const samples = parsed.families.flatMap((f) => f.samples).slice(0, MAX_SAMPLES_RETURNED).map(jsonSample);
      const quantileText = Object.entries(summary.quantiles)
        .map(([name, q]) => `${name} p50=${q.p50 ?? 'n/a'} p95=${q.p95 ?? 'n/a'} p99=${q.p99 ?? 'n/a'}`)
        .join('; ');
      const evidence = await ctx.recordEvidence({
        evidenceType: 'metric',
        data: res.text,
        mimeType: res.contentType ?? 'text/plain; version=0.0.4',
        summary: `metrics scrape of ${redactUrl(target.url)}: ${summary.families.length} families, ${summary.sampleCount} samples${quantileText ? `; ${quantileText}` : ''}`.slice(0, 500),
        structured: { source: 'prometheus-text', url: redactUrl(target.url), truncated: res.truncated, ...summary } as unknown as JsonValue,
        provenance: { target: redactUrl(target.url) },
      });
      const structured = { ...summary, samples, samplesTruncated: parsed.sampleCount > samples.length, bodyTruncated: res.truncated, evidenceId: evidence.evidenceId };
      return { status: 'success', structured: structured as unknown as JsonValue, evidenceRefs: [evidence.evidenceId] };
    },
  };
}
