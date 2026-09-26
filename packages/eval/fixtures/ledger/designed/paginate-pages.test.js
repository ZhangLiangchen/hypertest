import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/ledger.js';

// ledger-contract A1: paginate returns every item exactly once across pages
test('paginate returns every item exactly once across pages', () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  const pages = [1, 2, 3].map((page) => paginate(items, page, 3));
  assert.deepEqual(pages, [[1, 2, 3], [4, 5, 6], [7]]);
});
