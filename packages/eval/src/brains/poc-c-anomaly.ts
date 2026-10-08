/**
 * PoC C anomaly brains (F[4], coverage[9], coverage[10]) — the complete PoC C flow of technology-selection §PoC C:
 * metrics → anomaly → RCA → targeted regression, in parallel with metrics analysis and the executor, across a crash:
 *
 *   lead Plan v1:
 *     prepare  (environment)               env.restart → GET /health
 *     load     (environment, ←prepare)     load.start 30 rps × 3 s (the job outlives a Hypertest crash)
 *     analyse  (metrics_analyst, ←load)    load.observe: p99 ≥ 250 ms ⇒ posts a P1 PERFORMANCE finding (the anomaly)
 *                                          citing the job's metric evidence, claims p99/error rate, scrapes, and stays at
 *                                          work until RCA has started on its finding
 *     diagnose (executor, ←load)           targeted probes of the hot key k1 and the control key k2 (api-response
 *                                          evidence), at work until RCA has started
 *   → finding.created wakes, WITHOUT the lead (reactors):
 *     RCA            reproduces with a direct timing script (stdout evidence), posts an evidence-backed hypothesis on the
 *                    finding's lineage and confirms the finding
 *     TestDesigner   writes and registers a TARGETED regression test of the hot key (p99 of 50 GETs < 250 ms), runs it
 *                    (it fails on the anomaly: known-bad), validates it
 *   → finding.confirmed wakes the independent reviewer; the run-level review is requested before the gate
 *   → plan drained → lead Plan v2 readyForGate ⇒ fail (C1 violated, unresolved P1).
 *
 * RCA, the metrics analysis and the executor RUN AT THE SAME TIME: the analyst and the executor answer their last turn
 * only once RCA's first model call happened (brains wait on the observation log — they stay functions of the request,
 * waiting only delays the reply).
 */
import type { JsonValue } from '@hypertest/core';
import { awaitObservation, evIds, inputRecord, jsonOf, leadReply, recIds, resultText, str, toolCall, type BrainView, type RoleBrain } from './kit.ts';
import { KV_ENV_ID, KV_EXPERIMENT, KV_LOAD, KV_ORACLE_ID, pocCEnvironment } from './poc-c.ts';
import { pocReviewer, reviewerOfFinding, reviewerOfRun } from './poc-a.ts';

/** The SLO bound of oracle kv-slo C1. */
export const KV_P99_BOUND_MS = 250;
/** The targeted regression test the TestDesigner writes for the anomaly. */
export const KV_REGRESSION_TEST_PATH = 'regression/kv-hot-key-latency.test.mjs';
/** How long a brain waits for RCA to start (the scenario then may not happen; the graders say so). */
const RCA_WAIT_MS = 60_000;

const OBJECTIVE = {
  objectiveId: 'obj-slo',
  description: `Decide from metric evidence whether kv-service meets ${KV_ORACLE_ID} (p99 latency < ${KV_P99_BOUND_MS} ms at 30 rps, error rate < 1%) and is releasable; any anomaly is analysed and covered by a regression.`,
  priority: 'P1',
  acceptanceCriteria: ['a 30 rps load job ran on a fresh service generation', 'latency and error rate of that job are metric evidence', 'an anomaly is explained and has a regression test'],
};

function leadComplete(summary: string, ready: boolean, evidenceRefs: string[]) {
  return toolCall('complete_work', {
    summary, evidenceRefs,
    output: { summary, planProposed: true, readyForGate: ready, objectives: [{ objectiveId: OBJECTIVE.objectiveId, status: ready ? 'satisfied' : 'open', evidenceRefs }] },
  });
}

export const anomalyLead: RoleBrain = (v) => {
  if (v.kind === 'initial_plan') {
    if (v.step === 0) return toolCall('experiment.define', KV_EXPERIMENT as unknown as JsonValue);
    if (v.step === 1) {
      const experimentId = str(jsonOf(resultText(v, 0)), 'experimentId');
      const refs = experimentId ? { inputRefs: [{ kind: 'experiment', id: experimentId }] } : {};
      return leadReply('performance goal: fresh generation, load, metrics; anomalies go to RCA through the blackboard', 'plan.propose_revision', {
        rationale: 'Plan v1: restart kv-service, run the 30 rps load job, quantify latency and error rate from the job\'s metric evidence, and probe the hot path directly in parallel. An anomaly is posted as a finding: RCA and the regression follow from it.',
        objectives: [OBJECTIVE],
        workItems: [
          {
            localId: 'prepare', title: 'Restart kv-service', role: 'environment', dependsOn: [], objectiveIds: [OBJECTIVE.objectiveId], ...refs,
            objective: `Restart environment ${KV_ENV_ID} with env.restart to a fresh generation, then verify with http.request GET /health that it serves.`,
          },
          {
            localId: 'load', title: 'Run the 30 rps load job', role: 'environment', dependsOn: ['prepare'], objectiveIds: [OBJECTIVE.objectiveId], ...refs,
            objective: `Run load.start against environment ${KV_ENV_ID}: ${KV_LOAD.method} ${KV_LOAD.path} at ${KV_LOAD.ratePerSecond} rps for ${KV_LOAD.durationMs} ms (concurrency ${KV_LOAD.concurrency}). Wait for the job, verify the achieved rate with metrics.scrape and report the load job's operation id.`,
            evidenceRequirements: [{ evidenceType: 'metric', minCount: 1, critical: true }],
          },
          {
            localId: 'analyse', title: 'Quantify latency and error rate; report anomalies', role: 'metrics_analyst', dependsOn: ['load'], objectiveIds: [OBJECTIVE.objectiveId], ...refs,
            objective: `Quantify the latency (p99) and error rate of the load job reported by the load item against oracle ${KV_ORACLE_ID} (C1 p99 < ${KV_P99_BOUND_MS} ms at 30 rps, C2 error rate < 1%): load.observe the job, post any SLO violation as a performance finding citing the metric evidence, claim the numbers, metrics.scrape environment ${KV_ENV_ID}.`,
            evidenceRequirements: [{ evidenceType: 'metric', minCount: 1, critical: true }],
          },
          {
            localId: 'diagnose', title: 'Probe the hot path directly', role: 'executor', dependsOn: ['load'], objectiveIds: [OBJECTIVE.objectiveId],
            objective: `Probe environment ${KV_ENV_ID} directly while the load results are analysed: http.request GET /kv/k1 (the load's key) and GET /kv/k2 (a control key) and report what they show.`,
          },
        ],
      });
    }
    return leadComplete('Plan v1 proposed: restart, load, analysis and direct probes; anomalies go to RCA.', false, []);
  }
  if (v.step === 0) return toolCall('evidence.query', { evidenceType: 'metric' });
  const ev = evIds(resultText(v, 0)).slice(0, 3);
  if (v.step === 1) {
    return leadReply('the anomaly was analysed through the blackboard; the gate decides', 'plan.propose_revision', {
      rationale: `Plan v2: the load job's latency and error rate are metric evidence (${ev.join(', ')}); the anomaly was posted, analysed by RCA and covered by a regression test without the lead. Hand over to the QualityGate.`,
      objectives: [{ ...OBJECTIVE, status: 'satisfied' }],
      workItems: [],
      readyForGate: true,
    });
  }
  return leadComplete('Plan v2: ready for the gate.', true, ev);
};

/** The load job's operation id from the dependency results (the load item reports it). */
function loadJobOf(v: BrainView): string | undefined {
  return /load job (op_\w+) completed/.exec(v.userText)?.[1];
}

/** The kv base URL a metrics.scrape result names (`metrics scrape of http://host:port/metrics`), else undefined. */
function kvUrl(text: string): string | undefined {
  return /metrics scrape of (https?:\/\/[^/\s]+)\//.exec(text)?.[1];
}

/** Waits until RCA's first model call happened (it started on the finding), bounded. */
async function rcaStarted(file: string | undefined): Promise<boolean> {
  return awaitObservation(file, (o) => o.role === 'rca', RCA_WAIT_MS);
}

export function anomalyMetricsAnalyst(observationsFile: string | undefined): RoleBrain {
  return async (v) => {
    const op = loadJobOf(v);
    if (!op) return toolCall('fail_work', { reason: 'agent_failed', message: 'the dependency results name no load job operation id' });
    if (v.step === 0) return toolCall('load.observe', { operationId: op });
    const observed = jsonOf(resultText(v, 0));
    const jobEv = str(observed, 'evidenceId') ?? evIds(resultText(v, 0))[0];
    const results = (observed['results'] ?? {}) as { latencyMs?: { p99?: number }; errorRate?: number | null; sent?: number; achievedRps?: number };
    const p99 = results.latencyMs?.p99;
    const errorRate = results.errorRate;
    if (!jobEv || typeof p99 !== 'number' || typeof errorRate !== 'number') return toolCall('fail_work', { reason: 'agent_failed', message: `the load job results are incomplete: ${resultText(v, 0).slice(0, 300)}` });
    const anomaly = p99 >= KV_P99_BOUND_MS;
    if (v.step === 1) return toolCall('metrics.scrape', { environmentId: KV_ENV_ID });
    const scrapeEv = evIds(resultText(v, 1));
    // an anomaly: the scrape evidence's recorded target names the endpoint (step 2), then the finding (step 3) — it wakes
    // RCA and the TestDesigner through the reactors
    if (anomaly && v.step === 2) {
      if (!scrapeEv[0]) return toolCall('fail_work', { reason: 'agent_failed', message: 'the metrics scrape recorded no evidence' });
      return toolCall('evidence.get', { evidenceId: scrapeEv[0] });
    }
    if (anomaly && v.step === 3) {
      const target = str((jsonOf(resultText(v, 2))['structured'] ?? {}) as Record<string, unknown>, 'url');
      const base = target ? kvUrl(`metrics scrape of ${target}`) : undefined;
      return toolCall('blackboard.post_finding', {
        title: `GET /kv/k1 p99 latency ${p99} ms breaks ${KV_ORACLE_ID} C1 at ${KV_LOAD.ratePerSecond} rps`,
        description: `The ${KV_LOAD.ratePerSecond} rps load job ${op} on kv-service measured p99 ${p99} ms (bound ${KV_P99_BOUND_MS} ms) with error rate ${errorRate}: a latency anomaly on the hot key k1.`,
        severity: 'P1', category: 'performance', component: 'GET /kv/:key',
        expected: `p99 < ${KV_P99_BOUND_MS} ms at ${KV_LOAD.ratePerSecond} rps (${KV_ORACLE_ID} C1)`, actual: `p99 ${p99} ms`,
        reproduction: `load ${KV_LOAD.ratePerSecond} rps × ${KV_LOAD.durationMs} ms GET ${base ?? `(environment ${KV_ENV_ID})`}${KV_LOAD.path}`,
        oracleRef: { oracleId: KV_ORACLE_ID, revision: 1, assertionId: 'C1' },
        evidenceRefs: [jobEv],
      });
    }
    const offset = anomaly ? 2 : 0;
    const finding = anomaly ? recIds(resultText(v, 3))[0] : undefined;
    if (v.step === 2 + offset) {
      return toolCall('evidence.claim', {
        statement: `p99 latency of the ${KV_LOAD.ratePerSecond} rps load job ${op} is ${p99} ms (oracle ${KV_ORACLE_ID} C1: < ${KV_P99_BOUND_MS} ms)`,
        value: p99, evidenceRefs: [jobEv], critical: true, evidenceQuery: { evidenceType: 'metric', field: 'latencyMs.p99' },
      });
    }
    if (v.step === 3 + offset) {
      return toolCall('evidence.claim', {
        statement: `error rate of the load job ${op} is ${errorRate} (oracle ${KV_ORACLE_ID} C2: < 1%)`,
        value: errorRate, evidenceRefs: [jobEv], critical: true, evidenceQuery: { evidenceType: 'metric', field: 'errorRate' },
      });
    }
    // the analysis stays at work until RCA started on the finding (RCA ∥ metrics ∥ executor)
    if (anomaly) await rcaStarted(observationsFile);
    const summary = `Load job ${op}: p99 ${p99} ms, error rate ${errorRate} over ${results.sent ?? '?'} requests${anomaly ? `; ANOMALY posted as finding ${finding ?? '?'}` : '; within the SLO'}.`;
    return toolCall('complete_work', {
      summary, evidenceRefs: [jobEv, ...scrapeEv], ...(finding ? { recordRefs: [finding] } : {}),
      output: {
        summary, dataSufficient: true, findings: finding ? [finding] : [],
        observations: [
          { metric: 'latencyMs', aggregation: 'p99', value: p99, window: `${KV_LOAD.durationMs} ms at ${KV_LOAD.ratePerSecond} rps`, statement: `client-side p99 latency ${p99} ms`, evidenceIds: [jobEv] },
          { metric: 'errorRate', value: errorRate, window: `${KV_LOAD.durationMs} ms at ${KV_LOAD.ratePerSecond} rps`, statement: `error rate ${errorRate}`, evidenceIds: [jobEv] },
        ],
      },
    });
  };
}

/** The executor's direct probes of the hot key and a control key, at work until RCA started. */
export function anomalyExecutor(observationsFile: string | undefined): RoleBrain {
  return async (v) => {
    if (v.step === 0) return toolCall('http.request', { method: 'GET', environmentId: KV_ENV_ID, path: '/kv/k1' });
    if (v.step === 1) return toolCall('http.request', { method: 'GET', environmentId: KV_ENV_ID, path: '/kv/k2' });
    await rcaStarted(observationsFile);
    const k1 = evIds(resultText(v, 0));
    const k2 = evIds(resultText(v, 1));
    const summary = `Direct probes: GET /kv/k1 (${k1.join(', ')}) and the control GET /kv/k2 (${k2.join(', ')}) answer 200.`;
    return toolCall('complete_work', {
      summary, evidenceRefs: [...k1, ...k2],
      output: { summary, executed: [{ selector: 'GET /kv/k1', passed: true, outcome: 'passed', evidenceIds: k1 }, { selector: 'GET /kv/k2', passed: true, outcome: 'passed', evidenceIds: k2 }], findings: [] },
    });
  };
}

/** A timing script: 40 sequential GETs of k1 and of k2 ⇒ {k1: {slow, max}, k2: {slow, max}} (slow = over the bound). */
export function timingScript(base: string): string {
  return `const t = async (k) => { let slow = 0; let max = 0; for (let i = 0; i < 40; i++) { const s = Date.now(); await (await fetch(${JSON.stringify(base)} + '/kv/' + k)).text(); const d = Date.now() - s; max = Math.max(max, d); if (d >= ${KV_P99_BOUND_MS}) slow++; } return { slow, max }; }; console.log(JSON.stringify({ k1: await t('k1'), k2: await t('k2') }));`;
}

/** RCA reaction: the finding's evidence → a direct timing reproduction → hypothesis → confirm → complete. */
export const anomalyRca: RoleBrain = (v) => {
  const finding = inputRecord(v, 'finding');
  if (!finding) return toolCall('fail_work', { reason: 'agent_failed', message: 'no finding record in the task inputs' });
  const p = finding.payload;
  const base = /GET (https?:\/\/[^/\s]+)\//.exec(String(p['reproduction'] ?? ''))?.[1];
  switch (v.step) {
    case 0:
      return toolCall('evidence.get', { evidenceId: finding.evidenceRefs[0]! });
    case 1:
      if (!base) return toolCall('fail_work', { reason: 'agent_failed', message: 'the finding names no reproducible endpoint' });
      return toolCall('shell.exec', { command: ['node', '--input-type=module', '-e', timingScript(base)] });
    case 2: {
      const out = jsonOf(resultText(v, 1)) as { k1?: { slow?: number; max?: number }; k2?: { slow?: number; max?: number } };
      return toolCall('blackboard.post_hypothesis', {
        findingRecordId: finding.recordId,
        statement: `The latency anomaly is specific to the hot key k1: ${out.k1?.slow ?? '?'} of 40 sequential GETs of k1 took ≥ ${KV_P99_BOUND_MS} ms (max ${out.k1?.max ?? '?'} ms) while the control key k2 had ${out.k2?.slow ?? '?'} (max ${out.k2?.max ?? '?'} ms): a periodic slow path on k1, not load or saturation.`,
        status: 'supported', confidence: 0.8,
        suggestedChecks: ['40 sequential GET /kv/k1 vs /kv/k2 (reproduced)', 'a regression test asserting the p99 of GET /kv/k1'],
        evidenceRefs: [...finding.evidenceRefs, ...evIds(resultText(v, 1))],
      });
    }
    case 3: {
      const out = jsonOf(resultText(v, 1)) as { k1?: { slow?: number } };
      if (!((out.k1?.slow ?? 0) > 0)) return toolCall('fail_work', { reason: 'agent_failed', message: `the reproduction did not show the anomaly: ${resultText(v, 1).slice(0, 300)}` });
      return toolCall('blackboard.post_finding', {
        updatesRecordId: finding.recordId,
        title: String(p['title']), description: String(p['description']), severity: String(p['severity']), category: String(p['category']),
        component: String(p['component'] ?? 'GET /kv/:key'), expected: String(p['expected'] ?? ''), actual: String(p['actual'] ?? ''),
        reproduction: String(p['reproduction'] ?? ''), oracleRef: p['oracleRef'] as JsonValue, status: 'confirmed',
        evidenceRefs: [...finding.evidenceRefs, ...evIds(resultText(v, 1))],
      });
    }
    default: {
      const hypothesis = str(jsonOf(resultText(v, 2)), 'recordId')!;
      const reproEv = evIds(resultText(v, 1));
      const summary = 'Reproduced: GET /kv/k1 is periodically slow while k2 is not; hypothesis posted, finding confirmed.';
      return toolCall('complete_work', {
        summary, evidenceRefs: reproEv, recordRefs: [hypothesis, finding.recordId],
        output: { summary, hypotheses: [hypothesis], rootCause: { status: 'hypothesis', statement: 'a periodic slow path on the hot key k1', evidenceRefs: reproEv }, reproduction: 'always', findingRecordId: finding.recordId },
      });
    }
  }
};

/** The targeted regression test: p99 of 50 sequential GETs of the hot key below the SLO bound. */
export function kvRegressionTest(base: string): string {
  return `import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = ${JSON.stringify(base)};

// kv-slo C1: the hot key k1 answers within ${KV_P99_BOUND_MS} ms at p99
test('GET /kv/k1 p99 latency stays below ${KV_P99_BOUND_MS} ms', async () => {
  const times = [];
  for (let i = 0; i < 50; i++) {
    const s = Date.now();
    const res = await fetch(BASE + '/kv/k1');
    await res.text();
    assert.equal(res.status, 200);
    times.push(Date.now() - s);
  }
  times.sort((a, b) => a - b);
  const p99 = times[Math.ceil(times.length * 0.99) - 1];
  assert.ok(p99 < ${KV_P99_BOUND_MS}, \`p99 \${p99} ms\`);
});
`;
}

/** TestDesigner reaction: the targeted regression of the anomaly (write → register → run: fails on it → validate → complete). */
export const anomalyTestDesigner: RoleBrain = (v) => {
  const finding = inputRecord(v, 'finding');
  if (!finding) return toolCall('fail_work', { reason: 'agent_failed', message: 'no finding record in the task inputs' });
  const base = /GET (https?:\/\/[^/\s]+)\//.exec(String(finding.payload['reproduction'] ?? ''))?.[1];
  if (!base) return toolCall('fail_work', { reason: 'agent_failed', message: 'the finding names no reproducible endpoint' });
  switch (v.step) {
    case 0:
      return toolCall('fs.write', { path: KV_REGRESSION_TEST_PATH, content: kvRegressionTest(base) });
    case 1:
      return toolCall('test_artifact.register', {
        path: KV_REGRESSION_TEST_PATH, sourceType: 'generated', runner: { framework: 'node_test', selector: KV_REGRESSION_TEST_PATH },
        oracleRefs: [{ oracleId: KV_ORACLE_ID, revision: 1, assertionIds: ['C1'] }],
      });
    case 2:
      return toolCall('test.run', { framework: 'node_test', selector: KV_REGRESSION_TEST_PATH, testArtifactIds: [str(jsonOf(resultText(v, 1)), 'artifactId')!] });
    case 3: {
      const run = resultText(v, 2);
      const artifactId = str(jsonOf(resultText(v, 1)), 'artifactId')!;
      return toolCall('test_artifact.validate', /NOT PASSED/.test(run)
        ? { artifactId, knownBadEvidenceId: evIds(run).at(-1)!, knownGoodUnavailableReason: 'the anomalous kv-service is the only deployment: no fixed build exists to run the regression against' }
        : { artifactId, knownGoodEvidenceId: evIds(run).at(-1)! });
    }
    default: {
      const artifactId = str(jsonOf(resultText(v, 1)), 'artifactId')!;
      const ev = evIds(resultText(v, 2)).at(-1)!;
      const summary = `Targeted regression ${KV_REGRESSION_TEST_PATH} (artifact ${artifactId}) for finding ${finding.recordId}: it fails on the anomalous service (known-bad ${ev}).`;
      return toolCall('complete_work', { summary, evidenceRefs: [ev], recordRefs: [finding.recordId], output: { summary, testArtifacts: [{ artifactId, path: KV_REGRESSION_TEST_PATH, covers: [finding.recordId], evidenceRefs: [ev] }] } });
    }
  }
};

/** A metric evidence payload whose p99 breaks the SLO (what the anomaly rests on). */
export function breaksSlo(structured: unknown): boolean {
  const s = structured as { latencyMs?: { p99?: unknown } } | undefined;
  return typeof s?.latencyMs?.p99 === 'number' && s.latencyMs.p99 >= KV_P99_BOUND_MS;
}

export const anomalyReviewer: RoleBrain = pocReviewer(
  reviewerOfFinding({ evidenceType: 'metric', supports: breaksSlo, what: `the load job's p99 latency at or above ${KV_P99_BOUND_MS} ms` }),
  reviewerOfRun({ evidenceType: 'metric', supports: breaksSlo, what: `the load job's p99 latency at or above ${KV_P99_BOUND_MS} ms (the SLO violation the verdict rests on)` }),
);

/** The role policies of the anomaly scenario (observation log: where the analyst and the executor see RCA start). */
export function anomalyRoles(observationsFile: string | undefined): Record<string, RoleBrain> {
  return {
    lead: anomalyLead,
    environment: pocCEnvironment,
    metrics_analyst: anomalyMetricsAnalyst(observationsFile),
    executor: anomalyExecutor(observationsFile),
    rca: anomalyRca,
    test_designer: anomalyTestDesigner,
    reviewer: anomalyReviewer,
  };
}
