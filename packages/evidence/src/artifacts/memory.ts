import { readFile } from 'node:fs/promises';
import { sha256Hex } from '@hypertest/core';
import type { ArtifactRef } from '@hypertest/domain';
import type { ArtifactHead, ArtifactPutOptions, ArtifactStore } from '../contracts.ts';
import { casUri, fileReadError, parseArtifactLocator, toBytes } from '../hash.ts';
import { artifactCorrupted, artifactNotFound, bytesToText, validateMimeType } from './common.ts';

/** In-memory content-addressed store for tests and ephemeral runs. Bytes are copied in and out. */
export class MemoryArtifactStore implements ArtifactStore {
  readonly kind = 'memory' as const;
  readonly #objects = new Map<string, Uint8Array>();

  get size(): number {
    return this.#objects.size;
  }

  async put(data: Uint8Array | string, options: ArtifactPutOptions): Promise<ArtifactRef> {
    const mimeType = validateMimeType(options?.mimeType);
    const bytes = toBytes(data);
    const sha256 = sha256Hex(bytes);
    if (!this.#objects.has(sha256)) this.#objects.set(sha256, Uint8Array.from(bytes));
    return { uri: casUri(sha256), sha256, size: bytes.byteLength, mimeType };
  }

  async putFile(path: string, options: ArtifactPutOptions): Promise<ArtifactRef> {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (e) {
      throw fileReadError(e, path);
    }
    return this.put(bytes, options);
  }

  async get(ref: ArtifactRef | string): Promise<Uint8Array> {
    const sha256 = parseArtifactLocator(ref);
    const bytes = this.#objects.get(sha256);
    if (!bytes) throw artifactNotFound(sha256, 'memory store');
    const actual = sha256Hex(bytes);
    if (actual !== sha256) throw artifactCorrupted(sha256, actual, 'memory store');
    return Uint8Array.from(bytes);
  }

  async getText(ref: ArtifactRef | string, maxBytes?: number): Promise<string> {
    return bytesToText(await this.get(ref), maxBytes);
  }

  async exists(sha256: string): Promise<boolean> {
    return this.#objects.has(parseArtifactLocator(sha256));
  }

  async head(ref: ArtifactRef | string): Promise<ArtifactHead | undefined> {
    const sha256 = parseArtifactLocator(ref);
    const bytes = this.#objects.get(sha256);
    return bytes ? { sha256, size: bytes.byteLength } : undefined;
  }

  async verify(ref: ArtifactRef): Promise<boolean> {
    const sha256 = parseArtifactLocator(ref);
    const bytes = this.#objects.get(sha256);
    return bytes !== undefined && bytes.byteLength === ref.size && sha256Hex(bytes) === sha256;
  }
}
