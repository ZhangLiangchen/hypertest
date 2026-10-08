import type { JsonValue } from '@hypertest/core';
import type { BlackboardRecord, EvidenceRecord, OracleSpec, Review, TestArtifact } from '@hypertest/domain';
import { DEFAULT_TEST_PATH_PATTERNS } from './classifier.ts';
import { matchesGlob } from './patterns.ts';

/**
 * (D-0 / D-1, BLOCKER of the audit) Sensitivity evidence BOUND to the TestArtifact it validates, and the full artifact
 * lifecycle of architecture-improvements §TestArtifact, re-derived from evidence and review records. Pure and shared by
 * `test_artifact.validate` (control: what it accepts) and the QualityGate (what it counts) — the gate never trusts a stored
 * score or approval state alone.
 *
 * Execution binding (written by the tools, never claimed by a caller): `test.run` and `mutation.run` record on their
 * evidence `executedTests` `{ attribution: 'complete'|'partial'|'none', files: [{ path, sha256, cases, staticCheck? }],
 * unattributedCases }` — the test files the run executed (cases attributed to their file), the content digest of each and,
 * for files that differ from the base commit, the framework's syntax/static check — and `codeRevision`
 * `{ kind: 'workspace'|'base', baseCommit?, treeDigest }` — the code the run executed. A record counts for an artifact only
 * when it executed the artifact's file with exactly the artifact's content digest on a recorded code revision; a mutation
 * result counts only when the mutation run executed NOTHING but that file (another test killing the mutants proves nothing
 * about this one).
 */

export interface StaticCheckResult {
  checker: string;
  ok: boolean;
  detail?: string;
}

export interface ExecutedTestFile {
  path: string;
  sha256?: string;
  cases?: number;
  staticCheck?: StaticCheckResult;
}

export interface ExecutedTests {
  attribution: 'complete' | 'partial' | 'none';
  files: ExecutedTestFile[];
  unattributedCases: number;
}

export interface CodeRevision {
  kind: 'workspace' | 'base';
  baseCommit?: string;
  treeDigest?: string;
}

function obj(v: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, JsonValue>) : undefined;
}

export function normalizeTestPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

/** The default discovery patterns of the supported test runners (node:test `*-test.*`, `test-*.*`, `test.*`; spec dirs …). */
export const TEST_RUNNER_DISCOVERY_PATTERNS: readonly string[] = Object.freeze(['**/*-test.*', '**/*_test.*', '**/test-*.*', '**/test.*', '**/*_spec.*', '**/spec/**', '**/__tests__/**']);

/**
 * Paths whose change can alter which test cases run or what they assert: the policy's test path patterns plus the runners'
 * discovery patterns. One source of truth for the tools (workspace deltas, base-revision runs, mutation targets) and the
 * sensitivity binding.
 */
export const TEST_FILE_PATH_PATTERNS: readonly string[] = Object.freeze([...DEFAULT_TEST_PATH_PATTERNS, ...TEST_RUNNER_DISCOVERY_PATTERNS]);

/** True when `path` is test code (TEST_FILE_PATH_PATTERNS). */
export function isTestPath(path: string): boolean {
  const p = normalizeTestPath(path);
  return TEST_FILE_PATH_PATTERNS.some((g) => matchesGlob(g, p));
}

/**
 * The file a mutation run mutated, as `mutation.run` recorded it (`mutatedFile: { path, isTestFile, changedSinceBase }`,
 * derived by the tool from the workspace — never claimed by the caller); undefined when absent or malformed.
 */
export function mutatedFileOf(e: Pick<EvidenceRecord, 'structured'>): { path: string; isTestFile?: boolean; changedSinceBase?: boolean } | undefined {
  const m = obj(obj(e.structured)?.['mutatedFile']);
  if (!m || typeof m['path'] !== 'string' || m['path'] === '') return undefined;
  const out: { path: string; isTestFile?: boolean; changedSinceBase?: boolean } = { path: m['path'] };
  if (typeof m['isTestFile'] === 'boolean') out.isTestFile = m['isTestFile'];
  if (typeof m['changedSinceBase'] === 'boolean') out.changedSinceBase = m['changedSinceBase'];
  return out;
}

/** Same file, allowing one side to be absolute or rooted elsewhere (`/ws/test/a.test.js` ≡ `test/a.test.js`). */
export function sameTestFile(file: string, path: string): boolean {
  const f = normalizeTestPath(file);
  const p = normalizeTestPath(path);
  return f === p || f.endsWith(`/${p}`) || p.endsWith(`/${f}`);
}

/** The python module path of a test file (`tests/test_x.py` → `tests.test_x`), as pytest's junit classname uses it. */
function pythonModule(path: string): string | undefined {
  const p = normalizeTestPath(path);
  return p.endsWith('.py') ? p.slice(0, -3).replaceAll('/', '.') : undefined;
}

/** True when one test case of a test-result belongs to `path` (exact file, never a name substring). */
export function caseInFile(c: JsonValue, path: string): boolean {
  const rec = obj(c);
  if (!rec) return false;
  if (typeof rec['file'] === 'string') return sameTestFile(rec['file'], path);
  const id = typeof rec['id'] === 'string' ? rec['id'] : '';
  const sepAt = id.indexOf('::');
  if (sepAt > 0) {
    const head = id.slice(0, sepAt);
    const mod = pythonModule(path);
    return sameTestFile(head, path) || (mod !== undefined && (head === mod || head.endsWith(`.${mod}`) || mod.endsWith(`.${head}`)));
  }
  return false;
}

/** The `executedTests` a tool recorded on a record (undefined when absent or malformed). */
export function executedTestsOf(e: Pick<EvidenceRecord, 'structured'>): ExecutedTests | undefined {
  const x = obj(obj(e.structured)?.['executedTests']);
  if (!x || !Array.isArray(x['files'])) return undefined;
  const attribution = x['attribution'];
  if (attribution !== 'complete' && attribution !== 'partial' && attribution !== 'none') return undefined;
  const files: ExecutedTestFile[] = [];
  for (const f of x['files']) {
    const r = obj(f);
    if (!r || typeof r['path'] !== 'string') return undefined;
    const file: ExecutedTestFile = { path: r['path'] };
    if (typeof r['sha256'] === 'string') file.sha256 = r['sha256'];
    if (typeof r['cases'] === 'number') file.cases = r['cases'];
    const sc = obj(r['staticCheck']);
    if (sc && typeof sc['checker'] === 'string' && typeof sc['ok'] === 'boolean') {
      file.staticCheck = { checker: sc['checker'], ok: sc['ok'], ...(typeof sc['detail'] === 'string' ? { detail: sc['detail'] } : {}) };
    }
    files.push(file);
  }
  return { attribution, files, unattributedCases: typeof x['unattributedCases'] === 'number' ? x['unattributedCases'] : 0 };
}

/** The `codeRevision` a tool recorded on a record. */
export function codeRevisionOf(e: Pick<EvidenceRecord, 'structured'>): CodeRevision | undefined {
  const c = obj(obj(e.structured)?.['codeRevision']);
  if (!c || (c['kind'] !== 'workspace' && c['kind'] !== 'base')) return undefined;
  const out: CodeRevision = { kind: c['kind'] };
  if (typeof c['baseCommit'] === 'string') out.baseCommit = c['baseCommit'];
  if (typeof c['treeDigest'] === 'string') out.treeDigest = c['treeDigest'];
  return out;
}

/** True for a record of a run on the BASE revision (a known-good validation run): never evidence about the candidate. */
export function isBaseRevisionRun(e: Pick<EvidenceRecord, 'structured'>): boolean {
  return codeRevisionOf(e)?.kind === 'base';
}

export type BindingPurpose = 'known_good' | 'known_bad' | 'mutation';

export type Binding =
  | { ok: true; codeDigest: string; revision: 'workspace' | 'base'; file: ExecutedTestFile }
  | { ok: false; problem: string };

/**
 * Whether evidence `e` provably executed artifact `a` (see the module comment). The problem text is exact and names what
 * to do; `test_artifact.validate` refuses with it, the gate lists it.
 */
export function sensitivityBinding(e: EvidenceRecord, a: Pick<TestArtifact, 'artifactId' | 'path' | 'artifactDigest'>, purpose: BindingPurpose): Binding {
  const want = purpose === 'mutation' ? 'mutation-result' : 'test-result';
  const label = purpose === 'known_good' ? 'known-good' : purpose === 'known_bad' ? 'known-bad' : 'mutation';
  if (e.evidenceType !== want) return { ok: false, problem: `${label} evidence ${e.evidenceId} must be a ${want} (got ${e.evidenceType})` };
  const executed = executedTestsOf(e);
  if (!executed) {
    return { ok: false, problem: `${label} evidence ${e.evidenceId} records no executed test files (no execution binding): it cannot be tied to artifact ${a.artifactId} — run ${purpose === 'mutation' ? 'mutation.run' : 'test.run'} again on ${a.path}` };
  }
  const rev = codeRevisionOf(e);
  if (!rev || typeof rev.treeDigest !== 'string' || rev.treeDigest === '') {
    return { ok: false, problem: `${label} evidence ${e.evidenceId} records no code revision (tree digest): the code it ran on is unknown` };
  }
  const mine = executed.files.find((f) => sameTestFile(f.path, a.path));
  if (!mine) {
    const ran = executed.files.map((f) => f.path).slice(0, 10).join(', ') || 'no attributable file';
    return { ok: false, problem: `${label} evidence ${e.evidenceId} did not execute ${a.path} (artifact ${a.artifactId}); it executed ${ran} — foreign evidence never proves this artifact` };
  }
  if (mine.sha256 !== a.artifactDigest) {
    return {
      ok: false,
      problem: `${label} evidence ${e.evidenceId} executed ${a.path} with content ${String(mine.sha256 ?? 'unknown').slice(0, 12)}…, not the registered artifact content ${a.artifactDigest.slice(0, 12)}… (the file changed after registration: re-register it and validate the new content)`,
    };
  }
  if ((mine.cases ?? 0) < 1) return { ok: false, problem: `${label} evidence ${e.evidenceId} attributes no test case to ${a.path}` };
  if (purpose === 'mutation') {
    // the mutants must be in the candidate's PRODUCT code: mutating the artifact itself, another test file or a file written
    // in the workspace (a helper the test imports) proves nothing about whether the test notices a product defect
    const mutated = mutatedFileOf(e);
    if (!mutated) return { ok: false, problem: `mutation evidence ${e.evidenceId} records no mutated-file facts (which file was mutated, whether it is test code or was written in the workspace): run mutation.run again` };
    if (sameTestFile(mutated.path, a.path) || executed.files.some((f) => sameTestFile(f.path, mutated.path)) || mutated.isTestFile !== false || isTestPath(mutated.path)) {
      return { ok: false, problem: `mutation evidence ${e.evidenceId} mutated ${mutated.path}, which is test code (the artifact itself or another test file): killing mutants of a test proves nothing about the product — run mutation.run on the product source the artifact tests` };
    }
    if (mutated.changedSinceBase !== false) {
      return { ok: false, problem: `mutation evidence ${e.evidenceId} mutated ${mutated.path}, which ${mutated.changedSinceBase === true ? 'was added or modified in the workspace' : 'is not known to be unchanged since the base commit'}: only mutants of the candidate's own product code show sensitivity` };
    }
    const others = executed.files.filter((f) => !sameTestFile(f.path, a.path));
    if (others.length > 0 || executed.attribution !== 'complete' || executed.unattributedCases > 0) {
      return {
        ok: false,
        problem: `mutation evidence ${e.evidenceId} executed more than ${a.path}${others.length ? ` (also ${others.map((f) => f.path).slice(0, 10).join(', ')})` : ''}${executed.unattributedCases > 0 ? ` (${executed.unattributedCases} case(s) not attributable to a file)` : ''}: another test could have killed the mutants — run mutation.run with testSelector naming only ${a.path}`,
      };
    }
  }
  return { ok: true, codeDigest: rev.treeDigest, revision: rev.kind, file: mine };
}

/** The statuses of the artifact's own cases in a test-result (by exact file). */
export function artifactCaseStatuses(e: Pick<EvidenceRecord, 'structured'>, path: string): string[] {
  const cases = obj(e.structured)?.['cases'];
  if (!Array.isArray(cases)) return [];
  return cases.filter((c) => caseInFile(c, path)).map((c) => String(obj(c)?.['status']));
}

export type StageStatus = 'passed' | 'failed' | 'missing' | 'waived';

export interface ArtifactEligibility {
  artifactId: string;
  revision: number;
  /** May count as gate evidence (every lifecycle stage completed, re-derived). */
  eligible: boolean;
  /**
   * May support or violate a P0/P1 assertion: eligible AND its known-good run passed on the run's BASE revision (not merely
   * "unavailable", and not on the candidate workspace: a test that passes on the code under test proves nothing about what
   * correct behaviour is — it may encode the defect itself as the expectation).
   */
  criticalSupport: boolean;
  /** (additive) Where the known-good run that passed ran: the run's base revision, or the (candidate) workspace. */
  knownGoodRevision?: 'base' | 'workspace';
  stages: { static: StageStatus; knownGood: StageStatus; sensitivity: StageStatus; oracleReview: StageStatus };
  reasons: string[];
}

export interface EligibilityContext {
  /** Evidence of the run by id (the gate's evidence). */
  evidence: ReadonlyMap<string, EvidenceRecord>;
  /** Review records of the run (every revision is fine; matched by record id). */
  reviews: ReadonlyArray<BlackboardRecord<Review>>;
  /** The oracle revisions in force for the run (approved, pinned, current). */
  oraclesInForce: ReadonlyArray<OracleSpec>;
  /** The run's known-good base commit (target.baseCommit): a known-good run on the base revision must have run on it. */
  baseCommit?: string;
}

/** Oracle consistency: every oracleRef names an assertion of an oracle revision in force. Returns the problems. */
export function oracleRefProblems(a: Pick<TestArtifact, 'oracleRefs'>, oraclesInForce: ReadonlyArray<OracleSpec>): string[] {
  if (!Array.isArray(a.oracleRefs) || a.oracleRefs.length === 0) return ['the artifact names no oracle assertion (oracleRefs is empty): a test bound to no correctness criterion cannot pass the oracle consistency review'];
  const out: string[] = [];
  for (const ref of a.oracleRefs) {
    const o = oraclesInForce.find((x) => x.oracleId === ref.oracleId);
    if (!o) {
      out.push(`oracle ${ref.oracleId} is not in force for this run`);
      continue;
    }
    if (o.revision !== ref.revision) {
      out.push(`oracle ${ref.oracleId} revision ${ref.revision} is not the revision in force (${o.revision})`);
      continue;
    }
    if (!Array.isArray(ref.assertionIds) || ref.assertionIds.length === 0) {
      out.push(`oracleRef ${ref.oracleId}@${ref.revision} names no assertion`);
      continue;
    }
    for (const id of ref.assertionIds) if (!o.assertions.some((x) => x.assertionId === id)) out.push(`assertion ${id} does not exist in oracle ${ref.oracleId}@${ref.revision}`);
  }
  return out;
}

/** Whether a review record is an independent oracle consistency approval of `a`'s current content (problems listed). */
export function reviewProblems(a: TestArtifact, review: BlackboardRecord<Review> | undefined): string[] {
  const r = a.oracleReview;
  if (!r) return ['no oracle consistency review is recorded'];
  if (r.verdict !== 'approve') return [`the oracle consistency review ${r.reviewRecordId} rejected it`];
  if (r.artifactDigest !== a.artifactDigest) return [`the oracle consistency review ${r.reviewRecordId} judged other content (${r.artifactDigest.slice(0, 12)}…)`];
  if (!review) return [`review record ${r.reviewRecordId} is not on record`];
  const out: string[] = [];
  const subject = review.payload.subjectRef;
  if ((subject.kind as string) !== 'test_artifact' || subject.id !== a.artifactId) out.push(`review ${review.recordId} is not a review of test artifact ${a.artifactId}`);
  if (review.payload.verdict !== 'approve') out.push(`review ${review.recordId} does not approve (${review.payload.verdict})`);
  const creator = a.generatedBy?.agentId;
  if (creator !== undefined && review.createdBy === creator) out.push(`review ${review.recordId} was posted by the artifact's creator ${creator} (not independent)`);
  const creatorRole = a.generatedBy?.role ?? 'test_designer';
  if (review.payload.reviewerRole === creatorRole) out.push(`review ${review.recordId} was posted by the creator's role ${creatorRole} (not independent)`);
  return out;
}

function stagePassed(v: { status?: string } | undefined): boolean {
  return v?.status === 'passed';
}

/**
 * Re-derives the lifecycle of `a` from evidence and review records (see the module comment). `existing` artifacts (an
 * unchanged test of the repository) are eligible as they are; callers judging a CHANGED file pass it as `generated`.
 */
export function artifactEligibility(a: TestArtifact, ctx: EligibilityContext): ArtifactEligibility {
  const out: ArtifactEligibility = {
    artifactId: a.artifactId,
    revision: a.revision,
    eligible: false,
    criticalSupport: false,
    stages: { static: 'missing', knownGood: 'missing', sensitivity: 'missing', oracleReview: 'missing' },
    reasons: [],
  };
  if (a.approvalState === 'quarantined' || a.approvalState === 'retired') {
    out.reasons.push(`artifact is ${a.approvalState}`);
    return out;
  }
  if (a.sourceType === 'existing') {
    out.eligible = true;
    out.criticalSupport = true;
    out.stages = { static: 'passed', knownGood: 'passed', sensitivity: 'passed', oracleReview: 'passed' };
    return out;
  }
  const v = a.validations ?? {};
  const bound = (purpose: BindingPurpose, ref: string | undefined): { ok: true; e: EvidenceRecord; codeDigest: string; file: ExecutedTestFile } | { ok: false; problem: string } => {
    if (ref === undefined) return { ok: false, problem: 'no evidence cited' };
    const e = ctx.evidence.get(ref);
    if (!e) return { ok: false, problem: `evidence ${ref} is not in the run's evidence` };
    const b = sensitivityBinding(e, a, purpose);
    return b.ok ? { ok: true, e, codeDigest: b.codeDigest, file: b.file } : { ok: false, problem: b.problem };
  };

  // static validation: a bound record's static check of exactly this content
  if (stagePassed(v.static)) {
    const refs = v.static!.evidenceRefs ?? [];
    const ok = refs.some((ref) => {
      const e = ctx.evidence.get(ref);
      if (!e) return false;
      const ex = executedTestsOf(e)?.files.find((f) => sameTestFile(f.path, a.path));
      return ex !== undefined && ex.sha256 === a.artifactDigest && ex.staticCheck?.ok === true;
    });
    out.stages.static = ok ? 'passed' : 'failed';
    if (!ok) out.reasons.push(`static validation not re-derivable: no cited evidence carries a passing static check of ${a.path} with this content`);
  } else out.reasons.push(`static validation ${v.static?.status ?? 'missing'}${v.static?.detail ? ` (${v.static.detail})` : ''}`);

  // known-good: a bound passing run, or an explicit reason why no known-good revision can exist
  let goodCode: string | undefined;
  if (stagePassed(v.knownGood)) {
    const b = bound('known_good', v.knownGood!.evidenceRefs[0]);
    const rev = b.ok ? codeRevisionOf(b.e) : undefined;
    if (!b.ok) {
      out.stages.knownGood = 'failed';
      out.reasons.push(`known-good: ${b.problem}`);
    } else if (rev?.kind === 'base' && rev.baseCommit !== ctx.baseCommit) {
      out.stages.knownGood = 'failed';
      out.reasons.push(`known-good: ${b.e.evidenceId} ran on base revision ${String(rev.baseCommit)}, not the run's base commit ${ctx.baseCommit ?? '(none)'}`);
    } else {
      const statuses = artifactCaseStatuses(b.e, a.path);
      if (statuses.length > 0 && statuses.every((s) => s === 'passed')) {
        out.stages.knownGood = 'passed';
        goodCode = b.codeDigest;
        out.knownGoodRevision = rev?.kind === 'base' ? 'base' : 'workspace';
        if (out.knownGoodRevision !== 'base') {
          out.reasons.push(`known-good: ${b.e.evidenceId} passed on the workspace (candidate) code, not on the run's base revision: the artifact never supports or violates a P0/P1 assertion (run test.run revision "base" for that)`);
        }
      } else {
        out.stages.knownGood = 'failed';
        out.reasons.push(`known-good: the artifact's cases in ${b.e.evidenceId} did not all pass (${statuses.join(', ') || 'none'})`);
      }
    }
  } else if (v.knownGood === undefined && v.knownGoodUnavailable !== undefined && typeof v.knownGoodUnavailable.reason === 'string' && v.knownGoodUnavailable.reason.trim() !== '') {
    out.stages.knownGood = 'waived';
    out.reasons.push(`known-good unavailable (${v.knownGoodUnavailable.reason}): never supports a P0/P1 assertion`);
  } else out.reasons.push(`known-good ${v.knownGood?.status ?? 'missing'}${v.knownGood?.detail ? ` (${v.knownGood.detail})` : ''}`);

  // sensitivity: a bound known-bad failure on other code, or a bound mutation run with a killed mutant
  const sensitivity: string[] = [];
  if (stagePassed(v.knownBad)) {
    const b = bound('known_bad', v.knownBad!.evidenceRefs[0]);
    if (!b.ok) sensitivity.push(`known-bad: ${b.problem}`);
    else {
      const statuses = artifactCaseStatuses(b.e, a.path);
      const failed = statuses.filter((s) => s === 'failed').length;
      if (failed < 1 || statuses.some((s) => s === 'error')) sensitivity.push(`known-bad: ${b.e.evidenceId} shows no clean assertion failure of the artifact (${statuses.join(', ') || 'none'})`);
      else if (goodCode !== undefined && goodCode === b.codeDigest) sensitivity.push(`known-bad: ran on the same code as the known-good run (tree ${goodCode.slice(0, 12)}…)`);
      else out.stages.sensitivity = 'passed';
    }
  }
  if (out.stages.sensitivity !== 'passed' && stagePassed(v.mutation)) {
    const b = bound('mutation', v.mutation!.evidenceRefs[0]);
    if (!b.ok) sensitivity.push(`mutation: ${b.problem}`);
    else {
      const s = obj(b.e.structured) ?? {};
      const killed = s['killed'];
      const baseline = obj(s['baseline']);
      if (typeof killed !== 'number' || killed < 1) sensitivity.push(`mutation: ${b.e.evidenceId} killed no mutant`);
      else if (baseline?.['passed'] !== true) sensitivity.push(`mutation: ${b.e.evidenceId} has no passing baseline`);
      else out.stages.sensitivity = 'passed';
    }
  }
  if (out.stages.sensitivity !== 'passed') {
    out.stages.sensitivity = sensitivity.length > 0 ? 'failed' : 'missing';
    out.reasons.push(...(sensitivity.length > 0 ? sensitivity : ['sensitivity not demonstrated (no bound known-bad failure and no bound mutation run with a killed mutant)']));
  }

  // oracle consistency review: an independent approving review of this content against the oracle revisions in force
  if (a.approvalState !== 'approved') out.reasons.push(`approval state ${a.approvalState} (the oracle consistency review has not approved it)`);
  const review = a.oracleReview ? ctx.reviews.find((r) => r.recordId === a.oracleReview!.reviewRecordId) : undefined;
  const problems = [...(a.approvalState === 'approved' ? reviewProblems(a, review) : []), ...oracleRefProblems(a, ctx.oraclesInForce)];
  out.stages.oracleReview = a.approvalState === 'approved' && problems.length === 0 ? 'passed' : a.oracleReview ? 'failed' : 'missing';
  out.reasons.push(...problems.map((p) => `oracle review: ${p}`));

  const s = out.stages;
  out.eligible = s.static === 'passed' && (s.knownGood === 'passed' || s.knownGood === 'waived') && s.sensitivity === 'passed' && s.oracleReview === 'passed';
  out.criticalSupport = out.eligible && s.knownGood === 'passed' && out.knownGoodRevision === 'base' && ctx.baseCommit !== undefined;
  return out;
}
