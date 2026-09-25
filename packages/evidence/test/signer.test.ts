import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, createPublicKey } from 'node:crypto';
import { isHypertestError } from '@hypertest/core';
import { Ed25519Signer, ed25519KeyId, verifyEd25519 } from '../src/index.ts';

// RFC 8032 §7.1, TEST 1 (empty message).
const RFC_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const RFC_PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const RFC_SIG =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

test('fromSeed reproduces the RFC 8032 test vector', async () => {
  const signer = Ed25519Signer.fromSeed(Buffer.from(RFC_SEED, 'hex'));
  const der = createPublicKey(signer.publicKeyPem()).export({ type: 'spki', format: 'der' });
  assert.equal(der.subarray(der.length - 32).toString('hex'), RFC_PUBLIC);
  const sig = await signer.sign(new Uint8Array(0));
  assert.equal(Buffer.from(sig, 'base64').toString('hex'), RFC_SIG);
  assert.equal(verifyEd25519(signer.publicKeyPem(), '', sig), true);
});

test('keyId = "ed25519:" + sha256(SPKI DER)[0..16]', () => {
  const signer = Ed25519Signer.fromSeed(Buffer.from(RFC_SEED, 'hex'));
  const der = createPublicKey(signer.publicKeyPem()).export({ type: 'spki', format: 'der' });
  const expected = `ed25519:${createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
  assert.equal(signer.keyId, expected);
  assert.match(signer.keyId, /^ed25519:[0-9a-f]{16}$/);
  assert.equal(ed25519KeyId(signer.publicKeyPem()), expected);
  assert.equal(signer.algorithm, 'ed25519');
});

test('generate / fromPem round trip keeps identity', async () => {
  const a = Ed25519Signer.generate();
  const b = Ed25519Signer.fromPem(a.privateKeyPem());
  assert.equal(b.keyId, a.keyId);
  assert.equal(b.publicKeyPem(), a.publicKeyPem());
  const sig = await b.sign('payload');
  assert.equal(verifyEd25519(a.publicKeyPem(), 'payload', sig), true);
  assert.notEqual(Ed25519Signer.generate().keyId, a.keyId);
});

test('verifyEd25519 rejects tampered data, wrong key and malformed input without throwing', async () => {
  const signer = Ed25519Signer.generate();
  const other = Ed25519Signer.generate();
  const sig = await signer.sign('root=abc');
  assert.equal(verifyEd25519(signer.publicKeyPem(), 'root=abd', sig), false, 'tampered data');
  assert.equal(verifyEd25519(other.publicKeyPem(), 'root=abc', sig), false, 'wrong key');
  const flipped = Buffer.from(sig, 'base64');
  flipped[0] = flipped[0]! ^ 1;
  assert.equal(verifyEd25519(signer.publicKeyPem(), 'root=abc', flipped.toString('base64')), false, 'bit flip');
  assert.equal(verifyEd25519(signer.publicKeyPem(), 'root=abc', 'not base64!!'), false);
  assert.equal(verifyEd25519(signer.publicKeyPem(), 'root=abc', ''), false);
  assert.equal(verifyEd25519(signer.publicKeyPem(), 'root=abc', sig.slice(0, 40)), false, 'truncated');
  assert.equal(verifyEd25519('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----', 'root=abc', sig), false);
});

test('invalid key material is rejected with invalid_argument', () => {
  assert.throws(() => Ed25519Signer.fromSeed(new Uint8Array(31)), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  assert.throws(() => Ed25519Signer.fromPem('garbage'), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  assert.throws(() => ed25519KeyId('garbage'), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});
