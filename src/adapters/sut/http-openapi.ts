import { createHash } from "node:crypto";

import type {
  ArtifactRef,
  Json,
  JsonSchemaShape,
  SutContract,
  SutOperation,
} from "../../contracts.js";
import { parseDataDocument } from "../../profile.js";

const methods = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;

export function importOpenApiContract(
  text: string,
  sourceRevision: string,
  provenance: readonly ArtifactRef[] = [],
): SutContract {
  const document = expectRecord(parseDataDocument(text), "interface document");
  const paths = expectRecord(document.paths, "interface document paths");
  const title =
    isRecord(document.info) && typeof document.info.title === "string"
      ? document.info.title
      : "HTTP service";
  const operations: SutOperation[] = [];

  for (const [path, rawPathItem] of Object.entries(paths)) {
    const pathItem = expectRecord(rawPathItem, `path ${path}`);
    const pathParameters = readParameters(pathItem.parameters, document);
    for (const method of methods) {
      const rawOperation = pathItem[method];
      if (!isRecord(rawOperation)) continue;
      const parameters = [
        ...pathParameters,
        ...readParameters(rawOperation.parameters, document),
      ];
      const inputProperties: Record<string, JsonSchemaShape> = {};
      const required: string[] = [];
      for (const parameter of parameters) {
        const name = typeof parameter.name === "string" ? parameter.name : "parameter";
        const location = typeof parameter.in === "string" ? parameter.in : "unknown";
        const key = `${location}.${name}`;
        inputProperties[key] = resolveSchema(
          isRecord(parameter.schema) ? parameter.schema : {},
          document,
        );
        if (parameter.required === true) required.push(key);
      }

      const requestBody = resolveRef(rawOperation.requestBody, document);
      if (isRecord(requestBody)) {
        const content = isRecord(requestBody.content) ? requestBody.content : {};
        const media = chooseMedia(content);
        if (media !== undefined && isRecord(media.value) && isRecord(media.value.schema)) {
          inputProperties.body = resolveSchema(media.value.schema, document);
          if (requestBody.required === true) required.push("body");
        }
      }

      const responses = isRecord(rawOperation.responses) ? rawOperation.responses : {};
      const expectedStatuses = Object.keys(responses).filter((status) => /^\d{3}$/.test(status));
      const responseBodies: JsonSchemaShape[] = [];
      for (const response of Object.values(responses)) {
        const resolved = resolveRef(response, document);
        if (!isRecord(resolved) || !isRecord(resolved.content)) continue;
        const media = chooseMedia(resolved.content);
        if (media !== undefined && isRecord(media.value) && isRecord(media.value.schema)) {
          responseBodies.push(resolveSchema(media.value.schema, document));
        }
      }

      const operationId =
        typeof rawOperation.operationId === "string" && rawOperation.operationId.length > 0
          ? rawOperation.operationId
          : `${method.toUpperCase()} ${path}`;
      operations.push({
        id: operationId,
        ...(typeof rawOperation.summary === "string" ? { title: rawOperation.summary } : {}),
        ...(typeof rawOperation.description === "string"
          ? { description: rawOperation.description }
          : {}),
        interactionKind: "http",
        inputSchema: {
          type: "object",
          properties: inputProperties,
          required,
          additionalProperties: false,
        },
        observationSchema: {
          type: "object",
          properties: {
            status: { type: "integer" },
            headers: { type: "object" },
            body:
              responseBodies.length === 0
                ? {}
                : responseBodies.length === 1
                  ? responseBodies[0]!
                  : { oneOf: responseBodies },
          },
          required: ["status"],
        },
        effects: effectForMethod(method),
        preconditions: [],
        oracleHints: [
          {
            kind: "http-status",
            expected: expectedStatuses.length === 0 ? ["2xx", "4xx"] : expectedStatuses,
          },
        ],
        tags: Array.isArray(rawOperation.tags)
          ? rawOperation.tags.filter((item): item is string => typeof item === "string")
          : [],
        extensionSchema: "hypertest.http-operation/v1",
        extension: {
          method: method.toUpperCase(),
          path,
          expectedStatuses,
          ...(typeof document.servers === "object" && Array.isArray(document.servers)
            ? { servers: document.servers }
            : {}),
        },
      });
    }
  }

  const id = `http-${createHash("sha256").update(title).digest("hex").slice(0, 12)}`;
  return {
    schema: "hypertest.sut-contract/v1",
    id,
    title,
    sourceRevision,
    operations,
    lifecycleCapabilities: ["probe"],
    provenance,
  };
}

function readParameters(value: Json | undefined, root: Record<string, Json>): Record<string, Json>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const resolved = resolveRef(item, root);
    return isRecord(resolved) ? [resolved] : [];
  });
}

function resolveRef(value: Json | undefined, root: Record<string, Json>): Json | undefined {
  if (!isRecord(value) || typeof value.$ref !== "string") return value;
  if (!value.$ref.startsWith("#/")) {
    throw new Error(`External interface references are not supported: ${value.$ref}`);
  }
  let current: Json = root;
  for (const segment of value.$ref.slice(2).split("/")) {
    if (!isRecord(current)) throw new Error(`Invalid interface reference: ${value.$ref}`);
    current = current[segment.replaceAll("~1", "/").replaceAll("~0", "~")] ?? null;
  }
  return current;
}

function resolveSchema(value: Record<string, Json>, root: Record<string, Json>): JsonSchemaShape {
  const resolved = resolveRef(value, root);
  if (!isRecord(resolved)) return {};
  const output: Record<string, Json> = {};
  for (const [key, child] of Object.entries(resolved)) {
    if (key === "$ref") continue;
    if (key === "properties" && isRecord(child)) {
      output.properties = Object.fromEntries(
        Object.entries(child).map(([name, property]) => [
          name,
          resolveSchema(isRecord(property) ? property : {}, root) as unknown as Json,
        ]),
      );
    } else if (key === "items" && isRecord(child)) {
      output.items = resolveSchema(child, root) as unknown as Json;
    } else if (["oneOf", "anyOf", "allOf"].includes(key) && Array.isArray(child)) {
      output[key] = child.map((item) =>
        resolveSchema(isRecord(item) ? item : {}, root) as unknown as Json,
      );
    } else {
      output[key] = child;
    }
  }
  return output as unknown as JsonSchemaShape;
}

function chooseMedia(
  content: Record<string, Json>,
): { readonly name: string; readonly value: Json } | undefined {
  for (const preferred of ["application/json", "application/*+json", "text/plain"]) {
    if (content[preferred] !== undefined) return { name: preferred, value: content[preferred] };
  }
  const first = Object.entries(content)[0];
  return first === undefined ? undefined : { name: first[0], value: first[1] };
}

function effectForMethod(method: (typeof methods)[number]): SutOperation["effects"] {
  if (method === "get" || method === "head" || method === "options") return "read";
  if (method === "delete") return "destructive";
  return "write";
}

function expectRecord(value: Json | undefined, path: string): Record<string, Json> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function isRecord(value: Json | undefined): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
