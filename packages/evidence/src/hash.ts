import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { HypertestError, sha256Hex } from '@hypertest/core';
import type { ArtifactRef } from '@hypertest/domain';

const HEX64 = /^[0-9a-f]{64}$/;
const CAS_RE = /^cas:\/\/sha256\/([0-9a-fA-F]{64})$/;
const S3_RE = /^s3:\/\/[^/]+\/(?:.*\/)?sha256\/([0-9a-fA-F]{64})$/;

/** SHA-256 of the empty string: the Merkle root of an empty ledger. */
export const EMPTY_ROOT = sha256Hex('');

export function isSha256Hex(s: unknown): s is string {
  return typeof s === 'string' && HEX64.test(s);
}

/** `cas://sha256/<hex>` — the store-neutral content address. */
export function casUri(sha256: string): string {
  return `cas://sha256/${sha256}`;
}

/**
 * Resolves an artifact locator to its lowercase sha256 hex digest. Accepts an ArtifactRef, a
 * `cas://sha256/<hex>` uri, an `s3://<bucket>/<prefix>sha256/<hex>` uri, or a bare hex digest.
 * Anything else (including path-traversal attempts) is `invalid_argument`.
 */
export function parseArtifactLocator(ref: ArtifactRef | string): string {
  if (ref !== null && typeof ref === 'object') {
    const hex = typeof ref.sha256 === 'string' ? ref.sha256.toLowerCase() : '';
    if (!HEX64.test(hex)) throw new HypertestError('invalid_argument', 'artifact ref has no valid sha256', { details: { uri: (ref as { uri?: unknown }).uri } });
    return hex;
  }
  if (typeof ref !== 'string') throw new HypertestError('invalid_argument', 'artifact locator must be an ArtifactRef or a string');
  const lower = ref.toLowerCase();
  if (HEX64.test(lower)) return lower;
  const m = CAS_RE.exec(ref) ?? S3_RE.exec(ref);
  if (m) return m[1]!.toLowerCase();
  throw new HypertestError('invalid_argument', `unrecognized artifact locator: ${ref.slice(0, 120)}`);
}

export function toBytes(data: Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof Uint8Array) return data;
  throw new HypertestError('invalid_argument', 'artifact data must be a Uint8Array or a string');
}

/** Maps a file read error: ENOENT ⇒ not_found, EISDIR ⇒ invalid_argument (not a regular file); others unchanged. */
export function fileReadError(e: unknown, path: string): unknown {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return new HypertestError('not_found', `file not found: ${path}`, { cause: e });
  if (code === 'EISDIR') return new HypertestError('invalid_argument', `not a regular file: ${path}`, { cause: e });
  return e;
}

/** Streams a file through SHA-256. Throws not_found when missing, invalid_argument for a directory. */
export async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      const buf = chunk as Buffer;
      hash.update(buf);
      size += buf.byteLength;
    }
  } catch (e) {
    throw fileReadError(e, path);
  }
  return { sha256: hash.digest('hex'), size };
}

/**
 * Merkle root over hex leaf hashes (in the given order): parent = sha256(left + right) over the hex
 * strings; an odd level duplicates its last node; a single leaf is its own root; empty ⇒ sha256('').
 *
 * Note: duplicate-last means [a,b,c] and [a,b,c,c] share a root, so a root is only meaningful
 * together with its leaf count — seals and verifications always carry `count`.
 */
export function merkleRoot(leafHashes: readonly string[]): string {
  for (let i = 0; i < leafHashes.length; i++) {
    if (!isSha256Hex(leafHashes[i])) throw new HypertestError('invalid_argument', `merkle leaf ${i} is not a lowercase sha256 hex digest`);
  }
  return merkleRootUnchecked(leafHashes);
}

/**
 * Same construction without leaf validation. Used over *stored* hashes during verification, where a
 * tampered (non-hex) value must be reported as a problem rather than abort the verifier.
 */
export function merkleRootUnchecked(leafHashes: readonly string[]): string {
  if (leafHashes.length === 0) return EMPTY_ROOT;
  let level: string[] = [...leafHashes];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left;
      next.push(sha256Hex(left + right));
    }
    level = next;
  }
  return level[0]!;
}
