import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HyperTestOrchestrator } from "../src/orchestrator.js";
import type { RunRequest } from "../src/contracts.js";
import type { AgentEvent, AgentRuntime } from "../src/runtime.js";

const adapterCli = new URL("../src/adapter-cli.js", import.meta.url).pathname;

test("orchestrator completes a cross-process plan and execute flow", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-orchestrator-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "cmd", "tool"), { recursive: true });
  const contractPath = join(root, "contract.json");
  await writeFile(
    contractPath,
    JSON.stringify({
      title: "Echo CLI",
      operations: [
        {
          id: "echo",
          argv: [process.execPath, "-e", "process.exit(0)"],
          inputSchema: { type: "object", properties: {} },
          expectedExitCodes: [0],
          effects: "none",
        },
      ],
    }),
  );

  const eventScript = [
    `console.log(JSON.stringify({Action:'run',Package:'p',Test:'TestGenerated'}));`,
    `console.log(JSON.stringify({Action:'pass',Package:'p',Test:'TestGenerated',Elapsed:0.01}));`,
    `console.log(JSON.stringify({Action:'pass',Package:'p'}));`,
  ].join("");
  const profilePath = join(root, "profile.json");
  await writeFile(
    profilePath,
    JSON.stringify({
      schema: "hypertest.profile/v1",
      name: "e2e",
      runtime: {
        provider: "deterministic",
        budgets: {
          maxTurns: 10,
          maxToolCalls: 20,
          maxRepairRounds: 1,
          wallClockMs: 120000,
          tokenBudget: 1000,
        },
      },
      sut: { contractSource: contractPath, sourceKind: "command-contract" },
      adapters: {
        sut: {
          command: process.execPath,
          args: [adapterCli, "--adapter", "sut-command"],
        },
        test: {
          command: process.execPath,
          args: [adapterCli, "--adapter", "test-go"],
          config: {
            outputPath: "hypertest_generated_test.go",
            packageName: "hyperfixture_test",
            command: [process.execPath, "-e", eventScript],
          },
        },
      },
      gate: { mode: "static-allow" },
      workspace: {
        allowedWriteGlobs: ["**/*_test.go"],
        forbiddenGlobs: ["src/**"],
      },
    }),
  );

  const request: RunRequest = {
    schema: "hypertest.run-request/v1",
    runId: "orchestrator-e2e",
    profilePath,
    workspacePath: root,
    sourceRevision: "rev",
    mode: "execute",
    budget: {
      maxTurns: 10,
      maxToolCalls: 20,
      maxRepairRounds: 1,
      wallClockMs: 120000,
      tokenBudget: 1000,
    },
  };
  const orchestrator = new HyperTestOrchestrator({ artifactRoot: join(root, ".testagent") });
  const summary = await orchestrator.run(request);
  assert.equal(summary.finalState, "verified");
  assert.equal(summary.testRun?.kind, "test-run");
  assert.equal(summary.patch?.kind, "patch");
  assert.equal(summary.gateDecisions.length, 2);

  const usageText = await readFile(
    join(
      root,
      ".testagent",
      "runs",
      request.runId,
      "artifacts",
      "model-usage.json",
    ),
    "utf8",
  );
  const usage = JSON.parse(usageText) as {
    readonly providerCalls: number;
    readonly usageUnavailableCalls: number;
    readonly totalTokens: number;
  };
  assert.deepEqual(usage, {
    ...usage,
    providerCalls: 0,
    usageUnavailableCalls: 0,
    totalTokens: 0,
  });
  assert.match(summary.warnings.join("\n"), /model-usage=.*model-usage\.json/);
  assert.match(summary.modelUsage.uri, /model-usage\.json$/);
  assert.match(summary.ledger.uri, /run-ledger\.json$/);
  const verifiedLedger = JSON.parse(
    await readFile(
      join(
        root,
        ".testagent",
        "runs",
        request.runId,
        "artifacts",
        "run-ledger.json",
      ),
      "utf8",
    ),
  ) as { readonly state: string };
  assert.equal(verifiedLedger.state, "publish_gate");

  const gateScript = join(root, "gate.mjs");
  await writeFile(
    gateScript,
    `import { createHash } from "node:crypto";
let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const request = JSON.parse(input);
const sort = (value) => Array.isArray(value)
  ? value.map(sort)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]))
    : value;
const verdict = request.action === "enter_implementation" ? "allow" : "deny";
process.stdout.write(JSON.stringify({
  schema: "hypertest.gate-decision/v1",
  requestId: request.requestId,
  requestHash: createHash("sha256").update(JSON.stringify(sort(request))).digest("hex"),
  verdict,
  receiptId: "test-receipt-" + request.action,
  reasonCodes: verdict === "deny" ? ["TEST_DENIAL"] : [],
  obligations: [],
  evidenceHashes: request.evidence.map((item) => item.sha256),
}));
`,
  );
  const deniedProfile = JSON.parse(await readFile(profilePath, "utf8")) as Record<
    string,
    unknown
  >;
  deniedProfile.gate = {
    mode: "process",
    process: { command: process.execPath, args: [gateScript] },
  };
  await writeFile(profilePath, JSON.stringify(deniedProfile));
  const deniedRequest = { ...request, runId: "orchestrator-apply-denied" };
  const deniedSummary = await new HyperTestOrchestrator({
    artifactRoot: join(root, ".testagent"),
  }).run(deniedRequest);
  assert.equal(deniedSummary.finalState, "rejected");
  const deniedLedger = JSON.parse(
    await readFile(
      join(
        root,
        ".testagent",
        "runs",
        deniedRequest.runId,
        "artifacts",
        "run-ledger.json",
      ),
      "utf8",
    ),
  ) as {
    readonly transitions: ReadonlyArray<{
      readonly from: string;
      readonly event: string;
      readonly to: string;
      readonly atEpochMs: number;
    }>;
  };
  const deniedTransition = deniedLedger.transitions.at(-1);
  assert.equal(deniedTransition?.from, "execute");
  assert.equal(deniedTransition?.event, "denied");
  assert.equal(deniedTransition?.to, "rejected");
});

test("orchestrator persists usage evidence before a failed model run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-model-failure-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const contractPath = join(root, "contract.json");
  await writeFile(
    contractPath,
    JSON.stringify({
      title: "Failure fixture",
      operations: [
        {
          id: "read",
          argv: [process.execPath, "-e", "process.exit(0)"],
          inputSchema: { type: "object", properties: {} },
          expectedExitCodes: [0],
          effects: "read",
        },
      ],
    }),
  );
  const profilePath = join(root, "profile.json");
  await writeFile(
    profilePath,
    JSON.stringify({
      schema: "hypertest.profile/v1",
      name: "model-failure",
      runtime: {
        provider: "openai-compatible",
        budgets: {
          maxTurns: 2,
          maxToolCalls: 2,
          maxRepairRounds: 0,
          wallClockMs: 120_000,
          tokenBudget: 100,
        },
      },
      sut: { contractSource: contractPath, sourceKind: "command-contract" },
      adapters: {
        sut: {
          command: process.execPath,
          args: [adapterCli, "--adapter", "sut-command"],
        },
        test: {
          command: process.execPath,
          args: [adapterCli, "--adapter", "test-go"],
        },
      },
      gate: { mode: "static-allow" },
      workspace: {
        allowedWriteGlobs: ["**/*_test.go"],
        forbiddenGlobs: ["src/**"],
      },
    }),
  );

  const runtime: AgentRuntime = {
    async *run(request): AsyncIterable<AgentEvent> {
      yield { type: "started", runId: request.runId };
      yield {
        type: "usage",
        usage: {
          provider: "openai-compatible",
          model: "failure-model",
          endpointFingerprint: "a".repeat(64),
          providerRequestId: "failed-request-1",
          inputTokens: 7,
          outputTokens: 3,
          cachedTokens: 2,
          latencyMs: 11,
          retryCount: 0,
          usageUnavailable: false,
        },
      };
      yield {
        type: "failed",
        code: "provider_error",
        message: "Provider unavailable",
        retryable: false,
        providerRequestId: "failed-request-1",
      };
    },
    async cancel(): Promise<void> {},
  };
  const request: RunRequest = {
    schema: "hypertest.run-request/v1",
    runId: "orchestrator-model-failure",
    profilePath,
    workspacePath: root,
    sourceRevision: "rev-failure",
    mode: "plan",
    budget: {
      maxTurns: 2,
      maxToolCalls: 2,
      maxRepairRounds: 0,
      wallClockMs: 120_000,
      tokenBudget: 100,
    },
  };
  const artifactRoot = join(root, ".testagent");
  const summary = await new HyperTestOrchestrator({
    artifactRoot,
    runtime,
    runtimeProvider: "openai-compatible",
  }).run(request);

  assert.equal(summary.finalState, "failed");
  assert.match(summary.modelUsage.uri, /model-usage\.json$/);
  assert.match(summary.ledger.uri, /run-ledger\.json$/);
  const usageText = await readFile(
    join(
      artifactRoot,
      "runs",
      request.runId,
      "artifacts",
      "model-usage.json",
    ),
    "utf8",
  );
  const usage = JSON.parse(usageText) as {
    readonly providerCalls: number;
    readonly totalTokens: number;
    readonly records: ReadonlyArray<{ readonly providerRequestId?: string }>;
  };
  assert.equal(usage.providerCalls, 1);
  assert.equal(usage.totalTokens, 12);
  assert.equal(usage.records[0]?.providerRequestId, "failed-request-1");

  const events = (await readFile(
    join(artifactRoot, "runs", request.runId, "events.ndjson"),
    "utf8",
  ))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          readonly event: string;
          readonly state: string;
          readonly detail?: { readonly event?: string };
        },
    );
  const usageIndex = events.findIndex((event) => event.event === "model_usage_recorded");
  const fatalIndex = events.findIndex(
    (event) =>
      event.event === "transition" && event.detail?.event === "fatal_error",
  );
  const failedIndex = events.findIndex((event) => event.event === "run_failed");
  assert.ok(usageIndex >= 0);
  assert.ok(fatalIndex > usageIndex);
  assert.ok(failedIndex > fatalIndex);
  assert.equal(events[failedIndex]?.state, "failed");
});

test("orchestrator shares the hard token budget with model repair", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-repair-budget-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const contractPath = join(root, "openapi.json");
  await writeFile(
    contractPath,
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Repair budget fixture", version: "1" },
      paths: {
        "/items/{id}": {
          get: {
            operationId: "read-item",
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    }),
  );
  const profilePath = join(root, "profile.json");
  await writeFile(
    profilePath,
    JSON.stringify({
      schema: "hypertest.profile/v1",
      name: "repair-budget",
      runtime: {
        provider: "openai-compatible",
        budgets: {
          maxTurns: 2,
          maxToolCalls: 2,
          maxRepairRounds: 1,
          wallClockMs: 120_000,
          tokenBudget: 100,
        },
      },
      sut: { contractSource: contractPath, sourceKind: "openapi" },
      adapters: {
        sut: {
          command: process.execPath,
          args: [adapterCli, "--adapter", "sut-http-openapi"],
        },
        test: {
          command: process.execPath,
          args: [adapterCli, "--adapter", "test-pytest"],
          config: {
            command: [
              process.execPath,
              "-e",
              "console.error('configuration error'); process.exit(2)",
            ],
          },
        },
      },
      gate: { mode: "static-allow" },
      workspace: {
        allowedWriteGlobs: ["tests/**"],
        forbiddenGlobs: ["src/**"],
      },
    }),
  );

  let runtimeCalls = 0;
  const runtime: AgentRuntime = {
    async *run(request): AsyncIterable<AgentEvent> {
      runtimeCalls += 1;
      yield { type: "started", runId: request.runId };
      yield {
        type: "usage",
        usage: {
          provider: "openai-compatible",
          model: "budget-model",
          endpointFingerprint: "b".repeat(64),
          inputTokens: 100,
          outputTokens: 0,
          latencyMs: 5,
          retryCount: 0,
          usageUnavailable: false,
        },
      };
      yield { type: "completed", result: { cases: [] } };
    },
    async cancel(): Promise<void> {},
  };
  const request: RunRequest = {
    schema: "hypertest.run-request/v1",
    runId: "orchestrator-repair-budget",
    profilePath,
    workspacePath: root,
    sourceRevision: "rev-budget",
    mode: "repair",
    budget: {
      maxTurns: 2,
      maxToolCalls: 2,
      maxRepairRounds: 1,
      wallClockMs: 120_000,
      tokenBudget: 100,
    },
  };
  const artifactRoot = join(root, ".testagent");
  const summary = await new HyperTestOrchestrator({
    artifactRoot,
    runtime,
    runtimeProvider: "openai-compatible",
  }).run(request);

  assert.equal(runtimeCalls, 1);
  assert.equal(summary.finalState, "needs_human");
  const usage = JSON.parse(
    await readFile(
      join(
        artifactRoot,
        "runs",
        request.runId,
        "artifacts",
        "model-usage.json",
      ),
      "utf8",
    ),
  ) as { readonly providerCalls: number; readonly totalTokens: number };
  assert.equal(usage.providerCalls, 1);
  assert.equal(usage.totalTokens, 100);
  const ledger = JSON.parse(
    await readFile(
      join(
        artifactRoot,
        "runs",
        request.runId,
        "artifacts",
        "run-ledger.json",
      ),
      "utf8",
    ),
  ) as {
    readonly transitions: ReadonlyArray<{
      readonly event: string;
      readonly detail?: string;
    }>;
  };
  assert.deepEqual(
    ledger.transitions.slice(-2).map((transition) => transition.event),
    ["safe_repair", "human_required"],
  );
  assert.match(
    ledger.transitions.at(-1)?.detail ?? "",
    /token budget exhausted/i,
  );

  let unknownUsageRuntimeCalls = 0;
  const unknownUsageRuntime: AgentRuntime = {
    async *run(runRequest): AsyncIterable<AgentEvent> {
      unknownUsageRuntimeCalls += 1;
      yield { type: "started", runId: runRequest.runId };
      yield {
        type: "usage",
        usage: {
          provider: "openai-compatible",
          model: "budget-model",
          endpointFingerprint: "c".repeat(64),
          latencyMs: 5,
          retryCount: 0,
          usageUnavailable: true,
        },
      };
      yield { type: "completed", result: { cases: [] } };
    },
    async cancel(): Promise<void> {},
  };
  const unknownUsageRequest = {
    ...request,
    runId: "orchestrator-repair-unknown-usage",
  };
  const unknownUsageSummary = await new HyperTestOrchestrator({
    artifactRoot,
    runtime: unknownUsageRuntime,
    runtimeProvider: "openai-compatible",
  }).run(unknownUsageRequest);
  assert.equal(unknownUsageRuntimeCalls, 1);
  assert.equal(unknownUsageSummary.finalState, "needs_human");
  const unknownUsage = JSON.parse(
    await readFile(
      join(
        artifactRoot,
        "runs",
        unknownUsageRequest.runId,
        "artifacts",
        "model-usage.json",
      ),
      "utf8",
    ),
  ) as {
    readonly providerCalls: number;
    readonly usageUnavailableCalls: number;
    readonly totalTokens: number;
  };
  assert.equal(unknownUsage.providerCalls, 1);
  assert.equal(unknownUsage.usageUnavailableCalls, 1);
  assert.equal(unknownUsage.totalTokens, 0);
  const unknownUsageLedger = JSON.parse(
    await readFile(
      join(
        artifactRoot,
        "runs",
        unknownUsageRequest.runId,
        "artifacts",
        "run-ledger.json",
      ),
      "utf8",
    ),
  ) as {
    readonly transitions: ReadonlyArray<{
      readonly event: string;
      readonly detail?: string;
    }>;
  };
  assert.match(
    unknownUsageLedger.transitions.at(-1)?.detail ?? "",
    /usage is unavailable/i,
  );

  let failedRepairRuntimeCalls = 0;
  const failedRepairRuntime: AgentRuntime = {
    async *run(runRequest): AsyncIterable<AgentEvent> {
      failedRepairRuntimeCalls += 1;
      yield { type: "started", runId: runRequest.runId };
      yield {
        type: "usage",
        usage: {
          provider: "openai-compatible",
          model: "repair-failure-model",
          endpointFingerprint: "d".repeat(64),
          providerRequestId: `repair-failure-${failedRepairRuntimeCalls}`,
          inputTokens: failedRepairRuntimeCalls === 1 ? 10 : 5,
          outputTokens: 0,
          latencyMs: 5,
          retryCount: 0,
          usageUnavailable: false,
        },
      };
      if (failedRepairRuntimeCalls === 1) {
        yield { type: "completed", result: { cases: [] } };
      } else {
        yield {
          type: "failed",
          code: "provider_error",
          message: "Repair Provider unavailable",
          retryable: false,
          providerRequestId: "repair-failure-2",
        };
      }
    },
    async cancel(): Promise<void> {},
  };
  const failedRepairRequest = {
    ...request,
    runId: "orchestrator-repair-provider-failure",
  };
  const failedRepairSummary = await new HyperTestOrchestrator({
    artifactRoot,
    runtime: failedRepairRuntime,
    runtimeProvider: "openai-compatible",
  }).run(failedRepairRequest);
  assert.equal(failedRepairRuntimeCalls, 2);
  assert.equal(failedRepairSummary.finalState, "failed");
  assert.equal(failedRepairSummary.testPlan?.kind, "test-plan");
  assert.equal(failedRepairSummary.patch?.kind, "patch");
  assert.equal(failedRepairSummary.testRun?.kind, "test-run");
  assert.equal(failedRepairSummary.diagnosis?.kind, "diagnosis");
  const failedRepairUsage = JSON.parse(
    await readFile(
      join(
        artifactRoot,
        "runs",
        failedRepairRequest.runId,
        "artifacts",
        "model-usage.json",
      ),
      "utf8",
    ),
  ) as { readonly providerCalls: number; readonly totalTokens: number };
  assert.equal(failedRepairUsage.providerCalls, 2);
  assert.equal(failedRepairUsage.totalTokens, 15);
});
