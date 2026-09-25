import { randomBytes } from 'node:crypto';

/** Crockford base32 alphabet used by ULIDs. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Generates identifiers. Inject a deterministic implementation in tests. */
export interface IdGenerator {
  /** Returns `${prefix}_${ulid}`; prefix must be lowercase [a-z0-9]+ (e.g. "run", "wi", "ev"). */
  next(prefix: string): string;
}

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % 32];
  return out;
}

const PREFIX_RE = /^[a-z][a-z0-9]{0,15}$/;

/** ULID-based, time-sortable, monotonic within one process. */
export class UlidIdGenerator implements IdGenerator {
  #lastTime = -1;
  #lastRandom = '';
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  next(prefix: string): string {
    if (!PREFIX_RE.test(prefix)) throw new Error(`invalid id prefix: ${prefix}`);
    const t = this.#now();
    let rnd: string;
    if (t === this.#lastTime) {
      rnd = incrementBase32(this.#lastRandom);
    } else {
      rnd = encodeRandom(16);
      this.#lastTime = t;
    }
    this.#lastRandom = rnd;
    return `${prefix}_${encodeTime(t)}${rnd}`;
  }
}

function incrementBase32(s: string): string {
  const chars = s.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    const idx = ALPHABET.indexOf(chars[i]!);
    if (idx < 31) {
      chars[i] = ALPHABET[idx + 1]!;
      return chars.join('');
    }
    chars[i] = ALPHABET[0]!;
  }
  return chars.join('');
}

/** Deterministic generator for tests: `${prefix}_${zero-padded counter}` per prefix. */
export class SequentialIdGenerator implements IdGenerator {
  readonly #counters = new Map<string, number>();
  next(prefix: string): string {
    if (!PREFIX_RE.test(prefix)) throw new Error(`invalid id prefix: ${prefix}`);
    const n = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(6, '0')}`;
  }
}

export const defaultIds: IdGenerator = new UlidIdGenerator();

/** Convenience: `newId('run')` → `run_01J…`. */
export function newId(prefix: string): string {
  return defaultIds.next(prefix);
}

/** Returns the prefix of an id produced by an IdGenerator. */
export function idPrefix(id: string): string {
  const i = id.indexOf('_');
  return i < 0 ? '' : id.slice(0, i);
}
