import { HypertestError, noopLogger, throwIfAborted, type Logger } from '@hypertest/core';
import type { RetrievalHit, RetrievalQuery, Retriever } from '../contracts.ts';
import { resolveLimit } from '../util.ts';

/** Dedupe key of a hit: ref kind:id plus the line when present. */
export function hitKey(hit: RetrievalHit): string {
  return `${hit.ref.kind}:${hit.ref.id}${hit.line !== undefined ? `:${hit.line}` : ''}`;
}

/**
 * Reciprocal-rank fusion over child retrievers: score(d) = Σ_children 1/(k + rank_child(d)), rank 1-based in each
 * child's own ordering. Hits are deduplicated by ref kind:id(+line); the representative hit is the first one
 * seen (children order, then rank). Ties keep first-seen order, so the result is stable. A failing child is
 * logged and skipped; if every child fails the first error is thrown.
 */
export class HybridRetriever implements Retriever {
  readonly name = 'hybrid';
  readonly #children: readonly Retriever[];
  readonly #k: number;
  readonly #logger: Logger;

  constructor(children: Retriever[], options: { k?: number; logger?: Logger } = {}) {
    if (!Array.isArray(children) || children.length === 0) throw new HypertestError('invalid_argument', 'HybridRetriever needs at least one child retriever');
    const k = options.k ?? 60;
    if (!Number.isFinite(k) || k < 0) throw new HypertestError('invalid_argument', 'k must be a number ≥ 0');
    this.#children = [...children];
    this.#k = k;
    this.#logger = options.logger ?? noopLogger;
  }

  async search(query: RetrievalQuery, signal?: AbortSignal): Promise<RetrievalHit[]> {
    throwIfAborted(signal);
    const limit = resolveLimit(query.limit, 20, 'query.limit');
    const results = await Promise.allSettled(this.#children.map((c) => c.search(query, signal)));
    throwIfAborted(signal);
    const fused = new Map<string, { hit: RetrievalHit; score: number; order: number }>();
    let order = 0;
    let failures = 0;
    let firstError: unknown;
    results.forEach((r, ci) => {
      if (r.status === 'rejected') {
        failures++;
        firstError ??= r.reason;
        this.#logger.warn('retriever failed; fusing the others', { retriever: this.#children[ci]!.name, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
        return;
      }
      const seenInChild = new Set<string>();
      let rank = 0;
      for (const hit of r.value) {
        const key = hitKey(hit);
        if (seenInChild.has(key)) continue; // a child's duplicate does not vote twice
        seenInChild.add(key);
        rank++;
        const add = 1 / (this.#k + rank);
        const prev = fused.get(key);
        if (prev) prev.score += add;
        else fused.set(key, { hit, score: add, order: order++ });
      }
    });
    if (failures === this.#children.length) throw firstError;
    return [...fused.values()]
      // Equal fused scores can differ in the last float bits depending on summation order: treat as ties.
      .sort((a, b) => (Math.abs(b.score - a.score) > 1e-12 ? b.score - a.score : a.order - b.order))
      .slice(0, limit)
      .map((f) => ({ ...f.hit, score: f.score }));
  }
}
