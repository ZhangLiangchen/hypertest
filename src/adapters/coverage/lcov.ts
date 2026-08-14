import type { CoverageFile, CoverageMap, CoverageRegion } from "../../contracts.js";

export function parseLcov(text: string, sourceRevision: string): CoverageMap {
  const files: CoverageFile[] = [];
  let currentPath: string | undefined;
  let regions: CoverageRegion[] = [];
  const functions = new Map<string, number>();

  const flush = (): void => {
    if (currentPath !== undefined) {
      files.push({ uri: toRepoUri(currentPath), regions });
    }
    currentPath = undefined;
    regions = [];
    functions.clear();
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      flush();
      currentPath = line.slice(3);
    } else if (line.startsWith("DA:")) {
      const [lineNumber, hits] = line.slice(3).split(",").map(Number);
      if (Number.isFinite(lineNumber) && Number.isFinite(hits)) {
        regions.push(region(lineNumber!, 1, lineNumber!, 1, "line", hits!));
      }
    } else if (line.startsWith("FN:")) {
      const [lineNumber, ...nameParts] = line.slice(3).split(",");
      functions.set(nameParts.join(","), Number(lineNumber));
    } else if (line.startsWith("FNDA:")) {
      const [hits, ...nameParts] = line.slice(5).split(",");
      const lineNumber = functions.get(nameParts.join(","));
      if (lineNumber !== undefined) {
        regions.push(region(lineNumber, 1, lineNumber, 1, "function", Number(hits)));
      }
    } else if (line.startsWith("BRDA:")) {
      const [lineNumber, block, branch, taken] = line.slice(5).split(",");
      const column = Number(block) + Number(branch) + 1;
      regions.push(
        region(
          Number(lineNumber),
          Number.isFinite(column) ? column : 1,
          Number(lineNumber),
          Number.isFinite(column) ? column : 1,
          "branch",
          taken === "-" ? 0 : Number(taken),
        ),
      );
    } else if (line === "end_of_record") {
      flush();
    }
  }
  flush();

  return {
    schema: "hypertest.coverage-map/v1",
    sourceRevision,
    files,
    capabilities: {
      line: files.some((file) => file.regions.some((item) => item.kind === "line")),
      block: false,
      branch: files.some((file) => file.regions.some((item) => item.kind === "branch")),
      condition: false,
      function: files.some((file) => file.regions.some((item) => item.kind === "function")),
      perTest: false,
    },
    completeness: "complete",
    warnings: [],
  };
}

function region(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  kind: CoverageRegion["kind"],
  hits: number,
): CoverageRegion {
  return {
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn },
    kind,
    hits: Number.isFinite(hits) ? hits : 0,
    testIds: [],
  };
}

function toRepoUri(path: string): string {
  return `repo:///${path.replaceAll("\\", "/").replace(/^\/+/, "")}`;
}
