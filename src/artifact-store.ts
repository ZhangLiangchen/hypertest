import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type { ArtifactRef } from "./contracts.js";

export interface PutArtifactRequest<K extends string> {
  readonly runId: string;
  readonly relativePath: string;
  readonly kind: K;
  readonly schema: string;
  readonly mediaType: string;
  readonly content: string | Uint8Array;
}

export interface ArtifactStore {
  put<K extends string>(request: PutArtifactRequest<K>): Promise<ArtifactRef<K>>;
}

export class FileArtifactStore implements ArtifactStore {
  private readonly root: string;

  public constructor(root: string) {
    this.root = resolve(root);
  }

  public async put<K extends string>(
    request: PutArtifactRequest<K>,
  ): Promise<ArtifactRef<K>> {
    const destination = this.resolveSafePath(
      "runs",
      request.runId,
      "artifacts",
      request.relativePath,
    );
    await mkdir(dirname(destination), { recursive: true });

    const bytes =
      typeof request.content === "string"
        ? Buffer.from(request.content, "utf8")
        : Buffer.from(request.content);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const temporary = `${destination}.tmp-${randomUUID()}`;

    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await link(temporary, destination);
      await rm(temporary);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }

    return {
      kind: request.kind,
      schema: request.schema,
      uri: `file://${destination}`,
      mediaType: request.mediaType,
      sha256,
      sizeBytes: bytes.byteLength,
    };
  }

  private resolveSafePath(...parts: readonly string[]): string {
    const candidate = resolve(this.root, ...parts);
    const prefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    if (candidate !== this.root && !candidate.startsWith(prefix)) {
      throw new Error("Artifact path escapes the configured store root");
    }
    return candidate;
  }
}
