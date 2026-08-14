import type {
  ArtifactRef,
  Diagnosis,
  DiagnosisCategory,
  TestRun,
} from "./contracts.js";

export interface DiagnosisInput {
  readonly run: TestRun;
  readonly runRef: ArtifactRef<"test-run">;
  readonly previousRuns?: readonly TestRun[];
  readonly generatedPaths?: readonly string[];
  readonly operationIds?: readonly string[];
}

export function diagnoseFailure(input: DiagnosisInput): Diagnosis {
  const evidence = [input.runRef] as const;
  const text = collectFailureText(input.run).toLowerCase();
  const generatedPaths = input.generatedPaths ?? [];
  const previousRuns = input.previousRuns ?? [];

  if (input.run.status === "passed") {
    return diagnosis(
      "UNKNOWN",
      1,
      "The run passed; no failure is available to diagnose",
      false,
      evidence,
    );
  }

  if (input.run.status === "cancelled") {
    return diagnosis(
      "ENVIRONMENT",
      0.95,
      "Execution was cancelled before a domain result was established",
      false,
      evidence,
      "execution",
    );
  }

  if (input.run.status === "timeout") {
    return diagnosis(
      "ENVIRONMENT",
      0.85,
      "Execution exceeded its sandbox deadline",
      false,
      evidence,
      "sandbox",
    );
  }

  if (input.run.status === "infrastructure_error") {
    return diagnosis(
      "ENVIRONMENT",
      0.9,
      "The execution environment failed before a reliable test result was produced",
      false,
      evidence,
      "sandbox",
    );
  }

  if (input.run.status === "build_error") {
    const generated = generatedPaths.some((path) => text.includes(path.toLowerCase()));
    return diagnosis(
      "BUILD",
      generated ? 0.92 : 0.72,
      generated
        ? "The generated test change caused a build or load failure"
        : "The workspace failed to build; ownership of the failure requires review",
      generated,
      evidence,
      "build",
      generatedPaths,
    );
  }

  if (looksFlaky(input.run, previousRuns)) {
    return diagnosis(
      "FLAKY",
      0.82,
      "Equivalent executions produced inconsistent outcomes",
      false,
      evidence,
      "execution",
    );
  }

  if (matchesAny(text, [
    "connection refused",
    "host not found",
    "temporary failure",
    "permission denied",
    "no space left",
    "out of memory",
    "resource unavailable",
    "service unavailable",
  ])) {
    return diagnosis(
      "ENVIRONMENT",
      0.86,
      "Failure evidence points to an unavailable or unhealthy execution environment",
      false,
      evidence,
      "environment",
    );
  }

  if (matchesAny(text, [
    "unknown field",
    "unexpected field",
    "schema mismatch",
    "contract mismatch",
    "operation not found",
    "unsupported version",
  ])) {
    return diagnosis(
      "CONTRACT_DRIFT",
      0.84,
      "Observed behavior or structure no longer matches the imported contract",
      false,
      evidence,
      "contract",
      undefined,
      input.operationIds,
    );
  }

  if (input.run.status === "runner_error") {
    if (matchesAny(text, ["invalid option", "unknown argument", "configuration", "cannot parse result"])) {
      return diagnosis(
        "ADAPTER_CONFIG",
        0.8,
        "The runner command or result parser configuration is invalid",
        true,
        evidence,
        "test-framework-adapter",
      );
    }
    return diagnosis(
      "ENVIRONMENT",
      0.65,
      "The test runner failed internally before producing reliable case outcomes",
      false,
      evidence,
      "test-framework-adapter",
    );
  }

  if (matchesAny(text, ["fixture", "seed data", "test data", "setup failed", "cleanup failed"])) {
    return diagnosis(
      "FIXTURE_DEFECT",
      0.76,
      "Failure evidence implicates test setup, seed data, or cleanup rather than the SUT behavior",
      true,
      evidence,
      "test-fixture",
    );
  }

  const generatedPath = generatedPaths.find((path) => text.includes(path.toLowerCase()));
  if (
    generatedPath !== undefined &&
    matchesAny(text, ["syntax", "type error", "name error", "undefined", "cannot import", "cannot load"])
  ) {
    return diagnosis(
      "TEST_DEFECT",
      0.88,
      "The failure originates in generated test implementation code",
      true,
      evidence,
      "generated-test",
      [generatedPath],
    );
  }

  if (
    input.run.cases.some((item) => item.status === "failed") &&
    input.operationIds !== undefined &&
    input.operationIds.length > 0
  ) {
    return diagnosis(
      "SUT_DEFECT",
      0.68,
      "The test reached an assertion and the observed SUT outcome violated the planned oracle",
      false,
      evidence,
      "sut-observation",
      undefined,
      input.operationIds,
    );
  }

  return diagnosis(
    "UNKNOWN",
    0.35,
    "Available evidence is insufficient to distinguish test, environment, contract, and SUT causes",
    false,
    evidence,
  );
}

function diagnosis(
  category: DiagnosisCategory,
  confidence: number,
  rationale: string,
  repairAllowed: boolean,
  evidence: readonly ArtifactRef[],
  adapterStage?: string,
  files?: readonly string[],
  operations?: readonly string[],
): Diagnosis {
  return {
    schema: "hypertest.diagnosis/v1",
    category,
    confidence,
    hypotheses: [
      {
        rank: 1,
        statement: rationale,
        evidence,
        falsificationStep: falsificationStep(category),
      },
    ],
    ...(
      adapterStage === undefined && files === undefined && operations === undefined
        ? {}
        : {
            culprit: {
              ...(adapterStage === undefined ? {} : { adapterStage }),
              ...(files === undefined ? {} : { files }),
              ...(operations === undefined ? {} : { operations }),
            },
          }
    ),
    repairAllowed,
    rationale,
  };
}

function falsificationStep(category: DiagnosisCategory): string {
  switch (category) {
    case "TEST_DEFECT":
    case "BUILD":
      return "Revert only the generated patch and verify that the baseline workspace loads successfully";
    case "FIXTURE_DEFECT":
      return "Run the same test against a clean, independently seeded environment";
    case "ADAPTER_CONFIG":
      return "Execute the recorded runner command directly with the same inputs";
    case "SUT_DEFECT":
      return "Replay the recorded operation outside the generated test and compare the observation with the contract oracle";
    case "CONTRACT_DRIFT":
      return "Re-import the authoritative interface definition at the tested revision";
    case "ENVIRONMENT":
      return "Repeat a health-only probe in a fresh sandbox without applying the generated patch";
    case "FLAKY":
      return "Repeat the identical revision, environment, seed, and selector several times";
    case "UNKNOWN":
      return "Collect a smaller reproducible run with structured runner and SUT evidence";
  }
}

function collectFailureText(run: TestRun): string {
  return [
    run.stderr ?? "",
    run.stdout ?? "",
    ...run.cases.flatMap((item) => [item.message ?? "", item.stderr ?? "", item.stdout ?? ""]),
  ].join("\n");
}

function looksFlaky(run: TestRun, history: readonly TestRun[]): boolean {
  if (history.length === 0) return false;
  const current = caseSignature(run);
  return history.some(
    (item) => item.sourceRevision === run.sourceRevision && caseSignature(item) !== current,
  );
}

function caseSignature(run: TestRun): string {
  return JSON.stringify(
    run.cases.map((item) => [item.id, item.status]).sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

function matchesAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
