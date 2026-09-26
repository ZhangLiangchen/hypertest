import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HypertestError } from '@hypertest/core';
import { isTerminalRun, type QualityDecision, type RunStatus, type TestRun } from '@hypertest/domain';
import type { HypertestInstance } from '@hypertest/app';
import { UsageError, flag, int, list, positionals, str } from '../args.ts';
import type { Command } from '../command.ts';
import { pause, withInstance, type CommandContext } from '../context.ts';
import { EXIT_CODES } from '../exit-codes.ts';
import { eventLine, runLines, table, truncate, verdictLabel } from '../format.ts';

const RUN_STATUSES: readonly RunStatus[] = ['created', 'running', 'paused', 'converging', 'gating', 'completed', 'failed', 'cancelled'];
/** Poll interval of `events --follow` (as the API's SSE stream). */
export const FOLLOW_POLL_MS = 500;
/** Quiet polls after the run became terminal before `events --follow` ends (the terminal events are always printed first). */
export const FOLLOW_QUIET_POLLS = 2;

async function requireRun(ht: HypertestInstance, runId: string) {
  const run = await ht.status(runId);
  if (!run) throw new HypertestError('not_found', `run ${runId} not found`);
  return run;
}

/**
 * The run's decisions as the report reads them: only the FINAL decision (`run.decisionId`, set when the run completes)
 * is its verdict. While the gate's feedback loop sends the lead back for more evidence the latest decision is an interim
 * audit record — it is returned separately and never presented as the verdict.
 */
export async function runDecisions(ht: HypertestInstance, run: TestRun): Promise<{ decision?: QualityDecision; interim?: QualityDecision }> {
  const decision = run.decisionId ? await ht.services.decisions.get(run.decisionId) : undefined;
  if (decision) return { decision };
  const interim = await ht.services.decisions.latestForRun(run.runId);
  return interim ? { interim } : {};
}

export const statusCommand: Command = {
  name: 'status',
  summary: 'show one run, or list runs (newest first)',
  usage: ['status [<runId>] [--status s1,s2] [--limit n] [--json]'],
  optionHelp: [
    ['--status <list>', `filter the list by status (${RUN_STATUSES.join(', ')})`],
    ['--limit <n>', 'list at most n runs (default 20)'],
  ],
  options: { status: { type: 'string' }, limit: { type: 'string' } },
  async run(ctx, values, args) {
    const [runId] = positionals('status', args, [], ['runId']);
    const statuses = list(values, 'status');
    for (const s of statuses) if (!(RUN_STATUSES as readonly string[]).includes(s)) throw new UsageError(`--status: unknown run status ${JSON.stringify(s)} (${RUN_STATUSES.join(', ')})`, 'status');
    const limit = int('status', values, 'limit', { min: 1, max: 10_000 }) ?? 20;
    return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
      if (runId !== undefined) {
        const run = await requireRun(ht, runId);
        const { decision, interim } = await runDecisions(ht, run);
        const reassessment = decision ? await ht.services.decisions.reassessment(decision.decisionId) : undefined;
        if (ctx.global.json) ctx.json({ run, decision: decision ?? null, interimDecision: interim ?? null, needsReassessment: reassessment?.needsReassessment ?? false });
        else for (const l of runLines(run, decision, reassessment, interim)) ctx.out(l);
        return EXIT_CODES.ok;
      }
      const runs = await ht.listRuns({ ...(statuses.length > 0 ? { status: statuses as RunStatus[] } : {}), limit });
      const rows = [];
      for (const run of runs) {
        const decision = run.decisionId ? await ht.services.decisions.get(run.decisionId) : undefined;
        rows.push({ run, verdict: decision?.verdict });
      }
      if (ctx.global.json) {
        ctx.json(rows.map(({ run, verdict }) => ({ ...run, verdict: verdict ?? null })));
        return EXIT_CODES.ok;
      }
      if (rows.length === 0) {
        ctx.out('no runs');
        return EXIT_CODES.ok;
      }
      for (const l of table(['RUN', 'STATUS', 'VERDICT', 'CREATED', 'GOAL'], rows.map(({ run, verdict }) => [run.runId, run.status, verdictLabel(verdict), run.createdAt, truncate(run.goal, 60)]))) ctx.out(l);
      return EXIT_CODES.ok;
    });
  },
};

export const reportCommand: Command = {
  name: 'report',
  summary: 'the run report (markdown, or --json) built from claims, evidence and the gate decision',
  usage: ['report <runId> [--json] [--out <file>]'],
  optionHelp: [['--out <file>', 'write the report to a file instead of stdout']],
  options: { out: { type: 'string' } },
  async run(ctx, values, args) {
    const [runId] = positionals('report', args, ['runId']);
    return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
      await requireRun(ht, runId!);
      const report = await ht.report(runId!);
      const text = ctx.global.json ? `${JSON.stringify(report.json, null, 2)}\n` : report.markdown;
      const out = str(values, 'out');
      if (out) {
        const file = resolve(ctx.io.cwd, out);
        await writeFile(file, text);
        ctx.err(`wrote ${file} (verdict ${verdictLabel(report.verdict)})`);
      } else ctx.io.stdout.write(text);
      return EXIT_CODES.ok;
    });
  },
};

async function printPage(ctx: CommandContext, ht: HypertestInstance, runId: string, state: { lastSeq: number }, types: string[]): Promise<number> {
  let printed = 0;
  for (;;) {
    const events = await ht.events(runId, { afterSeq: state.lastSeq, limit: 500, ...(types.length > 0 ? { types } : {}) });
    for (const e of events) {
      if (ctx.global.json) ctx.io.stdout.write(`${JSON.stringify(e)}\n`);
      else ctx.out(eventLine(e));
      state.lastSeq = Math.max(state.lastSeq, e.seq ?? state.lastSeq);
      printed++;
    }
    if (events.length < 500) return printed;
  }
}

export const eventsCommand: Command = {
  name: 'events',
  summary: 'the run\'s L0 events in seq order (--json: one event per line)',
  usage: ['events <runId> [--follow] [--after <seq>] [--types t1,t2] [--json]'],
  optionHelp: [
    ['--follow', 'keep printing new events until the run is finished'],
    ['--after <seq>', 'only events after this seq'],
    ['--types <list>', 'only these event types'],
  ],
  notes: ['With the embedded PGlite store, one process owns the data directory: follow a run from the process that drives it (`hypertest run --follow`) or use PostgreSQL / the API (`hypertest serve`).'],
  options: { follow: { type: 'boolean' }, after: { type: 'string' }, types: { type: 'string' } },
  longRunning: (values) => values['follow'] === true,
  async run(ctx, values, args) {
    const [runId] = positionals('events', args, ['runId']);
    const after = int('events', values, 'after', { min: 0 }) ?? 0;
    const types = list(values, 'types');
    const follow = flag(values, 'follow');
    return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
      await requireRun(ht, runId!);
      const state = { lastSeq: after };
      if (!follow) {
        await printPage(ctx, ht, runId!, state, types);
        return EXIT_CODES.ok;
      }
      let quiet = 0;
      for (;;) {
        // the status is read BEFORE the events: events committed with the terminal transition are never missed
        const run = await ht.status(runId!);
        const printed = await printPage(ctx, ht, runId!, state, types);
        if (run && isTerminalRun(run.status)) {
          quiet = printed === 0 ? quiet + 1 : 0;
          if (quiet >= FOLLOW_QUIET_POLLS) return EXIT_CODES.ok;
        }
        if (await pause(FOLLOW_POLL_MS, ctx.signal)) return EXIT_CODES.interrupted;
      }
    });
  },
};

export const evidenceCommand: Command = {
  name: 'evidence',
  summary: 'verify a run\'s evidence chain, artifacts, seals and signed verdict',
  usage: ['evidence verify <runId> [--json]'],
  notes: ['Exit code 0 when the evidence verifies, 1 with the problems listed otherwise.'],
  options: {},
  async run(ctx, _values, args) {
    const [sub, runId] = positionals('evidence', args, ['verify', 'runId']);
    if (sub !== 'verify') throw new UsageError(`unknown sub-command evidence ${sub} (evidence verify <runId>)`, 'evidence');
    return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
      await requireRun(ht, runId!);
      const result = await ht.verifyEvidence(runId!);
      const root = await ht.services.evidence.rootHash(runId!);
      const seal = await ht.services.evidence.latestSeal(runId!);
      if (ctx.global.json) {
        ctx.json({ runId, ok: result.ok, problems: result.problems, records: root.count, rootHash: root.rootHash, sealed: seal !== undefined });
      } else if (result.ok) {
        ctx.out(`evidence of run ${runId} verified: ${root.count} records, root ${root.rootHash}${seal ? `, sealed by ${seal.keyId}` : ', not sealed'}`);
      } else {
        ctx.out(`evidence of run ${runId} FAILED verification (${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}):`);
        for (const p of result.problems) ctx.out(`  - ${p}`);
      }
      return result.ok ? EXIT_CODES.ok : EXIT_CODES.failure;
    });
  },
};
