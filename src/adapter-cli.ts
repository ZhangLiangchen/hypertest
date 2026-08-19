#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  adapterFailure,
  exitCodeForStatus,
  okResponse,
  unsupportedResponse,
  type AdapterInvocationRequest,
} from "./adapter-protocol.js";
import { readArtifactJson, readArtifactText } from "./adapter-files.js";
import { FileArtifactStore } from "./artifact-store.js";
import type {
  AdapterManifest,
  AdapterResponse,
  ArtifactRef,
  CoverageMap,
  Json,
  SutContract,
  TestPlan,
  TestRun,
} from "./contracts.js";
import { parseDataDocument } from "./profile.js";
import { materializeNewFilePatch } from "./patch.js";
import { runProcess } from "./process.js";
import { parseCoberturaXml } from "./adapters/coverage/cobertura.js";
import { parseCoverageJson } from "./adapters/coverage/coverage-json.js";
import { parseGoCoverProfile } from "./adapters/coverage/go-cover.js";
import { parseLcov } from "./adapters/coverage/lcov.js";
import { GitLabCiProvider } from "./adapters/ci/gitlab.js";
import { LspClient } from "./adapters/code/lsp.js";
import { GitLabChangePublisher } from "./adapters/scm/gitlab.js";
import { importCommandContract } from "./adapters/sut/command.js";
import { importOpenApiContract } from "./adapters/sut/http-openapi.js";
import { parseGoTestJson, renderGoCommandTests } from "./adapters/test/go-test.js";
import { parsePytestJunit, renderPytestHttp } from "./adapters/test/pytest.js";
import { parseUnifiedDiff } from "./repair.js";

const args = process.argv.slice(2);
const adapterName = option(args, "--adapter") ?? process.env.HYPERTEST_ADAPTER;
const commandIndex = args.findIndex((item) => item === "describe" || item === "invoke");
const command = commandIndex < 0 ? undefined : args[commandIndex];
const responsePath = option(args, "--response");

if (adapterName === undefined || command === undefined || responsePath === undefined) {
  console.error("Usage: hypertest-adapter --adapter <name> describe|invoke --response <file> [...]");
  process.exit(64);
}

const manifest = manifestFor(adapterName);
if (command === "describe") {
  await writeAtomicJson(responsePath, manifest);
  process.exit(0);
}

const requestPath = option(args, "--request");
const operation = option(args, "--operation");
if (requestPath === undefined || operation === undefined) {
  console.error("invoke requires --operation and --request");
  process.exit(64);
}

let request: AdapterInvocationRequest;
try {
  request = JSON.parse(await readFile(requestPath, "utf8")) as AdapterInvocationRequest;
  if (request.schema !== "hypertest.adapter-invocation/v1" || request.operation !== operation) {
    throw new Error("Adapter invocation envelope is invalid");
  }
} catch (error) {
  const response = adapterFailure<Json>(
    randomUUID(),
    manifest.adapter,
    "permanent_error",
    "INVALID_REQUEST",
    error instanceof Error ? error.message : String(error),
    false,
  );
  await writeAtomicJson(responsePath, response);
  process.exit(64);
}

let response: AdapterResponse<Json>;
try {
  response = await invokeBuiltIn(adapterName, operation, request, manifest);
} catch (error) {
  response = adapterFailure<Json>(
    request.context.requestId,
    manifest.adapter,
    "permanent_error",
    "BUILTIN_ADAPTER_ERROR",
    error instanceof Error ? error.stack ?? error.message : String(error),
    false,
  );
}
await writeAtomicJson(responsePath, response);
process.exit(exitCodeForStatus(response.status));

async function invokeBuiltIn(
  name: string,
  operation: string,
  request: AdapterInvocationRequest,
  manifest: AdapterManifest,
): Promise<AdapterResponse<Json>> {
  const input = expectRecord(request.input, "input");
  const config = isRecord(request.config) ? request.config : {};
  const store = new FileArtifactStore(
    string(config.artifactRoot) ?? process.env.HYPERTEST_ARTIFACT_ROOT ?? ".testagent",
  );

  if (name === "sut-http-openapi" || name === "sut-command") {
    if (operation !== "importContract") {
      return unsupportedResponse(request.context.requestId, manifest.adapter, operation);
    }
    const source = artifact(input.source, "raw-sut-contract");
    const text = await readArtifactText(source);
    const contract = name === "sut-http-openapi"
      ? importOpenApiContract(text, request.context.sourceRevision, [source])
      : importCommandContract(text, request.context.sourceRevision, [source]);
    const ref = await store.putJson({
      runId: request.context.runId,
      relativePath: "sut-contract.json",
      kind: "sut-contract",
      schema: "hypertest.sut-contract/v1",
      sourceRevision: request.context.sourceRevision,
      value: contract as unknown as Json,
    });
    return okResponse(request.context.requestId, manifest.adapter, ref as unknown as Json, [ref]);
  }

  if (name === "test-pytest" || name === "test-go") {
    if (operation === "render") {
      const planRef = artifact(input.plan, "test-plan");
      const contractRef = artifact(input.contract, "sut-contract");
      const plan = await readArtifactJson<TestPlan>(planRef);
      const contract = await readArtifactJson<SutContract>(contractRef);
      const outputPath = string(config.outputPath);
      const baseUrlEnvironmentVariable = string(config.baseUrlEnvironmentVariable);
      const packageName = string(config.packageName);
      const rendered = name === "test-pytest"
        ? renderPytestHttp(plan, contract, {
            ...(outputPath === undefined ? {} : { outputPath }),
            ...(baseUrlEnvironmentVariable === undefined
              ? {}
              : { baseUrlEnvironmentVariable }),
          })
        : renderGoCommandTests(plan, contract, {
            ...(outputPath === undefined ? {} : { outputPath }),
            ...(packageName === undefined ? {} : { packageName }),
          });
      const patch = await store.put({
        runId: request.context.runId,
        relativePath: "generated.patch",
        kind: "patch",
        schema: "hypertest.patch/v1",
        mediaType: "text/x-diff",
        sourceRevision: request.context.sourceRevision,
        metadata: { changedPaths: [rendered.path] },
        content: rendered.patch,
      });
      return okResponse(request.context.requestId, manifest.adapter, patch as unknown as Json, [patch]);
    }
    if (operation === "validate") {
      const patchRef = artifact(input.patch, "patch");
      const parsed = parseUnifiedDiff(await readArtifactText(patchRef));
      const report: Json = {
        valid: parsed.paths.length > 0,
        changedPaths: [...parsed.paths],
        addedLines: parsed.added.length,
        deletedLines: parsed.deleted.length,
      };
      const reportRef = await store.putJson({
        runId: request.context.runId,
        relativePath: "validation-report.json",
        kind: "validation-report",
        schema: "hypertest.validation-report/v1",
        value: report,
      });
      return okResponse(request.context.requestId, manifest.adapter, reportRef as unknown as Json, [reportRef]);
    }
    if (operation === "run") {
      return runTestAdapter(name, request, manifest, store, input, config);
    }
    return unsupportedResponse(request.context.requestId, manifest.adapter, operation);
  }

  if (name.startsWith("coverage-")) {
    if (operation !== "normalize") {
      return unsupportedResponse(request.context.requestId, manifest.adapter, operation);
    }
    const source = artifact(input.source, "raw-coverage");
    const text = await readArtifactText(source);
    let map: CoverageMap;
    if (name === "coverage-lcov") map = parseLcov(text, request.context.sourceRevision);
    else if (name === "coverage-cobertura") map = parseCoberturaXml(text, request.context.sourceRevision);
    else if (name === "coverage-json") map = parseCoverageJson(text, request.context.sourceRevision);
    else if (name === "coverage-go") map = parseGoCoverProfile(text, request.context.sourceRevision);
    else return unsupportedResponse(request.context.requestId, manifest.adapter, operation);
    const ref = await store.putJson({
      runId: request.context.runId,
      relativePath: "coverage-map.json",
      kind: "coverage-map",
      schema: "hypertest.coverage-map/v1",
      sourceRevision: request.context.sourceRevision,
      value: map as unknown as Json,
    });
    return okResponse(request.context.requestId, manifest.adapter, ref as unknown as Json, [ref]);
  }

  if (name === "code-lsp") {
    if (operation !== "query") {
      return unsupportedResponse(request.context.requestId, manifest.adapter, operation);
    }
    const server = string(config.command);
    if (server === undefined) throw new Error("code-lsp config.command is required");
    const cwd = string(config.cwd) ?? workspacePath(request.context.workspace);
    const client = new LspClient({
      command: server,
      args: stringArray(config.args),
      cwd,
      requestTimeoutMs: number(config.timeoutMs) ?? 20_000,
    });
    try {
      await client.start();
      const kind = string(input.kind);
      let result: Json;
      if (kind === "symbols") result = await client.workspaceSymbols(string(input.query) ?? "");
      else if (kind === "definition") result = await client.definition(
        requiredString(input.uri, "input.uri"),
        requiredNumber(input.line, "input.line"),
        requiredNumber(input.character, "input.character"),
      );
      else if (kind === "references") result = await client.references(
        requiredString(input.uri, "input.uri"),
        requiredNumber(input.line, "input.line"),
        requiredNumber(input.character, "input.character"),
      );
      else return unsupportedResponse(request.context.requestId, manifest.adapter, `query:${kind ?? "unknown"}`);
      const outcome = {
        result,
        capabilities: client.getCapabilities(),
        notifications: [...client.getNotifications()],
        completeness: "partial",
      };
      return okResponse(request.context.requestId, manifest.adapter, outcome);
    } finally {
      await client.close();
    }
  }

  if (name === "ci-gitlab") {
    const token = string(config.token) ?? process.env.GITLAB_TOKEN;
    const projectId = string(config.projectId) ?? process.env.CI_PROJECT_ID;
    if (token === undefined || projectId === undefined) throw new Error("GitLab token and project id are required");
    const gitLabBaseUrl = string(config.baseUrl);
    const provider = new GitLabCiProvider({
      token,
      projectId,
      ...(gitLabBaseUrl === undefined ? {} : { baseUrl: gitLabBaseUrl }),
    });
    if (operation === "currentContext") {
      return okResponse(request.context.requestId, manifest.adapter, provider.currentContext() as unknown as Json);
    }
    if (operation === "submit") {
      const pipeline = await provider.submit(requiredString(input.ref, "input.ref"), stringRecord(input.variables));
      return okResponse(request.context.requestId, manifest.adapter, pipeline as unknown as Json);
    }
    if (operation === "get") {
      const pipeline = await provider.get(requiredNumber(input.pipelineId, "input.pipelineId"));
      return okResponse(request.context.requestId, manifest.adapter, pipeline as unknown as Json);
    }
    if (operation === "cancel") {
      const pipeline = await provider.cancel(requiredNumber(input.pipelineId, "input.pipelineId"));
      return okResponse(request.context.requestId, manifest.adapter, pipeline as unknown as Json);
    }
    return unsupportedResponse(request.context.requestId, manifest.adapter, operation);
  }

  if (name === "scm-gitlab") {
    if (operation !== "publishDraft") {
      return unsupportedResponse(request.context.requestId, manifest.adapter, operation);
    }
    const token = string(config.token) ?? process.env.GITLAB_TOKEN;
    const projectId = string(config.projectId) ?? process.env.CI_PROJECT_ID;
    if (token === undefined || projectId === undefined) throw new Error("GitLab token and project id are required");
    const gitLabBaseUrl = string(config.baseUrl);
    const targetBranch = string(config.targetBranch);
    const publisher = new GitLabChangePublisher({
      token,
      projectId,
      workspacePath: string(config.workspacePath) ?? workspacePath(request.context.workspace),
      ...(gitLabBaseUrl === undefined ? {} : { baseUrl: gitLabBaseUrl }),
      ...(targetBranch === undefined ? {} : { targetBranch }),
    });
    const patchRef = artifact(input.patch, "patch");
    const result = await publisher.publishDraft({
      baseRevision: requiredString(input.baseRevision, "input.baseRevision"),
      patchText: await readArtifactText(patchRef),
      title: requiredString(input.title, "input.title"),
      description: requiredString(input.description, "input.description"),
      idempotencyKey: requiredString(input.idempotencyKey, "input.idempotencyKey"),
    });
    return okResponse(request.context.requestId, manifest.adapter, result as unknown as Json);
  }

  return unsupportedResponse(request.context.requestId, manifest.adapter, operation);
}

async function runTestAdapter(
  name: string,
  request: AdapterInvocationRequest,
  manifest: AdapterManifest,
  store: FileArtifactStore,
  input: Record<string, Json>,
  config: Record<string, Json>,
): Promise<AdapterResponse<Json>> {
  const sourceWorkspace = string(input.workspacePath) ?? workspacePath(request.context.workspace);
  const temporary = await mkdtemp(join(tmpdir(), "hypertest-test-run-"));
  const copied = join(temporary, basename(sourceWorkspace) || "workspace");
  await cp(sourceWorkspace, copied, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).some((part) => part === ".git" || part === ".testagent" || part === "node_modules"),
  });
  try {
    if (input.patch !== undefined) {
      const patchRef = artifact(input.patch, "patch");
      await materializeNewFilePatch(copied, await readArtifactText(patchRef));
    }
    const command = stringArray(config.command);
    if (command.length === 0) throw new Error("Test adapter config.command must be a non-empty array");
    const [executable, ...args] = command;
    const executionCwd = resolve(copied, string(config.workdir) ?? ".");
    const result = await runProcess({
      command: executable!,
      args,
      cwd: executionCwd,
      env: stringRecord(config.env),
      timeoutMs: number(config.timeoutMs) ?? 120_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    let testRun: TestRun;
    if (result.timedOut) {
      testRun = {
        schema: "hypertest.test-run/v1",
        runId: request.context.runId,
        sourceRevision: request.context.sourceRevision,
        status: "timeout",
        command,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        startedAtEpochMs: result.startedAtEpochMs,
        finishedAtEpochMs: result.finishedAtEpochMs,
        cases: [],
        stdout: result.stdout,
        stderr: result.stderr,
        rawArtifacts: [],
        coverageArtifacts: [],
      };
    } else if (name === "test-pytest") {
      const resultPath = resolve(executionCwd, string(config.resultPath) ?? ".hypertest-junit.xml");
      try {
        const xml = await readFile(resultPath, "utf8");
        testRun = parsePytestJunit(xml, {
          runId: request.context.runId,
          sourceRevision: request.context.sourceRevision,
          command,
          exitCode: result.exitCode ?? 1,
          startedAtEpochMs: result.startedAtEpochMs,
          finishedAtEpochMs: result.finishedAtEpochMs,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (error) {
        if (result.exitCode === undefined || result.exitCode === 0 || !isMissingFileError(error)) {
          throw error;
        }
        testRun = {
          schema: "hypertest.test-run/v1",
          runId: request.context.runId,
          sourceRevision: request.context.sourceRevision,
          status: "runner_error",
          command,
          exitCode: result.exitCode,
          ...(result.signal === undefined ? {} : { signal: result.signal }),
          startedAtEpochMs: result.startedAtEpochMs,
          finishedAtEpochMs: result.finishedAtEpochMs,
          cases: [],
          stdout: result.stdout,
          stderr: result.stderr,
          rawArtifacts: [],
          coverageArtifacts: [],
        };
      }
    } else {
      testRun = parseGoTestJson(result.stdout, {
        runId: request.context.runId,
        sourceRevision: request.context.sourceRevision,
        command,
        exitCode: result.exitCode ?? 1,
        startedAtEpochMs: result.startedAtEpochMs,
        finishedAtEpochMs: result.finishedAtEpochMs,
        stderr: result.stderr,
      });
    }

    const artifacts: ArtifactRef[] = [];
    const coveragePath = string(config.coveragePath);
    if (coveragePath !== undefined) {
      try {
        const bytes = await readFile(resolve(executionCwd, coveragePath));
        const rawCoverage = await store.put({
          runId: request.context.runId,
          relativePath: basename(coveragePath),
          kind: "raw-coverage",
          schema: "hypertest.raw-coverage/v1",
          mediaType: string(config.coverageMediaType) ?? "text/plain",
          sourceRevision: request.context.sourceRevision,
          content: bytes,
        });
        artifacts.push(rawCoverage);
        testRun = { ...testRun, coverageArtifacts: [rawCoverage] };
      } catch {
        // A missing optional coverage file is reflected by an empty coverage list.
      }
    }
    const testRunRef = await store.putJson({
      runId: request.context.runId,
      relativePath: "test-run.json",
      kind: "test-run",
      schema: "hypertest.test-run/v1",
      sourceRevision: request.context.sourceRevision,
      value: testRun as unknown as Json,
    });
    artifacts.unshift(testRunRef);
    return okResponse(request.context.requestId, manifest.adapter, testRunRef as unknown as Json, artifacts);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function manifestFor(name: string): AdapterManifest {
  const common = { schema: "hypertest.adapter-manifest/v1" as const, adapter: { name, version: "0.1.0" } };
  if (name === "sut-http-openapi" || name === "sut-command") {
    return {
      ...common,
      category: "sut",
      capabilities: ["contract-import"],
      operations: [{ name: "importContract", description: "Import a SUT contract", idempotent: true }],
    };
  }
  if (name === "test-pytest" || name === "test-go") {
    return {
      ...common,
      category: "test-framework",
      capabilities: ["render", "validate", "run"],
      operations: [
        { name: "render", description: "Render framework source from a neutral plan", idempotent: true },
        { name: "validate", description: "Validate a generated patch", idempotent: true },
        { name: "run", description: "Execute tests in a copied workspace", idempotent: false },
      ],
    };
  }
  if (name.startsWith("coverage-")) {
    return {
      ...common,
      category: "coverage",
      capabilities: ["normalize"],
      operations: [{ name: "normalize", description: "Normalize native coverage", idempotent: true }],
    };
  }
  if (name === "code-lsp") {
    return {
      ...common,
      category: "code-intelligence",
      capabilities: ["symbols", "definition", "references"],
      operations: [{ name: "query", description: "Perform one language-server query", idempotent: true }],
    };
  }
  if (name === "ci-gitlab") {
    return {
      ...common,
      category: "ci",
      capabilities: ["current-context", "submit", "status", "cancel"],
      operations: [
        { name: "currentContext", description: "Read the current CI context", idempotent: true },
        { name: "submit", description: "Create a pipeline", idempotent: false },
        { name: "get", description: "Read pipeline state", idempotent: true },
        { name: "cancel", description: "Cancel a pipeline", idempotent: true },
      ],
    };
  }
  if (name === "scm-gitlab") {
    return {
      ...common,
      category: "scm",
      capabilities: ["draft-change"],
      operations: [{ name: "publishDraft", description: "Push a patch and create a draft change", idempotent: true }],
    };
  }
  throw new Error(`Unknown built-in adapter: ${name}`);
}

function option(values: readonly string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index < 0 ? undefined : values[index + 1];
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

function expectRecord(value: Json | undefined, path: string): Record<string, Json> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function isRecord(value: Json | undefined): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: Json | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: Json | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredString(value: Json | undefined, path: string): string {
  const result = string(value);
  if (result === undefined) throw new Error(`${path} must be a non-empty string`);
  return result;
}

function requiredNumber(value: Json | undefined, path: string): number {
  const result = number(value);
  if (result === undefined) throw new Error(`${path} must be a number`);
  return result;
}

function stringArray(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: Json | undefined): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (typeof item === "string" ? [[key, item]] : [])),
  );
}

function artifact(value: Json | undefined, kind: string): ArtifactRef {
  const record = expectRecord(value, `artifact ${kind}`);
  if (
    typeof record.kind !== "string" ||
    typeof record.schema !== "string" ||
    typeof record.uri !== "string" ||
    typeof record.mediaType !== "string" ||
    typeof record.sha256 !== "string"
  ) throw new Error(`Invalid ${kind} artifact reference`);
  return record as unknown as ArtifactRef;
}

function workspacePath(ref: ArtifactRef): string {
  const url = new URL(ref.uri);
  if (url.protocol !== "file:") throw new Error("Built-in adapters require a file workspace URI");
  return resolve(decodeURIComponent(url.pathname));
}
