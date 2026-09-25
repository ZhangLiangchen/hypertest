import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FixedClock, isHypertestError, sha256Hex } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { S3ArtifactStore, type S3ClientLike } from '../src/index.ts';

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

/** In-memory fake of the three S3 operations the store uses; records every command. */
class FakeS3 implements S3ClientLike {
  readonly objects = new Map<string, { body: Buffer; input: Record<string, unknown> }>();
  readonly sent: Sent[] = [];
  failWith: Error | undefined;
  preconditionOnPut = false;
  /** Simulates a concurrent writer: on PutObject, this body is stored under the key first, then 412. */
  racer: Buffer | undefined;
  destroyed = 0;

  destroy(): void {
    this.destroyed++;
  }

  async send(command: object): Promise<unknown> {
    const name = command.constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    this.sent.push({ name, input });
    if (this.failWith) throw this.failWith;
    const key = `${String(input['Bucket'])}/${String(input['Key'])}`;
    switch (name) {
      case 'HeadObjectCommand': {
        const o = this.objects.get(key);
        if (!o) throw s3Error('NotFound', 404);
        return { ContentLength: o.body.byteLength };
      }
      case 'PutObjectCommand': {
        if (this.racer) {
          this.objects.set(key, { body: this.racer, input: {} });
          throw s3Error('PreconditionFailed', 412);
        }
        if (this.preconditionOnPut) throw s3Error('PreconditionFailed', 412);
        if (input['IfNoneMatch'] === '*' && this.objects.has(key)) throw s3Error('PreconditionFailed', 412);
        const body = input['Body'];
        let buf: Buffer;
        if (body instanceof Uint8Array) buf = Buffer.from(body);
        else {
          const chunks: Buffer[] = [];
          for await (const c of body as Readable) chunks.push(Buffer.from(c as Buffer));
          buf = Buffer.concat(chunks);
        }
        const checksum = Buffer.from(sha256Hex(buf), 'hex').toString('base64');
        if (input['ChecksumSHA256'] !== checksum) throw s3Error('BadDigest', 400);
        this.objects.set(key, { body: buf, input });
        return {};
      }
      case 'GetObjectCommand': {
        const o = this.objects.get(key);
        if (!o) throw s3Error('NoSuchKey', 404);
        return { Body: { transformToByteArray: async () => new Uint8Array(o.body) } };
      }
      default:
        throw new Error(`unexpected command ${name}`);
    }
  }
}

test('S3: put uses key <prefix>sha256/<hex>, HeadObject dedupe, checksum, If-None-Match and s3:// uri', async () => {
  const fake = new FakeS3();
  const store = new S3ArtifactStore({ client: fake, region: 'us-east-1', bucket: 'evidence', prefix: 'hypertest' });
  const hex = sha256Hex('s3 bytes');
  const ref = await store.put('s3 bytes', { mimeType: 'text/plain', classification: 'confidential' });
  assert.deepEqual(ref, { uri: `s3://evidence/hypertest/sha256/${hex}`, sha256: hex, size: 8, mimeType: 'text/plain' });
  assert.deepEqual(fake.sent.map((s) => s.name), ['HeadObjectCommand', 'PutObjectCommand']);
  const put = fake.sent[1]!.input;
  assert.equal(put['Bucket'], 'evidence');
  assert.equal(put['Key'], `hypertest/sha256/${hex}`);
  assert.equal(put['ContentType'], 'text/plain');
  assert.equal(put['ContentLength'], 8);
  assert.equal(put['IfNoneMatch'], '*');
  assert.equal(put['ChecksumSHA256'], Buffer.from(hex, 'hex').toString('base64'));
  assert.deepEqual(put['Metadata'], { sha256: hex, classification: 'confidential' });
  assert.equal(put['ObjectLockMode'], undefined, 'no Object Lock headers unless objectLockDays is configured');
  assert.equal(put['ObjectLockRetainUntilDate'], undefined);

  fake.sent.length = 0;
  assert.deepEqual(await store.put('s3 bytes', { mimeType: 'text/plain' }), ref);
  assert.deepEqual(fake.sent.map((s) => s.name), ['HeadObjectCommand'], 'second put is deduped by HeadObject');
});

test('S3: objectLockDays ⇒ ObjectLockMode=COMPLIANCE and retain-until = now + days', async () => {
  const fake = new FakeS3();
  const clock = new FixedClock('2026-03-01T12:00:00.000Z');
  const store = new S3ArtifactStore({ client: fake, region: 'us-east-1', bucket: 'worm', objectLockDays: 30, clock });
  await store.put('locked', { mimeType: 'text/plain' });
  const put = fake.sent.find((s) => s.name === 'PutObjectCommand')!.input;
  assert.equal(put['ObjectLockMode'], 'COMPLIANCE');
  assert.deepEqual(put['ObjectLockRetainUntilDate'], new Date('2026-03-31T12:00:00.000Z'));
  assert.equal(put['Key'], `sha256/${sha256Hex('locked')}`, 'empty prefix ⇒ key sha256/<hex>');
});

test('S3: invalid objectLockDays / missing bucket are rejected at construction', () => {
  assert.throws(() => new S3ArtifactStore({ region: 'r', bucket: 'b', objectLockDays: 0 }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  assert.throws(() => new S3ArtifactStore({ region: 'r', bucket: 'b', objectLockDays: 1.5 }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  assert.throws(() => new S3ArtifactStore({ region: 'r', bucket: '' }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});

test('S3: get/getText/exists/head/verify round trip and not_found', async () => {
  const fake = new FakeS3();
  const store = new S3ArtifactStore({ client: fake, region: 'us-east-1', bucket: 'b', prefix: 'p/' });
  const ref = await store.put('round trip', { mimeType: 'text/plain' });
  assert.equal(await store.getText(ref), 'round trip');
  assert.equal(await store.getText(ref.uri), 'round trip');
  assert.equal(Buffer.from(await store.get(ref.sha256)).toString(), 'round trip');
  assert.equal(await store.exists(ref.sha256), true);
  assert.deepEqual(await store.head(ref), { sha256: ref.sha256, size: 10 });
  assert.equal(await store.verify(ref), true);

  const missing = sha256Hex('missing');
  await assert.rejects(store.get(missing), (e: unknown) => isHypertestError(e, 'not_found'));
  assert.equal(await store.exists(missing), false);
  assert.equal(await store.verify({ ...ref, sha256: missing }), false);
});

test('S3: tampered object bytes ⇒ verify false and get integrity_violation', async () => {
  const fake = new FakeS3();
  const store = new S3ArtifactStore({ client: fake, region: 'us-east-1', bucket: 'b' });
  const ref = await store.put('original', { mimeType: 'text/plain' });
  fake.objects.get(`b/sha256/${ref.sha256}`)!.body = Buffer.from('modified');
  assert.equal(await store.verify(ref), false);
  await assert.rejects(store.get(ref), (e: unknown) => isHypertestError(e, 'integrity_violation'));
});

test('S3: existing object with a different size is an integrity_violation (never overwritten)', async () => {
  const fake = new FakeS3();
  const store = new S3ArtifactStore({ client: fake, region: 'us-east-1', bucket: 'b' });
  const hex = sha256Hex('abc');
  fake.objects.set(`b/sha256/${hex}`, { body: Buffer.from('abcdef'), input: {} });
  await assert.rejects(store.put('abc', { mimeType: 'text/plain' }), (e: unknown) => isHypertestError(e, 'integrity_violation'));
  assert.equal(fake.sent.filter((s) => s.name === 'PutObjectCommand').length, 0);
});

test('S3: a concurrent writer winning the race (412) with the same object is treated as success', async () => {
  const fake = new FakeS3();
  fake.racer = Buffer.from('raced');
  const store = new S3ArtifactStore({ client: fake, region: 'us-east-1', bucket: 'b' });
  const ref = await store.put('raced', { mimeType: 'text/plain' });
  assert.equal(ref.sha256, sha256Hex('raced'));
  assert.deepEqual(fake.sent.map((s) => s.name), ['HeadObjectCommand', 'PutObjectCommand', 'HeadObjectCommand'], 'the winner\'s object is re-checked');
});

test('S3: a 412 race lost to an object of a different size ⇒ integrity_violation (not success)', async () => {
  const fake = new FakeS3();
  fake.racer = Buffer.from('something else entirely');
  const store = new S3ArtifactStore({ client: fake, region: 'us-east-1', bucket: 'b' });
  await assert.rejects(store.put('raced', { mimeType: 'text/plain' }), (e: unknown) => isHypertestError(e, 'integrity_violation') && e.details['storedSize'] === 23);
});

test('S3: 412 while the winner\'s object is not visible ⇒ retryable unavailable', async () => {
  const fake = new FakeS3();
  fake.preconditionOnPut = true;
  const store = new S3ArtifactStore({ client: fake, region: 'us-east-1', bucket: 'b' });
  await assert.rejects(store.put('raced', { mimeType: 'text/plain' }), (e: unknown) => isHypertestError(e, 'unavailable') && e.retryable);
});

test('S3: destroy() leaves an injected client to its owner', async () => {
  const fake = new FakeS3();
  const store = new S3ArtifactStore({ client: fake, region: 'us-east-1', bucket: 'b' });
  await store.put('x', { mimeType: 'text/plain' });
  store.destroy();
  assert.equal(fake.destroyed, 0);
  assert.equal(await store.getText(sha256Hex('x')), 'x', 'the injected client is still used');
});

test('S3: putFile hashes first, then streams the upload', async () => {
  const fake = new FakeS3();
  const store = new S3ArtifactStore({ client: fake, region: 'us-east-1', bucket: 'b' });
  const dir = await tempDir();
  try {
    const p = join(dir.path, 'payload.json');
    const content = JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => i) });
    await writeFile(p, content);
    const ref = await store.putFile(p, { mimeType: 'application/json' });
    assert.equal(ref.sha256, sha256Hex(content));
    assert.equal(ref.size, Buffer.byteLength(content));
    const put = fake.sent.find((s) => s.name === 'PutObjectCommand')!.input;
    assert.ok(put['Body'] instanceof Readable, 'upload body is a stream');
    assert.equal(await store.getText(ref), content);
    await assert.rejects(store.putFile(join(dir.path, 'absent'), { mimeType: 'text/plain' }), (e: unknown) => isHypertestError(e, 'not_found'));
    await assert.rejects(store.putFile(dir.path, { mimeType: 'text/plain' }), (e: unknown) => isHypertestError(e, 'invalid_argument'), 'a directory is not a source file');
    assert.equal(fake.sent.filter((x) => x.name === 'PutObjectCommand').length, 1, 'nothing uploaded for the failed sources');
  } finally {
    await dir.cleanup();
  }
});

test('S3: transport errors map to typed HypertestErrors', async () => {
  const fake = new FakeS3();
  const store = new S3ArtifactStore({ client: fake, region: 'us-east-1', bucket: 'b' });
  fake.failWith = s3Error('AccessDenied', 403);
  await assert.rejects(store.put('x', { mimeType: 'text/plain' }), (e: unknown) => isHypertestError(e, 'permission_denied'));
  fake.failWith = s3Error('InternalError', 500);
  await assert.rejects(store.get(sha256Hex('x')), (e: unknown) => isHypertestError(e, 'unavailable') && (e as { retryable: boolean }).retryable === true);
  await assert.rejects(store.exists(sha256Hex('x')), (e: unknown) => isHypertestError(e, 'unavailable'));
});
