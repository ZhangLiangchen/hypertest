/**
 * (coverage[14]) The other two layers of the eval platform (architecture-improvements §评测套件), next to the Hypertest
 * core layer:
 *
 * - the CUSTOMER / PRIVATE layer: suites loaded from a directory (`hypertest eval run <suite> --suite-dir <dir>`) —
 *   declarative `*.suite.json` files (git-repository or URL targets, expected verdicts, hidden faults, graders, oracles,
 *   tool and safety constraints) or ES modules `*.suite.mjs|ts` exporting an EvalSuite (or a factory). Their content is
 *   fingerprinted with the directory (suiteFingerprint): a private suite is versioned like a built-in one, and it never
 *   reaches an agent's long-term memory (the cold track is the default).
 * - the PUBLIC SANITY layer: SWE-bench-style instances (JSON lines: instance_id, repo, base_commit, problem_statement,
 *   patch, test_patch, FAIL_TO_PASS, PASS_TO_PASS) turned into Hypertest testing tasks over a LOCAL mirror of the
 *   repositories: per instance, the gold patch is a releasable candidate (expected pass) and the unfixed base with the
 *   issue's tests is a defective one (expected fail, hidden fault = the failing tests). The public datasets cannot be
 *   downloaded in this environment: the live sanity run is deferred; the loader and a local fixture instance are tested.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HypertestError } from '@hypertest/core';
import type { QualityVerdict } from '@hypertest/domain';
import type { EvalOracle, EvalSuite, EvalTask, HiddenFault, SafetyConstraint, TrialFixture } from './contracts.ts';
import { createGitFixtureRepo } from './fixtures.ts';
import { filesDigest, suiteFingerprint } from './suite-versions.ts';

// ------------------------------------------------------------------------------------------------ private layer

/** One task of a declarative private suite (`*.suite.json`). */
export interface DeclarativeTask {
  taskId: string;
  title?: string;
  goal: string;
  /** A repository built from directories (relative to the suite file): `base` committed, then `candidate` over it. */
  repo?: { base: string; candidate?: string };
  /** A black-box target instead: the system's URL. */
  sutUrl?: string;
  expectedVerdict: QualityVerdict | QualityVerdict[];
  hiddenFaults?: HiddenFault[];
  graders?: string[];
  oracles?: EvalOracle[];
  gate?: EvalTask['gate'];
  budget?: EvalTask['budget'];
  allowedTools?: string[];
  safetyConstraints?: SafetyConstraint[];
  tiers?: EvalTask['tiers'];
}

export interface DeclarativeSuite {
  suiteId: string;
  revision: string;
  tasks: DeclarativeTask[];
}

const DEFAULT_PRIVATE_GRADERS = ['verdict', 'defectDetected', 'evidenceCompleteness', 'evidenceIntegrity', 'policyViolation', 'auditReconstruction'];

function declarativeProblems(doc: unknown, file: string): string[] {
  const d = doc as Partial<DeclarativeSuite> | null;
  if (!d || typeof d !== 'object') return [`${file}: not a JSON object`];
  const out: string[] = [];
  if (typeof d.suiteId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(d.suiteId)) out.push(`${file}: suiteId must be a lowercase id (a-z, 0-9, -)`);
  if (typeof d.revision !== 'string' || d.revision.trim() === '') out.push(`${file}: revision is required`);
  if (!Array.isArray(d.tasks) || d.tasks.length === 0) out.push(`${file}: tasks must list at least one task`);
  for (const [i, t] of (Array.isArray(d.tasks) ? d.tasks : []).entries()) {
    const at = `${file}: tasks[${i}]`;
    if (!t || typeof t !== 'object') {
      out.push(`${at} is not an object`);
      continue;
    }
    if (typeof t.taskId !== 'string' || t.taskId === '') out.push(`${at}.taskId is required`);
    if (typeof t.goal !== 'string' || t.goal.trim() === '') out.push(`${at}.goal is required`);
    if ((t.repo === undefined) === (t.sutUrl === undefined)) out.push(`${at}: give exactly one target: repo {base, candidate?} or sutUrl`);
    if (t.repo !== undefined && (typeof t.repo.base !== 'string' || (t.repo.candidate !== undefined && typeof t.repo.candidate !== 'string'))) out.push(`${at}.repo must be {base: dir, candidate?: dir}`);
    if (t.expectedVerdict === undefined) out.push(`${at}.expectedVerdict is required`);
  }
  return out;
}

/** An EvalTask from a declarative task of a suite file in `dir`. */
export function declarativeTask(t: DeclarativeTask, suite: Pick<DeclarativeSuite, 'revision'>, dir: string): EvalTask {
  const at = (p: string) => (isAbsolute(p) ? p : resolve(dir, p));
  const task: EvalTask = {
    taskId: t.taskId,
    suiteRevision: suite.revision,
    title: t.title ?? t.taskId,
    goal: t.goal,
    hiddenFaults: t.hiddenFaults ?? [],
    expectedVerdict: t.expectedVerdict,
    graders: t.graders ?? DEFAULT_PRIVATE_GRADERS,
    async setup(ctx): Promise<TrialFixture> {
      if (t.repo) {
        const repo = await createGitFixtureRepo(join(ctx.workDir, 'sut'), { base: at(t.repo.base), ...(t.repo.candidate ? { candidate: at(t.repo.candidate) } : {}), name: t.taskId });
        return { target: { repoPath: repo.path, commit: repo.head, baseCommit: repo.base, description: t.title ?? t.taskId }, cleanup: async () => undefined };
      }
      return { target: { sutUrl: t.sutUrl!, description: t.title ?? t.taskId }, cleanup: async () => undefined };
    },
  };
  if (t.oracles) task.oracles = t.oracles;
  if (t.gate) task.gate = t.gate;
  if (t.budget) task.budget = t.budget;
  if (t.allowedTools) task.allowedTools = t.allowedTools;
  if (t.safetyConstraints) task.safetyConstraints = t.safetyConstraints;
  if (t.tiers) task.tiers = t.tiers;
  if (t.repo) task.fixtureFiles = [at(t.repo.base), ...(t.repo.candidate ? [at(t.repo.candidate)] : [])];
  return task;
}

/** A private suite as loaded: the suite and the fingerprint of its directory (part of its suite fingerprint). */
export interface LoadedSuite {
  suite: EvalSuite;
  file: string;
  fingerprint: string;
}

/**
 * Loads every suite of a directory: `*.suite.json` (declarative) and `*.suite.mjs` / `*.suite.ts` (an ES module whose
 * `suite` / `default` export is an EvalSuite or a factory). Suite ids must be unique; malformed files are refused with
 * every problem named.
 */
export async function loadSuiteDirectory(dir: string): Promise<Map<string, LoadedSuite>> {
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new HypertestError('invalid_argument', `suite directory ${root} does not exist`);
  const out = new Map<string, LoadedSuite>();
  const dirDigest = filesDigest(['.'], root);
  for (const name of readdirSync(root).sort()) {
    const file = join(root, name);
    let suite: EvalSuite | undefined;
    if (name.endsWith('.suite.json')) {
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        throw new HypertestError('invalid_argument', `${file} is not JSON: ${(e as Error).message}`);
      }
      const problems = declarativeProblems(doc, file);
      if (problems.length > 0) throw new HypertestError('invalid_argument', problems.join('; '));
      const d = doc as DeclarativeSuite;
      suite = { suiteId: d.suiteId, revision: d.revision, tasks: d.tasks.map((t) => declarativeTask(t, d, root)) };
    } else if (/\.suite\.(mjs|ts)$/.test(name)) {
      const mod = (await import(pathToFileURL(file).href)) as { suite?: unknown; default?: unknown };
      const exported = mod.suite ?? mod.default;
      const value = typeof exported === 'function' ? await (exported as () => unknown)() : exported;
      const v = value as Partial<EvalSuite> | undefined;
      if (!v || typeof v.suiteId !== 'string' || typeof v.revision !== 'string' || !Array.isArray(v.tasks)) throw new HypertestError('invalid_argument', `${file} exports no EvalSuite (suite / default)`);
      suite = v as EvalSuite;
    }
    if (!suite) continue;
    if (out.has(suite.suiteId)) throw new HypertestError('invalid_argument', `suite ${suite.suiteId} is defined twice in ${root}`);
    out.set(suite.suiteId, { suite, file, fingerprint: suiteFingerprint(suite, dirDigest) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ public sanity layer

/** One SWE-bench-style instance (the fields the loader reads). */
export interface SweBenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  /** The gold patch (unified diff). */
  patch: string;
  /** The tests the issue adds/changes (unified diff). */
  test_patch: string;
  FAIL_TO_PASS: string[] | string;
  PASS_TO_PASS?: string[] | string;
}

function list(v: string[] | string | undefined): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.map(String);
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [String(v)];
  } catch {
    return [String(v)];
  }
}

/** Parses a JSON-lines dataset (blank lines skipped); a malformed instance is refused with its line number. */
export function parseSweBench(text: string, source = 'dataset'): SweBenchInstance[] {
  const out: SweBenchInstance[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let x: Partial<SweBenchInstance>;
    try {
      x = JSON.parse(line) as Partial<SweBenchInstance>;
    } catch (e) {
      throw new HypertestError('invalid_argument', `${source}:${i + 1} is not JSON: ${(e as Error).message}`);
    }
    for (const k of ['instance_id', 'repo', 'base_commit', 'problem_statement', 'patch', 'test_patch'] as const) {
      if (typeof x[k] !== 'string' || x[k] === '') throw new HypertestError('invalid_argument', `${source}:${i + 1}: ${k} is required`);
    }
    if (list(x.FAIL_TO_PASS).length === 0) throw new HypertestError('invalid_argument', `${source}:${i + 1}: FAIL_TO_PASS names no test`);
    out.push(x as SweBenchInstance);
  });
  return out;
}

/** The revision of the sanity suite (its tasks are derived from the dataset; the dataset digest is in the fingerprint). */
export const SANITY_SUITE_REVISION = 'sanity-1';

/**
 * The public sanity suite of a dataset over a LOCAL mirror of its repositories (`reposDir/<owner>__<name>`, a git
 * checkout containing `base_commit`; no network). Per instance two tasks: `<id>:fixed` (base + gold patch + test patch ⇒
 * expected pass) and `<id>:unfixed` (base + test patch ⇒ expected fail; hidden fault = the FAIL_TO_PASS tests).
 */
export function sanitySuite(input: { datasetFile: string; reposDir: string; limit?: number }): EvalSuite {
  const text = readFileSync(input.datasetFile, 'utf8');
  const instances = parseSweBench(text, input.datasetFile).slice(0, input.limit ?? Number.MAX_SAFE_INTEGER);
  const tasks: EvalTask[] = [];
  for (const inst of instances) {
    const mirror = join(resolve(input.reposDir), inst.repo.replace('/', '__'));
    const failing = list(inst.FAIL_TO_PASS);
    const variant = (fixed: boolean): EvalTask => ({
      taskId: `${inst.instance_id}:${fixed ? 'fixed' : 'unfixed'}`,
      suiteRevision: SANITY_SUITE_REVISION,
      title: `${inst.instance_id} (${fixed ? 'gold patch' : 'unfixed'})`,
      goal: `Decide whether this change resolves the issue and is releasable. Issue (${inst.repo}):\n${inst.problem_statement}`,
      hiddenFaults: fixed ? [] : [{ faultId: `${inst.instance_id}:unresolved`, description: `the issue is not resolved: ${failing.join(', ')} fail`, severity: 'P1', detectionHints: [failing.map((t) => t.split(/::|\.| /).pop() ?? t).join('|')] }],
      expectedVerdict: fixed ? 'pass' : 'fail',
      graders: ['verdict', 'defectDetected', 'evidenceCompleteness', 'evidenceIntegrity', 'policyViolation'],
      tiers: ['deep'],
      async setup(ctx): Promise<TrialFixture> {
        if (!existsSync(mirror)) throw new HypertestError('precondition_failed', `no local mirror of ${inst.repo} at ${mirror} (the sanity layer never downloads)`);
        const base = join(ctx.workDir, 'sanity-base');
        // the mirror at base_commit as a plain tree (no history leaks into the trial)
        const { execFileSync } = await import('node:child_process');
        execFileSync('git', ['-C', mirror, 'worktree', 'add', '--detach', base, inst.base_commit], { stdio: 'ignore' });
        try {
          const patch = fixed ? `${inst.patch}\n${inst.test_patch}` : inst.test_patch;
          const repo = await createGitFixtureRepo(join(ctx.workDir, 'sut'), { base, patch, name: inst.instance_id });
          return { target: { repoPath: repo.path, commit: repo.head, baseCommit: repo.base, description: `${inst.repo}@${inst.base_commit.slice(0, 12)}` }, cleanup: async () => undefined };
        } finally {
          execFileSync('git', ['-C', mirror, 'worktree', 'remove', '--force', base], { stdio: 'ignore' });
        }
      },
    });
    tasks.push(variant(true), variant(false));
  }
  if (tasks.length === 0) throw new HypertestError('invalid_argument', `${input.datasetFile} holds no instance`);
  return { suiteId: 'sanity', revision: SANITY_SUITE_REVISION, tasks };
}
