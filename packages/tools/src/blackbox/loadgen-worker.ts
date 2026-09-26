/**
 * Built-in HTTP load generator worker (standalone process). Usage: `node loadgen-worker.ts <jobDir>`.
 *
 * Reads `<jobDir>/spec.json`, writes `<jobDir>/pid` (decimal pid), rewrites `<jobDir>/status.json` every 500 ms and
 * `<jobDir>/results.json` when it finishes (completed | stopped | failed). All files are written
 * atomically (tmp + rename), so a reader never sees a partial document.
 *
 * Scheduling is OPEN-LOOP: request i is due at start + i/ratePerSecond regardless of how fast the target
 * answers. At most `concurrency` requests are in flight; due requests beyond that wait in a FIFO queue.
 * Latency is measured from the request's scheduled time (coordinated-omission corrected), so a slow
 * target shows up as latency instead of silently lowering the offered rate.
 *
 * SIGTERM/SIGINT ⇒ stop scheduling, abort in-flight requests, final state `stopped`. A `stop-*.json`
 * marker (written by load.stop BEFORE it signals) is itself a durable stop request: it is honoured at
 * startup (before any request is sent — a stop can never be overtaken by a slow launch) and on every
 * status tick (so a stop whose signal was lost, e.g. its caller crashed after writing the marker, still
 * takes effect within ~500 ms).
 * Every request carries `X-Hypertest-Operation: <operationId>` (operation-id labelling).
 *
 * Deliberately depends on node: built-ins only (fast start, runs from any working directory).
 */
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

interface LoadSpec {
  operationId: string;
  targetUrl: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
  ratePerSecond: number;
  durationMs: number;
  concurrency: number;
  timeoutMs: number;
}

type JobState = 'running' | 'completed' | 'failed' | 'stopped';

/** Log-bucketed latency histogram (≈2% relative precision) + exact coarse cumulative buckets. */
class LatencyHistogram {
  static readonly BASE = 0.01; // ms
  static readonly GROWTH = 1.02;
  static readonly COARSE_MS: readonly number[] = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];
  readonly counts = new Map<number, number>();
  readonly coarse: number[] = new Array<number>(LatencyHistogram.COARSE_MS.length + 1).fill(0);
  total = 0;
  sum = 0;
  max = 0;
  min = Number.POSITIVE_INFINITY;

  record(ms: number): void {
    const v = Math.max(0, ms);
    const idx = v <= LatencyHistogram.BASE ? 0 : Math.ceil(Math.log(v / LatencyHistogram.BASE) / Math.log(LatencyHistogram.GROWTH));
    this.counts.set(idx, (this.counts.get(idx) ?? 0) + 1);
    let c = LatencyHistogram.COARSE_MS.findIndex((b) => v <= b);
    if (c < 0) c = LatencyHistogram.COARSE_MS.length;
    this.coarse[c] = this.coarse[c]! + 1;
    this.total++;
    this.sum += v;
    if (v > this.max) this.max = v;
    if (v < this.min) this.min = v;
  }

  quantile(q: number): number | null {
    if (this.total === 0) return null;
    const rank = Math.max(1, Math.ceil(q * this.total));
    let seen = 0;
    for (const idx of [...this.counts.keys()].sort((a, b) => a - b)) {
      seen += this.counts.get(idx)!;
      if (seen >= rank) return round(Math.min(this.max, LatencyHistogram.BASE * LatencyHistogram.GROWTH ** idx));
    }
    return round(this.max);
  }

  summary(): { p50: number | null; p95: number | null; p99: number | null; max: number | null; min: number | null; mean: number | null } {
    if (this.total === 0) return { p50: null, p95: null, p99: null, max: null, min: null, mean: null };
    return { p50: this.quantile(0.5), p95: this.quantile(0.95), p99: this.quantile(0.99), max: round(this.max), min: round(this.min), mean: round(this.sum / this.total) };
  }

  /** Cumulative buckets (Prometheus style: count of latencies ≤ le). */
  buckets(): Array<{ le: number | string; count: number }> {
    let cum = 0;
    const out: Array<{ le: number | string; count: number }> = [];
    LatencyHistogram.COARSE_MS.forEach((le, i) => {
      cum += this.coarse[i]!;
      out.push({ le, count: cum });
    });
    cum += this.coarse[LatencyHistogram.COARSE_MS.length]!;
    out.push({ le: '+Inf', count: cum });
    return out;
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

function validSpec(raw: unknown): LoadSpec {
  const s = raw as Partial<LoadSpec>;
  const fail = (m: string): never => {
    throw new Error(`invalid spec.json: ${m}`);
  };
  if (!s || typeof s !== 'object') fail('not an object');
  if (typeof s.operationId !== 'string' || s.operationId === '') fail('operationId');
  if (typeof s.targetUrl !== 'string' || !/^https?:\/\//.test(s.targetUrl)) fail('targetUrl');
  if (typeof s.method !== 'string' || s.method === '') fail('method');
  if (typeof s.ratePerSecond !== 'number' || !(s.ratePerSecond > 0)) fail('ratePerSecond');
  if (typeof s.durationMs !== 'number' || !(s.durationMs > 0)) fail('durationMs');
  if (typeof s.concurrency !== 'number' || !(s.concurrency >= 1)) fail('concurrency');
  if (typeof s.timeoutMs !== 'number' || !(s.timeoutMs > 0)) fail('timeoutMs');
  return s as LoadSpec;
}

function main(): void {
  const jobDir = process.argv[2];
  if (!jobDir) {
    process.stderr.write('usage: loadgen-worker <jobDir>\n');
    process.exit(2);
  }
  const statusPath = join(jobDir, 'status.json');
  const resultsPath = join(jobDir, 'results.json');
  // Signal handlers first: a stop that arrives while the job is still starting must not kill it silently.
  let onStop: () => void = () => {
    stopRequested = true;
  };
  let stopRequested = false;
  process.on('SIGTERM', () => onStop());
  process.on('SIGINT', () => onStop());
  const startedAt = new Date().toISOString();
  const pidTmp = join(jobDir, `pid.tmp-${process.pid}`);
  writeFileSync(pidTmp, `${process.pid}\n`);
  renameSync(pidTmp, join(jobDir, 'pid'));

  let spec: LoadSpec;
  try {
    spec = validSpec(JSON.parse(readFileSync(join(jobDir, 'spec.json'), 'utf8')));
  } catch (e) {
    const failed = { state: 'failed' as JobState, startedAt, updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), pid: process.pid, error: (e as Error).message, sent: 0, ok: 0, errors: 0 };
    writeJsonAtomic(statusPath, failed);
    writeJsonAtomic(resultsPath, failed);
    process.exit(1);
  }

  const hist = new LatencyHistogram();
  const statusCodes: Record<string, number> = {};
  const planned = Math.max(1, Math.floor((spec.ratePerSecond * spec.durationMs) / 1000));
  const interval = 1000 / spec.ratePerSecond;
  const abortAll = new AbortController();
  const queue: number[] = [];
  let state: JobState = 'running';
  let scheduled = 0;
  let sent = 0;
  let ok = 0;
  let errors = 0;
  let networkErrors = 0;
  let timeouts = 0;
  let inFlight = 0;
  let finishedAt: string | undefined;
  let lastError: string | undefined;
  const t0 = performance.now();
  let sendWindowEnd: number | undefined;
  const headers: Record<string, string> = { 'user-agent': 'hypertest-loadgen/0.3' };
  for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k.toLowerCase()] = String(v);
  headers['x-hypertest-operation'] = spec.operationId;

  const snapshot = () => {
    const elapsedMs = performance.now() - t0;
    const windowMs = Math.max(1, (sendWindowEnd ?? performance.now()) - t0);
    return {
      operationId: spec.operationId,
      state,
      pid: process.pid,
      startedAt,
      updatedAt: new Date().toISOString(),
      ...(finishedAt !== undefined ? { finishedAt } : {}),
      targetUrl: spec.targetUrl,
      method: spec.method,
      ratePerSecond: spec.ratePerSecond,
      durationMs: spec.durationMs,
      concurrency: spec.concurrency,
      planned,
      sent,
      ok,
      errors,
      networkErrors,
      timeouts,
      inFlight,
      queued: queue.length,
      statusCodes,
      latencyMs: hist.summary(),
      // errors / completed requests (non-2xx, timeouts, network errors); null until a request completed (unknown, never 0)
      errorRate: ok + errors > 0 ? Math.round((errors / (ok + errors)) * 1e6) / 1e6 : null,
      achievedRps: round((sent * 1000) / windowMs),
      elapsedMs: round(elapsedMs),
      ...(lastError !== undefined ? { lastError } : {}),
    };
  };

  const stopMarkerPresent = (): boolean => {
    try {
      return readdirSync(jobDir).some((f) => /^stop-.+\.json$/.test(f));
    } catch {
      return false; // unreadable directory: the signal path still stops the job
    }
  };

  const writeStatus = () => {
    if (state === 'running' && stopMarkerPresent()) {
      onStop();
      return;
    }
    try {
      writeJsonAtomic(statusPath, snapshot());
    } catch (e) {
      process.stderr.write(`status write failed: ${(e as Error).message}\n`);
    }
  };

  const finish = (final: JobState) => {
    if (state !== 'running') return;
    state = final;
    finishedAt = new Date().toISOString();
    clearInterval(statusTimer);
    if (tickTimer) clearTimeout(tickTimer);
    const s = snapshot();
    writeJsonAtomic(resultsPath, { ...s, histogram: { unit: 'ms', buckets: hist.buckets() } });
    writeJsonAtomic(statusPath, s);
    // give aborted fetches a moment to unwind, then exit explicitly (keep-alive sockets would linger)
    setTimeout(() => process.exit(final === 'failed' ? 1 : 0), 20);
  };

  const onDone = () => {
    if (state !== 'running') return;
    const next = queue.shift();
    if (next !== undefined) {
      void send(next);
      return;
    }
    if (scheduled >= planned && inFlight === 0) finish('completed');
  };

  const send = async (scheduledAt: number): Promise<void> => {
    inFlight++;
    sent++;
    const timeout = AbortSignal.timeout(spec.timeoutMs);
    const signal = AbortSignal.any([abortAll.signal, timeout]);
    try {
      const init: RequestInit = { method: spec.method, headers, signal };
      if (spec.body !== undefined) init.body = spec.body;
      const res = await fetch(spec.targetUrl, init);
      await res.arrayBuffer();
      if (state !== 'running') return;
      statusCodes[String(res.status)] = (statusCodes[String(res.status)] ?? 0) + 1;
      if (res.ok) ok++;
      else errors++;
      hist.record(performance.now() - scheduledAt);
    } catch (e) {
      if (state !== 'running') return;
      errors++;
      if (timeout.aborted) timeouts++;
      else {
        networkErrors++;
        const cause = (e as { cause?: { code?: string } }).cause;
        lastError = `${(e as Error).message}${cause?.code ? ` (${cause.code})` : ''}`;
      }
      hist.record(performance.now() - scheduledAt);
    } finally {
      inFlight--;
      onDone();
    }
  };

  let tickTimer: NodeJS.Timeout | undefined;
  const tick = () => {
    tickTimer = undefined;
    if (state !== 'running') return;
    const now = performance.now();
    while (scheduled < planned && t0 + scheduled * interval <= now) {
      const at = t0 + scheduled * interval;
      scheduled++;
      if (inFlight < spec.concurrency) void send(at);
      else queue.push(at);
    }
    if (scheduled >= planned) {
      sendWindowEnd = Math.max(now, t0 + spec.durationMs);
      if (inFlight === 0 && queue.length === 0) finish('completed');
      return;
    }
    tickTimer = setTimeout(tick, Math.max(0, t0 + scheduled * interval - performance.now()));
  };

  const statusTimer = setInterval(writeStatus, 500);
  onStop = () => {
    if (state !== 'running') return;
    abortAll.abort();
    finish('stopped');
  };
  process.on('uncaughtException', (e) => {
    lastError = e.message;
    finish('failed');
  });
  if (stopRequested || stopMarkerPresent()) onStop();
  else {
    writeStatus();
    tick();
  }
}

main();
