import { HypertestError } from '@hypertest/core';

/** A lone UTF-16 surrogate (a high surrogate not followed by a low one, or a low one not preceded by a high one). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function invalid(message: string): HypertestError {
  return new HypertestError('invalid_argument', message);
}

/**
 * Replaces lone UTF-16 surrogates with U+FFFD (what `String.prototype.toWellFormed` does, and what
 * UTF-8 encoding on the way into PostgreSQL does anyway). Without this, a `text` column silently
 * stores U+FFFD while the hash was computed over the surrogate, so an untouched record would verify
 * as tampered (a false `metadata_hash` alarm that also blocks sealing), and `jsonb` rejects the
 * escaped surrogate outright.
 */
export function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE, '�');
}

/** Validates and normalizes a string exactly as it will be stored (NUL is not storable in PostgreSQL). */
export function storableString(value: string, name: string): string {
  if (value.includes('\u0000')) throw invalid(`evidence ${name} must not contain NUL characters (not storable in PostgreSQL)`);
  return wellFormed(value);
}

/**
 * JSON round trip (what `jsonb` will store) plus string normalization, so the hash computed at append
 * equals the hash recomputed from the stored row on every later read.
 */
export function storableJson<T>(value: T, name: string): T {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (e) {
    throw new HypertestError('invalid_argument', `evidence ${name} is not JSON-serializable`, { cause: e });
  }
  if (text === undefined) throw invalid(`evidence ${name} is not JSON-serializable`);
  return normalizeParsed(JSON.parse(text), name) as T;
}

function normalizeParsed(value: unknown, name: string): unknown {
  if (typeof value === 'string') return storableString(value, name);
  if (Array.isArray(value)) return value.map((v) => normalizeParsed(v, name));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = storableString(k, `${name} key`);
      if (Object.prototype.hasOwnProperty.call(out, key)) throw invalid(`evidence ${name} has keys that collide after Unicode normalization (${JSON.stringify(key)})`);
      // defineProperty keeps a literal "__proto__" key an own, enumerable member (as JSON.parse does).
      Object.defineProperty(out, key, { value: normalizeParsed(v, name), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}
