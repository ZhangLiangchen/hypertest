import { HypertestError, canonicalJson, fromJsonColumn, toIso, type SqlParam } from '@hypertest/core';
import type { ModelUsage } from '@hypertest/model';

/** jsonb parameter: always stringified explicitly (the SQL layer would pass JS arrays as PostgreSQL arrays). */
export function jsonParam(value: unknown): string {
  return JSON.stringify(value);
}

/** Nullable jsonb parameter. */
export function jsonOrNull(value: unknown): SqlParam {
  return value === undefined ? null : JSON.stringify(value);
}

export function parseJson<T>(v: unknown): T | undefined {
  if (v === null || v === undefined) return undefined;
  return fromJsonColumn<T>(v);
}

export function isoOrUndefined(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : toIso(v);
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

export function assertNonEmpty(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new HypertestError('invalid_argument', `${what} must be a non-empty string`);
}

export function assertTurnNumber(turn: unknown, what = 'turn', min = 1): asserts turn is number {
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < min) {
    throw new HypertestError('invalid_argument', `${what} must be an integer >= ${min} (got ${String(turn)})`);
  }
}

export function zeroUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}
