import { EFFECT_ORDER, type ActionCapability, type CapabilityRequirement, type ToolEffect } from '@hypertest/domain';
import { intersectPatterns, nonCanonicalResource, resourcePatternCovers, type CapabilityConstraints } from '@hypertest/policy';

/**
 * I2 (BLUEPRINT §1.2; improvements §安全与权限边界): an agent's capability is
 *
 *     parent (or the root profile) ∩ role policy ∩ WorkItem.capabilityRequirements ∩ environment policy
 *
 * and never amplified. This module is the work item's share of that intersection. A work item without requirements
 * constrains nothing beyond its role. With requirements, the grant is narrowed to what they ask for: an ActionCapability
 * is flat (it cannot pair an effect with a scope), so the constraint is the LEAST flat capability covering every
 * requirement plus the baseline every agent needs to work at all:
 *   - effects      = read ∪ record ∪ { r.effect }
 *   - scopes       = the agent's own workspace and the run's records (baseline) ∪ { r.resourceScopes }
 *   - environments = { r.environmentClass } when at least one requirement names a class and no requirement without a
 *                    class may address an environment (unconstrained otherwise). A requirement without a class asks
 *                    for its scopes in EVERY class the other operands allow; only scopes confined to the agent-local
 *                    namespaces (ENVIRONMENT_FREE_NAMESPACES: workspace files, run records — resources no tool ever
 *                    classifies by environment) need no class, so they do not widen the named classes.
 * Requirements that exceed the parent / role / environment policy are simply not granted (intersection) — the missing
 * part is reported (unmetRequirements) to the agent in its task message, never silently dropped.
 */

/** Effects every agent keeps within its baseline scopes (read inputs, record findings / complete its work). */
export const BASELINE_EFFECTS: readonly ToolEffect[] = Object.freeze(['read', 'record'] as const);

/** JSON schema of a CapabilityRequirement (domain type) in tool inputs. */
export const CAPABILITY_REQUIREMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['effect', 'resourceScopes'],
  properties: {
    effect: { type: 'string', enum: ['read', 'record', 'write_workspace', 'execute', 'external', 'destructive'] },
    resourceScopes: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1, maxLength: 512 } },
    environmentClass: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const;

/** Structural problems of a work item's capability requirements (empty: well formed). */
export function requirementProblems(requirements: unknown, at = 'capabilityRequirements'): string[] {
  if (!Array.isArray(requirements)) return [`${at} must be a list`];
  const out: string[] = [];
  requirements.forEach((r: unknown, i) => {
    const p = `${at}[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      out.push(`${p} must be an object`);
      return;
    }
    const req = r as Record<string, unknown>;
    if (typeof req['effect'] !== 'string' || !Object.hasOwn(EFFECT_ORDER, req['effect'])) out.push(`${p}.effect must be one of ${Object.keys(EFFECT_ORDER).join(', ')}`);
    const scopes = req['resourceScopes'];
    if (!Array.isArray(scopes) || scopes.length === 0) out.push(`${p}.resourceScopes must be a non-empty list`);
    else {
      for (const s of scopes) {
        const bad = typeof s === 'string' ? nonCanonicalResource(s) : 'not a string';
        if (bad !== undefined) out.push(`${p}.resourceScopes: ${JSON.stringify(s)} is not a canonical resource pattern (${bad})`);
      }
    }
    if (req['environmentClass'] !== undefined && (typeof req['environmentClass'] !== 'string' || req['environmentClass'] === '')) out.push(`${p}.environmentClass must be a non-empty string`);
  });
  return out;
}

/**
 * Resource namespaces whose keys are never classified by environment: the agent's workspace files (`workspace/…`) and
 * the run's records (`run/…`). Every other scope (`env/…`, `loadgen/…`, `loadjob/…`, host or MCP resources, `**`) may be
 * addressed by a tool that carries an environment class.
 */
export const ENVIRONMENT_FREE_NAMESPACES: readonly string[] = Object.freeze(['workspace', 'run']);

/** True when a requirement WITHOUT an environment class may address environments (it then needs every allowed class). */
export function addressesEnvironments(requirement: Pick<CapabilityRequirement, 'resourceScopes'>): boolean {
  return requirement.resourceScopes.some((s) => !ENVIRONMENT_FREE_NAMESPACES.includes(s.split('/', 1)[0]!));
}

/** The work item's constraint (see the module comment); undefined when it states no requirements. */
export function workItemConstraint(requirements: readonly CapabilityRequirement[], baselineScopes: readonly string[]): CapabilityConstraints | undefined {
  if (requirements.length === 0) return undefined;
  const effects = new Set<ToolEffect>(BASELINE_EFFECTS);
  const scopes = new Set<string>(baselineScopes);
  const classes = new Set<string>();
  // a classless requirement that may address environments needs every class: the classes stay unconstrained
  let everyClass = false;
  for (const r of requirements) {
    effects.add(r.effect);
    for (const s of r.resourceScopes) scopes.add(s);
    if (r.environmentClass !== undefined) classes.add(r.environmentClass);
    else if (addressesEnvironments(r)) everyClass = true;
  }
  const c: CapabilityConstraints = {
    allowedEffects: [...effects].sort((a, b) => EFFECT_ORDER[a] - EFFECT_ORDER[b]),
    resourceScopes: [...scopes].sort(),
  };
  if (classes.size > 0 && !everyClass) c.environmentClasses = [...classes].sort();
  return c;
}

/** One requirement the granted capability does not (fully) cover, with what is missing. */
export interface UnmetRequirement {
  requirement: CapabilityRequirement;
  missing: string[];
}

/** The requirements `cap` does not cover (an effect, scope or environment class it lacks), in requirement order. */
export function unmetRequirements(cap: ActionCapability, requirements: readonly CapabilityRequirement[]): UnmetRequirement[] {
  const out: UnmetRequirement[] = [];
  for (const r of requirements) {
    const missing: string[] = [];
    if (!(cap.allowedEffects as string[]).includes(r.effect)) missing.push(`effect ${r.effect}`);
    for (const s of r.resourceScopes) {
      if (cap.resourceScopes.some((p) => resourcePatternCovers(p, s))) continue;
      const part = intersectPatterns(cap.resourceScopes, [s], 'resource');
      missing.push(part.length > 0 ? `resource scope ${s} (granted only ${part.join(', ')})` : `resource scope ${s}`);
    }
    if (r.environmentClass !== undefined && !cap.environmentClasses.includes(r.environmentClass)) missing.push(`environment class ${r.environmentClass}`);
    if (missing.length > 0) out.push({ requirement: r, missing });
  }
  return out;
}

/** One line per unmet requirement (task message and audit). */
export function describeUnmet(unmet: readonly UnmetRequirement[]): string[] {
  return unmet.map(({ requirement: r, missing }) => `${r.effect} on ${r.resourceScopes.join(', ')}${r.environmentClass ? ` in ${r.environmentClass}` : ''}: not granted — ${missing.join('; ')}`);
}
