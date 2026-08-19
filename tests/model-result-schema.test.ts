import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactRef, Json, SutContract } from "../src/contracts.js";
import {
  PlannerModelValidationError,
  createTestPlan,
  plannerAugmentationSchema,
} from "../src/planner.js";
import type { AgentEvent, AgentRunRequest } from "../src/runtime.js";
import {
  FakeAgentRuntime,
  ScriptedAgentRuntime,
} from "../src/runtime.js";
import {
  RuntimeValidationError,
  parseAndValidateModelResult,
} from "../src/runtime/validation.js";

const resultSchema: Json = {
  type: "object",
  additionalProperties: false,
  required: ["cases"],
  properties: {
    cases: { type: "array", maxItems: 2 },
  },
};

function request(runId: string): AgentRunRequest {
  return {
    runId,
    phase: "schema-test",
    prompt: "Return JSON",
    tools: [],
    artifacts: [],
    tokenBudget: 100,
    deadlineEpochMs: Date.now() + 10_000,
    expectedResultSchema: resultSchema,
  };
}

async function events(
  runtime: FakeAgentRuntime | ScriptedAgentRuntime,
  value: AgentRunRequest,
): Promise<AgentEvent[]> {
  const output: AgentEvent[] = [];
  for await (const event of runtime.run(value)) output.push(event);
  return output;
}

function validationError(action: () => unknown): RuntimeValidationError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RuntimeValidationError);
    return error;
  }
  assert.fail("Expected RuntimeValidationError");
}

test("empty and non-JSON model output fail closed without echoing the response", () => {
  assert.equal(validationError(() => parseAndValidateModelResult("   ")).code, "model_output_parse_error");
  const secret = "not-json SECRET-API-KEY-123";
  const error = validationError(() => parseAndValidateModelResult(secret));
  assert.equal(error.code, "model_output_parse_error");
  assert.doesNotMatch(error.message, /SECRET-API-KEY-123/);
});

test("an exact fenced JSON document is accepted", () => {
  assert.deepEqual(
    parseAndValidateModelResult('```json\n{"cases":[]}\n```', resultSchema),
    { cases: [] },
  );
});

test("schema mismatch and additional properties report only a safe JSON Pointer", () => {
  const mismatch = validationError(() =>
    parseAndValidateModelResult('{"cases":"secret-response-value"}', resultSchema),
  );
  assert.equal(mismatch.code, "model_output_schema_error");
  assert.equal(mismatch.validationPath, "/cases");
  assert.doesNotMatch(mismatch.message, /secret-response-value/);

  const additional = validationError(() =>
    parseAndValidateModelResult('{"cases":[],"unexpected":"sensitive"}', resultSchema),
  );
  assert.equal(additional.code, "model_output_schema_error");
  assert.doesNotMatch(additional.message, /sensitive/);
});

test("Fake and Scripted runtimes execute expectedResultSchema", async () => {
  const fake = await events(
    new FakeAgentRuntime({ cases: "wrong" }),
    request("fake-schema"),
  );
  assert.equal(fake[0]?.type, "started");
  assert.deepEqual(fake[1], {
    type: "failed",
    code: "model_output_schema_error",
    message: "Model result does not match the expected schema at /cases: must be array",
    retryable: false,
  });

  const scripted = await events(
    new ScriptedAgentRuntime([{ cases: [], extra: true }]),
    request("scripted-schema"),
  );
  assert.equal(scripted[0]?.type, "started");
  assert.equal(scripted[1]?.type, "failed");
  if (scripted[1]?.type === "failed") {
    assert.equal(scripted[1].code, "model_output_schema_error");
  }
});

const contractRef: ArtifactRef<"sut-contract"> = {
  kind: "sut-contract",
  schema: "hypertest.sut-contract/v1",
  uri: "file:///contract.json",
  mediaType: "application/json",
  sha256: "a".repeat(64),
};

const contract: SutContract = {
  schema: "hypertest.sut-contract/v1",
  id: "contract",
  title: "Contract",
  sourceRevision: "rev",
  operations: [
    {
      id: "read",
      title: "Read",
      interactionKind: "http",
      inputSchema: { type: "object", properties: {} },
      observationSchema: {},
      effects: "read",
      preconditions: ["authenticated"],
      oracleHints: [{ status: 200 }],
      tags: [],
    },
    {
      id: "write",
      title: "Write",
      interactionKind: "http",
      inputSchema: { type: "object", properties: {} },
      observationSchema: {},
      effects: "write",
      preconditions: ["write lease held"],
      oracleHints: [{ persisted: true }],
      tags: [],
    },
    {
      id: "unknown-effect",
      title: "Unknown effect",
      interactionKind: "custom",
      inputSchema: { type: "object", properties: {} },
      observationSchema: {},
      effects: "unknown",
      preconditions: ["operator review available"],
      oracleHints: [],
      tags: [],
    },
  ],
  lifecycleCapabilities: [],
  provenance: [],
};

function modelCase(operationId: string, title = "model case") {
  return {
    title,
    objective: "exercise an operation",
    steps: [{ operationId, input: {} }],
    oracle: { expectedValidity: "valid" },
  };
}

test("planner augmentation schema rejects additional fields", async () => {
  await assert.rejects(
    createTestPlan(contract, contractRef, {
      runtime: new FakeAgentRuntime({
        cases: [{ ...modelCase("read"), extra: "not allowed" }],
      }),
      runId: "planner-additional",
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("model_output_schema_error") &&
      !error.message.includes("not allowed"),
  );
  assert.equal(
    (plannerAugmentationSchema(3) as { properties?: { cases?: { maxItems?: number } } })
      .properties?.cases?.maxItems,
    3,
  );
});

test("one illegal planner case fails the whole augmentation instead of being filtered", async () => {
  await assert.rejects(
    createTestPlan(contract, contractRef, {
      runtime: new FakeAgentRuntime({
        cases: [modelCase("read", "valid"), modelCase("unknown", "invalid")],
      }),
      runId: "planner-semantic",
    }),
    PlannerModelValidationError,
  );
});

test("planner augmentation rejects whitespace fields and an empty oracle", async () => {
  for (const invalid of [
    { ...modelCase("read"), title: "   " },
    { ...modelCase("read"), objective: "\n\t" },
    { ...modelCase("read"), oracle: {} },
  ]) {
    await assert.rejects(
      createTestPlan(contract, contractRef, {
        runtime: new FakeAgentRuntime({ cases: [invalid] }),
        runId: `planner-empty-${JSON.stringify(invalid).length}`,
      }),
      /model_output_schema_error|Planner augmentation case 0 is structurally invalid/,
    );
  }
});

test("a schema-valid and semantically valid model case is deterministically merged", async () => {
  const plan = await createTestPlan(contract, contractRef, {
    runtime: new FakeAgentRuntime({ cases: [modelCase("read")] }),
    runId: "planner-valid",
  });
  const generated = plan.cases.find((item) => item.generatedBy === "model");
  assert.ok(generated);
  assert.deepEqual(generated.preconditions, ["authenticated"]);
  assert.equal(generated.risk.severity, "medium");
  assert.ok(generated.oracles.some((oracle) => oracle.kind === "sut-hint"));
  assert.ok(generated.oracles.some((oracle) => oracle.kind === "interaction-outcome"));
  assert.ok(generated.oracles.some((oracle) => oracle.kind === "model-proposed"));
  assert.ok(plan.cases.some((item) => item.generatedBy === "deterministic"));
});

test("model cases inherit write preconditions, safeguards, and high risk", async () => {
  const plan = await createTestPlan(contract, contractRef, {
    runtime: new FakeAgentRuntime({ cases: [modelCase("write")] }),
    runId: "planner-write-risk",
  });
  const generated = plan.cases.find(
    (item) => item.generatedBy === "model" && item.operationIds.includes("write"),
  );
  assert.ok(generated);
  assert.deepEqual(generated.preconditions, ["write lease held"]);
  assert.equal(generated.risk.severity, "high");
  assert.ok(generated.risk.dimensions.includes("effect:write"));
  assert.ok(generated.oracles.some((oracle) => oracle.kind === "sut-hint"));
});

test("unknown-effect model cases remain high risk without assuming valid input", async () => {
  const plan = await createTestPlan(contract, contractRef, {
    runtime: new FakeAgentRuntime({ cases: [modelCase("unknown-effect")] }),
    runId: "planner-unknown-effect-risk",
  });
  const generated = plan.cases.find(
    (item) =>
      item.generatedBy === "model" &&
      item.operationIds.includes("unknown-effect"),
  );
  assert.ok(generated);
  assert.equal(generated.risk.severity, "high");
  assert.deepEqual(generated.preconditions, ["operator review available"]);
  const interaction = generated.oracles.find(
    (oracle) => oracle.kind === "interaction-outcome",
  );
  assert.match(interaction?.rationale ?? "", /without assuming success/);
  assert.equal(interaction?.strength, "weak");
});
