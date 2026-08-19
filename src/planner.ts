import { createHash } from "node:crypto";

import type {
  ArtifactRef,
  Json,
  JsonSchemaShape,
  SutContract,
  SutOperation,
  TestOracle,
  TestPlan,
  TestPlanCase,
} from "./contracts.js";
import type {
  AgentEvent,
  AgentRuntime,
  AgentToolDefinition,
  AgentToolExecutionOutcome,
  AgentToolExecutor,
  AgentUsageSummary,
} from "./runtime.js";
import {
  AgentRuntimeError,
  collectAgentRun,
  emptyAgentUsageSummary,
} from "./runtime.js";

export interface PlanOptions {
  readonly maxCasesPerOperation?: number;
  readonly includeDestructive?: boolean;
  readonly runtime?: AgentRuntime;
  readonly runId?: string;
  readonly tokenBudget?: number;
  readonly deadlineEpochMs?: number;
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxRepeatedToolCalls?: number;
  readonly onUsage?: (summary: AgentUsageSummary) => void | Promise<void>;
  readonly onAgentEvent?: (event: AgentEvent) => void | Promise<void>;
}

export async function createTestPlan(
  contract: SutContract,
  contractRef: ArtifactRef<"sut-contract">,
  options: PlanOptions = {},
): Promise<TestPlan> {
  const deterministic = contract.operations.flatMap((operation) =>
    createOperationCases(operation, contractRef, options),
  );
  const modelCases =
    options.runtime === undefined
      ? await recordDeterministicUsage(options)
      : await requestModelCases(contract, contractRef, options);
  const merged = deduplicateCases([...deterministic, ...modelCases]);
  return {
    schema: "hypertest.test-plan/v1",
    sutContractHash: contractRef.sha256,
    sourceRevision: contract.sourceRevision,
    generatedAtEpochMs: Date.now(),
    cases: merged,
    uncoveredRisks: contract.operations
      .filter((operation) => operation.effects === "destructive" && !options.includeDestructive)
      .map((operation) => `${operation.id}: destructive operation deferred`),
  };
}

function createOperationCases(
  operation: SutOperation,
  contractRef: ArtifactRef<"sut-contract">,
  options: PlanOptions,
): TestPlanCase[] {
  if (operation.effects === "destructive" && !options.includeDestructive) {
    return [];
  }

  const max = options.maxCasesPerOperation ?? 12;
  const provenance = [contractRef] as const;
  const base = defaultValue(operation.inputSchema);
  const candidates: Array<{
    readonly suffix: string;
    readonly title: string;
    readonly objective: string;
    readonly input: Json;
    readonly dimensions: readonly string[];
    readonly severity: TestPlanCase["risk"]["severity"];
    readonly expectedValidity: "valid" | "invalid" | "unknown";
  }> = [
    {
      suffix: "happy",
      title: `${operation.title ?? operation.id}: representative valid input`,
      objective: `Verify the representative success behavior of ${operation.id}`,
      input: base,
      dimensions: ["representative", "success-path"],
      severity: operation.effects === "none" || operation.effects === "read" ? "medium" : "high",
      expectedValidity: "valid",
    },
  ];

  for (const variant of schemaVariants(operation.inputSchema, base)) {
    candidates.push({
      suffix: variant.id,
      title: `${operation.title ?? operation.id}: ${variant.title}`,
      objective: variant.objective,
      input: variant.value,
      dimensions: variant.dimensions,
      severity: variant.severity,
      expectedValidity: variant.expectedValidity,
    });
  }

  return candidates.slice(0, max).map((candidate, index) => ({
    id: stableCaseId(operation.id, candidate.suffix, index),
    title: candidate.title,
    objective: candidate.objective,
    operationIds: [operation.id],
    preconditions: operation.preconditions,
    steps: [{ operationId: operation.id, input: candidate.input }],
    oracles: buildOracles(operation, candidate.expectedValidity),
    risk: {
      severity: candidate.severity,
      dimensions: candidate.dimensions,
    },
    provenance,
    generatedBy: "deterministic",
  }));
}

function schemaVariants(
  schema: JsonSchemaShape,
  base: Json,
): Array<{
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly value: Json;
  readonly dimensions: readonly string[];
  readonly severity: TestPlanCase["risk"]["severity"];
  readonly expectedValidity: "valid" | "invalid" | "unknown";
}> {
  const variants: Array<{
    id: string;
    title: string;
    objective: string;
    value: Json;
    dimensions: string[];
    severity: TestPlanCase["risk"]["severity"];
    expectedValidity: "valid" | "invalid" | "unknown";
  }> = [];

  if (isRecord(base) && schema.properties !== undefined) {
    for (const required of schema.required ?? []) {
      const copy = { ...base };
      delete copy[required];
      variants.push({
        id: `missing-${slug(required)}`,
        title: `missing required field ${required}`,
        objective: `Verify rejection or safe handling when ${required} is absent`,
        value: copy,
        dimensions: ["required-field", "negative"],
        severity: "high",
        expectedValidity: "invalid",
      });
    }

    for (const [name, property] of Object.entries(schema.properties)) {
      const values = boundaryValues(property);
      for (const item of values) {
        variants.push({
          id: `${slug(name)}-${item.id}`,
          title: `${name} ${item.title}`,
          objective: `Verify ${name} at ${item.title}`,
          value: { ...base, [name]: item.value },
          dimensions: ["boundary", item.valid ? "valid" : "negative"],
          severity: item.valid ? "medium" : "high",
          expectedValidity: item.valid ? "valid" : "invalid",
        });
      }
    }
  } else {
    for (const item of boundaryValues(schema)) {
      variants.push({
        id: item.id,
        title: item.title,
        objective: `Verify the operation at ${item.title}`,
        value: item.value,
        dimensions: ["boundary", item.valid ? "valid" : "negative"],
        severity: item.valid ? "medium" : "high",
        expectedValidity: item.valid ? "valid" : "invalid",
      });
    }
  }
  return variants;
}

function boundaryValues(
  schema: JsonSchemaShape,
): Array<{ readonly id: string; readonly title: string; readonly value: Json; readonly valid: boolean }> {
  const output: Array<{
    id: string;
    title: string;
    value: Json;
    valid: boolean;
  }> = [];
  if (schema.enum !== undefined) {
    schema.enum.forEach((value, index) => {
      output.push({ id: `enum-${index + 1}`, title: `enum member ${index + 1}`, value, valid: true });
    });
    output.push({ id: "outside-enum", title: "outside the declared enum", value: "__hypertest_invalid_enum__", valid: false });
    return output;
  }

  const type = primaryType(schema);
  if (type === "integer" || type === "number") {
    if (schema.minimum !== undefined) {
      output.push({ id: "minimum", title: "at the minimum", value: schema.minimum, valid: true });
      output.push({ id: "below-minimum", title: "below the minimum", value: schema.minimum - 1, valid: false });
    }
    if (schema.maximum !== undefined) {
      output.push({ id: "maximum", title: "at the maximum", value: schema.maximum, valid: true });
      output.push({ id: "above-maximum", title: "above the maximum", value: schema.maximum + 1, valid: false });
    }
    if (schema.minimum === undefined && schema.maximum === undefined) {
      output.push(
        { id: "zero", title: "zero", value: 0, valid: true },
        { id: "negative", title: "a negative value", value: -1, valid: true },
      );
    }
  } else if (type === "string") {
    output.push({ id: "empty", title: "as an empty string", value: "", valid: (schema.minLength ?? 0) === 0 });
    if (schema.minLength !== undefined && schema.minLength > 0) {
      output.push({ id: "min-length", title: "at minimum length", value: "x".repeat(schema.minLength), valid: true });
      output.push({ id: "below-min-length", title: "below minimum length", value: "x".repeat(Math.max(0, schema.minLength - 1)), valid: false });
    }
    if (schema.maxLength !== undefined) {
      output.push({ id: "max-length", title: "at maximum length", value: "x".repeat(schema.maxLength), valid: true });
      output.push({ id: "above-max-length", title: "above maximum length", value: "x".repeat(schema.maxLength + 1), valid: false });
    }
    if (schema.pattern !== undefined) {
      output.push({ id: "pattern-mismatch", title: "not matching the declared pattern", value: "__hypertest_pattern_mismatch__", valid: false });
    }
  } else if (type === "array") {
    output.push(
      { id: "empty-array", title: "with an empty collection", value: [], valid: true },
      { id: "single-item", title: "with one item", value: [defaultValue(schema.items ?? {})], valid: true },
    );
  } else if (type === "boolean") {
    output.push(
      { id: "true", title: "as true", value: true, valid: true },
      { id: "false", title: "as false", value: false, valid: true },
    );
  }
  return output;
}

function defaultValue(schema: JsonSchemaShape): Json {
  if (schema.default !== undefined) return schema.default;
  if (schema.examples?.[0] !== undefined) return schema.examples[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.[0] !== undefined) return schema.enum[0];
  const type = primaryType(schema);
  if (type === "object" || schema.properties !== undefined) {
    const output: Record<string, Json> = {};
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if ((schema.required ?? []).includes(name) || property.default !== undefined) {
        output[name] = defaultValue(property);
      }
    }
    return output;
  }
  if (type === "array") return [];
  if (type === "integer" || type === "number") return schema.minimum ?? 0;
  if (type === "boolean") return false;
  if (type === "null") return null;
  if (type === "string") {
    const length = Math.max(1, schema.minLength ?? 1);
    return "x".repeat(length);
  }
  return null;
}

function primaryType(schema: JsonSchemaShape): string | undefined {
  if (typeof schema.type === "string" || schema.type === undefined) return schema.type;
  return schema.type.find((item) => item !== "null");
}

function buildOracles(
  operation: SutOperation,
  expectedValidity: "valid" | "invalid" | "unknown",
): TestOracle[] {
  const hints = operation.oracleHints.map((hint, index) => ({
    kind: "sut-hint",
    expression: hint,
    rationale: `Oracle hint ${index + 1} declared by the SUT contract`,
    strength: "normal" as const,
  }));
  const baseline: TestOracle = {
    kind: "interaction-outcome",
    expression: { expectedValidity },
    rationale:
      expectedValidity === "invalid"
        ? "Invalid input must be rejected or handled without an unsafe side effect"
        : expectedValidity === "unknown"
          ? "Input validity is unknown; execution must preserve safety and surface a structured outcome without assuming success"
          : "Valid input must complete without an infrastructure or protocol failure",
    strength: expectedValidity === "unknown" ? "weak" : "normal",
  };
  return [baseline, ...hints];
}

export class PlannerModelValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PlannerModelValidationError";
  }
}

export function plannerAugmentationSchema(maxCases: number): Json {
  return {
    type: "object",
    additionalProperties: false,
    required: ["cases"],
    properties: {
      cases: {
        type: "array",
        maxItems: Math.max(0, Math.min(maxCases, 64)),
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "objective", "steps", "oracle"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 160 },
            objective: { type: "string", minLength: 1, maxLength: 1_000 },
            steps: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["operationId", "input"],
                properties: {
                  operationId: {
                    type: "string",
                    minLength: 1,
                    maxLength: 200,
                  },
                  input: {},
                },
              },
            },
            oracle: {
              type: "object",
              minProperties: 1,
              maxProperties: 32,
            },
          },
        },
      },
    },
  };
}

const PLANNER_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = Object.freeze([
  Object.freeze({
    name: "contract.list_operations",
    description:
      "List operation ids and minimal deterministic capabilities from the current in-memory SUT contract.",
    inputSchema: deepFreezeJson({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    idempotent: true,
  }),
  Object.freeze({
    name: "contract.get_operation",
    description:
      "Read a deterministic view of one operation from the current in-memory SUT contract.",
    inputSchema: deepFreezeJson({
      type: "object",
      properties: {
        operationId: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["operationId"],
      additionalProperties: false,
    }),
    idempotent: true,
  }),
]);

export function plannerToolDefinitions(): readonly AgentToolDefinition[] {
  return PLANNER_TOOL_DEFINITIONS;
}

export function createPlannerToolExecutor(
  contract: SutContract,
): AgentToolExecutor {
  const operations = new Map(
    contract.operations.map((operation) => [operation.id, operation]),
  );
  return async ({ name, input }): Promise<AgentToolExecutionOutcome> => {
    if (name === "contract.list_operations") {
      return {
        status: "ok",
        output: {
          operations: contract.operations.map((operation) => ({
            operationId: operation.id,
            ...(operation.title === undefined
              ? {}
              : { title: operation.title }),
            effects: operation.effects,
            interactionKind: operation.interactionKind,
            inputSchemaDigest: digestJson(operation.inputSchema),
            capability: {
              preconditionCount: operation.preconditions.length,
              oracleHintCount: operation.oracleHints.length,
              tags: operation.tags.slice(0, 16),
            },
          })),
        },
      };
    }
    if (name === "contract.get_operation") {
      if (!isRecord(input) || typeof input.operationId !== "string") {
        return plannerToolError(
          "invalid_tool_input",
          "contract.get_operation requires a string operationId",
        );
      }
      const operation = operations.get(input.operationId);
      if (operation === undefined) {
        return plannerToolError(
          "unknown_operation",
          `No operation exists for ${safeIdentifier(input.operationId)}`,
          { operationId: input.operationId },
        );
      }
      return {
        status: "ok",
        output: { operation: operationView(operation) },
      };
    }
    return plannerToolError(
      "tool_not_allowed",
      `Tool ${safeIdentifier(name)} is not in the planner allowlist`,
    );
  };
}

function operationView(operation: SutOperation): Json {
  return {
    operationId: operation.id,
    ...(operation.title === undefined ? {} : { title: operation.title }),
    ...(operation.description === undefined
      ? {}
      : { description: operation.description }),
    interactionKind: operation.interactionKind,
    effects: operation.effects,
    inputSchema: toJsonValue(operation.inputSchema),
    observationSchema: toJsonValue(operation.observationSchema),
    preconditions: [...operation.preconditions],
    oracleHints: [...operation.oracleHints],
    tags: [...operation.tags],
  };
}

function toJsonValue(value: unknown): Json {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, toJsonValue(item)]),
    );
  }
  return String(value);
}

function deepFreezeJson<T extends Json>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreezeJson(item);
  }
  return Object.freeze(value);
}

function plannerToolError(
  code: string,
  message: string,
  detail?: Json,
): AgentToolExecutionOutcome {
  return {
    status: "error",
    output: {
      error: {
        code,
        message,
        ...(detail === undefined ? {} : { detail }),
      },
    },
  };
}

function digestJson(value: JsonSchemaShape): string {
  return createHash("sha256").update(canonicalValue(value)).digest("hex");
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
    .join(",")}}`;
}

async function recordDeterministicUsage(
  options: PlanOptions,
): Promise<TestPlanCase[]> {
  await options.onUsage?.(
    emptyAgentUsageSummary(options.runId ?? `plan-${Date.now()}`),
  );
  return [];
}

async function requestModelCases(
  contract: SutContract,
  contractRef: ArtifactRef<"sut-contract">,
  options: PlanOptions,
): Promise<TestPlanCase[]> {
  const maxCases =
    Math.max(1, options.maxCasesPerOperation ?? 12) *
    Math.max(1, contract.operations.length);
  const runId = options.runId ?? `plan-${Date.now()}`;
  let outcome;
  try {
    outcome = await collectAgentRun(
      options.runtime!,
      {
        runId,
        phase: "test-plan-augmentation",
        systemPrompt:
          "Generate framework-neutral test cases only. Use only the declared read-only contract tools when operation details are needed. Never emit test source code. Return only JSON matching the supplied result schema.",
        prompt: JSON.stringify({
          contract: {
            id: contract.id,
            title: contract.title,
            sourceRevision: contract.sourceRevision,
            operationCount: contract.operations.length,
            lifecycleCapabilities: contract.lifecycleCapabilities,
          },
          constraints: {
            maxCasesPerOperation: options.maxCasesPerOperation ?? 12,
            includeDestructive: options.includeDestructive ?? false,
          },
          workflow: [
            "Call contract.list_operations to discover operation ids and capabilities.",
            "Call contract.get_operation only for operation details needed by a proposed case.",
            "Return the final planner augmentation JSON after tool use.",
          ],
        }),
        tools: plannerToolDefinitions(),
        toolExecutor: createPlannerToolExecutor(contract),
        artifacts: [contractRef],
        tokenBudget: options.tokenBudget ?? 20_000,
        deadlineEpochMs: options.deadlineEpochMs ?? Date.now() + 120_000,
        expectedResultSchema: plannerAugmentationSchema(maxCases),
        maxTurns: options.maxTurns ?? 12,
        maxToolCalls: options.maxToolCalls ?? 24,
        maxRepeatedToolCalls: options.maxRepeatedToolCalls ?? 3,
        maxOutputBytes: 262_144,
      },
      options.onAgentEvent === undefined
        ? {}
        : { onEvent: options.onAgentEvent },
    );
  } catch (error) {
    if (error instanceof AgentRuntimeError && error.usage !== undefined) {
      await options.onUsage?.(error.usage);
    }
    throw error;
  }
  await options.onUsage?.(outcome.usage);
  const result = outcome.result;
  if (!isRecord(result) || !Array.isArray(result.cases)) {
    throw new PlannerModelValidationError(
      "Validated planner augmentation is missing its cases array",
    );
  }
  return result.cases.map((item, index) =>
    validateModelCase(item, index, contract, contractRef, options),
  );
}

function validateModelCase(
  value: Json,
  index: number,
  contract: SutContract,
  contractRef: ArtifactRef<"sut-contract">,
  options: PlanOptions,
): TestPlanCase {
  if (
    !isRecord(value) ||
    typeof value.title !== "string" ||
    value.title.trim().length === 0 ||
    typeof value.objective !== "string" ||
    value.objective.trim().length === 0 ||
    !Array.isArray(value.steps) ||
    value.steps.length === 0 ||
    !isRecord(value.oracle) ||
    Object.keys(value.oracle).length === 0
  ) {
    throw new PlannerModelValidationError(
      `Planner augmentation case ${index} is structurally invalid`,
    );
  }

  const operations = new Map(
    contract.operations.map((operation) => [operation.id, operation]),
  );
  const steps = value.steps.map((step, stepIndex) => {
    if (
      !isRecord(step) ||
      typeof step.operationId !== "string" ||
      !("input" in step)
    ) {
      throw new PlannerModelValidationError(
        `Planner augmentation case ${index} step ${stepIndex} is invalid`,
      );
    }
    const operation = operations.get(step.operationId);
    if (operation === undefined) {
      throw new PlannerModelValidationError(
        `Planner augmentation references unknown operationId ${safeIdentifier(step.operationId)}`,
      );
    }
    if (operation.effects === "destructive" && !options.includeDestructive) {
      throw new PlannerModelValidationError(
        `Planner augmentation references destructive operation ${safeIdentifier(step.operationId)} while destructive cases are disabled`,
      );
    }
    return { operationId: operation.id, input: step.input };
  });

  const selectedOperations = [
    ...new Map(
      steps.map((step) => [step.operationId, operations.get(step.operationId)!]),
    ).values(),
  ];
  const firstOperation = selectedOperations[0];
  if (firstOperation === undefined) {
    throw new PlannerModelValidationError(
      `Planner augmentation case ${index} has no executable step`,
    );
  }
  const title = value.title.trim();
  const objective = value.objective.trim();
  const id = stableCaseId(firstOperation.id, title, index);
  const deterministicOracles = selectedOperations.flatMap((operation) =>
    buildOracles(operation, "unknown"),
  );
  const effects = [...new Set(selectedOperations.map((operation) => operation.effects))];
  return {
    id,
    title,
    objective,
    operationIds: [...new Set(steps.map((step) => step.operationId))],
    preconditions: [
      ...new Set(selectedOperations.flatMap((operation) => operation.preconditions)),
    ],
    steps,
    oracles: [
      ...deterministicOracles,
      {
        kind: "model-proposed",
        expression: value.oracle,
        rationale: "Model-proposed oracle pending deterministic execution evidence",
        strength: "weak",
      },
    ],
    risk: {
      severity: strongestModelRisk(selectedOperations),
      dimensions: ["model-proposed", ...effects.map((effect) => `effect:${effect}`)],
    },
    provenance: [contractRef],
    generatedBy: "model",
  };
}

function strongestModelRisk(
  operations: readonly SutOperation[],
): TestPlanCase["risk"]["severity"] {
  let severity: TestPlanCase["risk"]["severity"] = "medium";
  for (const operation of operations) {
    if (operation.effects === "destructive") return "critical";
    if (operation.effects === "write" || operation.effects === "unknown") {
      severity = "high";
    }
  }
  return severity;
}

function safeIdentifier(value: string): string {
  return JSON.stringify(value.replace(/[\r\n\t]+/g, " ").slice(0, 120));
}

function deduplicateCases(cases: readonly TestPlanCase[]): TestPlanCase[] {
  const bySignature = new Map<string, TestPlanCase>();
  for (const item of cases) {
    const signature = createHash("sha256")
      .update(JSON.stringify({ steps: item.steps, oracles: item.oracles }))
      .digest("hex");
    const existing = bySignature.get(signature);
    if (existing === undefined || severityRank(item.risk.severity) > severityRank(existing.risk.severity)) {
      bySignature.set(signature, item);
    }
  }
  return [...bySignature.values()];
}

function severityRank(value: TestPlanCase["risk"]["severity"]): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[value];
}

function stableCaseId(operationId: string, suffix: string, index: number): string {
  const digest = createHash("sha256")
    .update(`${operationId}\0${suffix}\0${index}`)
    .digest("hex")
    .slice(0, 10);
  return `HT-${slug(operationId).toUpperCase()}-${digest}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "case";
}

function isRecord(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
