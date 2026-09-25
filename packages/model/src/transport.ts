import { HypertestError, isHypertestError } from '@hypertest/core';
import type { StreamDelta } from './contracts.ts';
import { httpStatusError, providerFault, scrubSecrets } from './errors.ts';

export const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_SSE_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Runs `fn` under a whole-call deadline and the caller's abort signal. Distinguishes the two causes:
 * deadline ⇒ `timeout`, caller abort ⇒ `cancelled`; any other failure is normalized by `normalize`.
 * Returns even if `fn` ignores its signal (the abort is raced).
 */
export async function withDeadline<T>(
  options: { timeoutMs: number; signal?: AbortSignal | undefined; what: string; normalize: (e: unknown) => HypertestError },
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { signal, what } = options;
  if (typeof options.timeoutMs !== 'number' || Number.isNaN(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new HypertestError('invalid_argument', `${what}: timeoutMs must be a positive number (got ${String(options.timeoutMs)})`, { retryable: false });
  }
  // Node clamps timers above 2^31-1 ms to 1 ms (an immediate timeout); cap instead.
  const timeoutMs = Math.min(options.timeoutMs, MAX_TIMER_MS);
  if (signal?.aborted) throw providerFault('cancelled', `${what}: cancelled by caller`);
  const ctrl = new AbortController();
  let timedOut = false;
  let rejectAbort: (e: HypertestError) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  aborted.catch(() => undefined);
  const timer = setTimeout(() => {
    timedOut = true;
    const e = providerFault('timeout', `${what}: timed out after ${timeoutMs}ms`, { timeoutMs });
    ctrl.abort(e);
    rejectAbort(e);
  }, timeoutMs);
  const onAbort = () => {
    const e = providerFault('cancelled', `${what}: cancelled by caller`);
    ctrl.abort(e);
    rejectAbort(e);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([fn(ctrl.signal), aborted]);
  } catch (e) {
    if (timedOut) throw providerFault('timeout', `${what}: timed out after ${timeoutMs}ms`, { timeoutMs });
    if (signal?.aborted) throw providerFault('cancelled', `${what}: cancelled by caller`);
    throw options.normalize(e);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Normalizes transport failures (fetch network errors etc.) to `unavailable`; keeps HypertestErrors. */
export function normalizeTransportError(provider: string, secrets: ReadonlyArray<string | undefined>) {
  return (e: unknown): HypertestError => {
    if (isHypertestError(e)) return e;
    const msg = scrubSecrets(e instanceof Error ? `${e.message}${causeText(e)}` : String(e), secrets);
    return providerFault('unavailable', `${provider}: network error: ${msg}`, { provider }, e);
  };
}

function causeText(e: Error): string {
  const c = (e as { cause?: unknown }).cause;
  if (c instanceof Error) return ` (${c.message})`;
  return '';
}

/** POSTs JSON; maps non-2xx responses to HypertestErrors (status taxonomy in errors.ts). */
export async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
  provider: string,
  secrets: ReadonlyArray<string | undefined>,
): Promise<Response> {
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
  if (!res.ok) {
    const text = await readBounded(res, MAX_ERROR_BODY_BYTES).catch(() => '');
    throw httpStatusError(provider, res.status, text, secrets, res.headers.get('retry-after'));
  }
  return res;
}

async function readBounded(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    out += decoder.decode(chunk, { stream: true });
    if (bytes >= maxBytes) break;
  }
  return out;
}

export function isEventStream(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Minimal spec-compliant SSE reader (data/event fields, comments, CRLF, multi-line data). */
export async function* readSse(body: ReadableStream<Uint8Array> | null, provider: string): AsyncGenerator<SseEvent> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let pendingBytes = 0;
  const dispatch = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const ev: SseEvent = { data: dataLines.join('\n') };
    if (eventName !== undefined) ev.event = eventName;
    dataLines = [];
    eventName = undefined;
    pendingBytes = 0;
    return ev;
  };
  const handleLine = (line: string): SseEvent | undefined => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return undefined;
    const idx = line.indexOf(':');
    const field = idx < 0 ? line : line.slice(0, idx);
    let value = idx < 0 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      dataLines.push(value);
      pendingBytes += value.length;
      if (pendingBytes > MAX_SSE_EVENT_BYTES) throw providerFault('provider_error', `${provider}: SSE event exceeds ${MAX_SSE_EVENT_BYTES} bytes`, { provider });
    } else if (field === 'event') eventName = value;
    return undefined;
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.search(/\r\n|\n|\r/)) >= 0) {
      const line = buffer.slice(0, nl);
      const sepLen = buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1;
      // A lone trailing '\r' may be the first half of '\r\n' split across chunks: wait for more input.
      if (buffer[nl] === '\r' && nl + 1 === buffer.length) break;
      buffer = buffer.slice(nl + sepLen);
      const ev = handleLine(line);
      if (ev) yield ev;
    }
    if (buffer.length > MAX_SSE_EVENT_BYTES) throw providerFault('provider_error', `${provider}: SSE line exceeds ${MAX_SSE_EVENT_BYTES} bytes`, { provider });
  }
  buffer += decoder.decode();
  // EOF. A line held back only because it ended with a lone '\r' is complete. Any other remainder is a line cut
  // mid-way (the connection closed cleanly in the middle of an event): it is DROPPED, so a truncated payload surfaces
  // as an incomplete stream (retryable `unavailable`) instead of as malformed JSON (non-retryable `provider_error`).
  if (buffer.endsWith('\r')) {
    const ev = handleLine(buffer.slice(0, -1));
    if (ev) yield ev;
  }
  // Complete data lines of a final event that lacks only its blank-line terminator are still delivered.
  const last = dispatch();
  if (last) yield last;
}

/** Parses one JSON payload from a provider stream; protocol violations are non-retryable provider errors. */
export function parseJsonPayload(provider: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new HypertestError('provider_error', `${provider}: malformed JSON payload from provider`, { retryable: false, cause: e, details: { provider, sample: text.slice(0, 200) } });
  }
}

/** Monotonic milliseconds for latency measurement. */
export function monoMs(): number {
  return performance.now();
}

/**
 * Wraps the caller's `onDelta` so that an exception thrown by the CALLER is a non-retryable `internal` fault.
 * Otherwise it would surface from inside the transport as a "network error" (retryable `unavailable`), be
 * retried and then answered with a fallback model although the provider was healthy.
 */
export function guardDelta(onDelta: ((d: StreamDelta) => void) | undefined): ((d: StreamDelta) => void) | undefined {
  if (!onDelta) return undefined;
  return (d) => {
    try {
      onDelta(d);
    } catch (e) {
      throw new HypertestError('internal', `onDelta callback threw: ${e instanceof Error ? e.message : String(e)}`, { retryable: false, cause: e, details: { source: 'onDelta' } });
    }
  };
}
