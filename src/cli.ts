#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Json, RunRequest } from "./contracts.js";
import { resolveModelConfig } from "./model-config.js";
import { HyperTestOrchestrator } from "./orchestrator.js";
import { loadProfile } from "./profile.js";
import { runProcess } from "./process.js";
import { FakeAgentRuntime } from "./runtime.js";
import { createOpenAICompatibleRuntime } from "./runtime/pi/openai-compatible.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

try {
  if (command === "run" || command === "plan") {
    const profilePath = requiredOption(args, "--profile");
    const workspacePath = resolve(option(args, "--workspace") ?? ".");
    const profile = await loadProfile(profilePath);
    const revision = option(args, "--revision") ?? (await detectRevision(workspacePath));
    const mode = command === "plan"
      ? "plan"
      : parseMode(option(args, "--mode") ?? "execute");
    const runId = option(args, "--run-id") ?? `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const request: RunRequest = {
      schema: "hypertest.run-request/v1",
      runId,
      profilePath: resolve(profilePath),
      workspacePath,
      sourceRevision: revision,
      mode,
      budget: profile.runtime.budgets,
    };
    const fakeResult = option(args, "--fake-result");
    const runtime = fakeResult === undefined
      ? createConfiguredRuntime(profile.runtime)
      : new FakeAgentRuntime(JSON.parse(fakeResult) as Json);
    const orchestrator = new HyperTestOrchestrator({
      artifactRoot: option(args, "--artifact-root") ?? resolve(workspacePath, ".testagent"),
      ...(runtime === undefined ? {} : { runtime }),
    });
    const summary = await orchestrator.run(request);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (["failed", "rejected"].includes(summary.finalState)) process.exitCode = 1;
  } else if (command === "validate-profile") {
    const path = requiredOption(args, "--profile");
    const profile = await loadProfile(path);
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
  } else if (command === "init") {
    const output = resolve(option(args, "--profile") ?? "profiles/hypertest.local.json");
    const kind = option(args, "--kind") ?? "http";
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(initialProfile(kind), null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`Created ${output}\n`);
  } else if (command === "version" || args.includes("--version")) {
    process.stdout.write("hypertest 0.1.0\n");
  } else {
    printHelp();
    if (command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 64;
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}

function createConfiguredRuntime(
  settings: Parameters<typeof resolveModelConfig>[0],
) {
  const config = resolveModelConfig(settings);
  return config.provider === "deterministic"
    ? undefined
    : createOpenAICompatibleRuntime(config);
}

function initialProfile(kind: string): Json {
  const adapterCli = fileURLToPath(new URL("./adapter-cli.js", import.meta.url));
  const isCommand = kind === "command";
  return {
    schema: "hypertest.profile/v1",
    name: isCommand ? "command-system" : "http-service",
    runtime: {
      provider: "deterministic",
      budgets: {
        maxTurns: 20,
        maxToolCalls: 60,
        maxRepairRounds: 2,
        wallClockMs: 1_800_000,
        tokenBudget: 100_000,
      },
    },
    sut: {
      contractSource: isCommand ? "contract.command.json" : "openapi.json",
      sourceKind: isCommand ? "command-contract" : "openapi",
    },
    adapters: {
      sut: {
        command: process.execPath,
        args: [adapterCli, "--adapter", isCommand ? "sut-command" : "sut-http-openapi"],
      },
      test: {
        command: process.execPath,
        args: [adapterCli, "--adapter", isCommand ? "test-go" : "test-pytest"],
        config: {
          command: isCommand
            ? ["go", "test", "-json", "-coverprofile=.hypertest-cover.out", "./..."]
            : ["python3", "-m", "pytest", "-q", "--junitxml=.hypertest-junit.xml"],
          resultPath: ".hypertest-junit.xml",
          coveragePath: isCommand ? ".hypertest-cover.out" : ".coverage.json",
        },
      },
      coverage: {
        command: process.execPath,
        args: [adapterCli, "--adapter", isCommand ? "coverage-go" : "coverage-json"],
      },
    },
    gate: { mode: "static-allow" },
    workspace: {
      allowedWriteGlobs: isCommand ? ["**/*_test.go"] : ["tests/**"],
      forbiddenGlobs: [".git/**", "src/**", "cmd/**"],
    },
  };
}

function parseMode(value: string): RunRequest["mode"] {
  if (!["plan", "execute", "repair", "propose"].includes(value)) {
    throw new Error(`Invalid mode: ${value}`);
  }
  return value as RunRequest["mode"];
}

async function detectRevision(workspace: string): Promise<string> {
  const result = await runProcess({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: workspace,
    timeoutMs: 10_000,
  });
  if (result.exitCode === 0 && /^[a-f0-9]{40,64}$/i.test(result.stdout.trim())) {
    return result.stdout.trim();
  }
  return "unversioned";
}

function option(values: readonly string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index < 0 ? undefined : values[index + 1];
}

function requiredOption(values: readonly string[], name: string): string {
  const value = option(values, name);
  if (value === undefined) throw new Error(`Missing required option ${name}`);
  return value;
}

function printHelp(): void {
  process.stdout.write(`HyperTest\n\n` +
    `Usage:\n` +
    `  hypertest plan --profile <file> [--workspace <dir>]\n` +
    `  hypertest run --profile <file> [--mode execute|repair|propose]\n` +
    `  hypertest validate-profile --profile <file>\n` +
    `  hypertest init [--kind http|command] [--profile <file>]\n` +
    `  hypertest version\n\n` +
    `Development testing:\n` +
    `  --fake-result <json>  explicitly bypass the configured model runtime\n`);
}
