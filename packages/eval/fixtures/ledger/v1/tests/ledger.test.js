// The original suite: only the first page of a short list and simple transfers are covered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTransfer, computeInterest, paginate } from '../src/ledger.js';

test('paginate returns the first page of a short list', () => {
  assert.deepEqual(paginate(['a', 'b', 'c'], 1, 10), ['a', 'b', 'c']);
});

test('applyTransfer moves the amount between two accounts', () => {
  assert.deepEqual(applyTransfer({ alice: 100, bob: 20 }, 'alice', 'bob', 30), { alice: 70, bob: 50 });
});

test('applyTransfer refuses a non-positive amount', () => {
  assert.throws(() => applyTransfer({ alice: 100, bob: 20 }, 'alice', 'bob', 0), RangeError);
});

test('computeInterest over one year at 1%', () => {
  assert.equal(computeInterest(36500, 1, 365), 365);
});
