import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HypertestError, sha256Hex } from '@hypertest/core';
import type { ArtifactRef } from '@hypertest/domain';
import type { ArtifactHead, ArtifactPutOptions, ArtifactStore, FsArtifactStoreOptions } from '../contracts.ts';
import { casUri, parseArtifactLocator, sha256File, toBytes } from '../hash.ts';
import { artifactCorrupted, artifactNotFound, bytesToText, validateMimeType } from './common.ts';

/**
 * Content-addressed filesystem store: `<root>/sha256/<first2>/<hex>`, uri `cas://sha256/<hex>`.
 * Writes go to `<root>/.tmp/` and are atomically renamed into place; stored files are read-only
 * (0444). An object that already exists is never rewritten (put is idempotent), so on-disk
 * tampering stays detectable by verify() instead of being silently "repaired".
 */
export class FsArtifactStore implements ArtifactStore {
  readonly kind = 'fs' as const;
  readonly root: string;
  readonly #fsync: boolean;

  constructor(root: string, options: FsArtifactStoreOptions = {}) {
    if (typeof root !== 'string' || root === '') throw new HypertestError('invalid_argument', 'FsArtifactStore root is required');
    this.root = resolve(root);
    this.#fsync = options.fsync ?? true;
  }

  /** Absolute path of the object for a sha256 digest (the layout is part of the public contract). */
  pathFor(sha256: string): string {
    const hex = parseArtifactLocator(sha256);
    return join(this.root, 'sha256', hex.slice(0, 2), hex);
  }

  async put(data: Uint8Array | string, options: ArtifactPutOptions): Promise<ArtifactRef> {
    const mimeType = validateMimeType(options?.mimeType);
    const bytes = toBytes(data);
    const sha256 = sha256Hex(bytes);
    const ref: ArtifactRef = { uri: casUri(sha256), sha256, size: bytes.byteLength, mimeType };
    const finalPath = this.pathFor(sha256);
    if (this.#alreadyStored(sha256, bytes.byteLength, await this.#statSize(finalPath))) return ref;
    const tmp = await this.#tmpPath();
    try {
      const fh = await open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(bytes);
        if (this.#fsync) await fh.sync();
      } finally {
        await fh.close();
      }
      await this.#publish(tmp, finalPath);
    } finally {
      await rm(tmp, { force: true });
    }
    return ref;
  }

  async putFile(path: string, options: ArtifactPutOptions): Promise<ArtifactRef> {
    const mimeType = validateMimeType(options?.mimeType);
    const tmp = await this.#tmpPath();
    const hash = createHash('sha256');
    let size = 0;
    const hasher = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.byteLength;
        cb(null, chunk);
      },
    });
    try {
      try {
        await pipeline(createReadStream(path), hasher, createWriteStream(tmp, { flags: 'wx', mode: 0o600, flush: this.#fsync }));
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT' && err.path === path) throw new HypertestError('not_found', `source file not found: ${path}`, { cause: e });
        if (err.code === 'EISDIR') throw new HypertestError('invalid_argument', `source is a directory, not a file: ${path}`, { cause: e });
        throw e;
      }
      const sha256 = hash.digest('hex');
      const finalPath = this.pathFor(sha256);
      if (!this.#alreadyStored(sha256, size, await this.#statSize(finalPath))) await this.#publish(tmp, finalPath);
      return { uri: casUri(sha256), sha256, size, mimeType };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async get(ref: ArtifactRef | string): Promise<Uint8Array> {
    const sha256 = parseArtifactLocator(ref);
    let bytes: Buffer;
    try {
      bytes = await readFile(this.pathFor(sha256));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // A directory planted at the object path is not a stored object (exists() agrees).
      if (code === 'ENOENT' || code === 'EISDIR') throw artifactNotFound(sha256, this.root);
      throw e;
    }
    const actual = sha256Hex(bytes);
    if (actual !== sha256) throw artifactCorrupted(sha256, actual, this.root);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async getText(ref: ArtifactRef | string, maxBytes?: number): Promise<string> {
    return bytesToText(await this.get(ref), maxBytes);
  }

  async exists(sha256: string): Promise<boolean> {
    return (await this.#statSize(this.pathFor(sha256))) !== undefined;
  }

  async head(ref: ArtifactRef | string): Promise<ArtifactHead | undefined> {
    const sha256 = parseArtifactLocator(ref);
    const size = await this.#statSize(this.pathFor(sha256));
    return size === undefined ? undefined : { sha256, size };
  }

  async verify(ref: ArtifactRef): Promise<boolean> {
    const sha256 = parseArtifactLocator(ref);
    try {
      const actual = await sha256File(this.pathFor(sha256));
      return actual.sha256 === sha256 && actual.size === ref.size;
    } catch (e) {
      // Missing, or replaced by a directory (invalid_argument): report it instead of aborting verification.
      if (e instanceof HypertestError && (e.code === 'not_found' || e.code === 'invalid_argument')) return false;
      throw e;
    }
  }

  /**
   * true when the object is already stored (put is then a no-op: never rewritten). An existing object
   * whose size differs from the content being stored was modified after it was written: fail closed
   * instead of handing out a ref to bytes that do not hash to it (S3ArtifactStore does the same).
   */
  #alreadyStored(sha256: string, size: number, storedSize: number | undefined): boolean {
    if (storedSize === undefined) return false;
    if (storedSize !== size) {
      throw new HypertestError('integrity_violation', `artifact sha256:${sha256} is stored with ${storedSize} bytes but its content has ${size}`, {
        details: { sha256, size, storedSize },
      });
    }
    return true;
  }

  async #statSize(path: string): Promise<number | undefined> {
    try {
      const st = await stat(path);
      return st.isFile() ? st.size : undefined;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  async #tmpPath(): Promise<string> {
    const dir = join(this.root, '.tmp');
    await mkdir(dir, { recursive: true });
    return join(dir, `${randomUUID()}.part`);
  }

  /** Makes the temp file read-only and atomically renames it into its content address. */
  async #publish(tmp: string, finalPath: string): Promise<void> {
    const dir = dirname(finalPath);
    await mkdir(dir, { recursive: true });
    await chmod(tmp, 0o444);
    await rename(tmp, finalPath);
    if (this.#fsync) {
      try {
        const dh = await open(dir, 'r');
        try {
          await dh.sync();
        } finally {
          await dh.close();
        }
      } catch {
        // Directory fsync is best-effort (unsupported on some platforms/filesystems).
      }
    }
  }
}
