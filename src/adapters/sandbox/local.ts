import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { runProcess } from "../../process.js";
import type { SandboxProvider, SandboxRunRequest, SandboxRunResult } from "../../sandbox.js";

export class LocalSandboxProvider implements SandboxProvider {
  public async run(
    request: SandboxRunRequest,
    signal?: AbortSignal,
  ): Promise<SandboxRunResult> {
    const root = await mkdtemp(join(tmpdir(), "hypertest-local-sandbox-"));
    const workspace = join(root, basename(request.workspacePath) || "workspace");
    await cp(request.workspacePath, workspace, {
      recursive: true,
      force: false,
      filter: (source) =>
        !source.split(/[\\/]/).some((part) => part === ".git" || part === ".testagent" || part === "node_modules"),
    });
    try {
      const [command, ...args] = request.command;
      if (command === undefined) throw new Error("Sandbox command is empty");
      const result = await runProcess({
        command,
        args,
        cwd: workspace,
        ...(request.env === undefined ? {} : { env: request.env }),
        timeoutMs: request.timeoutMs,
        maxOutputBytes: 8 * 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
      });
      return { ...result, sandboxKind: "local-copy", workspacePath: workspace };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
