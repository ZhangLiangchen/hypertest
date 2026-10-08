/**
 * (row 246: ACP Agent) An external coding agent speaking the Agent Client Protocol (the fake agent process
 * packages/tools/test/fixtures/fake-acp-agent.mjs) configured under `tools.acpAgents` in the production composition (PGlite,
 * or PostgreSQL 16 with HYPERTEST_TEST_DB=postgres). The test designer (offered `acp.coder.*` by default) asks it for a test:
 * the agent runs inside the designer's workspace sandbox, reads the module and writes the test through Hypertest into the
 * designer's isolated worktree, its request to run a terminal command is refused; the designer then runs the suite —
 * which now includes the agent's test — and the QualityGate judges the test-result evidence. The transcript and the diff
 * are evidence; the call passed capability (write_workspace) → policy permit like any workspace write.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, type HypertestConfig } from '../src/index.ts';
import { OBJECTIVE, call, evidenceIds, roleRouter, scriptedConfig, sumRepo, testStore, type RoleBrain } from './helpers.ts';

const AGENT = fileURLToPath(new URL('../../tools/test/fixtures/fake-acp-agent.mjs', import.meta.url));

const executor: RoleBrain = (v) => {
  if (v.step === 0) return call('test.run', { framework: 'node_test' });
  const ids = evidenceIds(v.toolResults[0]!.content);
  return call('complete_work', { summary: 'the suite passes', evidenceRefs: ids, output: { summary: 'suite passed', executed: [{ selector: 'test/sum.test.js', passed: true, outcome: 'passed', evidenceIds: ids }], findings: [] } });
};

const lead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) return call('system_model.record', { components: [{ componentId: 'sum', name: 'sum module', kind: 'module', paths: ['src/sum.js'] }] });
    if (v.step === 1) {
      return call('plan.propose_revision', {
        rationale: 'Strengthen the suite with an agent-written test, then run it.',
        objectives: [OBJECTIVE],
        workItems: [
          { localId: 'design', title: 'Add a test with the coding agent', objective: 'Have the coding agent add a test for adding zero, then run the suite.', role: 'test_designer', dependsOn: [], objectiveIds: ['obj-sum'] },
          { localId: 'run-suite', title: 'Run the sum suite', objective: 'Run the node:test suite on the candidate commit.', role: 'executor', dependsOn: [], objectiveIds: ['obj-sum'], evidenceRequirements: [{ evidenceType: 'test-result', minCount: 1, critical: true }] },
        ],
      });
    }
    return call('complete_work', { summary: 'Plan v1', output: { summary: 'Plan v1', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-sum', status: 'open', evidenceRefs: [] }] } });
  }
  if (v.step === 0) return call('evidence.query', { evidenceType: 'test-result' });
  const ev = evidenceIds(v.toolResults[0]?.content ?? '');
  if (v.step === 1) return call('plan.propose_revision', { rationale: 'The suite ran with the new test.', objectives: [{ ...OBJECTIVE, status: 'satisfied' }], workItems: [], readyForGate: true });
  return call('complete_work', { summary: 'ready', evidenceRefs: ev.slice(0, 1), output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-sum', status: 'satisfied', evidenceRefs: ev.slice(0, 1) }] } });
};

function designer(results: Array<{ name: string; content: string; isError: boolean }>): RoleBrain {
  return (v) => {
    const last = v.toolResults.at(-1);
    if (last) results.push(last);
    if (v.step === 0) return call('acp.coder.prompt', { prompt: 'Add a node:test case for sum(4, 0) under test/.' });
    if (v.step === 1) return call('test.run', { framework: 'node_test' });
    const ids = evidenceIds(v.toolResults[1]?.content ?? '');
    return call('complete_work', { summary: 'the agent added a test; the suite passes', evidenceRefs: ids, output: { summary: 'suite with the agent test passes', testArtifacts: [] } });
  };
}

describe('ACP agent in a real run (test designer + external coding agent)', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  before(async () => {
    dir = await tempDir('ht-app-acp-');
    repo = await sumRepo();
    db = await testStore();
  });
  after(async () => {
    await db?.dispose();
    await repo?.cleanup();
    await dir?.cleanup();
  });

  test('the agent writes a test into the designer\'s worktree through Hypertest; the suite with it passes the gate', async () => {
    const results: Array<{ name: string; content: string; isError: boolean }> = [];
    const c = scriptedConfig(dir.path, { gate: { requireIndependentReview: false }, tools: { acpAgents: [{ id: 'coder', command: process.execPath, args: [AGENT], envFrom: { FAKE_ACP_MODE: 'HT_TEST_ACP_MODE' }, timeoutMs: 60_000 }] } } as never);
    const config: HypertestConfig = db.store ? { ...c, store: db.store } : c;
    const ht = await createHypertest(config, { scriptedBrains: { sim: roleRouter({ lead, executor, test_designer: designer(results) }) }, logger: new MemoryLogger(), env: { ...process.env, HT_TEST_ACP_MODE: 'write' } });
    try {
      assert.ok(ht.services.tools.get('acp.coder.prompt'));
      assert.ok(ht.services.roles.require('test_designer').toolPolicy.allow.includes('acp.coder.*'));
      const outcome = await ht.run({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 120_000 });
      assert.deepEqual(results.filter((r) => r.isError).map((r) => r.content), []);
      const transcript = (await ht.services.evidence.query({ runId: outcome.runId, evidenceType: 'acp-transcript' }))[0];
      assert.ok(transcript, 'the ACP transcript is evidence');
      const t = transcript.structured as { stopReason: string; filesWritten: Array<{ path: string }>; permissionsRefused: Array<{ title: string }>; filesRead: string[] };
      assert.equal(t.stopReason, 'end_turn');
      assert.deepEqual(t.filesWritten.map((f) => f.path), ['test/sum.more.test.js']);
      assert.deepEqual(t.filesRead, ['src/sum.js']);
      assert.deepEqual(t.permissionsRefused.map((p) => p.title), ['npm test']);
      assert.equal((await ht.services.evidence.query({ runId: outcome.runId, evidenceType: 'git-diff' })).length >= 1, true);
      // the suite the designer ran includes the agent's test (2 original cases + 1) — a generated, unregistered test file:
      // the QualityGate never counts that evidence (test governance), it judges the executor's run of the candidate suite
      const runs = (await ht.services.evidence.query({ runId: outcome.runId, evidenceType: 'test-result' })).map((e) => (e.structured as { totals: { passed: number; total: number } }).totals);
      assert.deepEqual(runs.map((t) => [t.passed, t.total]).sort(), [[2, 2], [3, 3]]);
      assert.ok(outcome.decision?.reasons.some((r) => /test\/sum\.more\.test\.js is added since the base commit/.test(r)), JSON.stringify(outcome.decision?.reasons));
      // the call was authorized as a workspace write (policy decision on record)
      const decisions = (await ht.services.decisionLog.list(outcome.runId)).filter((d) => d.request.tool === 'acp.coder.prompt' && (d.request.phase ?? 'before_action') === 'before_action');
      assert.deepEqual(decisions.map((d) => [d.request.effect, d.permit.decision]), [['write_workspace', 'allow']]);
      assert.equal(outcome.decision?.verdict, 'pass', JSON.stringify(outcome.decision?.reasons));
    } finally {
      await ht.close();
    }
  });
});
