import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ArtifactRef } from "./contracts.js";

export async function readArtifact(ref: ArtifactRef): Promise<Uint8Array> {
  const url = new URL(ref.uri);
  if (url.protocol !== "file:") {
    throw new Error(`Built-in adapters support file artifacts only, got ${url.protocol}`);
  }
  const bytes = await readFile(fileURLToPath(url));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== ref.sha256) {
    throw new Error(`Artifact hash mismatch for ${ref.uri}`);
  }
  return bytes;
}

export async function readArtifactText(ref: ArtifactRef): Promise<string> {
  return Buffer.from(await readArtifact(ref)).toString("utf8");
}

export async function readArtifactJson<T>(ref: ArtifactRef): Promise<T> {
  return JSON.parse(await readArtifactText(ref)) as T;
}
