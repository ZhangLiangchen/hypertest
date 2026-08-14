export interface RenderedPatch {
  readonly path: string;
  readonly content: string;
  readonly patch: string;
}

export function renderNewFilePatch(path: string, content: string): RenderedPatch {
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const patch = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
  return { path, content: normalized, patch };
}
