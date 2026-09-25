import { SEVERITY_ORDER, atLeastAsSevere, type Severity } from '@hypertest/domain';
import type { RoleSubscription, SubscriptionFilter, SubscriptionSubject } from './contracts.ts';

function isSeverity(v: unknown): v is Severity {
  return typeof v === 'string' && Object.hasOwn(SEVERITY_ORDER, v);
}

function inList(list: readonly string[] | undefined, value: string | undefined): boolean {
  if (list === undefined) return true;
  // Fail closed: an empty list or a subject without the constrained field never matches.
  return value !== undefined && list.includes(value);
}

/**
 * True when every constraint of the filter holds for the subject (AND; missing fields fail closed).
 * `excludeFromRoles` rejects subjects produced by those roles; a subject without an actor role is not excluded.
 */
export function matchesSubscriptionFilter(filter: SubscriptionFilter | undefined, subject: Omit<SubscriptionSubject, 'eventType'>): boolean {
  if (filter === undefined) return true;
  if (filter.excludeFromRoles !== undefined && subject.actorRole !== undefined && filter.excludeFromRoles.includes(subject.actorRole)) return false;
  if (filter.minSeverity !== undefined) {
    if (!isSeverity(filter.minSeverity) || !isSeverity(subject.severity)) return false;
    if (!atLeastAsSevere(subject.severity, filter.minSeverity)) return false;
  }
  return (
    inList(filter.categories, subject.category) &&
    inList(filter.statuses, subject.status) &&
    inList(filter.recordTypes, subject.recordType) &&
    inList(filter.fromRoles, subject.actorRole)
  );
}

/** True when the subscription listens to the subject's event type and its filter matches. */
export function matchesSubscription(sub: Pick<RoleSubscription, 'eventTypes' | 'filter'>, subject: SubscriptionSubject): boolean {
  return sub.eventTypes.includes(subject.eventType) && matchesSubscriptionFilter(sub.filter, subject);
}
