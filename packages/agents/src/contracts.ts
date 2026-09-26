import type { JsonSchema } from '@hypertest/core';
import type { AgentRole, DataClassification, FindingCategory, ModelPolicy, Severity, ToolPolicy, WorkBudget } from '@hypertest/domain';

/**
 * @hypertest/agents — the role catalog. Roles are data (policy), not code paths: prompts, default model
 * policy (native multi-LLM: every role routes independently), tool allowlists, permission profile,
 * output schema, event subscriptions (decentralized collaboration) and delegation limits.
 *
 * Implementations to export from src/index.ts:
 *   BUILTIN_ROLES: RoleDefinition[]   (lead, code_change_analyst, architecture_analyst, historical_bug_analyst,
 *                                      test_designer, executor, rca, fixer, reviewer, metrics_analyst,
 *                                      environment, condenser, + additive: vision_gui, local_private)
 *   class RoleCatalog implements RoleCatalogLike (constructor(roles, overrides?: RoleOverrides))
 *   renderTemplate(template: string, vars: Record<string, string>): string   ({{name}} substitution; unknown ⇒ left empty)
 *   TERMINAL_TOOLS = ['complete_work', 'fail_work'] as const
 *
 * Additive exports (backward compatible):
 *   BUILTIN_TOOL_IDS, DOMAIN_TOOL_IDS, KNOWN_TOOL_IDS (readonly tool id lists), type KnownToolId,
 *   WORKSPACE_WRITE_TOOL_IDS (fs.write, fs.apply_patch, git.commit: holders must use an isolated worktree),
 *   DYNAMIC_TOOL_NAMESPACES (['mcp.']: bridge tools discovered at runtime),
 *   matchesToolPattern(pattern, toolId)   (identical semantics to @hypertest/policy matchesToolPattern),
 *   isKnownToolPattern(pattern, extraToolIds?), toolPermitted(toolPolicy, toolId)   (allow matches and no deny matches)
 *   PROMPT_TEMPLATE_VARS (role, objective, protocol, runGoal), SUBSCRIPTION_TEMPLATE_VARS (title, severity,
 *   recordId, lineageId, summary, component), templateVariables(template): string[],
 *   renderRolePrompt(role, vars: RolePromptVars): string, renderSubscriptionWork(sub, vars): RenderedSubscriptionWork,
 *   NO_PROTOCOL_NOTICE, NO_OBJECTIVE_NOTICE, NO_RUN_GOAL_NOTICE (texts renderRolePrompt uses for blank inputs),
 *   matchesSubscription(sub, subject: SubscriptionSubject): boolean, matchesSubscriptionFilter(filter, subject): boolean,
 *   ROLE_DEFINITION_SCHEMA (JSON Schema of RoleDefinition), validateRoleDefinition(role, options?): string[],
 *   RoleCatalog constructor third parameter `options?: RoleCatalogOptions` (roles may be `readonly RoleDefinition[]`),
 *   role output schemas: LEAD_OUTPUT_SCHEMA, ANALYSIS_OUTPUT_SCHEMA, TEST_DESIGN_OUTPUT_SCHEMA, EXECUTION_OUTPUT_SCHEMA,
 *   RCA_OUTPUT_SCHEMA, FIX_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA, METRICS_OUTPUT_SCHEMA, ENVIRONMENT_OUTPUT_SCHEMA,
 *   CONDENSE_OUTPUT_SCHEMA, (runtime-roles unit) GUI_OUTPUT_SCHEMA, GUI_CHECK_METHODS, PRIVATE_OUTPUT_SCHEMA,
 *   SPECIALIST_ROLES (vision_gui, local_private: roles only a special route can serve).
 * BUILTIN_ROLES and every RoleCatalog role are deep-frozen; invalid catalogs (and malformed options) throw
 * HypertestError('invalid_argument'). Role ids and subscription ruleIds may not be 'constructor' or 'prototype'.
 * Every built-in role holds both TERMINAL_TOOLS (the condenser holds only those).
 *
 * Prompt requirements (all roles): evidence-first (never invent identifiers, numbers or results; cite
 * evidence ids), never weaken oracles/assertions/thresholds or skip/delete failing tests, distinguish
 * product defects from test/infra defects, label unproven root causes as hypotheses, prefer xfail/skip
 * only through governed proposals, finish with complete_work (structured output) or fail_work.
 * Lead: decomposes goals into typed PlanRevisions (plan.propose_revision), never executes tests, replans
 * on findings/gate feedback, sets readyForGate only when objectives are covered by evidence.
 * Reviewer: judges evidence (evidence.get/query), never the executor's narrative alone; uses a model
 * provider independent from executor/test_designer (independentFromRoles).
 */

export interface SubscriptionFilter {
  minSeverity?: Severity;
  categories?: FindingCategory[];
  statuses?: string[];
  recordTypes?: string[];
  /** Only events produced by these roles (actor role). */
  fromRoles?: string[];
  /**
   * Additive: events produced by these roles never match (self-trigger guard, e.g. an agent's own finding).
   * A subject without an actor role is not excluded.
   */
  excludeFromRoles?: string[];
}

export interface RoleSubscription {
  /** Unique across the whole catalog (reactor origin key: `WorkOrigin.rule`). */
  ruleId: string;
  eventTypes: string[];
  /**
   * All given constraints must hold (AND). A subject that lacks a constrained field does not match
   * (fail closed). Filter arrays are non-empty.
   */
  filter?: SubscriptionFilter;
  work: {
    /** Templates with {{title}}, {{severity}}, {{recordId}}, {{lineageId}}, {{summary}}, {{component}} from the event/record. */
    title: string;
    objective: string;
    /** 0..100 (same scale as PlannedWorkItem.priority); higher is more urgent. */
    priority: number;
    budget?: Partial<WorkBudget>;
    /** Defaults to the subscribing role's `outputSchema` when omitted. */
    expectedOutput?: JsonSchema;
  };
  /** Livelock guards. */
  maxPerRun: number;
  maxCausalDepth: number;
}

export interface RoleDefinition {
  role: AgentRole;
  description: string;
  /** System prompt template; placeholders: {{role}}, {{objective}}, {{protocol}}, {{runGoal}}. */
  systemPrompt: string;
  phase: 'analysis' | 'design' | 'implementation' | 'execution' | 'diagnosis' | 'review' | 'acceptance';
  taskType: string;
  defaultModelPolicy: ModelPolicy;
  toolPolicy: ToolPolicy;
  permissionProfile: 'read_only' | 'analyst' | 'test_author' | 'test_executor' | 'environment_operator' | 'product_fixer';
  workspace: 'shared_readonly' | 'isolated_worktree' | 'scratch';
  dataClassification: DataClassification;
  outputSchema?: JsonSchema;
  subscriptions: RoleSubscription[];
  canDelegateTo: AgentRole[];
  /**
   * Maximum delegation depth of the subtree rooted at an agent of this role: an agent at depth `d` may
   * delegate (to a role in `canDelegateTo`) only while `d < maxDepth`. 0 = cannot delegate.
   */
  maxDepth: number;
  defaultBudget: Partial<WorkBudget>;
}

export interface RoleOverrides {
  /** Per-role partial overrides from configuration (e.g. model policy per role). */
  roles?: Record<string, Partial<Omit<RoleDefinition, 'role'>>>;
  /** Additional custom roles. */
  custom?: RoleDefinition[];
}

export interface RoleCatalogLike {
  get(role: string): RoleDefinition | undefined;
  require(role: string): RoleDefinition;
  list(): RoleDefinition[];
  subscriptions(): Array<RoleSubscription & { role: AgentRole }>;
  revision(): string;
}

// ----------------------------------------------------------------------------- additive (v0.3)

/** Additive: options of validateRoleDefinition / the RoleCatalog constructor. */
export interface RoleValidationOptions {
  /** Extra tool ids (e.g. deployment-specific tools) accepted in allow/deny lists besides KNOWN_TOOL_IDS. */
  extraToolIds?: string[];
  /** Extra event types accepted in subscriptions besides the domain EVENT_TYPES catalog. */
  extraEventTypes?: string[];
  /** When given, canDelegateTo / independentFromRoles must reference these roles. */
  knownRoles?: string[];
}

/** Additive: third constructor parameter of RoleCatalog. */
export type RoleCatalogOptions = Omit<RoleValidationOptions, 'knownRoles'>;

/** Additive: variables of renderRolePrompt. Blank values are replaced by explicit notices. */
export interface RolePromptVars {
  objective: string;
  runGoal: string;
  /** Rendered BUGate PreparedProtocolContext (omitted/blank ⇒ an explicit "no protocol context" notice). */
  protocol?: string;
}

/** Additive: the facts of a domain event a subscription filter is matched against. */
export interface SubscriptionSubject {
  eventType: string;
  severity?: string;
  category?: string;
  status?: string;
  recordType?: string;
  /** Role of the actor that produced the event. */
  actorRole?: string;
}

/**
 * Additive: output of renderSubscriptionWork. Title ≤ 200 and objective ≤ 4000 UTF-16 code units (hence also
 * code points); event values are shortened before the template text is cut; neither contains a live
 * `{{placeholder}}`.
 */
export interface RenderedSubscriptionWork {
  title: string;
  objective: string;
  priority: number;
  budget?: Partial<WorkBudget>;
  expectedOutput?: JsonSchema;
}
