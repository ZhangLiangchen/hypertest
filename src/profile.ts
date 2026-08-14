import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { Json, RunBudget } from "./contracts.js";

export interface AdapterCommandProfile {
  readonly executable?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly config?: Json;
}

export interface HyperTestProfile {
  readonly schema: "hypertest.profile/v1";
  readonly name: string;
  readonly runtime: {
    readonly provider: "deterministic" | "fake" | "pi";
    readonly model?: string;
    readonly budgets: RunBudget;
  };
  readonly sut: {
    readonly contractSource: string;
    readonly sourceKind: string;
  };
  readonly adapters: {
    readonly sut: AdapterCommandProfile;
    readonly test: AdapterCommandProfile;
    readonly coverage?: AdapterCommandProfile;
    readonly code?: AdapterCommandProfile;
    readonly sandbox?: AdapterCommandProfile;
    readonly ci?: AdapterCommandProfile;
    readonly scm?: AdapterCommandProfile;
    readonly knowledge?: AdapterCommandProfile;
  };
  readonly gate: {
    readonly mode: "static-allow" | "static-deny" | "process";
    readonly process?: AdapterCommandProfile;
  };
  readonly workspace: {
    readonly allowedWriteGlobs: readonly string[];
    readonly forbiddenGlobs: readonly string[];
  };
  readonly options?: Readonly<Record<string, Json>>;
}

export async function loadProfile(path: string): Promise<HyperTestProfile> {
  const absolute = resolve(path);
  const text = await readFile(absolute, "utf8");
  const parsed = parseDataDocument(text);
  const profile = validateProfile(parsed);
  const base = dirname(absolute);
  return {
    ...profile,
    sut: {
      ...profile.sut,
      contractSource: resolveProfilePath(base, profile.sut.contractSource),
    },
    adapters: mapAdapterPaths(profile.adapters, base),
    gate: {
      ...profile.gate,
      ...(profile.gate.process === undefined
        ? {}
        : { process: resolveAdapter(profile.gate.process, base) }),
    },
  };
}

export function parseDataDocument(text: string): Json {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("Configuration document is empty");
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as Json;
  }
  return parseSimpleYaml(text);
}

export function validateProfile(value: Json): HyperTestProfile {
  const root = expectRecord(value, "profile");
  if (root.schema !== "hypertest.profile/v1") {
    throw new Error("Profile schema must be hypertest.profile/v1");
  }
  const name = expectString(root.name, "profile.name");
  const runtimeInput = expectRecord(root.runtime, "profile.runtime");
  const provider = expectString(runtimeInput.provider, "runtime.provider");
  if (!["deterministic", "fake", "pi"].includes(provider)) {
    throw new Error(`Unsupported runtime provider: ${provider}`);
  }
  const budgetInput =
    runtimeInput.budgets === undefined
      ? runtimeInput
      : expectRecord(runtimeInput.budgets, "runtime.budgets");
  const budgets: RunBudget = {
    maxTurns: expectPositiveInteger(budgetInput.maxTurns ?? 20, "maxTurns"),
    maxToolCalls: expectPositiveInteger(
      budgetInput.maxToolCalls ?? 60,
      "maxToolCalls",
    ),
    maxRepairRounds: expectNonNegativeInteger(
      budgetInput.maxRepairRounds ?? runtimeInput.max_repair_rounds ?? 2,
      "maxRepairRounds",
    ),
    wallClockMs: expectPositiveInteger(
      budgetInput.wallClockMs ?? 1_800_000,
      "wallClockMs",
    ),
    tokenBudget: expectPositiveInteger(
      budgetInput.tokenBudget ?? 100_000,
      "tokenBudget",
    ),
  };

  const sutInput = expectRecord(root.sut, "profile.sut");
  const contractSource = expectString(
    sutInput.contractSource ?? sutInput.contract_source,
    "sut.contractSource",
  );
  const sourceKind = expectString(
    sutInput.sourceKind ?? sutInput.source_kind,
    "sut.sourceKind",
  );

  const adaptersInput = expectRecord(root.adapters, "profile.adapters");
  const gateInput = expectRecord(root.gate ?? { mode: "static-allow" }, "profile.gate");
  const gateMode = expectString(gateInput.mode, "gate.mode");
  if (!["static-allow", "static-deny", "process"].includes(gateMode)) {
    throw new Error(`Unsupported gate mode: ${gateMode}`);
  }
  const workspaceInput = expectRecord(
    root.workspace ?? {},
    "profile.workspace",
  );

  return {
    schema: "hypertest.profile/v1",
    name,
    runtime: {
      provider: provider as HyperTestProfile["runtime"]["provider"],
      ...(runtimeInput.model === undefined
        ? {}
        : { model: expectString(runtimeInput.model, "runtime.model") }),
      budgets,
    },
    sut: { contractSource, sourceKind },
    adapters: {
      sut: parseAdapter(adaptersInput.sut, "adapters.sut"),
      test: parseAdapter(adaptersInput.test, "adapters.test"),
      ...(adaptersInput.coverage === undefined
        ? {}
        : { coverage: parseAdapter(adaptersInput.coverage, "adapters.coverage") }),
      ...(adaptersInput.code === undefined
        ? {}
        : { code: parseAdapter(adaptersInput.code, "adapters.code") }),
      ...(adaptersInput.sandbox === undefined
        ? {}
        : { sandbox: parseAdapter(adaptersInput.sandbox, "adapters.sandbox") }),
      ...(adaptersInput.ci === undefined
        ? {}
        : { ci: parseAdapter(adaptersInput.ci, "adapters.ci") }),
      ...(adaptersInput.scm === undefined
        ? {}
        : { scm: parseAdapter(adaptersInput.scm, "adapters.scm") }),
      ...(adaptersInput.knowledge === undefined
        ? {}
        : { knowledge: parseAdapter(adaptersInput.knowledge, "adapters.knowledge") }),
    },
    gate: {
      mode: gateMode as HyperTestProfile["gate"]["mode"],
      ...(gateInput.process === undefined
        ? {}
        : { process: parseAdapter(gateInput.process, "gate.process") }),
    },
    workspace: {
      allowedWriteGlobs: expectStringArray(
        workspaceInput.allowedWriteGlobs ??
          workspaceInput.allowed_write_globs ??
          ["tests/**", "fixtures/**"],
        "workspace.allowedWriteGlobs",
      ),
      forbiddenGlobs: expectStringArray(
        workspaceInput.forbiddenGlobs ??
          workspaceInput.forbidden_globs ??
          [".git/**"],
        "workspace.forbiddenGlobs",
      ),
    },
    ...(root.options === undefined
      ? {}
      : { options: expectRecord(root.options, "profile.options") }),
  };
}

function parseAdapter(value: Json | undefined, path: string): AdapterCommandProfile {
  if (typeof value === "string") {
    return { executable: value };
  }
  const record = expectRecord(value, path);
  const executable = record.executable ?? record.command;
  if (typeof executable !== "string" || executable.length === 0) {
    throw new Error(`${path} requires executable or command`);
  }
  return {
    ...(record.executable === undefined
      ? { command: expectString(record.command, `${path}.command`) }
      : { executable: expectString(record.executable, `${path}.executable`) }),
    ...(record.args === undefined
      ? {}
      : { args: expectStringArray(record.args, `${path}.args`) }),
    ...(record.cwd === undefined
      ? {}
      : { cwd: expectString(record.cwd, `${path}.cwd`) }),
    ...(record.env === undefined
      ? {}
      : { env: expectStringRecord(record.env, `${path}.env`) }),
    ...(record.timeoutMs === undefined && record.timeout_ms === undefined
      ? {}
      : {
          timeoutMs: expectPositiveInteger(
            (record.timeoutMs ?? record.timeout_ms)!,
            `${path}.timeoutMs`,
          ),
        }),
    ...(record.config === undefined ? {} : { config: record.config }),
  };
}

function mapAdapterPaths(
  adapters: HyperTestProfile["adapters"],
  base: string,
): HyperTestProfile["adapters"] {
  return Object.fromEntries(
    Object.entries(adapters).map(([key, value]) => [
      key,
      resolveAdapter(value as AdapterCommandProfile, base),
    ]),
  ) as unknown as HyperTestProfile["adapters"];
}

function resolveAdapter(
  adapter: AdapterCommandProfile,
  base: string,
): AdapterCommandProfile {
  const executable = adapter.executable ?? adapter.command;
  if (executable === undefined) {
    return adapter;
  }
  const resolved = resolveExecutable(base, executable);
  return {
    ...adapter,
    ...(adapter.executable === undefined
      ? { command: resolved }
      : { executable: resolved }),
    ...(adapter.cwd === undefined
      ? {}
      : { cwd: resolveProfilePath(base, adapter.cwd) }),
  };
}

function resolveExecutable(base: string, executable: string): string {
  if (
    isAbsolute(executable) ||
    (!executable.startsWith(".") && !executable.includes("/"))
  ) {
    return executable;
  }
  return resolve(base, executable);
}

function resolveProfilePath(base: string, value: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}

function expectRecord(value: Json | undefined, path: string): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function expectString(value: Json | undefined, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function expectStringArray(value: Json, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${path} must be a string array`);
  }
  return [...value] as string[];
}

function expectStringRecord(
  value: Json,
  path: string,
): Readonly<Record<string, string>> {
  const record = expectRecord(value, path);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    output[key] = expectString(item, `${path}.${key}`);
  }
  return output;
}

function expectPositiveInteger(value: Json, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value;
}

function expectNonNegativeInteger(value: Json, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value;
}

interface YamlFrame {
  readonly indent: number;
  readonly container: Record<string, Json> | Json[];
  readonly pendingKey?: string;
}

function parseSimpleYaml(text: string): Json {
  const root: Record<string, Json> = {};
  const stack: YamlFrame[] = [{ indent: -1, container: root }];
  const lines = text.replaceAll("\t", "  ").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const withoutComment = stripComment(raw);
    if (withoutComment.trim().length === 0) {
      continue;
    }
    const indent = withoutComment.length - withoutComment.trimStart().length;
    const content = withoutComment.trim();

    while (stack.length > 1 && indent <= (stack.at(-1)?.indent ?? -1)) {
      stack.pop();
    }
    const frame = stack.at(-1);
    if (frame === undefined) {
      throw new Error(`Invalid YAML structure at line ${index + 1}`);
    }

    if (content.startsWith("- ") || content === "-") {
      if (!Array.isArray(frame.container)) {
        throw new Error(`List item without list parent at line ${index + 1}`);
      }
      const itemText = content === "-" ? "" : content.slice(2).trim();
      if (itemText.length === 0) {
        const child: Record<string, Json> = {};
        frame.container.push(child);
        stack.push({ indent, container: child });
      } else if (itemText.includes(":")) {
        const child: Record<string, Json> = {};
        frame.container.push(child);
        const [key, value] = splitKeyValue(itemText, index + 1);
        child[key] = parseScalar(value);
        stack.push({ indent, container: child });
      } else {
        frame.container.push(parseScalar(itemText));
      }
      continue;
    }

    if (Array.isArray(frame.container)) {
      throw new Error(`Mapping entry inside scalar list at line ${index + 1}`);
    }
    const [key, value] = splitKeyValue(content, index + 1);
    if (value.length > 0) {
      frame.container[key] = parseScalar(value);
      continue;
    }

    const next = nextMeaningfulLine(lines, index + 1);
    const nextContent = next?.text.trim() ?? "";
    const child: Record<string, Json> | Json[] = nextContent.startsWith("-")
      ? []
      : {};
    frame.container[key] = child;
    stack.push({ indent, container: child });
  }
  return root;
}

function splitKeyValue(text: string, line: number): [string, string] {
  const colon = text.indexOf(":");
  if (colon <= 0) {
    throw new Error(`Expected key: value at YAML line ${line}`);
  }
  return [text.slice(0, colon).trim(), text.slice(colon + 1).trim()];
}

function parseScalar(value: string): Json {
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") || value.startsWith("{")) {
    try {
      return JSON.parse(value.replaceAll("'", '"')) as Json;
    } catch {
      // Fall through to a plain string. The supported YAML subset is explicit.
    }
  }
  return value;
}

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === '"' || character === "'") && line[index - 1] !== "\\") {
      quote = quote === character ? undefined : quote ?? character;
    } else if (character === "#" && quote === undefined) {
      return line.slice(0, index);
    }
  }
  return line;
}

function nextMeaningfulLine(
  lines: readonly string[],
  start: number,
): { readonly text: string } | undefined {
  for (let index = start; index < lines.length; index += 1) {
    const text = stripComment(lines[index] ?? "");
    if (text.trim().length > 0) {
      return { text };
    }
  }
  return undefined;
}
