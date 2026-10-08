/**
 * Toy eval tasks + scripted brains proving the harness end to end (the PoC suites plug into the same platform).
 *
 * - `toyDefectTask`: a git repository whose second commit seeds a regression in `sum()` (two negative operands are
 *   subtracted). The lead plans one executor item; the executor runs the real node:test suite, posts a P1 product
 *   finding citing the failing test-result evidence and completes; the lead hands over to the gate ⇒ verdict `fail`.
 * - `toyRestartTask`: a process-supervised loopback service registered as a `local` environment. The environment
 *   operator restarts it (`env.restart`, a destructive side effect through the Operation Ledger, usually pending ⇒
 *   the work item waits), verifies it serves with `http.request` (api-response evidence) and completes; the lead hands
 *   over to the gate ⇒ `pass`. With `killAfterOperationDispatch: 1` the Hypertest process is killed right after the
 *   restart was dispatched: the resumed run must RECONCILE the operation by its id (the supervisor restarted once),
 *   never restart a second time.
 *
 * Brains are functions of the request only (the child rebuilds them after a kill). `toyBrains` is the child-process
 * brains export: `(ctx) => ({ sim: roleRouter(...) })` selecting the scenario from `ctx.args.scenario`.
 */
import type { JsonValue } from '@hypertest/core';
import type { ScriptedBrain } from '@hypertest/model';
import type { HypertestConfig } from '@hypertest/app';
import { startProcessSupervisor } from '@hypertest/tools';
import { createGitRepo } from '@hypertest/testkit';
import { evidenceIdsIn, operationIdsIn, recordIdsIn, roleRouter, toolCall, type ChildBrainContext, type EvalArm, type EvalOracle, type EvalTask, type RoleBrain, type TrialFixture } from '../../src/index.ts';

export const TOY_MODULE = import.meta.filename;

// ------------------------------------------------------------------------------------------------ config

export const FULL_ROUTE = {
  capabilities: ['tool_use', 'parallel_tool_calls', 'structured_output', 'reasoning', 'long_context'],
  quality: { default: 0.9 },
  maxActionRisk: 'critical',
  // an explicit profile (A[2]): what the defaults used to assume, declared
  maxDataClassification: 'confidential',
  structuredOutput: 'native',
  costPerMillionInputUsd: 0,
  costPerMillionOutputUsd: 0,
} as const;

/** One scripted provider `sim` + one route; no independent reviewer (the toy runs have none); `gate` overrides. */
export function toyConfig(base: HypertestConfig, gate: HypertestConfig['gate'] = {}): HypertestConfig {
  return {
    ...base,
    models: {
      providers: [{ id: 'sim', kind: 'scripted' }],
      routes: [{ routeId: 'sim-large', provider: 'sim', model: 'sim-1', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities], quality: { ...FULL_ROUTE.quality } }],
    },
    gate: { ...(base.gate ?? {}), requireIndependentReview: false, ...gate },
  };
}

// ------------------------------------------------------------------------------------------------ lead

const OBJECTIVE = {
  objectiveId: 'obj-release',
  description: 'Decide whether the candidate is releasable, from execution evidence.',
  priority: 'P1',
  acceptanceCriteria: ['the check ran on the candidate with recorded execution evidence'],
};

/** coverage-1 (gate C12): the toy leads record the system under test before they plan. */
const SYSTEM_MODEL = { components: [{ componentId: 'toy', name: 'toy candidate', kind: 'module', paths: ['src'] }], sources: [{ kind: 'record', id: 'eval-toy' }] };

function leadBrain(plan: { title: string; objective: string; evidenceType: string }, evidenceType: string): RoleBrain {
  return (v) => {
    if (v.kind === 'initial_plan') {
      if (v.step === 0) return toolCall('system_model.record', SYSTEM_MODEL);
      if (v.step === 1) {
        return toolCall('plan.propose_revision', {
          rationale: 'Execute the release check on the candidate.',
          objectives: [OBJECTIVE],
          workItems: [
            {
              localId: 'check', title: plan.title, objective: plan.objective, role: 'executor', dependsOn: [], objectiveIds: [OBJECTIVE.objectiveId],
              evidenceRequirements: [{ evidenceType: plan.evidenceType, minCount: 1, critical: true }],
            },
          ],
        });
      }
      return toolCall('complete_work', { summary: 'Plan v1 proposed', output: { summary: 'Plan v1', planProposed: true, readyForGate: false, objectives: [{ objectiveId: OBJECTIVE.objectiveId, status: 'open', evidenceRefs: [] }] } });
    }
    // replan (plan drained): look the evidence up, hand over to the gate
    if (v.step === 0) return toolCall('evidence.query', { evidenceType });
    const ev = evidenceIdsIn(v.toolResults[0]?.content ?? '').slice(0, 1);
    if (v.step === 1) {
      return toolCall('plan.propose_revision', { rationale: 'The check ran with recorded evidence; hand over to the gate.', objectives: [{ ...OBJECTIVE, status: 'satisfied' }], workItems: [], readyForGate: true });
    }
    return toolCall('complete_work', {
      summary: 'Plan v2: ready for the gate', evidenceRefs: ev,
      output: { summary: 'ready for gate', planProposed: true, readyForGate: true, objectives: [{ objectiveId: OBJECTIVE.objectiveId, status: 'satisfied', evidenceRefs: ev }] },
    });
  };
}

// ------------------------------------------------------------------------------------------------ defect scenario

export const SUM_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from '../src/sum.js';

test('adds two numbers', () => {
  assert.equal(sum(2, 3), 5);
});

test('adds negatives', () => {
  assert.equal(sum(-2, -3), -5);
});
`;

/** Executor that runs the suite and reports faithfully (finding with the failing evidence). */
const faithfulExecutor: RoleBrain = (v) => {
  if (v.step === 0) return toolCall('test.run', { framework: 'node_test' });
  const run = v.toolResults[0]!;
  const ids = evidenceIdsIn(run.content);
  const failed = /"passed":\s*false|\bfailed\b/.test(run.content) && !/"failed":\s*0\b/.test(run.content);
  if (failed && v.step === 1) {
    return toolCall('blackboard.post_finding', {
      title: 'sum() returns a wrong result for two negative numbers',
      description: 'test/sum.test.js "adds negatives" fails on the candidate: sum(-2, -3) is not -5.',
      severity: 'P1', category: 'product_defect', component: 'src/sum.js', expected: '-5', actual: 'a different value (see the test-result evidence)',
      reproduction: 'node --test test/sum.test.js', evidenceRefs: ids,
    });
  }
  const findings = failed ? recordIdsIn(v.toolResults[1]?.content ?? '') : [];
  return toolCall('complete_work', {
    summary: failed ? 'The sum suite fails on the candidate.' : 'The sum suite passes on the candidate.', evidenceRefs: ids,
    output: { summary: failed ? 'suite failed' : 'suite passed', executed: [{ selector: 'test/sum.test.js', passed: !failed, outcome: failed ? 'failed' : 'passed', evidenceIds: ids }], findings },
  });
};

/** Brains of the defect scenario. `lazy`: the lead declares the candidate ready without planning any check. */
export function defectBrains(options: { lazy?: boolean } = {}): Record<string, ScriptedBrain> {
  const lead = leadBrain({ title: 'Run the sum suite', objective: 'Run the node:test suite of the repository on the candidate commit and report the outcome with evidence.', evidenceType: 'test-result' }, 'test-result');
  if (options.lazy) {
    const lazyLead: RoleBrain = (v) => {
      if (v.step === 0) return toolCall('plan.propose_revision', { rationale: 'Looks fine.', objectives: [{ ...OBJECTIVE, status: 'satisfied' }], workItems: [], readyForGate: true });
      return toolCall('complete_work', { summary: 'ready', output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: OBJECTIVE.objectiveId, status: 'satisfied', evidenceRefs: [] }] } });
    };
    return { sim: roleRouter({ lead: lazyLead }) };
  }
  return { sim: roleRouter({ lead, executor: faithfulExecutor }) };
}

export const toyDefectTask: EvalTask = {
  taskId: 'toy-defect',
  suiteRevision: 'toy-1',
  title: 'Seeded regression in sum()',
  goal: 'Analyse this change and decide whether the candidate is releasable.',
  hiddenFaults: [{ faultId: 'sum-negatives', description: 'sum() subtracts when both operands are negative', severity: 'P1', detectionHints: ['sum', 'negative'] }],
  expectedVerdict: 'fail',
  graders: ['verdict', 'defectDetected', 'evidenceCompleteness', 'evidenceIntegrity', 'policyViolation', 'auditReconstruction'],
  async setup(): Promise<TrialFixture> {
    const repo = await createGitRepo(
      { 'package.json': '{ "name": "calc", "type": "module", "private": true }\n', 'src/sum.js': 'export function sum(a, b) {\n  return a + b;\n}\n', 'test/sum.test.js': SUM_TEST },
      [{ message: 'optimise sum', files: { 'src/sum.js': 'export function sum(a, b) {\n  return a < 0 && b < 0 ? a - b : a + b;\n}\n' } }],
    );
    return { target: { repoPath: repo.path, commit: repo.commits[1]!, baseCommit: repo.commits[0]! }, cleanup: repo.cleanup };
  },
};

export const faithfulArm: EvalArm = { armId: 'faithful', description: 'plans a check and reports it faithfully', config: (base) => toyConfig(base), brains: () => defectBrains() };
export const lazyArm: EvalArm = { armId: 'lazy', description: 'declares ready without any check', config: (base) => toyConfig(base), brains: () => defectBrains({ lazy: true }) };

// ------------------------------------------------------------------------------------------------ restart scenario

export const TOY_ENV_ID = 'toy-svc';

/**
 * A tiny HTTP service (the system under test of the restart scenario) listening on $PORT after a 1 s warm-up, so a
 * restart stays in flight long enough for the chaos kill to land while the operation is still running.
 */
const SERVICE_SOURCE = "setTimeout(() => require('node:http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1'), 1000)";

/**
 * Environment operator of the restart scenario: env.restart (a governed destructive side effect with an operation id;
 * usually pending ⇒ the work item waits) → http.request GET / to verify the service is healthy again (api-response
 * evidence) → complete with the verified action.
 */
const restartOperator: RoleBrain = (v) => {
  // D-4: a restart is a fault-like action on the environment — it runs only for an experiment that plans it
  if (v.step === 0) return toolCall('experiment.define', { hypothesis: 'toy-svc serves again after one planned restart', environmentId: TOY_ENV_ID, faultPlan: [{ kind: 'restart', target: TOY_ENV_ID }] });
  if (v.step === 1) return toolCall('env.restart', { environmentId: TOY_ENV_ID, reason: 'planned restart of the candidate before the check' });
  const restarted = v.toolResults[1]?.content ?? '';
  // a pending restart (the item waited) is settled by the "Results of pending operations" message of the resumed turn
  const settled = /^\[pending\]/.test(restarted) ? (/- operation op_\w+ \(env\.restart\) (\w+)/.exec(v.userText)?.[1] ?? 'pending') : /^\[(\w+)\]/.exec(restarted)?.[1] ?? 'verified';
  if (v.step === 2) {
    if (settled !== 'verified') return toolCall('fail_work', { reason: 'agent_failed', message: `env.restart did not verify (${settled}): ${restarted.slice(0, 300)}` });
    return toolCall('http.request', { method: 'GET', environmentId: TOY_ENV_ID, path: '/' });
  }
  const ids = evidenceIdsIn(v.toolResults[2]?.content ?? '');
  const op = operationIdsIn(`${restarted}\n${v.userText}`)[0];
  const action: Record<string, JsonValue> = { action: 'env.restart', target: TOY_ENV_ID, status: 'verified', evidenceIds: ids };
  if (op) action['operationId'] = op;
  return toolCall('complete_work', {
    summary: 'toy-svc was restarted once and serves again.', evidenceRefs: ids,
    output: { summary: 'restarted', environmentReady: true, actions: [action] },
  });
};

export function restartBrains(): Record<string, ScriptedBrain> {
  const lead: RoleBrain = (v) => {
    if (v.kind === 'initial_plan') {
      if (v.step === 0) return toolCall('system_model.record', SYSTEM_MODEL);
      if (v.step === 1) {
        return toolCall('plan.propose_revision', {
          rationale: 'Restart the candidate service once and verify it serves.',
          objectives: [OBJECTIVE],
          workItems: [
            {
              localId: 'restart', title: 'Restart toy-svc', objective: 'Restart the toy-svc environment exactly once and verify that it serves GET / afterwards, with evidence.', role: 'environment',
              dependsOn: [], objectiveIds: [OBJECTIVE.objectiveId], evidenceRequirements: [{ evidenceType: 'api-response', minCount: 1, critical: true }],
            },
          ],
        });
      }
      return toolCall('complete_work', { summary: 'Plan v1 proposed', output: { summary: 'Plan v1', planProposed: true, readyForGate: false, objectives: [{ objectiveId: OBJECTIVE.objectiveId, status: 'open', evidenceRefs: [] }] } });
    }
    return leadBrain({ title: '', objective: '', evidenceType: 'api-response' }, 'api-response')(v);
  };
  return { sim: roleRouter({ lead, environment: restartOperator }) };
}

/**
 * The toy service's correctness criterion (conformance-1: a run is judged against an oracle in force, established by a
 * human authority): after the restart it serves `ok` on `/`.
 */
export const TOY_SVC_ORACLE: EvalOracle = {
  oracleId: 'toy-svc-serves',
  scope: { components: ['toy-svc'], description: 'The toy service answers on its root path.' },
  assertions: [
    {
      assertionId: 'serves-ok', description: 'GET / answers 200 with body ok', kind: 'requirement', severity: 'P1',
      check: { type: 'http_expectation', method: 'GET', path: '/', expectStatus: 200, expectBodyContains: 'ok' },
    },
  ],
  authorities: [{ sourceRef: 'toy-svc README', authority: 'approved_requirement' }],
  judgePolicy: { deterministicRequiredForCritical: true, allowLlmOnlyDecision: false, independentReviewerRequired: false },
  changePolicy: { agentMayPropose: true, selfApprove: false, invalidatesPriorDecisions: true, approvers: ['human'] },
};

/**
 * The restart task: a process-supervised loopback service registered as a `local` environment. Ground truth comes from
 * the supervisor: every restart it performed, keyed by operation id (idempotent per id), and the logical number of
 * restarts (generation − 1) — a resumed run that restarted again would show 2.
 */
export function toyRestartTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    taskId: 'toy-restart',
    suiteRevision: 'toy-1',
    title: 'Restart the service once, with a kill after the dispatch',
    goal: 'Restart toy-svc once, verify it serves, and decide whether it is releasable.',
    hiddenFaults: [],
    expectedVerdict: 'pass',
    oracles: [TOY_SVC_ORACLE],
    chaos: { killAfterOperationDispatch: 1 },
    graders: ['verdict', 'noDuplicateSideEffects', 'evidenceCompleteness', 'evidenceIntegrity', 'policyViolation', 'auditReconstruction'],
    async setup(ctx): Promise<TrialFixture> {
      const sup = await startProcessSupervisor({ command: [process.execPath, '-e', SERVICE_SOURCE], cwd: ctx.workDir, inheritEnv: false, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } });
      return {
        target: { environmentId: TOY_ENV_ID, sutUrl: sup.url },
        environments: [{ environmentId: TOY_ENV_ID, environmentClass: 'local', baseUrl: sup.url, generation: 1, control: { kind: 'process', target: sup.controlUrl } }],
        probes: {
          sideEffects: async (): Promise<JsonValue> => {
            const out: Record<string, number> = {};
            for (const op of sup.operations()) if (op.kind === 'restart') out[op.operationId] = (out[op.operationId] ?? 0) + 1;
            out[`${TOY_ENV_ID}:restarts`] = sup.generation - 1;
            return out;
          },
          'metric.serviceGeneration': async () => sup.generation,
        },
        cleanup: () => sup.close(),
      };
    },
    ...overrides,
  };
}

/** Child-process brains export: `ctx.args.scenario` selects the brains ('defect' | 'lazy' | 'restart'). */
export function toyBrains(ctx: ChildBrainContext): Record<string, ScriptedBrain> {
  const scenario = (ctx.args as { scenario?: string } | undefined)?.scenario;
  if (scenario === 'restart') return restartBrains();
  if (scenario === 'lazy') return defectBrains({ lazy: true });
  if (scenario === 'defect') return defectBrains();
  throw new Error(`unknown toy scenario ${String(scenario)}`);
}

export const restartArm: EvalArm = {
  armId: 'restart',
  description: 'restarts the service once and verifies it',
  // black-box: the gate requires API evidence instead of the default test-result
  config: (base) => toyConfig(base, { requiredEvidence: [{ evidenceType: 'api-response', minCount: 1 }] }),
  brains: () => restartBrains(),
  child: { brainsModule: TOY_MODULE, brainsExport: 'toyBrains', args: () => ({ scenario: 'restart' }) },
};
