import { CLASSIFICATION_ORDER, type BlackboardRecord, type DataClassification } from '@hypertest/domain';
import type { RoleCatalogLike } from '@hypertest/agents';
import type { AgentRepository } from '@hypertest/runtime';

/**
 * Data-classification clearance between agents (privacy boundary of the `local_private` role and any role configured
 * with a stricter `dataClassification`). A role's classification is both what its tools' evidence is recorded as and
 * the clearance it reads with: data classified above a reader's clearance is withheld from it (ids stay visible, content
 * does not), so restricted material never reaches a prompt that a lower-clearance (e.g. cloud) route may receive.
 */
export function roleClassification(roles: RoleCatalogLike, role: string | undefined): DataClassification {
  return (role !== undefined ? roles.get(role)?.dataClassification : undefined) ?? 'internal';
}

export function cleared(reader: DataClassification, data: DataClassification | undefined): boolean {
  return CLASSIFICATION_ORDER[data ?? 'internal'] <= CLASSIFICATION_ORDER[reader];
}

export function withheldNote(data: DataClassification): string {
  return `[withheld: ${data} data above this agent's clearance]`;
}

/** The summary of a work result produced by `producerRole`, as a reader of `readerRole` may see it. */
export function summaryFor(roles: RoleCatalogLike, readerRole: string | undefined, producerRole: string | undefined, summary: string): string {
  const data = roleClassification(roles, producerRole);
  return cleared(roleClassification(roles, readerRole), data) ? summary : withheldNote(data);
}

/** Classification of a blackboard record: that of the role of the agent that wrote it (system actors: internal). */
export async function recordClassification(agents: Pick<AgentRepository, 'get'>, roles: RoleCatalogLike, record: Pick<BlackboardRecord<unknown>, 'createdBy'>, cache?: Map<string, DataClassification>): Promise<DataClassification> {
  const hit = cache?.get(record.createdBy);
  if (hit !== undefined) return hit;
  const agent = record.createdBy.startsWith('ag_') ? await agents.get(record.createdBy) : undefined;
  const cls = roleClassification(roles, agent?.role);
  cache?.set(record.createdBy, cls);
  return cls;
}
