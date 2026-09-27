/**
 * Privacy boundary of role data classifications (local_private): evidence is recorded at the producing role's
 * classification; readers below that clearance see ids, never content — through evidence.get / evidence.query,
 * blackboard.read, and the work/delegation result summaries composed into prompts.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentInstance } from '@hypertest/domain';
import { recordEvidence } from '@hypertest/evidence';
import type { ToolContext, ToolSpec } from '@hypertest/tools';
import { createDomainTools } from '../src/index.ts';
import { cleared, summaryFor } from '../src/clearance.ts';
import { createHarness } from './harness.ts';

function ctxFor(runId: string, role: string, agentId = `ag_${role}`): ToolContext {
  return { runId, role, agentId, workItemId: 'wi_x', invocationId: `inv_${role}`, eventContext: { runId, correlationId: runId, actorId: agentId } } as unknown as ToolContext;
}

function tool(specs: ToolSpec[], id: string): ToolSpec {
  const s = specs.find((t) => t.id === id);
  assert.ok(s, id);
  return s;
}

describe('role data classification is a read clearance', () => {
  test('clearance ordering and withheld summaries', () => {
    assert.equal(cleared('internal', 'restricted'), false);
    assert.equal(cleared('restricted', 'internal'), true);
    assert.equal(cleared('internal', undefined), true);
    const h = { roles: { get: (r: string) => ({ dataClassification: r === 'local_private' ? 'restricted' : 'internal' }) } } as never;
    assert.match(summaryFor((h as { roles: never }).roles, 'lead', 'local_private', 'the secret is 42'), /^\[withheld: restricted data/);
    assert.equal(summaryFor((h as { roles: never }).roles, 'local_private', 'executor', 'public summary'), 'public summary');
  });

  test('evidence.get refuses and evidence.query withholds content classified above the reader; the owner role reads it', async () => {
    const h = await createHarness();
    try {
      const run = await h.control.startRun({ goal: 'privacy', target: {} });
      const producer = { workerId: 'w', runtimeManifestId: 'rm_x' };
      const restricted = await recordEvidence(h.deps.evidence, h.deps.artifacts, { runId: run.runId, evidenceType: 'stdout', data: 'customer IBAN DE00 1234', mimeType: 'text/plain', summary: 'private output', producer, provenance: {}, classification: 'restricted' });
      const normal = await recordEvidence(h.deps.evidence, h.deps.artifacts, { runId: run.runId, evidenceType: 'stdout', data: 'ok', mimeType: 'text/plain', summary: 'normal output', producer, provenance: {} });
      const specs = createDomainTools(h.deps);
      const get = tool(specs, 'evidence.get');
      const denied = await get.execute({ evidenceId: restricted.evidenceId }, ctxFor(run.runId, 'executor'));
      assert.equal(denied.status, 'failed');
      assert.match(JSON.stringify(denied), /classified restricted, above this agent's clearance \(internal\)/);
      assert.doesNotMatch(JSON.stringify(denied), /IBAN/);
      const allowed = await get.execute({ evidenceId: restricted.evidenceId }, ctxFor(run.runId, 'local_private'));
      assert.equal(allowed.status, 'success');
      assert.match(JSON.stringify(allowed.structured), /IBAN/);
      const query = tool(specs, 'evidence.query');
      const q = (await query.execute({}, ctxFor(run.runId, 'executor'))).structured as { evidence: Array<{ evidenceId: string }>; withheld?: { count: number } };
      assert.deepEqual(q.evidence.map((e) => e.evidenceId), [normal.evidenceId]);
      assert.equal(q.withheld?.count, 1);
      const q2 = (await query.execute({}, ctxFor(run.runId, 'local_private'))).structured as { evidence: unknown[]; withheld?: unknown };
      assert.equal(q2.evidence.length, 2);
      assert.equal(q2.withheld, undefined);
    } finally {
      await h.dispose();
    }
  });

  test('blackboard.read withholds the payload of records written by a higher-classified role', async () => {
    const h = await createHarness();
    try {
      const run = await h.control.startRun({ goal: 'privacy', target: {} });
      const now = h.clock.isoNow();
      const agent: AgentInstance = { agentId: 'ag_private1', runId: run.runId, role: 'local_private', workItemId: 'wi_p', depth: 1, engineKind: 'native', sessionId: 'ses_p', status: 'active', capabilityId: 'cap_p', continuable: false, background: false, createdAt: now, updatedAt: now };
      await h.deps.agents.create(agent);
      const rec = await h.deps.blackboard.postRecord({ runId: run.runId, recordType: 'note', payload: { text: 'restricted: account 4711 balance' }, createdBy: agent.agentId }, h.ctx(run.runId));
      const read = tool(createDomainTools(h.deps), 'blackboard.read');
      const low = JSON.stringify((await read.execute({ recordId: rec.recordId }, ctxFor(run.runId, 'lead'))).structured);
      assert.doesNotMatch(low, /4711/);
      assert.match(low, /withheld: restricted data/);
      assert.match(low, new RegExp(rec.recordId), 'the id stays visible');
      const all = JSON.stringify((await read.execute({}, ctxFor(run.runId, 'reviewer'))).structured);
      assert.doesNotMatch(all, /4711/);
      const own = JSON.stringify((await read.execute({ recordId: rec.recordId }, ctxFor(run.runId, 'local_private'))).structured);
      assert.match(own, /4711/);
    } finally {
      await h.dispose();
    }
  });
});
