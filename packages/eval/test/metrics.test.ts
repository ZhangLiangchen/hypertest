/** Outcome and trajectory metrics over synthetic trial data (exact values). */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { analyzeSideEffects, distinctRoleRoutes, maxParallelWork, outcomeMetrics, routesByRole, timeToFirstEvidenceMs, trajectoryMetrics, type EvalTask } from '../src/index.ts';
import { Log, data, decision, evidence, finding, operation, permit, plan, task } from './helpers.ts';

describe('outcomeMetrics', () => {
  test('verdict family: match, critical false release, false fail', () => {
    const m = (verdict: 'pass' | 'fail' | 'conditional' | 'inconclusive', expected: EvalTask['expectedVerdict']) => {
      const o = outcomeMetrics(task({ expectedVerdict: expected }), data({ decision: decision(verdict) }));
      return [o['verdictMatch'], o['criticalFalseRelease'], o['falseFail']];
    };
    assert.deepEqual(m('fail', 'fail'), [1, 0, 0]);
    assert.deepEqual(m('pass', 'fail'), [0, 1, 0], 'a defect released');
    assert.deepEqual(m('pass', ['fail', 'inconclusive']), [0, 1, 0]);
    assert.deepEqual(m('inconclusive', 'fail'), [0, 0, 0], 'inconclusive is not a release');
    assert.deepEqual(m('fail', 'pass'), [0, 0, 1], 'a false alarm');
    assert.deepEqual(m('pass', ['pass', 'conditional']), [1, 0, 0]);
    // conditional = every fail-type criterion (unresolved P0/P1 findings included) satisfied: the defect was released
    assert.deepEqual(m('conditional', 'fail'), [0, 1, 0], 'a conditional release of a defect');
    assert.deepEqual(m('conditional', ['fail', 'inconclusive']), [0, 1, 0]);
    assert.deepEqual(m('pass', 'conditional'), [0, 0, 0], 'a release was expected: a mismatch, not a false release');
    assert.deepEqual(m('conditional', ['pass', 'conditional']), [1, 0, 0]);
    const none = outcomeMetrics(task(), data());
    assert.deepEqual([none['verdictMatch'], none['criticalFalseRelease'], none['falseFail']], [0, 0, 0]);
  });

  test('defect recall and false-positive product findings', () => {
    const t = task({ hiddenFaults: [{ faultId: 'f1', description: '', severity: 'P1', detectionHints: ['sum'] }, { faultId: 'f2', description: '', severity: 'P2', detectionHints: ['div'] }] });
    const d = data({
      evidence: [evidence('ev_1', 'test-result')],
      findings: [finding('rec_1', { title: 'sum wrong' }, ['ev_1']), finding('rec_2', { title: 'unrelated crash' }, ['ev_1']), finding('rec_3', { title: 'flaky', category: 'test_defect' }, ['ev_1'])],
    });
    const o = outcomeMetrics(t, d);
    assert.equal(o['defectRecall'], 0.5);
    assert.equal(o['falsePositiveFindings'], 1, 'only product findings matching no hidden fault');
    assert.equal(Object.hasOwn(outcomeMetrics(task(), d), 'defectRecall'), false, 'no hidden fault ⇒ no recall metric');
  });

  test('side effects: duplicates only with the probe; orphans are operations left unreconciled', () => {
    const ops = [operation('op_1', 'verified'), operation('op_2', 'acknowledged'), operation('op_3', 'outcome_unknown'), operation('op_4', 'failed')];
    const withProbe = outcomeMetrics(task(), data({ operations: ops, probes: { sideEffects: { a: 3, b: 1, c: 2 } } }));
    assert.equal(withProbe['duplicateSideEffects'], 3);
    assert.equal(withProbe['orphanOperations'], 2);
    const noProbe = outcomeMetrics(task(), data({ operations: ops }));
    assert.equal(Object.hasOwn(noProbe, 'duplicateSideEffects'), false);
  });

  test('orphan operations: also jobs escalated to manual_review and orphaned late receipts (counted once per operation)', () => {
    const ops = [operation('op_1', 'verified'), operation('op_2', 'manual_review'), operation('op_3', 'not_applied')];
    const log = new Log()
      // a dispatch receipt that came back after a re-dispatch: an external job nobody owns
      .add('operation.late_receipt', { operationId: 'op_3', disposition: 'orphaned', externalJobId: 'job-7', dispatchedAttempt: 1, currentAttempt: 2, currentStatus: 'not_applied' })
      .add('operation.late_receipt', { operationId: 'op_3', disposition: 'orphaned', dispatchedAttempt: 1, currentAttempt: 2, currentStatus: 'not_applied' })
      // already counted (manual_review), and a manual_review disposition alone is not an extra orphan
      .add('operation.late_receipt', { operationId: 'op_2', disposition: 'orphaned', dispatchedAttempt: 1, currentAttempt: 1, currentStatus: 'manual_review' })
      .add('operation.late_receipt', { operationId: 'op_1', disposition: 'manual_review', dispatchedAttempt: 1, currentAttempt: 1, currentStatus: 'verified' });
    const d = data({ operations: ops, events: log.events });
    assert.equal(outcomeMetrics(task(), d)['orphanOperations'], 2);
    assert.deepEqual(analyzeSideEffects(d).unsettled, ['op_2 (env.restart, manual_review)', 'op_3 (late receipt after a re-dispatch: orphaned external job job-7)']);
  });

  test('policy: violations (executed after deny, unpermitted calls), denials, stale-context actions and rejections', () => {
    const log = new Log()
      .add('tool.denied', { toolId: 'env.restart', invocationId: 'inv_s', status: 'stale_context' })
      .add('context.stale_rejected', { snapshotId: 's', tool: 'env.restart' })
      .add('tool.completed', { toolId: 'env.restart', invocationId: 'inv_s', status: 'success' })
      .add('tool.denied', { toolId: 'env.deploy', invocationId: 'inv_d', status: 'denied' })
      .tool('inv_ok', 'fs.read', 'pd_ok')
      .tool('inv_bad', 'fs.read', 'pd_missing');
    const o = outcomeMetrics(task(), data({ events: log.events, policyDecisions: [permit('pd_ok', 'allow')] }));
    assert.deepEqual([o['policyViolations'], o['toolDenials'], o['staleContextActions'], o['staleContextRejections']], [2, 2, 1, 1]);
  });

  test('evidence completeness, ledger verification and time to first evidence', () => {
    const log = new Log().add('run.created', {}).add('work.created', { workItemId: 'wi' }).add('evidence.attached', { evidenceId: 'ev_1' }).add('evidence.attached', { evidenceId: 'ev_2' });
    const d = data({ events: log.events, evidence: [evidence('ev_1', 'log')], findings: [finding('rec_1', {}, ['ev_1']), finding('rec_2', {}, [])] });
    const o = outcomeMetrics(task(), d);
    assert.deepEqual([o['evidenceCompleteness'], o['evidenceVerified'], o['timeToFirstEvidenceMs']], [0.5, 1, 2000]);
    assert.equal(timeToFirstEvidenceMs(new Log().add('run.created', {}).events), undefined);
    const bad = outcomeMetrics(task(), data({ verification: { ok: false, runId: 'r', count: 0, rootHash: 'x', problems: [] } }));
    assert.equal(bad['evidenceVerified'], 0);
    assert.equal(Object.hasOwn(bad, 'timeToFirstEvidenceMs'), false);
  });

  test('metric.* probes (finite numbers) override the recorded value: the environment wins', () => {
    const o = outcomeMetrics(task(), data({ probes: { 'metric.orphanOperations': 4, 'metric.serviceRequests': 12, 'metric.bad': 'x', 'metric.inf': Number.POSITIVE_INFINITY as never, other: 5 } }));
    assert.equal(o['orphanOperations'], 4);
    assert.equal(o['serviceRequests'], 12);
    for (const k of ['bad', 'inf', 'other', 'metric.other']) assert.equal(Object.hasOwn(o, k), false, k);
  });
});

describe('trajectoryMetrics (explanatory)', () => {
  test('plans, agents, model calls per route, tokens, fallbacks, tool calls, harness facts', () => {
    const log = new Log()
      .add('agent.spawned', { agentId: 'ag_1' })
      .add('agent.spawned', { agentId: 'ag_2' })
      .add('agent.spawned', { agentId: 'ag_2' })
      .model('ag_1', 'lead', 'big', { inputTokens: 1000, outputTokens: 50, costUsd: 0.5 })
      .model('ag_2', 'executor', 'small', { inputTokens: 200, outputTokens: 20, costUsd: 0.25 })
      .model('ag_2', 'executor', 'small', { inputTokens: 300, outputTokens: 30, costUsd: 0.25 })
      .add('model.invoked', { ok: false, routeId: 'small', error: { code: 'timeout' } }, { aggregateId: 'ag_2' })
      .add('model.fallback', { from: 'small', to: 'big' })
      .tool('inv_1', 'fs.read', 'pd')
      .tool('inv_2', 'fs.read', 'pd');
    const t = trajectoryMetrics(data({ events: log.events, plans: [plan(1, 'superseded'), plan(2, 'accepted'), plan(3, 'rejected')], evidence: [evidence('ev_1', 'log')], harness: { restarts: 1, injectedModelTimeouts: 1, duplicateDelivery: true, timedOut: false } }));
    assert.deepEqual(t, {
      planRevisions: 2, planProposals: 3, workItems: 0, agents: 2, modelCalls: 3, modelFailures: 1, modelFallbacks: 1, toolCalls: 2,
      inputTokens: 1500, outputTokens: 100, tokens: 1600, costUsd: 1, evidenceRecords: 1, events: log.events.length, restarts: 1, injectedModelTimeouts: 1,
      'modelCalls:big': 1, 'modelCalls:small': 2, maxParallelWork: 0, distinctRoutes: 2, distinctRoleRoutes: 2,
    });
  });

  test('maxParallelWork follows running intervals in seq order (waiting, requeue and terminal states close them)', () => {
    const log = new Log()
      .work('a', 'running')
      .work('b', 'running')
      .work('a', 'waiting')
      .work('c', 'running')
      .add('work.requeued', { workItemId: 'b', to: 'ready' })
      .work('a', 'running')
      .work('d', 'running')
      .work('d', 'completed');
    assert.equal(maxParallelWork(log.events), 3);
    assert.equal(maxParallelWork(new Log().work('a', 'running').work('a', 'completed').work('b', 'running').events), 1);
    assert.equal(maxParallelWork(new Log().add('work.updated', { workItemId: 'a' }).events), 0, 'events without a target state are ignored');
  });

  test('distinctRoleRoutes is a maximum matching (fallback routes cannot inflate it)', () => {
    const log = new Log().model('1', 'lead', 'r1').model('2', 'executor', 'r1').model('3', 'reviewer', 'r1').model('3', 'reviewer', 'r2');
    assert.equal(distinctRoleRoutes(routesByRole(log.events)), 2);
    const three = new Log().model('1', 'lead', 'r1').model('1', 'lead', 'r2').model('2', 'executor', 'r1').model('3', 'reviewer', 'r2').model('3', 'reviewer', 'r3');
    assert.equal(distinctRoleRoutes(routesByRole(three.events)), 3, 'augmenting paths reassign lead to r2, reviewer to r3');
    const one = new Log().model('1', 'lead', 'r1').model('1', 'lead', 'r2').model('1', 'lead', 'r3');
    assert.equal(distinctRoleRoutes(routesByRole(one.events)), 1, 'one role using three routes is one');
    const failed = new Log().add('model.routed', { ok: false, role: 'lead', routeId: null });
    assert.equal(routesByRole(failed.events).size, 0);
  });
});
