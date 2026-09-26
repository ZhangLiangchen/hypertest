/**
 * PoC C — durable load + fault recovery, one trial each of the scripted multi-LLM arm with Hypertest in a CHILD
 * PROCESS: the harness SIGKILLs it right after the load.start operation was acknowledged (the load job keeps running
 * outside) and a `resume` child takes over. Also injected: a model timeout, a scripted provider outage (fallback route +
 * new epoch), every bus message delivered twice and a ~2 MiB tool output. Every grader of the task passes and the
 * acceptance table ("首批 PoC：长时压测与故障恢复闭环") is asserted row by row from the recorded state and the environment's
 * ground truth. The insufficient-data variant must end `inconclusive`, never `pass`.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Review } from '@hypertest/domain';
import { tempDir } from '@hypertest/testkit';
import { MAX_BOUNDED_MESSAGE_BYTES, MAX_BOUNDED_REQUEST_BYTES, maxConcurrent, pocCInsufficientTask, pocCTask, runTrial, scriptedMultiLlmArm, type BrainObservation } from '../src/index.ts';
import { DIAGNOSTIC_BYTES } from '../src/brains/index.ts';
import { assertSchemasDropped, capture, eventCounts, failures, payloadOf, routesOfRoles, schemaPrefix, trialOptions } from './fixtures/poc-e2e.ts';

const PREFIX = schemaPrefix('c');
let root: Awaited<ReturnType<typeof tempDir>>;
before(async () => (root = await tempDir('ht-poc-c-')));
after(async () => {
  await root.cleanup();
  await assertSchemasDropped(PREFIX);
});

test('PoC C: a SIGKILLed Hypertest resumes, re-attaches the running load job and passes the SLO on cited metric evidence', async () => {
  const acceptance = capture(async (ctx) => {
    const d = ctx.data;
    const evidence = new Map(d.evidence.map((e) => [e.evidenceId, e]));
    const obs = d.probes['observations'] as unknown as BrainObservation[];
    const loadOp = d.operations.find((o) => o.operationType === 'load.start');
    const reviews = await ctx.ht.services.blackboard.query<Review>({ runId: d.runId!, recordType: 'review' });
    const loadItem = d.workItems.find((w) => w.role === 'environment' && /load\.start/.test(w.objective));
    const loadAgent = d.events.find((e) => e.eventType === 'agent.spawned' && payloadOf(e)['workItemId'] === loadItem?.workItemId)?.agentId;
    const envAndDump = d.workItems.filter((w) => w.role === 'environment' || w.role === 'executor').map((w) => w.workItemId);
    const claims = d.report?.claims.filter((c) => c.critical) ?? [];
    const jobEvidence = d.evidence.filter((e) => e.evidenceType === 'metric' && e.operationId === loadOp?.operationId);
    return {
      verdict: d.decision?.verdict,
      status: d.status,
      restarts: d.harness.restarts,
      injected: d.harness.injectedModelTimeouts,
      duplicateDelivery: d.harness.duplicateDelivery,
      ops: d.operations.map((o) => `${o.operationType}:${o.status}`).sort(),
      loadTransitions: d.events.filter((e) => e.aggregateId === loadOp?.operationId && e.eventType.startsWith('operation.')).map((e) => String(payloadOf(e)['to'])),
      effects: d.probes['sideEffects'] as Record<string, number>,
      loadJobs: (d.probes['loadJobs'] as Array<{ operationId: string; state?: string }>).map((j) => `${j.operationId === loadOp?.operationId ? 'the-load-op' : j.operationId}:${j.state}`),
      fingerprintsUnique: new Set(d.workItems.map((w) => w.fingerprint)).size === d.workItems.length,
      loadFirstCalls: obs.filter((o) => o.workItemId === loadItem?.workItemId && o.step === 0).length,
      loadTurns: d.sessionTurns.filter((t) => t.agentId === loadAgent).map((t) => t.turn),
      afterLarge: obs.filter((o) => o.tag === 'after_large_output').map((o) => [o.requestBytes, o.maxMessageBytes]),
      largeArtifacts: d.evidence.filter((e) => e.artifact.size >= DIAGNOSTIC_BYTES).map((e) => e.evidenceType).sort(),
      claims: claims.map((c) => ({ field: c.evidenceQuery.field, cites: c.evidenceRefs.map((id) => (jobEvidence.some((e) => e.evidenceId === id) ? 'load-job-metric' : evidence.get(id)?.evidenceType)) })),
      provenance: (d.report?.json as { provenance?: Array<{ complete: boolean; gaps: string[] }> } | undefined)?.provenance?.map((t) => (t.complete ? 'complete' : t.gaps.join('; '))),
      jobEnvironment: jobEvidence.map((e) => e.environment && `${e.environment.environmentId}@${e.environment.generation}`),
      parallelEnvAndDump: maxConcurrent(d.events, new Set(envAndDump)),
      routes: routesOfRoles(d.events),
      fallbacks: d.events.filter((e) => e.eventType === 'model.fallback').map((e) => `${String(payloadOf(e)['from'])}→${String(payloadOf(e)['to'])}`),
      reviews: reviews.map((r) => ({ verdict: r.payload.verdict, provider: r.payload.modelProvider, subject: r.payload.subjectRef.kind, checked: [...new Set(r.payload.checkedEvidenceRefs.map((id) => evidence.get(id)?.evidenceType))] })),
      recovery: d.report?.recovery.map((r) => r.detail) ?? [],
      counts: eventCounts(d.events, ['operation.dispatched', 'run.recovered']),
    };
  });
  const task = pocCTask();
  const trial = await runTrial(
    { ...task, graders: [...task.graders, 'acceptance'] },
    scriptedMultiLlmArm,
    trialOptions(PREFIX, join(root.path, 'trial'), { mode: 'child-process', graders: { acceptance: acceptance.grader } }),
  );
  assert.deepEqual(failures(trial), [], JSON.stringify(trial.graders, null, 1));
  assert.deepEqual([trial.result, trial.verdict, trial.error], ['pass', 'pass', undefined]);
  assert.deepEqual(trial.graders.map((g) => g.graderId), [...task.graders, 'acceptance']);
  const a = acceptance.value();

  // Durable — the Hypertest process was SIGKILLed after the load job was acknowledged; a resumed process finished the run
  assert.deepEqual([a.restarts, a.status], [1, 'completed']);
  // Idempotency — the completed destructive restart and the running load job were never repeated: the environment saw one
  // restart and one load job (one worker); each operation was dispatched once and verified: the job was RE-ATTACHED
  assert.deepEqual(a.ops, ['env.restart:verified', 'load.start:verified']);
  assert.deepEqual(a.loadTransitions, ['prepared', 'dispatching', 'acknowledged', 'verified']);
  assert.equal(a.counts['operation.dispatched'], 2);
  assert.deepEqual([a.effects['kv:restarts'], a.effects['loadgen:jobs'], a.effects['loadgen:workers']], [1, 1, 1]);
  assert.deepEqual([...new Set(Object.values(a.effects))], [1], JSON.stringify(a.effects));
  assert.deepEqual(a.loadJobs, ['the-load-op:completed']);
  // Recovery audit — the resumed process recorded what it recovered, and the report explains it
  assert.ok(a.counts['run.recovered']! >= 1);
  assert.ok(a.recovery.some((r) => /^recovery by worker:eval:run_\w+: /.test(r)), a.recovery.join('\n'));
  // Context — rebuilt from the stores, not re-generated: the load item's committed first turn was never asked again and
  // its committed turns are unique; the 2 MiB dump is an offloaded tool-output artifact; every request after it stayed bounded
  assert.equal(a.loadFirstCalls, 1);
  assert.deepEqual(a.loadTurns, [...new Set(a.loadTurns)].sort((x, y) => x - y));
  assert.ok(a.largeArtifacts.includes('tool-output'), a.largeArtifacts.join(', '));
  assert.ok(a.afterLarge.length >= 1);
  for (const [requestBytes, maxMessageBytes] of a.afterLarge) assert.ok(requestBytes! < MAX_BOUNDED_REQUEST_BYTES && maxMessageBytes! < MAX_BOUNDED_MESSAGE_BYTES, `${requestBytes} / ${maxMessageBytes}`);
  // Metrics + Evidence — both SLO claims cite the load job's own metric evidence (recorded with the environment generation
  // the job measured: after the restart) and their provenance traces completely
  assert.deepEqual(a.claims, [{ field: 'latencyMs.p99', cites: ['load-job-metric'] }, { field: 'errorRate', cites: ['load-job-metric'] }]);
  assert.deepEqual(a.provenance, ['complete', 'complete']);
  assert.deepEqual(a.jobEnvironment, ['kv@2']);
  // Multi-Agent — the diagnostics dump ran in parallel with the environment work
  assert.ok(a.parallelEnvAndDump >= 2, `max ${a.parallelEnvAndDump} concurrently`);
  // Multi-LLM — roles routed by policy; the reason-a outage failed over (re-validated) to another route in a new epoch;
  // the injected model timeout happened
  assert.deepEqual([a.routes['lead'], a.routes['environment'], a.routes['executor'], a.routes['reviewer']], [['reason-a-large'], ['fast-b-tools'], ['fast-b-tools'], ['judge-c-review']]);
  assert.ok(a.routes['metrics_analyst']?.includes('fast-b-tools'), JSON.stringify(a.routes));
  assert.ok(a.fallbacks.includes('reason-a-large→fast-b-tools'), a.fallbacks.join(', '));
  assert.equal(a.injected, 1);
  // Duplicate event — every bus message was delivered twice, yet no work item exists twice
  assert.deepEqual([a.duplicateDelivery, a.fingerprintsUnique], [true, true]);
  // Review — an independent provider approved the run on the recorded metric evidence
  assert.deepEqual(a.reviews, [{ verdict: 'approve', provider: 'judge-c', subject: 'run', checked: ['metric'] }]);
  // Gate — the evidence is sufficient and the SLO holds: pass
  assert.equal(a.verdict, 'pass');
});

test('PoC C (insufficient data): the load job latency is never recorded as evidence ⇒ inconclusive, never pass', async () => {
  const acceptance = capture((ctx) => {
    const d = ctx.data;
    return {
      verdict: d.decision?.verdict,
      unknown: d.decision?.unknownCriteria.map((c) => c.criterionId).sort(),
      violated: d.decision?.violatedCriteria.map((c) => c.criterionId),
      unproven: d.decision?.reasons.filter((r) => /unproven/.test(r)),
      latencyEvidence: d.evidence.filter((e) => e.evidenceType === 'metric' && (e.structured as { latencyMs?: unknown } | undefined)?.latencyMs !== undefined).length,
      loadJobs: (d.probes['loadJobs'] as Array<{ state?: string }>).map((j) => j.state),
      dataSufficient: d.workItems.filter((w) => w.role === 'metrics_analyst').map((w) => (w.result?.output as { dataSufficient?: unknown } | undefined)?.dataSufficient),
    };
  });
  const task = pocCInsufficientTask();
  const trial = await runTrial({ ...task, graders: [...task.graders, 'acceptance'] }, scriptedMultiLlmArm, trialOptions(PREFIX, join(root.path, 'insufficient'), { mode: 'child-process', graders: { acceptance: acceptance.grader } }));
  assert.deepEqual(failures(trial), [], JSON.stringify(trial.graders, null, 1));
  assert.deepEqual([trial.result, trial.verdict, trial.error], ['pass', 'inconclusive', undefined]);
  const a = acceptance.value();
  // the load job ran and completed, but its latency / error rate were never recorded as evidence: the analyst said so
  assert.deepEqual([a.loadJobs, a.latencyEvidence, a.dataSufficient], [['completed'], 0, [false]]);
  // Gate — insufficient data can only be inconclusive: the SLO criteria are unknown (unproven), nothing violated, no pass
  assert.equal(a.verdict, 'inconclusive');
  assert.ok(a.unknown?.includes('C3'), `unknown ${a.unknown?.join(', ')}`);
  assert.deepEqual(a.violated, []);
  assert.deepEqual(a.unproven, ['C3 kv-slo@1/C1 (P1) unproven: no metric evidence with field latencyMs.p99', 'C3 kv-slo@1/C2 (P1) unproven: no metric evidence with field errorRate']);
});
