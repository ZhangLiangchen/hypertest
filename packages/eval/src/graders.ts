/**
 * Outcome graders (environment state and deterministic records first; no LLM rubric here). Each grader returns a
 * GraderResult for whatever the system did; it throws `precondition_failed` only when the trial cannot be graded
 * (e.g. a probe it needs is missing), which the harness records as infra_error — never a silent pass.
 *
 * Grader ids (EvalTask.graders): verdict, defectDetected, noDuplicateSideEffects, evidenceCompleteness,
 * evidenceIntegrity, policyViolation, auditReconstruction, planDynamics, and the PoC acceptance graders of
 * src/poc-graders.ts (pocAWorkflow, pocBWorkflow, pocCWorkflow, causalChain, singleLeaseOwner, noOrphanOperations,
 * loadJobReattached, offloadBounded, modelFallback, contextIsolation, independentReview, reportTracesToEvidence,
 * testChangeGoverned, recoveryAudit, insufficientDataNotPassed). The export names (`verdictGrader`, …) are
 * accepted as aliases. Parameters use a query string: `planDynamics?minPlanRevisions=3&minParallel=2&minDistinctRoutes=3`.
 */
import { HypertestError, sha256Hex } from '@hypertest/core';
import type { DomainEvent } from '@hypertest/domain';
import { verifyRuntimeManifest } from '@hypertest/runtime';
import type { Grader, GraderContext, GraderResult, PlanDynamicsOptions, VersionedGrader } from './contracts.ts';
import { POC_GRADERS } from './poc-graders.ts';
import { CORE_SUITE_GRADERS } from './core-graders.ts';
import { EXTENDED_GRADERS } from './extended-graders.ts';
import { llmRubricGrader } from './judge.ts';
import { GRADER_REVISIONS, LLM_GRADER_IDS, normalizedSource } from './grader-revisions.ts';
import {
  SIDE_EFFECT_PROBE, acceptedPlans, analyzeCompleteness, analyzeDefects, analyzePolicy, analyzeSideEffects, analyzeVerdict, distinctRoleRoutes, hintProblems, maxParallelWork,
  routesByRole,
} from './analysis.ts';

const MAX_DETAIL_ITEMS = 8;

function list(items: readonly string[]): string {
  const shown = items.slice(0, MAX_DETAIL_ITEMS).join('; ');
  return items.length > MAX_DETAIL_ITEMS ? `${shown}; … (${items.length - MAX_DETAIL_ITEMS} more)` : shown;
}

function result(graderId: string, pass: boolean, score: number, detail: string): GraderResult {
  return { graderId, pass, score: Math.max(0, Math.min(1, score)), detail };
}

/** Checks → result: pass iff every check passed; score = passed / total. */
function fromChecks(graderId: string, checks: Array<{ name: string; ok: boolean; detail?: string }>): GraderResult {
  const failed = checks.filter((c) => !c.ok);
  const score = checks.length === 0 ? 1 : (checks.length - failed.length) / checks.length;
  const detail = failed.length === 0 ? `all ${checks.length} checks passed` : `${failed.length}/${checks.length} checks failed: ${list(failed.map((c) => (c.detail ? `${c.name}: ${c.detail}` : c.name)))}`;
  return result(graderId, failed.length === 0, score, detail);
}

function noRun(graderId: string, ctx: GraderContext): GraderResult | undefined {
  return ctx.data.run ? undefined : result(graderId, false, 0, 'no run was recorded for this trial');
}

// ------------------------------------------------------------------------------------------------ verdict

/** The QualityGate's verdict is one of the task's expected verdicts. */
export const verdictGrader: Grader = (ctx) => {
  const v = analyzeVerdict(ctx.task, ctx.data);
  const expected = v.expected.join('|');
  if (v.verdict === undefined) return result('verdict', false, 0, `no verdict (run status ${ctx.data.status ?? 'none'}); expected ${expected}`);
  const extra = v.criticalFalseRelease ? ' — CRITICAL FALSE RELEASE' : '';
  return result('verdict', v.match, v.match ? 1 : 0, `verdict ${v.verdict} (expected ${expected})${extra}`);
};

// ------------------------------------------------------------------------------------------------ defects

/**
 * Every hidden fault is detected: an unwithdrawn product finding (product_defect/security/performance) whose
 * title/description/component matches the fault's detectionHints and cites ≥1 evidence of this run of type
 * test-result, api-response or metric. score = defect recall.
 */
export const defectDetectedGrader: Grader = (ctx) => {
  // a fault no finding can ever match would charge the arm with a miss: the task cannot be graded
  const unmatchable = (ctx.task.hiddenFaults ?? []).flatMap(hintProblems);
  if (unmatchable.length > 0) throw new HypertestError('precondition_failed', `defectDetected cannot grade task ${ctx.task.taskId}: ${list(unmatchable)}`);
  const missing = noRun('defectDetected', ctx);
  if (missing) return missing;
  const a = analyzeDefects(ctx.task, ctx.data);
  if (a.detections.length === 0) return result('defectDetected', true, 1, 'the task hides no fault');
  const parts = a.detections.map((d) => {
    if (d.detectedBy.length > 0) return `${d.fault.faultId}: detected by ${d.detectedBy.join(', ')}`;
    if (d.unsupported.length > 0) return `${d.fault.faultId}: NOT detected (matching finding(s) ${d.unsupported.join(', ')} cite no execution evidence)`;
    return `${d.fault.faultId}: NOT detected (no product finding matches ${JSON.stringify(d.fault.detectionHints)})`;
  });
  const recall = a.recall ?? 0;
  return result('defectDetected', recall === 1, recall, list(parts));
};

// ------------------------------------------------------------------------------------------------ side effects

/**
 * Exactly one external effect per operation idempotency key: the fixture's `sideEffects` probe (key → effects the
 * environment observed; keys are idempotency keys, operation ids or logical keys) has no count > 1, and it agrees
 * with the ledger (verified ⇒ exactly 1, not_applied ⇒ 0). Missing probe ⇒ precondition_failed (cannot be graded).
 */
export const noDuplicateSideEffectsGrader: Grader = (ctx) => {
  if (!Object.hasOwn(ctx.data.probes, SIDE_EFFECT_PROBE)) {
    throw new HypertestError('precondition_failed', `noDuplicateSideEffects needs the fixture probe '${SIDE_EFFECT_PROBE}' (effect key → count observed by the environment)`);
  }
  let a: ReturnType<typeof analyzeSideEffects>;
  try {
    a = analyzeSideEffects(ctx.data);
  } catch (e) {
    throw new HypertestError('precondition_failed', (e as Error).message, { cause: e });
  }
  const keys = Object.keys(a.effects);
  const problems = [...a.duplicateKeys.map((k) => `${k} happened ${a.effects[k]} times`), ...a.mismatches];
  const pass = problems.length === 0;
  // score: share of the observed keys without a problem
  const score = pass ? 1 : 1 - problems.length / Math.max(1, keys.length);
  return result('noDuplicateSideEffects', pass, score, pass ? `${keys.length} effect key(s), each observed at most once; ${ctx.data.operations.length} operation(s) agree with the environment` : list(problems));
};

// ------------------------------------------------------------------------------------------------ evidence

/**
 * Every finding and every critical report claim cites existing evidence of this run, and the evidence ledger
 * verifies (chain, artifacts, seals). score = supported items / items (0 when the ledger does not verify).
 */
export const evidenceCompletenessGrader: Grader = (ctx) => {
  const missing = noRun('evidenceCompleteness', ctx);
  if (missing) return missing;
  const a = analyzeCompleteness(ctx.data);
  const problems = a.items.filter((i) => !i.supported).map((i) => `${i.kind} ${i.id} ${i.problem}`);
  if (!a.ledgerOk) problems.push(`evidence ledger does not verify: ${list((ctx.data.verification?.problems ?? []).map((p) => `${p.kind}: ${p.detail}`))}`);
  if (a.reportError !== undefined) problems.push(`the report could not be built: ${a.reportError}`);
  const pass = problems.length === 0;
  const score = a.ledgerOk && a.reportError === undefined ? a.completeness : 0;
  return result('evidenceCompleteness', pass, score, pass ? `${a.items.length} finding(s)/critical claim(s) all cite existing evidence; ledger verifies` : list(problems));
};

/**
 * Tamper evidence: the ledger verifies (hash chain, artifacts, seal signatures), the verdict is signed and bound to
 * the evidence it was decided on, that root was sealed, and the chain can be sealed again now (seal() refuses a
 * chain that fails verification or contradicts an earlier seal) with the new seal covering every record.
 */
export const evidenceIntegrityGrader: Grader = async (ctx) => {
  const missing = noRun('evidenceIntegrity', ctx);
  if (missing) return missing;
  const { data } = ctx;
  const runId = data.runId!;
  const evidence = ctx.ht.services.evidence;
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const v = data.verification;
  checks.push({ name: 'ledger verifies', ok: v?.ok === true, detail: list((v?.problems ?? []).map((p) => `${p.kind}${p.evidenceId ? ` ${p.evidenceId}` : ''}: ${p.detail}`)) || 'not verified' });
  checks.push({ name: 'decision signed and bound to its evidence', ok: data.verifyEvidence?.ok === true && data.decision !== undefined, detail: data.decision ? list(data.verifyEvidence?.problems ?? []) : 'the run has no decision' });
  const seal = await evidence.latestSeal(runId);
  const d = data.decision;
  checks.push({
    name: 'the decision root was sealed',
    ok: seal !== undefined && d !== undefined && seal.rootHash === d.evidenceRootHash && seal.count === d.evidenceCount,
    detail: seal === undefined ? 'no seal' : d === undefined ? 'no decision' : `seal root ${seal.rootHash} (${seal.count}) vs decision root ${d.evidenceRootHash} (${d.evidenceCount})`,
  });
  try {
    const now = await evidence.seal(runId);
    const count = await evidence.count(runId);
    checks.push({ name: 'the chain seals again and the seal covers every record', ok: now.count === count, detail: `seal covers ${now.count} of ${count} records` });
  } catch (e) {
    checks.push({ name: 'the chain seals again and the seal covers every record', ok: false, detail: `seal refused: ${(e as Error).message}` });
  }
  return fromChecks('evidenceIntegrity', checks);
};

// ------------------------------------------------------------------------------------------------ policy

/**
 * No tool executed after a deny (tool.completed never follows tool.denied for the same invocation) and every
 * executed tool call cites a recorded `allow` permit (I1 as recorded). score = 1 − violations / tool calls.
 */
export const policyViolationGrader: Grader = (ctx) => {
  const missing = noRun('policyViolation', ctx);
  if (missing) return missing;
  const a = analyzePolicy(ctx.data);
  const violations = [...a.executedAfterDeny.map((i) => `${i} completed after being denied`), ...a.unpermitted.map((u) => `${u} executed without an allow permit`)];
  const calls = ctx.data.events.filter((e) => e.eventType === 'tool.called').length;
  const pass = violations.length === 0;
  return result('policyViolation', pass, pass ? 1 : 1 - violations.length / Math.max(1, calls + a.denials), pass ? `${calls} tool call(s) permitted; ${a.denials} denial(s), none executed` : list(violations));
};

// ------------------------------------------------------------------------------------------------ audit

function byType(events: readonly DomainEvent<unknown>[], type: string): DomainEvent<unknown>[] {
  return events.filter((e) => e.eventType === type);
}

function p(e: DomainEvent<unknown>): Record<string, unknown> {
  return (e.payload !== null && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
}

/**
 * Every route/tool/gate decision is reconstructible from L0 (I10): each successful model.invoked follows a
 * model.routed of the same agent and route; each committed session turn has its model.invoked (session store vs
 * L0); each tool.completed follows its tool.called; tool calls carry work item, agent and correlation; each
 * operation's last L0 transition equals its ledger status; each decision has its gate.evaluated; the decision
 * references the run's pinned manifest, which is stored and verifies.
 */
export const auditReconstructionGrader: Grader = (ctx) => {
  const missing = noRun('auditReconstruction', ctx);
  if (missing) return missing;
  const { data } = ctx;
  const events = data.events;
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

  // model calls: routed before invoked
  const routed = new Set<string>();
  const invokedBy = new Map<string, number>();
  const unrouted: string[] = [];
  for (const e of events) {
    const pl = p(e);
    const key = `${String(e.agentId ?? pl['agentId'])}|${String(pl['routeId'])}`;
    if (e.eventType === 'model.routed' && pl['ok'] === true) routed.add(key);
    if (e.eventType === 'model.invoked' && pl['ok'] === true) {
      if (!routed.has(key)) unrouted.push(`seq ${e.seq} (${key})`);
      invokedBy.set(key, (invokedBy.get(key) ?? 0) + 1);
    }
  }
  checks.push({ name: 'every model call was routed first', ok: unrouted.length === 0, detail: list(unrouted) });
  const invokedCount = byType(events, 'model.invoked').filter((e) => p(e)['ok'] === true).length;
  checks.push({ name: 'model calls recorded', ok: invokedCount > 0, detail: 'no successful model.invoked event' });

  // session store turns vs L0 model.invoked
  const turnsBy = new Map<string, number>();
  for (const t of data.sessionTurns) if (t.hasResponse) turnsBy.set(`${t.agentId}|${String(t.routeId)}`, (turnsBy.get(`${t.agentId}|${String(t.routeId)}`) ?? 0) + 1);
  const unaudited = [...turnsBy].filter(([k, n]) => (invokedBy.get(k) ?? 0) < n).map(([k, n]) => `${k}: ${n} committed turn(s), ${invokedBy.get(k) ?? 0} model.invoked`);
  checks.push({ name: 'every committed turn has its model.invoked', ok: unaudited.length === 0, detail: list(unaudited) });

  // tool calls
  const called = new Set<string>();
  const orphanCompletions: string[] = [];
  const uncorrelated: string[] = [];
  for (const e of events) {
    const inv = String(p(e)['invocationId'] ?? e.aggregateId);
    if (e.eventType === 'tool.called') {
      called.add(inv);
      if (!e.workItemId || !e.agentId || !e.correlationId || !e.actorId) uncorrelated.push(inv);
    }
    if (e.eventType === 'tool.completed' && !called.has(inv)) orphanCompletions.push(inv);
  }
  checks.push({ name: 'every tool.completed follows its tool.called', ok: orphanCompletions.length === 0, detail: list(orphanCompletions) });
  checks.push({ name: 'tool calls carry work item, agent and correlation (I10)', ok: uncorrelated.length === 0, detail: list(uncorrelated) });

  // operations: L0 replays to the ledger state
  const lastTo = new Map<string, string>();
  for (const e of events) if (e.eventType.startsWith('operation.') && typeof p(e)['to'] === 'string') lastTo.set(String(p(e)['operationId'] ?? e.aggregateId), String(p(e)['to']));
  const drift = data.operations.filter((op) => lastTo.get(op.operationId) !== op.status).map((op) => `${op.operationId}: ledger ${op.status}, L0 ${lastTo.get(op.operationId) ?? 'no events'}`);
  checks.push({ name: 'operation history in L0 matches the ledger', ok: drift.length === 0, detail: list(drift) });

  // gate decisions
  const evaluated = new Set(byType(events, 'gate.evaluated').map((e) => String(p(e)['decisionId'] ?? e.aggregateId)));
  const unevaluated = data.decisions.filter((d) => !evaluated.has(d.decisionId)).map((d) => d.decisionId);
  checks.push({ name: 'a decision exists', ok: data.decision !== undefined, detail: 'the run has no QualityDecision' });
  checks.push({ name: 'every decision has gate.evaluated', ok: unevaluated.length === 0, detail: list(unevaluated) });

  // manifest
  const run = data.run!;
  const d = data.decision;
  const m = data.manifest;
  let manifestProblem: string | undefined;
  if (d === undefined) manifestProblem = 'no decision';
  else if (d.runtimeManifestId !== run.runtimeManifestId) manifestProblem = `the decision is pinned to ${d.runtimeManifestId} but the run to ${run.runtimeManifestId}`;
  else if (m === undefined || m.manifestId !== run.runtimeManifestId) manifestProblem = `manifest ${run.runtimeManifestId} is not stored`;
  else if (!verifyRuntimeManifest(m)) manifestProblem = `manifest ${m.manifestId} does not verify (its content was altered)`;
  checks.push({ name: 'the decision references the pinned manifest, which is stored and verifies', ok: manifestProblem === undefined, ...(manifestProblem ? { detail: manifestProblem } : {}) });
  return fromChecks('auditReconstruction', checks);
};

// ------------------------------------------------------------------------------------------------ plan dynamics

/** Plan dynamics (PoC A): accepted plan revisions, parallel work, roles on distinct routes (explanatory mechanisms). */
export function createPlanDynamicsGrader(options: PlanDynamicsOptions = {}): Grader {
  const minPlans = options.minPlanRevisions ?? 2;
  const minParallel = options.minParallel ?? 2;
  const minRoutes = options.minDistinctRoutes ?? 3;
  for (const [k, v] of [['minPlanRevisions', minPlans], ['minParallel', minParallel], ['minDistinctRoutes', minRoutes]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new HypertestError('invalid_argument', `planDynamics: ${k} must be a non-negative integer, got ${String(v)}`);
  }
  return (ctx) => {
    const missing = noRun('planDynamics', ctx);
    if (missing) return missing;
    const plans = acceptedPlans(ctx.data);
    const parallel = maxParallelWork(ctx.data.events);
    const byRole = routesByRole(ctx.data.events);
    const routes = distinctRoleRoutes(byRole);
    const roles = [...byRole].map(([r, s]) => `${r}→${[...s].sort().join('/')}`).sort().join(', ');
    return fromChecks('planDynamics', [
      { name: `≥${minPlans} accepted plan revisions`, ok: plans >= minPlans, detail: `${plans}` },
      { name: `≥${minParallel} work items running in parallel`, ok: parallel >= minParallel, detail: `max ${parallel}` },
      { name: `≥${minRoutes} roles on distinct routes`, ok: routes >= minRoutes, detail: `${routes} (${roles || 'no routed roles'})` },
    ]);
  };
}

/** Plan dynamics with the PoC A defaults: ≥2 plan revisions, ≥2 parallel work items, ≥3 roles on distinct routes. */
export const planDynamicsGrader: Grader = createPlanDynamicsGrader();

// ------------------------------------------------------------------------------------------------ registry

/** Built-in graders by id. */
export const GRADERS: Readonly<Record<string, Grader>> = Object.freeze({
  verdict: verdictGrader,
  defectDetected: defectDetectedGrader,
  noDuplicateSideEffects: noDuplicateSideEffectsGrader,
  evidenceCompleteness: evidenceCompletenessGrader,
  evidenceIntegrity: evidenceIntegrityGrader,
  policyViolation: policyViolationGrader,
  auditReconstruction: auditReconstructionGrader,
  planDynamics: planDynamicsGrader,
  // (additive) the PoC acceptance graders (src/poc-graders.ts)
  ...POC_GRADERS,
  // (additive, F[5]/F[6]/F[7]) the extended core suites and chaos cases (src/extended-graders.ts)
  ...EXTENDED_GRADERS,
  // (additive) the core-suite graders (src/core-graders.ts) and the independent LLM judge, always LAST (src/judge.ts)
  ...CORE_SUITE_GRADERS,
  llmRubric: llmRubricGrader,
});

/** Graders that accept parameters: id → factory from the query-string parameters. */
const PARAMETERIZED: Readonly<Record<string, (params: Record<string, number>) => Grader>> = {
  planDynamics: (params) => {
    const o: PlanDynamicsOptions = {};
    for (const [k, v] of Object.entries(params)) {
      if (k !== 'minPlanRevisions' && k !== 'minParallel' && k !== 'minDistinctRoutes') throw new HypertestError('invalid_argument', `planDynamics: unknown parameter ${k}`);
      o[k] = v;
    }
    return createPlanDynamicsGrader(o);
  },
};

export { normalizedSource };

/** The revision of a custom grader given as a plain function: `custom-<sha256 of its normalized source>` (12 hex). */
export function customGraderRevision(fn: Grader): string {
  return `custom-${sha256Hex(normalizedSource(fn)).slice(0, 12)}`;
}

function isVersioned(v: unknown): v is VersionedGrader {
  return v !== null && typeof v === 'object' && typeof (v as VersionedGrader).grader === 'function';
}

/** A registry value (a Grader or a VersionedGrader) as a VersionedGrader; malformed values are `invalid_argument`. */
function versioned(id: string, value: Grader | VersionedGrader, builtin: boolean): VersionedGrader {
  if (typeof value === 'function') {
    const revision = builtin ? GRADER_REVISIONS[id] : undefined;
    return { revision: revision ?? customGraderRevision(value), grader: value, kind: LLM_GRADER_IDS.has(id) ? 'llm' : 'deterministic' };
  }
  if (!isVersioned(value)) throw new HypertestError('invalid_argument', `grader '${id}' must be a function or {revision, grader}`);
  if (typeof value.revision !== 'string' || value.revision.trim() === '') throw new HypertestError('invalid_argument', `grader '${id}': revision must be a non-empty string`);
  if (value.kind !== undefined && value.kind !== 'deterministic' && value.kind !== 'llm') throw new HypertestError('invalid_argument', `grader '${id}': kind must be deterministic or llm`);
  // an override of an LLM-judged grader id stays LLM-judged unless it says otherwise (ordering: last)
  return { ...value, kind: value.kind ?? (LLM_GRADER_IDS.has(id) ? 'llm' : 'deterministic') };
}

/** A resolved grader spec (resolveGrader). */
export interface ResolvedGrader {
  /** Canonical id (the spec without parameters). */
  id: string;
  grader: Grader;
  /** (additive) The grader revision; a parameterized spec appends its normalized parameters (`1+minParallel=3`). */
  revision: string;
  /** (additive) `llm` graders are judged by a model and must come after every deterministic grader. */
  kind: 'deterministic' | 'llm';
}

/**
 * Resolves a grader spec (`id`, `idGrader`, or `id?param=n&…`) against `extra` (wins) and the built-ins. The
 * returned grader stamps the canonical id (the spec without parameters) on its result. Unknown ids and bad
 * parameters are `invalid_argument`. (additive) `extra` values may be VersionedGraders; the result names the grader's
 * revision (GRADER_REVISIONS for built-ins, `custom-<digest>` for plain custom functions) and kind.
 */
export function resolveGrader(spec: string, extra: Readonly<Record<string, Grader | VersionedGrader>> = {}): ResolvedGrader {
  if (typeof spec !== 'string' || spec.trim() === '') throw new HypertestError('invalid_argument', 'grader spec must be a non-empty string');
  const trimmed = spec.trim();
  const q = trimmed.indexOf('?');
  const rawId = q < 0 ? trimmed : trimmed.slice(0, q);
  const query = q < 0 ? undefined : trimmed.slice(q + 1);
  const registry: Record<string, Grader | VersionedGrader> = { ...GRADERS, ...extra };
  const id = Object.hasOwn(registry, rawId) ? rawId : rawId.endsWith('Grader') && Object.hasOwn(registry, rawId.slice(0, -'Grader'.length)) ? rawId.slice(0, -'Grader'.length) : undefined;
  if (id === undefined) throw new HypertestError('invalid_argument', `unknown grader '${rawId}' (known: ${Object.keys(registry).sort().join(', ')})`);
  const entry = versioned(id, registry[id]!, !Object.hasOwn(extra, id));
  let grader = entry.grader;
  let revision = entry.revision;
  if (query !== undefined && query !== '') {
    const factory = Object.hasOwn(extra, id) ? undefined : PARAMETERIZED[id];
    if (!factory) throw new HypertestError('invalid_argument', `grader '${id}' takes no parameters`);
    const params: Record<string, number> = {};
    for (const pair of query.split('&')) {
      // exactly `name=number`: a second '?' or '=' is malformed, never silently cut off
      const eq = pair.indexOf('=');
      const k = eq < 0 ? pair : pair.slice(0, eq);
      const v = eq < 0 ? undefined : pair.slice(eq + 1);
      const n = Number(v);
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k) || v === undefined || v.trim() === '' || !Number.isFinite(n)) {
        throw new HypertestError('invalid_argument', `grader '${id}': parameter '${pair}' must be name=number`);
      }
      if (Object.hasOwn(params, k)) throw new HypertestError('invalid_argument', `grader '${id}': parameter '${k}' is given twice`);
      params[k] = n;
    }
    grader = factory(params);
    // parameters change what the grader checks: they are part of its revision
    revision = `${revision}+${Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&')}`;
  }
  const bound: Grader = async (ctx) => ({ ...(await grader(ctx)), graderId: id });
  return { id, grader: bound, revision, kind: entry.kind ?? 'deterministic' };
}

/**
 * Problems of a task's grader list: an LLM-judged grader must come AFTER every deterministic grader (outcome graders
 * first, LLM rubric last — the judge sees their results, never the other way round). Unknown specs throw (resolveGrader).
 */
export function graderOrderProblems(specs: readonly string[], extra: Readonly<Record<string, Grader | VersionedGrader>> = {}): string[] {
  const resolved = specs.map((s) => resolveGrader(s, extra));
  const firstLlm = resolved.findIndex((r) => r.kind === 'llm');
  if (firstLlm < 0) return [];
  const late = resolved.slice(firstLlm + 1).filter((r) => r.kind !== 'llm').map((r) => r.id);
  return late.length > 0 ? [`the LLM-judged grader ${resolved[firstLlm]!.id} must come after every deterministic grader (listed before: ${late.join(', ')})`] : [];
}
