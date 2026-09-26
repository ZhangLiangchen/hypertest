import type { JsonValue } from '@hypertest/core';
import type { Finding, ReportClaim, Risk } from '@hypertest/domain';
import type { ProvenanceTrace } from '@hypertest/context';
import type { ReportBuilder, RunReport } from './contracts.ts';
import type { ControlDeps } from './deps.ts';
import { ControlStore } from './store.ts';
import { byString, clip, notFound } from './util.ts';

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/**
 * Builds the RunReport from canonical state only (decision store, blackboard, evidence ledger, epochs, L0): every
 * number in the report is read from a store, claims cite evidence ids, and critical claims carry their provenance
 * trace (evidence → tool run → operation → environment/commit) with its completeness.
 */
export function createReportBuilder(deps: ControlDeps): ReportBuilder {
  const { db, runs, decisions, blackboard, evidence, agents, sessions, epochs, events, provenance } = deps;
  const store = new ControlStore(db);

  return {
    async build(runId) {
      const run = await runs.get(runId);
      if (!run) throw notFound('run', runId);
      // Only the run's FINAL decision is its verdict; an interim (feedback-loop) decision is an audit record while the run
      // continues, so the report says `pending` then and names it separately.
      const decision = run.decisionId ? await decisions.get(run.decisionId) : undefined;
      const interim = decision ? undefined : await decisions.latestForRun(runId);
      const claims: ReportClaim[] = await store.claims(runId);
      const findingRecords = await blackboard.query<Finding>({ runId, recordType: 'finding' });
      const riskRecords = await blackboard.query<Risk>({ runId, recordType: 'risk' });
      const findings = findingRecords
        .map((r) => ({ recordId: r.recordId, title: r.payload.title, severity: r.payload.severity, status: r.payload.status, evidenceRefs: r.evidenceRefs }))
        .sort((a, b) => a.severity.localeCompare(b.severity) || byString(a.recordId, b.recordId));
      const risks = riskRecords.map((r) => ({ recordId: r.recordId, title: r.payload.title, level: r.payload.level, status: r.payload.status }));
      const planList = await blackboard.listPlans(runId);
      const plans = planList.map((p) => ({ revision: p.revision, status: p.status, rationale: p.rationale, workItems: p.workItems.length }));
      const items = await blackboard.listWorkItems({ runId });
      const workItems = items.map((w) => ({ workItemId: w.workItemId, role: w.role, title: w.title, state: w.state }));

      // model routes per role: every epoch of every agent, with the turns it served
      const routeTurns = new Map<string, { role: string; routeId: string; provider: string; turns: number }>();
      for (const agent of await agents.list({ runId })) {
        const session = await sessions.get(agent.sessionId);
        const eps = await epochs.list(agent.sessionId);
        eps.forEach((e, i) => {
          const next = eps[i + 1];
          const end = next ? next.startedAtTurn : (session?.turnCount ?? e.startedAtTurn) + 1;
          const turns = Math.max(0, end - e.startedAtTurn);
          const key = `${agent.role}|${e.routeId}`;
          const cur = routeTurns.get(key) ?? { role: agent.role, routeId: e.routeId, provider: e.provider, turns: 0 };
          cur.turns += turns;
          routeTurns.set(key, cur);
        });
      }
      const models = [...routeTurns.values()].sort((a, b) => byString(a.role, b.role) || byString(a.routeId, b.routeId));

      const root = await evidence.rootHash(runId);
      let sealed = false;
      if (root.count > 0) {
        const seal = await evidence.latestSeal(runId);
        if (seal && seal.rootHash === root.rootHash && seal.count === root.count) {
          const verification = await evidence.verify(runId, { checkArtifacts: false });
          sealed = verification.ok && (verification.sealsChecked ?? 0) > 0;
        }
      }

      const recoveryEvents = await events.read(runId, { types: ['work.requeued', 'operation.reconciled'] });
      const recovery = recoveryEvents.map((e) => {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        const detail =
          e.eventType === 'work.requeued'
            ? `work item ${e.aggregateId} requeued (attempt ${String(p['attempts'] ?? '?')}, from ${String(p['from'] ?? '?')})`
            : `operation ${e.aggregateId} reconciled: ${String(p['to'] ?? p['status'] ?? '')}`;
        return { at: e.occurredAt, detail };
      });

      const traces: Array<{ claimId: string; complete: boolean; gaps: string[]; nodes: number }> = [];
      for (const c of claims.filter((x) => x.critical)) {
        let trace: ProvenanceTrace | undefined;
        try {
          trace = await provenance.traceClaim(c);
        } catch (e) {
          traces.push({ claimId: c.claimId, complete: false, gaps: [(e as Error).message], nodes: 0 });
          continue;
        }
        traces.push({ claimId: c.claimId, complete: trace.complete, gaps: trace.gaps, nodes: trace.nodes.length });
      }

      const verdict = decision?.verdict ?? 'pending';
      const md: string[] = [];
      md.push(`# Hypertest report — run ${runId}`);
      md.push('');
      md.push(`- **Goal:** ${run.goal}`);
      md.push(`- **Status:** ${run.status}`);
      md.push(`- **Verdict:** ${verdict.toUpperCase()}${decision ? ` (decision ${decision.decisionId}, revision ${decision.revision}${decision.signature ? `, signed by ${decision.signature.keyId}` : ''})` : ''}`);
      if (interim) md.push(`- **Interim gate decision (not final):** ${interim.verdict} (decision ${interim.decisionId}, revision ${interim.revision})`);
      if (decision) {
        md.push(`- **Requires human review:** ${decision.requiresHumanReview ? 'yes' : 'no'}`);
        md.push('');
        md.push('## Decision reasons');
        for (const r of decision.reasons) md.push(`- ${r}`);
      }
      md.push('');
      md.push('## Findings');
      if (findings.length === 0) md.push('No findings.');
      else {
        md.push('| id | severity | status | title | evidence |');
        md.push('|---|---|---|---|---|');
        for (const f of findings) md.push(`| ${f.recordId} | ${f.severity} | ${f.status} | ${cell(f.title)} | ${f.evidenceRefs.join(', ') || '—'} |`);
      }
      md.push('');
      md.push('## Risks');
      if (risks.length === 0) md.push('No risks.');
      for (const r of risks) md.push(`- ${r.recordId} [${r.level}, ${r.status}] ${r.title}`);
      md.push('');
      md.push('## Claims');
      if (claims.length === 0) md.push('No claims.');
      for (const c of claims) {
        const t = traces.find((x) => x.claimId === c.claimId);
        md.push(`- ${c.critical ? '**critical** ' : ''}${c.statement}${c.value !== undefined ? ` = ${JSON.stringify(c.value)}` : ''} — evidence ${c.evidenceRefs.join(', ')}${t ? ` — provenance ${t.complete ? 'complete' : `INCOMPLETE (${t.gaps.slice(0, 3).join('; ')})`}` : ''}`);
      }
      md.push('');
      md.push('## Plan evolution');
      for (const p of plans) md.push(`- v${p.revision} [${p.status}] ${p.workItems} work items — ${clip(p.rationale, 300)}`);
      md.push('');
      md.push('## Work items by role');
      const byRole = new Map<string, Record<string, number>>();
      for (const w of workItems) {
        const m = byRole.get(w.role) ?? {};
        m[w.state] = (m[w.state] ?? 0) + 1;
        byRole.set(w.role, m);
      }
      for (const [role, states] of [...byRole.entries()].sort((a, b) => byString(a[0], b[0]))) {
        md.push(`- ${role}: ${Object.entries(states).map(([s, n]) => `${n} ${s}`).join(', ')}`);
      }
      md.push('');
      md.push('## Model routes per role');
      for (const m of models) md.push(`- ${m.role}: ${m.routeId} (${m.provider}), ${m.turns} turns`);
      md.push('');
      md.push('## Evidence');
      md.push(`- ${root.count} records, Merkle root ${root.rootHash}, ${sealed ? 'sealed (seal verified)' : 'not sealed'}`);
      md.push('');
      md.push('## Recovery log');
      if (recovery.length === 0) md.push('No recovery actions.');
      for (const r of recovery) md.push(`- ${r.at} ${r.detail}`);

      const report: Omit<RunReport, 'json' | 'markdown'> = {
        runId,
        goal: run.goal,
        verdict,
        claims,
        findings,
        risks,
        plans,
        workItems,
        models,
        evidence: { count: root.count, rootHash: root.rootHash, sealed },
        recovery,
      };
      if (decision) report.decision = decision;
      const json = JSON.parse(JSON.stringify({ ...report, provenance: traces })) as JsonValue;
      return { ...report, markdown: md.join('\n') + '\n', json };
    },
  };
}
