import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { EFFECT_ORDER, type ContextSnapshot, type Finding, type ToolEffect } from '@hypertest/domain';
import {
  createFreshnessGuard, createFreshnessPassLog, createObservationLog, createSnapshotBuilder, observeToolRuntime, workspaceFileResolver,
  type FreshnessGuard, type ObservationLog,
} from '@hypertest/context';
import { signCapability } from '@hypertest/policy';
import { ToolRegistry, createToolRuntime, type ToolContext, type ToolSpec } from '@hypertest/tools';
import { createToolDispatcher, freshnessChecked, isFreshnessChecked, type DispatcherInput } from '../src/index.ts';
import { SECRET, call, createHarness, runItem, turnSnapshot, type BrainView, type Harness, type RoleBrain } from './harness.ts';

/**
 * (B[1], CONFORMANCE "Checklist: mutation actions check the ReadSet (100%)"; B[2] "FreshnessGuard re-checks … withdrawn
 * findings"): EVERY mutating tool of the catalog — record effects included (plan, blackboard, oracle, experiment, test artifact,
 * delegation and work tools) — is validated by the FreshnessGuard against what the agent observed before it acts.
 */

/** A guard that always reports a stale read set, recording what it was asked to validate. */
function staleGuard(asked: string[]): FreshnessGuard {
  return {
    resolvers: { register() {}, get: () => undefined },
    async validate(_snapshot, action) {
      asked.push(action.tool);
      return { fresh: false, checked: 1, stale: [{ resourceType: 'finding', resourceId: 'rec_lineage', observedVersion: 'rec_1', currentVersion: 'rec_2', reason: 'version_changed' }] };
    },
  };
}

/** What a dynamic effect can be: the effect function over the inputs that steer it (HTTP methods). */
function possibleEffects(spec: ToolSpec): ToolEffect[] {
  if (typeof spec.effect !== 'function') return [spec.effect];
  const out = new Set<ToolEffect>();
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    try {
      out.add(spec.effect({ method } as never));
    } catch {
      // an input the effect cannot classify
    }
  }
  try {
    out.add(spec.effect({} as never));
  } catch {
    // idem
  }
  return [...out];
}

/** The mutating effects the ToolRuntime validates itself (step 6): every effect but read and record. */
const RUNTIME_CHECKED: ReadonlySet<string> = new Set(Object.keys(EFFECT_ORDER).filter((e) => e !== 'read' && e !== 'record'));

async function leadTurn(h: Harness, goal: string) {
  const run0 = await h.control.startRun({ goal, target: {} });
  const d0 = (await h.control.tick(run0.runId)).dispatched[0]!;
  assert.equal((await h.control.executeTurn(d0.workItemId, d0.fencingToken)).status, 'continue');
  const item = (await h.deps.blackboard.getWorkItem(d0.workItemId))!;
  const run = (await h.deps.runs.get(run0.runId))!;
  const { agent, spec } = await h.control.worker.ensureAgent(item, run, d0.fencingToken);
  return { run, item, agent, spec, token: d0.fencingToken };
}

const idle: RoleBrain = (v) => (v.step === 0 ? { text: 'thinking' } : call('fail_work', { reason: 'test', message: 'not needed' }));

describe('(B[1]) catalog: every mutating tool is freshness-checked (a new mutating tool without a ReadSet check fails here)', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: { lead: idle } });
  });
  after(async () => h.dispose());

  test('the runtime validates every mutating effect class but record; record tools carry the domain freshness wrapper', async () => {
    const { run, item, agent, spec } = await leadTurn(h, 'effect classes');
    const asked: string[] = [];
    const executed: string[] = [];
    // one synthetic tool per effect class of the domain's closed effect union (a new effect class joins this loop)
    const synthetic: ToolSpec[] = [];
    for (const effect of Object.keys(EFFECT_ORDER) as ToolEffect[]) {
      if (effect === 'read') continue;
      const s: ToolSpec = {
        id: `t.${effect}`, title: effect, description: effect, inputSchema: { type: 'object', additionalProperties: false, properties: {} }, effect, riskClass: 'low', timeoutMs: 5000,
        resources: (_i, ctx) => [ctx.workspace.resourcePrefix],
        execute: async () => {
          executed.push(effect);
          return { status: 'success', text: 'ran' };
        },
      };
      synthetic.push(effect === 'record' ? freshnessChecked({ ...h.deps, freshness: staleGuard(asked) }, s) : s);
    }
    const permissive = { revision: 'p-test', async evaluate() { return { decision: 'allow' as const, decisionId: h.ids.next('pdec'), reasons: [], policyRevision: 'p-test' }; } };
    const runtime = createToolRuntime({
      ids: h.ids, clock: h.clock, logger: h.logger, registry: new ToolRegistry(synthetic), policy: permissive as never, freshness: staleGuard(asked), sideEffects: h.deps.gateway,
      artifacts: h.deps.artifacts, evidence: h.deps.evidence, events: h.deps.events, environments: h.deps.environments, runtimeManifestId: 'rm_test', workerId: 'worker-1', capabilitySecret: SECRET,
    });
    const { signature: _s, ...unsigned } = spec.capability;
    const capability = signCapability({ ...unsigned, tools: synthetic.map((t) => t.id), allowedEffects: Object.keys(EFFECT_ORDER) as ToolEffect[], resourceScopes: ['**'], environmentClasses: ['local'], maxRiskClass: 'critical' }, SECRET);
    const workspace = await h.deps.workspaces.scratch({ runId: run.runId, workItemId: item.workItemId });
    const snapshot = await turnSnapshot(h, run.runId);
    for (const t of synthetic) {
      const r = await runtime.execute({
        toolId: t.id, input: {}, invocationId: `inv_${t.id}`, runId: run.runId, workItemId: item.workItemId, agentId: agent.agentId, role: 'lead', capability, workspace, snapshot,
        eventContext: h.ctx(run.runId), signal: new AbortController().signal,
      });
      assert.equal(r.status, 'stale_context', `${t.id}: a mutating ${t.effect as string} call on a stale read set is refused (${r.modelText})`);
    }
    assert.deepEqual(executed, [], 'nothing ran on a stale view');
    assert.deepEqual([...asked].sort(), synthetic.map((t) => t.id).sort(), 'the guard validated every mutating effect class');
  });

  test('the composed catalog (built-in + domain tools): record tools are wrapped and refuse a stale view before they write; every other mutating effect is runtime-checked', async () => {
    const { run, item, agent } = await leadTurn(h, 'catalog');
    const recordTools: ToolSpec[] = [];
    const unchecked: string[] = [];
    for (const spec of h.deps.registry.list()) {
      for (const effect of possibleEffects(spec)) {
        if (effect === 'read') continue;
        if (effect === 'record') {
          if (!isFreshnessChecked(spec)) unchecked.push(`${spec.id} (record)`);
          else if (!recordTools.includes(spec)) recordTools.push(spec);
        } else if (!RUNTIME_CHECKED.has(effect)) unchecked.push(`${spec.id} (${effect})`);
      }
    }
    assert.deepEqual(unchecked, [], 'every mutating tool is freshness-checked');
    // the record tools of the design (plan, blackboard, oracle, experiment, test artifacts, delegation, completion) are all there
    for (const id of ['plan.propose_revision', 'work.propose', 'blackboard.post_finding', 'blackboard.post_review', 'blackboard.post_strategy', 'blackboard.post_decision', 'oracle.propose_change', 'experiment.define', 'test_artifact.register', 'test_artifact.validate', 'delegate', 'complete_work', 'fail_work', 'request_approval', 'evidence.claim']) {
      assert.ok(recordTools.some((t) => t.id === id), `${id} is a freshness-checked record tool`);
    }
    // behavioural: each refuses a stale view (exact reason + refresh hint) BEFORE its body runs
    const asked: string[] = [];
    const original = h.deps.freshness;
    h.deps.freshness = staleGuard(asked);
    try {
      const snapshot = await turnSnapshot(h, run.runId);
      const workspace = await h.deps.workspaces.scratch({ runId: run.runId, workItemId: item.workItemId });
      for (const spec of recordTools) {
        const ctx = {
          runId: run.runId, workItemId: item.workItemId, agentId: agent.agentId, role: 'lead', invocationId: `cat:${spec.id}`, workspace, snapshot, environments: h.deps.environments,
          eventContext: { ...h.ctx(run.runId), agentId: agent.agentId, workItemId: item.workItemId }, signal: new AbortController().signal, logger: h.logger, artifacts: h.deps.artifacts,
        } as unknown as ToolContext;
        const out = await spec.execute({} as never, ctx);
        assert.equal(out.status, 'stale_context', `${spec.id}: ${JSON.stringify(out)}`);
        assert.match(out.error!.message, /stale context \(snapshot cs_\w+\): finding\/rec_lineage: version_changed \(now rec_2\)/);
        assert.match(String(out.text), /Refresh your view of these resources before retrying the mutating action: re-read the changed records with blackboard\.read/);
      }
      assert.deepEqual([...new Set(asked)].sort(), recordTools.map((t) => t.id).sort());
      // without a snapshot a configured guard cannot vouch for the action: refused (fail closed)
      const out = await h.deps.registry.get('blackboard.post_note')!.execute({ text: 'x' } as never, { runId: run.runId, workItemId: item.workItemId, agentId: agent.agentId, role: 'lead', invocationId: 'cat:nosnap', eventContext: h.ctx(run.runId), environments: h.deps.environments, logger: h.logger } as never);
      assert.equal(out.status, 'stale_context');
      assert.match(out.error!.message, /no context snapshot supplied/);
    } finally {
      if (original) h.deps.freshness = original;
      else delete h.deps.freshness;
    }
    assert.deepEqual(await h.deps.blackboard.query({ runId: run.runId, recordType: 'note' }), [], 'no refused call wrote anything');
  });
});

// ------------------------------------------------------------------------------------------------ end to end

/** What @hypertest/app composes for the context engine: the observation log feeding builder, guard and prompt pins. */
function withContextEngine(h: Harness): ObservationLog {
  const base = { ids: h.ids, clock: h.clock, logger: h.logger };
  const log = createObservationLog({ ...base, db: h.db });
  h.deps.resolvers.register(workspaceFileResolver((id) => h.deps.workspaces.get(id)?.root));
  const guard = createFreshnessGuard({ ...base, db: h.db, events: h.deps.events, snapshots: h.deps.snapshots, resolvers: h.deps.resolvers, observations: log });
  h.deps.freshness = guard;
  h.deps.observations = log;
  h.deps.freshnessPasses = createFreshnessPassLog({ ...base, db: h.db });
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

const FINDING = (status: Finding['status']): Finding => ({ title: 'Discount rounds the wrong way', description: 'd', severity: 'P2', category: 'product_defect', status, fingerprint: 'fp-prompt' });

describe('(B[1]) plan.propose_revision is a compare-and-set against the plan revision the lead saw', () => {
  let h: Harness;
  const results: Array<{ name: string; content: string; isError: boolean }> = [];
  before(async () => {
    h = await createHarness({
      brains: {
        lead: async (v: BrainView) => {
          if (v.lastResult) results.push(v.lastResult);
          const plan = (n: number) => call('plan.propose_revision', { rationale: `plan ${n}`, objectives: [{ objectiveId: `o${n}`, description: 'objective', priority: 'P2' }], workItems: [] });
          switch (v.step) {
            case 0:
              return plan(1);
            case 1: {
              assert.match(v.userText, /Plan v1 /, 'the prompt shows the plan the lead decides on');
              // another proposal is accepted while this lead is thinking (plan v2)
              const other = h.deps.registry.get('plan.propose_revision')!;
              const snap = await turnSnapshot(h, v.runId);
              const r = await other.execute(
                { rationale: 'concurrent', objectives: [{ objectiveId: 'ox', description: 'objective', priority: 'P2' }], workItems: [] } as never,
                { runId: v.runId, workItemId: v.workItemId, agentId: 'ag_other_lead', role: 'lead', invocationId: 'concurrent:1', snapshot: snap, eventContext: h.ctx(v.runId), environments: h.deps.environments, logger: h.logger } as never,
              );
              assert.equal(r.status, 'success', JSON.stringify(r));
              return plan(2);
            }
            case 2:
              assert.match(v.userText, /Plan v2 /, 'the next turn shows the current plan');
              return plan(3);
            default:
              return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } });
          }
        },
      },
    });
    withContextEngine(h);
  });
  after(async () => h.dispose());

  test('a revision proposed on a plan view another proposal superseded meanwhile is refused stale_context; on the current view it is accepted', async () => {
    const run = await h.control.startRun({ goal: 'plan cas', target: {} });
    const d = (await h.control.tick(run.runId)).dispatched[0]!;
    assert.equal(await runItem(h.control, d.workItemId, d.fencingToken), 'completed');
    const [first, stale, third] = results;
    assert.equal(first!.isError, false, first!.content);
    assert.equal(stale!.isError, true);
    assert.match(stale!.content, new RegExp(`^\\[stale_context\\] stale_context: stale context \\(snapshot cs_\\w+\\): plan/run/${run.runId}/plan: version_changed \\(now 2\\)`));
    assert.match(stale!.content, /read the current plan with plan\.read/);
    assert.equal(third!.isError, false, third!.content);
    const plans = await h.deps.blackboard.listPlans(run.runId);
    assert.deepEqual(plans.map((p) => p.rationale), ['plan 1', 'concurrent', 'plan 3'], 'the stale proposal was never recorded');
    assert.equal((await h.deps.events.read(run.runId, { types: ['context.stale_rejected'] })).length, 1);
  });
});

describe('(B[2]) a finding the agent saw ONLY in its prompt is pinned: withdrawn meanwhile ⇒ its mutating actions are refused until it is told', () => {
  let h: Harness;
  let lineage = '';
  const results: Array<{ name: string; content: string; isError: boolean }> = [];
  const texts: string[] = [];
  before(async () => {
    h = await createHarness({
      brains: {
        lead: (v) => (v.step === 0
          ? call('plan.propose_revision', { rationale: 'design', objectives: [{ objectiveId: 'obj', description: 'regression coverage', priority: 'P1' }], workItems: [{ localId: 'd1', title: 'design', objective: 'design a regression test', role: 'test_designer', dependsOn: [], objectiveIds: ['obj'] }] })
          : call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } })),
        test_designer: async (v) => {
          if (v.lastResult) results.push(v.lastResult);
          texts.push(v.userText);
          switch (v.step) {
            case 0: {
              // the finding reaches this agent only through the Blackboard section of its prompt (no input ref, no read)
              assert.match(v.userText, new RegExp(`finding ${lineage}: \\[P2, product_defect, open\\] Discount rounds the wrong way`));
              // another agent withdraws it while this agent is deciding
              const head = (await h.deps.blackboard.head(lineage))!;
              await h.deps.blackboard.postRecord({ runId: v.runId, recordType: 'finding', createdBy: 'agent-reviewer', supersedes: head.recordId, payload: FINDING('rejected') }, h.ctx(v.runId));
              return call('blackboard.post_note', { text: 'designing a regression test for the discount finding' });
            }
            case 1:
              return call('blackboard.post_note', { text: 'designing a regression test for the discount finding' });
            default:
              return call('complete_work', { summary: 'done', output: { summary: 'done', testArtifacts: [] } });
          }
        },
      },
    });
    withContextEngine(h);
  });
  after(async () => h.dispose());

  test('the note is refused (finding_withdrawal stale); the next prompt says WITHDRAWN and pins that; the note then goes through', async () => {
    const run = await h.control.startRun({ goal: 'prompt pins', target: {} });
    lineage = (await h.deps.blackboard.postRecord({ runId: run.runId, recordType: 'finding', createdBy: 'agent-executor', payload: FINDING('open') }, h.ctx(run.runId))).lineageId;
    const t0 = await h.control.tick(run.runId);
    assert.equal(await runItem(h.control, t0.dispatched[0]!.workItemId, t0.dispatched[0]!.fencingToken), 'completed');
    const d = (await h.control.tick(run.runId)).dispatched[0]!;
    assert.equal(await runItem(h.control, d.workItemId, d.fencingToken), 'completed');
    const [refused, accepted] = results;
    assert.equal(refused!.isError, true);
    // refused for the WITHDRAWAL (always re-checked), not for a mere version change of a finding it only saw listed
    assert.match(refused!.content, new RegExp(`^\\[stale_context\\] stale_context: stale context \\(snapshot cs_\\w+\\): finding_withdrawal/${lineage}: version_changed \\(now withdrawn:rejected\\)`));
    assert.doesNotMatch(refused!.content, new RegExp(`(^|[ ;:])finding/${lineage}:`));
    assert.match(texts[1]!, new RegExp(`finding rec_\\w+ CHANGED since you saw rec_\\w+ — WITHDRAWN \\(rejected\\)`), 'the next prompt tells the agent');
    assert.equal(accepted!.isError, false, accepted!.content);
    // what the prompt delivered is recorded (toolId context.assemble), under the turn's snapshot
    const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
    const seen = await h.deps.observations!.latest({ runId: run.runId, agentId: agent.agentId });
    const w = seen.find((o) => o.resourceType === 'finding_withdrawal' && o.resourceId === lineage)!;
    assert.equal(w.toolId, 'context.assemble');
    assert.equal(w.observedVersion, 'withdrawn:rejected');
    assert.ok(w.snapshotId);
    const notes = await h.deps.blackboard.query({ runId: run.runId, recordType: 'note' });
    assert.equal(notes.length, 1, 'only the accepted note was written');
  });
});

describe('(review: liveness) a finding merely LISTED in the prompt that is updated without being withdrawn does not block the agent', () => {
  let h: Harness;
  let lineage = '';
  const results: Array<{ name: string; content: string; isError: boolean }> = [];
  before(async () => {
    h = await createHarness({
      brains: {
        lead: (v) => (v.step === 0
          ? call('plan.propose_revision', { rationale: 'design', objectives: [{ objectiveId: 'obj', description: 'regression coverage', priority: 'P1' }], workItems: [{ localId: 'd1', title: 'design', objective: 'design a regression test', role: 'test_designer', dependsOn: [], objectiveIds: ['obj'] }] })
          : call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [] } })),
        test_designer: async (v) => {
          if (v.lastResult) results.push(v.lastResult);
          switch (v.step) {
            case 0: {
              assert.match(v.userText, new RegExp(`finding ${lineage}: \\[P2, product_defect, open\\]`));
              // a reviewer CONFIRMS the listed finding while this agent decides (a new version, not a withdrawal)
              const head = (await h.deps.blackboard.head(lineage))!;
              await h.deps.blackboard.postRecord({ runId: v.runId, recordType: 'finding', createdBy: 'agent-reviewer', supersedes: head.recordId, payload: FINDING('confirmed') }, h.ctx(v.runId));
              return call('blackboard.post_note', { text: 'unrelated design note' });
            }
            default:
              return call('complete_work', { summary: 'done', output: { summary: 'done', testArtifacts: [] } });
          }
        },
      },
    });
    withContextEngine(h);
  });
  after(async () => h.dispose());

  test('the note goes through: the listed finding is pinned for withdrawal (always) and by version only for actions naming it', async () => {
    const run = await h.control.startRun({ goal: 'listed findings', target: {} });
    lineage = (await h.deps.blackboard.postRecord({ runId: run.runId, recordType: 'finding', createdBy: 'agent-executor', payload: FINDING('open') }, h.ctx(run.runId))).lineageId;
    const t0 = await h.control.tick(run.runId);
    assert.equal(await runItem(h.control, t0.dispatched[0]!.workItemId, t0.dispatched[0]!.fencingToken), 'completed');
    const d = (await h.control.tick(run.runId)).dispatched[0]!;
    assert.equal(await runItem(h.control, d.workItemId, d.fencingToken), 'completed');
    assert.equal(results[0]!.isError, false, results[0]!.content);
    assert.equal((await h.deps.blackboard.query({ runId: run.runId, recordType: 'note' })).length, 1);
    // what the listing pinned: the lineage as `record` (checked when named) and the withdrawal state — no `finding` pin
    const agent = (await h.deps.agents.byWorkItem(d.workItemId))!;
    const seen = (await h.deps.observations!.latest({ runId: run.runId, agentId: agent.agentId })).filter((o) => o.resourceId === lineage && o.toolId === 'context.assemble');
    assert.deepEqual(seen.map((o) => o.resourceType).sort(), ['finding_withdrawal', 'record']);
  });
});

describe('(B[1]) a durable replay of a record call that already took effect is never refused as stale by its own write', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ brains: { lead: idle } });
    withContextEngine(h);
  });
  after(async () => h.dispose());

  test('the pass is recorded with the effect; the replay on a now-stale snapshot returns the recorded outcome', async () => {
    const { run, item, agent, spec, token } = await leadTurn(h, 'replay');
    const finding = await h.deps.blackboard.postRecord({ runId: run.runId, recordType: 'finding', createdBy: 'agent-executor', payload: FINDING('open') }, h.ctx(run.runId));
    const ctx = { runId: run.runId, correlationId: item.workItemId, actorId: agent.agentId, workItemId: item.workItemId, agentId: agent.agentId };
    // the turn snapshot pins the finding the lead read
    const snapshot: ContextSnapshot = await h.deps.snapshotBuilder.build({ runId: run.runId, readSet: [{ resourceType: 'finding', resourceId: finding.lineageId, observedVersion: finding.recordId, observedAt: h.clock.isoNow(), freshness: { kind: 'exact_version' } }] }, ctx);
    const input: DispatcherInput = {
      runId: run.runId, workItemId: item.workItemId, agentId: agent.agentId, role: 'lead', sessionId: agent.sessionId, capability: spec.capability,
      allow: ['blackboard.read', 'request_approval'], deny: [], workspace: await h.deps.workspaces.scratch({ runId: run.runId, workItemId: item.workItemId }),
      eventContext: ctx, turnState: { turn: 40, snapshot }, fencingToken: token,
    };
    const d = createToolDispatcher(h.deps, input);
    const meta = { sessionId: agent.sessionId, turn: 40, invocationId: `${agent.sessionId}:40:r1`, signal: new AbortController().signal };
    const args = { kind: 'manual_review', subject: { what: 'replay' }, rationale: 'a replay must not file twice' };
    const first = await d.dispatch({ id: 'r1', name: 'request_approval', arguments: args }, meta);
    assert.notEqual(first.message.isError, true, String(first.message.content));
    assert.ok(await h.deps.freshnessPasses!.get(meta.invocationId), 'the pass committed with the effect');
    // the finding the snapshot pins changes: a NEW call on this snapshot is stale, the replay of the first is not
    await h.deps.blackboard.postRecord({ runId: run.runId, recordType: 'finding', createdBy: 'agent-reviewer', supersedes: finding.recordId, payload: FINDING('confirmed') }, h.ctx(run.runId));
    const fresh = await createToolDispatcher(h.deps, input).dispatch({ id: 'r2', name: 'request_approval', arguments: args }, { ...meta, invocationId: `${agent.sessionId}:40:r2` });
    assert.match(String(fresh.message.content), /^\[stale_context\]/);
    const replay = await createToolDispatcher(h.deps, input).dispatch({ id: 'r1', name: 'request_approval', arguments: args }, meta);
    assert.notEqual(replay.message.isError, true, String(replay.message.content));
    assert.equal((await h.deps.approvals.list({ runId: run.runId })).length, 1, 'filed once');
  });
});
