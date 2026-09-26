import { fromJsonColumn, HypertestError, toIso, type SqlExecutor, type SqlParam } from '@hypertest/core';
import { eventFrom, EVENT_TYPES, type EventContext } from '@hypertest/domain';
import type { ContextDeps, DurableMemory, ExperienceDecision, ExperienceItem, ExperienceStatus } from './contracts.ts';
import { isRecord, requireText, resolveLimit, storableJson, tokenize } from './util.ts';

export const EXPERIENCE_KINDS: ReadonlySet<ExperienceItem['kind']> = new Set(['lesson', 'pattern', 'pitfall', 'test_idea', 'skill_candidate']);
export const EXPERIENCE_STATUSES: readonly ExperienceStatus[] = ['candidate', 'reviewed', 'approved', 'published', 'quarantined', 'rejected'];
/** Only these are ever retrieved: agent hallucinations must not become future testing policy. */
export const RETRIEVABLE_STATUSES: readonly ExperienceStatus[] = ['approved', 'published'];

const TRANSITIONS: Record<ExperienceStatus, readonly ExperienceStatus[]> = {
  candidate: ['reviewed', 'approved', 'rejected', 'quarantined'],
  reviewed: ['approved', 'rejected', 'quarantined'],
  approved: ['published', 'quarantined'],
  published: ['quarantined'],
  rejected: [],
  quarantined: [],
};

export function canTransitionExperience(from: ExperienceStatus, to: ExperienceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const DECISION_STATUS: Record<ExperienceDecision, ExperienceStatus> = {
  review: 'reviewed',
  approve: 'approved',
  publish: 'published',
  reject: 'rejected',
  quarantine: 'quarantined',
};

export const EXPERIENCE_REVIEWED_EVENT = 'experience.reviewed';

interface ExperienceRow {
  experience_id: string;
  scope: unknown;
  kind: string;
  content: string;
  source_run_id: string;
  evidence_refs: unknown;
  status: string;
  created_by: string;
  reviewed_by: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const COLUMNS = 'experience_id, scope, kind, content, source_run_id, evidence_refs, status, created_by, reviewed_by, created_at, updated_at';

function rowToItem(r: ExperienceRow): ExperienceItem {
  const item: ExperienceItem = {
    experienceId: r.experience_id,
    scope: fromJsonColumn<ExperienceItem['scope']>(r.scope),
    kind: r.kind as ExperienceItem['kind'],
    content: r.content,
    sourceRunId: r.source_run_id,
    evidenceRefs: fromJsonColumn<string[]>(r.evidence_refs),
    status: r.status as ExperienceStatus,
    createdBy: r.created_by,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
  if (r.reviewed_by !== null) item.reviewedBy = r.reviewed_by;
  return item;
}

function validateScope(scope: unknown): ExperienceItem['scope'] {
  if (!isRecord(scope)) throw new HypertestError('invalid_argument', 'scope must be an object');
  const out: ExperienceItem['scope'] = {};
  for (const k of ['project', 'role', 'topic'] as const) {
    const v = scope[k];
    if (v === undefined) continue;
    requireText(v, `scope.${k}`);
    out[k] = v;
  }
  return out;
}

/**
 * Same actor for the reviewer ≠ creator rule. Ids are compared trimmed and case-insensitively, so `Agent-X ` cannot
 * review what `agent-x` created (the comparison errs on the side of refusing).
 */
export function sameActor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The creator of an experience in the acting context (ctx.actorId / ctx.agentId), if any: the creator can neither
 * review its own item under its own name nor submit a review "as" someone else.
 */
export function creatorActing(createdBy: string, reviewer: string, ctx: EventContext | undefined): string | undefined {
  if (sameActor(createdBy, reviewer)) return reviewer;
  for (const actor of [ctx?.actorId, ctx?.agentId]) if (typeof actor === 'string' && actor.length > 0 && sameActor(createdBy, actor)) return actor;
  return undefined;
}

/** Scope filter: every field the query names must be absent on the item (global) or equal. */
export function scopeMatches(item: ExperienceItem['scope'], query: ExperienceItem['scope'] | undefined): boolean {
  if (!query) return true;
  for (const k of ['project', 'role', 'topic'] as const) {
    const q = query[k];
    if (q === undefined) continue;
    const v = item[k];
    if (v !== undefined && v !== q) return false;
  }
  return true;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'be', 'with', 'by', 'at', 'it', 'as', 'that', 'this']);

function terms(text: string): Set<string> {
  return new Set(tokenize(text).filter((t) => t.length > 1 && !STOP.has(t)));
}

/** Token-overlap relevance: |query ∩ item| / |query| (0 when the query has no terms). */
export function overlapScore(query: string, content: string): number {
  const q = terms(query);
  if (q.size === 0) return 0;
  const d = terms(content);
  let hit = 0;
  for (const t of q) if (d.has(t)) hit++;
  return hit / q.size;
}

/**
 * L4 durable memory on ht_experience. propose ⇒ candidate (+ experience.proposed); review enforces reviewer ≠
 * creator — neither as the named reviewer nor as the acting ctx.actorId/agentId (permission_denied; see
 * creatorActing) — and the lifecycle table (precondition_failed), emits
 * experience.reviewed (row and event in one transaction);
 * retrieve returns ONLY approved/published items (quarantined, rejected and unreviewed items never).
 */
export function createExperienceStore(deps: ContextDeps): DurableMemory {
  const { db, ids, clock, logger } = deps;

  async function load(x: SqlExecutor, id: string, lock: boolean): Promise<ExperienceItem | undefined> {
    const r = await x.query<ExperienceRow>(`SELECT ${COLUMNS} FROM ht_experience WHERE experience_id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    return r.rows[0] ? rowToItem(r.rows[0]) : undefined;
  }

  return {
    kind: 'sql',

    async propose(input, ctx: EventContext) {
      if (!isRecord(input)) throw new HypertestError('invalid_argument', 'experience must be an object');
      requireText(input.content, 'content');
      requireText(input.createdBy, 'createdBy');
      requireText(input.sourceRunId, 'sourceRunId');
      if (!EXPERIENCE_KINDS.has(input.kind)) throw new HypertestError('invalid_argument', `kind must be one of ${[...EXPERIENCE_KINDS].join(', ')}`);
      if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.some((r) => typeof r !== 'string' || r.length === 0)) {
        throw new HypertestError('invalid_argument', 'evidenceRefs must be an array of non-empty strings');
      }
      const scope = storableJson(validateScope(input.scope));
      const now = clock.isoNow();
      const item: ExperienceItem = storableJson({
        experienceId: ids.next('xp'),
        scope,
        kind: input.kind,
        content: input.content,
        sourceRunId: input.sourceRunId,
        evidenceRefs: [...new Set(input.evidenceRefs)],
        status: 'candidate',
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      } as ExperienceItem);
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO ht_experience (experience_id, scope, scope_project, scope_role, scope_topic, kind, content, source_run_id, evidence_refs, status, created_by, created_at, updated_at)
           VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9::jsonb, 'candidate', $10, $11, $11)`,
          [item.experienceId, JSON.stringify(scope), scope.project ?? null, scope.role ?? null, scope.topic ?? null, item.kind, item.content, item.sourceRunId,
            JSON.stringify(item.evidenceRefs), item.createdBy, now],
        );
        if (deps.events) {
          const event = eventFrom(ctx, EVENT_TYPES.experienceProposed, 'context', item.experienceId, {
            experienceId: item.experienceId,
            kind: item.kind,
            scope,
            createdBy: item.createdBy,
            evidenceRefs: item.evidenceRefs,
          });
          event.runId = item.sourceRunId;
          await deps.events.emit([event], tx);
        }
      });
      logger.info('experience proposed', { experienceId: item.experienceId, kind: item.kind });
      return item;
    },

    async review(experienceId, decision, reviewer, ctx) {
      requireText(experienceId, 'experienceId');
      requireText(reviewer, 'reviewer');
      const to = DECISION_STATUS[decision];
      if (!to) throw new HypertestError('invalid_argument', `unknown review decision ${String(decision)}`);
      return db.transaction(async (tx) => {
        const cur = await load(tx, experienceId, true);
        if (!cur) throw new HypertestError('not_found', `experience ${experienceId} not found`);
        const self = creatorActing(cur.createdBy, reviewer, ctx);
        if (self !== undefined) {
          throw new HypertestError('permission_denied', `experience ${experienceId} cannot be reviewed by its creator ${self}`, { details: { experienceId, reviewer, actor: self } });
        }
        // Idempotent retry of the same decision by the same reviewer.
        if (cur.status === to && cur.reviewedBy === reviewer) return cur;
        if (!canTransitionExperience(cur.status, to)) {
          throw new HypertestError('precondition_failed', `experience ${experienceId} cannot go from ${cur.status} to ${to}`, { details: { from: cur.status, to } });
        }
        const now = clock.isoNow();
        const entry = { decision, reviewer, from: cur.status, to, at: now };
        await tx.query(
          `UPDATE ht_experience SET status = $2, reviewed_by = $3, updated_at = $4, history = history || $5::jsonb WHERE experience_id = $1`,
          [experienceId, to, reviewer, now, JSON.stringify([entry])],
        );
        if (deps.events) {
          const event = eventFrom(ctx, EXPERIENCE_REVIEWED_EVENT, 'context', experienceId, { experienceId, decision, reviewer, from: cur.status, to });
          event.runId = cur.sourceRunId;
          await deps.events.emit([event], tx);
        }
        logger.info('experience reviewed', { experienceId, from: cur.status, to, reviewer });
        return { ...cur, status: to, reviewedBy: reviewer, updatedAt: new Date(now).toISOString() };
      });
    },

    async retrieve(query) {
      const limit = resolveLimit(query?.limit, 10);
      const scope = query?.scope ? validateScope(query.scope) : undefined;
      const params: SqlParam[] = [[...RETRIEVABLE_STATUSES]];
      let sql = `SELECT ${COLUMNS} FROM ht_experience WHERE status = ANY($1)`;
      for (const [k, col] of [['project', 'scope_project'], ['role', 'scope_role'], ['topic', 'scope_topic']] as const) {
        const v = scope?.[k];
        if (v === undefined) continue;
        params.push(v);
        sql += ` AND (${col} IS NULL OR ${col} = $${params.length})`;
      }
      const r = await db.query<ExperienceRow>(sql, params);
      const text = query?.text ?? '';
      const scored = r.rows
        .map(rowToItem)
        // Defence in depth: the status filter is re-checked outside SQL.
        .filter((it) => RETRIEVABLE_STATUSES.includes(it.status) && scopeMatches(it.scope, scope))
        .map((it) => ({ it, s: overlapScore(text, `${it.content} ${it.scope.topic ?? ''} ${it.kind}`) }))
        .filter((x) => terms(text).size === 0 || x.s > 0);
      scored.sort((a, b) => b.s - a.s || (a.it.updatedAt < b.it.updatedAt ? 1 : a.it.updatedAt > b.it.updatedAt ? -1 : 0) || (a.it.experienceId < b.it.experienceId ? -1 : 1));
      return scored.slice(0, limit).map((x) => x.it);
    },

    async list(filter) {
      const params: SqlParam[] = [];
      const where: string[] = [];
      if (filter?.status && filter.status.length > 0) {
        params.push([...filter.status]);
        where.push(`status = ANY($${params.length})`);
      }
      if (filter?.sourceRunId !== undefined) {
        params.push(filter.sourceRunId);
        where.push(`source_run_id = $${params.length}`);
      }
      const r = await db.query<ExperienceRow>(`SELECT ${COLUMNS} FROM ht_experience${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at, experience_id`, params);
      return r.rows.map(rowToItem);
    },
  };
}
