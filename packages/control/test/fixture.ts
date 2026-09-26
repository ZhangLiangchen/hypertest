import { createGitRepo } from '@hypertest/testkit';
import type { EventContext } from '@hypertest/domain';
import type { Harness } from './harness.ts';

export const PRICING_OK = `export function applyDiscount(priceCents, percent) {
  return Math.round((priceCents * (100 - percent)) / 100);
}
`;

/** The seeded regression: the discount is applied twice. */
export const PRICING_BUG = `export function applyDiscount(priceCents, percent) {
  return Math.round((priceCents * (100 - percent * 2)) / 100);
}
`;

export const PRICING_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/pricing.js';

test('applies a 10% discount', () => {
  assert.equal(applyDiscount(1000, 10), 900);
});

test('zero discount keeps the price', () => {
  assert.equal(applyDiscount(1000, 0), 1000);
});
`;

/** A git repo whose HEAD carries the seeded regression; commits[0] is the known-good base. */
export async function pricingRepo(): Promise<{ path: string; base: string; head: string; cleanup(): Promise<void> }> {
  const repo = await createGitRepo(
    { 'package.json': '{ "name": "shop", "type": "module", "private": true }\n', 'src/pricing.js': PRICING_OK, 'test/pricing.test.js': PRICING_TEST },
    [{ message: 'faster discount computation', files: { 'src/pricing.js': PRICING_BUG } }],
  );
  return { path: repo.path, base: repo.commits[0]!, head: repo.commits[1]!, cleanup: repo.cleanup };
}

/** Establishes the (human-approved) pricing oracle: its critical assertion is the 10% discount test outcome. */
export async function pricingOracle(h: Harness): Promise<string> {
  const ctx: EventContext = { runId: 'oracle-setup', correlationId: 'oracle-setup', actorId: 'human:qa-lead' };
  const spec = await h.deps.oracles.establish(
    {
      oracleId: 'oracle.pricing',
      scope: { components: ['pricing'], description: 'Discounts reduce the price by exactly the percentage (REQ-7).' },
      assertions: [
        {
          assertionId: 'discount-10',
          description: 'a 10% discount on 1000 cents yields 900 cents',
          kind: 'deterministic_invariant',
          severity: 'P1',
          check: { type: 'test_outcome', testSelector: '*applies a 10% discount*', expected: 'pass' },
        },
      ],
      authorities: [{ sourceRef: 'REQ-7', authority: 'approved_requirement' }],
      judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: true },
      changePolicy: { agentMayPropose: true, selfApprove: false, invalidatesPriorDecisions: true, approvers: ['human'] },
    },
    { kind: 'human', id: 'qa-lead' },
    ctx,
  );
  return spec.oracleId;
}
