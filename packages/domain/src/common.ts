import type { JsonValue } from '@hypertest/core';

/** Priority/severity scale. P0 is most severe. */
export type Severity = 'P0' | 'P1' | 'P2' | 'P3';
export const SEVERITY_ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
/** True when `a` is at least as severe as `b`. */
export function atLeastAsSevere(a: Severity, b: Severity): boolean {
  return SEVERITY_ORDER[a] <= SEVERITY_ORDER[b];
}

export type RiskClass = 'low' | 'medium' | 'high' | 'critical';
export const RISK_ORDER: Record<RiskClass, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export function riskAtMost(a: RiskClass, max: RiskClass): boolean {
  return RISK_ORDER[a] <= RISK_ORDER[max];
}

/** Data classification governs which model routes may see data (security-first routing). */
export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted';
export const CLASSIFICATION_ORDER: Record<DataClassification, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };

/**
 * What a tool does to the world. Ordered by blast radius:
 * read < record (blackboard/evidence writes) < write_workspace (isolated files) < execute (sandboxed
 * processes) < external (reconcilable effects on systems outside the sandbox) < destructive.
 */
export type ToolEffect = 'read' | 'record' | 'write_workspace' | 'execute' | 'external' | 'destructive';
export const EFFECT_ORDER: Record<ToolEffect, number> = { read: 0, record: 1, write_workspace: 2, execute: 3, external: 4, destructive: 5 };

/** Actor performing an action: an agent, a human, or a deterministic Hypertest service. */
export type ActorKind = 'agent' | 'human' | 'system';
export interface ActorRef {
  kind: ActorKind;
  id: string;
  /** For agents: the role and the model provider that produced the action (heterogeneity checks). */
  role?: string;
  modelProvider?: string;
}

/** Typed reference to any Hypertest object. */
export type RefKind =
  | 'run'
  | 'record'
  | 'evidence'
  | 'artifact'
  | 'work_item'
  | 'plan'
  | 'file'
  | 'commit'
  | 'url'
  | 'oracle'
  | 'experiment'
  | 'test_artifact'
  | 'system_model'
  | 'operation'
  | 'decision';
export interface Ref {
  kind: RefKind;
  id: string;
  note?: string;
}

export type Labels = Record<string, string>;
export type Metadata = Record<string, JsonValue>;

/** Every revisioned domain contract is immutable; a change creates a new revision that supersedes the old. */
export interface Revisioned {
  revision: number;
  supersedes?: number;
  createdAt: string;
}
