import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { collabMigrations, createBlackboard, createEventStore, type Blackboard, type EventStore } from '@hypertest/collab';
import { DEFAULT_WORK_BUDGET, workItemFingerprint, type DomainEvent, type EventContext, type EvidenceInput, type EvidenceRecord, type ReportClaim } from '@hypertest/domain';
import { MemoryArtifactStore, createEvidenceLedger, evidenceMigrations, type EvidenceLedger } from '@hypertest/evidence';
import { eventCtx } from '@hypertest/testkit';
import { createProvenanceService, nodeKey, type ProvenanceService, type ProvenanceTrace } from '../src/index.ts';
import { openDb, type Db } from './helpers.ts';

let env: Db;
let events: EventStore;
let board: Blackboard;
let ledger: EvidenceLedger;
let artifacts: MemoryArtifactStore;
let prov: ProvenanceService;

before(async () => {
  env = await openDb([...collabMigrations, ...evidenceMigrations]);
  events = createEventStore(env.deps);
  board = createBlackboard({ ...env.deps, events });
  artifacts = new MemoryArtifactStore();
  ledger = createEvidenceLedger({ ...env.deps, artifacts, events });
  // The ports are implemented structurally by the real stores.
  prov = createProvenanceService({ evidence: ledger, events, records: board });
});
after(async () => {
  await env.dispose();
});

async function workItem(runId: string, ctx: EventContext, objective: string): Promise<string> {
  const { workItem } = await board.createWorkItem({
    runId, kind: 'reaction', origin: { kind: 'system', reason: 'test' }, title: objective, objective, role: 'executor', objectiveIds: [],
    capabilityRequirements: [], inputRefs: [], evidenceRequirements: [], dependsOn: [], budget: DEFAULT_WORK_BUDGET, priority: 1, depth: 0,
    fingerprint: workItemFingerprint({ runId, role: 'executor', objective, originKey: 'test' }), resourceClaims: [],
  }, ctx);
  return workItem.workItemId;
}

async function toolRun(runId: string, ctx: EventContext, invocationId: string, workItemId: string, operationId?: string): Promise<DomainEvent<unknown>[]> {
  const base = { aggregateType: 'tool' as const, aggregateId: invocationId, runId, correlationId: ctx.correlationId, actorId: 'agent-exec', agentId: 'agent-exec', workItemId };
  const [called] = await events.append([{ ...base, eventType: 'tool.called', payload: { invocationId, toolId: 'env.restart' } }]);
  const [completed] = await events.append([{ ...base, eventType: 'tool.completed', causationId: called!.eventId, payload: { invocationId, toolId: 'env.restart', status: 'success', ...(operationId ? { operationId } : {}) } }]);
  return [called!, completed!];
}

async function operation(runId: string, ctx: EventContext, operationId: string, invocationId: string, workItemId: string): Promise<void> {
  const base = { aggregateType: 'operation' as const, aggregateId: operationId, runId, correlationId: ctx.correlationId, actorId: 'system:gateway', workItemId };
  await events.append([
    { ...base, eventType: 'operation.prepared', payload: { operationId, from: null, to: 'prepared', toolInvocationId: invocationId } },
    { ...base, eventType: 'operation.dispatched', payload: { operationId, from: 'prepared', to: 'dispatching', toolInvocationId: invocationId } },
    { ...base, eventType: 'operation.verified', payload: { operationId, from: 'acknowledged', to: 'verified', toolInvocationId: invocationId } },
  ]);
}

async function evidence(runId: string, extra: Partial<EvidenceInput>): Promise<EvidenceRecord> {
  const artifact = await artifacts.put(`output ${Math.random()}`, { mimeType: 'text/plain' });
  return ledger.append({
    runId,
    evidenceType: 'tool-output',
    artifact,
    summary: 'restart acknowledged',
    producer: { workerId: 'worker-1', runtimeManifestId: 'rm_1', agentId: 'agent-exec' },
    provenance: { toolId: 'env.restart', commit: 'abc123' },
    ...extra,
  });
}

const edges = (t: ProvenanceTrace) => t.edges.map((e) => `${e.from} -${e.relation}-> ${e.to}`).sort();
const keys = (t: ProvenanceTrace) => t.nodes.map((n) => nodeKey(n.ref));

test('traceEvidence: evidence → tool events → operation events → work item → agent → environment → commit', async () => {
  const runId = 'run_prov_chain';
  const ctx = eventCtx(runId);
  const wi = await workItem(runId, ctx, 'restart checkout');
  await toolRun(runId, ctx, 'inv_1', wi, 'op_1');
  await operation(runId, ctx, 'op_1', 'inv_1', wi);
  const ev = await evidence(runId, {
    workItemId: wi, agentId: 'agent-exec', toolInvocationId: 'inv_1', operationId: 'op_1',
    environment: { environmentId: 'env-1', environmentClass: 'k8s', generation: 3, buildDigest: 'sha256:b1' },
  });

  const t = await prov.traceEvidence(ev.evidenceId);
  assert.deepEqual(t.gaps, []);
  assert.equal(t.complete, true);
  assert.deepEqual(t.root, { kind: 'evidence', id: ev.evidenceId });
  assert.deepEqual(keys(t), [`evidence:${ev.evidenceId}`, 'tool_invocation:inv_1', 'operation:op_1', `work_item:${wi}`, 'agent:agent-exec', 'environment:env-1', 'commit:abc123']);
  assert.deepEqual(edges(t), [
    `evidence:${ev.evidenceId} -commit-> commit:abc123`,
    `evidence:${ev.evidenceId} -executed_in-> environment:env-1`,
    `evidence:${ev.evidenceId} -executed_in-> work_item:${wi}`,
    `evidence:${ev.evidenceId} -produced_by-> tool_invocation:inv_1`,
    'tool_invocation:inv_1 -operation-> operation:op_1',
    'tool_invocation:inv_1 -produced_by-> agent:agent-exec',
  ].sort());
  const tool = t.nodes.find((n) => n.ref.kind === 'tool_invocation')!;
  assert.equal(tool.detail!['toolId'], 'env.restart');
  assert.equal(tool.detail!['status'], 'success');
  assert.deepEqual((tool.detail!['events'] as Array<{ eventType: string }>).map((e) => e.eventType), ['tool.called', 'tool.completed']);
  const op = t.nodes.find((n) => n.ref.kind === 'operation')!;
  assert.equal(op.detail!['status'], 'verified');
  assert.deepEqual((op.detail!['events'] as Array<{ eventType: string }>).map((e) => e.eventType), ['operation.prepared', 'operation.dispatched', 'operation.verified']);
  const w = t.nodes.find((n) => n.ref.kind === 'work_item')!;
  assert.deepEqual((w.detail!['events'] as Array<{ eventType: string }>).map((e) => e.eventType), ['work.created', 'work.ready']);
  assert.deepEqual(t.nodes.find((n) => n.ref.kind === 'environment')!.detail, { environmentClass: 'k8s', generation: 3, buildDigest: 'sha256:b1' });
  // The operation id may also come from the tool.completed payload.
  const ev2 = await evidence(runId, { workItemId: wi, toolInvocationId: 'inv_1', environment: { environmentId: 'env-1', environmentClass: 'k8s', generation: 3 } });
  const t2 = await prov.traceEvidence(ev2.evidenceId);
  assert.equal(t2.complete, true);
  assert.ok(keys(t2).includes('operation:op_1'));
});

test('missing links make a trace incomplete with a precise gap each', async () => {
  const runId = 'run_prov_gaps';
  const ctx = eventCtx(runId);
  // Tool invocation without any L0 tool events, operation without events, no work item, no agent, no env/commit.
  const ev = await evidence(runId, { toolInvocationId: 'inv_ghost', operationId: 'op_ghost', producer: { workerId: 'w', runtimeManifestId: 'rm_1' }, provenance: {} });
  const t = await prov.traceEvidence(ev.evidenceId);
  assert.equal(t.complete, false);
  assert.deepEqual(t.gaps, [
    `tool invocation inv_ghost has no tool.called/tool.completed events in run ${runId}`,
    `operation op_ghost has no operation.* events in run ${runId}`,
    `evidence ${ev.evidenceId} is not bound to a work item`,
    `evidence ${ev.evidenceId} records no producing agent`,
    `evidence ${ev.evidenceId} records neither an environment nor a commit`,
  ]);
  // Inconsistent bindings are gaps too.
  const wiA = await workItem(runId, ctx, 'a');
  const wiB = await workItem(runId, ctx, 'b');
  await toolRun(runId, ctx, 'inv_a', wiA);
  const mixed = await evidence(runId, { workItemId: wiB, toolInvocationId: 'inv_a' });
  const tm = await prov.traceEvidence(mixed.evidenceId);
  assert.equal(tm.complete, false);
  assert.deepEqual(tm.gaps, [`tool invocation inv_a ran in work item ${wiA}, but evidence ${mixed.evidenceId} names ${wiB}`]);
  // Unknown evidence.
  const tu = await prov.traceEvidence('ev_unknown');
  assert.equal(tu.complete, false);
  assert.deepEqual(tu.gaps, ['evidence ev_unknown not found in the evidence ledger']);
});

test('traceRecord: cited evidence traced + causation chain; a missing link makes it incomplete', async () => {
  const runId = 'run_prov_record';
  const ctx = eventCtx(runId);
  const wi = await workItem(runId, ctx, 'find checkout defect');
  const [called, completed] = await toolRun(runId, ctx, 'inv_r', wi, 'op_r');
  await operation(runId, ctx, 'op_r', 'inv_r', wi);
  const good = await evidence(runId, { workItemId: wi, toolInvocationId: 'inv_r', operationId: 'op_r' });
  const orphan = await evidence(runId, { workItemId: wi, toolInvocationId: 'inv_lost' }); // tool events never recorded

  const rec = await board.postRecord(
    { runId, recordType: 'finding', createdBy: 'agent-exec', workItemId: wi, evidenceRefs: [good.evidenceId],
      payload: { title: 'checkout 500 on empty cart', description: 'd', severity: 'P1', category: 'product_defect', status: 'open', fingerprint: 'fp1' } },
    { ...ctx, causationId: completed!.eventId },
  );
  const t = await prov.traceRecord(rec.recordId);
  assert.deepEqual(t.gaps, []);
  assert.equal(t.complete, true);
  assert.equal(t.nodes[0]!.label, 'finding v1: checkout 500 on empty cart');
  const creation = (await events.read(runId, { types: ['finding.created'] }))[0]!;
  assert.ok(edges(t).includes(`record:${rec.recordId} -cites-> evidence:${good.evidenceId}`));
  assert.ok(edges(t).includes(`record:${rec.recordId} -caused_by-> event:${creation.eventId}`));
  assert.ok(edges(t).includes(`event:${creation.eventId} -caused_by-> event:${completed!.eventId}`));
  assert.ok(edges(t).includes(`event:${completed!.eventId} -caused_by-> event:${called!.eventId}`));
  assert.ok(keys(t).includes('operation:op_r'));

  // Same record lineage, but the new version also cites evidence whose tool run is not in L0.
  const v2 = await board.postRecord(
    { runId, recordType: 'finding', createdBy: 'agent-rca', workItemId: wi, supersedes: rec.recordId, evidenceRefs: [good.evidenceId, orphan.evidenceId, 'ev_missing'],
      payload: { title: 'checkout 500 on empty cart', description: 'd', severity: 'P1', category: 'product_defect', status: 'confirmed', fingerprint: 'fp1' } },
    ctx,
  );
  const t2 = await prov.traceRecord(v2.recordId);
  assert.equal(t2.complete, false);
  assert.deepEqual(t2.gaps, [
    `tool invocation inv_lost has no tool.called/tool.completed events in run ${runId}`,
    'evidence ev_missing not found in the evidence ledger',
  ]);
  assert.ok(keys(t2).includes(`event:${(await events.read(runId, { types: ['finding.updated'] }))[0]!.eventId}`));

  // A record citing nothing is not traceable to evidence.
  const note = await board.postRecord({ runId, recordType: 'note', createdBy: 'agent-exec', payload: { text: 'hunch' } }, ctx);
  const t3 = await prov.traceRecord(note.recordId);
  assert.deepEqual(t3.gaps, [`record ${note.recordId} cites no evidence`]);
  const t4 = await prov.traceRecord('rec_nope');
  assert.deepEqual(t4.gaps, ['record rec_nope not found on the blackboard']);
});

test('traceClaim is complete only if every cited evidence traces completely; parents are followed', async () => {
  const runId = 'run_prov_claim';
  const ctx = eventCtx(runId);
  const wi = await workItem(runId, ctx, 'measure latency');
  await toolRun(runId, ctx, 'inv_m', wi);
  const parent = await evidence(runId, { workItemId: wi, toolInvocationId: 'inv_m', evidenceType: 'metric' });
  const child = await evidence(runId, { workItemId: wi, toolInvocationId: 'inv_m', parentEvidenceIds: [parent.evidenceId], evidenceType: 'report' });
  const claim = (refs: string[]): ReportClaim => ({ claimId: 'cl_1', statement: 'p95 latency is 120ms', value: 120, evidenceQuery: { evidenceType: 'metric' }, evidenceRefs: refs, critical: true });

  const ok = await prov.traceClaim(claim([child.evidenceId]));
  assert.equal(ok.complete, true);
  assert.deepEqual(ok.root, { kind: 'claim', id: 'cl_1' });
  assert.ok(edges(ok).includes(`claim:cl_1 -cites-> evidence:${child.evidenceId}`));
  assert.ok(edges(ok).includes(`evidence:${child.evidenceId} -derived_from-> evidence:${parent.evidenceId}`));
  assert.equal(ok.nodes[0]!.detail!['value'], 120);

  const partial = await prov.traceClaim(claim([child.evidenceId, 'ev_gone']));
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.gaps, ['evidence ev_gone not found in the evidence ledger']);
  const none = await prov.traceClaim(claim([]));
  assert.deepEqual(none.gaps, ['claim cl_1 cites no evidence']);
});

test('inconsistent links are gaps: invocation ids, tool ids, agents, operation work items, cross-run citations', async () => {
  const runId = 'run_prov_inconsistent';
  const ctx = eventCtx(runId);
  const wiA = await workItem(runId, ctx, 'inconsistent a');
  const wiB = await workItem(runId, ctx, 'inconsistent b');
  const envRef = { environmentId: 'env-1', environmentClass: 'k8s', generation: 1 };
  await toolRun(runId, ctx, 'inv_i', wiA, 'op_i');
  await operation(runId, ctx, 'op_i', 'inv_i', wiA);
  // Baseline: consistent evidence traces completely.
  const good = await evidence(runId, { workItemId: wiA, toolInvocationId: 'inv_i', environment: envRef });
  assert.deepEqual((await prov.traceEvidence(good.evidenceId)).gaps, []);

  const conflictingInvocation = await evidence(runId, { workItemId: wiA, toolInvocationId: 'inv_i', environment: envRef, provenance: { toolId: 'env.restart', toolInvocationId: 'inv_other' } });
  assert.deepEqual((await prov.traceEvidence(conflictingInvocation.evidenceId)).gaps, [`evidence ${conflictingInvocation.evidenceId} names tool invocation inv_i but its provenance names inv_other`]);

  const wrongTool = await evidence(runId, { workItemId: wiA, toolInvocationId: 'inv_i', environment: envRef, provenance: { toolId: 'fs.write' } });
  assert.deepEqual((await prov.traceEvidence(wrongTool.evidenceId)).gaps, [`tool invocation inv_i ran tool env.restart, but evidence ${wrongTool.evidenceId} names fs.write`]);

  const wrongAgent = await evidence(runId, { workItemId: wiA, toolInvocationId: 'inv_i', environment: envRef, agentId: 'agent-impostor' });
  assert.deepEqual((await prov.traceEvidence(wrongAgent.evidenceId)).gaps, [
    `evidence ${wrongAgent.evidenceId} names agent agent-impostor but its producer is agent agent-exec`,
    `tool invocation inv_i was run by agent agent-exec, but evidence ${wrongAgent.evidenceId} names agent-impostor`,
  ]);

  // The operation ran for another work item than the evidence claims.
  await toolRun(runId, ctx, 'inv_j', wiB, 'op_j');
  await operation(runId, ctx, 'op_j', 'inv_j', wiA);
  const wrongOpItem = await evidence(runId, { workItemId: wiB, toolInvocationId: 'inv_j', environment: envRef });
  assert.deepEqual((await prov.traceEvidence(wrongOpItem.evidenceId)).gaps, [`operation op_j ran in work item ${wiA}, but evidence ${wrongOpItem.evidenceId} names ${wiB}`]);

  // A record of another run citing this run's (complete) evidence is not backed by its own run's evidence.
  const otherRun = 'run_prov_other';
  const rec = await board.postRecord(
    { runId: otherRun, recordType: 'finding', createdBy: 'agent-exec', evidenceRefs: [good.evidenceId],
      payload: { title: 'borrowed evidence', description: 'd', severity: 'P2', category: 'product_defect', status: 'open', fingerprint: 'fp-borrowed' } },
    eventCtx(otherRun),
  );
  const t = await prov.traceRecord(rec.recordId);
  assert.equal(t.complete, false);
  assert.deepEqual(t.gaps, [`record ${rec.recordId} (run ${otherRun}) cites evidence ${good.evidenceId} of run ${runId}`]);
});
