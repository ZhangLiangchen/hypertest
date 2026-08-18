import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent as PiAgentEvent,
  AgentOptions,
  AgentState,
  AgentTool,
  ShouldStopAfterTurnContext,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

import type { Json } from "../../contracts.js";
import type {
  AgentEvent,
  AgentRunRequest,
  AgentRuntime,
} from "../../runtime.js";

export interface PiToolExecutionRequest {
  readonly runId: string;
  readonly name: string;
  readonly callId: string;
  readonly input: Json;
}

export interface PiAgentRuntimeOptions {
  readonly model: AgentState["model"];
  readonly streamFn: StreamFn;
  readonly toolExecutor?: (request: PiToolExecutionRequest) => Promise<Json>;
  readonly transformContext?: AgentOptions["transformContext"];
  readonly thinkingLevel?: AgentState["thinkingLevel"];
}

export class PiAgentRuntime implements AgentRuntime {
  private readonly active = new Map<string, Agent>();

  public constructor(private readonly options: PiAgentRuntimeOptions) {}

  public async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    const tools: AgentTool<TSchema, Json>[] = request.tools.map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: toSchema(tool.inputSchema, tool.name),
      execute: async (callId, input) => {
        if (this.options.toolExecutor === undefined) {
          throw new Error(`No executor is configured for tool ${tool.name}`);
        }
        const result = await this.options.toolExecutor({
          runId: request.runId,
          name: tool.name,
          callId,
          input: toJson(input),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
    }));

    const agent = new Agent({
      initialState: {
        systemPrompt: request.systemPrompt ?? "You are a HyperTest worker.",
        model: this.options.model,
        thinkingLevel: this.options.thinkingLevel ?? "medium",
        tools,
        messages: [],
      },
      streamFn: this.options.streamFn,
      ...(this.options.transformContext === undefined
        ? {}
        : { transformContext: this.options.transformContext }),
      shouldStopAfterTurn: (context: ShouldStopAfterTurnContext) =>
        Date.now() >= request.deadlineEpochMs || context.context.messages.length > 100,
    });

    this.active.set(request.runId, agent);
    const events: AgentEvent[] = [{ type: "started", runId: request.runId }];
    let text = "";
    let failed: string | undefined;

    const unsubscribe = agent.subscribe((event: PiAgentEvent) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        const delta = event.assistantMessageEvent.delta;
        text += delta;
        events.push({ type: "text_delta", text: delta });
      } else if (event.type === "tool_execution_start") {
        events.push({
          type: "tool_requested",
          callId: event.toolCallId,
          name: event.toolName,
          input: toJson(event.args),
        });
      } else if (event.type === "tool_execution_end") {
        events.push({
          type: "tool_completed",
          callId: event.toolCallId,
          result: toJson(event.result),
          isError: event.isError,
        });
      } else if (
        event.type === "message_end" &&
        isAssistantFailure(event.message)
      ) {
        failed = event.message.errorMessage ?? `Pi agent stopped with ${event.message.stopReason}`;
      }
    });

    try {
      await agent.prompt(request.prompt);
      for (const event of events) yield event;
      if (failed !== undefined) {
        yield { type: "failed", message: failed, retryable: true };
        return;
      }
      yield { type: "completed", result: parseModelResult(text) };
    } catch (error) {
      for (const event of events) yield event;
      yield {
        type: "failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    } finally {
      unsubscribe();
      this.active.delete(request.runId);
    }
  }

  public async cancel(runId: string): Promise<void> {
    this.active.get(runId)?.abort();
  }
}

function toSchema(value: Json, toolName: string): TSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Tool ${toolName} input schema must be a JSON object`);
  }
  return value;
}

function isAssistantFailure(message: unknown): message is {
  readonly role: "assistant";
  readonly stopReason: "error" | "aborted";
  readonly errorMessage?: string;
} {
  if (typeof message !== "object" || message === null) return false;
  const record = message as Record<string, unknown>;
  return (
    record.role === "assistant" &&
    (record.stopReason === "error" || record.stopReason === "aborted")
  );
}

function parseModelResult(text: string): Json {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { text: "" };
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate) as Json;
  } catch {
    return { text: trimmed };
  }
}

function toJson(value: unknown): Json {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map((item) => toJson(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJson(item)]),
    );
  }
  return String(value);
}
