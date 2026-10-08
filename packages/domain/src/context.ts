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
  /**
   * `sourceDigest` (additive, conformance-8): sha256 over the source files of every Hypertest package — a rebuilt
   * Hypertest with changed code at the same version is a different runtime (I11).
   * `gitSha` (runtime BOM): `git rev-parse HEAD` of the Hypertest installation when it is the top level of a git
   * checkout. `imageDigest` (additive, runtime BOM): the OCI image digest (`sha256:<64 hex>`) the installation runs from
   * (`HYPERTEST_IMAGE_DIGEST`).
   */
  hypertest: { version: string; gitSha?: string; sourceDigest?: string; imageDigest?: string };
  /** `adapter` (additive, runtime BOM): the Hypertest package adapting the engine (e.g. @hypertest/runtime-pi) and its version. */
  agentEngines: Array<{ kind: string; version?: string; gitSha?: string; imageDigest?: string; adapter?: { package: string; version: string } }>;
  /** (additive, runtime BOM) The engine new agents run on (`engines.default`). */
  defaultEngine?: string;
  providerAdapters: Array<{ provider: string; package: string; version: string }>;
  modelCatalogRevision: string;
  schemas: { event: string; contextSnapshot: string; tool: string; operation: string; evidence: string };
  policyBundleRevision: string;
  /** (additive, runtime BOM) Revision of the effective role catalog (prompts, tool allowlists, model policies, subscriptions). */
  roleCatalogRevision?: string;
  /** Revision of the tool catalog; built by the runtime from every tool's schemas, effect, risk, timeout and side-effect binding. */
  toolCatalogRevision: string;
  protocol?: { id: string; version: string; digest: string };
  /**
   * (additive, coverage[7]) The eval-derived route quality scores merged into the model catalog (models.scoresFile): the
   * file's sha256, the scored routes and the scores' provenance (suite, revision, eval result digest, method).
   */
  modelScores?: { digest: string; routes: string[]; source?: { suiteId?: string; revision?: string; inputDigest?: string; trials?: number; method?: string } };
  /** (additive, A[6]) Kernel plugins loaded from the configuration (digest-pinned ES modules) and what they may provide. */
  plugins?: Array<{ id: string; version: string; kind: string; digest: string; capabilities: string[] }>;
  createdAt: string;
}

/**
 * Release states of a runtime manifest (the runtime release registry): candidate → shadow → canary → active → retiring →
 * retired. New TestRuns are created only under the active release (or a canary that selects them); a rolled-back release
 * is retired and its live runs are quarantined.
 */
export type RuntimeReleaseState = 'candidate' | 'shadow' | 'canary' | 'active' | 'retiring' | 'retired';

/** (additive) One check of a run migration's compatibility verdict (source manifest → target release). */
export interface RuntimeCompatibilityCheck {
  /** e.g. `target_state`, `target_integrity`, `schema.event`, `engine.pi`, `protocol`. */
  check: string;
  ok: boolean;
  detail: string;
}

/**
 * (additive) A runtime epoch of a TestRun: the explicit, audited migration of a live run from the manifest it was
 * pinned to onto another release (checkpoint → canonical snapshot → operation reconciliation → compatibility check →
 * re-pin → resume). A run never changes runtime otherwise (I11).
 */
export interface RuntimeEpoch {
  epochId: string;
  runId: string;
  /** 1 for the first migration of the run, then 2, 3, … */
  seq: number;
  previousEpochId?: string;
  fromManifestId: string;
  toManifestId: string;
  /** The canonical ContextSnapshot taken at the checkpoint (under the source manifest). */
  snapshotId: string;
  /** What the operation reconciliation found (every operation of the run was settled before the re-pin). */
  reconciliation: { examined: number; verified: string[]; notApplied: string[]; manualReview: string[]; stillPending: string[]; failed: string[] };
  compatibility: RuntimeCompatibilityCheck[];
  /** The run's status before the checkpoint and after the resume. */
  statusBefore: string;
  statusAfter: string;
  migratedBy: string;
  reason: string;
  /**
   * (additive, item 17) Work items that were waiting only on a model pause (`model:<agentId>`) at the checkpoint: they
   * hold no turn in flight, migrate with the run, and their pauses carry over to this epoch.
   */
  carriedModelPauses?: string[];
  createdAt: string;
}
