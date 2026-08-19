import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Check, Errors } from "typebox/value";

const root = resolve(new URL("../", import.meta.url).pathname);
const schemaDir = join(root, "schemas");
const files = (await readdir(schemaDir)).filter((name) => name.endsWith(".schema.json")).sort();
const ids = new Set();
const errors = [];
const schemas = [];

for (const name of files) {
  try {
    const value = JSON.parse(await readFile(join(schemaDir, name), "utf8"));
    if (value.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      errors.push(`${name}: unsupported or missing $schema`);
    }
    if (typeof value.$id !== "string" || value.$id.length === 0) {
      errors.push(`${name}: missing $id`);
    } else if (ids.has(value.$id)) {
      errors.push(`${name}: duplicate $id ${value.$id}`);
    } else {
      ids.add(value.$id);
    }
    schemas.push(value);
  } catch (error) {
    errors.push(`${name}: ${error}`);
  }
}

const schemaContext = Object.fromEntries(
  schemas
    .filter((schema) => typeof schema.$id === "string")
    .map((schema) => [schema.$id, schema]),
);

const artifactRef = (kind, schema) => ({
  kind,
  schema,
  uri: `file:///tmp/${kind}.json`,
  mediaType: "application/json",
  sha256: "a".repeat(64),
});

const validProfile = {
  schema: "hypertest.profile/v1",
  name: "schema-check",
  runtime: {
    provider: "deterministic",
    budgets: {
      maxTurns: 4,
      maxToolCalls: 8,
      maxRepairRounds: 0,
      wallClockMs: 30_000,
      tokenBudget: 2_000,
    },
  },
  sut: { contractSource: "contract.json", sourceKind: "command-contract" },
  adapters: { sut: {}, test: {} },
  gate: { mode: "static-allow" },
  workspace: { allowedWriteGlobs: ["tests/**"], forbiddenGlobs: ["src/**"] },
};

const validModelUsage = {
  schema: "hypertest.model-usage/v1",
  runId: "schema-check",
  providerCalls: 1,
  usageUnavailableCalls: 0,
  inputTokens: 12,
  outputTokens: 5,
  cachedTokens: 2,
  totalTokens: 19,
  retryCount: 0,
  totalLatencyMs: 25,
  estimatedCostUsd: 0,
  records: [
    {
      provider: "openai-compatible",
      model: "schema-check-model-2026-08",
      endpointFingerprint: "b".repeat(64),
      providerRequestId: "request-1",
      inputTokens: 12,
      outputTokens: 5,
      cachedTokens: 2,
      latencyMs: 25,
      retryCount: 0,
      stopReason: "stop",
      usageUnavailable: false,
    },
  ],
};

const ledgerRef = artifactRef("run-ledger", "hypertest.run-ledger/v1");
const modelUsageRef = artifactRef("model-usage", "hypertest.model-usage/v1");
const testPlanRef = artifactRef("test-plan", "hypertest.test-plan/v1");
const gateDecisionRef = artifactRef(
  "gate-decision",
  "hypertest.gate-decision/v1",
);
const validRunLedger = {
  schema: "hypertest.run-ledger/v1",
  runId: "schema-check",
  state: "pre_code_gate",
  repairRounds: 0,
  transitions: [
    { from: "intake", event: "accepted", to: "acquire_evidence", atEpochMs: 1 },
    { from: "acquire_evidence", event: "evidence_ready", to: "analyze", atEpochMs: 2 },
    { from: "analyze", event: "analysis_ready", to: "plan", atEpochMs: 3 },
    { from: "plan", event: "plan_ready", to: "pre_code_gate", atEpochMs: 4 },
  ],
};
const validRunSummary = {
  schema: "hypertest.run-summary/v1",
  runId: "schema-check",
  sourceRevision: "revision-1",
  finalState: "planned",
  testPlan: testPlanRef,
  ledger: ledgerRef,
  modelUsage: modelUsageRef,
  change: { id: "change-1", url: "https://example.test/changes/1" },
  gateDecisions: [gateDecisionRef],
  warnings: [],
};

const { ledger: _missingLedger, ...runSummaryWithoutLedger } = validRunSummary;
const { modelUsage: _missingModelUsage, ...runSummaryWithoutModelUsage } =
  validRunSummary;

const representativeInstances = [
  {
    label: "profile valid instance",
    schemaId: "https://hypertest.dev/schemas/profile.v1.schema.json",
    value: validProfile,
    expected: true,
  },
  {
    label: "profile unknown runtime key",
    schemaId: "https://hypertest.dev/schemas/profile.v1.schema.json",
    value: {
      ...validProfile,
      runtime: { ...validProfile.runtime, unexpectedProviderOption: true },
    },
    expected: false,
  },
  {
    label: "profile invalid nested budget",
    schemaId: "https://hypertest.dev/schemas/profile.v1.schema.json",
    value: {
      ...validProfile,
      runtime: {
        ...validProfile.runtime,
        budgets: { ...validProfile.runtime.budgets, maxTurns: 0 },
      },
    },
    expected: false,
  },
  {
    label: "profile rejects more than two automatic repair rounds",
    schemaId: "https://hypertest.dev/schemas/profile.v1.schema.json",
    value: {
      ...validProfile,
      runtime: {
        ...validProfile.runtime,
        budgets: { ...validProfile.runtime.budgets, maxRepairRounds: 3 },
      },
    },
    expected: false,
  },
  {
    label: "model usage valid instance",
    schemaId: "https://hypertest.dev/schemas/model-usage.v1.schema.json",
    value: validModelUsage,
    expected: true,
  },
  {
    label: "model usage invalid endpoint fingerprint",
    schemaId: "https://hypertest.dev/schemas/model-usage.v1.schema.json",
    value: {
      ...validModelUsage,
      records: [{ ...validModelUsage.records[0], endpointFingerprint: "not-a-digest" }],
    },
    expected: false,
  },
  {
    label: "model usage unavailable record cannot contain tokens",
    schemaId: "https://hypertest.dev/schemas/model-usage.v1.schema.json",
    value: {
      ...validModelUsage,
      records: [
        {
          ...validModelUsage.records[0],
          usageUnavailable: true,
        },
      ],
    },
    expected: false,
  },
  {
    label: "run summary valid typed artifact references and change",
    schemaId: "https://hypertest.dev/schemas/run-summary.v1.schema.json",
    value: validRunSummary,
    expected: true,
  },
  {
    label: "run summary rejects an unknown final state",
    schemaId: "https://hypertest.dev/schemas/run-summary.v1.schema.json",
    value: { ...validRunSummary, finalState: "typo_state" },
    expected: false,
  },
  {
    label: "run summary missing required ledger",
    schemaId: "https://hypertest.dev/schemas/run-summary.v1.schema.json",
    value: runSummaryWithoutLedger,
    expected: false,
  },
  {
    label: "run summary missing required model usage",
    schemaId: "https://hypertest.dev/schemas/run-summary.v1.schema.json",
    value: runSummaryWithoutModelUsage,
    expected: false,
  },
  {
    label: "run summary invalid ledger artifact reference",
    schemaId: "https://hypertest.dev/schemas/run-summary.v1.schema.json",
    value: { ...validRunSummary, ledger: modelUsageRef },
    expected: false,
  },
  {
    label: "run summary invalid modelUsage artifact reference",
    schemaId: "https://hypertest.dev/schemas/run-summary.v1.schema.json",
    value: { ...validRunSummary, modelUsage: ledgerRef },
    expected: false,
  },
  {
    label: "run summary invalid testPlan artifact reference",
    schemaId: "https://hypertest.dev/schemas/run-summary.v1.schema.json",
    value: { ...validRunSummary, testPlan: modelUsageRef },
    expected: false,
  },
  {
    label: "run summary invalid gate decision artifact reference",
    schemaId: "https://hypertest.dev/schemas/run-summary.v1.schema.json",
    value: { ...validRunSummary, gateDecisions: [ledgerRef] },
    expected: false,
  },
  {
    label: "run summary invalid change shape",
    schemaId: "https://hypertest.dev/schemas/run-summary.v1.schema.json",
    value: { ...validRunSummary, change: { id: "change-1" } },
    expected: false,
  },
  {
    label: "run ledger valid checkpoint instance",
    schemaId: "https://hypertest.dev/schemas/run-ledger.v1.schema.json",
    value: validRunLedger,
    expected: true,
  },
  {
    label: "run ledger invalid state",
    schemaId: "https://hypertest.dev/schemas/run-ledger.v1.schema.json",
    value: { ...validRunLedger, state: "typo_state" },
    expected: false,
  },
  {
    label: "run ledger rejects more than two repair rounds",
    schemaId: "https://hypertest.dev/schemas/run-ledger.v1.schema.json",
    value: { ...validRunLedger, repairRounds: 3 },
    expected: false,
  },
];

for (const instance of representativeInstances) {
  const schema = schemaContext[instance.schemaId];
  if (schema === undefined) {
    errors.push(`${instance.label}: missing schema ${instance.schemaId}`);
    continue;
  }
  try {
    const actual = Check(schemaContext, schema, instance.value);
    if (actual !== instance.expected) {
      const detail = actual
        ? "instance was unexpectedly accepted"
        : Errors(schemaContext, schema, instance.value)
          .slice(0, 3)
          .map((error) => `${error.instancePath || "/"}: ${error.message}`)
          .join("; ");
      errors.push(`${instance.label}: ${detail}`);
    }
  } catch (error) {
    errors.push(`${instance.label}: schema evaluation failed: ${error}`);
  }
}

for (const path of [
  "profiles/python-http-pytest.example.json",
  "profiles/go-cli-go-test.example.json",
  "examples/python-http/openapi.json",
  "examples/go-cli/command-contract.json",
]) {
  try {
    JSON.parse(await readFile(join(root, path), "utf8"));
  } catch (error) {
    errors.push(`${path}: ${error}`);
  }
}

if (files.length < 10) errors.push(`expected at least 10 public schemas, found ${files.length}`);
if (errors.length > 0) {
  console.error(`Schema checks failed:\n${errors.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(
    `Schemas: PASS (${files.length} public schemas; ${representativeInstances.length} representative instance assertions)`,
  );
}
