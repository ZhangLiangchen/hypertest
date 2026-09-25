import { HypertestError, canonicalJson, deepFreeze, jsonClone, sha256Hex } from '@hypertest/core';
import type { AgentRole } from '@hypertest/domain';
import type { RoleCatalogLike, RoleCatalogOptions, RoleDefinition, RoleOverrides, RoleSubscription } from './contracts.ts';
import { validateRoleDefinition } from './validation.ts';

type FlatSubscription = RoleSubscription & { role: AgentRole };

const ROLE_KEYS: ReadonlySet<string> = new Set([
  'description', 'systemPrompt', 'phase', 'taskType', 'defaultModelPolicy', 'toolPolicy', 'permissionProfile', 'workspace',
  'dataClassification', 'outputSchema', 'subscriptions', 'canDelegateTo', 'maxDepth', 'defaultBudget',
]);
/** Values replaced wholesale by an override (a partially merged JSON Schema is meaningless). */
const ATOMIC_KEYS: ReadonlySet<string> = new Set(['outputSchema']);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function invalid(message: string, details: Record<string, unknown> = {}): HypertestError {
  return new HypertestError('invalid_argument', message, { details });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Deep merge for configuration: plain objects merge recursively, arrays and scalars replace, undefined is ignored. */
function deepMerge(base: unknown, patch: unknown, path: string): unknown {
  if (isPlainObject(patch) && isPlainObject(base)) {
    const out: Record<string, unknown> = { ...base };
    for (const key of Object.keys(patch)) {
      if (FORBIDDEN_KEYS.has(key)) throw invalid(`role override: forbidden key '${key}' at ${path}`, { path, key });
      const value = patch[key];
      if (value === undefined) continue;
      out[key] = deepMerge(base[key], value, `${path}.${key}`);
    }
    return out;
  }
  if (isPlainObject(patch)) {
    for (const key of Object.keys(patch)) if (FORBIDDEN_KEYS.has(key)) throw invalid(`role override: forbidden key '${key}' at ${path}`, { path, key });
  }
  return jsonClone(patch);
}

function applyOverride(base: RoleDefinition, patch: unknown): RoleDefinition {
  if (!isPlainObject(patch)) throw invalid(`role override for '${base.role}' must be an object`, { role: base.role });
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const key of Object.keys(patch)) {
    if (key === 'role') throw invalid(`role override for '${base.role}' may not rename the role`, { role: base.role });
    if (FORBIDDEN_KEYS.has(key)) throw invalid(`role override for '${base.role}': forbidden key '${key}'`, { role: base.role, key });
    if (!ROLE_KEYS.has(key)) throw invalid(`role override for '${base.role}': unknown key '${key}'`, { role: base.role, key, allowed: [...ROLE_KEYS] });
    const value = patch[key];
    if (value === undefined) continue;
    out[key] = ATOMIC_KEYS.has(key) ? jsonClone(value) : deepMerge(out[key], value, `${base.role}.${key}`);
  }
  return out as unknown as RoleDefinition;
}

function cloneRole(role: unknown, source: string): RoleDefinition {
  if (!isPlainObject(role)) throw invalid(`${source} role definition must be an object`);
  return jsonClone(role) as unknown as RoleDefinition;
}

/**
 * Immutable, revisioned role catalog. Construction applies configuration overrides (deep merge; arrays
 * and JSON Schemas replace), appends custom roles, validates every effective role and the catalog as a
 * whole (unique roles and subscription rule ids, resolvable role references) and deep-freezes the result.
 * Invalid input throws `HypertestError('invalid_argument')` listing every issue; inputs are never mutated.
 */
export class RoleCatalog implements RoleCatalogLike {
  readonly #byRole: Map<string, RoleDefinition>;
  readonly #roles: readonly RoleDefinition[];
  readonly #subscriptions: readonly FlatSubscription[];
  readonly #revision: string;

  constructor(roles: readonly RoleDefinition[], overrides: RoleOverrides = {}, options: RoleCatalogOptions = {}) {
    if (!Array.isArray(roles)) throw invalid('roles must be an array');
    if (!isPlainObject(overrides)) throw invalid('role overrides must be an object');
    const custom: unknown = overrides.custom ?? [];
    if (!Array.isArray(custom)) throw invalid('overrides.custom must be an array');
    const perRole: unknown = overrides.roles ?? {};
    if (!isPlainObject(perRole)) throw invalid('overrides.roles must be an object keyed by role');
    if (!isPlainObject(options)) throw invalid('role catalog options must be an object');
    for (const key of ['extraToolIds', 'extraEventTypes'] as const) {
      const list: unknown = options[key];
      if (list !== undefined && !(Array.isArray(list) && list.every((v) => typeof v === 'string' && v.length > 0))) {
        throw invalid(`options.${key} must be an array of non-empty strings`, { key });
      }
    }

    const effective: RoleDefinition[] = [
      ...roles.map((r) => cloneRole(r, 'built-in')),
      ...(custom as unknown[]).map((r) => cloneRole(r, 'custom')),
    ];

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const r of effective) {
      const id = String(r.role);
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
    if (duplicates.length > 0) throw invalid(`duplicate role ids: ${[...new Set(duplicates)].join(', ')}`, { duplicates: [...new Set(duplicates)] });

    const unknownOverrides = Object.keys(perRole).filter((k) => !seen.has(k));
    if (unknownOverrides.length > 0) throw invalid(`overrides for unknown roles: ${unknownOverrides.join(', ')}`, { roles: unknownOverrides, known: [...seen] });
    for (let i = 0; i < effective.length; i++) {
      const base = effective[i]!;
      if (Object.hasOwn(perRole, base.role)) effective[i] = applyOverride(base, perRole[base.role]);
    }

    const issues: string[] = [];
    const knownRoles = [...seen];
    const validation = { knownRoles, ...(options.extraToolIds ? { extraToolIds: options.extraToolIds } : {}), ...(options.extraEventTypes ? { extraEventTypes: options.extraEventTypes } : {}) };
    for (const r of effective) issues.push(...validateRoleDefinition(r, validation));
    const ruleOwners = new Map<string, string>();
    for (const r of effective) {
      for (const sub of Array.isArray(r.subscriptions) ? r.subscriptions : []) {
        const owner = ruleOwners.get(sub.ruleId);
        if (owner !== undefined && owner !== r.role) issues.push(`${r.role}: subscription ruleId '${sub.ruleId}' is already used by role '${owner}'`);
        ruleOwners.set(sub.ruleId, r.role);
      }
    }
    if (issues.length > 0) throw invalid(`invalid role catalog: ${issues.join('; ')}`, { issues });

    this.#roles = deepFreeze(effective);
    this.#byRole = new Map(effective.map((r) => [r.role, r]));
    this.#subscriptions = deepFreeze(effective.flatMap((r) => r.subscriptions.map((s): FlatSubscription => ({ ...jsonClone(s), role: r.role }))));
    this.#revision = sha256Hex(canonicalJson({ catalogVersion: 1, roles: effective }));
  }

  get(role: string): RoleDefinition | undefined {
    return this.#byRole.get(role);
  }

  require(role: string): RoleDefinition {
    const r = this.#byRole.get(role);
    if (!r) throw new HypertestError('not_found', `unknown agent role: ${role}`, { details: { role, known: [...this.#byRole.keys()] } });
    return r;
  }

  list(): RoleDefinition[] {
    return [...this.#roles];
  }

  subscriptions(): Array<RoleSubscription & { role: AgentRole }> {
    return [...this.#subscriptions];
  }

  /** SHA-256 (hex) of the canonical JSON of the effective roles, in catalog order. */
  revision(): string {
    return this.#revision;
  }
}
