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
const piPackageFragments = ["pi-agent-core", "@earendil-works/pi"];
const violations = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if ([".ts", ".mts", ".cts"].includes(extname(entry.name))) await inspect(path);
  }
}

async function inspect(path) {
  const text = await readFile(path, "utf8");
  const normalized = relative(root.pathname, path).replaceAll("\\", "/");
  const lower = text.toLowerCase();

  if (
    piPackageFragments.some((fragment) => lower.includes(fragment.toLowerCase())) &&
    !normalized.startsWith("src/runtime/pi/")
  ) {
    violations.push(`${normalized}: pi SDK reference outside src/runtime/pi`);
  }

  const isAdapter = normalized.startsWith("src/adapters/");
  const isAdapterCli = normalized === "src/adapter-cli.ts";
  const isProfileExampleAwareCli = normalized === "src/cli.ts";
  if (!isAdapter && !isAdapterCli && !isProfileExampleAwareCli) {
    for (const term of ecosystemTerms) {
      if (lower.includes(term)) {
        violations.push(`${normalized}: ecosystem-specific term '${term}' outside adapter boundary`);
      }
    }
  }

  if (normalized.startsWith("src/adapters/") && text.includes("@earendil-works/pi")) {
    violations.push(`${normalized}: adapter imports the agent SDK`);
  }
}

await walk(sourceRoot.pathname);
if (violations.length > 0) {
  console.error("Architecture boundary violations:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Architecture boundaries: PASS");
}
