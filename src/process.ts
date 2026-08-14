import { spawn } from "node:child_process";

export interface ProcessRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ProcessResult {
  readonly command: readonly string[];
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly startedAtEpochMs: number;
  readonly finishedAtEpochMs: number;
  readonly truncated: boolean;
}

export class ProcessExecutionError extends Error {
  public constructor(
    message: string,
    public readonly causeValue?: unknown,
  ) {
    super(message);
    this.name = "ProcessExecutionError";
  }
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new ProcessExecutionError("timeoutMs must be a positive finite number");
  }

  const maxOutputBytes = request.maxOutputBytes ?? 4 * 1024 * 1024;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new ProcessExecutionError("maxOutputBytes must be a positive integer");
  }

  const startedAtEpochMs = Date.now();
  const args = [...(request.args ?? [])];
  const child = spawn(request.command, args, {
    cwd: request.cwd,
    env: request.env === undefined ? process.env : { ...process.env, ...request.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let timedOut = false;
  let cancelled = false;
  let truncated = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const append = (
    chunk: Buffer,
    chunks: Buffer[],
    current: number,
  ): number => {
    const remaining = maxOutputBytes - current;
    if (remaining <= 0) {
      truncated = true;
      return current;
    }
    if (chunk.byteLength > remaining) {
      chunks.push(chunk.subarray(0, remaining));
      truncated = true;
      return maxOutputBytes;
    }
    chunks.push(chunk);
    return current + chunk.byteLength;
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes = append(chunk, stdoutChunks, stdoutBytes);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes = append(chunk, stderrChunks, stderrBytes);
  });

  const terminate = (): void => {
    if (!child.killed) {
      child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1_000);
      force.unref();
    }
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs);
  timeout.unref();

  const onAbort = (): void => {
    cancelled = true;
    terminate();
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });

  const settled = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", (error) => reject(error));
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });

  try {
    if (request.stdin !== undefined) {
      child.stdin.end(request.stdin);
    } else {
      child.stdin.end();
    }

    const outcome = await settled;
    return {
      command: [request.command, ...args],
      ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
      ...(outcome.signal === null ? {} : { signal: outcome.signal }),
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      timedOut,
      cancelled,
      startedAtEpochMs,
      finishedAtEpochMs: Date.now(),
      truncated,
    };
  } catch (error) {
    terminate();
    throw new ProcessExecutionError(
      `Failed to execute ${[request.command, ...args].join(" ")}`,
      error,
    );
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
