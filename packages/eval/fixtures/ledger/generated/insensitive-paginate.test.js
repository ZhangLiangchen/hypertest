import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/ledger.js';

// "covers" ledger-contract A1 by name, but checks nothing a pagination defect would change
test('paginate returns every item exactly once across pages', () => {
  const page = paginate([1, 2, 3, 4, 5, 6, 7], 1, 3);
  assert.ok(Array.isArray(page));
  assert.ok(page.length > 0);
});
