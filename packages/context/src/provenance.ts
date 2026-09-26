import { EVENT_TYPES, type DomainEvent, type EvidenceRecord, type ReportClaim } from '@hypertest/domain';
import type { ProvenanceDeps, ProvenanceNode, ProvenanceRef, ProvenanceService, ProvenanceTrace } from './contracts.ts';
import { isRecord } from './util.ts';

type Relation = ProvenanceTrace['edges'][number]['relation'];

export const TOOL_EVENT_TYPES: readonly string[] = [EVENT_TYPES.toolCalled, EVENT_TYPES.toolCompleted, EVENT_TYPES.toolDenied];
/** Catalog operation events plus every `operation.<status>` the operation ledger emits. */
export const OPERATION_EVENT_TYPES: readonly string[] = [
  ...new Set([
    ...Object.values(EVENT_TYPES).filter((t) => t.startsWith('operation.')),
    ...['prepared', 'dispatched', 'acknowledged', 'verified', 'not_applied', 'outcome_unknown', 'reconciling', 'reconciled', 'compensating', 'compensated', 'manual_review', 'failed', 'late_receipt'].map((s) => `operation.${s}`),
  ]),
];
export const WORK_EVENT_TYPES: readonly string[] = [...new Set([...Object.values(EVENT_TYPES).filter((t) => t.startsWith('work.')), 'work.blocked', 'work.updated'])];
export const RECORD_EVENT_TYPES: readonly string[] = [
  'finding.created', 'finding.updated', 'finding.confirmed', 'finding.rejected',
  'hypothesis.created', 'hypothesis.supported', 'hypothesis.refuted',
  'coverage.gap_detected', 'risk.identified', 'review.completed', 'record.posted',
];

/** Node key used by edges: `${kind}:${id}`. */
export function nodeKey(ref: ProvenanceRef): string {
  return `${ref.kind}:${ref.id}`;
}

function payloadOf(e: DomainEvent<unknown>): Record<string, unknown> {
  return isRecord(e.payload) ? e.payload : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function eventSummary(e: DomainEvent<unknown>): Record<string, unknown> {
  const s: Record<string, unknown> = { eventId: e.eventId, eventType: e.eventType, occurredAt: e.occurredAt };
  if (e.seq !== undefined) s['seq'] = e.seq;
  return s;
}

class TraceBuilder {
  readonly nodes = new Map<string, ProvenanceNode>();
  readonly edges = new Map<string, ProvenanceTrace['edges'][number]>();
  readonly gaps: string[] = [];

  node(ref: ProvenanceRef, label: string, detail?: Record<string, unknown>): string {
    const key = nodeKey(ref);
    if (!this.nodes.has(key)) {
      const n: ProvenanceNode = { ref, label };
      if (detail !== undefined) n.detail = detail;
      this.nodes.set(key, n);
    }
    return key;
  }

  edge(from: string, to: string, relation: Relation): void {
    const k = `${from}\u0000${to}\u0000${relation}`;
    if (!this.edges.has(k)) this.edges.set(k, { from, to, relation });
  }

  gap(msg: string): void {
    if (!this.gaps.includes(msg)) this.gaps.push(msg);
  }

  build(root: ProvenanceRef): ProvenanceTrace {
    return { root, nodes: [...this.nodes.values()], edges: [...this.edges.values()], complete: this.gaps.length === 0, gaps: [...this.gaps] };
  }
}

/**
 * L5 provenance: answers "where does this conclusion come from?" from canonical stores only (evidence ledger,
 * L0 events, blackboard). Evidence traces follow evidence → tool invocation (tool.* events matched by
 * payload.invocationId) → operation (+ operation.* events) → work item (+ work.* events) → agent →
 * environment → commit, and parent evidence (derived_from). Every missing or inconsistent link is a gap and
 * makes the trace incomplete; required links: tool events for the invocation, a work item, a producing agent,
 * an environment or commit, and operation events whenever an operation is referenced. Inconsistent links are
 * gaps as well: conflicting invocation ids, tool ids, agents or work items between the evidence, its tool events
 * and its operation events, and a record citing evidence of another run.
 */
export function createProvenanceService(deps: ProvenanceDeps & { maxDepth?: number }): ProvenanceService {
  const maxDepth = deps.maxDepth ?? 16;

  function session() {
    const cache = new Map<string, Promise<DomainEvent<unknown>[]>>();
    const runEvents = (runId: string, types: readonly string[]): Promise<DomainEvent<unknown>[]> => {
      const key = `${runId}\u0000${types.join(',')}`;
      let p = cache.get(key);
      if (!p) {
        p = deps.events.read(runId, { types: [...types] });
        cache.set(key, p);
      }
      return p;
    };
    const visited = new Set<string>();

    async function traceEvidenceInto(b: TraceBuilder, evidenceId: string, depth: number): Promise<string> {
      const ref: ProvenanceRef = { kind: 'evidence', id: evidenceId };
      const evKey = nodeKey(ref);
      if (visited.has(evidenceId)) return evKey;
      visited.add(evidenceId);
      const ev: EvidenceRecord | undefined = await deps.evidence.get(evidenceId);
      if (!ev) {
        b.node(ref, `evidence ${evidenceId} (not found)`);
        b.gap(`evidence ${evidenceId} not found in the evidence ledger`);
        return evKey;
      }
      b.node(ref, `${ev.evidenceType}: ${ev.summary}`, {
        runId: ev.runId,
        seq: ev.seq,
        recordHash: ev.recordHash,
        artifactSha256: ev.artifact.sha256,
        capturedAt: ev.capturedAt,
      });

      // tool invocation → tool.* events
      const invocationId = ev.toolInvocationId ?? ev.provenance.toolInvocationId;
      if (ev.toolInvocationId && ev.provenance.toolInvocationId && ev.toolInvocationId !== ev.provenance.toolInvocationId) {
        b.gap(`evidence ${evidenceId} names tool invocation ${ev.toolInvocationId} but its provenance names ${ev.provenance.toolInvocationId}`);
      }
      let toolKey: string | undefined;
      let toolEvents: DomainEvent<unknown>[] = [];
      if (invocationId) {
        toolEvents = (await runEvents(ev.runId, TOOL_EVENT_TYPES)).filter((e) => payloadOf(e)['invocationId'] === invocationId);
        const toolId = ev.provenance.toolId ?? toolEvents.map((e) => str(payloadOf(e)['toolId'])).find(Boolean);
        const completed = toolEvents.filter((e) => e.eventType === EVENT_TYPES.toolCompleted).at(-1);
        const detail: Record<string, unknown> = { events: toolEvents.map(eventSummary) };
        if (toolId) detail['toolId'] = toolId;
        const status = completed ? str(payloadOf(completed)['status']) : undefined;
        if (status) detail['status'] = status;
        toolKey = b.node({ kind: 'tool_invocation', id: invocationId }, `tool ${toolId ?? '?'} (${invocationId})`, detail);
        b.edge(evKey, toolKey, 'produced_by');
        if (toolEvents.length === 0) b.gap(`tool invocation ${invocationId} has no tool.called/tool.completed events in run ${ev.runId}`);
        const eventToolIds = [...new Set(toolEvents.map((e) => str(payloadOf(e)['toolId'])).filter((x): x is string => x !== undefined))];
        const mismatched = eventToolIds.filter((t) => t !== toolId);
        if (toolId && mismatched.length > 0) b.gap(`tool invocation ${invocationId} ran tool ${mismatched.join(', ')}, but evidence ${evidenceId} names ${toolId}`);
      } else {
        b.gap(`evidence ${evidenceId} records no tool invocation id`);
      }

      // operation → operation.* events
      const opId = ev.operationId ?? toolEvents.map((e) => str(payloadOf(e)['operationId'])).find(Boolean);
      if (opId) {
        const opEvents = (await runEvents(ev.runId, OPERATION_EVENT_TYPES)).filter((e) => e.aggregateId === opId || payloadOf(e)['operationId'] === opId);
        const last = opEvents.at(-1);
        const detail: Record<string, unknown> = { events: opEvents.map(eventSummary) };
        const status = last ? str(payloadOf(last)['to']) : undefined;
        if (status) detail['status'] = status;
        const opKey = b.node({ kind: 'operation', id: opId }, `operation ${opId}`, detail);
        b.edge(toolKey ?? evKey, opKey, 'operation');
        if (opEvents.length === 0) b.gap(`operation ${opId} has no operation.* events in run ${ev.runId}`);
        const opInvocation = opEvents.map((e) => str(payloadOf(e)['toolInvocationId'])).find(Boolean);
        if (invocationId && opInvocation && opInvocation !== invocationId) {
          b.gap(`operation ${opId} belongs to tool invocation ${opInvocation}, but evidence ${evidenceId} names ${invocationId}`);
        }
        const evWorkItem = ev.workItemId ?? toolEvents.map((e) => e.workItemId).find(Boolean);
        const opWorkItem = opEvents.map((e) => e.workItemId).find(Boolean);
        if (evWorkItem && opWorkItem && opWorkItem !== evWorkItem) b.gap(`operation ${opId} ran in work item ${opWorkItem}, but evidence ${evidenceId} names ${evWorkItem}`);
      }

      // work item → work.* events
      const workItemId = ev.workItemId ?? toolEvents.map((e) => e.workItemId).find(Boolean);
      if (workItemId) {
        const workEvents = (await runEvents(ev.runId, WORK_EVENT_TYPES)).filter((e) => e.aggregateId === workItemId);
        const wiKey = b.node({ kind: 'work_item', id: workItemId }, `work item ${workItemId}`, { events: workEvents.map(eventSummary) });
        b.edge(evKey, wiKey, 'executed_in');
        if (workEvents.length === 0) b.gap(`work item ${workItemId} has no work.* events in run ${ev.runId}`);
        const toolWorkItem = toolEvents.map((e) => e.workItemId).find(Boolean);
        if (toolWorkItem && toolWorkItem !== workItemId) b.gap(`tool invocation ${invocationId} ran in work item ${toolWorkItem}, but evidence ${evidenceId} names ${workItemId}`);
      } else {
        b.gap(`evidence ${evidenceId} is not bound to a work item`);
      }

      // producing agent
      const agentId = ev.agentId ?? ev.producer.agentId ?? toolEvents.map((e) => e.agentId).find(Boolean);
      if (ev.agentId && ev.producer.agentId && ev.agentId !== ev.producer.agentId) {
        b.gap(`evidence ${evidenceId} names agent ${ev.agentId} but its producer is agent ${ev.producer.agentId}`);
      }
      const toolAgent = toolEvents.map((e) => e.agentId).find(Boolean);
      if (agentId && toolAgent && toolAgent !== agentId) b.gap(`tool invocation ${invocationId} was run by agent ${toolAgent}, but evidence ${evidenceId} names ${agentId}`);
      if (agentId) {
        const agentKey = b.node({ kind: 'agent', id: agentId }, `agent ${agentId}`, { workerId: ev.producer.workerId, runtimeManifestId: ev.producer.runtimeManifestId });
        b.edge(toolKey ?? evKey, agentKey, 'produced_by');
      } else {
        b.gap(`evidence ${evidenceId} records no producing agent`);
      }

      // environment and commit
      let envKey: string | undefined;
      if (ev.environment) {
        const env = ev.environment;
        const detail: Record<string, unknown> = { environmentClass: env.environmentClass, generation: env.generation };
        if (env.buildDigest !== undefined) detail['buildDigest'] = env.buildDigest;
        envKey = b.node({ kind: 'environment', id: env.environmentId }, `${env.environmentClass} ${env.environmentId} gen ${env.generation}`, detail);
        b.edge(evKey, envKey, 'executed_in');
      }
      const commit = ev.provenance.commit;
      if (commit) {
        const commitKey = b.node({ kind: 'commit', id: commit }, `commit ${commit}`);
        b.edge(evKey, commitKey, 'commit');
      }
      if (!ev.environment && !commit) b.gap(`evidence ${evidenceId} records neither an environment nor a commit`);

      // parent evidence
      for (const parent of ev.parentEvidenceIds ?? []) {
        if (depth >= maxDepth) {
          b.gap(`evidence lineage deeper than ${maxDepth} levels at ${evidenceId}`);
          break;
        }
        const pKey = await traceEvidenceInto(b, parent, depth + 1);
        b.edge(evKey, pKey, 'derived_from');
      }
      return evKey;
    }

    async function causationChain(b: TraceBuilder, start: DomainEvent<unknown>, startKey: string): Promise<void> {
      let cur = start;
      let curKey = startKey;
      const seen = new Set<string>([start.eventId]);
      for (let i = 0; i < 64 && cur.causationId; i++) {
        if (seen.has(cur.causationId)) break;
        seen.add(cur.causationId);
        const parent = await deps.events.get(cur.causationId);
        if (!parent) break; // a causation id that is not an L0 event (e.g. an external trigger) ends the chain
        const pKey = b.node({ kind: 'event', id: parent.eventId }, parent.eventType, { ...eventSummary(parent), aggregateType: parent.aggregateType, aggregateId: parent.aggregateId, actorId: parent.actorId });
        b.edge(curKey, pKey, 'caused_by');
        cur = parent;
        curKey = pKey;
      }
    }

    return { traceEvidenceInto, causationChain, runEvents };
  }

  return {
    async traceEvidence(evidenceId) {
      const b = new TraceBuilder();
      const s = session();
      await s.traceEvidenceInto(b, evidenceId, 0);
      return b.build({ kind: 'evidence', id: evidenceId });
    },

    async traceRecord(recordId) {
      const b = new TraceBuilder();
      const s = session();
      const root: ProvenanceRef = { kind: 'record', id: recordId };
      const rec = await deps.records.getRecord<Record<string, unknown>>(recordId);
      if (!rec) {
        b.node(root, `record ${recordId} (not found)`);
        b.gap(`record ${recordId} not found on the blackboard`);
        return b.build(root);
      }
      const payload = isRecord(rec.payload) ? rec.payload : {};
      const title = str(payload['title']) ?? str(payload['statement']) ?? str(payload['topic']);
      const detail: Record<string, unknown> = { runId: rec.runId, lineageId: rec.lineageId, version: rec.version, revision: rec.revision, createdBy: rec.createdBy };
      if (str(payload['status'])) detail['status'] = payload['status'];
      const recKey = b.node(root, `${rec.recordType} v${rec.version}${title ? `: ${title}` : ''}`, detail);

      if (rec.workItemId) b.edge(recKey, b.node({ kind: 'work_item', id: rec.workItemId }, `work item ${rec.workItemId}`), 'executed_in');
      if (rec.evidenceRefs.length === 0) b.gap(`record ${recordId} cites no evidence`);
      for (const ref of rec.evidenceRefs) {
        const evKey = await s.traceEvidenceInto(b, ref, 0);
        b.edge(recKey, evKey, 'cites');
        // Evidence of another run is outside this run's hash chain / Merkle root, so it cannot back the record.
        const evRun = b.nodes.get(evKey)?.detail?.['runId'];
        if (typeof evRun === 'string' && evRun !== rec.runId) b.gap(`record ${recordId} (run ${rec.runId}) cites evidence ${ref} of run ${evRun}`);
      }

      const creation = (await s.runEvents(rec.runId, RECORD_EVENT_TYPES)).find((e) => e.aggregateType === 'record' && payloadOf(e)['recordId'] === recordId);
      if (!creation) {
        b.gap(`record ${recordId} has no creation event in L0`);
      } else {
        const cKey = b.node({ kind: 'event', id: creation.eventId }, creation.eventType, { ...eventSummary(creation), actorId: creation.actorId });
        b.edge(recKey, cKey, 'caused_by');
        await s.causationChain(b, creation, cKey);
      }
      return b.build(root);
    },

    async traceClaim(claim: ReportClaim) {
      const b = new TraceBuilder();
      const s = session();
      const root: ProvenanceRef = { kind: 'claim', id: claim.claimId };
      const detail: Record<string, unknown> = { critical: claim.critical, evidenceQuery: claim.evidenceQuery };
      if (claim.value !== undefined) detail['value'] = claim.value;
      const claimKey = b.node(root, claim.statement, detail);
      const refs = claim.evidenceRefs ?? [];
      if (refs.length === 0) b.gap(`claim ${claim.claimId} cites no evidence`);
      for (const ref of refs) {
        const evKey = await s.traceEvidenceInto(b, ref, 0);
        b.edge(claimKey, evKey, 'cites');
      }
      return b.build(root);
    },
  };
}
