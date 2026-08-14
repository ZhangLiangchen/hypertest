import assert from "node:assert/strict";
import test from "node:test";

import { importCommandContract } from "../src/adapters/sut/command.js";
import { importOpenApiContract } from "../src/adapters/sut/http-openapi.js";

test("imports an HTTP interface without leaking it into the core IR", () => {
  const contract = importOpenApiContract(
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Greeting" },
      paths: {
        "/greet/{name}": {
          get: {
            operationId: "greet",
            parameters: [
              { name: "name", in: "path", required: true, schema: { type: "string", minLength: 1 } },
            ],
            responses: { "200": { description: "ok" }, "400": { description: "bad" } },
          },
        },
      },
    }),
    "rev",
  );
  assert.equal(contract.operations[0]?.inputSchema.required?.[0], "path.name");
  assert.equal(contract.operations[0]?.extensionSchema, "hypertest.http-operation/v1");
});

test("imports a command interface as the same SutContract shape", () => {
  const contract = importCommandContract(
    JSON.stringify({
      title: "Greeting CLI",
      operations: [
        {
          id: "greet",
          argv: ["go", "run", "./cmd/tool", "{name}"],
          inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          expectedExitCodes: [0],
          effects: "none",
        },
      ],
    }),
    "rev",
  );
  assert.equal(contract.operations[0]?.interactionKind, "command");
  assert.equal(contract.operations[0]?.extensionSchema, "hypertest.command-operation/v1");
});
