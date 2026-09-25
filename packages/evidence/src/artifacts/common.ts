import { HypertestError, truncateUtf8 } from '@hypertest/core';

export function artifactNotFound(sha256: string, where?: string): HypertestError {
  return new HypertestError('not_found', `artifact sha256:${sha256} not found${where ? ` in ${where}` : ''}`, { details: { sha256 } });
}

export function artifactCorrupted(sha256: string, actual: string, where?: string): HypertestError {
  return new HypertestError('integrity_violation', `artifact sha256:${sha256} is corrupted${where ? ` in ${where}` : ''} (stored bytes hash to ${actual})`, {
    details: { sha256, actual },
  });
}

export function validateMimeType(mimeType: unknown): string {
  if (typeof mimeType !== 'string' || mimeType.trim() === '') throw new HypertestError('invalid_argument', 'artifact mimeType is required');
  return mimeType;
}

/** UTF-8 decode, optionally bounded to `maxBytes` (with the core truncation marker). */
export function bytesToText(bytes: Uint8Array, maxBytes?: number): string {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  if (maxBytes === undefined) return text;
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new HypertestError('invalid_argument', 'maxBytes must be a non-negative integer');
  return truncateUtf8(text, maxBytes).text;
}
