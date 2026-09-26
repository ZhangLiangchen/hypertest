import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HypertestError, type Logger } from '@hypertest/core';
import { Ed25519Signer, ed25519KeyId } from '@hypertest/evidence';
import type { HypertestConfig } from './contracts.ts';

/**
 * Key material of one Hypertest data directory: the Ed25519 evidence signer and the HMAC secret of capability
 * tokens. Both must survive restarts (seals are verified with the signer's public key; capabilities recorded for
 * live agents are verified with the secret after a resume), so generated keys are persisted with 0600 permissions
 * under `<dataDir>/keys/` (directory 0700). Keys are never logged.
 */

export const SIGNING_KEY_FILE = 'evidence-ed25519.pem';
export const CAPABILITY_SECRET_FILE = 'capability.secret';
const MIN_SECRET_LENGTH = 16;

/** `ed25519-<hex>.pub.pem` for key id `ed25519:<hex>`. */
export function publicKeyFileName(keyId: string): string {
  return `${keyId.replace(/[^A-Za-z0-9]+/g, '-')}.pub.pem`;
}

export function keysDir(dataDir: string): string {
  return join(dataDir, 'keys');
}

async function ensureKeysDir(dataDir: string): Promise<string> {
  const dir = keysDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

/** Writes `content` to a new file with `mode`; returns false when the file already exists (another process won). */
async function createExclusive(path: string, content: string, mode: number): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, 'wx', mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await chmod(path, mode);
  return true;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Private key files must not be readable by group/other; a looser file is tightened (and reported). */
async function enforcePrivate(path: string, logger: Logger): Promise<void> {
  const st = await stat(path);
  if ((st.mode & 0o077) !== 0) {
    logger.warn('private key file was group/other accessible; permissions tightened to 0600', { path });
    await chmod(path, 0o600);
  }
}

export interface SigningKeys {
  signer: Ed25519Signer;
  /** Where the private key lives. */
  keyFile: string;
  /** Trusted seal keys keyId → SPKI PEM: the signer's own key plus every `*.pub.pem` in `<dataDir>/keys/`. */
  publicKeys: Record<string, string>;
}

/**
 * The evidence signer: `signing.keyFile` when configured (it must exist: a configured key that is missing is a fault,
 * never silently replaced), else `<dataDir>/keys/evidence-ed25519.pem`, generated on first use (0600) together with
 * its public key file `<dataDir>/keys/ed25519-<hex>.pub.pem`. Public keys of rotated signers kept as
 * `<dataDir>/keys/*.pub.pem` stay trusted by verify.
 */
export async function loadSigningKeys(config: HypertestConfig, dataDir: string, logger: Logger): Promise<SigningKeys> {
  const dir = await ensureKeysDir(dataDir);
  let signer: Ed25519Signer;
  let keyFile: string;
  if (config.signing?.keyFile) {
    keyFile = config.signing.keyFile;
    const pem = await readIfExists(keyFile);
    if (pem === undefined) throw new HypertestError('not_found', `signing.keyFile ${keyFile} does not exist (remove signing.keyFile to let Hypertest generate ${join(dir, SIGNING_KEY_FILE)})`);
    await enforcePrivate(keyFile, logger);
    signer = Ed25519Signer.fromPem(pem);
  } else {
    keyFile = join(dir, SIGNING_KEY_FILE);
    let pem = await readIfExists(keyFile);
    if (pem === undefined) {
      const generated = Ed25519Signer.generate();
      if (await createExclusive(keyFile, generated.privateKeyPem(), 0o600)) {
        logger.info('generated the evidence signing key', { keyId: generated.keyId, keyFile });
        pem = generated.privateKeyPem();
      } else {
        pem = await readFile(keyFile, 'utf8');
      }
    }
    await enforcePrivate(keyFile, logger);
    signer = Ed25519Signer.fromPem(pem);
  }
  // one public key file per signer key id: after a key rotation, seals of the old key stay verifiable
  await createExclusive(join(dir, publicKeyFileName(signer.keyId)), signer.publicKeyPem(), 0o644);
  const publicKeys: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith('.pub.pem')) continue;
    const pem = await readFile(join(dir, name), 'utf8');
    try {
      publicKeys[ed25519KeyId(pem)] = pem;
    } catch {
      logger.warn('ignoring an invalid public key file', { file: join(dir, name) });
    }
  }
  publicKeys[signer.keyId] = signer.publicKeyPem();
  return { signer, keyFile, publicKeys };
}

/**
 * The capability HMAC secret: from `policy.capabilitySecretEnv` when configured (the variable must be set, ≥ 16
 * characters; share it between workers of one PostgreSQL store), else `<dataDir>/keys/capability.secret` (generated,
 * 0600). It never appears in the configuration.
 */
export async function loadCapabilitySecret(config: HypertestConfig, dataDir: string, env: Record<string, string | undefined>, logger: Logger): Promise<string> {
  const name = config.policy?.capabilitySecretEnv;
  if (name) {
    const value = env[name];
    if (value === undefined || value === '') throw new HypertestError('precondition_failed', `policy.capabilitySecretEnv names ${name}, which is not set`);
    if (value.length < MIN_SECRET_LENGTH) throw new HypertestError('precondition_failed', `the capability secret in ${name} is too short (at least ${MIN_SECRET_LENGTH} characters)`);
    return value;
  }
  const dir = await ensureKeysDir(dataDir);
  const file = join(dir, CAPABILITY_SECRET_FILE);
  let secret = (await readIfExists(file))?.trim();
  if (secret === undefined) {
    const generated = randomBytes(32).toString('base64url');
    secret = (await createExclusive(file, `${generated}\n`, 0o600)) ? generated : (await readFile(file, 'utf8')).trim();
  }
  await enforcePrivate(file, logger);
  if (secret.length < MIN_SECRET_LENGTH) throw new HypertestError('integrity_violation', `capability secret file ${file} is truncated`);
  return secret;
}
