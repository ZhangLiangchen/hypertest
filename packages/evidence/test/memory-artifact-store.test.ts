import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isHypertestError, sha256Hex } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { MemoryArtifactStore } from '../src/index.ts';

test('memory store: content-addressed, idempotent, copies bytes in and out', async () => {
  const store = new MemoryArtifactStore();
  const bytes = new Uint8Array([9, 8, 7]);
  const ref = await store.put(bytes, { mimeType: 'application/octet-stream' });
  assert.deepEqual(ref, { uri: `cas://sha256/${sha256Hex(bytes)}`, sha256: sha256Hex(bytes), size: 3, mimeType: 'application/octet-stream' });
  bytes[0] = 0; // caller mutation must not affect the stored object
  assert.deepEqual([...(await store.get(ref))], [9, 8, 7]);
  const out = await store.get(ref);
  out[0] = 1; // nor may mutating a returned buffer
  assert.equal(await store.verify(ref), true);
  assert.deepEqual(await store.put(new Uint8Array([9, 8, 7]), { mimeType: 'application/octet-stream' }), ref);
  assert.equal(store.size, 1);
});

test('memory store: not_found, exists, head, verify, getText and putFile', async () => {
  const store = new MemoryArtifactStore();
  const missing = sha256Hex('missing');
  await assert.rejects(store.get(missing), (e: unknown) => isHypertestError(e, 'not_found'));
  assert.equal(await store.exists(missing), false);
  assert.equal(await store.head(missing), undefined);
  assert.equal(await store.verify({ uri: `cas://sha256/${missing}`, sha256: missing, size: 7, mimeType: 'text/plain' }), false);

  const ref = await store.put('héllo', { mimeType: 'text/plain' });
  assert.equal(ref.size, 6);
  assert.equal(await store.getText(ref.uri), 'héllo');
  assert.deepEqual(await store.head(ref), { sha256: ref.sha256, size: 6 });
  assert.equal(await store.verify({ ...ref, size: 5 }), false);

  const dir = await tempDir();
  try {
    const p = join(dir.path, 'f.txt');
    await writeFile(p, 'from file');
    const fref = await store.putFile(p, { mimeType: 'text/plain' });
    assert.equal(fref.sha256, sha256Hex('from file'));
    await assert.rejects(store.putFile(join(dir.path, 'absent'), { mimeType: 'text/plain' }), (e: unknown) => isHypertestError(e, 'not_found'));
    await assert.rejects(store.putFile(dir.path, { mimeType: 'text/plain' }), (e: unknown) => isHypertestError(e, 'invalid_argument'), 'a directory is not a source file');
  } finally {
    await dir.cleanup();
  }
});
