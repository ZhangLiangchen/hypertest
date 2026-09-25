import { deepFreeze, isValidSchema, validateJson, type JsonSchema } from '@hypertest/core';
import { EVENT_TYPES } from '@hypertest/domain';
import type { RoleDefinition, RoleValidationOptions } from './contracts.ts';
import { PROMPT_TEMPLATE_VARS, SUBSCRIPTION_TEMPLATE_VARS, malformedPlaceholders, templateVariables } from './template.ts';
import { TERMINAL_TOOLS, WORKSPACE_WRITE_TOOL_IDS, isKnownToolPattern, toolPermitted } from './tool-ids.ts';

/**
 * Ids consumers may use as keys of plain objects (quotas per role, rate limits per rule): names of
 * Object.prototype members that the id grammar would otherwise admit are reserved.
 */
const RESERVED_IDS = ['constructor', 'prototype'] as const;
const ROLE_ID = { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$', not: { enum: RESERVED_IDS } } as const;
const NON_EMPTY = { type: 'string', minLength: 1 } as const;
const uniqueStrings = (minItems = 0) => ({ type: 'array', items: NON_EMPTY, uniqueItems: true, minItems }) as const;

const BUDGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxTurns: { type: 'integer', minimum: 1 },
    maxTokens: { type: 'integer', minimum: 1 },
    maxCostUsd: { type: 'number', minimum: 0 },
    maxToolCalls: { type: 'integer', minimum: 1 },
    maxWallClockMs: { type: 'integer', minimum: 1 },
  },
} as const;

const MODEL_POLICY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    preferredRoutes: uniqueStrings(),
    requiredCapabilities: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: ['tool_use', 'parallel_tool_calls', 'structured_output', 'reasoning', 'vision', 'long_context', 'computer_use'] },
    },
    minQuality: { type: 'number', minimum: 0, maximum: 1 },
    allowedProviders: uniqueStrings(),
    prohibitedProviders: uniqueStrings(),
    privacyClass: { type: 'string', enum: ['public', 'internal', 'confidential', 'restricted'] },
    independentFromRoles: { type: 'array', uniqueItems: true, items: ROLE_ID },
    maxCostPerCallUsd: { type: 'number', minimum: 0 },
    latencyBudgetMs: { type: 'integer', minimum: 1 },
    reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high'] },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    fallback: { type: 'string', enum: ['revalidated', 'fail_closed'] },
  },
} as const;

const SUBSCRIPTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ruleId', 'eventTypes', 'work', 'maxPerRun', 'maxCausalDepth'],
  properties: {
    ruleId: { type: 'string', pattern: '^[a-z][a-z0-9_.:-]{0,127}$', not: { enum: RESERVED_IDS } },
    eventTypes: uniqueStrings(1),
    filter: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minSeverity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        categories: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', enum: ['product_defect', 'test_defect', 'infrastructure', 'environment', 'performance', 'security', 'unknown'] },
        },
        statuses: uniqueStrings(1),
        recordTypes: uniqueStrings(1),
        fromRoles: { type: 'array', minItems: 1, uniqueItems: true, items: ROLE_ID },
        excludeFromRoles: { type: 'array', minItems: 1, uniqueItems: true, items: ROLE_ID },
      },
    },
    work: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'objective', 'priority'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        objective: { type: 'string', minLength: 1, maxLength: 4000 },
        priority: { type: 'integer', minimum: 0, maximum: 100 },
        budget: BUDGET_SCHEMA,
        expectedOutput: { type: 'object' },
      },
    },
    maxPerRun: { type: 'integer', minimum: 1, maximum: 1000 },
    maxCausalDepth: { type: 'integer', minimum: 1, maximum: 32 },
  },
} as const;

/** JSON Schema (2020-12) of a RoleDefinition as accepted by the catalog (built-in, custom or overridden). */
export const ROLE_DEFINITION_SCHEMA: JsonSchema = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'role', 'description', 'systemPrompt', 'phase', 'taskType', 'defaultModelPolicy', 'toolPolicy', 'permissionProfile', 'workspace',
    'dataClassification', 'subscriptions', 'canDelegateTo', 'maxDepth', 'defaultBudget',
  ],
  properties: {
    role: ROLE_ID,
    description: { type: 'string', minLength: 1, maxLength: 500 },
    systemPrompt: { type: 'string', minLength: 1, maxLength: 40000 },
    phase: { type: 'string', enum: ['analysis', 'design', 'implementation', 'execution', 'diagnosis', 'review', 'acceptance'] },
    taskType: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
    defaultModelPolicy: MODEL_POLICY_SCHEMA,
    toolPolicy: {
      type: 'object',
      additionalProperties: false,
      required: ['allow'],
      properties: { allow: uniqueStrings(1), deny: uniqueStrings() },
    },
    permissionProfile: { type: 'string', enum: ['read_only', 'analyst', 'test_author', 'test_executor', 'environment_operator', 'product_fixer'] },
    workspace: { type: 'string', enum: ['shared_readonly', 'isolated_worktree', 'scratch'] },
    dataClassification: { type: 'string', enum: ['public', 'internal', 'confidential', 'restricted'] },
    outputSchema: { type: 'object' },
    subscriptions: { type: 'array', items: SUBSCRIPTION_SCHEMA },
    canDelegateTo: { type: 'array', uniqueItems: true, items: ROLE_ID },
    maxDepth: { type: 'integer', minimum: 0, maximum: 8 },
    defaultBudget: BUDGET_SCHEMA,
  },
});

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(EVENT_TYPES));

/**
 * Validates one role definition (structure + semantics). Returns human-readable issues, each prefixed
 * with the role id; an empty array means valid. Semantic rules:
 * - the prompt uses only {{role}}/{{objective}}/{{protocol}}/{{runGoal}} and contains the {{protocol}} slot;
 * - allow/deny entries are known tool ids or namespaced globs over known tools (no bare `*`);
 * - both terminal tools (complete_work, fail_work) are permitted;
 * - a role holding a workspace-writing tool (fs.write, fs.apply_patch, git.commit) uses an isolated worktree;
 * - templates contain no malformed placeholders (e.g. `{{run goal}}`, which would survive rendering);
 * - `delegate` is permitted iff canDelegateTo is non-empty, and delegating roles have maxDepth ≥ 1;
 * - output / expected-output schemas compile;
 * - subscriptions use known event types, only the documented template variables and unique rule ids;
 * - a filter never both requires (fromRoles) and excludes (excludeFromRoles) the same actor role;
 * - with `knownRoles`, canDelegateTo, independentFromRoles and filter.fromRoles / excludeFromRoles reference catalog roles.
 */
export function validateRoleDefinition(role: unknown, options: RoleValidationOptions = {}): string[] {
  const r = validateJson<RoleDefinition>(ROLE_DEFINITION_SCHEMA, role);
  const label = (role && typeof role === 'object' && typeof (role as { role?: unknown }).role === 'string' ? (role as { role: string }).role : '<unnamed>');
  if (!r.valid) return r.issues.map((i) => `${label}: ${i.path} ${i.message}`);
  const def = r.value;
  const issues: string[] = [];
  const add = (msg: string): void => {
    issues.push(`${def.role}: ${msg}`);
  };
  const extraTools = options.extraToolIds ?? [];

  const promptVars = templateVariables(def.systemPrompt);
  for (const v of promptVars) {
    if (!(PROMPT_TEMPLATE_VARS as readonly string[]).includes(v)) add(`systemPrompt uses unknown placeholder {{${v}}} (allowed: ${PROMPT_TEMPLATE_VARS.join(', ')})`);
  }
  if (!promptVars.includes('protocol')) add('systemPrompt must contain the {{protocol}} injection slot');
  for (const m of malformedPlaceholders(def.systemPrompt)) add(`systemPrompt contains malformed placeholder ${m}`);

  for (const p of def.toolPolicy.allow) {
    if (!isKnownToolPattern(p, extraTools)) add(`toolPolicy.allow entry '${p}' is not a known tool id or namespaced glob over known tools`);
  }
  for (const p of def.toolPolicy.deny ?? []) {
    if (!isKnownToolPattern(p, extraTools)) add(`toolPolicy.deny entry '${p}' is not a known tool id or namespaced glob over known tools`);
  }
  for (const t of TERMINAL_TOOLS) {
    if (!toolPermitted(def.toolPolicy, t)) add(`terminal tool '${t}' must be permitted`);
  }
  const writes = WORKSPACE_WRITE_TOOL_IDS.filter((t) => toolPermitted(def.toolPolicy, t));
  if (writes.length > 0 && def.workspace !== 'isolated_worktree') {
    add(`holds workspace-writing tools (${writes.join(', ')}) but workspace is '${def.workspace}'; they require 'isolated_worktree'`);
  }

  const canDelegate = toolPermitted(def.toolPolicy, 'delegate');
  if (def.canDelegateTo.length > 0 && !canDelegate) add("canDelegateTo is non-empty but the 'delegate' tool is not permitted");
  if (def.canDelegateTo.length === 0 && canDelegate) add("the 'delegate' tool is permitted but canDelegateTo is empty");
  if (def.canDelegateTo.length > 0 && def.maxDepth < 1) add('a delegating role needs maxDepth >= 1');

  if (def.outputSchema !== undefined && !isValidSchema(def.outputSchema)) add('outputSchema does not compile');

  if (options.knownRoles !== undefined) {
    const known = new Set(options.knownRoles);
    for (const d of def.canDelegateTo) if (!known.has(d)) add(`canDelegateTo references unknown role '${d}'`);
    for (const d of def.defaultModelPolicy.independentFromRoles ?? []) if (!known.has(d)) add(`independentFromRoles references unknown role '${d}'`);
    for (const sub of def.subscriptions) {
      for (const key of ['fromRoles', 'excludeFromRoles'] as const) {
        for (const d of sub.filter?.[key] ?? []) if (!known.has(d)) add(`subscription '${sub.ruleId}' filter.${key} references unknown role '${d}'`);
      }
    }
  }

  const eventTypes = new Set([...KNOWN_EVENT_TYPES, ...(options.extraEventTypes ?? [])]);
  const ruleIds = new Set<string>();
  for (const sub of def.subscriptions) {
    if (ruleIds.has(sub.ruleId)) add(`duplicate subscription ruleId '${sub.ruleId}'`);
    const contradictory = (sub.filter?.fromRoles ?? []).filter((r) => sub.filter?.excludeFromRoles?.includes(r));
    if (contradictory.length > 0) add(`subscription '${sub.ruleId}' both requires and excludes actor roles: ${contradictory.join(', ')}`);
    ruleIds.add(sub.ruleId);
    for (const t of sub.eventTypes) if (!eventTypes.has(t)) add(`subscription '${sub.ruleId}' uses unknown event type '${t}'`);
    for (const field of ['title', 'objective'] as const) {
      for (const v of templateVariables(sub.work[field])) {
        if (!(SUBSCRIPTION_TEMPLATE_VARS as readonly string[]).includes(v)) add(`subscription '${sub.ruleId}' work.${field} uses unknown placeholder {{${v}}}`);
      }
      for (const m of malformedPlaceholders(sub.work[field])) add(`subscription '${sub.ruleId}' work.${field} contains malformed placeholder ${m}`);
    }
    if (sub.work.expectedOutput !== undefined && !isValidSchema(sub.work.expectedOutput)) add(`subscription '${sub.ruleId}' expectedOutput does not compile`);
  }
  return issues;
}
