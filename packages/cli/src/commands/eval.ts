import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HypertestError, isHypertestError, sha256Hex } from '@hypertest/core';
import { deriveRouteScores, loadConfig, mergeConfig, type HypertestConfig, type HypertestConfigInput, type ScoredTrial } from '@hypertest/app';
import type {
  BridgeReport, CalibrationSet, EvalArm, EvalSuite, EvalTier, EvalTrack, ExperienceSeed, LlmJudge, ReleaseGateOptions, ReleaseGateReport, SuiteOptions, SuiteResult, VersionedGrader,
} from '@hypertest/eval';
import { UsageError, flag, int, list, positionals, required, str, type OptionValues } from '../args.ts';
import type { Command } from '../command.ts';
import { aborted, brainMap, findConfig, isPlainObject, loadBrainsModule, loadCliConfig, type CommandContext } from '../context.ts';
import type { EvalModuleLike, ScriptedBrainMap } from '../contracts.ts';
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
    // suite factories (`pocAWhiteboxSuite`), not verbs over suites (`runSuite`, `createSuite`, …) nor parameterized
    // loaders (`sanitySuite` takes a dataset)
    if (/^[a-z][A-Za-z0-9]*Suite$/.test(name) && !/^(run|create|build|render|load|make|new|define|sanity)([A-Z]|$)/.test(name.replace(/Suite$/, '')) && typeof value === 'function') {
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

/** Brains of the CLI's configuration arms: the --scripted-brains module (per task: evalBrains, else its static map). */
async function configBrains(ctx: CommandContext, config: HypertestConfig): Promise<EvalArm['brains'] | undefined> {
  if (ctx.global.scriptedBrains === undefined) return undefined;
  const mod = await loadBrainsModule(ctx, ctx.global.scriptedBrains);
  if (mod.evalBrains) return mod.evalBrains;
  const brains = await brainMap(ctx, mod, config, ctx.global.scriptedBrains);
  return () => brains;
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
  const brains = await configBrains(ctx, config);
  if (brains) arm.brains = brains;
  return arm;
}

/**
 * (F[13]) The `deployment` arm: the WHOLE configuration file (models, roles, policies, gate, tools, sandbox, runtime, …)
 * over the trial's base configuration — only what isolates the trial is the trial's (data directory, store, artifacts,
 * durable runtime, log level). Its trials run under the deployment's runtime manifest, so a result of the core suite on
 * this arm certifies THIS deployment's release (`runtime record-suite current --kind release_gate --from-eval …`).
 */
async function deploymentArm(ctx: CommandContext, ev: EvalModuleLike): Promise<EvalArm | undefined> {
  const path = findConfig(ctx.io, ctx.global.config);
  if (!path) return undefined;
  const config = await loadConfig(path, { env: ctx.io.env });
  const arm: EvalArm = {
    armId: 'deployment',
    description: `the deployment configuration ${path} (release evaluation)`,
    config: (base: HypertestConfig) => ({ ...config, project: { ...config.project, dataDir: base.project.dataDir }, store: base.store, artifacts: base.artifacts, durable: base.durable, ...(base.observability ? { observability: base.observability } : {}) }),
  };
  const brains = await configBrains(ctx, config);
  if (brains) arm.brains = brains;
  else {
    // a scripted deployment over the multi-LLM provider ids runs the platform's scripted task brains
    const ids = config.models.providers.map((p) => p.id).sort().join(',');
    const scripted = config.models.providers.every((p) => p.kind === 'scripted');
    const pocBrains = ev['pocBrains'] as ((args: { taskId: string; arm: 'multi'; observationsFile?: string }) => ScriptedBrainMap) | undefined;
    const brainArgsFor = ev['brainArgsFor'] as ((task: unknown, fixture: unknown, arm: 'multi') => { taskId: string; arm: 'multi' }) | undefined;
    if (scripted && ids === 'fast-b,judge-c,reason-a' && pocBrains && brainArgsFor) arm.brains = (task, fixture) => pocBrains(brainArgsFor(task, fixture, 'multi'));
  }
  return arm;
}

function summaryLines(result: SuiteResult): string[] {
  const lines = [`suite ${result.suiteId} (revision ${result.revision}): ${result.trials.length} trial${result.trials.length === 1 ? '' : 's'}${result.cancelled ? ' — CANCELLED (partial)' : ''}`, ''];
  const ks = [...new Set(Object.values(result.perArm).flatMap((s) => Object.keys(s.passAtK ?? {})))].map(Number).sort((a, b) => a - b);
  lines.push(...table(['ARM', 'PASS RATE', 'PASS^K', ...ks.flatMap((k) => [`PASS@${k}`, `PASS^${k}`])], Object.entries(result.perArm).map(([arm, s]) => [arm, s.passRate.toFixed(3), s.passHatK.toFixed(3), ...ks.flatMap((k) => [(s.passAtK?.[String(k)] ?? 0).toFixed(3), (s.passHatKByK?.[String(k)] ?? 0).toFixed(3)])])));
  lines.push('');
  lines.push(...table(['TASK', 'ARM', 'TRIAL', 'RESULT', 'VERDICT', 'RUN'], result.trials.map((t) => [t.taskId, t.armId, String(t.trial), `${t.result}${t.cancelled ? ' (cancelled)' : ''}`, t.verdict ?? '-', t.runId ?? '-'])));
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

async function readJson(ctx: CommandContext, option: string, path: string, command = 'eval'): Promise<unknown> {
  const file = resolve(ctx.io.cwd, path);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    throw new UsageError(`--${option} ${path} cannot be read: ${(e as Error).message}`, command);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`--${option} ${path} is not JSON: ${(e as Error).message}`, command);
  }
}

/** Reads a SuiteResult JSON file (`eval run --out`); unreadable or malformed ⇒ usage error naming the file. */
async function readSuiteResult(ctx: CommandContext, option: string, path: string): Promise<SuiteResult> {
  return (await readJson(ctx, option, path)) as SuiteResult;
}

async function loadEvalModule(ctx: CommandContext): Promise<EvalModuleLike> {
  try {
    return await ctx.io.loadEval();
  } catch (e) {
    throw new HypertestError('unavailable', `the eval platform (@hypertest/eval) could not be loaded: ${(e as Error).message}`, { cause: e });
  }
}

function fn<T>(ev: EvalModuleLike, name: string, what: string): T {
  const v = ev[name];
  if (typeof v !== 'function') throw new HypertestError('unsupported', `@hypertest/eval does not export ${name}: this build has no ${what}`);
  return v as T;
}

/**
 * The gate options of `eval gate` / `runtime record-suite --kind release_gate`: arms, α, the critical false release SLO
 * (row 321; default 0) — shared so both apply the same gate.
 */
export async function gateOptionsFrom(_ctx: CommandContext, values: OptionValues, command: string): Promise<ReleaseGateOptions> {
  const options: ReleaseGateOptions = {};
  const baselineArm = str(values, 'baseline-arm');
  const candidateArm = str(values, 'candidate-arm');
  if (baselineArm !== undefined) options.baselineArm = baselineArm;
  if (candidateArm !== undefined) options.candidateArm = candidateArm;
  const alpha = str(values, 'alpha');
  if (alpha !== undefined) {
    const a = Number(alpha);
    if (!(Number.isFinite(a) && a > 0 && a < 1)) throw new UsageError(`--alpha must be a number in (0, 1) (got ${JSON.stringify(alpha)})`, command);
    options.alpha = a;
  }
  const slo = str(values, 'max-critical-false-release');
  if (slo !== undefined) {
    const r = Number(slo);
    if (!(Number.isFinite(r) && r >= 0 && r <= 1)) throw new UsageError(`--max-critical-false-release must be a rate in [0, 1] (got ${JSON.stringify(slo)})`, command);
    options.maxCriticalFalseReleaseRate = r;
  }
  return options;
}

/** (F[12]) The bridge reports `--bridge <file>` names (an `eval bridge --out` file: a report or {reports: [...]}). */
export async function bridgeReportsFrom(ctx: CommandContext, values: OptionValues, command: string): Promise<BridgeReport[]> {
  const out: BridgeReport[] = [];
  for (const file of list(values, 'bridge')) {
    const doc = (await readJson(ctx, 'bridge', file, command)) as { reports?: unknown } | BridgeReport;
    const reports = Array.isArray((doc as { reports?: unknown }).reports) ? ((doc as { reports: unknown[] }).reports as BridgeReport[]) : [doc as BridgeReport];
    for (const r of reports) {
      if (!r || typeof r.graderId !== 'string' || typeof r.fromRevision !== 'string' || typeof r.toRevision !== 'string' || typeof r.discontinuity !== 'boolean' || typeof r.pairs !== 'number') {
        throw new UsageError(`--bridge ${file} is not a bridge report (graderId, fromRevision, toRevision, pairs, discontinuity)`, command);
      }
      out.push(r);
    }
  }
  return out;
}

/** `eval gate`: the eval release gate over two persisted suite results ⇒ exit 0 (pass) / 1 (fail) with a report. */
async function gate(ctx: CommandContext, values: OptionValues, args: string[]): Promise<number> {
  positionals('eval', args, ['gate']);
  const baselinePath = required('eval', values, 'baseline');
  const candidatePath = required('eval', values, 'candidate');
  const options = await gateOptionsFrom(ctx, values, 'eval');
  const bridges = await bridgeReportsFrom(ctx, values, 'eval');
  if (bridges.length > 0) options.bridges = bridges;
  const baseline = await readSuiteResult(ctx, 'baseline', baselinePath);
  const candidate = await readSuiteResult(ctx, 'candidate', candidatePath);
  if (candidate.cancelled) throw new UsageError(`--candidate ${candidatePath} is a CANCELLED (partial) suite result: it never gates a release`, 'eval');
  const ev = await loadEvalModule(ctx);
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
async function applyScores(ctx: CommandContext, values: OptionValues, args: string[]): Promise<number> {
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
  const doc = raw as { suiteId?: unknown; revision?: unknown; trials?: unknown; cancelled?: unknown };
  if (doc.cancelled === true) throw new HypertestError('invalid_argument', 'eval apply-scores: a CANCELLED (partial) suite result never scores routes');
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

/** (F[11]) The judge of `--judge scripted|config` (config: the configuration's routes, `--judge-route` narrows them). */
async function judgeFrom(ctx: CommandContext, ev: EvalModuleLike, values: OptionValues): Promise<LlmJudge | undefined> {
  const kind = str(values, 'judge');
  if (kind === undefined) return undefined;
  const calibrationFile = str(values, 'calibration');
  let calibration: CalibrationSet | undefined;
  if (calibrationFile !== undefined) {
    const assertSet = fn<(v: unknown, what?: string) => CalibrationSet>(ev, 'assertCalibrationSet', 'judge calibration');
    try {
      calibration = assertSet(await readJson(ctx, 'calibration', calibrationFile), calibrationFile);
    } catch (e) {
      if (e instanceof UsageError) throw e;
      throw new UsageError((e as Error).message, 'eval');
    }
  }
  let judge: LlmJudge;
  if (kind === 'scripted') {
    if (str(values, 'judge-route') !== undefined) throw new UsageError('--judge-route selects routes of the configuration (--judge config)', 'eval');
    const scripted = fn<(o?: { calibration?: CalibrationSet }) => LlmJudge>(ev, 'scriptedJudge', 'LLM judge');
    judge = scripted(calibration ? { calibration } : {});
  } else if (kind === 'config') {
    const { config } = await loadCliConfig(ctx);
    const configured = fn<(c: HypertestConfig, o: Record<string, unknown>) => Promise<LlmJudge>>(ev, 'configuredJudge', 'configured LLM judge');
    const routeIds = list(values, 'judge-route');
    let scriptedBrains: ScriptedBrainMap | undefined;
    if (ctx.global.scriptedBrains !== undefined) scriptedBrains = await brainMap(ctx, await loadBrainsModule(ctx, ctx.global.scriptedBrains), config, ctx.global.scriptedBrains);
    judge = await configured(config, { env: ctx.io.env, ...(routeIds.length > 0 ? { routeIds } : {}), ...(calibration ? { calibration } : {}), ...(scriptedBrains ? { scriptedBrains } : {}) });
  } else {
    throw new UsageError(`--judge must be scripted (the calibrated CI judge) or config (the configuration's model routes), got ${JSON.stringify(kind)}`, 'eval');
  }
  const packets = str(values, 'judge-packets');
  if (packets !== undefined) judge = fn<(j: LlmJudge, dir: string) => LlmJudge>(ev, 'recordingJudge', 'judge packet recording')(judge, resolve(ctx.io.cwd, packets));
  return judge;
}

/** (F[11]) `eval calibrate`: agreement of the judge with the expert labels, or `eval calibrate label`: a human label. */
async function calibrate(ctx: CommandContext, values: OptionValues, args: string[]): Promise<number> {
  const ev = await loadEvalModule(ctx);
  if (args[1] === 'label') {
    positionals('eval', args, ['calibrate', 'label']);
    const setFile = resolve(ctx.io.cwd, required('eval', values, 'set'));
    const packetFile = resolve(ctx.io.cwd, required('eval', values, 'packet'));
    const label = required('eval', values, 'label');
    const by = required('eval', values, 'by').trim();
    const human = by.startsWith('human:') ? by : `human:${by}`;
    const note = str(values, 'note');
    const labelItem = fn<(i: Record<string, unknown>) => { set: CalibrationSet; item: { itemId: string } }>(ev, 'labelCalibrationItem', 'human calibration');
    let r;
    try {
      r = labelItem({ setFile, packetFile, label, by: human, ...(note ? { note } : {}) });
    } catch (e) {
      if (isHypertestError(e, 'invalid_argument') || isHypertestError(e, 'conflict')) throw new UsageError(e.message, 'eval');
      throw e;
    }
    if (ctx.global.json) ctx.json({ set: setFile, revision: r.set.revision, item: r.item.itemId, items: r.set.items.length });
    else ctx.out(`labelled ${r.item.itemId} ${label} by ${human}: ${setFile} is now revision ${r.set.revision} (${r.set.items.length} item(s))`);
    return EXIT_CODES.ok;
  }
  positionals('eval', args, ['calibrate']);
  if (str(values, 'judge') === undefined) values['judge'] = 'scripted';
  const setFile = str(values, 'set');
  if (setFile !== undefined && str(values, 'calibration') === undefined) values['calibration'] = setFile;
  const judge = (await judgeFrom(ctx, ev, values))!;
  const loadSet = fn<(path?: string) => CalibrationSet>(ev, 'loadCalibrationSet', 'judge calibration');
  const assertSet = fn<(v: unknown, what?: string) => CalibrationSet>(ev, 'assertCalibrationSet', 'judge calibration');
  const set = setFile !== undefined ? assertSet(await readJson(ctx, 'set', setFile), setFile) : loadSet();
  const rubric = ev['VERDICT_CONSISTENCY_RUBRIC'] as Parameters<LlmJudge['calibrate']>[1];
  const report = await judge.calibrate(set, rubric);
  if (ctx.global.json) ctx.json(report);
  else {
    ctx.out(`judge ${report.judge} on ${report.calibrationSetId}@${report.revision} (rubric ${report.rubricId}@${report.rubricRevision}): ${report.n} item(s)`);
    ctx.out(`agreement ${report.agreement.toFixed(3)} (≥ ${report.thresholds.minAgreement}), kappa ${report.kappa.toFixed(3)} (≥ ${report.thresholds.minKappa}), routes ${(report.routes ?? []).join(', ') || '-'}`);
    for (const d of report.disagreements) ctx.out(`  disagreement ${d.itemId}: expert ${d.label}, judge ${d.verdict}`);
    ctx.out(report.meetsThreshold ? 'CALIBRATED: the judge\'s results count' : 'NOT CALIBRATED: the judge\'s results are reported but never counted');
  }
  return report.meetsThreshold ? EXIT_CODES.ok : EXIT_CODES.failure;
}

interface ResolvedSuite {
  suite: EvalSuite;
  arms: EvalArm[];
  trials: number;
  mode?: 'in-process' | 'child-process';
  tier?: EvalTier;
  options: Pick<SuiteOptions, 'track' | 'experience' | 'judge' | 'bridge'>;
  bridgeGrader?: string;
}

/** Resolves suite, arms, tier, track, judge and bridge of `eval run` / `eval bridge`. */
async function resolveRun(ctx: CommandContext, ev: EvalModuleLike, values: OptionValues, suiteArg: string | undefined, command: 'run' | 'bridge'): Promise<ResolvedSuite> {
  const tierName = str(values, 'tier');
  let tier: EvalTier | undefined;
  let tierTrials: number | undefined;
  let tierMode: 'in-process' | 'child-process' | undefined;
  let suiteId = suiteArg;
  if (tierName !== undefined) {
    const tierSpec = fn<(t: string) => { suiteId: string; trials: number; mode: 'in-process' | 'child-process' }>(ev, 'tierSpec', 'eval tiers');
    let spec;
    try {
      spec = tierSpec(tierName);
    } catch (e) {
      throw new UsageError((e as Error).message, 'eval');
    }
    tier = tierName as EvalTier;
    suiteId ??= spec.suiteId;
    tierTrials = spec.trials;
    tierMode = spec.mode;
  }
  if (suiteId === undefined) throw new UsageError(`eval ${command}: name a suite or a --tier`, 'eval');
  const trials = int('eval', values, 'trials', { min: 1, max: 10_000 }) ?? tierTrials ?? 1;
  const mode = str(values, 'mode') ?? tierMode;
  if (mode !== undefined && mode !== 'in-process' && mode !== 'child-process') throw new UsageError(`--mode must be in-process or child-process (got ${JSON.stringify(mode)})`, 'eval');

  // the suite: a private directory (customer layer), the public sanity layer, or a built-in suite
  let suite: EvalSuite | undefined;
  const suiteDir = str(values, 'suite-dir');
  if (suiteDir !== undefined) {
    const load = fn<(dir: string) => Promise<Map<string, { suite: EvalSuite; fingerprint: string }>>>(ev, 'loadSuiteDirectory', 'private suites');
    let loaded;
    try {
      loaded = await load(resolve(ctx.io.cwd, suiteDir));
    } catch (e) {
      if (isHypertestError(e, 'invalid_argument')) throw new UsageError(e.message, 'eval');
      throw e;
    }
    const hit = loaded.get(suiteId);
    if (hit) suite = hit.suite;
    else if (!availableSuites(ev).has(suiteId)) throw new UsageError(`unknown suite ${JSON.stringify(suiteId)} (in ${suiteDir}: ${[...loaded.keys()].sort().join(', ') || 'none'})`, 'eval');
  }
  if (!suite && suiteId === 'sanity') {
    const dataset = str(values, 'dataset');
    const repos = str(values, 'repos');
    if (dataset === undefined || repos === undefined) throw new UsageError('the sanity layer needs --dataset <instances.jsonl> and --repos <local mirror dir> (it never downloads)', 'eval');
    const sanity = fn<(i: { datasetFile: string; reposDir: string; limit?: number }) => EvalSuite>(ev, 'sanitySuite', 'public sanity layer');
    const limit = int('eval', values, 'limit', { min: 1 });
    try {
      suite = sanity({ datasetFile: resolve(ctx.io.cwd, dataset), reposDir: resolve(ctx.io.cwd, repos), ...(limit !== undefined ? { limit } : {}) });
    } catch (e) {
      if (isHypertestError(e, 'invalid_argument')) throw new UsageError(e.message, 'eval');
      throw e;
    }
  }
  if (!suite) {
    const suites = availableSuites(ev);
    const factory = suites.get(suiteId);
    if (!factory) throw new UsageError(`unknown suite ${JSON.stringify(suiteId)}${suites.size > 0 ? ` (available: ${[...suites.keys()].sort().join(', ')})` : ' (@hypertest/eval provides no suites)'}`, 'eval');
    suite = factory();
  }
  if (!isSuite(suite)) throw new HypertestError('internal', `@hypertest/eval: suite factory for ${suiteId} did not return an EvalSuite`);

  const options: ResolvedSuite['options'] = {};
  const judge = await judgeFrom(ctx, ev, values);
  if (judge) {
    options.judge = judge;
    suite = withJudge(suite);
  }
  // (coverage[16]) cold by default; learning admits approved experience only
  const track = str(values, 'track');
  if (track !== undefined && track !== 'cold' && track !== 'learning') throw new UsageError(`--track must be cold or learning (got ${JSON.stringify(track)})`, 'eval');
  if (track) options.track = track as EvalTrack;
  const experienceFile = str(values, 'experience');
  if (experienceFile !== undefined) {
    if (track !== 'learning') throw new UsageError('--experience seeds approved experience on the learning track only (--track learning)', 'eval');
    const doc = await readJson(ctx, 'experience', experienceFile);
    const items = Array.isArray(doc) ? doc : isPlainObject(doc) && Array.isArray(doc['items']) ? (doc['items'] as unknown[]) : undefined;
    if (!items) throw new UsageError(`--experience ${experienceFile} must be a list of experience items (or {items: [...]})`, 'eval');
    options.experience = items as ExperienceSeed[];
  }
  // (F[12]) a retained earlier grader revision graded on the same trials (eval bridge)
  const bridgeSpec = str(values, command === 'bridge' ? 'grader' : 'bridge-grader');
  let bridgeGrader: string | undefined;
  if (bridgeSpec !== undefined) {
    const retained = fn<(s: string) => { graderId: string; versioned: VersionedGrader }>(ev, 'retainedGrader', 'retained grader revisions');
    let r;
    try {
      r = retained(bridgeSpec);
    } catch (e) {
      throw new UsageError((e as Error).message, 'eval');
    }
    options.bridge = { [r.graderId]: r.versioned };
    bridgeGrader = r.graderId;
  }

  const registry = availableArms(ev, suite);
  const wanted = list(values, 'arms');
  const needConfigArm = wanted.includes('config') || (wanted.length === 0 && registry.size === 0);
  if (needConfigArm && !registry.has('config')) {
    const arm = await configArm(ctx);
    if (arm) registry.set('config', arm);
  }
  if (wanted.includes('deployment') && !registry.has('deployment')) {
    const arm = await deploymentArm(ctx, ev);
    if (arm) registry.set('deployment', arm);
  }
  let arms: EvalArm[];
  if (wanted.length > 0) {
    const unknown = wanted.filter((a) => !registry.has(a));
    if (unknown.length > 0) throw new UsageError(`unknown arm${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')} (available: ${[...registry.keys()].sort().join(', ') || 'none'})`, 'eval');
    arms = [...new Set(wanted)].map((a) => registry.get(a)!);
  } else {
    // the default arms: the model-variation arms (scripted multi/single, live when configured) — causal and product arms
    // are opt-in by name
    arms = [...registry.values()].filter((a) => a.family === undefined || a.family === 'model');
    if (arms.length === 0) throw new HypertestError('precondition_failed', 'no eval arms: @hypertest/eval provides none and no configuration file was found for the `config` arm');
  }
  const out: ResolvedSuite = { suite, arms, trials, options };
  if (mode !== undefined) out.mode = mode as 'in-process' | 'child-process';
  if (tier !== undefined) out.tier = tier;
  if (bridgeGrader !== undefined) out.bridgeGrader = bridgeGrader;
  return out;
}

/** Runs a resolved suite with cancellation (SIGINT / --timeout): a partial, CANCELLED result is kept and returned. */
/** How long `eval run` waits for the platform to settle after a cancellation before leaving it to finish (ms). */
const DEFAULT_CANCEL_GRACE_MS = 30_000;

async function runResolved(ctx: CommandContext, ev: EvalModuleLike, values: OptionValues, r: ResolvedSuite): Promise<{ result: SuiteResult; cancelledBy?: 'interrupt' | 'timeout'; workDir: string; keep: boolean } | { interruptedEarly: true } | { abandoned: 'interrupt' | 'timeout' }> {
  if (typeof ev.runSuite !== 'function') throw new HypertestError('unsupported', '@hypertest/eval does not export runSuite: this build has no eval platform');
  const timeoutMs = int('eval', values, 'timeout-ms', { min: 1 });
  const suiteTimeout = int('eval', values, 'timeout', { min: 1 });
  const explicitDir = str(values, 'work-dir');
  const workDir = explicitDir ? resolve(ctx.io.cwd, explicitDir) : await mkdtemp(join(tmpdir(), 'ht-eval-'));
  if (explicitDir) await mkdir(workDir, { recursive: true });
  const keep = explicitDir !== undefined || flag(values, 'keep-work-dir');
  // (F[14]) the evaluation's cancellation: the CLI's interrupt signal and the --timeout deadline
  // a REF'd timer (AbortSignal.timeout's is unref'd: a waiting evaluation would let the process exit under it), cleared below
  const deadlineCtrl = suiteTimeout !== undefined ? new AbortController() : undefined;
  const deadlineTimer = deadlineCtrl ? setTimeout(() => deadlineCtrl.abort(new HypertestError('timeout', `the evaluation exceeded --timeout ${suiteTimeout} ms`)), suiteTimeout) : undefined;
  const deadline = deadlineCtrl?.signal;
  const signal = deadline ? AbortSignal.any([ctx.signal, deadline]) : ctx.signal;
  try {
    return await runUnderSignal(ctx, ev, r, { signal, deadline, suiteTimeout, workDir, keep, values, timeoutMs });
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

async function runUnderSignal(
  ctx: CommandContext,
  ev: EvalModuleLike,
  r: ResolvedSuite,
  x: { signal: AbortSignal; deadline: AbortSignal | undefined; suiteTimeout: number | undefined; workDir: string; keep: boolean; values: OptionValues; timeoutMs: number | undefined },
): Promise<{ result: SuiteResult; cancelledBy?: 'interrupt' | 'timeout'; workDir: string; keep: boolean } | { interruptedEarly: true } | { abandoned: 'interrupt' | 'timeout' }> {
  const { signal, deadline, suiteTimeout, workDir, keep, values, timeoutMs } = x;
  const options: SuiteOptions = {
    arms: r.arms, trials: r.trials, workDir, keepWorkDir: keep, signal, ...r.options,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(r.mode !== undefined ? { mode: r.mode } : {}),
    ...(r.tier !== undefined ? { tier: r.tier } : {}),
    onTrial: (t) => {
      if (!ctx.global.json) ctx.err(`  ${t.taskId} / ${t.armId} #${t.trial}: ${t.result}${t.cancelled ? ' (cancelled)' : ''}${t.verdict ? ` (verdict ${t.verdict})` : ''}${t.error ? ` — ${t.error}` : ''} in ${Math.round(t.durationMs)} ms`);
    },
  };
  if (!ctx.global.json) ctx.err(`eval ${r.suite.suiteId}${r.tier ? ` (tier ${r.tier})` : ''}: ${r.suite.tasks.length} task${r.suite.tasks.length === 1 ? '' : 's'} × ${r.arms.length} arm${r.arms.length === 1 ? '' : 's'} (${r.arms.map((a) => a.armId).join(', ')}) × ${r.trials} trial${r.trials === 1 ? '' : 's'}${r.options.track === 'learning' ? ', track learning' : ''} in ${workDir}`);
  if (signal.aborted) {
    if (!keep) await rm(workDir, { recursive: true, force: true });
    ctx.err('interrupted before the evaluation started: no trial was run');
    return { interruptedEarly: true };
  }
  // (F[14]) the platform cancels through SuiteOptions.signal: it settles with the partial result. A platform that does not
  // honour the signal within the grace period is reported and left to finish in the background (never a hang)
  const grace = int('eval', values, 'cancel-grace-ms', { min: 0 }) ?? DEFAULT_CANCEL_GRACE_MS;
  const stop = aborted(signal);
  let graceTimer: NodeJS.Timeout | undefined;
  let settledAlready = false;
  const abandoned = stop.promise.then(() => new Promise<'abandoned'>((resolveGrace) => {
    // no timer once the evaluation settled (nothing may keep the process alive after the command)
    if (!settledAlready) graceTimer = setTimeout(() => resolveGrace('abandoned'), grace);
  }));
  const running = Promise.resolve().then(() => ev.runSuite!(r.suite, options));
  running.catch(() => undefined);
  try {
    const settled = await Promise.race([running.then((result) => ({ result }), (error: unknown) => ({ error })), abandoned]);
    if (settled === 'abandoned') {
      const by = deadline?.aborted ? 'timeout' : 'interrupt';
      ctx.err(`${by === 'timeout' ? `the evaluation exceeded --timeout ${suiteTimeout} ms` : 'interrupted'}: the evaluation did not stop within ${grace} ms of its cancellation (this eval platform does not honour it); trials still in progress finish in the background, a second Ctrl-C terminates the process; trial workspace ${workDir} is left in place`);
      return { abandoned: by };
    }
    if ('result' in settled) return { result: settled.result, workDir, keep };
    const e = settled.error;
    // (F[14]) cancelled: the partial result (completed trials + the cancelled one) is kept, never summarized as complete
    const partial = isHypertestError(e, 'cancelled') ? (e.details?.['result'] as SuiteResult | undefined) : undefined;
    if (!partial) throw e;
    const by = deadline?.aborted ? 'timeout' : 'interrupt';
    ctx.err(`${by === 'timeout' ? `the evaluation exceeded --timeout ${suiteTimeout} ms` : 'interrupted'}: cancelled after ${partial.trials.filter((t) => !t.cancelled).length} completed trial(s); the partial result is kept (marked cancelled: it never gates anything)`);
    return { result: partial, cancelledBy: by, workDir, keep };
  } finally {
    settledAlready = true;
    if (graceTimer) clearTimeout(graceTimer);
    stop.dispose();
  }
}

async function runCommand(ctx: CommandContext, values: OptionValues, args: string[]): Promise<number> {
  const [, suiteArg] = positionals('eval', args, ['run'], ['suite']);
  const ev = await loadEvalModule(ctx);
  if (typeof ev.runSuite !== 'function') throw new HypertestError('unsupported', '@hypertest/eval does not export runSuite: this build has no eval platform');
  const resolved = await resolveRun(ctx, ev, values, suiteArg, 'run');
  const ran = await runResolved(ctx, ev, values, resolved);
  if ('interruptedEarly' in ran) return EXIT_CODES.interrupted;
  if ('abandoned' in ran) return ran.abandoned === 'interrupt' ? EXIT_CODES.interrupted : EXIT_CODES.failure;
  const { result, workDir, keep } = ran;
  if (!keep) await rm(workDir, { recursive: true, force: true });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const text = ctx.global.json ? json : `${(typeof ev.renderSuiteReport === 'function' ? ev.renderSuiteReport(result) : summaryLines(result).join('\n')).trimEnd()}\n`;
  ctx.io.stdout.write(text);
  // --out persists the SuiteResult itself (JSON, whatever the display format): the input of `eval gate` and
  // `runtime record-suite --from-eval` (a cancelled result is marked and never gates anything)
  const out = str(values, 'out');
  if (out) await writeOutput(ctx, out, json);
  const reportFile = str(values, 'report');
  if (reportFile) await writeOutput(ctx, reportFile, text);
  if (keep && !ctx.global.json) ctx.err(`trial workspace: ${workDir}`);
  if (ran.cancelledBy === 'interrupt') return EXIT_CODES.interrupted;
  if (ran.cancelledBy === 'timeout') return EXIT_CODES.failure;
  return result.trials.length > 0 && result.trials.every((t) => t.result === 'pass') ? EXIT_CODES.ok : EXIT_CODES.failure;
}

/**
 * (F[12]) `eval bridge <suite> --grader <id>@<revision>`: the suite's trials graded by the current AND the retained earlier
 * revision; writes the bridge report (old → new: agreement, flips, McNemar, score mapping, discontinuity) — the input of
 * `eval gate --bridge` (results across the change stay comparable only without a discontinuity).
 */
async function bridgeCommand(ctx: CommandContext, values: OptionValues, args: string[]): Promise<number> {
  const [, suiteArg] = positionals('eval', args, ['bridge'], ['suite']);
  required('eval', values, 'grader');
  const outFile = required('eval', values, 'out');
  const ev = await loadEvalModule(ctx);
  const resolved = await resolveRun(ctx, ev, values, suiteArg, 'bridge');
  if (!resolved.suite.tasks.some((t) => t.graders.some((g) => g.split('?')[0] === resolved.bridgeGrader))) {
    throw new UsageError(`no task of ${resolved.suite.suiteId} is graded by ${resolved.bridgeGrader}`, 'eval');
  }
  const ran = await runResolved(ctx, ev, values, resolved);
  if ('interruptedEarly' in ran) return EXIT_CODES.interrupted;
  if ('abandoned' in ran) return ran.abandoned === 'interrupt' ? EXIT_CODES.interrupted : EXIT_CODES.failure;
  if (!ran.keep) await rm(ran.workDir, { recursive: true, force: true });
  if (ran.cancelledBy) return ran.cancelledBy === 'interrupt' ? EXIT_CODES.interrupted : EXIT_CODES.failure;
  const compare = fn<(id: string, trials: SuiteResult['trials'], o: { bridgeIsPrevious: boolean }) => BridgeReport>(ev, 'bridgeCompare', 'bridge comparisons');
  const report = compare(resolved.bridgeGrader!, ran.result.trials, { bridgeIsPrevious: true });
  const doc = { suiteId: ran.result.suiteId, revision: ran.result.revision, suiteFingerprint: ran.result.suiteFingerprint ?? null, reportDigest: sha256Hex(JSON.stringify(ran.result)), reports: [report] };
  await writeOutput(ctx, outFile, `${JSON.stringify(doc, null, 2)}\n`);
  const resultOut = str(values, 'result-out');
  if (resultOut) await writeOutput(ctx, resultOut, `${JSON.stringify(ran.result, null, 2)}\n`);
  if (ctx.global.json) ctx.json(doc);
  else ctx.out(report.statement);
  return EXIT_CODES.ok;
}

export const evalCommand: Command = {
  name: 'eval',
  summary: 'run an evaluation suite (fresh environment per trial) and compare arms; gate a candidate against a baseline; bridge grader revisions; calibrate the judge',
  usage: [
    'eval run [<suite>] [--tier pr-smoke|release-core|deep|failure-recovery] [--trials n] [--arms a,b] [--track cold|learning] [--experience <items.json>] [--suite-dir <dir>] [--dataset <instances.jsonl> --repos <dir>] [--work-dir <dir>] [--keep-work-dir] [--timeout-ms n] [--timeout n] [--cancel-grace-ms n] [--mode in-process|child-process] [--judge scripted|config] [--judge-route r] [--judge-packets <dir>] [--calibration <set.json>] [--bridge-grader <id>@<rev>] [--out <suite-result.json>] [--report <file>] [--json]',
    'eval gate --baseline <suite-result.json> --candidate <suite-result.json> [--baseline-arm a] [--candidate-arm b] [--alpha 0.05] [--max-critical-false-release r] [--bridge <bridge.json> …] [--report <file>] [--json]',
    'eval bridge [<suite>] --grader <id>@<revision> --out <bridge.json> [--tier t] [--arms a] [--trials n] [--result-out <suite-result.json>]',
    'eval calibrate [--judge scripted|config] [--judge-route r] [--set <calibration.json>] [--json]',
    'eval calibrate label --set <calibration.json> --packet <recorded-packet.json> --label pass|fail|unknown --by <name> [--note "<text>"]',
    'eval apply-scores <suite-result.json> --out <scores.json> [--min-trials n] [--json]',
  ],
  optionHelp: [
    ['--tier <tier>', 'pr-smoke (fast subset ×1), release-core (core ×5), deep (everything ×5), failure-recovery (chaos ×10, child-process): suite, trials and mode (each overridable)'],
    ['--trials <n>', 'trials per task and arm (default the tier\'s, else 1); reports pass@k and pass^k per k'],
    ['--arms <list>', 'arms to compare (default: the model arms @hypertest/eval provides, else `config`); causal H0…H6 and product arms by name; `deployment` = this configuration file'],
    ['--track <track>', 'cold (default: no long-term memory across trials) or learning (approved experience only, --experience)'],
    ['--experience <file>', 'learning track: experience items seeded into every trial (only approved/published ones are admitted)'],
    ['--suite-dir <dir>', 'the customer/private layer: *.suite.json / *.suite.mjs files of that directory'],
    ['--dataset <file>', 'suite sanity: SWE-bench-style instances (JSON lines) over --repos <dir> (local mirrors; never downloaded)'],
    ['--work-dir <dir>', 'trial workspace (default: a temporary directory, removed afterwards)'],
    ['--keep-work-dir', 'keep the temporary workspace'],
    ['--timeout-ms <n>', 'per-trial timeout'],
    ['--timeout <n>', 'the whole evaluation\'s deadline (ms): cancels the running trial, keeps the partial result (exit 1)'],
    ['--cancel-grace-ms <n>', 'how long a cancelled evaluation may take to settle with its partial result (default 30000); then it is left to finish in the background'],
    ['--mode <mode>', 'in-process (default) or child-process (arms that support it; chaos kills are real SIGKILLs)'],
    ['--judge <kind>', 'add the independent LLM judge (llmRubric, last): scripted = the calibrated CI judge, config = the configuration\'s model routes'],
    ['--judge-route <ids>', '--judge config: the routes the judge may use (default every enabled route)'],
    ['--judge-packets <dir>', 'write every packet the judge saw (for human labelling: eval calibrate label)'],
    ['--calibration <file>', 'the expert-labelled calibration set of the judge (default: the committed set)'],
    ['--bridge-grader <spec>', 'run: also grade every trial with a retained earlier grader revision (<id>@<rev>; never counted)'],
    ['--out <file>', 'persist the SuiteResult as JSON (the input of `eval gate` and `runtime record-suite --from-eval`)'],
    ['--report <file>', 'also write the report (markdown, or JSON with --json) to a file'],
    ['--baseline <file>', 'gate: the SuiteResult JSON of the active runtime/model (eval run --out)'],
    ['--candidate <file>', 'gate: the SuiteResult JSON of the candidate'],
    ['--baseline-arm <id>', 'gate: arm of the baseline (default: its only arm, or the arm both share)'],
    ['--candidate-arm <id>', 'gate: arm of the candidate (default: its only arm, or the baseline arm)'],
    ['--alpha <p>', 'gate: significance level of "defect recall not significantly lower" (exact McNemar; default 0.05)'],
    ['--max-critical-false-release <r>', 'gate: the product SLO on the candidate\'s critical false release rate (default 0)'],
    ['--bridge <file>', 'gate: bridge reports (eval bridge --out) that make results of different grader revisions comparable'],
    ['--grader <spec>', 'bridge: the retained earlier revision <id>@<rev> compared with the current one'],
    ['--set <file>', 'calibrate: the calibration set to measure against / to add a label to'],
    ['--packet <file>', 'calibrate label: a recorded judge packet (eval run --judge-packets)'],
    ['--label <v>', 'calibrate label: the human expert\'s verdict (pass, fail, unknown)'],
    ['--min-trials <n>', 'apply-scores: graded trials a (route, role) pair needs before it is scored (default 3)'],
  ],
  notes: [
    'Suites: poc-a-whitebox, poc-b-event-driven, poc-c-durable-load, oracle-robustness, recovery-chaos, failure-recovery, context-freshness, model-switch, security-injection, test-generation, api-ui-blackbox, performance, fault-tolerance, evidence, multi-agent, core, pr-smoke, deep, sanity (with --dataset), and private suites of --suite-dir.',
    'The `config` arm evaluates the models and role policies of your configuration file; `deployment` the whole file (its trials run under this deployment\'s runtime manifest — the input of runtime record-suite --kind compatibility|release_gate). Live providers need their key variables; scripted providers need --scripted-brains.',
    'eval run: exit code 0 when every trial passed, 1 otherwise (and on --timeout), 130 when interrupted (the partial result is still written to --out, marked cancelled).',
    'eval apply-scores: derives per-route, per-role quality scores from a SuiteResult (graded trials whose agents of the role ran on the route; (passes + 1) / (trials + 2)) and writes them with their provenance to --out. Point models.scoresFile at it: the next start routes with the scores, and its RuntimeManifest records them (modelScores).',
    'eval gate: exit code 0 when the candidate passes every check (critical false release not worse and within the SLO, defect recall not significantly lower and no hidden defect lost on every trial, security violations = 0, duplicate side effects = 0, evidence completeness 100% for critical decisions, comparable results — a grader change only through a bridge without discontinuity — full coverage), 1 otherwise.',
    'eval calibrate: exit 0 when the judge meets the calibration thresholds on the set (its results count), 1 otherwise; `calibrate label` adds a human expert label (a new set revision).',
  ],
  options: {
    trials: { type: 'string' }, arms: { type: 'string' }, 'work-dir': { type: 'string' }, 'keep-work-dir': { type: 'boolean' }, 'timeout-ms': { type: 'string' }, timeout: { type: 'string' }, mode: { type: 'string' },
    out: { type: 'string' }, report: { type: 'string' }, judge: { type: 'string' }, 'judge-route': { type: 'string' }, 'judge-packets': { type: 'string' }, calibration: { type: 'string' },
    baseline: { type: 'string' }, candidate: { type: 'string' }, 'baseline-arm': { type: 'string' }, 'candidate-arm': { type: 'string' }, alpha: { type: 'string' },
    'max-critical-false-release': { type: 'string' }, bridge: { type: 'string', multiple: true }, 'bridge-grader': { type: 'string' }, grader: { type: 'string' }, 'result-out': { type: 'string' },
    tier: { type: 'string' }, track: { type: 'string' }, experience: { type: 'string' }, 'suite-dir': { type: 'string' }, dataset: { type: 'string' }, repos: { type: 'string' }, limit: { type: 'string' },
    set: { type: 'string' }, packet: { type: 'string' }, label: { type: 'string' }, by: { type: 'string' }, note: { type: 'string' },
    'min-trials': { type: 'string' }, 'cancel-grace-ms': { type: 'string' },
  },
  longRunning: true,
  async run(ctx, values, args) {
    if (args[0] === 'gate') return gate(ctx, values, args);
    if (args[0] === 'apply-scores') return applyScores(ctx, values, args);
    if (args[0] === 'bridge') return bridgeCommand(ctx, values, args);
    if (args[0] === 'calibrate') return calibrate(ctx, values, args);
    if (args[0] !== 'run') throw new UsageError(args[0] === undefined ? 'missing sub-command (eval run <suite>)' : `unknown sub-command eval ${args[0]}`, 'eval');
    return runCommand(ctx, values, args);
  },
};
