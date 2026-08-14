import type { CoverageMap, CoverageRegion, Json } from "../../contracts.js";

export function parseCoverageJson(text: string, sourceRevision: string): CoverageMap {
  const parsed = JSON.parse(text) as Json;
  if (!isRecord(parsed) || !isRecord(parsed.files)) {
    throw new Error("Coverage JSON must contain a files object");
  }
  const files = Object.entries(parsed.files).map(([path, value]) => {
    if (!isRecord(value)) throw new Error(`Coverage entry ${path} is invalid`);
    const executed = numberArray(value.executed_lines);
    const missing = numberArray(value.missing_lines);
    const executedBranches = pairArray(value.executed_branches);
    const missingBranches = pairArray(value.missing_branches);
    const regions: CoverageRegion[] = [
      ...executed.map((line) => lineRegion(line, 1)),
      ...missing.map((line) => lineRegion(line, 0)),
      ...executedBranches.map(([line, target], index) => branchRegion(line, target, index, 1)),
      ...missingBranches.map(([line, target], index) => branchRegion(line, target, index, 0)),
    ];
    return {
      uri: `repo:///${path.replaceAll("\\", "/").replace(/^\/+/, "")}`,
      regions,
    };
  });
  return {
    schema: "hypertest.coverage-map/v1",
    sourceRevision,
    files,
    capabilities: {
      line: true,
      block: false,
      branch: files.some((file) => file.regions.some((region) => region.kind === "branch")),
      condition: false,
      function: false,
      perTest: false,
    },
    completeness: "complete",
    warnings: [],
  };
}

function lineRegion(line: number, hits: number): CoverageRegion {
  return {
    start: { line, column: 1 },
    end: { line, column: 1 },
    kind: "line",
    hits,
    testIds: [],
  };
}

function branchRegion(
  line: number,
  target: number,
  index: number,
  hits: number,
): CoverageRegion {
  return {
    start: { line, column: index + 1 },
    end: { line: target, column: 1 },
    kind: "branch",
    hits,
    testIds: [],
  };
}

function isRecord(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberArray(value: Json | undefined): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

function pairArray(value: Json | undefined): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    Array.isArray(item) && typeof item[0] === "number" && typeof item[1] === "number"
      ? [[item[0], item[1]] as [number, number]]
      : [],
  );
}
