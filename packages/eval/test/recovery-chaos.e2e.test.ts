/**
 * recovery-chaos — one trial of the scripted multi-LLM arm on the PoC C fixture with Hypertest in a CHILD PROCESS that
 * is SIGKILLed twice at different points of its side effects: (1) while the service restart is in flight at the
 * supervisor (dispatched, no receipt yet: an unknown outcome), (2) while the load job runs (acknowledged, no evidence
 * yet). Each time a `resume` child takes over. Zero duplicate side effects, zero orphan operations: the restart is
 * reconciled by its operation id (never re-sent), the load job is re-attached (never re-created), the run passes.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempDir } from '@hypertest/testkit';
import { recoveryChaosTask, runTrial, scriptedMultiLlmArm } from '../src/index.ts';
import { assertSchemasDropped, capture, eventCounts, failures, payloadOf, schemaPrefix, trialOptions } from './fixtures/poc-e2e.ts';

const PREFIX = schemaPrefix('r');
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-recovery-chaos-')));
after(async () => {
  await root.cleanup();
  await assertSchemasDropped(PREFIX);
});

test('recovery-chaos: two SIGKILLs (restart in flight, load job running) ⇒ zero duplicate side effects, zero orphan operations', async () => {
  const acceptance = capture((ctx) => {
    const d = ctx.data;
    const opOf = (type: string) => d.operations.find((o) => o.operationType === type);
    const transitions = (type: string) => d.events.filter((e) => e.aggregateId === opOf(type)?.operationId && e.eventType.startsWith('operation.')).map((e) => String(payloadOf(e)['to']));
    return {
      verdict: d.decision?.verdict,
      status: d.status,
      restarts: d.harness.restarts,
      ops: d.operations.map((o) => `${o.operationType}:${o.status}`).sort(),
      restart: transitions('env.restart'),
      load: transitions('load.start'),
      effects: d.probes['sideEffects'] as Record<string, number>,
      restartOpId: opOf('env.restart')?.operationId,
      loadItem: d.workItems.find((w) => w.role === 'environment' && /load\.start/.test(w.objective))?.workItemId,
      loadOpId: opOf('load.start')?.operationId,
      loadJobs: (d.probes['loadJobs'] as Array<{ operationId: string; state?: string }>).map((j) => `${j.operationId === opOf('load.start')?.operationId ? 'the-load-op' : j.operationId}:${j.state}`),
      recovery: d.report?.recovery.map((r) => r.detail) ?? [],
      counts: eventCounts(d.events, ['operation.dispatched', 'operation.reconciled', 'run.recovered']),
    };
  });
  const task = recoveryChaosTask();
  const trial = await runTrial({ ...task, graders: [...task.graders, 'acceptance'] }, scriptedMultiLlmArm, trialOptions(PREFIX, join(root.path, 'trial'), { mode: 'child-process', graders: { acceptance: acceptance.grader } }));
  assert.deepEqual(failures(trial), [], JSON.stringify(trial.graders, null, 1));
  assert.deepEqual([trial.result, trial.verdict, trial.error], ['pass', 'pass', undefined]);
  const a = acceptance.value();

  // both kill points were reached; resumed children finished the run
  assert.deepEqual([a.restarts, a.status, a.verdict], [2, 'completed', 'pass']);
  assert.equal(a.counts['run.recovered'], 2);
  // kill 1 landed while the restart was in flight: its outcome became unknown and was RECONCILED by operation id (the
  // supervisor answers per operation id) — the environment restarted exactly once, for exactly that operation
  assert.deepEqual(a.restart.slice(0, 4), ['prepared', 'dispatching', 'outcome_unknown', 'reconciling'], a.restart.join(' → '));
  assert.equal(a.restart.at(-1), 'verified');
  assert.equal(a.effects[a.restartOpId!], 1);
  assert.equal(a.effects['kv:restarts'], 1);
  // kill 2 landed while the load job ran: it was re-attached, never re-dispatched or re-created
  assert.deepEqual(a.load, ['prepared', 'dispatching', 'acknowledged', 'verified']);
  assert.deepEqual([a.effects['loadgen:jobs'], a.effects['loadgen:workers'], a.loadJobs], [1, 1, ['the-load-op:completed']]);
  // zero duplicate side effects, zero orphan operations
  assert.deepEqual([...new Set(Object.values(a.effects))], [1], JSON.stringify(a.effects));
  assert.deepEqual(a.ops, ['env.restart:verified', 'load.start:verified']);
  // the report explains both recoveries: what was reconciled, re-run and re-attached. The second pass names the load
  // item either way — re-attached while waiting on its job, or re-run when the kill landed between its committed
  // "waiting" turn and the waiting transition (the re-run turn then re-enters waiting on the recorded operation; the load
  // transitions above prove it was never re-dispatched)
  const passes = a.recovery.filter((r) => r.startsWith('recovery by worker:eval:'));
  assert.equal(passes.length, 2, a.recovery.join('\n'));
  const loadRecovery = passes[1]!;
  // (the kill may also land while other items run: they are listed in the same re-run clause)
  const reRun = new RegExp(`re-runs (?:[^—]*, )?${a.loadItem} \\(environment, was running, attempt 1\\)(?:, [^—]*)? — orphaned by the previous process`);
  assert.ok(loadRecovery.includes(`re-attached ${a.loadItem} (environment) to ${a.loadOpId} — still waiting, nothing re-created`) || reRun.test(loadRecovery), loadRecovery);
  assert.ok(a.recovery.some((r) => r.startsWith(`operation ${a.restartOpId} reconciled:`)), a.recovery.join('\n'));
});

test('recovery-chaos (Hypertest down until the load job has finished): the resumed process attaches the FINISHED job — its results become evidence, nothing is re-created', async () => {
  // Kill 2 lands while the 3 s load job runs, and Hypertest stays down (4 s) until the job has finished on its own. The
  // resumed process must attach the finished job by its operation id (the item was waiting on it): verified once, its
  // results recorded as the SLO evidence, no second job, no second worker.
  const acceptance = capture((ctx) => {
    const d = ctx.data;
    const loadOp = d.operations.find((o) => o.operationType === 'load.start');
    const jobs = d.probes['loadJobs'] as Array<{ operationId: string; state?: string }>;
    const recovered = d.events.filter((e) => e.eventType === 'run.recovered').map((e) => Date.parse(e.occurredAt));
    const results = d.evidence.filter((e) => e.evidenceType === 'metric' && e.operationId === loadOp?.operationId);
    const finishedAt = (results[0]?.structured as { finishedAt?: string } | undefined)?.finishedAt;
    return {
      verdict: d.decision?.verdict,
      restarts: d.harness.restarts,
      load: d.events.filter((e) => e.aggregateId === loadOp?.operationId && e.eventType.startsWith('operation.')).map((e) => String(payloadOf(e)['to'])),
      jobs: jobs.map((j) => `${j.operationId === loadOp?.operationId ? 'the-load-op' : j.operationId}:${j.state}`),
      effects: d.probes['sideEffects'] as Record<string, number>,
      // the job had finished before the process that attached it recovered the run
      finishedWhileDown: finishedAt !== undefined && recovered.length === 2 && Date.parse(finishedAt) < recovered[1]!,
      resultsEvidence: results.map((e) => `${e.environment?.environmentId}@${e.environment?.generation}`),
    };
  });
  const base = recoveryChaosTask();
  const [inFlight, loadRunning] = base.chaos!.kills!;
  const task = recoveryChaosTask({ taskId: 'recovery-chaos-downtime', chaos: { kills: [inFlight!, { ...loadRunning!, downtimeMs: 4000 }] } });
  const trial = await runTrial({ ...task, graders: [...task.graders, 'acceptance'] }, scriptedMultiLlmArm, trialOptions(PREFIX, join(root.path, 'downtime'), { mode: 'child-process', graders: { acceptance: acceptance.grader } }));
  assert.deepEqual(failures(trial), [], JSON.stringify(trial.graders, null, 1));
  assert.deepEqual([trial.result, trial.verdict, trial.error], ['pass', 'pass', undefined]);
  const a = acceptance.value();
  assert.equal(a.restarts, 2);
  assert.equal(a.finishedWhileDown, true, 'the job finished while Hypertest was down');
  assert.deepEqual(a.load, ['prepared', 'dispatching', 'acknowledged', 'verified']);
  assert.deepEqual(a.jobs, ['the-load-op:completed']);
  assert.deepEqual([a.effects['loadgen:jobs'], a.effects['loadgen:workers'], a.effects['kv:restarts']], [1, 1, 1]);
  assert.deepEqual([...new Set(Object.values(a.effects))], [1], JSON.stringify(a.effects));
  assert.deepEqual(a.resultsEvidence, ['kv@2']);
});
