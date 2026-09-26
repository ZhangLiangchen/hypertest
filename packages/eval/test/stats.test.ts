import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HypertestError } from '@hypertest/core';
import { mcnemarExact, mulberry32, pairedBootstrapCI, passAtK, passHatK, seedFrom, seededShuffle } from '../src/index.ts';

const invalid = (e: unknown): boolean => e instanceof HypertestError && e.code === 'invalid_argument';

describe('mcnemarExact: two-sided exact binomial p of the discordant pairs', () => {
  test('reference values (hand-computed from the binomial distribution)', () => {
    assert.equal(mcnemarExact(0, 0), 1, 'no discordant pairs: no evidence of a difference');
    assert.equal(mcnemarExact(1, 0), 1, '2 · P(X ≤ 0 | n=1) = 1');
    assert.equal(mcnemarExact(0, 5), 0.0625, '2 · 0.5^5');
    assert.equal(mcnemarExact(2, 8), 112 / 1024, '2 · (1 + 10 + 45) / 1024');
    assert.equal(mcnemarExact(3, 3), 1, 'balanced ⇒ capped at 1');
    assert.equal(mcnemarExact(0, 10), 2 / 1024);
    assert.equal(mcnemarExact(3, 0), 0.25);
  });

  test('symmetric in b and c; smaller for more lopsided splits', () => {
    assert.equal(mcnemarExact(2, 9), mcnemarExact(9, 2));
    assert.ok(mcnemarExact(1, 9) < mcnemarExact(2, 8));
    assert.ok(mcnemarExact(2, 8) < mcnemarExact(4, 6));
  });

  test('stable for large counts (log space): finite, within (0, 1], continuous with the exact branch', () => {
    const p = mcnemarExact(1000, 1100);
    assert.ok(Number.isFinite(p) && p > 0 && p < 1, String(p));
    // n = 1000 (exact branch) vs n = 1001 (log branch): neighbouring values agree closely
    assert.ok(Math.abs(mcnemarExact(480, 520) - mcnemarExact(480, 521)) < 0.02);
    assert.ok(mcnemarExact(480, 521) < mcnemarExact(480, 520));
    assert.ok(Math.abs(mcnemarExact(5000, 5000) - 1) < 1e-9);
    assert.equal(mcnemarExact(0, 5000), 0, 'underflows to 0, never NaN');
  });

  test('very large counts neither overflow the call stack nor lose accuracy (log-sum-exp without an array spread)', () => {
    // 200 001 terms: a Math.max(...terms) spread threw RangeError (maximum call stack size exceeded)
    assert.equal(mcnemarExact(200_000, 200_000), 1, 'balanced: 2 · P(X ≤ n/2) > 1 ⇒ capped at 1');
    // reference: normal approximation with continuity correction, z = (|b − c| − 1) / √(b + c) = 1999 / √200000 ≈ 4.47 ⇒ p ≈ 7.8e-6
    const p = mcnemarExact(99_000, 101_000);
    assert.ok(p > 7e-6 && p < 8.6e-6, String(p));
    assert.equal(mcnemarExact(101_000, 99_000), p, 'symmetric');
  });

  test('rejects negative, fractional and non-numeric counts', () => {
    for (const [b, c] of [[-1, 2], [1.5, 2], [1, Number.NaN], [Number.POSITIVE_INFINITY, 1]] as const) assert.throws(() => mcnemarExact(b, c), invalid);
  });
});

describe('mulberry32 / seedFrom / seededShuffle', () => {
  test('the same seed yields the same sequence; values in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    assert.deepEqual(xs, Array.from({ length: 1000 }, () => b()));
    assert.ok(xs.every((x) => x >= 0 && x < 1));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean}`);
    assert.notDeepEqual(Array.from({ length: 5 }, mulberry32(1)), Array.from({ length: 5 }, mulberry32(2)));
  });

  test('string seeds hash deterministically (FNV-1a) and differ by content', () => {
    assert.equal(seedFrom('suite@1/task#0'), seedFrom('suite@1/task#0'));
    assert.notEqual(seedFrom('suite@1/task#0'), seedFrom('suite@1/task#1'));
    assert.equal(seedFrom(''), 0x811c9dc5);
    assert.equal(seedFrom(7.9), 7);
    assert.throws(() => seedFrom(Number.NaN), invalid);
  });

  test('seeded shuffle is a deterministic permutation and leaves the input untouched', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const s1 = seededShuffle(items, 'x');
    assert.deepEqual(s1, seededShuffle(items, 'x'));
    assert.deepEqual([...s1].sort(), items);
    assert.deepEqual(items, ['a', 'b', 'c', 'd', 'e']);
    const orders = new Set(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'].map((seed) => seededShuffle(items, seed).join('')));
    assert.ok(orders.size > 1, 'different seeds give different orders');
  });
});

describe('pairedBootstrapCI', () => {
  test('deterministic for a seed; the percentile interval brackets the observed mean', () => {
    const diffs = [1, 0, 1, 1, 0, -1, 1, 0, 1, 1];
    const a = pairedBootstrapCI(diffs, { seed: 'cmp', iterations: 2000 });
    assert.deepEqual(a, pairedBootstrapCI(diffs, { seed: 'cmp', iterations: 2000 }));
    assert.equal(a.mean, 0.5);
    assert.ok(a.lo <= a.mean && a.mean <= a.hi, JSON.stringify(a));
    assert.ok(a.lo >= -1 && a.hi <= 1);
    assert.ok(a.lo > 0, `a clear improvement excludes 0: ${JSON.stringify(a)}`);
    const b = pairedBootstrapCI(diffs, { seed: 'other', iterations: 2000 });
    assert.equal(b.mean, a.mean);
  });

  test('constant differences give a degenerate interval; a wider alpha narrows it', () => {
    assert.deepEqual(pairedBootstrapCI([2, 2, 2], { seed: 1 }), { mean: 2, lo: 2, hi: 2 });
    const diffs = [3, -1, 0, 2, 5, -4, 1, 0];
    const wide = pairedBootstrapCI(diffs, { alpha: 0.01, seed: 3 });
    const narrow = pairedBootstrapCI(diffs, { alpha: 0.5, seed: 3 });
    assert.ok(narrow.hi - narrow.lo < wide.hi - wide.lo);
  });

  test('defaults: 2000 iterations, alpha 0.05, seed 1', () => {
    const diffs = [0.3, -0.2, 0.9, 0.1];
    assert.deepEqual(pairedBootstrapCI(diffs), pairedBootstrapCI(diffs, { iterations: 2000, alpha: 0.05, seed: 1 }));
  });

  test('rejects empty input, non-finite differences and bad options', () => {
    assert.throws(() => pairedBootstrapCI([]), invalid);
    assert.throws(() => pairedBootstrapCI([1, Number.NaN]), invalid);
    assert.throws(() => pairedBootstrapCI([1], { iterations: 0 }), invalid);
    assert.throws(() => pairedBootstrapCI([1], { alpha: 1 }), invalid);
    assert.throws(() => pairedBootstrapCI([1], { alpha: 0 }), invalid);
  });
});

describe('passAtK / passHatK (unbiased estimators over n trials)', () => {
  const t = true;
  const f = false;
  test('k = 1 is the pass rate for both', () => {
    assert.equal(passAtK([t, f, f, t, f], 1), 0.4);
    assert.equal(passHatK([t, f, f, t, f], 1), 0.4);
  });

  test('k = n: pass@n = any passed, pass^n = all passed', () => {
    assert.equal(passAtK([t, f, f, f, f], 5), 1);
    assert.equal(passAtK([f, f, f], 3), 0);
    assert.equal(passHatK([t, t, t, t, f], 5), 0);
    assert.equal(passHatK([t, t, t], 3), 1);
  });

  test('intermediate k: combinatorial values', () => {
    // n = 3, c = 2, k = 2: pass@2 = 1 − C(1,2)/C(3,2) = 1; pass^2 = C(2,2)/C(3,2) = 1/3
    assert.equal(passAtK([t, t, f], 2), 1);
    assert.ok(Math.abs(passHatK([t, t, f], 2) - 1 / 3) < 1e-12);
    // n = 5, c = 3, k = 2: pass^2 = C(3,2)/C(5,2) = 3/10; pass@2 = 1 − C(2,2)/C(5,2) = 0.9
    assert.ok(Math.abs(passHatK([t, t, t, f, f], 2) - 0.3) < 1e-12);
    assert.ok(Math.abs(passAtK([t, t, t, f, f], 2) - 0.9) < 1e-12);
  });

  test('large n stays finite and exact (the ratio is a product of factors in [0, 1]; C(2000, 1000) alone overflows)', () => {
    const all = Array.from({ length: 2000 }, () => t);
    assert.equal(passHatK(all, 1000), 1, 'every trial passed ⇒ pass^k = 1 (was NaN = ∞/∞)');
    assert.equal(passAtK(all.map(() => f), 1000), 0, 'no trial passed ⇒ pass@k = 0 (was NaN)');
    // one failure among 2000: pass^1000 = C(1999, 1000) / C(2000, 1000) = 1000 / 2000 exactly
    const oneFail = [...all.slice(1), f];
    assert.ok(Math.abs(passHatK(oneFail, 1000) - 0.5) < 1e-9, String(passHatK(oneFail, 1000)));
    assert.ok(Math.abs(passAtK(oneFail, 1000) - 1) < 1e-12);
    const mixed = Array.from({ length: 2000 }, (_, i) => i % 4 !== 0); // c = 1500
    for (const v of [passHatK(mixed, 1000), passAtK(mixed, 1000)]) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, String(v));
  });

  test('k outside [1, n] and non-boolean results are refused', () => {
    assert.throws(() => passAtK([t, f], 3), invalid);
    assert.throws(() => passHatK([t, f], 0), invalid);
    assert.throws(() => passHatK([], 1), invalid);
    assert.throws(() => passAtK([1 as unknown as boolean], 1), invalid);
  });
});
