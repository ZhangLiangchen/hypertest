import { HypertestError } from '@hypertest/core';
import { finiteOrNull, jsonNumber } from './common.ts';

/**
 * Prometheus text exposition format (0.0.4, plus the OpenMetrics spellings that commonly appear in it)
 * and Prometheus HTTP API result parsing. Pure functions; no I/O.
 */

export type PromMetricType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped' | 'gaugehistogram' | 'info' | 'stateset' | 'unknown';

export interface PromSample {
  /** Full sample name (e.g. `http_request_duration_seconds_bucket`). */
  name: string;
  labels: Record<string, string>;
  /** May be NaN / ±Infinity. */
  value: number;
  timestampMs?: number;
}

export interface PromFamily {
  name: string;
  type: PromMetricType;
  help?: string;
  samples: PromSample[];
}

export interface PromParseError {
  line: number;
  message: string;
}

export interface PromParseResult {
  families: PromFamily[];
  sampleCount: number;
  errors: PromParseError[];
}

const TYPES: ReadonlySet<string> = new Set(['counter', 'gauge', 'histogram', 'summary', 'untyped', 'gaugehistogram', 'info', 'stateset', 'unknown']);
const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*/;
/** Suffixes that attach a sample to a histogram/summary (or OpenMetrics counter) family. */
const FAMILY_SUFFIXES: Record<string, readonly string[]> = {
  histogram: ['_bucket', '_sum', '_count', '_created'],
  gaugehistogram: ['_bucket', '_gsum', '_gcount'],
  summary: ['_sum', '_count', '_created'],
  counter: ['_total', '_created'],
  info: ['_info'],
};

/** Parses a Prometheus float: decimal/exponent forms, `NaN`, `+Inf`, `-Inf`, `Inf` (case-insensitive). */
export function parsePromValue(raw: string): number {
  const s = raw.trim();
  const lower = s.toLowerCase();
  if (lower === 'nan') return Number.NaN;
  if (lower === '+inf' || lower === 'inf') return Number.POSITIVE_INFINITY;
  if (lower === '-inf') return Number.NEGATIVE_INFINITY;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) && !/^[+-]?0[xX][0-9a-fA-F]+$/.test(s)) {
    throw new HypertestError('invalid_argument', `invalid sample value ${JSON.stringify(raw)}`);
  }
  const v = Number(s);
  if (Number.isNaN(v)) throw new HypertestError('invalid_argument', `invalid sample value ${JSON.stringify(raw)}`);
  return v;
}

function unescapeHelp(s: string): string {
  return s.replace(/\\(\\|n)/g, (_m, c: string) => (c === 'n' ? '\n' : '\\'));
}

/** Parses `{a="x",b="y\"z"}` starting at `pos` (which points at `{`); returns labels and the next index. */
function parseLabels(line: string, pos: number): { labels: Record<string, string>; next: number } {
  const labels: Record<string, string> = {};
  let i = pos + 1;
  const skipWs = () => {
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  };
  for (;;) {
    skipWs();
    if (line[i] === '}') return { labels, next: i + 1 };
    const m = LABEL_NAME_RE.exec(line.slice(i));
    if (!m) throw new Error(`invalid label name at column ${i + 1}`);
    const name = m[0];
    i += name.length;
    skipWs();
    if (line[i] !== '=') throw new Error(`expected "=" after label ${name}`);
    i++;
    skipWs();
    if (line[i] !== '"') throw new Error(`expected quoted value for label ${name}`);
    i++;
    let value = '';
    for (;;) {
      if (i >= line.length) throw new Error(`unterminated value for label ${name}`);
      const c = line[i]!;
      if (c === '\\') {
        const n = line[i + 1];
        if (n === 'n') value += '\n';
        else if (n === '\\') value += '\\';
        else if (n === '"') value += '"';
        else throw new Error(`invalid escape \\${n ?? ''} in label ${name}`);
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        break;
      }
      value += c;
      i++;
    }
    if (Object.hasOwn(labels, name)) throw new Error(`duplicate label ${name}`);
    labels[name] = value;
    skipWs();
    if (line[i] === ',') {
      i++;
      continue;
    }
    if (line[i] === '}') return { labels, next: i + 1 };
    throw new Error(`expected "," or "}" after label ${name}`);
  }
}

/**
 * Parses the text exposition format. Lenient: malformed lines are reported in `errors` (1-based line
 * numbers) and skipped; the rest is still returned. Samples are attached to the family declared by
 * `# TYPE` (histogram `_bucket/_sum/_count`, summary `_sum/_count`, OpenMetrics counter `_total`);
 * samples without a declaration form an `untyped` family of their own name.
 */
export function parsePrometheusText(text: string): PromParseResult {
  const families = new Map<string, PromFamily>();
  const order: string[] = [];
  const errors: PromParseError[] = [];
  let sampleCount = 0;
  const family = (name: string): PromFamily => {
    let f = families.get(name);
    if (!f) {
      f = { name, type: 'untyped', samples: [] };
      families.set(name, f);
      order.push(name);
    }
    return f;
  };
  /** Explicitly declared types (by family name). */
  const declared = new Map<string, PromMetricType>();
  const familyOf = (sampleName: string): PromFamily => {
    if (declared.has(sampleName) && families.has(sampleName)) return families.get(sampleName)!;
    for (const [fname, type] of declared) {
      const suffixes = FAMILY_SUFFIXES[type];
      if (!suffixes) continue;
      for (const s of suffixes) if (sampleName === fname + s) return families.get(fname)!;
    }
    return family(sampleName);
  };

  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      const m = /^#\s*(HELP|TYPE)\s+([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\s+(.*))?$/.exec(line);
      if (!m) continue; // plain comment (or `# EOF`)
      const [, kind, name, rest = ''] = m;
      if (kind === 'HELP') {
        family(name!).help = unescapeHelp(rest);
      } else {
        const t = rest.trim().toLowerCase();
        if (!TYPES.has(t)) {
          errors.push({ line: n + 1, message: `unknown metric type ${JSON.stringify(rest.trim())} for ${name}` });
          continue;
        }
        const f = family(name!);
        f.type = t as PromMetricType;
        declared.set(name!, f.type);
      }
      continue;
    }
    try {
      const nm = NAME_RE.exec(line);
      if (!nm) throw new Error('invalid metric name');
      const name = nm[0];
      let i = name.length;
      let labels: Record<string, string> = {};
      if (line[i] === '{') {
        const parsed = parseLabels(line, i);
        labels = parsed.labels;
        i = parsed.next;
      }
      const rest = line.slice(i).trim().split(/[ \t]+/);
      if (rest.length === 0 || rest[0] === '') throw new Error('missing sample value');
      if (rest.length > 2) throw new Error('unexpected trailing fields');
      const value = parsePromValue(rest[0]!);
      const sample: PromSample = { name, labels, value };
      if (rest[1] !== undefined) {
        const ts = Number(rest[1]);
        if (!Number.isFinite(ts)) throw new Error(`invalid timestamp ${JSON.stringify(rest[1])}`);
        sample.timestampMs = ts;
      }
      familyOf(name).samples.push(sample);
      sampleCount++;
    } catch (e) {
      errors.push({ line: n + 1, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { families: order.map((k) => families.get(k)!), sampleCount, errors };
}

export interface HistogramBucket {
  /** Upper bound (`le`), +Infinity for the overflow bucket. */
  le: number;
  /** Cumulative count of observations ≤ le. */
  count: number;
}

/**
 * Prometheus `histogram_quantile` semantics: linear interpolation inside the bucket that contains the
 * rank q·total (lower bound of the first bucket is 0 unless its upper bound is ≤ 0). The +Inf bucket is
 * required; a rank in it returns the highest finite bound. Returns NaN without data, -Inf/+Inf for q
 * outside [0, 1]. Buckets with the same bound are merged and non-monotonic counts are repaired.
 */
export function histogramQuantile(q: number, input: readonly HistogramBucket[]): number {
  if (Number.isNaN(q)) return Number.NaN;
  if (q < 0) return Number.NEGATIVE_INFINITY;
  if (q > 1) return Number.POSITIVE_INFINITY;
  const merged = new Map<number, number>();
  for (const b of input) {
    if (Number.isNaN(b.le) || !Number.isFinite(b.count)) continue;
    merged.set(b.le, (merged.get(b.le) ?? 0) + b.count);
  }
  const buckets = [...merged.entries()].map(([le, count]) => ({ le, count })).sort((a, b) => a.le - b.le);
  if (buckets.length < 2) return Number.NaN;
  const last = buckets[buckets.length - 1]!;
  if (last.le !== Number.POSITIVE_INFINITY) return Number.NaN;
  for (let i = 1; i < buckets.length; i++) if (buckets[i]!.count < buckets[i - 1]!.count) buckets[i]!.count = buckets[i - 1]!.count;
  const total = last.count;
  if (total <= 0) return Number.NaN;
  let rank = q * total;
  let b = buckets.findIndex((x) => x.count >= rank);
  if (b < 0) b = buckets.length - 1;
  if (b === buckets.length - 1) return buckets[buckets.length - 2]!.le;
  if (b === 0 && buckets[0]!.le <= 0) return buckets[0]!.le;
  let start = 0;
  const end = buckets[b]!.le;
  let count = buckets[b]!.count;
  if (b > 0) {
    start = buckets[b - 1]!.le;
    count -= buckets[b - 1]!.count;
    rank -= buckets[b - 1]!.count;
  }
  if (count === 0) return end;
  return start + (end - start) * (rank / count);
}

export interface HistogramStats {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  count: number | null;
  sum: number | null;
  /** Number of label sets (series) aggregated into this family's buckets. */
  series: number;
}

/** Aggregated (summed over all label sets) buckets of a histogram family. */
export function histogramBuckets(f: PromFamily): HistogramBucket[] {
  const out: HistogramBucket[] = [];
  for (const s of f.samples) {
    if (s.name !== `${f.name}_bucket`) continue;
    const le = s.labels['le'];
    if (le === undefined) continue;
    let bound: number;
    try {
      bound = parsePromValue(le);
    } catch {
      continue;
    }
    out.push({ le: bound, count: s.value });
  }
  return out;
}

export function histogramStats(f: PromFamily): HistogramStats {
  const buckets = histogramBuckets(f);
  const sumOf = (suffix: string): number | null => {
    const xs = f.samples.filter((s) => s.name === f.name + suffix).map((s) => s.value);
    return xs.length === 0 ? null : finiteOrNull(xs.reduce((a, b) => a + b, 0));
  };
  const series = new Set(
    f.samples
      .filter((s) => s.name === `${f.name}_bucket`)
      .map((s) => JSON.stringify(Object.entries(s.labels).filter(([k]) => k !== 'le').sort(([a], [b]) => (a < b ? -1 : 1)))),
  ).size;
  return {
    p50: finiteOrNull(histogramQuantile(0.5, buckets)),
    p95: finiteOrNull(histogramQuantile(0.95, buckets)),
    p99: finiteOrNull(histogramQuantile(0.99, buckets)),
    count: sumOf('_count'),
    sum: sumOf('_sum'),
    series,
  };
}

export interface MetricsSummary {
  families: Array<{ name: string; type: PromMetricType; help?: string; samples: number }>;
  /** Per histogram family: quantiles over the buckets summed across all label sets. */
  quantiles: Record<string, HistogramStats>;
  /** Per counter family: sum over all label sets (null when non-finite). */
  counters: Record<string, number | null>;
  sampleCount: number;
  parseErrors: PromParseError[];
}

/** The structured summary recorded with `metric` evidence of a scrape. */
export function summarizeMetrics(parsed: PromParseResult): MetricsSummary {
  const quantiles: Record<string, HistogramStats> = {};
  const counters: Record<string, number | null> = {};
  for (const f of parsed.families) {
    if (f.type === 'histogram') quantiles[f.name] = histogramStats(f);
    else if (f.type === 'counter') {
      const xs = f.samples.filter((s) => !s.name.endsWith('_created')).map((s) => s.value);
      counters[f.name] = finiteOrNull(xs.reduce((a, b) => a + b, 0));
    }
  }
  return {
    families: parsed.families.map((f) => ({ name: f.name, type: f.type, ...(f.help !== undefined ? { help: f.help } : {}), samples: f.samples.length })),
    quantiles,
    counters,
    sampleCount: parsed.sampleCount,
    parseErrors: parsed.errors.slice(0, 50),
  };
}

/** JSON-safe sample (non-finite values spelled `NaN`/`+Inf`/`-Inf`). */
export function jsonSample(s: PromSample): { name: string; labels: Record<string, string>; value: number | string; timestampMs?: number } {
  return { name: s.name, labels: s.labels, value: jsonNumber(s.value), ...(s.timestampMs !== undefined ? { timestampMs: s.timestampMs } : {}) };
}

// ----------------------------------------------------------------------------- HTTP API results

export type PromApiResultType = 'vector' | 'matrix' | 'scalar' | 'string';

export interface PromSeries {
  metric: Record<string, string>;
  /** [unix seconds, value]; non-finite values are spelled `NaN`/`+Inf`/`-Inf`; string results keep the string. */
  values: Array<[number, number | string]>;
}

export interface PromQueryResult {
  resultType: PromApiResultType;
  series: PromSeries[];
}

function pointOf(p: unknown, resultType: PromApiResultType): [number, number | string] {
  if (!Array.isArray(p) || p.length !== 2) throw new HypertestError('schema_violation', 'malformed sample pair in Prometheus response');
  const t = Number(p[0]);
  if (!Number.isFinite(t)) throw new HypertestError('schema_violation', 'malformed timestamp in Prometheus response');
  if (resultType === 'string') return [t, String(p[1])];
  return [t, jsonNumber(parsePromValue(String(p[1])))];
}

/**
 * Parses a Prometheus HTTP API body (`/api/v1/query`, `/api/v1/query_range`). `status: "error"` becomes a
 * thrown `invalid_argument` carrying `errorType`; malformed bodies throw `schema_violation`.
 */
export function parsePrometheusApiResponse(body: unknown): PromQueryResult {
  if (!body || typeof body !== 'object') throw new HypertestError('schema_violation', 'Prometheus response is not a JSON object');
  const b = body as { status?: unknown; data?: unknown; errorType?: unknown; error?: unknown };
  if (b.status === 'error') {
    throw new HypertestError('invalid_argument', `Prometheus ${String(b.errorType ?? 'error')}: ${String(b.error ?? 'unknown error')}`, { details: { errorType: String(b.errorType ?? 'error') } });
  }
  if (b.status !== 'success' || !b.data || typeof b.data !== 'object') throw new HypertestError('schema_violation', 'Prometheus response has no success data');
  const data = b.data as { resultType?: unknown; result?: unknown };
  const resultType = data.resultType;
  if (resultType === 'scalar' || resultType === 'string') {
    return { resultType, series: [{ metric: {}, values: [pointOf(data.result, resultType)] }] };
  }
  if (resultType !== 'vector' && resultType !== 'matrix') throw new HypertestError('schema_violation', `unsupported Prometheus resultType ${String(resultType)}`);
  if (!Array.isArray(data.result)) throw new HypertestError('schema_violation', 'Prometheus result is not an array');
  const series: PromSeries[] = [];
  for (const item of data.result as Array<{ metric?: Record<string, string>; value?: unknown; values?: unknown }>) {
    const metric: Record<string, string> = {};
    for (const [k, v] of Object.entries(item?.metric ?? {})) metric[k] = String(v);
    let values: Array<[number, number | string]>;
    if (resultType === 'vector') values = item.value === undefined ? [] : [pointOf(item.value, resultType)];
    else values = Array.isArray(item.values) ? item.values.map((p) => pointOf(p, resultType)) : [];
    series.push({ metric, values });
  }
  return { resultType, series };
}
