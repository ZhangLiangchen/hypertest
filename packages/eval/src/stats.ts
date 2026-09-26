/**
 * Statistics for paired eval comparisons: exact McNemar (two-sided exact binomial test on the discordant pairs),
 * seeded paired bootstrap confidence intervals, and the pass@k / pass^k reliability estimators.
 *
 * Everything is deterministic: the bootstrap uses the seeded mulberry32 PRNG (a seed string is hashed to 32 bits
 * with FNV-1a), so the same diffs and seed always yield the same interval.
 */
import { HypertestError } from '@hypertest/core';

function invalid(message: string): HypertestError {
  return new HypertestError('invalid_argument', message);
}

function assertCount(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw invalid(`${name} must be a non-negative integer, got ${String(v)}`);
}

/**
 * Exact McNemar test: two-sided exact binomial p-value of the discordant pairs `b` (A pass, B fail) and `c`
 * (A fail, B pass) under H0 p = 0.5: `min(1, 2 · P(X ≤ min(b, c)))`, X ~ Binomial(b + c, 0.5). No discordant pairs ⇒ 1.
 * Exact arithmetic from 2^-n for up to 1000 discordant pairs, log space beyond (stable for large counts).
 */
export function mcnemarExact(b: number, c: number): number {
  assertCount('b', b);
  assertCount('c', c);
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  if (n <= 1000) {
    // linear space from the exact 2^-n: exact for the small counts eval suites produce
    let pmf = 2 ** -n;
    let tail = 0;
    for (let i = 0; i <= k; i++) {
      tail += pmf;
      pmf = (pmf * (n - i)) / (i + 1);
    }
    return Math.min(1, 2 * tail);
  }
  // log space for large counts: log pmf(0) = -n ln 2; pmf(i+1) = pmf(i) · (n - i) / (i + 1). The pmf increases
  // over i ≤ k ≤ n/2, so the last term is the maximum; the sum is accumulated relative to it (log-sum-exp, O(1) memory:
  // no array spread, which overflows the call stack for large k).
  let lp = -n * Math.LN2;
  const lps = new Float64Array(k + 1);
  for (let i = 0; i <= k; i++) {
    lps[i] = lp;
    lp += Math.log(n - i) - Math.log(i + 1);
  }
  let max = Number.NEGATIVE_INFINITY;
  for (const l of lps) if (l > max) max = l;
  let rel = 0;
  for (const l of lps) rel += Math.exp(l - max);
  return Math.min(1, 2 * Math.exp(max) * rel);
}

/** mulberry32: a small, fast, seeded 32-bit PRNG → uniform floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed from a number (its low 32 bits) or a string (FNV-1a over its UTF-16 code units). */
export function seedFrom(seed: number | string): number {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) throw invalid(`seed must be finite, got ${String(seed)}`);
    return Math.trunc(seed) >>> 0;
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic Fisher–Yates shuffle (a copy) with the seeded PRNG. */
export function seededShuffle<T>(items: readonly T[], seed: number | string): T[] {
  const out = [...items];
  const rnd = mulberry32(seedFrom(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Linear-interpolation quantile (type 7) of a sorted array. */
function quantileSorted(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (pos - lo);
}

export interface BootstrapOptions {
  /** Resamples (default 2000). */
  iterations?: number;
  /** Two-sided level: the interval covers 1 − alpha (default 0.05). */
  alpha?: number;
  /** PRNG seed (default 1). */
  seed?: number | string;
}

/**
 * Paired bootstrap CI of the mean of per-pair differences (e.g. armA − armB per task/seed): `iterations` resamples
 * with replacement, percentile interval [alpha/2, 1 − alpha/2] (linear interpolation). `mean` is the observed mean.
 */
export function pairedBootstrapCI(diffs: readonly number[], options: BootstrapOptions = {}): { mean: number; lo: number; hi: number } {
  if (!Array.isArray(diffs) || diffs.length === 0) throw invalid('pairedBootstrapCI needs at least one difference');
  for (const d of diffs) if (typeof d !== 'number' || !Number.isFinite(d)) throw invalid(`differences must be finite numbers, got ${String(d)}`);
  const iterations = options.iterations ?? 2000;
  const alpha = options.alpha ?? 0.05;
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw invalid(`iterations must be a positive integer, got ${String(iterations)}`);
  if (!(typeof alpha === 'number' && alpha > 0 && alpha < 1)) throw invalid(`alpha must be in (0, 1), got ${String(alpha)}`);
  const n = diffs.length;
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const rnd = mulberry32(seedFrom(options.seed ?? 1));
  const means = new Array<number>(iterations);
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rnd() * n)]!;
    means[it] = sum / n;
  }
  means.sort((a, b) => a - b);
  return { mean, lo: quantileSorted(means, alpha / 2), hi: quantileSorted(means, 1 - alpha / 2) };
}

/**
 * C(m, k) / C(n, k) for m ≤ n as the product Π_{i<k} (m − i) / (n − i): every factor is in [0, 1], so the ratio never
 * overflows (the two binomials separately exceed Number.MAX_VALUE for n ≳ 1030 and would give NaN).
 */
function binomialRatio(m: number, n: number, k: number): number {
  if (k > m) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r *= (m - i) / (n - i);
  return r;
}

function checkK(results: readonly boolean[], k: number): void {
  if (!Array.isArray(results) || results.some((r) => typeof r !== 'boolean')) throw invalid('results must be an array of booleans (one per trial)');
  if (!Number.isSafeInteger(k) || k < 1) throw invalid(`k must be a positive integer, got ${String(k)}`);
  if (k > results.length) throw invalid(`k (${k}) exceeds the number of trials (${results.length})`);
}

/**
 * pass@k: probability that at least one of k trials (drawn without replacement from the n observed) passes —
 * the unbiased estimator 1 − C(n − c, k) / C(n, k), c = passing trials.
 */
export function passAtK(results: readonly boolean[], k: number): number {
  checkK(results, k);
  const n = results.length;
  const c = results.filter(Boolean).length;
  return 1 - binomialRatio(n - c, n, k);
}

/**
 * pass^k: probability that ALL k trials (drawn without replacement from the n observed) pass — C(c, k) / C(n, k).
 * With k = n it is 1 exactly when every trial passed.
 */
export function passHatK(results: readonly boolean[], k: number): number {
  checkK(results, k);
  const n = results.length;
  const c = results.filter(Boolean).length;
  return binomialRatio(c, n, k);
}
