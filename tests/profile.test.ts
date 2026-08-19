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

test("validates bounded OpenAI-compatible settings without accepting secrets", () => {
  const base = {
    schema: "hypertest.profile/v1" as const,
    name: "model-profile",
    runtime: {
      provider: "openai-compatible",
      model: "model-2026-08",
      baseUrl: "https://models.example.test/v1",
      timeoutMs: 5_000,
      maxRetries: 2,
      maxOutputTokens: 512,
      budgets: {
        maxTurns: 4,
        maxToolCalls: 4,
        maxRepairRounds: 0,
        wallClockMs: 10_000,
        tokenBudget: 1_000,
      },
    },
    sut: { contractSource: "contract.json", sourceKind: "command-contract" },
    adapters: {
      sut: { command: "node" },
      test: { command: "node" },
    },
    gate: { mode: "static-allow" },
    workspace: {
      allowedWriteGlobs: ["tests/**"],
      forbiddenGlobs: ["src/**"],
    },
  };
  const profile = validateProfile(base);
  assert.equal(profile.runtime.provider, "openai-compatible");
  assert.equal(profile.runtime.maxOutputTokens, 512);
  assert.throws(
    () =>
      validateProfile({
        ...base,
        runtime: { ...base.runtime, apiKey: "must-not-be-stored" },
      }),
    /HYPERTEST_MODEL_API_KEY/,
  );
  assert.throws(
    () =>
      validateProfile({
        ...base,
        runtime: { ...base.runtime, maxRetries: 11 },
      }),
    /runtime\.maxRetries/,
  );
});

test("rejects unknown runtime keys without masking the profile-secret error", () => {
  const base = {
    schema: "hypertest.profile/v1" as const,
    name: "runtime-key-validation",
    runtime: { provider: "deterministic" as const },
    sut: { contractSource: "contract.json", sourceKind: "command-contract" },
    adapters: {
      sut: { command: "node" },
      test: { command: "node" },
    },
    gate: { mode: "static-allow" },
    workspace: {
      allowedWriteGlobs: ["tests/**"],
      forbiddenGlobs: ["src/**"],
    },
  };

  assert.throws(
    () =>
      validateProfile({
        ...base,
        runtime: { ...base.runtime, maxRetry: 2 },
      }),
    /Unsupported runtime profile key: "maxRetry"/,
  );
  assert.throws(
    () =>
      validateProfile({
        ...base,
        runtime: { ...base.runtime, apiKey: "must-not-be-stored", maxRetry: 2 },
      }),
    /HYPERTEST_MODEL_API_KEY/,
  );
  assert.throws(
    () =>
      validateProfile({
        ...base,
        runtime: {
          ...base.runtime,
          budgets: { maxTurns: 4, maxTurn: 9 },
        },
      }),
    /Unsupported runtime budget key: "maxTurn"/,
  );
});

test("preserves legacy flattened runtime budget aliases", () => {
  const profile = validateProfile({
    schema: "hypertest.profile/v1",
    name: "legacy-budget-profile",
    runtime: {
      provider: "deterministic",
      maxTurns: 3,
      maxToolCalls: 7,
      max_repair_rounds: 0,
      wallClockMs: 9_000,
      tokenBudget: 321,
    },
    sut: { contractSource: "contract.json", sourceKind: "command-contract" },
    adapters: {
      sut: { command: "node" },
      test: { command: "node" },
    },
    gate: { mode: "static-allow" },
    workspace: {
      allowedWriteGlobs: ["tests/**"],
      forbiddenGlobs: ["src/**"],
    },
  });

  assert.deepEqual(profile.runtime.budgets, {
    maxTurns: 3,
    maxToolCalls: 7,
    maxRepairRounds: 0,
    wallClockMs: 9_000,
    tokenBudget: 321,
  });
});

test("rejects profiles that authorize more than two automatic repairs", () => {
  assert.throws(
    () =>
      validateProfile({
        schema: "hypertest.profile/v1",
        name: "too-many-repairs",
        runtime: {
          provider: "deterministic",
          budgets: { maxRepairRounds: 3 },
        },
        sut: { contractSource: "contract.json", sourceKind: "command-contract" },
        adapters: {
          sut: { command: "node" },
          test: { command: "node" },
        },
        gate: { mode: "static-allow" },
        workspace: {
          allowedWriteGlobs: ["tests/**"],
          forbiddenGlobs: ["src/**"],
        },
      }),
    /between 0 and 2/,
  );
});
