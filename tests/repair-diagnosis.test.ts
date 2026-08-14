import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactRef, TestRun } from "../src/contracts.js";
import { diagnoseFailure } from "../src/diagnosis.js";
import { matchesGlob, validateRepairPatch } from "../src/repair.js";

const runRef: ArtifactRef<"test-run"> = {
  kind: "test-run",
  schema: "hypertest.test-run/v1",
  uri: "file:///run",
  mediaType: "application/json",
  sha256: "c".repeat(64),
};

function run(overrides: Partial<TestRun> = {}): TestRun {
  return {
    schema: "hypertest.test-run/v1",
    runId: "r",
    sourceRevision: "rev",
    status: "build_error",
    command: ["runner"],
    exitCode: 1,
    startedAtEpochMs: 1,
    finishedAtEpochMs: 2,
    cases: [],
    stderr: "tests/generated.py: syntax error",
    rawArtifacts: [],
    coverageArtifacts: [],
    ...overrides,
  };
}

test("diagnoses generated build failures as repairable", () => {
  const diagnosis = diagnoseFailure({
    run: run(),
    runRef,
    generatedPaths: ["tests/generated.py"],
  });
  assert.equal(diagnosis.category, "BUILD");
  assert.equal(diagnosis.repairAllowed, true);
});

test("repair policy rejects weakened tests and forbidden paths", () => {
  const diagnosis = diagnoseFailure({ run: run(), runRef, generatedPaths: ["tests/generated.py"] });
  const patch = `diff --git a/tests/generated.py b/tests/generated.py\n--- a/tests/generated.py\n+++ b/tests/generated.py\n@@ -1 +1 @@\n-assert result == 1\n+skip(\"broken\")\n`;
  const report = validateRepairPatch(diagnosis, patch, {
    allowedWriteGlobs: ["tests/**"],
    forbiddenGlobs: ["src/**"],
    maxChangedFiles: 2,
    maxAddedLines: 10,
  });
  assert.equal(report.safe, false);
  assert.ok(report.violations.some((item) => item.includes("skip")));
  assert.equal(matchesGlob("tests/a/b.py", "tests/**"), true);
});
