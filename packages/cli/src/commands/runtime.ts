import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HypertestError, sha256Hex } from '@hypertest/core';
import type { RuntimeManifest } from '@hypertest/domain';
import type { RuntimeReleaseView } from '@hypertest/app';
import { UsageError, flag, int, list, positionals, required, str, type OptionValues } from '../args.ts';
import type { Command } from '../command.ts';
import { withInstance } from '../context.ts';
import { EXIT_CODES } from '../exit-codes.ts';
import { table } from '../format.ts';
import { SANDBOX_ENV } from './decide.ts';

const SUITE_KINDS = ['engine_contract', 'replay'] as const;
const SCHEMA_KEYS = ['event', 'contextSnapshot', 'tool', 'operation', 'evidence'] as const;
const SUBS = ['list', 'show', 'register', 'record-suite', 'promote', 'rollback', 'migrate'] as const;

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
    'runtime record-suite <manifestId>|current --kind engine_contract|replay (--suite <id> [--revision <r>] --passed|--failed [--total n] [--failures n] | --from-eval <SuiteResult.json>) [--report <file>] [--detail "<text>"] --by <name>',
    'runtime promote <manifestId>|current --by <name> --reason "<text>" [--canary-percent n] [--canary-label key=value …]',
    'runtime rollback [<manifestId>] --by <name> --reason "<text>"',
    'runtime migrate <runId> --to <manifestId>|current --by <name> --reason "<text>" [--checkpoint-timeout-ms n]',
    'runtime migrate <runId> --abort --by <name> --reason "<text>"',
  ],
  optionHelp: [
    ['--by <name>', 'the human (or ci:<pipeline>) taking the release decision; recorded in the release history'],
    ['--manifest <file>', 'register a manifest exported by another installation (`runtime show --json`); default: this runtime'],
    ['--allow-migration <spec>', 'a schema change runs may take when migrated onto this release, e.g. event:collab/005-append-only=>collab/006-x'],
    ['--kind <kind>', 'engine_contract (the AgentEngine contract suite) or replay (a replay / golden eval suite)'],
    ['--from-eval <file>', 'take suite id, revision and pass/fail from an eval SuiteResult JSON (every trial must pass)'],
    ['--canary-percent <n>', 'entering canary: the share of new runs (by run id) the canary serves'],
    ['--canary-label <k=v>', 'entering canary: runs carrying this label are served by the canary'],
    ['--checkpoint-timeout-ms <n>', 'migrate: how long in-flight turns may take to give their claims back (default 90000)'],
    ['--abort', 'migrate: release the checkpoint of an abandoned migration (run paused migrating): the run continues on its own runtime'],
  ],
  notes: [
    'Releases move candidate → shadow → canary → active one step per `promote`; every step needs the LATEST recorded engine_contract and replay results of that manifest to be passes. New runs are created only under the active release (or a canary that selects them); an installation that never activated a release runs unmanaged (runtime.requireActiveRelease: true refuses instead).',
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
      const kind = required('runtime', values, 'kind');
      if (!(SUITE_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind must be one of ${SUITE_KINDS.join(', ')}`, 'runtime');
      const fromEval = str(values, 'from-eval');
      const passedFlag = flag(values, 'passed');
      const failedFlag = flag(values, 'failed');
      if (fromEval !== undefined && (passedFlag || failedFlag || str(values, 'total') !== undefined || str(values, 'failures') !== undefined)) {
        throw new UsageError('--from-eval takes pass/fail and counts from the suite result: do not combine it with --passed/--failed/--total/--failures', 'runtime');
      }
      if (fromEval === undefined && passedFlag === failedFlag) throw new UsageError('give exactly one of --passed, --failed or --from-eval', 'runtime');
      assertNotSandboxed(ctx.io.env, 'record-suite');
      let suiteId = str(values, 'suite');
      let suiteRevision = str(values, 'revision');
      let passed = passedFlag;
      const summary: { total?: number; failed?: number; detail?: string } = {};
      let reportDigest: string | undefined;
      if (fromEval !== undefined) {
        let text: string;
        try {
          text = await readFile(resolve(ctx.io.cwd, fromEval), 'utf8');
        } catch (e) {
          throw new UsageError(`--from-eval ${fromEval}: ${(e as Error).message}`, 'runtime');
        }
        const r = suiteFromEval(text, fromEval);
        if (suiteId !== undefined && suiteId !== r.suiteId) throw new UsageError(`--suite ${suiteId} differs from the suite result's suiteId ${r.suiteId}`, 'runtime');
        suiteId = r.suiteId;
        if (suiteRevision === undefined && r.suiteRevision !== undefined) suiteRevision = r.suiteRevision;
        passed = r.passed;
        summary.total = r.total;
        summary.failed = r.failed;
        reportDigest = r.digest;
      } else {
        const total = int('runtime', values, 'total', { min: 0 });
        const failures = int('runtime', values, 'failures', { min: 0 });
        if (total !== undefined) summary.total = total;
        if (failures !== undefined) summary.failed = failures;
      }
      if (suiteId === undefined || suiteId.trim() === '') throw new UsageError('--suite is required (or --from-eval)', 'runtime');
      const detail = str(values, 'detail');
      if (detail !== undefined) summary.detail = detail;
      const report = str(values, 'report');
      if (report !== undefined && reportDigest === undefined) {
        try {
          reportDigest = sha256Hex(await readFile(resolve(ctx.io.cwd, report)));
        } catch (e) {
          throw new UsageError(`--report ${report}: ${(e as Error).message}`, 'runtime');
        }
      }
      return withInstance(ctx, { drivesAgents: false }, async ({ ht }) => {
        const manifestId = await ht.releases.resolve(ref!);
        const result = await ht.releases.recordSuite({
          manifestId, kind: kind as (typeof SUITE_KINDS)[number], suiteId: suiteId!, passed, summary, by,
          ...(suiteRevision !== undefined ? { suiteRevision } : {}), ...(reportDigest !== undefined ? { reportDigest } : {}),
        });
        if (ctx.global.json) ctx.json(result);
        else ctx.out(`${result.kind} suite ${result.suiteId}${result.suiteRevision ? `@${result.suiteRevision}` : ''} recorded for ${manifestId}: ${result.passed ? 'PASS' : 'FAIL'} (${result.resultId})`);
        return EXIT_CODES.ok;
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
