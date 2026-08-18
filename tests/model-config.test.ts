import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeEndpoint,
  resolveModelConfig,
} from "../src/model-config.js";

test("resolves deterministic and OpenAI-compatible model configuration", () => {
  assert.deepEqual(
    resolveModelConfig({ provider: "deterministic" }, {}),
    { provider: "deterministic" },
  );

  const config = resolveModelConfig(
    {
      provider: "openai-compatible",
      model: "profile-model-2026-08",
      baseUrl: "https://models.example.test/v1/",
      timeoutMs: 5_000,
      maxRetries: 1,
      maxOutputTokens: 512,
    },
    { HYPERTEST_MODEL_API_KEY: "secret-value" },
  );
  assert.deepEqual(config, {
    provider: "openai-compatible",
    modelId: "profile-model-2026-08",
    baseUrl: "https://models.example.test/v1",
    apiKey: "secret-value",
    timeoutMs: 5_000,
    maxRetries: 1,
    maxOutputTokens: 512,
  });
});

test("environment values explicitly override profile model settings", () => {
  const config = resolveModelConfig(
    { provider: "deterministic" },
    {
      HYPERTEST_MODEL_PROVIDER: "openai-compatible",
      HYPERTEST_MODEL_ID: "environment-model-2026-08",
      HYPERTEST_MODEL_BASE_URL: "http://127.0.0.1:9080/v1/",
      HYPERTEST_MODEL_API_KEY: "environment-secret",
      HYPERTEST_MODEL_TIMEOUT_MS: "900",
      HYPERTEST_MODEL_MAX_RETRIES: "3",
      HYPERTEST_MODEL_MAX_OUTPUT_TOKENS: "128",
    },
  );
  assert.equal(config.provider, "openai-compatible");
  if (config.provider === "openai-compatible") {
    assert.equal(config.modelId, "environment-model-2026-08");
    assert.equal(config.baseUrl, "http://127.0.0.1:9080/v1");
    assert.equal(config.timeoutMs, 900);
    assert.equal(config.maxRetries, 3);
    assert.equal(config.maxOutputTokens, 128);
  }
});

test("OpenAI-compatible configuration fails closed without required fields", () => {
  assert.throws(
    () => resolveModelConfig({ provider: "openai-compatible" }, {}),
    /HYPERTEST_MODEL_ID or runtime\.model/,
  );
  assert.throws(
    () =>
      resolveModelConfig(
        { provider: "openai-compatible", model: "model" },
        {},
      ),
    /HYPERTEST_MODEL_BASE_URL or runtime\.baseUrl/,
  );
  assert.throws(
    () =>
      resolveModelConfig(
        {
          provider: "openai-compatible",
          model: "model",
          baseUrl: "https://models.example.test/v1",
        },
        {},
      ),
    /HYPERTEST_MODEL_API_KEY/,
  );
});

test("model configuration rejects unsafe URLs and unbounded numeric values", () => {
  for (const value of [
    "file:///tmp/provider",
    "https://user:password@models.example.test/v1",
    "https://models.example.test/v1?secret=value",
    "https://models.example.test/v1#fragment",
  ]) {
    assert.throws(() => normalizeEndpoint(value));
  }

  const baseEnvironment = {
    HYPERTEST_MODEL_API_KEY: "do-not-print-this",
    HYPERTEST_MODEL_ID: "model",
    HYPERTEST_MODEL_BASE_URL: "https://models.example.test/v1",
  };
  for (const [name, value] of [
    ["HYPERTEST_MODEL_TIMEOUT_MS", "99"],
    ["HYPERTEST_MODEL_MAX_RETRIES", "11"],
    ["HYPERTEST_MODEL_MAX_OUTPUT_TOKENS", "0"],
  ] as const) {
    assert.throws(
      () =>
        resolveModelConfig(
          { provider: "openai-compatible" },
          { ...baseEnvironment, [name]: value },
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(name));
        assert.doesNotMatch(error.message, /do-not-print-this/);
        return true;
      },
    );
  }
});
