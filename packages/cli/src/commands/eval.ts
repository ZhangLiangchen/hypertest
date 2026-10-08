import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HypertestError, isHypertestError } from '@hypertest/core';
import { deriveRouteScores, loadConfig, mergeConfig, type HypertestConfig, type HypertestConfigInput, type ScoredTrial } from '@hypertest/app';
import type { EvalArm, EvalSuite, ReleaseGateOptions, ReleaseGateReport, SuiteOptions, SuiteResult } from '@hypertest/eval';
import { UsageError, flag, int, list, positionals, required, str } from '../args.ts';
import type { Command } from '../command.ts';
import { aborted, brainMap, findConfig, isPlainObject, loadBrainsModule, type CommandContext } from '../context.ts';
import type { EvalModuleLike } from '../contracts.ts';
import { EXIT_CODES } from '../exit-codes.ts';
import { table } from '../format.ts';

/** `poc-a-whitebox` → `pocAWhiteboxSuite` (the factory names of the eval contract). */
export function suiteFactoryName(suiteId: string): string {
  return `${suiteId.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}Suite`;
}

/** `pocAWhiteboxSuite` → `poc-a-whitebox`. */
export function suiteIdOf(factoryName: string): string {
  return factoryName.replace(/Suite$/, '').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function isSuite(v: unknown): v is EvalSuite {
  return isPlainObject(v) && typeof v['suiteId'] === 'string' && Array.isArray(v['tasks']);
}

/** Suites the eval module offers, by id. */
export function availableSuites(ev: EvalModuleLike): Map<string, () => EvalSuite> {
  const out = new Map<string, () => EvalSuite>();
  for (const [name, value] of Object.entries(ev)) {
    // suite factories (`pocAWhiteboxSuite`), not verbs over suites (`runSuite`, `createSuite`, …)
    if (/^[a-z][A-Za-z0-9]*Suite$/.test(name) && !/^(run|create|build|render|load|make|new|define)([A-Z]|$)/.test(name.replace(/Suite$/, '')) && typeof value === 'function') {
      out.set(suiteIdOf(name), value as () => EvalSuite);
    }
  }
  if (isPlainObject(ev.suites)) {
    for (const [id, value] of Object.entries(ev.suites)) {
      if (typeof value === 'function') out.set(id, value as () => EvalSuite);
      else if (isSuite(value)) out.set(id, () => value);
    }
  }
  return out;
}

function armsFrom(value: unknown, into: Map<string, EvalArm>): void {
  const items = Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : [];
  for (const a of items) if (isPlainObject(a) && typeof a['armId'] === 'string' && typeof a['config'] === 'function') into.set(a['armId'], a as unknown as EvalArm);
}

/** Arms the eval module offers (`arms`, `builtinArms()`, `defaultArms()`, `ARMS`) and arms a suite carries (`suite.arms`), by id. */
export function availableArms(ev: EvalModuleLike, suite?: EvalSuite): Map<string, EvalArm> {
  const out = new Map<string, EvalArm>();
  if (suite) armsFrom((suite as EvalSuite & { arms?: unknown }).arms, out);
  armsFrom(ev.arms, out);
  for (const factory of [ev.builtinArms, ev.defaultArms]) if (typeof factory === 'function') armsFrom(factory(), out);
  armsFrom(ev.ARMS, out);
  return out;
}

/**
 * The CLI's own `config` arm: the configuration's models (providers, routes, default policy) and role policies over
 * the trial's base configuration (fresh store per trial), with the `--scripted-brains` brains when given.
 */
async function configArm(ctx: CommandContext): Promise<EvalArm | undefined> {
  const path = findConfig(ctx.io, ctx.global.config);
  if (!path) return undefined;
  const config = await loadConfig(path, { env: ctx.io.env });
  const patch: HypertestConfigInput = { models: config.models };
  if (config.roles) patch.roles = config.roles;
  const arm: EvalArm = {
    armId: 'config',
    description: `models and role policies of ${path}`,
    config: (base: HypertestConfig) => mergeConfig(base, patch),
  };
  if (ctx.global.scriptedBrains !== undefined) {
    const mod = await loadBrainsModule(ctx, ctx.global.scriptedBrains);
    if (mod.evalBrains) arm.brains = mod.evalBrains;
    else {
      const brains = await brainMap(ctx, mod, config, ctx.global.scriptedBrains);
      arm.brains = () => brains;
    }
  }
  return arm;
}

function summaryLines(result: SuiteResult): string[] {
  const lines = [`suite ${result.suiteId} (revision ${result.revision}): ${result.trials.length} trial${result.trials.length === 1 ? '' : 's'}`, ''];
  lines.push(...table(['ARM', 'PASS RATE', 'PASS^K'], Object.entries(result.perArm).map(([arm, s]) => [arm, s.passRate.toFixed(3), s.passHatK.toFixed(3)])));
  lines.push('');
  lines.push(...table(['TASK', 'ARM', 'TRIAL', 'RESULT', 'VERDICT', 'RUN'], result.trials.map((t) => [t.taskId, t.armId, String(t.trial), t.result, t.verdict ?? '-', t.runId ?? '-'])));
  for (const t of result.trials.filter((x) => x.error)) lines.push(`  ${t.taskId}/${t.armId}#${t.trial}: ${t.error}`);
  if (result.comparisons.length > 0) {
    lines.push('');
    lines.push(...table(['ARM A', 'ARM B', 'B', 'C', 'MCNEMAR P'], result.comparisons.map((c) => [c.armA, c.armB, String(c.b), String(c.c), c.mcnemarP.toFixed(4)])));
  }
  return lines;
}

/** Writes an output file (its directory is created) and says so on stderr. */
async function writeOutput(ctx: CommandContext, path: string, text: string): Promise<void> {
  const file = resolve(ctx.io.cwd, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  ctx.err(`wrote ${file}`);
}

/** Reads a SuiteResult JSON file (`eval run --out`); unreadable or malformed ⇒ usage error naming the file. */
async function readSuiteResult(ctx: CommandContext, option: string, path: string): Promise<SuiteResult> {
  const file = resolve(ctx.io.cwd, path);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    throw new UsageError(`--${option} ${path} cannot be read: ${(e as Error).message}`, 'eval');
  }
  try {
    return JSON.parse(text) as SuiteResult;
  } catch (e) {
    throw new UsageError(`--${option} ${path} is not JSON: ${(e as Error).message}`, 'eval');
  }
}

/** `eval gate`: the eval release gate over two persisted suite results ⇒ exit 0 (pass) / 1 (fail) with a report. */
async function gate(ctx: CommandContext, values: Parameters<Command['run']>[1], args: string[]): Promise<number> {
  positionals('eval', args, ['gate']);
  const baselinePath = required('eval', values, 'baseline');
  const candidatePath = required('eval', values, 'candidate');
  const options: ReleaseGateOptions = {};
  const baselineArm = str(values, 'baseline-arm');
  const candidateArm = str(values, 'candidate-arm');
  if (baselineArm !== undefined) options.baselineArm = baselineArm;
  if (candidateArm !== undefined) options.candidateArm = candidateArm;
  const alpha = str(values, 'alpha');
  if (alpha !== undefined) {
    const a = Number(alpha);
    if (!(Number.isFinite(a) && a > 0 && a < 1)) throw new UsageError(`--alpha must be a number in (0, 1) (got ${JSON.stringify(alpha)})`, 'eval');
    options.alpha = a;
  }
  const baseline = await readSuiteResult(ctx, 'baseline', baselinePath);
  const candidate = await readSuiteResult(ctx, 'candidate', candidatePath);
  let ev: EvalModuleLike;
  try {
    ev = await ctx.io.loadEval();
  } catch (e) {
    throw new HypertestError('unavailable', `the eval platform (@hypertest/eval) could not be loaded: ${(e as Error).message}`, { cause: e });
  }
  if (typeof ev.evaluateReleaseGate !== 'function') throw new HypertestError('unsupported', '@hypertest/eval does not export evaluateReleaseGate: this build has no eval release gate');
  let report: ReleaseGateReport;
  try {
    report = ev.evaluateReleaseGate(baseline, candidate, options);
  } catch (e) {
    // malformed inputs (not a suite result, an unknown or ambiguous arm) are the caller's to fix
    if (isHypertestError(e, 'invalid_argument')) throw new UsageError(e.message, 'eval');
    throw e;
  }
  const text = ctx.global.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${(typeof ev.renderReleaseGateReport === 'function' ? ev.renderReleaseGateReport(report) : report.checks.map((c) => `${c.pass ? 'pass' : 'FAIL'}  ${c.description}: ${c.detail}`).join('\n')).trimEnd()}\n`;
  ctx.io.stdout.write(text);
  const reportFile = str(values, 'report');
  if (reportFile) await writeOutput(ctx, reportFile, text);
  if (!ctx.global.json) ctx.err(`eval gate ${report.suiteId}: ${report.pass ? 'PASS' : 'FAIL'} (${report.checks.filter((c) => !c.pass).map((c) => c.checkId).join(', ') || 'every check passed'})`);
  return report.pass ? EXIT_CODES.ok : EXIT_CODES.failure;
}

/** The suite with the independent LLM judge appended (last) to every task that does not list it already. */
export function withJudge(suite: EvalSuite): EvalSuite {
  return { ...suite, tasks: suite.tasks.map((t) => (t.graders.some((g) => g.split('?')[0] === 'llmRubric') ? t : { ...t, graders: [...t.graders, 'llmRubric'] })) };
}

/**
 * (coverage[7]) `eval apply-scores`: the auditable path from eval results to routing — a SuiteResult (eval run --out)
 * becomes a RouteScoresFile (scores + provenance) that models.scoresFile merges into the catalog.
 */
async function applyScores(ctx: CommandContext, values: Parameters<Command['run']>[1], args: string[]): Promise<number> {
  const [, input] = positionals('eval', args, ['apply-scores', 'suite-result.json']);
  const out = required('eval', values, 'out');
  const minTrials = int('eval', values, 'min-trials', { min: 1, max: 1_000_000 });
  const file = resolve(ctx.io.cwd, input!);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw new HypertestError('invalid_argument', `eval apply-scores: ${file} is not a readable SuiteResult JSON: ${(e as Error).message}`);
  }
  const doc = raw as { suiteId?: unknown; revision?: unknown; trials?: unknown };
  const scores = deriveRouteScores(
    { ...(typeof doc.suiteId === 'string' ? { suiteId: doc.suiteId } : {}), ...(typeof doc.revision === 'string' ? { revision: doc.revision } : {}), trials: doc.trials as ScoredTrial[] },
    { ...(minTrials !== undefined ? { minTrials } : {}), derivedAt: new Date().toISOString() },
  );
  const target = resolve(ctx.io.cwd, out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(scores, null, 2)}\n`);
  if (ctx.global.json) ctx.json({ out: target, scores: scores.scores, source: scores.source });
  else {
    const rows = Object.entries(scores.scores).flatMap(([routeId, byRole]) => Object.entries(byRole).map(([role, v]) => [routeId, role, v.toFixed(3)]));
    if (rows.length === 0) ctx.out(`no (route, role) pair has ${minTrials ?? 3} graded trials: nothing scored`);
    else for (const l of table(['ROUTE', 'ROLE', 'SCORE'], rows)) ctx.out(l);
    ctx.err(`wrote ${target} (${scores.source?.trials ?? 0} graded trials); set models.scoresFile to it — the next start routes with these scores`);
  }
  return EXIT_CODES.ok;
}

export const evalCommand: Command = {
  name: 'eval',
  summary: 'run an evaluation suite (fresh environment per trial) and compare arms; gate a candidate against a baseline',
  usage: [
    'eval run <suite> [--trials n] [--arms a,b] [--work-dir <dir>] [--keep-work-dir] [--timeout-ms n] [--mode in-process|child-process] [--judge scripted] [--out <suite-result.json>] [--report <file>] [--json]',
    'eval gate --baseline <suite-result.json> --candidate <suite-result.json> [--baseline-arm a] [--candidate-arm b] [--alpha 0.05] [--report <file>] [--json]',
    'eval apply-scores <suite-result.json> --out <scores.json> [--min-trials n] [--json]',
  ],
  optionHelp: [
    ['--trials <n>', 'trials per task and arm (default 1)'],
    ['--arms <list>', 'arms to compare (default: the arms @hypertest/eval provides, else `config`)'],
    ['--work-dir <dir>', 'trial workspace (default: a temporary directory, removed afterwards)'],
    ['--keep-work-dir', 'keep the temporary workspace'],
    ['--timeout-ms <n>', 'per-trial timeout'],
    ['--mode <mode>', 'in-process (default) or child-process (arms that support it; chaos kills are real SIGKILLs)'],
    ['--judge scripted', 'add the independent LLM judge (llmRubric, last) to every task; `scripted` = the calibrated CI judge'],
    ['--out <file>', 'persist the SuiteResult as JSON (the input of `eval gate` and `runtime record-suite --from-eval`)'],
    ['--report <file>', 'also write the report (markdown, or JSON with --json) to a file'],
    ['--baseline <file>', 'gate: the SuiteResult JSON of the active runtime/model (eval run --out)'],
    ['--candidate <file>', 'gate: the SuiteResult JSON of the candidate'],
    ['--baseline-arm <id>', 'gate: arm of the baseline (default: its only arm, or the arm both share)'],
    ['--candidate-arm <id>', 'gate: arm of the candidate (default: its only arm, or the baseline arm)'],
    ['--alpha <p>', 'gate: significance level of "defect recall not significantly lower" (exact McNemar; default 0.05)'],
    ['--min-trials <n>', 'apply-scores: graded trials a (route, role) pair needs before it is scored (default 3)'],
  ],
  notes: [
    'Suites: poc-a-whitebox, poc-b-event-driven, poc-c-durable-load, oracle-robustness, recovery-chaos, context-freshness, model-switch, security-injection, test-generation, core (as provided by @hypertest/eval).',
    'The `config` arm evaluates the models and role policies of your configuration file (live providers need their key variables; scripted providers need --scripted-brains).',
    'eval run: exit code 0 when every trial passed, 1 otherwise.',
    'eval apply-scores: derives per-route, per-role quality scores from a SuiteResult (graded trials whose agents of the role ran on the route; (passes + 1) / (trials + 2)) and writes them with their provenance to --out. Point models.scoresFile at it: the next start routes with the scores, and its RuntimeManifest records them (modelScores).',
    'eval gate: exit code 0 when the candidate passes every check (critical false release not worse, defect recall not significantly lower, security violations = 0, duplicate side effects = 0, evidence completeness 100% for critical decisions, comparable results, full coverage), 1 otherwise.',
  ],
  options: {
    trials: { type: 'string' }, arms: { type: 'string' }, 'work-dir': { type: 'string' }, 'keep-work-dir': { type: 'boolean' }, 'timeout-ms': { type: 'string' }, mode: { type: 'string' },
    out: { type: 'string' }, report: { type: 'string' }, judge: { type: 'string' },
    baseline: { type: 'string' }, candidate: { type: 'string' }, 'baseline-arm': { type: 'string' }, 'candidate-arm': { type: 'string' }, alpha: { type: 'string' },
    'min-trials': { type: 'string' },
  },
  longRunning: true,
  async run(ctx, values, args) {
    if (args[0] === 'gate') return gate(ctx, values, args);
    if (args[0] === 'apply-scores') return applyScores(ctx, values, args);
    if (args[0] !== 'run') throw new UsageError(args[0] === undefined ? 'missing sub-command (eval run <suite>)' : `unknown sub-command eval ${args[0]}`, 'eval');
    const [, suiteId] = positionals('eval', args, ['run', 'suite']);
    const judgeKind = str(values, 'judge');
    if (judgeKind !== undefined && judgeKind !== 'scripted') throw new UsageError(`--judge must be scripted (got ${JSON.stringify(judgeKind)}); a live judge is configured through @hypertest/eval createLlmJudge`, 'eval');
    const trials = int('eval', values, 'trials', { min: 1, max: 10_000 }) ?? 1;
    const timeoutMs = int('eval', values, 'timeout-ms', { min: 1 });
    const wanted = list(values, 'arms');
    const mode = str(values, 'mode');
    if (mode !== undefined && mode !== 'in-process' && mode !== 'child-process') throw new UsageError(`--mode must be in-process or child-process (got ${JSON.stringify(mode)})`, 'eval');

    let ev: EvalModuleLike;
    try {
      ev = await ctx.io.loadEval();
    } catch (e) {
      throw new HypertestError('unavailable', `the eval platform (@hypertest/eval) could not be loaded: ${(e as Error).message}`, { cause: e });
    }
    if (typeof ev.runSuite !== 'function') throw new HypertestError('unsupported', '@hypertest/eval does not export runSuite: this build has no eval platform');
    const suites = availableSuites(ev);
    const factory = suites.get(suiteId!);
    if (!factory) throw new UsageError(`unknown suite ${JSON.stringify(suiteId)}${suites.size > 0 ? ` (available: ${[...suites.keys()].sort().join(', ')})` : ' (@hypertest/eval provides no suites)'}`, 'eval');
    let suite = factory();
    if (!isSuite(suite)) throw new HypertestError('internal', `@hypertest/eval: suite factory for ${suiteId} did not return an EvalSuite`);
    let judge: SuiteOptions['judge'];
    if (judgeKind === 'scripted') {
      if (typeof ev.scriptedJudge !== 'function') throw new HypertestError('unsupported', '@hypertest/eval does not export scriptedJudge: this build has no LLM judge');
      judge = ev.scriptedJudge();
      suite = withJudge(suite);
    }

    const registry = availableArms(ev, suite);
    const needConfigArm = wanted.includes('config') || (wanted.length === 0 && registry.size === 0);
    if (needConfigArm && !registry.has('config')) {
      const arm = await configArm(ctx);
      if (arm) registry.set('config', arm);
    }
    let arms: EvalArm[];
    if (wanted.length > 0) {
      const unknown = wanted.filter((a) => !registry.has(a));
      if (unknown.length > 0) throw new UsageError(`unknown arm${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')} (available: ${[...registry.keys()].sort().join(', ') || 'none'})`, 'eval');
      arms = [...new Set(wanted)].map((a) => registry.get(a)!);
    } else {
      arms = [...registry.values()];
      if (arms.length === 0) throw new HypertestError('precondition_failed', 'no eval arms: @hypertest/eval provides none and no configuration file was found for the `config` arm');
    }

    const explicitDir = str(values, 'work-dir');
    const workDir = explicitDir ? resolve(ctx.io.cwd, explicitDir) : await mkdtemp(join(tmpdir(), 'ht-eval-'));
    if (explicitDir) await mkdir(workDir, { recursive: true });
    const keep = explicitDir !== undefined || flag(values, 'keep-work-dir');
    const options: SuiteOptions = {
      arms, trials, workDir, keepWorkDir: keep,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(judge !== undefined ? { judge } : {}),
      onTrial: (t) => {
        if (!ctx.global.json) ctx.err(`  ${t.taskId} / ${t.armId} #${t.trial}: ${t.result}${t.verdict ? ` (verdict ${t.verdict})` : ''}${t.error ? ` — ${t.error}` : ''} in ${Math.round(t.durationMs)} ms`);
      },
    };
    if (!ctx.global.json) ctx.err(`eval ${suite.suiteId}: ${suite.tasks.length} task${suite.tasks.length === 1 ? '' : 's'} × ${arms.length} arm${arms.length === 1 ? '' : 's'} (${arms.map((a) => a.armId).join(', ')}) × ${trials} trial${trials === 1 ? '' : 's'} in ${workDir}`);
    if (ctx.signal.aborted) {
      // interrupted while preparing: no trial is started
      if (!keep) await rm(workDir, { recursive: true, force: true });
      ctx.err('interrupted before the evaluation started: no trial was run');
      return EXIT_CODES.interrupted;
    }
    const running = ev.runSuite(suite, options);
    running.catch(() => undefined);
    const stop = aborted(ctx.signal);
    let result: SuiteResult;
    try {
      const first = await Promise.race([running.then((r) => ({ kind: 'done' as const, r })), stop.promise.then(() => ({ kind: 'aborted' as const }))]);
      if (first.kind === 'aborted') {
        // runSuite takes no cancellation signal: the trial in progress (and the ones after it) keep running in this
        // process until the suite ends — say so instead of pretending the evaluation stopped
        ctx.err(`interrupted: the evaluation cannot be cancelled from the CLI (@hypertest/eval has no cancellation); trials still in progress finish in the background, a second Ctrl-C terminates the process; trial workspace ${workDir} is left in place`);
        return EXIT_CODES.interrupted;
      }
      result = first.r;
    } finally {
      stop.dispose();
    }
    if (!keep) await rm(workDir, { recursive: true, force: true });

    const json = `${JSON.stringify(result, null, 2)}\n`;
    const text = ctx.global.json ? json : `${(typeof ev.renderSuiteReport === 'function' ? ev.renderSuiteReport(result) : summaryLines(result).join('\n')).trimEnd()}\n`;
    ctx.io.stdout.write(text);
    // --out persists the SuiteResult itself (JSON, whatever the display format): the input of `eval gate` and
    // `runtime record-suite --from-eval`
    const out = str(values, 'out');
    if (out) await writeOutput(ctx, out, json);
    const reportFile = str(values, 'report');
    if (reportFile) await writeOutput(ctx, reportFile, text);
    if (keep && !ctx.global.json) ctx.err(`trial workspace: ${workDir}`);
    return result.trials.length > 0 && result.trials.every((t) => t.result === 'pass') ? EXIT_CODES.ok : EXIT_CODES.failure;
  },
};
