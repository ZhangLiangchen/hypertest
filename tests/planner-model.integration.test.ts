import assert from "node:assert/strict";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

import type { ArtifactRef, Json, SutContract } from "../src/contracts.js";
import {
  createPlannerToolExecutor,
  createTestPlan,
  plannerToolDefinitions,
} from "../src/planner.js";
import type { AgentEvent, AgentUsageSummary } from "../src/runtime.js";
import {
  PiAgentRuntime,
  type PiAgentRuntimeOptions,
} from "../src/runtime/pi/pi-runtime.js";

const model: PiAgentRuntimeOptions["model"] = {
  id: "planner-mock",
  name: "Planner mock",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://127.0.0.1.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

const contractRef: ArtifactRef<"sut-contract"> = {
  kind: "sut-contract",
  schema: "hypertest.sut-contract/v1",
  uri: "file:///planner-contract.json",
  mediaType: "application/json",
  sha256: "c".repeat(64),
};

const operationId = "sensitive-read-operation";
const contract: SutContract = {
  schema: "hypertest.sut-contract/v1",
  id: "planner-contract",
  title: "Planner contract",
  sourceRevision: "rev",
  operations: [
    {
      id: operationId,
      title: "Read item",
      description: "Read one item by id",
      interactionKind: "http",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 } },
        required: ["id"],
      },
      observationSchema: { type: "object" },
      effects: "read",
      preconditions: ["service available"],
      oracleHints: [{ status: 200 }],
      tags: ["read-only"],
    },
  ],
  lifecycleCapabilities: ["reset"],
  provenance: [],
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  responseId: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "planner-mock",
    responseId,
    usage: {
      input: 2,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 4,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function pending(): AssistantMessage {
  return assistant([], "pending", "pending");
}

function emitToolCall(
  stream: AssistantMessageEventStream,
  callId: string,
  name: string,
  input: Record<string, Json>,
): void {
  const toolCall = {
    type: "toolCall" as const,
    id: callId,
    name,
    arguments: input,
  };
  const message = assistant([toolCall], "toolUse", `request-${callId}`);
  stream.push({ type: "start", partial: pending() });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
  stream.push({
    type: "toolcall_end",
    contentIndex: 0,
    toolCall,
    partial: message,
  });
  stream.push({ type: "done", reason: "toolUse", message });
}

function emitFinalJson(
  stream: AssistantMessageEventStream,
  value: Json,
  responseId: string,
): void {
  const text = JSON.stringify(value);
  const message = assistant([{ type: "text", text }], "stop", responseId);
  stream.push({ type: "start", partial: pending() });
  stream.push({ type: "text_start", contentIndex: 0, partial: message });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });
}

function modelCase(): Json {
  return {
    cases: [
      {
        title: "Model read case",
        objective: "Verify a model-selected read input",
        steps: [{ operationId, input: { id: "example" } }],
        oracle: { status: 200 },
      },
    ],
  };
}

test("planner closes the real Pi tool loop and deterministically merges the validated case", async () => {
  let providerTurn = 0;
  const events: AgentEvent[] = [];
  let usage: AgentUsageSummary | undefined;
  const runtime = new PiAgentRuntime({
    model,
    streamFn: (_model, context) => {
      const stream = createAssistantMessageEventStream();
      const current = providerTurn;
      providerTurn += 1;
      if (current === 0) {
        const user = context.messages.find((message) => message.role === "user");
        assert.equal(user?.role, "user");
        if (user?.role === "user") {
          assert.doesNotMatch(JSON.stringify(user.content), new RegExp(operationId));
        }
        assert.deepEqual(
          context.tools?.map((tool) => tool.name),
          ["contract.list_operations", "contract.get_operation"],
        );
        queueMicrotask(() =>
          emitToolCall(
            stream,
            "get-operation-1",
            "contract.get_operation",
            { operationId },
          ),
        );
      } else {
        const toolResult = context.messages.at(-1);
        assert.equal(toolResult?.role, "toolResult");
        if (toolResult?.role === "toolResult") {
          assert.equal(toolResult.toolCallId, "get-operation-1");
          assert.equal(toolResult.isError, false);
          const text = toolResult.content[0];
          assert.equal(text?.type, "text");
          if (text?.type === "text") {
            const parsed = JSON.parse(text.text) as {
              readonly operation?: { readonly operationId?: string };
            };
            assert.equal(parsed.operation?.operationId, operationId);
          }
        }
        queueMicrotask(() =>
          emitFinalJson(stream, modelCase(), "planner-final"),
        );
      }
      return stream;
    },
  });

  const plan = await createTestPlan(contract, contractRef, {
    runtime,
    runId: "planner-tool-loop",
    tokenBudget: 100,
    onAgentEvent: (event) => {
      events.push(event);
    },
    onUsage: (summary) => {
      usage = summary;
    },
  });

  assert.equal(providerTurn, 2);
  assert.ok(
    plan.cases.some(
      (item) => item.generatedBy === "model" && item.operationIds.includes(operationId),
    ),
  );
  assert.ok(plan.cases.some((item) => item.generatedBy === "deterministic"));
  const requested = events.find((event) => event.type === "tool_requested");
  const completed = events.find((event) => event.type === "tool_completed");
  assert.equal(requested?.type, "tool_requested");
  assert.equal(completed?.type, "tool_completed");
  if (requested?.type === "tool_requested" && completed?.type === "tool_completed") {
    assert.equal(requested.callId, completed.callId);
    assert.equal(completed.name, "contract.get_operation");
    assert.equal(completed.isError, false);
    assert.ok(completed.durationMs >= 0);
  }
  assert.equal(usage?.providerCalls, 2);
  assert.equal(usage?.totalTokens, 8);
});

test("unknown operations return a structured recoverable tool error", async () => {
  let providerTurn = 0;
  const runtime = new PiAgentRuntime({
    model,
    streamFn: (_model, context) => {
      const stream = createAssistantMessageEventStream();
      const current = providerTurn;
      providerTurn += 1;
      if (current === 0) {
        queueMicrotask(() =>
          emitToolCall(
            stream,
            "missing-operation",
            "contract.get_operation",
            { operationId: "does-not-exist" },
          ),
        );
      } else {
        const result = context.messages.at(-1);
        assert.equal(result?.role, "toolResult");
        if (result?.role === "toolResult") {
          assert.equal(result.isError, true);
          const text = result.content[0];
          assert.equal(text?.type, "text");
          if (text?.type === "text") {
            const parsed = JSON.parse(text.text) as {
              readonly error?: { readonly code?: string };
            };
            assert.equal(parsed.error?.code, "unknown_operation");
          }
        }
        queueMicrotask(() =>
          emitFinalJson(stream, { cases: [] }, "after-tool-error"),
        );
      }
      return stream;
    },
  });

  const plan = await createTestPlan(contract, contractRef, {
    runtime,
    runId: "planner-unknown-operation",
    tokenBudget: 100,
  });
  assert.equal(providerTurn, 2);
  assert.ok(plan.cases.every((item) => item.generatedBy === "deterministic"));
});

test("planner exposes only the fixed in-memory read-only allowlist", async () => {
  assert.deepEqual(
    plannerToolDefinitions().map((tool) => tool.name),
    ["contract.list_operations", "contract.get_operation"],
  );
  const execute = createPlannerToolExecutor(contract);
  const listed = await execute({
    runId: "tool-unit",
    name: "contract.list_operations",
    callId: "list",
    input: {},
  });
  assert.equal(listed.status, "ok");
  assert.match(JSON.stringify(listed.output), /inputSchemaDigest/);
  assert.doesNotMatch(JSON.stringify(listed.output), /description/);

  const forbidden = await execute({
    runId: "tool-unit",
    name: "write_file",
    callId: "write",
    input: { path: "/tmp/forbidden", content: "x" },
  });
  assert.equal(forbidden.status, "error");
  assert.match(JSON.stringify(forbidden.output), /tool_not_allowed/);
});
