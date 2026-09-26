/**
 * PoC C — Durable load + fault recovery (BLUEPRINT §6; acceptance table "首批 PoC：长时压测与故障恢复闭环"), and the
 * recovery-chaos suite on the same fixture.
 *
 * Fixture: `fixtures/kv-service/server.js` under the Hypertest process supervisor, which runs as its own process (the
 * SLO measurement never depends on the harness's event loop; environment `kv`, class local, restartable through
 * `env.restart`, operation records persisted). Oracle `kv-slo`: C1 P1 statistical "p99 latency <
 * 250 ms at 30 rps" and C2 P1 statistical "error rate < 1%" (evidence predicates over the load job's metric evidence).
 *
 * - `pocCTask()`: chaos = kill the Hypertest process right after the load.start operation is acknowledged (the load
 *   job keeps running outside), an injected model timeout, duplicate event delivery and a ~2 MiB tool output; plus the
 *   brains' scripted provider outage (fallback route + new epoch). Expected verdict: pass (service healthy, evidence
 *   sufficient) — the resumed process re-attaches the SAME load job (exactly one job directory and worker).
 * - `pocCInsufficientTask()`: the metrics analyst never records the job's latency evidence ⇒ inconclusive, never pass.
 * - `recoveryChaosTask()`: repeated kills at different points (a restart in flight — dispatched, no receipt yet — and
 *   a running load job — acknowledged, no evidence yet) ⇒ zero duplicate side effects, zero orphan operations.
 */
import { join } from 'node:path';
import type { JsonValue } from '@hypertest/core';
import type { EvalOracle, EvalTask, TrialContext, TrialFixture } from '../contracts.ts';
import { asJson, killLoadWorkers, loadJobs, startKvService } from '../fixtures.ts';
import { trialDataDir } from '../harness.ts';
import { DIAGNOSTIC_BYTES, KV_ENV_ID, KV_ORACLE_ID } from '../brains/poc-c.ts';
import { OBSERVATIONS_PROBE, POC_SUITE_REVISION, observationsFile, observationsProbe } from './common.ts';

export const KV_ORACLE: EvalOracle = {
  oracleId: KV_ORACLE_ID,
  scope: { components: ['kv-service'], description: 'Service level objective of kv-service under 30 rps.' },
  assertions: [
    {
      assertionId: 'C1', description: 'p99 latency < 250 ms at 30 rps', kind: 'statistical', severity: 'P1',
      check: { type: 'evidence_predicate', evidenceType: 'metric', field: 'latencyMs.p99', comparator: '<', value: 250 },
    },
    {
      assertionId: 'C2', description: 'error rate < 1%', kind: 'statistical', severity: 'P1',
      check: { type: 'evidence_predicate', evidenceType: 'metric', field: 'errorRate', comparator: '<', value: 0.01 },
    },
  ],
  authorities: [{ sourceRef: 'KV-SLO-2026 (latency and availability objectives)', authority: 'approved_requirement' }],
  judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: true },
  changePolicy: { agentMayPropose: true, selfApprove: false, invalidatesPriorDecisions: true, approvers: ['human'] },
};

export const POC_C_TASK_ID = 'poc-c-durable-load';
export const POC_C_INSUFFICIENT_TASK_ID = 'poc-c-insufficient';
export const RECOVERY_CHAOS_TASK_ID = 'recovery-chaos';

/**
 * The kv-service fixture. Ground truth (probes): restarts the supervisor performed per operation id, load jobs per
 * operation id (the job directory IS the external effect), worker processes, the service generation.
 */
export async function kvFixture(ctx: TrialContext, options: { warmupMs?: number } = {}): Promise<TrialFixture> {
  const sup = await startKvService({ stateDir: join(ctx.workDir, 'kv'), ...(options.warmupMs !== undefined ? { warmupMs: options.warmupMs } : {}) });
  const stateDir = join(trialDataDir(ctx), 'state');
  const observations = observationsFile(ctx);
  return {
    target: { environmentId: KV_ENV_ID, sutUrl: sup.url, description: 'kv-service (black-box, process-supervised)' },
    environments: [
      { environmentId: KV_ENV_ID, environmentClass: 'local', baseUrl: sup.url, metricsUrl: `${sup.url}/metrics`, generation: 1, control: { kind: 'process', target: sup.controlUrl } },
    ],
    brainArgs: { observationsFile: observations },
    probes: {
      [OBSERVATIONS_PROBE]: observationsProbe(observations),
      sideEffects: async (): Promise<JsonValue> => {
        const out: Record<string, number> = {};
        for (const op of sup.operations()) if (op.kind === 'restart') out[op.operationId] = (out[op.operationId] ?? 0) + 1;
        const jobs = loadJobs(stateDir);
        for (const job of jobs) out[job.operationId] = (out[job.operationId] ?? 0) + 1;
        out[`${KV_ENV_ID}:restarts`] = (await sup.generation()) - 1;
        out['loadgen:jobs'] = jobs.length;
        out['loadgen:workers'] = new Set(jobs.map((j) => j.pid).filter((p) => p !== undefined)).size;
        return out;
      },
      loadJobs: async (): Promise<JsonValue> => asJson(loadJobs(stateDir)),
      'metric.serviceGeneration': () => sup.generation(),
      'metric.loadJobs': async () => loadJobs(stateDir).length,
    },
    cleanup: async () => {
      await killLoadWorkers(stateDir);
      await sup.close();
    },
  };
}

const POC_C_GRADERS = [
  'verdict', 'pocCWorkflow', 'planDynamics', 'loadJobReattached', 'noDuplicateSideEffects', 'noOrphanOperations', 'recoveryAudit', 'offloadBounded', 'modelFallback', 'independentReview',
  'reportTracesToEvidence', 'evidenceCompleteness', 'evidenceIntegrity', 'policyViolation', 'auditReconstruction',
];

export function pocCTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    taskId: POC_C_TASK_ID,
    suiteRevision: POC_SUITE_REVISION,
    title: 'Durable load + fault recovery (kv-service SLO under a Hypertest crash)',
    goal: 'Verify that kv-service meets its latency and error-rate objectives under 30 rps and decide whether it is releasable.',
    hiddenFaults: [],
    expectedVerdict: 'pass',
    oracles: [KV_ORACLE],
    gate: { requiredEvidence: [{ evidenceType: 'metric', minCount: 1, critical: true }] },
    chaos: { kills: [{ after: 'acknowledged', operationType: 'load.start' }], injectModelTimeoutOnCall: 3, duplicateEventDelivery: true, largeOutputBytes: Math.min(2_000_000, DIAGNOSTIC_BYTES) },
    graders: POC_C_GRADERS,
    setup: (ctx) => kvFixture(ctx),
    ...overrides,
  };
}

export function pocCInsufficientTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return pocCTask({
    taskId: POC_C_INSUFFICIENT_TASK_ID,
    title: 'Durable load with insufficient latency evidence (never a pass)',
    expectedVerdict: 'inconclusive',
    chaos: {},
    graders: ['verdict', 'insufficientDataNotPassed', 'noDuplicateSideEffects', 'noOrphanOperations', 'evidenceCompleteness', 'evidenceIntegrity', 'policyViolation', 'auditReconstruction'],
    ...overrides,
  });
}

export function recoveryChaosTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return pocCTask({
    taskId: RECOVERY_CHAOS_TASK_ID,
    title: 'Repeated kill/restart of Hypertest at different points of the side effects',
    // the restart stays in flight for ~1 s: the first kill lands after its dispatch, before any receipt
    setup: (ctx) => kvFixture(ctx, { warmupMs: 1000 }),
    chaos: {
      kills: [
        // the restart request is in flight at the supervisor (warm-up 1 s) when the process dies: an unknown outcome
        { after: 'dispatched', operationType: 'env.restart', delayMs: 400 },
        { after: 'acknowledged', operationType: 'load.start' },
      ],
    },
    graders: ['verdict', 'noDuplicateSideEffects', 'noOrphanOperations', 'loadJobReattached', 'recoveryAudit', 'evidenceIntegrity', 'policyViolation', 'auditReconstruction'],
    ...overrides,
  });
}
