import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HypertestError, isHypertestError, sha256Hex } from '@hypertest/core';
import type { RuntimeManifest } from '@hypertest/domain';
import type { RuntimeReleaseView } from '@hypertest/app';
import type { ReleaseGateOptions } from '@hypertest/eval';
import { UsageError, flag, int, list, positionals, required, str, type OptionValues } from '../args.ts';
import type { Command } from '../command.ts';
import { withInstance } from '../context.ts';
import { EXIT_CODES } from '../exit-codes.ts';
import { table } from '../format.ts';
import { SANDBOX_ENV } from './decide.ts';
import { bridgeReportsFrom, gateOptionsFrom } from './eval.ts';

/** (F[0]) The suite kinds of the per-stage release gates (`replay` is accepted as the legacy name of `compatibility`). */
const SUITE_KINDS = ['engine_contract', 'compatibility', 'production_replay', 'release_gate'] as const;
const SCHEMA_KEYS = ['event', 'contextSnapshot', 'tool', 'operation', 'evidence'] as const;
const SUBS = ['list', 'show', 'register', 'record-suite', 'promote', 'rollback', 'migrate', 'shadow'] as const;

/**
 * (F[0]) The engine contract suite of each engine kind (the AgentEngine ABI golden suite, `engineContractSuite`) in this
 * installation: `record-suite current --kind engine_contract --run` executes it for the engines the manifest pins.
 */
export const ENGINE_CONTRACT_TESTS: Readonly<Record<string, string>> = Object.freeze({
  native: 'packages/runtime/test/native-engine.test.ts',
  pi: 'packages/runtime-pi/test/pi-engine.test.ts',
  dsh: 'packages/runtime-dsh/test/dsh-engine.test.ts',
});
const INSTALL_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Runs the engine contract suites of `engines` (node --test, contract describe blocks only) ⇒ counts + TAP digest. */
export async function runEngineContract(engines: readonly string[], options: { root?: string; timeoutMs?: number } = {}): Promise<{ total: number; failed: number; digest: string; files: string[] }> {
  const root = options.root ?? INSTALL_ROOT;
  const files: string[] = [];
  for (const e of [...new Set(engines)].sort()) {
    const rel = ENGINE_CONTRACT_TESTS[e];
    if (!rel) throw new HypertestError('unsupported', `no engine contract suite is known for engine ${e}`);
    const file = resolve(root, rel);
    if (!existsSync(file)) throw new HypertestError('unsupported', `the engine contract suite of ${e} (${rel}) is not part of this installation: attest the CI result instead (--passed --report <file>)`);
    files.push(file);
  }
  if (files.length === 0) throw new HypertestError('precondition_failed', 'the manifest pins no engine with a contract suite');
  const out = await new Promise<string>((resolveOut, reject) => {
    // a parent that is itself a node:test run (NODE_TEST_CONTEXT) would switch the child to its internal protocol: no TAP
    const env = { ...process.env };
    delete env['NODE_TEST_CONTEXT'];
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^AgentEngine contract', ...files], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', () => undefined);
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 600_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolveOut(Buffer.concat(chunks).toString('utf8'));
    });
  });
  const count = (name: string): number | undefined => {
    const m = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(out);
    return m ? Number(m[1]) : undefined;
  };
  const pass = count('pass');
  const fail = count('fail');
  const cancelled = count('cancelled') ?? 0;
  if (pass === undefined || fail === undefined) throw new HypertestError('internal', 'the engine contract suite produced no TAP summary');
  return { total: pass + fail + cancelled, failed: fail + cancelled, digest: sha256Hex(out), files: files.map((f) => f.slice(root.length)) };
}

/**
 * The actor of a release decision: `--by <name>` is a human (`human:<name>`); `--by ci:<id>` names an automated
 * pipeline (release gates and suite results recorded by CI). Anything else is a usage error.
 */
export function releaseActor(values: OptionValues): string {
  const by = required('runtime', values, 'by').trim();
  const m = /^(?:(human|ci):)?([\p{L}\p{N}._@+-][\p{L}\p{N}._@+\- ]{0,127})$/u.exec(by);
  if (!m) throw new UsageError(`--by must be a person's name (or ci:<pipeline>), got ${JSON.stringify(by)}`, 'runtime');
  return `${m[1] ?? 'human'}:${m[2]}`;
}

/**
 * Release decisions (register, suite results, promotion, rollback, migration) govern which runtime runs every later
 * TestRun: never taken from inside a Hypertest sandbox (an agent must not promote the runtime it is judged by).
 */
function assertNotSandboxed(env: Record<string, string | undefined>, what: string): void {
  if (env[SANDBOX_ENV]) {
    throw new HypertestError('permission_denied', `runtime ${what} is a release decision and cannot be taken from inside a Hypertest sandbox (${SANDBOX_ENV} is set)`);
  }
}

/** `--allow-migration <schema>:<from>=><to>` entries. */
export function parseAllowances(values: OptionValues): Array<{ schema: (typeof SCHEMA_KEYS)[number]; from: string; to: string }> {
  const raw = values['allow-migration'];
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return items.map((item) => {
    const m = /^([A-Za-z]+):(.+?)=>(.+)$/.exec(item.trim());
    if (!m || !(SCHEMA_KEYS as readonly string[]).includes(m[1]!)) {
      throw new UsageError(`--allow-migration must be <schema>:<from>=><to> with schema one of ${SCHEMA_KEYS.join(', ')} (got ${JSON.stringify(item)})`, 'runtime');
    }
    return { schema: m[1] as (typeof SCHEMA_KEYS)[number], from: m[2]!.trim(), to: m[3]!.trim() };
  });
}

/** `--canary-percent n` / `--canary-label k=v` → a canary selection (undefined when neither is given). */
export function parseCanary(values: OptionValues): { percentage?: number; labels?: Record<string, string> } | undefined {
  const percentage = int('runtime', values, 'canary-percent', { min: 0, max: 100 });
  const labels: Record<string, string> = {};
  for (const item of list(values, 'canary-label')) {
    const i = item.indexOf('=');
    const key = i > 0 ? item.slice(0, i).trim() : '';
    if (key === '') throw new UsageError(`--canary-label must be key=value (got ${JSON.stringify(item)})`, 'runtime');
    labels[key] = item.slice(i + 1).trim();
  }
  if (percentage === undefined && Object.keys(labels).length === 0) return undefined;
  return { ...(percentage !== undefined ? { percentage } : {}), ...(Object.keys(labels).length > 0 ? { labels } : {}) };
}

/**
 * A suite result from an eval SuiteResult JSON (`hypertest eval run … --json`): passed only when trials ran and every
 * trial passed (an infra_error trial is not a pass); the report digest binds the record to the file.
 */
export function suiteFromEval(text: string, file: string): { suiteId: string; suiteRevision?: string; passed: boolean; total: number; failed: number; digest: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`--from-eval ${file} is not JSON: ${(e as Error).message}`, 'runtime');
  }
  const r = doc as { suiteId?: unknown; revision?: unknown; trials?: unknown };
  if (!r || typeof r !== 'object' || typeof r.suiteId !== 'string' || !Array.isArray(r.trials)) {
    throw new UsageError(`--from-eval ${file} is not an eval suite result (suiteId, trials)`, 'runtime');
  }
  const trials = r.trials as Array<{ result?: unknown }>;
  const failed = trials.filter((t) => t?.result !== 'pass').length;
  const out: { suiteId: string; suiteRevision?: string; passed: boolean; total: number; failed: number; digest: string } = {
    suiteId: r.suiteId,
    passed: trials.length > 0 && failed === 0,
    total: trials.length,
    failed,
    digest: sha256Hex(text),
  };
  if (typeof r.revision === 'string' && r.revision !== '') out.suiteRevision = r.revision;
  return out;
}

function releaseRows(views: RuntimeReleaseView[]): string[][] {
  return views.map((v) => [
    `${v.current ? '*' : ' '} ${v.manifestId}`,
    `${v.state}${v.rolledBack ? ' (rolled back)' : ''}`,
    v.active ? 'yes' : '',
    v.canary ? [v.canary.percentage ? `${v.canary.percentage}%` : '', ...Object.entries(v.canary.labels ?? {}).map(([k, x]) => `${k}=${x}`)].filter(Boolean).join(',') : '',
    String(v.liveRuns),
    v.manifest.hypertest.version,
    v.registeredBy,
  ]);
}

export const runtimeCommand: Command = {
  name: 'runtime',
  summary: 'runtime releases: list, register, record compatibility suites, promote, roll back, migrate a live run',
  usage: [
    'runtime list [--json]',
    'runtime show [<manifestId>|current] [--json]',
    'runtime register [--manifest <file.json>] [--allow-migration <schema>:<from>=><to> …] --by <name>',
    'runtime record-suite current --kind engine_contract --run --by <name>',
    'runtime record-suite <manifestId>|current --kind engine_contract --suite <id> [--revision <r>] (--passed --report <file> | --failed) [--total n] [--failures n] [--detail "<text>"] --by <name>',
    'runtime record-suite <manifestId>|current --kind compatibility --from-eval <SuiteResult.json> --by <name>',
    'runtime record-suite <manifestId>|current --kind production_replay --from-shadow [--min-runs n] --by <name>',
    'runtime record-suite <manifestId>|current --kind release_gate --from-eval <core-SuiteResult.json> --baseline <SuiteResult.json> [--baseline-arm a] [--candidate-arm b] [--alpha p] [--max-critical-false-release r] [--bridge <bridge.json> …] --by <name>',
    'runtime shadow [<runId> …] [--limit n] [--timeout-ms n] --by <name>',
    'runtime promote <manifestId>|current --by <name> --reason "<text>" [--canary-percent n] [--canary-label key=value …]',
    'runtime rollback [<manifestId>] --by <name> --reason "<text>"',
    'runtime migrate <runId> --to <manifestId>|current --by <name> --reason "<text>" [--checkpoint-timeout-ms n]',
    'runtime migrate <runId> --abort --by <name> --reason "<text>"',
  ],
  optionHelp: [
    ['--by <name>', 'the human (or ci:<pipeline>) taking the release decision; recorded in the release history'],
    ['--manifest <file>', 'register a manifest exported by another installation (`runtime show --json`); default: this runtime'],
    ['--allow-migration <spec>', 'a schema change runs may take when migrated onto this release, e.g. event:collab/005-append-only=>collab/006-x'],
    ['--kind <kind>', 'engine_contract (AgentEngine contract suite) | compatibility (an eval suite run on this runtime) | production_replay (the shadow comparisons) | release_gate (core eval vs baseline); `replay` = compatibility'],
    ['--run', 'engine_contract: execute the engine contract suites of the engines this runtime pins (bound: executed here)'],
    ['--report <file>', 'the report an attested result rests on (its sha256 is recorded); required with --passed'],
    ['--from-eval <file>', 'an eval SuiteResult JSON (eval run --out): every trial must pass AND have run under the manifest'],
    ['--from-shadow', 'production_replay: summarize this shadow release\'s recorded comparisons (no divergence allowed)'],
    ['--baseline <file>', 'release_gate: the committed baseline SuiteResult the core candidate is gated against (eval gate)'],
    ['--baseline-arm / --candidate-arm', 'release_gate: the arms compared (e.g. the baseline\'s scripted-multi-llm vs the candidate\'s deployment)'],
    ['--max-critical-false-release <r>', 'release_gate: the product SLO on the candidate\'s critical false release rate (default 0)'],
    ['--limit <n>', 'shadow: how many selected production runs to mirror (default 10)'],
    ['--timeout-ms <n>', 'shadow: how long one mirrored run may take (default runtime.shadow.timeoutMs or 600000)'],
    ['--canary-percent <n>', 'entering canary: the share of new runs (by run id) the canary serves'],
    ['--canary-label <k=v>', 'entering canary: runs carrying this label are served by the canary'],
    ['--checkpoint-timeout-ms <n>', 'migrate: how long in-flight turns may take to give their claims back (default 90000)'],
    ['--abort', 'migrate: release the checkpoint of an abandoned migration (run paused migrating): the run continues on its own runtime'],
  ],
  notes: [
    'Releases move candidate → shadow → canary → active one step per `promote`, each behind its own gate (the LATEST result of each kind, bound to that manifest): → shadow engine_contract + compatibility; → canary + production_replay; → active + release_gate (the CORE eval only). New runs are created only under the active release (or a canary that selects them); a shadow release creates only mirrored, dry-run runs (`runtime shadow`); an installation that never activated a release runs unmanaged (runtime.requireActiveRelease: true refuses instead).',
    '`shadow` runs on the SHADOW release\'s installation: it mirrors finished runs of the active release (the given ones, else those runtime.shadow selects) with every external effect dry-run (recorded not_applied, never dispatched), compares each decision with the production one and records the comparison; `record-suite --kind production_replay --from-shadow` turns them into the gate of shadow → canary.',
    '`rollback` without a manifest stops the canary, else rolls the active release back to the previous one; the rolled-back release is retired for good and its live runs are quarantined (paused until migrated or cancelled). Old runs keep running on the manifest they are pinned to.',
    '`migrate` checkpoints the run (pause), takes a canonical snapshot, reconciles its operations (refused while any is unsettled), checks compatibility with the target (active or canary, same schemas or an allowed migration, the engines the run used), records a runtime epoch (run.migrated) and re-pins it. The target runtime drives it afterwards (`hypertest resume` there). `migrate <runId> --abort` releases the checkpoint of a migration whose process died before the re-pin (the run stays paused migrating otherwise): the run continues on the runtime it is still pinned to.',
    `Every decision is refused (permission_denied) when $${SANDBOX_ENV} is set.`,
  ],
  options: {
    by: { type: 'string' },
    reason: { type: 'string' },
    manifest: { type: 'string' },
    'allow-migration': { type: 'string', multiple: true },
    kind: { type: 'string' },
    suite: { type: 'string' },
    revision: { type: 'string' },
    passed: { type: 'boolean' },
    failed: { type: 'boolean' },
    total: { type: 'string' },
    failures: { type: 'string' },
    'from-eval': { type: 'string' },
    report: { type: 'string' },
    detail: { type: 'string' },
    'canary-percent': { type: 'string' },
    run: { type: 'boolean' },
    'from-shadow': { type: 'boolean' },
    'min-runs': { type: 'string' },
    baseline: { type: 'string' },
    alpha: { type: 'string' },
    'max-critical-false-release': { type: 'string' },
    'baseline-arm': { type: 'string' },
    'candidate-arm': { type: 'string' },
    bridge: { type: 'string', multiple: true },
    limit: { type: 'string' },
    'timeout-ms': { type: 'string' },
    'canary-label': { type: 'string', multiple: true },
    to: { type: 'string' },
    'checkpoint-timeout-ms': { type: 'string' },
    abort: { type: 'boolean' },
  },
  async run(ctx, values, args) {
    const sub = args[0];
    if (!(SUBS as readonly (string | undefined)[]).includes(sub)) {
      throw new UsageError(sub === undefined ? `missing sub-command (runtime ${SUBS.join(' | ')})` : `unknown sub-command runtime ${sub} (${SUBS.join(', ')})`, 'runtime');
    }

    if (sub === 'list') {
      positionals('runtime', args, ['list']);
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const views = await ht.releases.list();
        if (ctx.global.json) {
          ctx.json({ current: ht.manifest.manifestId, releases: views });
          return EXIT_CODES.ok;
        }
        if (views.length === 0) ctx.out(`no runtime releases registered (unmanaged); this runtime is ${ht.manifest.manifestId}`);
        else for (const l of table(['MANIFEST (* this runtime)', 'STATE', 'ACTIVE', 'CANARY', 'LIVE RUNS', 'VERSION', 'REGISTERED BY'], releaseRows(views))) ctx.out(l);
        return EXIT_CODES.ok;
      });
    }

    if (sub === 'show') {
      const [, ref] = positionals('runtime', args, ['show'], ['manifestId']);
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const id = ref === undefined ? ht.manifest.manifestId : await ht.releases.resolve(ref);
        const release = await ht.releases.registry.get(id);
        const manifest: RuntimeManifest | undefined = release?.manifest ?? (id === ht.manifest.manifestId ? ht.manifest : undefined);
        if (!manifest) throw new HypertestError('not_found', `runtime manifest ${id} is not registered`);
        if (ctx.global.json) {
          ctx.json(manifest);
          return EXIT_CODES.ok;
        }
        ctx.out(`manifest   ${manifest.manifestId}${id === ht.manifest.manifestId ? ' (this runtime)' : ''}`);
        ctx.out(`state      ${release ? `${release.state}${release.rolledBack ? ' (rolled back)' : ''}` : 'not registered'}`);
        const h = manifest.hypertest;
        ctx.out(`hypertest  ${h.version}${h.gitSha ? ` git ${h.gitSha}` : ''}${h.imageDigest ? ` image ${h.imageDigest}` : ''}${h.sourceDigest ? ` source ${h.sourceDigest.slice(0, 16)}` : ''}`);
        for (const e of manifest.agentEngines) ctx.out(`engine     ${e.kind} ${e.version ?? '?'}${e.adapter ? ` (adapter ${e.adapter.package} ${e.adapter.version})` : ''}${manifest.defaultEngine === e.kind ? ' [default]' : ''}`);
        ctx.out(`schemas    ${Object.entries(manifest.schemas).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        ctx.out(`catalogs   models ${manifest.modelCatalogRevision}, tools ${manifest.toolCatalogRevision}, roles ${manifest.roleCatalogRevision ?? '-'}`);
        ctx.out(`policy     ${manifest.policyBundleRevision}`);
        if (manifest.protocol) ctx.out(`protocol   ${manifest.protocol.id} ${manifest.protocol.version} ${manifest.protocol.digest}`);
        if (release) for (const r of await ht.releases.registry.suiteResults(id)) ctx.out(`suite      ${r.kind} ${r.suiteId}${r.suiteRevision ? `@${r.suiteRevision}` : ''} ${r.passed ? 'PASS' : 'FAIL'} (${r.recordedBy}, ${r.recordedAt})`);
        return EXIT_CODES.ok;
      });
    }

    if (sub === 'register') {
      positionals('runtime', args, ['register']);
      const by = releaseActor(values);
      const allowedMigrations = parseAllowances(values);
      assertNotSandboxed(ctx.io.env, 'register');
      const file = str(values, 'manifest');
      let manifest: RuntimeManifest | undefined;
      if (file !== undefined) {
        try {
          manifest = JSON.parse(await readFile(resolve(ctx.io.cwd, file), 'utf8')) as RuntimeManifest;
        } catch (e) {
          throw new UsageError(`--manifest ${file}: ${(e as Error).message}`, 'runtime');
        }
      }
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const { release, created } = await ht.releases.register({ by, allowedMigrations, ...(manifest ? { manifest } : {}) });
        if (ctx.global.json) ctx.json({ release, created });
        else ctx.out(`runtime ${release.manifestId} ${created ? 'registered as a candidate' : `already registered (${release.state})`}`);
        return EXIT_CODES.ok;
      });
    }

    if (sub === 'record-suite') {
      const [, ref] = positionals('runtime', args, ['record-suite', 'manifestId']);
      const by = releaseActor(values);
      let kind = required('runtime', values, 'kind');
      if (kind === 'replay') {
        ctx.err('note: --kind replay is the legacy name of compatibility (an eval suite run on this runtime)');
        kind = 'compatibility';
      }
      if (!(SUITE_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind must be one of ${SUITE_KINDS.join(', ')}`, 'runtime');
      const fromEval = str(values, 'from-eval');
      const fromShadow = flag(values, 'from-shadow');
      const runHere = flag(values, 'run');
      const passedFlag = flag(values, 'passed');
      const failedFlag = flag(values, 'failed');
      const manualCounts = str(values, 'total') !== undefined || str(values, 'failures') !== undefined;
      const sources = [fromEval !== undefined, fromShadow, runHere, passedFlag || failedFlag].filter(Boolean).length;
      if (fromEval !== undefined && (passedFlag || failedFlag || manualCounts)) {
        throw new UsageError('--from-eval takes pass/fail and counts from the suite result: do not combine it with --passed/--failed/--total/--failures', 'runtime');
      }
      if (sources !== 1 || (passedFlag && failedFlag)) throw new UsageError('give exactly one of --passed, --failed, --run, --from-eval or --from-shadow', 'runtime');
      // (F[0], e2e[5]) which evidence each kind accepts: a pass is never a bare claim
      if (kind === 'engine_contract' && (fromEval !== undefined || fromShadow)) throw new UsageError('engine_contract: --run (execute it here) or --passed --report <file> / --failed (a CI attestation)', 'runtime');
      if (kind === 'engine_contract' && passedFlag && str(values, 'report') === undefined) throw new UsageError('engine_contract --passed attests a CI report: give it with --report <file> (or execute the suite with --run)', 'runtime');
      if (kind === 'compatibility' && (passedFlag || runHere || fromShadow)) throw new UsageError('compatibility: --from-eval <SuiteResult.json> of an eval run on this runtime (or --failed)', 'runtime');
      if (kind === 'production_replay' && !fromShadow) throw new UsageError('production_replay: --from-shadow (the comparisons `hypertest runtime shadow` recorded on the shadow release)', 'runtime');
      if (kind === 'release_gate' && fromEval === undefined) throw new UsageError('release_gate: --from-eval <core SuiteResult.json> --baseline <baseline SuiteResult.json>', 'runtime');
      for (const option of ['baseline', 'baseline-arm', 'candidate-arm', 'alpha', 'max-critical-false-release', 'bridge']) {
        if (kind !== 'release_gate' && (option === 'bridge' ? list(values, option).length > 0 : str(values, option) !== undefined)) throw new UsageError(`--${option} belongs to --kind release_gate`, 'runtime');
      }
      assertNotSandboxed(ctx.io.env, 'record-suite');
      const readText = async (option: string, file: string): Promise<string> => {
        try {
          return await readFile(resolve(ctx.io.cwd, file), 'utf8');
        } catch (e) {
          throw new UsageError(`--${option} ${file}: ${(e as Error).message}`, 'runtime');
        }
      };
      const parse = (option: string, file: string, text: string): unknown => {
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new UsageError(`--${option} ${file} is not JSON: ${(e as Error).message}`, 'runtime');
        }
      };
      const print = (result: { kind: string; suiteId: string; suiteRevision?: string; passed: boolean; resultId: string; summary: { detail?: string } }, manifestId: string): number => {
        if (ctx.global.json) ctx.json(result);
        else {
          ctx.out(`${result.kind} suite ${result.suiteId}${result.suiteRevision ? `@${result.suiteRevision}` : ''} recorded for ${manifestId}: ${result.passed ? 'PASS' : 'FAIL'} (${result.resultId})`);
          if (!result.passed && result.summary.detail) ctx.out(`  ${result.summary.detail}`);
        }
        return EXIT_CODES.ok;
      };

      if (kind === 'release_gate') {
        const candidateText = await readText('from-eval', fromEval!);
        const baselinePath = required('runtime', values, 'baseline');
        const baselineText = await readText('baseline', baselinePath);
        const candidate = parse('from-eval', fromEval!, candidateText);
        const baseline = parse('baseline', baselinePath, baselineText);
        const options: ReleaseGateOptions = await gateOptionsFrom(ctx, values, 'runtime');
        const bridges = await bridgeReportsFrom(ctx, values, 'runtime');
        if (bridges.length > 0) options.bridges = bridges;
        let ev;
        try {
          ev = await ctx.io.loadEval();
        } catch (e) {
          throw new HypertestError('unavailable', `the eval platform (@hypertest/eval) could not be loaded: ${(e as Error).message}`, { cause: e });
        }
        if (typeof ev.evaluateReleaseGate !== 'function') throw new HypertestError('unsupported', '@hypertest/eval does not export evaluateReleaseGate');
        // (review, F[13]) "core" is the BUILT-IN core suite at its current revision and content (a private suite or another
        // revision named core is not the core eval): candidate and baseline alike. Another suite id is refused by the
        // release service (candidate) or makes the gate not comparable (baseline)
        const coreSuite = ev['coreSuite'];
        const fingerprintOf = ev['suiteFingerprint'];
        if (typeof coreSuite !== 'function' || typeof fingerprintOf !== 'function') throw new HypertestError('unsupported', '@hypertest/eval does not export coreSuite / suiteFingerprint: the core suite cannot be verified');
        const core = (coreSuite as () => { suiteId: string; revision: string; tasks: unknown[] })();
        const expected = (fingerprintOf as (s: unknown) => string)(core);
        for (const [option, file, doc] of [['from-eval', fromEval!, candidate], ['baseline', baselinePath, baseline]] as const) {
          const d = (doc ?? {}) as { suiteId?: unknown; revision?: unknown; suiteFingerprint?: unknown };
          if (d.suiteId !== core.suiteId) continue;
          if (d.revision !== core.revision || d.suiteFingerprint !== expected) {
            const has = d.revision !== core.revision ? `revision ${String(d.revision)}` : `fingerprint ${typeof d.suiteFingerprint === 'string' ? d.suiteFingerprint.slice(0, 12) : 'none'}`;
            throw new HypertestError('precondition_failed', `--${option} ${file} is not the built-in core suite (${core.suiteId}@${core.revision}, content fingerprint ${expected.slice(0, 12)}…): its result has ${has} — run \`hypertest eval run core\` of this installation`);
          }
        }
        let report;
        try {
          report = ev.evaluateReleaseGate(baseline as never, candidate as never, options);
        } catch (e) {
          if (isHypertestError(e, 'invalid_argument')) throw new UsageError(e.message, 'runtime');
          throw e;
        }
        return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
          const manifestId = await ht.releases.resolve(ref!);
          const result = await ht.releases.recordReleaseGate({ manifestId, candidate, baseline, candidateDigest: sha256Hex(candidateText), baselineDigest: sha256Hex(baselineText), report, by });
          return print(result, manifestId);
        });
      }
      if (kind === 'compatibility' && fromEval !== undefined) {
        const text = await readText('from-eval', fromEval);
        const doc = parse('from-eval', fromEval, text);
        // the shape is checked here (a usage error), the binding by the release service
        suiteFromEval(text, fromEval);
        const detail = str(values, 'detail');
        return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
          const manifestId = await ht.releases.resolve(ref!);
          const result = await ht.releases.recordEvalSuite({ manifestId, kind: 'compatibility', result: doc, digest: sha256Hex(text), by, ...(detail !== undefined ? { detail } : {}) });
          return print(result, manifestId);
        });
      }
      if (kind === 'production_replay') {
        const minRuns = int('runtime', values, 'min-runs', { min: 1 });
        return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
          const manifestId = await ht.releases.resolve(ref!);
          const result = await ht.releases.recordProductionReplay({ manifestId, by, ...(minRuns !== undefined ? { minRuns } : {}) });
          return print(result, manifestId);
        });
      }
      if (runHere) {
        return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
          const manifestId = await ht.releases.resolve(ref!);
          if (manifestId !== ht.manifest.manifestId) throw new UsageError(`--run executes the suite of THIS installation (${ht.manifest.manifestId}): name it as current`, 'runtime');
          const engines = ht.manifest.agentEngines.map((e) => e.kind).filter((k) => Object.hasOwn(ENGINE_CONTRACT_TESTS, k));
          if (!ctx.global.json) ctx.err(`running the AgentEngine contract suite of ${engines.join(', ')} …`);
          const r = await runEngineContract(engines);
          const result = await ht.releases.recordSuite({
            manifestId, kind: 'engine_contract', suiteId: 'agent-engine-contract', passed: r.total > 0 && r.failed === 0, by,
            summary: { total: r.total, failed: r.failed, detail: `executed here: ${r.files.join(', ')}` }, reportDigest: r.digest,
            ...(r.failed === 0 && r.total > 0 ? { binding: { kind: 'executed' as const, manifestIds: [manifestId] } } : {}),
          });
          return print(result, manifestId);
        });
      }
      // a manual record: an engine contract attestation (--passed needs its report) or a failure of any kind
      const suiteId = str(values, 'suite');
      if (suiteId === undefined || suiteId.trim() === '') throw new UsageError('--suite is required', 'runtime');
      const suiteRevision = str(values, 'revision');
      const summary: { total?: number; failed?: number; detail?: string } = {};
      const total = int('runtime', values, 'total', { min: 0 });
      const failures = int('runtime', values, 'failures', { min: 0 });
      if (total !== undefined) summary.total = total;
      if (failures !== undefined) summary.failed = failures;
      const detail = str(values, 'detail');
      if (detail !== undefined) summary.detail = detail;
      let reportDigest: string | undefined;
      const report = str(values, 'report');
      if (report !== undefined) {
        try {
          reportDigest = sha256Hex(await readFile(resolve(ctx.io.cwd, report)));
        } catch (e) {
          throw new UsageError(`--report ${report}: ${(e as Error).message}`, 'runtime');
        }
      }
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const manifestId = await ht.releases.resolve(ref!);
        const result = await ht.releases.recordSuite({
          manifestId, kind: kind as (typeof SUITE_KINDS)[number], suiteId, passed: passedFlag, summary, by,
          ...(suiteRevision !== undefined ? { suiteRevision } : {}), ...(reportDigest !== undefined ? { reportDigest } : {}),
          ...(passedFlag ? { binding: { kind: 'attested' as const } } : {}),
        });
        return print(result, manifestId);
      });
    }

    if (sub === 'shadow') {
      const runIds = args.slice(1);
      const by = releaseActor(values);
      const limit = int('runtime', values, 'limit', { min: 1, max: 1000 });
      const timeoutMs = int('runtime', values, 'timeout-ms', { min: 1 });
      assertNotSandboxed(ctx.io.env, 'shadow');
      return withInstance(ctx, { drivesAgents: true }, async ({ ht }) => {
        const sources = runIds.length > 0 ? runIds : await ht.releases.shadowCandidates({ limit: limit ?? 10 });
        if (sources.length === 0) {
          if (ctx.global.json) ctx.json({ mirrored: [] });
          else ctx.out('no production run to mirror (runtime.shadow selects finished runs of the active release that were not mirrored yet)');
          return EXIT_CODES.ok;
        }
        const mirrored = [];
        for (const runId of sources) {
          if (ctx.signal.aborted) break;
          if (!ctx.global.json) ctx.err(`mirroring ${runId} (dry-run) …`);
          const m = await ht.releases.mirror(runId, { by, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
          mirrored.push(m);
          if (!ctx.global.json) {
            const c = m.comparison;
            ctx.out(`${runId} → ${m.shadowRunId}: ${c.diverged ? `DIVERGED (${c.divergences.join('; ')})` : 'equivalent'} [verdict ${c.sourceVerdict ?? 'none'} → ${c.shadowVerdict ?? 'none'}]${m.created ? '' : ' (mirrored before)'}`);
          }
        }
        if (ctx.global.json) ctx.json({ mirrored });
        else ctx.out(`record the production replay with \`hypertest runtime record-suite current --kind production_replay --from-shadow --by <name>\``);
        return ctx.signal.aborted ? EXIT_CODES.interrupted : EXIT_CODES.ok;
      });
    }

    if (sub === 'promote') {
      const [, ref] = positionals('runtime', args, ['promote', 'manifestId']);
      const by = releaseActor(values);
      const reason = required('runtime', values, 'reason');
      const canary = parseCanary(values);
      assertNotSandboxed(ctx.io.env, 'promote');
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const id = await ht.releases.resolve(ref!);
        const result = await ht.releases.promote(id, { by, reason, ...(canary ? { canary } : {}) });
        if (ctx.global.json) ctx.json(result);
        else {
          ctx.out(`runtime ${id} promoted ${result.transition.fromState} → ${result.transition.toState}`);
          if (result.retiring) ctx.out(`runtime ${result.retiring.manifestId} is retiring (its live runs continue on it)`);
          for (const r of result.retired) ctx.out(`runtime ${r} retired (no live runs)`);
        }
        return EXIT_CODES.ok;
      });
    }

    if (sub === 'rollback') {
      const [, ref] = positionals('runtime', args, ['rollback'], ['manifestId']);
      const by = releaseActor(values);
      const reason = required('runtime', values, 'reason');
      assertNotSandboxed(ctx.io.env, 'rollback');
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const result = await ht.releases.rollback({ by, reason, ...(ref !== undefined ? { manifestId: await ht.releases.resolve(ref) } : {}) });
        if (ctx.global.json) ctx.json(result);
        else {
          ctx.out(`runtime ${result.rolledBack.manifestId} rolled back (${result.fromState} → retired)`);
          if (result.restored) ctx.out(`active release is ${result.restored.manifestId} again`);
          ctx.out(result.quarantined.length === 0 ? 'no live runs were quarantined' : `quarantined runs: ${result.quarantined.join(', ')} (migrate them with \`hypertest runtime migrate <runId> --to <manifestId>\`, or cancel them)`);
          ctx.out('re-run the compatibility / golden suites against the active release (hypertest runtime record-suite)');
        }
        return EXIT_CODES.ok;
      });
    }

    // migrate
    const [, runId] = positionals('runtime', args, ['migrate', 'runId']);
    const by = releaseActor(values);
    const reason = required('runtime', values, 'reason');
    if (flag(values, 'abort')) {
      if (str(values, 'to') !== undefined || str(values, 'checkpoint-timeout-ms') !== undefined) throw new UsageError('--abort releases an abandoned checkpoint: do not combine it with --to or --checkpoint-timeout-ms', 'runtime');
      assertNotSandboxed(ctx.io.env, 'migrate --abort');
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const run = await ht.releases.releaseCheckpoint(runId!, { by, reason });
        if (ctx.global.json) ctx.json(run);
        else {
          ctx.out(`run ${runId}: the checkpoint of the abandoned migration is released; status ${run.status}, still pinned to ${run.runtimeManifestId}`);
          ctx.out(run.runtimeManifestId === ht.manifest.manifestId ? 'resume it with `hypertest resume`' : `the runtime ${run.runtimeManifestId} drives it (\`hypertest resume\` there)`);
        }
        return EXIT_CODES.ok;
      });
    }
    const to = required('runtime', values, 'to');
    const checkpointTimeoutMs = int('runtime', values, 'checkpoint-timeout-ms', { min: 0 });
    assertNotSandboxed(ctx.io.env, 'migrate');
    return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
      const result = await ht.releases.migrate(runId!, { to, by, reason, ...(checkpointTimeoutMs !== undefined ? { checkpointTimeoutMs } : {}) });
      if (ctx.global.json) ctx.json(result);
      else {
        ctx.out(`run ${runId} migrated ${result.epoch.fromManifestId} → ${result.epoch.toManifestId} (runtime epoch ${result.epoch.seq}, ${result.epoch.epochId})`);
        ctx.out(`status ${result.run.status}${result.run.pauseReason ? ` (${result.run.pauseReason})` : ''}; checkpoint snapshot ${result.epoch.snapshotId}`);
        if (result.run.status === 'running') {
          ctx.out(result.epoch.toManifestId === ht.manifest.manifestId ? 'resume it with `hypertest resume`' : `the runtime ${result.epoch.toManifestId} drives it (\`hypertest resume\` there)`);
        }
      }
      return EXIT_CODES.ok;
    });
  },
};
