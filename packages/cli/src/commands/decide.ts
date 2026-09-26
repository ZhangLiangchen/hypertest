import { HypertestError } from '@hypertest/core';
import type { HypertestInstance } from '@hypertest/app';
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
 * decision commands refuse. NOTE: the local sandbox of @hypertest/tools does not set it yet (reported open issue).
 */
export const SANDBOX_ENV = 'HYPERTEST_SANDBOX';

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
      const rows = approvals.map((a) => [a.approvalId, a.runId, a.kind, a.status, `${a.requestedBy.kind}:${a.requestedBy.id}`, a.createdAt, truncate(JSON.stringify(a.subject), 60)]);
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

export const oracleCommand: Command = {
  name: 'oracle',
  summary: 'oracle change proposals: list them, or decide one as a human',
  usage: ['oracle proposals [--run <runId>] [--status s1,s2 | --all] [--json]', 'oracle decide <proposalId> [--reject] --by <name> --reason "<text>"'],
  notes: [
    'Agents only propose oracle changes; a change that would flip a recorded failure needs an independent (human) decision (I8).',
    `\`oracle decide\` is refused (permission_denied) when $${SANDBOX_ENV} is set.`,
  ],
  options: { reject: { type: 'boolean' }, by: { type: 'string' }, reason: { type: 'string' }, run: { type: 'string' }, status: { type: 'string' }, all: { type: 'boolean' } },
  async run(ctx, values, args) {
    const sub = args[0];
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
    if (sub !== 'decide') throw new UsageError(sub === undefined ? 'missing sub-command (oracle proposals | oracle decide <proposalId>)' : `unknown sub-command oracle ${sub}`, 'oracle');
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
