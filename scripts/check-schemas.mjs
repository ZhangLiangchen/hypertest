import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(new URL("../", import.meta.url).pathname);
const schemaDir = join(root, "schemas");
const files = (await readdir(schemaDir)).filter((name) => name.endsWith(".schema.json")).sort();
const ids = new Set();
const errors = [];

for (const name of files) {
  try {
    const value = JSON.parse(await readFile(join(schemaDir, name), "utf8"));
    if (value.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      errors.push(`${name}: unsupported or missing $schema`);
    }
    if (typeof value.$id !== "string" || value.$id.length === 0) {
      errors.push(`${name}: missing $id`);
    } else if (ids.has(value.$id)) {
      errors.push(`${name}: duplicate $id ${value.$id}`);
    } else {
      ids.add(value.$id);
    }
  } catch (error) {
    errors.push(`${name}: ${error}`);
  }
}

for (const path of [
  "profiles/python-http-pytest.example.json",
  "profiles/go-cli-go-test.example.json",
  "examples/python-http/openapi.json",
  "examples/go-cli/command-contract.json",
]) {
  try {
    JSON.parse(await readFile(join(root, path), "utf8"));
  } catch (error) {
    errors.push(`${path}: ${error}`);
  }
}

if (files.length < 10) errors.push(`expected at least 10 public schemas, found ${files.length}`);
if (errors.length > 0) {
  console.error(`Schema checks failed:\n${errors.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Schemas: PASS (${files.length} public schemas)`);
}
