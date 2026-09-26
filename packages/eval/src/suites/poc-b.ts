/**
 * PoC B — Event-driven black-box defect loop (BLUEPRINT §6; acceptance table "首批 PoC：Event-driven 黑盒缺陷闭环").
 *
 * Fixture: `fixtures/bank-api/server.js` (a child process on a free loopback port; registered as the sandbox environment
 * `bank`) with a hidden defect: a negative transfer amount is accepted (201) and moves money backwards. Oracle
 * `bank-api`: B1 P1 "non-positive transfer amounts are rejected with 400" (http_expectation POST /transfers ⇒ 400),
 * B2 P0 "the total balance is conserved" (GET /health reports balanceConserved). Chaos: every bus message is delivered
 * twice. Ground truth: the server's per-Idempotency-Key effect counts. Expected verdict: fail.
 */
import type { JsonValue } from '@hypertest/core';
import type { EvalOracle, EvalTask, TrialFixture } from '../contracts.ts';
import { asJson, startBankApi } from '../fixtures.ts';
import { BANK_ENV_ID, BANK_ORACLE_ID } from '../brains/poc-b.ts';
import { OBSERVATIONS_PROBE, POC_SUITE_REVISION, observationsFile, observationsProbe } from './common.ts';

export const BANK_ORACLE: EvalOracle = {
  oracleId: BANK_ORACLE_ID,
  scope: { components: ['transfers', 'accounts'], description: 'Transfer contract of the bank API.' },
  assertions: [
    {
      assertionId: 'B1', description: 'non-positive transfer amounts are rejected with 400', kind: 'requirement', severity: 'P1',
      check: { type: 'http_expectation', method: 'POST', path: '/transfers', expectStatus: 400 },
    },
    {
      assertionId: 'B2', description: 'the total balance is conserved (the service reports balanceConserved on /health)', kind: 'deterministic_invariant', severity: 'P0',
      check: { type: 'http_expectation', method: 'GET', path: '/health', expectStatus: 200, expectBodyContains: '"balanceConserved":true' },
    },
  ],
  authorities: [{ sourceRef: 'BANK-API-SPEC §4 transfers', authority: 'formal_spec' }],
  judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: true },
  changePolicy: { agentMayPropose: true, selfApprove: false, invalidatesPriorDecisions: true, approvers: ['human'] },
};

export const POC_B_TASK_ID = 'poc-b-event-driven';

export function pocBTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    taskId: POC_B_TASK_ID,
    suiteRevision: POC_SUITE_REVISION,
    title: 'Event-driven black-box defect loop (bank API transfers)',
    goal: 'Test the transfer API of the bank service against its contract and decide whether it is releasable.',
    hiddenFaults: [
      { faultId: 'negative-transfer', description: 'POST /transfers accepts a negative amount (201) and moves money backwards', severity: 'P1', detectionHints: ['transfer', 'negative', 'amount'] },
    ],
    expectedVerdict: 'fail',
    oracles: [BANK_ORACLE],
    gate: { requiredEvidence: [{ evidenceType: 'api-response', minCount: 1, critical: true }] },
    chaos: { duplicateEventDelivery: true },
    graders: [
      'verdict', 'defectDetected', 'pocBWorkflow', 'causalChain', 'singleLeaseOwner', 'noDuplicateSideEffects', 'independentReview', 'reportTracesToEvidence', 'evidenceCompleteness',
      'evidenceIntegrity', 'policyViolation', 'auditReconstruction',
    ],
    async setup(ctx): Promise<TrialFixture> {
      const bank = await startBankApi();
      const observations = observationsFile(ctx);
      return {
        target: { environmentId: BANK_ENV_ID, sutUrl: bank.url, description: 'bank API (black-box)' },
        environments: [{ environmentId: BANK_ENV_ID, environmentClass: 'sandbox', baseUrl: bank.url, metricsUrl: `${bank.url}/metrics`, generation: 1 }],
        brainArgs: { observationsFile: observations },
        probes: {
          [OBSERVATIONS_PROBE]: observationsProbe(observations),
          sideEffects: async (): Promise<JsonValue> => asJson(await bank.effects()),
          bankHealth: async (): Promise<JsonValue> => asJson(await bank.health()),
        },
        cleanup: () => bank.close(),
      };
    },
    ...overrides,
  };
}
