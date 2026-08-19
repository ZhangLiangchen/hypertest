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

import {
  normalizeEndpoint,
  type OpenAICompatibleModelConfig,
} from "../../model-config.js";
import { fingerprintEndpoint } from "../usage.js";
import {
  PiAgentRuntime,
  type PiAgentRuntimeOptions,
  type PiProviderAttemptTelemetry,
  type PiProviderTelemetry,
} from "./pi-runtime.js";

const MAX_SSE_EVENT_BYTES = 1_048_576;
const MAX_RETRY_DELAY_MS = 1_000;

interface MutableProviderAttemptTelemetry {
  readonly retryCount: number;
  readonly startedAt: number;
  providerRequestId?: string;
  finishedAt?: number;
  stopReason?: string;
  usageUnavailable?: boolean;
}

interface AttemptState extends MutableProviderAttemptTelemetry {
  status?: number;
  headers?: Headers;
  networkError: boolean;
  redirectError: boolean;
}

export function createOpenAICompatibleRuntime(
  config: OpenAICompatibleModelConfig,
): PiAgentRuntime {
  const baseUrl = normalizeEndpoint(config.baseUrl);
  const model: Model<"openai-completions"> = {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: "openai-compatible",
    baseUrl,
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
  const telemetryByMessage = new WeakMap<AssistantMessage, PiProviderTelemetry>();
  const activeTelemetryByRunId = new Map<
    string,
    () => PiProviderTelemetry
  >();
  const sanitizeProviderRequestId = createProviderRequestIdSanitizer(
    config.apiKey,
  );
  const bindTelemetry = (
    message: AssistantMessage,
    telemetry: PiProviderTelemetry,
  ): void => {
    telemetryByMessage.set(message, telemetry);
  };
  const createStreamFn = (runId?: string): StreamFn => (candidate, context, options) => {
    if (!isOpenAICompletionsModel(candidate)) {
      return protocolFailureStream(
        candidate,
        "Pi runtime selected a non-OpenAI-completions model",
        bindTelemetry,
      );
    }
    return streamWithBoundedRetries(
      candidate,
      context,
      options,
      config,
      sanitizeProviderRequestId,
      bindTelemetry,
      runId,
      activeTelemetryByRunId,
    );
  };
  const streamFn = createStreamFn();

  return new PiAgentRuntime({
    model,
    streamFn,
    streamFnForRun: (runId) => createStreamFn(runId),
    provider: config.provider,
    modelId: config.modelId,
    endpointFingerprint: fingerprintEndpoint(baseUrl),
    maxOutputTokens: config.maxOutputTokens,
    getProviderTelemetry: (message, runId): PiProviderTelemetry | undefined =>
      message === undefined
        ? activeTelemetryByRunId.get(runId)?.()
        : telemetryByMessage.get(message),
    sanitizeProviderRequestId,
  });
}

function streamWithBoundedRetries(
  model: Model<"openai-completions">,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: OpenAICompatibleModelConfig,
  sanitizeProviderRequestId: (value: string) => string | undefined,
  bindTelemetry: (
    message: AssistantMessage,
    telemetry: PiProviderTelemetry,
  ) => void,
  runId: string | undefined,
  activeTelemetryByRunId: Map<string, () => PiProviderTelemetry>,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const attempts: AttemptState[] = [];
  const snapshot = (): PiProviderTelemetry => snapshotTelemetry(attempts);
  if (runId !== undefined) activeTelemetryByRunId.set(runId, snapshot);
  const releaseActiveTelemetry = (): void => {
    if (
      runId !== undefined &&
      activeTelemetryByRunId.get(runId) === snapshot
    ) {
      activeTelemetryByRunId.delete(runId);
    }
  };
  const replayLockedByHistory = context.messages.some(
    (message) => message.role === "toolResult",
  );
  const maxRetries = replayLockedByHistory ? 0 : config.maxRetries;

  void (async () => {
    for (let attemptIndex = 0; ; attemptIndex += 1) {
      const attempt: AttemptState = {
        retryCount: attemptIndex === 0 ? 0 : 1,
        startedAt: Date.now(),
        networkError: false,
        redirectError: false,
      };
      attempts.push(attempt);
      const buffered: AssistantMessageEvent[] = [];
      let visible = false;
      let terminalSeen = false;
      let retryScheduled = false;
      const baseFetch = options?.fetch ?? globalThis.fetch;
      const observedFetch: typeof globalThis.fetch = async (input, init) => {
        try {
          const response = await baseFetch(input, {
            ...(init ?? {}),
            redirect: "error",
          });
          attempt.status = response.status;
          attempt.headers = response.headers;
          const requestId = sanitizeProviderRequestId(
            response.headers.get("x-request-id") ??
              response.headers.get("request-id") ??
              response.headers.get("x-amzn-requestid") ??
              "",
          );
          if (requestId !== undefined) attempt.providerRequestId = requestId;
          return validateSseResponse(response);
        } catch (error) {
          attempt.redirectError = isRedirectFetchError(error);
          attempt.networkError = !attempt.redirectError;
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
          recordResponse(response, attempt, sanitizeProviderRequestId);
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
            finishAttempt(attempt, "retry", true);
            await sleepBeforeRetry(
              retryDelayMs(attempt, attemptIndex),
              options?.signal,
            );
            retryScheduled = true;
            break;
          }
          flush(buffered, output);
          const aborted = options?.signal?.aborted === true;
          finishAttempt(attempt, aborted ? "aborted" : "error", true);
          const finalMessage = safeErrorMessage(
            model,
            attempt,
            event.error.errorMessage,
            visible,
            attempt.providerRequestId,
            aborted,
          );
          bindTelemetry(finalMessage, snapshotTelemetry(attempts));
          output.push({
            type: "error",
            reason: aborted ? "aborted" : "error",
            error: finalMessage,
          });
          return;
        }

        if (event.type === "done") {
          terminalSeen = true;
          if (!visible) flush(buffered, output);
          finishAttempt(attempt, event.reason, false);
          bindTelemetry(event.message, snapshotTelemetry(attempts));
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

      if (retryScheduled) continue;
      if (!terminalSeen) {
        const retryable =
          !visible &&
          attemptIndex < maxRetries &&
          options?.signal?.aborted !== true;
        if (retryable) {
          finishAttempt(attempt, "retry", true);
          await sleepBeforeRetry(
            retryDelayMs(attempt, attemptIndex),
            options?.signal,
          );
          continue;
        }
        flush(buffered, output);
        const aborted = options?.signal?.aborted === true;
        finishAttempt(attempt, aborted ? "aborted" : "error", true);
        const finalMessage = safeErrorMessage(
          model,
          attempt,
          "Provider stream ended without a terminal event",
          visible,
          attempt.providerRequestId,
          aborted,
        );
        bindTelemetry(finalMessage, snapshotTelemetry(attempts));
        output.push({
          type: "error",
          reason: aborted ? "aborted" : "error",
          error: finalMessage,
        });
        return;
      }
    }
  })()
    .catch(() => {
      const aborted = options?.signal?.aborted === true;
      const attempt = attempts.at(-1) ?? {
        retryCount: 0,
        startedAt: Date.now(),
        networkError: true,
        redirectError: false,
      };
      if (attempts.length === 0) attempts.push(attempt);
      finishAttempt(attempt, aborted ? "aborted" : "error", true);
      const finalMessage = safeErrorMessage(
        model,
        attempt,
        "Provider retry control failed",
        false,
        attempt.providerRequestId,
        aborted,
      );
      bindTelemetry(finalMessage, snapshotTelemetry(attempts));
      output.push({
        type: "error",
        reason: aborted ? "aborted" : "error",
        error: finalMessage,
      });
    })
    .finally(releaseActiveTelemetry);

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
        validatePendingSseBytes(buffer, encoder);
      },
      flush(controller) {
        buffer += decoder.decode();
        emitCompleteSseEvents(controller);
        validatePendingSseBytes(buffer, encoder);
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
      if (encoder.encode(event).byteLength > MAX_SSE_EVENT_BYTES) {
        throw providerProtocolError();
      }
      validateSseEvent(event);
      controller.enqueue(encoder.encode(`${event}\n\n`));
    }
  }
}

function validatePendingSseBytes(
  buffer: string,
  encoder: TextEncoder,
): void {
  if (encoder.encode(buffer).byteLength > MAX_SSE_EVENT_BYTES) {
    throw providerProtocolError();
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
  attempt: MutableProviderAttemptTelemetry,
  sanitizeProviderRequestId: (value: string) => string | undefined,
): void {
  const requestId = sanitizeProviderRequestId(
    headerValue(response.headers, "x-request-id") ??
      headerValue(response.headers, "request-id") ??
      headerValue(response.headers, "x-amzn-requestid") ??
      "",
  );
  if (requestId !== undefined) attempt.providerRequestId = requestId;
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

function finishAttempt(
  attempt: MutableProviderAttemptTelemetry,
  stopReason: string,
  usageUnavailable: boolean,
): void {
  attempt.finishedAt ??= Date.now();
  attempt.stopReason = stopReason;
  if (usageUnavailable) attempt.usageUnavailable = true;
}

function snapshotTelemetry(
  attempts: readonly MutableProviderAttemptTelemetry[],
): PiProviderTelemetry {
  return {
    attempts: attempts.map(
      (attempt): PiProviderAttemptTelemetry => ({
        retryCount: attempt.retryCount,
        latencyMs: Math.max(
          0,
          Math.floor((attempt.finishedAt ?? Date.now()) - attempt.startedAt),
        ),
        ...(attempt.providerRequestId === undefined
          ? {}
          : { providerRequestId: attempt.providerRequestId }),
        ...(attempt.stopReason === undefined
          ? {}
          : { stopReason: attempt.stopReason }),
        ...(attempt.usageUnavailable === undefined
          ? {}
          : { usageUnavailable: attempt.usageUnavailable }),
      }),
    ),
  };
}

function createProviderRequestIdSanitizer(
  apiKey: string,
): (value: string) => string | undefined {
  const configuredSecret = apiKey.trim();
  return (value: string): string | undefined => {
    const candidate = value.trim();
    if (
      candidate.length === 0 ||
      candidate.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/+=-]*$/.test(candidate) ||
      (configuredSecret.length > 0 && candidate.includes(configuredSecret))
    ) {
      return undefined;
    }
    return candidate;
  };
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
  if (attempt.redirectError) return false;
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

function isRedirectFetchError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "string"
          ? current
          : "";
    if (/redirect/i.test(message)) return true;
    current =
      typeof current === "object" && "cause" in current
        ? (current as { readonly cause?: unknown }).cause
        : undefined;
  }
  return false;
}

function retryDelayMs(attempt: AttemptState, retryIndex: number): number {
  const retryAfter = attempt.headers?.get("retry-after");
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.min(
        Math.max(0, dateMs - Date.now()),
        MAX_RETRY_DELAY_MS,
      );
    }
  }
  return Math.min(25 * 2 ** retryIndex, MAX_RETRY_DELAY_MS);
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
  } else if (
    attempt.redirectError ||
    (attempt.status !== undefined &&
      attempt.status >= 300 &&
      attempt.status < 400)
  ) {
    message = "OpenAI-compatible provider protocol error";
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
  bindTelemetry: (
    message: AssistantMessage,
    telemetry: PiProviderTelemetry,
  ) => void,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const error: AssistantMessage = {
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
    };
    bindTelemetry(error, {
      attempts: [
        {
          retryCount: 0,
          latencyMs: 0,
          stopReason: "error",
          usageUnavailable: true,
        },
      ],
    });
    output.push({
      type: "error",
      reason: "error",
      error,
    });
  });
  return output;
}

function isOpenAICompletionsModel(
  model: Model<Api>,
): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}
