import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HypertestError } from '@hypertest/core';
import { loadConfig, mergeConfig, type HypertestConfig, type HypertestConfigInput } from '@hypertest/app';
import type { EvalArm, EvalSuite, SuiteOptions, SuiteResult } from '@hypertest/eval';
import { UsageError, flag, int, list, positionals, str } from '../args.ts';
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

export const evalCommand: Command = {
  name: 'eval',
  summary: 'run an evaluation suite (fresh environment per trial) and compare arms',
  usage: ['eval run <suite> [--trials n] [--arms a,b] [--work-dir <dir>] [--keep-work-dir] [--timeout-ms n] [--mode in-process|child-process] [--out <file>] [--json]'],
  optionHelp: [
    ['--trials <n>', 'trials per task and arm (default 1)'],
    ['--arms <list>', 'arms to compare (default: the arms @hypertest/eval provides, else `config`)'],
    ['--work-dir <dir>', 'trial workspace (default: a temporary directory, removed afterwards)'],
    ['--keep-work-dir', 'keep the temporary workspace'],
    ['--timeout-ms <n>', 'per-trial timeout'],
    ['--mode <mode>', 'in-process (default) or child-process (arms that support it; chaos kills are real SIGKILLs)'],
    ['--out <file>', 'also write the report (markdown, or JSON with --json) to a file'],
  ],
  notes: [
    'Suites: poc-a-whitebox, poc-b-event-driven, poc-c-durable-load, oracle-robustness, recovery-chaos (as provided by @hypertest/eval).',
    'The `config` arm evaluates the models and role policies of your configuration file (live providers need their key variables; scripted providers need --scripted-brains).',
    'Exit code 0 when every trial passed, 1 otherwise.',
  ],
  options: {
    trials: { type: 'string' }, arms: { type: 'string' }, 'work-dir': { type: 'string' }, 'keep-work-dir': { type: 'boolean' }, 'timeout-ms': { type: 'string' }, mode: { type: 'string' },
    out: { type: 'string' },
  },
  longRunning: true,
  async run(ctx, values, args) {
    if (args[0] !== 'run') throw new UsageError(args[0] === undefined ? 'missing sub-command (eval run <suite>)' : `unknown sub-command eval ${args[0]}`, 'eval');
    const [, suiteId] = positionals('eval', args, ['run', 'suite']);
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
    const suite = factory();
    if (!isSuite(suite)) throw new HypertestError('internal', `@hypertest/eval: suite factory for ${suiteId} did not return an EvalSuite`);

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

    const text = ctx.global.json ? `${JSON.stringify(result, null, 2)}\n` : `${(typeof ev.renderSuiteReport === 'function' ? ev.renderSuiteReport(result) : summaryLines(result).join('\n')).trimEnd()}\n`;
    ctx.io.stdout.write(text);
    const out = str(values, 'out');
    if (out) {
      const file = resolve(ctx.io.cwd, out);
      await writeFile(file, text);
      ctx.err(`wrote ${file}`);
    }
    if (keep && !ctx.global.json) ctx.err(`trial workspace: ${workDir}`);
    return result.trials.length > 0 && result.trials.every((t) => t.result === 'pass') ? EXIT_CODES.ok : EXIT_CODES.failure;
  },
};
