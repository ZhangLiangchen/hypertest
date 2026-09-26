/**
 * PoC A — Multi-LLM white-box autonomous regression (BLUEPRINT §6; acceptance table "首批 PoC：Multi-LLM 白盒自主回归").
 *
 * Fixture: the ledger git repository (base = correct initial commit, candidate = "refactor pagination" with the seeded
 * regression `slice(start, start + size - 1)`); the original suite covers only page 1 of a short list, so it stays
 * green on the candidate. Oracle `ledger-contract` (human authority, established before the run): A1 P1 requirement
 * "paginate returns every item exactly once across pages", A2 P0 invariant "applyTransfer conserves the total balance".
 * Expected verdict: fail (the seeded defect is detected with execution evidence and stays unresolved).
 */
import { join } from 'node:path';
import type { EvalOracle, EvalTask, TrialFixture } from '../contracts.ts';
import { createLedgerRepo, gitShowFile } from '../fixtures.ts';
import { LEDGER_ORACLE_ID } from '../brains/poc-a.ts';
import { OBSERVATIONS_PROBE, POC_SUITE_REVISION, observationsFile, observationsProbe } from './common.ts';

/** The ledger contract (the test selectors are globs over the recorded test case names). */
export const LEDGER_ORACLE: EvalOracle = {
  oracleId: LEDGER_ORACLE_ID,
  scope: { components: ['ledger'], description: 'Public contract of the ledger library: pagination and transfers.' },
  assertions: [
    {
      assertionId: 'A1', description: 'paginate returns every item exactly once across pages', kind: 'requirement', severity: 'P1',
      check: { type: 'test_outcome', testSelector: '*paginate*', expected: 'pass' },
    },
    {
      assertionId: 'A2', description: 'applyTransfer conserves the total balance', kind: 'deterministic_invariant', severity: 'P0',
      check: { type: 'test_outcome', testSelector: '*transfer conserves*', expected: 'pass' },
    },
  ],
  authorities: [{ sourceRef: 'LEDGER-REQ-3 (pagination), LEDGER-REQ-7 (conservation of money)', authority: 'approved_requirement' }],
  judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: true },
  changePolicy: { agentMayPropose: true, selfApprove: false, invalidatesPriorDecisions: true, approvers: ['human'] },
};

export const POC_A_TASK_ID = 'poc-a-whitebox';

/** The PoC A task (overrides for variants). */
export function pocATask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    taskId: POC_A_TASK_ID,
    suiteRevision: POC_SUITE_REVISION,
    title: 'Multi-LLM white-box autonomous regression (ledger pagination)',
    goal: 'Analyse this change and decide whether it satisfies the release conditions.',
    hiddenFaults: [
      {
        faultId: 'paginate-off-by-one',
        description: 'paginate drops the last item of every page: items.slice(start, start + size - 1)',
        severity: 'P1',
        detectionHints: ['paginate', 'page', 'slice', 'off-by-one'],
      },
    ],
    expectedVerdict: 'fail',
    oracles: [LEDGER_ORACLE],
    gate: { requiredEvidence: [{ evidenceType: 'test-result', minCount: 1, critical: true }] },
    graders: [
      'verdict', 'defectDetected', 'planDynamics', 'pocAWorkflow', 'contextIsolation', 'independentReview', 'causalChain', 'evidenceCompleteness', 'evidenceIntegrity',
      'policyViolation', 'auditReconstruction',
    ],
    async setup(ctx): Promise<TrialFixture> {
      const repo = await createLedgerRepo(join(ctx.workDir, 'sut'));
      const observations = observationsFile(ctx);
      return {
        target: { repoPath: repo.path, commit: repo.head, baseCommit: repo.base, description: 'ledger library' },
        brainArgs: { observationsFile: observations },
        probes: {
          [OBSERVATIONS_PROBE]: observationsProbe(observations),
          // the candidate itself is never modified by the run (agents work in worktrees)
          candidateSource: async () => gitShowFile(repo.path, 'HEAD', 'src/ledger.js'),
        },
        cleanup: async () => undefined,
      };
    },
    ...overrides,
  };
}
