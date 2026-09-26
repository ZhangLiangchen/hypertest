import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { sha256Hex } from '@hypertest/core';
import { createGitRepo } from '@hypertest/testkit';
import type { ContextSnapshot, Finding, Risk, WorkItem } from '@hypertest/domain';
import {
  createFreshnessGuard, createObservationLog, createSnapshotBuilder, observeToolRuntime, workspaceFileResolver, type ObservationLog,
} from '@hypertest/context';
import { createToolRuntime } from '@hypertest/tools';
import { claimLeaseOwner, createContextProvider, resolveConfig, type TurnState } from '../src/index.ts';
import { SECRET, call, createHarness, runItem, type BrainView, type Harness, type RoleBrain } from './harness.ts';
import { pricingRepo } from './fixture.ts';

/**
 * The ReadSet is populated from what agents OBSERVED (conformance: "P0 revision 2", "FreshnessGuard re-checks …",
 * "mutation actions check the ReadSet"): tool results feed an observation log through the tool runtime the dispatcher
 * calls, the NEXT turn's snapshot pins them, and the FreshnessGuard re-validates them (with the agent's own observations
 * of the current turn) before every mutating call. Plus the context provider's own pins (input records, held leases) and
 * SOFT condensation.
 */

const REGRESSION = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/pricing.js';

test('regression: 25% off 2000 cents is 1500', () => {
  assert.equal(applyDiscount(2000, 25), 1500);
});
`;
const TOUCHED = `${REGRESSION}// reviewed by another agent\n`;
const EXTENDED = `${TOUCHED}
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

/** Wires what @hypertest/app composes: the observing tool runtime, the file resolver, the builder/guard with the log. */
function withObservations(h: Harness): ObservationLog {
  const base = { ids: h.ids, clock: h.clock, logger: h.logger };
  const log = createObservationLog({ ...base, db: h.db });
  h.deps.resolvers.register(workspaceFileResolver((id) => h.deps.workspaces.get(id)?.root));
  const guard = createFreshnessGuard({ ...base, db: h.db, events: h.deps.events, snapshots: h.deps.snapshots, resolvers: h.deps.resolvers, observations: log });
  h.deps.freshness = guard;
  h.deps.snapshotBuilder = createSnapshotBuilder({
    ...base, db: h.db, events: h.deps.events, snapshots: h.deps.snapshots, resolvers: h.deps.resolvers, observations: log,
    sources: {
      getRun: (runId) => h.deps.runs.get(runId),
      lastEventSeq: (runId) => h.deps.events.lastSeq(runId),
      blackboardRevision: (runId) => h.deps.blackboard.revision(runId),
      evidenceRoot: (runId) => h.deps.evidence.rootHash(runId),
      experimentRevisions: async () => ({}),
    },
  });
  h.deps.toolRuntime = observeToolRuntime(
    createToolRuntime({
      ...base, registry: h.deps.registry, policy: h.deps.policy, decisionLog: h.deps.decisionLog, freshness: guard, sideEffects: h.deps.gateway,
      artifacts: h.deps.artifacts, evidence: h.deps.evidence, events: h.deps.events, environments: h.deps.environments,
      runtimeManifestId: h.deps.config.runtimeManifest.manifestId, workerId: 'worker-1', capabilitySecret: SECRET,
    }),
    { log, logger: h.logger, now: () => h.clock.isoNow() },
  );
  return log;
}

const workspaceRootOf = (v: BrainView) => /Workspace root: (\S+) \(/.exec(v.userText)?.[1];

describe('observed read set through the dispatcher: stale after a concurrent change; an unrelated change does not block', () => {
  let h: Harness;
  let repo: Awaited<ReturnType<typeof pricingRepo>>;
  let log: ObservationLog;
  const results: Array<{ name: string; content: string; isError: boolean }> = [];
  before(async () => {
    repo = await pricingRepo();
    h = await createHarness({
      brains: {
        lead: leadWith([{ localId: 'd1', title: 'design', objective: 'extend the regression tests', role: 'test_designer', dependsOn: [], objectiveIds: ['obj'] }]),
        test_designer: async (v) => {
          if (v.lastResult) results.push(v.lastResult);
          const root = workspaceRootOf(v)!;
          switch (v.step) {
            case 0:
              return call('fs.write', { path: 'test/regression.test.js', content: REGRESSION });
            case 1:
              return call('fs.read', { path: 'test/regression.test.js' });
            case 2:
              // another agent sharing the worktree rewrites the file after this agent read it
              await writeFile(join(root, 'test/regression.test.js'), TOUCHED);
              return call('fs.write', { path: 'test/regression.test.js', content: EXTENDED });
            case 3:
              return call('fs.read', { path: 'test/regression.test.js' });
            case 4:
              // an unrelated change (a file this agent never read) does not make its view stale
              await writeFile(join(root, 'README.md'), 'changed by someone else\n');
              return call('fs.write', { path: 'test/regression.test.js', content: EXTENDED });
            default:
              return call('complete_work', { summary: 'extended', output: { summary: 'extended', testArtifacts: [] } });
          }
        },
      },
    });
    log = withObservations(h);
  });
  after(async () => {
    await h.dispose();
    await repo.cleanup();
  });

  test('a file the agent read and another agent changed ⇒ stale_context; after a re-read the write goes through', async () => {
    const run = await h.control.startRun({ goal: 'observed read set', target: { repoPath: repo.path, commit: repo.head } });
    const t0 = await h.control.tick(run.runId);
    assert.equal(await runItem(h.control, t0.dispatched[0]!.workItemId, t0.dispatched[0]!.fencingToken), 'completed');
    const t1 = await h.control.tick(run.runId);
    const d = t1.dispatched[0]!;
    assert.equal(await runItem(h.control, d.workItemId, d.fencingToken), 'completed');
    const [created, read, stale, reread, written] = results;
    assert.equal(created!.isError, false, created!.content);
    assert.equal(read!.isError, false, read!.content);
    // the write decided on the file the agent read is refused: another agent changed it meanwhile
    assert.equal(stale!.isError, true);
    assert.match(stale!.content, /^\[stale_context\] stale_context: stale context \(snapshot cs_\w+\): file\/workspace\/ws_\w+\/test\/regression\.test\.js: version_changed/);
    assert.equal(reread!.isError, false);
    // re-read ⇒ the next snapshot pins the current version; an unrelated file changed meanwhile does not block
    assert.equal(written!.isError, false, written!.content);
    const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
    const snapshotOf = async (turn: number): Promise<ContextSnapshot> => (await h.deps.snapshots.get((await h.deps.sessions.getTurn(agent.sessionId, turn))!.snapshotId!))!;
    const fileEntries = async (turn: number) => (await snapshotOf(turn)).readSet.filter((e) => e.resourceType === 'file').map((e) => e.observedVersion);
    // model turns start at 1 (turn 0 is the task input)
    assert.deepEqual(await fileEntries(1), [], 'nothing observed before the first tool call');
    assert.deepEqual(await fileEntries(2), [sha256Hex(REGRESSION)], 'turn 2 pins the file the agent wrote in turn 1');
    assert.deepEqual(await fileEntries(3), [sha256Hex(REGRESSION)], 'turn 3 pins what it read in turn 2');
    assert.deepEqual(await fileEntries(5), [sha256Hex(TOUCHED)], 'turn 5 pins what it re-read in turn 4');
    // the refusal is on L0 with what was stale
    const rejected = await h.deps.events.read(run.runId, { types: ['context.stale_rejected'] });
    assert.equal(rejected.length, 1);
    assert.deepEqual((rejected[0]!.payload as { stale: Array<{ resourceType: string; currentVersion: string }> }).stale.map((s) => [s.resourceType, s.currentVersion]), [['file', sha256Hex(TOUCHED)]]);
    // what was observed is recorded durably, per agent
    const observed = await log.latest({ runId: run.runId, agentId: agent.agentId });
    assert.ok(observed.some((o) => o.toolId === 'fs.write' && o.kind === 'write' && o.observedVersion === sha256Hex(EXTENDED)));
  });
});

describe('observed read set through the dispatcher: a git.show of the committed version never launders another agent\'s change', () => {
  let h: Harness;
  let repo: Awaited<ReturnType<typeof createGitRepo>>;
  let log: ObservationLog;
  const results: Array<{ name: string; content: string; isError: boolean }> = [];
  before(async () => {
    repo = await createGitRepo({
      'package.json': '{ "name": "shop", "type": "module", "private": true }\n',
      'src/pricing.js': 'export function applyDiscount(cents, pct) {\n  return Math.round(cents * (100 - pct) / 100);\n}\n',
      'test/regression.test.js': REGRESSION,
    });
    h = await createHarness({
      brains: {
        lead: leadWith([{ localId: 'd1', title: 'design', objective: 'extend the regression tests', role: 'test_designer', dependsOn: [], objectiveIds: ['obj'] }]),
        test_designer: async (v) => {
          if (v.lastResult) results.push(v.lastResult);
          const root = workspaceRootOf(v)!;
          switch (v.step) {
            case 0:
              return call('fs.read', { path: 'test/regression.test.js' });
            case 1:
              // another agent sharing the worktree rewrites the file; this agent then looks at the COMMITTED version only
              await writeFile(join(root, 'test/regression.test.js'), TOUCHED);
              return call('git.show', { rev: 'HEAD', path: 'test/regression.test.js' });
            case 2:
              return call('fs.write', { path: 'test/regression.test.js', content: EXTENDED });
            case 3:
              // a file whose committed version IS the working-tree file: the git.show observes it
              return call('git.show', { rev: 'HEAD', path: 'src/pricing.js' });
            default:
              return call('complete_work', { summary: 'extended', output: { summary: 'extended', testArtifacts: [] } });
          }
        },
      },
    });
    log = withObservations(h);
  });
  after(async () => {
    await h.dispose();
    await repo.cleanup();
  });

  test('the write decided without seeing the current file stays stale_context; a git.show of the current content is observed', async () => {
    const run = await h.control.startRun({ goal: 'git.show observation', target: { repoPath: repo.path, commit: repo.commits[0]! } });
    const t0 = await h.control.tick(run.runId);
    assert.equal(await runItem(h.control, t0.dispatched[0]!.workItemId, t0.dispatched[0]!.fencingToken), 'completed');
    const d = (await h.control.tick(run.runId)).dispatched[0]!;
    assert.equal(await runItem(h.control, d.workItemId, d.fencingToken), 'completed');
    const [read, shown, write, shownCurrent] = results;
    assert.equal(read!.isError, false, read!.content);
    assert.equal(shown!.isError, false, shown!.content);
    assert.doesNotMatch(shown!.content, /reviewed by another agent/, 'git.show HEAD shows the committed version');
    // the write was decided on the committed content, never on the other agent's change: refused
    assert.equal(write!.isError, true, write!.content);
    assert.match(write!.content, /^\[stale_context\] stale_context: .*file\/workspace\/ws_\w+\/test\/regression\.test\.js: version_changed/);
    assert.equal(shownCurrent!.isError, false, shownCurrent!.content);
    const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
    const observed = (await log.latest({ runId: run.runId, agentId: agent.agentId })).map((o) => `${o.toolId} ${o.resourceId.replace(/^workspace\/ws_\w+\//, '')}`).sort();
    assert.deepEqual(observed, ['fs.read test/regression.test.js', 'git.show src/pricing.js']);
  });
});

describe('context provider pins: every input record, the side-effect leases the current claim holds, the observer', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: { lead: leadWith([]) } });
  });
  after(async () => {
    await h.dispose();
  });

  test('input findings (always re-checked) and other records at their head; live leases of in-flight operations owned by this claim only', async () => {
    const log = withObservations(h);
    const run = await h.control.startRun({ goal: 'pins', target: {} });
    const ctx = h.ctx(run.runId);
    const f: Finding = { title: 'f', description: 'd', severity: 'P2', category: 'product_defect', status: 'open', fingerprint: 'fp-pins' };
    const finding = await h.deps.blackboard.postRecord({ runId: run.runId, recordType: 'finding', createdBy: 'ag_x', payload: f }, ctx);
    const newer = await h.deps.blackboard.postRecord({ runId: run.runId, recordType: 'finding', createdBy: 'ag_x', supersedes: finding.recordId, payload: { ...f, status: 'confirmed' } }, ctx);
    const r0: Risk = { title: 'r', description: 'd', likelihood: 'high', impact: 'high', level: 'high', componentRefs: [], source: 'review', status: 'open' };
    const risk = await h.deps.blackboard.postRecord({ runId: run.runId, recordType: 'risk', createdBy: 'ag_x', payload: r0 }, ctx);
    const t = await h.control.tick(run.runId);
    const d = t.dispatched[0]!;
    const claimed = (await h.deps.blackboard.getWorkItem(d.workItemId))!;
    const item: WorkItem = { ...claimed, inputRefs: [{ kind: 'record', id: finding.recordId }, { kind: 'record', id: risk.recordId }] };
    // an in-flight operation of this item holding a live lease of THIS claim, and one whose lease another owner holds now
    const owner = claimLeaseOwner(claimed.claim!.ownerId, d.workItemId, claimed.claim!.fencingToken);
    const mine = (await h.deps.leases.acquire({ resourceKey: 'env/kv', owner, ttlMs: 60_000 }))!;
    const theirs = (await h.deps.leases.acquire({ resourceKey: 'env/other', owner: 'someone-else', ttlMs: 60_000 }))!;
    for (const [lease, n] of [[mine, 1], [theirs, 2]] as const) {
      const op = await h.deps.ledger.prepare({ runId: run.runId, workItemId: d.workItemId, operationType: 'env.restart', adapterId: 'x', target: { resourceKey: lease.resourceKey, kind: 'environment' }, desiredStateHash: `h${n}`, inputHash: `i${n}`, lease: { leaseId: lease.leaseId, resourceKey: lease.resourceKey, fencingToken: lease.fencingToken } }, ctx);
      await h.deps.ledger.transition(op.operationId, 'dispatching', {}, ctx);
    }
    const agentId = 'ag_pins';
    await log.record({ runId: run.runId, agentId, toolId: 'fs.read', invocationId: 'inv_1' }, [{ kind: 'read', resourceType: 'file', resourceId: 'workspace/ws_x/a.ts', observedVersion: 'v1', observedAt: h.clock.isoNow(), freshness: { kind: 'exact_version' } }]);
    const turnState: TurnState = {};
    const workspace = await h.deps.workspaces.scratch({ runId: run.runId, workItemId: d.workItemId });
    const provider = createContextProvider(h.deps, resolveConfig(h.deps.config), {
      run: (await h.deps.runs.get(run.runId))!, item, role: h.deps.roles.require('lead'), agentId, workspace, eventContext: ctx, turnState,
      tools: { definitions: () => [], isParallelSafe: () => false, dispatch: async () => Promise.reject(new Error('unused')) },
    });
    const out = await provider.assemble({ sessionId: 'ses_pins', turn: 1, transcript: [], compactions: [], signal: new AbortController().signal });
    const pins = out.snapshot.readSet.map((e) => `${e.resourceType} ${e.resourceId} ${e.observedVersion}`).sort();
    assert.deepEqual(pins, [
      `file workspace/ws_x/a.ts v1`,
      `finding ${finding.lineageId} ${newer.recordId}`,
      `lease env/kv ${owner}:${mine.fencingToken}`,
      `record ${risk.lineageId} ${risk.recordId}`,
    ]);
    assert.equal(turnState.snapshot?.snapshotId, out.snapshot.snapshotId);
    // the lease taken over by another owner makes a mutating action of this turn stale
    await h.deps.leases.release(mine.leaseId);
    await h.deps.leases.acquire({ resourceKey: 'env/kv', owner: 'intruder', ttlMs: 60_000 });
    const r = await h.deps.freshness!.validate(out.snapshot, { tool: 'fs.write', resources: ['workspace/ws_y/b.ts'], mutating: true }, { ...ctx, agentId });
    assert.deepEqual(!r.fresh && r.stale.map((s) => [s.resourceType, s.resourceId, s.reason]), [['lease', 'env/kv', 'version_changed']]);
  });
});

describe('SOFT condensation: deferrable, only with the condenser route and enough turns; HARD stays mandatory', () => {
  const lead = (turns: number): RoleBrain => {
    let n = 0;
    return () => (n++ < turns ? call('blackboard.read', { status: `status-${n}-${'x'.repeat(700)}` }) : call('complete_work', { summary: 'ok', output: { summary: 'ok', planProposed: false, readyForGate: false, objectives: [] } }));
  };

  test('soft pressure with ≥ keepRecentTurns + 2 turns ⇒ a soft compaction by the LLM condenser (context.compacted level soft)', async () => {
    const h = await createHarness({ brains: { lead: lead(8), condenser: () => ({ text: 'SOFT-CONDENSED: the lead read the blackboard.' }) }, config: { maxInlineContextTokens: 3000 } });
    try {
      const run = await h.control.startRun({ goal: 'soft', target: {} });
      const d = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.equal(await runItem(h.control, d.workItemId, d.fencingToken), 'completed');
      const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
      const compactions = await h.deps.sessions.compactions(agent.sessionId);
      assert.ok(compactions.length >= 1, 'condensed');
      assert.equal(compactions[0]!.level, 'soft');
      assert.match(compactions[0]!.summary, /SOFT-CONDENSED/);
      const events = await h.deps.events.read(run.runId, { types: ['context.compacted'] });
      assert.deepEqual(events.map((e) => (e.payload as { level: string }).level), compactions.map((c) => c.level));
      // ≥ keepRecentTurns (4) + 2 turns lay beyond the (initial) cut, ≥ 2 turns condensed, 4 kept
      const turn = (events[0]!.payload as { turn: number; upToTurn: number });
      assert.ok(turn.turn - (-1) >= 6 && turn.upToTurn <= turn.turn - 4, JSON.stringify(turn));
      assert.ok(!compactions.some((c) => c.level === 'hard'), 'soft condensation kept the view below hard pressure');
    } finally {
      await h.dispose();
    }
  });

  test('a failing or missing condenser defers soft condensation (no deterministic fallback, the turn goes on); hard pressure still condenses', async () => {
    const h = await createHarness({ brains: { lead: lead(8), condenser: () => ({ error: 'provider_error', message: 'condenser down' }) }, config: { maxInlineContextTokens: 3000 } });
    try {
      const run = await h.control.startRun({ goal: 'soft deferred', target: {} });
      const d = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.equal(await runItem(h.control, d.workItemId, d.fencingToken), 'completed');
      const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
      const compactions = await h.deps.sessions.compactions(agent.sessionId);
      // the view stayed under hard pressure: no compaction at all — soft was deferred, never done deterministically
      assert.deepEqual(compactions, [], 'no soft compaction without a working condenser');
      assert.ok(h.logger.entries.some((e) => e.msg === 'soft condensation deferred' && /condenser/.test(String(e.fields['error']))));
      assert.ok(!h.logger.entries.some((e) => e.msg === 'LLM condenser unavailable; using the deterministic summarizer'), 'soft never falls back to the deterministic summarizer');
      assert.equal((await h.deps.events.read(run.runId, { types: ['context.compacted'] })).length, 0);
    } finally {
      await h.dispose();
    }
    // back-off: a failed soft attempt is not retried on every following turn (each could cost the condenser's deadline)
    const h1 = await createHarness({ brains: { lead: lead(14), condenser: () => ({ error: 'provider_error', message: 'condenser down' }) }, config: { maxInlineContextTokens: 3000 } });
    try {
      const run = await h1.control.startRun({ goal: 'soft back-off', target: {} });
      const d = (await h1.control.tick(run.runId)).dispatched[0]!;
      assert.equal(await runItem(h1.control, d.workItemId, d.fencingToken), 'completed');
      const deferredTurns = h1.logger.entries.filter((e) => e.msg === 'soft condensation deferred').map((e) => Number(e.fields['turn']));
      assert.ok(deferredTurns.length >= 1, 'soft condensation was attempted and deferred');
      for (let i = 1; i < deferredTurns.length; i++) assert.ok(deferredTurns[i]! - deferredTurns[i - 1]! >= 6, `attempts ≥ keepRecentTurns + 2 turns apart: ${deferredTurns.join(', ')}`);
      // the deferral is on L0 (audit, and the durable back-off anchor: the provider is rebuilt every turn)
      const onL0 = await h1.deps.events.read(run.runId, { types: ['context.condensation_deferred'] });
      assert.deepEqual(onL0.map((e) => (e.payload as { turn: number }).turn), deferredTurns);
      assert.deepEqual(onL0.map((e) => (e.payload as { retryTurn: number }).retryTurn), deferredTurns.map((t) => t + 6));
    } finally {
      await h1.dispose();
    }
    // HARD: the same failing condenser, a budget the transcript outgrows ⇒ mandatory, deterministic fallback
    const h2 = await createHarness({ brains: { lead: lead(8), condenser: () => ({ error: 'provider_error', message: 'condenser down' }) }, config: { maxInlineContextTokens: 1500 } });
    try {
      const run = await h2.control.startRun({ goal: 'hard', target: {} });
      const d = (await h2.control.tick(run.runId)).dispatched[0]!;
      assert.equal(await runItem(h2.control, d.workItemId, d.fencingToken), 'completed');
      const agent = (await h2.deps.agents.byWorkItem(d.workItemId))!;
      const compactions = await h2.deps.sessions.compactions(agent.sessionId);
      assert.ok(compactions.some((c) => c.level === 'hard'), 'hard condensation happened');
      assert.ok(h2.logger.entries.some((e) => e.msg === 'LLM condenser unavailable; using the deterministic summarizer'));
    } finally {
      await h2.dispose();
    }
  });
});
