/**
 * PoC C brains — durable load + fault recovery on kv-service (environment `kv`, process-supervised).
 *
 *   lead Plan v1 (parallel where independent):
 *     prepare (environment)       env.restart (a governed destructive operation) → verify /health
 *     load    (environment, ←prepare)  load.start 30 rps × 3 s (an external job with an operation id; the item waits on
 *                                  it) → metrics.scrape shows the achieved rate → reports the job's operation id
 *     dump    (executor, parallel)  shell.exec printing ~2 MiB of diagnostics: offloaded to an artifact, the next model
 *                                  request stays bounded (the brain checks and records what it received)
 *     analyse (metrics_analyst, ←load) load.observe (the job's results as metric evidence: latencyMs.p99, errorRate) →
 *                                  metrics.scrape → critical claims citing the metric evidence
 *                                  (variant `insufficient`: never records the job's latency evidence)
 *     review  (reviewer, ←analyse, dump, prepare) independent review of the RUN from the metric evidence
 *   → plan drained → lead Plan v2 readyForGate ⇒ pass (inconclusive for the insufficient variant).
 *
 * Provider outage (multi arm): `reason-a` answers the metrics analyst's first call with timeouts on every attempt ⇒
 * the router falls back to another route and a new ModelEpoch starts at the next turn.
 */
import type { JsonValue } from '@hypertest/core';
import { evIds, jsonOf, leadReply, opIds, requestBytes, resultText, str, toolCall, type BrainView, type RoleBrain } from './kit.ts';

export const KV_ENV_ID = 'kv';
export const KV_ORACLE_ID = 'kv-slo';
/** Load profile of the experiment (the oracle's C1 names 30 rps). */
export const KV_LOAD = Object.freeze({ path: '/kv/k1', method: 'GET', ratePerSecond: 30, durationMs: 3000, concurrency: 8 });
/** Size of the diagnostics dump the executor prints (≥ the chaos plan's largeOutputBytes). */
export const DIAGNOSTIC_LINE = 'kv-diagnostic 0123456789abcdef\n';
export const DIAGNOSTIC_REPEAT = 70_000;
export const DIAGNOSTIC_BYTES = DIAGNOSTIC_LINE.length * DIAGNOSTIC_REPEAT;
/** A model request after the offloaded dump must stay below this (bytes): only bounded digests enter messages (I9). */
export const MAX_REQUEST_BYTES_AFTER_OFFLOAD = 256 * 1024;

const OBJECTIVE = {
  objectiveId: 'obj-slo',
  description: 'Decide from metric evidence whether kv-service meets its SLO (oracle kv-slo: p99 latency < 250 ms at 30 rps, error rate < 1%) and is releasable.',
  priority: 'P1',
  acceptanceCriteria: ['a 30 rps load job ran on a fresh service generation', 'latency and error rate of that job are metric evidence', 'an independent review of the run'],
};

function leadComplete(summary: string, ready: boolean, status: 'open' | 'satisfied' | 'unsatisfiable', evidenceRefs: string[]) {
  return toolCall('complete_work', {
    summary, evidenceRefs,
    output: { summary, planProposed: true, readyForGate: ready, objectives: [{ objectiveId: OBJECTIVE.objectiveId, status, evidenceRefs, ...(status === 'unsatisfiable' ? { note: 'the load job latency was never recorded as evidence' } : {}) }] },
  });
}

export const pocCLead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) {
      return leadReply('performance goal: fresh generation, load, metrics, independent review; the dump runs in parallel', 'plan.propose_revision', {
        rationale: 'Plan v1: restart kv-service to a known generation, run the 30 rps load job, quantify its latency and error rate from metric evidence, collect the diagnostics dump in parallel, and have the run reviewed independently.',
        objectives: [OBJECTIVE],
        workItems: [
          {
            localId: 'prepare', title: 'Restart kv-service', role: 'environment', dependsOn: [], objectiveIds: [OBJECTIVE.objectiveId],
            objective: `Restart environment ${KV_ENV_ID} with env.restart to a fresh generation, then verify with http.request GET /health that it serves.`,
          },
          {
            localId: 'load', title: 'Run the 30 rps load job', role: 'environment', dependsOn: ['prepare'], objectiveIds: [OBJECTIVE.objectiveId],
            objective: `Run load.start against environment ${KV_ENV_ID}: ${KV_LOAD.method} ${KV_LOAD.path} at ${KV_LOAD.ratePerSecond} rps for ${KV_LOAD.durationMs} ms (concurrency ${KV_LOAD.concurrency}). Wait for the job, verify the achieved rate with metrics.scrape and report the load job's operation id.`,
            evidenceRequirements: [{ evidenceType: 'metric', minCount: 1, critical: true }],
          },
          {
            localId: 'dump', title: 'Collect the diagnostics dump', role: 'executor', dependsOn: [], objectiveIds: [OBJECTIVE.objectiveId],
            objective: 'Collect the kv-service diagnostics dump with shell.exec (it is large) and confirm what it contains.',
          },
          {
            localId: 'analyse', title: 'Quantify latency and error rate', role: 'metrics_analyst', dependsOn: ['load'], objectiveIds: [OBJECTIVE.objectiveId],
            objective: `Quantify the latency (p99) and error rate of the load job reported by the load item against oracle ${KV_ORACLE_ID} (C1 p99 < 250 ms at 30 rps, C2 error rate < 1%): load.observe the job, metrics.scrape environment ${KV_ENV_ID}, judge data sufficiency and record critical claims citing the metric evidence.`,
            evidenceRequirements: [{ evidenceType: 'metric', minCount: 1, critical: true }],
          },
          {
            localId: 'review', title: 'Review the run', role: 'reviewer', dependsOn: ['analyse', 'dump', 'prepare'], objectiveIds: [OBJECTIVE.objectiveId],
            objective: `Independently review this run's performance claims against oracle ${KV_ORACLE_ID}: inspect the metric evidence yourself and post a review of the run (subjectRef kind run).`,
          },
        ],
      });
    }
    return leadComplete('Plan v1 proposed: restart, load, dump, analysis and review.', false, 'open', []);
  }
  if (v.step === 0) return toolCall('evidence.query', { evidenceType: 'metric' });
  const listing = resultText(v, 0);
  const records = Array.isArray(jsonOf(listing)['evidence']) ? (jsonOf(listing)['evidence'] as Array<{ evidenceId: string; summary?: string }>) : [];
  const jobEvidence = records.filter((e) => /load job/i.test(e.summary ?? '')).map((e) => e.evidenceId);
  const ev = (jobEvidence.length > 0 ? jobEvidence : records.map((e) => e.evidenceId)).slice(0, 3);
  const satisfied = jobEvidence.length > 0;
  if (v.step === 1) {
    return leadReply('hand over: the gate judges the recorded metrics', 'plan.propose_revision', {
      rationale: satisfied
        ? `Plan v2: the load job's latency and error rate are metric evidence (${ev.join(', ')}) and the run was reviewed. Hand over to the QualityGate.`
        : 'Plan v2: the load job ran but its latency was never recorded as evidence; no further step can obtain it in this run. Hand over to the QualityGate (insufficient data must not pass).',
      objectives: [{ ...OBJECTIVE, status: satisfied ? 'satisfied' : 'unsatisfiable' }],
      workItems: [],
      readyForGate: true,
    });
  }
  return leadComplete(satisfied ? 'Plan v2: ready for the gate.' : 'Plan v2: ready for the gate with insufficient data.', true, satisfied ? 'satisfied' : 'unsatisfiable', satisfied ? ev : []);
};

// ------------------------------------------------------------------------------------------------ environment operator

/** How the i-th (pending) side effect settled: `[pending]` results settle in the "Results of pending operations" message. */
function settled(v: BrainView, i: number, operationType: string): { status: string; operationId?: string } {
  const text = resultText(v, i);
  const op = opIds(text)[0];
  if (/^\[pending\]/.test(text)) {
    const m = new RegExp(`- operation (op_\\w+) \\(${operationType.replace('.', '\\.')}\\) (\\w+)`).exec(v.userText);
    return m ? { status: m[2]!, operationId: m[1]! } : { status: 'pending', ...(op ? { operationId: op } : {}) };
  }
  return { status: /^\[(\w+)\]/.exec(text)?.[1] ?? 'verified', ...(op ? { operationId: op } : {}) };
}

function restartOperator(v: BrainView) {
  if (v.step === 0) return toolCall('env.restart', { environmentId: KV_ENV_ID, reason: 'fresh service generation before the load experiment' });
  const s = settled(v, 0, 'env.restart');
  if (v.step === 1) {
    if (s.status !== 'verified') return toolCall('fail_work', { reason: 'agent_failed', message: `env.restart did not verify (${s.status})` });
    return toolCall('http.request', { method: 'GET', environmentId: KV_ENV_ID, path: '/health' });
  }
  const ev = evIds(resultText(v, 1));
  const action: Record<string, JsonValue> = { action: 'env.restart', target: KV_ENV_ID, status: 'verified', evidenceIds: ev };
  if (s.operationId) action['operationId'] = s.operationId;
  const summary = `kv-service restarted once${s.operationId ? ` (operation ${s.operationId})` : ''} and serves /health (${ev.join(', ')}).`;
  return toolCall('complete_work', { summary, evidenceRefs: ev, output: { summary, environmentReady: true, actions: [action] } });
}

function loadOperator(v: BrainView) {
  if (v.step === 0) return toolCall('load.start', { environmentId: KV_ENV_ID, ...KV_LOAD });
  const s = settled(v, 0, 'load.start');
  if (v.step === 1) {
    if (s.status !== 'verified') return toolCall('fail_work', { reason: 'agent_failed', message: `the load job did not complete (${s.status})` });
    return toolCall('metrics.scrape', { environmentId: KV_ENV_ID });
  }
  const ev = evIds(resultText(v, 1));
  const action: Record<string, JsonValue> = { action: 'load.start', target: KV_ENV_ID, status: 'verified', evidenceIds: ev };
  if (s.operationId) action['operationId'] = s.operationId;
  const summary = `load job ${s.operationId ?? '?'} completed (${KV_LOAD.ratePerSecond} rps × ${KV_LOAD.durationMs} ms of ${KV_LOAD.method} ${KV_LOAD.path}); the service counters on /metrics show the traffic (${ev.join(', ')}).`;
  return toolCall('complete_work', { summary, evidenceRefs: ev, output: { summary, environmentReady: true, actions: [action] } });
}

export const pocCEnvironment: RoleBrain = (v) => (/load\.start/.test(v.userText) ? loadOperator(v) : restartOperator(v));

// ------------------------------------------------------------------------------------------------ executor (large output)

export const pocCExecutor: RoleBrain = (v) => {
  if (v.step === 0) return toolCall('shell.exec', { command: ['node', '-e', `process.stdout.write(${JSON.stringify(DIAGNOSTIC_LINE)}.repeat(${DIAGNOSTIC_REPEAT}))`] });
  const text = resultText(v, 0);
  const bytes = requestBytes(v.request);
  // I9: the dump itself never enters the model's messages — only a bounded digest with the artifact reference
  if (bytes > MAX_REQUEST_BYTES_AFTER_OFFLOAD) return toolCall('fail_work', { reason: 'agent_failed', message: `context overflow: the request after the dump is ${bytes} bytes` });
  const ev = evIds(text);
  const summary = `Diagnostics dump collected (${DIAGNOSTIC_BYTES} bytes, offloaded: ${/output truncated/.test(text) ? 'yes' : 'no'}); the next model request was ${bytes} bytes.`;
  return toolCall('complete_work', { summary, evidenceRefs: ev, output: { summary, executed: [{ selector: 'diagnostics dump', passed: true, outcome: 'passed', evidenceIds: ev }], findings: [] } });
};

/** Tag of a model call made after the large output (the probe/grader reads these observations). */
export function pocCTag(v: BrainView): string | undefined {
  return v.role === 'executor' && v.step >= 1 ? 'after_large_output' : undefined;
}

// ------------------------------------------------------------------------------------------------ metrics analyst

/** The load job's operation id from the dependency results (the load item reports it). */
function loadJobOf(v: BrainView): string | undefined {
  return /load job (op_\w+) completed/.exec(v.userText)?.[1];
}

export function pocCMetricsAnalyst(variant: string | undefined): RoleBrain {
  if (variant === 'insufficient') {
    return (v) => {
      if (v.step === 0) return toolCall('metrics.scrape', { environmentId: KV_ENV_ID });
      const ev = evIds(resultText(v, 0));
      const summary = 'Only the service-side scrape is available; the load job\'s own latency and error-rate results were not collected: the data is insufficient for the SLO.';
      return toolCall('complete_work', {
        summary, evidenceRefs: ev,
        output: { summary, dataSufficient: false, observations: [{ metric: 'kv_requests_total', statement: 'service-side request counters after the load', evidenceIds: ev }], findings: [] },
      });
    };
  }
  return (v) => {
    const op = loadJobOf(v);
    if (!op) return toolCall('fail_work', { reason: 'agent_failed', message: 'the dependency results name no load job operation id' });
    if (v.step === 0) return toolCall('load.observe', { operationId: op });
    const observed = jsonOf(resultText(v, 0));
    const jobEv = str(observed, 'evidenceId') ?? evIds(resultText(v, 0))[0];
    const results = (observed['results'] ?? {}) as { latencyMs?: { p99?: number }; errorRate?: number | null; sent?: number; achievedRps?: number };
    const p99 = results.latencyMs?.p99;
    const errorRate = results.errorRate;
    if (!jobEv || typeof p99 !== 'number' || typeof errorRate !== 'number') return toolCall('fail_work', { reason: 'agent_failed', message: `the load job results are incomplete: ${resultText(v, 0).slice(0, 300)}` });
    if (v.step === 1) return toolCall('metrics.scrape', { environmentId: KV_ENV_ID });
    if (v.step === 2) {
      return toolCall('evidence.claim', {
        statement: `p99 latency of the ${KV_LOAD.ratePerSecond} rps load job ${op} is ${p99} ms (oracle ${KV_ORACLE_ID} C1: < 250 ms)`,
        value: p99, evidenceRefs: [jobEv], critical: true, evidenceQuery: { evidenceType: 'metric', field: 'latencyMs.p99' },
      });
    }
    if (v.step === 3) {
      return toolCall('evidence.claim', {
        statement: `error rate of the load job ${op} is ${errorRate} (oracle ${KV_ORACLE_ID} C2: < 1%)`,
        value: errorRate, evidenceRefs: [jobEv], critical: true, evidenceQuery: { evidenceType: 'metric', field: 'errorRate' },
      });
    }
    const scrapeEv = evIds(resultText(v, 1));
    const summary = `Load job ${op}: p99 ${p99} ms, error rate ${errorRate} over ${results.sent ?? '?'} requests (${results.achievedRps ?? '?'} rps achieved); data sufficient.`;
    return toolCall('complete_work', {
      summary, evidenceRefs: [jobEv, ...scrapeEv],
      output: {
        summary, dataSufficient: true, findings: [],
        observations: [
          { metric: 'latencyMs', aggregation: 'p99', value: p99, window: `${KV_LOAD.durationMs} ms at ${KV_LOAD.ratePerSecond} rps`, statement: `client-side p99 latency ${p99} ms`, evidenceIds: [jobEv] },
          { metric: 'errorRate', value: errorRate, window: `${KV_LOAD.durationMs} ms at ${KV_LOAD.ratePerSecond} rps`, statement: `error rate ${errorRate}`, evidenceIds: [jobEv] },
          { metric: 'kv_request_duration_seconds', aggregation: 'p99', statement: 'service-side latency histogram after the load', evidenceIds: scrapeEv },
        ],
      },
    });
  };
}

// ------------------------------------------------------------------------------------------------ reviewer (run)

/** A metric evidence payload that satisfies the SLO (the reviewer judges recorded numbers, not claims). */
function meetsSlo(structured: unknown): boolean {
  const s = structured as { latencyMs?: { p99?: unknown }; errorRate?: unknown } | undefined;
  return typeof s?.latencyMs?.p99 === 'number' && s.latencyMs.p99 < 250 && typeof s.errorRate === 'number' && s.errorRate < 0.01;
}

export const pocCReviewer: RoleBrain = (v) => {
  if (v.step === 0) return toolCall('evidence.query', { evidenceType: 'metric' });
  const listing = jsonOf(resultText(v, 0));
  const ids = (Array.isArray(listing['evidence']) ? (listing['evidence'] as Array<{ evidenceId: string }>) : []).map((e) => e.evidenceId).slice(0, 5);
  const fetched = v.step - 1;
  if (fetched < ids.length) return toolCall('evidence.get', { evidenceId: ids[fetched]! });
  const inspected = ids.slice(0, fetched);
  const supporting = inspected.filter((_id, i) => meetsSlo(jsonOf(resultText(v, 1 + i))['structured']));
  const verdict = supporting.length > 0 ? 'approve' : 'needs_more_evidence';
  if (v.step === 1 + ids.length) {
    return toolCall('blackboard.post_review', {
      subjectRef: { kind: 'run', id: v.runId },
      verdict,
      rationale: supporting.length > 0
        ? `The load job results ${supporting.join(', ')} record p99 < 250 ms and an error rate < 1% at 30 rps (kv-slo C1, C2).`
        : `No inspected metric evidence (${inspected.join(', ') || 'none'}) records the load job's p99 latency and error rate: kv-slo cannot be judged.`,
      checkedEvidenceRefs: inspected,
    });
  }
  const review = str(jsonOf(resultText(v, 1 + ids.length)), 'recordId')!;
  const summary = `Independent review of run ${v.runId}: ${verdict} (checked ${inspected.join(', ') || 'no evidence'}).`;
  return toolCall('complete_work', { summary, evidenceRefs: inspected, recordRefs: [review], output: { summary, verdict, reviews: [review], checkedEvidenceIds: inspected } });
};

export function pocCRoles(variant: string | undefined): Record<string, RoleBrain> {
  return { lead: pocCLead, environment: pocCEnvironment, executor: pocCExecutor, metrics_analyst: pocCMetricsAnalyst(variant), reviewer: pocCReviewer };
}

/** The scripted outage: `reason-a` times out on every attempt of the metrics analyst's first call (⇒ fallback route + new epoch). */
export function pocCOutage(v: BrainView): boolean {
  return v.role === 'metrics_analyst' && v.step === 0;
}
