import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

import type { Json } from "../contracts.js";
import type { AgentFailureCode } from "../runtime.js";

export class RuntimeValidationError extends Error {
  public constructor(
    public readonly code: Extract<
      AgentFailureCode,
      | "model_output_parse_error"
      | "model_output_schema_error"
      | "tool_input_schema_error"
      | "provider_protocol_error"
    >,
    message: string,
    public readonly validationPath?: string,
  ) {
    super(message);
    this.name = "RuntimeValidationError";
  }
}

export function parseAndValidateModelResult(
  text: string,
  expectedSchema?: Json,
): Json {
  const parsed = parseModelJson(text);
  return validateModelResult(parsed, expectedSchema);
}

export function parseModelJson(text: string): Json {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new RuntimeValidationError(
      "model_output_parse_error",
      "Model returned an empty result",
    );
  }
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new RuntimeValidationError(
      "model_output_parse_error",
      "Model result is not valid JSON",
    );
  }
  if (!isJson(parsed)) {
    throw new RuntimeValidationError(
      "model_output_parse_error",
      "Model result is not JSON-serializable",
    );
  }
  return parsed;
}

export function validateModelResult(
  value: Json,
  expectedSchema?: Json,
): Json {
  if (expectedSchema === undefined) return value;
  validateAgainstSchema(
    value,
    expectedSchema,
    "model_output_schema_error",
    "Model result does not match the expected schema",
  );
  return value;
}

export function validateToolInput(value: Json, schema: Json): Json {
  validateAgainstSchema(
    value,
    schema,
    "tool_input_schema_error",
    "Tool input does not match the declared schema",
  );
  return value;
}

function validateAgainstSchema(
  value: Json,
  schema: Json,
  code: "model_output_schema_error" | "tool_input_schema_error",
  label: string,
): void {
  if (!isSchemaObject(schema)) {
    throw new RuntimeValidationError(
      "provider_protocol_error",
      "HyperTest received an invalid JSON Schema configuration",
    );
  }

  let valid: boolean;
  try {
    valid = Check(schema, value);
  } catch {
    throw new RuntimeValidationError(
      "provider_protocol_error",
      "HyperTest could not evaluate the configured JSON Schema",
    );
  }
  if (valid) return;

  let path = "";
  let reason = "validation failed";
  try {
    const first = Errors(schema, value)[0];
    if (first !== undefined) {
      path = safePointer(first.instancePath);
      reason = safeReason(first.message);
    }
  } catch {
    // The generic message below is intentionally response-free.
  }
  const location = path.length === 0 ? " at /" : ` at ${path}`;
  throw new RuntimeValidationError(code, `${label}${location}: ${reason}`, path || "/");
}

function isSchemaObject(value: Json): value is Json & TSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePointer(value: unknown): string {
  if (typeof value !== "string") return "";
  if (!/^\/(?:[^~\/]|~[01]|\/)*$/.test(value)) return "";
  return value.slice(0, 256);
}

function safeReason(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "validation failed";
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 160);
}

function isJson(value: unknown): value is Json {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item));
  if (typeof value !== "object") return false;
  return Object.values(value).every((item) => isJson(item));
}
