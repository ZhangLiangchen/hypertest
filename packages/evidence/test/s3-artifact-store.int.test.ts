import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '@hypertest/core';
import { skipUnless } from '@hypertest/testkit';
import { S3ArtifactStore } from '../src/index.ts';

// Requires an S3-compatible endpoint (e.g. MinIO):
//   HYPERTEST_TEST_S3_ENDPOINT (required), HYPERTEST_TEST_S3_BUCKET (default hypertest-test),
//   HYPERTEST_TEST_S3_ACCESS_KEY / HYPERTEST_TEST_S3_SECRET_KEY (default minioadmin), HYPERTEST_TEST_S3_REGION.
const endpoint = process.env['HYPERTEST_TEST_S3_ENDPOINT'];
const bucket = process.env['HYPERTEST_TEST_S3_BUCKET'] ?? 'hypertest-test';
const region = process.env['HYPERTEST_TEST_S3_REGION'] ?? 'us-east-1';
const credentials = {
  accessKeyId: process.env['HYPERTEST_TEST_S3_ACCESS_KEY'] ?? 'minioadmin',
  secretAccessKey: process.env['HYPERTEST_TEST_S3_SECRET_KEY'] ?? 'minioadmin',
};

test('S3ArtifactStore against a live S3-compatible endpoint', skipUnless(!!endpoint, 'HYPERTEST_TEST_S3_ENDPOINT is not set (no MinIO/S3 endpoint available)'), async () => {
  const { S3Client, CreateBucketCommand, HeadBucketCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({ endpoint: endpoint!, region, forcePathStyle: true, credentials });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  const store = new S3ArtifactStore({ endpoint: endpoint!, region, bucket, prefix: `it-${randomBytes(4).toString('hex')}`, forcePathStyle: true, credentials });
  const payload = `integration ${randomBytes(8).toString('hex')}`;
  const ref = await store.put(payload, { mimeType: 'text/plain' });
  assert.equal(ref.sha256, sha256Hex(payload));
  assert.ok(ref.uri.startsWith(`s3://${bucket}/`));
  assert.deepEqual(await store.put(payload, { mimeType: 'text/plain' }), ref);
  assert.equal(await store.getText(ref), payload);
  assert.equal(await store.exists(ref.sha256), true);
  assert.equal(await store.verify(ref), true);
  assert.equal(await store.exists(sha256Hex(`absent ${payload}`)), false);
  client.destroy();
});
