import type { BaseDeps, EventBus, SqlDatabase } from '@hypertest/core';
import type { BudgetEnvelope, GateSpec, QualityDecision, RuntimeManifest } from '@hypertest/domain';
import type { Blackboard, DecisionRepository, EventStore, Inbox, OutboxRelay, RunRepository, SpecRepository } from '@hypertest/collab';
import type { AdapterRegistryLike, BudgetLedger, LeaseService, OperationLedger, Reconciler, ResourceAdmission, SideEffectGateway } from '@hypertest/operation';
import type { ArtifactStore, EvidenceLedger, Signer } from '@hypertest/evidence';
import type { ApprovalService, GateInput, OracleGovernance, PolicyDecisionLog, PolicyEngine, ResolvedProtocol } from '@hypertest/policy';
import type { ModelCatalogLike, ModelRouter } from '@hypertest/model';
import type {
  DurableMemory, FreshnessGuard, ProvenanceService, ResolverRegistry, Retriever, SnapshotBuilder, SnapshotStore, WorkingContextManager,
} from '@hypertest/context';
import type { EnvironmentRegistry, ToolRegistryLike, ToolRuntime, WorkspaceManager } from '@hypertest/tools';
import type { AgentRepository, AgentRunner, EngineRegistryLike, EpochManager, SessionStore, SubagentRuntime, TurnLimits } from '@hypertest/runtime';
import type { RoleCatalogLike } from '@hypertest/agents';

/** Deterministic quality gate port (structurally satisfied by @hypertest/policy QualityGate). */
export interface QualityGateLike {
  evaluate(input: GateInput): QualityDecision;
}

/** Configuration of one control plane instance (one worker process). */
export interface ControlConfig {
  /** HMAC secret of capability tokens (root capabilities are signed with it; children are attenuated + signed). */
  capabilitySecret: string;
  /** The runtime manifest every new run is pinned to (I11); persisted in ht_manifests. */
  runtimeManifest: RuntimeManifest;
  /** Identity of this worker: owner of the run lease and of the work-item leases it grants. */
  workerId: string;
  /** Engine kind used for new agents (e.g. 'native'). */
  defaultEngineKind: string;
  /** Work-item lease TTL (default 60000 ms). */
  leaseTtlMs?: number;
  /** Run lease TTL (default leaseTtlMs). */
  runLeaseTtlMs?: number;
  /** Per-turn engine limits (default { maxToolCallsPerTurn: 16, repetitionThreshold: 4 }). */
  turnLimits?: TurnLimits;
  /** Run budget defaults: DEFAULT_BUDGET ⊕ defaultBudget ⊕ StartRunInput.budget. */
  defaultBudget?: Partial<BudgetEnvelope>;
  /** Gate defaults: DEFAULT_GATE_SPEC ⊕ defaultGate ⊕ StartRunInput.gate. */
  defaultGate?: Partial<GateSpec>;
  /** What a model budget boundary does to the run: leave it to convergence ('gate', default) or pause it. */
  onBudgetExhausted?: 'gate' | 'pause';
  /** Repository used when a run's target names none. */
  targetRepoPath?: string;
  /** Token budget of the L2 working view (default: route context window × 0.6, else 48000). */
  maxInlineContextTokens?: number;
  /** (additive) maxOutputTokens of every model call (default 4096). */
  maxOutputTokens?: number;
  /** (additive) Interval of the lease heartbeat while a turn runs (default max(1000, leaseTtlMs / 3)). */
  heartbeatMs?: number;
  /**
   * (additive) Attempts after which a work item that keeps losing its worker (lease expiry / orphaned by a crash) is
   * failed instead of requeued again (default 5): a poison item never livelocks the run (I12).
   */
  maxWorkAttempts?: number;
}

/**
 * Every already-constructed service the control plane needs (built by @hypertest/app's composition root).
 * Nothing here is constructed by control; control wires the services together and owns only its own tables
 * (controlMigrations).
 */
export interface ControlDeps extends BaseDeps {
  db: SqlDatabase;
  // collaboration plane (collab)
  events: EventStore;
  blackboard: Blackboard;
  runs: RunRepository;
  specs: SpecRepository;
  decisions: DecisionRepository;
  inbox: Inbox;
  bus?: EventBus;
  relay?: OutboxRelay;
  // external world (operation)
  ledger: OperationLedger;
  leases: LeaseService;
  gateway: SideEffectGateway;
  reconciler: Reconciler;
  admission: ResourceAdmission;
  budget: BudgetLedger;
  adapters: AdapterRegistryLike;
  // evidence
  artifacts: ArtifactStore;
  evidence: EvidenceLedger;
  signer?: Signer;
  // governance (policy)
  policy: PolicyEngine;
  decisionLog: PolicyDecisionLog;
  approvals: ApprovalService;
  oracles: OracleGovernance;
  gate: QualityGateLike;
  protocol: ResolvedProtocol;
  // models
  router: ModelRouter;
  /** (additive, optional) The router's catalog: gives the route context window for the working-view budget. */
  catalog?: ModelCatalogLike;
  // context engine
  snapshots: SnapshotStore;
  snapshotBuilder: SnapshotBuilder;
  freshness?: FreshnessGuard;
  resolvers: ResolverRegistry;
  workingContext: WorkingContextManager;
  retrieverFactory: (root: string) => Retriever;
  memory: DurableMemory;
  provenance: ProvenanceService;
  // tools
  toolRuntime: ToolRuntime;
  registry: ToolRegistryLike;
  workspaces: WorkspaceManager;
  environments: EnvironmentRegistry;
  // agent runtime
  sessions: SessionStore;
  agents: AgentRepository;
  epochs: EpochManager;
  engines: EngineRegistryLike;
  subagents: SubagentRuntime;
  runner: AgentRunner;
  roles: RoleCatalogLike;
  config: ControlConfig;
}

/** Resolved configuration with every default applied. */
export interface ResolvedControlConfig extends ControlConfig {
  leaseTtlMs: number;
  runLeaseTtlMs: number;
  turnLimits: TurnLimits;
  onBudgetExhausted: 'gate' | 'pause';
  maxOutputTokens: number;
  heartbeatMs: number;
  maxWorkAttempts: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = Object.freeze({ maxToolCallsPerTurn: 16, repetitionThreshold: 4 }) as TurnLimits;

export function resolveConfig(config: ControlConfig): ResolvedControlConfig {
  const leaseTtlMs = config.leaseTtlMs ?? 60_000;
  return {
    ...config,
    leaseTtlMs,
    runLeaseTtlMs: config.runLeaseTtlMs ?? leaseTtlMs,
    turnLimits: config.turnLimits ?? { ...DEFAULT_TURN_LIMITS },
    onBudgetExhausted: config.onBudgetExhausted ?? 'gate',
    maxOutputTokens: config.maxOutputTokens ?? 4096,
    heartbeatMs: config.heartbeatMs ?? Math.max(1000, Math.floor(leaseTtlMs / 3)),
    maxWorkAttempts: config.maxWorkAttempts ?? 5,
  };
}
