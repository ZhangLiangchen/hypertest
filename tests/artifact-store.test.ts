import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileArtifactStore } from "../src/artifact-store.js";

test("stores an immutable, content-addressed artifact reference", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const store = new FileArtifactStore(root);
  const ref = await store.put({
    runId: "run-1",
    relativePath: "test-plan.json",
    kind: "test-plan",
    schema: "hypertest.test-plan/v1",
    mediaType: "application/json",
    content: '{"cases":[]}',
  });

  assert.equal(
    ref.sha256,
    "6b20d0ea9be4a5fee9878ca07056218d7724bdb563a254e62ae94e8bb043cbf2",
  );
  assert.equal(ref.sizeBytes, 12);
  const stored = await readFile(new URL(ref.uri), "utf8");
  assert.equal(stored, '{"cases":[]}');
});

test("does not overwrite an artifact path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const store = new FileArtifactStore(root);
  const request = {
    runId: "run-1",
    relativePath: "diagnosis.json",
    kind: "diagnosis",
    schema: "hypertest.diagnosis/v1",
    mediaType: "application/json",
    content: "{}",
  } as const;

  await store.put(request);
  await assert.rejects(store.put(request), /EEXIST/);
});

test("rejects paths that escape the artifact root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const store = new FileArtifactStore(root);
  await assert.rejects(
    store.put({
      runId: "../../escape",
      relativePath: "evidence.json",
      kind: "evidence",
      schema: "hypertest.evidence/v1",
      mediaType: "application/json",
      content: "{}",
    }),
    /escapes the configured store root/,
  );
});
