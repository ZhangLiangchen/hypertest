/**
 * Error codes for faults (not legitimate negative outcomes). A failing test, a denied permit or a
 * rejected plan are domain outcomes and must be returned, not thrown.
 */
export type ErrorCode =
  | 'invalid_argument'
  | 'not_found'
  | 'conflict'
  | 'precondition_failed'
  | 'permission_denied'
  | 'stale_fence'
  | 'stale_context'
  | 'budget_exhausted'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'rate_limited'
  | 'provider_error'
  | 'schema_violation'
  | 'integrity_violation'
  | 'unsupported'
  | 'internal';

// provider_error is a non-retryable bad request/response by contract (a different model must not mask it).
const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['timeout', 'unavailable', 'rate_limited']);

export interface HypertestErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class HypertestError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: HypertestErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HypertestError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.details = options.details ?? {};
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

export function isHypertestError(e: unknown, code?: ErrorCode): e is HypertestError {
  return e instanceof HypertestError && (code === undefined || e.code === code);
}

/** Normalizes anything thrown into a HypertestError (preserving HypertestErrors). */
export function toHypertestError(e: unknown, fallback: ErrorCode = 'internal'): HypertestError {
  if (e instanceof HypertestError) return e;
  if (e instanceof Error && e.name === 'AbortError') return new HypertestError('cancelled', e.message, { cause: e });
  const message = e instanceof Error ? e.message : String(e);
  return new HypertestError(fallback, message, { cause: e });
}

/** A value-or-error result for expected, recoverable negative outcomes. */
export type Result<T, E = HypertestError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}
export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

export function assertNever(x: never, message = 'unexpected value'): never {
  throw new HypertestError('internal', `${message}: ${JSON.stringify(x)}`);
}
