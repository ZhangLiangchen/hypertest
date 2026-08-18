export type ModelRuntimeProvider = "deterministic" | "openai-compatible";

export interface ModelRuntimeSettings {
  readonly provider: ModelRuntimeProvider;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly maxOutputTokens?: number;
}

export interface DeterministicModelConfig {
  readonly provider: "deterministic";
}

export interface OpenAICompatibleModelConfig {
  readonly provider: "openai-compatible";
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly maxOutputTokens: number;
}

export type ResolvedModelConfig =
  | DeterministicModelConfig
  | OpenAICompatibleModelConfig;

export type ModelEnvironment = Readonly<Record<string, string | undefined>>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

export function resolveModelConfig(
  settings: ModelRuntimeSettings,
  environment: ModelEnvironment = process.env,
): ResolvedModelConfig {
  const provider = readOptional(environment, "HYPERTEST_MODEL_PROVIDER") ??
    settings.provider;
  if (provider === "deterministic") return { provider };
  if (provider !== "openai-compatible") {
    throw new Error(
      `Unsupported model provider ${JSON.stringify(provider)}; expected deterministic or openai-compatible`,
    );
  }

  const modelId =
    readOptional(environment, "HYPERTEST_MODEL_ID") ?? settings.model;
  if (modelId === undefined || modelId.trim().length === 0) {
    throw new Error(
      "OpenAI-compatible runtime requires HYPERTEST_MODEL_ID or runtime.model",
    );
  }

  const baseUrlInput =
    readOptional(environment, "HYPERTEST_MODEL_BASE_URL") ?? settings.baseUrl;
  if (baseUrlInput === undefined) {
    throw new Error(
      "OpenAI-compatible runtime requires HYPERTEST_MODEL_BASE_URL or runtime.baseUrl",
    );
  }
  const baseUrl = normalizeEndpoint(baseUrlInput);

  const apiKey = readOptional(environment, "HYPERTEST_MODEL_API_KEY");
  if (apiKey === undefined) {
    throw new Error(
      "OpenAI-compatible runtime requires HYPERTEST_MODEL_API_KEY",
    );
  }

  return {
    provider,
    modelId: modelId.trim(),
    baseUrl,
    apiKey,
    timeoutMs: readBoundedInteger(
      environment,
      "HYPERTEST_MODEL_TIMEOUT_MS",
      settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      100,
      600_000,
    ),
    maxRetries: readBoundedInteger(
      environment,
      "HYPERTEST_MODEL_MAX_RETRIES",
      settings.maxRetries ?? DEFAULT_MAX_RETRIES,
      0,
      10,
    ),
    maxOutputTokens: readBoundedInteger(
      environment,
      "HYPERTEST_MODEL_MAX_OUTPUT_TOKENS",
      settings.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      1,
      131_072,
    ),
  };
}

export function normalizeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OpenAI-compatible model base URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OpenAI-compatible model base URL must use http or https");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("OpenAI-compatible model base URL must not contain credentials");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error(
      "OpenAI-compatible model base URL must not contain a query or fragment",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function readOptional(
  environment: ModelEnvironment,
  name: string,
): string | undefined {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  return value.trim();
}

function readBoundedInteger(
  environment: ModelEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = readOptional(environment, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
