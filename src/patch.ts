import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { parseUnifiedDiff } from "./repair.js";
import { runProcess } from "./process.js";

export async function applyPatchWithGit(
  workspacePath: string,
  patchText: string,
  timeoutMs = 30_000,
): Promise<void> {
  const result = await runProcess({
    command: "git",
    args: ["apply", "--whitespace=nowarn", "-"],
    cwd: workspacePath,
    stdin: patchText,
    timeoutMs,
    maxOutputBytes: 1_048_576,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git apply failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export async function materializeNewFilePatch(
  workspacePath: string,
  patchText: string,
): Promise<readonly string[]> {
  const parsed = parseUnifiedDiff(patchText);
  if (parsed.paths.length !== 1) {
    throw new Error("Simple patch materializer supports exactly one file");
  }
  if (parsed.deleted.length > 0) {
    throw new Error("Simple patch materializer supports new files only");
  }
  const path = parsed.paths[0]!;
  const root = resolve(workspacePath);
  const destination = resolve(root, path);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!destination.startsWith(prefix)) throw new Error("Patch path escapes workspace");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${parsed.added.join("\n")}\n`, { flag: "wx" });
  return [path];
}
