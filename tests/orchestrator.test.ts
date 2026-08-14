import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HyperTestOrchestrator } from "../src/orchestrator.js";
import type { RunRequest } from "../src/contracts.js";

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
});
