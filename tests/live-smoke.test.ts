import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runProcess } from "../src/process.js";

const script = fileURLToPath(
  new URL("../../scripts/test-model-live.mjs", import.meta.url),
);

test("optional live model smoke skips cleanly without credentials", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: [script],
    env: {
      HYPERTEST_MODEL_PROVIDER: "",
      HYPERTEST_MODEL_ID: "",
      HYPERTEST_MODEL_BASE_URL: "",
      HYPERTEST_MODEL_API_KEY: "",
    },
    timeoutMs: 5_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /SKIP live model smoke/);
  assert.match(result.stdout, /No provider request was sent/);
});
