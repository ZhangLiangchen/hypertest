import type { Diagnosis } from "./contracts.js";

export interface RepairSafetyPolicy {
  readonly allowedWriteGlobs: readonly string[];
  readonly forbiddenGlobs: readonly string[];
  readonly maxChangedFiles: number;
  readonly maxAddedLines: number;
  readonly allowSkipMarkers?: boolean;
}

export interface RepairSafetyReport {
  readonly safe: boolean;
  readonly changedPaths: readonly string[];
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly violations: readonly string[];
  readonly warnings: readonly string[];
}

const automaticallyRepairable = new Set<Diagnosis["category"]>([
  "TEST_DEFECT",
  "FIXTURE_DEFECT",
  "ADAPTER_CONFIG",
  "BUILD",
]);

export function validateRepairPatch(
  diagnosis: Diagnosis,
  patchText: string,
  policy: RepairSafetyPolicy,
): RepairSafetyReport {
  const parsed = parseUnifiedDiff(patchText);
  const violations: string[] = [];
  const warnings: string[] = [];

  if (!diagnosis.repairAllowed || !automaticallyRepairable.has(diagnosis.category)) {
    violations.push(`Diagnosis category ${diagnosis.category} is not eligible for automatic repair`);
  }
  if (parsed.paths.length === 0) {
    violations.push("Patch contains no changed files");
  }
  if (parsed.paths.length > policy.maxChangedFiles) {
    violations.push(
      `Patch changes ${parsed.paths.length} files, above the limit of ${policy.maxChangedFiles}`,
    );
  }
  if (parsed.added.length > policy.maxAddedLines) {
    violations.push(
      `Patch adds ${parsed.added.length} lines, above the limit of ${policy.maxAddedLines}`,
    );
  }

  for (const path of parsed.paths) {
    if (!policy.allowedWriteGlobs.some((pattern) => matchesGlob(path, pattern))) {
      violations.push(`Path is outside the allowed repair surface: ${path}`);
    }
    if (policy.forbiddenGlobs.some((pattern) => matchesGlob(path, pattern))) {
      violations.push(`Path is explicitly forbidden: ${path}`);
    }
  }

  const addedText = parsed.added.join("\n").toLowerCase();
  const deletedText = parsed.deleted.join("\n").toLowerCase();
  if (!policy.allowSkipMarkers && hasSkipWeakening(addedText)) {
    violations.push("Patch introduces a skip, expected-failure, ignore, or disabled-test marker");
  }
  if (hasExceptionSwallowing(addedText)) {
    violations.push("Patch appears to swallow an exception or failure");
  }
  if (hasUnconditionalPass(addedText)) {
    violations.push("Patch introduces an unconditional success path in test code");
  }

  const deletedAssertions = parsed.deleted.filter(isAssertionLine).length;
  const addedAssertions = parsed.added.filter(isAssertionLine).length;
  if (deletedAssertions > addedAssertions) {
    violations.push(
      `Patch removes ${deletedAssertions} assertion-like lines but adds only ${addedAssertions}`,
    );
  }
  if (deletedText.includes("expected") && !addedText.includes("expected")) {
    warnings.push("Patch removes text associated with an expected outcome; review oracle preservation");
  }
  if (addedText.includes("tolerance") || addedText.includes("epsilon")) {
    warnings.push("Patch changes numeric tolerance semantics; human review may be required");
  }

  return {
    safe: violations.length === 0,
    changedPaths: parsed.paths,
    addedLines: parsed.added.length,
    deletedLines: parsed.deleted.length,
    violations,
    warnings,
  };
}

export interface ParsedDiff {
  readonly paths: readonly string[];
  readonly added: readonly string[];
  readonly deleted: readonly string[];
}

export function parseUnifiedDiff(patchText: string): ParsedDiff {
  const paths = new Set<string>();
  const added: string[] = [];
  const deleted: string[] = [];

  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const candidate = line.slice(4).trim().split("\t")[0] ?? "";
      if (candidate !== "/dev/null") {
        paths.add(normalizeDiffPath(candidate));
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deleted.push(line.slice(1));
    }
  }

  return { paths: [...paths].sort(), added, deleted };
}

export function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  let expression = "^";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index] ?? "";
    const next = normalizedPattern[index + 1];
    if (character === "*" && next === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegExp(character);
    }
  }
  expression += "$";
  return new RegExp(expression).test(normalizedPath);
}

function normalizeDiffPath(path: string): string {
  return path.replace(/^[ab]\//, "").replaceAll("\\", "/");
}

function isAssertionLine(line: string): boolean {
  const text = line.trim().toLowerCase();
  return /^(assert\b|expect\b|require\b|check\b)/.test(text) ||
    text.includes(".should(") ||
    text.includes(".toequal(") ||
    text.includes(".to_equal(");
}

function hasSkipWeakening(text: string): boolean {
  return [
    "skip(",
    "skipif",
    "xfail",
    "expectedfailure",
    "@ignore",
    "disabled = true",
    "test.skip",
    "describe.skip",
  ].some((needle) => text.includes(needle));
}

function hasExceptionSwallowing(text: string): boolean {
  return [
    "except exception:\n    pass",
    "catch (",
    "catch(",
  ].some((needle) => text.includes(needle)) &&
    ["pass", "return true", "return nil", "// ignore"].some((needle) => text.includes(needle));
}

function hasUnconditionalPass(text: string): boolean {
  return [
    "assert true",
    "return true //",
    "return true;",
    "expect(true)",
  ].some((needle) => text.includes(needle));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
