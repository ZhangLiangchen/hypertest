/**
 * (coverage[15]) Eval tiers (architecture-improvements §Trial 设计): which suite, how many trials per task and arm, and the
 * trial mode, per use. The design's task counts are budget-bound starting values; the tiers here are what this
 * repository's suites provide and grow with them:
 *
 * | tier               | suite              | trials | mode           | use                                   |
 * |--------------------|--------------------|-------:|----------------|---------------------------------------|
 * | `pr-smoke`         | `pr-smoke`         |      1 | in-process     | every runtime change (fast subset)     |
 * | `release-core`     | `core`             |      5 | in-process     | runtime / model release (release gate) |
 * | `deep`             | `deep`             |      5 | in-process     | monthly / major architecture change    |
 * | `failure-recovery` | `failure-recovery` |     10 | child-process  | durable / safety release (real SIGKILL) |
 *
 * `hypertest eval run --tier <tier>` selects suite, trials and mode (an explicit suite, --trials or --mode overrides).
 */
import { HypertestError } from '@hypertest/core';
import type { EvalTier } from './contracts.ts';

export interface TierSpec {
  tier: EvalTier;
  /** The suite id the tier runs. */
  suiteId: string;
  trials: number;
  mode: 'in-process' | 'child-process';
  description: string;
}

export const EVAL_TIERS: Readonly<Record<EvalTier, TierSpec>> = Object.freeze({
  'pr-smoke': { tier: 'pr-smoke', suiteId: 'pr-smoke', trials: 1, mode: 'in-process', description: 'fast subset of the core suites, one trial (every runtime change)' },
  'release-core': { tier: 'release-core', suiteId: 'core', trials: 5, mode: 'in-process', description: 'every core task × 5 trials (runtime/model release; the release gate suite)' },
  deep: { tier: 'deep', suiteId: 'deep', trials: 5, mode: 'in-process', description: 'every PoC and core task × 5 trials (monthly / major change)' },
  'failure-recovery': { tier: 'failure-recovery', suiteId: 'failure-recovery', trials: 10, mode: 'child-process', description: 'recovery and chaos scenarios × 10 trials with real SIGKILLs (durable/safety release)' },
} as const);

export const EVAL_TIER_IDS = Object.freeze(Object.keys(EVAL_TIERS) as EvalTier[]);

export function tierSpec(tier: string): TierSpec {
  if (!Object.hasOwn(EVAL_TIERS, tier)) throw new HypertestError('invalid_argument', `unknown eval tier ${JSON.stringify(tier)} (${EVAL_TIER_IDS.join(', ')})`);
  return EVAL_TIERS[tier as EvalTier];
}
