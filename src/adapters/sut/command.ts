import { createHash } from "node:crypto";

import type { ArtifactRef, Json, JsonSchemaShape, SutContract, SutOperation } from "../../contracts.js";
import { parseDataDocument } from "../../profile.js";

export function importCommandContract(
  text: string,
  sourceRevision: string,
  provenance: readonly ArtifactRef[] = [],
): SutContract {
  const document = expectRecord(parseDataDocument(text), "command contract");
  const title = typeof document.title === "string" ? document.title : "Command-line system";
  const rawOperations = Array.isArray(document.operations)
    ? document.operations
    : Array.isArray(document.commands)
      ? document.commands
      : [];
  const operations = rawOperations.map((raw, index) =>
    parseOperation(expectRecord(raw, `operations[${index}]`), index),
  );
  if (operations.length === 0) {
    throw new Error("Command contract must declare at least one operation");
  }
  return {
    schema: "hypertest.sut-contract/v1",
    id:
      typeof document.id === "string"
        ? document.id
        : `command-${createHash("sha256").update(title).digest("hex").slice(0, 12)}`,
    title,
    sourceRevision,
    operations,
    lifecycleCapabilities: ["probe"],
    provenance,
  };
}

function parseOperation(record: Record<string, Json>, index: number): SutOperation {
  const id = string(record.id) ?? `command-${index + 1}`;
  const argv = stringArray(record.argv);
  if (argv.length === 0) throw new Error(`Operation ${id} must declare argv`);
  const expectedExitCodes = numberArray(record.expectedExitCodes ?? record.expected_exit_codes);
  const inputSchema = isRecord(record.inputSchema ?? record.input_schema)
    ? (record.inputSchema ?? record.input_schema) as unknown as JsonSchemaShape
    : {
        type: "object",
        properties: {
          args: { type: "array", items: { type: "string" } },
          stdin: { type: "string" },
          env: { type: "object" },
        },
      };
  const observationSchema = isRecord(record.observationSchema ?? record.observation_schema)
    ? (record.observationSchema ?? record.observation_schema) as unknown as JsonSchemaShape
    : {
        type: "object",
        properties: {
          exitCode: { type: "integer" },
          stdout: { type: "string" },
          stderr: { type: "string" },
          files: { type: "array" },
        },
        required: ["exitCode", "stdout", "stderr"],
      };
  const effect = string(record.effects) ?? "unknown";
  if (!["none", "read", "write", "destructive", "unknown"].includes(effect)) {
    throw new Error(`Operation ${id} has an invalid effects value`);
  }
  const cwd = string(record.cwd);
  const title = string(record.title);
  const description = string(record.description);
  return {
    id,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    interactionKind: "command",
    inputSchema,
    observationSchema,
    effects: effect as SutOperation["effects"],
    preconditions: stringArray(record.preconditions),
    oracleHints: [
      {
        kind: "exit-code",
        expected: expectedExitCodes.length === 0 ? [0] : expectedExitCodes,
      },
      ...(Array.isArray(record.oracleHints ?? record.oracle_hints)
        ? ((record.oracleHints ?? record.oracle_hints) as Json[])
        : []),
    ],
    tags: stringArray(record.tags),
    extensionSchema: "hypertest.command-operation/v1",
    extension: {
      argv,
      expectedExitCodes: expectedExitCodes.length === 0 ? [0] : expectedExitCodes,
      ...(cwd === undefined ? {} : { cwd }),
    },
  };
}

function expectRecord(value: Json | undefined, path: string): Record<string, Json> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function isRecord(value: Json | undefined): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: Json | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberArray(value: Json | undefined): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}
