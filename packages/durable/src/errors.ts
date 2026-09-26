import { isHypertestError, type ErrorCode } from '@hypertest/core';

/**
 * Faults a retry of the same control call can never fix (the Temporal activity retry policy's
 * `nonRetryableErrorTypes`; the local runtime stops the loop on them). Everything else — timeouts, unavailable
 * stores, a conflict with a concurrent writer, an aborted turn (`cancelled`: the turn replays on the next attempt),
 * `internal` — is retried a bounded number of times; an executeTurn retry carries `expectedTurn`, so a turn that
 * committed before the fault is never run twice.
 */
export const NON_RETRYABLE_ERROR_CODES: readonly ErrorCode[] = Object.freeze([
  'invalid_argument',
  'not_found',
  'permission_denied',
  'stale_fence',
  'schema_violation',
  'integrity_violation',
  'unsupported',
  'budget_exhausted',
  'precondition_failed',
  'provider_error',
]);

const NON_RETRYABLE: ReadonlySet<string> = new Set(NON_RETRYABLE_ERROR_CODES);

/** The error type recorded for a fault: the HypertestError code, else `internal`. */
export function faultCode(e: unknown): ErrorCode {
  return isHypertestError(e) ? e.code : 'internal';
}

/** Whether a retry of the same control call may succeed. */
export function isRetryableFault(e: unknown): boolean {
  return !NON_RETRYABLE.has(faultCode(e));
}

/** Every HypertestError code (a Record so that a code added to core fails the typecheck here). */
const ERROR_CODES: Record<ErrorCode, true> = {
  invalid_argument: true,
  not_found: true,
  conflict: true,
  precondition_failed: true,
  permission_denied: true,
  stale_fence: true,
  stale_context: true,
  budget_exhausted: true,
  timeout: true,
  cancelled: true,
  unavailable: true,
  rate_limited: true,
  provider_error: true,
  schema_violation: true,
  integrity_violation: true,
  unsupported: true,
  internal: true,
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
