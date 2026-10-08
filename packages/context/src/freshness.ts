import { HypertestError, toIso } from '@hypertest/core';
import { eventFrom, EVENT_TYPES, type ContextSnapshot, type EventContext, type ReadSetEntry } from '@hypertest/domain';
import type { ContextDeps, FreshnessGuard, FreshnessPass, FreshnessPassLog, FreshnessResult, ObservationLog, ProposedAction, ResolverRegistry, SnapshotStore, StaleEntry } from './contracts.ts';
import { requireText } from './util.ts';
import { ABSENT_VERSION } from './observations.ts';
import { createResolverRegistry } from './resolvers.ts';
import { environmentVersion, snapshotIdFor } from './snapshots.ts';

/**
 * Types always re-validated before a mutating action (the "world moved under you" set).
 * (conformance-3) `finding` entries — the heads of the findings a work item acts on, pinned by the control plane — are
 * re-checked too: a fix or test built on a finding that was rejected or superseded meanwhile is stale.
 * (B[2]) `finding_withdrawal` entries — every finding the agent was shown (prompt summaries included) — are re-checked for
 * withdrawal (rejected / duplicate) before every mutating action.
 */
export const ALWAYS_CHECKED_TYPES: ReadonlySet<string> = new Set(['environment', 'build', 'oracle', 'experiment', 'lease', 'finding', 'finding_withdrawal']);

function idMatches(id: string, resource: string): boolean {
  return resource === id || resource.startsWith(id + '/') || id.startsWith(resource + '/');
}

/**
 * True when an action resource names the entry: equal id or hierarchical overlap (a/b ⊂ a), either bare or
 * prefixed with the entry type (`file:src` names `file` entry `src/a.ts`).
 */
export function resourceMatches(entry: Pick<ReadSetEntry, 'resourceType' | 'resourceId'>, resource: string): boolean {
  if (typeof resource !== 'string' || resource.length === 0) return false;
  const typed = `${entry.resourceType}:`;
  return idMatches(entry.resourceId, resource) || (resource.startsWith(typed) && resource.length > typed.length && idMatches(entry.resourceId, resource.slice(typed.length)));
}

/**
 * The versions a snapshot pins in its own fields (environment, oracle and experiment revisions) as exact_version
 * entries. A mutating action re-validates them even when the read set lacks a matching entry (e.g. a snapshot
 * created directly through SnapshotStore rather than the builder), so the pinned versions can never go unchecked.
 */
export function pinnedEntries(snapshot: ContextSnapshot): ReadSetEntry[] {
  const at = snapshot.createdAt;
  const out: ReadSetEntry[] = [];
  if (snapshot.environment) {
    out.push({ resourceType: 'environment', resourceId: snapshot.environment.environmentId, observedVersion: environmentVersion(snapshot.environment), observedAt: at, freshness: { kind: 'exact_version' } });
  }
  for (const [id, rev] of Object.entries(snapshot.oracleRevisions ?? {})) out.push({ resourceType: 'oracle', resourceId: id, observedVersion: String(rev), observedAt: at, freshness: { kind: 'exact_version' } });
  for (const [id, rev] of Object.entries(snapshot.experimentRevisions ?? {})) out.push({ resourceType: 'experiment', resourceId: id, observedVersion: String(rev), observedAt: at, freshness: { kind: 'exact_version' } });
  return out;
}

/** A malformed action must never be mistaken for a read-only one (fail closed). */
function validateAction(action: unknown): asserts action is ProposedAction {
  if (typeof action !== 'object' || action === null) throw new HypertestError('invalid_argument', 'action must be an object');
  const a = action as Record<string, unknown>;
  if (typeof a['mutating'] !== 'boolean') throw new HypertestError('invalid_argument', 'action.mutating must be a boolean');
  if (typeof a['tool'] !== 'string' || a['tool'].length === 0) throw new HypertestError('invalid_argument', 'action.tool must be a non-empty string');
  if (a['resources'] !== undefined && (!Array.isArray(a['resources']) || a['resources'].some((r) => typeof r !== 'string'))) {
    throw new HypertestError('invalid_argument', 'action.resources must be an array of strings');
  }
}

export interface FreshnessGuardDeps extends ContextDeps {
  snapshots: SnapshotStore;
  /** Defaults to an empty registry (every exact_version check then fails closed with `no_resolver`). */
  resolvers?: ResolverRegistry;
  /**
   * (additive) The agents' observations. The acting agent's (`ctx.agentId`) observations made under the validated
   * snapshot — i.e. during the turn it fixes — refine the read set: each replaces the snapshot's entries of the same
   * resource (its own write, or a fresh re-read, is its current knowledge) and a resource first observed in the turn
   * joins it. A log that cannot be read fails the validation (the runtime reports stale_context).
   */
  observations?: ObservationLog;
}

const resourceKey = (e: Pick<ReadSetEntry, 'resourceType' | 'resourceId'>) => `${e.resourceType}\u0000${e.resourceId}`;

/**
 * FreshnessGuard (I1: no mutating tool without a freshness validation).
 *  - A malformed action (mutating not a boolean, …) is invalid_argument, never treated as read-only.
 *  - Read-only actions are fresh without touching the snapshot or any resolver.
 *  - Mutating actions check every non-immutable entry whose type is environment/build/oracle/experiment/lease
 *    or whose resourceId is named by action.resources: max_age entries by time (clock), exact_version entries
 *    through the registered resolver. The snapshot's pinned environment / oracle / experiment versions are
 *    checked too, even without a matching read-set entry. A missing resolver, a throwing resolver and an unknown snapshot are all
 *    stale (fail closed). A snapshot object whose content no longer hashes to its id is not trusted: the stored
 *    snapshot is used instead (missing ⇒ stale). Stale results emit context.stale_rejected.
 *  - (additive) With `observations`, the acting agent's observations made under the snapshot refine its read set
 *    (see FreshnessGuardDeps.observations); an entry observed as ABSENT_VERSION is fresh while the resource is missing.
 */
export function createFreshnessGuard(deps: FreshnessGuardDeps): FreshnessGuard {
  const resolvers = deps.resolvers ?? createResolverRegistry();
  const { clock, logger } = deps;

  async function reject(snapshotId: string, runId: string | undefined, action: ProposedAction, checked: number, stale: StaleEntry[], ctx: EventContext): Promise<FreshnessResult> {
    logger.warn('stale context rejected', { snapshotId, tool: action.tool, stale: stale.map((s) => `${s.resourceType}:${s.resourceId}:${s.reason}`) });
    if (deps.events) {
      const event = eventFrom(ctx, EVENT_TYPES.contextStaleRejected, 'context', snapshotId, {
        snapshotId,
        tool: action.tool,
        resources: action.resources,
        checked,
        stale: stale.map((s) => ({ ...s })),
      });
      if (runId) event.runId = runId;
      await deps.events.emit([event]);
    }
    return { fresh: false, checked, stale };
  }

  return {
    resolvers,
    async validate(snapshotOrId, action, ctx) {
      validateAction(action);
      if (!action.mutating) return { fresh: true, checked: 0 };
      if (typeof snapshotOrId !== 'string' && (typeof snapshotOrId !== 'object' || snapshotOrId === null)) {
        throw new HypertestError('invalid_argument', 'snapshot must be a ContextSnapshot or a snapshot id');
      }
      const snapshotId = typeof snapshotOrId === 'string' ? snapshotOrId : snapshotOrId.snapshotId;
      let snapshot: ContextSnapshot | undefined;
      // A snapshot object is trusted only while its content still hashes to its id (content address); an edited
      // or hand-made object is replaced by the stored snapshot, and fails closed when there is none.
      if (typeof snapshotOrId !== 'string' && snapshotIdFor(snapshotOrId) === snapshotOrId.snapshotId) snapshot = snapshotOrId;
      else snapshot = await deps.snapshots.get(snapshotId);
      if (!snapshot) {
        return reject(snapshotId, typeof snapshotOrId === 'string' ? undefined : snapshotOrId.runId, action, 0, [{ resourceType: 'context_snapshot', resourceId: snapshotId, observedVersion: snapshotId, reason: 'missing' }], ctx);
      }
      const resources = action.resources ?? [];
      const nowMs = clock.nowMs();
      const stale: StaleEntry[] = [];
      let checked = 0;
      const pending: Array<Promise<void>> = [];
      // One resolver call per (type, id) even if several entries observed it.
      const cache = new Map<string, Promise<{ ok: true; version: string | undefined } | { ok: false; error: string }>>();

      // Pinned versions not already observed verbatim in the read set are checked as well (an inconsistent read
      // set entry and pinned field are both checked, so at most one of them can pass).
      const versionKey = (e: ReadSetEntry) => `${e.resourceType}\u0000${e.resourceId}\u0000${e.observedVersion}`;
      const observedKeys = new Set(snapshot.readSet.map(versionKey));
      let entries = [...snapshot.readSet, ...pinnedEntries(snapshot).filter((e) => !observedKeys.has(versionKey(e)))];
      // (additive) What the acting agent observed since this snapshot was fixed (during its turn) supersedes the snapshot's
      // view of the same resources: its own writes and re-reads are its current knowledge — a change by anyone else after
      // them is still caught — and resources it first observed in this turn are validated too.
      if (deps.observations && typeof ctx?.agentId === 'string' && ctx.agentId.length > 0) {
        const since = await deps.observations.latest({ runId: snapshot.runId, agentId: ctx.agentId, snapshotId: snapshot.snapshotId });
        if (since.length > 0) {
          const refined = new Map(since.map((o) => [resourceKey(o), { resourceType: o.resourceType, resourceId: o.resourceId, observedVersion: o.observedVersion, observedAt: o.observedAt, freshness: o.freshness } as ReadSetEntry]));
          entries = [...entries.filter((e) => !refined.has(resourceKey(e))), ...refined.values()];
        }
      }

      for (const entry of entries) {
        if (entry.freshness.kind === 'immutable') continue;
        const selected = ALWAYS_CHECKED_TYPES.has(entry.resourceType) || resources.some((r) => resourceMatches(entry, r));
        if (!selected) continue;
        checked++;
        const base = { resourceType: entry.resourceType, resourceId: entry.resourceId, observedVersion: entry.observedVersion };
        if (entry.freshness.kind === 'max_age') {
          const observed = Date.parse(entry.observedAt);
          // An unparsable observation time cannot prove freshness: fail closed.
          if (Number.isNaN(observed) || nowMs - observed > entry.freshness.milliseconds) stale.push({ ...base, reason: 'expired' });
          continue;
        }
        const resolver = resolvers.get(entry.resourceType);
        if (!resolver) {
          stale.push({ ...base, reason: 'no_resolver' });
          continue;
        }
        const key = `${entry.resourceType}\u0000${entry.resourceId}`;
        let lookup = cache.get(key);
        if (!lookup) {
          lookup = resolver.currentVersion(entry.resourceId).then(
            (version) => ({ ok: true as const, version }),
            (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
          );
          cache.set(key, lookup);
        }
        pending.push(
          lookup.then((r) => {
            if (!r.ok) stale.push({ ...base, reason: 'resolver_error', error: r.error });
            // an entry that recorded the resource as ABSENT stays fresh while it is still missing
            else if (r.version === undefined) {
              if (entry.observedVersion !== ABSENT_VERSION) stale.push({ ...base, reason: 'missing' });
            } else if (r.version !== entry.observedVersion) stale.push({ ...base, currentVersion: r.version, reason: 'version_changed' });
          }),
        );
      }
      await Promise.all(pending);
      if (stale.length === 0) return { fresh: true, checked };
      // Deterministic order regardless of resolver latency.
      stale.sort((a, b) => (a.resourceType + '\u0000' + a.resourceId < b.resourceType + '\u0000' + b.resourceId ? -1 : a.resourceType + '\u0000' + a.resourceId > b.resourceType + '\u0000' + b.resourceId ? 1 : 0));
      return reject(snapshotId, snapshot.runId, action, checked, stale, ctx);
    },
  };
}

/**
 * (B[1]) The FreshnessPassLog on ht_context_freshness_passes (migration context/004): `record` writes through the caller's
 * transaction when one is active (the store's AsyncLocalStorage), so the pass commits with — and only with — the tool's
 * effect. Recording a known invocation again is a no-op (the first pass stands).
 */
export function createFreshnessPassLog(deps: ContextDeps): FreshnessPassLog {
  const { db, clock } = deps;
  return {
    async record(pass) {
      requireText(pass?.invocationId, 'pass.invocationId');
      requireText(pass.runId, 'pass.runId');
      requireText(pass.agentId, 'pass.agentId');
      requireText(pass.toolId, 'pass.toolId');
      if (!Number.isSafeInteger(pass.checked) || pass.checked < 0) throw new HypertestError('invalid_argument', 'pass.checked must be an integer >= 0');
      await db.query(
        `INSERT INTO ht_context_freshness_passes (invocation_id, run_id, agent_id, tool_id, snapshot_id, checked, passed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (invocation_id) DO NOTHING`,
        [pass.invocationId, pass.runId, pass.agentId, pass.toolId, pass.snapshotId ?? null, pass.checked, clock.isoNow()],
      );
    },
    async get(invocationId) {
      if (typeof invocationId !== 'string' || invocationId.length === 0) return undefined;
      const r = await db.query<{ invocation_id: string; run_id: string; agent_id: string; tool_id: string; snapshot_id: string | null; checked: number; passed_at: unknown }>(
        'SELECT invocation_id, run_id, agent_id, tool_id, snapshot_id, checked, passed_at FROM ht_context_freshness_passes WHERE invocation_id = $1',
        [invocationId],
      );
      const row = r.rows[0];
      if (!row) return undefined;
      const pass: FreshnessPass & { passedAt: string } = { invocationId: row.invocation_id, runId: row.run_id, agentId: row.agent_id, toolId: row.tool_id, checked: Number(row.checked), passedAt: toIso(row.passed_at) };
      if (row.snapshot_id !== null) pass.snapshotId = row.snapshot_id;
      return pass;
    },
  };
}
