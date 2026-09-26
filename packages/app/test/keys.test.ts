import assert from 'node:assert/strict';
import { chmod, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HypertestError, MemoryLogger } from '@hypertest/core';
import { Ed25519Signer } from '@hypertest/evidence';
import { tempDir } from '@hypertest/testkit';
import { CAPABILITY_SECRET_FILE, SIGNING_KEY_FILE, defaultConfig, keysDir, loadCapabilitySecret, loadSigningKeys, publicKeyFileName } from '../src/index.ts';

const mode = async (p: string) => (await stat(p)).mode & 0o777;

describe('evidence signing key', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => (dir = await tempDir('ht-app-keys-')));
  after(async () => dir.cleanup());

  test('generated on first use with 0600 (dir 0700), persisted, and the same key is loaded again', async () => {
    const dataDir = join(dir.path, 'a');
    const logger = new MemoryLogger();
    const first = await loadSigningKeys(defaultConfig(), dataDir, logger);
    const keyFile = join(keysDir(dataDir), SIGNING_KEY_FILE);
    assert.equal(first.keyFile, keyFile);
    assert.equal(await mode(keyFile), 0o600);
    assert.equal(await mode(keysDir(dataDir)), 0o700);
    assert.equal(await mode(join(keysDir(dataDir), publicKeyFileName(first.signer.keyId))), 0o644);
    assert.deepEqual(Object.keys(first.publicKeys), [first.signer.keyId]);
    const second = await loadSigningKeys(defaultConfig(), dataDir, logger);
    assert.equal(second.signer.keyId, first.signer.keyId);
    assert.equal(logger.entries.filter((e) => e.msg === 'generated the evidence signing key').length, 1);
    assert.equal(JSON.stringify(logger.entries).includes('PRIVATE KEY'), false, 'the private key is never logged');
  });

  test('a group/other readable key file is tightened to 0600 and reported', async () => {
    const dataDir = join(dir.path, 'b');
    const { keyFile } = await loadSigningKeys(defaultConfig(), dataDir, new MemoryLogger());
    await chmod(keyFile, 0o644);
    const logger = new MemoryLogger();
    await loadSigningKeys(defaultConfig(), dataDir, logger);
    assert.equal(await mode(keyFile), 0o600);
    assert.ok(logger.entries.some((e) => e.level === 'warn' && /permissions tightened to 0600/.test(e.msg)));
  });

  test('signing.keyFile: loaded when present; a configured but missing key is not_found (never silently replaced)', async () => {
    const dataDir = join(dir.path, 'c');
    const external = Ed25519Signer.generate();
    const keyFile = join(dir.path, 'external.pem');
    await writeFile(keyFile, external.privateKeyPem(), { mode: 0o600 });
    const keys = await loadSigningKeys(defaultConfig({ signing: { keyFile } }), dataDir, new MemoryLogger());
    assert.equal(keys.signer.keyId, external.keyId);
    assert.deepEqual((await readdir(keysDir(dataDir))).sort(), [publicKeyFileName(external.keyId)]);
    await assert.rejects(
      loadSigningKeys(defaultConfig({ signing: { keyFile: join(dir.path, 'missing.pem') } }), dataDir, new MemoryLogger()),
      (e: unknown) => e instanceof HypertestError && e.code === 'not_found' && /signing\.keyFile .*missing\.pem does not exist/.test(e.message),
    );
  });

  test('rotated keys stay trusted: every *.pub.pem in the keys directory is a verification key', async () => {
    const dataDir = join(dir.path, 'd');
    const old = await loadSigningKeys(defaultConfig(), dataDir, new MemoryLogger());
    const rotated = Ed25519Signer.generate();
    const keyFile = join(dir.path, 'rotated.pem');
    await writeFile(keyFile, rotated.privateKeyPem(), { mode: 0o600 });
    await writeFile(join(keysDir(dataDir), 'garbage.pub.pem'), 'not a key');
    const logger = new MemoryLogger();
    const now = await loadSigningKeys(defaultConfig({ signing: { keyFile } }), dataDir, logger);
    assert.deepEqual(Object.keys(now.publicKeys).sort(), [old.signer.keyId, rotated.keyId].sort());
    assert.equal(now.publicKeys[old.signer.keyId], old.signer.publicKeyPem());
    assert.ok(logger.entries.some((e) => e.msg === 'ignoring an invalid public key file'));
  });
});

describe('capability secret', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => (dir = await tempDir('ht-app-secret-')));
  after(async () => dir.cleanup());

  test('generated (0600) and stable across restarts when no capabilitySecretEnv is configured', async () => {
    const dataDir = join(dir.path, 'a');
    const s1 = await loadCapabilitySecret(defaultConfig(), dataDir, {}, new MemoryLogger());
    const s2 = await loadCapabilitySecret(defaultConfig(), dataDir, {}, new MemoryLogger());
    assert.equal(s1, s2);
    assert.ok(s1.length >= 32);
    const file = join(keysDir(dataDir), CAPABILITY_SECRET_FILE);
    assert.equal((await readFile(file, 'utf8')).trim(), s1);
    assert.equal(await mode(file), 0o600);
  });

  test('from policy.capabilitySecretEnv: required, at least 16 characters, never written to disk', async () => {
    const dataDir = join(dir.path, 'b');
    const cfg = defaultConfig({ policy: { capabilitySecretEnv: 'HT_CAP_SECRET' } });
    assert.equal(await loadCapabilitySecret(cfg, dataDir, { HT_CAP_SECRET: 'a-very-long-shared-secret' }, new MemoryLogger()), 'a-very-long-shared-secret');
    await assert.rejects(loadCapabilitySecret(cfg, dataDir, {}, new MemoryLogger()), (e: unknown) => e instanceof HypertestError && e.code === 'precondition_failed' && /HT_CAP_SECRET, which is not set/.test(e.message));
    await assert.rejects(loadCapabilitySecret(cfg, dataDir, { HT_CAP_SECRET: 'short' }, new MemoryLogger()), (e: unknown) => e instanceof HypertestError && /too short/.test(e.message) && !e.message.includes('short\''));
    await assert.rejects(stat(join(keysDir(dataDir), CAPABILITY_SECRET_FILE)), { code: 'ENOENT' });
  });

  test('a truncated secret file is an integrity violation', async () => {
    const dataDir = join(dir.path, 'c');
    await loadCapabilitySecret(defaultConfig(), dataDir, {}, new MemoryLogger());
    await writeFile(join(keysDir(dataDir), CAPABILITY_SECRET_FILE), 'abc\n');
    await assert.rejects(loadCapabilitySecret(defaultConfig(), dataDir, {}, new MemoryLogger()), (e: unknown) => e instanceof HypertestError && e.code === 'integrity_violation');
  });
});
