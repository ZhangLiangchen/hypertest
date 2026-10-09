/**
 * (F[5], F[6], F[7]) The extended core suites of the eval platform (architecture-improvements §评测套件 "Hypertest core
 * eval suites" and §Chaos Suite), each a real end-to-end run with graders — scripted brains, real fixtures, real
 * Hypertest:
 *
 * | suite              | tasks                                                                                    |
 * |--------------------|------------------------------------------------------------------------------------------|
 * | `api-ui-blackbox`  | API transfer contract (bank API, http.request); UI transfer feedback (real Chromium)      |
 * | `performance`      | SLO met on a healthy service (pass); latency regression → RCA → regression test (fail)    |
 * | `fault-tolerance`  | controlled latency fault + invariant (pass); controlled error-rate fault + invariant (fail) |
 * | `evidence`         | tampered / deleted / rewritten evidence detected by the independent verifier; missing evidence never passes |
 * | `multi-agent`      | delegation (parallel delegated analysts, summaries only); convergence (two agents, one finding) |
 * | `chaos`            | kill after an external success; budget exhaustion; competing fault experiments; unqueryable target (manual review by a human operator) |
 *
 * Not in these suites (covered elsewhere, see CONFORMANCE): a stale lease of a FROZEN worker (the lease TTL is not
 * configurable per trial: collab/control fencing tests), real NATS redelivery and Temporal activity retry (eval trials run
 * the in-process bus and the local durable runtime: bus/durable integration tests).
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonValue } from '@hypertest/core';
import type { EvalOracle, EvalSuite, EvalTask, TrialFixture } from '../contracts.ts';
import { asJson, readKvWrites, startBankApi, startKvService } from '../fixtures.ts';
import { BANK_ENV_ID } from '../brains/poc-b.ts';
import { KV_ENV_ID } from '../brains/poc-c.ts';
import { BANK_UI_ORACLE_ID, FLAG_ORACLE_ID, FLAG_PATH, FLAG_VALUE, KV_RESILIENCE_ORACLE_ID, UI_REJECTED_MESSAGE } from '../brains/extended.ts';
import { OBSERVATIONS_PROBE, observationsFile, observationsProbe } from './common.ts';
import { pocBTask } from './poc-b.ts';
import { pocCAnomalyTask, pocCInsufficientTask, pocCTask, kvFixture } from './poc-c.ts';
import { pocATask } from './poc-a.ts';

/** Revision of the extended suites (paired seeds and reports carry it). */
export const EXTENDED_SUITE_REVISION = 'ext-1';

function human(): Pick<EvalOracle, 'judgePolicy' | 'changePolicy'> {
  return {
    judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: true },
    changePolicy: { agentMayPropose: true, selfApprove: false, invalidatesPriorDecisions: true, approvers: ['human'] },
  };
}

const COMMON_GRADERS = ['evidenceIntegrity', 'policyViolation', 'auditReconstruction'];

// ================================================================================================ api-ui-blackbox

export const API_BLACKBOX_TASK_ID = 'api-blackbox-transfers';
export const UI_BLACKBOX_TASK_ID = 'ui-blackbox-transfer-feedback';

/** API black-box: the bank API transfer contract through http.request only (no white-box tool may be used). */
export function apiBlackboxTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return pocBTask({
    taskId: API_BLACKBOX_TASK_ID,
    suiteRevision: EXTENDED_SUITE_REVISION,
    title: 'API black-box: the bank transfer contract over HTTP',
    chaos: {},
    graders: ['verdict', 'defectDetected', 'blackBoxOnly', 'causalChain', 'independentReview', 'reportTracesToEvidence', 'evidenceCompleteness', ...COMMON_GRADERS],
    ...overrides,
  });
}

export const BANK_UI_ORACLE: EvalOracle = {
  oracleId: BANK_UI_ORACLE_ID,
  scope: { components: ['bank UI'], description: 'What the transfer page of the bank UI shows its user.' },
  assertions: [
    {
      assertionId: 'U1', description: `a rejected transfer is shown as rejected ("${UI_REJECTED_MESSAGE}")`, kind: 'requirement', severity: 'P1',
      check: { type: 'evidence_predicate', evidenceType: 'dom-snapshot', field: 'text', comparator: '==', value: UI_REJECTED_MESSAGE },
    },
  ],
  authorities: [{ sourceRef: 'BANK-UI-SPEC §2 transfer feedback', authority: 'approved_requirement' }],
  ...human(),
};

/** UI black-box: the transfer page in a real browser (Chromium); its feedback defect is only visible in the page. */
export function uiBlackboxTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    taskId: UI_BLACKBOX_TASK_ID,
    suiteRevision: EXTENDED_SUITE_REVISION,
    title: 'UI black-box: transfer feedback in a real browser',
    goal: 'Test the transfer page of the bank UI against its specification and decide whether it is releasable.',
    hiddenFaults: [{ faultId: 'ui-swallows-rejection', description: 'the transfer page shows "Transfer complete" for a rejected transfer', severity: 'P1', detectionHints: ['rejected|reject', 'transfer', 'complete'] }],
    expectedVerdict: 'fail',
    oracles: [BANK_UI_ORACLE],
    graders: ['verdict', 'defectDetected', 'blackBoxOnly', 'uiEvidence', 'causalChain', 'independentReview', 'evidenceCompleteness', ...COMMON_GRADERS],
    // the browser tools (Playwright + the local Chromium) are part of what this task exercises
    configure: (config) => ({ ...config, tools: { ...config.tools, enableBrowser: true } }),
    async setup(ctx): Promise<TrialFixture> {
      const bank = await startBankApi();
      const observations = observationsFile(ctx);
      return {
        target: { environmentId: BANK_ENV_ID, sutUrl: bank.url, description: 'bank UI (black-box, browser)' },
        environments: [{ environmentId: BANK_ENV_ID, environmentClass: 'sandbox', baseUrl: bank.url, metricsUrl: `${bank.url}/metrics`, generation: 1 }],
        brainArgs: { observationsFile: observations },
        probes: { [OBSERVATIONS_PROBE]: observationsProbe(observations), sideEffects: async (): Promise<JsonValue> => asJson(await bank.effects()) },
        cleanup: () => bank.close(),
      };
    },
    ...overrides,
  };
}

export function apiUiBlackboxSuite(): EvalSuite {
  return { suiteId: 'api-ui-blackbox', revision: EXTENDED_SUITE_REVISION, tasks: [apiBlackboxTask(), uiBlackboxTask()] };
}

// ================================================================================================ performance

export const PERFORMANCE_SLO_TASK_ID = 'performance-slo';
export const PERFORMANCE_REGRESSION_TASK_ID = 'performance-regression';

/** Performance: the SLO of a healthy kv-service judged on the load job's own metric evidence (pass). */
export function performanceSloTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return pocCTask({
    taskId: PERFORMANCE_SLO_TASK_ID,
    suiteRevision: EXTENDED_SUITE_REVISION,
    title: 'Performance: SLO of a healthy service under 30 rps',
    chaos: {},
    graders: ['verdict', 'pocCWorkflow', 'loadJobReattached', 'reportTracesToEvidence', 'independentReview', 'evidenceCompleteness', 'noDuplicateSideEffects', ...COMMON_GRADERS],
    ...overrides,
  });
}

/** Performance: a latency regression on the hot key — metrics → anomaly → RCA ∥ metrics ∥ executor → regression (fail). */
export function performanceRegressionTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return pocCAnomalyTask({
    taskId: PERFORMANCE_REGRESSION_TASK_ID,
    suiteRevision: EXTENDED_SUITE_REVISION,
    title: 'Performance: a hot-key latency regression is found in the metrics and analysed',
    chaos: {},
    graders: ['verdict', 'defectDetected', 'anomalyReaction', 'rcaMetricsExecutorParallel', 'causalChain', 'reportTracesToEvidence', 'evidenceCompleteness', ...COMMON_GRADERS],
    ...overrides,
  });
}

export function performanceSuite(): EvalSuite {
  return { suiteId: 'performance', revision: EXTENDED_SUITE_REVISION, tasks: [performanceSloTask(), performanceRegressionTask()] };
}

// ================================================================================================ fault-tolerance

export const FAULT_TOLERANCE_LATENCY_TASK_ID = 'fault-tolerance-latency';
export const FAULT_TOLERANCE_ERRORS_TASK_ID = 'fault-tolerance-errors';

export const KV_RESILIENCE_ORACLE: EvalOracle = {
  oracleId: KV_RESILIENCE_ORACLE_ID,
  scope: { components: ['kv-service'], description: 'Fault tolerance of kv-service: invariants under a controlled fault and after it.' },
  assertions: [
    {
      assertionId: 'R1', description: 'error rate < 1% under a controlled fault (30 rps)', kind: 'statistical', severity: 'P1',
      check: { type: 'evidence_predicate', evidenceType: 'metric', field: 'errorRate', comparator: '<', value: 0.01 },
    },
    { assertionId: 'R2', description: 'the service answers /health with 200 after the fault', kind: 'requirement', severity: 'P1', check: { type: 'http_expectation', method: 'GET', path: '/health', expectStatus: 200 } },
  ],
  authorities: [{ sourceRef: 'KV-RESILIENCE-2026 (degradation under faults)', authority: 'approved_requirement' }],
  ...human(),
};

function faultToleranceTask(taskId: string, title: string, expected: 'pass' | 'fail', overrides: Partial<EvalTask>): EvalTask {
  return {
    taskId,
    suiteRevision: EXTENDED_SUITE_REVISION,
    title,
    goal: 'Inject the planned controlled fault into kv-service, measure it under 30 rps and decide whether it tolerates the fault and recovers.',
    hiddenFaults: [],
    expectedVerdict: expected,
    oracles: [KV_RESILIENCE_ORACLE],
    gate: { requiredEvidence: [{ evidenceType: 'metric', minCount: 1, critical: true }] },
    graders: ['verdict', 'faultTolerance', 'noDuplicateSideEffects', 'noOrphanOperations', 'evidenceCompleteness', ...COMMON_GRADERS],
    setup: (ctx) => kvFixture(ctx),
    ...overrides,
  };
}

/** FaultTolerance: a 120 ms latency fault; the invariant (error rate < 1%) holds and the service recovers (pass). */
export function faultToleranceLatencyTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return faultToleranceTask(FAULT_TOLERANCE_LATENCY_TASK_ID, 'FaultTolerance: a controlled latency fault + the error-rate invariant', 'pass', overrides);
}

/** FaultTolerance: a 20% error-rate fault; kv-service has no retry/masking, the invariant breaks (fail). */
export function faultToleranceErrorsTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return faultToleranceTask(FAULT_TOLERANCE_ERRORS_TASK_ID, 'FaultTolerance: a controlled error-rate fault breaks the error-rate invariant', 'fail', overrides);
}

export function faultToleranceSuite(): EvalSuite {
  return { suiteId: 'fault-tolerance', revision: EXTENDED_SUITE_REVISION, tasks: [faultToleranceLatencyTask(), faultToleranceErrorsTask()] };
}

// ================================================================================================ evidence

export const EVIDENCE_TAMPER_TASK_ID = 'evidence-tamper-detected';
export const EVIDENCE_MISSING_TASK_ID = 'evidence-missing-not-passed';

/** The artifact file of a digest in the trial's filesystem artifact store. */
function artifactFile(dataDir: string, sha256: string): string {
  return join(dataDir, 'artifacts', 'sha256', sha256.slice(0, 2), sha256);
}

/**
 * Evidence: after a healthy run an attacker with access to the stores (1) flips bytes of the load job's metric
 * artifact, (2) deletes another artifact, (3) tries to rewrite an evidence row (refused by the append-only trigger),
 * then rewrites it with the trigger disabled. The INDEPENDENT verifier (`hypertest evidence verify`) must name exactly
 * the affected records — tampered, missing, rewritten — and nothing else.
 */
export function evidenceTamperTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return pocCTask({
    taskId: EVIDENCE_TAMPER_TASK_ID,
    suiteRevision: EXTENDED_SUITE_REVISION,
    title: 'Evidence: tampered, deleted and rewritten evidence is detected by the independent verifier',
    chaos: {},
    graders: ['verdict', 'tamperDetected', 'auditReconstruction'],
    async setup(ctx): Promise<TrialFixture> {
      const base = await kvFixture(ctx);
      return {
        ...base,
        async afterRun({ ht, runId, dataDir }): Promise<JsonValue> {
          const records = await ht.services.evidence.query({ runId });
          const loadJob = records.find((e) => e.evidenceType === 'metric' && (e.structured as { source?: unknown } | null)?.source === 'loadgen');
          const scrape = records.find((e) => e.evidenceType === 'metric' && (e.structured as { source?: unknown } | null)?.source === 'prometheus-text' && e.artifact.sha256 !== loadJob?.artifact.sha256);
          const health = records.find((e) => e.evidenceType === 'api-response' && e.artifact.sha256 !== loadJob?.artifact.sha256 && e.artifact.sha256 !== scrape?.artifact.sha256);
          if (!loadJob || !scrape || !health) return { error: `the run lacks the evidence the attack needs (load ${loadJob?.evidenceId ?? '-'}, scrape ${scrape?.evidenceId ?? '-'}, http ${health?.evidenceId ?? '-'})` };
          // (1) bytes of the load job's artifact are changed (same size: a size check alone would not see it)
          const file = artifactFile(dataDir, loadJob.artifact.sha256);
          const bytes = await readFile(file);
          bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
          await writeFile(file, bytes);
          // (2) another artifact disappears
          await rm(artifactFile(dataDir, scrape.artifact.sha256));
          // (3) rewriting an evidence row: refused by the ledger's append-only trigger …
          let updateRefused = false;
          try {
            await ht.services.db.query('UPDATE ht_evidence SET summary = $1 WHERE evidence_id = $2', ['rewritten by an attacker', health.evidenceId]);
          } catch {
            updateRefused = true;
          }
          // … so a privileged attacker disables it for the rewrite
          await ht.services.db.query('ALTER TABLE ht_evidence DISABLE TRIGGER ht_evidence_no_mutation');
          try {
            await ht.services.db.query('UPDATE ht_evidence SET summary = $1 WHERE evidence_id = $2', ['rewritten by an attacker', health.evidenceId]);
          } finally {
            await ht.services.db.query('ALTER TABLE ht_evidence ENABLE TRIGGER ht_evidence_no_mutation');
          }
          const sharing = (sha: string) => records.filter((e) => e.artifact.sha256 === sha).map((e) => e.evidenceId).sort();
          return { tampered: sharing(loadJob.artifact.sha256), missing: sharing(scrape.artifact.sha256), rewritten: [health.evidenceId], updateRefused, records: records.length };
        },
      };
    },
    ...overrides,
  });
}

/** Evidence: the load job's latency is never recorded as evidence ⇒ the gate names the missing evidence; never a pass. */
export function evidenceMissingTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return pocCInsufficientTask({ taskId: EVIDENCE_MISSING_TASK_ID, suiteRevision: EXTENDED_SUITE_REVISION, title: 'Evidence: missing critical evidence is never a pass', ...overrides });
}

export function evidenceSuite(): EvalSuite {
  return { suiteId: 'evidence', revision: EXTENDED_SUITE_REVISION, tasks: [evidenceTamperTask(), evidenceMissingTask()] };
}

// ================================================================================================ multi-agent

export const MULTI_AGENT_DELEGATION_TASK_ID = 'multi-agent-delegation';
export const MULTI_AGENT_CONVERGENCE_TASK_ID = 'multi-agent-convergence';

/** MultiAgent delegation: the lead delegates three analyses in ONE turn (parallel children), receives only summaries. */
export function multiAgentDelegationTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return pocATask({
    taskId: MULTI_AGENT_DELEGATION_TASK_ID,
    suiteRevision: EXTENDED_SUITE_REVISION,
    title: 'MultiAgent: delegated parallel analyses converge into one plan and one decision',
    graders: ['verdict', 'defectDetected', 'delegation', 'causalChain', 'contextIsolation', 'independentReview', 'evidenceCompleteness', ...COMMON_GRADERS],
    ...overrides,
  });
}

/** MultiAgent convergence: two independent executors report the same symptom; the blackboard keeps ONE finding. */
export function multiAgentConvergenceTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return pocBTask({
    taskId: MULTI_AGENT_CONVERGENCE_TASK_ID,
    suiteRevision: EXTENDED_SUITE_REVISION,
    title: 'MultiAgent: two independent agents converge on one finding and one decision',
    chaos: {},
    graders: ['verdict', 'defectDetected', 'convergence', 'causalChain', 'singleLeaseOwner', 'independentReview', 'evidenceCompleteness', ...COMMON_GRADERS],
    ...overrides,
  });
}

export function multiAgentSuite(): EvalSuite {
  return { suiteId: 'multi-agent', revision: EXTENDED_SUITE_REVISION, tasks: [multiAgentDelegationTask(), multiAgentConvergenceTask()] };
}

// ================================================================================================ chaos

export const CHAOS_KILL_AFTER_SUCCESS_TASK_ID = 'chaos-kill-after-success';
export const CHAOS_BUDGET_EXHAUSTION_TASK_ID = 'chaos-budget-exhaustion';
export const CHAOS_COMPETING_FAULTS_TASK_ID = 'chaos-competing-faults';
export const CHAOS_UNQUERYABLE_TARGET_TASK_ID = 'chaos-unqueryable-target';
/** The tool-call budget of the exhaustion case: the plan and the restart fit, the load never starts. */
export const BUDGET_EXHAUSTION_TOOL_CALLS = 6;

/** Kill right after the restart's external SUCCESS was verified: it is never repeated. */
export function chaosKillAfterSuccessTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return pocCTask({
    taskId: CHAOS_KILL_AFTER_SUCCESS_TASK_ID,
    suiteRevision: EXTENDED_SUITE_REVISION,
    title: 'Chaos: Hypertest killed right after an external success',
    chaos: { kills: [{ after: 'verified', operationType: 'env.restart' }] },
    graders: ['verdict', 'noDuplicateSideEffects', 'noOrphanOperations', 'recoveryAudit', 'loadJobReattached', ...COMMON_GRADERS],
    ...overrides,
  });
}

/** Budget exhaustion: the run's tool-call budget runs out before any metric evidence exists ⇒ converges, never passes. */
export function chaosBudgetExhaustionTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return pocCTask({
    taskId: CHAOS_BUDGET_EXHAUSTION_TASK_ID,
    suiteRevision: EXTENDED_SUITE_REVISION,
    title: 'Chaos: the run budget is exhausted mid-run',
    chaos: {},
    budget: { maxToolCalls: BUDGET_EXHAUSTION_TOOL_CALLS, onExhausted: 'gate' },
    expectedVerdict: 'inconclusive',
    graders: ['verdict', 'budgetExhaustion', 'noOrphanOperations', ...COMMON_GRADERS],
    ...overrides,
  });
}

/** Competing fault experiments: a latency and an error-rate experiment in parallel on one environment. */
export function chaosCompetingFaultsTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return faultToleranceTask(CHAOS_COMPETING_FAULTS_TASK_ID, 'Chaos: two fault experiments compete for one environment', 'fail', {
    goal: 'Measure kv-service under a latency fault and under an error-rate fault (two independent experiments) and decide whether it tolerates them.',
    // two load jobs by design (one per experiment): the side-effect ground truth counts effects PER OPERATION only — the
    // environment-wide job/worker totals of the PoC C fixture (one job expected there) would read as duplicates here
    async setup(ctx) {
      const f = await kvFixture(ctx);
      const all = f.probes!['sideEffects']!;
      f.probes!['sideEffects'] = async (): Promise<JsonValue> => {
        const counts = (await all()) as Record<string, number>;
        return Object.fromEntries(Object.entries(counts).filter(([k]) => !k.startsWith('loadgen:')));
      };
      return f;
    },
    graders: ['verdict', 'competingFaultsIsolated', 'noDuplicateSideEffects', 'noOrphanOperations', ...COMMON_GRADERS],
    ...overrides,
  });
}

export const KV_FLAG_ORACLE: EvalOracle = {
  oracleId: FLAG_ORACLE_ID,
  scope: { components: ['kv-service'], description: 'The maintenance flag of kv-service.' },
  // what is served is the criterion: the write itself may end without an answer (an unknown outcome a human resolves)
  assertions: [
    { assertionId: 'M1', description: 'the maintenance flag is served', kind: 'requirement', severity: 'P1', check: { type: 'http_expectation', method: 'GET', path: FLAG_PATH, expectStatus: 200, expectBodyContains: FLAG_VALUE } },
  ],
  authorities: [{ sourceRef: 'KV-OPS-3 (maintenance flag)', authority: 'approved_requirement' }],
  ...human(),
};

/**
 * Unqueryable target: Hypertest dies while its PUT is in flight at kv-service (which applied it but answers late, and
 * offers no lookup by operation id): the outcome is unknown and cannot be reconciled ⇒ manual review, never a blind
 * re-send; a human operator (scripted: it checks the service's own write log) resolves it and the run continues.
 * In-process trial (the operator acts on the live instance).
 */
export function chaosUnqueryableTargetTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    taskId: CHAOS_UNQUERYABLE_TARGET_TASK_ID,
    suiteRevision: EXTENDED_SUITE_REVISION,
    title: 'Chaos: an unknown outcome on a target that cannot be queried goes to a human',
    goal: 'Publish the maintenance flag of kv-service exactly once and decide whether it is served.',
    hiddenFaults: [],
    expectedVerdict: 'pass',
    oracles: [KV_FLAG_ORACLE],
    gate: { requiredEvidence: [{ evidenceType: 'api-response', minCount: 1, critical: true }] },
    chaos: { kills: [{ after: 'dispatched', operationType: 'http.request', delayMs: 300 }] },
    graders: ['verdict', 'unqueryableEscalated', 'noOrphanOperations', ...COMMON_GRADERS],
    async setup(ctx): Promise<TrialFixture> {
      const writeLog = join(ctx.workDir, 'kv-writes.jsonl');
      const sup = await startKvService({ stateDir: join(ctx.workDir, 'kv'), writeLog, slowPutMs: 2500 });
      const observations = observationsFile(ctx);
      const resolved: Array<{ operationId: string; outcome: string }> = [];
      return {
        target: { environmentId: KV_ENV_ID, sutUrl: sup.url, description: 'kv-service (black-box, process-supervised, no lookup by operation id)' },
        environments: [{ environmentId: KV_ENV_ID, environmentClass: 'local', baseUrl: sup.url, metricsUrl: `${sup.url}/metrics`, generation: 1, control: { kind: 'process', target: sup.controlUrl } }],
        brainArgs: { observationsFile: observations },
        // the on-call human: an operation under manual review is resolved from the service's own record of its writes
        operator: {
          intervalMs: 250,
          async act({ ht, runId }) {
            for (const op of await ht.listOperations({ runId, status: ['manual_review'] })) {
              const landed = readKvWrites(writeLog).some((w) => w.idempotencyKey === op.operationId);
              const outcome = landed ? 'succeeded' : 'failed';
              await ht.resolveOperation(op.operationId, outcome, { kind: 'human', id: 'eval-operator' }, landed ? `kv-service's write log shows the PUT with Idempotency-Key ${op.operationId}` : `kv-service's write log has no write with Idempotency-Key ${op.operationId}`);
              resolved.push({ operationId: op.operationId, outcome });
            }
          },
        },
        probes: {
          [OBSERVATIONS_PROBE]: observationsProbe(observations),
          sideEffects: async (): Promise<JsonValue> => {
            const out: Record<string, number> = {};
            for (const w of readKvWrites(writeLog)) if (w.idempotencyKey) out[w.idempotencyKey] = (out[w.idempotencyKey] ?? 0) + 1;
            out['maintenance:writes'] = readKvWrites(writeLog).filter((w) => `/kv/${w.key}` === FLAG_PATH).length;
            return out;
          },
          writes: async (): Promise<JsonValue> => asJson(readKvWrites(writeLog)),
          operatorResolutions: async (): Promise<JsonValue> => asJson(resolved),
        },
        cleanup: () => sup.close(),
      };
    },
    ...overrides,
  };
}

export function chaosSuite(): EvalSuite {
  return {
    suiteId: 'chaos',
    revision: EXTENDED_SUITE_REVISION,
    tasks: [chaosKillAfterSuccessTask(), chaosBudgetExhaustionTask(), chaosCompetingFaultsTask(), chaosUnqueryableTargetTask()],
  };
}

/** Every extended task (deep tier). */
export function extendedTasks(): EvalTask[] {
  return [
    apiBlackboxTask(), uiBlackboxTask(), performanceSloTask(), performanceRegressionTask(), faultToleranceLatencyTask(), faultToleranceErrorsTask(), evidenceTamperTask(), evidenceMissingTask(),
    multiAgentDelegationTask(), multiAgentConvergenceTask(), chaosKillAfterSuccessTask(), chaosBudgetExhaustionTask(), chaosCompetingFaultsTask(), chaosUnqueryableTargetTask(),
  ];
}

