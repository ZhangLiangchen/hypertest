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
 *                                      environment, condenser)
 *   class RoleCatalog implements RoleCatalogLike (constructor(roles, overrides?: RoleOverrides))
 *   renderTemplate(template: string, vars: Record<string, string>): string   ({{name}} substitution; unknown ⇒ left empty)
 *   TERMINAL_TOOLS = ['complete_work', 'fail_work'] as const
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
}

export interface RoleSubscription {
  ruleId: string;
  eventTypes: string[];
  filter?: SubscriptionFilter;
  work: {
    /** Templates with {{title}}, {{severity}}, {{recordId}}, {{lineageId}}, {{summary}}, {{component}} from the event/record. */
    title: string;
    objective: string;
    priority: number;
    budget?: Partial<WorkBudget>;
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
