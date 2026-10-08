import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HypertestError } from '@hypertest/core';
import { mergeConfig, renderSkillMarkdown, skillArmId, SKILL_STATUSES, type HypertestConfig, type SkillEvalResult, type SkillRegistry, type SkillRevision, type SkillStatus } from '@hypertest/app';
import type { EvalArm, SuiteResult } from '@hypertest/eval';
import { UsageError, flag, int, list, positionals, required, str } from '../args.ts';
import type { Command } from '../command.ts';
import { withInstance, type CommandContext } from '../context.ts';
import type { EvalModuleLike } from '../contracts.ts';
import { EXIT_CODES } from '../exit-codes.ts';
import { table, truncate } from '../format.ts';
import { SANDBOX_ENV } from './decide.ts';
import { availableArms, availableSuites } from './eval.ts';

/** A human decider's name (it becomes `human:<name>` in the registry and on L0). */
function by(values: Parameters<typeof required>[1]): string {
  const name = required('skill', values, 'by').trim();
  if (!/^[\p{L}\p{N}._@+-][\p{L}\p{N}._@+\- ]{0,127}$/u.test(name)) throw new UsageError(`--by must be a person's name or handle (letters, digits, . _ @ + -), got ${JSON.stringify(name)}`, 'skill');
  return name;
}

/** Skill decisions are human decisions: never taken from inside a Hypertest sandbox (an agent never publishes its own skill). */
function notSandboxed(ctx: CommandContext, what: string): void {
  if (ctx.io.env[SANDBOX_ENV]) {
    throw new HypertestError('permission_denied', `${what} is a human decision and cannot be taken from inside a Hypertest sandbox (${SANDBOX_ENV} is set): an agent never decides its own skill`);
  }
}

function registryOf(ht: { services: { skills?: SkillRegistry } }): SkillRegistry {
  if (!ht.services.skills) throw new HypertestError('unsupported', 'this Hypertest build has no skill registry');
  return ht.services.skills;
}

function revisionOf(values: Parameters<typeof int>[1]): number | undefined {
  return int('skill', values, 'revision', { min: 1, max: 1_000_000 });
}

async function revisionOrLatest(skills: SkillRegistry, skillId: string, revision: number | undefined): Promise<SkillRevision> {
  const s = await skills.get(skillId, revision);
  if (!s) throw new HypertestError('not_found', `skill ${skillId}${revision !== undefined ? ` revision ${revision}` : ''} not found`);
  return s;
}

function ratio(values: Parameters<typeof str>[0], name: string): number | undefined {
  const raw = str(values, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new UsageError(`--${name} must be a number in (0, 1] (got ${JSON.stringify(raw)})`, 'skill');
  return n;
}

/**
 * Runs an eval suite with two arms — the cold-track base arm and the arm bound to the skill revision (the base arm's
 * configuration plus `skills.trial: [revision]`: the candidate is shown, marked, in the prompts of that arm's trial instances
 * only) — and returns the SuiteResult the registry judges.
 */
async function evaluate(ctx: CommandContext, skill: SkillRevision, suiteId: string, baseArmId: string | undefined, trials: number, timeoutMs: number | undefined): Promise<{ result: SuiteResult; baseArm: string }> {
  let ev: EvalModuleLike;
  try {
    ev = await ctx.io.loadEval();
  } catch (e) {
    throw new HypertestError('unavailable', `the eval platform (@hypertest/eval) could not be loaded: ${(e as Error).message}`, { cause: e });
  }
  if (typeof ev.runSuite !== 'function') throw new HypertestError('unsupported', '@hypertest/eval does not export runSuite: this build has no eval platform');
  const factory = availableSuites(ev).get(suiteId);
  if (!factory) throw new UsageError(`unknown suite ${JSON.stringify(suiteId)} (available: ${[...availableSuites(ev).keys()].sort().join(', ') || 'none'})`, 'skill');
  const suite = factory();
  const arms = availableArms(ev, suite);
  const base = baseArmId !== undefined ? arms.get(baseArmId) : arms.values().next().value;
  if (!base) throw new UsageError(baseArmId !== undefined ? `unknown arm ${baseArmId} (available: ${[...arms.keys()].sort().join(', ') || 'none'})` : 'the eval platform offers no arm to evaluate the skill with (--arm)', 'skill');
  const armId = skillArmId(skill);
  const skillArm: EvalArm = {
    armId,
    description: `${base.armId} + candidate skill ${skill.skillId} r${skill.revision} (${skill.name}, digest ${skill.digest.slice(0, 12)})`,
    config: (cfg: HypertestConfig, tctx) => mergeConfig(base.config(cfg, tctx), { skills: { trial: [skill] } }),
  };
  if (base.brains) skillArm.brains = base.brains;
  const workDir = await mkdtemp(join(tmpdir(), 'ht-skill-eval-'));
  try {
    if (!ctx.global.json) ctx.err(`skill ${skill.skillId} r${skill.revision}: eval ${suite.suiteId} — arms ${base.armId} (cold track) and ${armId}, ${trials} trial${trials === 1 ? '' : 's'} each`);
    const result = await ev.runSuite(suite, {
      arms: [base, skillArm], trials, workDir, keepWorkDir: false, ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      onTrial: (t) => {
        if (!ctx.global.json) ctx.err(`  ${t.taskId} / ${t.armId} #${t.trial}: ${t.result}`);
      },
    });
    return { result, baseArm: base.armId };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Reads a SuiteResult file (`eval run --out`). */
async function readResult(ctx: CommandContext, path: string): Promise<SkillEvalResult> {
  let text: string;
  try {
    text = await readFile(resolve(ctx.io.cwd, path), 'utf8');
  } catch (e) {
    throw new UsageError(`--result ${path} cannot be read: ${(e as Error).message}`, 'skill');
  }
  try {
    return JSON.parse(text) as SkillEvalResult;
  } catch (e) {
    throw new UsageError(`--result ${path} is not JSON: ${(e as Error).message}`, 'skill');
  }
}

/**
 * (B[7]) The human surface of the Skill Registry: candidate skills are distilled from APPROVED experience, validated by an
 * eval run bound to their exact revision, and published into the ACTIVE registry — the only skills agents see. The registry
 * enforces every rule (not this command): approved sources only, a passing validation of the exact digest before publishing
 * (also a database trigger), publisher ≠ creator.
 */
export const skillCommand: Command = {
  name: 'skill',
  summary: 'the skill registry of the learning loop: list, propose from approved experience, validate by eval, publish, retire',
  usage: [
    'skill list [--status s1,s2 | --all] [--json]',
    'skill show <skillId> [--revision n] [--json]',
    'skill propose --from <experienceId,...> --name <name> --description "<text>" (--body-file <SKILL.md body> | --body "<text>") [--role r] [--topic t] [--skill <skillId>] --by <name>',
    'skill validate <skillId> [--revision n] (--suite <suite> [--arm <base arm>] [--trials n] [--timeout-ms n] | --result <suite-result.json>) [--min-pass-rate r] [--min-trials n] --by <name>',
    'skill publish <skillId> [--revision n] --by <name>',
    'skill retire <skillId> --by <name>',
    'skill reject <skillId> [--revision n] --by <name>',
  ],
  optionHelp: [
    ['--from <ids>', 'propose: the approved/published experience items the skill is distilled from'],
    ['--skill <skillId>', 'propose: a new revision of this skill'],
    ['--suite <suite>', 'validate: run this eval suite with the cold-track arm and the arm bound to the revision'],
    ['--arm <id>', 'validate: the cold-track (no skill) arm (default: the first arm the eval platform offers)'],
    ['--result <file>', 'validate: judge an existing SuiteResult (eval run --out) that has trials of the arm bound to the revision'],
    ['--min-pass-rate <r>', 'validate: pass rate the skill arm needs (default 1)'],
    ['--min-trials <n>', 'validate: trials the skill arm needs (default 1)'],
  ],
  notes: [
    'Only PUBLISHED skills reach agent prompts. A revision is published only after its latest eval validation passed — never by its creator.',
    `propose, validate, publish, retire and reject are human decisions: refused (permission_denied) when $${SANDBOX_ENV} is set.`,
  ],
  options: {
    status: { type: 'string' }, all: { type: 'boolean' }, revision: { type: 'string' }, from: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
    'body-file': { type: 'string' }, body: { type: 'string' }, role: { type: 'string' }, topic: { type: 'string' }, skill: { type: 'string' }, suite: { type: 'string' }, arm: { type: 'string' },
    trials: { type: 'string' }, 'timeout-ms': { type: 'string' }, result: { type: 'string' }, 'min-pass-rate': { type: 'string' }, 'min-trials': { type: 'string' }, by: { type: 'string' },
  },
  longRunning: (values) => values['suite'] !== undefined,
  async run(ctx, values, args) {
    const sub = args[0];
    switch (sub) {
      case 'list': {
        positionals('skill', args, ['list']);
        const statuses = list(values, 'status');
        for (const s of statuses) if (!(SKILL_STATUSES as readonly string[]).includes(s)) throw new UsageError(`--status: unknown skill status ${JSON.stringify(s)} (${SKILL_STATUSES.join(', ')})`, 'skill');
        if (statuses.length > 0 && flag(values, 'all')) throw new UsageError('--status and --all are mutually exclusive', 'skill');
        return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
          const filter: { status?: SkillStatus[] } = {};
          if (!flag(values, 'all')) filter.status = statuses.length > 0 ? (statuses as SkillStatus[]) : ['candidate', 'validated', 'published'];
          const skills = await registryOf(ht).list(filter);
          if (ctx.global.json) {
            ctx.json(skills);
            return EXIT_CODES.ok;
          }
          if (skills.length === 0) {
            ctx.out(`no ${filter.status ? filter.status.join('/') + ' ' : ''}skills`);
            return EXIT_CODES.ok;
          }
          for (const l of table(['SKILL', 'REV', 'STATUS', 'NAME', 'SCOPE', 'CREATED BY', 'DESCRIPTION'], skills.map((s) => [s.skillId, String(s.revision), s.status, s.name, s.scope.role ?? s.scope.topic ?? '-', s.createdBy, truncate(s.description, 50)]))) ctx.out(l);
          return EXIT_CODES.ok;
        });
      }
      case 'show': {
        const [, skillId] = positionals('skill', args, ['show', 'skillId']);
        return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
          const skills = registryOf(ht);
          const s = await revisionOrLatest(skills, skillId!, revisionOf(values));
          const validations = await skills.validations(s.skillId, s.revision);
          if (ctx.global.json) {
            ctx.json({ ...s, validations });
            return EXIT_CODES.ok;
          }
          ctx.out(`# ${s.skillId} r${s.revision} [${s.status}] digest ${s.digest}`);
          ctx.out(`# from experience ${s.sourceExperienceIds.join(', ')}; created by ${s.createdBy}${s.publishedBy ? `; published by ${s.publishedBy}` : ''}`);
          for (const v of validations) ctx.out(`# validation ${v.validationId}: ${v.passed ? 'PASSED' : 'FAILED'} ${v.suiteId} arm ${v.armId} pass rate ${v.passRate.toFixed(3)}${v.baselinePassRate !== undefined ? ` (baseline ${v.baselinePassRate.toFixed(3)})` : ''}${v.reasons.length ? ` — ${v.reasons.join('; ')}` : ''}`);
          ctx.io.stdout.write(renderSkillMarkdown(s));
          return EXIT_CODES.ok;
        });
      }
      case 'propose': {
        positionals('skill', args, ['propose']);
        const from = list(values, 'from');
        if (from.length === 0) throw new UsageError('--from is required (the approved experience the skill is distilled from)', 'skill');
        const name = required('skill', values, 'name');
        const description = required('skill', values, 'description');
        const bodyFile = str(values, 'body-file');
        const inline = str(values, 'body');
        if ((bodyFile === undefined) === (inline === undefined)) throw new UsageError('exactly one of --body-file and --body is required', 'skill');
        const body = bodyFile !== undefined ? await readFile(resolve(ctx.io.cwd, bodyFile), 'utf8').catch((e: unknown) => { throw new UsageError(`--body-file ${bodyFile} cannot be read: ${(e as Error).message}`, 'skill'); }) : inline!;
        const who = by(values);
        notSandboxed(ctx, 'skill propose');
        const scope: SkillRevision['scope'] = {};
        const role = str(values, 'role');
        const topic = str(values, 'topic');
        if (role) scope.role = role;
        if (topic) scope.topic = topic;
        return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
          const input: Parameters<SkillRegistry['propose']>[0] = { name, description, body, scope, sourceExperienceIds: from, createdBy: `human:${who}` };
          const skillId = str(values, 'skill');
          if (skillId) input.skillId = skillId;
          const s = await registryOf(ht).propose(input, { runId: `skill-${skillId ?? 'new'}`, correlationId: `skill-${name}`, actorId: `human:${who}` });
          if (ctx.global.json) ctx.json(s);
          else ctx.out(`skill ${s.skillId} r${s.revision} ${s.status} (digest ${s.digest.slice(0, 12)}; eval arm ${skillArmId(s)})`);
          return EXIT_CODES.ok;
        });
      }
      case 'validate': {
        const [, skillId] = positionals('skill', args, ['validate', 'skillId']);
        const suiteId = str(values, 'suite');
        const resultFile = str(values, 'result');
        if ((suiteId === undefined) === (resultFile === undefined)) throw new UsageError('exactly one of --suite and --result is required', 'skill');
        const trials = int('skill', values, 'trials', { min: 1, max: 10_000 }) ?? 1;
        const timeoutMs = int('skill', values, 'timeout-ms', { min: 1 });
        const minPassRate = ratio(values, 'min-pass-rate');
        const minTrials = int('skill', values, 'min-trials', { min: 1, max: 10_000 });
        const who = by(values);
        notSandboxed(ctx, 'skill validate');
        return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
          const skills = registryOf(ht);
          const s = await revisionOrLatest(skills, skillId!, revisionOf(values));
          let result: SkillEvalResult;
          let baselineArmId: string | undefined;
          if (suiteId !== undefined) {
            const r = await evaluate(ctx, s, suiteId, str(values, 'arm'), trials, timeoutMs);
            result = r.result;
            baselineArmId = r.baseArm;
          } else result = await readResult(ctx, resultFile!);
          const options: Parameters<SkillRegistry['recordValidation']>[3] = { recordedBy: `human:${who}` };
          if (minPassRate !== undefined) options.minPassRate = minPassRate;
          if (minTrials !== undefined) options.minTrials = minTrials;
          if (baselineArmId !== undefined) options.baselineArmId = baselineArmId;
          else if (str(values, 'arm') !== undefined) options.baselineArmId = str(values, 'arm')!;
          const v = await skills.recordValidation(s.skillId, s.revision, result, options, { runId: `skill-${s.skillId}`, correlationId: `skill-${s.skillId}`, actorId: `human:${who}` });
          if (ctx.global.json) ctx.json(v);
          else ctx.out(`skill ${s.skillId} r${s.revision} validation ${v.validationId}: ${v.passed ? 'PASSED' : 'FAILED'} (arm ${v.armId}: ${v.passes}/${v.trials} passed${v.baselinePassRate !== undefined ? `, baseline ${v.baselineArmId} ${v.baselinePassRate.toFixed(3)}` : ''})${v.reasons.length ? ` — ${v.reasons.join('; ')}` : ''}`);
          return v.passed ? EXIT_CODES.ok : EXIT_CODES.failure;
        });
      }
      case 'publish':
      case 'reject': {
        const [, skillId] = positionals('skill', args, [sub, 'skillId']);
        const who = by(values);
        notSandboxed(ctx, `skill ${sub}`);
        return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
          const skills = registryOf(ht);
          const s = await revisionOrLatest(skills, skillId!, revisionOf(values));
          const ctx2 = { runId: `skill-${s.skillId}`, correlationId: `skill-${s.skillId}`, actorId: `human:${who}` };
          const out = sub === 'publish' ? await skills.publish(s.skillId, s.revision, `human:${who}`, ctx2) : await skills.reject(s.skillId, s.revision, `human:${who}`, ctx2);
          if (ctx.global.json) ctx.json(out);
          else ctx.out(`skill ${out.skillId} r${out.revision} ${out.status} by human:${who}`);
          return EXIT_CODES.ok;
        });
      }
      case 'retire': {
        const [, skillId] = positionals('skill', args, ['retire', 'skillId']);
        const who = by(values);
        notSandboxed(ctx, 'skill retire');
        return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
          const out = await registryOf(ht).retire(skillId!, `human:${who}`, { runId: `skill-${skillId}`, correlationId: `skill-${skillId}`, actorId: `human:${who}` });
          if (ctx.global.json) ctx.json(out);
          else ctx.out(`skill ${out.skillId} r${out.revision} retired by human:${who}`);
          return EXIT_CODES.ok;
        });
      }
      default:
        throw new UsageError(sub === undefined ? 'missing sub-command (skill list | show | propose | validate | publish | retire | reject)' : `unknown sub-command skill ${sub}`, 'skill');
    }
  },
};
