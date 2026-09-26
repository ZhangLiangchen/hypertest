import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTransfer } from '../src/ledger.js';

const total = (accounts) => Object.values(accounts).reduce((sum, v) => sum + v, 0);

// ledger-contract A2: applyTransfer conserves the total balance
test('transfer conserves the total balance', () => {
  const before = { alice: 120, bob: 35, carol: 0 };
  const after = applyTransfer(applyTransfer(before, 'alice', 'bob', 45), 'bob', 'carol', 30);
  assert.equal(total(after), total(before));
  assert.deepEqual(after, { alice: 75, bob: 50, carol: 30 });
});
