import { createHash } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * Canonical JSON (RFC 8785 style): object keys sorted by UTF-16 code units, no whitespace,
 * `undefined` object members dropped, non-finite numbers rejected. Used for all content hashes.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson: unsupported top-level/array value of type ${typeof value}`);
    case 'object': {
      if (seen.has(value)) throw new TypeError('canonicalJson: cyclic structure');
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return '[' + value.map((v) => (v === undefined ? 'null' : serialize(v, seen))).join(',') + ']';
        }
        if (value instanceof Date) return JSON.stringify(value.toISOString());
        if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('base64'));
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).filter((k) => obj[k] !== undefined && typeof obj[k] !== 'function').sort();
        return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(obj[k], seen)).join(',') + '}';
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError('canonicalJson: unsupported value');
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of the canonical JSON encoding. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Deep-freezes a JSON-like value (used for immutable snapshots/revisions). */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Structured clone restricted to JSON semantics. */
export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Truncates a string to at most `maxBytes` UTF-8 bytes, appending a marker when truncated. */
export function truncateUtf8(s: string, maxBytes: number, marker = '…[truncated]'): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false };
  const keep = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let text = buf.subarray(0, keep).toString('utf8');
  if (text.endsWith('�')) text = text.slice(0, -1);
  return { text: text + marker, truncated: true };
}
