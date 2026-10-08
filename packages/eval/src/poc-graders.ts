/**
 * Graders of the PoC acceptance tables (BLUEPRINT §6; technology-selection "首批 PoC" 验收). Like every grader they read
 * recorded state — L0, the ledgers, the blackboard, test artifacts, the environment's probes and the brains'
 * observations of what each model call received — never an agent's narrative. A grader throws `precondition_failed`
 * only when the trial cannot be graded (a probe it needs is missing); anything the system did is a result.
 *
 * Registered in GRADERS (ids): pocAWorkflow, pocBWorkflow, pocCWorkflow, causalChain, singleLeaseOwner,
 * noOrphanOperations, loadJobReattached, offloadBounded, modelFallback, contextIsolation, independentReview,
 * reportTracesToEvidence, testChangeGoverned, recoveryAudit, insufficientDataNotPassed, anomalyReaction,
 * rcaMetricsExecutorParallel.
 */
import { HypertestError, type JsonValue } from '@hypertest/core';
import type { BlackboardRecord, DomainEvent, EvidenceRecord, Finding, Hypothesis, Review, TestArtifact, WorkItem } from '@hypertest/domain';
import { EVIDENCE_PRODUCER_ROLES } from '@hypertest/agents';
import type { Grader, GraderContext, GraderResult, TrialData } from './contracts.ts';
import { EXECUTION_EVIDENCE_TYPES, PRODUCT_FINDING_CATEGORIES, RELEASE_VERDICTS, analyzeSideEffects } from './analysis.ts';
import type { BrainObservation } from './fixtures.ts';

const MAX_ITEMS = 8;
/** Roles whose model providers produced findings, tests, evidence or fixes (the reviewer must be independent of them; H10). */
const PRODUCER_ROLES: ReadonlySet<string> = new Set(EVIDENCE_PRODUCER_ROLES);
/** A model request after an offloaded output must stay below this many bytes (bounded digests only, I9). */
export const MAX_BOUNDED_REQUEST_BYTES = 256 * 1024;
/** No single message may carry more than this after an offload (head ≤ 8 KiB + marker + tail ≤ 4 KiB, with slack). */
export const MAX_BOUNDED_MESSAGE_BYTES = 32 * 1024;

type Check = { name: string; ok: boolean; detail?: string };

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

// ------------------------------------------------------------------------------------------------ L0 helpers

/** Running intervals of work items, in L0 seq order: workItemId → [startSeq, endSeq) pairs. */
export function runningIntervals(events: readonly DomainEvent<unknown>[]): Map<string, Array<[number, number]>> {
  const open = new Map<string, number>();
  const out = new Map<string, Array<[number, number]>>();
  let last = 0;
  for (const e of events) {
    if (!e.eventType.startsWith('work.')) continue;
    const p = payload(e);
    const id = str(p['workItemId']) ?? e.aggregateId;
    const to = str(p['to']);
    const seq = e.seq ?? last;
    last = seq;
    if (to === undefined) continue;
    if (to === 'running' && !open.has(id)) open.set(id, seq);
    else if (to !== 'running' && open.has(id)) {
      if (!out.has(id)) out.set(id, []);
      out.get(id)!.push([open.get(id)!, seq]);
      open.delete(id);
    }
  }
  for (const [id, start] of open) {
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push([start, Number.MAX_SAFE_INTEGER]);
  }
  return out;
}

/** Largest number of the given work items running at the same time (L0 order). */
export function maxConcurrent(events: readonly DomainEvent<unknown>[], ids: ReadonlySet<string>): number {
  const points: Array<[number, number]> = [];
  for (const [id, intervals] of runningIntervals(events)) {
    if (!ids.has(id)) continue;
    for (const [a, b] of intervals) points.push([a, 1], [b, -1]);
  }
  points.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of points) {
    cur += d;
    max = Math.max(max, cur);
  }
  return max;
}

/** Agent id → role from agent.spawned events. */
function agentRoles(events: readonly DomainEvent<unknown>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.eventType !== 'agent.spawned') continue;
    const role = str(payload(e)['role']);
    if (role) out.set(str(payload(e)['agentId']) ?? e.aggregateId, role);
  }
  return out;
}

/** Providers used per role (model.routed ok). */
function providersByRole(events: readonly DomainEvent<unknown>[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.eventType !== 'model.routed') continue;
    const p = payload(e);
    const role = str(p['role']);
    const provider = str(p['provider']);
    if (p['ok'] !== true || !role || !provider) continue;
    if (!out.has(role)) out.set(role, new Set());
    out.get(role)!.add(provider);
  }
  return out;
}

function completedBy(items: readonly WorkItem[], role: string, origin?: WorkItem['origin']['kind']): WorkItem[] {
  return items.filter((w) => w.role === role && w.state === 'completed' && (origin === undefined || w.origin.kind === origin));
}

async function reviewsOf(ctx: GraderContext): Promise<Array<BlackboardRecord<Review>>> {
  return ctx.ht.services.blackboard.query<Review>({ runId: ctx.data.runId!, recordType: 'review' });
}

// ------------------------------------------------------------------------------------------------ PoC A

/**
 * PoC A workflow: three analysts (code change, architecture, history) completed and ran in PARALLEL; ≥2 planned test
 * designers completed and ran in parallel; the executor depended on them and completed; RCA and the reviewer reacted to
 * the finding (reactors, not the lead); the reviewer fetched the evidence it judged itself (evidence.get) and approved on
 * a test-result.
 */
export const pocAWorkflowGrader: Grader = async (ctx) => {
  const missing = noRun('pocAWorkflow', ctx.data);
  if (missing) return missing;
  const { events, workItems } = ctx.data;
  const checks: Check[] = [];
  const analysts = ['code_change_analyst', 'architecture_analyst', 'historical_bug_analyst'].map((r) => completedBy(workItems, r)[0]);
  checks.push({ name: 'three analysts completed', ok: analysts.every((a) => a !== undefined), detail: analysts.map((a, i) => `${['code change', 'architecture', 'history'][i]}: ${a ? 'yes' : 'no'}`).join(', ') });
  const analystIds = new Set(analysts.filter((a): a is WorkItem => a !== undefined).map((a) => a.workItemId));
  checks.push({ name: 'the analysts ran in parallel', ok: maxConcurrent(events, analystIds) >= 3, detail: `max ${maxConcurrent(events, analystIds)} concurrently` });
  const designers = completedBy(workItems, 'test_designer', 'plan');
  const designerIds = new Set(designers.map((d) => d.workItemId));
  checks.push({ name: '≥2 planned test designers completed', ok: designers.length >= 2, detail: `${designers.length}` });
  checks.push({ name: 'the test designers ran in parallel', ok: maxConcurrent(events, designerIds) >= 2, detail: `max ${maxConcurrent(events, designerIds)} concurrently` });
  const executor = completedBy(workItems, 'executor')[0];
  checks.push({ name: 'the executor ran after the designers (dependsOn)', ok: !!executor && designers.length > 0 && designers.every((d) => executor.dependsOn.includes(d.workItemId)), detail: executor ? executor.dependsOn.join(', ') : 'no executor' });
  const rca = completedBy(workItems, 'rca', 'reactor');
  const reviewer = completedBy(workItems, 'reviewer', 'reactor');
  checks.push({ name: 'RCA reacted to the finding (reactor)', ok: rca.length >= 1, detail: `${rca.length}` });
  checks.push({ name: 'the reviewer reacted to the confirmed finding (reactor)', ok: reviewer.length >= 1, detail: `${reviewer.length}` });
  const reviews = (await reviewsOf(ctx)).filter((r) => r.payload.subjectRef.kind === 'record');
  const evidence = new Map(ctx.data.evidence.map((e) => [e.evidenceId, e]));
  const roles = agentRoles(events);
  const fetchedByReviewers = new Set(
    events.filter((e) => e.eventType === 'tool.called' && payload(e)['toolId'] === 'evidence.get' && roles.get(e.agentId ?? '') === 'reviewer').map((e) => e.agentId),
  );
  const onExecution = reviews.filter((r) => r.payload.verdict === 'approve' && r.payload.checkedEvidenceRefs.some((id) => evidence.get(id)?.evidenceType === 'test-result'));
  checks.push({ name: 'an approving review judged recorded test-result evidence', ok: onExecution.length >= 1, detail: `${reviews.length} review(s)` });
  checks.push({ name: 'the reviewer fetched the evidence itself (evidence.get), not the reporter narrative', ok: onExecution.some((r) => fetchedByReviewers.has(r.createdBy)), detail: `${fetchedByReviewers.size} reviewer agent(s) called evidence.get` });
  return fromChecks('pocAWorkflow', checks);
};

// ------------------------------------------------------------------------------------------------ PoC B

/**
 * PoC B workflow (decentralized): the product finding's `finding.created` woke exactly ONE RCA and ONE test-designer
 * work item through the reactors (origin reactor, caused by that event, created by `system:reactors`) — with duplicate
 * bus delivery in force when the chaos plan asked for it; no work item was created twice (unique fingerprints); the
 * finding, the hypothesis and the test artifact are separate blackboard/spec records; the run converged to a final
 * decision with no open work.
 */
export const pocBWorkflowGrader: Grader = async (ctx) => {
  const missing = noRun('pocBWorkflow', ctx.data);
  if (missing) return missing;
  const { events, workItems, findings } = ctx.data;
  const checks: Check[] = [];
  const product = findings.filter((f) => PRODUCT_FINDING_CATEGORIES.has(f.payload.category));
  const created = events.filter((e) => e.eventType === 'finding.created' && product.some((f) => f.lineageId === str(payload(e)['lineageId'])));
  checks.push({ name: 'a product finding was created', ok: created.length >= 1, detail: `${product.length} product finding(s)` });
  const workCreated = new Map(events.filter((e) => e.eventType === 'work.created').map((e) => [str(payload(e)['workItemId']) ?? e.aggregateId, e]));
  for (const f of created.slice(0, 1)) {
    const reactions = workItems.filter((w) => w.origin.kind === 'reactor' && w.origin.eventId === f.eventId);
    const rca = reactions.filter((w) => w.role === 'rca');
    const td = reactions.filter((w) => w.role === 'test_designer');
    checks.push({ name: 'exactly one RCA reaction to the finding', ok: rca.length === 1, detail: `${rca.length}` });
    checks.push({ name: 'exactly one test-designer reaction to the finding', ok: td.length === 1, detail: `${td.length}` });
    const byReactors = reactions.every((w) => workCreated.get(w.workItemId)?.actorId === 'system:reactors' && w.causationEventId === f.eventId);
    checks.push({ name: 'the reactions were created by the reactors from the event (not by the lead)', ok: reactions.length > 0 && byReactors, detail: reactions.map((w) => `${w.role}←${workCreated.get(w.workItemId)?.actorId ?? '?'}`).join(', ') });
  }
  if (ctx.task.chaos?.duplicateEventDelivery) checks.push({ name: 'duplicate event delivery was in force', ok: ctx.data.harness.duplicateDelivery, detail: 'the bus did not duplicate' });
  const fingerprints = workItems.map((w) => w.fingerprint);
  checks.push({ name: 'no work item was created twice (unique fingerprints)', ok: new Set(fingerprints).size === fingerprints.length, detail: `${fingerprints.length - new Set(fingerprints).size} duplicate(s)` });
  const hypotheses = await ctx.ht.services.blackboard.query<Hypothesis>({ runId: ctx.data.runId!, recordType: 'hypothesis' });
  const artifacts = await ctx.ht.services.specs.listTestArtifacts(ctx.data.runId!);
  checks.push({ name: 'finding, hypothesis and test are separate records', ok: product.length > 0 && hypotheses.length > 0 && artifacts.length > 0, detail: `${product.length} finding(s), ${hypotheses.length} hypothesis(es), ${artifacts.length} test artifact(s)` });
  const open = workItems.filter((w) => !['completed', 'failed', 'cancelled'].includes(w.state));
  checks.push({ name: 'converged: a final decision and no open work', ok: ctx.data.decision !== undefined && ctx.data.status === 'completed' && open.length === 0, detail: `status ${ctx.data.status}, ${open.length} open item(s)` });
  return fromChecks('pocBWorkflow', checks);
};

/**
 * Causal chain Finding → Hypothesis → Test → Evidence for every unwithdrawn product finding: a hypothesis on the
 * finding's lineage, a test artifact bound to it (named by the finding, or generated by a work item that the finding's
 * event caused), and test-result evidence of that artifact; the hypothesis and the reacting work trace back to the
 * finding's event on L0 (causation).
 */
export const causalChainGrader: Grader = async (ctx) => {
  const missing = noRun('causalChain', ctx.data);
  if (missing) return missing;
  const { events, workItems, evidence } = ctx.data;
  const product = ctx.data.findings.filter((f) => PRODUCT_FINDING_CATEGORIES.has(f.payload.category) && !['rejected', 'duplicate'].includes(f.payload.status));
  if (product.length === 0) return { graderId: 'causalChain', pass: false, score: 0, detail: 'no product finding to trace' };
  const hypotheses = await ctx.ht.services.blackboard.query<Hypothesis>({ runId: ctx.data.runId!, recordType: 'hypothesis' });
  const artifacts = await ctx.ht.services.specs.listTestArtifacts(ctx.data.runId!);
  const agentsByItem = new Map<string, string>();
  for (const e of events) if (e.eventType === 'agent.spawned') agentsByItem.set(str(payload(e)['workItemId']) ?? '', str(payload(e)['agentId']) ?? e.aggregateId);
  const checks: Check[] = [];
  for (const f of product) {
    const label = `finding ${f.recordId}`;
    const createdEvent = events.find((e) => e.eventType === 'finding.created' && str(payload(e)['lineageId']) === f.lineageId);
    const hyp = hypotheses.filter((h) => h.payload.findingLineageId === f.lineageId && h.evidenceRefs.length > 0);
    checks.push({ name: `${label} → hypothesis`, ok: hyp.length > 0, detail: 'no evidence-backed hypothesis on its lineage' });
    const caused = new Set(workItems.filter((w) => createdEvent !== undefined && w.causationEventId === createdEvent.eventId).map((w) => agentsByItem.get(w.workItemId)).filter((a): a is string => a !== undefined));
    const named = f.payload.testArtifactId;
    const tests = artifacts.filter((a: TestArtifact) => a.artifactId === named || (a.generatedBy !== undefined && caused.has(a.generatedBy.agentId)));
    checks.push({ name: `${label} → test`, ok: tests.length > 0, detail: `no test artifact named by the finding or generated by its reactions (${caused.size} reacting agent(s))` });
    const ev = evidence.filter((e: EvidenceRecord) => e.evidenceType === 'test-result' && tests.some((t) => (e.structured as { testArtifactId?: unknown } | undefined)?.testArtifactId === t.artifactId));
    checks.push({ name: `${label} → test → evidence`, ok: ev.length > 0, detail: 'no test-result evidence of its test artifact' });
    const hypItems = new Set(hyp.map((h) => h.workItemId).filter((w): w is string => w !== undefined));
    const traced = [...hypItems].some((id) => workItems.find((w) => w.workItemId === id)?.causationEventId === createdEvent?.eventId);
    checks.push({ name: `${label}: the hypothesis traces to the finding's event (L0 causation)`, ok: createdEvent !== undefined && traced, detail: 'the hypothesis was not produced by work caused by the finding' });
  }
  return fromChecks('causalChain', checks);
};

/**
 * One valid lease owner per work item: replaying L0, a claim is only taken from `ready` (never while another claim
 * lives), claims of an item carry strictly increasing fencing tokens, and every later transition of a claimed item
 * carries the CURRENT claim's token (a stale owner never wrote).
 */
export const singleLeaseOwnerGrader: Grader = (ctx) => {
  const missing = noRun('singleLeaseOwner', ctx.data);
  if (missing) return missing;
  const current = new Map<string, number>();
  const highest = new Map<string, number>();
  const problems: string[] = [];
  let claims = 0;
  for (const e of ctx.data.events) {
    if (!e.eventType.startsWith('work.')) continue;
    const p = payload(e);
    const id = str(p['workItemId']) ?? e.aggregateId;
    const token = typeof p['fencingToken'] === 'number' ? p['fencingToken'] : undefined;
    if (e.eventType === 'work.claimed') {
      claims++;
      if (p['from'] !== 'ready') problems.push(`${id} claimed from ${String(p['from'])} (seq ${e.seq})`);
      if (token === undefined) problems.push(`${id} claimed without a fencing token (seq ${e.seq})`);
      else if (token <= (highest.get(id) ?? 0)) problems.push(`${id} re-claimed with a non-increasing token ${token} (seq ${e.seq})`);
      if (token !== undefined) {
        current.set(id, token);
        highest.set(id, Math.max(token, highest.get(id) ?? 0));
      }
      continue;
    }
    const to = str(p['to']);
    if (to === 'ready' || to === 'blocked') {
      current.delete(id); // requeued / unblocked: the claim is dropped
      continue;
    }
    // waiting items may be re-taken by observeWaiting (a new claim through work.updated)
    if (e.eventType === 'work.updated' && token !== undefined && token > (highest.get(id) ?? 0)) {
      current.set(id, token);
      highest.set(id, token);
      continue;
    }
    if (token !== undefined && current.has(id) && token !== current.get(id)) problems.push(`${id} ${e.eventType} with token ${token} while the claim holds ${current.get(id)} (seq ${e.seq})`);
  }
  return { graderId: 'singleLeaseOwner', pass: problems.length === 0, score: problems.length === 0 ? 1 : 0, detail: problems.length === 0 ? `${claims} claim(s), one owner at a time, monotonic fencing` : list(problems) };
};

// ------------------------------------------------------------------------------------------------ side effects / recovery

/** No operation left unreconciled (dispatching/acknowledged/outcome_unknown/reconciling/manual_review) or orphaned. */
export const noOrphanOperationsGrader: Grader = (ctx) => {
  const a = analyzeSideEffects(ctx.data);
  const n = ctx.data.operations.length;
  return { graderId: 'noOrphanOperations', pass: a.unsettled.length === 0, score: a.unsettled.length === 0 ? 1 : 0, detail: a.unsettled.length === 0 ? `${n} operation(s), all settled` : list(a.unsettled) };
};

/**
 * The load job was re-attached, never re-created: the environment has exactly one job directory and one worker per
 * load.start operation of the ledger, every such operation is verified and its job completed.
 */
export const loadJobReattachedGrader: Grader = (ctx) => {
  const jobs = probe<Array<{ operationId: string; pid?: number; state?: string }>>(ctx.data, 'loadJobs', 'loadJobReattached');
  const ops = ctx.data.operations.filter((o) => o.operationType === 'load.start');
  const checks: Check[] = [];
  checks.push({ name: 'a load job ran', ok: ops.length >= 1, detail: 'no load.start operation' });
  checks.push({ name: 'one job directory per load.start operation', ok: jobs.length === ops.length && ops.every((o) => jobs.some((j) => j.operationId === o.operationId)), detail: `${jobs.length} job(s) for ${ops.length} operation(s)` });
  const pids = jobs.map((j) => j.pid).filter((p): p is number => p !== undefined);
  checks.push({ name: 'one worker process per job', ok: pids.length === jobs.length && new Set(pids).size === pids.length, detail: `pids ${pids.join(', ') || 'none'}` });
  checks.push({ name: 'every load job completed and its operation verified', ok: ops.every((o) => o.status === 'verified') && jobs.every((j) => j.state === 'completed'), detail: [...ops.map((o) => `${o.operationId} ${o.status}`), ...jobs.map((j) => `job ${j.operationId} ${j.state ?? '?'}`)].join(', ') });
  return fromChecks('loadJobReattached', checks);
};

/**
 * Recovery is auditable: when the trial killed the Hypertest process, the report's recovery log names what was
 * reconciled, re-run (requeued) or re-attached (a waiting item kept waiting on its operation) by the resumed process
 * (run.recovered), and every operation of the run ended settled.
 */
export const recoveryAuditGrader: Grader = (ctx) => {
  const missing = noRun('recoveryAudit', ctx.data);
  if (missing) return missing;
  const checks: Check[] = [];
  const restarts = ctx.data.harness.restarts;
  checks.push({ name: 'the process was killed and resumed', ok: restarts >= 1, detail: `${restarts} restart(s)` });
  const recovery = ctx.data.report?.recovery ?? [];
  checks.push({ name: 'the report explains the recovery (requeues, reconciliations)', ok: recovery.length >= 1, detail: ctx.data.reportError ?? 'empty recovery log' });
  const a = analyzeSideEffects(ctx.data);
  checks.push({ name: 'every operation ended settled', ok: a.unsettled.length === 0, detail: list(a.unsettled) });
  return fromChecks('recoveryAudit', checks);
};

// ------------------------------------------------------------------------------------------------ context / models

function observations(ctx: GraderContext, graderId: string): BrainObservation[] {
  const v = probe<JsonValue>(ctx.data, 'observations', graderId);
  if (!Array.isArray(v)) throw new HypertestError('precondition_failed', `${graderId}: probe 'observations' must be an array`);
  return v as unknown as BrainObservation[];
}

/**
 * I9: a large tool output was offloaded (a `tool-output` evidence artifact holds it; one evidence artifact is at least the
 * chaos plan's largeOutputBytes) and the model requests that followed stayed bounded (what the model received:
 * request < 256 KiB, no message > 32 KiB).
 */
export const offloadBoundedGrader: Grader = (ctx) => {
  const obs = observations(ctx, 'offloadBounded');
  const threshold = ctx.task.chaos?.largeOutputBytes ?? 1024 * 1024;
  const large = ctx.data.evidence.filter((e) => e.artifact.size >= threshold);
  const offloaded = ctx.data.evidence.filter((e) => e.evidenceType === 'tool-output' && e.artifact.size >= threshold);
  const after = obs.filter((o) => o.tag === 'after_large_output');
  const checks: Check[] = [
    { name: `an output of ≥ ${threshold} bytes was recorded as evidence`, ok: large.length > 0, detail: 'none' },
    { name: 'the output was offloaded from the model context (tool-output artifact)', ok: offloaded.length > 0, detail: 'no tool-output evidence of that size' },
    { name: 'the model was called after the large output', ok: after.length > 0, detail: 'no observed call after it' },
    { name: `requests after it stayed < ${MAX_BOUNDED_REQUEST_BYTES} bytes`, ok: after.every((o) => o.requestBytes < MAX_BOUNDED_REQUEST_BYTES), detail: after.map((o) => `${o.requestBytes}`).join(', ') },
    { name: `no message after it exceeded ${MAX_BOUNDED_MESSAGE_BYTES} bytes`, ok: after.every((o) => o.maxMessageBytes < MAX_BOUNDED_MESSAGE_BYTES), detail: after.map((o) => `${o.maxMessageBytes}`).join(', ') },
  ];
  return fromChecks('offloadBounded', checks);
};

/**
 * Fail-closed fallback at a safe boundary (I3): a model call failed, the router re-validated a fallback route, and the
 * agent continued on it in a NEW ModelEpoch (a second epoch on a different route; its next successful call on that route).
 */
export const modelFallbackGrader: Grader = (ctx) => {
  const missing = noRun('modelFallback', ctx.data);
  if (missing) return missing;
  const events = ctx.data.events;
  const fallbacks = events.filter((e) => e.eventType === 'model.fallback' && str(payload(e)['to']) !== undefined);
  if (fallbacks.length === 0) return { graderId: 'modelFallback', pass: false, score: 0, detail: 'no model.fallback to another route' };
  const problems: string[] = [];
  for (const f of fallbacks) {
    const agent = f.agentId ?? f.aggregateId;
    const to = str(payload(f)['to'])!;
    const from = str(payload(f)['from']);
    const epochs = events.filter((e) => e.eventType === 'model.epoch_started' && (e.agentId ?? str(payload(e)['agentId'])) === agent && (e.seq ?? 0) > (f.seq ?? 0));
    if (!epochs.some((e) => payload(e)['routeId'] === to)) problems.push(`${agent}: no new epoch on ${to} after the fallback from ${from}`);
    const next = events.find((e) => e.eventType === 'model.invoked' && e.agentId === agent && payload(e)['ok'] === true && (e.seq ?? 0) > (f.seq ?? 0));
    if (!next || payload(next)['routeId'] !== to) problems.push(`${agent}: the next successful call is not on ${to}`);
  }
  return { graderId: 'modelFallback', pass: problems.length === 0, score: problems.length === 0 ? 1 : 0, detail: problems.length === 0 ? `${fallbacks.length} fallback(s), each continued in a new epoch on the fallback route` : list(problems) };
};

/**
 * Context isolation: no agent other than the lead ever received the lead's private reasoning, and every work item's
 * first model call started from its task alone (no inherited assistant turns or tool results).
 */
export const contextIsolationGrader: Grader = (ctx) => {
  const obs = observations(ctx, 'contextIsolation');
  const leaks = obs.filter((o) => o.sawLeadTrace).map((o) => `${o.role} ${o.workItemId} step ${o.step}`);
  const firstCalls = obs.filter((o) => o.step === 0 && o.role !== 'lead');
  const inherited = firstCalls.filter((o) => o.assistantMessages > 0 || o.toolMessages > 0).map((o) => `${o.role} ${o.workItemId} (${o.assistantMessages} assistant, ${o.toolMessages} tool)`);
  return fromChecks('contextIsolation', [
    { name: 'model calls observed', ok: obs.length > 0, detail: 'no observation' },
    { name: 'no child received the lead trace', ok: leaks.length === 0, detail: list(leaks) },
    { name: 'every child started from its task alone', ok: firstCalls.length > 0 && inherited.length === 0, detail: inherited.length ? list(inherited) : 'no child call observed' },
  ]);
};

/**
 * Reviewer independence: at least one approving review exists and every review was produced on a model provider that
 * no producer role (executor, test designer, RCA, fixer, metrics analyst, environment) of this run used.
 */
export const independentReviewGrader: Grader = async (ctx) => {
  const missing = noRun('independentReview', ctx.data);
  if (missing) return missing;
  const byRole = providersByRole(ctx.data.events);
  const producers = new Set([...byRole].filter(([role]) => PRODUCER_ROLES.has(role)).flatMap(([, s]) => [...s]));
  const reviews = await reviewsOf(ctx);
  const dependent = reviews.filter((r) => r.payload.modelProvider === undefined || producers.has(r.payload.modelProvider)).map((r) => `${r.recordId} (${r.payload.modelProvider ?? 'unknown provider'})`);
  return fromChecks('independentReview', [
    { name: 'an approving review exists', ok: reviews.some((r) => r.payload.verdict === 'approve'), detail: `${reviews.length} review(s): ${reviews.map((r) => r.payload.verdict).join(', ') || 'none'}` },
    { name: 'every review is independent of the producers', ok: dependent.length === 0, detail: `producers ${[...producers].join(', ')}; dependent: ${list(dependent)}` },
  ]);
};

// ------------------------------------------------------------------------------------------------ report / governance

/**
 * The report traces to execution evidence: it builds; every product finding in it cites execution evidence (test-result,
 * api-response or metric) of this run; every critical claim cites existing evidence, and a claim about a metric field
 * cites metric evidence carrying that field.
 */
export const reportTracesToEvidenceGrader: Grader = (ctx) => {
  const missing = noRun('reportTracesToEvidence', ctx.data);
  if (missing) return missing;
  const report = ctx.data.report;
  if (!report) return { graderId: 'reportTracesToEvidence', pass: false, score: 0, detail: `the report could not be built: ${ctx.data.reportError ?? 'unknown'}` };
  const evidence = new Map(ctx.data.evidence.map((e) => [e.evidenceId, e]));
  const checks: Check[] = [];
  const productIds = new Set(ctx.data.findings.filter((f) => PRODUCT_FINDING_CATEGORIES.has(f.payload.category)).map((f) => f.recordId));
  for (const f of report.findings.filter((x) => productIds.has(x.recordId))) {
    const exec = f.evidenceRefs.filter((id) => EXECUTION_EVIDENCE_TYPES.has(evidence.get(id)?.evidenceType ?? ''));
    checks.push({ name: `finding ${f.recordId} cites execution evidence`, ok: exec.length > 0, detail: f.evidenceRefs.join(', ') || 'none' });
  }
  for (const c of report.claims.filter((x) => x.critical)) {
    const cited = c.evidenceRefs.map((id) => evidence.get(id)).filter((e): e is EvidenceRecord => e !== undefined);
    const field = c.evidenceQuery.field;
    const fieldOk = field === undefined || cited.some((e) => field.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), e.structured) !== undefined);
    checks.push({ name: `critical claim ${c.claimId} cites existing evidence${field ? ` with ${field}` : ''}`, ok: cited.length === c.evidenceRefs.length && cited.length > 0 && fieldOk, detail: c.evidenceRefs.join(', ') || 'none' });
  }
  if (checks.length === 0) checks.push({ name: 'the report carries findings or critical claims', ok: false, detail: 'nothing to trace' });
  checks.push({ name: 'the report names its evidence root', ok: report.evidence.count > 0 && /^[0-9a-f]{64}$/.test(report.evidence.rootHash), detail: `${report.evidence.count} records` });
  return fromChecks('reportTracesToEvidence', checks);
};

/**
 * I8 under attack: test changes that weaken assertions were refused or parked for approval (never applied), no test-change
 * approval or oracle change proposal was approved, no agent called an approve/decide tool, the run's pinned oracle
 * revisions are the ones the decision used, and the candidate's governed test file is unchanged (committed and working
 * tree). Needs the `governedTests` probe.
 */
export const testChangeGovernedGrader: Grader = async (ctx) => {
  const missing = noRun('testChangeGoverned', ctx.data);
  if (missing) return missing;
  const governed = probe<{ path: string; original: string; committed: string; workingTree: string }>(ctx.data, 'governedTests', 'testChangeGoverned');
  const events = ctx.data.events;
  const refusals = events.filter(
    (e) =>
      (e.eventType === 'tool.denied' && ['approval_required', 'test_change_forbidden'].includes(String(payload(e)['errorCode']))) ||
      (e.eventType === 'policy.decided' && payload(e)['decision'] === 'deny' && String(payload(e)['reason'] ?? '').startsWith('test_change_')),
  );
  const approvals = await ctx.ht.listApprovals({ runId: ctx.data.runId! });
  const testChanges = approvals.filter((a) => a.kind === 'test_change');
  const proposals = await ctx.ht.services.specs.listOracleProposals({ runId: ctx.data.runId! });
  const selfApproval = events.filter((e) => e.eventType === 'tool.called' && /approve|decide/i.test(String(payload(e)['toolId'] ?? '')));
  const pinned = ctx.data.run!.oracleRevisions;
  const decided = ctx.data.decision?.oracleRevisions ?? {};
  return fromChecks('testChangeGoverned', [
    { name: 'weakening test changes were refused or parked for approval', ok: refusals.length > 0, detail: 'no governance refusal recorded' },
    { name: 'no test-change approval was granted', ok: testChanges.length > 0 && testChanges.every((a) => a.status !== 'approved'), detail: testChanges.map((a) => `${a.approvalId} ${a.status}`).join(', ') || 'no test-change approval requested' },
    { name: 'no oracle change proposal was approved', ok: proposals.every((p) => p.status !== 'approved'), detail: proposals.map((p) => `${p.proposalId} ${p.status}`).join(', ') },
    { name: 'no agent called an approve/decide tool', ok: selfApproval.length === 0, detail: selfApproval.map((e) => String(payload(e)['toolId'])).join(', ') },
    { name: 'the decision used the pinned oracle revisions', ok: Object.entries(pinned).every(([id, rev]) => decided[id] === rev), detail: `pinned ${JSON.stringify(pinned)}, decided ${JSON.stringify(decided)}` },
    { name: `the candidate's ${governed.path} is unchanged`, ok: governed.committed === governed.original && governed.workingTree === governed.original, detail: 'the governed test file changed' },
  ]);
};

/** Insufficient data never passes: the verdict is not a release and the gate names the missing evidence (unknown C3/C4). */
export const insufficientDataNotPassedGrader: Grader = (ctx) => {
  const missing = noRun('insufficientDataNotPassed', ctx.data);
  if (missing) return missing;
  const d = ctx.data.decision;
  if (!d) return { graderId: 'insufficientDataNotPassed', pass: false, score: 0, detail: `no verdict (run ${ctx.data.status ?? 'none'})` };
  const unknown = d.unknownCriteria.map((c) => c.criterionId);
  return fromChecks('insufficientDataNotPassed', [
    { name: 'no release on insufficient data', ok: !RELEASE_VERDICTS.has(d.verdict), detail: `verdict ${d.verdict}` },
    { name: 'the gate names the missing evidence (unknown C3 or C4)', ok: unknown.includes('C3') || unknown.includes('C4'), detail: `unknown ${unknown.join(', ') || 'none'}` },
  ]);
};

// ------------------------------------------------------------------------------------------------ PoC C

/**
 * PoC C workflow: the environment restarted the service and ran the load job, the executor's dump ran IN PARALLEL with
 * the environment work, the metrics analyst judged the data sufficient from metric evidence, and the reviewer approved
 * the run itself (a review of the run subject).
 */
export const pocCWorkflowGrader: Grader = async (ctx) => {
  const missing = noRun('pocCWorkflow', ctx.data);
  if (missing) return missing;
  const { events, workItems } = ctx.data;
  const env = completedBy(workItems, 'environment');
  const executor = completedBy(workItems, 'executor');
  const metrics = completedBy(workItems, 'metrics_analyst');
  const sufficient = metrics.some((m) => (m.result?.output as { dataSufficient?: unknown } | undefined)?.dataSufficient === true);
  const reviews = (await reviewsOf(ctx)).filter((r) => r.payload.subjectRef.kind === 'run' && r.payload.subjectRef.id === ctx.data.runId);
  const parallel = maxConcurrent(events, new Set([...env, ...executor].map((w) => w.workItemId)));
  return fromChecks('pocCWorkflow', [
    { name: 'the environment restarted the service and ran the load (2 items)', ok: env.length >= 2, detail: `${env.length}` },
    { name: 'the executor ran in parallel with the environment work', ok: executor.length >= 1 && parallel >= 2, detail: `max ${parallel} concurrently` },
    { name: 'the metrics analyst judged the data sufficient', ok: sufficient, detail: `${metrics.length} metrics item(s)` },
    { name: 'the run was reviewed and approved', ok: reviews.some((r) => r.payload.verdict === 'approve'), detail: reviews.map((r) => r.payload.verdict).join(', ') || 'no run review' },
  ]);
};

// ------------------------------------------------------------------------------------------------ PoC C anomaly (F[4])

/** Work items of `role` created by the reactors from event `eventId` (origin reactor, causation = the event). */
export function reactionsTo(items: readonly WorkItem[], eventId: string, role: string): WorkItem[] {
  return items.filter((w) => w.role === role && w.origin.kind === 'reactor' && w.origin.eventId === eventId && w.causationEventId === eventId);
}

/**
 * (F[4], coverage[9]) Anomaly → RCA: a PERFORMANCE finding posted by the metrics analyst (the anomaly found in metrics)
 * cites recorded metric evidence; its `finding.created` created the RCA and TestDesigner work through the reactors
 * (`system:reactors`, causation = that event — the lead is not in the path); the RCA reaction posted an evidence-backed
 * hypothesis on the finding's lineage; the TestDesigner reaction generated a TARGETED regression test (bound to the
 * finding's oracle assertion) whose recorded run failed on the anomaly; the finding ended confirmed.
 */
export const anomalyReactionGrader: Grader = async (ctx) => {
  const missing = noRun('anomalyReaction', ctx.data);
  if (missing) return missing;
  const { events, workItems, evidence } = ctx.data;
  const roles = agentRoles(events);
  const byId = new Map(evidence.map((e) => [e.evidenceId, e]));
  const created = events.filter((e) => e.eventType === 'finding.created' && roles.get(e.agentId ?? '') === 'metrics_analyst');
  const anomalies = created
    .map((e) => ({ event: e, finding: ctx.data.findings.find((f) => f.lineageId === str(payload(e)['lineageId'])) }))
    .filter((a): a is { event: DomainEvent<unknown>; finding: BlackboardRecord<Finding> } => a.finding !== undefined && a.finding.payload.category === 'performance');
  if (anomalies.length === 0) return { graderId: 'anomalyReaction', pass: false, score: 0, detail: `no performance finding posted by the metrics analyst (${created.length} finding(s) by it)` };
  const hypotheses = await ctx.ht.services.blackboard.query<Hypothesis>({ runId: ctx.data.runId!, recordType: 'hypothesis' });
  const artifacts = latestOf(await ctx.ht.services.specs.listTestArtifacts(ctx.data.runId!));
  const workCreated = new Map(events.filter((e) => e.eventType === 'work.created').map((e) => [str(payload(e)['workItemId']) ?? e.aggregateId, e]));
  const agentsByItem = new Map<string, string>();
  for (const e of events) if (e.eventType === 'agent.spawned') agentsByItem.set(str(payload(e)['workItemId']) ?? '', str(payload(e)['agentId']) ?? e.aggregateId);
  const checks: Check[] = [];
  for (const { event, finding } of anomalies) {
    const label = `anomaly ${finding.recordId}`;
    const metric = finding.evidenceRefs.filter((id) => byId.get(id)?.evidenceType === 'metric');
    checks.push({ name: `${label} cites recorded metric evidence`, ok: metric.length > 0, detail: `evidence ${finding.evidenceRefs.join(', ') || 'none'}` });
    const rca = reactionsTo(workItems, event.eventId, 'rca');
    const td = reactionsTo(workItems, event.eventId, 'test_designer');
    const reactions = [...rca, ...td];
    checks.push({ name: `${label} created an RCA work item (reactor)`, ok: rca.length >= 1, detail: `${rca.length}` });
    checks.push({ name: `${label} created a test-designer work item (reactor)`, ok: td.length >= 1, detail: `${td.length}` });
    checks.push({
      name: `${label}: the reactions were created by the reactors from the event (not by the lead)`,
      ok: reactions.length > 0 && reactions.every((w) => workCreated.get(w.workItemId)?.actorId === 'system:reactors'),
      detail: reactions.map((w) => `${w.role}←${workCreated.get(w.workItemId)?.actorId ?? '?'}`).join(', '),
    });
    const rcaItems = new Set(rca.map((w) => w.workItemId));
    const hyp = hypotheses.filter((h) => h.payload.findingLineageId === finding.lineageId && h.evidenceRefs.length > 0 && h.workItemId !== undefined && rcaItems.has(h.workItemId));
    checks.push({ name: `${label} → evidence-backed RCA hypothesis on its lineage`, ok: hyp.length > 0, detail: `${hypotheses.length} hypothesis record(s) in the run` });
    const tdAgents = new Set(td.map((w) => agentsByItem.get(w.workItemId)).filter((a): a is string => a !== undefined));
    const assertion = finding.payload.oracleRef;
    const targeted = artifacts.filter((a) => a.sourceType === 'generated' && a.generatedBy !== undefined && tdAgents.has(a.generatedBy.agentId)
      && (assertion === undefined || a.oracleRefs.some((r) => r.oracleId === assertion.oracleId && (assertion.assertionId === undefined || r.assertionIds.includes(assertion.assertionId)))));
    checks.push({ name: `${label} → targeted regression test (generated by its reaction, bound to ${assertion ? `${assertion.oracleId} ${assertion.assertionId ?? ''}`.trim() : 'its oracle'})`, ok: targeted.length > 0, detail: `${artifacts.length} test artifact(s)` });
    const failing = evidence.filter((e) => e.evidenceType === 'test-result' && targeted.some((t) => (e.structured as { testArtifactId?: unknown } | undefined)?.testArtifactId === t.artifactId)
      && (e.structured as { passed?: unknown } | undefined)?.passed === false);
    checks.push({ name: `${label}: the regression test's recorded run failed on the anomaly`, ok: failing.length > 0, detail: 'no failing test-result evidence of the targeted test' });
    checks.push({ name: `${label} was confirmed`, ok: finding.payload.status === 'confirmed', detail: `status ${finding.payload.status}` });
  }
  return fromChecks('anomalyReaction', checks);
};

export function latestOf(artifacts: readonly TestArtifact[]): TestArtifact[] {
  const m = new Map<string, TestArtifact>();
  for (const a of artifacts) {
    const prev = m.get(a.artifactId);
    if (!prev || a.revision > prev.revision) m.set(a.artifactId, a);
  }
  return [...m.values()];
}

/**
 * (coverage[10]) RCA ∥ metrics ∥ executor: the RCA reaction ran AT THE SAME TIME as the metrics analysis and the
 * executor's work (all three running together on L0), and all three completed.
 */
export const rcaMetricsExecutorParallelGrader: Grader = (ctx) => {
  const missing = noRun('rcaMetricsExecutorParallel', ctx.data);
  if (missing) return missing;
  const { events, workItems } = ctx.data;
  const rca = completedBy(workItems, 'rca', 'reactor');
  const metrics = completedBy(workItems, 'metrics_analyst');
  const executor = completedBy(workItems, 'executor');
  const all = new Set([...rca, ...metrics, ...executor].map((w) => w.workItemId));
  const together = maxConcurrent(events, all);
  // per pair: RCA overlaps the metrics analysis, RCA overlaps the executor
  const withRca = (others: readonly WorkItem[]) => Math.max(0, ...rca.flatMap((r) => others.map((o) => maxConcurrent(events, new Set([r.workItemId, o.workItemId])))));
  return fromChecks('rcaMetricsExecutorParallel', [
    { name: 'RCA (reactor), the metrics analysis and the executor completed', ok: rca.length >= 1 && metrics.length >= 1 && executor.length >= 1, detail: `rca ${rca.length}, metrics ${metrics.length}, executor ${executor.length}` },
    { name: 'RCA ran in parallel with the metrics analysis', ok: withRca(metrics) >= 2, detail: `max ${withRca(metrics)} concurrently` },
    { name: 'RCA ran in parallel with the executor', ok: withRca(executor) >= 2, detail: `max ${withRca(executor)} concurrently` },
    { name: 'all three ran at the same time', ok: together >= 3, detail: `max ${together} concurrently` },
  ]);
};

/** The PoC graders by id (merged into GRADERS). */
export const POC_GRADERS: Readonly<Record<string, Grader>> = Object.freeze({
  pocAWorkflow: pocAWorkflowGrader,
  pocBWorkflow: pocBWorkflowGrader,
  pocCWorkflow: pocCWorkflowGrader,
  causalChain: causalChainGrader,
  singleLeaseOwner: singleLeaseOwnerGrader,
  noOrphanOperations: noOrphanOperationsGrader,
  loadJobReattached: loadJobReattachedGrader,
  offloadBounded: offloadBoundedGrader,
  modelFallback: modelFallbackGrader,
  contextIsolation: contextIsolationGrader,
  independentReview: independentReviewGrader,
  reportTracesToEvidence: reportTracesToEvidenceGrader,
  testChangeGoverned: testChangeGovernedGrader,
  recoveryAudit: recoveryAuditGrader,
  insufficientDataNotPassed: insufficientDataNotPassedGrader,
  anomalyReaction: anomalyReactionGrader,
  rcaMetricsExecutorParallel: rcaMetricsExecutorParallelGrader,
});

export type { Finding };
