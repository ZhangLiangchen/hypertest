import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { HypertestError, sha256Hex } from '@hypertest/core';
import type { Signer } from './contracts.ts';

/** PKCS#8 DER prefix for a raw 32-byte Ed25519 seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function toBuffer(data: string | Uint8Array): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function keyIdOf(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `ed25519:${sha256Hex(der).slice(0, 16)}`;
}

/** Key id of an Ed25519 public key: `ed25519:` + first 16 hex chars of sha256(SPKI DER). */
export function ed25519KeyId(publicKeyPem: string): string {
  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch (e) {
    throw new HypertestError('invalid_argument', 'invalid public key PEM', { cause: e });
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new HypertestError('invalid_argument', `expected an ed25519 key, got ${key.asymmetricKeyType}`);
  return keyIdOf(key);
}

/**
 * Ed25519 signer backed by node:crypto. The `Signer` interface is the KMS/HSM port: production
 * deployments can supply a remote signer with the same shape; the signer identity is separate from
 * the evidence writers.
 */
export class Ed25519Signer implements Signer {
  readonly keyId: string;
  readonly algorithm = 'ed25519' as const;
  readonly #privateKey: KeyObject;
  readonly #publicKeyPem: string;

  constructor(privateKey: KeyObject) {
    if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
      throw new HypertestError('invalid_argument', 'Ed25519Signer requires an ed25519 private key');
    }
    this.#privateKey = privateKey;
    const publicKey = createPublicKey(privateKey);
    this.#publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    this.keyId = keyIdOf(publicKey);
  }

  static generate(): Ed25519Signer {
    return new Ed25519Signer(generateKeyPairSync('ed25519').privateKey);
  }

  /** From a PKCS#8 private key PEM. */
  static fromPem(privatePem: string): Ed25519Signer {
    let key: KeyObject;
    try {
      key = createPrivateKey(privatePem);
    } catch (e) {
      throw new HypertestError('invalid_argument', 'invalid private key PEM', { cause: e });
    }
    return new Ed25519Signer(key);
  }

  /** From a raw 32-byte seed (RFC 8032 secret key). */
  static fromSeed(seed: Uint8Array): Ed25519Signer {
    if (!(seed instanceof Uint8Array) || seed.byteLength !== 32) throw new HypertestError('invalid_argument', 'ed25519 seed must be exactly 32 bytes');
    const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]);
    return new Ed25519Signer(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
  }

  async sign(data: string | Uint8Array): Promise<string> {
    return cryptoSign(null, toBuffer(data), this.#privateKey).toString('base64');
  }

  publicKeyPem(): string {
    return this.#publicKeyPem;
  }

  /** PKCS#8 PEM, for persisting a generated key in a secret store. Never log it. */
  privateKeyPem(): string {
    return this.#privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Verifies an Ed25519 signature. Never throws: malformed keys/signatures yield false. */
export function verifyEd25519(publicKeyPem: string, data: string | Uint8Array, signatureBase64: string): boolean {
  try {
    if (typeof signatureBase64 !== 'string' || signatureBase64.length % 4 !== 0 || !BASE64_RE.test(signatureBase64)) return false;
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.byteLength !== 64) return false;
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return cryptoVerify(null, toBuffer(data), key, signature);
  } catch {
    return false;
  }
}
