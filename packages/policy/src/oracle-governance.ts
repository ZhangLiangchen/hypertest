import { HypertestError, canonicalJson, validateJson } from '@hypertest/core';
import { EVENT_TYPES, ORACLE_ASSERTION_SCHEMA, eventFrom, type ActorRef, type EventContext, type OracleChangeProposal, type OracleSpec } from '@hypertest/domain';
import type { OracleGovernance, OracleGovernanceDeps } from './contracts.ts';
import { ORACLE_AUTHORITY_KINDS } from './gate.ts';
import { KeyedMutex, agentIndependenceViolation } from './independence.ts';

function assertActor(actor: ActorRef, what: string): void {
  if (!actor || typeof actor.id !== 'string' || actor.id.length === 0 || !['agent', 'human', 'system'].includes(actor.kind)) {
    throw new HypertestError('invalid_argument', `${what} must be an ActorRef with kind and id`);
  }
}

function denied(message: string, details: Record<string, unknown> = {}): HypertestError {
  return new HypertestError('permission_denied', message, { details });
}

/**
 * Checks whether `decidedBy` may decide (approve=true: approve; approve=false: reject) the proposal under
 * the oracle's change policy. Returns nothing when eligible; throws permission_denied otherwise.
 *
 * Approval rules (I8):
 *  - never the proposer (self-approval), never a `system` actor;
 *  - a human only when `human` is a listed approver kind;
 *  - an agent only when `independent_agent` is listed and it is independent of the proposer: known model
 *    provider different from the proposer's, known role different from the proposer's (fail closed);
 *  - when the change would flip a recorded failure and humans are approvers, only a human may approve.
 * Rejection keeps the status quo: the proposer may withdraw; others must be eligible approver kinds.
 */
export function assertMayDecide(oracle: OracleSpec, proposal: OracleChangeProposal, decidedBy: ActorRef, approve: boolean): void {
  const approvers = oracle.changePolicy.approvers;
  const proposer = proposal.proposedBy;
  if (!approve && decidedBy.id === proposer.id) return; // withdrawal
  if (!approve && decidedBy.kind === 'system') return; // deterministic services may close stale proposals
  if (approve && decidedBy.id === proposer.id) throw denied(`self-approval is forbidden (${decidedBy.id} proposed ${proposal.proposalId})`, { rule: 'self_approval' });
  if (decidedBy.kind === 'system') throw denied('system actors cannot approve oracle changes', { rule: 'system_approver' });
  if (decidedBy.kind === 'human') {
    if (!approvers.includes('human')) throw denied(`oracle ${oracle.oracleId} does not accept human approvers`, { rule: 'approver_kind' });
    return;
  }
  // agent
  if (!approvers.includes('independent_agent')) throw denied(`oracle ${oracle.oracleId} does not accept agent approvers`, { rule: 'approver_kind' });
  // D-7: approvals are checked against the oracle's authorities — an expert-approved criterion is changed only by a human
  if (approve && (oracle.authorities ?? []).some((a) => a.authority === 'expert_approved')) {
    throw denied(`oracle ${oracle.oracleId} rests on an expert_approved authority; only a human may approve its change`, { rule: 'authority_requires_human' });
  }
  const violation = agentIndependenceViolation(proposer, decidedBy);
  if (violation) throw denied(violation.message, { rule: violation.rule });
  if (approve && proposal.wouldFlipRecordedFailure && approvers.includes('human')) {
    throw denied(`proposal ${proposal.proposalId} would flip a recorded failure; a human approver is required`, { rule: 'flip_requires_human' });
  }
}

/**
 * (D-7) Why an oracle's authorities do not meet the design (empty: they do): at least one authority, each with a non-empty
 * sourceRef and a known kind, and an `expert_approved` authority only with a human approver.
 */
export function authorityProblems(authorities: OracleSpec['authorities'] | undefined, approver?: ActorRef): string[] {
  const out: string[] = [];
  if (!Array.isArray(authorities) || authorities.length === 0) return ['an oracle needs at least one authority (formal_spec, approved_requirement, business_rule, known_good_reference, differential_reference, expert_approved)'];
  for (const a of authorities) {
    if (!a || typeof a.sourceRef !== 'string' || a.sourceRef.trim() === '') out.push('every authority needs a non-empty sourceRef');
    else if (!ORACLE_AUTHORITY_KINDS.has(a.authority)) out.push(`authority ${a.sourceRef}: unknown kind ${String(a.authority)}`);
  }
  if (approver !== undefined && authorities.some((a) => a?.authority === 'expert_approved') && approver.kind !== 'human') out.push('an expert_approved authority must be established by a human');
  return out;
}

/**
 * Oracle governance (I8): oracles are established by authorities (humans/system), changed only through
 * proposals that the proposer can never approve, approved by independent actors, and every approval
 * creates a new revision (history is never rewritten). Decisions based on the superseded revision are
 * marked needs_reassessment when the change policy says so or when the change flips a recorded failure.
 *
 * Concurrency: decisions on one oracle are serialized in-process, and every revision write names the exact
 * revision it creates (`revision: current + 1`), which the store rejects (conflict) when another writer got
 * there first — so one proposal (or two proposals on the same base revision) can never yield two revisions.
 */
export function createOracleGovernance(deps: OracleGovernanceDeps): OracleGovernance {
  const { store, decisions, events, ids, clock, logger } = deps;
  const mutex = new KeyedMutex();

  const flipNow = async (proposal: OracleChangeProposal): Promise<boolean> =>
    deps.wouldFlipRecordedFailure ? (await deps.wouldFlipRecordedFailure(proposal)) === true : false;

  return {
    async establish(spec, approver, ctx) {
      assertActor(approver, 'approver');
      if (approver.kind === 'agent') throw denied(`agents cannot establish oracles (${approver.id})`, { rule: 'agent_establish' });
      if (spec.changePolicy.selfApprove !== false) throw new HypertestError('invalid_argument', 'changePolicy.selfApprove must be false');
      if (spec.changePolicy.approvers.length === 0) throw new HypertestError('invalid_argument', 'changePolicy.approvers must not be empty');
      const authority = authorityProblems(spec.authorities, approver);
      if (authority.length > 0) throw new HypertestError('invalid_argument', `oracle ${spec.oracleId}: ${authority.join('; ')}`, { details: { rule: 'authorities' } });
      for (const a of spec.assertions) {
        const v = validateJson(ORACLE_ASSERTION_SCHEMA, a);
        if (!v.valid) throw new HypertestError('schema_violation', `invalid oracle assertion ${a.assertionId}: ${v.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
      }
      return mutex.run(spec.oracleId, async () => {
        // establish creates; an existing oracle changes only through propose/decide (which also invalidates
        // decisions based on the old revision)
        const existing = await store.getOracle(spec.oracleId);
        if (existing) {
          throw new HypertestError('conflict', `oracle ${spec.oracleId} already exists at revision ${existing.revision}; change it through propose/decide`, {
            details: { oracleId: spec.oracleId, revision: existing.revision },
          });
        }
        const { revision: _r, createdAt: _c, supersedes: _s, invalidation: _i, ...clean } = spec as typeof spec & { revision?: number; createdAt?: string; supersedes?: number; invalidation?: unknown };
        const saved = await store.saveOracle({ ...clean, status: 'approved', approvedBy: [approver], approvedAt: clock.isoNow(), revision: 1 }, ctx);
        logger.info('oracle established', { oracleId: saved.oracleId, revision: saved.revision, approver: approver.id });
        return saved;
      });
    },

    async propose(input, proposedBy, ctx) {
      assertActor(proposedBy, 'proposedBy');
      const current = await store.getOracle(input.oracleId);
      if (!current) throw new HypertestError('not_found', `oracle ${input.oracleId} not found`);
      if (proposedBy.kind === 'agent' && !current.changePolicy.agentMayPropose) {
        throw denied(`oracle ${input.oracleId} does not accept agent proposals`, { rule: 'agent_may_not_propose' });
      }
      if (input.fromRevision !== current.revision) {
        throw new HypertestError('conflict', `proposal targets revision ${input.fromRevision} but oracle ${input.oracleId} is at revision ${current.revision}`);
      }
      if (!Array.isArray(input.proposedAssertions) || input.proposedAssertions.length === 0) {
        throw new HypertestError('invalid_argument', 'proposedAssertions must be a non-empty full replacement list');
      }
      const seen = new Set<string>();
      for (const a of input.proposedAssertions) {
        const v = validateJson(ORACLE_ASSERTION_SCHEMA, a);
        if (!v.valid) throw new HypertestError('schema_violation', `invalid proposed assertion: ${v.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
        if (seen.has(a.assertionId)) throw new HypertestError('invalid_argument', `duplicate assertionId ${a.assertionId}`);
        seen.add(a.assertionId);
      }
      if (!input.rationale || input.rationale.trim().length === 0) throw new HypertestError('invalid_argument', 'a rationale is required');
      const draft: OracleChangeProposal = {
        proposalId: ids.next('ocp'),
        runId: input.runId,
        oracleId: input.oracleId,
        fromRevision: input.fromRevision,
        proposedAssertions: input.proposedAssertions,
        rationale: input.rationale,
        proposedBy,
        relatedEvidenceRefs: [...input.relatedEvidenceRefs],
        wouldFlipRecordedFailure: false,
        status: 'pending',
        createdAt: clock.isoNow(),
      };
      draft.wouldFlipRecordedFailure = await flipNow(draft);
      const saved = await store.saveOracleProposal(draft, ctx);
      if (events) {
        await events.emit([
          eventFrom(ctx, EVENT_TYPES.oracleChangeProposed, 'oracle', input.oracleId, {
            proposalId: saved.proposalId,
            oracleId: saved.oracleId,
            fromRevision: saved.fromRevision,
            proposedBy: proposedBy.id,
            wouldFlipRecordedFailure: saved.wouldFlipRecordedFailure,
            relatedEvidenceRefs: saved.relatedEvidenceRefs,
          }),
        ]);
      }
      logger.info('oracle change proposed', { proposalId: saved.proposalId, oracleId: saved.oracleId, by: proposedBy.id });
      return saved;
    },

    async decide(proposalId, approve, decidedBy, rationale, ctx) {
      assertActor(decidedBy, 'decidedBy');
      if (typeof rationale !== 'string' || rationale.trim().length === 0) throw new HypertestError('invalid_argument', 'a decision rationale is required');
      const first = await store.getOracleProposal(proposalId);
      if (!first) throw new HypertestError('not_found', `oracle change proposal ${proposalId} not found`);
      return mutex.run(first.oracleId, async () => {
        // re-read under the lock: a concurrent decider may have finished meanwhile
        const proposal = await store.getOracleProposal(proposalId);
        if (!proposal) throw new HypertestError('not_found', `oracle change proposal ${proposalId} not found`);
        if (proposal.status !== 'pending') throw new HypertestError('precondition_failed', `proposal ${proposalId} is already ${proposal.status}`);
        const current = await store.getOracle(proposal.oracleId);
        if (!current) throw new HypertestError('not_found', `oracle ${proposal.oracleId} not found`);
        // the flip is re-evaluated now: a failure recorded after the proposal must still require a human
        const flip = proposal.wouldFlipRecordedFailure || (approve && (await flipNow(proposal)));
        assertMayDecide(current, { ...proposal, wouldFlipRecordedFailure: flip }, decidedBy, approve);
        // An approval interrupted after its revision was written (e.g. the proposal save failed) is resumed by
        // the same approver: the revision is not written twice, the remaining steps are completed.
        const resumed =
          approve &&
          current.revision === proposal.fromRevision + 1 &&
          current.supersedes === proposal.fromRevision &&
          current.approvedBy.length === 1 &&
          current.approvedBy[0]!.kind === decidedBy.kind &&
          current.approvedBy[0]!.id === decidedBy.id &&
          canonicalJson(current.assertions) === canonicalJson(proposal.proposedAssertions);
        if (approve && !resumed && current.revision !== proposal.fromRevision) {
          throw new HypertestError('conflict', `proposal ${proposalId} targets revision ${proposal.fromRevision} but oracle ${proposal.oracleId} is at revision ${current.revision}`);
        }
        const decidedAt = clock.isoNow();
        const decided: OracleChangeProposal = { ...proposal, status: approve ? 'approved' : 'rejected', decidedBy, decisionRationale: rationale, decidedAt };

        if (!approve) {
          const saved = await store.saveOracleProposal(decided, ctx);
          if (events) {
            await events.emit([
              eventFrom(ctx, EVENT_TYPES.oracleChangeRejected, 'oracle', proposal.oracleId, { proposalId, oracleId: proposal.oracleId, fromRevision: proposal.fromRevision, decidedBy: decidedBy.id, rationale }),
            ]);
          }
          logger.info('oracle change rejected', { proposalId, by: decidedBy.id });
          return { proposal: saved, invalidatedDecisions: [] };
        }

        let newRevision: OracleSpec = current;
        if (!resumed) {
          const { revision: _r, createdAt: _c, supersedes: _s, invalidation: _i, ...base } = current;
          // compare-and-set: exactly revision current+1 (the store refuses with conflict when it already exists)
          newRevision = await store.saveOracle(
            { ...base, assertions: proposal.proposedAssertions, status: 'approved', approvedBy: [decidedBy], approvedAt: decidedAt, revision: current.revision + 1 },
            ctx,
          );
          if (newRevision.revision !== current.revision + 1) {
            throw new HypertestError('internal', `oracle store saved revision ${newRevision.revision} for ${proposal.oracleId}; expected ${current.revision + 1}`);
          }
        }

        // invalidate BEFORE closing the proposal: if this fails, the proposal stays pending and a retry resumes
        // (markNeedsReassessment is idempotent), so a closed proposal always implies completed invalidation
        const invalidatedDecisions: string[] = [];
        if (decisions && (current.changePolicy.invalidatesPriorDecisions || flip)) {
          const affected = await decisions.findByOracleRevision(proposal.oracleId, proposal.fromRevision);
          const reason = `oracle ${proposal.oracleId} revision ${proposal.fromRevision} superseded by revision ${newRevision.revision} (proposal ${proposalId})`;
          for (const d of [...affected].sort((a, b) => (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0))) {
            await decisions.markNeedsReassessment(d.decisionId, reason, ctx);
            invalidatedDecisions.push(d.decisionId);
          }
        }
        const saved = await store.saveOracleProposal(decided, ctx);
        if (events) {
          await events.emit([
            eventFrom(ctx, EVENT_TYPES.oracleChangeApproved, 'oracle', proposal.oracleId, {
              proposalId,
              oracleId: proposal.oracleId,
              fromRevision: proposal.fromRevision,
              newRevision: newRevision.revision,
              decidedBy: decidedBy.id,
              wouldFlipRecordedFailure: flip,
              invalidatedDecisions,
            }),
          ]);
        }
        logger.info('oracle change approved', { proposalId, oracleId: proposal.oracleId, newRevision: newRevision.revision, invalidated: invalidatedDecisions.length });
        return { proposal: saved, newRevision, invalidatedDecisions };
      });
    },

    async invalidate(oracleId, revision, by, reason, ctx) {
      assertActor(by, 'by');
      if (by.kind === 'agent') throw denied(`agents cannot declare an oracle invalid (${by.id}); propose a change instead`, { rule: 'agent_invalidate' });
      if (typeof reason !== 'string' || reason.trim().length === 0) throw new HypertestError('invalid_argument', 'a reason is required to declare an oracle revision invalid');
      return mutex.run(oracleId, async () => {
        const current = await store.getOracle(oracleId);
        if (!current) throw new HypertestError('not_found', `oracle ${oracleId} not found`);
        if (current.revision !== revision) {
          throw new HypertestError('conflict', `oracle ${oracleId} is at revision ${current.revision}; only the latest revision (not ${revision}) can be declared invalid`, { details: { oracleId, revision, latest: current.revision } });
        }
        if (current.status !== 'approved') throw new HypertestError('precondition_failed', `oracle ${oracleId} revision ${revision} is ${current.status}, not approved`);
        const at = clock.isoNow();
        const { revision: _r, createdAt: _c, supersedes: _s, invalidation: _i, ...base } = current;
        // append-only: the declaration is a new revision (history is never updated)
        const invalid = await store.saveOracle(
          { ...base, status: 'invalid', approvedBy: [by], approvedAt: at, invalidation: { revision, reason, by, at }, revision: current.revision + 1 },
          ctx,
        );
        const invalidatedDecisions: string[] = [];
        if (decisions) {
          // unconditionally (whatever the change policy says): a decision that rests on an invalid criterion must be re-judged
          const affected = await decisions.findByOracleRevision(oracleId, revision);
          for (const d of [...affected].sort((a, b) => (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0))) {
            await decisions.markNeedsReassessment(d.decisionId, `oracle ${oracleId} revision ${revision} declared invalid by ${by.kind}:${by.id}: ${reason}`, ctx);
            invalidatedDecisions.push(d.decisionId);
          }
        }
        if (events) {
          await events.emit([eventFrom(ctx, EVENT_TYPES.oracleInvalidated, 'oracle', oracleId, { oracleId, revision, invalidRevision: invalid.revision, by: by.id, byKind: by.kind, reason, invalidatedDecisions })]);
        }
        logger.info('oracle revision declared invalid', { oracleId, revision, by: by.id, invalidated: invalidatedDecisions.length });
        return { invalid, invalidatedDecisions };
      });
    },
  };
}
