/**
 * PoC A — L5 provenance of the defect finding (conformance: "L5 provenance: conclusion → evidence → tool run →
 * environment → commit"). PoC C proves that every critical report claim traces completely; here the seeded pagination
 * defect found by the scripted multi-LLM team is traced through the provenance service over the run's own stores:
 * finding → cited evidence → tool invocation → work item → agent → commit, with no gap. The same trial also shows the
 * ReadSet fed by what the agents observed (context engine wiring of @hypertest/app).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { HypertestServices } from '@hypertest/app';
import { tempDir } from '@hypertest/testkit';
import { pocATask, runTrial, scriptedMultiLlmArm } from '../src/index.ts';
import { assertSchemasDropped, capture, failures, payloadOf, schemaPrefix, trialOptions } from './fixtures/poc-e2e.ts';

type Trace = Awaited<ReturnType<NonNullable<HypertestServices['provenance']>['traceRecord']>>;

const PREFIX = schemaPrefix('ap');
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-poc-a-prov-')));
after(async () => {
  await root.cleanup();
  await assertSchemasDropped(PREFIX);
});

test('PoC A: the defect finding traces completely: evidence → tool → work item → agent → commit', async () => {
  const acceptance = capture(async (ctx) => {
    const d = ctx.data;
    const provenance = ctx.ht.services.provenance;
    assert.ok(provenance, 'the composition exposes the L5 provenance service');
    const finding = d.findings.find((f) => f.payload.title === 'paginate drops the last item of every page')!;
    const trace: Trace = await provenance.traceRecord(finding.recordId);
    const edge = (from: string, relation: string) => trace.edges.filter((e) => e.from === from && e.relation === relation).map((e) => e.to);
    const agentOfItem = (workItemId: string) => d.events.find((e) => e.eventType === 'agent.spawned' && payloadOf(e)['workItemId'] === workItemId)?.agentId;
    const chains = finding.evidenceRefs.map((evidenceId) => {
      const ev = d.evidence.find((e) => e.evidenceId === evidenceId)!;
      const key = `evidence:${evidenceId}`;
      const tools = edge(key, 'produced_by').filter((k) => k.startsWith('tool_invocation:'));
      const items = edge(key, 'executed_in').filter((k) => k.startsWith('work_item:'));
      const agents = tools.flatMap((t) => edge(t, 'produced_by'));
      const commits = edge(key, 'commit');
      const toolNode = trace.nodes.find((n) => `${n.ref.kind}:${n.ref.id}` === tools[0]);
      const item = d.workItems.find((w) => `work_item:${w.workItemId}` === items[0]);
      return {
        type: ev.evidenceType,
        tool: (toolNode?.detail as { toolId?: string } | undefined)?.toolId,
        invocation: tools.length === 1 && tools[0] === `tool_invocation:${ev.toolInvocationId}`,
        role: item?.role,
        agent: agents.length === 1 && agents[0] === `agent:${agentOfItem(item!.workItemId)}` && agents[0] === `agent:${ev.producer.agentId}`,
        commit: commits,
      };
    });
    const observations = await ctx.ht.services.db.query<{ tool_id: string; kind: string; n: unknown }>(
      'SELECT tool_id, kind, count(*) AS n FROM ht_context_observations WHERE run_id = $1 GROUP BY tool_id, kind ORDER BY tool_id, kind', [d.runId!],
    );
    const pinnedFiles = await ctx.ht.services.db.query<{ n: unknown }>(
      `SELECT count(*) AS n FROM ht_context_snapshots WHERE run_id = $1 AND content->'readSet' @> '[{"resourceType":"file"}]'::jsonb`, [d.runId!],
    );
    return {
      complete: trace.complete,
      gaps: trace.gaps,
      cites: edge(`record:${finding.recordId}`, 'cites').sort(),
      causedBy: edge(`record:${finding.recordId}`, 'caused_by').length,
      chains,
      commit: d.run?.target.commit,
      observed: observations.rows.map((r) => `${r.tool_id}:${r.kind}`),
      snapshotsPinningFiles: Number(pinnedFiles.rows[0]!.n),
    };
  });
  const task = pocATask();
  const trial = await runTrial({ ...task, graders: [...task.graders, 'acceptance'] }, scriptedMultiLlmArm, trialOptions(PREFIX, join(root.path, 'trial'), { graders: { acceptance: acceptance.grader } }));
  assert.deepEqual(failures(trial), [], JSON.stringify(trial.graders, null, 1));
  assert.deepEqual([trial.result, trial.verdict], ['pass', 'fail']);
  const a = acceptance.value();

  // complete: no missing or inconsistent link anywhere in the lineage
  assert.deepEqual([a.complete, a.gaps], [true, []], a.gaps.join('\n'));
  assert.equal(a.causedBy, 1, 'the finding version is tied to its creation event on L0');
  // the confirmed finding cites the executor's failing test-result and the RCA's reproduction (stdout)
  assert.deepEqual(a.chains.map((c) => c.type).sort(), ['stdout', 'test-result']);
  assert.equal(a.cites.length, a.chains.length);
  assert.ok(a.commit && /^[0-9a-f]{40}$/.test(a.commit), 'the run pins the candidate commit');
  for (const c of a.chains) {
    // evidence → tool invocation (its own, with tool.* events) → work item → agent (spawned for it, the producer) → commit
    assert.equal(c.invocation, true, JSON.stringify(c));
    assert.equal(c.agent, true, JSON.stringify(c));
    assert.deepEqual(c.commit, [`commit:${a.commit}`], JSON.stringify(c));
  }
  const byType = Object.fromEntries(a.chains.map((c) => [c.type, `${c.tool}@${c.role}`]));
  assert.deepEqual(byType, { 'test-result': 'test.run@executor', stdout: 'shell.exec@rca' });

  // the agents' observations were recorded and pinned in later turns' snapshots (tool results → read set)
  for (const o of ['blackboard.post_finding:write', 'blackboard.read:read', 'fs.write:write']) assert.ok(a.observed.includes(o), `${o} in ${a.observed.join(', ')}`);
  assert.ok(a.snapshotsPinningFiles > 0, 'a designer turn after its fs.write pins the file it wrote');
});
