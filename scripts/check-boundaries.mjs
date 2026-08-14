import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../", import.meta.url);
const sourceRoot = new URL("../src/", import.meta.url);
const forbiddenCoreTerms = [
  "pytest",
  "go test",
  "junit",
  "lcov",
  "cobertura",
  "gitlab",
  "github actions",
  "openapi",
];
const piPackage = "@earendil-works/pi-agent-core";
const violations = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
    } else if ([".ts", ".mts", ".cts"].includes(extname(entry.name))) {
      await inspect(path);
    }
  }
}

async function inspect(path) {
  const text = await readFile(path, "utf8");
  const projectPath = relative(root.pathname, path);
  const normalized = projectPath.replaceAll("\\", "/");

  if (text.includes(piPackage) && !normalized.startsWith("src/runtime/pi/")) {
    violations.push(`${normalized}: pi SDK import outside src/runtime/pi`);
  }

  if (normalized.startsWith("src/core/") || normalized === "src/state-machine.ts") {
    const lower = text.toLowerCase();
    for (const term of forbiddenCoreTerms) {
      if (lower.includes(term)) {
        violations.push(`${normalized}: ecosystem-specific term '${term}' in core`);
      }
    }
  }
}

await walk(sourceRoot.pathname);
if (violations.length > 0) {
  console.error("Architecture boundary violations:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Architecture boundaries: PASS");
}
