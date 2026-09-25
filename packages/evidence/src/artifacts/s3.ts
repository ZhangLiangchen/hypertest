import { createReadStream } from 'node:fs';
import type * as S3 from '@aws-sdk/client-s3';
import { HypertestError, sha256Hex, systemClock, type Clock } from '@hypertest/core';
import type { ArtifactRef } from '@hypertest/domain';
import type { ArtifactHead, ArtifactPutOptions, ArtifactStore, S3ArtifactStoreOptions, S3ClientLike } from '../contracts.ts';
import { parseArtifactLocator, sha256File, toBytes } from '../hash.ts';
import { artifactCorrupted, artifactNotFound, bytesToText, validateMimeType } from './common.ts';

type S3Module = typeof S3;

let sdkPromise: Promise<S3Module> | undefined;
/** The AWS SDK is loaded lazily so importing @hypertest/evidence stays cheap for fs/memory users. */
function loadSdk(): Promise<S3Module> {
  sdkPromise ??= import('@aws-sdk/client-s3');
  return sdkPromise;
}

const DAY_MS = 86_400_000;

interface S3ErrorLike {
  name?: string;
  Code?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

function statusOf(e: unknown): number | undefined {
  return (e as S3ErrorLike)?.$metadata?.httpStatusCode;
}

function isNotFound(e: unknown): boolean {
  const err = e as S3ErrorLike;
  return statusOf(e) === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.Code === 'NoSuchKey';
}

function isPreconditionFailed(e: unknown): boolean {
  const err = e as S3ErrorLike;
  return statusOf(e) === 412 || err?.name === 'PreconditionFailed';
}

function mapError(e: unknown, action: string, key: string): HypertestError {
  if (e instanceof HypertestError) return e;
  const err = e as S3ErrorLike;
  const status = statusOf(e);
  const message = `s3 ${action} ${key} failed: ${err?.name ?? 'error'}${err?.message ? ` (${err.message})` : ''}`;
  const details = { key, status, name: err?.name };
  if (status === 401 || status === 403 || err?.name === 'AccessDenied') return new HypertestError('permission_denied', message, { cause: e, details });
  if (status === 400) return new HypertestError('invalid_argument', message, { cause: e, details });
  return new HypertestError('unavailable', message, { cause: e, details });
}

async function bodyToBytes(body: unknown): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  const withTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof withTransform.transformToByteArray === 'function') return withTransform.transformToByteArray();
  if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw new HypertestError('internal', 'unsupported S3 GetObject body type');
}

/**
 * S3-compatible content-addressed store (AWS S3, MinIO, …). Keys are `<prefix>sha256/<hex>`, uris
 * `s3://<bucket>/<key>`. put() dedupes with HeadObject and writes with `If-None-Match: *` plus a
 * server-validated SHA-256 checksum; with `objectLockDays` every object is written under Object Lock
 * COMPLIANCE retention (WORM) — the bucket must have Object Lock enabled.
 */
export class S3ArtifactStore implements ArtifactStore {
  readonly kind = 's3' as const;
  readonly bucket: string;
  readonly prefix: string;
  readonly objectLockDays: number | undefined;
  readonly #options: S3ArtifactStoreOptions;
  readonly #clock: Clock;
  #client: S3ClientLike | undefined;
  #ownsClient = false;

  constructor(options: S3ArtifactStoreOptions) {
    if (!options || typeof options.bucket !== 'string' || options.bucket === '') throw new HypertestError('invalid_argument', 'S3ArtifactStore requires a bucket');
    if (typeof options.region !== 'string' || options.region === '') throw new HypertestError('invalid_argument', 'S3ArtifactStore requires a region');
    if (options.objectLockDays !== undefined && (!Number.isInteger(options.objectLockDays) || options.objectLockDays <= 0)) {
      throw new HypertestError('invalid_argument', 'objectLockDays must be a positive integer');
    }
    const prefix = options.prefix ?? '';
    this.prefix = prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`;
    this.bucket = options.bucket;
    this.objectLockDays = options.objectLockDays;
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#client = options.client;
  }

  keyFor(sha256: string): string {
    return `${this.prefix}sha256/${parseArtifactLocator(sha256)}`;
  }

  uriFor(sha256: string): string {
    return `s3://${this.bucket}/${this.keyFor(sha256)}`;
  }

  async put(data: Uint8Array | string, options: ArtifactPutOptions): Promise<ArtifactRef> {
    const mimeType = validateMimeType(options?.mimeType);
    const bytes = toBytes(data);
    const sha256 = sha256Hex(bytes);
    return this.#upload(sha256, bytes.byteLength, mimeType, options.classification, () => bytes);
  }

  /** Hashes the file in a streaming pass (the key depends on the digest), then streams the upload. */
  async putFile(path: string, options: ArtifactPutOptions): Promise<ArtifactRef> {
    const mimeType = validateMimeType(options?.mimeType);
    const { sha256, size } = await sha256File(path);
    return this.#upload(sha256, size, mimeType, options.classification, () => createReadStream(path));
  }

  async get(ref: ArtifactRef | string): Promise<Uint8Array> {
    const sha256 = parseArtifactLocator(ref);
    const bytes = await this.#download(sha256);
    if (!bytes) throw artifactNotFound(sha256, `s3://${this.bucket}`);
    const actual = sha256Hex(bytes);
    if (actual !== sha256) throw artifactCorrupted(sha256, actual, `s3://${this.bucket}`);
    return bytes;
  }

  async getText(ref: ArtifactRef | string, maxBytes?: number): Promise<string> {
    return bytesToText(await this.get(ref), maxBytes);
  }

  async exists(sha256: string): Promise<boolean> {
    return (await this.head(sha256)) !== undefined;
  }

  async head(ref: ArtifactRef | string): Promise<ArtifactHead | undefined> {
    const sha256 = parseArtifactLocator(ref);
    const key = this.keyFor(sha256);
    const sdk = await loadSdk();
    try {
      const out = (await (await this.#getClient()).send(new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: key }))) as { ContentLength?: number };
      return { sha256, size: out?.ContentLength ?? 0 };
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw mapError(e, 'HeadObject', key);
    }
  }

  async verify(ref: ArtifactRef): Promise<boolean> {
    const sha256 = parseArtifactLocator(ref);
    const bytes = await this.#download(sha256);
    return bytes !== undefined && bytes.byteLength === ref.size && sha256Hex(bytes) === sha256;
  }

  async #upload(sha256: string, size: number, mimeType: string, classification: string | undefined, body: () => unknown): Promise<ArtifactRef> {
    const key = this.keyFor(sha256);
    const ref: ArtifactRef = { uri: `s3://${this.bucket}/${key}`, sha256, size, mimeType };
    if (await this.#alreadyStored(sha256, size, key)) return ref;
    const sdk = await loadSdk();
    const input: S3.PutObjectCommandInput = {
      Bucket: this.bucket,
      Key: key,
      Body: body() as NonNullable<S3.PutObjectCommandInput['Body']>,
      ContentLength: size,
      ContentType: mimeType,
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
      IfNoneMatch: '*',
      Metadata: classification ? { sha256, classification } : { sha256 },
    };
    if (this.objectLockDays !== undefined) {
      input.ObjectLockMode = 'COMPLIANCE';
      input.ObjectLockRetainUntilDate = new Date(this.#clock.nowMs() + this.objectLockDays * DAY_MS);
    }
    try {
      await (await this.#getClient()).send(new sdk.PutObjectCommand(input));
    } catch (e) {
      // Another writer created the key first. Content addressing makes that a success only if the
      // object it wrote has our size (it may not have sent a server-validated checksum).
      if (isPreconditionFailed(e)) {
        if (await this.#alreadyStored(sha256, size, key)) return ref;
        throw new HypertestError('unavailable', `s3 PutObject ${key} was refused (412) but the object is not visible yet`, { cause: e, details: { key } });
      }
      throw mapError(e, 'PutObject', key);
    }
    return ref;
  }

  /** true when the object exists with the expected size; integrity_violation when its size differs. */
  async #alreadyStored(sha256: string, size: number, key: string): Promise<boolean> {
    const existing = await this.head(sha256);
    if (!existing) return false;
    if (existing.size !== size) {
      throw new HypertestError('integrity_violation', `s3 object ${key} exists with size ${existing.size}, expected ${size}`, { details: { key, sha256, size, storedSize: existing.size } });
    }
    return true;
  }

  async #download(sha256: string): Promise<Uint8Array | undefined> {
    const key = this.keyFor(sha256);
    const sdk = await loadSdk();
    let out: { Body?: unknown };
    try {
      out = (await (await this.#getClient()).send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key: key }))) as { Body?: unknown };
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw mapError(e, 'GetObject', key);
    }
    return bodyToBytes(out?.Body);
  }

  async #getClient(): Promise<S3ClientLike> {
    if (this.#client) return this.#client;
    const sdk = await loadSdk();
    // A concurrent first call may have created the client while this one awaited the SDK.
    if (this.#client) return this.#client;
    const config: S3.S3ClientConfig = { region: this.#options.region };
    if (this.#options.endpoint !== undefined) config.endpoint = this.#options.endpoint;
    if (this.#options.forcePathStyle !== undefined) config.forcePathStyle = this.#options.forcePathStyle;
    if (this.#options.credentials !== undefined) config.credentials = this.#options.credentials;
    this.#client = new sdk.S3Client(config);
    this.#ownsClient = true;
    return this.#client;
  }

  /**
   * Releases the S3 client (and its keep-alive sockets) when this store created it; an injected
   * client belongs to the caller and is left alone. The store may be used again afterwards (a new
   * client is created on demand).
   */
  destroy(): void {
    if (!this.#ownsClient || !this.#client) return;
    (this.#client as { destroy?: () => void }).destroy?.();
    this.#client = undefined;
    this.#ownsClient = false;
  }
}
