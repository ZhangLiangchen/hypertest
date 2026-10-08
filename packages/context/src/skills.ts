import { canonicalJson, fromJsonColumn, HypertestError, sha256Hex, toIso, type JsonValue, type SqlExecutor, type SqlParam } from '@hypertest/core';
import { eventFrom, type EventContext } from '@hypertest/domain';
import type { ContextDeps, DurableMemory, SkillEvalResult, SkillRegistry, SkillRevision, SkillStatus, SkillValidation, SkillValidationOptions } from './contracts.ts';
import { RETRIEVABLE_STATUSES, creatorActing, overlapScore, scopeMatches } from './experience.ts';
import { isRecord, requireText, resolveLimit } from './util.ts';

/** L0 events of the skill registry (aggregate `skill`, id `<skillId>`). */
export const SKILL_EVENTS = Object.freeze({
  proposed: 'skill.proposed',
  validated: 'skill.validated',
  validationFailed: 'skill.validation_failed',
  published: 'skill.published',
  retired: 'skill.retired',
  rejected: 'skill.rejected',
});

export const SKILL_STATUSES: readonly SkillStatus[] = ['candidate', 'validated', 'published', 'retired', 'rejected'];

/** Agent Skills `name`: lowercase letters, digits and hyphens, 1–64 characters, no leading/trailing/double hyphen. */
export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;

/** Content address of a skill revision: sha256 of canonical {name, description, body, scope}. */
export function skillDigest(skill: Pick<SkillRevision, 'name' | 'description' | 'body' | 'scope'>): string {
  return sha256Hex(canonicalJson({ name: skill.name, description: skill.description, body: skill.body, scope: skill.scope as unknown as JsonValue }));
}

/**
 * The eval arm bound to one skill revision: a validation counts only the trials of this arm, so an eval result proves the
 * exact revision (and content digest) it was run with.
 */
export function skillArmId(skill: Pick<SkillRevision, 'skillId' | 'revision' | 'digest'>): string {
  return `skill-${skill.skillId}-r${skill.revision}-${skill.digest.slice(0, 12)}`;
}

/** The SKILL.md document of a revision (Agent Skills standard: YAML front matter `name` + `description`, then the body). */
export function renderSkillMarkdown(skill: Pick<SkillRevision, 'name' | 'description' | 'body'>): string {
  const quote = (v: string) => JSON.stringify(v);
  return `---\nname: ${skill.name}\ndescription: ${quote(skill.description)}\n---\n\n${skill.body.trimEnd()}\n`;
}

interface SkillRow {
  skill_id: string;
  revision: number;
  name: string;
  description: string;
  body: string;
  scope: unknown;
  digest: string;
  status: string;
  source_experience_ids: unknown;
  created_by: string;
  published_by: string | null;
  retired_by: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const COLUMNS = 'skill_id, revision, name, description, body, scope, digest, status, source_experience_ids, created_by, published_by, retired_by, created_at, updated_at';

function rowToSkill(r: SkillRow): SkillRevision {
  const s: SkillRevision = {
    skillId: r.skill_id,
    revision: Number(r.revision),
    name: r.name,
    description: r.description,
    body: r.body,
    scope: fromJsonColumn<SkillRevision['scope']>(r.scope),
    digest: r.digest,
    status: r.status as SkillStatus,
    sourceExperienceIds: fromJsonColumn<string[]>(r.source_experience_ids),
    createdBy: r.created_by,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
  if (r.published_by !== null) s.publishedBy = r.published_by;
  if (r.retired_by !== null) s.retiredBy = r.retired_by;
  return s;
}

interface ValidationRow {
  validation_id: string;
  skill_id: string;
  revision: number;
  digest: string;
  suite_id: string;
  suite_revision: string;
  arm_id: string;
  trials: number;
  passes: number;
  pass_rate: number;
  baseline_arm_id: string | null;
  baseline_pass_rate: number | null;
  min_pass_rate: number;
  min_trials: number;
  passed: boolean;
  reasons: unknown;
  result_digest: string;
  recorded_by: string;
  recorded_at: unknown;
}

function rowToValidation(r: ValidationRow): SkillValidation {
  const v: SkillValidation = {
    validationId: r.validation_id,
    skillId: r.skill_id,
    revision: Number(r.revision),
    digest: r.digest,
    suiteId: r.suite_id,
    suiteRevision: r.suite_revision,
    armId: r.arm_id,
    trials: Number(r.trials),
    passes: Number(r.passes),
    passRate: Number(r.pass_rate),
    minPassRate: Number(r.min_pass_rate),
    minTrials: Number(r.min_trials),
    passed: r.passed === true,
    reasons: fromJsonColumn<string[]>(r.reasons),
    resultDigest: r.result_digest,
    recordedBy: r.recorded_by,
    recordedAt: toIso(r.recorded_at),
  };
  if (r.baseline_arm_id !== null) v.baselineArmId = r.baseline_arm_id;
  if (r.baseline_pass_rate !== null) v.baselinePassRate = Number(r.baseline_pass_rate);
  return v;
}

function validateScope(scope: unknown): SkillRevision['scope'] {
  if (scope === undefined) return {};
  if (!isRecord(scope)) throw new HypertestError('invalid_argument', 'scope must be an object');
  const out: SkillRevision['scope'] = {};
  for (const k of ['project', 'role', 'topic'] as const) {
    const v = scope[k];
    if (v === undefined) continue;
    requireText(v, `scope.${k}`);
    out[k] = v;
  }
  const extra = Object.keys(scope).filter((k) => !['project', 'role', 'topic'].includes(k));
  if (extra.length > 0) throw new HypertestError('invalid_argument', `scope has unknown keys: ${extra.join(', ')}`);
  return out;
}

/** A ratio in (0, 1]: a zero threshold would let a skill whose every trial failed "pass" its validation. */
function ratio(v: unknown, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1) throw new HypertestError('invalid_argument', `${name} must be a number in (0, 1]`);
  return v;
}

export interface SkillRegistryDeps extends ContextDeps {
  /** Where source experience is looked up (approved/published only may become a skill). */
  experiences: Pick<DurableMemory, 'list'>;
}

/**
 * The Hypertest Skill Registry on ht_skills / ht_skill_validations (migration context/005-skills). Store-enforced:
 *  - propose: every source experience must be approved or published (a candidate experience never becomes a skill);
 *  - recordValidation: counts only the trials of the arm bound to the revision (skillArmId); passes when the arm has at least
 *    minTrials trials, a pass rate ≥ minPassRate and — with a baseline (cold-track) arm — a pass rate not below it;
 *  - publish: only a revision whose LATEST validation passed (and by someone other than its creator); the database refuses a
 *    `validated`/`published` status without such a validation (trigger, 42501) and every content change of a revision;
 *  - forPrompt: published revisions only (the ACTIVE registry).
 */
export function createSkillRegistry(deps: SkillRegistryDeps): SkillRegistry {
  const { db, ids, clock, logger } = deps;

  async function load(x: SqlExecutor, skillId: string, revision?: number, lock = false): Promise<SkillRevision | undefined> {
    const r = revision === undefined
      ? await x.query<SkillRow>(`SELECT ${COLUMNS} FROM ht_skills WHERE skill_id = $1 ORDER BY revision DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [skillId])
      : await x.query<SkillRow>(`SELECT ${COLUMNS} FROM ht_skills WHERE skill_id = $1 AND revision = $2${lock ? ' FOR UPDATE' : ''}`, [skillId, revision]);
    return r.rows[0] ? rowToSkill(r.rows[0]) : undefined;
  }

  async function emit(x: SqlExecutor, ctx: EventContext, type: string, skill: SkillRevision, extra: Record<string, unknown> = {}): Promise<void> {
    if (!deps.events) return;
    const event = eventFrom(ctx, type, 'skill', skill.skillId, { skillId: skill.skillId, revision: skill.revision, digest: skill.digest, status: skill.status, ...extra });
    await deps.events.emit([event], x);
  }

  async function setStatus(x: SqlExecutor, skill: SkillRevision, status: SkillStatus, by?: { column: 'published_by' | 'retired_by'; actor: string }): Promise<SkillRevision> {
    const now = clock.isoNow();
    if (by) await x.query(`UPDATE ht_skills SET status = $3, ${by.column} = $4, updated_at = $5 WHERE skill_id = $1 AND revision = $2`, [skill.skillId, skill.revision, status, by.actor, now]);
    else await x.query('UPDATE ht_skills SET status = $3, updated_at = $4 WHERE skill_id = $1 AND revision = $2', [skill.skillId, skill.revision, status, now]);
    const out: SkillRevision = { ...skill, status, updatedAt: new Date(now).toISOString() };
    if (by?.column === 'published_by') out.publishedBy = by.actor;
    if (by?.column === 'retired_by') out.retiredBy = by.actor;
    return out;
  }

  async function latestValidation(x: SqlExecutor, skill: SkillRevision): Promise<SkillValidation | undefined> {
    const r = await x.query<ValidationRow>(
      'SELECT * FROM ht_skill_validations WHERE skill_id = $1 AND revision = $2 AND digest = $3 ORDER BY recorded_at DESC, seq DESC LIMIT 1',
      [skill.skillId, skill.revision, skill.digest],
    );
    return r.rows[0] ? rowToValidation(r.rows[0]) : undefined;
  }

  return {
    async propose(input, ctx) {
      if (!isRecord(input)) throw new HypertestError('invalid_argument', 'skill must be an object');
      requireText(input.name, 'name');
      if (!SKILL_NAME_RE.test(input.name)) throw new HypertestError('invalid_argument', `name ${JSON.stringify(input.name)} must be lowercase letters, digits and single hyphens (Agent Skills name, ≤ 64 characters)`);
      requireText(input.description, 'description');
      if (input.description.length > 1024) throw new HypertestError('invalid_argument', 'description must be at most 1024 characters');
      requireText(input.body, 'body');
      requireText(input.createdBy, 'createdBy');
      if (input.skillId !== undefined) requireText(input.skillId, 'skillId');
      if (!Array.isArray(input.sourceExperienceIds) || input.sourceExperienceIds.length === 0 || input.sourceExperienceIds.some((x) => typeof x !== 'string' || x.length === 0)) {
        throw new HypertestError('invalid_argument', 'sourceExperienceIds must name at least one experience item (a skill is distilled from approved experience)');
      }
      const scope = validateScope(input.scope);
      const sources = [...new Set(input.sourceExperienceIds)];
      // a skill is distilled from APPROVED experience only: never a candidate, a rejected or a quarantined item
      const approved = new Map((await deps.experiences.list({ status: [...RETRIEVABLE_STATUSES] })).map((e) => [e.experienceId, e]));
      const missing = sources.filter((id) => !approved.has(id));
      if (missing.length > 0) {
        throw new HypertestError('precondition_failed', `a candidate skill needs approved experience: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not approved or published`, { details: { notApproved: missing } });
      }
      const digest = skillDigest({ name: input.name, description: input.description, body: input.body, scope });
      return db.transaction(async (tx) => {
        let skillId = input.skillId;
        let revision = 1;
        if (skillId !== undefined) {
          const latest = await load(tx, skillId, undefined, true);
          if (!latest) throw new HypertestError('not_found', `skill ${skillId} not found (omit skillId for a new skill)`);
          if (latest.digest === digest && (latest.status === 'candidate' || latest.status === 'validated' || latest.status === 'published')) return latest;
          revision = latest.revision + 1;
        } else {
          // the same content proposed again is the same candidate (idempotent retry)
          const same = await tx.query<SkillRow>(`SELECT ${COLUMNS} FROM ht_skills WHERE digest = $1 AND status IN ('candidate', 'validated', 'published') ORDER BY skill_id, revision LIMIT 1`, [digest]);
          if (same.rows[0]) return rowToSkill(same.rows[0]);
          skillId = ids.next('skl');
        }
        const now = clock.isoNow();
        await tx.query(
          `INSERT INTO ht_skills (skill_id, revision, name, description, body, scope, scope_role, digest, status, source_experience_ids, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'candidate', $9::jsonb, $10, $11, $11)`,
          [skillId, revision, input.name, input.description, input.body, JSON.stringify(scope), scope.role ?? null, digest, JSON.stringify(sources), input.createdBy, now],
        );
        const created: SkillRevision = {
          skillId, revision, name: input.name, description: input.description, body: input.body, scope, digest, status: 'candidate', sourceExperienceIds: sources,
          createdBy: input.createdBy, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
        };
        await emit(tx, ctx, SKILL_EVENTS.proposed, created, { name: created.name, sourceExperienceIds: sources, createdBy: input.createdBy });
        logger.info('skill proposed', { skillId, revision });
        return created;
      });
    },

    async recordValidation(skillId, revision, result, options, ctx) {
      requireText(skillId, 'skillId');
      if (!Number.isSafeInteger(revision) || revision < 1) throw new HypertestError('invalid_argument', 'revision must be a positive integer');
      requireText(options?.recordedBy, 'options.recordedBy');
      if (!isRecord(result) || typeof result.suiteId !== 'string' || !Array.isArray(result.trials)) throw new HypertestError('invalid_argument', 'result must be an eval suite result ({ suiteId, revision, trials[] })');
      const minPassRate = ratio(options.minPassRate, 'minPassRate', 1);
      const minTrials = options.minTrials ?? 1;
      if (!Number.isSafeInteger(minTrials) || minTrials < 1) throw new HypertestError('invalid_argument', 'minTrials must be a positive integer');
      return db.transaction(async (tx) => {
        const skill = await load(tx, skillId, revision, true);
        if (!skill) throw new HypertestError('not_found', `skill ${skillId} revision ${revision} not found`);
        if (skill.status !== 'candidate' && skill.status !== 'validated') throw new HypertestError('precondition_failed', `skill ${skillId} r${revision} is ${skill.status}: only a candidate or validated revision is validated`);
        const armId = skillArmId(skill);
        const mine = result.trials.filter((t) => isRecord(t) && t.armId === armId);
        if (mine.length === 0) {
          throw new HypertestError('precondition_failed', `the eval result has no trial of arm ${armId}: it was not run with skill ${skillId} r${revision} (digest ${skill.digest.slice(0, 12)})`, {
            details: { armId, arms: [...new Set(result.trials.map((t) => t.armId))] },
          });
        }
        const otherArms = [...new Set(result.trials.map((t) => t.armId).filter((a) => a !== armId))];
        const baselineArmId = options.baselineArmId ?? (otherArms.length === 1 ? otherArms[0] : undefined);
        if (baselineArmId !== undefined && baselineArmId === armId) throw new HypertestError('invalid_argument', 'the baseline arm cannot be the skill arm');
        const passes = mine.filter((t) => t.result === 'pass').length;
        const passRate = passes / mine.length;
        const reasons: string[] = [];
        if (mine.length < minTrials) reasons.push(`${mine.length} trial(s) of ${armId}, fewer than ${minTrials}`);
        if (passRate < minPassRate) reasons.push(`pass rate ${passRate.toFixed(3)} below ${minPassRate}`);
        let baselinePassRate: number | undefined;
        if (baselineArmId !== undefined) {
          const base = result.trials.filter((t) => t.armId === baselineArmId);
          if (base.length === 0) throw new HypertestError('precondition_failed', `the eval result has no trial of the baseline arm ${baselineArmId}`);
          baselinePassRate = base.filter((t) => t.result === 'pass').length / base.length;
          if (passRate < baselinePassRate) reasons.push(`pass rate ${passRate.toFixed(3)} below the baseline arm ${baselineArmId} (${baselinePassRate.toFixed(3)}): the skill makes results worse`);
        }
        const passed = reasons.length === 0;
        const validation: SkillValidation = {
          validationId: ids.next('sklv'),
          skillId, revision, digest: skill.digest,
          suiteId: result.suiteId, suiteRevision: typeof result.revision === 'string' ? result.revision : '',
          armId, trials: mine.length, passes, passRate, minPassRate, minTrials, passed, reasons,
          resultDigest: sha256Hex(canonicalJson(JSON.parse(JSON.stringify(result)) as JsonValue)),
          recordedBy: options.recordedBy,
          recordedAt: new Date(clock.isoNow()).toISOString(),
        };
        if (baselineArmId !== undefined) validation.baselineArmId = baselineArmId;
        if (baselinePassRate !== undefined) validation.baselinePassRate = baselinePassRate;
        await tx.query(
          `INSERT INTO ht_skill_validations (validation_id, skill_id, revision, digest, suite_id, suite_revision, arm_id, trials, passes, pass_rate, baseline_arm_id, baseline_pass_rate,
             min_pass_rate, min_trials, passed, reasons, result_digest, recorded_by, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19)`,
          [validation.validationId, skillId, revision, skill.digest, validation.suiteId, validation.suiteRevision, armId, validation.trials, passes, passRate, baselineArmId ?? null,
            baselinePassRate ?? null, minPassRate, minTrials, passed, JSON.stringify(reasons), validation.resultDigest, options.recordedBy, validation.recordedAt],
        );
        // the latest validation decides: a passing one validates the revision, a failing one sends it back to candidate
        const next: SkillStatus = passed ? 'validated' : 'candidate';
        const updated = next !== skill.status ? await setStatus(tx, skill, next) : skill;
        await emit(tx, ctx, passed ? SKILL_EVENTS.validated : SKILL_EVENTS.validationFailed, updated, {
          validationId: validation.validationId, suiteId: validation.suiteId, armId, trials: validation.trials, passRate, ...(baselinePassRate !== undefined ? { baselinePassRate } : {}), reasons,
        });
        logger.info('skill validation recorded', { skillId, revision, passed, passRate });
        return validation;
      });
    },

    async publish(skillId, revision, publisher, ctx) {
      requireText(skillId, 'skillId');
      requireText(publisher, 'publisher');
      return db.transaction(async (tx) => {
        const skill = await load(tx, skillId, revision, true);
        if (!skill) throw new HypertestError('not_found', `skill ${skillId} revision ${revision} not found`);
        if (skill.status === 'published' && skill.publishedBy === publisher) return skill;
        const self = creatorActing(skill.createdBy, publisher, ctx);
        if (self !== undefined) throw new HypertestError('permission_denied', `skill ${skillId} cannot be published by its creator ${self}`);
        const latest = await latestValidation(tx, skill);
        if (skill.status !== 'validated' || !latest?.passed) {
          throw new HypertestError('precondition_failed', `skill ${skillId} r${revision} is ${skill.status}: a skill enters the active registry only with a passing eval validation of this revision${latest ? ` (latest validation ${latest.validationId}: ${latest.passed ? 'passed' : `failed — ${latest.reasons.join('; ')}`})` : ' (none recorded)'}`, {
            details: { status: skill.status, latestValidation: latest?.validationId ?? null },
          });
        }
        // one active revision per skill: the previously published one is retired
        const active = await tx.query<SkillRow>(`SELECT ${COLUMNS} FROM ht_skills WHERE skill_id = $1 AND status = 'published' FOR UPDATE`, [skillId]);
        for (const row of active.rows) {
          const prev = await setStatus(tx, rowToSkill(row), 'retired', { column: 'retired_by', actor: publisher });
          await emit(tx, ctx, SKILL_EVENTS.retired, prev, { retiredBy: publisher, supersededBy: revision });
        }
        const published = await setStatus(tx, skill, 'published', { column: 'published_by', actor: publisher });
        await emit(tx, ctx, SKILL_EVENTS.published, published, { publishedBy: publisher, validationId: latest.validationId });
        logger.info('skill published', { skillId, revision, publisher });
        return published;
      });
    },

    async retire(skillId, retiredBy, ctx) {
      requireText(skillId, 'skillId');
      requireText(retiredBy, 'retiredBy');
      return db.transaction(async (tx) => {
        const r = await tx.query<SkillRow>(`SELECT ${COLUMNS} FROM ht_skills WHERE skill_id = $1 AND status = 'published' FOR UPDATE`, [skillId]);
        if (!r.rows[0]) throw new HypertestError('precondition_failed', `skill ${skillId} has no published revision to retire`);
        const retired = await setStatus(tx, rowToSkill(r.rows[0]), 'retired', { column: 'retired_by', actor: retiredBy });
        await emit(tx, ctx, SKILL_EVENTS.retired, retired, { retiredBy });
        return retired;
      });
    },

    async reject(skillId, revision, rejectedBy, ctx) {
      requireText(skillId, 'skillId');
      requireText(rejectedBy, 'rejectedBy');
      return db.transaction(async (tx) => {
        const skill = await load(tx, skillId, revision, true);
        if (!skill) throw new HypertestError('not_found', `skill ${skillId} revision ${revision} not found`);
        if (skill.status === 'rejected') return skill;
        if (skill.status !== 'candidate' && skill.status !== 'validated') throw new HypertestError('precondition_failed', `skill ${skillId} r${revision} is ${skill.status}: only a candidate or validated revision can be rejected (retire a published one)`);
        const self = creatorActing(skill.createdBy, rejectedBy, ctx);
        if (self !== undefined) throw new HypertestError('permission_denied', `skill ${skillId} cannot be rejected by its creator ${self}`);
        const rejected = await setStatus(tx, skill, 'rejected');
        await emit(tx, ctx, SKILL_EVENTS.rejected, rejected, { rejectedBy });
        return rejected;
      });
    },

    async get(skillId, revision) {
      if (typeof skillId !== 'string' || skillId.length === 0) return undefined;
      return load(db, skillId, revision);
    },

    async list(filter) {
      const params: SqlParam[] = [];
      const where: string[] = [];
      if (filter?.status && filter.status.length > 0) {
        params.push([...filter.status]);
        where.push(`status = ANY($${params.length})`);
      }
      if (filter?.skillId !== undefined) {
        params.push(filter.skillId);
        where.push(`skill_id = $${params.length}`);
      }
      const r = await db.query<SkillRow>(`SELECT ${COLUMNS} FROM ht_skills${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY skill_id, revision`, params);
      return r.rows.map(rowToSkill);
    },

    async validations(skillId, revision) {
      const r = revision === undefined
        ? await db.query<ValidationRow>('SELECT * FROM ht_skill_validations WHERE skill_id = $1 ORDER BY recorded_at, seq', [skillId])
        : await db.query<ValidationRow>('SELECT * FROM ht_skill_validations WHERE skill_id = $1 AND revision = $2 ORDER BY recorded_at, seq', [skillId, revision]);
      return r.rows.map(rowToValidation);
    },

    async forPrompt(query) {
      const limit = resolveLimit(query?.limit, 3);
      // the ACTIVE registry: published revisions only (re-checked outside SQL as well)
      const r = await db.query<SkillRow>(`SELECT ${COLUMNS} FROM ht_skills WHERE status = 'published' ORDER BY skill_id, revision`);
      const role = typeof query?.role === 'string' && query.role.length > 0 ? query.role : undefined;
      const text = query?.text ?? '';
      const scored = r.rows
        .map(rowToSkill)
        .filter((s) => s.status === 'published' && scopeMatches(s.scope, role ? { role } : undefined))
        .map((s) => ({ s, roleMatch: role !== undefined && s.scope.role === role, score: overlapScore(text, `${s.name.replace(/-/g, ' ')} ${s.description} ${s.scope.topic ?? ''}`) }))
        // a skill scoped to the role always applies; a global one only when relevant to the task
        .filter((x) => x.roleMatch || x.score > 0 || text.trim() === '');
      scored.sort((a, b) => Number(b.roleMatch) - Number(a.roleMatch) || b.score - a.score || (a.s.skillId < b.s.skillId ? -1 : 1));
      return scored.slice(0, limit).map((x) => x.s);
    },
  };
}

/**
 * A skill registry view that also offers `trial` skill revisions — an eval arm under evaluation (`skills.trial` of the
 * configuration) — to prompts, marked as candidates under evaluation. Trial revisions never enter the registry: they exist
 * only in the evaluated instance's configuration, bound by digest to the arm that runs them (skillArmId).
 */
export function withTrialSkills(registry: Pick<SkillRegistry, 'forPrompt'>, trial: readonly SkillRevision[]): Pick<SkillRegistry, 'forPrompt'> {
  if (trial.length === 0) return registry;
  for (const t of trial) {
    if (skillDigest(t) !== t.digest) throw new HypertestError('integrity_violation', `trial skill ${t.skillId} r${t.revision}: its content does not hash to its digest ${t.digest.slice(0, 12)}`);
  }
  return {
    async forPrompt(query) {
      const role = typeof query?.role === 'string' && query.role.length > 0 ? query.role : undefined;
      const extra = trial.filter((t) => scopeMatches(t.scope, role ? { role } : undefined)).map((t) => ({ ...t, description: `[candidate under evaluation] ${t.description}` }));
      const published = await registry.forPrompt(query);
      return [...extra, ...published.filter((p) => !extra.some((e) => e.skillId === p.skillId))].slice(0, Math.max(resolveLimit(query?.limit, 3), extra.length));
    },
  };
}
