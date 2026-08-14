import type { ArtifactRef, Json } from "./contracts.js";

export interface AgentRunRequest {
  readonly runId: string;
  readonly phase: string;
  readonly prompt: string;
  readonly tools: readonly AgentToolDefinition[];
  readonly artifacts: readonly ArtifactRef[];
  readonly tokenBudget: number;
  readonly deadlineEpochMs: number;
}

export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Json;
}

export type AgentEvent =
  | { readonly type: "started"; readonly runId: string }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_requested"; readonly name: string; readonly input: Json }
  | { readonly type: "completed"; readonly result: Json }
  | { readonly type: "failed"; readonly message: string };

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
      yield { type: "failed", message: "cancelled" };
      return;
    }
    yield { type: "completed", result: this.result };
  }

  public async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
  }
}
