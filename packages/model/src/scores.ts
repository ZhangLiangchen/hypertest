import { HypertestError, canonicalJson, sha256Hex } from '@hypertest/core';

/**
 * (coverage[7]) Routing-eval feedback: eval trial outcomes become per-route, per-role quality scores that the router's
 * quality stage uses (ModelCatalog.withScores) — through an explicit, auditable file:
 *
 *   hypertest eval apply-scores <suite-result.json> --out <scores.json>    (deriveRouteScores → a RouteScoresFile)
 *   models.scoresFile: <scores.json>                                      (createHypertest merges it into the catalog)
 *
 * The merged catalog has a new revision, so the RuntimeManifest (modelCatalogRevision + modelScores {digest, source})
 * changes with it: a run is pinned to the scores it was routed with (I11), never re-scored mid-run.
 *
 * Method (deterministic): for every (route, role) pair that served a trial (≥ 1 successful call on the route by agents
 * of the role), n = graded trials (pass | fail; infra errors excluded) and k = passing trials; score = (k + 1) / (n + 2)
 * (Laplace smoothing: no evidence ⇒ 0.5, never 0 or 1 from few trials), rounded to 3 decimals, kept only when
 * n ≥ minTrials (default 3).
 */
export interface RouteScoresFile {
  version: 1;
  /** routeId → (role | taskType | 'default') → score in [0, 1]. */
  scores: Record<string, Record<string, number>>;
  /** Provenance (audit): what the scores were derived from. */
  source?: {
    suiteId?: string;
    revision?: string;
    /** sha256 of the canonical JSON of the eval result the scores were derived from. */
    inputDigest?: string;
    trials?: number;
    method?: string;
    derivedAt?: string;
  };
}

/** The part of an eval trial the derivation reads (structurally an @hypertest/eval EvalTrial). */
export interface ScoredTrial {
  result: 'pass' | 'fail' | 'infra_error' | (string & {});
  modelRoutes?: Array<{ role: string; routeId: string; calls: number }>;
}

export const ROUTE_SCORES_METHOD = 'laplace: (passes + 1) / (trials + 2) per (route, role) over graded trials';

/** Derives a RouteScoresFile from eval trials (see the method above). */
export function deriveRouteScores(
  input: { suiteId?: string; revision?: string; trials: readonly ScoredTrial[] },
  options: { minTrials?: number; derivedAt?: string } = {},
): RouteScoresFile {
  if (!input || !Array.isArray(input.trials)) throw new HypertestError('invalid_argument', 'eval result: `trials` must be an array (a SuiteResult or {trials: EvalTrial[]})');
  const minTrials = options.minTrials ?? 3;
  if (!Number.isSafeInteger(minTrials) || minTrials < 1) throw new HypertestError('invalid_argument', `minTrials must be an integer ≥ 1 (got ${String(minTrials)})`);
  const tally = new Map<string, { routeId: string; role: string; n: number; k: number }>();
  let graded = 0;
  for (const t of input.trials) {
    if (t?.result !== 'pass' && t?.result !== 'fail') continue;
    graded++;
    const pairs = new Set<string>();
    for (const r of t.modelRoutes ?? []) {
      if (typeof r?.routeId !== 'string' || typeof r.role !== 'string' || !(typeof r.calls === 'number' && r.calls > 0)) continue;
      pairs.add(JSON.stringify([r.routeId, r.role]));
    }
    for (const key of pairs) {
      const [routeId, role] = JSON.parse(key) as [string, string];
      const e = tally.get(key) ?? { routeId, role, n: 0, k: 0 };
      e.n++;
      if (t.result === 'pass') e.k++;
      tally.set(key, e);
    }
  }
  const scores: Record<string, Record<string, number>> = {};
  for (const e of [...tally.values()].sort((a, b) => (a.routeId + '\0' + a.role < b.routeId + '\0' + b.role ? -1 : 1))) {
    if (e.n < minTrials) continue;
    (scores[e.routeId] ??= {})[e.role] = Math.round(((e.k + 1) / (e.n + 2)) * 1000) / 1000;
  }
  const source: NonNullable<RouteScoresFile['source']> = {
    inputDigest: sha256Hex(canonicalJson(input as never)),
    trials: graded,
    method: `${ROUTE_SCORES_METHOD}; minTrials ${minTrials}`,
  };
  if (input.suiteId !== undefined) source.suiteId = input.suiteId;
  if (input.revision !== undefined) source.revision = input.revision;
  if (options.derivedAt !== undefined) source.derivedAt = options.derivedAt;
  return { version: 1, scores, source };
}

/** Validates a scores file document (throws invalid_argument naming every problem). */
export function parseRouteScoresFile(raw: unknown, where = 'scores file'): RouteScoresFile {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HypertestError('invalid_argument', `${where}: must be a JSON object { version: 1, scores: { <routeId>: { <role>: score } } }`);
  const doc = raw as Record<string, unknown>;
  if (doc['version'] !== 1) problems.push(`version must be 1 (got ${JSON.stringify(doc['version'])})`);
  const scores: Record<string, Record<string, number>> = {};
  const s = doc['scores'];
  if (!s || typeof s !== 'object' || Array.isArray(s)) problems.push('scores must be a mapping of route id to { role: score }');
  else {
    for (const [routeId, byRole] of Object.entries(s as Record<string, unknown>)) {
      if (!byRole || typeof byRole !== 'object' || Array.isArray(byRole)) {
        problems.push(`scores.${routeId} must be a mapping of role/taskType to score`);
        continue;
      }
      for (const [role, v] of Object.entries(byRole as Record<string, unknown>)) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) problems.push(`scores.${routeId}.${role} must be a number in [0, 1]`);
        else (scores[routeId] ??= {})[role] = v;
      }
    }
  }
  if (problems.length > 0) throw new HypertestError('invalid_argument', `${where}: ${problems.join('; ')}`, { details: { problems } });
  const out: RouteScoresFile = { version: 1, scores };
  const src = doc['source'];
  if (src && typeof src === 'object' && !Array.isArray(src)) out.source = src as RouteScoresFile['source'] & object;
  return out;
}
