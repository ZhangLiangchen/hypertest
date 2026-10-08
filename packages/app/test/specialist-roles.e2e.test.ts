/**
 * The specialist roles in a real run (PGlite, or PostgreSQL 16 with HYPERTEST_TEST_DB=postgres): the lead plans a
 * `local_private` item (restricted data) and a `vision_gui` item next to a hosted route (vision, higher quality,
 * confidential data at most) and a local route (restricted data, no vision). Every model call of the local_private agent
 * reaches only the local provider and every call of the vision_gui agent only the vision route; without a restricted
 * route the local_private item fails closed at routing and the hosted provider never sees it.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, defaultConfig, type HypertestConfig, type HypertestConfigInput } from '../src/index.ts';
import { FULL_ROUTE, OBJECTIVE, SUM_ORACLE, call, evidenceIds, roleRouter, sumRepo, testStore, type BrainView, type RoleBrain } from './helpers.ts';

const GOAL = 'Is the sum module releasable, and does its fixture data leak anything?';

const HOSTED_ROUTE = {
  routeId: 'hosted-big', provider: 'hosted', model: 'hosted-1', ...FULL_ROUTE,
  capabilities: [...FULL_ROUTE.capabilities, 'vision'], quality: { default: 0.95 }, maxDataClassification: 'confidential',
};
const LOCAL_ROUTE = {
  routeId: 'local-small', provider: 'local', model: 'local-1', ...FULL_ROUTE, capabilities: ['tool_use', 'structured_output', 'long_context'],
  quality: { default: 0.7 }, maxActionRisk: 'critical', maxDataClassification: 'restricted',
};

function config(dataDir: string, store: HypertestConfig['store'] | undefined, routes: unknown[]): HypertestConfig {
  const c = defaultConfig({
    project: { name: 'specialist-roles', dataDir },
    models: { providers: [{ id: 'hosted', kind: 'scripted' }, { id: 'local', kind: 'scripted' }], routes },
    gate: { requireIndependentReview: false },
    observability: { logLevel: 'warn' },
    oracles: [SUM_ORACLE],
  } as unknown as HypertestConfigInput);
  return store ? { ...c, store } : c;
}

/** Lead: Plan v1 = a local_private item and a vision_gui item; replan: ready for the gate over the recorded test result. */
function lead(): RoleBrain {
  return (v) => {
    if (v.kind === 'initial_plan') {
      if (v.step === 0) {
        return call('plan.propose_revision', {
          rationale: 'The fixtures may hold personal data (local model only); the release page is checked in the browser.',
          objectives: [OBJECTIVE],
          workItems: [
            {
              localId: 'private-scan', title: 'Run the suite over the restricted fixtures', objective: 'Run the node:test suite on the candidate commit; report without reproducing any restricted value.',
              role: 'local_private', dependsOn: [], objectiveIds: ['obj-sum'], evidenceRequirements: [{ evidenceType: 'test-result', minCount: 1, critical: true }],
            },
            { localId: 'gui-check', title: 'Check the release page', objective: 'Report the GUI checks you can run (none are required for this commit).', role: 'vision_gui', dependsOn: [], objectiveIds: ['obj-sum'] },
          ],
        });
      }
      return call('complete_work', { summary: 'Plan v1 proposed', output: { summary: 'Plan v1', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-sum', status: 'open', evidenceRefs: [] }] } });
    }
    if (v.step === 0) return call('evidence.query', { evidenceType: 'test-result' });
    const ev = evidenceIds(v.toolResults[0]!.content);
    if (v.step === 1) return call('plan.propose_revision', { rationale: 'The suite passed under the local model.', objectives: [{ ...OBJECTIVE, status: 'satisfied' }], workItems: [], readyForGate: true });
    return call('complete_work', {
      summary: 'ready for the gate', evidenceRefs: ev.slice(0, 1),
      output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-sum', status: 'satisfied', evidenceRefs: ev.slice(0, 1) }] },
    });
  };
}

const localPrivate: RoleBrain = (v) => {
  if (v.step === 0) return call('test.run', { framework: 'node_test' });
  const ids = evidenceIds(v.toolResults[0]!.content);
  return call('complete_work', {
    summary: 'The suite passes; the fixtures hold no restricted values in the output.', evidenceRefs: ids,
    output: { summary: 'suite passed', observations: [{ statement: 'the node:test suite passes on the candidate commit', evidenceIds: ids }], findings: [], withheld: [] },
  });
};

const visionGui: RoleBrain = () =>
  call('complete_work', { summary: 'No GUI check applies to this commit.', output: { summary: 'nothing to check in the GUI', checks: [], findings: [], screenshots: [] } });

describe('specialist roles in a run: local_private stays on the local route, vision_gui on a vision route', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let repo: Awaited<ReturnType<typeof sumRepo>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  before(async () => {
    dir = await tempDir('ht-app-specialists-');
    repo = await sumRepo();
    db = await testStore();
  });
  after(async () => {
    await db.dispose();
    await repo.cleanup();
    await dir.cleanup();
  });

  test('restricted work is served only by the restricted (local) route; GUI work only by the vision route', async () => {
    const hostedCalls: BrainView[] = [];
    const localCalls: BrainView[] = [];
    const brains = { lead: lead(), local_private: localPrivate, vision_gui: visionGui };
    const ht = await createHypertest(config(dir.path, db.store, [HOSTED_ROUTE, LOCAL_ROUTE]), {
      scriptedBrains: { hosted: roleRouter(brains, hostedCalls), local: roleRouter(brains, localCalls) },
      logger: new MemoryLogger(),
    });
    try {
      const outcome = await ht.run({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 120_000 });
      assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
      const roles = (calls: BrainView[]) => [...new Set(calls.map((c) => c.role))].sort();
      assert.ok(localCalls.some((c) => c.role === 'local_private'), 'the local_private agent ran on the local route');
      assert.deepEqual(roles(localCalls).filter((r) => r !== 'local_private'), [], 'the local route (lower quality) served nothing else');
      assert.ok(!hostedCalls.some((c) => c.role === 'local_private'), 'restricted work never reached the hosted provider');
      assert.ok(hostedCalls.some((c) => c.role === 'vision_gui'), 'GUI work went to the vision route');
      // the recorded model epochs agree with the providers that answered
      const items = await ht.services.blackboard.listWorkItems({ runId: outcome.runId });
      const byRole = new Map(items.map((w) => [w.role, w]));
      assert.equal(byRole.get('local_private')?.state, 'completed');
      assert.equal(byRole.get('vision_gui')?.state, 'completed');
      const roleOfItem = new Map(items.map((w) => [w.workItemId, w.role]));
      const epochs = await ht.events(outcome.runId, { types: ['model.epoch_started'] });
      const routeOf = new Map<string, Set<string>>();
      for (const e of epochs) {
        const role = e.workItemId === undefined ? undefined : roleOfItem.get(e.workItemId);
        const routeId = (e.payload as { routeId?: string }).routeId;
        if (role && routeId) routeOf.set(role, (routeOf.get(role) ?? new Set()).add(routeId));
      }
      assert.deepEqual([...(routeOf.get('local_private') ?? [])], ['local-small'], JSON.stringify(epochs.map((e) => [e.workItemId, e.payload])));
      assert.deepEqual([...(routeOf.get('vision_gui') ?? [])], ['hosted-big']);
    } finally {
      await ht.close();
    }
  });

  test('without a restricted route the local_private item fails closed at routing; the hosted provider never sees it', async () => {
    const hostedCalls: BrainView[] = [];
    const brains = { lead: lead(), local_private: localPrivate, vision_gui: visionGui };
    const own = await testStore();
    const ht = await createHypertest(config(`${dir.path}/hosted-only`, own.store, [HOSTED_ROUTE]), {
      scriptedBrains: { hosted: roleRouter(brains, hostedCalls), local: roleRouter(brains) },
      logger: new MemoryLogger(),
    }).catch(async (e: unknown) => {
      await own.dispose();
      throw e;
    });
    try {
      const run = await ht.start({ goal: GOAL, target: { repoPath: repo.path, commit: repo.head } });
      // wait until the private item is decided (it can never be served) and the GUI item completed
      const deadline = Date.now() + 60_000;
      let items = await ht.services.blackboard.listWorkItems({ runId: run.runId });
      const settled = () => {
        const priv = items.find((w) => w.role === 'local_private');
        const gui = items.find((w) => w.role === 'vision_gui');
        return priv !== undefined && gui?.state === 'completed' && !['queued', 'ready', 'claimed', 'running'].includes(priv.state);
      };
      while (!settled() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        items = await ht.services.blackboard.listWorkItems({ runId: run.runId });
      }
      const priv = items.find((w) => w.role === 'local_private');
      assert.ok(priv, 'the lead planned the private item');
      assert.ok(settled(), `the private item was decided without a route: ${JSON.stringify(items.map((w) => [w.role, w.state]))}`);
      assert.equal(priv.state, 'failed', 'restricted work without a restricted route fails; it is never completed elsewhere');
      assert.ok(!hostedCalls.some((c) => c.role === 'local_private'), 'restricted work never reached the hosted provider');
      // the router refused at its security stage (the data boundary), not for capability or quality
      const routed = (await ht.events(run.runId, { types: ['model.routed'] })).filter((e) => e.workItemId === priv.workItemId);
      assert.ok(routed.length > 0);
      for (const e of routed) {
        const p = e.payload as { ok: boolean; reason: string; role: string; rejected: Array<{ stage: string; routeId: string; reason: string }> };
        assert.deepEqual([p.ok, p.reason, p.role], [false, 'no_eligible_route', 'local_private']);
        assert.deepEqual(p.rejected, [{ stage: 'security', routeId: 'hosted-big', reason: 'route accepts data up to confidential; request carries restricted' }]);
      }
      await ht.cancel(run.runId, 'test done');
    } finally {
      await ht.close();
      await own.dispose();
    }
  });
});
