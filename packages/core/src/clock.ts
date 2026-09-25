/** Time source. Inject `FixedClock` in tests. */
export interface Clock {
  /** Milliseconds since epoch. */
  nowMs(): number;
  /** ISO-8601 UTC timestamp. */
  isoNow(): string;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

/** Manually advanced clock for deterministic tests. */
export class FixedClock implements Clock {
  #ms: number;
  constructor(start: string | number = '2026-01-01T00:00:00.000Z') {
    this.#ms = typeof start === 'number' ? start : Date.parse(start);
  }
  nowMs(): number {
    return this.#ms;
  }
  isoNow(): string {
    return new Date(this.#ms).toISOString();
  }
  advance(ms: number): void {
    this.#ms += ms;
  }
  set(iso: string): void {
    this.#ms = Date.parse(iso);
  }
}

export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}
