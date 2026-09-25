import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FixedClock, sha256Hex } from '@hypertest/core';
import { S3ArtifactStore } from '../src/index.ts';

// A minimal S3-compatible HTTP server on localhost: exercises the real AWS SDK request path
// (path-style addressing, signing, headers on the wire) without any external network.
interface Req {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}
const objects = new Map<string, Buffer>();
const requests: Req[] = [];
let server: Server;
let endpoint: string;

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = decodeURIComponent((req.url ?? '').split('?')[0]!);
      requests.push({ method: req.method ?? '', url, headers: req.headers });
      const obj = objects.get(url);
      if (req.method === 'HEAD') {
        if (!obj) return void res.writeHead(404).end();
        return void res.writeHead(200, { 'content-length': obj.byteLength, etag: '"e"' }).end();
      }
      if (req.method === 'GET') {
        if (!obj) {
          res.writeHead(404, { 'content-type': 'application/xml' });
          return void res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
        }
        return void res.writeHead(200, { 'content-length': obj.byteLength, 'content-type': 'application/octet-stream' }).end(obj);
      }
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && obj) {
          res.writeHead(412, { 'content-type': 'application/xml' });
          return void res.end('<?xml version="1.0"?><Error><Code>PreconditionFailed</Code><Message>exists</Message></Error>');
        }
        const body = Buffer.concat(chunks);
        const expected = Buffer.from(sha256Hex(body), 'hex').toString('base64');
        if (req.headers['x-amz-checksum-sha256'] !== expected) {
          res.writeHead(400, { 'content-type': 'application/xml' });
          return void res.end('<?xml version="1.0"?><Error><Code>BadDigest</Code><Message>checksum</Message></Error>');
        }
        objects.set(url, body);
        return void res.writeHead(200, { etag: '"e"' }).end();
      }
      res.writeHead(405).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  for (const s of created) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const created: S3ArtifactStore[] = [];

function store(objectLockDays?: number): S3ArtifactStore {
  const s = new S3ArtifactStore({
    endpoint,
    region: 'us-east-1',
    bucket: 'evidence',
    prefix: 'ht',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    clock: new FixedClock('2026-05-01T00:00:00.000Z'),
    ...(objectLockDays === undefined ? {} : { objectLockDays }),
  });
  created.push(s);
  return s;
}

test('S3 over the wire: path-style key, checksum, If-None-Match and Object Lock COMPLIANCE headers', async () => {
  const s = store(7);
  const hex = sha256Hex('wire bytes');
  const ref = await s.put('wire bytes', { mimeType: 'text/plain' });
  assert.equal(ref.uri, `s3://evidence/ht/sha256/${hex}`);
  const put = requests.find((r) => r.method === 'PUT')!;
  assert.equal(put.url, `/evidence/ht/sha256/${hex}`);
  assert.equal(put.headers['x-amz-object-lock-mode'], 'COMPLIANCE');
  assert.equal(new Date(String(put.headers['x-amz-object-lock-retain-until-date'])).toISOString(), '2026-05-08T00:00:00.000Z');
  assert.equal(put.headers['if-none-match'], '*');
  assert.equal(put.headers['content-type'], 'text/plain');
  assert.equal(put.headers['x-amz-meta-sha256'], hex);
  assert.ok(String(put.headers['authorization']).startsWith('AWS4-HMAC-SHA256'), 'requests are SigV4-signed');

  requests.length = 0;
  assert.deepEqual(await s.put('wire bytes', { mimeType: 'text/plain' }), ref);
  assert.deepEqual(requests.map((r) => r.method), ['HEAD'], 'dedupe by HeadObject');

  assert.equal(await s.getText(ref), 'wire bytes');
  assert.equal(await s.verify(ref), true);
  assert.equal(await s.exists(sha256Hex('nope')), false);
  assert.equal(await s.verify({ ...ref, sha256: sha256Hex('nope') }), false);
});

test('S3 over the wire: no Object Lock headers without objectLockDays; tampered object detected', async () => {
  const s = store();
  const ref = await s.put('plain object', { mimeType: 'text/plain' });
  const put = requests.filter((r) => r.method === 'PUT').at(-1)!;
  assert.equal(put.headers['x-amz-object-lock-mode'], undefined);
  assert.equal(put.headers['x-amz-object-lock-retain-until-date'], undefined);
  objects.set(`/evidence/ht/sha256/${ref.sha256}`, Buffer.from('plain objecT'));
  assert.equal(await s.verify(ref), false);
  await assert.rejects(s.get(ref), /corrupted/);
});

test('S3 over the wire: putFile streams a file body with the precomputed checksum', async () => {
  const { tempDir } = await import('@hypertest/testkit');
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = await tempDir();
  try {
    const p = join(dir.path, 'report.bin');
    const content = Buffer.alloc(256 * 1024, 7);
    await writeFile(p, content);
    const s = store();
    const ref = await s.putFile(p, { mimeType: 'application/octet-stream' });
    assert.equal(ref.sha256, sha256Hex(content));
    assert.equal(ref.size, content.byteLength);
    assert.equal(Buffer.compare(Buffer.from(await s.get(ref)), content), 0);
  } finally {
    await dir.cleanup();
  }
});

test('S3 over the wire: destroy() releases the owned client once; the store recreates one on demand', async () => {
  const { S3Client } = await import('@aws-sdk/client-s3');
  const original = S3Client.prototype.destroy;
  let destroyed = 0;
  S3Client.prototype.destroy = function (this: InstanceType<typeof S3Client>) {
    destroyed++;
    return original.call(this);
  };
  try {
    const s = store();
    s.destroy();
    assert.equal(destroyed, 0, 'nothing to release before the client exists');
    const ref = await s.put('destroy me', { mimeType: 'text/plain' });
    s.destroy();
    s.destroy();
    assert.equal(destroyed, 1, 'released exactly once');
    assert.equal(await s.getText(ref), 'destroy me');
    s.destroy();
    assert.equal(destroyed, 2, 'the recreated client is released too');
  } finally {
    S3Client.prototype.destroy = original;
  }
});
