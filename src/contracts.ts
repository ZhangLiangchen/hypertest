export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export interface ArtifactRef<K extends string = string> {
  readonly kind: K;
  readonly schema: string;
  readonly uri: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly sizeBytes?: number;
}

export interface CallContext {
  readonly runId: string;
  readonly requestId: string;
  readonly workspace: ArtifactRef<"workspace">;
  readonly sourceRevision: string;
  readonly deadlineEpochMs: number;
  readonly attempt: number;
}

export type AdapterStatus =
  | "ok"
  | "unsupported"
  | "transient_error"
  | "permanent_error"
  | "cancelled";

export interface AdapterDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly detail?: Json;
}

export interface AdapterResponse<T> {
  readonly schema: "hypertest.adapter-response/v1";
  readonly requestId: string;
  readonly adapter: {
    readonly name: string;
    readonly version: string;
  };
  readonly status: AdapterStatus;
  readonly outcome?: T;
  readonly artifacts: readonly ArtifactRef[];
  readonly diagnostics: readonly AdapterDiagnostic[];
  readonly retry?: {
    readonly safe: boolean;
    readonly afterMs?: number;
  };
}

export interface SutLease {
  readonly leaseId: string;
  readonly expiresAtEpochMs?: number;
  readonly metadata?: Json;
}

export interface SutObservation {
  readonly operationId: string;
  readonly observedAtEpochMs: number;
  readonly value: Json;
  readonly evidence: readonly ArtifactRef[];
}

export interface SutAdapter {
  describe(ctx: CallContext): Promise<AdapterResponse<Json>>;
  importContract(
    ctx: CallContext,
    request: {
      readonly source: ArtifactRef<"raw-sut-contract">;
      readonly sourceKind: string;
    },
  ): Promise<AdapterResponse<ArtifactRef<"sut-contract">>>;
  acquire(
    ctx: CallContext,
    request: {
      readonly mode: string;
      readonly revision?: string;
      readonly configuration?: ArtifactRef<"sut-config">;
    },
  ): Promise<AdapterResponse<SutLease>>;
  reset(
    ctx: CallContext,
    request: {
      readonly lease: SutLease;
      readonly strategy: string;
      readonly seed?: ArtifactRef<"seed-data">;
    },
  ): Promise<AdapterResponse<Json>>;
  probe(
    ctx: CallContext,
    request: {
      readonly lease: SutLease;
      readonly operationId: string;
      readonly input: Json;
    },
  ): Promise<AdapterResponse<SutObservation>>;
  release(
    ctx: CallContext,
    request: { readonly lease: SutLease },
  ): Promise<AdapterResponse<{ readonly released: boolean }>>;
}

export interface TestFrameworkAdapter {
  describe(ctx: CallContext): Promise<AdapterResponse<Json>>;
  discover(
    ctx: CallContext,
    request: { readonly workspace: ArtifactRef<"workspace"> },
  ): Promise<AdapterResponse<ArtifactRef<"test-inventory">>>;
  render(
    ctx: CallContext,
    request: {
      readonly plan: ArtifactRef<"test-plan">;
      readonly inventory: ArtifactRef<"test-inventory">;
      readonly frameworkGuide?: ArtifactRef<"framework-guide">;
    },
  ): Promise<AdapterResponse<ArtifactRef<"patch">>>;
  validate(
    ctx: CallContext,
    request: { readonly patch: ArtifactRef<"patch"> },
  ): Promise<AdapterResponse<ArtifactRef<"validation-report">>>;
  run(
    ctx: CallContext,
    request: {
      readonly patch?: ArtifactRef<"patch">;
      readonly selector?: Json;
      readonly environment: ArtifactRef<"test-environment">;
      readonly collectCoverage: boolean;
    },
  ): Promise<AdapterResponse<ArtifactRef<"test-run">>>;
  normalizeCoverage(
    ctx: CallContext,
    request: {
      readonly rawCoverage: readonly ArtifactRef[];
      readonly sourceSnapshot: ArtifactRef<"source-snapshot">;
    },
  ): Promise<AdapterResponse<ArtifactRef<"coverage-map">>>;
}

export interface CiAdapter {
  describe(ctx: CallContext): Promise<AdapterResponse<Json>>;
  submit(
    ctx: CallContext,
    request: {
      readonly revision: string;
      readonly profile: ArtifactRef<"hypertest-profile">;
      readonly inputs?: Json;
    },
  ): Promise<AdapterResponse<{ readonly runId: string }>>;
  get(
    ctx: CallContext,
    request: { readonly runId: string },
  ): Promise<AdapterResponse<Json>>;
  cancel(
    ctx: CallContext,
    request: { readonly runId: string },
  ): Promise<AdapterResponse<{ readonly cancelled: boolean }>>;
  fetchArtifacts(
    ctx: CallContext,
    request: {
      readonly runId: string;
      readonly selectors: readonly string[];
    },
  ): Promise<AdapterResponse<readonly ArtifactRef[]>>;
}

export interface ChangePublisherAdapter {
  publishDraft(
    ctx: CallContext,
    request: {
      readonly baseRevision: string;
      readonly patch: ArtifactRef<"patch">;
      readonly gateDecision: ArtifactRef<"gate-decision">;
      readonly proposal: ArtifactRef<"change-proposal">;
      readonly idempotencyKey: string;
    },
  ): Promise<
    AdapterResponse<{
      readonly changeId: string;
      readonly url: string;
      readonly branch: string;
      readonly created: boolean;
    }>
  >;
}
