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
  readonly model: unknown;
  readonly streamFn: (...args: readonly unknown[]) => unknown;
  readonly toolExecutor?: (request: PiToolExecutionRequest) => Promise<Json>;
  readonly transformContext?: (messages: readonly unknown[], signal: AbortSignal) => Promise<readonly unknown[]>;
  readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

interface PiAgentLike {
  subscribe(listener: (event: any) => void | Promise<void>): () => void;
  prompt(prompt: string): Promise<unknown>;
  abort?: () => void;
  cancel?: () => void;
}

interface PiModuleLike {
  Agent: new (options: unknown) => PiAgentLike;
}

export class PiAgentRuntime implements AgentRuntime {
  private readonly active = new Map<string, PiAgentLike>();

  public constructor(private readonly options: PiAgentRuntimeOptions) {}

  public async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    const packageName: string = ["@earendil-works", "pi-agent-core"].join("/");
    const module = (await import(packageName)) as unknown as PiModuleLike;
    const tools = request.tools.map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      execute: async (callId: string, input: Json) => {
        if (this.options.toolExecutor === undefined) {
          throw new Error(`No executor is configured for tool ${tool.name}`);
        }
        return this.options.toolExecutor({
          runId: request.runId,
          name: tool.name,
          callId,
          input,
        });
      },
    }));

    const agent = new module.Agent({
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
      shouldStopAfterTurn: ({ context }: any) => {
        const now = Date.now();
        if (now >= request.deadlineEpochMs) {
          return true;
        }
        return Array.isArray(context?.messages) && context.messages.length > 100;
      },
    });

    this.active.set(request.runId, agent);
    const events: AgentEvent[] = [
      { type: "started", runId: request.runId },
    ];
    let text = "";
    let failed: string | undefined;

    const unsubscribe = agent.subscribe((event: any) => {
      if (
        event?.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta" &&
        typeof event.assistantMessageEvent.delta === "string"
      ) {
        const delta = event.assistantMessageEvent.delta;
        text += delta;
        events.push({ type: "text_delta", text: delta });
      } else if (event?.type === "tool_execution_start") {
        events.push({
          type: "tool_requested",
          callId: String(event.toolCallId ?? "unknown"),
          name: String(event.toolName ?? "unknown"),
          input: toJson(event.args),
        });
      } else if (event?.type === "tool_execution_end") {
        events.push({
          type: "tool_completed",
          callId: String(event.toolCallId ?? "unknown"),
          result: toJson(event.result),
          isError: Boolean(event.isError),
        });
      } else if (event?.type === "agent_error") {
        failed = String(event.message ?? "pi agent error");
      }
    });

    try {
      await agent.prompt(request.prompt);
      for (const event of events) {
        yield event;
      }
      if (failed !== undefined) {
        yield { type: "failed", message: failed, retryable: true };
        return;
      }
      yield { type: "completed", result: parseModelResult(text) };
    } catch (error) {
      for (const event of events) {
        yield event;
      }
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
    const agent = this.active.get(runId);
    agent?.abort?.();
    agent?.cancel?.();
  }
}

function parseModelResult(text: string): Json {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { text: "" };
  }
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate) as Json;
  } catch {
    return { text: trimmed };
  }
}

function toJson(value: unknown): Json {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as Json;
}
