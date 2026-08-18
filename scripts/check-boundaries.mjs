import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../", import.meta.url);
const sourceRoot = new URL("../src/", import.meta.url);
const ecosystemTerms = [
  "pytest",
  "go test",
  "junit",
  "lcov",
  "cobertura",
  "gitlab",
  "github actions",
  "openapi",
];
const piPackagePattern = /@earendil-works\/pi-(?:agent-core|ai)/i;
const forbiddenAgentDependencyFragments = [
  "codex",
  "opencode",
  "openhands",
  "metagpt",
  "hermes",
];
const violations = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if ([".ts", ".mts", ".cts"].includes(extname(entry.name))) {
      await inspect(path);
    }
  }
}

async function inspect(path) {
  const text = await readFile(path, "utf8");
  const normalized = relative(root.pathname, path).replaceAll("\\", "/");
  const lower = text.toLowerCase();
  const isPiBoundary = normalized.startsWith("src/runtime/pi/");

  if (piPackagePattern.test(text) && !isPiBoundary) {
    violations.push(`${normalized}: Pi SDK reference outside src/runtime/pi`);
  }

  if (isPiBoundary) {
    if (/\b(?:as\s+)?any\b/.test(text)) {
      violations.push(`${normalized}: any is forbidden in the Pi adapter`);
    }
    if (/unknown\s+as\s+Pi[A-Z]/.test(text)) {
      violations.push(`${normalized}: unsafe unknown-as-Pi assertion`);
    }
    if (/\bimport\s*\(/.test(text)) {
      violations.push(`${normalized}: dynamic import is forbidden in the Pi adapter`);
    }
    if (/\.join\s*\(\s*["']\/["']\s*\)/.test(text)) {
      violations.push(`${normalized}: dynamic package path assembly is forbidden`);
    }
  } else if (
    /^\s*(?:export\s+)?(?:interface|type)\s+Pi[A-Z][A-Za-z0-9_]*/m.test(
      text,
    )
  ) {
    violations.push(`${normalized}: Pi shadow type outside src/runtime/pi`);
  }

  if (
    (normalized === "src/runtime.ts" || normalized.startsWith("src/runtime/")) &&
    /return\s*\{\s*text\s*:/.test(text)
  ) {
    violations.push(`${normalized}: invalid model output text fallback`);
  }

  if (/\bfork\s*\(/.test(text)) {
    violations.push(`${normalized}: process fork is forbidden`);
  }

  const isAdapter = normalized.startsWith("src/adapters/");
  const isAdapterCli = normalized === "src/adapter-cli.ts";
  const isProfileExampleAwareCli = normalized === "src/cli.ts";
  if (!isAdapter && !isAdapterCli && !isProfileExampleAwareCli) {
    for (const term of ecosystemTerms) {
      if (lower.includes(term)) {
        violations.push(
          `${normalized}: ecosystem-specific term '${term}' outside adapter boundary`,
        );
      }
    }
  }

  if (isAdapter && piPackagePattern.test(text)) {
    violations.push(`${normalized}: adapter imports the agent SDK`);
  }
}

async function inspectDependencies() {
  const packageDocument = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const dependencyNames = Object.keys({
    ...(packageDocument.dependencies ?? {}),
    ...(packageDocument.devDependencies ?? {}),
    ...(packageDocument.optionalDependencies ?? {}),
  });
  for (const name of dependencyNames) {
    const lower = name.toLowerCase();
    if (
      forbiddenAgentDependencyFragments.some((fragment) =>
        lower.includes(fragment),
      )
    ) {
      violations.push(`${name}: second agent SDK dependency is forbidden`);
    }
  }
  const piDependencies = dependencyNames.filter((name) =>
    piPackagePattern.test(name),
  );
  const allowedPiDependencies = new Set([
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
  ]);
  for (const name of piDependencies) {
    if (!allowedPiDependencies.has(name)) {
      violations.push(`${name}: unapproved Pi package dependency`);
    }
  }
  if (!dependencyNames.includes("@earendil-works/pi-agent-core")) {
    violations.push("package.json: missing sole SDK-level agent runtime");
  }
}

await walk(sourceRoot.pathname);
await inspectDependencies();
if (violations.length > 0) {
  console.error("Architecture boundary violations:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Architecture boundaries: PASS");
}
