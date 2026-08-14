import { resolve } from "node:path";

import { runProcess } from "../../process.js";
import type { SandboxProvider, SandboxRunRequest, SandboxRunResult } from "../../sandbox.js";

export interface OciSandboxOptions {
  readonly engine?: "docker" | "podman";
  readonly image: string;
  readonly user?: string;
  readonly workdir?: string;
  readonly readOnlyRoot?: boolean;
  readonly extraArgs?: readonly string[];
}

export class OciSandboxProvider implements SandboxProvider {
  public constructor(private readonly options: OciSandboxOptions) {
    if (!options.image.includes("@sha256:") && !options.image.startsWith("sha256:")) {
      throw new Error("OCI sandbox image must be pinned by digest");
    }
  }

  public async run(
    request: SandboxRunRequest,
    signal?: AbortSignal,
  ): Promise<SandboxRunResult> {
    const engine = this.options.engine ?? "docker";
    const workdir = this.options.workdir ?? "/workspace";
    const args: string[] = [
      "run",
      "--rm",
      "--init",
      "--workdir",
      workdir,
      "--mount",
      `type=bind,src=${resolve(request.workspacePath)},dst=${workdir},rw`,
      "--pids-limit",
      String(request.pidsLimit ?? 256),
      "--memory",
      String(request.memoryBytes ?? 1_073_741_824),
      "--cpus",
      String(request.cpuLimit ?? 1),
    ];
    if (this.options.readOnlyRoot ?? true) args.push("--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m");
    if (this.options.user !== undefined) args.push("--user", this.options.user);
    if (request.network === "none") args.push("--network", "none");
    if (request.network === "host") args.push("--network", "host");
    for (const [name, value] of Object.entries(request.env ?? {})) {
      args.push("--env", `${name}=${value}`);
    }
    args.push(...(this.options.extraArgs ?? []), this.options.image, ...request.command);
    const result = await runProcess({
      command: engine,
      args,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: 8 * 1024 * 1024,
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      ...result,
      sandboxKind: `oci-${engine}`,
      workspacePath: request.workspacePath,
    };
  }
}
