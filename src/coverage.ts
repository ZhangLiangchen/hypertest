import type { CoverageFile, CoverageMap, CoverageRegion } from "./contracts.js";

export interface CoverageSummary {
  readonly regions: number;
  readonly coveredRegions: number;
  readonly uncoveredRegions: number;
  readonly ratio?: number;
  readonly byKind: Readonly<
    Record<string, { readonly total: number; readonly covered: number }>
  >;
}

export function summarizeCoverage(map: CoverageMap): CoverageSummary {
  const regions = map.files.flatMap((file) => file.regions);
  const covered = regions.filter((region) => region.hits > 0);
  const byKind: Record<string, { total: number; covered: number }> = {};
  for (const region of regions) {
    const current = byKind[region.kind] ?? { total: 0, covered: 0 };
    current.total += 1;
    if (region.hits > 0) current.covered += 1;
    byKind[region.kind] = current;
  }
  return {
    regions: regions.length,
    coveredRegions: covered.length,
    uncoveredRegions: regions.length - covered.length,
    ...(regions.length === 0 ? {} : { ratio: covered.length / regions.length }),
    byKind,
  };
}

export function mergeCoverageMaps(maps: readonly CoverageMap[]): CoverageMap {
  if (maps.length === 0) {
    throw new Error("At least one coverage map is required");
  }
  const sourceRevision = maps[0]?.sourceRevision;
  if (sourceRevision === undefined) {
    throw new Error("Coverage map has no source revision");
  }
  if (maps.some((map) => map.sourceRevision !== sourceRevision)) {
    throw new Error("Coverage maps from different source revisions cannot be merged");
  }

  const files = new Map<string, CoverageFile>();
  for (const map of maps) {
    for (const file of map.files) {
      const existing = files.get(file.uri);
      const sha256 = file.sha256 ?? existing?.sha256;
      files.set(file.uri, {
        uri: file.uri,
        ...(sha256 === undefined ? {} : { sha256 }),
        regions: mergeRegions([...(existing?.regions ?? []), ...file.regions]),
      });
    }
  }

  return {
    schema: "hypertest.coverage-map/v1",
    sourceRevision,
    files: [...files.values()].sort((left, right) => left.uri.localeCompare(right.uri)),
    capabilities: {
      line: maps.some((map) => map.capabilities.line),
      block: maps.some((map) => map.capabilities.block),
      branch: maps.some((map) => map.capabilities.branch),
      condition: maps.some((map) => map.capabilities.condition),
      function: maps.some((map) => map.capabilities.function),
      perTest: maps.some((map) => map.capabilities.perTest),
    },
    completeness: maps.every((map) => map.completeness === "complete")
      ? "complete"
      : maps.some((map) => map.completeness === "partial")
        ? "partial"
        : "unknown",
    warnings: [...new Set(maps.flatMap((map) => map.warnings))],
  };
}

export function uncoveredRegions(
  map: CoverageMap,
  limit = 100,
): Array<{ readonly uri: string; readonly region: CoverageRegion }> {
  return map.files
    .flatMap((file) =>
      file.regions
        .filter((region) => region.hits === 0)
        .map((region) => ({ uri: file.uri, region })),
    )
    .sort((left, right) => {
      const path = left.uri.localeCompare(right.uri);
      if (path !== 0) return path;
      return left.region.start.line - right.region.start.line;
    })
    .slice(0, limit);
}

function mergeRegions(regions: readonly CoverageRegion[]): CoverageRegion[] {
  const merged = new Map<string, CoverageRegion>();
  for (const region of regions) {
    const key = [
      region.kind,
      region.start.line,
      region.start.column,
      region.end.line,
      region.end.column,
    ].join(":");
    const existing = merged.get(key);
    merged.set(key, {
      ...region,
      hits: (existing?.hits ?? 0) + region.hits,
      testIds: [...new Set([...(existing?.testIds ?? []), ...region.testIds])],
    });
  }
  return [...merged.values()].sort((left, right) => {
    const line = left.start.line - right.start.line;
    if (line !== 0) return line;
    return left.start.column - right.start.column;
  });
}
