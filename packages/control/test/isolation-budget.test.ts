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
import { WorkFactory, createControlPlane, createToolDispatcher, runScope, workScope } from '../src/index.ts';
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

/**
 * (D-4) Load against an environment runs only for an experiment that declares the workload: the lead defines one (its
 * later load.start calls are attributed to it). Defined through the lead's host: define it before another dispatcher's
 * first call (a dispatcher reads its item's experiments at its first call, and again only after its own experiment.define).
 */
async function loadExperiment(l: { dispatch: (name: string, args: JsonValue) => Promise<{ message: { isError?: boolean; content: unknown }; execution?: ToolExecutionResult }> }, ratePerSecond: number, durationMs: number): Promise<string> {
  const r = await l.dispatch('experiment.define', { hypothesis: `the service holds ${ratePerSecond} rps`, environmentId: 'svc', workload: { kind: 'http_load', ratePerSecond, durationMs } });
  assert.equal(r.message.isError, undefined, String(r.message.content));
  return String((r.execution!.structured as Record<string, unknown>)['experimentId']);
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

  test('chaos (concurrent): two fault experiments defined at the same time on the same service ⇒ exactly one is admitted and created', async () => {
    const a = await lead(h, 'concurrent fault A');
    const b = await lead(h, 'concurrent fault B');
    const isolation = { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'service/inventory', mode: 'fault_exclusive' }] };
    const [ra, rb] = await Promise.all([
      a.dispatch('experiment.define', { hypothesis: 'inventory tolerates latency', environmentId: 'svc', faultPlan: [{ kind: 'latency', target: 'inventory' }], isolation }),
      b.dispatch('experiment.define', { hypothesis: 'inventory tolerates a kill', environmentId: 'svc', faultPlan: [{ kind: 'process_kill', target: 'inventory' }], isolation }),
    ]);
    const outcomes = [ra, rb].map((r) => (r.message.isError ? 'refused' : 'admitted')).sort();
    assert.deepEqual(outcomes, ['admitted', 'refused'], `${String(ra.message.content)}\n${String(rb.message.content)}`);
    const [winner, loser] = ra.message.isError ? [b, a] : [a, b];
    const loserResult = ra.message.isError ? ra : rb;
    assert.match(String(loserResult.message.content), /resource_conflict: experiment not created/);
    const created = await h.deps.specs.listExperiments(winner.run.runId);
    assert.equal(created.length, 1);
    assert.deepEqual(await h.deps.specs.listExperiments(loser.run.runId), []);
    const holders = (await h.deps.admission.active()).filter((c) => c.claim.resourceKey === 'service/inventory').map((c) => c.holderId);
    assert.deepEqual(holders, [created[0]!.experimentId], 'one holder of the fault claim, never two');
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
    // D-3/coverage-13: the isolation records its plan — the contamination checks the gate (C10) runs over the experiment
    assert.deepEqual(spec.isolation, {
      mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'env/svc', mode: 'write_exclusive' }],
      plan: { dedicatedEnvironment: false, contaminationChecks: [{ kind: 'foreign_operations', resources: ['env/svc'] }, { kind: 'environment_generation' }, { kind: 'exclusive_claims' }] },
    });
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
    assert.deepEqual(obsSpec.isolation, { mode: 'shared_readonly', resourceClaims: [{ resourceKey: 'env/other', mode: 'read_shared' }], plan: { dedicatedEnvironment: false, contaminationChecks: [{ kind: 'foreign_operations', resources: ['env/other'] }, { kind: 'environment_generation' }] } });
    // D-3: a contamination rule beyond the defaults is ENFORCED — its resources become claims admitted with the experiment
    // (write_exclusive for a writing experiment; read_shared for a read-only one, which excludes every writer but never
    // lets the read-only experiment write) — and another holder's write on them is refused at admission
    const ruled = await l.dispatch('experiment.define', {
      hypothesis: 'billing survives load', environmentId: 'svc', workload: { kind: 'http_load', ratePerSecond: 2 },
      isolation: { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'service/billing', mode: 'write_exclusive' }] },
      contaminationRules: [{ description: 'nobody touches the billing database', exclusiveResources: ['db/billing', 'service/billing/api'] }],
    });
    assert.equal(ruled.message.isError, undefined, String(ruled.message.content));
    const ruledSpec = (await h.deps.specs.getExperiment(String((ruled.execution!.structured as Record<string, unknown>)['experimentId'])))!;
    assert.deepEqual(ruledSpec.isolation.resourceClaims, [{ resourceKey: 'service/billing', mode: 'write_exclusive' }, { resourceKey: 'db/billing', mode: 'write_exclusive' }]);
    assert.deepEqual((await h.deps.admission.held!(ruledSpec.experimentId)).map((c) => c.claim.resourceKey).sort(), ['db/billing', 'service/billing']);
    assert.equal((await h.deps.admission.admit({ holderId: 'exp_writer', runId: 'run_other', claims: [{ resourceKey: 'db/billing', mode: 'write_exclusive' }], ttlMs: 60_000 })).admitted, false);
    const roRuled = await l.dispatch('experiment.define', { hypothesis: 'reads are stable', environmentId: 'other', contaminationRules: [{ description: 'no cache writes', exclusiveResources: ['cache/other'] }] });
    const roRuledSpec = (await h.deps.specs.getExperiment(String((roRuled.execution!.structured as Record<string, unknown>)['experimentId'])))!;
    assert.deepEqual(roRuledSpec.isolation.resourceClaims, [{ resourceKey: 'env/other', mode: 'read_shared' }, { resourceKey: 'cache/other', mode: 'read_shared' }]);
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
      await loadExperiment(l, 100, 60_000);
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

describe('conformance-5 × durability-1: recovery keeps the QPS reservation of a load job that outlives its worker', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  test('recover releases the dead turn\'s model reservations but not the rate of its still-running job; a job over the cap stays refused until the job ends', async () => {
    const l = await lead(h, 'qps across a crash', { maxExternalQps: 100 });
    const ops: string[] = [];
    const restore = intercept(h, async (req) => {
      if (req.toolId !== 'load.start') return undefined;
      const op = await h.deps.ledger.prepare({
        runId: req.runId, workItemId: req.workItemId, toolInvocationId: req.invocationId, operationType: 'load.start', adapterId: 'load.http',
        target: { resourceKey: 'loadgen/127.0.0.1:9', kind: 'load_job' }, desiredStateHash: `d-${req.invocationId}`, inputHash: `i-${req.invocationId}`,
      }, req.eventContext);
      ops.push(op.operationId);
      await h.deps.ledger.transition(op.operationId, 'dispatching', {}, req.eventContext);
      await h.deps.ledger.transition(op.operationId, 'acknowledged', { externalJobId: op.operationId }, req.eventContext);
      return result(req, { status: 'pending', operationId: op.operationId, structured: { operationId: op.operationId, operationStatus: 'acknowledged' } });
    });
    const reserved = async () => (await h.deps.budget.usage(runScope(l.run.runId)))?.reserved ?? {};
    const load = (rate: number) => ({ method: 'GET', environmentId: 'svc', path: '/', ratePerSecond: rate, durationMs: 600_000 });
    try {
      await loadExperiment(l, 100, 600_000);
      const d = await dispatcherFor(h, l.run, l.item, l.agent.agentId, l.agent.sessionId, l.spec.capability, ['load.start']);
      const started = await d('load.start', load(60));
      assert.equal(started.message.isError, undefined, String(started.message.content));
      // worker-1 then reserved its next model call and died with both open
      const turn = await h.deps.budget.reserve([workScope(l.item.workItemId)], { tokens: 1000 }, 'model call of a turn that never returned');
      assert.equal(turn.ok, true);
      assert.deepEqual([(await reserved()).externalQps, (await reserved()).tokens], [60, 1000]);

      const worker2 = createControlPlane({ ...h.deps, config: { ...h.deps.config, workerId: 'worker-2' } });
      h.clock.advance(60_001);
      const report = await worker2.recover(l.run.runId);
      assert.ok(report.requeued.includes(l.item.workItemId), 'the dead worker\'s claim was taken');
      assert.equal((await reserved()).tokens ?? 0, 0, 'the stranded model reservation is released (durability-1)');
      assert.equal((await reserved()).externalQps, 60, 'the job still runs: its rate stays reserved');
      // the job still holds its rate: a second concurrent job above the cap is refused
      // the recovered item keeps its agent (and the experiment that agent defined); worker-2's tick renews the experiment's
      // claims (they lapsed with the dead worker's TTL) — the job itself never stopped
      await worker2.tick(l.run.runId);
      assert.equal((await reserved()).externalQps, 60);
      const d2 = await dispatcherFor(h, l.run, l.item, l.agent.agentId, 'sess-w2', l.spec.capability, ['load.start']);
      const over = await d2('load.start', load(50));
      assert.equal(over.message.isError, true);
      assert.match(String(over.message.content), /\[denied\] external_qps_exhausted: running load jobs of this run already hold 60 of its maxExternalQps 100/);
      assert.equal(ops.length, 1, 'the refused job never started');
      // the recovered job ends ⇒ the next tick gives its rate back
      await worker2.tick(l.run.runId);
      assert.equal((await reserved()).externalQps, 60);
      await h.deps.ledger.transition(ops[0]!, 'verified', { result: { state: 'completed' } }, h.ctx(l.run.runId));
      await worker2.tick(l.run.runId);
      assert.equal((await reserved()).externalQps ?? 0, 0);
    } finally {
      restore();
    }
  });
});

// ======================================================================================== adversarial review (B2)

/** A dispatcher whose calls carry an explicit invocation id (a replay re-dispatches the SAME invocation). */
async function replayableDispatcherFor(h: Harness, run: TestRun, item: WorkItem, agentId: string, sessionId: string, capability: ActionCapability, extraTools: string[]) {
  const d = createToolDispatcher(h.deps, {
    runId: run.runId, workItemId: item.workItemId, agentId, role: item.role, sessionId,
    capability: { ...capability, tools: [...capability.tools, ...extraTools], allowedEffects: ['read', 'record', 'write_workspace', 'execute', 'external', 'destructive'] },
    allow: ['blackboard.read', 'experiment.define', ...extraTools], deny: [],
    workspace: await h.deps.workspaces.scratch({ runId: run.runId, workItemId: item.workItemId }),
    eventContext: { runId: run.runId, correlationId: item.workItemId, actorId: agentId, workItemId: item.workItemId, agentId },
    turnState: {},
  });
  return (name: string, args: JsonValue, invocationId: string) =>
    d.dispatch({ id: invocationId.split(':').at(-1)!, name: name.replaceAll('.', '__'), arguments: args }, { sessionId, turn: 900, invocationId, signal: new AbortController().signal });
}

async function executorFor(h: Harness, runId: string, expIds: string[], fp: string): Promise<WorkItem> {
  const c = await new WorkFactory(h.deps).create({
    runId, kind: 'task', origin: { kind: 'system', reason: 'test' }, title: `for ${expIds.join(',')}`, objective: `run ${fp}`, role: 'executor', objectiveIds: [], capabilityRequirements: [],
    inputRefs: expIds.map((id) => ({ kind: 'experiment' as const, id })), evidenceRequirements: [], dependsOn: [], budget: { maxTurns: 5, maxTokens: 10_000, maxToolCalls: 50, maxWallClockMs: 6_000_000 },
    priority: 10, depth: 0, fingerprint: fp, resourceClaims: [], state: 'blocked',
  }, h.ctx(runId));
  const w = c.status === 'created' ? c.workItem : assert.fail('not created');
  await h.deps.budget.open(workScope(w.workItemId), {}, runScope(runId));
  return w;
}

function expIdOf(r: { execution?: ToolExecutionResult }): string {
  return String((r.execution!.structured as Record<string, unknown>)['experimentId']);
}

describe('review B2 — external QPS is never run on a released reservation', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  const load = (rate: number) => ({ method: 'GET', environmentId: 'svc', path: '/', ratePerSecond: rate, durationMs: 600_000 });

  test('an execution that throws AFTER its job was dispatched keeps the job\'s rate reserved (a second job over the cap stays refused)', async () => {
    const l = await lead(h, 'qps: throw after dispatch', { maxExternalQps: 100 });
    const ops: string[] = [];
    const restore = intercept(h, async (req) => {
      if (req.toolId !== 'load.start') return undefined;
      const op = await h.deps.ledger.prepare({
        runId: req.runId, workItemId: req.workItemId, toolInvocationId: req.invocationId, operationType: 'load.start', adapterId: 'load.http',
        target: { resourceKey: 'loadgen/127.0.0.1:9', kind: 'load_job' }, desiredStateHash: `d-${req.invocationId}`, inputHash: `i-${req.invocationId}`,
      }, req.eventContext);
      ops.push(op.operationId);
      await h.deps.ledger.transition(op.operationId, 'dispatching', {}, req.eventContext);
      await h.deps.ledger.transition(op.operationId, 'acknowledged', { externalJobId: op.operationId }, req.eventContext);
      if (ops.length === 1) throw new Error('event store unavailable after the job was launched');
      return result(req, { status: 'pending', operationId: op.operationId, structured: { operationId: op.operationId, operationStatus: 'acknowledged' } });
    });
    const reserved = async () => (await h.deps.budget.usage(runScope(l.run.runId)))?.reserved.externalQps ?? 0;
    try {
      await loadExperiment(l, 100, 600_000);
      const call = await replayableDispatcherFor(h, l.run, l.item, l.agent.agentId, l.agent.sessionId, l.spec.capability, ['load.start']);
      await assert.rejects(call('load.start', load(60), `${l.agent.sessionId}:900:qa`), /event store unavailable/);
      assert.equal(await reserved(), 60, 'the job runs: its rate stays reserved');
      const over = await call('load.start', load(50), `${l.agent.sessionId}:900:qb`);
      assert.equal(over.message.isError, true);
      assert.match(String(over.message.content), /external_qps_exhausted/);
      assert.equal(ops.length, 1, 'the second job never started');
      // the job ends ⇒ the tick gives the rate back
      await h.deps.ledger.transition(ops[0]!, 'verified', { result: { state: 'completed' } }, h.ctx(l.run.runId));
      await h.control.tick(l.run.runId);
      assert.equal(await reserved(), 0);
    } finally {
      restore();
      await h.control.cancelRun(l.run.runId, 'test done: release the experiment claims');
    }
  });

  test('a replayed load.start whose reservation was already given back reserves its rate again before the job runs', async () => {
    const l = await lead(h, 'qps: replay after release', { maxExternalQps: 100 });
    const ops: string[] = [];
    let attempt = 0;
    const restore = intercept(h, async (req) => {
      if (req.toolId !== 'load.start') return undefined;
      if (req.invocationId.endsWith(':ra') && ++attempt === 1) throw new Error('policy store unavailable (nothing dispatched)');
      const op = await h.deps.ledger.prepare({
        runId: req.runId, workItemId: req.workItemId, toolInvocationId: req.invocationId, operationType: 'load.start', adapterId: 'load.http',
        target: { resourceKey: 'loadgen/127.0.0.1:9', kind: 'load_job' }, desiredStateHash: `d-${req.invocationId}`, inputHash: `i-${req.invocationId}`,
      }, req.eventContext);
      ops.push(op.operationId);
      await h.deps.ledger.transition(op.operationId, 'dispatching', {}, req.eventContext);
      await h.deps.ledger.transition(op.operationId, 'acknowledged', { externalJobId: op.operationId }, req.eventContext);
      return result(req, { status: 'pending', operationId: op.operationId, structured: { operationId: op.operationId, operationStatus: 'acknowledged' } });
    });
    const reserved = async () => (await h.deps.budget.usage(runScope(l.run.runId)))?.reserved.externalQps ?? 0;
    try {
      await loadExperiment(l, 100, 600_000);
      const call = await replayableDispatcherFor(h, l.run, l.item, l.agent.agentId, l.agent.sessionId, l.spec.capability, ['load.start']);
      const inv = `${l.agent.sessionId}:900:ra`;
      await assert.rejects(call('load.start', load(60), inv), /policy store unavailable/);
      assert.equal(await reserved(), 0, 'no job was dispatched: nothing stays reserved');
      // the engine replays the pending call with the SAME invocation id: the job now starts
      const replay = await call('load.start', load(60), inv);
      assert.equal(replay.message.isError, undefined, String(replay.message.content));
      assert.equal(ops.length, 1);
      assert.equal(await reserved(), 60, 'the replayed job holds a live reservation of its rate');
      const over = await call('load.start', load(50), `${l.agent.sessionId}:900:rb`);
      assert.match(String(over.message.content), /external_qps_exhausted: running load jobs of this run already hold 60 of its maxExternalQps 100/);
      assert.equal(ops.length, 1);
      // the re-keyed reservation is still tied to its job: the tick releases it once the job ended
      await h.control.tick(l.run.runId);
      assert.equal(await reserved(), 60);
      await h.deps.ledger.transition(ops[0]!, 'verified', { result: { state: 'completed' } }, h.ctx(l.run.runId));
      await h.control.tick(l.run.runId);
      assert.equal(await reserved(), 0);
    } finally {
      restore();
    }
  });
});

describe('review B2 — a write/fault call acts only on resources its experiment claims', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  test('resources outside the experiment\'s claims are refused (experiment_claims_missing), never executed; covered ones run and name the covering experiment', async () => {
    const l = await lead(h, 'coverage');
    const wr = expIdOf(await l.dispatch('experiment.define', { hypothesis: 'svc holds 5 rps', environmentId: 'svc', workload: { kind: 'http_load', ratePerSecond: 5 } }));
    const payment = expIdOf(await l.dispatch('experiment.define', {
      hypothesis: 'payment tolerates latency', environmentId: 'other', faultPlan: [{ kind: 'latency', target: 'payment' }],
      isolation: { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'service/payment', mode: 'fault_exclusive' }] },
    }));
    const seen: ToolExecutionRequest[] = [];
    const restore = intercept(h, async (req) => {
      if (req.workItemId === l.item.workItemId) return undefined;
      seen.push(req);
      return result(req);
    });
    try {
      const w = await executorFor(h, l.run.runId, [wr], 'fp-cover-wr');
      const d = await dispatcherFor(h, l.run, w, 'agent-cov', 'sess-cov', l.spec.capability, ['http.request', 'load.start', 'env.restart']);
      const ok = await d('http.request', { method: 'POST', environmentId: 'svc', path: '/orders', body: '{}' });
      assert.equal(ok.message.isError, undefined, String(ok.message.content));
      assert.equal(seen.length, 1);
      const cases: Array<[string, JsonValue, RegExp]> = [
        ['http.request', { method: 'POST', environmentId: 'other', path: '/orders', body: '{}' }, /env\/other is outside the claims of experiment/],
        ['env.restart', { environmentId: 'other', reason: 'x' }, /env\/other is outside the claims of experiment/],
        ['load.start', { method: 'GET', targetUrl: 'http://127.0.0.1:11/', ratePerSecond: 1, durationMs: 1000 }, /url\/127\.0\.0\.1:11 is outside the claims of experiment/],
        // the URL of ANOTHER registered environment is that environment: not covered
        ['http.request', { method: 'POST', url: 'http://127.0.0.1:10/orders', body: '{}' }, /url\/127\.0\.0\.1:10 is outside the claims of experiment/],
      ];
      for (const [name, args, re] of cases) {
        const denied = await d(name, args);
        assert.equal(denied.message.isError, true, `${name} ${JSON.stringify(args)}`);
        assert.match(String(denied.message.content), /\[denied\] experiment_claims_missing: /);
        assert.match(String(denied.message.content), re);
      }
      assert.equal(seen.length, 1, 'nothing outside the claims was executed');
      // the claimed environment addressed by its URL is covered (the same system under test)
      const byUrl = await d('http.request', { method: 'POST', url: 'http://127.0.0.1:9/orders', body: '{}' });
      assert.equal(byUrl.message.isError, undefined, String(byUrl.message.content));
      assert.equal(seen.length, 2);
      // a fault experiment whose claims name an abstract service does not cover the environment the fault tool acts on
      const wf = await executorFor(h, l.run.runId, [payment], 'fp-cover-fault');
      const df = await dispatcherFor(h, l.run, wf, 'agent-covf', 'sess-covf', l.spec.capability, ['env.inject_fault']);
      const fault = await df('env.inject_fault', { environmentId: 'other', fault: 'latency' });
      assert.match(String(fault.message.content), /experiment_claims_missing: .*env\/other is outside the claims of experiment/);
      assert.equal(seen.length, 2);
      // an item running for two experiments: a covered write is attributed to the experiment whose claims cover it
      const both = await executorFor(h, l.run.runId, [wr, payment], 'fp-cover-both');
      const db2 = await dispatcherFor(h, l.run, both, 'agent-both', 'sess-both', l.spec.capability, ['http.request']);
      const covered = await db2('http.request', { method: 'POST', environmentId: 'svc', path: '/orders', body: '{}' });
      assert.equal(covered.message.isError, undefined, String(covered.message.content));
      assert.equal(seen.at(-1)!.experimentId, wr);
    } finally {
      restore();
    }
  });

});

describe('review B2 — no work item writes to or faults a resource another experiment holds', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  test('a write/fault call on a resource another experiment holds is refused — also for items that run for no experiment (the contamination rule is enforced)', async () => {
    const a = await lead(h, 'holder run');
    const fault = expIdOf(await a.dispatch('experiment.define', { hypothesis: 'other tolerates latency', environmentId: 'other', faultPlan: [{ kind: 'latency', target: 'other' }] }));
    const loadgen = expIdOf(await a.dispatch('experiment.define', {
      hypothesis: 'the load generator is exclusive', environmentId: 'svc', workload: { kind: 'http_load', ratePerSecond: 1 },
      isolation: { mode: 'exclusive_write', resourceClaims: [{ resourceKey: 'loadgen/127.0.0.1:9', mode: 'write_exclusive' }] },
    }));
    const spec = (await h.deps.specs.getExperiment(fault))!;
    assert.match(spec.contaminationRules[0]!.description, /no other experiment or work item may use env\/other/);
    const b = await lead(h, 'intruding run');
    const seen: ToolExecutionRequest[] = [];
    const restore = intercept(h, async (req) => {
      if (req.workItemId !== b.item.workItemId || req.toolId === 'blackboard.read' || req.toolId === 'experiment.define') return undefined;
      seen.push(req);
      return result(req);
    });
    try {
      const d = await dispatcherFor(h, b.run, b.item, b.agent.agentId, b.agent.sessionId, b.spec.capability, ['env.inject_fault', 'http.request', 'load.start']);
      for (const [name, args, holder] of [
        ['env.inject_fault', { environmentId: 'other', fault: 'latency' }, fault],
        ['http.request', { method: 'POST', environmentId: 'other', path: '/x', body: '{}' }, fault],
        // the held environment addressed by its URL (no alias bypass)
        ['http.request', { method: 'POST', url: 'http://127.0.0.1:10/x', body: '{}' }, fault],
        ['load.start', { method: 'GET', environmentId: 'svc', path: '/', ratePerSecond: 1, durationMs: 1000 }, loadgen],
      ] as const) {
        const denied = await d(name, args as unknown as JsonValue);
        assert.equal(denied.message.isError, true, name);
        assert.match(String(denied.message.content), /\[denied\] experiment_resource_conflict: /);
        assert.ok(String(denied.message.content).includes(holder), `${name}: the holding experiment is named`);
      }
      assert.equal(seen.length, 0, 'nothing was executed');
      const events = (await h.deps.events.read(b.run.runId, { types: ['tool.denied'] })).filter((e) => (e.payload as Record<string, unknown>)['errorCode'] === 'experiment_resource_conflict');
      assert.equal(events.length, 4);
      // reads of the held resource still run; a write elsewhere needs an experiment of the item (D-4, changed with
      // gate-governance: it used to run without one) — with one claiming that resource, it runs
      assert.equal((await d('http.request', { method: 'GET', environmentId: 'other', path: '/health' })).message.isError, undefined);
      const unowned = await d('http.request', { method: 'POST', environmentId: 'svc', path: '/x', body: '{}' });
      assert.match(String(unowned.message.content), /^\[denied\] experiment_required: http\.request acts on the environment \(effect external\) and work item wi_\w+ runs for no experiment/);
      const own = expIdOf(await b.dispatch('experiment.define', { hypothesis: 'orders accept writes', environmentId: 'svc', isolation: { mode: 'exclusive_write', resourceClaims: [] } }));
      const d2 = await dispatcherFor(h, b.run, b.item, b.agent.agentId, b.agent.sessionId, b.spec.capability, ['env.inject_fault', 'http.request']);
      assert.equal((await d2('http.request', { method: 'POST', environmentId: 'svc', path: '/x', body: '{}' })).message.isError, undefined);
      assert.deepEqual(seen.map((r) => [r.toolId, r.experimentId]), [['http.request', undefined], ['http.request', own]]);
      // once the holder's claims are released, the intruder may define its own fault experiment there and act
      await h.deps.admission.release(fault);
      const faultB = expIdOf(await b.dispatch('experiment.define', { hypothesis: 'other tolerates latency too', environmentId: 'other', faultPlan: [{ kind: 'latency', target: 'other' }] }));
      const wf = await executorFor(h, b.run.runId, [faultB], 'fp-intruder-fault');
      const restoreWf = intercept(h, async (req) => (req.workItemId === wf.workItemId ? (seen.push(req), result(req)) : undefined));
      try {
        const d3 = await dispatcherFor(h, b.run, wf, 'agent-intruder-fault', 'sess-intruder-fault', b.spec.capability, ['env.inject_fault']);
        const injected = await d3('env.inject_fault', { environmentId: 'other', kind: 'latency', params: { ms: 100 }, durationMs: 1000 });
        assert.equal(injected.message.isError, undefined, String(injected.message.content));
        assert.equal(seen.at(-1)!.experimentId, faultB, 'attributed to the declared fault experiment');
      } finally {
        restoreWf();
      }
    } finally {
      restore();
    }
  });
});

describe('review B2 — experiment.define keeps a saved experiment admitted across a failed call', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  test('a failure after the experiment was saved does not release its claims; the replay records it on the run', async () => {
    const l = await lead(h, 'partial define');
    const spec = h.deps.registry.get('experiment.define')!;
    const ctx = {
      runId: l.run.runId, workItemId: l.item.workItemId, agentId: l.agent.agentId, role: 'lead', invocationId: `${l.agent.sessionId}:78:pd`,
      eventContext: { runId: l.run.runId, correlationId: l.item.workItemId, actorId: l.agent.agentId, workItemId: l.item.workItemId, agentId: l.agent.agentId },
      signal: new AbortController().signal, logger: h.logger, environments: h.deps.environments, artifacts: h.deps.artifacts,
    };
    const input = { hypothesis: 'partial', environmentId: 'svc', faultPlan: [{ kind: 'restart', target: 'svc' }] };
    const runs = h.deps.runs;
    const original = runs.update;
    let failed = false;
    runs.update = async (...args: Parameters<typeof original>) => {
      if (!failed && (args[1] as Partial<TestRun>).experimentIds !== undefined) {
        failed = true;
        throw new Error('run store unavailable');
      }
      return original.apply(runs, args);
    };
    try {
      await assert.rejects(spec.execute(input, ctx as never), /run store unavailable/);
    } finally {
      runs.update = original;
    }
    const saved = await h.deps.specs.listExperiments(l.run.runId);
    assert.equal(saved.length, 1, 'the experiment was saved before the failure');
    const expId = saved[0]!.experimentId;
    assert.deepEqual((await h.deps.admission.held!(expId)).map((c) => c.claim.mode), ['fault_exclusive'], 'a saved experiment keeps its admitted claims');
    // a competing definition is still refused
    const other = await lead(h, 'competitor');
    const competing = await other.dispatch('experiment.define', { hypothesis: 'competing', environmentId: 'svc', faultPlan: [{ kind: 'latency', target: 'svc' }] });
    assert.match(String(competing.message.content), /resource_conflict/);
    // the replay returns the experiment and records it on the run
    const replay = await spec.execute(input, ctx as never);
    assert.equal(replay.status, 'success');
    assert.equal((replay.structured as Record<string, unknown>)['experimentId'], expId);
    assert.deepEqual((await h.deps.runs.get(l.run.runId))!.experimentIds, [expId]);
  });
});

describe('review B2 — experiment.define: a failed save releases the claims only of an experiment that does not exist', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  test('save refused before anything was stored ⇒ claims released; save committed then the call failed ⇒ the existing experiment keeps its claims', async () => {
    const l = await lead(h, 'failing saves');
    const spec = h.deps.registry.get('experiment.define')!;
    const ctxFor = (inv: string) => ({
      runId: l.run.runId, workItemId: l.item.workItemId, agentId: l.agent.agentId, role: 'lead', invocationId: `${l.agent.sessionId}:79:${inv}`,
      eventContext: { runId: l.run.runId, correlationId: l.item.workItemId, actorId: l.agent.agentId, workItemId: l.item.workItemId, agentId: l.agent.agentId },
      signal: new AbortController().signal, logger: h.logger, environments: h.deps.environments, artifacts: h.deps.artifacts,
    });
    const store = h.deps.specs;
    const original = store.saveExperiment;
    try {
      store.saveExperiment = async () => {
        throw new Error('spec store unavailable');
      };
      await assert.rejects(spec.execute({ hypothesis: 'never saved', environmentId: 'svc', faultPlan: [{ kind: 'restart', target: 'svc' }] }, ctxFor('a') as never), /spec store unavailable/);
      assert.deepEqual((await h.deps.admission.active(l.run.runId)).filter((c) => c.holderId.startsWith('exp_')), [], 'not created: no claims');
      store.saveExperiment = async (...args: Parameters<typeof original>) => {
        await original.apply(store, args);
        throw new Error('connection reset after commit');
      };
      await assert.rejects(spec.execute({ hypothesis: 'saved', environmentId: 'svc', faultPlan: [{ kind: 'restart', target: 'svc' }] }, ctxFor('b') as never), /connection reset after commit/);
    } finally {
      store.saveExperiment = original;
    }
    const saved = await h.deps.specs.listExperiments(l.run.runId);
    assert.equal(saved.length, 1);
    assert.deepEqual((await h.deps.admission.held!(saved[0]!.experimentId)).map((c) => c.claim.resourceKey), ['env/svc'], 'an existing experiment keeps its claims');
    const replay = await spec.execute({ hypothesis: 'saved', environmentId: 'svc', faultPlan: [{ kind: 'restart', target: 'svc' }] }, ctxFor('b') as never);
    assert.equal((replay.structured as Record<string, unknown>)['experimentId'], saved[0]!.experimentId);
    assert.deepEqual((await h.deps.runs.get(l.run.runId))!.experimentIds, [saved[0]!.experimentId]);
  });
});

describe('review B2 — no side effect runs once its evidence can no longer be stored', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  test('a spent artifact budget refuses write/fault calls BEFORE they act (typed budget_exhausted); reads still run', async () => {
    const l = await lead(h, 'artifact budget vs side effects', { maxArtifactBytes: 1000 });
    const seen: ToolExecutionRequest[] = [];
    const restore = intercept(h, async (req) => {
      if (req.workItemId !== l.item.workItemId || req.toolId === 'blackboard.read' || req.toolId === 'experiment.define') return undefined;
      seen.push(req);
      return req.toolId === 'fs.search' ? result(req, { usage: { computeMs: 0, artifactBytes: 1500 } }) : result(req);
    });
    try {
      // the item runs for a restart experiment on svc (D-4): what refuses the writes below is the spent budget
      const defined = await l.dispatch('experiment.define', { hypothesis: 'svc survives a restart', environmentId: 'svc', faultPlan: [{ kind: 'restart', target: 'svc' }] });
      assert.equal(defined.message.isError, undefined, String(defined.message.content));
      const d = await dispatcherFor(h, l.run, l.item, l.agent.agentId, l.agent.sessionId, l.spec.capability, ['fs.search', 'http.request', 'env.restart', 'load.stop']);
      await d('fs.search', { pattern: 'x' });
      assert.equal((await h.deps.budget.remaining!([workScope(l.item.workItemId)])).artifactBytes, 0);
      for (const [name, args] of [['http.request', { method: 'POST', environmentId: 'svc', path: '/orders', body: '{}' }], ['env.restart', { environmentId: 'svc', reason: 'x' }]] as const) {
        const denied = await d(name, args as unknown as JsonValue);
        assert.equal(denied.message.isError, true, name);
        assert.match(String(denied.message.content), /\[denied\] budget_exhausted: the artifact budget of run:\S+ is spent \(1500\/1000 bytes\)/);
      }
      assert.deepEqual(seen.map((r) => r.toolId), ['fs.search'], 'no side effect ran');
      const ev = (await eventsOf(h, l.run.runId, 'budget.exhausted')).filter((e) => e.payload['reason'] === 'artifact_bytes');
      assert.ok(ev.length >= 3, 'each refusal is a typed exhaustion on L0');
      // a read still runs (it acts on nothing), and a running load job can still be stopped (it only ends an effect)
      await d('http.request', { method: 'GET', environmentId: 'svc', path: '/health' });
      await d('load.stop', { operationId: 'op_01J00000000000000000000000' });
      assert.deepEqual(seen.map((r) => r.toolId), ['fs.search', 'http.request', 'load.stop']);
    } finally {
      restore();
    }
  });
});

describe('review B2 — experiment claims outlive their owners while the experiment\'s load job still runs', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: ENVIRONMENTS });
  });
  after(async () => h.dispose());

  test('owners ended but a job of the experiment runs ⇒ claims kept (a competing experiment stays refused); the job ends ⇒ released', async () => {
    const l = await lead(h, 'job outlives owners');
    const expId = expIdOf(await l.dispatch('experiment.define', { hypothesis: 'svc holds 20 rps', environmentId: 'svc', workload: { kind: 'http_load', ratePerSecond: 20 } }));
    const w = await executorFor(h, l.run.runId, [expId], 'fp-job-outlives');
    const ops: string[] = [];
    const restore = intercept(h, async (req) => {
      if (req.toolId !== 'load.start') return undefined;
      const op = await h.deps.ledger.prepare({
        runId: req.runId, workItemId: req.workItemId, toolInvocationId: req.invocationId, operationType: 'load.start', adapterId: 'load.http',
        target: { resourceKey: 'loadgen/127.0.0.1:9', kind: 'load_job' }, desiredStateHash: `d-${req.invocationId}`, inputHash: `i-${req.invocationId}`,
        ...(req.experimentId !== undefined ? { experimentId: req.experimentId } : {}),
      }, req.eventContext);
      ops.push(op.operationId);
      await h.deps.ledger.transition(op.operationId, 'dispatching', {}, req.eventContext);
      await h.deps.ledger.transition(op.operationId, 'acknowledged', { externalJobId: op.operationId }, req.eventContext);
      return result(req, { status: 'pending', operationId: op.operationId, structured: { operationId: op.operationId, operationStatus: 'acknowledged' } });
    });
    try {
      const d = await dispatcherFor(h, l.run, w, 'agent-job', 'sess-job', l.spec.capability, ['load.start']);
      const started = await d('load.start', { method: 'GET', environmentId: 'svc', path: '/', ratePerSecond: 20, durationMs: 600_000 });
      assert.equal(started.message.isError, undefined, String(started.message.content));
      // both owners end while the job runs
      await h.deps.blackboard.transitionWorkItem(l.item.workItemId, 'cancelled', { failure: { reason: 'cancelled', message: 'test' } }, h.ctx(l.run.runId), { expectedFencingToken: l.token });
      await h.deps.blackboard.transitionWorkItem(w.workItemId, 'cancelled', { failure: { reason: 'cancelled', message: 'test' } }, h.ctx(l.run.runId), { expectedFrom: ['blocked'] });
      await h.control.tick(l.run.runId);
      assert.deepEqual((await h.deps.admission.held!(expId)).map((c) => c.claim.resourceKey), ['env/svc'], 'the running job keeps its experiment isolated');
      h.clock.advance(70_000); // past the TTL: renewed by the tick, not lapsed
      await h.control.tick(l.run.runId);
      assert.equal((await h.deps.admission.held!(expId)).length, 1);
      const other = await lead(h, 'competing fault');
      const refused = await other.dispatch('experiment.define', { hypothesis: 'svc tolerates a restart', environmentId: 'svc', faultPlan: [{ kind: 'restart', target: 'svc' }] });
      assert.match(String(refused.message.content), new RegExp(`resource_conflict: .*${expId}`));
      // the job ends ⇒ the next tick releases the claims
      await h.deps.ledger.transition(ops[0]!, 'verified', { result: { state: 'completed' } }, h.ctx(l.run.runId));
      await h.control.tick(l.run.runId);
      assert.deepEqual(await h.deps.admission.held!(expId), []);
      assert.deepEqual((await eventsOf(h, l.run.runId, 'admission.released')).map((e) => [e.payload['experimentId'], e.payload['reason']]), [[expId, 'owners_ended']]);
    } finally {
      restore();
    }
  });
});
