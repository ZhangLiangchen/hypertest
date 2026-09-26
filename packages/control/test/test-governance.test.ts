import assert from 'node:assert/strict';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { isHypertestError, sha256Hex } from '@hypertest/core';
import type { TestArtifact, WorkItem } from '@hypertest/domain';
import { ControlStore, unifiedDiff } from '../src/index.ts';
import { call, createHarness, items, parsed, runItem, type Harness, type RoleBrain } from './harness.ts';
import { PRICING_BUG, PRICING_OK, PRICING_TEST, pricingOracle, pricingRepo } from './fixture.ts';

const WEAKENED = PRICING_TEST.replace('assert.equal(applyDiscount(1000, 10), 900);', 'assert.ok(applyDiscount(1000, 10) > 0);');
const DELETED = PRICING_TEST.replace("\ntest('zero discount keeps the price', () => {\n  assert.equal(applyDiscount(1000, 0), 1000);\n});\n", '');
const REGRESSION = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/pricing.js';

test('regression: 25% off 2000 cents is 1500', () => {
  assert.equal(applyDiscount(2000, 25), 1500);
});
`;
const REGRESSION_EXTENDED = `${REGRESSION}
test('regression: 50% off 100 cents is 50', () => {
  assert.equal(applyDiscount(100, 50), 50);
});
`;

function leadWith(workItems: unknown[]): RoleBrain {
  return (v) => {
    if (v.step === 0) return call('plan.propose_revision', { rationale: 'test', objectives: [{ objectiveId: 'obj', description: 'regression coverage', priority: 'P1' }], workItems: workItems as never });
    return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } });
  };
}

async function runLeadThen(h: Harness, runId: string): Promise<void> {
  const t = await h.control.tick(runId);
  assert.equal(await runItem(h.control, t.dispatched[0]!.workItemId, t.dispatched[0]!.fencingToken), 'completed');
}

async function workspaceRoot(h: Harness, workItemId: string): Promise<string> {
  const agent = (await h.deps.agents.byWorkItem(workItemId))!;
  const spec = (await h.control.worker.ensureAgent((await h.deps.blackboard.getWorkItem(workItemId)) as WorkItem, (await h.deps.runs.get(agent.runId))!, 0)).spec;
  return h.deps.workspaces.get(spec.workspaceId)!.root;
}

describe('I8 test-change governance in the dispatcher (before any write executes)', () => {
  let h: Harness;
  let repo: Awaited<ReturnType<typeof pricingRepo>>;
  const results: Array<{ name: string; content: string; isError: boolean }> = [];
  before(async () => {
    repo = await pricingRepo();
    h = await createHarness({
      brains: {
        lead: leadWith([{ localId: 'd1', title: 'design', objective: 'strengthen the discount tests', role: 'test_designer', dependsOn: [], objectiveIds: ['obj'] }]),
        test_designer: (v) => {
          if (v.lastResult) results.push(v.lastResult);
          switch (v.step) {
            case 0:
              return call('fs.apply_patch', { patch: unifiedDiff('test/pricing.test.js', PRICING_TEST, WEAKENED) });
            case 1:
              return call('fs.write', { path: 'test/regression.test.js', content: REGRESSION });
            case 2:
              return call('fs.apply_patch', { patch: unifiedDiff('test/pricing.test.js', PRICING_TEST, DELETED) });
            case 3:
              return call('git.commit', { message: 'regression test for the discount', paths: ['test/regression.test.js'] });
            default:
              return call('complete_work', { summary: 'governed changes only', output: { summary: 'governed changes only', testArtifacts: [] } });
          }
        },
      },
    });
  });
  after(async () => {
    await h.dispose();
    await repo.cleanup();
  });

  test('weakening an assertion needs approval and is not applied; deleting a test is forbidden; a new test file is allowed', async () => {
    const run = await h.control.startRun({ goal: 'self-heal governance', target: { repoPath: repo.path, commit: repo.head } });
    await runLeadThen(h, run.runId);
    const t = await h.control.tick(run.runId);
    const design = t.dispatched[0]!;
    assert.equal(await runItem(h.control, design.workItemId, design.fencingToken), 'completed');
    const root = await workspaceRoot(h, design.workItemId);

    const [weaken, add, remove, commit] = results;
    assert.equal(weaken!.isError, true);
    assert.match(weaken!.content, /^\[denied\] test change requires independent approval \(approvalId appr_\w+; assertion\)/);
    assert.equal(await readFile(join(root, 'test/pricing.test.js'), 'utf8'), PRICING_TEST, 'the weakened assertion was never written');
    const approvals = await h.deps.approvals.list({ runId: run.runId, status: ['pending'] });
    assert.equal(approvals.length, 1);
    const subject = approvals[0]!.subject as { categories: string[]; paths: string[]; toolId: string; diffSha256: string };
    assert.equal(approvals[0]!.kind, 'test_change');
    assert.deepEqual(subject.categories, ['assertion']);
    assert.deepEqual(subject.paths, ['test/pricing.test.js']);
    assert.equal(subject.toolId, 'fs.apply_patch');
    assert.equal(subject.diffSha256, sha256Hex(unifiedDiff('test/pricing.test.js', PRICING_TEST, WEAKENED)));

    assert.equal(add!.isError, false);
    assert.equal(await readFile(join(root, 'test/regression.test.js'), 'utf8'), REGRESSION);

    assert.equal(remove!.isError, true);
    assert.match(remove!.content, /^\[denied\] forbidden test change \(assertion, test_deleted\): test\/pricing\.test\.js:9 test_deleted: test removed: zero discount keeps the price/);
    assert.equal(await readFile(join(root, 'test/pricing.test.js'), 'utf8'), PRICING_TEST);
    const denied = (await h.deps.events.read(run.runId, { types: ['policy.decided'] })).filter((e) => (e.payload as { reason?: string }).reason === 'test_change_forbidden');
    assert.equal(denied.length, 1);
    assert.equal(denied[0]!.workItemId, design.workItemId);
    assert.equal((denied[0]!.payload as { reason: string; decision: string }).reason, 'test_change_forbidden');
    assert.equal((denied[0]!.payload as { reason: string; decision: string }).decision, 'deny');

    assert.equal(commit!.isError, false, commit!.content);
    assert.match(commit!.content, /^committed [0-9a-f]{12} on ht\/run_\w+\/wi_\w+ \(1 files\)/);

    // governance refusals never reached the ToolRuntime: no tool.called for them, but a tool.denied each (I10)
    const agent = (await h.deps.agents.byWorkItem(design.workItemId))!;
    const refused = [(await h.deps.sessions.getTurn(agent.sessionId, 1))!, (await h.deps.sessions.getTurn(agent.sessionId, 3))!].map((tr) => tr.toolCalls[0]!.invocationId);
    const called = (await h.deps.events.read(run.runId, { types: ['tool.called'] })).map((e) => (e.payload as { invocationId: string }).invocationId);
    for (const id of refused) assert.ok(!called.includes(id), `refused ${id} must not execute`);
    const deniedEvents = (await h.deps.events.read(run.runId, { types: ['tool.denied'] })).map((e) => e.payload as { invocationId: string; errorCode: string });
    assert.deepEqual(deniedEvents.map((p) => [p.invocationId, p.errorCode]), [[refused[0], 'approval_required'], [refused[1], 'test_change_forbidden']]);

    // the requester is recorded WITH its model provider (the heterogeneity check of an agent approval, as for oracle
    // proposals): an agent on the requester's provider is refused, an independent one (other provider, other role) may
    // approve. Without the provider every agent approval failed closed (provider_unknown): independent approval impossible.
    const pending = approvals[0]!;
    assert.deepEqual(pending.requestedBy, { kind: 'agent', id: agent.agentId, role: 'test_designer', modelProvider: 'alpha' });
    const ctx = { runId: run.runId, correlationId: run.runId, actorId: 'agent:reviewer' };
    await assert.rejects(
      h.deps.approvals.decide(pending.approvalId, true, { kind: 'agent', id: 'ag_same_provider', role: 'reviewer', modelProvider: 'alpha' }, 'looks fine', ctx),
      (e: unknown) => isHypertestError(e, 'permission_denied') && /shares model provider alpha/.test((e as Error).message),
    );
    const approved = await h.deps.approvals.decide(pending.approvalId, true, { kind: 'agent', id: 'ag_independent', role: 'reviewer', modelProvider: 'gamma' }, 'independent review of the test change', ctx);
    assert.equal(approved.status, 'approved');
  });
});

describe('test artifacts: register → validate (sensitivity) → materialized into the executor worktree', () => {
  let h: Harness;
  let repo: Awaited<ReturnType<typeof pricingRepo>>;
  const designer: Array<{ name: string; content: string; isError: boolean }> = [];
  let artifactId = '';
  before(async () => {
    repo = await pricingRepo();
    h = await createHarness({
      brains: {
        lead: leadWith([
          { localId: 'd1', title: 'design', objective: 'write a regression test for the discount', role: 'test_designer', dependsOn: [], objectiveIds: ['obj'] },
          { localId: 'e1', title: 'execute', objective: 'run the regression test', role: 'executor', dependsOn: ['d1'], objectiveIds: ['obj'], evidenceRequirements: [{ evidenceType: 'test-result', minCount: 1, critical: true }] },
        ]),
        test_designer: async (v) => {
          if (v.lastResult) designer.push(v.lastResult);
          switch (v.step) {
            case 0:
              return call('fs.write', { path: 'test/regression.test.js', content: REGRESSION });
            case 1:
              return call('test_artifact.register', {
                path: './test/regression.test.js', sourceType: 'existing', runner: { framework: 'node_test', selector: 'test/regression.test.js' },
                oracleRefs: [{ oracleId: 'oracle.pricing', revision: 1, assertionIds: ['discount-10'] }],
              });
            case 2:
              artifactId = parsed(v.lastResult!.content)['artifactId'] as string;
              return call('test.run', { framework: 'node_test', selector: 'test/regression.test.js', testArtifactIds: [artifactId] });
            case 3: {
              const tr = (await h.deps.evidence.query({ runId: v.runId, workItemId: v.workItemId, evidenceType: 'test-result' }))[0]!;
              return call('test_artifact.validate', { artifactId, knownBadEvidenceId: tr.evidenceId });
            }
            case 4:
              return call('fs.write', { path: 'test/regression.test.js', content: REGRESSION_EXTENDED });
            default:
              return call('complete_work', { summary: 'regression test registered', output: { summary: 'registered', testArtifacts: [{ artifactId, path: 'test/regression.test.js', covers: ['discount-10'] }] } });
          }
        },
        executor: async (v) => {
          if (v.step === 0) {
            const id = (await h.deps.specs.listTestArtifacts(v.runId))[0]!.artifactId;
            return call('test.run', { framework: 'node_test', selector: 'test/regression.test.js', testArtifactIds: [id] });
          }
          const ids = (await h.deps.evidence.query({ runId: v.runId, workItemId: v.workItemId })).map((e) => e.evidenceId);
          return call('complete_work', { summary: 'regression fails on the candidate', evidenceRefs: ids, output: { summary: 'fails', executed: [{ selector: 'test/regression.test.js', passed: false, outcome: 'failed', evidenceIds: ids }], findings: [] } });
        },
      },
    });
    await pricingOracle(h);
  });
  after(async () => {
    await h.dispose();
    await repo.cleanup();
  });

  test('a designer registers and validates its test; a conditional change resets it to draft; the executor gets it materialized', async () => {
    const run = await h.control.startRun({ goal: 'regression test', target: { repoPath: repo.path, commit: repo.head, baseCommit: repo.base }, oracleIds: ['oracle.pricing'] });
    await runLeadThen(h, run.runId);
    const t = await h.control.tick(run.runId);
    const design = t.dispatched[0]!;
    assert.equal(await runItem(h.control, design.workItemId, design.fencingToken), 'completed');
    const [, registered, ran, validated, changed] = designer;
    assert.equal(registered!.isError, false, registered!.content);
    const reg = parsed(registered!.content);
    assert.equal(reg['sourceType'], 'generated', 'a designer never registers its own test as existing');
    assert.equal(reg['approvalState'], 'draft');
    assert.equal(reg['artifactDigest'], sha256Hex(REGRESSION));
    assert.match(ran!.content, /NOT PASSED/);
    assert.equal(validated!.isError, false, validated!.content);
    assert.equal(parsed(validated!.content)['approvalState'], 'validated');
    assert.equal(changed!.isError, false);
    const artifact = (await h.deps.specs.getTestArtifact(artifactId)) as TestArtifact;
    assert.equal(artifact.revision, 3);
    assert.equal(artifact.approvalState, 'draft', 'a conditional change invalidates the sensitivity proof');
    assert.deepEqual(artifact.validations, {});
    const history = await Promise.all([1, 2].map((r) => h.deps.specs.getTestArtifact(artifactId, r)));
    assert.deepEqual(history.map((a) => a!.approvalState), ['draft', 'validated']);
    assert.equal(history[1]!.validations.knownBad!.status, 'passed');

    const t2 = await h.control.tick(run.runId);
    const exec = t2.dispatched[0]!;
    assert.equal(await runItem(h.control, exec.workItemId, exec.fencingToken), 'completed');
    const execRoot = await workspaceRoot(h, exec.workItemId);
    assert.equal(await readFile(join(execRoot, 'test/regression.test.js'), 'utf8'), REGRESSION, 'the registered content was materialized');
    const results = await h.deps.evidence.query({ runId: run.runId, workItemId: exec.workItemId, evidenceType: 'test-result' });
    assert.equal(results.length, 1);
    const structured = results[0]!.structured as { testArtifactId: string; passed: boolean; cases: Array<{ status: string }> };
    assert.equal(structured.testArtifactId, artifactId);
    assert.equal(structured.passed, false);
    assert.ok(structured.cases.some((c) => c.status === 'failed'));
    assert.ok(h.logger.entries.some((e) => e.msg === 'materialized test artifacts into the worktree' && (e.fields['paths'] as string[]).includes('test/regression.test.js')));
    const all = await items(h, run.runId);
    assert.equal(all.find((w) => w.workItemId === exec.workItemId)!.result!.summary, 'regression fails on the candidate');
  });
});

describe('I8 bypass attempts: non-canonical paths, symlinks and commands that rewrite tests', () => {
  test('fs.write through `test/../src/…` or a test-dir symlink is classified by what it really writes: product code ⇒ forbidden, file unchanged', async () => {
    const repo = await pricingRepo();
    const results: Array<{ content: string; isError: boolean }> = [];
    let h!: Harness;
    h = await createHarness({
      brains: {
        lead: leadWith([{ localId: 'd1', title: 'design', objective: 'test the discount', role: 'test_designer', dependsOn: [], objectiveIds: ['obj'] }]),
        test_designer: async (v) => {
          if (v.lastResult) results.push(v.lastResult);
          switch (v.step) {
            case 0:
              return call('fs.write', { path: 'test/../src/pricing.js', content: PRICING_OK });
            case 1: {
              // a symlink inside the test tree pointing at product code (e.g. checked into the repository)
              await symlink('../src/pricing.js', join(await workspaceRoot(h, v.workItemId), 'test/alias.js'));
              return call('fs.write', { path: 'test/alias.js', content: PRICING_OK });
            }
            default:
              return call('complete_work', { summary: 'nothing written', output: { summary: 'nothing written', testArtifacts: [] } });
          }
        },
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'path tricks', target: { repoPath: repo.path, commit: repo.head } });
      await runLeadThen(h, run.runId);
      const d = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.equal(await runItem(h.control, d.workItemId, d.fencingToken), 'completed');
      const [dotdot, viaLink] = results;
      assert.equal(dotdot!.isError, true);
      assert.match(dotdot!.content, /^\[denied\] forbidden test change \(product_code\): src\/pricing\.js(:\d+)? product_code/);
      assert.equal(viaLink!.isError, true);
      assert.match(viaLink!.content, /^\[denied\] forbidden test change \(product_code\): src\/pricing\.js(:\d+)? product_code/);
      const root = await workspaceRoot(h, d.workItemId);
      assert.equal(await readFile(join(root, 'src/pricing.js'), 'utf8'), PRICING_BUG, 'the product code was never written');
      const denied = (await h.deps.events.read(run.runId, { types: ['policy.decided'] })).filter((e) => (e.payload as { reason?: string }).reason === 'test_change_forbidden');
      assert.deepEqual(denied.map((e) => (e.payload as { paths: string[] }).paths), [['src/pricing.js'], ['src/pricing.js']]);
    } finally {
      await h.dispose();
      await repo.cleanup();
    }
  });

  test('a command that weakens an assertion (shell.exec sed) quarantines the worktree: no test run or completion until restored', async () => {
    const repo = await pricingRepo();
    const results: Array<{ content: string; isError: boolean }> = [];
    const h = await createHarness({
      brains: {
        lead: leadWith([{ localId: 'e1', title: 'execute', objective: 'run the pricing suite', role: 'executor', dependsOn: [], objectiveIds: ['obj'] }]),
        executor: async (v) => {
          if (v.lastResult) results.push(v.lastResult);
          const done = { summary: 'suite ran', output: { summary: 'suite ran', executed: [], findings: [] } };
          switch (v.step) {
            case 0:
              return call('shell.exec', { command: ['git', 'status', '--short'] });
            case 1:
              return call('shell.exec', { command: ['sed', '-i', 's/900/800/', 'test/pricing.test.js'] });
            case 2:
              return call('test.run', { framework: 'node_test' });
            case 3:
              return call('complete_work', done);
            case 4:
              return call('shell.exec', { command: ['git', 'checkout', '--', 'test/pricing.test.js'] });
            case 5:
              return call('test.run', { framework: 'node_test' });
            default:
              return call('complete_work', done);
          }
        },
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'shell rewrite', target: { repoPath: repo.path, commit: repo.head } });
      await runLeadThen(h, run.runId);
      const d = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.equal(await runItem(h.control, d.workItemId, d.fencingToken), 'completed');
      const [status, sed, blockedRun, blockedDone, restore, run2] = results;
      assert.equal(status!.isError, false, 'a command that changes nothing is not governed');
      assert.equal(sed!.isError, true);
      assert.match(sed!.content, /^\[denied\] unapproved change by shell\.exec \(assertion\): test\/pricing\.test\.js:\d+ assertion: .*The worktree is quarantined/s);
      assert.equal(blockedRun!.isError, true);
      assert.match(blockedRun!.content, /^\[denied\] quarantined_worktree: test\.run is refused because shell\.exec \(invocation \S+\) changed governed code \(assertion\).*Restore exactly test\/pricing\.test\.js/s);
      assert.equal(blockedDone!.isError, true);
      assert.match(blockedDone!.content, /^\[denied\] quarantined_worktree: complete_work is refused/);
      assert.equal(restore!.isError, false, restore!.content);
      assert.equal(run2!.isError, false);
      assert.match(run2!.content, /NOT PASSED/, 'the restored (strong) test catches the seeded regression');
      // exactly one test run reached the evidence ledger: the one after the restore
      const testResults = await h.deps.evidence.query({ runId: run.runId, evidenceType: 'test-result' });
      assert.equal(testResults.length, 1);
      assert.equal((testResults[0]!.structured as { passed: boolean }).passed, false);
      const decided = (await h.deps.events.read(run.runId, { types: ['policy.decided'] })).map((e) => e.payload as { reason?: string; phase?: string; toolId?: string; paths?: string[] }).filter((p) => p.phase === 'post_execution');
      assert.deepEqual(decided.map((p) => [p.reason, p.toolId, p.paths]), [['test_change_unapproved', 'shell.exec', ['test/pricing.test.js']]]);
      const deniedCodes = (await h.deps.events.read(run.runId, { types: ['tool.denied'] })).map((e) => [(e.payload as { toolId: string }).toolId, (e.payload as { errorCode: string }).errorCode]);
      assert.deepEqual(deniedCodes, [['test.run', 'quarantined_worktree'], ['complete_work', 'quarantined_worktree']], 'every refused call is on L0');
      const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
      assert.equal((await new ControlStore(h.db).agentHost(agent.agentId))!.quarantine, undefined, 'lifted once the file was restored');
      assert.equal(await readFile(join(await workspaceRoot(h, d.workItemId), 'test/pricing.test.js'), 'utf8'), PRICING_TEST);
    } finally {
      await h.dispose();
      await repo.cleanup();
    }
  });

  test('a command that "fixes" the product under test (shell.exec sed on src/) is forbidden for an executor: no green run on a patched candidate', async () => {
    const repo = await pricingRepo();
    const results: Array<{ content: string; isError: boolean }> = [];
    const h = await createHarness({
      brains: {
        lead: leadWith([{ localId: 'e1', title: 'execute', objective: 'run the pricing suite', role: 'executor', dependsOn: [], objectiveIds: ['obj'] }]),
        executor: (v) => {
          if (v.lastResult) results.push(v.lastResult);
          if (v.step === 0) return call('shell.exec', { command: ['sed', '-i', 's/percent \\* 2/percent/', 'src/pricing.js'] });
          if (v.step === 1) return call('test.run', { framework: 'node_test' });
          return call('fail_work', { reason: 'quarantined', message: 'the worktree was quarantined' });
        },
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'product patch', target: { repoPath: repo.path, commit: repo.head } });
      await runLeadThen(h, run.runId);
      const d = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.equal(await runItem(h.control, d.workItemId, d.fencingToken), 'failed');
      const [patch, blocked] = results;
      assert.match(patch!.content, /^\[denied\] forbidden change by shell\.exec \(product_code\): src\/pricing\.js(:\d+)? product_code/);
      assert.match(blocked!.content, /^\[denied\] quarantined_worktree: test\.run is refused/);
      assert.equal(await readFile(join(await workspaceRoot(h, d.workItemId), 'src/pricing.js'), 'utf8'), PRICING_OK, 'the command did run (quarantine does not undo it) …');
      assert.deepEqual(await h.deps.evidence.query({ runId: run.runId, evidenceType: 'test-result' }), [], '… but no test ran on the patched candidate');
      const decided = (await h.deps.events.read(run.runId, { types: ['policy.decided'] })).map((e) => e.payload as { reason?: string; phase?: string; paths?: string[] }).filter((p) => p.phase === 'post_execution');
      assert.deepEqual(decided.map((p) => [p.reason, p.paths]), [['test_change_forbidden', ['src/pricing.js']]]);
    } finally {
      await h.dispose();
      await repo.cleanup();
    }
  });

  test('a guarded call re-dispatched after a crash (same invocation id) is judged against the state BEFORE its first execution', async () => {
    const repo = await pricingRepo();
    const h = await createHarness({
      brains: {
        lead: leadWith([{ localId: 'e1', title: 'execute', objective: 'run the pricing suite', role: 'executor', dependsOn: [], objectiveIds: ['obj'] }]),
        executor: () => call('git.status', {}),
      },
    });
    try {
      const run = await h.control.startRun({ goal: 'crash replay', target: { repoPath: repo.path, commit: repo.head } });
      await runLeadThen(h, run.runId);
      const d = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.equal((await h.control.executeTurn(d.workItemId, d.fencingToken)).status, 'continue');
      const item = (await h.deps.blackboard.getWorkItem(d.workItemId)) as WorkItem;
      const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
      const store = new ControlStore(h.db);
      const root = await workspaceRoot(h, d.workItemId);
      // the first execution of invocation X recorded its pre-state, ran `sed`, then the process died before the check
      const invocationId = `${agent.sessionId}:9:sed`;
      await store.setGuard(agent.agentId, { invocationId, before: '' });
      await writeFile(join(root, 'test/pricing.test.js'), PRICING_TEST.replace('900', '800'));
      // the restarted worker rebuilds the host from the stored spec and re-dispatches X (sed is idempotent: no new change)
      const r = (await h.deps.runs.get(run.runId))!;
      const { spec } = await h.control.worker.ensureAgent(item, r, item.claim!.fencingToken);
      const host = await h.control.worker.buildHost(item, r, agent, spec, item.claim!.fencingToken);
      const res = await host.tools.dispatch(
        { id: 'sed', name: 'shell__exec', arguments: { command: ['sed', '-i', 's/900/800/', 'test/pricing.test.js'] } },
        { sessionId: agent.sessionId, turn: 9, signal: new AbortController().signal, invocationId },
      );
      assert.equal(res.message.isError, true);
      assert.match(res.message.content, /^\[denied\] unapproved change by shell\.exec \(assertion\)/);
      const after = (await store.agentHost(agent.agentId))!;
      assert.deepEqual(after.quarantine!.paths, ['test/pricing.test.js']);
      assert.equal(after.guard, undefined, 'the guard is cleared once the call was judged');
    } finally {
      await h.dispose();
      await repo.cleanup();
    }
  });
});
