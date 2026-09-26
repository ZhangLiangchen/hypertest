/**
 * Unit B2 — experiment isolation and budget leases in the control plane.
 *
 * conformance-6: experiment.define admits its isolation claims atomically (holder = experimentId); a conflict refuses the
 * experiment (not created, holders returned); fixtures / seeds / stop conditions / contamination rules are recorded;
 * write/fault tools of a work item running for an experiment need its claims held (`experiment_claims_missing`); the
 * claims follow their owners (renewed / released each tick) and the run's end. Chaos row "two fault experiments compete".
 *
 * conformance-5: sandbox compute (computeMs) and artifact bytes are charged to the work item and its run; exhaustion is a
 * typed outcome handed to the scheduler (convergence ⇒ budget) or the pause policy; external QPS is reserved across the
 * run's concurrent load jobs and released when a job ends.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { JsonValue } from '@hypertest/core';
import type { ActionCapability, ExperimentSpec, TestRun, WorkItem } from '@hypertest/domain';
import type { ToolExecutionRequest, ToolExecutionResult } from '@hypertest/tools';
import { WorkFactory, createToolDispatcher, runScope, workScope } from '../src/index.ts';
import { call, createHarness, parsed, type Harness, type RoleBrain } from './harness.ts';

const LEAD_OUT: { [k: string]: JsonValue } = { summary: 'lead done', planProposed: false, readyForGate: false, objectives: [] };

function readingLead(): Record<string, RoleBrain> {
  return { lead: (v) => (v.step === 0 ? call('blackboard.read', {}) : call('complete_work', { summary: 'done', output: LEAD_OUT })) };
}

const ENVIRONMENTS = [
  { environmentId: 'svc', environmentClass: 'local', baseUrl: 'http://127.0.0.1:9', generation: 3, buildDigest: 'sha256:build-7', control: { kind: 'process' as const, target: 'svc-main' } },
  { environmentId: 'other', environmentClass: 'local', baseUrl: 'http://127.0.0.1:10', generation: 1 },
];

/** A run whose lead has run one turn: the lead item is running, has an agent, a claim and a tool host. */
async function lead(h: Harness, goal: string, budget: Partial<TestRun['budget']> = {}) {
  const run = await h.control.startRun({ goal, target: {}, budget });
  const t = await h.control.tick(run.runId);
  const d = t.dispatched[0]!;
  assert.equal((await h.control.executeTurn(d.workItemId, d.fencingToken)).status, 'continue');
  const item = (await h.deps.blackboard.getWorkItem(d.workItemId))!;
  const cur = (await h.deps.runs.get(run.runId))!;
  const { agent, spec } = await h.control.worker.ensureAgent(item, cur, d.fencingToken);
  const host = await h.control.worker.buildHost(item, cur, agent, spec, d.fencingToken);
  let turn = 100;
  const dispatch = (name: string, args: JsonValue) => {
    const n = ++turn;
    return host.tools.dispatch({ id: `c${n}`, name: name.replaceAll('.', '__'), arguments: args }, { sessionId: agent.sessionId, turn: n, invocationId: `${agent.sessionId}:${n}:c${n}`, signal: new AbortController().signal });
  };
  return { run: cur, item, token: d.fencingToken, agent, spec, dispatch };
}

function intercept(h: Harness, fn: (req: ToolExecutionRequest) => Promise<ToolExecutionResult | undefined>): () => void {
  const runtime = h.deps.toolRuntime;
  const original = runtime.execute;
  runtime.execute = async (req) => (await fn(req)) ?? original.call(runtime, req);
  return () => {
    runtime.execute = original;
  };
}

function result(req: ToolExecutionRequest, over: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return { toolId: req.toolId, invocationId: req.invocationId, status: 'success', structured: {}, modelText: 'ok', artifactRefs: [], evidenceRefs: [], durationMs: 1, usage: { computeMs: 0, artifactBytes: 0 }, ...over };
}

/**
 * A dispatcher for a work item with extra (black-box) tools offered. The runtime is intercepted in these tests (the
 * extended capability is not re-signed), so what reaches it is observed, never executed for real.
 */
async function dispatcherFor(h: Harness, run: TestRun, item: WorkItem, agentId: string, sessionId: string, capability: ActionCapability, extraTools: string[]) {
  const d = createToolDispatcher(h.deps, {
    runId: run.runId, workItemId: item.workItemId, agentId, role: item.role, sessionId,
    capability: { ...capability, tools: [...capability.tools, ...extraTools], allowedEffects: ['read', 'record', 'write_workspace', 'execute', 'external', 'destructive'] },
    allow: ['blackboard.read', 'experiment.define', ...extraTools], deny: [],
    workspace: await h.deps.workspaces.scratch({ runId: run.runId, workItemId: item.workItemId }),
    eventContext: { runId: run.runId, correlationId: item.workItemId, actorId: agentId, workItemId: item.workItemId, agentId },
    turnState: {},
  });
  let turn = 500;
  return (name: string, args: JsonValue) => {
    const n = ++turn;
    return d.dispatch({ id: `x${n}`, name: name.replaceAll('.', '__'), arguments: args }, { sessionId, turn: n, invocationId: `${sessionId}:${n}:x${n}`, signal: new AbortController().signal });
  };
}

async function eventsOf(h: Harness, runId: string, type: string) {
  return (await h.deps.events.read(runId, { types: [type] })).map((e) => ({ ...e, payload: e.payload as Record<string, unknown> }));
}

// ======================================================================================== experiments (conformance-6)

describe('conformance-6: experiments are bound to admitted claims', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  test('chaos: two fault experiments compete for the same service ⇒ admission rejects one; the rejected experiment is not created and names the holder', async () => {
    const a = await lead(h, 'fault experiment A');
    const b = await lead(h, 'fault experiment B');
    const fault = { kind: 'latency', target: 'payment', params: { ms: 500 } };
    const isolation = { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'service/payment', mode: 'fault_exclusive' }] };
    const okA = await a.dispatch('experiment.define', { hypothesis: 'payment tolerates 500 ms latency', environmentId: 'svc', faultPlan: [fault], isolation });
    assert.equal(okA.message.isError, undefined, String(okA.message.content));
    const expA = String(parsed(String(okA.message.content))['experimentId'] ?? (okA.execution?.structured as Record<string, unknown>)['experimentId']);
    assert.match(expA, /^exp_/);
    assert.deepEqual((await h.deps.admission.held!(expA)).map((c) => [c.claim.resourceKey, c.claim.mode]), [['service/payment', 'fault_exclusive']]);

    const refused = await b.dispatch('experiment.define', { hypothesis: 'payment tolerates dropped connections', environmentId: 'svc', faultPlan: [{ kind: 'error_rate', target: 'payment' }], isolation });
    assert.equal(refused.message.isError, true);
    assert.match(String(refused.message.content), /resource_conflict: experiment not created: its isolation claims conflict with claims held by exp_/);
    assert.ok(String(refused.message.content).includes(expA), 'the conflicting holder is named');
    const s = refused.execution?.structured as { holders: string[]; admitted: boolean };
    assert.deepEqual([s.admitted, s.holders], [false, [expA]]);
    // not created: no spec, not on the run, no experiment.defined, no claims of it
    assert.deepEqual(await h.deps.specs.listExperiments(b.run.runId), []);
    assert.deepEqual((await h.deps.runs.get(b.run.runId))!.experimentIds, []);
    assert.deepEqual(await eventsOf(h, b.run.runId, 'experiment.defined'), []);
    const refusal = await eventsOf(h, b.run.runId, 'admission.refused');
    assert.equal(refusal.length, 1);
    assert.equal(refusal[0]!.aggregateType, 'experiment');
    assert.deepEqual(refusal[0]!.payload['conflicts'], [`service/payment@${expA}`]);
    // A is untouched; a fault experiment on ANOTHER service is admitted
    assert.equal((await h.deps.admission.held!(expA)).length, 1);
    const other = await b.dispatch('experiment.define', { hypothesis: 'orders tolerate latency', environmentId: 'svc', faultPlan: [fault], isolation: { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'service/orders', mode: 'fault_exclusive' }] } });
    assert.equal(other.message.isError, undefined, String(other.message.content));
    const granted = await eventsOf(h, b.run.runId, 'admission.granted');
    assert.equal(granted.length, 1);
    assert.deepEqual(granted[0]!.payload['claims'], [{ resourceKey: 'service/orders', mode: 'fault_exclusive' }]);
  });

  test('records environment generation/build digest, fixtures, a generated (retry-stable) seed, workload, derived stop conditions, contamination rules and default claims', async () => {
    const l = await lead(h, 'load experiment');
    const input = { hypothesis: 'p95 stays under 200 ms at 20 rps', environmentId: 'svc', workload: { kind: 'http_load', ratePerSecond: 20, durationMs: 5_000 }, fixtures: ['dataset/orders-v3', 'dataset/orders-v3'] };
    const r = await l.dispatch('experiment.define', input);
    assert.equal(r.message.isError, undefined, String(r.message.content));
    const out = r.execution!.structured as Record<string, unknown>;
    const spec = (await h.deps.specs.getExperiment(String(out['experimentId'])))!;
    assert.deepEqual(spec.environment, { environmentId: 'svc', environmentClass: 'local', generation: 3, buildDigest: 'sha256:build-7', topologyRef: 'process:svc-main' });
    assert.deepEqual(spec.subjects, [{ role: 'candidate', buildDigest: 'sha256:build-7' }]);
    assert.deepEqual(spec.fixtures, ['dataset/orders-v3']);
    assert.equal(spec.randomSeeds.length, 1);
    assert.match(spec.randomSeeds[0]!, /^[0-9a-f]{16}$/);
    assert.deepEqual(spec.workload, input.workload);
    assert.deepEqual(spec.isolation, { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'env/svc', mode: 'write_exclusive' }] });
    assert.deepEqual(spec.stopConditions, [{ kind: 'duration', value: 5_000 }]);
    assert.deepEqual(spec.contaminationRules.map((c) => c.exclusiveResources), [['env/svc']]);
    assert.match(spec.contaminationRules[0]!.description, /admission-enforced/);
    assert.deepEqual(out['randomSeeds'], spec.randomSeeds);
    assert.deepEqual((await h.deps.admission.held!(spec.experimentId)).map((c) => c.claim), [{ resourceKey: 'env/svc', mode: 'write_exclusive' }]);
    // explicit seeds / stop conditions / contamination rules are recorded as given; an observation-only experiment reads shared
    const obs = await l.dispatch('experiment.define', {
      hypothesis: 'error rate is flat', environmentId: 'other', randomSeeds: ['42'], stopConditions: [{ kind: 'metric_threshold', metric: 'error_rate', value: 0.05 }],
      contaminationRules: [{ description: 'no deploys', exclusiveResources: ['env/other'] }],
    });
    const obsSpec = (await h.deps.specs.getExperiment(String((obs.execution!.structured as Record<string, unknown>)['experimentId'])))!;
    assert.deepEqual([obsSpec.randomSeeds, obsSpec.stopConditions, obsSpec.contaminationRules], [['42'], [{ kind: 'metric_threshold', metric: 'error_rate', value: 0.05 }], [{ description: 'no deploys', exclusiveResources: ['env/other'] }]]);
    assert.deepEqual(obsSpec.isolation, { mode: 'shared_readonly', resourceClaims: [{ resourceKey: 'env/other', mode: 'read_shared' }] });
  });

  test('a replayed definition returns the recorded experiment (same seed) and admits nothing twice', async () => {
    const l = await lead(h, 'replayed define');
    const spec = h.deps.registry.get('experiment.define')!;
    const ctx = {
      runId: l.run.runId, workItemId: l.item.workItemId, agentId: l.agent.agentId, role: 'lead', invocationId: `${l.agent.sessionId}:77:rep`,
      eventContext: { runId: l.run.runId, correlationId: l.item.workItemId, actorId: l.agent.agentId, workItemId: l.item.workItemId, agentId: l.agent.agentId },
      signal: new AbortController().signal, logger: h.logger, environments: h.deps.environments, artifacts: h.deps.artifacts,
    };
    const input = { hypothesis: 'replay', environmentId: 'other', faultPlan: [{ kind: 'restart', target: 'other' }], isolation: { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'service/replay', mode: 'fault_exclusive' }] } };
    const first = await spec.execute(input, ctx as never);
    const second = await spec.execute(input, ctx as never);
    assert.equal(first.status, 'success');
    assert.deepEqual(second.structured, first.structured);
    assert.equal((await h.deps.specs.listExperiments(l.run.runId)).length, 1);
    assert.equal((await eventsOf(h, l.run.runId, 'admission.granted')).length, 1);
  });

  test('isolation that does not cover what the experiment does is refused before anything is admitted', async () => {
    const l = await lead(h, 'bad isolation');
    const cases: Array<[Record<string, JsonValue>, RegExp]> = [
      [{ hypothesis: 'x', environmentId: 'svc', faultPlan: [{ kind: 'latency', target: 'svc' }], isolation: { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'env/svc', mode: 'write_exclusive' }] } }, /fault plan needs a fault_exclusive/],
      [{ hypothesis: 'x', environmentId: 'svc', workload: { kind: 'http_load', ratePerSecond: 5 }, isolation: { mode: 'shared_readonly', resourceClaims: [] } }, /shared_readonly cannot run a workload/],
      [{ hypothesis: 'x', environmentId: 'svc', workload: { kind: 'http_load' }, isolation: { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'env/svc', mode: 'read_shared' }] } }, /workload needs a write_exclusive/],
      [{ hypothesis: 'x', environmentId: 'svc', isolation: { mode: 'shared_readonly', resourceClaims: [{ resourceKey: 'env/svc', mode: 'fault_exclusive' }] } }, /shared_readonly can only hold read_shared/],
    ];
    for (const [input, re] of cases) {
      const r = await l.dispatch('experiment.define', input);
      assert.equal(r.message.isError, true);
      assert.match(String(r.message.content), /isolation_insufficient/);
      assert.match(String(r.message.content), re);
    }
    assert.deepEqual(await h.deps.specs.listExperiments(l.run.runId), []);
    assert.deepEqual((await h.deps.admission.active(l.run.runId)).filter((c) => c.holderId.startsWith('exp_')), []);
  });
});

describe('conformance-6: write/fault tools need the experiment claims held; evidence and operations name the experiment', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  test('a work item running for an experiment: held claims ⇒ runs (request names the experiment); lapsed / taken ⇒ experiment_claims_missing, never executed', async () => {
    const l = await lead(h, 'guarded tools');
    const def = await l.dispatch('experiment.define', { hypothesis: 'svc survives a restart', environmentId: 'svc', faultPlan: [{ kind: 'restart', target: 'svc' }] });
    const expId = String((def.execution!.structured as Record<string, unknown>)['experimentId']);
    // an executor item that declares the experiment
    const factory = new WorkFactory(h.deps);
    const created = await factory.create({
      runId: l.run.runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title: 'run the fault', objective: 'inject the planned fault', role: 'executor',
      objectiveIds: [], capabilityRequirements: [], inputRefs: [{ kind: 'experiment', id: expId }], evidenceRequirements: [], dependsOn: [],
      budget: { maxTurns: 5, maxTokens: 10_000, maxToolCalls: 20, maxWallClockMs: 600_000 }, priority: 10, depth: 0, fingerprint: `fp-guard-${expId}`, resourceClaims: [], state: 'blocked',
    }, h.ctx(l.run.runId));
    const item = created.status === 'created' ? created.workItem : assert.fail('not created');
    await h.deps.budget.open(workScope(item.workItemId), {}, runScope(l.run.runId));
    const seen: ToolExecutionRequest[] = [];
    const restore = intercept(h, async (req) => {
      if (req.workItemId !== item.workItemId) return undefined;
      seen.push(req);
      return result(req);
    });
    try {
      const d = await dispatcherFor(h, l.run, item, 'agent-exec', 'sess-exec', l.spec.capability, ['env.inject_fault', 'env.restart', 'http.request', 'load.stop']);
      const ok = await d('env.restart', { environmentId: 'svc', reason: 'planned' });
      assert.equal(ok.message.isError, undefined, String(ok.message.content));
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.experimentId, expId, 'the call runs for the declared experiment');
      // reads run regardless and are attributed too
      await d('http.request', { method: 'GET', environmentId: 'svc', path: '/health' });
      assert.equal(seen.at(-1)!.experimentId, expId);
      // the claims lapse and another experiment takes them
      h.clock.advance(61_000);
      assert.equal((await h.deps.admission.admit({ holderId: 'exp_intruder', runId: 'run_other', claims: [{ resourceKey: 'env/svc', mode: 'write_exclusive' }], ttlMs: 60_000 })).admitted, true);
      const before = seen.length;
      for (const [name, args] of [['env.restart', { environmentId: 'svc', reason: 'again' }], ['env.inject_fault', { environmentId: 'svc', fault: 'latency' }], ['http.request', { method: 'POST', environmentId: 'svc', path: '/orders', body: '{}' }]] as const) {
        const denied = await d(name, args as unknown as JsonValue);
        assert.equal(denied.message.isError, true);
        assert.match(String(denied.message.content), /\[denied\] experiment_claims_missing: the claims of experiment exp_\w+ are not held \(fault_exclusive\(env\/svc\)/);
      }
      assert.equal(seen.length, before, 'nothing was executed');
      const deniedEvents = (await h.deps.events.read(l.run.runId, { types: ['tool.denied'] })).filter((e) => (e.payload as Record<string, unknown>)['errorCode'] === 'experiment_claims_missing');
      assert.equal(deniedEvents.length, 3);
      // stopping a load job is never blocked (it only ends an effect); reads still run
      await d('load.stop', { operationId: 'op_01J00000000000000000000000' });
      await d('http.request', { method: 'GET', environmentId: 'svc', path: '/health' });
      assert.deepEqual(seen.slice(before).map((r) => r.toolId), ['load.stop', 'http.request']);
    } finally {
      restore();
      await h.deps.admission.release('exp_intruder');
    }
  });

  test('a read-only experiment cannot host writes, and a write experiment cannot host faults', async () => {
    const l = await lead(h, 'mode checks');
    const ro = await l.dispatch('experiment.define', { hypothesis: 'observe only', environmentId: 'other' });
    const wr = await l.dispatch('experiment.define', { hypothesis: 'load', environmentId: 'svc', workload: { kind: 'http_load', ratePerSecond: 1 } });
    const roId = String((ro.execution!.structured as Record<string, unknown>)['experimentId']);
    const wrId = String((wr.execution!.structured as Record<string, unknown>)['experimentId']);
    const factory = new WorkFactory(h.deps);
    const mk = async (expId: string) => {
      const c = await factory.create({
        runId: l.run.runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title: `for ${expId}`, objective: `run ${expId}`, role: 'executor', objectiveIds: [], capabilityRequirements: [],
        inputRefs: [{ kind: 'experiment', id: expId }], evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 5, maxTokens: 10_000, maxToolCalls: 20, maxWallClockMs: 600_000 },
        priority: 10, depth: 0, fingerprint: `fp-mode-${expId}`, resourceClaims: [], state: 'blocked',
      }, h.ctx(l.run.runId));
      const w = c.status === 'created' ? c.workItem : assert.fail('not created');
      await h.deps.budget.open(workScope(w.workItemId), {}, runScope(l.run.runId));
      return w;
    };
    const restore = intercept(h, async (req) => (req.workItemId === l.item.workItemId ? undefined : result(req)));
    try {
      const dRo = await dispatcherFor(h, l.run, await mk(roId), 'agent-ro', 'sess-ro', l.spec.capability, ['http.request']);
      const post = await dRo('http.request', { method: 'POST', environmentId: 'other', path: '/x', body: '{}' });
      assert.match(String(post.message.content), /experiment_claims_missing: experiment exp_\w+ holds no write_exclusive or fault_exclusive claim/);
      const dWr = await dispatcherFor(h, l.run, await mk(wrId), 'agent-wr', 'sess-wr', l.spec.capability, ['env.inject_fault', 'http.request']);
      const fault = await dWr('env.inject_fault', { environmentId: 'svc', fault: 'latency' });
      assert.match(String(fault.message.content), /experiment_claims_missing: experiment exp_\w+ holds no fault_exclusive claim/);
      const write = await dWr('http.request', { method: 'POST', environmentId: 'svc', path: '/x', body: '{}' });
      assert.equal(write.message.isError, undefined, String(write.message.content));
      // an item declaring an experiment that does not exist in the run never writes
      const dGhost = await dispatcherFor(h, l.run, await mk('exp_ghost'), 'agent-gh', 'sess-gh', l.spec.capability, ['http.request']);
      assert.match(String((await dGhost('http.request', { method: 'POST', environmentId: 'svc', path: '/x', body: '{}' })).message.content), /experiment exp_ghost does not exist in run/);
    } finally {
      restore();
    }
  });
});

describe('conformance-6: experiment claims follow their owners and the run', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  async function declaring(runId: string, expId: string, fp: string): Promise<WorkItem> {
    const c = await new WorkFactory(h.deps).create({
      runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title: 'declares', objective: `declares ${fp}`, role: 'executor', objectiveIds: [], capabilityRequirements: [],
      inputRefs: [{ kind: 'experiment', id: expId }], evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 5, maxTokens: 10_000, maxToolCalls: 20, maxWallClockMs: 6_000_000 },
      priority: 10, depth: 0, fingerprint: fp, resourceClaims: [], state: 'ready',
    }, h.ctx(runId));
    return c.status === 'created' ? c.workItem : assert.fail('not created');
  }

  test('renewed while an owner is live (also re-admitted after a TTL gap), released when the owners ended; a renewal taken by another holder is recorded as lapsed', async () => {
    const l = await lead(h, 'owner lifecycle');
    const def = await l.dispatch('experiment.define', { hypothesis: 'h', environmentId: 'svc', faultPlan: [{ kind: 'latency', target: 'svc' }] });
    const expId = String((def.execution!.structured as Record<string, unknown>)['experimentId']);
    const w = await declaring(l.run.runId, expId, 'fp-owner-1');
    // the defining lead item ends; the declaring item keeps the experiment alive
    await h.deps.blackboard.transitionWorkItem(l.item.workItemId, 'cancelled', { failure: { reason: 'cancelled', message: 'test' } }, h.ctx(l.run.runId), { expectedFencingToken: l.token });
    h.clock.advance(70_000); // past the TTL: the claims expired
    assert.deepEqual(await h.deps.admission.held!(expId), []);
    await h.control.tick(l.run.runId);
    assert.deepEqual((await h.deps.admission.held!(expId)).map((c) => c.claim.mode), ['fault_exclusive'], 're-admitted: an owner is live');
    // lapse: the claims expire and another holder takes them; the renewal is refused and recorded (once)
    h.clock.advance(70_000);
    await h.deps.admission.admit({ holderId: 'exp_thief', runId: 'run_thief', claims: [{ resourceKey: 'env/svc', mode: 'read_shared' }], ttlMs: 600_000 });
    await h.control.tick(l.run.runId);
    await h.control.tick(l.run.runId);
    const lapsed = (await eventsOf(h, l.run.runId, 'admission.lapsed')).filter((e) => e.aggregateType === 'experiment');
    assert.equal(lapsed.length, 1);
    assert.deepEqual([lapsed[0]!.payload['experimentId'], lapsed[0]!.payload['conflicts'], lapsed[0]!.payload['phase']], [expId, ['env/svc@exp_thief'], 'experiment_renewal']);
    await h.deps.admission.release('exp_thief');
    await h.control.tick(l.run.runId);
    assert.equal((await h.deps.admission.held!(expId)).length, 1, 'renewed once the thief left');
    // the last owner ends ⇒ released at the next tick, with an audit event
    const cur = (await h.deps.blackboard.getWorkItem(w.workItemId))!;
    assert.ok(['ready', 'claimed'].includes(cur.state), `the declaring item is still live (${cur.state})`);
    await h.deps.blackboard.transitionWorkItem(w.workItemId, 'cancelled', { failure: { reason: 'cancelled', message: 'test' } }, h.ctx(l.run.runId), {
      expectedFrom: [cur.state], ...(cur.claim ? { expectedFencingToken: cur.claim.fencingToken } : {}),
    });
    await h.control.tick(l.run.runId);
    assert.deepEqual(await h.deps.admission.held!(expId), []);
    const released = await eventsOf(h, l.run.runId, 'admission.released');
    assert.deepEqual(released.map((e) => [e.payload['experimentId'], e.payload['reason']]), [[expId, 'owners_ended']]);
  });

  test('the run\'s end releases every experiment claim (cancelRun) — the next experiment on the resource is admitted', async () => {
    const l = await lead(h, 'run end');
    const def = await l.dispatch('experiment.define', { hypothesis: 'h', environmentId: 'other', faultPlan: [{ kind: 'latency', target: 'other' }] });
    const expId = String((def.execution!.structured as Record<string, unknown>)['experimentId']);
    assert.equal((await h.deps.admission.held!(expId)).length, 1);
    const l2 = await lead(h, 'waiting for the resource');
    const blocked = await l2.dispatch('experiment.define', { hypothesis: 'h2', environmentId: 'other', faultPlan: [{ kind: 'latency', target: 'other' }] });
    assert.match(String(blocked.message.content), /resource_conflict/);
    await h.control.cancelRun(l.run.runId, 'test');
    assert.deepEqual(await h.deps.admission.held!(expId), []);
    assert.deepEqual((await eventsOf(h, l.run.runId, 'admission.released')).map((e) => e.payload['reason']), ['run_ended']);
    const admitted = await l2.dispatch('experiment.define', { hypothesis: 'h2', environmentId: 'other', faultPlan: [{ kind: 'latency', target: 'other' }] });
    assert.equal(admitted.message.isError, undefined, String(admitted.message.content));
  });
});

describe('conformance-6: work items running for an experiment share its claims; a foreign experiment id shares nothing', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  async function item(runId: string, expId: string, fp: string): Promise<WorkItem> {
    const c = await new WorkFactory(h.deps).create({
      runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title: 'with claims', objective: `claims ${fp}`, role: 'executor', objectiveIds: [], capabilityRequirements: [],
      inputRefs: [{ kind: 'experiment', id: expId }], evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 5, maxTokens: 10_000, maxToolCalls: 20, maxWallClockMs: 6_000_000 },
      priority: 90, depth: 0, fingerprint: fp, resourceClaims: [{ resourceKey: 'env/svc', mode: 'write_exclusive' }], state: 'ready',
    }, h.ctx(runId));
    return c.status === 'created' ? c.workItem : assert.fail('not created');
  }

  test('same run: the item\'s overlapping claims are admitted next to its experiment; another run declaring the id is refused and never attributed', async () => {
    const a = await lead(h, 'owner run');
    const def = await a.dispatch('experiment.define', { hypothesis: 'h', environmentId: 'svc', faultPlan: [{ kind: 'latency', target: 'svc' }] });
    const expId = String((def.execution!.structured as Record<string, unknown>)['experimentId']);
    const mine = await item(a.run.runId, expId, 'fp-share-mine');
    const t = await h.control.tick(a.run.runId);
    assert.ok(t.dispatched.some((d) => d.workItemId === mine.workItemId), 'admitted: it runs for the experiment holding the resource');
    // run B: an item that names run A's experiment gets no share of its claims
    const b = await lead(h, 'foreign run');
    const foreign = await item(b.run.runId, expId, 'fp-share-foreign');
    const tb = await h.control.tick(b.run.runId);
    assert.ok(!tb.dispatched.some((d) => d.workItemId === foreign.workItemId), 'refused: another run\'s experiment is not its own');
    const refused = (await eventsOf(h, b.run.runId, 'admission.refused')).filter((e) => e.aggregateId === foreign.workItemId);
    assert.equal(refused.length, 1);
    assert.ok((refused[0]!.payload['conflicts'] as string[]).includes(`env/svc@${expId}`));
    // and a call of that item is never attributed to (nor allowed to write for) the foreign experiment
    await h.deps.budget.open(workScope(foreign.workItemId), {}, runScope(b.run.runId));
    const seen: ToolExecutionRequest[] = [];
    const restore = intercept(h, async (req) => {
      if (req.workItemId !== foreign.workItemId) return undefined;
      seen.push(req);
      return result(req);
    });
    try {
      const d = await dispatcherFor(h, b.run, foreign, 'agent-foreign', 'sess-foreign', b.spec.capability, ['http.request']);
      await d('http.request', { method: 'GET', environmentId: 'svc', path: '/' });
      assert.equal(seen[0]!.experimentId, undefined);
      const post = await d('http.request', { method: 'POST', environmentId: 'svc', path: '/', body: '{}' });
      assert.match(String(post.message.content), new RegExp(`experiment_claims_missing: experiment ${expId} does not exist in run ${b.run.runId}`));
    } finally {
      restore();
    }
  });
});

// ======================================================================================== budgets (conformance-5)

describe('conformance-5: compute and artifact bytes are charged; exhaustion is typed and handed to the scheduler / pause policy', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  test('startRun opens the run scope with computeMs, artifactBytes and externalQps limits', async () => {
    const run = await h.control.startRun({ goal: 'limits', target: {}, budget: { maxComputeMinutes: 1.5, maxArtifactBytes: 2048, maxExternalQps: 40 } });
    const u = await h.deps.budget.usage(runScope(run.runId));
    assert.deepEqual([u?.limits.computeMs, u?.limits.artifactBytes, u?.limits.externalQps], [90_000, 2048, 40]);
  });

  test('real metering end to end: a tool that runs sandbox processes charges its wall time to the work item and the run', async () => {
    const l = await lead(h, 'real compute', { maxComputeMinutes: 60 });
    const r = await l.dispatch('fs.search', { pattern: 'anything' });
    const usage = r.execution?.usage;
    assert.ok(usage, 'the runtime reports usage');
    const runUsed = (await h.deps.budget.usage(runScope(l.run.runId)))?.used.computeMs ?? 0;
    const workUsed = (await h.deps.budget.usage(workScope(l.item.workItemId)))?.used.computeMs ?? 0;
    assert.equal(runUsed, usage!.computeMs);
    assert.equal(workUsed, usage!.computeMs);
    if (usage!.computeMs === 0) assert.equal(r.message.isError, true, 'no process ran only when the call failed before running one');
  });

  test('compute: headroom caps the call; spent compute is recorded in full, typed exhaustion ⇒ further execute tools refused before running ⇒ convergence reports budget', async () => {
    const l = await lead(h, 'compute budget', { maxComputeMinutes: 0.001 }); // 60 ms
    const seen: ToolExecutionRequest[] = [];
    const restore = intercept(h, async (req) => {
      if (req.toolId !== 'shell.exec') return undefined;
      seen.push(req);
      return result(req, { usage: { computeMs: 95, artifactBytes: 0 } });
    });
    try {
      const d = await dispatcherFor(h, l.run, l.item, l.agent.agentId, l.agent.sessionId, l.spec.capability, ['shell.exec']);
      const first = await d('shell.exec', { command: ['ls'] });
      assert.equal(seen[0]!.timeoutMs, 60, 'the call is capped at the compute left');
      assert.match(String(first.message.content), /\[budget_exhausted: the compute budget of run:\S+ is spent \(95\/60 ms of sandbox time\)/);
      assert.equal((await h.deps.budget.usage(runScope(l.run.runId)))?.used.computeMs, 95, 'recorded in full, never refused');
      const second = await d('shell.exec', { command: ['ls'] });
      assert.equal(second.message.isError, true);
      assert.match(String(second.message.content), /\[denied\] budget_exhausted: the compute budget of run:\S+ is spent/);
      assert.equal(seen.length, 1, 'refused before it ran');
      // a read tool still runs (it is not an execution tool)
      assert.equal((await l.dispatch('blackboard.read', {})).message.isError, undefined);
      const exhausted = (await eventsOf(h, l.run.runId, 'budget.exhausted')).filter((e) => e.payload['reason'] === 'compute');
      assert.equal(exhausted.length, 2);
      assert.deepEqual([exhausted[0]!.payload['dimension'], exhausted[0]!.payload['scope'], exhausted[0]!.payload['used'], exhausted[0]!.payload['limit']], ['computeMs', runScope(l.run.runId), 95, 60]);
      assert.equal(await h.control.convergence.exhaustion((await h.deps.runs.get(l.run.runId))!), 'budget', 'the scheduler stops admitting and gates (never a silent downgrade)');
      assert.equal((await h.deps.runs.get(l.run.runId))!.status, 'running', 'default policy: gate, not pause');
    } finally {
      restore();
    }
  });

  test('artifact bytes: the headroom bounds the call (limits.maxArtifactBytes); recorded usage past the limit ⇒ budget.exhausted; a refused put is recorded too', async () => {
    const l = await lead(h, 'artifact budget', { maxArtifactBytes: 1000 });
    const seen: ToolExecutionRequest[] = [];
    let mode: 'over' | 'refused' = 'over';
    const restore = intercept(h, async (req) => {
      if (req.toolId !== 'fs.search') return undefined;
      seen.push(req);
      return mode === 'over'
        ? result(req, { usage: { computeMs: 0, artifactBytes: 1500 } })
        : result(req, { status: 'failed', error: { code: 'budget_exhausted', message: 'artifact budget exhausted' }, modelText: '[failed] budget_exhausted' });
    });
    try {
      const d = await dispatcherFor(h, l.run, l.item, l.agent.agentId, l.agent.sessionId, l.spec.capability, ['fs.search']);
      const r = await d('fs.search', { pattern: 'x' });
      assert.deepEqual(seen[0]!.limits, { maxArtifactBytes: 1000 });
      assert.match(String(r.message.content), /\[budget_exhausted: the artifact budget of run:\S+ is spent \(1500\/1000 bytes\)/);
      mode = 'refused';
      await d('fs.search', { pattern: 'y' });
      assert.deepEqual(seen[1]!.limits, { maxArtifactBytes: 0 });
      const ev = (await eventsOf(h, l.run.runId, 'budget.exhausted')).filter((e) => e.payload['reason'] === 'artifact_bytes');
      assert.equal(ev.length, 2);
      assert.equal(await h.control.convergence.exhaustion((await h.deps.runs.get(l.run.runId))!), 'budget');
    } finally {
      restore();
    }
  });
});

describe('conformance-5: onBudgetExhausted pause — a run-scope compute exhaustion pauses the run', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS, config: { onBudgetExhausted: 'pause' } });
  });
  after(async () => h.dispose());

  test('the run is paused (pauseReason budget), not silently continued', async () => {
    const l = await lead(h, 'pause on compute', { maxComputeMinutes: 0.001 });
    const restore = intercept(h, async (req) => (req.toolId === 'shell.exec' ? result(req, { usage: { computeMs: 500, artifactBytes: 0 } }) : undefined));
    try {
      const d = await dispatcherFor(h, l.run, l.item, l.agent.agentId, l.agent.sessionId, l.spec.capability, ['shell.exec']);
      await d('shell.exec', { command: ['ls'] });
      const run = (await h.deps.runs.get(l.run.runId))!;
      assert.deepEqual([run.status, run.pauseReason], ['paused', 'budget']);
    } finally {
      restore();
    }
  });
});

describe('conformance-5: external QPS is reserved across concurrent load jobs and released when a job ends', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  test('a second concurrent job over the cap is refused (typed); ending jobs (settled, stopped, never started) free their rate; the run end frees the rest', async () => {
    const l = await lead(h, 'qps', { maxExternalQps: 100 });
    const ops = new Map<string, string>();
    let startOutcome: 'running' | 'not_applied' = 'running';
    const restore = intercept(h, async (req) => {
      if (req.toolId === 'load.start') {
        const op = await h.deps.ledger.prepare({
          runId: req.runId, workItemId: req.workItemId, toolInvocationId: req.invocationId, operationType: 'load.start', adapterId: 'load.http',
          target: { resourceKey: 'loadgen/127.0.0.1:9', kind: 'load_job' }, desiredStateHash: `d-${req.invocationId}`, inputHash: `i-${req.invocationId}`,
        }, req.eventContext);
        ops.set(req.invocationId, op.operationId);
        if (startOutcome === 'not_applied') {
          await h.deps.ledger.transition(op.operationId, 'not_applied', { lastError: 'quota' }, req.eventContext);
          return result(req, { status: 'failed', operationId: op.operationId, structured: { operationId: op.operationId, operationStatus: 'not_applied' }, error: { code: 'not_applied', message: 'quota' } });
        }
        await h.deps.ledger.transition(op.operationId, 'dispatching', {}, req.eventContext);
        await h.deps.ledger.transition(op.operationId, 'acknowledged', { externalJobId: op.operationId }, req.eventContext);
        return result(req, { status: 'pending', operationId: op.operationId, structured: { operationId: op.operationId, operationStatus: 'acknowledged' } });
      }
      if (req.toolId === 'load.stop' || req.toolId === 'load.observe') return result(req);
      return undefined;
    });
    const reserved = async () => (await h.deps.budget.usage(runScope(l.run.runId)))?.reserved.externalQps ?? 0;
    const load = (rate: number) => ({ method: 'GET', environmentId: 'svc', path: '/', ratePerSecond: rate, durationMs: 60_000 });
    try {
      const d = await dispatcherFor(h, l.run, l.item, l.agent.agentId, l.agent.sessionId, l.spec.capability, ['load.start', 'load.stop', 'load.observe']);
      const a = await d('load.start', load(60));
      assert.equal(a.message.isError, undefined, String(a.message.content));
      assert.equal(await reserved(), 60, 'the running job holds its rate');
      const b = await d('load.start', load(50));
      assert.equal(b.message.isError, true);
      assert.match(String(b.message.content), /\[denied\] external_qps_exhausted: running load jobs of this run already hold 60 of its maxExternalQps 100 requests per second; 50 more do not fit \(40 left\)/);
      assert.equal(ops.size, 1, 'the refused job never started');
      const qpsEvent = (await eventsOf(h, l.run.runId, 'budget.exhausted')).find((e) => e.payload['reason'] === 'external_qps');
      assert.deepEqual([qpsEvent?.payload['dimension'], qpsEvent?.payload['reserved'], qpsEvent?.payload['requested']], ['externalQps', 60, 50]);
      assert.equal(await h.control.convergence.exhaustion((await h.deps.runs.get(l.run.runId))!), undefined, 'a transient rate refusal never exhausts the run');
      // the tick keeps the rate of a job that still runs
      await h.control.tick(l.run.runId);
      assert.equal(await reserved(), 60);
      // job A completes (its operation verifies): the next tick gives the rate back
      const opA = [...ops.values()][0]!;
      await h.deps.ledger.transition(opA, 'verified', { result: { state: 'completed' } }, h.ctx(l.run.runId));
      await h.control.tick(l.run.runId);
      assert.equal(await reserved(), 0);
      // now B fits; stopping it frees its rate at once
      const b2 = await d('load.start', load(50));
      assert.equal(b2.message.isError, undefined, String(b2.message.content));
      assert.equal(await reserved(), 50);
      const opB = [...ops.values()][1]!;
      await d('load.stop', { operationId: opB });
      assert.equal(await reserved(), 0, 'a verified load.stop ends the job');
      // a job that was never applied holds nothing
      startOutcome = 'not_applied';
      await d('load.start', load(30));
      assert.equal(await reserved(), 0);
      // load.observe finding a settled job frees its rate
      startOutcome = 'running';
      await d('load.start', load(70));
      const opC = [...ops.values()][3]!;
      await h.deps.ledger.transition(opC, 'failed', { lastError: 'stopped' }, h.ctx(l.run.runId));
      await d('load.observe', { operationId: opC });
      assert.equal(await reserved(), 0);
      // the run's end frees whatever is still reserved
      await d('load.start', load(20));
      assert.equal(await reserved(), 20);
      await h.control.cancelRun(l.run.runId, 'test');
      assert.equal(await reserved(), 0);
    } finally {
      restore();
    }
  });
});
