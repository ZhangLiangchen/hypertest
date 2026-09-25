import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_ROLES, RoleCatalog, matchesSubscription, matchesSubscriptionFilter, type SubscriptionSubject } from '../src/index.ts';

const catalog = new RoleCatalog(BUILTIN_ROLES);

/** Roles whose subscriptions a subject wakes (the reactor routing table implied by the catalog). */
function woken(subject: SubscriptionSubject): string[] {
  return catalog.subscriptions().filter((s) => matchesSubscription(s, subject)).map((s) => s.role);
}

test('routing: a P1 product defect wakes the test designer and RCA without the lead', () => {
  assert.deepEqual(woken({ eventType: 'finding.created', severity: 'P1', category: 'product_defect', actorRole: 'executor' }), ['test_designer', 'rca']);
});

test('routing: a P2 performance finding also wakes the metrics analyst', () => {
  assert.deepEqual(woken({ eventType: 'finding.created', severity: 'P2', category: 'performance' }), ['test_designer', 'rca', 'metrics_analyst']);
});

test('routing: below-threshold or non-product findings wake no one', () => {
  assert.deepEqual(woken({ eventType: 'finding.created', severity: 'P3', category: 'product_defect' }), []);
  assert.deepEqual(woken({ eventType: 'finding.created', severity: 'P0', category: 'test_defect' }), []);
  assert.deepEqual(woken({ eventType: 'finding.created', severity: 'P0', category: 'infrastructure' }), []);
});

test('routing: unknown-category findings go to RCA only; security to test designer and RCA', () => {
  assert.deepEqual(woken({ eventType: 'finding.created', severity: 'P1', category: 'unknown' }), ['rca']);
  assert.deepEqual(woken({ eventType: 'finding.created', severity: 'P0', category: 'security' }), ['test_designer', 'rca']);
});

test('routing: confirmed P0/P1 findings get independent verification; P2 does not', () => {
  assert.deepEqual(woken({ eventType: 'finding.confirmed', severity: 'P0', category: 'product_defect' }), ['reviewer']);
  assert.deepEqual(woken({ eventType: 'finding.confirmed', severity: 'P1', category: 'performance' }), ['reviewer']);
  assert.deepEqual(woken({ eventType: 'finding.confirmed', severity: 'P2', category: 'product_defect' }), []);
});

test('routing: review requests and coverage gaps', () => {
  assert.deepEqual(woken({ eventType: 'review.requested' }), ['reviewer']);
  assert.deepEqual(woken({ eventType: 'coverage.gap_detected', recordType: 'coverage_gap' }), ['test_designer']);
  assert.deepEqual(woken({ eventType: 'finding.updated', severity: 'P0', category: 'product_defect' }), [], 'updates do not re-trigger');
});

test('matchesSubscription requires the event type', () => {
  assert.equal(matchesSubscription({ eventTypes: ['a.b'] }, { eventType: 'a.b' }), true);
  assert.equal(matchesSubscription({ eventTypes: ['a.b'] }, { eventType: 'a.c' }), false);
});

test('filter: minSeverity is inclusive and fails closed on missing or invalid severities', () => {
  const f = { minSeverity: 'P2' as const };
  assert.equal(matchesSubscriptionFilter(f, { severity: 'P0' }), true);
  assert.equal(matchesSubscriptionFilter(f, { severity: 'P2' }), true);
  assert.equal(matchesSubscriptionFilter(f, { severity: 'P3' }), false);
  assert.equal(matchesSubscriptionFilter(f, {}), false);
  assert.equal(matchesSubscriptionFilter(f, { severity: 'P9' }), false);
  assert.equal(matchesSubscriptionFilter(f, { severity: 'toString' }), false);
  assert.equal(matchesSubscriptionFilter({ minSeverity: 'critical' as never }, { severity: 'P0' }), false, 'invalid filter never matches');
});

test('filter: list constraints are AND-ed and fail closed on missing fields or empty lists', () => {
  const f = { categories: ['security' as const], statuses: ['open'], recordTypes: ['finding'], fromRoles: ['executor'] };
  const full = { category: 'security', status: 'open', recordType: 'finding', actorRole: 'executor' };
  assert.equal(matchesSubscriptionFilter(f, full), true);
  for (const key of Object.keys(full) as Array<keyof typeof full>) {
    const { [key]: _drop, ...partial } = full;
    assert.equal(matchesSubscriptionFilter(f, partial), false, `missing ${key}`);
    assert.equal(matchesSubscriptionFilter(f, { ...full, [key]: 'other' }), false, `wrong ${key}`);
  }
  assert.equal(matchesSubscriptionFilter({ categories: [] }, { category: 'security' }), false);
  assert.equal(matchesSubscriptionFilter(undefined, {}), true);
  assert.equal(matchesSubscriptionFilter({}, {}), true);
});

test('routing: the metrics analyst is not woken by its own performance findings (self-trigger guard)', () => {
  assert.deepEqual(woken({ eventType: 'finding.created', severity: 'P2', category: 'performance', actorRole: 'metrics_analyst' }), ['test_designer', 'rca']);
  assert.deepEqual(woken({ eventType: 'finding.created', severity: 'P2', category: 'performance', actorRole: 'executor' }), ['test_designer', 'rca', 'metrics_analyst']);
});

test('filter: excludeFromRoles rejects listed actors and does not require an actor role', () => {
  const f = { excludeFromRoles: ['rca'] };
  assert.equal(matchesSubscriptionFilter(f, { actorRole: 'rca' }), false);
  assert.equal(matchesSubscriptionFilter(f, { actorRole: 'executor' }), true);
  assert.equal(matchesSubscriptionFilter(f, {}), true, 'unknown actor: not excluded (fromRoles is the fail-closed constraint)');
  assert.equal(matchesSubscriptionFilter({ ...f, categories: ['security'] }, { actorRole: 'executor', category: 'performance' }), false, 'still AND-ed');
});
