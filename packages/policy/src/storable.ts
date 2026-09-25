/**
 * PostgreSQL text/jsonb cannot hold U+0000. Audit rows must never be lost because an agent-influenced value
 * (redacted tool input, approval subject, rationale) contains one, so such values are stored with U+0000
 * replaced by U+FFFD. Hashes are computed over the stored form, so a stored row always re-verifies.
 */
export function storableString(s: string): string {
  return s.includes('\u0000') ? s.replace(/\u0000/g, '�') : s;
}

export function storable<T>(value: T): T {
  if (typeof value === 'string') return storableString(value) as T;
  if (Array.isArray(value)) return value.map((v) => storable(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[storableString(k)] = storable(v);
    return out as T;
  }
  return value;
}
