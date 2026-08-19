export type JsonPrimitive = null | boolean | number | string;
export type Json = JsonPrimitive | Json[] | { [key: string]: Json };

export interface ArtifactRef<K extends string = string> {
  readonly kind: K;
  readonly schema: string;
  readonly uri: string;
  readonly mediaType: string;
  readonly sha256: string;
  readonly sizeBytes?: number;
  readonly sourceRevision?: string;
  readonly metadata?: Readonly<Record<string, Json>>;
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

export interface AdapterIdentity {
  readonly name: string;
  readonly version: string;
}

export interface AdapterResponse<T> {
  readonly schema: "hypertest.adapter-response/v1";
  readonly requestId: string;
  readonly adapter: AdapterIdentity;
  readonly status: AdapterStatus;
  readonly outcome?: T;
  readonly artifacts: readonly ArtifactRef[];
  readonly diagnostics: readonly AdapterDiagnostic[];
  readonly retry?: {
    readonly safe: boolean;
    readonly afterMs?: number;
  };
}

export interface AdapterOperationManifest {
  readonly name: string;
  readonly description: string;
  readonly idempotent: boolean;
  readonly inputSchema?: string;
  readonly outputSchema?: string;
  readonly timeoutMs?: number;
}

export interface AdapterManifest {
  readonly schema: "hypertest.adapter-manifest/v1";
  readonly adapter: AdapterIdentity;
  readonly category:
    | "sut"
    | "test-framework"
    | "coverage"
    | "code-intelligence"
    | "sandbox"
    | "ci"
    | "scm"
    | "knowledge"
    | "gate";
  readonly capabilities: readonly string[];
  readonly operations: readonly AdapterOperationManifest[];
}

export interface JsonSchemaShape {
  readonly type?: string | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchemaShape>>;
  readonly required?: readonly string[];
  readonly enum?: readonly Json[];
  readonly const?: Json;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly items?: JsonSchemaShape;
  readonly additionalProperties?: boolean | JsonSchemaShape;
  readonly default?: Json;
  readonly examples?: readonly Json[];
  readonly oneOf?: readonly JsonSchemaShape[];
  readonly anyOf?: readonly JsonSchemaShape[];
  readonly allOf?: readonly JsonSchemaShape[];
  readonly nullable?: boolean;
  readonly extension?: Json;
}

export type SideEffect =
  | "none"
  | "read"
  | "write"
  | "destructive"
  | "unknown";

export interface SutOperation {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly interactionKind: string;
  readonly inputSchema: JsonSchemaShape;
  readonly observationSchema: JsonSchemaShape;
  readonly effects: SideEffect;
  readonly preconditions: readonly string[];
  readonly oracleHints: readonly Json[];
  readonly tags: readonly string[];
  readonly extensionSchema?: string;
  readonly extension?: Json;
}

export interface SutContract {
  readonly schema: "hypertest.sut-contract/v1";
  readonly id: string;
  readonly title: string;
  readonly sourceRevision: string;
  readonly operations: readonly SutOperation[];
  readonly lifecycleCapabilities: readonly string[];
  readonly provenance: readonly ArtifactRef[];
}

export interface TestOracle {
  readonly kind: string;
  readonly expression: Json;
  readonly rationale: string;
  readonly strength: "weak" | "normal" | "strong";
}

export interface TestStep {
  readonly operationId: string;
  readonly input: Json;
  readonly bind?: string;
}

export interface TestPlanCase {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly operationIds: readonly string[];
  readonly preconditions: readonly string[];
  readonly steps: readonly TestStep[];
  readonly oracles: readonly TestOracle[];
  readonly risk: {
    readonly severity: "low" | "medium" | "high" | "critical";
    readonly dimensions: readonly string[];
  };
  readonly provenance: readonly ArtifactRef[];
  readonly generatedBy: "deterministic" | "model" | "hybrid";
}

export interface TestPlan {
  readonly schema: "hypertest.test-plan/v1";
  readonly sutContractHash: string;
  readonly sourceRevision: string;
  readonly generatedAtEpochMs: number;
  readonly cases: readonly TestPlanCase[];
  readonly uncoveredRisks: readonly string[];
}

export type TestCaseStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "error"
  | "not_run";

export interface TestCaseResult {
  readonly id: string;
  readonly name: string;
  readonly status: TestCaseStatus;
  readonly durationMs?: number;
  readonly message?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly evidence: readonly ArtifactRef[];
  readonly metadata?: Json;
}

export type ExecutionStatus =
  | "passed"
  | "failed"
  | "build_error"
  | "runner_error"
  | "timeout"
  | "infrastructure_error"
  | "cancelled";

export interface TestRun {
  readonly schema: "hypertest.test-run/v1";
  readonly runId: string;
  readonly sourceRevision: string;
  readonly patchHash?: string;
  readonly status: ExecutionStatus;
  readonly command: readonly string[];
  readonly exitCode?: number;
  readonly signal?: string;
  readonly startedAtEpochMs: number;
  readonly finishedAtEpochMs: number;
  readonly cases: readonly TestCaseResult[];
  readonly stdout?: string;
  readonly stderr?: string;
  readonly rawArtifacts: readonly ArtifactRef[];
  readonly coverageArtifacts: readonly ArtifactRef[];
  readonly metadata?: Json;
}

export type CoverageRegionKind =
  | "line"
  | "block"
  | "branch"
  | "condition"
  | "function";

export interface CoverageRegion {
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
  readonly kind: CoverageRegionKind;
  readonly hits: number;
  readonly testIds: readonly string[];
}

export interface CoverageFile {
  readonly uri: string;
  readonly sha256?: string;
  readonly regions: readonly CoverageRegion[];
}

export interface CoverageMap {
  readonly schema: "hypertest.coverage-map/v1";
  readonly sourceRevision: string;
  readonly files: readonly CoverageFile[];
  readonly capabilities: {
    readonly line: boolean;
    readonly block: boolean;
    readonly branch: boolean;
    readonly condition: boolean;
    readonly function: boolean;
    readonly perTest: boolean;
  };
  readonly completeness: "complete" | "partial" | "unknown";
  readonly warnings: readonly string[];
}

export type DiagnosisCategory =
  | "TEST_DEFECT"
  | "FIXTURE_DEFECT"
  | "ADAPTER_CONFIG"
  | "SUT_DEFECT"
  | "CONTRACT_DRIFT"
  | "BUILD"
  | "ENVIRONMENT"
  | "FLAKY"
  | "UNKNOWN";

export interface DiagnosisHypothesis {
  readonly rank: number;
  readonly statement: string;
  readonly evidence: readonly ArtifactRef[];
  readonly falsificationStep?: string;
}

export interface Diagnosis {
  readonly schema: "hypertest.diagnosis/v1";
  readonly category: DiagnosisCategory;
  readonly confidence: number;
  readonly hypotheses: readonly DiagnosisHypothesis[];
  readonly culprit?: {
    readonly files?: readonly string[];
    readonly operations?: readonly string[];
    readonly adapterStage?: string;
  };
  readonly repairAllowed: boolean;
  readonly rationale: string;
}

export interface RepairProposal {
  readonly schema: "hypertest.repair-proposal/v1";
  readonly diagnosisHash: string;
  readonly patch: ArtifactRef<"patch">;
  readonly changedPaths: readonly string[];
  readonly intendedChanges: readonly string[];
  readonly safetyAssertions: readonly string[];
}

export interface RunBudget {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxRepairRounds: number;
  readonly wallClockMs: number;
  readonly tokenBudget: number;
}

export interface RunRequest {
  readonly schema: "hypertest.run-request/v1";
  readonly runId: string;
  readonly profilePath: string;
  readonly workspacePath: string;
  readonly sourceRevision: string;
  readonly mode: "plan" | "execute" | "repair" | "propose";
  readonly budget: RunBudget;
}

export type RunFinalState =
  | "planned"
  | "verified"
  | "completed"
  | "needs_human"
  | "rejected"
  | "failed";

export interface RunSummary {
  readonly schema: "hypertest.run-summary/v1";
  readonly runId: string;
  readonly sourceRevision: string;
  readonly finalState: RunFinalState;
  readonly testPlan?: ArtifactRef<"test-plan">;
  readonly patch?: ArtifactRef<"patch">;
  readonly testRun?: ArtifactRef<"test-run">;
  readonly coverage?: ArtifactRef<"coverage-map">;
  readonly diagnosis?: ArtifactRef<"diagnosis">;
  readonly modelUsage: ArtifactRef<"model-usage">;
  readonly ledger: ArtifactRef<"run-ledger">;
  readonly gateDecisions: readonly ArtifactRef<"gate-decision">[];
  readonly change?: {
    readonly id: string;
    readonly url: string;
  };
  readonly warnings: readonly string[];
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
  describe(ctx: CallContext): Promise<AdapterResponse<AdapterManifest>>;
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
  describe(ctx: CallContext): Promise<AdapterResponse<AdapterManifest>>;
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
  describe(ctx: CallContext): Promise<AdapterResponse<AdapterManifest>>;
  currentContext(ctx: CallContext): Promise<AdapterResponse<Json | null>>;
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
