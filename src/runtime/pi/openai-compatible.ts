import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderResponse,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";

import type { OpenAICompatibleModelConfig } from "../../model-config.js";
import { fingerprintEndpoint } from "../usage.js";
import {
  PiAgentRuntime,
  type PiAgentRuntimeOptions,
  type PiProviderTelemetry,
} from "./pi-runtime.js";

interface MutableProviderCallTelemetry {
  retryCount: number;
  providerRequestId?: string;
}

interface AttemptState {
  status?: number;
  headers?: Headers;
  networkError: boolean;
}

export function createOpenAICompatibleRuntime(
  config: OpenAICompatibleModelConfig,
): PiAgentRuntime {
  const model: Model<"openai-completions"> = {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: "openai-compatible",
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: config.maxOutputTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
    },
  };
  const pendingTelemetry: MutableProviderCallTelemetry[] = [];
  const streamFn: StreamFn = (candidate, context, options) => {
    const telemetry: MutableProviderCallTelemetry = { retryCount: 0 };
    pendingTelemetry.push(telemetry);
    if (!isOpenAICompletionsModel(candidate)) {
      return protocolFailureStream(
        candidate,
        "Pi runtime selected a non-OpenAI-completions model",
      );
    }
    return streamWithBoundedRetries(
      candidate,
      context,
      options,
      config,
      telemetry,
    );
  };

  return new PiAgentRuntime({
    model,
    streamFn,
    provider: config.provider,
    modelId: config.modelId,
    endpointFingerprint: fingerprintEndpoint(config.baseUrl),
    maxOutputTokens: config.maxOutputTokens,
    getProviderTelemetry: (): PiProviderTelemetry | undefined => {
      const telemetry = pendingTelemetry.shift();
      if (telemetry === undefined) return undefined;
      return {
        retryCount: telemetry.retryCount,
        ...(telemetry.providerRequestId === undefined
          ? {}
          : { providerRequestId: telemetry.providerRequestId }),
      };
    },
  });
}

function streamWithBoundedRetries(
  model: Model<"openai-completions">,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: OpenAICompatibleModelConfig,
  telemetry: MutableProviderCallTelemetry,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const replayLockedByHistory = context.messages.some(
    (message) => message.role === "toolResult",
  );
  const maxRetries = replayLockedByHistory ? 0 : config.maxRetries;

  void (async () => {
    for (let attemptIndex = 0; ; attemptIndex += 1) {
      const attempt: AttemptState = { networkError: false };
      delete telemetry.providerRequestId;
      const buffered: AssistantMessageEvent[] = [];
      let visible = false;
      let terminalSeen = false;
      const baseFetch = options?.fetch ?? globalThis.fetch;
      const observedFetch: typeof globalThis.fetch = async (input, init) => {
        try {
          const response = await baseFetch(input, init);
          attempt.status = response.status;
          attempt.headers = response.headers;
          const requestId =
            response.headers.get("x-request-id") ??
            response.headers.get("request-id") ??
            response.headers.get("x-amzn-requestid");
          if (requestId !== null) telemetry.providerRequestId = requestId;
          return validateSseResponse(response);
        } catch (error) {
          attempt.networkError = true;
          throw error;
        }
      };

      const providerStream = streamOpenAICompletions(model, context, {
        ...(options ?? {}),
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
        maxRetries: 0,
        fetch: observedFetch,
        transport: "sse",
        onResponse: async (response, responseModel) => {
          recordResponse(response, telemetry);
          await options?.onResponse?.(response, responseModel);
        },
      });

      for await (const event of providerStream) {
        if (event.type === "error") {
          terminalSeen = true;
          const retryable =
            !visible &&
            attemptIndex < maxRetries &&
            isRetryableAttempt(attempt, event.error.errorMessage) &&
            options?.signal?.aborted !== true;
          if (retryable) {
            telemetry.retryCount += 1;
            await sleepBeforeRetry(
              retryDelayMs(attempt, attemptIndex),
              options?.signal,
            );
            break;
          }
          flush(buffered, output);
          output.push({
            type: "error",
            reason: options?.signal?.aborted === true ? "aborted" : "error",
            error: safeErrorMessage(
              model,
              attempt,
              event.error.errorMessage,
              visible,
              telemetry.providerRequestId,
              options?.signal?.aborted === true,
            ),
          });
          return;
        }

        if (event.type === "done") {
          terminalSeen = true;
          if (!visible) flush(buffered, output);
          output.push(event);
          return;
        }
        if (locksReplay(event)) {
          if (!visible) flush(buffered, output);
          visible = true;
          output.push(event);
        } else if (visible) {
          output.push(event);
        } else {
          buffered.push(event);
        }
      }

      if (!terminalSeen) {
        const retryable =
          !visible &&
          attemptIndex < maxRetries &&
          options?.signal?.aborted !== true;
        if (retryable) {
          telemetry.retryCount += 1;
          await sleepBeforeRetry(
            retryDelayMs(attempt, attemptIndex),
            options?.signal,
          );
          continue;
        }
        flush(buffered, output);
        output.push({
          type: "error",
          reason: options?.signal?.aborted === true ? "aborted" : "error",
          error: safeErrorMessage(
            model,
            attempt,
            "Provider stream ended without a terminal event",
            visible,
            telemetry.providerRequestId,
            options?.signal?.aborted === true,
          ),
        });
        return;
      }

      if (attemptIndex >= maxRetries) return;
    }
  })().catch(() => {
    output.push({
      type: "error",
      reason: options?.signal?.aborted === true ? "aborted" : "error",
      error: safeErrorMessage(
        model,
        { networkError: true },
        "Provider retry control failed",
        false,
        telemetry.providerRequestId,
        options?.signal?.aborted === true,
      ),
    });
  });

  return output;
}

function validateSseResponse(response: Response): Response {
  if (
    response.body === null ||
    response.ok !== true ||
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream") !== true
  ) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        emitCompleteSseEvents(controller);
      },
      flush(controller) {
        buffer += decoder.decode();
        emitCompleteSseEvents(controller);
        if (buffer.trim().length > 0) throw providerProtocolError();
      },
    }),
  );

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  function emitCompleteSseEvents(
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    for (;;) {
      const delimiter = findSseEventDelimiter(buffer);
      if (delimiter === undefined) return;
      const event = buffer.slice(0, delimiter.index);
      buffer = buffer.slice(delimiter.index + delimiter.length);
      validateSseEvent(event);
      controller.enqueue(encoder.encode(`${event}\n\n`));
    }
  }
}

function findSseEventDelimiter(
  value: string,
): { readonly index: number; readonly length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value);
  if (match === null || match.index === undefined) return undefined;
  return { index: match.index, length: match[0].length };
}

function validateSseEvent(event: string): void {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (data.length === 0 || data === "[DONE]") return;
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw providerProtocolError();
    }
  } catch {
    throw providerProtocolError();
  }
}

function providerProtocolError(): Error {
  return new Error("OpenAI-compatible provider protocol error");
}

function recordResponse(
  response: ProviderResponse,
  telemetry: MutableProviderCallTelemetry,
): void {
  const requestId =
    headerValue(response.headers, "x-request-id") ??
    headerValue(response.headers, "request-id") ??
    headerValue(response.headers, "x-amzn-requestid");
  if (requestId !== undefined) telemetry.providerRequestId = requestId;
}

function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && value.length > 0) return value;
  }
  return undefined;
}

function flush(
  events: readonly AssistantMessageEvent[],
  output: AssistantMessageEventStream,
): void {
  for (const event of events) output.push(event);
}

function locksReplay(event: AssistantMessageEvent): boolean {
  return (
    (event.type === "text_delta" && event.delta.length > 0) ||
    (event.type === "thinking_delta" && event.delta.length > 0) ||
    event.type === "toolcall_start" ||
    event.type === "toolcall_delta" ||
    event.type === "toolcall_end"
  );
}

function isRetryableAttempt(
  attempt: AttemptState,
  errorMessage: string | undefined,
): boolean {
  if (
    attempt.status === 429 ||
    attempt.status === 502 ||
    attempt.status === 503 ||
    attempt.status === 504
  ) {
    return true;
  }
  if (attempt.status !== undefined && attempt.status !== 200) return false;
  return (
    attempt.networkError ||
    /connection|socket|terminated|premature|fetch failed|network|ECONNRESET|UND_ERR|other side closed/i.test(
      errorMessage ?? "",
    )
  );
}

function retryDelayMs(attempt: AttemptState, retryIndex: number): number {
  const retryAfter = attempt.headers?.get("retry-after");
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return Math.min(25 * 2 ** retryIndex, 1_000);
}

async function sleepBeforeRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) throw new Error("Provider request aborted");
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Provider request aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, delayMs));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function safeErrorMessage(
  model: Model<"openai-completions">,
  attempt: AttemptState,
  providerMessage: string | undefined,
  visible: boolean,
  providerRequestId: string | undefined,
  aborted: boolean,
): AssistantMessage {
  let message: string;
  if (aborted) {
    message = "OpenAI-compatible provider request was aborted";
  } else if (attempt.status !== undefined && attempt.status !== 200) {
    message = `OpenAI-compatible provider returned HTTP ${attempt.status}`;
  } else if (
    attempt.networkError ||
    /connection|socket|terminated|premature|fetch failed|network|ECONNRESET|UND_ERR|other side closed/i.test(
      providerMessage ?? "",
    )
  ) {
    message = visible
      ? "OpenAI-compatible provider connection failed after visible output"
      : "OpenAI-compatible provider connection failed before the first visible delta";
  } else {
    message = "OpenAI-compatible provider protocol error";
  }
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    ...(providerRequestId === undefined
      ? {}
      : { responseId: providerRequestId }),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

function protocolFailureStream(
  model: Model<Api>,
  message: string,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  queueMicrotask(() => {
    output.push({
      type: "error",
      reason: "error",
      error: {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "error",
        errorMessage: message,
        timestamp: Date.now(),
      },
    });
  });
  return output;
}

function isOpenAICompletionsModel(
  model: Model<Api>,
): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}
