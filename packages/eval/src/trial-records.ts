/**
 * What a trial records about itself beyond pass/fail (architecture-improvements §Eval 数据模型: EvalTrial harness,
 * runtimeManifestId, modelRoutes …; §隔离与防 benchmark 污染: fixed model ID / RuntimeManifest / Oracle revision per trial):
 *
 * - `trialModelRoutes(events)`: per role, the routes its agents ran on (route id, provider, model, epochs, calls, switch
 *   reasons) — from L0 (agent.spawned, model.epoch_started, model.invoked), never from the arm's configuration;
 * - `canonicalProjection(data)` / `canonicalState(data)`: the outcome that must not depend on which model produced it
 *   (plan, blackboard, evidence, verdict — ids, timestamps and routes removed);
 * - `trialKey(parts)`: suite + suite revision + task + grader revisions + runtime manifest + oracle revisions.
 */
import { canonicalJson, sha256Hex, type JsonValue } from '@hypertest/core';
import type { DomainEvent, EvidenceRecord } from '@hypertest/domain';
import type { CanonicalProjection, CanonicalState, TrialData, TrialModelRoute } from './contracts.ts';

function payload(e: DomainEvent<unknown>): Record<string, unknown> {
  return (e.payload !== null && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * The routes of a trial per role, from L0: every model.epoch_started of an agent (route, provider, model, switch reason)
 * and every successful model.invoked on the route, attributed to the agent's role (agent.spawned). Sorted by role, route.
 */
export function trialModelRoutes(events: readonly DomainEvent<unknown>[]): TrialModelRoute[] {
  const roles = new Map<string, string>();
  for (const e of events) {
    if (e.eventType !== 'agent.spawned') continue;
    const role = str(payload(e)['role']);
    if (role) roles.set(str(payload(e)['agentId']) ?? e.aggregateId, role);
  }
  const acc = new Map<string, { r: TrialModelRoute; agents: Set<string>; reasons: Set<string> }>();
  const entry = (role: string, routeId: string, provider: string, model: string) => {
    const key = `${role}\u0000${routeId}`;
    let a = acc.get(key);
    if (!a) {
      a = { r: { role, routeId, provider, model, epochs: 0, agents: 0, calls: 0, switchReasons: [] }, agents: new Set(), reasons: new Set() };
      acc.set(key, a);
    }
    return a;
  };
  // the route each agent is on (for attributing model.invoked, which carries route but not always provider/model)
  const routeOf = new Map<string, { provider: string; model: string }>();
  for (const e of events) {
    const p = payload(e);
    const agentId = e.agentId ?? str(p['agentId']) ?? e.aggregateId;
    const role = roles.get(agentId);
    if (e.eventType === 'model.epoch_started') {
      const routeId = str(p['routeId']);
      const provider = str(p['provider']);
      const model = str(p['model']);
      if (!role || !routeId || !provider || !model) continue;
      routeOf.set(`${agentId}\u0000${routeId}`, { provider, model });
      const a = entry(role, routeId, provider, model);
      a.r.epochs++;
      a.agents.add(agentId);
      const reason = str(p['switchReason']);
      if (reason) a.reasons.add(reason);
    } else if (e.eventType === 'model.invoked' && p['ok'] === true) {
      const routeId = str(p['routeId']);
      if (!role || !routeId) continue;
      const known = routeOf.get(`${agentId}\u0000${routeId}`);
      const provider = str(p['provider']) ?? known?.provider ?? '?';
      const model = str(p['model']) ?? known?.model ?? '?';
      const a = entry(role, routeId, provider, model);
      a.r.calls++;
      a.agents.add(agentId);
    }
  }
  return [...acc.values()]
    .map(({ r, agents, reasons }) => ({ ...r, agents: agents.size, switchReasons: [...reasons].sort() }))
    .sort((a, b) => a.role.localeCompare(b.role) || a.routeId.localeCompare(b.routeId));
}

/** Ids and other run-specific tokens are replaced by `<id>` (a title may name a record or evidence id). */
export function withoutIds(text: string): string {
  return text.replace(/\b(?:rec|ev|op|wi|run|ta|ag|evt|ep|ss|snap|dec|prop|apr|exp|cap|call)_[0-9A-Za-z]+\b/g, '<id>').replace(/\b[0-9a-f]{12,64}\b/g, '<hash>');
}

function testOutcome(e: EvidenceRecord): string {
  const s = (e.structured ?? {}) as { passed?: unknown; cases?: unknown };
  const cases = Array.isArray(s.cases) ? (s.cases as Array<{ name?: unknown; status?: unknown }>) : [];
  const listed = cases.map((c) => `${String(c.name)}=${String(c.status)}`).sort();
  return `passed=${String(s.passed)} [${listed.join('; ')}]`;
}

function apiOutcome(e: EvidenceRecord): string {
  const s = (e.structured ?? {}) as Record<string, unknown>;
  const req = (s['request'] ?? {}) as Record<string, unknown>;
  const res = (s['response'] ?? {}) as Record<string, unknown>;
  const method = str(s['method']) ?? str(req['method']) ?? '?';
  const path = str(s['path']) ?? str(req['path']) ?? '?';
  const status = s['status'] ?? res['status'];
  return `${method.toUpperCase()} ${path} → ${String(status)}`;
}

function evidenceLine(e: EvidenceRecord): string {
  switch (e.evidenceType) {
    case 'test-result':
      return `test-result: ${withoutIds(testOutcome(e))}`;
    case 'api-response':
      return `api-response: ${apiOutcome(e)}`;
    case 'mutation-result': {
      const s = (e.structured ?? {}) as { killed?: unknown; total?: unknown; survived?: unknown };
      return `mutation-result: killed=${String(s.killed)} survived=${String(s.survived)}`;
    }
    default:
      return e.evidenceType;
  }
}

/**
 * The canonical outcome of a trial (what must not change when only the model route changes): the verdict and its
 * violated/unknown criteria, the accepted plans (work items as `role: title`), the work items (role/state/origin: title),
 * the current finding heads (title/severity/category/status) and the evidence outcomes (test cases, HTTP exchanges,
 * mutation scores) — all without ids, timestamps, routes or providers.
 */
export function canonicalProjection(data: Pick<TrialData, 'decision' | 'plans' | 'workItems' | 'findings' | 'evidence'>): CanonicalProjection {
  const d = data.decision;
  const plans = data.plans
    .filter((p) => p.status === 'accepted' || p.status === 'superseded')
    .sort((a, b) => a.revision - b.revision)
    .map((p) => ({
      readyForGate: p.readyForGate === true,
      workItems: (p.workItems ?? []).map((w) => withoutIds(`${w.role}: ${w.title}`)),
    }));
  const workItems = data.workItems.map((w) => withoutIds(`${w.role}/${w.state}/${w.origin.kind}: ${w.title}`)).sort();
  const records = data.findings.map((f) => withoutIds(`finding/${f.payload.severity}/${f.payload.category}/${f.payload.status}: ${f.payload.title}`)).sort();
  const evidence = data.evidence.map(evidenceLine).sort();
  return {
    verdict: d?.verdict ?? null,
    violatedCriteria: (d?.violatedCriteria ?? []).map((c) => c.criterionId).sort(),
    unknownCriteria: (d?.unknownCriteria ?? []).map((c) => c.criterionId).sort(),
    plans,
    workItems,
    records,
    evidence,
  };
}

export function canonicalState(data: Parameters<typeof canonicalProjection>[0]): CanonicalState {
  const projection = canonicalProjection(data);
  return { digest: sha256Hex(canonicalJson(projection as unknown as JsonValue)), projection };
}

/** Differences between two canonical projections (field: a vs b), for grader details. */
export function canonicalDifferences(a: CanonicalProjection, b: CanonicalProjection): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a) as Array<keyof CanonicalProjection>) {
    const x = canonicalJson(a[k] as unknown as JsonValue);
    const y = canonicalJson(b[k] as unknown as JsonValue);
    if (x === y) continue;
    if (Array.isArray(a[k]) && Array.isArray(b[k]) && k !== 'plans') {
      const xs = new Set((a[k] as string[]).map(String));
      const ys = new Set((b[k] as string[]).map(String));
      const only = (p: Set<string>, q: Set<string>) => [...p].filter((v) => !q.has(v));
      out.push(`${k}: only in trial [${only(xs, ys).slice(0, 4).join(' | ')}], only in baseline [${only(ys, xs).slice(0, 4).join(' | ')}]`);
    } else out.push(`${k}: ${x.slice(0, 200)} vs ${y.slice(0, 200)}`);
  }
  return out;
}

export interface TrialKeyParts {
  suiteId?: string;
  suiteRevision: string;
  taskId: string;
  graderRevisions: Record<string, string>;
  runtimeManifestId?: string;
  oracleRevisions?: Record<string, number>;
}

/**
 * The comparability key of a trial: `tk_` + sha256 (32 hex) of the canonical JSON of suite id, suite revision, task id,
 * grader revisions, runtime manifest id and oracle revisions. Two trials are like-for-like only with equal keys (the
 * paired comparison of two runtimes differs in the manifest id alone).
 */
export function trialKey(parts: TrialKeyParts): string {
  const body = {
    suiteId: parts.suiteId ?? null,
    suiteRevision: parts.suiteRevision,
    taskId: parts.taskId,
    graderRevisions: parts.graderRevisions,
    runtimeManifestId: parts.runtimeManifestId ?? null,
    oracleRevisions: parts.oracleRevisions ?? {},
  };
  return `tk_${sha256Hex(canonicalJson(body as unknown as JsonValue)).slice(0, 32)}`;
}
