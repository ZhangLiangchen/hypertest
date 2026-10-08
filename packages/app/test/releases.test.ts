import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { FixedClock, HypertestError, SequentialIdGenerator, isHypertestError, noopLogger } from '@hypertest/core';
import type { DomainEvent, TestRun } from '@hypertest/domain';
import { ModelCatalog, ProviderRegistry, ScriptedProvider, createModelRouter, type RouteRequest } from '@hypertest/model';
import { BUILTIN_ROLES, RoleCatalog } from '@hypertest/agents';
import type { ControlPlane, RunReport } from '@hypertest/control';
import { createGitRepo, tempDir } from '@hypertest/testkit';
import {
  agentClassification, completeRoute, condenserPrivacyFloor, hypertestGitSha, imageDigestFrom, pinnedControlPlane, releaseGovernedControlPlane, runtimeReleaseNotes,
  withRuntimeReleaseNotes,
} from '../src/index.ts';

describe('runtime BOM inputs', () => {
  test('hypertest.gitSha: HEAD of a checkout whose top level is the installation; never a parent repository', async () => {
    const repo = await createGitRepo({ 'package.json': '{}\n' }, [{ message: 'second', files: { 'a.txt': 'a' } }]);
    const outside = await tempDir('ht-no-git-');
    try {
      assert.equal(hypertestGitSha(repo.path), repo.commits[1]);
      const nested = join(repo.path, 'packages', 'app');
      await mkdir(nested, { recursive: true });
      assert.equal(hypertestGitSha(nested), undefined, 'an installation inside another repository does not pin that repository');
      assert.equal(hypertestGitSha(outside.path), undefined, 'not a checkout');
      assert.equal(hypertestGitSha(join(outside.path, 'x'), () => { throw new Error('git: command not found'); }), undefined, 'no git');
      assert.equal(hypertestGitSha(join(outside.path, 'y'), () => `${join(outside.path, 'y')}\nnot-a-sha\n`), undefined, 'garbage output is never pinned');
    } finally {
      await repo.cleanup();
      await outside.cleanup();
    }
  });

  test('hypertest.imageDigest from HYPERTEST_IMAGE_DIGEST: absent ⇒ none; malformed ⇒ invalid_argument', () => {
    const d = `sha256:${'0f'.repeat(32)}`;
    assert.equal(imageDigestFrom({}), undefined);
    assert.equal(imageDigestFrom({ HYPERTEST_IMAGE_DIGEST: '  ' }), undefined);
    assert.equal(imageDigestFrom({ HYPERTEST_IMAGE_DIGEST: ` ${d} ` }), d);
    for (const bad of ['latest', `sha256:${'0F'.repeat(32)}`, `sha512:${'0f'.repeat(32)}`, `sha256:${'0f'.repeat(31)}`]) {
      assert.throws(() => imageDigestFrom({ HYPERTEST_IMAGE_DIGEST: bad }), (e: unknown) => isHypertestError(e, 'invalid_argument'), bad);
    }
  });
});

describe('condenser privacy floor (local_private stays on local routes)', () => {
  const roles = new RoleCatalog(BUILTIN_ROLES);
  const hosts: Record<string, { role: string; modelPolicy: Record<string, unknown> }> = {
    agent_private: { role: 'local_private', modelPolicy: {} },
    agent_exec: { role: 'executor', modelPolicy: {} },
    agent_exec_conf: { role: 'executor', modelPolicy: { privacyClass: 'confidential' } },
  };
  const classify = () =>
    agentClassification({
      controlStore: { agentHost: async (id: string) => hosts[id] as never },
      agents: { get: async (id: string) => (id === 'agent_late' ? ({ role: 'local_private' } as never) : undefined) },
      roles,
    });

  test('agentClassification: max of the role classification and the effective policy privacy class', async () => {
    const c = classify();
    assert.equal(await c('agent_private'), 'restricted');
    assert.equal(await c('agent_exec'), 'internal');
    assert.equal(await c('agent_exec_conf'), 'confidential', 'a work item that tightened the privacy class');
    assert.equal(await c('agent_unknown'), undefined);
    assert.equal(await c('agent_late'), 'restricted', 'falls back to the agent repository');
  });

  test('a condenser request for a restricted agent routes to the local route; the hosted route (better quality) is never called', async () => {
    const calls: string[] = [];
    const providers = new ProviderRegistry([
      new ScriptedProvider({ providerId: 'hosted', brain: () => (calls.push('hosted'), { text: 'summary (hosted)' }) }),
      new ScriptedProvider({ providerId: 'local', brain: () => (calls.push('local'), { text: 'summary (local)' }) }),
    ]);
    const catalog = new ModelCatalog([
      // explicit prices (A[2]): the condenser's policy is cost-limited, and a route of unknown price never serves it
      completeRoute({ routeId: 'hosted-big', provider: 'hosted', model: 'h', capabilities: ['tool_use', 'long_context'], quality: { default: 0.95 }, costPerMillionInputUsd: 1, costPerMillionOutputUsd: 2 }, 'hosted:h'),
      completeRoute({ routeId: 'local-small', provider: 'local', model: 'l', capabilities: ['tool_use', 'long_context'], quality: { default: 0.6 }, maxDataClassification: 'restricted', costPerMillionInputUsd: 0, costPerMillionOutputUsd: 0 }, 'local:l'),
    ]);
    const raw = createModelRouter({ ids: new SequentialIdGenerator(), clock: new FixedClock(), logger: noopLogger, catalog, providers });
    const router = condenserPrivacyFloor(raw, classify());
    const condenser = roles.require('condenser');
    const request = (agentId: string, role = 'condenser'): RouteRequest => ({
      runId: 'run_1', agentId, role, taskType: condenser.taskType, policy: condenser.defaultModelPolicy, requiredCapabilities: [], actionRisk: 'low',
      dataClassification: condenser.dataClassification, contextTokensEstimate: 10, contextSnapshotId: 'cs_1',
    });
    const ctx = { runId: 'run_1', correlationId: 'c', actorId: 'system:test' };
    // without the floor the condenser of a private agent would pick the hosted route
    const unguarded = await raw.route(request('agent_private'), ctx);
    assert.equal(unguarded.ok && unguarded.routeId, 'hosted-big');
    const d = await router.route(request('agent_private'), ctx);
    assert.ok(d.ok && unguarded.ok);
    assert.equal(d.routeId, 'local-small');
    const out = await router.invoke({ decision: d, call: { messages: [{ role: 'user', content: 'restricted material' }], maxOutputTokens: 64 }, ctx }, request('agent_private'));
    assert.equal(out.ok, true);
    assert.deepEqual(calls, ['local']);
    // a hosted decision replayed for the private agent's request is refused at invoke (re-validated against the floor)
    const replay = await router.invoke({ decision: unguarded, call: { messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 64 }, ctx }, request('agent_private'));
    assert.equal(replay.ok, false);
    assert.deepEqual(calls, ['local'], 'the hosted provider never saw the material');
    // other agents' condensation and non-condenser requests are unchanged
    const other = await router.route(request('agent_exec'), ctx);
    assert.equal(other.ok && other.routeId, 'hosted-big');
    const plain = await router.route(request('agent_private', 'executor'), ctx);
    assert.equal(plain.ok && plain.routeId, 'hosted-big', 'only condenser requests are raised (agents route with their own classification)');
    assert.equal(typeof router.estimateCostUsd('local-small', 1, 1), 'number', 'other members pass through');
  });
});

describe('release governance at the control boundary', () => {
  const runs = new Map<string, TestRun>([
    ['run_live', { runId: 'run_live', status: 'running', runtimeManifestId: 'rm_this' } as TestRun],
    ['run_quarantined', { runId: 'run_quarantined', status: 'paused', pauseReason: 'quarantined', runtimeManifestId: 'rm_this' } as TestRun],
    ['run_migrating', { runId: 'run_migrating', status: 'paused', pauseReason: 'migrating', runtimeManifestId: 'rm_this' } as TestRun],
    ['run_budget', { runId: 'run_budget', status: 'paused', pauseReason: 'budget', runtimeManifestId: 'rm_this' } as TestRun],
  ]);
  function fake() {
    const calls: string[] = [];
    const control = {
      deps: {} as ControlPlane['deps'],
      async startRun(input: { runId?: string }) {
        calls.push(`startRun ${input.runId}`);
        return { runId: input.runId } as TestRun;
      },
      async resumeRun(runId: string) {
        calls.push(`resumeRun ${runId}`);
      },
    } as unknown as ControlPlane;
    return { control, calls };
  }

  test('a new run is admitted by the registry first (refused ⇒ nothing reaches the control plane); an existing run is not re-admitted', async () => {
    const { control, calls } = fake();
    const admitted: Array<Record<string, unknown>> = [];
    let allowed = false;
    let n = 0;
    const governed = releaseGovernedControlPlane(control, {
      manifestId: 'rm_this',
      requireActive: true,
      newRunId: () => `run_new${++n}`,
      getRun: async (id) => runs.get(id),
      registry: {
        admit: async (input) => {
          admitted.push(input as never);
          return allowed ? { allowed: true, mode: 'active', activeManifestId: 'rm_this' } : { allowed: false, reason: 'runtime rm_this is a candidate release', activeManifestId: 'rm_other', state: 'candidate' };
        },
      },
    });
    await assert.rejects(governed.startRun({ goal: 'g', target: {}, labels: { team: 'x' } }), (e: unknown) => {
      assert.ok(e instanceof HypertestError && e.code === 'precondition_failed');
      assert.equal(e.message, 'runtime release: runtime rm_this is a candidate release');
      assert.deepEqual(e.details, { runId: 'run_new1', runtimeManifestId: 'rm_this', activeManifestId: 'rm_other', state: 'candidate' });
      return true;
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(admitted, [{ manifestId: 'rm_this', runId: 'run_new1', labels: { team: 'x' }, requireActive: true }]);
    allowed = true;
    await governed.startRun({ goal: 'g', target: {} });
    assert.deepEqual(calls, ['startRun run_new2'], 'the admitted run id is the one created');
    // an existing run (idempotent start / resume by id) is not a new run
    await governed.startRun({ goal: 'g', target: {}, runId: 'run_live' });
    assert.equal(admitted.length, 2);
  });

  test('a newly created run is re-checked after creation: quarantined meanwhile ⇒ the start is refused (existing runs are not re-checked)', async () => {
    const created: string[] = [];
    const rechecked: string[] = [];
    let rolledBack = true;
    const control = {
      deps: {} as ControlPlane['deps'],
      async startRun(input: { runId?: string }) {
        created.push(input.runId!);
        return { runId: input.runId, status: 'running', runtimeManifestId: 'rm_this' } as TestRun;
      },
    } as unknown as ControlPlane;
    const governed = releaseGovernedControlPlane(control, {
      manifestId: 'rm_this',
      requireActive: false,
      newRunId: () => `run_new${created.length + 1}`,
      getRun: async (id) => runs.get(id),
      registry: { admit: async () => ({ allowed: true, mode: 'active', activeManifestId: 'rm_this' }) },
      afterCreate: async (runId) => {
        rechecked.push(runId);
        return rolledBack;
      },
    });
    await assert.rejects(governed.startRun({ goal: 'g', target: {} }), (e: unknown) => {
      assert.ok(e instanceof HypertestError && e.code === 'precondition_failed', String(e));
      assert.match(e.message, /^runtime release: runtime rm_this was rolled back while run run_new1 was being created — the run is quarantined/);
      assert.deepEqual(e.details, { runId: 'run_new1', runtimeManifestId: 'rm_this', quarantined: true });
      return true;
    });
    rolledBack = false;
    assert.equal((await governed.startRun({ goal: 'g', target: {} })).runId, 'run_new2');
    // an existing run (idempotent start by id) was admitted when it was created: no re-check
    rolledBack = true;
    await governed.startRun({ goal: 'g', target: {}, runId: 'run_live' });
    assert.deepEqual([created, rechecked], [['run_new1', 'run_new2', 'run_live'], ['run_new1', 'run_new2']]);
  });

  test('beforeDrive: every loop start (recover) and every operator resume re-checks the run first; fails closed', async () => {
    const calls: string[] = [];
    const local = new Map<string, TestRun>([
      ['run_escaped', { runId: 'run_escaped', status: 'paused', pauseReason: 'operator', runtimeManifestId: 'rm_this' } as TestRun],
      ['run_ok', { runId: 'run_ok', status: 'paused', pauseReason: 'operator', runtimeManifestId: 'rm_this' } as TestRun],
    ]);
    const control = {
      deps: {} as ControlPlane['deps'],
      async recover(runId: string) {
        calls.push(`recover ${runId}`);
        return { reconciled: 0, requeued: [] };
      },
      async resumeRun(runId: string) {
        calls.push(`resumeRun ${runId}`);
      },
    } as unknown as ControlPlane;
    const options = { manifestId: 'rm_this', requireActive: false, newRunId: () => 'run_x', getRun: async (id: string) => local.get(id), registry: { admit: async () => ({ allowed: true, mode: 'unmanaged' }) as const } };
    const governed = releaseGovernedControlPlane(control, {
      ...options,
      // run_escaped belongs to a rolled-back release but escaped the rollback's sweep: the re-check quarantines it
      beforeDrive: async (runId) => {
        calls.push(`check ${runId}`);
        if (runId !== 'run_escaped') return false;
        local.set(runId, { ...local.get(runId)!, pauseReason: 'quarantined' });
        return true;
      },
    });
    assert.deepEqual(await governed.recover('run_ok'), { reconciled: 0, requeued: [] });
    assert.deepEqual(calls, ['check run_ok', 'recover run_ok'], 'the re-check precedes the loop\'s recover');
    calls.length = 0;
    await assert.rejects(governed.resumeRun('run_escaped'), (e: unknown) => isHypertestError(e, 'precondition_failed') && /is quarantined/.test((e as Error).message));
    await governed.resumeRun('run_ok');
    assert.deepEqual(calls, ['check run_escaped', 'check run_ok', 'resumeRun run_ok', 'check run_ok'], 'the escaped run is not resumed; a resumed run is re-checked after the resume');
    // a re-check that cannot be made fails closed: nothing is recovered or resumed (the durable loop retries `unavailable`)
    const failing = releaseGovernedControlPlane(control, {
      ...options,
      beforeDrive: async () => {
        throw new HypertestError('unavailable', 'the store is down');
      },
    });
    calls.length = 0;
    await assert.rejects(failing.recover('run_ok'), (e: unknown) => isHypertestError(e, 'unavailable'));
    await assert.rejects(failing.resumeRun('run_ok'), (e: unknown) => isHypertestError(e, 'unavailable'));
    assert.deepEqual(calls, []);
  });

  test('beforeDrive: a rollback whose sweep quarantined the run between the resume check and the resume is not undone by the resume', async () => {
    const local = new Map<string, TestRun>([['run_r', { runId: 'run_r', status: 'paused', pauseReason: 'operator', runtimeManifestId: 'rm_this' } as TestRun]]);
    let rolledBack = false;
    const calls: string[] = [];
    const control = {
      deps: {} as ControlPlane['deps'],
      // the rollback commits (its sweep quarantines the run) just before the control plane's resume flips it to running
      async resumeRun(runId: string) {
        rolledBack = true;
        calls.push(`resumeRun ${runId}`);
        local.set(runId, { ...local.get(runId)!, status: 'running', pauseReason: undefined } as unknown as TestRun);
      },
    } as unknown as ControlPlane;
    const governed = releaseGovernedControlPlane(control, {
      manifestId: 'rm_this', requireActive: false, newRunId: () => 'run_x', getRun: async (id) => local.get(id),
      registry: { admit: async () => ({ allowed: true, mode: 'unmanaged' }) },
      beforeDrive: async (runId) => {
        calls.push(`check ${runId}`);
        const cur = local.get(runId)!;
        if (!rolledBack || cur.status !== 'running') return false;
        local.set(runId, { ...cur, status: 'paused', pauseReason: 'quarantined' });
        return true;
      },
    });
    await assert.rejects(governed.resumeRun('run_r'), (e: unknown) => {
      assert.ok(isHypertestError(e, 'precondition_failed'), String(e));
      assert.match((e as Error).message, /^run run_r is quarantined: the runtime release it is pinned to \(rm_this\) was rolled back/);
      return true;
    });
    assert.deepEqual(calls, ['check run_r', 'resumeRun run_r', 'check run_r']);
    assert.deepEqual([local.get('run_r')!.status, local.get('run_r')!.pauseReason], ['paused', 'quarantined'], 'quarantined again, not left running');
  });

  test('resumeRun refuses quarantined runs and migration checkpoints; other pauses pass', async () => {
    const { control, calls } = fake();
    const governed = releaseGovernedControlPlane(control, { manifestId: 'rm_this', requireActive: false, newRunId: () => 'run_x', getRun: async (id) => runs.get(id), registry: { admit: async () => ({ allowed: true, mode: 'unmanaged' }) } });
    await assert.rejects(governed.resumeRun('run_quarantined'), (e: unknown) => isHypertestError(e, 'precondition_failed') && /is quarantined: .* migrate it/.test((e as Error).message));
    await assert.rejects(governed.resumeRun('run_migrating'), (e: unknown) => isHypertestError(e, 'precondition_failed') && /checkpoint of a runtime migration/.test((e as Error).message));
    await governed.resumeRun('run_budget');
    assert.deepEqual(calls, ['resumeRun run_budget']);
  });

  test('pinnedControlPlane.forgetPin: a run migrated away is looked up again (and refused) instead of trusting the cache', async () => {
    const pins = new Map<string, TestRun>([['run_m', { runId: 'run_m', status: 'running', runtimeManifestId: 'rm_this' } as TestRun]]);
    const control = { deps: {}, tick: async (runId: string) => ({ runId }) } as unknown as ControlPlane;
    const guarded = pinnedControlPlane(control, 'rm_this', { getRun: async (id) => pins.get(id), runOf: async () => undefined });
    await guarded.tick('run_m');
    pins.set('run_m', { runId: 'run_m', status: 'running', runtimeManifestId: 'rm_other' } as TestRun);
    await guarded.tick('run_m'); // cached pin (the control plane itself re-checks the stored run)
    guarded.forgetPin('run_m');
    await assert.rejects(guarded.tick('run_m'), (e: unknown) => isHypertestError(e, 'precondition_failed'));
  });
});

describe('runtime release notes in the report', () => {
  const ev = (eventType: string, payload: Record<string, unknown>, occurredAt: string) => ({ eventType, payload, occurredAt }) as unknown as DomainEvent<unknown>;
  const report = (): RunReport => ({
    runId: 'run_1', goal: 'g', verdict: 'pending', claims: [], findings: [], risks: [], plans: [], workItems: [], models: [], evidence: { count: 0, rootHash: 'r', sealed: false },
    recovery: [{ at: '2026-01-01T00:00:02.000Z', detail: 'recovery by worker' }], markdown: '# report\n', json: { runId: 'run_1', recovery: [] },
  });

  test('quarantine and migration notes: markdown section, recovery entries in time order, json.runtimeRelease', () => {
    const notes = runtimeReleaseNotes([
      ev('run.quarantined', { manifestId: 'rm_new', by: 'human:alice', reason: 'bad canary', restoredManifestId: 'rm_old' }, '2026-01-01T00:00:01.000Z'),
      ev('run.migrated', { seq: 1, epochId: 'rte_1', by: 'human:alice', fromManifestId: 'rm_new', toManifestId: 'rm_old', reason: 'move', snapshotId: 'cs_1', statusBefore: 'paused', statusAfter: 'running' }, '2026-01-01T00:00:03.000Z'),
      ev('run.paused', {}, '2026-01-01T00:00:00.000Z'),
    ]);
    assert.equal(notes.length, 2);
    const quarantinedRun = { status: 'paused', pauseReason: 'quarantined' } as TestRun;
    const r = withRuntimeReleaseNotes(report(), quarantinedRun, notes.slice(0, 1));
    assert.match(r.markdown, /^# report\n\n## Runtime release\n\*\*This run is QUARANTINED\*\*: .*\n- 2026-01-01T00:00:01.000Z QUARANTINED: runtime release rm_new was rolled back by human:alice \(bad canary\); the active release is rm_old again/);
    const done = withRuntimeReleaseNotes(report(), { status: 'running' } as TestRun, notes);
    assert.deepEqual(done.recovery.map((x) => x.at), ['2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:03.000Z']);
    assert.doesNotMatch(done.markdown, /QUARANTINED\*\*/);
    assert.deepEqual((done.json as { runtimeRelease: { quarantined: boolean; notes: unknown[] } }).runtimeRelease.quarantined, false);
    const untouched = report();
    assert.equal(withRuntimeReleaseNotes(untouched, undefined, []), untouched, 'no notes: the report is returned as is');
  });

  test('a released migration checkpoint is a note too', () => {
    const notes = runtimeReleaseNotes([ev('run.migration_released', { runId: 'run_1', manifestId: 'rm_old', by: 'human:alice', reason: 'the migrating process died' }, '2026-01-01T00:00:04.000Z')]);
    assert.deepEqual(notes, [{ at: '2026-01-01T00:00:04.000Z', detail: 'abandoned runtime migration: its checkpoint was released by human:alice (the migrating process died); the run continued on rm_old' }]);
  });
});
