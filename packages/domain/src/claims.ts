import type { JsonValue } from '@hypertest/core';
import type { EvidenceRecord, ReportClaim } from './evidence.ts';

/**
 * (additive, area-C-0) Deterministic evaluation of a report claim against its evidence ("Claim: avg_tps = 103215 /
 * Evidence / Query … then it can be verified automatically", technology-selection §Evidence Store). Pure: shared by the
 * evidence package (`resolveClaim`, what `evidence.claim` accepts) and the QualityGate (criterion C9), so a claim is judged
 * the same way when it is recorded and when a verdict rests on it.
 *
 * Values: `evidenceQuery.field` (a dot path, numeric segments index arrays) is read from every referenced record's
 * `structured` payload, else from `data` (the parsed JSON artifact of that record, when the caller could load it). A
 * number array contributes its elements. `evidenceQuery.aggregation` reduces them: `value` (default: every value must be
 * the same, within the tolerance for numbers), `count`, `sum`, `avg`, `min`, `max`, `first`, `last`, or a nearest-rank
 * percentile `p50` / `p90` / `p95` / `p99` (numbers only). The result is compared with `claim.value`: strings, booleans and
 * structured values exactly (canonical JSON), numbers within CLAIM_RELATIVE_TOLERANCE (a numeric string claim is compared
 * as its number). A claim without a value is a reference claim (it asserts only that the evidence exists and matches the
 * query).
 */

/** Relative tolerance of numeric claims: |actual − claimed| ≤ 0.5 % of max(|actual|, |claimed|) (rounding in a statement). */
export const CLAIM_RELATIVE_TOLERANCE = 0.005;

export const CLAIM_AGGREGATIONS = ['value', 'count', 'sum', 'avg', 'min', 'max', 'first', 'last', 'p50', 'p90', 'p95', 'p99'] as const;
export type ClaimAggregation = (typeof CLAIM_AGGREGATIONS)[number];

export type ClaimEvaluation =
  /** No value to compare: the claim only references its evidence. */
  | { status: 'reference'; detail: string }
  | { status: 'match'; actual: JsonValue; detail: string }
  /** The evidence contradicts the claimed value (a violated claim). */
  | { status: 'mismatch'; actual: JsonValue; detail: string }
  /** The claim cannot be evaluated from its evidence (unknown, never supported). */
  | { status: 'unevaluable'; detail: string };

function fieldAt(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let cur: JsonValue | undefined = value;
  for (const segment of path.split('.')) {
    if (segment === '') return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(segment)) return undefined;
      cur = cur[Number(segment)];
    } else if (cur !== null && cur !== undefined && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, segment)) return undefined;
      cur = (cur as Record<string, JsonValue>)[segment];
    } else return undefined;
  }
  return cur;
}

function canonical(v: JsonValue): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, JsonValue>)[k]!)}`).join(',')}}`;
}

export function numbersClose(a: number, b: number, tolerance = CLAIM_RELATIVE_TOLERANCE): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b));
}

function percentile(sorted: number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

function aggregate(values: JsonValue[], aggregation: string): { ok: true; value: JsonValue } | { ok: false; detail: string } {
  if (aggregation === 'count') return { ok: true, value: values.length };
  if (values.length === 0) return { ok: false, detail: 'no values to aggregate' };
  if (aggregation === 'first') return { ok: true, value: values[0]! };
  if (aggregation === 'last') return { ok: true, value: values[values.length - 1]! };
  if (aggregation === 'value') {
    const first = values[0]!;
    const same = values.every((v) => (typeof v === 'number' && typeof first === 'number' ? numbersClose(v, first) : canonical(v) === canonical(first)));
    return same ? { ok: true, value: first } : { ok: false, detail: `the referenced records disagree (${values.slice(0, 5).map((v) => canonical(v)).join(', ')}); name an aggregation` };
  }
  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return { ok: false, detail: `aggregation ${aggregation} needs numbers` };
  const nums = values as number[];
  switch (aggregation) {
    case 'sum': return { ok: true, value: nums.reduce((s, x) => s + x, 0) };
    case 'avg': return { ok: true, value: nums.reduce((s, x) => s + x, 0) / nums.length };
    case 'min': return { ok: true, value: Math.min(...nums) };
    case 'max': return { ok: true, value: Math.max(...nums) };
    case 'p50': case 'p90': case 'p95': case 'p99': {
      const sorted = [...nums].sort((a, b) => a - b);
      return { ok: true, value: percentile(sorted, Number(aggregation.slice(1))) };
    }
    default: return { ok: false, detail: `unknown aggregation ${aggregation} (one of ${CLAIM_AGGREGATIONS.join(', ')})` };
  }
}

/** Evaluates `claim` against `records` (the referenced evidence, in any order; matched by `claim.evidenceRefs`). */
export function evaluateClaim(
  claim: Pick<ReportClaim, 'value' | 'evidenceQuery' | 'evidenceRefs'>,
  records: ReadonlyArray<Pick<EvidenceRecord, 'evidenceId' | 'structured'>>,
  data?: ReadonlyMap<string, JsonValue>,
): ClaimEvaluation {
  if (claim.value === undefined) return { status: 'reference', detail: 'reference claim (no value to compare)' };
  const q = claim.evidenceQuery ?? {};
  if (typeof q.field !== 'string' || q.field === '') return { status: 'unevaluable', detail: 'the claim states a value but its evidenceQuery names no field to evaluate' };
  const aggregation = q.aggregation ?? 'value';
  if (!(CLAIM_AGGREGATIONS as readonly string[]).includes(aggregation)) return { status: 'unevaluable', detail: `unknown aggregation ${aggregation} (one of ${CLAIM_AGGREGATIONS.join(', ')})` };
  const byId = new Map(records.map((r) => [r.evidenceId, r]));
  const values: JsonValue[] = [];
  for (const ref of [...new Set(claim.evidenceRefs)]) {
    const r = byId.get(ref);
    if (!r) return { status: 'unevaluable', detail: `evidence ${ref} is not available to evaluate the claim` };
    let v = fieldAt(r.structured, q.field);
    if (v === undefined && data?.has(ref)) v = fieldAt(data.get(ref), q.field);
    if (v === undefined || v === null) return { status: 'unevaluable', detail: `evidence ${ref} has no value at ${q.field}` };
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number')) values.push(...v);
    else values.push(v);
  }
  const agg = aggregate(values, aggregation);
  if (!agg.ok) return { status: 'unevaluable', detail: `${q.field} (${aggregation}): ${agg.detail}` };
  const actual = agg.value;
  const claimed = claim.value;
  const what = `${aggregation} of ${q.field} over ${values.length} value(s) = ${canonical(actual)}`;
  if (typeof actual === 'number') {
    const n = typeof claimed === 'number' ? claimed : typeof claimed === 'string' && claimed.trim() !== '' && Number.isFinite(Number(claimed)) ? Number(claimed) : undefined;
    if (n === undefined) return { status: 'mismatch', actual, detail: `claimed ${canonical(claimed)} is not a number; ${what}` };
    return numbersClose(actual, n)
      ? { status: 'match', actual, detail: `${what} matches the claimed ${n} (tolerance ${CLAIM_RELATIVE_TOLERANCE * 100}%)` }
      : { status: 'mismatch', actual, detail: `claimed ${n} but ${what} (tolerance ${CLAIM_RELATIVE_TOLERANCE * 100}%)` };
  }
  return canonical(actual) === canonical(claimed)
    ? { status: 'match', actual, detail: `${what} matches the claimed value` }
    : { status: 'mismatch', actual, detail: `claimed ${canonical(claimed)} but ${what}` };
}
