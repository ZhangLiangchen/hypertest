import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { runProcess } from "../src/process.js";

interface RecordedRequest {
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

interface MockServer {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const adapterCliPath = fileURLToPath(
  new URL("../src/adapter-cli.js", import.meta.url),
);
const cliSecret = "cli-integration-secret";

async function startPlannerMock(): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (incoming, response) => {
    let text = "";
    for await (const chunk of incoming) text += String(chunk);
    const body = JSON.parse(text) as Record<string, unknown>;
    const index = requests.length;
    requests.push({ headers: incoming.headers, body });
    if (index === 0) {
      sendToolCall(response);
    } else {
      const messages = body.messages as Array<Record<string, unknown>>;
      assert.equal(messages.at(-1)?.role, "tool");
      assert.equal(messages.at(-1)?.tool_call_id, "cli-tool-call");
      sendFinalPlan(response);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => closeServer(server),
  };
}

function openSse(response: ServerResponse, requestId: string): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-request-id": requestId,
  });
  response.flushHeaders();
}

function writeSse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function finishSse(response: ServerResponse): void {
  response.end("data: [DONE]\n\n");
}

function sendToolCall(response: ServerResponse): void {
  openSse(response, "cli-tool-request");
  writeSse(response, {
    id: "cli-tool-request",
    object: "chat.completion.chunk",
    created: 1,
    model: "cli-mock-model-2026-08",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "cli-tool-call",
              type: "function",
              function: {
                name: "contract.get_operation",
                arguments: '{"operationId":"read-item"}',
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  writeSse(response, {
    id: "cli-tool-request",
    object: "chat.completion.chunk",
    created: 1,
    model: "cli-mock-model-2026-08",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: {
      prompt_tokens: 6,
      completion_tokens: 3,
      total_tokens: 9,
      prompt_tokens_details: { cached_tokens: 1 },
    },
  });
  finishSse(response);
}

function sendFinalPlan(response: ServerResponse): void {
  openSse(response, "cli-final-request");
  const result = JSON.stringify({
    cases: [
      {
        title: "CLI model-generated read case",
        objective: "Verify the read operation selected through the CLI tool loop",
        steps: [{ operationId: "read-item", input: { id: "example" } }],
        oracle: { exitCode: 0 },
      },
    ],
  });
  writeSse(response, {
    id: "cli-final-request",
    object: "chat.completion.chunk",
    created: 1,
    model: "cli-mock-model-2026-08",
    choices: [
      { index: 0, delta: { content: result.slice(0, 48) }, finish_reason: null },
    ],
  });
  writeSse(response, {
    id: "cli-final-request",
    object: "chat.completion.chunk",
    created: 1,
    model: "cli-mock-model-2026-08",
    choices: [
      { index: 0, delta: { content: result.slice(48) }, finish_reason: null },
    ],
  });
  writeSse(response, {
    id: "cli-final-request",
    object: "chat.completion.chunk",
    created: 1,
    model: "cli-mock-model-2026-08",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 9,
      completion_tokens: 6,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 2 },
    },
  });
  finishSse(response);
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function writeCliFixture(
  root: string,
  provider: "deterministic" | "openai-compatible" = "openai-compatible",
): Promise<string> {
  const contractPath = join(root, "command-contract.json");
  await writeFile(
    contractPath,
    JSON.stringify({
      title: "CLI model contract",
      operations: [
        {
          id: "read-item",
          title: "Read item",
          argv: [process.execPath, "-e", "process.exit(0)"],
          inputSchema: {
            type: "object",
            properties: { id: { type: "string", minLength: 1 } },
            required: ["id"],
            additionalProperties: false,
          },
          expectedExitCodes: [0],
          effects: "read",
        },
      ],
    }),
  );
  const profilePath = join(root, "profile.json");
  await writeFile(
    profilePath,
    JSON.stringify({
      schema: "hypertest.profile/v1",
      name: "cli-model-e2e",
      runtime: {
        provider,
        budgets: {
          maxTurns: 4,
          maxToolCalls: 4,
          maxRepairRounds: 0,
          wallClockMs: 10_000,
          tokenBudget: 200,
        },
      },
      sut: {
        contractSource: contractPath,
        sourceKind: "command-contract",
      },
      adapters: {
        sut: {
          command: process.execPath,
          args: [adapterCliPath, "--adapter", "sut-command"],
        },
        test: {
          command: process.execPath,
          args: [adapterCliPath, "--adapter", "test-go"],
        },
      },
      gate: { mode: "static-allow" },
      workspace: {
        allowedWriteGlobs: ["**/*_test.go"],
        forbiddenGlobs: ["src/**"],
      },
    }),
  );
  return profilePath;
}

test("CLI activates the real provider and closes the HTTP/SSE planner tool loop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-cli-model-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const profilePath = await writeCliFixture(root, "deterministic");
  const artifactRoot = join(root, "artifacts");
  const mock = await startPlannerMock();
  t.after(async () => mock.close());

  const result = await runProcess({
    command: process.execPath,
    args: [
      cliPath,
      "plan",
      "--profile",
      profilePath,
      "--workspace",
      root,
      "--artifact-root",
      artifactRoot,
      "--revision",
      "cli-revision",
      "--run-id",
      "cli-model-e2e",
    ],
    cwd: root,
    env: {
      HYPERTEST_MODEL_PROVIDER: "openai-compatible",
      HYPERTEST_MODEL_ID: "cli-mock-model-2026-08",
      HYPERTEST_MODEL_BASE_URL: mock.baseUrl,
      HYPERTEST_MODEL_API_KEY: cliSecret,
      HYPERTEST_MODEL_TIMEOUT_MS: "2000",
      HYPERTEST_MODEL_MAX_RETRIES: "1",
      HYPERTEST_MODEL_MAX_OUTPUT_TOKENS: "128",
    },
    timeoutMs: 10_000,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0]?.headers.authorization, `Bearer ${cliSecret}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(cliSecret));

  const summary = JSON.parse(result.stdout) as {
    readonly finalState: string;
    readonly testPlan?: { readonly uri?: string };
    readonly modelUsage?: { readonly uri?: string };
    readonly ledger?: { readonly uri?: string };
    readonly warnings: readonly string[];
  };
  assert.equal(summary.finalState, "planned");
  assert.match(summary.testPlan?.uri ?? "", /test-plan\.json$/);
  assert.match(summary.modelUsage?.uri ?? "", /model-usage\.json$/);
  assert.match(summary.ledger?.uri ?? "", /run-ledger\.json$/);
  assert.match(summary.warnings.join("\n"), /model-usage=.*model-usage\.json/);

  const artifactDirectory = join(
    artifactRoot,
    "runs",
    "cli-model-e2e",
    "artifacts",
  );
  const planText = await readFile(join(artifactDirectory, "test-plan.json"), "utf8");
  const ledger = JSON.parse(
    await readFile(join(artifactDirectory, "run-ledger.json"), "utf8"),
  ) as { readonly state: string };
  assert.equal(ledger.state, "pre_code_gate");
  const plan = JSON.parse(planText) as {
    readonly cases: ReadonlyArray<{
      readonly title: string;
      readonly generatedBy: string;
    }>;
  };
  assert.ok(
    plan.cases.some(
      (item) =>
        item.generatedBy === "model" &&
        item.title === "CLI model-generated read case",
    ),
  );

  const usageText = await readFile(
    join(artifactDirectory, "model-usage.json"),
    "utf8",
  );
  const usage = JSON.parse(usageText) as {
    readonly providerCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedTokens: number;
    readonly totalTokens: number;
    readonly records: ReadonlyArray<{
      readonly providerRequestId?: string;
      readonly endpointFingerprint: string;
    }>;
  };
  assert.equal(usage.providerCalls, 2);
  assert.equal(usage.inputTokens, 12);
  assert.equal(usage.outputTokens, 9);
  assert.equal(usage.cachedTokens, 3);
  assert.equal(usage.totalTokens, 24);
  assert.deepEqual(
    usage.records.map((record) => record.providerRequestId),
    ["cli-tool-request", "cli-final-request"],
  );
  assert.ok(usage.records.every((record) => record.endpointFingerprint.length === 64));
  assert.doesNotMatch(`${planText}\n${usageText}`, new RegExp(cliSecret));
  assert.doesNotMatch(usageText, /127\.0\.0\.1/);
});

test("CLI honors a deterministic environment override over an OpenAI profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-cli-deterministic-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const profilePath = await writeCliFixture(root, "openai-compatible");
  const artifactRoot = join(root, "artifacts");
  const mock = await startPlannerMock();
  t.after(async () => mock.close());

  const result = await runProcess({
    command: process.execPath,
    args: [
      cliPath,
      "plan",
      "--profile",
      profilePath,
      "--workspace",
      root,
      "--artifact-root",
      artifactRoot,
      "--revision",
      "cli-revision",
      "--run-id",
      "cli-deterministic-override",
    ],
    cwd: root,
    env: {
      HYPERTEST_MODEL_PROVIDER: "deterministic",
      HYPERTEST_MODEL_BASE_URL: mock.baseUrl,
      HYPERTEST_MODEL_API_KEY: cliSecret,
    },
    timeoutMs: 10_000,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(mock.requests.length, 0);
  const summary = JSON.parse(result.stdout) as {
    readonly finalState: string;
    readonly modelUsage?: { readonly uri?: string };
  };
  assert.equal(summary.finalState, "planned");
  assert.match(summary.modelUsage?.uri ?? "", /model-usage\.json$/);
  const usage = JSON.parse(
    await readFile(
      join(
        artifactRoot,
        "runs",
        "cli-deterministic-override",
        "artifacts",
        "model-usage.json",
      ),
      "utf8",
    ),
  ) as { readonly providerCalls: number; readonly totalTokens: number };
  assert.equal(usage.providerCalls, 0);
  assert.equal(usage.totalTokens, 0);
});

test("CLI returns a distinct nonzero status when governance needs a human", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-cli-human-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const profilePath = await writeCliFixture(root, "deterministic");
  const gateScript = join(root, "needs-human-gate.mjs");
  await writeFile(
    gateScript,
    `let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const request = JSON.parse(input);
process.stdout.write(JSON.stringify({
  schema: "hypertest.gate-decision/v1",
  requestId: request.requestId,
  requestHash: "non-authorizing-decision",
  verdict: "needs_human",
  receiptId: "human-review-required",
  reasonCodes: ["HUMAN_REVIEW_REQUIRED"],
  obligations: [],
  evidenceHashes: [],
}));
`,
  );
  const profile = JSON.parse(await readFile(profilePath, "utf8")) as Record<
    string,
    unknown
  >;
  profile.gate = {
    mode: "process",
    process: { command: process.execPath, args: [gateScript] },
  };
  await writeFile(profilePath, JSON.stringify(profile));

  const result = await runProcess({
    command: process.execPath,
    args: [
      cliPath,
      "run",
      "--profile",
      profilePath,
      "--workspace",
      root,
      "--artifact-root",
      join(root, "artifacts"),
      "--revision",
      "cli-revision",
      "--run-id",
      "cli-human-review",
    ],
    cwd: root,
    env: { HYPERTEST_MODEL_PROVIDER: "deterministic" },
    timeoutMs: 10_000,
  });

  assert.equal(result.exitCode, 2, result.stderr);
  const summary = JSON.parse(result.stdout) as { readonly finalState: string };
  assert.equal(summary.finalState, "needs_human");
});

test("CLI does not fall back to deterministic when model credentials are missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypertest-cli-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const profilePath = await writeCliFixture(root);
  const result = await runProcess({
    command: process.execPath,
    args: [
      cliPath,
      "plan",
      "--profile",
      profilePath,
      "--workspace",
      root,
      "--revision",
      "cli-revision",
    ],
    cwd: dirname(profilePath),
    env: {
      HYPERTEST_MODEL_ID: "cli-mock-model-2026-08",
      HYPERTEST_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
      HYPERTEST_MODEL_API_KEY: "",
    },
    timeoutMs: 5_000,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /HYPERTEST_MODEL_API_KEY/);
  assert.doesNotMatch(result.stdout, /"finalState":\s*"planned"/);
});
