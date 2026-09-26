import { HypertestError, hashCanonical, isValidSchema } from '@hypertest/core';
import type { ActionCapability, ToolDefinition } from '@hypertest/domain';
import { matchesToolPattern } from '@hypertest/policy';
import type { ToolRegistryLike, ToolSpec } from '../contracts.ts';

/**
 * Tool ids are dotted namespaces (`fs.read`, `mcp.github.search`). Segments use `[A-Za-z0-9_-]` and may not
 * contain `__`, so the model-visible name (`.` → `__`) maps back to exactly one id.
 */
const TOOL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/;
/** Provider limit for function names (OpenAI / Anthropic): 64 chars of `[A-Za-z0-9_-]`. */
const MAX_MODEL_NAME = 64;

/** Model-visible tool name: `fs.read` → `fs__read`. */
export function toolIdToName(id: string): string {
  return id.replaceAll('.', '__');
}

/** Inverse of toolIdToName: `fs__read` → `fs.read`. */
export function toolNameToId(name: string): string {
  return name.replaceAll('__', '.');
}

/** Throws invalid_argument when the id cannot be mapped to a model-visible name and back. */
export function assertValidToolId(id: string): void {
  if (typeof id !== 'string' || !TOOL_ID_RE.test(id)) throw new HypertestError('invalid_argument', `invalid tool id ${JSON.stringify(id)}`);
  if (id.includes('__')) throw new HypertestError('invalid_argument', `tool id ${id} must not contain "__" (reserved for the model-visible name mapping)`);
  if (toolIdToName(id).length > MAX_MODEL_NAME) throw new HypertestError('invalid_argument', `tool id ${id} is too long for a model-visible tool name (max ${MAX_MODEL_NAME})`);
}

function assertValidSpec(spec: ToolSpec): void {
  if (!spec || typeof spec !== 'object') throw new HypertestError('invalid_argument', 'tool spec must be an object');
  assertValidToolId(spec.id);
  if (typeof spec.description !== 'string' || spec.description.length === 0) throw new HypertestError('invalid_argument', `tool ${spec.id}: description is required`);
  if (!isValidSchema(spec.inputSchema)) throw new HypertestError('invalid_argument', `tool ${spec.id}: inputSchema is not a valid JSON schema`);
  if (spec.outputSchema !== undefined && !isValidSchema(spec.outputSchema)) throw new HypertestError('invalid_argument', `tool ${spec.id}: outputSchema is not a valid JSON schema`);
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) throw new HypertestError('invalid_argument', `tool ${spec.id}: timeoutMs must be a positive number`);
  if (typeof spec.execute !== 'function') throw new HypertestError('invalid_argument', `tool ${spec.id}: execute must be a function`);
  if (typeof spec.resources !== 'function') throw new HypertestError('invalid_argument', `tool ${spec.id}: resources must be a function`);
  if (spec.maxInlineBytes !== undefined && (!Number.isInteger(spec.maxInlineBytes) || spec.maxInlineBytes < 256)) {
    throw new HypertestError('invalid_argument', `tool ${spec.id}: maxInlineBytes must be an integer >= 256`);
  }
  if (spec.sideEffect && (typeof spec.sideEffect.adapterId !== 'string' || typeof spec.sideEffect.operationType !== 'string' || typeof spec.sideEffect.target !== 'function')) {
    throw new HypertestError('invalid_argument', `tool ${spec.id}: sideEffect needs adapterId, operationType and target()`);
  }
}

/**
 * In-memory tool catalog. Registration is append-only (duplicate id ⇒ conflict); the content revision
 * feeds RuntimeManifest.toolCatalogRevision (I11).
 */
export class ToolRegistry implements ToolRegistryLike {
  readonly #specs = new Map<string, ToolSpec>();

  constructor(specs: readonly ToolSpec[] = []) {
    for (const s of specs) this.register(s);
  }

  register(spec: ToolSpec): void {
    assertValidSpec(spec);
    if (this.#specs.has(spec.id)) throw new HypertestError('conflict', `tool ${spec.id} is already registered`);
    this.#specs.set(spec.id, spec);
  }

  get(id: string): ToolSpec | undefined {
    return this.#specs.get(id);
  }

  /** Resolves a model-visible name (`fs__read`) or an id. */
  getByName(name: string): ToolSpec | undefined {
    return this.#specs.get(toolNameToId(name)) ?? this.#specs.get(name);
  }

  list(): ToolSpec[] {
    return [...this.#specs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * A tool is visible iff some `allow` pattern matches, no `deny` pattern matches and the capability's tool
   * patterns allow it. Patterns: exact id, trailing-`*` prefix glob, `*`. Sorted by id (deterministic).
   */
  definitionsFor(capability: ActionCapability, allow: string[], deny: string[] = []): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const spec of this.list()) {
      if (!allow.some((p) => matchesToolPattern(p, spec.id))) continue;
      if (deny.some((p) => matchesToolPattern(p, spec.id))) continue;
      if (!capability.tools.some((p) => matchesToolPattern(p, spec.id))) continue;
      out.push({ name: toolIdToName(spec.id), description: spec.description, inputSchema: spec.inputSchema });
    }
    return out;
  }

  /** sha256 over the canonical, id-sorted list of [id, inputSchema, outputSchema, effect, risk] (dynamic ⇒ 'dynamic'). */
  revision(): string {
    const entries = this.list().map((s) => [
      s.id,
      s.inputSchema,
      s.outputSchema ?? null,
      typeof s.effect === 'function' ? 'dynamic' : s.effect,
      typeof s.riskClass === 'function' ? 'dynamic' : s.riskClass,
    ]);
    return hashCanonical(entries);
  }
}
