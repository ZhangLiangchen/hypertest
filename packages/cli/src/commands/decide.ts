import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { HypertestError } from '@hypertest/core';
import { oracleConfigProblems, oracleSpecFromConfig, type HypertestInstance, type OracleConfig } from '@hypertest/app';
import { UsageError, flag, list, positionals, required, str } from '../args.ts';
import type { Command } from '../command.ts';
import { withInstance } from '../context.ts';
import { EXIT_CODES } from '../exit-codes.ts';
import { table, truncate } from '../format.ts';

type ApprovalStatus = Awaited<ReturnType<HypertestInstance['listApprovals']>>[number]['status'];
const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'denied', 'expired'];
const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected'] as const;

/**
 * Marker variable of a Hypertest sandbox. A command an agent runs (`shell.exec` allows `node`) can reach this CLI; a
 * human decision taken from there would let an agent approve its own side effect or oracle change as a "human" (I1, I8)
 * — the API refuses human decisions without a token for the same reason. When the variable is set (non-empty) the
 * decision commands refuse. Both sandboxes of @hypertest/tools (local and OCI) set it in every child process (H1).
 */
export const SANDBOX_ENV = 'HYPERTEST_SANDBOX';

/**
 * (review, E[8]) What a human is asked to decide, in one line: for an action approval the exact action it authorizes (tool,
 * effect/risk, target, environment class, arguments) — never just the opaque digest; for a budget extension the dimension,
 * its limit and the proposed raise; otherwise the subject as JSON.
 */
export function approvalSubjectSummary(a: { kind: string; subject?: unknown }): string {
  const s = (a.subject ?? null) as Record<string, unknown> | null;
  if (s && typeof s === 'object' && !Array.isArray(s)) {
    // an action description (what the approval gate records): the digest alone would tell the decider nothing
    if (a.kind === 'action' && typeof s['tool'] === 'string' && Array.isArray(s['resources']) && Object.prototype.hasOwnProperty.call(s, 'input')) {
      const resources = Array.isArray(s['resources']) ? (s['resources'] as unknown[]).join(',') : '';
      const env = typeof s['environmentClass'] === 'string' ? ` [${s['environmentClass']}]` : '';
      return `${s['tool']} ${String(s['effect'] ?? '?')}/${String(s['riskClass'] ?? '?')} on ${resources || '(no resource)'}${env} args ${JSON.stringify(s['input'] ?? null)}`;
    }
    if (a.kind === 'budget' && s['raise'] !== undefined && s['raise'] !== null && typeof s['raise'] === 'object') {
      return `extend ${String(s['dimension'] ?? 'the budget')}${s['limit'] !== undefined && s['limit'] !== null ? ` (limit ${String(s['limit'])})` : ''} by ${JSON.stringify(s['raise'])}`;
    }
  }
  return JSON.stringify(a.subject ?? null);
}

function assertNotSandboxed(env: Record<string, string | undefined>, what: string): void {
  if (env[SANDBOX_ENV]) {
    throw new HypertestError('permission_denied', `${what} is a human decision and cannot be taken from inside a Hypertest sandbox (${SANDBOX_ENV} is set): an agent never decides its own approval or oracle change`);
  }
}

/** A human decider's name: printable, no whitespace-only values (it becomes `human:<name>` in the audit trail). */
function deciderName(command: string, values: Parameters<typeof required>[1]): string {
  const by = required(command, values, 'by').trim();
  if (!/^[\p{L}\p{N}._@+-][\p{L}\p{N}._@+\- ]{0,127}$/u.test(by)) throw new UsageError(`--by must be a person's name or handle (letters, digits, . _ @ + -), got ${JSON.stringify(by)}`, command);
  return by;
}

export const approvalsCommand: Command = {
  name: 'approvals',
  summary: 'list approval requests (pending by default)',
  usage: ['approvals [--run <runId>] [--status s1,s2 | --all] [--json]'],
  options: { run: { type: 'string' }, status: { type: 'string' }, all: { type: 'boolean' } },
  async run(ctx, values, args) {
    positionals('approvals', args, []);
    const statuses = list(values, 'status');
    for (const s of statuses) if (!(APPROVAL_STATUSES as readonly string[]).includes(s)) throw new UsageError(`--status: unknown approval status ${JSON.stringify(s)} (${APPROVAL_STATUSES.join(', ')})`, 'approvals');
    if (statuses.length > 0 && flag(values, 'all')) throw new UsageError('--status and --all are mutually exclusive', 'approvals');
    const filter: { runId?: string; status?: ApprovalStatus[] } = {};
    const runId = str(values, 'run');
    if (runId) filter.runId = runId;
    if (!flag(values, 'all')) filter.status = statuses.length > 0 ? (statuses as ApprovalStatus[]) : ['pending'];
    return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
      const approvals = await ht.listApprovals(filter);
      if (ctx.global.json) {
        ctx.json(approvals);
        return EXIT_CODES.ok;
      }
      if (approvals.length === 0) {
        ctx.out(`no ${filter.status ? filter.status.join('/') + ' ' : ''}approvals${runId ? ` for run ${runId}` : ''}`);
        return EXIT_CODES.ok;
      }
      const rows = approvals.map((a) => [a.approvalId, a.runId, a.kind, a.status, `${a.requestedBy.kind}:${a.requestedBy.id}`, a.createdAt, truncate(approvalSubjectSummary(a), 160)]);
      for (const l of table(['APPROVAL', 'RUN', 'KIND', 'STATUS', 'REQUESTED BY', 'CREATED', 'SUBJECT'], rows)) ctx.out(l);
      return EXIT_CODES.ok;
    });
  },
};

export const approveCommand: Command = {
  name: 'approve',
  summary: 'decide an approval request as a human (approve, or --deny)',
  usage: ['approve <approvalId> [--deny] --by <name> --reason "<text>"'],
  notes: [
    'The requester can never approve its own request. The decision is recorded as human:<name> with the reason in the audit trail.',
    'With the embedded PGlite store, stop the process driving the run first (the run stays resumable), then `hypertest resume`.',
    `Refused (permission_denied) when $${SANDBOX_ENV} is set: a command an agent runs in a Hypertest sandbox never takes a human decision.`,
  ],
  options: { deny: { type: 'boolean' }, by: { type: 'string' }, reason: { type: 'string' } },
  async run(ctx, values, args) {
    const [approvalId] = positionals('approve', args, ['approvalId']);
    const by = deciderName('approve', values);
    const reason = required('approve', values, 'reason');
    const approve = !flag(values, 'deny');
    assertNotSandboxed(ctx.io.env, 'approve');
    return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
      await ht.approve(approvalId!, approve, { kind: 'human', id: by }, reason);
      const decided = await ht.services.approvals.get(approvalId!);
      if (ctx.global.json) ctx.json({ approvalId, status: decided?.status ?? null, runId: decided?.runId ?? null, decidedBy: `human:${by}` });
      else ctx.out(`approval ${approvalId} ${decided?.status ?? (approve ? 'approved' : 'denied')} by human:${by}${decided ? ` (run ${decided.runId})` : ''}`);
      return EXIT_CODES.ok;
    });
  },
};

/** (E[8]) `hypertest reject`: deny an approval request as a human (the explicit counterpart of `approve`). */
export const rejectCommand: Command = {
  name: 'reject',
  summary: 'deny an approval request as a human (the action stays refused; a budget extension is not granted)',
  usage: ['reject <approvalId> --by <name> --reason "<text>"'],
  notes: [
    'Same as `approve <approvalId> --deny`. The requester can never decide its own request; the decision is recorded as human:<name>.',
    `Refused (permission_denied) when $${SANDBOX_ENV} is set: a command an agent runs in a Hypertest sandbox never takes a human decision.`,
  ],
  options: { by: { type: 'string' }, reason: { type: 'string' } },
  async run(ctx, values, args) {
    const [approvalId] = positionals('reject', args, ['approvalId']);
    const by = deciderName('reject', values);
    const reason = required('reject', values, 'reason');
    assertNotSandboxed(ctx.io.env, 'reject');
    return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
      await ht.approve(approvalId!, false, { kind: 'human', id: by }, reason);
      const decided = await ht.services.approvals.get(approvalId!);
      if (ctx.global.json) ctx.json({ approvalId, status: decided?.status ?? null, runId: decided?.runId ?? null, decidedBy: `human:${by}` });
      else ctx.out(`approval ${approvalId} ${decided?.status ?? 'denied'} by human:${by}${decided ? ` (run ${decided.runId})` : ''}`);
      return EXIT_CODES.ok;
    });
  },
};

/** Reads one oracle (or a list of them) from a YAML/JSON file for `oracle establish`. */
async function readOracleFile(command: string, cwd: string, file: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(resolve(cwd, file), 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${file}: ${(e as Error).message}`, command);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    throw new UsageError(`${file} is not valid YAML/JSON: ${(e as Error).message}`, command);
  }
  const doc = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { oracles?: unknown }).oracles) ? (parsed as { oracles: unknown[] }).oracles : parsed;
  return Array.isArray(doc) ? doc : [doc];
}

export const oracleCommand: Command = {
  name: 'oracle',
  summary: 'oracles: establish one as a human authority; list or decide change proposals; declare a revision invalid',
  usage: [
    'oracle establish <file.yaml> --by <name>',
    'oracle proposals [--run <runId>] [--status s1,s2 | --all] [--json]',
    'oracle decide <proposalId> [--reject] --by <name> --reason "<text>"',
    'oracle invalidate <oracleId> --revision <n> --by <name> --reason "<text>"',
  ],
  notes: [
    'Correctness criteria are never decided by agents: an oracle is established by a named human (`establish`, or the `oracles:` configuration section) and a run pins it; without an oracle in force the gate is at best inconclusive (C0).',
    'Agents only propose oracle changes; a change that would flip a recorded failure needs an independent (human) decision (I8).',
    '(D-10) `invalidate` declares the latest revision of an oracle invalid (append-only: a new revision with status invalid; nothing is rewritten): every decision based on it is marked needs_reassessment, and a run pinned to it is at best inconclusive (C0) until a new revision is approved through a proposal (the run is then re-pinned and replans).',
    `\`oracle establish\`, \`oracle decide\` and \`oracle invalidate\` are refused (permission_denied) when $${SANDBOX_ENV} is set.`,
  ],
  options: { reject: { type: 'boolean' }, by: { type: 'string' }, reason: { type: 'string' }, run: { type: 'string' }, status: { type: 'string' }, all: { type: 'boolean' }, revision: { type: 'string' } },
  async run(ctx, values, args) {
    const sub = args[0];
    if (sub === 'establish') {
      const [, file] = positionals('oracle', args, ['establish', 'file']);
      const by = deciderName('oracle', values);
      assertNotSandboxed(ctx.io.env, 'oracle establish');
      const docs = (await readOracleFile('oracle', ctx.io.cwd, file!)).map((d) => (d && typeof d === 'object' && !Array.isArray(d) ? { ...(d as Record<string, unknown>), establishedBy: by } : d));
      const problems = oracleConfigProblems(docs);
      if (problems.length > 0) throw new UsageError(`invalid oracle file ${file}:\n  - ${problems.join('\n  - ')}`, 'oracle');
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const established: Array<{ oracleId: string; revision: number }> = [];
        for (const o of docs as OracleConfig[]) {
          if (await ht.services.specs.getOracle(o.oracleId)) {
            throw new HypertestError('conflict', `oracle ${o.oracleId} already exists: it changes only through governed proposals (oracle proposals / decide)`, { details: { oracleId: o.oracleId } });
          }
          const saved = await ht.services.oracles.establish(oracleSpecFromConfig(o), { kind: 'human', id: by }, { runId: `cli-${o.oracleId}`, correlationId: `cli-${o.oracleId}`, actorId: `human:${by}` });
          established.push({ oracleId: saved.oracleId, revision: saved.revision });
        }
        if (ctx.global.json) ctx.json({ established, establishedBy: `human:${by}` });
        else for (const e of established) ctx.out(`oracle ${e.oracleId} revision ${e.revision} established by human:${by}`);
        return EXIT_CODES.ok;
      });
    }
    if (sub === 'proposals') {
      positionals('oracle', args, ['proposals']);
      const statuses = list(values, 'status');
      for (const s of statuses) if (!(PROPOSAL_STATUSES as readonly string[]).includes(s)) throw new UsageError(`--status: unknown proposal status ${JSON.stringify(s)} (${PROPOSAL_STATUSES.join(', ')})`, 'oracle');
      const filter: { runId?: string; status?: Array<(typeof PROPOSAL_STATUSES)[number]> } = {};
      const runId = str(values, 'run');
      if (runId) filter.runId = runId;
      if (!flag(values, 'all')) filter.status = statuses.length > 0 ? (statuses as Array<(typeof PROPOSAL_STATUSES)[number]>) : ['pending'];
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const proposals = await ht.services.specs.listOracleProposals(filter);
        if (ctx.global.json) {
          ctx.json(proposals);
          return EXIT_CODES.ok;
        }
        if (proposals.length === 0) {
          ctx.out('no oracle change proposals');
          return EXIT_CODES.ok;
        }
        const rows = proposals.map((p) => [p.proposalId, p.runId, `${p.oracleId}@${p.fromRevision}`, p.status, p.wouldFlipRecordedFailure ? 'yes' : 'no', `${p.proposedBy.kind}:${p.proposedBy.id}`, truncate(p.rationale, 50)]);
        for (const l of table(['PROPOSAL', 'RUN', 'ORACLE', 'STATUS', 'FLIPS FAILURE', 'PROPOSED BY', 'RATIONALE'], rows)) ctx.out(l);
        return EXIT_CODES.ok;
      });
    }
    if (sub === 'invalidate') {
      const [, oracleId] = positionals('oracle', args, ['invalidate', 'oracleId']);
      const by = deciderName('oracle', values);
      const reason = required('oracle', values, 'reason');
      const revisionText = required('oracle', values, 'revision');
      const revision = Number(revisionText);
      if (!/^\d+$/.test(revisionText.trim()) || !Number.isInteger(revision) || revision < 1) throw new UsageError(`--revision must be a positive integer, got ${JSON.stringify(revisionText)}`, 'oracle');
      assertNotSandboxed(ctx.io.env, 'oracle invalidate');
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const invalidate = ht.services.oracles.invalidate;
        if (!invalidate) throw new HypertestError('unavailable', 'this oracle governance cannot declare a revision invalid');
        const out = await invalidate.call(ht.services.oracles, oracleId!, revision, { kind: 'human', id: by }, reason, { runId: `cli-${oracleId}`, correlationId: `cli-${oracleId}`, actorId: `human:${by}` });
        if (ctx.global.json) ctx.json({ oracleId, revision, invalidRevision: out.invalid.revision, invalidatedDecisions: out.invalidatedDecisions, by: `human:${by}` });
        else ctx.out(`oracle ${oracleId} revision ${revision} declared invalid by human:${by} (revision ${out.invalid.revision}); ${out.invalidatedDecisions.length} decision(s) marked needs_reassessment`);
        return EXIT_CODES.ok;
      });
    }
    if (sub !== 'decide') throw new UsageError(sub === undefined ? 'missing sub-command (oracle establish <file> | oracle proposals | oracle decide <proposalId> | oracle invalidate <oracleId>)' : `unknown sub-command oracle ${sub}`, 'oracle');
    const [, proposalId] = positionals('oracle', args, ['decide', 'proposalId']);
    const by = deciderName('oracle', values);
    const reason = required('oracle', values, 'reason');
    const approve = !flag(values, 'reject');
    assertNotSandboxed(ctx.io.env, 'oracle decide');
    return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
      await ht.decideOracleProposal(proposalId!, approve, { kind: 'human', id: by }, reason);
      const decided = await ht.services.specs.getOracleProposal(proposalId!);
      if (ctx.global.json) ctx.json({ proposalId, status: decided?.status ?? null, runId: decided?.runId ?? null, decidedBy: `human:${by}` });
      else ctx.out(`oracle change proposal ${proposalId} ${decided?.status ?? (approve ? 'approved' : 'rejected')} by human:${by}`);
      return EXIT_CODES.ok;
    });
  },
};

const EXPERIENCE_STATUSES = ['candidate', 'reviewed', 'approved', 'published', 'quarantined', 'rejected'] as const;
const EXPERIENCE_DECISIONS = ['review', 'approve', 'publish', 'reject', 'quarantine'] as const;

/**
 * conformance-13: the human surface of the learning loop. Experience candidates proposed by runs are only ever retrieved
 * once approved/published; `experience review` is that decision (never by the candidate's creator, never from inside a
 * sandbox).
 */
export const experienceCommand: Command = {
  name: 'experience',
  summary: 'experience candidates of the learning loop: list them, or review one as a human',
  usage: [
    'experience list [--run <runId>] [--status s1,s2 | --all] [--json]',
    'experience review <experienceId> --decision review|approve|publish|reject|quarantine --by <name>',
  ],
  notes: [
    'Only approved or published experience is retrieved into later runs. The creator of a candidate can never review it.',
    `\`experience review\` is refused (permission_denied) when $${SANDBOX_ENV} is set.`,
  ],
  options: { run: { type: 'string' }, status: { type: 'string' }, all: { type: 'boolean' }, decision: { type: 'string' }, by: { type: 'string' } },
  async run(ctx, values, args) {
    const sub = args[0];
    if (sub === 'list') {
      positionals('experience', args, ['list']);
      const statuses = list(values, 'status');
      for (const s of statuses) if (!(EXPERIENCE_STATUSES as readonly string[]).includes(s)) throw new UsageError(`--status: unknown experience status ${JSON.stringify(s)} (${EXPERIENCE_STATUSES.join(', ')})`, 'experience');
      if (statuses.length > 0 && flag(values, 'all')) throw new UsageError('--status and --all are mutually exclusive', 'experience');
      const filter: { status?: Array<(typeof EXPERIENCE_STATUSES)[number]>; sourceRunId?: string } = {};
      if (!flag(values, 'all')) filter.status = statuses.length > 0 ? (statuses as Array<(typeof EXPERIENCE_STATUSES)[number]>) : ['candidate', 'reviewed'];
      const runId = str(values, 'run');
      if (runId) filter.sourceRunId = runId;
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const items = await ht.services.memory.list(filter);
        if (ctx.global.json) {
          ctx.json(items);
          return EXIT_CODES.ok;
        }
        if (items.length === 0) {
          ctx.out(`no ${filter.status ? filter.status.join('/') + ' ' : ''}experience${runId ? ` from run ${runId}` : ''}`);
          return EXIT_CODES.ok;
        }
        const rows = items.map((e) => [e.experienceId, e.status, e.kind, e.sourceRunId, e.createdBy, truncate(e.content, 60)]);
        for (const l of table(['EXPERIENCE', 'STATUS', 'KIND', 'RUN', 'CREATED BY', 'CONTENT'], rows)) ctx.out(l);
        return EXIT_CODES.ok;
      });
    }
    if (sub !== 'review') throw new UsageError(sub === undefined ? 'missing sub-command (experience list | experience review <experienceId>)' : `unknown sub-command experience ${sub}`, 'experience');
    const [, experienceId] = positionals('experience', args, ['review', 'experienceId']);
    const decision = required('experience', values, 'decision');
    if (!(EXPERIENCE_DECISIONS as readonly string[]).includes(decision)) throw new UsageError(`--decision must be one of ${EXPERIENCE_DECISIONS.join(', ')} (got ${JSON.stringify(decision)})`, 'experience');
    const by = deciderName('experience', values);
    assertNotSandboxed(ctx.io.env, 'experience review');
    return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
      const cur = (await ht.services.memory.list({})).find((e) => e.experienceId === experienceId);
      if (!cur) throw new HypertestError('not_found', `experience ${experienceId} not found`);
      const reviewer = `human:${by}`;
      const out = await ht.services.memory.review(experienceId!, decision as (typeof EXPERIENCE_DECISIONS)[number], reviewer, { runId: cur.sourceRunId, correlationId: experienceId!, actorId: reviewer });
      if (ctx.global.json) ctx.json({ experienceId, status: out.status, reviewedBy: reviewer });
      else ctx.out(`experience ${experienceId} ${out.status} by ${reviewer}`);
      return EXIT_CODES.ok;
    });
  },
};

/**
 * conformance-11: a governed waiver of one QualityGate criterion for a run, decided by a named human (an approval of
 * kind `gate_exception`, requested by `system:cli` and approved by `human:<name>`). The gate applies it at the run's next
 * evaluation — never for C1 (evidence integrity), never after `--expires`; the decision and the report list it.
 */
export const waiveCommand: Command = {
  name: 'waive',
  summary: 'waive one quality-gate criterion for a run, as a human (recorded, optionally expiring)',
  usage: ['waive <runId> <criterionId> --by <name> --reason "<text>" [--expires <ISO-8601 time>]'],
  notes: [
    'Applies at the run\'s next gate evaluation (waive before the gate, e.g. while the run is running or paused). C1 evidence_integrity is never waivable.',
    `Refused (permission_denied) when $${SANDBOX_ENV} is set.`,
  ],
  options: { by: { type: 'string' }, reason: { type: 'string' }, expires: { type: 'string' } },
  async run(ctx, values, args) {
    const [runId, criterionId] = positionals('waive', args, ['runId', 'criterionId']);
    if (!/^C[0-9]$/.test(criterionId!)) throw new UsageError(`<criterionId> must be a gate criterion id C0..C9 (got ${JSON.stringify(criterionId)})`, 'waive');
    if (criterionId === 'C1') throw new UsageError('C1 evidence_integrity is not waivable', 'waive');
    const by = deciderName('waive', values);
    const reason = required('waive', values, 'reason');
    const expires = str(values, 'expires');
    if (expires !== undefined && !Number.isFinite(Date.parse(expires))) throw new UsageError(`--expires must be an ISO-8601 time (got ${JSON.stringify(expires)})`, 'waive');
    assertNotSandboxed(ctx.io.env, 'waive');
    return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
      const run = await ht.services.runs.get(runId!);
      if (!run) throw new HypertestError('not_found', `run ${runId} not found`);
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        throw new HypertestError('conflict', `run ${runId} is ${run.status}: its decision is final (a waiver applies at a gate evaluation)`);
      }
      const subject: Record<string, string> = { criterionId: criterionId! };
      if (expires !== undefined) subject['expiresAt'] = new Date(Date.parse(expires)).toISOString();
      const eventCtx = { runId: runId!, correlationId: runId!, actorId: `human:${by}` };
      const req = await ht.services.approvals.request({ runId: runId!, kind: 'gate_exception', subject, requestedBy: { kind: 'system', id: 'cli' }, rationale: reason }, eventCtx);
      await ht.approve(req.approvalId, true, { kind: 'human', id: by }, reason);
      if (ctx.global.json) ctx.json({ approvalId: req.approvalId, runId, criterionId, expiresAt: subject['expiresAt'] ?? null, approvedBy: `human:${by}` });
      else ctx.out(`criterion ${criterionId} waived for run ${runId} by human:${by} (approval ${req.approvalId}${subject['expiresAt'] ? `, until ${subject['expiresAt']}` : ''})`);
      return EXIT_CODES.ok;
    });
  },
};
