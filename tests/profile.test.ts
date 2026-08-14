import assert from "node:assert/strict";
import test from "node:test";

import { parseDataDocument, validateProfile } from "../src/profile.js";

test("parses the supported YAML profile subset", () => {
  const value = parseDataDocument(`
schema: hypertest.profile/v1
name: sample
runtime:
  provider: deterministic
  budgets:
    maxTurns: 5
    maxToolCalls: 10
    maxRepairRounds: 1
    wallClockMs: 1000
    tokenBudget: 100
sut:
  contractSource: contract.json
  sourceKind: command-contract
adapters:
  sut:
    command: node
    args: ["adapter.js"]
  test:
    command: node
    args: ["adapter.js"]
gate:
  mode: static-allow
workspace:
  allowedWriteGlobs: ["tests/**"]
  forbiddenGlobs: ["src/**"]
`);
  const profile = validateProfile(value);
  assert.equal(profile.runtime.budgets.maxTurns, 5);
  assert.deepEqual(profile.workspace.allowedWriteGlobs, ["tests/**"]);
});

test("rejects an invalid provider and missing adapters", () => {
  assert.throws(
    () =>
      validateProfile({
        schema: "hypertest.profile/v1",
        name: "bad",
        runtime: { provider: "magic" },
        sut: { contractSource: "x", sourceKind: "x" },
        adapters: {},
      }),
    /Unsupported runtime provider/,
  );
});
