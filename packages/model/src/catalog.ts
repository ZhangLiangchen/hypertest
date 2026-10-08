import { HypertestError, canonicalJson, deepFreeze, jsonClone, sha256Hex, validateJson, type JsonSchema } from '@hypertest/core';
import type { ModelCapabilityProfile, ModelCatalogLike } from './contracts.ts';

const CAPABILITIES = ['tool_use', 'parallel_tool_calls', 'structured_output', 'reasoning', 'vision', 'long_context', 'computer_use'];
const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'];
const RISKS = ['low', 'medium', 'high', 'critical'];

/** JSON Schema of a ModelCapabilityProfile (strict: unknown fields, capabilities and classes are rejected). */
export const MODEL_CAPABILITY_PROFILE_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'routeId', 'provider', 'model', 'capabilities', 'structuredOutput', 'reasoning', 'contextWindow', 'maxOutputTokens',
    'continuationCompatibilityClass', 'maxDataClassification', 'quality', 'toolReliability', 'typicalLatencyMs', 'maxActionRisk', 'enabled',
  ],
  properties: {
    routeId: { type: 'string', minLength: 1, maxLength: 200 },
    provider: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
    displayName: { type: 'string' },
    capabilities: { type: 'array', items: { enum: CAPABILITIES }, uniqueItems: true },
    structuredOutput: { enum: ['native', 'prompted', 'none'] },
    reasoning: { enum: ['native', 'visible', 'opaque', 'none'] },
    contextWindow: { type: 'integer', minimum: 1 },
    maxOutputTokens: { type: 'integer', minimum: 1 },
    continuationCompatibilityClass: { type: 'string', minLength: 1 },
    maxDataClassification: { enum: CLASSIFICATIONS },
    quality: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 } },
    toolReliability: { type: 'number', minimum: 0, maximum: 1 },
    costPerMillionInputUsd: { type: 'number', minimum: 0 },
    costPerMillionOutputUsd: { type: 'number', minimum: 0 },
    typicalLatencyMs: { type: 'number', minimum: 0 },
    maxActionRisk: { enum: RISKS },
    reasoningEffort: { enum: ['low', 'medium', 'high'] },
    extra: { type: 'object' },
    enabled: { type: 'boolean' },
  },
};

/**
 * Immutable, revisioned set of route capability profiles. `revision = 'mc_' + sha256(canonicalJson(profiles))[0..16]`
 * so any change (including scores) yields a new revision that epochs and manifests can pin.
 * `list()` returns every profile, including disabled ones — the router filters `enabled` (security stage).
 */
export class ModelCatalog implements ModelCatalogLike {
  readonly revision: string;
  readonly #profiles: readonly ModelCapabilityProfile[];
  readonly #byId: ReadonlyMap<string, ModelCapabilityProfile>;

  constructor(profiles: readonly ModelCapabilityProfile[]) {
    if (!Array.isArray(profiles)) throw new HypertestError('invalid_argument', 'model catalog: profiles must be an array');
    const byId = new Map<string, ModelCapabilityProfile>();
    profiles.forEach((p, i) => {
      assertFiniteNumbers(p, i);
      const r = validateJson<ModelCapabilityProfile>(MODEL_CAPABILITY_PROFILE_SCHEMA, p);
      if (!r.valid) {
        throw new HypertestError('invalid_argument', `model catalog: profile #${i} (${String((p as { routeId?: unknown } | null)?.routeId)}) invalid: ${r.issues.map((x) => `${x.path} ${x.message}`).join('; ')}`, {
          details: { index: i, issues: r.issues },
        });
      }
      if (byId.has(p.routeId)) throw new HypertestError('invalid_argument', `model catalog: duplicate routeId ${p.routeId}`, { details: { routeId: p.routeId } });
      byId.set(p.routeId, p);
    });
    const copy = deepFreeze(jsonClone([...profiles]));
    this.#profiles = copy;
    this.#byId = new Map(copy.map((p) => [p.routeId, p]));
    this.revision = 'mc_' + sha256Hex(canonicalJson(copy)).slice(0, 16);
  }

  /** All profiles (frozen), in declaration order, including disabled ones. */
  list(): ModelCapabilityProfile[] {
    return [...this.#profiles];
  }

  get(routeId: string): ModelCapabilityProfile | undefined {
    return this.#byId.get(routeId);
  }

  /**
   * Returns a NEW catalog (new revision) with quality scores merged per route (e.g. from eval results).
   * Unknown route ids are a `not_found` fault; scores are validated like any profile.
   */
  withScores(scores: Record<string, Record<string, number>>): ModelCatalog {
    for (const routeId of Object.keys(scores)) {
      if (!this.#byId.has(routeId)) throw new HypertestError('not_found', `model catalog: unknown routeId ${routeId}`, { details: { routeId } });
    }
    const next = this.#profiles.map((p) => {
      const s = scores[p.routeId];
      if (!s) return jsonClone(p);
      return { ...jsonClone(p), quality: { ...p.quality, ...s } };
    });
    return new ModelCatalog(next);
  }
}

/** Ajv cannot see NaN/Infinity through JSON semantics consistently; reject them explicitly (fail closed). */
function assertFiniteNumbers(p: unknown, index: number): void {
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new HypertestError('invalid_argument', `model catalog: profile #${index} has a non-finite number at ${path}`);
    }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}/${k}`);
  };
  walk(p, '');
}
