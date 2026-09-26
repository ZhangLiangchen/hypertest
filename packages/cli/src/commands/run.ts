import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { HypertestError, isHypertestError } from '@hypertest/core';
import { isTerminalRun, type QualityDecision, type TargetRef, type TestRun } from '@hypertest/domain';
import type { HypertestConfig, HypertestInstance } from '@hypertest/app';
import { UsageError, flag, int, list, positionals, required, str } from '../args.ts';
import type { Command } from '../command.ts';
import { aborted, pause, withInstance, type CommandContext } from '../context.ts';
import { EXIT_CODES, verdictExitCode } from '../exit-codes.ts';
import { decisionLines, eventLine } from '../format.ts';

const exec = promisify(execFile);

/** Poll interval of the foreground wait (progress events, pause notices). */
export const WAIT_POLL_MS = 500;

/** Resolves a commit-ish to a full SHA in `repo` (so a run is pinned to an immutable commit, not a moving ref). */
export async function resolveCommit(repo: string, ref: string, what: string): Promise<string> {
  // a ref is never an option: `--commit=--output=x` must not reach git as a flag
  if (ref.startsWith('-') || ref.trim() === '' || /[\0\n]/.test(ref)) throw new UsageError(`${what} must be a commit-ish (got ${JSON.stringify(ref)})`, 'run');
  try {
    const { stdout } = await exec('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { timeout: 10_000 });
    const sha = stdout.trim();
    if (/^[0-9a-f]{40,64}$/.test(sha)) return sha;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HypertestError('precondition_failed', `git is not available: cannot resolve ${what} ${ref} (install git, see \`hypertest doctor\`)`);
  }
  throw new HypertestError('invalid_argument', `${what} ${JSON.stringify(ref)} is not a commit of ${repo}`);
}

/** The run target from the command line (usage error without any target). */
export async function targetFrom(ctx: CommandContext, values: Record<string, unknown>): Promise<TargetRef> {
  const v = values as Parameters<typeof str>[0];
  const target: TargetRef = {};
  const repo = str(v, 'repo');
  const commit = str(v, 'commit');
  const base = str(v, 'base');
  const url = str(v, 'url');
  const environment = str(v, 'environment');
  if (!repo && !url && !environment) throw new UsageError('a target is required: --repo <path>, --url <sutUrl> and/or --environment <id>', 'run');
  if ((commit || base) && !repo) throw new UsageError('--commit/--base need --repo', 'run');
  if (repo) {
    const path = resolve(ctx.io.cwd, repo);
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new UsageError(`--repo ${path} is not a directory`, 'run');
    target.repoPath = path;
    if (commit) target.commit = await resolveCommit(path, commit, '--commit');
    if (base) target.baseCommit = await resolveCommit(path, base, '--base');
  }
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new UsageError(`--url must be an absolute http(s) URL (got ${JSON.stringify(url)})`, 'run');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new UsageError(`--url must be an http(s) URL (got ${JSON.stringify(url)})`, 'run');
    target.sutUrl = url;
  }
  if (environment) target.environmentId = environment;
  const description = str(v, 'description');
  if (description) target.description = description;
  return target;
}

function labelsFrom(values: Parameters<typeof list>[0]): Record<string, string> | undefined {
  const raw = values['label'];
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  if (items.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const item of items) {
    const i = item.indexOf('=');
    const key = i > 0 ? item.slice(0, i).trim() : '';
    if (key === '') throw new UsageError(`--label must be key=value (got ${JSON.stringify(item)})`, 'run');
    out[key] = item.slice(i + 1).trim();
  }
  return out;
}

/**
 * --detach is only meaningful when something else drives the run (Temporal workers). Checked on the loaded configuration
 * before anything is opened; the detached process itself is a client only (no embedded worker: see clientOnlyConfig).
 */
function detachable(command: string): (config: HypertestConfig) => HypertestConfig {
  return (config) => {
    if (config.durable.kind !== 'temporal') {
      throw new HypertestError(
        'precondition_failed',
        `--detach needs durable.kind temporal: with the local durable runtime the run is driven by this process and would stop when \`hypertest ${command}\` exits (run in the foreground, or \`hypertest serve\`)`,
      );
    }
    return config;
  };
}

/** What an interrupted foreground wait means for the run, by durable runtime. */
function interruptedNotice(ht: HypertestInstance, runIds: string[]): string {
  const which = runIds.length === 1 ? `run ${runIds[0]}` : 'the runs';
  return ht.durable.kind === 'temporal'
    ? `interrupted: ${which} ${runIds.length === 1 ? 'keeps' : 'keep'} running on the Temporal workers (\`hypertest status\`)`
    : `interrupted: ${which} ${runIds.length === 1 ? 'is' : 'are'} resumable with \`hypertest resume\``;
}

interface WaitResult {
  interrupted: boolean;
  outcome?: { runId: string; status: TestRun['status']; decision?: QualityDecision };
}

/**
 * Waits for a run's outcome in the foreground: progress events (`--follow`, to stderr), a one-time notice when the run
 * pauses for a human decision, and interruption by `ctx.signal` (the run stays resumable).
 */
export async function waitForRun(ctx: CommandContext, ht: HypertestInstance, runId: string, options: { follow: boolean; timeoutMs?: number }): Promise<WaitResult> {
  const completion = ht.durable.awaitCompletion(runId, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {});
  completion.catch(() => undefined); // observed below; never an unhandled rejection after an interruption
  const stop = aborted(ctx.signal);
  const done = new AbortController();
  const progress = { lastSeq: 0 };
  const watcher = watch(ctx, ht, runId, options.follow, progress, done.signal);
  try {
    const first = await Promise.race([completion.then((o) => ({ kind: 'done' as const, o })), stop.promise.then(() => ({ kind: 'aborted' as const }))]);
    if (first.kind === 'aborted') return { interrupted: true };
    return { interrupted: false, outcome: first.o };
  } catch (e) {
    if (isHypertestError(e, 'timeout')) {
      throw new HypertestError('timeout', `run ${runId} did not complete within ${options.timeoutMs} ms; it is resumable with \`hypertest resume\``, { details: { runId } });
    }
    throw e;
  } finally {
    stop.dispose();
    done.abort();
    await watcher;
    // the events committed with the terminal transition (gate.evaluated, run.completed)
    if (options.follow && !ctx.signal.aborted) await printEvents(ctx, ht, runId, progress).catch(() => undefined);
  }
}

/** Prints the run's events after `progress.lastSeq` to stderr (pages of 500) and advances it. */
async function printEvents(ctx: CommandContext, ht: HypertestInstance, runId: string, progress: { lastSeq: number }): Promise<void> {
  for (;;) {
    const events = await ht.events(runId, { afterSeq: progress.lastSeq, limit: 500 });
    for (const e of events) {
      ctx.err(eventLine(e));
      progress.lastSeq = Math.max(progress.lastSeq, e.seq ?? progress.lastSeq);
    }
    if (events.length < 500) return;
  }
}

async function watch(ctx: CommandContext, ht: HypertestInstance, runId: string, follow: boolean, progress: { lastSeq: number }, stop: AbortSignal): Promise<void> {
  let noticed = false;
  while (!stop.aborted) {
    try {
      if (follow) await printEvents(ctx, ht, runId, progress);
      if (!noticed) {
        const run = await ht.status(runId);
        if (run?.status === 'paused' && run.pauseReason === 'approval') {
          const pending = await ht.listApprovals({ runId, status: ['pending'] });
          if (pending.length > 0) {
            noticed = true;
            ctx.err(`run ${runId} is waiting for a human decision:`);
            for (const a of pending) ctx.err(`  approval ${a.approvalId} (${a.kind}) requested by ${a.requestedBy.kind}:${a.requestedBy.id}`);
            ctx.err('  decide with `hypertest approve <approvalId> [--deny] --by <name> --reason "<text>"`');
            if (ht.config.store.kind === 'pglite') ctx.err('  (the embedded store admits one process: stop this command first — the run stays resumable — then approve and `hypertest resume`)');
          }
        }
      }
    } catch {
      // progress is best effort; the outcome comes from the durable runtime
    }
    if (await pause(WAIT_POLL_MS, stop)) break;
  }
}

/** Prints a finished run and returns its exit code (verdict-aware). */
function reportOutcome(ctx: CommandContext, outcome: NonNullable<WaitResult['outcome']>, manifestId: string): number {
  const verdict = outcome.status === 'completed' ? outcome.decision?.verdict : undefined;
  const code = verdictExitCode(verdict);
  if (ctx.global.json) {
    const d = outcome.decision;
    ctx.json({
      runId: outcome.runId, status: outcome.status, verdict: verdict ?? null, decisionId: d?.decisionId ?? null, requiresHumanReview: d?.requiresHumanReview ?? null,
      evidenceRootHash: d?.evidenceRootHash ?? null, runtimeManifestId: manifestId, exitCode: code,
    });
    return code;
  }
  if (outcome.status === 'completed' && outcome.decision) {
    ctx.out(`run ${outcome.runId} completed`);
    for (const l of decisionLines(outcome.decision)) ctx.out(l);
    ctx.out(`report: hypertest report ${outcome.runId}`);
  } else {
    ctx.out(`run ${outcome.runId} ended ${outcome.status} without a verdict (details: hypertest events ${outcome.runId})`);
  }
  return code;
}

const TARGET_OPTIONS = {
  repo: { type: 'string' },
  commit: { type: 'string' },
  base: { type: 'string' },
  url: { type: 'string' },
  environment: { type: 'string' },
  description: { type: 'string' },
} as const;

export const runCommand: Command = {
  name: 'run',
  summary: 'start a testing run for a goal and wait for its verdict',
  usage: ['run "<goal>" [--repo <path>] [--commit <sha>] [--base <sha>] [--url <sutUrl>] [--environment <id>] [--config <file>] [--detach] [--follow]'],
  optionHelp: [
    ['--repo <path>', 'repository under test (white-box); --commit/--base are resolved to full SHAs in it'],
    ['--commit <ref>', 'commit under test'],
    ['--base <ref>', 'base commit for change analysis'],
    ['--url <sutUrl>', 'base URL of a running system under test (black-box)'],
    ['--environment <id>', 'an environment registered in the configuration'],
    ['--description <text>', 'target description'],
    ['--label k=v', 'run label (repeatable)'],
    ['--run-id <id>', 'caller-chosen run id'],
    ['--timeout-ms <n>', 'stop waiting after n ms (the run stays resumable)'],
    ['--follow', 'print the run\'s events to stderr while waiting'],
    ['--detach', 'start the run and return: the Temporal workers drive it (durable.kind temporal only; this process hosts no worker and needs no brains)'],
    ['--scripted-brains <module>', 'brains for scripted providers (tests, eval, demos)'],
  ],
  notes: ['Exit code: pass 0, fail 3, conditional 4, inconclusive 5; 1 when the run ends without a verdict; 130 when interrupted (the run stays resumable; interrupted during startup, no run is created).'],
  options: { ...TARGET_OPTIONS, label: { type: 'string', multiple: true }, 'run-id': { type: 'string' }, 'timeout-ms': { type: 'string' }, detach: { type: 'boolean' }, follow: { type: 'boolean' } },
  longRunning: (values) => values['detach'] !== true,
  async run(ctx, values, args) {
    const [goal] = positionals('run', args, ['goal']);
    if (goal!.trim() === '') throw new UsageError('the goal must not be empty', 'run');
    const target = await targetFrom(ctx, values);
    const labels = labelsFrom(values);
    const runId = str(values, 'run-id');
    const timeoutMs = int('run', values, 'timeout-ms', { min: 1 });
    const detach = flag(values, 'detach');
    // a detached run is driven by the Temporal workers: this process only starts it
    return withInstance(ctx, { drivesAgents: !detach, ...(detach ? { adjust: detachable('run') } : {}) }, async ({ ht }) => {
      // interrupted while the instance was being composed: the run the user abandoned is never created (a later
      // `resume` or `serve` would otherwise drive it)
      if (ctx.signal.aborted) {
        ctx.err('interrupted before the run was started: no run was created');
        if (ctx.global.json) ctx.json({ runId: null, status: null, verdict: null, interrupted: true, runtimeManifestId: ht.manifest.manifestId, exitCode: EXIT_CODES.interrupted });
        return EXIT_CODES.interrupted;
      }
      const run = await ht.start({ goal: goal!, target, ...(labels ? { labels } : {}), ...(runId ? { runId } : {}) });
      if (detach) {
        if (ctx.global.json) ctx.json({ runId: run.runId, status: run.status, detached: true, runtimeManifestId: run.runtimeManifestId });
        else ctx.out(`run ${run.runId} started (detached; follow it with \`hypertest status ${run.runId}\`)`);
        return EXIT_CODES.ok;
      }
      if (!ctx.global.json) ctx.err(`run ${run.runId} started (runtime manifest ${run.runtimeManifestId})`);
      const waited = await waitForRun(ctx, ht, run.runId, { follow: flag(values, 'follow'), ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      if (waited.interrupted) {
        ctx.err(interruptedNotice(ht, [run.runId]));
        // --json: stdout still carries one document (the run id is what a caller needs to resume or follow the run)
        if (ctx.global.json) ctx.json({ runId: run.runId, status: null, verdict: null, interrupted: true, runtimeManifestId: ht.manifest.manifestId, exitCode: EXIT_CODES.interrupted });
        return EXIT_CODES.interrupted;
      }
      return reportOutcome(ctx, waited.outcome!, ht.manifest.manifestId);
    });
  },
};

export const resumeCommand: Command = {
  name: 'resume',
  summary: 'resume the incomplete runs pinned to this runtime (after a crash or an interruption)',
  usage: ['resume [--detach] [--follow] [--timeout-ms <n>]'],
  optionHelp: [
    ['--detach', 'only (re)start the durable workflows (durable.kind temporal only; this process hosts no worker)'],
    ['--follow', 'print the runs\' events to stderr while waiting'],
    ['--timeout-ms <n>', 'stop waiting after n ms'],
  ],
  notes: ['Exit code: 0 when every resumed run completed with a verdict, 1 otherwise; 130 when interrupted.'],
  options: { detach: { type: 'boolean' }, follow: { type: 'boolean' }, 'timeout-ms': { type: 'string' } },
  longRunning: (values) => values['detach'] !== true,
  async run(ctx, values, args) {
    positionals('resume', args, []);
    const detach = flag(values, 'detach');
    const timeoutMs = int('resume', values, 'timeout-ms', { min: 1 });
    return withInstance(ctx, { drivesAgents: !detach, ...(detach ? { adjust: detachable('resume') } : {}) }, async ({ ht }) => {
      if (ctx.signal.aborted) {
        ctx.err('interrupted before any run was resumed');
        if (ctx.global.json) ctx.json({ resumed: [], outcomes: [], interrupted: true });
        return EXIT_CODES.interrupted;
      }
      const ids = await ht.resumeIncomplete();
      if (ids.length === 0) {
        if (ctx.global.json) ctx.json({ resumed: [], outcomes: [] });
        else ctx.out('no incomplete runs pinned to this runtime');
        return EXIT_CODES.ok;
      }
      if (detach) {
        if (ctx.global.json) ctx.json({ resumed: ids, outcomes: [] });
        else for (const id of ids) ctx.out(`resumed ${id} (detached)`);
        return EXIT_CODES.ok;
      }
      if (!ctx.global.json) for (const id of ids) ctx.err(`resumed ${id}`);
      const outcomes: Array<{ runId: string; status: string; verdict: string | null; error?: string }> = [];
      let code: number = EXIT_CODES.ok;
      for (const id of ids) {
        let waited: WaitResult;
        try {
          waited = await waitForRun(ctx, ht, id, { follow: flag(values, 'follow'), ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
        } catch (e) {
          outcomes.push({ runId: id, status: 'unknown', verdict: null, error: (e as Error).message });
          code = EXIT_CODES.failure;
          if (!ctx.global.json) ctx.out(`run ${id}: ${(e as Error).message}`);
          continue;
        }
        if (waited.interrupted) {
          ctx.err(interruptedNotice(ht, ids));
          if (ctx.global.json) ctx.json({ resumed: ids, outcomes, interrupted: true });
          return EXIT_CODES.interrupted;
        }
        const o = waited.outcome!;
        const verdict = o.status === 'completed' ? (o.decision?.verdict ?? null) : null;
        outcomes.push({ runId: id, status: o.status, verdict });
        if (verdict === null) code = EXIT_CODES.failure;
        if (!ctx.global.json) {
          if (o.decision && o.status === 'completed') {
            ctx.out(`run ${id} completed`);
            for (const l of decisionLines(o.decision)) ctx.out(l);
          } else ctx.out(`run ${id} ended ${o.status} without a verdict`);
        }
      }
      if (ctx.global.json) ctx.json({ resumed: ids, outcomes });
      return code;
    });
  },
};

export const cancelCommand: Command = {
  name: 'cancel',
  summary: 'cancel a run (its open work is swept; a finished run keeps its outcome)',
  usage: ['cancel <runId> --reason "<text>"'],
  options: { reason: { type: 'string' } },
  async run(ctx, values, args) {
    const [runId] = positionals('cancel', args, ['runId']);
    const reason = required('cancel', values, 'reason');
    return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
      await ht.cancel(runId!, reason);
      const run = await ht.status(runId!);
      if (ctx.global.json) ctx.json({ runId, status: run?.status ?? null });
      else ctx.out(`run ${runId} ${run && isTerminalRun(run.status) ? run.status : 'cancellation requested'}`);
      return EXIT_CODES.ok;
    });
  },
};
