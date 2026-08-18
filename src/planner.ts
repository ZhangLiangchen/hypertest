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
import type { AgentRuntime, AgentUsageSummary } from "./runtime.js";
import { collectAgentRun, emptyAgentUsageSummary } from "./runtime.js";

export interface PlanOptions {
  readonly maxCasesPerOperation?: number;
  readonly includeDestructive?: boolean;
  readonly runtime?: AgentRuntime;
  readonly runId?: string;
  readonly tokenBudget?: number;
  readonly deadlineEpochMs?: number;
  readonly onUsage?: (summary: AgentUsageSummary) => void | Promise<void>;
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
              maxProperties: 32,
            },
          },
        },
      },
    },
  };
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
  const outcome = await collectAgentRun(options.runtime!, {
    runId,
    phase: "test-plan-augmentation",
    systemPrompt:
      "Generate framework-neutral test cases only. Never emit test source code. Return only JSON matching the supplied result schema.",
    prompt: JSON.stringify({
      contract,
      constraints: {
        maxCasesPerOperation: options.maxCasesPerOperation ?? 12,
        includeDestructive: options.includeDestructive ?? false,
      },
    }),
    tools: [],
    artifacts: [contractRef],
    tokenBudget: options.tokenBudget ?? 20_000,
    deadlineEpochMs: options.deadlineEpochMs ?? Date.now() + 120_000,
    expectedResultSchema: plannerAugmentationSchema(maxCases),
    maxOutputBytes: 262_144,
  });
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
    typeof value.objective !== "string" ||
    !Array.isArray(value.steps) ||
    value.steps.length === 0 ||
    !isRecord(value.oracle)
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

  const firstOperation = steps[0]?.operationId;
  if (firstOperation === undefined) {
    throw new PlannerModelValidationError(
      `Planner augmentation case ${index} has no executable step`,
    );
  }
  const id = stableCaseId(firstOperation, value.title, index);
  return {
    id,
    title: value.title,
    objective: value.objective,
    operationIds: [...new Set(steps.map((step) => step.operationId))],
    preconditions: [],
    steps,
    oracles: [
      {
        kind: "model-proposed",
        expression: value.oracle,
        rationale: "Model-proposed oracle pending deterministic execution evidence",
        strength: "weak",
      },
    ],
    risk: { severity: "medium", dimensions: ["model-proposed"] },
    provenance: [contractRef],
    generatedBy: "model",
  };
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
