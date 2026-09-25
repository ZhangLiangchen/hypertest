import { HypertestError } from './errors.ts';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortReason(signal: AbortSignal): HypertestError {
  const r: unknown = signal.reason;
  if (r instanceof HypertestError) return r;
  return new HypertestError('cancelled', r instanceof Error ? r.message : 'operation aborted', { cause: r });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Runs fn with a timeout; the derived signal is aborted on timeout or when the parent aborts. */
export async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal, what = 'operation'): Promise<T> {
  const ctrl = new AbortController();
  const onParent = () => ctrl.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) throw abortReason(parent);
    parent.addEventListener('abort', onParent, { once: true });
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new HypertestError('timeout', `${what} timed out after ${ms}ms`);
      ctrl.abort(e);
      reject(e);
    }, ms);
  });
  try {
    return await Promise.race([fn(ctrl.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener('abort', onParent);
  }
}

/** Combines several abort signals into one. */
export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  return AbortSignal.any(present);
}

/** Retries a function with exponential backoff while the thrown error is retryable. */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: { attempts: number; baseDelayMs?: number; maxDelayMs?: number; signal?: AbortSignal; isRetryable?: (e: unknown) => boolean },
): Promise<T> {
  const base = options.baseDelayMs ?? 200;
  const max = options.maxDelayMs ?? 5000;
  const isRetryable = options.isRetryable ?? ((e: unknown) => e instanceof HypertestError && e.retryable);
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    throwIfAborted(options.signal);
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      if (attempt === options.attempts || !isRetryable(e)) throw e;
      await sleep(Math.min(max, base * 2 ** (attempt - 1)), options.signal);
    }
  }
  throw lastError;
}

/** A simple counting semaphore. */
export class Semaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.#available = permits;
  }
  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available--;
    } else {
      await new Promise<void>((r) => this.#waiters.push(r));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) next();
      else this.#available++;
    };
  }
}
