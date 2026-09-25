import { HypertestError, type ErrorCode } from '@hypertest/core';

/**
 * Provider fault taxonomy (see contracts.ts):
 *   429 → rate_limited (retryable), 408/5xx/network → unavailable (retryable), deadline → timeout (retryable),
 *   400/401/403/404/422/other 4xx → provider_error (NOT retryable: a bad request must not be masked by
 *   retrying or by another model), caller abort → cancelled (not retryable).
 */
export type ProviderErrorCode = 'rate_limited' | 'unavailable' | 'timeout' | 'provider_error' | 'cancelled';

/** Errors that justify retrying the same route. */
export const SAME_ROUTE_RETRYABLE: ReadonlySet<string> = new Set(['rate_limited', 'unavailable', 'timeout']);

/**
 * Errors that justify computing a (re-validated) fallback route for the next safe turn boundary.
 * provider_error is deliberately absent: a malformed request is a bug, not an availability problem.
 */
export const FALLBACK_ELIGIBLE: ReadonlySet<string> = new Set(['rate_limited', 'unavailable', 'timeout', 'not_found', 'precondition_failed']);

export function providerFault(code: ProviderErrorCode | ErrorCode, message: string, details: Record<string, unknown> = {}, cause?: unknown): HypertestError {
  const opts: { retryable: boolean; details: Record<string, unknown>; cause?: unknown } = { retryable: SAME_ROUTE_RETRYABLE.has(code), details };
  if (cause !== undefined) opts.cause = cause;
  return new HypertestError(code, message, opts);
}

/** Removes secrets from provider-supplied text before it is placed in an error message. */
export function scrubSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out;
}

export function codeForHttpStatus(status: number): ProviderErrorCode {
  if (status === 429) return 'rate_limited';
  if (status === 408 || status >= 500) return 'unavailable';
  return 'provider_error';
}

/** Maps a non-2xx HTTP response to a HypertestError (body is truncated and scrubbed). */
export function httpStatusError(provider: string, status: number, bodyText: string, secrets: ReadonlyArray<string | undefined>, retryAfter?: string | null): HypertestError {
  const code = codeForHttpStatus(status);
  const snippet = scrubSecrets(bodyText, secrets).slice(0, 500);
  const details: Record<string, unknown> = { provider, status };
  const retryAfterMs = parseRetryAfter(retryAfter);
  if (retryAfterMs !== undefined) details['retryAfterMs'] = retryAfterMs;
  return providerFault(code, `${provider}: HTTP ${status}${snippet ? `: ${snippet}` : ''}`, details);
}

function parseRetryAfter(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : undefined;
}

const SENSITIVE_HEADER = /authorization|api[-_]?key|token|secret|password|cookie|signature|credential/i;

/** Secrets to scrub from provider error text: the API key plus the values of credential-like custom headers. */
export function secretsOf(apiKey: string | undefined, headers: Record<string, string> | undefined): string[] {
  const out: string[] = [];
  if (apiKey) out.push(apiKey);
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value !== 'string' || !SENSITIVE_HEADER.test(name)) continue;
    out.push(value);
    // `Bearer <token>`: also scrub the bare token.
    const bare = value.replace(/^(bearer|basic|token)\s+/i, '');
    if (bare !== value) out.push(bare);
  }
  return out;
}
