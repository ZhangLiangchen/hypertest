export type Freshness = { kind: 'immutable' } | { kind: 'exact_version' } | { kind: 'max_age'; milliseconds: number };

/** One resource version the agent observed when the snapshot was taken. */
export interface ReadSetEntry {
  /** Resolver type, e.g. `environment`, `build`, `oracle`, `finding`, `lease`, `file`, `metric_window`. */
  resourceType: string;
  resourceId: string;
  observedVersion: string;
  observedAt: string;
  freshness: Freshness;
}

/**
 * Immutable logical projection of Hypertest's canonical world at one point, shared by every model
 * view (Analyst/Executor/Reviewer projections reference the same snapshotId). It does not claim the
 * external world stayed unchanged: mutating actions re-validate the ReadSet (FreshnessGuard).
 */
export interface ContextSnapshot {
  snapshotId: string;
  runId: string;
  eventSeq: number;
  blackboardRevision: number;
  planRevision: number;
  runtimeManifestId: string;
  modelEpochId?: string;
  systemModelRevision?: number;
  oracleRevisions: Record<string, number>;
  experimentRevisions: Record<string, number>;
  policyRevision: string;
  environment?: { environmentId: string; generation: number; buildDigest?: string };
  evidenceRootHash: string;
  readSet: ReadSetEntry[];
  createdAt: string;
}

export type ModelSwitchReason = 'initial' | 'policy' | 'quality' | 'rate_limit' | 'unavailable' | 'cost' | 'manual';

/** A span of turns served by one model route; switches happen only at safe turn boundaries (I3). */
export interface ModelEpoch {
  epochId: string;
  runId: string;
  agentId: string;
  sessionId: string;
  previousEpochId?: string;
  routeId: string;
  provider: string;
  model: string;
  capabilityProfileRevision: string;
  continuationCompatibilityClass: string;
  contextSnapshotId: string;
  switchReason: ModelSwitchReason;
  startedAtTurn: number;
  startedAt: string;
}

/** Complete runtime bill of materials pinned to a TestRun at creation (I11). */
export interface RuntimeManifest {
  /** SHA-256 of the canonical JSON of the other fields. */
  manifestId: string;
  hypertest: { version: string; gitSha?: string };
  agentEngines: Array<{ kind: string; version?: string; gitSha?: string; imageDigest?: string }>;
  providerAdapters: Array<{ provider: string; package: string; version: string }>;
  modelCatalogRevision: string;
  schemas: { event: string; contextSnapshot: string; tool: string; operation: string; evidence: string };
  policyBundleRevision: string;
  toolCatalogRevision: string;
  protocol?: { id: string; version: string; digest: string };
  createdAt: string;
}

export type RuntimeReleaseState = 'candidate' | 'shadow' | 'canary' | 'active' | 'retiring' | 'retired';
