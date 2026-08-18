import assert from "node:assert/strict";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type { Json } from "../src/contracts.js";
import type { AgentEvent, AgentRunRequest } from "../src/runtime.js";
import { AgentRuntimeError } from "../src/runtime.js";
import {
  PiAgentRuntime,
  type PiAgentRuntimeOptions,
} from "../src/runtime/pi/pi-runtime.js";

const model: PiAgentRuntimeOptions["model"] = {
  id: "mock-model",
  name: "Mock model",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://127.0.0.1.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
};

function request(
  runId: string,
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    runId,
    phase: "test",
    prompt: "Return JSON",
    tools: [],
    artifacts: [],
    tokenBudget: 100,
    deadlineEpochMs: Date.now() + 10_000,
    ...overrides,
  };
}

function message(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "mock-model",
    usage: {
      input: 1,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 4,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
    ...overrides,
  };
}

interface ControlledStream {
  readonly stream: AssistantMessageEventStream;
  readonly options: SimpleStreamOptions | undefined;
}

function controlledStreamFn(): {
  readonly streamFn: PiAgentRuntimeOptions["streamFn"];
  readonly next: () => Promise<ControlledStream>;
} {
  const pending: Array<(value: ControlledStream) => void> = [];
  const ready: ControlledStream[] = [];
  return {
    streamFn: (_model, _context, options) => {
      const value = { stream: createAssistantMessageEventStream(), options };
      const waiter = pending.shift();
      if (waiter === undefined) ready.push(value);
      else waiter(value);
      return value.stream;
    },
    next: async () => {
      const value = ready.shift();
      if (value !== undefined) return value;
      return new Promise<ControlledStream>((resolve) => pending.push(resolve));
    },
  };
}

function emitText(
  stream: AssistantMessageEventStream,
  text: string,
  finish = true,
): void {
  const partial = message([], "pending");
  const final = message([{ type: "text", text }], finish ? "stop" : "pending");
  stream.push({ type: "start", partial });
  stream.push({ type: "text_start", contentIndex: 0, partial: final });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: final });
  if (finish) {
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: final });
    stream.push({ type: "done", reason: "stop", message: final });
  }
}

async function collect(runtime: PiAgentRuntime, value: AgentRunRequest): Promise<AgentEvent[]> {
  const output: AgentEvent[] = [];
  for await (const event of runtime.run(value)) output.push(event);
  return output;
}

async function withTimeout<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("streams the first text delta before the provider turn finishes", async () => {
  const controlled = controlledStreamFn();
  const runtime = new PiAgentRuntime({ model, streamFn: controlled.streamFn });
  const iterator = runtime.run(request("live-stream"))[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "started", runId: "live-stream" },
  });
  const provider = await controlled.next();
  let providerFinished = false;
  void provider.stream.result().then(() => {
    providerFinished = true;
  });
  emitText(provider.stream, '{"live":', false);

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text_delta", text: '{"live":' },
  });
  assert.equal(providerFinished, false);

  const final = message([{ type: "text", text: '{"live":true}' }], "stop");
  provider.stream.push({
    type: "text_delta",
    contentIndex: 0,
    delta: "true}",
    partial: final,
  });
  provider.stream.push({
    type: "text_end",
    contentIndex: 0,
    content: '{"live":true}',
    partial: final,
  });
  provider.stream.push({ type: "done", reason: "stop", message: final });

  assert.deepEqual((await iterator.next()).value, {
    type: "text_delta",
    text: "true}",
  });
  assert.deepEqual((await iterator.next()).value, {
    type: "completed",
    result: { live: true },
  });
  assert.equal((await iterator.next()).done, true);
  assert.equal(providerFinished, true);
});

test("makes a tool request visible before execution and pairs call ids", async () => {
  let call = 0;
  let executorStarted = false;
  const runtime = new PiAgentRuntime({
    model,
    streamFn: (_model, context) => {
      const stream = createAssistantMessageEventStream();
      const current = call;
      call += 1;
      queueMicrotask(() => {
        if (current === 0) {
          const toolCall = {
            type: "toolCall" as const,
            id: "call-1",
            name: "contract.get_operation",
            arguments: { operationId: "read" },
          };
          const assistant = message([toolCall], "toolUse");
          stream.push({ type: "start", partial: message([], "pending") });
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: assistant });
          stream.push({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall,
            partial: assistant,
          });
          stream.push({ type: "done", reason: "toolUse", message: assistant });
        } else {
          assert.equal(context.messages.at(-1)?.role, "toolResult");
          emitText(stream, '{"cases":[]}');
        }
      });
      return stream;
    },
    toolExecutor: async ({ callId, input }) => {
      executorStarted = true;
      assert.equal(callId, "call-1");
      assert.deepEqual(input, { operationId: "read" });
      return { operationId: "read", effects: "read" };
    },
  });
  const iterator = runtime.run(
    request("tool-order", {
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
    }),
  )[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.type, "started");
  const requested = await iterator.next();
  assert.deepEqual(requested.value, {
    type: "tool_requested",
    callId: "call-1",
    name: "contract.get_operation",
    input: { operationId: "read" },
  });
  assert.equal(executorStarted, false);

  const completed = await iterator.next();
  assert.deepEqual(completed.value, {
    type: "tool_completed",
    callId: "call-1",
    result: { operationId: "read", effects: "read" },
    isError: false,
  });
  assert.equal(executorStarted, true);
  assert.equal((await iterator.next()).value?.type, "text_delta");
  assert.deepEqual((await iterator.next()).value, {
    type: "completed",
    result: { cases: [] },
  });
});

test("cancel is idempotent and interrupts an in-flight provider request", async () => {
  const controlled = controlledStreamFn();
  const runtime = new PiAgentRuntime({ model, streamFn: controlled.streamFn });
  const iterator = runtime.run(request("cancelled-run"))[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "started");
  const provider = await controlled.next();
  provider.stream.push({ type: "start", partial: message([], "pending") });

  await runtime.cancel("cancelled-run");
  await runtime.cancel("cancelled-run");
  const terminal = await withTimeout(iterator.next());
  assert.deepEqual(terminal.value, {
    type: "failed",
    code: "cancelled",
    message: "Agent run cancelled",
    retryable: false,
  });
  assert.equal((await iterator.next()).done, true);
});

test("wall-clock deadline terminates without waiting for the provider turn", async () => {
  const controlled = controlledStreamFn();
  const runtime = new PiAgentRuntime({ model, streamFn: controlled.streamFn });
  const iterator = runtime.run(
    request("deadline", { deadlineEpochMs: Date.now() + 25 }),
  )[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "started");
  await controlled.next();

  const terminal = await withTimeout(iterator.next(), 500);
  assert.deepEqual(terminal.value, {
    type: "failed",
    code: "deadline_exceeded",
    message: "Agent run deadline exceeded",
    retryable: false,
  });
  assert.equal((await iterator.next()).done, true);
});

test("output flooding is stopped in-stream and produces one terminal event", async () => {
  const controlled = controlledStreamFn();
  const runtime = new PiAgentRuntime({ model, streamFn: controlled.streamFn });
  const outputPromise = collect(
    runtime,
    request("flood", { maxOutputBytes: 5 }),
  );
  const provider = await controlled.next();
  emitText(provider.stream, "123456", false);

  const output = await withTimeout(outputPromise);
  assert.deepEqual(output, [
    { type: "started", runId: "flood" },
    {
      type: "failed",
      code: "output_limit",
      message: "Model output exceeded 5 bytes",
      retryable: false,
    },
  ]);
});

test("rejects a concurrent run id and releases it after cancellation", async () => {
  const controlled = controlledStreamFn();
  const runtime = new PiAgentRuntime({ model, streamFn: controlled.streamFn });
  const first = runtime.run(request("same-id"))[Symbol.asyncIterator]();
  assert.equal((await first.next()).value?.type, "started");
  await controlled.next();

  const second = runtime.run(request("same-id"))[Symbol.asyncIterator]();
  await assert.rejects(second.next(), AgentRuntimeError);
  await runtime.cancel("same-id");
  assert.equal((await first.next()).value?.type, "failed");

  const third = runtime.run(request("same-id"))[Symbol.asyncIterator]();
  assert.equal((await third.next()).value?.type, "started");
  await controlled.next();
  await runtime.cancel("same-id");
  assert.equal((await third.next()).value?.type, "failed");
});

test("invalid JSON and schema mismatch fail closed in PiAgentRuntime", async () => {
  const scenarios: Array<{
    readonly runId: string;
    readonly text: string;
    readonly expectedResultSchema?: Json;
    readonly code: "model_output_parse_error" | "model_output_schema_error";
  }> = [
    {
      runId: "pi-invalid-json",
      text: "not-json SECRET-MODEL-BODY",
      code: "model_output_parse_error",
    },
    {
      runId: "pi-schema-mismatch",
      text: '{"cases":"wrong"}',
      expectedResultSchema: {
        type: "object",
        required: ["cases"],
        properties: { cases: { type: "array" } },
        additionalProperties: false,
      },
      code: "model_output_schema_error",
    },
  ];
  for (const scenario of scenarios) {
    const runtime = new PiAgentRuntime({
      model,
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => emitText(stream, scenario.text));
        return stream;
      },
    });
    const output = await collect(
      runtime,
      request(scenario.runId, {
        ...(scenario.expectedResultSchema === undefined
          ? {}
          : { expectedResultSchema: scenario.expectedResultSchema }),
      }),
    );
    const terminal = output.at(-1);
    assert.equal(terminal?.type, "failed");
    if (terminal?.type === "failed") {
      assert.equal(terminal.code, scenario.code);
      assert.doesNotMatch(terminal.message, /SECRET-MODEL-BODY|wrong/);
    }
  }
});

test("invalid tool input is rejected before the executor runs", async () => {
  let executions = 0;
  const runtime = new PiAgentRuntime({
    model,
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const toolCall = {
          type: "toolCall" as const,
          id: "invalid-call",
          name: "contract.get_operation",
          arguments: {},
        };
        const assistant = message([toolCall], "toolUse");
        stream.push({ type: "start", partial: message([], "pending") });
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: assistant });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall,
          partial: assistant,
        });
        stream.push({ type: "done", reason: "toolUse", message: assistant });
      });
      return stream;
    },
    toolExecutor: async () => {
      executions += 1;
      return { impossible: true };
    },
  });

  const output = await collect(
    runtime,
    request("invalid-tool", {
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
    }),
  );
  assert.equal(executions, 0);
  const terminal = output.at(-1);
  assert.equal(terminal?.type, "failed");
  if (terminal?.type === "failed") {
    assert.equal(terminal.code, "tool_input_schema_error");
  }
});
