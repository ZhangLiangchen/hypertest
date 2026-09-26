// A multi-page pagination test (present in the initial commit of the oracle-robustness variant).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/ledger.js';

test('paginate returns every item exactly once across pages', () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  const seen = [...paginate(items, 1, 3), ...paginate(items, 2, 3), ...paginate(items, 3, 3)];
  assert.deepEqual(seen, items);
});
