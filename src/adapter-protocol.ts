import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type {
  AdapterDiagnostic,
  AdapterManifest,
  AdapterResponse,
  AdapterStatus,
  CallContext,
  Json,
} from "./contracts.js";
import type { AdapterCommandProfile } from "./profile.js";
import { runProcess } from "./process.js";

export interface AdapterInvocationRequest<T extends Json = Json> {
  readonly schema: "hypertest.adapter-invocation/v1";
  readonly operation: string;
  readonly context: CallContext;
  readonly input: T;
  readonly config?: Json;
}

export interface AdapterHandler {
  readonly manifest: AdapterManifest;
  invoke(request: AdapterInvocationRequest): Promise<AdapterResponse<Json>>;
}

export class ProcessAdapterClient {
  public constructor(private readonly profile: AdapterCommandProfile) {}

  public async describe(): Promise<AdapterManifest> {
    const temporary = await mkdtemp(join(tmpdir(), "hypertest-adapter-describe-"));
    const responsePath = join(temporary, "manifest.json");
    try {
      const command = this.command();
      const result = await runProcess({
        command,
        args: [...this.baseArgs(), "describe", "--response", responsePath],
        ...(this.profile.cwd === undefined ? {} : { cwd: this.profile.cwd }),
        ...(this.profile.env === undefined ? {} : { env: this.profile.env }),
        timeoutMs: this.profile.timeoutMs ?? 15_000,
        maxOutputBytes: 1_048_576,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `Adapter describe failed (${result.exitCode ?? "unknown"}): ${result.stderr.trim()}`,
        );
      }
      return validateManifest(JSON.parse(await readFile(responsePath, "utf8")));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  public async invoke<TInput extends Json, TOutput>(
    operation: string,
    context: CallContext,
    input: TInput,
    signal?: AbortSignal,
  ): Promise<AdapterResponse<TOutput>> {
    const temporary = await mkdtemp(join(tmpdir(), "hypertest-adapter-invoke-"));
    const requestPath = join(temporary, "request.json");
    const responsePath = join(temporary, "response.json");
    const request: AdapterInvocationRequest<TInput> = {
      schema: "hypertest.adapter-invocation/v1",
      operation,
      context,
      input,
      ...(this.profile.config === undefined
        ? {}
        : { config: this.profile.config }),
    };
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");

    try {
      const command = this.command();
      const result = await runProcess({
        command,
        args: [
          ...this.baseArgs(),
          "invoke",
          "--operation",
          operation,
          "--request",
          requestPath,
          "--response",
          responsePath,
        ],
        ...(this.profile.cwd === undefined ? {} : { cwd: this.profile.cwd }),
        ...(this.profile.env === undefined ? {} : { env: this.profile.env }),
        timeoutMs: Math.min(
          this.profile.timeoutMs ?? 60_000,
          Math.max(1, context.deadlineEpochMs - Date.now()),
        ),
        maxOutputBytes: 4 * 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
      });

      if (result.timedOut) {
        return adapterFailure<TOutput>(
          context.requestId,
          this.identityFromCommand(),
          "transient_error",
          "ADAPTER_TIMEOUT",
          `Adapter operation ${operation} timed out`,
          true,
        );
      }
      if (result.cancelled) {
        return adapterFailure<TOutput>(
          context.requestId,
          this.identityFromCommand(),
          "cancelled",
          "ADAPTER_CANCELLED",
          `Adapter operation ${operation} was cancelled`,
          false,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(responsePath, "utf8"));
      } catch (error) {
        return adapterFailure<TOutput>(
          context.requestId,
          this.identityFromCommand(),
          result.exitCode === 75 ? "transient_error" : "permanent_error",
          "ADAPTER_RESPONSE_INVALID",
          `Adapter did not produce a valid response: ${String(error)}; stderr=${result.stderr.trim()}`,
          result.exitCode === 75,
        );
      }

      const response = validateAdapterResponse<TOutput>(parsed);
      if (response.requestId !== context.requestId) {
        throw new Error("Adapter response requestId does not match the invocation");
      }
      const expectedExit = exitCodeForStatus(response.status);
      if (result.exitCode !== expectedExit) {
        throw new Error(
          `Adapter exit code ${result.exitCode ?? "unknown"} does not match response status ${response.status}`,
        );
      }
      return response;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private command(): string {
    const command = this.profile.executable ?? this.profile.command;
    if (command === undefined) {
      throw new Error("Adapter profile has no executable command");
    }
    return command;
  }

  private baseArgs(): string[] {
    return [...(this.profile.args ?? [])];
  }

  private identityFromCommand(): { readonly name: string; readonly version: string } {
    return { name: basename(this.command()), version: "unknown" };
  }
}

export function okResponse<T>(
  requestId: string,
  adapter: { readonly name: string; readonly version: string },
  outcome: T,
  artifacts: AdapterResponse<T>["artifacts"] = [],
  diagnostics: readonly AdapterDiagnostic[] = [],
): AdapterResponse<T> {
  return {
    schema: "hypertest.adapter-response/v1",
    requestId,
    adapter,
    status: "ok",
    outcome,
    artifacts,
    diagnostics,
  };
}

export function adapterFailure<T>(
  requestId: string,
  adapter: { readonly name: string; readonly version: string },
  status: Exclude<AdapterStatus, "ok" | "unsupported">,
  code: string,
  message: string,
  retrySafe: boolean,
  detail?: Json,
): AdapterResponse<T> {
  return {
    schema: "hypertest.adapter-response/v1",
    requestId,
    adapter,
    status,
    artifacts: [],
    diagnostics: [
      { code, message, ...(detail === undefined ? {} : { detail }) },
    ],
    retry: { safe: retrySafe },
  };
}

export function unsupportedResponse<T>(
  requestId: string,
  adapter: { readonly name: string; readonly version: string },
  operation: string,
): AdapterResponse<T> {
  return {
    schema: "hypertest.adapter-response/v1",
    requestId,
    adapter,
    status: "unsupported",
    artifacts: [],
    diagnostics: [
      {
        code: "OPERATION_UNSUPPORTED",
        message: `Operation ${operation} is not supported`,
      },
    ],
    retry: { safe: false },
  };
}

export function exitCodeForStatus(status: AdapterStatus): number {
  switch (status) {
    case "ok":
      return 0;
    case "unsupported":
      return 69;
    case "transient_error":
      return 75;
    case "permanent_error":
      return 70;
    case "cancelled":
      return 130;
  }
}

export function createCallContext(input: {
  readonly runId: string;
  readonly workspace: CallContext["workspace"];
  readonly sourceRevision: string;
  readonly deadlineEpochMs: number;
  readonly attempt?: number;
}): CallContext {
  return {
    runId: input.runId,
    requestId: randomUUID(),
    workspace: input.workspace,
    sourceRevision: input.sourceRevision,
    deadlineEpochMs: input.deadlineEpochMs,
    attempt: input.attempt ?? 1,
  };
}

export function validateAdapterResponse<T>(value: unknown): AdapterResponse<T> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Adapter response must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== "hypertest.adapter-response/v1") {
    throw new Error("Adapter response schema is invalid");
  }
  if (typeof record.requestId !== "string" || record.requestId.length === 0) {
    throw new Error("Adapter response requestId is invalid");
  }
  if (
    !["ok", "unsupported", "transient_error", "permanent_error", "cancelled"].includes(
      String(record.status),
    )
  ) {
    throw new Error("Adapter response status is invalid");
  }
  if (!Array.isArray(record.artifacts) || !Array.isArray(record.diagnostics)) {
    throw new Error("Adapter response artifacts and diagnostics must be arrays");
  }
  const adapter = record.adapter;
  if (typeof adapter !== "object" || adapter === null || Array.isArray(adapter)) {
    throw new Error("Adapter response identity is invalid");
  }
  if (
    typeof (adapter as Record<string, unknown>).name !== "string" ||
    typeof (adapter as Record<string, unknown>).version !== "string"
  ) {
    throw new Error("Adapter response identity fields are invalid");
  }
  return value as AdapterResponse<T>;
}

export function validateManifest(value: unknown): AdapterManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Adapter manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== "hypertest.adapter-manifest/v1") {
    throw new Error("Adapter manifest schema is invalid");
  }
  if (!Array.isArray(record.capabilities) || !Array.isArray(record.operations)) {
    throw new Error("Adapter manifest capability and operation fields are invalid");
  }
  return value as AdapterManifest;
}
