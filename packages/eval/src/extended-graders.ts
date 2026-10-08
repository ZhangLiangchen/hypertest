/**
 * Graders of the extended core suites (F[5], F[6], F[7]; src/suites/extended.ts). Like every grader they read recorded
 * state — L0, the ledgers, the blackboard, the evidence verifier, the fixtures' ground-truth probes — never an agent's
 * narrative. Registered in GRADERS (ids): blackBoxOnly, uiEvidence, faultTolerance, tamperDetected, delegation,
 * convergence, budgetExhaustion, competingFaultsIsolated, unqueryableEscalated, providerClassesAudited.
 */
import { HypertestError } from '@hypertest/core';
import { TERMINAL_TOOL_IDS } from '@hypertest/control';
import type { BlackboardRecord, DomainEvent, Finding } from '@hypertest/domain';
import type { Grader, GraderResult, TrialData } from './contracts.ts';
import { PRODUCT_FINDING_CATEGORIES, RELEASE_VERDICTS } from './analysis.ts';
import { maxConcurrent } from './poc-graders.ts';

type Check = { name: string; ok: boolean; detail?: string };
const MAX_ITEMS = 8;

function list(items: readonly string[]): string {
  const shown = items.slice(0, MAX_ITEMS).join('; ');
  return items.length > MAX_ITEMS ? `${shown}; … (${items.length - MAX_ITEMS} more)` : shown;
}

function fromChecks(graderId: string, checks: Check[]): GraderResult {
  const failed = checks.filter((c) => !c.ok);
  const score = checks.length === 0 ? 1 : (checks.length - failed.length) / checks.length;
  const detail = failed.length === 0 ? `all ${checks.length} checks passed` : `${failed.length}/${checks.length} checks failed: ${list(failed.map((c) => (c.detail ? `${c.name}: ${c.detail}` : c.name)))}`;
  return { graderId, pass: failed.length === 0, score, detail };
}

function noRun(graderId: string, data: TrialData): GraderResult | undefined {
  return data.run ? undefined : { graderId, pass: false, score: 0, detail: 'no run was recorded for this trial' };
}

function payload(e: DomainEvent<unknown>): Record<string, unknown> {
  return (e.payload !== null && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function probe<T>(data: TrialData, name: string, graderId: string): T {
  if (!Object.hasOwn(data.probes, name)) throw new HypertestError('precondition_failed', `${graderId} needs the fixture probe '${name}'`);
  return data.probes[name] as unknown as T;
}

/** Tool ids called (tool.called) in the run, with the role of the calling agent. */
function toolCalls(events: readonly DomainEvent<unknown>[]): Array<{ toolId: string; role: string | undefined; agentId: string | undefined }> {
  const roles = new Map<string, string>();
  for (const e of events) if (e.eventType === 'agent.spawned') roles.set(str(payload(e)['agentId']) ?? e.aggregateId, str(payload(e)['role']) ?? '');
  return events.filter((e) => e.eventType === 'tool.called').map((e) => ({ toolId: str(payload(e)['toolId']) ?? '?', role: roles.get(e.agentId ?? ''), agentId: e.agentId }));
}

/** Tools that read or change the SUT's source (white-box): a black-box task must reach its verdict without them. */
export const WHITE_BOX_TOOL_PREFIXES: readonly string[] = ['fs.read', 'fs.search', 'fs.list', 'code.', 'git.', 'lsp.', 'static.', 'db.'];

/**
 * (F[5]) Black-box only: no agent used a white-box tool (source read/search, code intelligence, git, database
 * introspection) — the verdict rests on what the system under test answers.
 */
export const blackBoxOnlyGrader: Grader = (ctx) => {
  const missing = noRun('blackBoxOnly', ctx.data);
  if (missing) return missing;
  const calls = toolCalls(ctx.data.events);
  const whiteBox = calls.filter((c) => WHITE_BOX_TOOL_PREFIXES.some((p) => c.toolId === p || c.toolId.startsWith(p)));
  const sut = calls.filter((c) => ['http.request', 'browser.navigate', 'browser.click', 'browser.fill', 'browser.text', 'load.start', 'grpc.call'].includes(c.toolId));
  return fromChecks('blackBoxOnly', [
    { name: 'the system under test was exercised through its interfaces', ok: sut.length > 0, detail: `${sut.length} interface call(s)` },
    { name: 'no white-box tool was used', ok: whiteBox.length === 0, detail: list(whiteBox.map((c) => `${c.toolId} by ${c.role ?? '?'}`)) },
  ]);
};

/**
 * (F[5]) UI evidence: the UI finding rests on what the page SHOWED — a dom-snapshot recorded by browser.text on the
 * environment's page (and a screenshot) — not on an API exchange or the agent's narrative.
 */
export const uiEvidenceGrader: Grader = (ctx) => {
  const missing = noRun('uiEvidence', ctx.data);
  if (missing) return missing;
  const { evidence, findings } = ctx.data;
  const byId = new Map(evidence.map((e) => [e.evidenceId, e]));
  const product = findings.filter((f) => PRODUCT_FINDING_CATEGORIES.has(f.payload.category));
  const dom = product.flatMap((f) => f.evidenceRefs.map((id) => byId.get(id)).filter((e) => e?.evidenceType === 'dom-snapshot'));
  const onPage = dom.filter((e) => /\/ui(\b|$|[?#])/.test(String((e!.structured as { url?: unknown } | null)?.url ?? '')));
  const shots = evidence.filter((e) => e.evidenceType === 'screenshot');
  const navigated = toolCalls(ctx.data.events).filter((c) => c.toolId === 'browser.navigate');
  return fromChecks('uiEvidence', [
    { name: 'a real browser opened the page (browser.navigate)', ok: navigated.length > 0, detail: `${navigated.length}` },
    { name: 'a product finding cites dom-snapshot evidence of the page', ok: onPage.length > 0, detail: `${product.length} product finding(s), ${dom.length} dom-snapshot ref(s)` },
    { name: 'a screenshot of the page was recorded', ok: shots.length > 0, detail: `${shots.length}` },
  ]);
};

interface FaultRecord { operationId: string; fault: { kind?: string } | null; requestedAt: string; expiresAt: string | null; state: string }
interface LoadJobRecord { operationId: string; state?: string; startedAt?: string; finishedAt?: string; errorRate?: number }

function within(job: LoadJobRecord, fault: FaultRecord): boolean {
  if (!job.startedAt || !job.finishedAt || !fault.expiresAt) return false;
  return Date.parse(fault.requestedAt) <= Date.parse(job.startedAt) && Date.parse(job.finishedAt) <= Date.parse(fault.expiresAt);
}

function overlaps(a: FaultRecord, b: FaultRecord): boolean {
  if (!a.expiresAt || !b.expiresAt) return true;
  return Date.parse(a.requestedAt) < Date.parse(b.expiresAt) && Date.parse(b.requestedAt) < Date.parse(a.expiresAt);
}

/**
 * (F[7]) FaultTolerance: the fault was injected through the GOVERNED tool (env.inject_fault, a verified operation of an
 * experiment whose fault plan names it) and exactly once at the environment (supervisor ground truth); the load job
 * ran inside the fault window (the invariant was measured UNDER the fault); the gate judged R1 on that job's metric
 * evidence; after the fault expired the service was checked (a GET /health recorded after the expiry).
 */
export const faultToleranceGrader: Grader = async (ctx) => {
  const missing = noRun('faultTolerance', ctx.data);
  if (missing) return missing;
  const { operations, evidence, decision } = ctx.data;
  const faults = probe<FaultRecord[]>(ctx.data, 'faults', 'faultTolerance');
  const jobs = probe<LoadJobRecord[]>(ctx.data, 'loadJobs', 'faultTolerance');
  const checks: Check[] = [];
  const injected = operations.filter((o) => o.operationType === 'env.inject_fault');
  checks.push({ name: 'the fault was injected through env.inject_fault (verified operation)', ok: injected.length === 1 && injected[0]!.status === 'verified', detail: injected.map((o) => `${o.operationId}:${o.status}`).join(', ') || 'none' });
  checks.push({ name: 'the environment applied exactly one fault', ok: faults.length === 1, detail: `${faults.length}` });
  const experiments = await ctx.ht.services.specs.listExperiments(ctx.data.runId!);
  const kind = faults[0]?.fault?.kind;
  checks.push({ name: 'the fault belongs to an experiment whose fault plan names it', ok: kind !== undefined && experiments.some((x) => x.faultPlan.some((f) => f.kind === kind)), detail: `fault ${kind ?? '?'}, ${experiments.length} experiment(s)` });
  const fault = faults[0];
  const under = fault ? jobs.filter((j) => within(j, fault)) : [];
  checks.push({ name: 'the load job ran inside the fault window', ok: jobs.length === 1 && under.length === 1, detail: jobs.map((j) => `${j.operationId} ${j.startedAt ?? '?'}..${j.finishedAt ?? '?'}`).join(', ') + (fault ? ` vs fault ${fault.requestedAt}..${fault.expiresAt}` : '') });
  const jobEvidence = evidence.filter((e) => e.evidenceType === 'metric' && under.some((j) => e.operationId === j.operationId)).map((e) => e.evidenceId);
  const judged = decision ? [...decision.satisfiedCriteria, ...decision.violatedCriteria].some((c) => c.criterionId === 'C3' && c.evidenceRefs.some((id) => jobEvidence.includes(id))) : false;
  checks.push({ name: "the gate judged the invariant on the job's metric evidence", ok: judged, detail: `job evidence ${jobEvidence.join(', ') || 'none'}` });
  const after = fault?.expiresAt ? evidence.filter((e) => e.evidenceType === 'api-response' && (e.structured as { request?: { path?: unknown } } | null)?.request?.path === '/health' && Date.parse(e.capturedAt) >= Date.parse(fault.expiresAt!)) : [];
  checks.push({ name: 'the service was checked after the fault expired', ok: after.length > 0, detail: `${after.length} GET /health after ${fault?.expiresAt ?? '?'}` });
  return fromChecks('faultTolerance', checks);
};

interface TamperProbe { tampered?: string[]; missing?: string[]; rewritten?: string[]; updateRefused?: boolean; error?: string }

/**
 * (F[7]) Tamper / missing detection: after the run an attacker changed artifact bytes, deleted an artifact and rewrote
 * an evidence row (the append-only trigger refused the plain rewrite). The independent verifier must name EXACTLY the
 * affected records per kind (artifact_hash, artifact_missing, metadata_hash) and no other record; the decision's
 * verification fails.
 */
export const tamperDetectedGrader: Grader = (ctx) => {
  const missing = noRun('tamperDetected', ctx.data);
  if (missing) return missing;
  const p = probe<TamperProbe>(ctx.data, 'afterRun', 'tamperDetected');
  if (p.error) throw new HypertestError('precondition_failed', `tamperDetected: the attack could not run: ${p.error}`);
  const problems = ctx.data.verification?.problems ?? [];
  const flagged = (kind: string) => [...new Set(problems.filter((x) => x.kind === kind && x.evidenceId).map((x) => x.evidenceId!))].sort();
  const expected = new Set([...(p.tampered ?? []), ...(p.missing ?? []), ...(p.rewritten ?? [])]);
  const extra = [...new Set(problems.map((x) => x.evidenceId).filter((id): id is string => id !== undefined && !expected.has(id)))];
  const same = (a: readonly string[], b: readonly string[] | undefined) => JSON.stringify(a) === JSON.stringify([...(b ?? [])].sort());
  return fromChecks('tamperDetected', [
    { name: 'the append-only ledger refused a plain rewrite of an evidence row', ok: p.updateRefused === true },
    { name: 'the verification fails', ok: ctx.data.verification?.ok === false && ctx.data.verifyEvidence?.ok === false },
    { name: 'every record of the tampered artifact is flagged artifact_hash', ok: same(flagged('artifact_hash'), p.tampered), detail: `flagged ${flagged('artifact_hash').join(', ') || 'none'}, expected ${(p.tampered ?? []).join(', ')}` },
    { name: 'every record of the deleted artifact is flagged artifact_missing', ok: same(flagged('artifact_missing'), p.missing), detail: `flagged ${flagged('artifact_missing').join(', ') || 'none'}, expected ${(p.missing ?? []).join(', ')}` },
    { name: 'the rewritten record is flagged metadata_hash', ok: same(flagged('metadata_hash'), p.rewritten), detail: `flagged ${flagged('metadata_hash').join(', ') || 'none'}, expected ${(p.rewritten ?? []).join(', ')}` },
    { name: 'no untouched record is flagged', ok: extra.length === 0, detail: list(extra) },
  ]);
};

/**
 * (F[5]) Delegation: the lead delegated ≥ 3 sub-tasks (delegation work items, its children) in one turn; they ran IN
 * PARALLEL and completed; their results reached the lead as summaries (it continued planning from them); the run then
 * converged to one decision with no open work.
 */
export const delegationGrader: Grader = (ctx) => {
  const missing = noRun('delegation', ctx.data);
  if (missing) return missing;
  const { workItems, events } = ctx.data;
  const children = workItems.filter((w) => w.origin.kind === 'delegation');
  const parents = new Set(children.map((w) => w.parentWorkItemId));
  const lead = workItems.find((w) => w.role === 'lead' && parents.has(w.workItemId));
  const done = children.filter((w) => w.state === 'completed');
  const parallel = maxConcurrent(events, new Set(children.map((w) => w.workItemId)));
  const plans = events.filter((e) => e.eventType === 'plan.revision_accepted' || e.eventType === 'plan.accepted' || e.eventType === 'plan.proposed').length;
  const open = workItems.filter((w) => !['completed', 'failed', 'cancelled'].includes(w.state));
  return fromChecks('delegation', [
    { name: 'the lead delegated ≥ 3 sub-tasks', ok: lead !== undefined && children.filter((w) => w.parentWorkItemId === lead.workItemId).length >= 3, detail: `${children.length} delegated item(s)` },
    { name: 'every delegated sub-task completed', ok: children.length > 0 && done.length === children.length, detail: children.map((w) => `${w.role}:${w.state}`).join(', ') },
    { name: 'the delegated sub-tasks ran in parallel', ok: parallel >= 2, detail: `max ${parallel} concurrently` },
    { name: 'the lead planned from the delegated results', ok: plans > 0 && workItems.some((w) => w.origin.kind === 'plan'), detail: `${plans} plan event(s)` },
    { name: 'converged: a final decision and no open work', ok: ctx.data.decision !== undefined && ctx.data.status === 'completed' && open.length === 0, detail: `status ${ctx.data.status}, ${open.length} open item(s)` },
  ]);
};

/**
 * (F[5]) Convergence: ≥ 2 independent agents reported the SAME symptom (each completed work that cites it), the
 * blackboard kept ONE finding lineage for it (no duplicate finding.created), exactly one RCA reaction followed, the run
 * reached one decision with no open work.
 */
export const convergenceGrader: Grader = (ctx) => {
  const missing = noRun('convergence', ctx.data);
  if (missing) return missing;
  const { workItems, events, findings } = ctx.data;
  const product = findings.filter((f) => PRODUCT_FINDING_CATEGORIES.has(f.payload.category) && f.payload.status !== 'duplicate');
  const byFingerprint = new Map<string, Array<BlackboardRecord<Finding>>>();
  for (const f of product) byFingerprint.set(f.payload.fingerprint, [...(byFingerprint.get(f.payload.fingerprint) ?? []), f]);
  const dupLineages = [...byFingerprint.values()].filter((l) => l.length > 1);
  const created = events.filter((e) => e.eventType === 'finding.created');
  const executors = workItems.filter((w) => w.role === 'executor' && w.origin.kind === 'plan' && w.state === 'completed');
  const reporting = executors.filter((w) => (w.result?.recordRefs ?? []).some((id) => product.some((f) => f.recordId === id || f.lineageId === id)));
  const rca = workItems.filter((w) => w.role === 'rca' && w.origin.kind === 'reactor');
  const open = workItems.filter((w) => !['completed', 'failed', 'cancelled'].includes(w.state));
  return fromChecks('convergence', [
    { name: '≥ 2 independent agents reported the symptom', ok: reporting.length >= 2, detail: `${reporting.length} of ${executors.length} executor(s)` },
    { name: 'one finding lineage per symptom (no duplicate findings)', ok: product.length >= 1 && dupLineages.length === 0, detail: `${product.length} product finding(s), ${dupLineages.length} duplicated symptom(s)` },
    { name: 'one finding.created for the symptom', ok: created.length === product.length, detail: `${created.length} finding.created` },
    { name: 'exactly one RCA reaction', ok: rca.length === 1, detail: `${rca.length}` },
    { name: 'converged: a final decision and no open work', ok: ctx.data.decision !== undefined && ctx.data.status === 'completed' && open.length === 0, detail: `status ${ctx.data.status}, ${open.length} open item(s)` },
  ]);
};

/**
 * (F[6]) Budget exhaustion: the run's budget ran out (budget.exhausted on L0), no tool call was executed beyond it,
 * the run converged (terminal, with a decision) and the verdict is not a release (missing evidence never passes).
 */
export const budgetExhaustionGrader: Grader = (ctx) => {
  const missing = noRun('budgetExhaustion', ctx.data);
  if (missing) return missing;
  const { events, decision } = ctx.data;
  const exhausted = events.filter((e) => e.eventType === 'budget.exhausted');
  const max = ctx.data.run!.budget.maxToolCalls;
  // the terminal calls (complete_work, fail_work) are never charged: an agent can always finish
  const executed = events.filter((e) => e.eventType === 'tool.completed' && !TERMINAL_TOOL_IDS.includes(str(payload(e)['toolId']) ?? '')).length;
  return fromChecks('budgetExhaustion', [
    { name: 'the budget was exhausted (budget.exhausted)', ok: exhausted.length >= 1, detail: `${exhausted.length}` },
    { name: `no more than maxToolCalls (${max}) charged tool calls completed`, ok: executed <= max, detail: `${executed} completed` },
    { name: 'the run converged to a decision', ok: decision !== undefined && (ctx.data.status === 'completed' || ctx.data.status === 'failed'), detail: `status ${ctx.data.status}` },
    { name: 'no release on an exhausted budget without evidence', ok: decision !== undefined && !RELEASE_VERDICTS.has(decision.verdict), detail: `verdict ${decision?.verdict ?? 'none'}` },
  ]);
};

/**
 * (F[6]) Competing fault experiments: two experiments with faults on the same environment were both admitted — one only
 * after the other released it (at least one refused admission on L0) — their faults never overlapped at the
 * environment (supervisor ground truth), and each load job ran inside exactly one fault window (no contamination).
 */
export const competingFaultsIsolatedGrader: Grader = async (ctx) => {
  const missing = noRun('competingFaultsIsolated', ctx.data);
  if (missing) return missing;
  const faults = probe<FaultRecord[]>(ctx.data, 'faults', 'competingFaultsIsolated');
  const jobs = probe<LoadJobRecord[]>(ctx.data, 'loadJobs', 'competingFaultsIsolated');
  const experiments = await ctx.ht.services.specs.listExperiments(ctx.data.runId!);
  const withFaults = experiments.filter((x) => x.faultPlan.length > 0);
  const refused = ctx.data.events.filter((e) => e.eventType === 'admission.refused' || (e.eventType === 'tool.denied' && /experiment|admission|conflict/.test(JSON.stringify(e.payload ?? {}))));
  const deniedDefines = toolCalls(ctx.data.events).filter((c) => c.toolId === 'experiment.define').length - withFaults.length;
  const pairs: string[] = [];
  for (let i = 0; i < faults.length; i++) for (let j = i + 1; j < faults.length; j++) if (overlaps(faults[i]!, faults[j]!)) pairs.push(`${faults[i]!.operationId}∩${faults[j]!.operationId}`);
  const clean = jobs.filter((job) => faults.filter((f) => within(job, f)).length === 1);
  return fromChecks('competingFaultsIsolated', [
    { name: 'both fault experiments were admitted', ok: withFaults.length >= 2, detail: `${withFaults.length}` },
    { name: 'a competing admission was refused while the other experiment held the environment', ok: refused.length > 0 || deniedDefines > 0, detail: `${refused.length} refusal event(s), ${deniedDefines} refused define(s)` },
    { name: 'both faults were applied', ok: faults.length === 2, detail: `${faults.length}` },
    { name: 'the fault windows never overlapped', ok: pairs.length === 0, detail: list(pairs) },
    { name: 'each load job ran under exactly one fault', ok: jobs.length === 2 && clean.length === jobs.length, detail: jobs.map((j) => `${j.operationId} ${j.startedAt ?? '?'}..${j.finishedAt ?? '?'}`).join(', ') },
  ]);
};

/**
 * (F[6]) Unqueryable target: the write whose outcome the crash made unknown was escalated to manual review (it could
 * not be reconciled), was NEVER re-sent (dispatched once; the service saw one write with its key), a human resolved it
 * with the true outcome, and the run then continued to its decision.
 */
export const unqueryableEscalatedGrader: Grader = (ctx) => {
  const missing = noRun('unqueryableEscalated', ctx.data);
  if (missing) return missing;
  const { operations, events } = ctx.data;
  const writes = probe<Array<{ idempotencyKey?: string | null; key?: string }>>(ctx.data, 'writes', 'unqueryableEscalated');
  const put = operations.find((o) => o.operationType === 'http.request' && events.some((e) => e.aggregateId === o.operationId && e.eventType === 'operation.manual_review'));
  if (!put) return { graderId: 'unqueryableEscalated', pass: false, score: 0, detail: `no write operation reached manual review (${operations.map((o) => `${o.operationType}:${o.status}`).join(', ') || 'no operations'})` };
  const transitions = events.filter((e) => e.aggregateId === put.operationId && e.eventType.startsWith('operation.')).map((e) => e.eventType);
  const dispatched = transitions.filter((t) => t === 'operation.dispatched').length;
  const landed = writes.filter((w) => w.idempotencyKey === put.operationId).length;
  const resolved = events.find((e) => e.aggregateId === put.operationId && e.eventType === 'operation.resolved');
  const by = str(resolved ? payload(resolved)['by'] : undefined);
  const outcome = str(resolved ? payload(resolved)['outcome'] : undefined);
  return fromChecks('unqueryableEscalated', [
    { name: 'the outcome became unknown and could not be reconciled', ok: transitions.includes('operation.outcome_unknown') && transitions.includes('operation.manual_review'), detail: transitions.join(' → ') },
    { name: 'the write was never re-sent (dispatched once)', ok: dispatched === 1, detail: `${dispatched} dispatch(es)` },
    { name: 'the target saw exactly one write with its key', ok: landed === 1, detail: `${landed}` },
    { name: 'a human resolved it with the true outcome', ok: by !== undefined && by.startsWith('human:') && outcome === (landed > 0 ? 'succeeded' : 'failed'), detail: `${by ?? 'nobody'}: ${outcome ?? '-'}` },
    { name: 'the run continued to its decision', ok: ctx.data.decision !== undefined && ctx.data.status === 'completed', detail: `status ${ctx.data.status}` },
  ]);
};

interface WireCallRecord { provider: string; wireClass: string; role: string; status: number }

/**
 * (item 6) Provider classes audited: the run's model calls went over ≥ 3 provider CLASSES (the wire transport's log is
 * the ground truth); every exchange the transport answered is on L0 (per provider: the attempts of its model.invoked
 * events equal the exchanges — none unaudited, none invented); and the router switched classes mid-run (a
 * model.fallback whose routes belong to different classes).
 */
export const providerClassesAuditedGrader: Grader = (ctx) => {
  const missing = noRun('providerClassesAudited', ctx.data);
  if (missing) return missing;
  const calls = probe<WireCallRecord[]>(ctx.data, 'wireCalls', 'providerClassesAudited');
  const classOf = new Map(calls.map((c) => [c.provider, c.wireClass]));
  const served = new Set(calls.filter((c) => c.status === 200).map((c) => c.wireClass));
  const attempts = new Map<string, number>();
  const routeProvider = new Map<string, string>();
  for (const e of ctx.data.events) {
    const p = payload(e);
    const provider = str(p['provider']);
    const routeId = str(p['routeId']);
    if (provider && routeId) routeProvider.set(routeId, provider);
    if (e.eventType === 'model.invoked' && provider) attempts.set(provider, (attempts.get(provider) ?? 0) + (typeof p['attempts'] === 'number' ? p['attempts'] : 1));
  }
  const exchanges = new Map<string, number>();
  for (const c of calls) exchanges.set(c.provider, (exchanges.get(c.provider) ?? 0) + 1);
  const mismatched = [...new Set([...exchanges.keys(), ...attempts.keys()])].filter((p) => (exchanges.get(p) ?? 0) !== (attempts.get(p) ?? 0)).map((p) => `${p}: ${exchanges.get(p) ?? 0} exchange(s) vs ${attempts.get(p) ?? 0} audited attempt(s)`);
  const switches = ctx.data.events.filter((e) => e.eventType === 'model.fallback').map((e) => {
    const from = classOf.get(routeProvider.get(str(payload(e)['from']) ?? '') ?? '');
    const to = classOf.get(routeProvider.get(str(payload(e)['to']) ?? '') ?? '');
    return { from, to };
  });
  const cross = switches.filter((x) => x.from !== undefined && x.to !== undefined && x.from !== x.to);
  return fromChecks('providerClassesAudited', [
    { name: 'model calls were served by ≥ 3 provider classes', ok: served.size >= 3, detail: [...served].sort().join(', ') || 'none' },
    { name: 'every exchange is audited on L0 (and nothing else)', ok: calls.length > 0 && mismatched.length === 0, detail: list(mismatched) },
    { name: 'the router switched provider class mid-run', ok: cross.length > 0, detail: switches.map((x) => `${x.from ?? '?'}→${x.to ?? '?'}`).join(', ') || 'no fallback' },
  ]);
};

/** The extended graders by id (merged into GRADERS). */
export const EXTENDED_GRADERS: Readonly<Record<string, Grader>> = Object.freeze({
  blackBoxOnly: blackBoxOnlyGrader,
  uiEvidence: uiEvidenceGrader,
  faultTolerance: faultToleranceGrader,
  tamperDetected: tamperDetectedGrader,
  delegation: delegationGrader,
  convergence: convergenceGrader,
  budgetExhaustion: budgetExhaustionGrader,
  competingFaultsIsolated: competingFaultsIsolatedGrader,
  unqueryableEscalated: unqueryableEscalatedGrader,
  providerClassesAudited: providerClassesAuditedGrader,
});

/** Helpers the extended graders' fingerprints depend on (GRADER_DEPENDENCIES). */
export { toolCalls as calledTools, within as withinFault, overlaps as faultsOverlap };

