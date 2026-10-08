/**
 * Upper-package hardening of the control plane: manifest pinning in the control plane itself (H2), gate override
 * validation (H3), claim-scoped side-effect leases and in-transaction claim re-checks of record-effect domain tools (H4),
 * idempotent tool-call charging and one test outcome event per invocation (H5), and one producer-role list (H10).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isHypertestError, type JsonValue } from '@hypertest/core';
import type { TestRun, WorkItem } from '@hypertest/domain';
import { BUILTIN_ROLES, EVIDENCE_PRODUCER_ROLES } from '@hypertest/agents';
import { PERMISSION_PROFILES } from '@hypertest/policy';
import type { ToolExecutionRequest, ToolExecutionResult } from '@hypertest/tools';
import { PRODUCER_ROLES, WorkFactory, claimLeaseOwner, createControlPlane, createToolDispatcher, runReviewRequestEventId, testOutcomeEventId, workScope } from '../src/index.ts';
import { call, createHarness, drive, items, parsed, type Harness, type RoleBrain } from './harness.ts';

const LEAD_OUT: { [k: string]: JsonValue } = { summary: 'lead done', planProposed: false, readyForGate: false, objectives: [] };

async function rejects(p: Promise<unknown>, code: string, re?: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(isHypertestError(e, code as never), `expected ${code}, got ${(e as Error).message}`);
    if (re) assert.match((e as Error).message, re);
    return true;
  });
}

/** A lead that reads the blackboard on its first turn (the item is then running with an agent), then completes. */
function readingLead(): Record<string, RoleBrain> {
  return {
    lead: (v) => (v.step === 0 ? call('blackboard.read', {}) : call('complete_work', { summary: 'done', output: LEAD_OUT })),
  };
}

/** Starts a run and runs the lead's first turn: the lead item is `running`, has an agent and a claim. */
async function runningLead(h: Harness, goal: string): Promise<{ run: TestRun; item: WorkItem; token: number }> {
  const run = await h.control.startRun({ goal, target: {} });
  const t = await h.control.tick(run.runId);
  const d = t.dispatched[0]!;
  assert.equal((await h.control.executeTurn(d.workItemId, d.fencingToken)).status, 'continue');
  const item = (await h.deps.blackboard.getWorkItem(d.workItemId))!;
  assert.equal(item.state, 'running');
  return { run: (await h.deps.runs.get(run.runId))!, item, token: d.fencingToken };
}

describe('H2: the control plane itself enforces the RuntimeManifest pin (I11), whatever the composer', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead() });
  });
  after(async () => h.dispose());

  test('tick, recover, executeTurn, observeWaiting and an idempotent startRun refuse a live run pinned to another manifest', async () => {
    // the run is created and driven by another runtime (e.g. an older release) sharing the store
    const manifest = h.control.config.runtimeManifest;
    const older = createControlPlane({ ...h.deps, config: { ...h.deps.config, runtimeManifest: { ...manifest, manifestId: 'rm_another_runtime' } } });
    let run: TestRun;
    let item: WorkItem;
    let token: number;
    try {
      run = await older.startRun({ goal: 'pinned elsewhere', target: {} });
      const d = (await older.tick(run.runId)).dispatched[0]!;
      assert.equal((await older.executeTurn(d.workItemId, d.fencingToken)).status, 'continue');
      item = (await h.deps.blackboard.getWorkItem(d.workItemId))!;
      token = d.fencingToken;
    } finally {
      await older.close();
    }
    assert.equal(run.runtimeManifestId, 'rm_another_runtime');
    // this runtime (another manifest) refuses to drive the live run, without any app-level wrapper
    await rejects(h.control.tick(run.runId), 'precondition_failed', /pinned to runtime manifest rm_another_runtime/);
    await rejects(h.control.recover(run.runId), 'precondition_failed', /I11/);
    await rejects(h.control.executeTurn(item.workItemId, token), 'precondition_failed', /I11/);
    await rejects(h.control.observeWaiting(item.workItemId), 'precondition_failed', /I11/);
    await rejects(h.control.startRun({ goal: 'pinned elsewhere', target: {}, runId: run.runId }), 'precondition_failed', /I11/);
    // nothing ran: the item is still where it was
    assert.equal((await h.deps.blackboard.getWorkItem(item.workItemId))!.state, 'running');
    // a finished run of another manifest stays readable (its outcome)
    await h.control.cancelRun(run.runId, 'test');
    const final = await h.control.tick(run.runId);
    assert.equal(final.final, true);
    assert.equal(final.status, 'cancelled');
  });

  test('an agent whose engine version is not the one the manifest pins never runs a turn', async () => {
    const { item, token } = await runningLead(h, 'engine pin');
    const manifest = h.control.config.runtimeManifest;
    // same manifest id (the run's pin), but this process's engine is not the pinned version
    const other = createControlPlane({ ...h.deps, config: { ...h.deps.config, runtimeManifest: { ...manifest, agentEngines: [{ kind: 'native', version: '9.9.9-not-this-one' }] } } });
    try {
      await rejects(other.executeTurn(item.workItemId, token), 'precondition_failed', /engine native is version/);
    } finally {
      await other.close();
    }
  });
});

describe('H3: startRun never stores a gate the QualityGate would misread as weaker', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead() });
  });
  after(async () => h.dispose());

  test('unknown severities / risk levels, non-boolean switches and malformed evidence requirements are refused', async () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ failOnUnresolvedSeverity: 'critical' }, /failOnUnresolvedSeverity must be one of P0, P1, P2, P3/],
      [{ failOnUnresolvedSeverity: 'P4' }, /failOnUnresolvedSeverity/],
      [{ conditionalOnRiskLevel: 'severe' }, /conditionalOnRiskLevel/],
      [{ requireIndependentReview: 'no' }, /requireIndependentReview must be a boolean/],
      [{ requiredEvidence: [{ evidenceType: 'test-result', minCount: 0 }] }, /minCount must be an integer ≥ 1/],
      [{ minCoverage: { lines: 101 } }, /minCoverage.lines/],
    ];
    for (const [gate, re] of bad) {
      await rejects(h.control.startRun({ goal: `bad gate ${JSON.stringify(gate)}`, target: {}, gate: gate as never }), 'invalid_argument', re);
    }
    assert.deepEqual(await h.deps.runs.list({}), [], 'no run was created');
    // a bogus configured default is refused the same way
    const plane = createControlPlane({ ...h.deps, config: { ...h.deps.config, defaultGate: { failOnUnresolvedSeverity: 'blocker' as never } } });
    try {
      await rejects(plane.startRun({ goal: 'bad default', target: {} }), 'invalid_argument', /failOnUnresolvedSeverity/);
    } finally {
      await plane.close();
    }
    // valid overrides still start the run
    // (conformance-9) a valid override that weakens the gate (conditionalOnRiskLevel high → critical) needs a recorded
    // human/system authority; a stricter one (P1 → P2) does not
    await rejects(h.control.startRun({ goal: 'valid gate', target: {}, gate: { failOnUnresolvedSeverity: 'P2', conditionalOnRiskLevel: 'critical' } }), 'invalid_argument', /conditionalOnRiskLevel: high → critical/);
    const ok = await h.control.startRun({
      goal: 'valid gate', target: {}, gate: { failOnUnresolvedSeverity: 'P2', conditionalOnRiskLevel: 'critical' }, gateOverrideBy: { kind: 'human', id: 'qa-lead' }, gateOverrideRationale: 'critical-only risk tolerance for this release train',
    });
    assert.equal(ok.status, 'running');
    assert.equal((await h.control.startRun({ goal: 'stricter gate', target: {}, gate: { failOnUnresolvedSeverity: 'P2' } })).status, 'running');
  });
});

describe('H4/H5: tool calls run under the work claim; replays are charged once and record one test outcome', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead() });
  });
  after(async () => h.dispose());

  async function host(item: WorkItem, token: number) {
    const run = (await h.deps.runs.get(item.runId))!;
    const { agent, spec } = await h.control.worker.ensureAgent(item, run, token);
    return { agent, host: await h.control.worker.buildHost(item, run, agent, spec, token) };
  }

  function intercept(before: (req: ToolExecutionRequest) => Promise<ToolExecutionResult | void>): () => void {
    const runtime = h.deps.toolRuntime;
    const original = runtime.execute;
    runtime.execute = async (req) => (await before(req)) ?? original.call(runtime, req);
    return () => {
      runtime.execute = original;
    };
  }

  test('H4: the request carries the claim-scoped lease owner <workerId>:<workItemId>:<token> and the claim', async () => {
    const { item, token } = await runningLead(h, 'lease owner');
    const { agent, host: hst } = await host(item, token);
    const seen: ToolExecutionRequest[] = [];
    const restore = intercept(async (req) => {
      seen.push(req);
    });
    try {
      await hst.tools.dispatch({ id: 'c1', name: 'blackboard__read', arguments: {} }, { sessionId: agent.sessionId, turn: 9, invocationId: `${agent.sessionId}:9:c1`, signal: new AbortController().signal });
    } finally {
      restore();
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.leaseOwner, claimLeaseOwner('worker-1', item.workItemId, token));
    assert.equal(seen[0]!.leaseOwner, `worker-1:${item.workItemId}:${token}`);
    assert.deepEqual(seen[0]!.claim, { workItemId: item.workItemId, fencingToken: token, ownerId: 'worker-1', leaseId: item.claim!.leaseId });
  });

  test('H4: a record-effect domain tool whose claim is revoked while the call is in flight writes nothing (re-checked in its transaction)', async () => {
    const { run, item, token } = await runningLead(h, 'stale in flight');
    const { agent, host: hst } = await host(item, token);
    // the claim is revoked AFTER the dispatcher's pre-dispatch fence check and BEFORE the tool writes (lease expiry → requeue)
    const restore = intercept(async () => {
      await h.control.scheduler.requeue((await h.deps.blackboard.getWorkItem(item.workItemId))!, h.ctx(run.runId), 'test: lease lapsed', token);
    });
    let r;
    try {
      r = await hst.tools.dispatch(
        { id: 'c2', name: 'request_approval', arguments: { kind: 'manual_review', subject: { what: 'stale write' }, rationale: 'a stale worker must not file this' } },
        { sessionId: agent.sessionId, turn: 10, invocationId: `${agent.sessionId}:10:c2`, signal: new AbortController().signal },
      );
    } finally {
      restore();
    }
    assert.equal(r.message.isError, true);
    assert.match(String(r.message.content), /lease_lost/);
    assert.deepEqual(await h.deps.approvals.list({ runId: run.runId }), [], 'the stale worker filed nothing');
    assert.equal((await h.deps.blackboard.getWorkItem(item.workItemId))!.state, 'ready');
  });

  test('H4: two concurrent executions of one replayed plan.propose_revision accept ONE revision (lookup inside the plan transaction)', async () => {
    const { run, item, token } = await runningLead(h, 'concurrent replay');
    const { agent } = await host(item, token);
    const spec = h.deps.registry.get('plan.propose_revision')!;
    const ctx = {
      runId: run.runId, workItemId: item.workItemId, agentId: agent.agentId, role: 'lead', invocationId: `${agent.sessionId}:3:dup`,
      eventContext: { runId: run.runId, correlationId: item.workItemId, actorId: agent.agentId, workItemId: item.workItemId, agentId: agent.agentId },
      signal: new AbortController().signal, logger: h.logger, environments: h.deps.environments, claim: { workItemId: item.workItemId, fencingToken: token },
    };
    const input = {
      rationale: 'plan once', objectives: [{ objectiveId: 'o1', description: 'objective', priority: 'P2' }],
      workItems: [{ localId: 'a1', title: 'analyse', objective: 'analyse the change', role: 'code_change_analyst', dependsOn: [], objectiveIds: ['o1'] }],
    };
    const [a, b] = await Promise.all([spec.execute(input, ctx as never), spec.execute(input, ctx as never)]);
    const plans = (await h.deps.blackboard.listPlans(run.runId)).filter((p) => p.status === 'accepted');
    assert.equal(plans.length, 1, 'one accepted revision');
    const analysts = (await items(h, run.runId)).filter((w) => w.role === 'code_change_analyst');
    assert.equal(analysts.length, 1, 'no duplicated work items');
    assert.deepEqual((a.structured as { workItemIds: string[] }).workItemIds, (b.structured as { workItemIds: string[] }).workItemIds);
    assert.equal([a, b].filter((x) => (x.structured as { replayed?: boolean }).replayed === true).length, 1);
  });

  test('conformance-5: load.start above the run\'s maxExternalQps is denied before it runs; at the cap it runs', async () => {
    const run = await h.control.startRun({ goal: 'qps cap', target: {}, budget: { maxExternalQps: 50 } });
    const t = await h.control.tick(run.runId);
    const dd = t.dispatched[0]!;
    assert.equal((await h.control.executeTurn(dd.workItemId, dd.fencingToken)).status, 'continue');
    const item = (await h.deps.blackboard.getWorkItem(dd.workItemId))!;
    const { agent, spec } = await h.control.worker.ensureAgent(item, (await h.deps.runs.get(run.runId))!, dd.fencingToken);
    const executed: unknown[] = [];
    const restore = intercept(async (req) => {
      if (req.toolId !== 'load.start') return undefined;
      executed.push(req.input);
      return { toolId: 'load.start', invocationId: req.invocationId, status: 'success', structured: {}, modelText: 'started', artifactRefs: [], evidenceRefs: [], durationMs: 1 };
    });
    const d = createToolDispatcher(h.deps, {
      runId: run.runId, workItemId: item.workItemId, agentId: agent.agentId, role: 'lead', sessionId: agent.sessionId,
      capability: { ...spec.capability, tools: [...spec.capability.tools, 'load.start'] }, allow: ['load.start'], deny: [],
      workspace: await h.deps.workspaces.scratch({ runId: run.runId, workItemId: item.workItemId }),
      eventContext: { runId: run.runId, correlationId: item.workItemId, actorId: agent.agentId, workItemId: item.workItemId, agentId: agent.agentId },
      turnState: {}, fencingToken: dd.fencingToken,
    });
    try {
      const meta = (n: number) => ({ sessionId: agent.sessionId, turn: 20 + n, invocationId: `${agent.sessionId}:${20 + n}:l`, signal: new AbortController().signal });
      // D-4: load runs only for an experiment of the item declaring it (defined by the lead's agent before its first call)
      const defined = await h.deps.registry.get('experiment.define')!.execute({
        hypothesis: 'the service holds 50 rps', workload: { kind: 'http_load', targetUrl: 'http://127.0.0.1:9/', ratePerSecond: 50, durationMs: 1000 },
        isolation: { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'url/127.0.0.1:9', mode: 'write_exclusive' }] },
      }, {
        runId: run.runId, workItemId: item.workItemId, agentId: agent.agentId, role: 'lead', invocationId: `${agent.sessionId}:19:e`,
        eventContext: { runId: run.runId, correlationId: item.workItemId, actorId: agent.agentId, workItemId: item.workItemId, agentId: agent.agentId },
        signal: new AbortController().signal, logger: h.logger, environments: h.deps.environments, claim: { workItemId: item.workItemId, fencingToken: dd.fencingToken },
      } as never);
      assert.equal(defined.status, 'success', JSON.stringify(defined));
      const over = await d.dispatch({ id: 'l', name: 'load__start', arguments: { method: 'GET', targetUrl: 'http://127.0.0.1:9/', ratePerSecond: 500, durationMs: 1000 } }, meta(1));
      assert.match(String(over.message.content), /\[denied\] external_qps_exceeded: load\.start ratePerSecond 500 exceeds the run's maxExternalQps 50/);
      assert.deepEqual(executed, [], 'the job never started');
      await d.dispatch({ id: 'l', name: 'load__start', arguments: { method: 'GET', targetUrl: 'http://127.0.0.1:9/', ratePerSecond: 50, durationMs: 1000 } }, meta(2));
      assert.equal(executed.length, 1, 'at the cap the call reaches the runtime');
    } finally {
      restore();
    }
  });

  test('H5: a replayed tool call is charged once; a replayed test.run records one test outcome event', async () => {
    const plan = await runningLead(h, 'replay charge');
    const { agent, host: hst } = await host(plan.item, plan.token);
    const meta = { sessionId: agent.sessionId, turn: 11, invocationId: `${agent.sessionId}:11:c3`, signal: new AbortController().signal };
    const before = (await h.deps.budget.usage(workScope(plan.item.workItemId)))?.used.toolCalls ?? 0;
    await hst.tools.dispatch({ id: 'c3', name: 'blackboard__read', arguments: {} }, meta);
    await hst.tools.dispatch({ id: 'c3', name: 'blackboard__read', arguments: {} }, meta);
    const afterCharge = (await h.deps.budget.usage(workScope(plan.item.workItemId)))!.used.toolCalls ?? 0;
    assert.equal(afterCharge - before, 1, 'the same invocation is charged once');

    // test.run outcome events: a replay (same invocation) never appends a second test.passed/test.failed
    const fake = (passed: boolean): ToolExecutionResult => ({
      toolId: 'test.run', invocationId: 'x', status: 'success', structured: { passed, framework: 'node_test', totals: { passed: passed ? 1 : 0, failed: passed ? 0 : 1, total: 1 } },
      modelText: 'ok', artifactRefs: [], evidenceRefs: [], durationMs: 1,
    });
    let outcome = false;
    const restore = intercept(async () => fake((outcome = !outcome)));
    // the lead is not offered test.run: a dispatcher of the same claim that offers it
    const { spec } = await h.control.worker.ensureAgent(plan.item, plan.run, plan.token);
    const d = createToolDispatcher(h.deps, {
      runId: plan.run.runId, workItemId: plan.item.workItemId, agentId: agent.agentId, role: 'lead', sessionId: agent.sessionId,
      capability: { ...spec.capability, tools: [...spec.capability.tools, 'test.run'] }, allow: ['test.run'], deny: [],
      workspace: await h.deps.workspaces.scratch({ runId: plan.run.runId, workItemId: plan.item.workItemId }),
      eventContext: { runId: plan.run.runId, correlationId: plan.item.workItemId, actorId: agent.agentId, workItemId: plan.item.workItemId, agentId: agent.agentId },
      turnState: {}, fencingToken: plan.token,
    });
    try {
      const meta2 = { sessionId: agent.sessionId, turn: 12, invocationId: `${agent.sessionId}:12:t1`, signal: new AbortController().signal };
      await d.dispatch({ id: 't1', name: 'test__run', arguments: {} }, meta2);
      await d.dispatch({ id: 't1', name: 'test__run', arguments: {} }, meta2);
    } finally {
      restore();
    }
    const outcomes = (await h.deps.events.read(plan.run.runId, { types: ['test.passed', 'test.failed'] })).filter((e) => e.aggregateId === `${agent.sessionId}:12:t1`);
    assert.equal(outcomes.length, 1, 'one test outcome event per invocation');
    assert.equal(outcomes[0]!.eventId, testOutcomeEventId(`${agent.sessionId}:12:t1`));
    assert.equal(outcomes[0]!.eventType, 'test.passed', 'the first recorded outcome is kept');
  });
});

describe('H10: the gate and the reviewer routing count the same evidence producers', () => {
  test('PRODUCER_ROLES is the agents catalog list, metrics_analyst and environment included', () => {
    assert.deepEqual([...PRODUCER_ROLES].sort(), [...EVIDENCE_PRODUCER_ROLES].sort());
    for (const r of ['executor', 'test_designer', 'rca', 'fixer', 'metrics_analyst', 'environment']) assert.ok(PRODUCER_ROLES.includes(r), r);
  });
});

describe('conformance-3: each turn\'s snapshot pins what the agent works against (every environment, its input findings)', () => {
  let h: Harness;
  const env = (environmentId: string) => ({ environmentId, environmentClass: 'sandbox', baseUrl: 'http://127.0.0.1:9', generation: 1 });
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: [env('env-target'), env('env-other')] });
  });
  after(async () => h.dispose());

  test('an env action on a non-target environment and a fix on a superseded finding are stale before a mutating action', async () => {
    const run = await h.control.startRun({ goal: 'freshness read set', target: { environmentId: 'env-target' } });
    const finding = await h.deps.blackboard.postRecord(
      { runId: run.runId, recordType: 'finding', createdBy: 'agent_exec', payload: { title: 'total wrong', description: 'd', severity: 'P1', category: 'product_defect', status: 'open', fingerprint: 'fp1' }, evidenceRefs: [] },
      h.ctx(run.runId),
    );
    const { workItem } = await h.deps.blackboard.createWorkItem(
      {
        runId: run.runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title: 'fix it', objective: 'fix the finding', role: 'lead', objectiveIds: [], capabilityRequirements: [],
        inputRefs: [{ kind: 'record', id: finding.recordId }], evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 5, maxTokens: 100_000, maxToolCalls: 20, maxWallClockMs: 600_000 },
        priority: 1000, depth: 0, fingerprint: 'fp-fix', resourceClaims: [], state: 'ready',
      },
      h.ctx(run.runId),
    );
    const d = (await h.control.tick(run.runId)).dispatched.find((x) => x.workItemId === workItem.workItemId)!;
    assert.ok(d, 'the fix item is dispatched');
    const item = (await h.deps.blackboard.getWorkItem(workItem.workItemId))!;
    const fresh = await h.deps.runs.get(run.runId);
    const { agent, spec } = await h.control.worker.ensureAgent(item, fresh!, d.fencingToken);
    const hostFor = await h.control.worker.buildHost(item, fresh!, agent, spec, d.fencingToken);
    const { snapshot } = await hostFor.context.assemble({ sessionId: agent.sessionId, turn: 1, transcript: [], compactions: [], signal: new AbortController().signal });
    const pinned = snapshot.readSet.map((e) => `${e.resourceType}:${e.resourceId}`).sort();
    assert.ok(pinned.includes('environment:env-target'));
    assert.ok(pinned.includes('environment:env-other'), `every registered environment is pinned: ${pinned.join(', ')}`);
    assert.ok(pinned.includes(`finding:${finding.lineageId}`), 'the input finding is pinned');
    const freshness = h.deps.freshness!;
    const ctx = h.ctx(run.runId);
    const mutate = (resources: string[]) => freshness.validate(snapshot, { tool: 'env.restart', resources, mutating: true }, ctx);
    assert.equal((await mutate(['env/env-other'])).fresh, true);

    // another agent restarts the NON-target environment: the turn's env action on it is stale (it used to pass)
    h.deps.environments.bumpGeneration('env-other', undefined, 'op_other_restart');
    const stale = await mutate(['env/env-other']);
    assert.equal(stale.fresh, false);
    assert.ok(!stale.fresh && stale.stale.some((s) => s.resourceType === 'environment' && s.resourceId === 'env-other'));

    // the finding the item acts on is rejected (superseded) meanwhile
    const snap2 = (await hostFor.context.assemble({ sessionId: agent.sessionId, turn: 2, transcript: [], compactions: [], signal: new AbortController().signal })).snapshot;
    assert.equal((await freshness.validate(snap2, { tool: 'fs.write', resources: ['ws/x'], mutating: true }, ctx)).fresh, true);
    await h.deps.blackboard.postRecord(
      { runId: run.runId, recordType: 'finding', createdBy: 'agent_rca', supersedes: finding.recordId, payload: { title: 'total wrong', description: 'not a defect', severity: 'P1', category: 'product_defect', status: 'rejected', fingerprint: 'fp1' }, evidenceRefs: [] },
      ctx,
    );
    const onRejected = await freshness.validate(snap2, { tool: 'fs.write', resources: ['ws/x'], mutating: true }, ctx);
    assert.equal(onRejected.fresh, false);
    assert.ok(!onRejected.fresh && onRejected.stale.some((s) => s.resourceType === 'finding' && s.resourceId === finding.lineageId));

  });
});

describe('H9: capability environment classes = role profile ∩ the classes of the registered environments', () => {
  test('a run whose only environment is a sandbox never carries a staging-capable token; with none, only this host (local) remains', async () => {
    const h = await createHarness({ brains: readingLead(), environments: [{ environmentId: 'env-sb', environmentClass: 'sandbox', baseUrl: 'http://127.0.0.1:9', generation: 1 }] });
    const bare = await createHarness({ brains: readingLead() });
    const staging = await createHarness({ brains: readingLead(), environments: [{ environmentId: 'env-st', environmentClass: 'staging', baseUrl: 'http://127.0.0.1:9', generation: 1 }] });
    try {
      const lead = PERMISSION_PROFILES[BUILTIN_ROLES.find((r) => r.role === 'lead')!.permissionProfile as keyof typeof PERMISSION_PROFILES].environmentClasses;
      const expect = (registered: string[]) => lead.filter((c) => c === 'local' || registered.includes(c)).sort();
      assert.ok(lead.some((c) => c !== 'local' && c !== 'sandbox'), `the lead profile allows more than local/sandbox: ${lead.join(', ')}`);
      for (const [harness, want] of [[h, expect(['sandbox'])], [bare, expect([])], [staging, expect(['staging'])]] as const) {
        const { item, token } = await runningLead(harness, 'env classes');
        const run = (await harness.deps.runs.get(item.runId))!;
        const { spec } = await harness.control.worker.ensureAgent(item, run, token);
        assert.deepEqual([...spec.capability.environmentClasses].sort(), [...want], `lead profile classes narrowed to ${want.join(', ') || 'none'}`);
      }
    } finally {
      await h.dispose();
      await bare.dispose();
      await staging.dispose();
    }
  });
});

/** A ready work item created directly (role lead: the scripted reading lead drives it). */
async function directItem(h: Harness, runId: string, extra: { fingerprint: string; resourceClaims?: WorkItem['resourceClaims']; priority?: number }): Promise<WorkItem> {
  const { workItem } = await h.deps.blackboard.createWorkItem(
    {
      runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title: extra.fingerprint, objective: `objective ${extra.fingerprint}`, role: 'lead', objectiveIds: [], capabilityRequirements: [],
      inputRefs: [], evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 5, maxTokens: 100_000, maxToolCalls: 20, maxWallClockMs: 600_000 },
      priority: extra.priority ?? 1000, depth: 0, fingerprint: extra.fingerprint, resourceClaims: extra.resourceClaims ?? [], state: 'ready',
    },
    h.ctx(runId),
  );
  return workItem;
}

describe('H13: a pause never costs a work attempt', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead() });
  });
  after(async () => h.dispose());

  test('executeTurn of a paused run gives the claim back (ready, attempts unchanged); after a long pause and resume the item is re-admitted and continues its session', async () => {
    const { run, item, token } = await runningLead(h, 'pause keeps attempts');
    const agentBefore = (await h.deps.agents.byWorkItem(item.workItemId))!;
    await h.control.pauseRun(run.runId, 'operator');
    const o = await h.control.executeTurn(item.workItemId, token);
    assert.equal(o.status, 'paused');
    const yielded = (await h.deps.blackboard.getWorkItem(item.workItemId))!;
    assert.equal(yielded.state, 'ready');
    assert.equal(yielded.attempts, 0, 'the pause consumed no attempt');
    assert.equal(yielded.claim, undefined);
    assert.equal(await h.deps.leases.current(`work/${item.workItemId}`), undefined, 'the work lease is released');
    // a pause far longer than the lease TTL, then resume
    h.clock.advance(10 * 60_000);
    assert.equal((await h.control.tick(run.runId)).dispatched.length, 0, 'nothing is admitted while paused');
    await h.control.resumeRun(run.runId);
    const t = await h.control.tick(run.runId);
    const again = t.dispatched.find((d) => d.workItemId === item.workItemId);
    assert.ok(again, 're-admitted on resume');
    assert.ok(again.fencingToken > token, 'under a new claim');
    const reclaimed = (await h.deps.blackboard.getWorkItem(item.workItemId))!;
    assert.equal(reclaimed.attempts, 0, 'still no attempt consumed');
    assert.equal((await h.control.executeTurn(item.workItemId, again.fencingToken)).status, 'completed');
    assert.equal((await h.deps.agents.byWorkItem(item.workItemId))!.agentId, agentBefore.agentId, 'the same agent (session) continued');
    // the old claim is stale
    assert.equal((await h.control.executeTurn(item.workItemId, token)).status, 'completed');
  });
});

describe('H6 (control): dispatch within the executor\'s free capacity; renewClaim keeps a queued claim alive', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead() });
  });
  after(async () => h.dispose());

  test('tick({maxDispatch}) claims at most that many items; renewClaim keeps a claim that has not started past the lease TTL', async () => {
    const run = await h.control.startRun({ goal: 'capacity', target: {}, budget: { maxAgentConcurrency: 4 } });
    await directItem(h, run.runId, { fingerprint: 'extra-1', priority: 10 });
    await directItem(h, run.runId, { fingerprint: 'extra-2', priority: 10 });
    assert.deepEqual((await h.control.tick(run.runId, { maxDispatch: 0 })).dispatched, [], 'no free slot: nothing is claimed');
    const t = await h.control.tick(run.runId, { maxDispatch: 1 });
    assert.equal(t.dispatched.length, 1, 'one free slot: one claim');
    const d = t.dispatched[0]!;
    // the claim waits for a slot for longer than the lease TTL (60 s), kept alive by the runtime every 30 s
    h.clock.advance(30_000);
    assert.equal(await h.control.renewClaim!(d.workItemId, d.fencingToken), true);
    h.clock.advance(40_000);
    assert.equal(await h.control.renewClaim!(d.workItemId, d.fencingToken), true);
    h.clock.advance(20_000); // 90 s after the claim
    await h.control.tick(run.runId, { maxDispatch: 0 });
    const w = (await h.deps.blackboard.getWorkItem(d.workItemId))!;
    assert.equal(w.state, 'claimed', 'not requeued');
    assert.equal(w.attempts, 0);
    assert.equal(w.claim!.fencingToken, d.fencingToken);
    assert.notEqual((await h.control.executeTurn(d.workItemId, d.fencingToken)).status, 'lease_lost');
    // a claim that is not held any more is not renewed
    assert.equal(await h.control.renewClaim!(d.workItemId, d.fencingToken + 100), false);
  });
});

describe('durability-2: a lapsed resource claim stops the item; admission is audited on L0', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead() });
  });
  after(async () => h.dispose());

  test('granted/refused/lapsed are L0 events; a turn never runs on resources another holder took meanwhile', async () => {
    const run = await h.control.startRun({ goal: 'resource claims', target: {} });
    const claims = [{ resourceKey: 'env/shared', mode: 'write_exclusive' as const }];
    const item = await directItem(h, run.runId, { fingerprint: 'fault-exp', resourceClaims: claims });
    const d = (await h.control.tick(run.runId)).dispatched.find((x) => x.workItemId === item.workItemId)!;
    assert.ok(d, 'admitted');
    const types = async () => (await h.deps.events.read(run.runId, { types: ['admission.granted', 'admission.refused', 'admission.lapsed'] })).map((e) => `${e.eventType}:${(e.payload as { workItemId: string }).workItemId}`);
    assert.deepEqual(await types(), [`admission.granted:${item.workItemId}`]);
    // a second item wanting the same resource is refused (recorded once, not every tick)
    const rival = await directItem(h, run.runId, { fingerprint: 'rival', resourceClaims: claims, priority: 1 });
    await h.control.tick(run.runId);
    await h.control.tick(run.runId);
    assert.deepEqual((await types()).filter((t) => t.startsWith('admission.refused')), [`admission.refused:${rival.workItemId}`]);
    // the holder's work lease is kept alive, but its resource claims lapse (e.g. a stall) and another holder takes them
    const held = (await h.deps.blackboard.getWorkItem(item.workItemId))!;
    h.clock.advance(40_000);
    await h.deps.leases.renew(held.claim!.leaseId, 60_000);
    h.clock.advance(30_000);
    const other = await h.deps.admission.admit({ holderId: 'other-run-item', runId: 'run_other', claims, ttlMs: 60_000 });
    assert.equal(other.admitted, true);
    const turnsBefore = h.calls.length;
    const o = await h.control.executeTurn(item.workItemId, d.fencingToken);
    assert.equal(o.status, 'lease_lost', 'no turn runs on resources held by another holder');
    assert.equal(h.calls.length, turnsBefore, 'no model call was made');
    const after = (await h.deps.blackboard.getWorkItem(item.workItemId))!;
    assert.equal(after.state, 'ready', 'the claim is given back');
    assert.equal(after.attempts, 0);
    assert.ok((await types()).includes(`admission.lapsed:${item.workItemId}`));
  });
});

describe('H7: the independent run review the gate requires is requested before the gate', () => {
  const readyLead: RoleBrain = (v) => {
    if (v.step === 0) return call('plan.propose_revision', { rationale: 'nothing to execute', objectives: [{ objectiveId: 'o', description: 'objective', priority: 'P3', status: 'satisfied' }], workItems: [], readyForGate: true });
    return call('complete_work', { summary: 'ready', output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [] } });
  };
  // the run records no execution evidence here: the reviewer can only ask for more (an approving run review on recorded
  // evidence, C6 satisfied, is the control e2e test's and the PoCs')
  const runReviewer: RoleBrain = (v) => {
    if (v.step === 0) return call('blackboard.post_review', { subjectRef: { kind: 'run', id: v.runId }, verdict: 'needs_more_evidence', rationale: 'the run recorded no execution evidence', checkedEvidenceRefs: [] });
    const rec = parsed(v.lastResult!.content)['recordId'] as string;
    return call('complete_work', { summary: 'needs more evidence', recordRefs: [rec], output: { summary: 'needs more evidence', verdict: 'needs_more_evidence', reviews: [rec], checkedEvidenceIds: [] } });
  };

  test('review.requested (run subject, deterministic id) precedes the gate; the reviewer reacts; the gate counts its review (C6)', async () => {
    const h = await createHarness({ brains: { lead: readyLead, reviewer: runReviewer } });
    try {
      const run = await h.control.startRun({ goal: 'h7 review', target: {} });
      const out = await drive(h, run.runId, 30);
      assert.ok(out.final?.decision, 'converged');
      const l0 = await h.deps.events.read(run.runId);
      const requested = l0.filter((e) => e.eventType === 'review.requested');
      assert.equal(requested.length, 1);
      assert.equal(requested[0]!.eventId, runReviewRequestEventId(run.runId, 1));
      assert.deepEqual((requested[0]!.payload as { subjectRef: unknown }).subjectRef, { kind: 'run', id: run.runId });
      const gated = l0.find((e) => e.eventType === 'gate.evaluated')!;
      assert.ok(requested[0]!.seq! < gated.seq!, 'requested before the gate');
      const reviewer = (await items(h, run.runId)).find((w) => w.role === 'reviewer')!;
      assert.equal(reviewer.state, 'completed');
      assert.equal(reviewer.causationEventId, requested[0]!.eventId);
      const [review] = await h.deps.blackboard.query({ runId: run.runId, recordType: 'review' });
      const c6 = out.final.decision.unknownCriteria.find((c) => c.criterionId === 'C6');
      assert.ok(c6 && c6.detail?.includes(review!.recordId), `C6 judged the run review: ${JSON.stringify(c6)}`);
      // one request only: the gate attempt after the feedback replan finds the run review and asks for none
    } finally {
      await h.dispose();
    }
  });

  test('not requested when the gate does not require it; requested once per gate attempt when the review never comes (the gate fails safe)', async () => {
    const h = await createHarness({ brains: { lead: readyLead } });
    try {
      const off = await h.control.startRun({ goal: 'no review required', target: {}, gate: { requireIndependentReview: false }, gateOverrideBy: { kind: 'human', id: 'qa-lead' }, gateOverrideRationale: 'no reviewer model in this deployment' });
      assert.ok((await drive(h, off.runId, 30)).final);
      assert.deepEqual(await h.deps.events.read(off.runId, { types: ['review.requested'] }), []);
      // no reviewer brain: the review work fails; the gate evaluates anyway and reports C6 (no livelock)
      const on = await h.control.startRun({ goal: 'review never comes', target: {} });
      const out = await drive(h, on.runId, 60);
      assert.ok(out.final?.decision, 'converged without the review');
      const c6 = [...out.final.decision.violatedCriteria, ...out.final.decision.unknownCriteria].find((c) => c.criterionId === 'C6');
      assert.ok(c6, 'C6 is not satisfied');
      const requested = await h.deps.events.read(on.runId, { types: ['review.requested'] });
      const attempts = (await h.deps.events.read(on.runId, { types: ['gate.evaluated'] })).length;
      assert.ok(requested.length >= 1 && requested.length <= attempts, `${requested.length} request(s) for ${attempts} gate attempt(s)`);
      assert.equal(new Set(requested.map((e) => e.eventId)).size, requested.length);
    } finally {
      await h.dispose();
    }
  });
});

describe('durability-9: a dispatch names the turn its session runs next', () => {
  test('nextTurn is 1 for a new agent and last committed turn + 1 for a requeued item', async () => {
    const h = await createHarness({ brains: readingLead() });
    try {
      const run = await h.control.startRun({ goal: 'next turn', target: {} });
      const first = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.equal(first.nextTurn, 1);
      assert.equal((await h.control.executeTurn(first.workItemId, first.fencingToken, undefined, { expectedTurn: first.nextTurn! })).status, 'continue');
      // the worker vanishes; the item is requeued and dispatched again: its session continues at turn 2
      await h.control.scheduler.requeue((await h.deps.blackboard.getWorkItem(first.workItemId))!, h.ctx(run.runId), 'test: worker lost', first.fencingToken);
      const again = (await h.control.tick(run.runId)).dispatched.find((d) => d.workItemId === first.workItemId)!;
      assert.equal(again.nextTurn, 2);
      // a retried first call of the new claim (turn 2 committed, the answer lost) does not run turn 3
      assert.equal((await h.control.executeTurn(again.workItemId, again.fencingToken, undefined, { expectedTurn: 2 })).status, 'completed');
      const calls = h.calls.length;
      assert.equal((await h.control.executeTurn(again.workItemId, again.fencingToken, undefined, { expectedTurn: 2 })).status, 'completed');
      assert.equal(h.calls.length, calls);
    } finally {
      await h.dispose();
    }
  });
});

describe('durability-8: cancelRun leaves no open work behind a racing tick', () => {
  test('an item another process claims during the sweep is still cancelled; no work is created for a cancelled run', async () => {
    const h = await createHarness({ brains: readingLead() });
    try {
      const run = await h.control.startRun({ goal: 'cancel race', target: {} });
      const lead = (await items(h, run.runId))[0]!;
      assert.equal(lead.state, 'ready');
      // a tick of another process that read the run before the cancel admits the item exactly while the sweep runs
      const bb = h.deps.blackboard;
      const original = bb.transitionWorkItem.bind(bb);
      let raced = false;
      bb.transitionWorkItem = (async (...args: Parameters<typeof bb.transitionWorkItem>) => {
        if (!raced && args[0] === lead.workItemId && args[1] === 'cancelled') {
          raced = true;
          await original(lead.workItemId, 'claimed', { claim: { ownerId: 'worker:other', leaseId: 'lease_other', fencingToken: 99, expiresAt: '2099-01-01T00:00:00.000Z' } }, h.ctx(run.runId), { expectedFrom: ['ready'] });
        }
        return original(...args);
      }) as typeof bb.transitionWorkItem;
      try {
        await h.control.cancelRun(run.runId, 'operator stop');
      } finally {
        bb.transitionWorkItem = original;
      }
      assert.equal(raced, true);
      assert.deepEqual((await items(h, run.runId)).map((w) => [w.workItemId, w.state]), [[lead.workItemId, 'cancelled']], 'the claimed item was re-read and cancelled, not skipped');
      // a replan or reaction that read the run before the cancel cannot create work after it
      const factory = new WorkFactory(h.deps);
      await rejects(
        factory.create({ runId: run.runId, kind: 'task', role: 'executor', title: 'late', objective: 'late work', fingerprint: 'late-work', origin: { kind: 'system', reason: 'test' }, budget: {} } as never, h.ctx(run.runId)),
        'conflict',
        /is cancelled: no work is created/,
      );
      assert.equal((await items(h, run.runId)).length, 1);
    } finally {
      await h.dispose();
    }
  });
});

describe('durability-11: per-process bookkeeping does not grow with finished work', () => {
  test('the issued-claim set forgets a claim whose item completed; an ended run leaves no idle counter behind', async () => {
    const h = await createHarness({ brains: readingLead() });
    try {
      const run = await h.control.startRun({ goal: 'bookkeeping', target: {} });
      const d = (await h.control.tick(run.runId)).dispatched[0]!;
      assert.equal(h.control.bookkeeping().issuedClaims, 1);
      await h.control.tick(run.runId); // the lead holds the only item: nothing progresses, an idle counter is kept
      assert.equal(h.control.bookkeeping().idleRuns, 1);
      let out = await h.control.executeTurn(d.workItemId, d.fencingToken);
      while (out.status === 'continue') out = await h.control.executeTurn(d.workItemId, d.fencingToken);
      assert.equal(out.status, 'completed');
      assert.equal(h.control.bookkeeping().issuedClaims, 0, 'the completed claim is forgotten');
      await h.control.tick(run.runId);
      await h.control.cancelRun(run.runId, 'done here');
      await h.control.tick(run.runId); // the terminal run's final result
      assert.deepEqual(h.control.bookkeeping(), { issuedClaims: 0, idleRuns: 0 });
    } finally {
      await h.dispose();
    }
  });
});

describe('conformance-4: an oracle superseded during the run', () => {
  const readyLead: RoleBrain = (v) => {
    if (v.step === 0) return call('plan.propose_revision', { rationale: 'nothing to execute', objectives: [{ objectiveId: 'o', description: 'objective', priority: 'P3', status: 'satisfied' }], workItems: [], readyForGate: true });
    return call('complete_work', { summary: 'ready', output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [] } });
  };

  // D-10 (changed with gate-governance: the run used to stay pinned to the superseded revision and the gate reported C0
  // unknown): an approved revision mid-run re-pins the run append-only (run.oracle_repinned on L0), schedules a lead
  // replan (oracle_changed) and the gate judges under the NEW revision — the replaced criterion never decides
  test('an oracle approved mid-run re-pins the run, replans the lead (oracle_changed); the verdict never rests on the replaced criterion', async () => {
    const h = await createHarness({ brains: { lead: readyLead } });
    try {
      const ctx = { ...h.ctx('oracle-setup'), actorId: 'human:alice' };
      const spec = {
        oracleId: 'or_mid', scope: { components: ['cart'], description: 'cart totals' }, status: 'approved' as const, approvedBy: [{ kind: 'human' as const, id: 'alice' }],
        assertions: [{ assertionId: 'total', description: 'totals are exact', kind: 'requirement' as const, severity: 'P1' as const, check: { type: 'test_outcome' as const, testSelector: '*', expected: 'pass' as const } }],
        authorities: [{ sourceRef: 'spec', authority: 'approved_requirement' as const }],
        judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: false },
        changePolicy: { agentMayPropose: true, selfApprove: false as const, invalidatesPriorDecisions: true, approvers: ['human' as const] },
      };
      await h.deps.specs.saveOracle(spec, ctx);
      const run = await h.control.startRun({ goal: 'mid-run oracle change', target: {}, oracleIds: ['or_mid'], gate: { requireIndependentReview: false }, gateOverrideBy: { kind: 'human', id: 'qa-lead' }, gateOverrideRationale: 'no reviewer model in this deployment' });
      assert.deepEqual(run.oracleRevisions, { or_mid: 1 });
      // a human approves a new revision while the run is in flight
      const r2 = await h.deps.specs.saveOracle({ ...spec, assertions: [{ ...spec.assertions[0]!, description: 'totals are exact to the cent' }] }, ctx);
      assert.equal(r2.revision, 2);
      const out = await drive(h, run.runId, 30);
      const decision = out.final!.decision!;
      assert.notEqual(decision.verdict, 'pass');
      assert.deepEqual((await h.deps.runs.get(run.runId))!.oracleRevisions, { or_mid: 2 }, 'the run moved to the approved revision');
      const repinned = await h.deps.events.read(run.runId, { types: ['run.oracle_repinned'] });
      assert.deepEqual(repinned.map((e) => e.payload), [{ oracleId: 'or_mid', from: 1, to: 2 }]);
      const replans = (await items(h, run.runId)).filter((w) => w.kind === 'replan' && /oracle revision changed/.test(w.title));
      assert.equal(replans.length, 1, 'one replan answers the re-pin');
      assert.match(replans[0]!.objective, /or_mid: revision 1 → 2/);
      const triggered = await h.deps.events.read(run.runId, { types: ['replan.triggered'] });
      assert.deepEqual(triggered.map((e) => (e.payload as { reason: string }).reason), ['oracle_changed']);
      assert.deepEqual(decision.oracleRevisions, { or_mid: 2 }, 'the decision names the revision it was judged under');
      assert.ok(!decision.unknownCriteria.some((c) => /superseded/.test(c.detail ?? '')), 'judged under the new revision: nothing rests on the old one');
      // history is not rewritten: revision 1 still exists as it was
      assert.equal((await h.deps.specs.getOracle('or_mid', 1))!.assertions[0]!.description, 'totals are exact');
      // conformance-9: the report names the gate that decided and the run's override of the default gate
      const report = await h.control.report(run.runId);
      assert.match(report.markdown, new RegExp(`- \\*\\*Gate:\\*\\* hypertest\\.default \\(spec ${decision.gateSpecDigest!.slice(0, 16)}; overrides: requireIndependentReview=false\\)`));
    } finally {
      await h.dispose();
    }
  });
});

describe('conformance-11: governed gate waivers', () => {
  const readyLead: RoleBrain = (v) => {
    if (v.step === 0) return call('plan.propose_revision', { rationale: 'nothing to execute', objectives: [{ objectiveId: 'o', description: 'objective', priority: 'P3', status: 'satisfied' }], workItems: [], readyForGate: true });
    return call('complete_work', { summary: 'ready', output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [] } });
  };

  test('a human-approved gate_exception waives its criterion at the gate; an agent-decided one is ignored', async () => {
    const h = await createHarness({ brains: { lead: readyLead } });
    try {
      const run = await h.control.startRun({ goal: 'waiver', target: {}, gate: { requireOracle: false }, gateOverrideBy: { kind: 'human', id: 'qa-lead' }, gateOverrideRationale: 'exploratory run without an established oracle' });
      const ctx = h.ctx(run.runId);
      const human = await h.deps.approvals.request({ runId: run.runId, kind: 'gate_exception', subject: { criterionId: 'C6' }, requestedBy: { kind: 'system', id: 'cli' }, rationale: 'no reviewer route' }, ctx);
      await h.deps.approvals.decide(human.approvalId, true, { kind: 'human', id: 'alice' }, 'no independent reviewer route this week', ctx);
      const byAgent = await h.deps.approvals.request({ runId: run.runId, kind: 'gate_exception', subject: { criterionId: 'C4' }, requestedBy: { kind: 'system', id: 'cli' }, rationale: 'skip evidence' }, ctx);
      await h.deps.approvals.decide(byAgent.approvalId, true, { kind: 'agent', id: 'ag_sneaky', role: 'lead', modelProvider: 'other-provider' }, 'waive it', ctx);
      const expired = await h.deps.approvals.request({ runId: run.runId, kind: 'gate_exception', subject: { criterionId: 'C9', expiresAt: '2000-01-01T00:00:00.000Z' }, requestedBy: { kind: 'system', id: 'cli' }, rationale: 'old' }, ctx);
      await h.deps.approvals.decide(expired.approvalId, true, { kind: 'human', id: 'bob' }, 'old waiver', ctx);
      const out = await drive(h, run.runId, 40);
      const d = out.final!.decision!;
      assert.deepEqual(d.exceptions.map((e) => [e.criterionId, `${e.approvedBy.kind}:${e.approvedBy.id}`, e.rationale]), [['C6', 'human:alice', 'no independent reviewer route this week']]);
      assert.ok(!d.unknownCriteria.some((c) => c.criterionId === 'C6') && !d.violatedCriteria.some((c) => c.criterionId === 'C6'), 'C6 is waived');
      assert.ok(d.reasons.some((r) => /exception for C4 approved by agent ag_sneaky ignored/.test(r)), d.reasons.join('\n'));
    } finally {
      await h.dispose();
    }
  });
});
