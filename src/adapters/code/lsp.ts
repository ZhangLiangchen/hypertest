import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";

import type { Json } from "../../contracts.js";

export interface LspServerOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
}

interface PendingRequest {
  readonly resolve: (value: Json) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

export class LspClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: Json[] = [];
  private initialized = false;
  private capabilities: Json = {};

  public constructor(private readonly options: LspServerOptions) {}

  public async start(): Promise<Json> {
    if (this.child !== undefined) return this.capabilities;
    const child = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => this.failAll(error));
    child.on("close", (code, signal) =>
      this.failAll(new Error(`Language server exited (${code ?? signal ?? "unknown"})`)),
    );

    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.options.cwd).href,
      capabilities: {
        workspace: { symbol: { dynamicRegistration: false } },
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true },
          callHierarchy: { dynamicRegistration: false },
        },
      },
      workspaceFolders: [
        { uri: pathToFileURL(this.options.cwd).href, name: "workspace" },
      ],
    });
    if (isRecord(result) && result.capabilities !== undefined) {
      this.capabilities = result.capabilities;
    }
    this.notify("initialized", {});
    this.initialized = true;
    return this.capabilities;
  }

  public async workspaceSymbols(query: string): Promise<Json> {
    await this.ensureStarted();
    return this.request("workspace/symbol", { query });
  }

  public async definition(uri: string, line: number, character: number): Promise<Json> {
    await this.ensureStarted();
    return this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  public async references(
    uri: string,
    line: number,
    character: number,
    includeDeclaration = true,
  ): Promise<Json> {
    await this.ensureStarted();
    return this.request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration },
    });
  }

  public async prepareCallHierarchy(uri: string, line: number, character: number): Promise<Json> {
    await this.ensureStarted();
    return this.request("textDocument/prepareCallHierarchy", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  public getNotifications(): readonly Json[] {
    return [...this.notifications];
  }

  public getCapabilities(): Json {
    return this.capabilities;
  }

  public async close(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    try {
      if (this.initialized) {
        await this.request("shutdown", null);
        this.notify("exit", null);
      }
    } finally {
      child.kill("SIGTERM");
      this.child = undefined;
      this.initialized = false;
    }
  }

  public async request(method: string, params: Json): Promise<Json> {
    const child = this.child;
    if (child === undefined) throw new Error("Language server is not running");
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: "2.0", id, method, params };
    child.stdin.write(encodeLspMessage(payload as unknown as Json));
    return new Promise<Json>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Language server request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? 20_000);
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  public notify(method: string, params: Json): void {
    const child = this.child;
    if (child === undefined) throw new Error("Language server is not running");
    child.stdin.write(
      encodeLspMessage({ jsonrpc: "2.0", method, params } as unknown as Json),
    );
  }

  private async ensureStarted(): Promise<void> {
    if (this.child === undefined) await this.start();
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const header = this.buffer.subarray(0, separator).toString("ascii");
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (lengthMatch === null) {
        this.failAll(new Error("Language server frame has no Content-Length"));
        return;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = separator + 4;
      if (this.buffer.byteLength < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.handleMessage(JSON.parse(body) as Json);
      } catch (error) {
        this.failAll(new Error(`Invalid language server JSON: ${String(error)}`));
        return;
      }
    }
  }

  private handleMessage(message: Json): void {
    if (!isRecord(message)) return;
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(`Language server error: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }
    if (typeof message.method === "string") {
      this.notifications.push(message);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function encodeLspMessage(value: Json): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

function isRecord(value: Json | undefined): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
