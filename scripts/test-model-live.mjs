#!/usr/bin/env node

const required = [
  "HYPERTEST_MODEL_PROVIDER",
  "HYPERTEST_MODEL_ID",
  "HYPERTEST_MODEL_BASE_URL",
  "HYPERTEST_MODEL_API_KEY",
];
const missing = required.filter((name) => {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0;
});
if (missing.length > 0) {
  console.log(
    `SKIP live model smoke: missing ${missing.join(", ")}. No provider request was sent.`,
  );
  process.exit(0);
}
if (process.env.HYPERTEST_MODEL_PROVIDER !== "openai-compatible") {
  console.log(
    "SKIP live model smoke: HYPERTEST_MODEL_PROVIDER must be openai-compatible. No provider request was sent.",
  );
  process.exit(0);
}

const [{ resolveModelConfig }, { createTestPlan }, { createOpenAICompatibleRuntime }] =
  await Promise.all([
    import("../dist/src/model-config.js"),
    import("../dist/src/planner.js"),
    import("../dist/src/runtime/pi/openai-compatible.js"),
  ]);

const resolved = resolveModelConfig(
  { provider: "openai-compatible" },
  process.env,
);
if (resolved.provider !== "openai-compatible") {
  throw new Error("Live smoke requires the OpenAI-compatible provider");
}
const config = {
  ...resolved,
  timeoutMs: Math.min(resolved.timeoutMs, 30_000),
  maxRetries: Math.min(resolved.maxRetries, 1),
  maxOutputTokens: Math.min(resolved.maxOutputTokens, 256),
};
const runtime = createOpenAICompatibleRuntime(config);
const contractRef = {
  kind: "sut-contract",
  schema: "hypertest.sut-contract/v1",
  uri: "memory://live-smoke-contract",
  mediaType: "application/json",
  sha256: "0".repeat(64),
  sourceRevision: "live-smoke",
};
const contract = {
  schema: "hypertest.sut-contract/v1",
  id: "live-smoke-contract",
  title: "HyperTest live smoke read-only contract",
  sourceRevision: "live-smoke",
  lifecycleCapabilities: [],
  provenance: [],
  operations: [
    {
      id: "status.read",
      title: "Read status",
      description: "A synthetic read-only operation for provider compatibility validation",
      interactionKind: "synthetic",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      observationSchema: { type: "object" },
      effects: "read",
      preconditions: [],
      oracleHints: [{ status: "available" }],
      tags: ["live-smoke", "read-only"],
    },
  ],
};

let usage;
const plan = await createTestPlan(contract, contractRef, {
  runtime,
  runId: `live-smoke-${Date.now()}`,
  maxCasesPerOperation: 1,
  tokenBudget: 512,
  maxTurns: 3,
  maxToolCalls: 2,
  maxRepeatedToolCalls: 1,
  deadlineEpochMs: Date.now() + 30_000,
  onUsage: (summary) => {
    usage = summary;
  },
});
if (usage === undefined) throw new Error("Live smoke produced no usage ledger");
console.log(
  JSON.stringify(
    {
      provider: config.provider,
      model: config.modelId,
      endpointFingerprint: usage.records[0]?.endpointFingerprint,
      requestIds: usage.records
        .map((record) => record.providerRequestId)
        .filter((value) => value !== undefined),
      providerCalls: usage.providerCalls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      latencyMs: usage.totalLatencyMs,
      retryCount: usage.retryCount,
      stopReasons: usage.records
        .map((record) => record.stopReason)
        .filter((value) => value !== undefined),
      modelGeneratedCases: plan.cases.filter(
        (item) => item.generatedBy === "model",
      ).length,
    },
    null,
    2,
  ),
);
