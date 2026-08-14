import type { ArtifactRef, Json } from "./contracts.js";

export interface AgentRunRequest {
  readonly runId: string;
  readonly phase: string;
  readonly systemPrompt?: string;
  readonly prompt: string;
  readonly tools: readonly AgentToolDefinition[];
  readonly artifacts: readonly ArtifactRef[];
  readonly tokenBudget: number;
  readonly deadlineEpochMs: number;
  readonly expectedResultSchema?: Json;
}

export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Json;
  readonly idempotent: boolean;
}

export type AgentEvent =
  | { readonly type: "started"; readonly runId: string }
  | { readonly type: "text_delta"; readonly text: string }
  | {
      readonly type: "tool_requested";
      readonly callId: string;
      readonly name: string;
      readonly input: Json;
    }
  | {
      readonly type: "tool_completed";
      readonly callId: string;
      readonly result: Json;
      readonly isError: boolean;
    }
  | { readonly type: "usage"; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: "completed"; readonly result: Json }
  | { readonly type: "failed"; readonly message: string; readonly retryable: boolean };

export interface AgentRuntime {
  run(request: AgentRunRequest): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}

export class FakeAgentRuntime implements AgentRuntime {
  private readonly cancelled = new Set<string>();

  public constructor(private readonly result: Json = { status: "ok" }) {}

  public async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield { type: "started", runId: request.runId };
    if (this.cancelled.has(request.runId)) {
      yield { type: "failed", message: "cancelled", retryable: false };
      return;
    }
    yield { type: "completed", result: this.result };
  }

  public async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
  }
}

export class ScriptedAgentRuntime implements AgentRuntime {
  private readonly cancelled = new Set<string>();
  private cursor = 0;

  public constructor(private readonly scripts: readonly Json[]) {}

  public async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield { type: "started", runId: request.runId };
    if (this.cancelled.has(request.runId)) {
      yield { type: "failed", message: "cancelled", retryable: false };
      return;
    }
    const result = this.scripts[this.cursor];
    this.cursor += 1;
    if (result === undefined) {
      yield {
        type: "failed",
        message: "No scripted result remains",
        retryable: false,
      };
      return;
    }
    yield { type: "completed", result };
  }

  public async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
  }
}

export async function collectAgentResult(
  runtime: AgentRuntime,
  request: AgentRunRequest,
): Promise<Json> {
  let completed: Json | undefined;
  let failure: string | undefined;
  for await (const event of runtime.run(request)) {
    if (event.type === "completed") {
      completed = event.result;
    } else if (event.type === "failed") {
      failure = event.message;
    }
  }
  if (failure !== undefined) {
    throw new Error(`Agent runtime failed: ${failure}`);
  }
  if (completed === undefined) {
    throw new Error("Agent runtime ended without a completed result");
  }
  return completed;
}
