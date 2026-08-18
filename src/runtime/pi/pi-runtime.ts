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
import {
  AgentRuntimeError,
  failure,
  type AgentEvent,
  type AgentFailureCode,
  type AgentRunRequest,
  type AgentRuntime,
} from "../../runtime.js";
import { AsyncQueue } from "../async-queue.js";
import {
  RuntimeValidationError,
  parseAndValidateModelResult,
  validateToolInput,
} from "../validation.js";

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

interface ActivePiRun {
  readonly agent: Agent;
  readonly abort: (
    code: AgentFailureCode,
    message: string,
    retryable: boolean,
  ) => void;
}

export class PiAgentRuntime implements AgentRuntime {
  private readonly active = new Map<string, ActivePiRun>();

  public constructor(private readonly options: PiAgentRuntimeOptions) {}

  public async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    if (this.active.has(request.runId)) {
      throw new AgentRuntimeError(
        failure(
          "provider_protocol_error",
          `Run ${request.runId} is already active`,
          false,
        ),
      );
    }

    const queue = new AsyncQueue<AgentEvent>();
    const maxTurns = request.maxTurns ?? 20;
    const maxToolCalls = request.maxToolCalls ?? 60;
    const maxOutputBytes = request.maxOutputBytes ?? 1_048_576;
    let terminal = false;
    let text = "";
    let outputBytes = 0;
    let turnCount = 0;
    let toolCallCount = 0;
    let unsubscribe: (() => void) | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;

    const tools: AgentTool<TSchema, Json>[] = request.tools.map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: toSchema(tool.inputSchema, tool.name),
      prepareArguments: (input) =>
        validateToolInput(toJson(input), tool.inputSchema),
      execute: async (callId, input) => {
        if (this.options.toolExecutor === undefined) {
          throw new PiToolExecutionError(`No executor is configured for tool ${tool.name}`);
        }
        const validated = validateToolInput(toJson(input), tool.inputSchema);
        let result: Json;
        try {
          result = await this.options.toolExecutor({
            runId: request.runId,
            name: tool.name,
            callId,
            input: validated,
          });
        } catch (error) {
          throw new PiToolExecutionError(
            error instanceof Error ? error.message : String(error),
          );
        }
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
        Date.now() >= request.deadlineEpochMs ||
        context.context.messages.length > 100,
      toolExecution: "sequential",
    });

    const cleanup = (): void => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      unsubscribe?.();
      unsubscribe = undefined;
      this.active.delete(request.runId);
    };

    const finish = (event: Extract<AgentEvent, { type: "completed" | "failed" }>): void => {
      if (terminal) return;
      terminal = true;
      queue.push(event);
      queue.close();
      cleanup();
    };

    const abort = (
      code: AgentFailureCode,
      message: string,
      retryable: boolean,
    ): void => {
      if (terminal) return;
      agent.abort();
      finish(failure(code, message, retryable));
    };

    unsubscribe = agent.subscribe(async (event: PiAgentEvent) => {
      if (terminal) return;
      if (event.type === "turn_start") {
        turnCount += 1;
        if (turnCount > maxTurns) {
          abort(
            "tool_loop_limit",
            `Agent exceeded the maximum of ${maxTurns} turns`,
            false,
          );
        }
        return;
      }
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        const delta = event.assistantMessageEvent.delta;
        outputBytes += Buffer.byteLength(delta, "utf8");
        if (outputBytes > maxOutputBytes) {
          abort(
            "output_limit",
            `Model output exceeded ${maxOutputBytes} bytes`,
            false,
          );
          return;
        }
        text += delta;
        queue.push({ type: "text_delta", text: delta });
        return;
      }
      if (event.type === "tool_execution_start") {
        toolCallCount += 1;
        if (toolCallCount > maxToolCalls) {
          abort(
            "tool_loop_limit",
            `Agent exceeded the maximum of ${maxToolCalls} tool calls`,
            false,
          );
          return;
        }
        await queue.pushAndWait({
          type: "tool_requested",
          callId: event.toolCallId,
          name: event.toolName,
          input: toJson(event.args),
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        const result = toolResultJson(event.result);
        queue.push({
          type: "tool_completed",
          callId: event.toolCallId,
          result,
          isError: event.isError,
        });
        if (event.isError) {
          const classification = classifyToolFailure(event.result);
          if (classification !== undefined) {
            finish(failure(classification, toolFailureMessage(classification), false));
          }
        }
        return;
      }
      if (
        event.type === "message_end" &&
        isAssistantFailure(event.message)
      ) {
        finish(
          failure(
            event.message.stopReason === "aborted"
              ? "cancelled"
              : "provider_error",
            event.message.errorMessage ??
              `Pi agent stopped with ${event.message.stopReason}`,
            event.message.stopReason === "error",
            event.message.responseId,
          ),
        );
      }
    });

    this.active.set(request.runId, { agent, abort });
    queue.push({ type: "started", runId: request.runId });

    const remainingMs = request.deadlineEpochMs - Date.now();
    if (remainingMs <= 0) {
      abort("deadline_exceeded", "Agent run deadline exceeded", false);
    } else {
      deadlineTimer = setTimeout(() => {
        abort("deadline_exceeded", "Agent run deadline exceeded", false);
      }, remainingMs);
    }

    void (async () => {
      try {
        await agent.prompt(request.prompt);
        if (!terminal) {
          try {
            finish({
              type: "completed",
              result: parseAndValidateModelResult(
                text,
                request.expectedResultSchema,
              ),
            });
          } catch (error) {
            if (error instanceof RuntimeValidationError) {
              finish(failure(error.code, error.message, false));
            } else {
              throw error;
            }
          }
        }
      } catch (error) {
        if (!terminal) {
          const mapped = mapProviderError(error);
          finish(failure(mapped.code, mapped.message, mapped.retryable));
        }
      } finally {
        cleanup();
      }
    })();

    try {
      for await (const event of queue) yield event;
    } finally {
      if (!terminal) abort("cancelled", "Agent event consumer cancelled", false);
    }
  }

  public async cancel(runId: string): Promise<void> {
    this.active
      .get(runId)
      ?.abort("cancelled", "Agent run cancelled", false);
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
  readonly responseId?: string;
} {
  if (typeof message !== "object" || message === null) return false;
  const record = message as Record<string, unknown>;
  return (
    record.role === "assistant" &&
    (record.stopReason === "error" || record.stopReason === "aborted")
  );
}

function toolResultJson(value: unknown): Json {
  if (
    typeof value === "object" &&
    value !== null &&
    "details" in value
  ) {
    return toJson(value.details);
  }
  return toJson(value);
}

class PiToolExecutionError extends Error {
  public constructor(message: string) {
    super(`HYPERTEST_TOOL_EXECUTION_ERROR: ${safeToolError(message)}`);
    this.name = "PiToolExecutionError";
  }
}

function classifyToolFailure(
  value: unknown,
): "tool_input_schema_error" | "tool_execution_error" | undefined {
  const text = JSON.stringify(toJson(value));
  if (
    text.includes("RuntimeValidationError") ||
    text.includes("Tool input does not match the declared schema") ||
    text.includes("HYPERTEST_TOOL_INPUT_SCHEMA_ERROR")
  ) {
    return "tool_input_schema_error";
  }
  if (text.includes("HYPERTEST_TOOL_EXECUTION_ERROR")) {
    return "tool_execution_error";
  }
  return undefined;
}

function toolFailureMessage(
  code: "tool_input_schema_error" | "tool_execution_error",
): string {
  return code === "tool_input_schema_error"
    ? "Tool input does not match the declared schema"
    : "Tool execution failed";
}

function safeToolError(message: string): string {
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 160);
}

function mapProviderError(error: unknown): {
  readonly code: AgentFailureCode;
  readonly message: string;
  readonly retryable: boolean;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b|rate.?limit/i.test(message)) {
    return { code: "provider_rate_limited", message, retryable: true };
  }
  if (/protocol|invalid.*event|malformed/i.test(message)) {
    return { code: "provider_protocol_error", message, retryable: false };
  }
  return { code: "provider_error", message, retryable: true };
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
