import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { ProcessAdapterClient, createCallContext } from "../src/adapter-protocol.js";
import { FileArtifactStore } from "../src/artifact-store.js";
import type { ArtifactRef, Json } from "../src/contracts.js";

const adapterCli = new URL("../src/adapter-cli.js", import.meta.url);

test("process adapter imports a contract through JSON files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-adapter-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new FileArtifactStore(root);
  const raw = await store.put({
    runId: "run-1",
    relativePath: "command.json",
    kind: "raw-sut-contract",
    schema: "hypertest.raw-sut-contract/v1",
    mediaType: "application/json",
    content: JSON.stringify({
      title: "CLI",
      operations: [{ id: "echo", argv: ["echo", "{message}"], inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }],
    }),
  });
  const workspace: ArtifactRef<"workspace"> = {
    kind: "workspace",
    schema: "hypertest.workspace/v1",
    uri: pathToFileURL(root).href,
    mediaType: "application/vnd.hypertest.workspace",
    sha256: "d".repeat(64),
  };
  const client = new ProcessAdapterClient({
    command: process.execPath,
    args: [adapterCli.pathname, "--adapter", "sut-command"],
    env: { HYPERTEST_ARTIFACT_ROOT: root },
  });
  const manifest = await client.describe();
  assert.equal(manifest.category, "sut");
  const response = await client.invoke<Json, ArtifactRef<"sut-contract">>(
    "importContract",
    createCallContext({
      runId: "run-1",
      workspace,
      sourceRevision: "rev",
      deadlineEpochMs: Date.now() + 30_000,
    }),
    { source: raw as unknown as Json, sourceKind: "command-contract" },
  );
  assert.equal(response.status, "ok");
  assert.equal(response.outcome?.kind, "sut-contract");
});
