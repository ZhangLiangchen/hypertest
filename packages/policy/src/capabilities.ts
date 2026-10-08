import { createHmac, timingSafeEqual } from 'node:crypto';
import { HypertestError, canonicalJson, deepFreeze, newId } from '@hypertest/core';
import { EFFECT_ORDER, RISK_ORDER, riskAtMost, type ActionCapability, type PermissionProfile, type RiskClass, type ToolEffect } from '@hypertest/domain';
import type {
  AttenuateOptions, CapabilityCheck, CapabilityCheckRequest, CapabilityConstraints, ChildCapabilityIdentity, PermissionProfileName, RootCapabilityInput,
} from './contracts.ts';
import { intersectPatterns, matchesResourcePattern, matchesToolPattern } from './patterns.ts';

/** Credential scope marking a capability that may change product (non-test) code. */
export const PRODUCT_FIX_SCOPE = 'workspace:product_write';

const ALL_EFFECTS: readonly ToolEffect[] = ['read', 'record', 'write_workspace', 'execute', 'external', 'destructive'];
const ALL_RISKS: readonly RiskClass[] = ['low', 'medium', 'high', 'critical'];

/**
 * Built-in permission profiles. Resource keys follow the tools convention: `workspace/<workspaceId>/<path>`
 * for workspace files, `env/<environmentId>/…` for environments, `run/<runId>/…` for run-scoped records, and the
 * black-box execution plane's `loadgen/<host>` (the load generator a load job occupies) and `loadjob/<operationId>`
 * (a running load job). No built-in profile grants production; an operator must configure an explicit profile for that.
 */
export const PERMISSION_PROFILES: Readonly<Record<PermissionProfileName, PermissionProfile>> = deepFreeze<Record<PermissionProfileName, PermissionProfile>>({
  read_only: {
    name: 'read_only',
    allowedEffects: ['read', 'record'],
    maxRiskClass: 'low',
    resourceScopes: ['**'],
    environmentClasses: ['local', 'sandbox', 'staging'],
    credentialScopes: [],
  },
  analyst: {
    name: 'analyst',
    allowedEffects: ['read', 'record'],
    maxRiskClass: 'medium',
    resourceScopes: ['**'],
    environmentClasses: ['local', 'sandbox', 'staging'],
    credentialScopes: [],
  },
  test_author: {
    name: 'test_author',
    allowedEffects: ['read', 'record', 'write_workspace', 'execute'],
    maxRiskClass: 'medium',
    resourceScopes: ['workspace/**', 'run/**'],
    environmentClasses: ['local', 'sandbox'],
    credentialScopes: [],
  },
  test_executor: {
    name: 'test_executor',
    allowedEffects: ['read', 'record', 'execute', 'external'],
    maxRiskClass: 'high',
    resourceScopes: ['workspace/**', 'run/**', 'env/**', 'loadgen/**', 'loadjob/**'],
    environmentClasses: ['local', 'sandbox'],
    credentialScopes: [],
  },
  // (E[8]) critical actions (env.deploy) are within the operator's reach, but never without a human: the default rule
  // approve-critical-risk (always composed in, most restrictive) sends every critical external/destructive action to
  // approval_required, and the approval gate lets it run once only after an independent human approval of that exact call.
  environment_operator: {
    name: 'environment_operator',
    allowedEffects: ['read', 'record', 'execute', 'external', 'destructive'],
    maxRiskClass: 'critical',
    resourceScopes: ['workspace/**', 'run/**', 'env/**', 'loadgen/**', 'loadjob/**'],
    environmentClasses: ['local', 'sandbox', 'staging'],
    credentialScopes: [],
  },
  product_fixer: {
    name: 'product_fixer',
    allowedEffects: ['read', 'record', 'write_workspace', 'execute'],
    maxRiskClass: 'medium',
    resourceScopes: ['workspace/**', 'run/**'],
    environmentClasses: ['local', 'sandbox'],
    credentialScopes: [PRODUCT_FIX_SCOPE],
  },
});

function assertIso(value: string, what: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new HypertestError('invalid_argument', `${what} is not an ISO timestamp: ${value}`);
  return ms;
}

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length === 0) throw new HypertestError('invalid_argument', 'capability secret must be a non-empty string');
}

function resolveProfile(profile: PermissionProfileName | PermissionProfile): PermissionProfile {
  if (typeof profile !== 'string') return profile;
  const p = (PERMISSION_PROFILES as Record<string, PermissionProfile | undefined>)[profile];
  if (!p) throw new HypertestError('invalid_argument', `unknown permission profile: ${profile}`);
  return p;
}

function sortedUnique<T extends string>(xs: readonly T[]): T[] {
  return [...new Set(xs)].sort();
}

function sortEffects(xs: readonly ToolEffect[]): ToolEffect[] {
  return [...new Set(xs)].sort((a, b) => EFFECT_ORDER[a] - EFFECT_ORDER[b]);
}

/** Builds and signs the root capability of a work item from a permission profile. */
export function createRootCapability(input: RootCapabilityInput, secret: string): ActionCapability {
  assertSecret(secret);
  assertIso(input.expiresAt, 'expiresAt');
  const profile = resolveProfile(input.profile);
  for (const e of profile.allowedEffects) if (!ALL_EFFECTS.includes(e)) throw new HypertestError('invalid_argument', `unknown effect in profile ${profile.name}: ${e}`);
  if (!ALL_RISKS.includes(profile.maxRiskClass)) throw new HypertestError('invalid_argument', `unknown risk class in profile ${profile.name}: ${profile.maxRiskClass}`);
  const cap: ActionCapability = {
    capabilityId: input.capabilityId ?? newId('cap'),
    runId: input.runId,
    subjectAgentId: input.subjectAgentId,
    workItemId: input.workItemId,
    tools: sortedUnique(input.tools ?? ['*']),
    resourceScopes: sortedUnique(profile.resourceScopes),
    allowedEffects: sortEffects(profile.allowedEffects),
    credentialScopes: sortedUnique(profile.credentialScopes),
    maxRiskClass: profile.maxRiskClass,
    environmentClasses: sortedUnique(profile.environmentClasses),
    expiresAt: new Date(Date.parse(input.expiresAt)).toISOString(),
  };
  return signCapability(cap, secret);
}

function minRisk(a: RiskClass, b: RiskClass): RiskClass {
  return RISK_ORDER[a] <= RISK_ORDER[b] ? a : b;
}

function minIso(a: string, b: string): string {
  const am = Date.parse(a);
  const bm = Date.parse(b);
  // An unparseable expiry is treated as already expired (fail closed).
  if (!Number.isFinite(am)) return a;
  if (!Number.isFinite(bm)) return b;
  return am <= bm ? a : b;
}

function applyConstraints(parent: ActionCapability, c: CapabilityConstraints): ActionCapability {
  const next: ActionCapability = {
    ...parent,
    tools: c.tools ? intersectPatterns(parent.tools, c.tools, 'tool') : [...parent.tools],
    resourceScopes: c.resourceScopes ? intersectPatterns(parent.resourceScopes, c.resourceScopes, 'resource') : [...parent.resourceScopes],
    allowedEffects: c.allowedEffects ? sortEffects(parent.allowedEffects.filter((e) => c.allowedEffects!.includes(e))) : [...parent.allowedEffects],
    credentialScopes: c.credentialScopes ? sortedUnique(parent.credentialScopes.filter((s) => c.credentialScopes!.includes(s))) : [...parent.credentialScopes],
    environmentClasses: c.environmentClasses ? sortedUnique(parent.environmentClasses.filter((s) => c.environmentClasses!.includes(s))) : [...parent.environmentClasses],
    maxRiskClass: c.maxRiskClass ? minRisk(parent.maxRiskClass, c.maxRiskClass) : parent.maxRiskClass,
    expiresAt: c.expiresAt ? minIso(parent.expiresAt, c.expiresAt) : parent.expiresAt,
  };
  return next;
}

/**
 * I2: child = parent ∩ constraints (role policy ∩ work-item requirements ∩ environment policy when an
 * array is given). Never amplifies: every pattern of the child is covered by the parent, effect /
 * credential / environment sets are intersections, risk and expiry are minima. Without options the result
 * is unsigned and the caller signs it with signCapability. With `options.secret` the parent's signature is
 * verified first (permission_denied otherwise, so a tampered parent can never be laundered into a validly
 * signed child) and the child is returned signed.
 */
export function attenuateCapability(
  parent: ActionCapability,
  constraints: CapabilityConstraints | readonly CapabilityConstraints[],
  child: ChildCapabilityIdentity,
  options: AttenuateOptions = {},
): ActionCapability {
  if (options.secret !== undefined && !verifyCapability(parent, options.secret)) {
    throw new HypertestError('permission_denied', `parent capability ${parent.capabilityId} has an invalid signature; refusing to attenuate`);
  }
  const list: readonly CapabilityConstraints[] = Array.isArray(constraints) ? constraints : [constraints as CapabilityConstraints];
  let cap: ActionCapability = { ...parent };
  for (const c of list) cap = applyConstraints(cap, c);
  const { signature: _drop, ...unsigned } = cap;
  const result: ActionCapability = {
    ...unsigned,
    capabilityId: child.capabilityId ?? newId('cap'),
    subjectAgentId: child.subjectAgentId,
    workItemId: child.workItemId,
    parentCapabilityId: parent.capabilityId,
  };
  return options.secret !== undefined ? signCapability(result, options.secret) : result;
}

/**
 * A resource key must be canonical: no empty, `.` or `..` segments (so `workspace/wt_1/../../etc/passwd`
 * can never match `workspace/**`). Returns the offending reason or undefined.
 */
export function nonCanonicalResource(resource: string): string | undefined {
  if (typeof resource !== 'string') return 'not a string';
  if (resource === '') return 'empty resource key';
  if (resource.includes('\\') || resource.includes('\0')) return 'contains a backslash or NUL';
  for (const seg of resource.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return `segment ${JSON.stringify(seg)}`;
  }
  return undefined;
}

/** Checks a concrete action against a capability; the first failing check gives a precise reason. */
export function capabilityAllows(cap: ActionCapability, req: CapabilityCheckRequest): CapabilityCheck {
  const now = Date.parse(req.now);
  const exp = Date.parse(cap.expiresAt);
  if (!Number.isFinite(now)) return { allowed: false, reason: `invalid_now: ${req.now}` };
  if (!Number.isFinite(exp)) return { allowed: false, reason: `capability_expired: invalid expiresAt ${cap.expiresAt}` };
  if (!(now < exp)) return { allowed: false, reason: `capability_expired: ${cap.expiresAt} <= ${req.now}` };
  if (!cap.tools.some((p) => matchesToolPattern(p, req.tool))) return { allowed: false, reason: `tool_not_permitted: ${req.tool}` };
  if (!cap.allowedEffects.includes(req.effect)) return { allowed: false, reason: `effect_not_permitted: ${req.effect}` };
  if (!Object.hasOwn(RISK_ORDER, req.riskClass) || !Object.hasOwn(RISK_ORDER, cap.maxRiskClass) || !riskAtMost(req.riskClass, cap.maxRiskClass)) {
    return { allowed: false, reason: `risk_exceeds_capability: ${req.riskClass} > ${cap.maxRiskClass}` };
  }
  for (const r of req.resources) {
    const bad = nonCanonicalResource(r);
    if (bad !== undefined) return { allowed: false, reason: `resource_not_canonical: ${r} (${bad})` };
    if (!cap.resourceScopes.some((p) => matchesResourcePattern(p, r))) return { allowed: false, reason: `resource_out_of_scope: ${r}` };
  }
  if (req.environmentClass !== undefined && !cap.environmentClasses.includes(req.environmentClass)) {
    return { allowed: false, reason: `environment_not_permitted: ${req.environmentClass}` };
  }
  for (const s of req.credentialScopes ?? []) {
    if (!cap.credentialScopes.includes(s)) return { allowed: false, reason: `credential_scope_not_permitted: ${s}` };
  }
  return { allowed: true };
}

function capabilityBody(cap: ActionCapability): string {
  const { signature: _sig, ...body } = cap;
  return canonicalJson(body);
}

function hmac(cap: ActionCapability, secret: string): string {
  return createHmac('sha256', secret).update(capabilityBody(cap)).digest('base64url');
}

/** HMAC-SHA256 (base64url) over the canonical capability body (signature excluded). */
export function signCapability(cap: ActionCapability, secret: string): ActionCapability {
  assertSecret(secret);
  return { ...cap, signature: hmac(cap, secret) };
}

/** Timing-safe verification; false for unsigned, malformed or tampered capabilities. */
export function verifyCapability(cap: ActionCapability, secret: string): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (typeof cap.signature !== 'string' || cap.signature.length === 0) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hmac(cap, secret), 'utf8');
  } catch {
    return false;
  }
  const given = Buffer.from(cap.signature, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/** True when the capability carries the product-fix credential scope (see classifyTestChange). */
export function holdsProductFix(cap: ActionCapability): boolean {
  return cap.credentialScopes.includes(PRODUCT_FIX_SCOPE);
}
