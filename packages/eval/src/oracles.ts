/**
 * Oracles of an eval task are established by a human authority BEFORE the run (OracleGovernance.establish: agents can
 * never establish or approve them); the run then pins their current revisions (StartRunInput.oracleIds).
 */
import type { ActorRef, EventContext } from '@hypertest/domain';
import type { HypertestInstance } from '@hypertest/app';
import type { EvalOracle } from './contracts.ts';

/** The authority that establishes eval oracles (a human actor: agents cannot establish oracles). */
export const EVAL_ORACLE_AUTHORITY: Readonly<ActorRef> = Object.freeze({ kind: 'human', id: 'eval:oracle-authority' });

/**
 * Establishes the task's oracles in the trial's store (an oracle that already exists — a resumed trial — is kept as it
 * is: it changes only through governed proposals). Returns the oracle ids for StartRunInput.oracleIds.
 */
export async function establishOracles(ht: Pick<HypertestInstance, 'services'>, oracles: readonly EvalOracle[] | undefined, runId: string): Promise<string[]> {
  const ids: string[] = [];
  const ctx: EventContext = { runId: `setup-${runId}`, correlationId: `setup-${runId}`, actorId: `${EVAL_ORACLE_AUTHORITY.kind}:${EVAL_ORACLE_AUTHORITY.id}` };
  for (const spec of oracles ?? []) {
    if (!(await ht.services.specs.getOracle(spec.oracleId))) await ht.services.oracles.establish(spec, { ...EVAL_ORACLE_AUTHORITY }, ctx);
    ids.push(spec.oracleId);
  }
  return ids;
}
