import type { DataClassification, RiskClass, ToolEffect } from './common.ts';

/**
 * Agent roles. Roles are policy (prompts, tools, model policy, subscriptions), not code paths. The
 * catalog lives in @hypertest/agents; custom roles are allowed via configuration (string).
 */
export type BuiltinRole =
  | 'lead'
  | 'code_change_analyst'
  | 'architecture_analyst'
  | 'historical_bug_analyst'
  | 'test_designer'
  | 'executor'
  | 'rca'
  | 'fixer'
  | 'reviewer'
  | 'metrics_analyst'
  | 'environment'
  | 'condenser';
export type AgentRole = BuiltinRole | (string & {});

export type ModelCapability = 'tool_use' | 'parallel_tool_calls' | 'structured_output' | 'reasoning' | 'vision' | 'long_context' | 'computer_use';

/**
 * Model selection policy. A first-class attribute of AgentSpec/WorkItem (native multi-LLM).
 * Resolution: work item override ⊕ role default ⊕ global default; the router applies it in the
 * order security → capability → role suitability → quality → latency → cost.
 */
export interface ModelPolicy {
  /** Preferred route ids in order (routes are catalog entries: provider + model + settings). */
  preferredRoutes?: string[];
  requiredCapabilities?: ModelCapability[];
  /** Quality floor (0..1) from the catalog's role/task scores; candidates below are rejected. */
  minQuality?: number;
  allowedProviders?: string[];
  prohibitedProviders?: string[];
  /** Highest data classification the agent's context may contain; routes must allow it. */
  privacyClass?: DataClassification;
  /** Reviewer heterogeneity: the chosen provider must differ from providers used by these roles in the run. */
  independentFromRoles?: string[];
  maxCostPerCallUsd?: number;
  latencyBudgetMs?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  temperature?: number;
  /** 'revalidated' permits fallback after full re-validation; 'fail_closed' pauses instead. */
  fallback?: 'revalidated' | 'fail_closed';
}

/** Tool allowlist/denylist. Entries are tool ids or `prefix.*` globs. Effective = role ∩ work item. */
export interface ToolPolicy {
  allow: string[];
  deny?: string[];
}

/**
 * Capability granted to one agent for one work item. Child capability = parent ∩ role ∩ work item ∩
 * environment policy (never amplified). Produced and attenuated by @hypertest/policy.
 */
export interface ActionCapability {
  capabilityId: string;
  runId: string;
  subjectAgentId: string;
  workItemId: string;
  parentCapabilityId?: string;
  /** Tool id patterns (`fs.read`, `git.*`, `*`). */
  tools: string[];
  /** Resource scope patterns, hierarchical with `/`, `*` one segment, `**` any depth (e.g. `workspace/wt_1/**`). */
  resourceScopes: string[];
  allowedEffects: ToolEffect[];
  credentialScopes: string[];
  maxRiskClass: RiskClass;
  /** Environment classes the agent may touch (`local`, `sandbox`, `staging`, ...). */
  environmentClasses: string[];
  expiresAt: string;
  /** HMAC over the canonical capability body (see policy.signCapability). */
  signature?: string;
}

export interface PermissionProfile {
  name: string;
  allowedEffects: ToolEffect[];
  maxRiskClass: RiskClass;
  resourceScopes: string[];
  environmentClasses: string[];
  credentialScopes: string[];
}

export type AgentStatus = 'active' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'disposed';

/** A durable agent identity (survives process restarts). */
export interface AgentInstance {
  agentId: string;
  runId: string;
  role: AgentRole;
  workItemId: string;
  parentAgentId?: string;
  depth: number;
  engineKind: string;
  sessionId: string;
  status: AgentStatus;
  capabilityId: string;
  continuable: boolean;
  background: boolean;
  createdAt: string;
  updatedAt: string;
}
