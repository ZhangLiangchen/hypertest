/**
 * Side-effect governance of the control plane (audit wave 2, unit side-effect-governance).
 *
 * E[0] "an expired worker cannot write successfully (0 successes)" — for EXTERNAL effects too: the audit's stale-external
 * probe revoked the work claim after the dispatcher's pre-dispatch fence check, and the SUT still received the POST. The
 * claim is now re-validated by the SideEffectGateway at its commit point (inside the transaction that records
 * `dispatching`): the revoked worker's POST never leaves the process.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import type { JsonValue } from '@hypertest/core';
import type { TestRun, WorkItem } from '@hypertest/domain';
import { signCapability } from '@hypertest/policy';
import type { ToolExecutionResult } from '@hypertest/tools';
import { brokeredCredentialScopes, createToolDispatcher } from '../src/index.ts';
import { SECRET, call, createHarness, type Harness, type RoleBrain } from './harness.ts';

const LEAD_OUT: { [k: string]: JsonValue } = { summary: 'lead done', planProposed: false, readyForGate: false, objectives: [] };

function readingLead(): Record<string, RoleBrain> {
  return { lead: (v) => (v.step === 0 ? call('blackboard.read', {}) : call('complete_work', { summary: 'done', output: LEAD_OUT })) };
}

/** A tiny SUT recording every non-safe request it receives. */
async function sut(): Promise<{ server: Server; port: number; posts: string[] }> {
  const posts: string[] = [];
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') posts.push(`${req.method} ${req.url ?? ''}`);
    req.resume();
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as { port: number }).port, posts };
}

type Dispatch = (name: string, args: JsonValue) => Promise<{ message: { isError?: boolean; content: unknown }; execution?: ToolExecutionResult }>;

/**
 * The lead's item after one turn, with a dispatcher bound to its claim (fencing token) whose capability also grants
 * http.request (external) — the audit's technique (re-signed with the harness secret, so the real ToolRuntime executes).
 */
async function leadWithHttp(h: Harness, goal: string): Promise<{ run: TestRun; item: WorkItem; token: number; dispatch: Dispatch }> {
  const run0 = await h.control.startRun({ goal, target: {} });
  const d0 = (await h.control.tick(run0.runId)).dispatched[0]!;
  assert.equal((await h.control.executeTurn(d0.workItemId, d0.fencingToken)).status, 'continue');
  const item = (await h.deps.blackboard.getWorkItem(d0.workItemId))!;
  const run = (await h.deps.runs.get(run0.runId))!;
  const { agent, spec } = await h.control.worker.ensureAgent(item, run, d0.fencingToken);
  const { signature: _s, ...unsigned } = spec.capability;
  const capability = signCapability(
    { ...unsigned, tools: [...unsigned.tools, 'http.request'], allowedEffects: ['read', 'record', 'external'], resourceScopes: ['**'], environmentClasses: ['local'], maxRiskClass: 'high' },
    SECRET,
  );
  const ctx = { runId: run.runId, correlationId: item.workItemId, actorId: agent.agentId, workItemId: item.workItemId, agentId: agent.agentId };
  const snapshot = await h.deps.snapshotBuilder.build({ runId: run.runId }, ctx);
  const dispatcher = createToolDispatcher(h.deps, {
    runId: run.runId, workItemId: item.workItemId, agentId: agent.agentId, role: item.role, sessionId: agent.sessionId,
    capability, allow: ['blackboard.read', 'experiment.define', 'http.request'], deny: [],
    workspace: await h.deps.workspaces.scratch({ runId: run.runId, workItemId: item.workItemId }),
    eventContext: ctx, turnState: { turn: 700, snapshot }, fencingToken: d0.fencingToken,
  });
  let n = 0;
  const dispatch: Dispatch = (name, args) => {
    const id = `p${++n}`;
    return dispatcher.dispatch({ id, name: name.replaceAll('.', '__'), arguments: args }, { sessionId: agent.sessionId, turn: 700, invocationId: `${agent.sessionId}:700:${id}`, signal: new AbortController().signal });
  };
  return { run, item, token: d0.fencingToken, dispatch };
}

describe('E[0]: an expired worker cannot reach the SUT (0 successes for external effects)', () => {
  let h: Harness;
  let s: Awaited<ReturnType<typeof sut>>;
  before(async () => {
    s = await sut();
    h = await createHarness({ brains: readingLead(), environments: [{ environmentId: 'svc', environmentClass: 'local', baseUrl: `http://127.0.0.1:${s.port}`, generation: 1 }] });
  });
  after(async () => {
    await h.dispose();
    await new Promise<void>((r) => s.server.close(() => r()));
  });

  test('audit probe: the claim revoked after the pre-dispatch check ⇒ the POST is refused at the gateway commit point, nothing reaches the SUT', async () => {
    const l = await leadWithHttp(h, 'stale external write');
    // D-4: a write to the environment runs for an experiment that claims it
    const def = await l.dispatch('experiment.define', { hypothesis: 'orders accept writes', environmentId: 'svc', workload: { kind: 'http_load', ratePerSecond: 1 } });
    assert.equal(def.message.isError, undefined, String(def.message.content));
    // positive control: while the claim is held the POST reaches the SUT once
    const ok = await l.dispatch('http.request', { method: 'POST', environmentId: 'svc', path: '/orders', body: '{}' });
    assert.equal(ok.execution?.status, 'success', String(ok.message.content));
    assert.deepEqual(s.posts, ['POST /orders']);

    // revoke the claim AFTER the dispatcher's pre-dispatch fence check, BEFORE the runtime executes (audit technique)
    const runtime = h.deps.toolRuntime;
    const original = runtime.execute;
    runtime.execute = async (req) => {
      await h.control.scheduler.requeue((await h.deps.blackboard.getWorkItem(l.item.workItemId))!, h.ctx(l.run.runId), 'audit: lease lapsed', l.token);
      return original.call(runtime, req);
    };
    let r: Awaited<ReturnType<Dispatch>>;
    try {
      r = await l.dispatch('http.request', { method: 'POST', environmentId: 'svc', path: '/orders/2', body: '{}' });
    } finally {
      runtime.execute = original;
    }
    const itemNow = (await h.deps.blackboard.getWorkItem(l.item.workItemId))!;
    assert.equal(itemNow.state, 'ready', 'the claim was really revoked');
    assert.deepEqual(s.posts, ['POST /orders'], 'the revoked worker\'s POST never reached the SUT');
    assert.equal(r.execution?.status, 'denied');
    assert.equal(r.execution?.error?.code, 'lease_lost');
    assert.match(String(r.message.content), /claim_fenced: work item .* is no longer held with fencing token/);
    assert.equal(r.message.isError, true);
    // the ledger records the refusal (never dispatched) with the exact reason
    const op = await h.deps.ledger.get(r.execution!.operationId ?? String((r.execution!.structured as Record<string, unknown>)['operationId']));
    assert.equal(op?.status, 'not_applied');
    assert.match(op?.lastError ?? '', /^claim_fenced: work item/);
    // no evidence of a successful exchange was recorded for the refused call
    const evidence = await h.deps.evidence.query({ runId: l.run.runId, evidenceType: 'api-response' });
    assert.equal(evidence.length, 1, 'only the positive control produced an api-response');
  });
});

// ======================================================================================== E[1] effect claims

const FAULT_ENVS = [{ environmentId: 'svc', environmentClass: 'local', baseUrl: 'http://127.0.0.1:9', generation: 3, control: { kind: 'process' as const, target: 'svc-main' } }];

/** A run whose lead ran one turn, with a dispatcher bound to its claim that also offers env.inject_fault (runtime intercepted). */
async function faultLead(h: Harness, goal: string): Promise<{ run: TestRun; item: WorkItem; dispatch: Dispatch }> {
  const run0 = await h.control.startRun({ goal, target: {} });
  const d0 = (await h.control.tick(run0.runId)).dispatched[0]!;
  assert.equal((await h.control.executeTurn(d0.workItemId, d0.fencingToken)).status, 'continue');
  const item = (await h.deps.blackboard.getWorkItem(d0.workItemId))!;
  const run = (await h.deps.runs.get(run0.runId))!;
  const { agent, spec } = await h.control.worker.ensureAgent(item, run, d0.fencingToken);
  const ctx = { runId: run.runId, correlationId: item.workItemId, actorId: agent.agentId, workItemId: item.workItemId, agentId: agent.agentId };
  const snapshot = await h.deps.snapshotBuilder.build({ runId: run.runId }, ctx);
  const dispatcher = createToolDispatcher(h.deps, {
    runId: run.runId, workItemId: item.workItemId, agentId: agent.agentId, role: item.role, sessionId: agent.sessionId,
    capability: (() => {
      const { signature: _s, ...unsigned } = spec.capability;
      return signCapability({ ...unsigned, tools: [...unsigned.tools, 'env.inject_fault'], allowedEffects: ['read', 'record', 'external', 'destructive'], resourceScopes: ['**'], environmentClasses: ['local'], maxRiskClass: 'high' }, SECRET);
    })(),
    allow: ['blackboard.read', 'experiment.define', 'env.inject_fault'], deny: [],
    workspace: await h.deps.workspaces.scratch({ runId: run.runId, workItemId: item.workItemId }),
    eventContext: ctx, turnState: { turn: 800, snapshot }, fencingToken: d0.fencingToken,
  });
  let n = 0;
  const dispatch: Dispatch = (name, args) => {
    const id = `f${++n}`;
    return dispatcher.dispatch({ id, name: name.replaceAll('.', '__'), arguments: args }, { sessionId: agent.sessionId, turn: 800, invocationId: `${agent.sessionId}:800:${id}`, signal: new AbortController().signal });
  };
  return { run, item, dispatch };
}

describe('E[1]: every write/fault/load action holds an admitted ResourceClaim for its whole effect window', () => {
  let h: Harness;
  /** Fault calls that reached the (intercepted) ToolRuntime: what would have been injected. */
  const injected: string[] = [];
  let restore: () => void = () => undefined;
  before(async () => {
    h = await createHarness({ brains: readingLead(), environments: FAULT_ENVS });
    const runtime = h.deps.toolRuntime;
    const original = runtime.execute;
    runtime.execute = async (req) => {
      if (req.toolId !== 'env.inject_fault') return original.call(runtime, req);
      injected.push(req.invocationId);
      const input = req.input as { durationMs: number };
      const expiresAt = new Date(h.clock.nowMs() + input.durationMs).toISOString();
      // what the gateway records for a verified time-boxed fault (its window in the result)
      const op = await h.deps.ledger.prepare({
        runId: req.runId, workItemId: req.workItemId, toolInvocationId: req.invocationId, operationType: 'env.inject_fault', adapterId: 'env.control',
        target: { resourceKey: 'env/svc', kind: 'environment' }, desiredStateHash: `d-${req.invocationId}`, inputHash: `i-${req.invocationId}`,
      }, req.eventContext);
      await h.deps.ledger.transition(op.operationId, 'dispatching', {}, req.eventContext);
      await h.deps.ledger.transition(op.operationId, 'acknowledged', {}, req.eventContext);
      const result = { action: 'fault', expiresAt, effectUntil: expiresAt };
      await h.deps.ledger.transition(op.operationId, 'verified', { result }, req.eventContext);
      return { toolId: req.toolId, invocationId: req.invocationId, status: 'success', structured: result, modelText: 'fault active', artifactRefs: [], evidenceRefs: [], durationMs: 1, operationId: op.operationId, usage: { computeMs: 0, artifactBytes: 0 } };
    };
    restore = () => {
      runtime.execute = original;
    };
  });
  after(async () => {
    restore();
    await h.dispose();
  });

  test('chaos: two fault experiments competing for one service ⇒ admission rejects one — also after the first experiment\'s claims were released while its fault is still in force', async () => {
    const a = await faultLead(h, 'fault experiment A');
    const defA = await a.dispatch('experiment.define', { hypothesis: 'svc tolerates latency', environmentId: 'svc', faultPlan: [{ kind: 'latency', target: 'svc' }] });
    assert.equal(defA.message.isError, undefined, String(defA.message.content));
    const expA = String((defA.execution!.structured as Record<string, unknown>)['experimentId']);
    // the fault is time-boxed (10 min): its call-scoped claim covers env/svc for the whole window
    const f1 = await a.dispatch('env.inject_fault', { environmentId: 'svc', kind: 'latency', params: { ms: 200 }, durationMs: 600_000 });
    assert.notEqual(f1.message.isError, true, String(f1.message.content));
    const holders = (await h.deps.admission.active(a.run.runId)).filter((c) => c.holderId.startsWith('effect:'));
    assert.deepEqual(holders.map((c) => [c.claim.resourceKey, c.claim.mode]), [['env/svc', 'fault_exclusive']]);
    assert.ok(holders[0]!.holderId.startsWith(`effect:${expA}:${a.item.workItemId}:`), holders[0]!.holderId);
    assert.ok(Date.parse(holders[0]!.expiresAt) >= h.clock.nowMs() + 600_000, 'held for the fault window');
    const granted = (await h.deps.events.read(a.run.runId, { types: ['admission.granted'] })).filter((e) => e.aggregateType === 'tool');
    assert.equal(granted.length, 1, 'the effect claim is on L0');

    // two overlapping faults on one service are refused — even within the same experiment
    const f2 = await a.dispatch('env.inject_fault', { environmentId: 'svc', kind: 'latency', params: { ms: 300 }, durationMs: 60_000 });
    assert.equal(f2.message.isError, true);
    assert.match(String(f2.message.content), /resource_claim_conflict: env.inject_fault needs fault_exclusive\(env\/svc\), which conflicts with live claims: fault_exclusive\(env\/svc\) vs fault_exclusive\(env\/svc\) held by effect:/);
    assert.equal(injected.length, 1, 'the second fault never reached the runtime');

    // the first experiment's owners end: its own claims are released (run end) — the fault is still in force
    await h.control.cancelRun(a.run.runId, 'experiment A done');
    assert.deepEqual(await h.deps.admission.held!(expA), []);
    const b = await faultLead(h, 'fault experiment B');
    const defB = await b.dispatch('experiment.define', { hypothesis: 'svc tolerates errors', environmentId: 'svc', faultPlan: [{ kind: 'error_rate', target: 'svc' }] });
    assert.equal(defB.message.isError, true, 'admission rejects the competing experiment while the fault is in force');
    assert.match(String(defB.message.content), /resource_conflict: experiment not created: its isolation claims conflict with claims held by effect:/);
    assert.deepEqual(await h.deps.specs.listExperiments(b.run.runId), []);

    // the window ends ⇒ the service is free again
    await h.control.cancelRun(b.run.runId, 'refused');
    h.clock.advance(600_000 + 60_000 + 5_001);
    const c = await faultLead(h, 'fault experiment C');
    const again = await c.dispatch('experiment.define', { hypothesis: 'svc tolerates errors', environmentId: 'svc', faultPlan: [{ kind: 'error_rate', target: 'svc' }] });
    assert.equal(again.message.isError, undefined, String(again.message.content));
    await h.control.cancelRun(c.run.runId, 'done');
  });

  test('an instantaneous write gives its claim back after the call; a refused call (policy, budget) holds nothing', async () => {
    const a = await faultLead(h, 'claims are call-scoped');
    const def = await a.dispatch('experiment.define', { hypothesis: 'svc tolerates latency', environmentId: 'svc', faultPlan: [{ kind: 'latency', target: 'svc' }] });
    assert.equal(def.message.isError, undefined, String(def.message.content));
    // a fault outside the plan is refused by the experiment check BEFORE any claim is admitted
    const off = await a.dispatch('env.inject_fault', { environmentId: 'svc', kind: 'error_rate', params: { rate: 1 }, durationMs: 1000 });
    assert.equal(off.message.isError, true);
    assert.match(String(off.message.content), /experiment_plan_violation/);
    assert.deepEqual((await h.deps.admission.active(a.run.runId)).filter((c) => c.holderId.startsWith('effect:')), []);
    await h.control.cancelRun(a.run.runId, 'done');
  });
});

// ======================================================================================== E[4] brokered credential grants

describe('E[4]: brokered credential scopes are granted per permission profile (the scope, never a value)', () => {
  test('brokeredCredentialScopes: the operator grants each credential to profiles (default test_executor, environment_operator)', () => {
    const envs = [
      { environmentId: 'shop', brokeredCredentials: [{ name: 'orders' }, { name: 'admin', grantTo: ['environment_operator'] }] },
      { environmentId: 'bare' },
    ];
    assert.deepEqual(brokeredCredentialScopes(envs, 'test_executor'), ['credential:shop/orders']);
    assert.deepEqual(brokeredCredentialScopes(envs, 'environment_operator'), ['credential:shop/orders', 'credential:shop/admin']);
    assert.deepEqual(brokeredCredentialScopes(envs, 'analyst'), []);
  });

  test("an agent's capability carries exactly the scopes granted to its profile", async () => {
    const h = await createHarness({
      brains: readingLead(),
      environments: [{ environmentId: 'shop', environmentClass: 'local', baseUrl: 'http://127.0.0.1:9', generation: 1, brokeredCredentials: [{ name: 'orders', grantTo: ['test_executor', 'analyst'] }] }],
    });
    try {
      const run = await h.control.startRun({ goal: 'credential grants', target: {} });
      const d = (await h.control.tick(run.runId)).dispatched[0]!;
      const item = (await h.deps.blackboard.getWorkItem(d.workItemId))!;
      const { spec } = await h.control.worker.ensureAgent(item, (await h.deps.runs.get(run.runId))!, d.fencingToken);
      const profile = h.deps.roles.require('lead').permissionProfile;
      const expected = profile === 'analyst' || profile === 'test_executor' ? ['credential:shop/orders'] : [];
      assert.deepEqual(spec.capability.credentialScopes, expected, `lead profile ${profile}`);
    } finally {
      await h.dispose();
    }
  });
});
