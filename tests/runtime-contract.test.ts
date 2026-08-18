import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent, AgentRunRequest } from "../src/runtime.js";
import {
  FakeAgentRuntime,
  ScriptedAgentRuntime,
  collectAgentResult,
} from "../src/runtime.js";

function request(runId: string): AgentRunRequest {
  return {
    runId,
    phase: "characterization",
    prompt: "Return JSON.",
    tools: [],
    artifacts: [],
    tokenBudget: 100,
    deadlineEpochMs: Date.now() + 10_000,
  };
}

async function events(runtime: { run(value: AgentRunRequest): AsyncIterable<AgentEvent> }, runId: string): Promise<AgentEvent[]> {
  const output: AgentEvent[] = [];
  for await (const event of runtime.run(request(runId))) output.push(event);
  return output;
}

test("v0.1 fake runtime has one start followed by one completion", async () => {
  const output = await events(new FakeAgentRuntime({ status: "ok" }), "fake-run");
  assert.deepEqual(output, [
    { type: "started", runId: "fake-run" },
    { type: "completed", result: { status: "ok" } },
  ]);
});

test("v0.1 scripted runtime fails explicitly after its finite script is exhausted", async () => {
  const runtime = new ScriptedAgentRuntime([{ value: 1 }]);
  assert.deepEqual(await collectAgentResult(runtime, request("script-1")), { value: 1 });
  const output = await events(runtime, "script-2");
  assert.equal(output[0]?.type, "started");
  assert.deepEqual(output[1], {
    type: "failed",
    message: "No scripted result remains",
    retryable: false,
  });
});
