import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactRef, SutContract } from "../src/contracts.js";
import { createTestPlan } from "../src/planner.js";

const ref: ArtifactRef<"sut-contract"> = {
  kind: "sut-contract",
  schema: "hypertest.sut-contract/v1",
  uri: "file:///contract",
  mediaType: "application/json",
  sha256: "b".repeat(64),
};

const contract: SutContract = {
  schema: "hypertest.sut-contract/v1",
  id: "sample",
  title: "Sample",
  sourceRevision: "rev",
  operations: [
    {
      id: "create",
      interactionKind: "generic",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 3 },
          count: { type: "integer", minimum: 1, maximum: 2 },
        },
        required: ["name"],
      },
      observationSchema: { type: "object" },
      effects: "write",
      preconditions: [],
      oracleHints: [],
      tags: [],
    },
  ],
  lifecycleCapabilities: [],
  provenance: [],
};

test("creates deterministic happy, required-field, and boundary cases", async () => {
  const plan = await createTestPlan(contract, ref, { maxCasesPerOperation: 20 });
  assert.ok(plan.cases.some((item) => item.risk.dimensions.includes("success-path")));
  assert.ok(plan.cases.some((item) => item.title.includes("missing required field")));
  assert.ok(plan.cases.some((item) => item.title.includes("above the maximum")));
  assert.ok(plan.cases.every((item) => item.generatedBy === "deterministic"));
});
