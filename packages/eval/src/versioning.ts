/**
 * Versioned graders and bridge comparisons (architecture-improvements §Eval 回滚与恢复):
 *
 *   grader bug ⇒ do not edit v8 → publish v9 → run v8 and v9 on a bridge dataset → score mapping / declare discontinuity
 *
 * - Every built-in grader has a revision (GRADER_REVISIONS). `packages/eval/graders.lock.json` pins a FINGERPRINT per
 *   grader: sha256 over the normalized source of the grader function and of the shared analyses it declares
 *   (GRADER_DEPENDENCIES). `graderLockProblems()` (run by test/grader-versions.test.ts) reports a grader whose source
 *   changed while its revision did not — a change of behaviour under an old revision would rewrite history.
 * - `bridgeCompare()` compares two revisions of a grader on the SAME trials (HarnessOptions.bridge grades every trial with
 *   the candidate revision too): agreement, flips, exact McNemar, score mapping, discontinuity.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HypertestError, canonicalJson, sha256Hex, type JsonValue } from '@hypertest/core';
import { isEligibleTestArtifact } from '@hypertest/domain';
import { artifactCaseStatuses, sensitivityBinding } from '@hypertest/policy';
import type { BridgeReport, EvalSuite, EvalTrial, SuiteOptions, SuiteResult, VersionedGrader } from './contracts.ts';
import { GRADERS, createPlanDynamicsGrader, normalizedSource } from './graders.ts';
import { GRADER_REVISIONS } from './grader-revisions.ts';
import {
  acceptedPlans, analyzeCompleteness, analyzeDefects, analyzePolicy, analyzeSensitivity, analyzeSideEffects, analyzeStaleness, analyzeVerdict, distinctRoleRoutes, expectedVerdicts,
  hintProblems, matchesHints, maxParallelWork, routesByRole, sideEffectCounts,
} from './analysis.ts';
import { maxConcurrent, runningIntervals } from './poc-graders.ts';
import { baselineEquivalence } from './core-graders.ts';
import { DEFAULT_PACKET_BYTES, JUDGE_ANSWER_SCHEMA, JUDGE_SYSTEM_PROMPT, buildEvidencePacket, groundJudgeAnswer, judgeMessages } from './judge.ts';
import { canonicalDifferences, canonicalProjection } from './trial-records.ts';
import { mcnemarExact } from './stats.ts';

type Fn = (...args: never[]) => unknown;

/**
 * The shared analyses each grader's verdict depends on (beyond its own function): part of its fingerprint, so a change of
 * e.g. analyzeDefects is a change of `defectDetected` and needs a new revision.
 */
export const GRADER_DEPENDENCIES: Readonly<Record<string, readonly Fn[]>> = Object.freeze({
  verdict: [analyzeVerdict, expectedVerdicts],
  defectDetected: [analyzeDefects, matchesHints, hintProblems],
  noDuplicateSideEffects: [analyzeSideEffects, sideEffectCounts],
  evidenceCompleteness: [analyzeCompleteness],
  evidenceIntegrity: [],
  policyViolation: [analyzePolicy],
  auditReconstruction: [],
  planDynamics: [createPlanDynamicsGrader, acceptedPlans, maxParallelWork, routesByRole, distinctRoleRoutes],
  pocAWorkflow: [maxConcurrent, runningIntervals],
  pocBWorkflow: [],
  pocCWorkflow: [maxConcurrent, runningIntervals],
  causalChain: [],
  singleLeaseOwner: [],
  noOrphanOperations: [analyzeSideEffects],
  loadJobReattached: [],
  offloadBounded: [],
  modelFallback: [],
  contextIsolation: [],
  independentReview: [],
  reportTracesToEvidence: [],
  testChangeGoverned: [],
  recoveryAudit: [analyzeSideEffects],
  insufficientDataNotPassed: [],
  freshnessGuarded: [analyzeStaleness, analyzePolicy],
  modelSwitchContinuity: [],
  injectionContained: [analyzePolicy],
  generatedTestsGoverned: [isEligibleTestArtifact, analyzeSensitivity, sensitivityBinding, artifactCaseStatuses],
  llmRubric: [buildEvidencePacket, groundJudgeAnswer, judgeMessages],
  baselineEquivalence: [canonicalProjection, canonicalDifferences],
});

/**
 * Data a grader's verdict depends on beyond code (part of its fingerprint): for the LLM judge, the system prompt, the
 * answer contract and the packet budget — a changed prompt is a changed grader and needs a new revision.
 */
export const GRADER_DATA_DEPENDENCIES: Readonly<Record<string, readonly JsonValue[]>> = Object.freeze({
  llmRubric: [JUDGE_SYSTEM_PROMPT, JUDGE_ANSWER_SCHEMA as unknown as JsonValue, DEFAULT_PACKET_BYTES],
});

/**
 * sha256 over the normalized sources of `fns` and the canonical JSON of `data` (in order). Without data it is the hash of
 * the function sources alone (the fingerprint of a grader without data dependencies).
 */
export function fingerprintOf(fns: readonly Fn[], data: readonly JsonValue[] = []): string {
  return sha256Hex([...fns.map((f) => normalizedSource(f)), ...data.map((d) => canonicalJson(d))].join('\n\u0000\n'));
}

/** Suite-level graders (applied by runSuite, not listed in EvalTask.graders) and their functions. */
const SUITE_LEVEL: Readonly<Record<string, Fn>> = Object.freeze({ baselineEquivalence: baselineEquivalence as Fn });

/** Every versioned built-in grader id (registry + suite-level), sorted. */
export function versionedGraderIds(): string[] {
  return [...new Set([...Object.keys(GRADERS), ...Object.keys(SUITE_LEVEL)])].sort();
}

/** sha256 of the normalized sources of a built-in grader and its declared dependencies (code and data). */
export function graderFingerprint(id: string): string {
  const fn = Object.hasOwn(GRADERS, id) ? (GRADERS[id] as Fn) : Object.hasOwn(SUITE_LEVEL, id) ? SUITE_LEVEL[id]! : undefined;
  if (!fn) throw new HypertestError('invalid_argument', `unknown grader ${id}`);
  return fingerprintOf([fn, ...(GRADER_DEPENDENCIES[id] ?? [])], GRADER_DATA_DEPENDENCIES[id] ?? []);
}

export interface GraderLock {
  graders: Record<string, { revision: string; fingerprint: string }>;
}

/** The lock of the graders as they are now (revision + fingerprint per grader). */
export function currentGraderLock(): GraderLock {
  const graders: GraderLock['graders'] = {};
  for (const id of versionedGraderIds()) {
    const revision = GRADER_REVISIONS[id];
    if (revision === undefined) throw new HypertestError('internal', `grader ${id} has no revision in GRADER_REVISIONS`);
    graders[id] = { revision, fingerprint: graderFingerprint(id) };
  }
  return { graders };
}

/** The committed lock file. */
export const GRADER_LOCK_PATH: string = fileURLToPath(new URL('../graders.lock.json', import.meta.url));

export function readGraderLock(path: string = GRADER_LOCK_PATH): GraderLock {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { graders?: unknown };
  if (!raw || typeof raw !== 'object' || !raw.graders || typeof raw.graders !== 'object') throw new HypertestError('invalid_argument', `${path} is not a grader lock`);
  return raw as GraderLock;
}

/**
 * Differences between a committed lock and the graders now: a grader whose fingerprint changed under the SAME revision
 * (bump its revision in GRADER_REVISIONS and run a bridge comparison), a revision that changed without a new lock entry,
 * a grader missing from the lock or a lock entry of a grader that no longer exists.
 */
export function graderLockProblems(lock: GraderLock, now: GraderLock = currentGraderLock()): string[] {
  const out: string[] = [];
  for (const [id, cur] of Object.entries(now.graders)) {
    const pinned = lock.graders[id];
    if (!pinned) {
      out.push(`grader ${id} (revision ${cur.revision}) is not in the lock: record it`);
      continue;
    }
    if (pinned.fingerprint !== cur.fingerprint && pinned.revision === cur.revision) {
      out.push(`grader ${id} changed (fingerprint ${cur.fingerprint.slice(0, 12)} ≠ ${pinned.fingerprint.slice(0, 12)}) but its revision is still ${cur.revision}: bump GRADER_REVISIONS.${id}, record the new fingerprint and bridge-compare the revisions`);
    } else if (pinned.revision !== cur.revision && pinned.fingerprint === cur.fingerprint) {
      out.push(`grader ${id}: revision ${pinned.revision} → ${cur.revision} without a change of its source: revert the revision`);
    } else if (pinned.revision !== cur.revision) {
      out.push(`grader ${id}: new revision ${cur.revision} (was ${pinned.revision}) is not recorded in the lock yet`);
    }
  }
  for (const id of Object.keys(lock.graders)) if (!Object.hasOwn(now.graders, id)) out.push(`the lock names grader ${id}, which no longer exists`);
  return out;
}

/** Canonical JSON text of a lock (the committed file's content). */
export function renderGraderLock(lock: GraderLock): string {
  const sorted: GraderLock = { graders: Object.fromEntries(Object.entries(lock.graders).sort(([a], [b]) => a.localeCompare(b))) };
  return `${JSON.stringify(JSON.parse(canonicalJson(sorted as unknown as JsonValue)), null, 2)}\n`;
}

// ------------------------------------------------------------------------------------------------ bridge

function ref(t: EvalTrial): string {
  return `${t.taskId}/${t.armId}#${t.trial}`;
}

/**
 * Compares the recorded results of grader `graderId` (the old revision, EvalTrial.graders) with the candidate revision's
 * results on the SAME trials (EvalTrial.bridge): agreement, the trials that flip, exact McNemar over the flips, the mean
 * score change and the score mapping old → new. `discontinuity` is true when any outcome flipped: history graded by the
 * old revision is not comparable to the new one without the mapping.
 */
export function bridgeCompare(graderId: string, trials: readonly EvalTrial[]): BridgeReport {
  const pairs: Array<{ t: EvalTrial; from: { pass: boolean; score: number; revision: string }; to: { pass: boolean; score: number; revision: string } }> = [];
  for (const t of trials) {
    const a = t.graders.find((g) => g.graderId === graderId);
    const b = t.bridge?.find((g) => g.graderId === graderId);
    if (!a || !b) continue;
    pairs.push({ t, from: { pass: a.pass, score: a.score, revision: a.revision ?? '?' }, to: { pass: b.pass, score: b.score, revision: b.revision ?? '?' } });
  }
  if (pairs.length === 0) throw new HypertestError('precondition_failed', `bridgeCompare: no trial was graded by both revisions of ${graderId} (run the suite with HarnessOptions.bridge)`);
  const fromRevisions = [...new Set(pairs.map((p) => p.from.revision))];
  const toRevisions = [...new Set(pairs.map((p) => p.to.revision))];
  if (fromRevisions.length > 1 || toRevisions.length > 1) throw new HypertestError('invalid_argument', `bridgeCompare: the trials mix revisions of ${graderId} (${fromRevisions.join(', ')} → ${toRevisions.join(', ')})`);
  const newlyFailing = pairs.filter((p) => p.from.pass && !p.to.pass).map((p) => ref(p.t));
  const newlyPassing = pairs.filter((p) => !p.from.pass && p.to.pass).map((p) => ref(p.t));
  const agree = pairs.length - newlyFailing.length - newlyPassing.length;
  const mapping = new Map<number, { sum: number; n: number }>();
  for (const p of pairs) {
    const k = Math.round(p.from.score * 1000) / 1000;
    const m = mapping.get(k) ?? { sum: 0, n: 0 };
    m.sum += p.to.score;
    m.n++;
    mapping.set(k, m);
  }
  const discontinuity = newlyFailing.length + newlyPassing.length > 0;
  const report: BridgeReport = {
    graderId,
    fromRevision: fromRevisions[0]!,
    toRevision: toRevisions[0]!,
    pairs: pairs.length,
    agreement: agree / pairs.length,
    newlyFailing,
    newlyPassing,
    mcnemarP: mcnemarExact(newlyFailing.length, newlyPassing.length),
    meanScoreDelta: pairs.reduce((s, p) => s + (p.to.score - p.from.score), 0) / pairs.length,
    scoreMapping: [...mapping].sort(([a], [b]) => a - b).map(([from, m]) => ({ from, to: m.sum / m.n, n: m.n })),
    discontinuity,
    statement: discontinuity
      ? `${graderId} ${fromRevisions[0]} → ${toRevisions[0]}: DISCONTINUITY — ${newlyFailing.length} trial(s) newly fail, ${newlyPassing.length} newly pass over ${pairs.length} bridge trial(s); results of the two revisions are not comparable without the score mapping`
      : `${graderId} ${fromRevisions[0]} → ${toRevisions[0]}: continuous over ${pairs.length} bridge trial(s) (no outcome flipped)`,
  };
  return report;
}

/**
 * Runs `suite` as a bridge dataset: every trial is graded by its graders AND by the candidate revisions (`candidates`,
 * grader id → VersionedGrader), then each candidate is compared with the revision it replaces (bridgeCompare).
 */
export async function runBridge(
  suite: EvalSuite,
  options: SuiteOptions,
  candidates: Readonly<Record<string, VersionedGrader>>,
  run: (suite: EvalSuite, options: SuiteOptions) => Promise<SuiteResult>,
): Promise<{ result: SuiteResult; reports: BridgeReport[] }> {
  const ids = Object.keys(candidates);
  if (ids.length === 0) throw new HypertestError('invalid_argument', 'runBridge: name at least one candidate grader revision');
  for (const id of ids) {
    if (!suite.tasks.some((t) => t.graders.some((g) => g.split('?')[0] === id))) throw new HypertestError('invalid_argument', `runBridge: no task of ${suite.suiteId} is graded by ${id}`);
  }
  const result = await run(suite, { ...options, bridge: { ...(options.bridge ?? {}), ...candidates } });
  return { result, reports: ids.map((id) => bridgeCompare(id, result.trials)) };
}
