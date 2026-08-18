import assert from "node:assert/strict";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

import type { AgentRunRequest } from "../src/runtime.js";
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

function request(): AgentRunRequest {
  return {
    runId: "pi-typed",
    phase: "test",
    prompt: "Return JSON",
    tools: [],
    artifacts: [],
    tokenBudget: 100,
    deadlineEpochMs: Date.now() + 10_000,
  };
}

test("PiAgentRuntime uses the statically typed Pi Agent API", async () => {
  const streamFn: PiAgentRuntimeOptions["streamFn"] = () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: '{"typed":true}' }],
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
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: '{"typed":true}', partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: '{"typed":true}', partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };

  const runtime = new PiAgentRuntime({ model, streamFn });
  const output = [];
  for await (const event of runtime.run(request())) output.push(event);

  assert.deepEqual(output, [
    { type: "started", runId: "pi-typed" },
    { type: "text_delta", text: '{"typed":true}' },
    { type: "completed", result: { typed: true } },
  ]);
});
