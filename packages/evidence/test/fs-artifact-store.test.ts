import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isHypertestError, sha256Hex } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { FsArtifactStore } from '../src/index.ts';

let dir: { path: string; cleanup(): Promise<void> };
let store: FsArtifactStore;

before(async () => {
  dir = await tempDir('ht-evidence-fs-');
  store = new FsArtifactStore(join(dir.path, 'cas'));
});
after(async () => {
  await dir.cleanup();
});

test('put: content address, uri scheme and <root>/sha256/<first2>/<hex> layout', async () => {
  const ref = await store.put('hello evidence', { mimeType: 'text/plain' });
  const hex = sha256Hex('hello evidence');
  assert.deepEqual(ref, { uri: `cas://sha256/${hex}`, sha256: hex, size: 14, mimeType: 'text/plain' });
  const path = join(dir.path, 'cas', 'sha256', hex.slice(0, 2), hex);
  assert.equal(store.pathFor(hex), path);
  assert.equal(await readFile(path, 'utf8'), 'hello evidence');
  const st = await stat(path);
  assert.equal(st.mode & 0o777, 0o444, 'stored objects are read-only');
});

test('put: idempotent — same bytes give the same ref and the object is not rewritten', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const first = await store.put(bytes, { mimeType: 'application/octet-stream' });
  const st1 = await stat(store.pathFor(first.sha256));
  await new Promise((r) => setTimeout(r, 20));
  const second = await store.put(Uint8Array.from(bytes), { mimeType: 'application/octet-stream' });
  const st2 = await stat(store.pathFor(first.sha256));
  assert.deepEqual(second, first);
  assert.equal(st2.ino, st1.ino, 'same inode: no rename over the existing object');
  assert.equal(st2.mtimeMs, st1.mtimeMs, 'same mtime: no rewrite');
});

test('put: concurrent puts of the same bytes converge on one object and leave no temp files', async () => {
  const refs = await Promise.all(Array.from({ length: 10 }, () => store.put('concurrent-same', { mimeType: 'text/plain' })));
  assert.equal(new Set(refs.map((r) => r.uri)).size, 1);
  assert.equal(await store.getText(refs[0]!), 'concurrent-same');
  assert.deepEqual(await readdir(join(dir.path, 'cas', '.tmp')), []);
});

test('putFile: streams a large file, hashing while copying', async () => {
  const src = join(dir.path, 'big.bin');
  const big = Buffer.alloc(3 * 1024 * 1024 + 17);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
  await writeFile(src, big);
  const ref = await store.putFile(src, { mimeType: 'application/octet-stream', classification: 'internal' });
  assert.equal(ref.sha256, sha256Hex(big));
  assert.equal(ref.size, big.length);
  assert.equal(ref.uri, `cas://sha256/${ref.sha256}`);
  const back = await store.get(ref);
  assert.equal(Buffer.compare(Buffer.from(back), big), 0);
  assert.deepEqual(await store.putFile(src, { mimeType: 'application/octet-stream' }), ref, 'putFile is idempotent too');
  assert.deepEqual(await readdir(join(dir.path, 'cas', '.tmp')), []);
});

test('putFile: missing source ⇒ not_found and no temp residue', async () => {
  await assert.rejects(store.putFile(join(dir.path, 'nope.txt'), { mimeType: 'text/plain' }), (e: unknown) => isHypertestError(e, 'not_found'));
  assert.deepEqual(await readdir(join(dir.path, 'cas', '.tmp')), []);
});

test('get: accepts ArtifactRef, cas:// uri, s3-style uri and bare hex', async () => {
  const ref = await store.put('locators', { mimeType: 'text/plain' });
  for (const loc of [ref, ref.uri, ref.sha256, ref.sha256.toUpperCase(), `s3://bucket/some/prefix/sha256/${ref.sha256}`]) {
    assert.equal(Buffer.from(await store.get(loc)).toString('utf8'), 'locators');
  }
});

test('get: unknown digest ⇒ not_found; malformed/traversal locators ⇒ invalid_argument', async () => {
  const missing = sha256Hex('never stored');
  await assert.rejects(store.get(missing), (e: unknown) => isHypertestError(e, 'not_found') && e.details['sha256'] === missing);
  for (const bad of ['../../etc/passwd', 'cas://sha256/../../x', 'cas://md5/abc', 'abc', `cas://sha256/${missing}/..`]) {
    await assert.rejects(store.get(bad), (e: unknown) => isHypertestError(e, 'invalid_argument'), bad);
  }
});

test('getText: bounded by maxBytes with the truncation marker', async () => {
  const ref = await store.put('x'.repeat(1000), { mimeType: 'text/plain' });
  const text = await store.getText(ref, 100);
  assert.ok(Buffer.byteLength(text) <= 100);
  assert.ok(text.endsWith('…[truncated]'));
  assert.equal(await store.getText(ref), 'x'.repeat(1000));
});

test('exists / head', async () => {
  const ref = await store.put('head me', { mimeType: 'text/plain' });
  assert.equal(await store.exists(ref.sha256), true);
  assert.deepEqual(await store.head(ref), { sha256: ref.sha256, size: 7 });
  assert.equal(await store.exists(sha256Hex('absent')), false);
  assert.equal(await store.head(sha256Hex('absent')), undefined);
});

test('verify: true for intact bytes; false when bytes are modified on disk, size lies, or file missing', async () => {
  const ref = await store.put('pristine bytes', { mimeType: 'text/plain' });
  assert.equal(await store.verify(ref), true);
  assert.equal(await store.verify({ ...ref, size: ref.size + 1 }), false, 'declared size must match');

  const path = store.pathFor(ref.sha256);
  await chmod(path, 0o644);
  await writeFile(path, 'tampered bytes');
  assert.equal(await store.verify(ref), false);
  await assert.rejects(store.get(ref), (e: unknown) => isHypertestError(e, 'integrity_violation'), 'get never returns corrupted bytes');

  // put() of the original bytes does not silently "repair" the tampered object (tamper stays visible).
  await store.put('pristine bytes', { mimeType: 'text/plain' });
  assert.equal(await store.verify(ref), false);

  await rm(path, { force: true });
  assert.equal(await store.verify(ref), false);
  assert.equal(await store.exists(ref.sha256), false);
});

test('put/putFile: an existing object whose size was changed ⇒ integrity_violation, never a ref to corrupt bytes', async () => {
  const ref = await store.put('size-checked object', { mimeType: 'text/plain' });
  const path = store.pathFor(ref.sha256);
  await chmod(path, 0o644);
  await writeFile(path, 'truncated');
  await assert.rejects(
    store.put('size-checked object', { mimeType: 'text/plain' }),
    (e: unknown) => isHypertestError(e, 'integrity_violation') && e.details['storedSize'] === 9 && e.details['size'] === ref.size,
  );
  const src = join(dir.path, 'size-checked.txt');
  await writeFile(src, 'size-checked object');
  await assert.rejects(store.putFile(src, { mimeType: 'text/plain' }), (e: unknown) => isHypertestError(e, 'integrity_violation'));
  assert.equal(await readFile(path, 'utf8'), 'truncated', 'the tampered object is left as evidence of tampering');
  assert.deepEqual(await readdir(join(dir.path, 'cas', '.tmp')), []);
});

test('a directory planted at an object path: exists false, get not_found, verify false (no crash)', async () => {
  const ref = await store.put('soon a directory', { mimeType: 'text/plain' });
  const path = store.pathFor(ref.sha256);
  await rm(path, { force: true });
  await mkdir(path);
  assert.equal(await store.exists(ref.sha256), false);
  assert.equal(await store.head(ref), undefined);
  assert.equal(await store.verify(ref), false);
  await assert.rejects(store.get(ref), (e: unknown) => isHypertestError(e, 'not_found'));
});

test('putFile: a directory as the source ⇒ invalid_argument and no temp residue', async () => {
  await assert.rejects(store.putFile(dir.path, { mimeType: 'text/plain' }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  assert.deepEqual(await readdir(join(dir.path, 'cas', '.tmp')), []);
});

test('put: validates mimeType and data', async () => {
  await assert.rejects(store.put('x', { mimeType: '' }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  await assert.rejects(store.put(42 as unknown as string, { mimeType: 'text/plain' }), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});
