import type { CoverageMap, CoverageRegion } from "../../contracts.js";

export function parseGoCoverProfile(
  text: string,
  sourceRevision: string,
): CoverageMap {
  const files = new Map<string, CoverageRegion[]>();
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const mode = lines[0]?.startsWith("mode:") ? lines.shift()?.slice(5).trim() : undefined;
  if (mode === undefined) warnings.push("Coverage profile did not declare a mode");

  for (const line of lines) {
    const match = /^(.*):(\d+)\.(\d+),(\d+)\.(\d+)\s+(\d+)\s+(\d+)$/.exec(line);
    if (match === null) {
      warnings.push(`Unparsed coverage line: ${line}`);
      continue;
    }
    const [, path, startLine, startColumn, endLine, endColumn, , count] = match;
    const uri = `repo:///${(path ?? "").replaceAll("\\", "/").replace(/^\/+/, "")}`;
    const regions = files.get(uri) ?? [];
    regions.push({
      start: { line: Number(startLine), column: Number(startColumn) },
      end: { line: Number(endLine), column: Number(endColumn) },
      kind: "block",
      hits: Number(count),
      testIds: [],
    });
    files.set(uri, regions);
  }

  return {
    schema: "hypertest.coverage-map/v1",
    sourceRevision,
    files: [...files.entries()].map(([uri, regions]) => ({ uri, regions })),
    capabilities: {
      line: false,
      block: true,
      branch: false,
      condition: false,
      function: false,
      perTest: false,
    },
    completeness: warnings.length === 0 ? "complete" : "partial",
    warnings: [
      ...warnings,
      "Block coverage is preserved as block coverage and must not be compared with branch coverage",
    ],
  };
}
