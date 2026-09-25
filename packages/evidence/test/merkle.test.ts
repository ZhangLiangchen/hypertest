import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHypertestError } from '@hypertest/core';
import { EMPTY_ROOT, merkleRoot } from '../src/index.ts';

// Leaves are sha256('a') … sha256('e'); expected roots were computed independently with Python hashlib.
const A = 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb';
const B = '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d';
const C = '2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6';
const D = '18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4';
const E = '3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea';

test('merkleRoot: empty ⇒ sha256("")', () => {
  assert.equal(merkleRoot([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(EMPTY_ROOT, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('merkleRoot: a single leaf is its own root', () => {
  assert.equal(merkleRoot([A]), A);
});

test('merkleRoot: two leaves ⇒ sha256(left + right) over hex strings', () => {
  assert.equal(merkleRoot([A, B]), '62af5c3cb8da3e4f25061e829ebeea5c7513c54949115b1acc225930a90154da');
});

test('merkleRoot: odd count duplicates the last node (3 leaves)', () => {
  assert.equal(merkleRoot([A, B, C]), '0bdf27bf7ec894ca7cadfe491ec1a3ece840f117989e8c5e9bd7086467bf6c38');
});

test('merkleRoot: four leaves', () => {
  assert.equal(merkleRoot([A, B, C, D]), '58c89d709329eb37285837b042ab6ff72c7c8f74de0446b091b6a0131c102cfd');
});

test('merkleRoot: odd duplication at an inner level (5 leaves)', () => {
  assert.equal(merkleRoot([A, B, C, D, E]), '3615e586768e706351e326736e446554c49123d0e24c169d3ecf9b791a82636b');
});

test('merkleRoot: order matters', () => {
  assert.notEqual(merkleRoot([A, B]), merkleRoot([B, A]));
});

test('merkleRoot: rejects non-hex leaves instead of hashing garbage', () => {
  for (const bad of [['abc'], [A.toUpperCase()], [A, 'not-a-hash'], [A + '00']]) {
    assert.throws(() => merkleRoot(bad), (e: unknown) => isHypertestError(e, 'invalid_argument'));
  }
});
