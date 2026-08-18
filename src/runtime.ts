import type { ArtifactRef, Json } from "./contracts.js";
import { RuntimeValidationError, validateModelResult } from "./runtime/validation.js";
import { aggregateAgentUsage, emptyAgentUsageSummary } from "./runtime/usage.js";

export type AgentFailureCode =
  | "cancelled"
  | "deadline_exceeded"
  | "provider_error"
  | "provider_protocol_error"
  | "provider_rate_limited"
  | "model_output_parse_error"
  | "model_output_schema_error"
  | "tool_input_schema_error"
  | "tool_execution_error"
  | "tool_loop_limit"
  | "output_limit"
  | "budget_exhausted";

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
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxOutputBytes?: number;
  readonly maxOutputTokens?: number;
  readonly maxRepeatedToolCalls?: number;
  readonly toolExecutor?: AgentToolExecutor;
}

export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Json;
  readonly idempotent: boolean;
}

export interface AgentToolExecutionRequest {
  readonly runId: string;
  readonly name: string;
  readonly callId: string;
  readonly input: Json;
}

export interface AgentToolExecutionOutcome {
  readonly status: "ok" | "error";
  readonly output: Json;
}

export type AgentToolExecutor = (
  request: AgentToolExecutionRequest,
) => Promise<AgentToolExecutionOutcome>;

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
      readonly name: string;
      readonly result: Json;
      readonly isError: boolean;
      readonly durationMs: number;
    }
  | { readonly type: "usage"; readonly usage: AgentUsage }
  | { readonly type: "completed"; readonly result: Json }
  | {
      readonly type: "failed";
      readonly code: AgentFailureCode;
      readonly message: string;
      readonly retryable: boolean;
      readonly providerRequestId?: string;
    };

export interface AgentUsage {
  readonly provider: string;
  readonly model: string;
  readonly endpointFingerprint: string;
  readonly providerRequestId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly latencyMs: number;
  readonly retryCount: number;
  readonly stopReason?: string;
  readonly usageUnavailable: boolean;
  readonly estimatedCostUsd?: number;
}

export interface AgentUsageSummary {
  readonly schema: "hypertest.model-usage/v1";
  readonly runId: string;
  readonly providerCalls: number;
  readonly usageUnavailableCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly totalTokens: number;
  readonly retryCount: number;
  readonly totalLatencyMs: number;
  readonly estimatedCostUsd: number;
  readonly records: readonly AgentUsage[];
}

export interface AgentRunOutcome {
  readonly result: Json;
  readonly usage: AgentUsageSummary;
}

export interface AgentRuntime {
  run(request: AgentRunRequest): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}

export class AgentRuntimeError extends Error {
  public constructor(
    public readonly failure: Extract<AgentEvent, { readonly type: "failed" }>,
    public readonly usage?: AgentUsageSummary,
  ) {
    super(`Agent runtime failed (${failure.code}): ${failure.message}`);
    this.name = "AgentRuntimeError";
  }
}

abstract class InMemoryAgentRuntime implements AgentRuntime {
  private readonly active = new Set<string>();
  private readonly cancelled = new Set<string>();

  public async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    if (this.active.has(request.runId)) {
      throw new AgentRuntimeError({
        type: "failed",
        code: "provider_protocol_error",
        message: `Run ${request.runId} is already active`,
        retryable: false,
      });
    }
    this.active.add(request.runId);
    try {
      yield { type: "started", runId: request.runId };
      if (this.cancelled.has(request.runId)) {
        yield failure("cancelled", "cancelled", false);
        return;
      }
      const result = this.nextResult();
      if (result === undefined) {
        yield failure(
          "provider_protocol_error",
          "No scripted result remains",
          false,
        );
        return;
      }
      try {
        yield {
          type: "completed",
          result: validateModelResult(result, request.expectedResultSchema),
        };
      } catch (error) {
        if (error instanceof RuntimeValidationError) {
          yield failure(error.code, error.message, false);
          return;
        }
        throw error;
      }
    } finally {
      this.active.delete(request.runId);
      this.cancelled.delete(request.runId);
    }
  }

  public async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
  }

  protected abstract nextResult(): Json | undefined;
}

export class FakeAgentRuntime extends InMemoryAgentRuntime {
  public constructor(private readonly result: Json = { status: "ok" }) {
    super();
  }

  protected nextResult(): Json {
    return this.result;
  }
}

export class ScriptedAgentRuntime extends InMemoryAgentRuntime {
  private cursor = 0;

  public constructor(private readonly scripts: readonly Json[]) {
    super();
  }

  protected nextResult(): Json | undefined {
    const result = this.scripts[this.cursor];
    this.cursor += 1;
    return result;
  }
}

export interface CollectAgentRunOptions {
  readonly onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export async function collectAgentRun(
  runtime: AgentRuntime,
  request: AgentRunRequest,
  options: CollectAgentRunOptions = {},
): Promise<AgentRunOutcome> {
  let completed: Json | undefined;
  let terminalCount = 0;
  const records: AgentUsage[] = [];
  for await (const event of runtime.run(request)) {
    await options.onEvent?.(event);
    if (event.type === "usage") {
      records.push(event.usage);
    } else if (event.type === "completed") {
      terminalCount += 1;
      completed = event.result;
    } else if (event.type === "failed") {
      terminalCount += 1;
      throw new AgentRuntimeError(
        event,
        aggregateAgentUsage(request.runId, records),
      );
    }
  }
  if (terminalCount !== 1 || completed === undefined) {
    throw new Error("Agent runtime ended without exactly one terminal event");
  }
  return {
    result: completed,
    usage: aggregateAgentUsage(request.runId, records),
  };
}

export async function collectAgentResult(
  runtime: AgentRuntime,
  request: AgentRunRequest,
): Promise<Json> {
  return (await collectAgentRun(runtime, request)).result;
}

export { aggregateAgentUsage, emptyAgentUsageSummary };

export function failure(
  code: AgentFailureCode,
  message: string,
  retryable: boolean,
  providerRequestId?: string,
): Extract<AgentEvent, { readonly type: "failed" }> {
  return {
    type: "failed",
    code,
    message,
    retryable,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  };
}
