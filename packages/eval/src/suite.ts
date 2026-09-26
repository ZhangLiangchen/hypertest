/**
 * Suites: every task × trial × arm with PAIRED seeds (the same seed for every arm of a task/trial, arms in a seeded
 * random order per pair), per-arm aggregates (pass rate, pass^k, mean metrics) and paired comparisons (exact McNemar
 * on the discordant pairs + a paired bootstrap CI of the pass difference), and the markdown report.
 */
import { HypertestError } from '@hypertest/core';
import type { EvalSuite, EvalTrial, SuiteOptions, SuiteResult, TrialOptions } from './contracts.ts';
import { chaosProblems, runTrial } from './harness.ts';
import { resolveGrader } from './graders.ts';
import { mcnemarExact, pairedBootstrapCI, passHatK, seededShuffle } from './stats.ts';

/** The paired seed of a task/trial (identical for every arm). */
export function trialSeed(suite: Pick<EvalSuite, 'suiteId' | 'revision'>, taskId: string, trial: number): string {
  return `${suite.suiteId}@${suite.revision}/${taskId}#${trial}`;
}

function validateSuite(suite: EvalSuite, options: SuiteOptions): void {
  if (!suite || typeof suite.suiteId !== 'string' || !Array.isArray(suite.tasks)) throw new HypertestError('invalid_argument', 'suite must have a suiteId and tasks');
  if (!Array.isArray(options?.arms) || options.arms.length === 0) throw new HypertestError('invalid_argument', 'SuiteOptions.arms must list at least one arm');
  if (!Number.isSafeInteger(options.trials) || options.trials < 1) throw new HypertestError('invalid_argument', `SuiteOptions.trials must be a positive integer, got ${String(options.trials)}`);
  const armIds = options.arms.map((a) => a.armId);
  if (new Set(armIds).size !== armIds.length) throw new HypertestError('invalid_argument', `arm ids must be unique: ${armIds.join(', ')}`);
  const taskIds = suite.tasks.map((t) => t.taskId);
  if (new Set(taskIds).size !== taskIds.length) throw new HypertestError('invalid_argument', `task ids must be unique in suite ${suite.suiteId}`);
  // a malformed suite is refused before its first trial (runTrial would record the same fault once per trial)
  for (const task of suite.tasks) {
    if (!Array.isArray(task.graders) || task.graders.length === 0) throw new HypertestError('invalid_argument', `task ${task.taskId} lists no graders`);
    for (const spec of task.graders) resolveGrader(spec, options.graders);
    const chaos = chaosProblems(task.chaos);
    if (chaos.length > 0) throw new HypertestError('invalid_argument', `task ${task.taskId}: ${chaos.join('; ')}`);
  }
  if (options.mode === 'child-process') {
    const missing = options.arms.filter((a) => !a.child).map((a) => a.armId);
    if (missing.length > 0) throw new HypertestError('invalid_argument', `child-process trials need EvalArm.child; missing for arm(s) ${missing.join(', ')}`);
  }
}

/** Runs the suite sequentially (trials use real processes and ports; concurrency would add interference). */
export async function runSuite(suite: EvalSuite, options: SuiteOptions): Promise<SuiteResult> {
  validateSuite(suite, options);
  const trials: EvalTrial[] = [];
  const cancelled = () =>
    new HypertestError('cancelled', `suite ${suite.suiteId} was cancelled after ${trials.length} trial(s)`, { details: { completedTrials: trials.length, trials: trials.map((x) => ({ taskId: x.taskId, armId: x.armId, trial: x.trial, result: x.result })) } });
  for (const task of suite.tasks) {
    for (let t = 0; t < options.trials; t++) {
      const seed = trialSeed(suite, task.taskId, t);
      for (const arm of seededShuffle(options.arms, seed)) {
        if (options.signal?.aborted) throw cancelled();
        const o: TrialOptions = { workDir: options.workDir, trial: t, seed };
        if (options.signal) o.signal = options.signal;
        if (options.baseConfig) o.baseConfig = options.baseConfig;
        if (options.timeoutMs !== undefined) o.timeoutMs = options.timeoutMs;
        if (options.mode) o.mode = options.mode;
        if (options.graders) o.graders = options.graders;
        if (options.logger) o.logger = options.logger;
        if (options.keepWorkDir !== undefined) o.keepWorkDir = options.keepWorkDir;
        if (options.probeTimeoutMs !== undefined) o.probeTimeoutMs = options.probeTimeoutMs;
        const trial = await runTrial(task, arm, o);
        trials.push(trial);
        options.onTrial?.(trial);
      }
    }
  }
  if (options.signal?.aborted) throw cancelled(); // the last trial was cancelled: never summarize a partial suite
  return summarizeSuite(suite, options.arms.map((a) => a.armId), trials);
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Aggregates trials into a SuiteResult. Per arm: `passRate` over graded trials (infra errors excluded and counted in
 * `metrics.infraErrors`), `passHatK` = mean over tasks of pass^k with k = the task's graded trials (1 exactly when
 * every graded trial of the task passed), `metrics` = means of every outcome metric (over the graded trials that
 * report it), `traj.<name>` means of the explanatory trajectory metrics, plus `trials`, `graded`, `infraErrors`,
 * `durationMs`. Comparisons for every arm pair (in the given order): discordant pairs b (A pass, B fail) and c
 * (A fail, B pass) over the (task, trial) pairs graded in both arms, exact McNemar p, and the paired bootstrap CI of
 * passA − passB (seeded by the suite).
 */
export function summarizeSuite(suite: Pick<EvalSuite, 'suiteId' | 'revision'>, armIds: readonly string[], trials: readonly EvalTrial[]): SuiteResult {
  const perArm: SuiteResult['perArm'] = {};
  for (const armId of armIds) {
    const own = trials.filter((t) => t.armId === armId);
    const graded = own.filter((t) => t.result !== 'infra_error');
    const metrics: Record<string, number> = { trials: own.length, graded: graded.length, infraErrors: own.length - graded.length, durationMs: mean(graded.map((t) => t.durationMs)) };
    const outcomeKeys = [...new Set(graded.flatMap((t) => Object.keys(t.outcomeMetrics)))].sort();
    for (const k of outcomeKeys) metrics[k] = mean(graded.filter((t) => Object.hasOwn(t.outcomeMetrics, k)).map((t) => t.outcomeMetrics[k]!));
    const trajKeys = [...new Set(graded.flatMap((t) => Object.keys(t.trajectoryMetrics)))].sort();
    for (const k of trajKeys) metrics[`traj.${k}`] = mean(graded.filter((t) => Object.hasOwn(t.trajectoryMetrics, k)).map((t) => t.trajectoryMetrics[k]!));
    const byTask = new Map<string, boolean[]>();
    for (const t of graded) {
      if (!byTask.has(t.taskId)) byTask.set(t.taskId, []);
      byTask.get(t.taskId)!.push(t.result === 'pass');
    }
    const hat = [...byTask.values()].map((r) => passHatK(r, r.length));
    perArm[armId] = { passRate: graded.length === 0 ? 0 : graded.filter((t) => t.result === 'pass').length / graded.length, passHatK: mean(hat), metrics };
  }
  const comparisons: SuiteResult['comparisons'] = [];
  for (let i = 0; i < armIds.length; i++) {
    for (let j = i + 1; j < armIds.length; j++) {
      const a = armIds[i]!;
      const b = armIds[j]!;
      const key = (t: EvalTrial): string => `${t.taskId}\u0000${t.trial}`;
      const bTrials = new Map(trials.filter((t) => t.armId === b && t.result !== 'infra_error').map((t) => [key(t), t]));
      let discordantB = 0;
      let discordantC = 0;
      const diffs: number[] = [];
      for (const ta of trials) {
        if (ta.armId !== a || ta.result === 'infra_error') continue;
        const tb = bTrials.get(key(ta));
        if (!tb) continue;
        const pa = ta.result === 'pass' ? 1 : 0;
        const pb = tb.result === 'pass' ? 1 : 0;
        if (pa === 1 && pb === 0) discordantB++;
        if (pa === 0 && pb === 1) discordantC++;
        diffs.push(pa - pb);
      }
      const cmp: SuiteResult['comparisons'][number] = { armA: a, armB: b, mcnemarP: mcnemarExact(discordantB, discordantC), b: discordantB, c: discordantC, pairs: diffs.length };
      if (diffs.length > 0) cmp.passDiffCI = pairedBootstrapCI(diffs, { seed: `${suite.suiteId}@${suite.revision}:${a}:${b}` });
      comparisons.push(cmp);
    }
  }
  return { suiteId: suite.suiteId, revision: suite.revision, trials: [...trials], perArm, comparisons };
}

// ------------------------------------------------------------------------------------------------ report

function fmt(n: number | undefined, digits = 3): string {
  if (n === undefined || !Number.isFinite(n)) return '–';
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Outcome metrics shown per arm (in this order) when any trial reports them. */
const HEADLINE = ['criticalFalseRelease', 'defectRecall', 'falseFail', 'duplicateSideEffects', 'orphanOperations', 'policyViolations', 'staleContextActions', 'evidenceCompleteness'];

/** Markdown report of a suite result (deterministic: no timestamps). Trajectory metrics are labelled explanatory. */
export function renderSuiteReport(result: SuiteResult): string {
  const arms = Object.keys(result.perArm);
  const lines: string[] = [];
  lines.push(`# Eval suite ${result.suiteId} (revision ${result.revision})`, '');
  lines.push(`${result.trials.length} trial(s), ${arms.length} arm(s). Outcome graders decide pass/fail; infra errors are excluded from rates.`, '');
  lines.push('## Arms', '');
  const shown = HEADLINE.filter((k) => arms.some((a) => Object.hasOwn(result.perArm[a]!.metrics, k)));
  lines.push(`| arm | pass rate | pass^k | graded | infra errors | ${shown.join(' | ')} |`);
  lines.push(`|---|---|---|---|---|${shown.map(() => '---|').join('')}`);
  for (const a of arms) {
    const r = result.perArm[a]!;
    lines.push(`| ${cell(a)} | ${fmt(r.passRate)} | ${fmt(r.passHatK)} | ${fmt(r.metrics['graded'])} | ${fmt(r.metrics['infraErrors'])} | ${shown.map((k) => fmt(r.metrics[k])).join(' | ')} |`);
  }
  lines.push('');
  if (result.comparisons.length > 0) {
    lines.push('## Paired comparisons', '');
    lines.push('| arm A | arm B | pairs | b (A only) | c (B only) | McNemar p | passA − passB (95% CI) |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const c of result.comparisons) {
      const ci = c.passDiffCI ? `${fmt(c.passDiffCI.mean)} [${fmt(c.passDiffCI.lo)}, ${fmt(c.passDiffCI.hi)}]` : '–';
      lines.push(`| ${cell(c.armA)} | ${cell(c.armB)} | ${fmt(c.pairs)} | ${c.b} | ${c.c} | ${fmt(c.mcnemarP, 4)} | ${ci} |`);
    }
    lines.push('');
  }
  lines.push('## Trials', '');
  lines.push('| task | arm | trial | result | verdict | failed graders | note |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const t of result.trials) {
    const failed = t.graders.filter((g) => !g.pass).map((g) => `${g.graderId}: ${g.detail}`);
    lines.push(`| ${cell(t.taskId)} | ${cell(t.armId)} | ${t.trial} | ${t.result} | ${t.verdict ?? '–'} | ${cell(failed.join('; ') || '–')} | ${cell(t.error ?? '')} |`);
  }
  lines.push('');
  const traj = arms.flatMap((a) => Object.keys(result.perArm[a]!.metrics).filter((k) => k.startsWith('traj.')));
  if (traj.length > 0) {
    const keys = [...new Set(traj)].sort();
    lines.push('## Trajectory (explanatory only — never a success criterion)', '');
    lines.push(`| metric | ${arms.map(cell).join(' | ')} |`);
    lines.push(`|---|${arms.map(() => '---|').join('')}`);
    for (const k of keys) lines.push(`| ${k.slice('traj.'.length)} | ${arms.map((a) => fmt(result.perArm[a]!.metrics[k])).join(' | ')} |`);
    lines.push('');
  }
  return lines.join('\n');
}
