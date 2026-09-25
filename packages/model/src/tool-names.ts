import { sha256Hex } from '@hypertest/core';

/** Tool-name grammar accepted by OpenAI-compatible and Anthropic APIs. */
export const WIRE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Per-request bijective mapping between Hypertest tool names (`fs.read`, `git.diff`) and wire names
 * (`fs__read`). `.` maps to `__`; any other invalid character or an over-long name gets a sanitized
 * form with a hash suffix. Collisions (e.g. an original `a__b` next to `a.b`) are disambiguated with a
 * hash so names always round-trip exactly.
 */
export class ToolNameMap {
  readonly #toWire = new Map<string, string>();
  readonly #fromWire = new Map<string, string>();

  encode(name: string): string {
    const known = this.#toWire.get(name);
    if (known !== undefined) return known;
    let wire = name.split('.').join('__');
    if (!WIRE_TOOL_NAME.test(wire)) wire = hashed(wire.replace(/[^a-zA-Z0-9_-]/g, '_'), name);
    const owner = this.#fromWire.get(wire);
    if (owner !== undefined && owner !== name) wire = hashed(wire, name);
    this.#toWire.set(name, wire);
    this.#fromWire.set(wire, name);
    return wire;
  }

  /** Wire → original. Unknown wire names (not sent in this request) are reversed heuristically (`__` → `.`). */
  decode(wire: string): string {
    return this.#fromWire.get(wire) ?? wire.split('__').join('.');
  }

  /** True when the wire name was produced by this map (the model called a tool it was offered). */
  known(wire: string): boolean {
    return this.#fromWire.has(wire);
  }
}

function hashed(base: string, original: string): string {
  const suffix = sha256Hex(original).slice(0, 8);
  const head = (base || 'tool').slice(0, 64 - suffix.length - 1);
  return `${head}_${suffix}`;
}
