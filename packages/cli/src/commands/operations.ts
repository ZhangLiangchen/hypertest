import { HypertestError } from '@hypertest/core';
import type { OperationStatus } from '@hypertest/domain';
import { UsageError, flag, int, list, positionals, required, str } from '../args.ts';
import type { Command } from '../command.ts';
import { withInstance } from '../context.ts';
import { EXIT_CODES } from '../exit-codes.ts';
import { table, truncate } from '../format.ts';
import { SANDBOX_ENV } from './decide.ts';

const OPERATION_STATUSES: readonly OperationStatus[] = ['prepared', 'dispatching', 'acknowledged', 'verified', 'not_applied', 'outcome_unknown', 'reconciling', 'compensating', 'compensated', 'manual_review', 'failed'];
const OUTCOMES = ['succeeded', 'failed', 'compensated'] as const;

/**
 * (stubs[8]) `hypertest operations`: the side-effect operations a human must look at. An operation whose outcome could
 * not be reconciled is escalated to `manual_review` and never retried blindly; the work item that issued it waits. A
 * human checks the target and records what happened — `succeeded` (⇒ verified), `failed` (⇒ failed) or `compensated`
 * (⇒ compensated) — audited on L0 (`operation.resolved`); the waiting work resumes with that outcome.
 */
export const operationsCommand: Command = {
  name: 'operations',
  summary: 'side-effect operations: list those awaiting manual review; resolve one as a human',
  usage: [
    'operations list [--run <runId>] [--status s1,s2 | --all] [--limit <n>] [--json]',
    'operations resolve <operationId> --outcome succeeded|failed|compensated --by <name> --note "<what you checked>"',
  ],
  notes: [
    '`list` shows the operations under manual review by default (of every run, or of --run).',
    'Agents never resolve operations: an agent would otherwise declare its own unknown side effect a success. `resolve` is refused (permission_denied) when $' + SANDBOX_ENV + ' is set.',
  ],
  options: { run: { type: 'string' }, status: { type: 'string' }, all: { type: 'boolean' }, limit: { type: 'string' }, outcome: { type: 'string' }, by: { type: 'string' }, note: { type: 'string' } },
  async run(ctx, values, args) {
    const sub = args[0];
    if (sub === 'list') {
      positionals('operations', args, ['list']);
      const statuses = list(values, 'status');
      for (const s of statuses) if (!(OPERATION_STATUSES as readonly string[]).includes(s)) throw new UsageError(`--status: unknown operation status ${JSON.stringify(s)} (${OPERATION_STATUSES.join(', ')})`, 'operations');
      if (statuses.length > 0 && flag(values, 'all')) throw new UsageError('--status and --all are mutually exclusive', 'operations');
      const limit = int('operations', values, 'limit', { min: 1, max: 10_000 });
      const runId = str(values, 'run');
      const filter: { runId?: string; status: OperationStatus[]; limit?: number } = { status: flag(values, 'all') ? [...OPERATION_STATUSES] : statuses.length > 0 ? (statuses as OperationStatus[]) : ['manual_review'] };
      if (runId) filter.runId = runId;
      if (limit !== undefined) filter.limit = limit;
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const ops = await ht.listOperations(filter);
        if (ctx.global.json) {
          ctx.json(ops);
          return EXIT_CODES.ok;
        }
        if (ops.length === 0) {
          ctx.out(`no ${statuses.length > 0 || flag(values, 'all') ? '' : 'manual_review '}operations${runId ? ` for run ${runId}` : ''}`);
          return EXIT_CODES.ok;
        }
        const rows = ops.map((o) => [o.operationId, o.runId, o.operationType, o.target.resourceKey, o.status, String(o.attempt), truncate(o.lastError ?? '', 60)]);
        for (const l of table(['OPERATION', 'RUN', 'TYPE', 'TARGET', 'STATUS', 'ATTEMPT', 'REASON'], rows)) ctx.out(l);
        return EXIT_CODES.ok;
      });
    }
    if (sub === 'resolve') {
      const [, operationId] = positionals('operations', args, ['resolve', 'operationId']);
      const outcome = required('operations', values, 'outcome');
      if (!(OUTCOMES as readonly string[]).includes(outcome)) throw new UsageError(`--outcome must be one of ${OUTCOMES.join(', ')} (got ${JSON.stringify(outcome)})`, 'operations');
      const by = required('operations', values, 'by').trim();
      if (!/^[\p{L}\p{N}._@+-][\p{L}\p{N}._@+\- ]{0,127}$/u.test(by)) throw new UsageError(`--by must be a person's name or handle (letters, digits, . _ @ + -), got ${JSON.stringify(by)}`, 'operations');
      const note = required('operations', values, 'note');
      if (ctx.io.env[SANDBOX_ENV]) {
        throw new HypertestError('permission_denied', `operations resolve is a human decision and cannot be taken from inside a Hypertest sandbox (${SANDBOX_ENV} is set): an agent never resolves its own side effect`);
      }
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const op = await ht.resolveOperation(operationId!, outcome as (typeof OUTCOMES)[number], { kind: 'human', id: by }, note);
        if (ctx.global.json) ctx.json({ operationId: op.operationId, runId: op.runId, status: op.status, outcome, resolvedBy: `human:${by}` });
        else ctx.out(`operation ${op.operationId} resolved ${outcome} (now ${op.status}) by human:${by} (run ${op.runId})`);
        return EXIT_CODES.ok;
      });
    }
    throw new UsageError(sub === undefined ? 'missing sub-command (operations list | operations resolve <operationId>)' : `unknown sub-command operations ${sub}`, 'operations');
  },
};
