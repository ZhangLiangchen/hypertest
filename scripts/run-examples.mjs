import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(new URL("../", import.meta.url).pathname);
const examples = [
  ["python-http-pytest", "profiles/python-http-pytest.example.json"],
  ["go-cli-go-test", "profiles/go-cli-go-test.example.json"],
];

for (const [name, profile] of examples) {
  const artifactRoot = await mkdtemp(join(tmpdir(), `hypertest-${name}-`));
  try {
    const runId = `conformance-${name}-${Date.now()}`;
    const output = await execute([
      "dist/src/cli.js",
      "run",
      "--profile",
      profile,
      "--workspace",
      ".",
      "--mode",
      "execute",
      "--run-id",
      runId,
      "--artifact-root",
      artifactRoot,
      "--revision",
      "conformance-revision",
    ]);
    const summary = JSON.parse(output);
    if (summary.finalState !== "verified") {
      throw new Error(`${name} did not verify: ${output}`);
    }
    const summaryPath = join(artifactRoot, "runs", runId, "artifacts", "run-summary.json");
    const persisted = JSON.parse(await readFile(summaryPath, "utf8"));
    if (persisted.finalState !== "verified") {
      throw new Error(`${name} persisted summary is not verified`);
    }
    console.log(`${name}: PASS (${Object.keys(summary.artifacts ?? {}).join(", ")})`);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
}

async function execute(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`HyperTest exited ${code}: ${stderr || stdout}`));
    });
  });
}
