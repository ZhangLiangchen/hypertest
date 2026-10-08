/**
 * (F[12]) Suite and environment versioning (architecture-improvements §Eval 回滚与恢复: "Suite v14 / Grader v8 / Oracle v6 /
 * Environment v17"). A suite revision (`EvalSuite.revision`) is a NAME; what it names is fingerprinted here:
 *
 *   suiteFingerprint = sha256( suite id + revision + every task definition (goal, graders, expected verdict, hidden faults,
 *                      chaos, gate, budget, oracles, rubric, tools, safety constraints, environment digest, setup source)
 *                      + the content of the sources the built-in tasks run on: their brains (src/brains), suites
 *                      (src/suites), fixture helpers (src/fixtures.ts) and fixture services (fixtures/) )
 *
 * `packages/eval/suites.lock.json` pins the fingerprint of every built-in suite revision; `suiteLockProblems()` (run by
 * test/suite-versions.test.ts) reports a suite whose content changed under the SAME revision — bump the revision (and
 * re-baseline: results of different suite revisions are never compared). The release gate refuses two results whose
 * fingerprints differ under one revision. The environment of a task (row 319) is versioned per trial as
 * `environmentImageDigest` (an OCI digest the task names, else `files:<sha256>` of the fixture files it declares).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HypertestError, canonicalJson, sha256Hex, type JsonValue } from '@hypertest/core';
import type { EvalSuite, EvalTask } from './contracts.ts';
import { normalizedSource } from './grader-revisions.ts';

/** The package root of @hypertest/eval. */
export const EVAL_PACKAGE_ROOT: string = fileURLToPath(new URL('../', import.meta.url));
/** Sources the built-in tasks run on (relative to the package root): their content is part of every built-in suite's fingerprint. */
export const SUITE_SOURCE_PATHS: readonly string[] = Object.freeze(['src/brains', 'src/suites', 'src/fixtures.ts', 'fixtures']);
/** The committed suite lock. */
export const SUITE_LOCK_PATH: string = join(EVAL_PACKAGE_ROOT, 'suites.lock.json');

function walk(path: string, out: string[]): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    const base = path.split('/').pop() ?? '';
    if (base === 'node_modules' || base.startsWith('.')) return;
    for (const name of readdirSync(path).sort()) walk(join(path, name), out);
  } else if (st.isFile()) out.push(path);
}

/** sha256 of the files under `paths` (relative to `root`): name + content of every file, in sorted order. */
export function filesDigest(paths: readonly string[], root: string = EVAL_PACKAGE_ROOT): string {
  const files: string[] = [];
  for (const p of paths) walk(resolve(root, p), files);
  const h = createHash('sha256');
  for (const f of [...new Set(files)].sort()) {
    h.update(relative(root, f));
    h.update('\u0000');
    h.update(readFileSync(f));
    h.update('\u0000');
  }
  return h.digest('hex');
}

let sourcesDigest: string | undefined;
/** The digest of SUITE_SOURCE_PATHS (computed once per process). */
export function builtinSourcesDigest(): string {
  sourcesDigest ??= filesDigest(SUITE_SOURCE_PATHS);
  return sourcesDigest;
}

/** The fingerprinted definition of one task (functions by their normalized source). */
export function taskDefinition(task: EvalTask): JsonValue {
  const fn = (f: unknown) => (typeof f === 'function' ? normalizedSource(f as (...a: never[]) => unknown) : null);
  const plain = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v ?? null)) as JsonValue;
  return {
    taskId: task.taskId, suiteRevision: task.suiteRevision, title: task.title, goal: task.goal, hiddenFaults: plain(task.hiddenFaults), expectedVerdict: plain(task.expectedVerdict),
    budget: plain(task.budget), chaos: plain(task.chaos), graders: plain(task.graders), gate: plain(task.gate), oracles: plain(task.oracles), rubric: plain(task.rubric),
    baselineTaskId: task.baselineTaskId ?? null, allowedTools: plain(task.allowedTools), safetyConstraints: plain(task.safetyConstraints),
    environmentImageDigest: task.environmentImageDigest ?? null, fixtureFiles: plain(task.fixtureFiles), tiers: plain(task.tiers), setup: fn(task.setup),
  };
}

/**
 * The content fingerprint of a suite: its id, revision, task definitions and the sources its tasks run on (the built-in
 * brains/suites/fixtures, plus `extraSources`, e.g. the directory a private suite was loaded from).
 */
export function suiteFingerprint(suite: Pick<EvalSuite, 'suiteId' | 'revision' | 'tasks'>, extraSources?: string): string {
  const content = {
    suiteId: suite.suiteId, revision: suite.revision, tasks: suite.tasks.map(taskDefinition), sources: builtinSourcesDigest(), extraSources: extraSources ?? null,
  };
  return sha256Hex(canonicalJson(content as unknown as JsonValue));
}

export interface SuiteLock {
  suites: Record<string, { revision: string; fingerprint: string }>;
}

/** The lock of the given suites as they are now. */
export function currentSuiteLock(suites: Readonly<Record<string, () => EvalSuite>>): SuiteLock {
  const out: SuiteLock['suites'] = {};
  for (const [id, factory] of Object.entries(suites).sort(([a], [b]) => a.localeCompare(b))) {
    const suite = factory();
    out[id] = { revision: suite.revision, fingerprint: suiteFingerprint(suite) };
  }
  return { suites: out };
}

export function readSuiteLock(path: string = SUITE_LOCK_PATH): SuiteLock {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { suites?: unknown };
  if (!raw || typeof raw !== 'object' || !raw.suites || typeof raw.suites !== 'object') throw new HypertestError('invalid_argument', `${path} is not a suite lock`);
  return raw as SuiteLock;
}

export function renderSuiteLock(lock: SuiteLock): string {
  const sorted = { suites: Object.fromEntries(Object.entries(lock.suites).sort(([a], [b]) => a.localeCompare(b))) };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Differences between the committed lock and the suites now: a suite whose content changed under the SAME revision (bump
 * EvalSuite.revision — CORE_SUITE_REVISION / POC_SUITE_REVISION — and re-baseline), a revision bump without a lock entry,
 * a suite missing from the lock, a lock entry of a suite that no longer exists.
 */
export function suiteLockProblems(lock: SuiteLock, now: SuiteLock): string[] {
  const out: string[] = [];
  for (const [id, cur] of Object.entries(now.suites)) {
    const pinned = lock.suites[id];
    if (!pinned) out.push(`suite ${id} (revision ${cur.revision}) is not in the lock: record it`);
    else if (pinned.fingerprint !== cur.fingerprint && pinned.revision === cur.revision) {
      out.push(`suite ${id} changed (fingerprint ${cur.fingerprint.slice(0, 12)} ≠ ${pinned.fingerprint.slice(0, 12)}) but its revision is still ${cur.revision}: bump the suite revision, record the new fingerprint and re-baseline`);
    } else if (pinned.revision !== cur.revision && pinned.fingerprint === cur.fingerprint) {
      out.push(`suite ${id}: revision ${pinned.revision} → ${cur.revision} without a change of its content: revert the revision`);
    } else if (pinned.revision !== cur.revision) out.push(`suite ${id}: new revision ${cur.revision} (was ${pinned.revision}) is not recorded in the lock yet`);
  }
  for (const id of Object.keys(lock.suites)) if (!Object.hasOwn(now.suites, id)) out.push(`the lock names suite ${id}, which no longer exists`);
  return out;
}

/** (row 319) The environment version of a trial: the task's image digest, else `files:<sha256>` of its fixture files (relative to the eval package root). */
export function environmentDigestOf(task: Pick<EvalTask, 'environmentImageDigest' | 'fixtureFiles'>, root: string = EVAL_PACKAGE_ROOT): string | undefined {
  if (task.environmentImageDigest !== undefined) {
    if (!/^(sha256:[0-9a-f]{64}|files:[0-9a-f]{64})$/.test(task.environmentImageDigest)) throw new HypertestError('invalid_argument', `environmentImageDigest must be sha256:<64 hex> (got ${JSON.stringify(task.environmentImageDigest)})`);
    return task.environmentImageDigest;
  }
  if (!task.fixtureFiles || task.fixtureFiles.length === 0) return undefined;
  return `files:${filesDigest(task.fixtureFiles, root)}`;
}
