import type { Labels, Metadata } from './common.ts';

/** What is being tested. All fields optional; profiles and agents enrich it. */
export interface TargetRef {
  /** Local path of the repository under test (white-box). */
  repoPath?: string;
  /** Commit under test and optional base for change analysis. */
  commit?: string;
  baseCommit?: string;
  /** Base URL of a running system under test (black-box). */
  sutUrl?: string;
  /** Environment registered with Hypertest (see ExperimentSpec.environment). */
  environmentId?: string;
  description?: string;
  metadata?: Metadata;
}

/** Hard limits for one run. Budgets are resource leases: reserve → execute → settle. */
export interface BudgetEnvelope {
  maxWallClockMs: number;
  maxAgentConcurrency: number;
  maxModelTokens: number;
  maxModelCostUsd?: number;
  maxToolCalls: number;
  maxComputeMinutes?: number;
  maxExternalQps?: number;
  maxArtifactBytes?: number;
  /** Bounded decentralization caps. */
  maxWorkItems: number;
  maxAgentDepth: number;
  maxPlanRevisions: number;
}

export const DEFAULT_BUDGET: BudgetEnvelope = {
  maxWallClockMs: 4 * 60 * 60 * 1000,
  maxAgentConcurrency: 4,
  maxModelTokens: 5_000_000,
  maxToolCalls: 2_000,
  maxWorkItems: 200,
  maxAgentDepth: 3,
  maxPlanRevisions: 12,
};

export type RunStatus = 'created' | 'running' | 'paused' | 'converging' | 'gating' | 'completed' | 'failed' | 'cancelled';
export type PauseReason = 'budget' | 'approval' | 'manual_review' | 'operator' | 'model_unavailable';

export interface ProtocolBindingRef {
  protocolId: string;
  version: string;
  digest: string;
}

export interface TestRun {
  runId: string;
  goal: string;
  target: TargetRef;
  status: RunStatus;
  pauseReason?: PauseReason;
  budget: BudgetEnvelope;
  /** Pinned at creation; never changes for a live run (I11). */
  runtimeManifestId: string;
  policyRevision: string;
  protocolBinding?: ProtocolBindingRef;
  currentPlanRevision: number;
  systemModelRevision?: number;
  /** Active oracle ids → revision used by this run. */
  oracleRevisions: Record<string, number>;
  experimentIds: string[];
  decisionId?: string;
  labels: Labels;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  created: ['running', 'cancelled', 'failed'],
  running: ['paused', 'converging', 'failed', 'cancelled'],
  paused: ['running', 'cancelled', 'failed', 'converging'],
  converging: ['running', 'gating', 'failed', 'cancelled'],
  gating: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}
export function isTerminalRun(s: RunStatus): boolean {
  return RUN_TRANSITIONS[s].length === 0;
}
