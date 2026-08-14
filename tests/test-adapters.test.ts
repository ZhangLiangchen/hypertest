import assert from "node:assert/strict";
import test from "node:test";

import type { SutContract, TestPlan } from "../src/contracts.js";
import { parseGoTestJson, renderGoCommandTests } from "../src/adapters/test/go-test.js";
import { parsePytestJunit, renderPytestHttp } from "../src/adapters/test/pytest.js";

const plan: TestPlan = {
  schema: "hypertest.test-plan/v1",
  sutContractHash: "a".repeat(64),
  sourceRevision: "rev",
  generatedAtEpochMs: 1,
  cases: [
    {
      id: "HT-GREET-1",
      title: "greet",
      objective: "greet safely",
      operationIds: ["greet"],
      preconditions: [],
      steps: [{ operationId: "greet", input: { "path.name": "Ada", name: "Ada" } }],
      oracles: [{ kind: "interaction-outcome", expression: { expectedValidity: "valid" }, rationale: "valid", strength: "normal" }],
      risk: { severity: "medium", dimensions: ["success"] },
      provenance: [],
      generatedBy: "deterministic",
    },
  ],
  uncoveredRisks: [],
};

test("renders framework source only inside framework adapters", () => {
  const http: SutContract = {
    schema: "hypertest.sut-contract/v1",
    id: "http",
    title: "http",
    sourceRevision: "rev",
    operations: [{
      id: "greet",
      interactionKind: "http",
      inputSchema: {},
      observationSchema: {},
      effects: "read",
      preconditions: [],
      oracleHints: [],
      tags: [],
      extensionSchema: "hypertest.http-operation/v1",
      extension: { method: "GET", path: "/greet/{name}", expectedStatuses: ["200"] },
    }],
    lifecycleCapabilities: [],
    provenance: [],
  };
  const python = renderPytestHttp(plan, http);
  assert.match(python.patch, /urllib\.request/);

  const command: SutContract = {
    ...http,
    id: "command",
    operations: [{
      ...http.operations[0]!,
      interactionKind: "command",
      extensionSchema: "hypertest.command-operation/v1",
      extension: { argv: ["echo", "{name}"], expectedExitCodes: [0] },
    }],
  };
  const go = renderGoCommandTests(plan, command);
  assert.match(go.patch, /exec\.Command/);
});

test("normalizes runner-specific result streams", () => {
  const py = parsePytestJunit(
    '<testsuite><testcase classname="x" name="ok" time="0.1"/><testcase classname="x" name="bad"><failure>no</failure></testcase></testsuite>',
    { runId: "r", sourceRevision: "rev", command: ["runner"], exitCode: 1, startedAtEpochMs: 1, finishedAtEpochMs: 2 },
  );
  assert.equal(py.status, "failed");
  const go = parseGoTestJson(
    [
      JSON.stringify({ Action: "run", Package: "p", Test: "TestOK" }),
      JSON.stringify({ Action: "pass", Package: "p", Test: "TestOK", Elapsed: 0.1 }),
      JSON.stringify({ Action: "pass", Package: "p" }),
    ].join("\n"),
    { runId: "r", sourceRevision: "rev", command: ["runner"], exitCode: 0, startedAtEpochMs: 1, finishedAtEpochMs: 2 },
  );
  assert.equal(go.cases[0]?.status, "passed");
});
