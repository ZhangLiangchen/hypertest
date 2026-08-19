import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { Json } from "../src/contracts.js";
import {
  AgentRuntimeError,
  collectAgentRun,
  type AgentEvent,
  type AgentRunRequest,
} from "../src/runtime.js";
import { createOpenAICompatibleRuntime } from "../src/runtime/pi/openai-compatible.js";

interface RecordedRequest {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

interface MockServer {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

type RequestHandler = (
  request: RecordedRequest,
  response: ServerResponse,
  index: number,
  incoming: IncomingMessage,
) => void | Promise<void>;

const apiKey = "integration-secret-key";

function runtimeConfig(baseUrl: string, overrides: Partial<{
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
}> = {}) {
  return {
    provider: "openai-compatible" as const,
    modelId: "mock-model-2026-08",
    baseUrl,
    apiKey,
    timeoutMs: overrides.timeoutMs ?? 1_000,
    maxRetries: overrides.maxRetries ?? 2,
    maxOutputTokens: overrides.maxOutputTokens ?? 256,
  };
}

function request(
  runId: string,
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    runId,
    phase: "protocol-integration",
    prompt: "Return the requested JSON",
    tools: [],
    artifacts: [],
    tokenBudget: 1_000,
    deadlineEpochMs: Date.now() + 5_000,
    expectedResultSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
    ...overrides,
  };
}

async function startMockServer(handler: RequestHandler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (incoming, response) => {
    let text = "";
    for await (const chunk of incoming) text += String(chunk);
    const body = text.length === 0
      ? {}
      : JSON.parse(text) as Record<string, unknown>;
    const recorded: RecordedRequest = {
      url: incoming.url ?? "",
      headers: incoming.headers,
      body,
    };
    const index = requests.length;
    requests.push(recorded);
    try {
      await handler(recorded, response, index, incoming);
    } catch (error) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
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

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  server.close();
  await once(server, "close");
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

function writeSse(response: ServerResponse, value: Json): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function finishSse(response: ServerResponse): void {
  response.end("data: [DONE]\n\n");
}

function textChunk(
  id: string,
  content: string | undefined,
  finishReason: string | null = null,
  usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cachedTokens?: number;
  },
): Json {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model-2026-08",
    choices: [
      {
        index: 0,
        delta: content === undefined ? {} : { content },
        finish_reason: finishReason,
      },
    ],
    ...(usage === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.promptTokens + usage.completionTokens,
            prompt_tokens_details: {
              cached_tokens: usage.cachedTokens ?? 0,
            },
          },
        }),
  };
}

function sendTextResponse(
  response: ServerResponse,
  parts: readonly string[],
  requestId: string,
  usage = { promptTokens: 4, completionTokens: 2, cachedTokens: 1 },
): void {
  openSse(response, requestId);
  for (const part of parts) writeSse(response, textChunk(requestId, part));
  writeSse(response, textChunk(requestId, undefined, "stop", usage));
  finishSse(response);
}

async function collectEvents(
  runtime: ReturnType<typeof createOpenAICompatibleRuntime>,
  value: AgentRunRequest,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runtime.run(value)) events.push(event);
  return events;
}

test("runtime factory rejects plaintext remote endpoints even when called directly", () => {
  assert.throws(
    () =>
      createOpenAICompatibleRuntime(
        runtimeConfig("http://provider.example.test/v1"),
      ),
    /must use https unless it targets localhost/,
  );
});

test("real SSE yields a text delta before the HTTP response closes", async () => {
  let releaseResponse: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let firstDeltaSent: (() => void) | undefined;
  const firstSent = new Promise<void>((resolve) => {
    firstDeltaSent = resolve;
  });
  const mock = await startMockServer(async (_request, response) => {
    openSse(response, "stream-live");
    writeSse(response, textChunk("stream-live", '{"ok":'));
    firstDeltaSent?.();
    await released;
    writeSse(response, textChunk("stream-live", "true}"));
    writeSse(
      response,
      textChunk("stream-live", undefined, "stop", {
        promptTokens: 2,
        completionTokens: 2,
      }),
    );
    finishSse(response);
  });
  try {
    const runtime = createOpenAICompatibleRuntime(runtimeConfig(mock.baseUrl));
    const iterator = runtime.run(request("real-live-stream"))[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "started");
    await firstSent;
    assert.deepEqual(await iterator.next(), {
      done: false,
      value: { type: "text_delta", text: '{"ok":' },
    });
    assert.equal(mock.requests.length, 1);
    releaseResponse?.();
    const remaining: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    assert.ok(remaining.some((event) => event.type === "completed"));
  } finally {
    releaseResponse?.();
    await mock.close();
  }
});

test("concurrent runs bind telemetry to the matching final message", async () => {
  let markFirstSeen: (() => void) | undefined;
  const firstSeen = new Promise<void>((resolve) => {
    markFirstSeen = resolve;
  });
  let releaseFirst: (() => void) | undefined;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const mock = await startMockServer(async (_request, response, index) => {
    if (index === 0) {
      markFirstSeen?.();
      await firstReleased;
      sendTextResponse(response, ['{"ok":true}'], "request-A");
      return;
    }
    sendTextResponse(response, ['{"ok":true}'], "request-B");
  });
  try {
    const runtime = createOpenAICompatibleRuntime(runtimeConfig(mock.baseUrl));
    const firstOutcomePromise = collectAgentRun(
      runtime,
      request("concurrent-A"),
    );
    await firstSeen;
    const secondOutcome = await collectAgentRun(
      runtime,
      request("concurrent-B"),
    );
    releaseFirst?.();
    const firstOutcome = await firstOutcomePromise;

    assert.equal(mock.requests.length, 2);
    assert.equal(
      firstOutcome.usage.records[0]?.providerRequestId,
      "request-A",
    );
    assert.equal(
      secondOutcome.usage.records[0]?.providerRequestId,
      "request-B",
    );
  } finally {
    releaseFirst?.();
    await mock.close();
  }
});

test("real protocol closes a tool loop with incremental tool fields and usage", async () => {
  const mock = await startMockServer((requestValue, response, index) => {
    if (index === 0) {
      openSse(response, "request-tool");
      writeSse(response, {
        id: "chat-tool",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock-model-2026-08",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-real-1",
                  type: "function",
                  function: { name: "", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      writeSse(response, {
        id: "chat-tool",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock-model-2026-08",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    name: "contract.get_operation",
                    arguments: '{"operation',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      writeSse(response, {
        id: "chat-tool",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock-model-2026-08",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'Id":"read"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      writeSse(response, {
        id: "chat-tool",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock-model-2026-08",
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls" },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 3,
          total_tokens: 8,
          prompt_tokens_details: { cached_tokens: 1 },
        },
      });
      finishSse(response);
      return;
    }

    const messages = requestValue.body.messages as Array<Record<string, unknown>>;
    assert.equal(messages.at(-1)?.role, "tool");
    assert.equal(messages.at(-1)?.tool_call_id, "call-real-1");
    sendTextResponse(
      response,
      ['{"ok":', "true}"],
      "request-final",
      { promptTokens: 8, completionTokens: 2, cachedTokens: 2 },
    );
  });
  try {
    let executions = 0;
    const runtime = createOpenAICompatibleRuntime(runtimeConfig(mock.baseUrl));
    const events: AgentEvent[] = [];
    const outcome = await collectAgentRun(
      runtime,
      request("real-tool-loop", {
        tools: [
          {
            name: "contract.get_operation",
            description: "Read one operation",
            inputSchema: {
              type: "object",
              properties: { operationId: { type: "string" } },
              required: ["operationId"],
              additionalProperties: false,
            },
            idempotent: true,
          },
        ],
        toolExecutor: async ({ name, callId, input }) => {
          executions += 1;
          assert.equal(name, "contract.get_operation");
          assert.equal(callId, "call-real-1");
          assert.deepEqual(input, { operationId: "read" });
          return {
            status: "ok",
            output: { operationId: "read", effects: "read" },
          };
        },
      }),
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    assert.deepEqual(outcome.result, { ok: true });
    assert.equal(executions, 1);
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[0]?.url, "/v1/chat/completions");
    assert.equal(mock.requests[0]?.headers.authorization, `Bearer ${apiKey}`);
    assert.equal(mock.requests[0]?.body.model, "mock-model-2026-08");
    assert.equal(mock.requests[0]?.body.stream, true);
    assert.deepEqual(
      events
        .filter(
          (event) =>
            event.type === "tool_requested" || event.type === "tool_completed",
        )
        .map((event) => ({ type: event.type, callId: event.callId })),
      [
        { type: "tool_requested", callId: "call-real-1" },
        { type: "tool_completed", callId: "call-real-1" },
      ],
    );
    assert.equal(outcome.usage.providerCalls, 2);
    assert.equal(outcome.usage.cachedTokens, 3);
    assert.equal(outcome.usage.retryCount, 0);
    assert.deepEqual(
      outcome.usage.records.map((record) => record.providerRequestId),
      ["request-tool", "request-final"],
    );
    assert.doesNotMatch(JSON.stringify(outcome.usage), /integration-secret-key/);
    assert.doesNotMatch(JSON.stringify(outcome.usage), /127\.0\.0\.1/);
  } finally {
    await mock.close();
  }
});

test("empty, invalid and schema-mismatched model output fail closed over HTTP", async () => {
  const cases = [
    { name: "empty", parts: [] as string[], code: "model_output_parse_error" },
    { name: "invalid", parts: ["not-json"], code: "model_output_parse_error" },
    {
      name: "schema",
      parts: ['{"unexpected":true}'],
      code: "model_output_schema_error",
    },
  ] as const;
  for (const scenario of cases) {
    const mock = await startMockServer((_request, response) => {
      sendTextResponse(response, scenario.parts, `request-${scenario.name}`);
    });
    try {
      const runtime = createOpenAICompatibleRuntime(runtimeConfig(mock.baseUrl));
      const events = await collectEvents(runtime, request(`http-${scenario.name}`));
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "failed", scenario.name);
      if (terminal?.type === "failed") {
        assert.equal(terminal.code, scenario.code, scenario.name);
      }
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
    }
  }
});

test("429 and 503 retry before output while 400 does not retry", async () => {
  const scenarios = [
    { status: 429, retry: true },
    { status: 503, retry: true },
    { status: 400, retry: false },
  ] as const;
  for (const scenario of scenarios) {
    const mock = await startMockServer((_request, response, index) => {
      if (index === 0) {
        response.writeHead(scenario.status, {
          "content-type": "application/json",
          "retry-after": "0",
          "x-request-id": `failed-${scenario.status}`,
        });
        response.end(
          JSON.stringify({ error: { message: `status ${scenario.status}` } }),
        );
        return;
      }
      sendTextResponse(response, ['{"ok":true}'], `success-${scenario.status}`);
    });
    try {
      const runtime = createOpenAICompatibleRuntime(
        runtimeConfig(mock.baseUrl, { maxRetries: 1 }),
      );
      if (scenario.retry) {
        const outcome = await collectAgentRun(
          runtime,
          request(`retry-${scenario.status}`),
        );
        assert.equal(mock.requests.length, 2);
        assert.equal(outcome.usage.providerCalls, mock.requests.length);
        assert.equal(outcome.usage.retryCount, 1);
        assert.equal(outcome.usage.records[0]?.usageUnavailable, true);
        assert.equal(
          outcome.usage.records[0]?.providerRequestId,
          `failed-${scenario.status}`,
        );
        assert.equal(outcome.usage.records[1]?.retryCount, 1);
        assert.equal(
          outcome.usage.records[1]?.providerRequestId,
          `success-${scenario.status}`,
        );
      } else {
        await assert.rejects(
          collectAgentRun(runtime, request(`retry-${scenario.status}`)),
          (error: unknown) => {
            assert.ok(error instanceof AgentRuntimeError);
            assert.equal(error.failure.code, "provider_error");
            assert.equal(error.failure.retryable, false);
            assert.equal(error.usage?.providerCalls, 1);
            return true;
          },
        );
        assert.equal(mock.requests.length, 1);
      }
    } finally {
      await mock.close();
    }
  }
});

test("unknown usage from a retry attempt blocks a later Provider turn", async () => {
  const mock = await startMockServer((_request, response, index) => {
    if (index === 0) {
      response.writeHead(503, {
        "content-type": "application/json",
        "retry-after": "0",
        "x-request-id": "unknown-retry-attempt",
      });
      response.end(JSON.stringify({ error: { message: "temporary" } }));
      return;
    }
    if (index === 1) {
      sendToolResponse(
        response,
        "retry-tool-call",
        "contract.get_operation",
        { operationId: "read" },
        "known-tool-attempt",
      );
      return;
    }
    sendTextResponse(response, ['{"ok":true}'], "forbidden-third-call");
  });
  try {
    let executions = 0;
    const runtime = createOpenAICompatibleRuntime(
      runtimeConfig(mock.baseUrl, { maxRetries: 1 }),
    );
    await assert.rejects(
      collectAgentRun(
        runtime,
        request("retry-usage-unknown", {
          tools: [
            {
              name: "contract.get_operation",
              description: "Read one operation",
              inputSchema: {
                type: "object",
                properties: { operationId: { type: "string" } },
                required: ["operationId"],
                additionalProperties: false,
              },
              idempotent: true,
            },
          ],
          toolExecutor: async () => {
            executions += 1;
            return { status: "ok", output: { operationId: "read" } };
          },
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof AgentRuntimeError);
        assert.equal(error.failure.code, "budget_exhausted");
        assert.equal(error.usage?.providerCalls, 2);
        assert.equal(error.usage?.usageUnavailableCalls, 1);
        return true;
      },
    );
    assert.equal(mock.requests.length, 2);
    assert.equal(executions, 1);
  } finally {
    await mock.close();
  }
});

test("cancellation after a retry records every physical Provider attempt", async () => {
  let secondRequestSeen: (() => void) | undefined;
  const secondSeen = new Promise<void>((resolve) => {
    secondRequestSeen = resolve;
  });
  const mock = await startMockServer((_request, response, index) => {
    if (index === 0) {
      response.writeHead(503, {
        "content-type": "application/json",
        "x-request-id": "cancel-retry-1",
      });
      response.end(JSON.stringify({ error: { message: "temporary" } }));
      return;
    }
    openSse(response, "cancel-retry-2");
    secondRequestSeen?.();
  });
  try {
    const runtime = createOpenAICompatibleRuntime(
      runtimeConfig(mock.baseUrl, { maxRetries: 1, timeoutMs: 2_000 }),
    );
    const iterator = runtime
      .run(request("cancel-after-retry"))
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "started");
    await secondSeen;
    await runtime.cancel("cancel-after-retry");
    const events: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    const usage = events.filter(
      (event): event is Extract<AgentEvent, { type: "usage" }> =>
        event.type === "usage",
    );
    assert.equal(mock.requests.length, 2);
    assert.equal(usage.length, mock.requests.length);
    assert.equal(
      usage.filter((event) => event.usage.usageUnavailable).length,
      2,
    );
    assert.equal(events.at(-1)?.type, "failed");
    const terminal = events.at(-1);
    if (terminal?.type === "failed") assert.equal(terminal.code, "cancelled");
  } finally {
    await mock.close();
  }
});

test("Retry-After cannot delay a bounded retry beyond the runtime cap", async () => {
  const mock = await startMockServer((_request, response, index) => {
    if (index === 0) {
      response.writeHead(503, {
        "content-type": "application/json",
        "retry-after": "3600",
        "x-request-id": "retry-after-capped",
      });
      response.end(JSON.stringify({ error: { message: "temporary" } }));
      return;
    }
    sendTextResponse(response, ['{"ok":true}'], "retry-after-success");
  });
  try {
    const runtime = createOpenAICompatibleRuntime(
      runtimeConfig(mock.baseUrl, { maxRetries: 1, timeoutMs: 3_000 }),
    );
    const outcome = await collectAgentRun(
      runtime,
      request("retry-after-cap", { deadlineEpochMs: Date.now() + 4_500 }),
    );
    assert.equal(mock.requests.length, 2);
    assert.equal(outcome.usage.providerCalls, mock.requests.length);
    assert.equal(outcome.usage.retryCount, 1);
  } finally {
    await mock.close();
  }
});

function sendToolResponse(
  response: ServerResponse,
  callId: string,
  name: string,
  input: Record<string, Json>,
  requestId: string,
): void {
  openSse(response, requestId);
  writeSse(response, {
    id: requestId,
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model-2026-08",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: callId,
              type: "function",
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  writeSse(response, {
    id: requestId,
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model-2026-08",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: {
      prompt_tokens: 2,
      completion_tokens: 2,
      total_tokens: 4,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  });
  finishSse(response);
}

test("connection failures retry only before the first visible delta", async () => {
  const preVisibleScenarios = ["before-headers", "after-headers"] as const;
  for (const scenario of preVisibleScenarios) {
    const mock = await startMockServer((_request, response, index) => {
      if (index === 0) {
        if (scenario === "after-headers") {
          openSse(response, `interrupted-${scenario}`);
          response.write(": connected\n\n");
        }
        response.destroy();
        return;
      }
      sendTextResponse(response, ['{"ok":true}'], `recovered-${scenario}`);
    });
    try {
      const runtime = createOpenAICompatibleRuntime(
        runtimeConfig(mock.baseUrl, { maxRetries: 1 }),
      );
      const outcome = await collectAgentRun(
        runtime,
        request(`network-${scenario}`),
      );
      assert.equal(mock.requests.length, 2, scenario);
      assert.equal(outcome.usage.providerCalls, mock.requests.length, scenario);
      assert.equal(outcome.usage.retryCount, 1, scenario);
      assert.deepEqual(
        outcome.usage.records.map((record) => record.retryCount),
        [0, 1],
        scenario,
      );
    } finally {
      await mock.close();
    }
  }

  const mock = await startMockServer((_request, response) => {
    openSse(response, "visible-interruption");
    writeSse(response, textChunk("visible-interruption", '{"ok":'));
    setImmediate(() => response.destroy());
  });
  try {
    const runtime = createOpenAICompatibleRuntime(
      runtimeConfig(mock.baseUrl, { maxRetries: 3 }),
    );
    const events = await collectEvents(runtime, request("network-after-delta"));
    assert.equal(mock.requests.length, 1);
    assert.ok(events.some((event) => event.type === "text_delta"));
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "failed");
    if (terminal?.type === "failed") {
      assert.equal(terminal.code, "provider_error");
      assert.equal(terminal.retryable, false);
    }
  } finally {
    await mock.close();
  }
});

test("a provider failure after tool execution is not retried or re-executed", async () => {
  const mock = await startMockServer((_request, response, index) => {
    if (index === 0) {
      sendToolResponse(
        response,
        "single-tool-call",
        "contract.get_operation",
        { operationId: "read" },
        "tool-before-failure",
      );
      return;
    }
    response.writeHead(503, {
      "content-type": "application/json",
      "retry-after": "0",
      "x-request-id": "after-tool-503",
    });
    response.end(JSON.stringify({ error: { message: "temporary" } }));
  });
  try {
    let executions = 0;
    const runtime = createOpenAICompatibleRuntime(
      runtimeConfig(mock.baseUrl, { maxRetries: 3 }),
    );
    const events = await collectEvents(
      runtime,
      request("no-retry-after-tool", {
        tools: [
          {
            name: "contract.get_operation",
            description: "Read one operation",
            inputSchema: {
              type: "object",
              properties: { operationId: { type: "string" } },
              required: ["operationId"],
              additionalProperties: false,
            },
            idempotent: true,
          },
        ],
        toolExecutor: async () => {
          executions += 1;
          return { status: "ok", output: { operationId: "read" } };
        },
      }),
    );
    assert.equal(mock.requests.length, 2);
    assert.equal(executions, 1);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "failed");
    if (terminal?.type === "failed") assert.equal(terminal.retryable, false);
    const usage = events.filter((event) => event.type === "usage");
    assert.equal(usage.length, 2);
    assert.equal(usage[1]?.type, "usage");
    if (usage[1]?.type === "usage") assert.equal(usage[1].usage.retryCount, 0);
  } finally {
    await mock.close();
  }
});

test("real HTTP requests obey deadline and cancellation", async () => {
  let requestSeen: (() => void) | undefined;
  const seen = new Promise<void>((resolve) => {
    requestSeen = resolve;
  });
  const deadlineMock = await startMockServer(() => {
    requestSeen?.();
  });
  try {
    const runtime = createOpenAICompatibleRuntime(
      runtimeConfig(deadlineMock.baseUrl, { timeoutMs: 1_000 }),
    );
    const startedAt = Date.now();
    const events = await collectEvents(
      runtime,
      request("http-deadline", { deadlineEpochMs: Date.now() + 40 }),
    );
    await seen;
    assert.ok(Date.now() - startedAt < 500);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "failed");
    if (terminal?.type === "failed") {
      assert.equal(terminal.code, "deadline_exceeded");
    }
  } finally {
    await deadlineMock.close();
  }

  let cancelRequestSeen: (() => void) | undefined;
  const cancelSeen = new Promise<void>((resolve) => {
    cancelRequestSeen = resolve;
  });
  const cancelMock = await startMockServer(() => {
    cancelRequestSeen?.();
  });
  try {
    const runtime = createOpenAICompatibleRuntime(
      runtimeConfig(cancelMock.baseUrl, { timeoutMs: 1_000 }),
    );
    const iterator = runtime.run(request("http-cancel"))[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "started");
    await cancelSeen;
    await runtime.cancel("http-cancel");
    const events: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "failed");
    if (terminal?.type === "failed") assert.equal(terminal.code, "cancelled");
  } finally {
    await cancelMock.close();
  }
});

test("real protocol enforces output and tool-loop limits", async () => {
  const floodMock = await startMockServer((_request, response) => {
    sendTextResponse(response, [`{"ok":true,"padding":"${"x".repeat(2_000)}"}`], "flood");
  });
  try {
    const runtime = createOpenAICompatibleRuntime(runtimeConfig(floodMock.baseUrl));
    const events = await collectEvents(
      runtime,
      request("http-output-limit", { maxOutputBytes: 64 }),
    );
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "failed");
    if (terminal?.type === "failed") assert.equal(terminal.code, "output_limit");
  } finally {
    await floodMock.close();
  }

  const loopMock = await startMockServer((_request, response, index) => {
    sendToolResponse(
      response,
      `loop-call-${index}`,
      "contract.get_operation",
      { operationId: `read-${index}` },
      `loop-request-${index}`,
    );
  });
  try {
    let executions = 0;
    const runtime = createOpenAICompatibleRuntime(runtimeConfig(loopMock.baseUrl));
    const events = await collectEvents(
      runtime,
      request("http-tool-loop", {
        tools: [
          {
            name: "contract.get_operation",
            description: "Read one operation",
            inputSchema: {
              type: "object",
              properties: { operationId: { type: "string" } },
              required: ["operationId"],
              additionalProperties: false,
            },
            idempotent: true,
          },
        ],
        toolExecutor: async ({ input }) => {
          executions += 1;
          return { status: "ok", output: input };
        },
        maxTurns: 10,
        maxToolCalls: 2,
        maxRepeatedToolCalls: 10,
      }),
    );
    assert.equal(loopMock.requests.length, 3);
    assert.equal(executions, 2);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "failed");
    if (terminal?.type === "failed") assert.equal(terminal.code, "tool_loop_limit");
  } finally {
    await loopMock.close();
  }
});

test("incremental tool id and name metadata obey the output limit", async () => {
  const mock = await startMockServer((_request, response) => {
    openSse(response, "late-tool-metadata");
    writeSse(response, {
      id: "late-tool-metadata",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock-model-2026-08",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, type: "function", function: { arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    writeSse(response, {
      id: "late-tool-metadata",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock-model-2026-08",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "x".repeat(100),
                type: "function",
                function: {
                  name: "contract.get_operation",
                  arguments: "",
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    finishSse(response);
  });
  try {
    const runtime = createOpenAICompatibleRuntime(runtimeConfig(mock.baseUrl));
    const events = await collectEvents(
      runtime,
      request("late-tool-metadata-limit", { maxOutputBytes: 32 }),
    );
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "failed");
    if (terminal?.type === "failed") assert.equal(terminal.code, "output_limit");
  } finally {
    await mock.close();
  }
});

test("redirects are rejected without follow-up or retry", async () => {
  const mock = await startMockServer((_request, response) => {
    response.writeHead(302, {
      location: "/redirect-target",
      "content-type": "text/plain",
    });
    response.end("redirect body must not be surfaced");
  });
  try {
    const runtime = createOpenAICompatibleRuntime(
      runtimeConfig(mock.baseUrl, { maxRetries: 3 }),
    );
    const events = await collectEvents(runtime, request("redirect-rejected"));
    assert.equal(mock.requests.length, 1);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "failed");
    if (terminal?.type === "failed") {
      assert.equal(terminal.code, "provider_protocol_error");
      assert.equal(terminal.retryable, false);
    }
    assert.doesNotMatch(JSON.stringify(events), /redirect body must not/);
  } finally {
    await mock.close();
  }
});

test("oversized complete and pending SSE events fail closed", async () => {
  for (const kind of ["complete", "pending"] as const) {
    const mock = await startMockServer((_request, response) => {
      openSse(response, `oversized-${kind}`);
      const payload = "x".repeat(1_048_577);
      if (kind === "complete") {
        response.end(`data: ${JSON.stringify({ payload })}\n\n`);
      } else {
        response.end(`data: ${payload}`);
      }
    });
    try {
      const runtime = createOpenAICompatibleRuntime(
        runtimeConfig(mock.baseUrl, { maxRetries: 3 }),
      );
      const events = await collectEvents(
        runtime,
        request(`oversized-sse-${kind}`),
      );
      assert.equal(mock.requests.length, 1, kind);
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "failed", kind);
      if (terminal?.type === "failed") {
        assert.equal(terminal.code, "provider_protocol_error", kind);
        assert.equal(terminal.retryable, false, kind);
      }
    } finally {
      await mock.close();
    }
  }
});

test("protocol and authentication failures are non-retryable and redacted", async () => {
  const malformed = await startMockServer((_request, response) => {
    openSse(response, "malformed-sse");
    response.end("data: {not-json}\n\n");
  });
  try {
    const runtime = createOpenAICompatibleRuntime(
      runtimeConfig(malformed.baseUrl, { maxRetries: 3 }),
    );
    const events = await collectEvents(runtime, request("malformed-sse"));
    assert.equal(malformed.requests.length, 1);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "failed");
    if (terminal?.type === "failed") {
      assert.equal(terminal.code, "provider_protocol_error");
      assert.equal(terminal.retryable, false);
    }
  } finally {
    await malformed.close();
  }

  for (const status of [401, 403] as const) {
    const secretBody = `provider-body-secret-${status}`;
    const authMock = await startMockServer((_request, response) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "x-request-id": status === 401 ? apiKey : `auth-${status}`,
      });
      response.end(
        JSON.stringify({ error: { message: `${secretBody}:${apiKey}` } }),
      );
    });
    try {
      const runtime = createOpenAICompatibleRuntime(
        runtimeConfig(authMock.baseUrl, { maxRetries: 3 }),
      );
      const events = await collectEvents(runtime, request(`auth-${status}`));
      assert.equal(authMock.requests.length, 1);
      assert.equal(authMock.requests[0]?.headers.authorization, `Bearer ${apiKey}`);
      const serialized = JSON.stringify(events);
      assert.doesNotMatch(serialized, new RegExp(apiKey));
      assert.doesNotMatch(serialized, new RegExp(secretBody));
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "failed");
      if (terminal?.type === "failed") {
        assert.equal(terminal.code, "provider_error");
        assert.equal(terminal.retryable, false);
        assert.equal(
          terminal.providerRequestId,
          status === 401 ? undefined : `auth-${status}`,
        );
      }
    } finally {
      await authMock.close();
    }
  }
});

test("provider response-id fallback rejects secrets and non-schema identifiers", async () => {
  const scenarios = [
    { name: "secret", responseId: apiKey },
    { name: "oversize", responseId: "x".repeat(129) },
    { name: "whitespace", responseId: "request id" },
    { name: "control", responseId: "request-\u0001id" },
  ] as const;
  for (const scenario of scenarios) {
    const mock = await startMockServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      writeSse(response, textChunk(scenario.responseId, '{"ok":true}'));
      writeSse(
        response,
        textChunk(scenario.responseId, undefined, "stop", {
          promptTokens: 1,
          completionTokens: 1,
        }),
      );
      finishSse(response);
    });
    try {
      const runtime = createOpenAICompatibleRuntime(runtimeConfig(mock.baseUrl));
      const outcome = await collectAgentRun(
        runtime,
        request(`invalid-response-id-${scenario.name}`),
      );
      assert.equal(
        outcome.usage.records[0]?.providerRequestId,
        undefined,
        scenario.name,
      );
      assert.doesNotMatch(
        JSON.stringify(outcome),
        new RegExp(escapeRegExp(scenario.responseId)),
        scenario.name,
      );
    } finally {
      await mock.close();
    }
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
