import assert from "node:assert/strict";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type { Json } from "../src/contracts.js";
import {
  AgentRuntimeError,
  FakeAgentRuntime,
  collectAgentRun,
  type AgentEvent,
  type AgentRunRequest,
} from "../src/runtime.js";
import {
  PiAgentRuntime,
  type PiAgentRuntimeOptions,
} from "../src/runtime/pi/pi-runtime.js";
import { fingerprintEndpoint } from "../src/runtime/usage.js";

const model: PiAgentRuntimeOptions["model"] = {
  id: "budget-model",
  name: "Budget model",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "https://user:password@example.test/v1/?api_key=SECRET",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
};

function request(
  runId: string,
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    runId,
    phase: "budget-test",
    prompt: "Return JSON",
    tools: [],
    artifacts: [],
    tokenBudget: 10,
    deadlineEpochMs: Date.now() + 10_000,
    ...overrides,
  };
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
  },
  responseId: string,
): AssistantMessage {
  const cacheRead = usage.cacheRead ?? 0;
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "budget-model",
    responseId,
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead,
      cacheWrite: 0,
      totalTokens: usage.input + usage.output,
      cost: {
        input: usage.input / 1_000_000,
        output: (usage.output * 2) / 1_000_000,
        cacheRead: cacheRead / 2_000_000,
        cacheWrite: 0,
        total:
          usage.input / 1_000_000 +
          (usage.output * 2) / 1_000_000 +
          cacheRead / 2_000_000,
      },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function emitToolCall(
  stream: AssistantMessageEventStream,
  message: AssistantMessage,
): void {
  const toolCall = message.content[0];
  assert.equal(toolCall?.type, "toolCall");
  if (toolCall?.type !== "toolCall") return;
  stream.push({ type: "start", partial: assistant([], "pending", { input: 0, output: 0 }, "pending") });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
  stream.push({
    type: "toolcall_end",
    contentIndex: 0,
    toolCall,
    partial: message,
  });
  stream.push({ type: "done", reason: "toolUse", message });
}

function emitText(
  stream: AssistantMessageEventStream,
  text: string,
  message: AssistantMessage,
): void {
  stream.push({ type: "start", partial: assistant([], "pending", { input: 0, output: 0 }, "pending") });
  stream.push({ type: "text_start", contentIndex: 0, partial: message });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });
}

async function collectEvents(
  runtime: PiAgentRuntime,
  value: AgentRunRequest,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runtime.run(value)) events.push(event);
  return events;
}

const readTool = {
  name: "contract.get_operation",
  description: "Read one operation",
  inputSchema: {
    type: "object",
    properties: { operationId: { type: "string" } },
    required: ["operationId"],
    additionalProperties: false,
  } satisfies Json,
  idempotent: true,
} as const;

test("deterministic runtime records zero provider calls rather than unavailable usage", async () => {
  const outcome = await collectAgentRun(
    new FakeAgentRuntime({ status: "ok" }),
    request("deterministic-usage"),
  );
  assert.deepEqual(outcome.result, { status: "ok" });
  assert.equal(outcome.usage.providerCalls, 0);
  assert.equal(outcome.usage.usageUnavailableCalls, 0);
  assert.equal(outcome.usage.totalTokens, 0);
  assert.equal(outcome.usage.estimatedCostUsd, 0);
});

test("aggregates multi-turn usage and shrinks the next output limit to the remaining budget", async () => {
  let call = 0;
  const maxTokens: number[] = [];
  const runtime = new PiAgentRuntime({
    model,
    streamFn: (_model, context, options?: SimpleStreamOptions) => {
      maxTokens.push(options?.maxTokens ?? -1);
      const stream = createAssistantMessageEventStream();
      const current = call;
      call += 1;
      queueMicrotask(() => {
        if (current === 0) {
          emitToolCall(
            stream,
            assistant(
              [
                {
                  type: "toolCall",
                  id: "read-1",
                  name: readTool.name,
                  arguments: { operationId: "read" },
                },
              ],
              "toolUse",
              { input: 4, output: 3, cacheRead: 2 },
              "provider-request-1",
            ),
          );
        } else {
          assert.equal(context.messages.at(-1)?.role, "toolResult");
          emitText(
            stream,
            '{"cases":[]}',
            assistant(
              [{ type: "text", text: '{"cases":[]}' }],
              "stop",
              { input: 2, output: 1, cacheRead: 1 },
              "provider-request-2",
            ),
          );
        }
      });
      return stream;
    },
    toolExecutor: async () => ({ operationId: "read", effects: "read" }),
    getProviderTelemetry: (message) => ({
      retryCount: message?.responseId === "provider-request-1" ? 2 : 0,
      latencyMs: message?.responseId === "provider-request-1" ? 5 : 7,
    }),
  });

  const outcome = await collectAgentRun(
    runtime,
    request("multi-turn-budget", {
      tools: [readTool],
      maxOutputTokens: 8,
    }),
  );

  assert.deepEqual(outcome.result, { cases: [] });
  assert.deepEqual(maxTokens, [8, 3]);
  assert.equal(outcome.usage.providerCalls, 2);
  assert.equal(outcome.usage.usageUnavailableCalls, 0);
  assert.equal(outcome.usage.inputTokens, 6);
  assert.equal(outcome.usage.outputTokens, 4);
  assert.equal(outcome.usage.cachedTokens, 3);
  assert.equal(outcome.usage.totalTokens, 10);
  assert.equal(outcome.usage.retryCount, 2);
  assert.equal(outcome.usage.totalLatencyMs, 12);
  assert.equal(outcome.usage.records[0]?.providerRequestId, "provider-request-1");
  assert.equal(
    outcome.usage.records[0]?.endpointFingerprint,
    fingerprintEndpoint(model.baseUrl),
  );
  const serialized = JSON.stringify(outcome.usage);
  assert.doesNotMatch(serialized, /SECRET|password|api_key|Authorization/i);
});

test("reaching the reported budget prevents a second provider turn", async () => {
  let providerCalls = 0;
  let toolCalls = 0;
  const runtime = new PiAgentRuntime({
    model,
    streamFn: () => {
      providerCalls += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        emitToolCall(
          stream,
          assistant(
            [
              {
                type: "toolCall",
                id: "budget-call",
                name: readTool.name,
                arguments: { operationId: "read" },
              },
            ],
            "toolUse",
            { input: 6, output: 4 },
            "budget-request",
          ),
        ),
      );
      return stream;
    },
    toolExecutor: async () => {
      toolCalls += 1;
      return { operationId: "read" };
    },
  });

  const events = await collectEvents(
    runtime,
    request("budget-exhausted", { tools: [readTool] }),
  );
  assert.equal(providerCalls, 1);
  assert.equal(toolCalls, 1);
  assert.equal(events.filter((event) => event.type === "usage").length, 1);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "failed");
  if (terminal?.type === "failed") {
    assert.equal(terminal.code, "budget_exhausted");
  }
});

test("an unavailable provider usage report is distinct and blocks an unbounded next turn", async () => {
  let providerCalls = 0;
  const runtime = new PiAgentRuntime({
    model,
    streamFn: () => {
      providerCalls += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        emitToolCall(
          stream,
          assistant(
            [
              {
                type: "toolCall",
                id: "unknown-usage",
                name: readTool.name,
                arguments: { operationId: "read" },
              },
            ],
            "toolUse",
            { input: 0, output: 0 },
            "unknown-usage-request",
          ),
        ),
      );
      return stream;
    },
    toolExecutor: async () => ({ operationId: "read" }),
  });

  await assert.rejects(
    collectAgentRun(
      runtime,
      request("usage-unavailable", { tools: [readTool] }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AgentRuntimeError);
      assert.equal(error.failure.code, "budget_exhausted");
      assert.equal(error.usage?.providerCalls, 1);
      assert.equal(error.usage?.usageUnavailableCalls, 1);
      assert.equal(error.usage?.records[0]?.inputTokens, undefined);
      return true;
    },
  );
  assert.equal(providerCalls, 1);
});
