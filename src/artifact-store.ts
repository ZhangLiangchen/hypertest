import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  link,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ArtifactRef, Json } from "./contracts.js";

export interface PutArtifactRequest<K extends string> {
  readonly runId: string;
  readonly relativePath: string;
  readonly kind: K;
  readonly schema: string;
  readonly mediaType: string;
  readonly content: string | Uint8Array;
  readonly sourceRevision?: string;
  readonly metadata?: Readonly<Record<string, Json>>;
}

export interface ArtifactStore {
  put<K extends string>(request: PutArtifactRequest<K>): Promise<ArtifactRef<K>>;
  putJson<K extends string>(
    request: Omit<PutArtifactRequest<K>, "content" | "mediaType"> & {
      readonly value: Json;
    },
  ): Promise<ArtifactRef<K>>;
  read(ref: ArtifactRef): Promise<Uint8Array>;
  readText(ref: ArtifactRef): Promise<string>;
  readJson<T>(ref: ArtifactRef): Promise<T>;
  appendEvent(runId: string, event: Json): Promise<void>;
}

export class FileArtifactStore implements ArtifactStore {
  private readonly root: string;

  public constructor(root: string) {
    this.root = resolve(root);
  }

  public async put<K extends string>(
    request: PutArtifactRequest<K>,
  ): Promise<ArtifactRef<K>> {
    this.assertToken(request.runId, "runId");
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
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await link(temporary, destination);
      await rm(temporary);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }

    return {
      kind: request.kind,
      schema: request.schema,
      uri: pathToFileURL(destination).href,
      mediaType: request.mediaType,
      sha256,
      sizeBytes: bytes.byteLength,
      ...(request.sourceRevision === undefined
        ? {}
        : { sourceRevision: request.sourceRevision }),
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    };
  }

  public async putJson<K extends string>(
    request: Omit<PutArtifactRequest<K>, "content" | "mediaType"> & {
      readonly value: Json;
    },
  ): Promise<ArtifactRef<K>> {
    return this.put({
      ...request,
      mediaType: "application/json",
      content: `${JSON.stringify(request.value, null, 2)}\n`,
    });
  }

  public async read(ref: ArtifactRef): Promise<Uint8Array> {
    const path = this.pathFromRef(ref);
    const bytes = await readFile(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== ref.sha256) {
      throw new Error(
        `Artifact hash mismatch for ${ref.uri}: expected ${ref.sha256}, got ${digest}`,
      );
    }
    if (ref.sizeBytes !== undefined && bytes.byteLength !== ref.sizeBytes) {
      throw new Error(`Artifact size mismatch for ${ref.uri}`);
    }
    return bytes;
  }

  public async readText(ref: ArtifactRef): Promise<string> {
    return Buffer.from(await this.read(ref)).toString("utf8");
  }

  public async readJson<T>(ref: ArtifactRef): Promise<T> {
    const text = await this.readText(ref);
    return JSON.parse(text) as T;
  }

  public async appendEvent(runId: string, event: Json): Promise<void> {
    this.assertToken(runId, "runId");
    const path = this.resolveSafePath("runs", runId, "events.ndjson");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  public async verify(ref: ArtifactRef): Promise<void> {
    await this.read(ref);
  }

  public async exists(ref: ArtifactRef): Promise<boolean> {
    try {
      await stat(this.pathFromRef(ref));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private pathFromRef(ref: ArtifactRef): string {
    const url = new URL(ref.uri);
    if (url.protocol !== "file:") {
      throw new Error(`Unsupported artifact URI protocol: ${url.protocol}`);
    }
    const path = resolve(fileURLToPath(url));
    const prefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    if (path !== this.root && !path.startsWith(prefix)) {
      throw new Error("Artifact reference escapes the configured store root");
    }
    return path;
  }

  private resolveSafePath(...parts: readonly string[]): string {
    const candidate = resolve(this.root, ...parts);
    const prefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    if (candidate !== this.root && !candidate.startsWith(prefix)) {
      throw new Error("Artifact path escapes the configured store root");
    }
    return candidate;
  }

  private assertToken(value: string, label: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new Error(`${label} contains unsafe characters`);
    }
  }
}
