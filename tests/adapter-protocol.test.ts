import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { ProcessAdapterClient, createCallContext } from "../src/adapter-protocol.js";
import { FileArtifactStore } from "../src/artifact-store.js";
import type { ArtifactRef, Json, TestRun } from "../src/contracts.js";

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

test("pytest runner failure without JUnit remains a successful adapter call", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-pytest-runner-error-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspacePath = join(root, "workspace");
  const artifactRoot = join(root, "artifacts");
  await mkdir(workspacePath, { recursive: true });
  const stdout = "runner stdout is preserved\n";
  const stderr = "runner stderr is preserved\n";
  const client = new ProcessAdapterClient({
    command: process.execPath,
    args: [adapterCli.pathname, "--adapter", "test-pytest"],
    env: { HYPERTEST_ARTIFACT_ROOT: artifactRoot },
    config: {
      artifactRoot,
      command: [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(3);`,
      ],
      resultPath: ".missing-pytest-junit.xml",
    },
  });
  const response = await client.invoke<Json, ArtifactRef<"test-run">>(
    "run",
    createCallContext({
      runId: "pytest-runner-error",
      workspace: workspaceRef(workspacePath),
      sourceRevision: "rev",
      deadlineEpochMs: Date.now() + 30_000,
    }),
    { workspacePath },
  );

  assert.equal(response.status, "ok");
  assert.ok(response.outcome);
  const run = await new FileArtifactStore(artifactRoot).readJson<TestRun>(
    response.outcome,
  );
  assert.equal(run.status, "runner_error");
  assert.equal(run.exitCode, 3);
  assert.equal(run.stdout, stdout);
  assert.equal(run.stderr, stderr);
  assert.deepEqual(run.cases, []);
});

test("pytest success without JUnit is still an adapter failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-pytest-missing-result-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspacePath = join(root, "workspace");
  const artifactRoot = join(root, "artifacts");
  await mkdir(workspacePath, { recursive: true });
  const client = new ProcessAdapterClient({
    command: process.execPath,
    args: [adapterCli.pathname, "--adapter", "test-pytest"],
    env: { HYPERTEST_ARTIFACT_ROOT: artifactRoot },
    config: {
      artifactRoot,
      command: [process.execPath, "-e", "process.exit(0)"],
      resultPath: ".missing-pytest-junit.xml",
    },
  });
  const response = await client.invoke<Json, ArtifactRef<"test-run">>(
    "run",
    createCallContext({
      runId: "pytest-missing-result",
      workspace: workspaceRef(workspacePath),
      sourceRevision: "rev",
      deadlineEpochMs: Date.now() + 30_000,
    }),
    { workspacePath },
  );

  assert.equal(response.status, "permanent_error");
  assert.equal(response.outcome, undefined);
  assert.equal(response.diagnostics[0]?.code, "BUILTIN_ADAPTER_ERROR");
});

function workspaceRef(path: string): ArtifactRef<"workspace"> {
  return {
    kind: "workspace",
    schema: "hypertest.workspace/v1",
    uri: pathToFileURL(path).href,
    mediaType: "application/vnd.hypertest.workspace",
    sha256: "d".repeat(64),
  };
}
