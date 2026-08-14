import type { CoverageFile, CoverageMap, CoverageRegion } from "../../contracts.js";

export function parseCoberturaXml(text: string, sourceRevision: string): CoverageMap {
  const files: CoverageFile[] = [];
  const classPattern = /<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g;
  let classMatch: RegExpExecArray | null;
  while ((classMatch = classPattern.exec(text)) !== null) {
    const path = decodeXml(classMatch[1] ?? "");
    const body = classMatch[2] ?? "";
    const regions: CoverageRegion[] = [];
    const linePattern = /<line\b([^>]*?)(?:\/>|>([\s\S]*?)<\/line>)/g;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = linePattern.exec(body)) !== null) {
      const attributes = parseAttributes(lineMatch[1] ?? "");
      const line = Number(attributes.number);
      const hits = Number(attributes.hits ?? 0);
      if (!Number.isFinite(line)) continue;
      regions.push({
        start: { line, column: 1 },
        end: { line, column: 1 },
        kind: "line",
        hits: Number.isFinite(hits) ? hits : 0,
        testIds: [],
      });
      const conditionText = lineMatch[2] ?? "";
      const conditionPattern = /<condition\b([^>]*)\/?>(?:<\/condition>)?/g;
      let conditionMatch: RegExpExecArray | null;
      let index = 0;
      while ((conditionMatch = conditionPattern.exec(conditionText)) !== null) {
        const condition = parseAttributes(conditionMatch[1] ?? "");
        const percent = Number(String(condition.coverage ?? "0").replace("%", ""));
        regions.push({
          start: { line, column: index + 1 },
          end: { line, column: index + 1 },
          kind: "condition",
          hits: percent > 0 ? 1 : 0,
          testIds: [],
        });
        index += 1;
      }
    }
    files.push({
      uri: `repo:///${path.replaceAll("\\", "/").replace(/^\/+/, "")}`,
      regions,
    });
  }
  return {
    schema: "hypertest.coverage-map/v1",
    sourceRevision,
    files,
    capabilities: {
      line: true,
      block: false,
      branch: false,
      condition: files.some((file) => file.regions.some((region) => region.kind === "condition")),
      function: false,
      perTest: false,
    },
    completeness: files.length === 0 ? "unknown" : "partial",
    warnings:
      files.length === 0
        ? ["No class entries were found in the coverage XML"]
        : ["Condition detail depends on producer-specific XML extensions"],
  };
}

function parseAttributes(text: string): Record<string, string> {
  const output: Record<string, string> = {};
  const pattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    output[match[1] ?? ""] = decodeXml(match[2] ?? "");
  }
  return output;
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
