import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileArtifactStore } from "../src/artifact-store.js";

test("stores and verifies an immutable artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new FileArtifactStore(root);
  const content = '{"cases":[]}';
  const ref = await store.put({
    runId: "run-1",
    relativePath: "test-plan.json",
    kind: "test-plan",
    schema: "hypertest.test-plan/v1",
    mediaType: "application/json",
    content,
  });
  assert.equal(ref.sha256, createHash("sha256").update(content).digest("hex"));
  assert.equal(await store.readText(ref), content);
  await assert.rejects(
    store.put({
      runId: "run-1",
      relativePath: "test-plan.json",
      kind: "test-plan",
      schema: "hypertest.test-plan/v1",
      mediaType: "application/json",
      content,
    }),
    /EEXIST/,
  );
});

test("detects tampering and escaping paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new FileArtifactStore(root);
  const ref = await store.put({
    runId: "run-1",
    relativePath: "evidence.txt",
    kind: "evidence",
    schema: "hypertest.evidence/v1",
    mediaType: "text/plain",
    content: "trusted",
  });
  await writeFile(new URL(ref.uri), "tampered");
  await assert.rejects(store.read(ref), /hash mismatch/);
  await assert.rejects(
    store.put({
      runId: "../../escape",
      relativePath: "x",
      kind: "evidence",
      schema: "x",
      mediaType: "text/plain",
      content: "x",
    }),
    /unsafe characters/,
  );
  const eventsPath = join(root, "runs", "run-1", "events.ndjson");
  await store.appendEvent("run-1", { event: "x" });
  assert.match(await readFile(eventsPath, "utf8"), /"event":"x"/);
});
