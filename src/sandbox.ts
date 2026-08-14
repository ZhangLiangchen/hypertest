import type { Json } from "./contracts.js";
import type { ProcessResult } from "./process.js";

export interface SandboxRunRequest {
  readonly workspacePath: string;
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly network: "none" | "host" | "isolated";
  readonly cpuLimit?: number;
  readonly memoryBytes?: number;
  readonly pidsLimit?: number;
  readonly metadata?: Json;
}

export interface SandboxRunResult extends ProcessResult {
  readonly sandboxKind: string;
  readonly workspacePath: string;
}

export interface SandboxProvider {
  run(request: SandboxRunRequest, signal?: AbortSignal): Promise<SandboxRunResult>;
}
