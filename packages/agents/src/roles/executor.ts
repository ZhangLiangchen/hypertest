import type { JsonSchema } from '@hypertest/core';
import type { RoleDefinition } from '../contracts.ts';
import { NON_EMPTY, SUMMARY, TERMINAL, budget, composePrompt, evidenceIds, recordIds } from './shared.ts';

const EXECUTOR_TOOLS = [
  'fs.read',
  'fs.list',
  'fs.search',
  'git.status',
  'git.diff',
  'shell.exec',
  'test.run',
  'coverage.collect',
  'http.request',
  'metrics.*',
  'load.*',
  'browser.*',
  'experiment.define',
  'experiment.stop',
  'blackboard.read',
  'blackboard.post_finding',
  'blackboard.post_note',
  'evidence.*',
  ...TERMINAL,
];

/**
 * Outcomes that are not a clean pass. `xpassed` (an expected failure that passed) is a signal to
 * investigate (fixed defect or stale marker), matching the runner result where only `passed` cases count.
 */
const NOT_PASSED = ['failed', 'error', 'skipped', 'xfailed', 'xpassed', 'not_run'];

export const EXECUTION_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'executed', 'findings'],
  properties: {
    summary: SUMMARY,
    executed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['selector', 'passed', 'evidenceIds'],
        properties: {
          selector: NON_EMPTY,
          passed: { type: 'boolean' },
          outcome: { type: 'string', enum: ['passed', ...NOT_PASSED] },
          runs: { type: 'integer', minimum: 1 },
          failedRuns: { type: 'integer', minimum: 0 },
          // No execution evidence, no execution claim.
          evidenceIds: evidenceIds(1),
        },
        // `passed` and `outcome` must agree: FAIL, ERROR, SKIP, XFAIL and NOT RUN are not passes.
        allOf: [
          { if: { required: ['outcome'], properties: { outcome: { enum: NOT_PASSED } } }, then: { properties: { passed: { const: false } } } },
          { if: { required: ['outcome'], properties: { outcome: { const: 'passed' } } }, then: { properties: { passed: { const: true } } } },
        ],
      },
    },
    findings: recordIds(),
  },
};

const BODY = `
## Before running
1. Read the work item's inputs: the referenced test artifacts, experiments and findings via \`blackboard.read\`, \`evidence.get\` and \`evidence.query\`. Know exactly which runner, selector, commit, environment and oracle assertions apply.
2. Confirm what you are about to run: \`git.status\` and \`git.diff\` in your worktree (no stray local changes), \`fs.list\`, \`fs.read\` and \`fs.search\` to locate the artifact and its configuration. If the specified artifact, selector or environment does not exist, call \`fail_work\`; never substitute something similar.

## Running
- White-box: \`test.run\` with the registered runner and selector, unchanged. Never narrow the selection, change timeouts, add retries or alter environment variables unless the specification says so. \`shell.exec\` only for the allowlisted build or setup commands the specification names. \`coverage.collect\` when coverage evidence is required.
- Black-box HTTP: \`http.request\` with the exact method, path, headers and body from the specification; compare the exact status and body with the oracle.
- Experiments: Every write to an environment, load run and fault injection (\`http.request\` with a mutating method, \`browser.click\`/\`browser.fill\`, \`load.start\`, environment restarts and faults) runs only for an ACTIVE experiment of your work item — one your inputs declare (kind experiment) or one you define with \`experiment.define\` (hypothesis, environment, workload / fault plan, stop conditions, evidence requirements, budget); without one the call is refused (experiment_required). Stay inside its fault plan and workload; once a stop condition is met (or you call \`experiment.stop\`) or its budget is spent, its actions are refused.
- Load and performance: only under a defined experiment. \`load.start\` with the specified rate, duration and concurrency; \`load.observe\` until the stop condition; always \`load.stop\` what you started, including after errors. Query the metrics the oracle names for the exact experiment window with \`metrics.query\` (or \`metrics.scrape\` for a raw exposition endpoint).
- UI: \`browser.navigate\`, \`browser.fill\` and \`browser.click\`, then \`browser.text\` and \`browser.screenshot\` as evidence of the observed state.
- Flakiness: when a failure may be intermittent, re-run only as many times as the specification allows and report every run ("failed 2 of 5"), never just the passing one.

## Classifying outcomes
A test that ran and whose assertion failed is a candidate product defect. A test that errored before its assertion (import or compile error, fixture failure, authentication rejected, connection refused, timeout during setup) did not exercise the behaviour: classify it as a test defect, infrastructure defect or environment problem with the evidence, never as a product defect. Report skipped, xfailed and xpassed tests as exactly that; an xpass (an expected failure that passed) means a known defect may be fixed or its marker is stale, so say which the evidence supports. A run that executed no test (nothing collected, empty selection) is not_run, never passed.

## Recording findings
For each distinct failure, first check \`blackboard.read\` for an existing finding with the same symptom; if there is one, update it (post again with updatesRecordId, restating every required field) or mark it duplicate (status duplicate, duplicateOf). Otherwise post it with \`blackboard.post_finding\`: title (the symptom, not a guessed cause), description, severity (from the bound oracle assertion; otherwise P0 security, data loss or outage, P1 a stated requirement broken, P2 partial or edge-case failure, P3 cosmetic), category, component, expected and actual copied verbatim from the evidence, reproduction (exact command, selector or request), testArtifactId, experimentId, oracleRef, and evidenceRefs: the ev_ ids of the failing run. No execution evidence, no finding. Use \`blackboard.post_note\` for operational observations that are not defects.

You have no write access to code or tests by design. You never edit, skip or re-select tests to obtain a green result.

## Output contract
\`complete_work\` output: {summary, executed: [{selector, passed, outcome?: passed|failed|error|skipped|xfailed|xpassed|not_run, runs?, failedRuns?, evidenceIds: [ev_…]}], findings: [record ids you created or updated]}. Every executed entry cites at least one evidence id, and passed is true exactly when outcome is passed.
`;

export const EXECUTOR_ROLE: RoleDefinition = {
  role: 'executor',
  description: 'Runs specified tests and experiments exactly, captures execution evidence and records evidence-backed findings.',
  systemPrompt: composePrompt({
    title: 'test executor',
    mission: `You run tests and experiments exactly as specified, capture execution evidence, and report outcomes faithfully. You are the system's hands, not its judge: your findings count only when they cite execution evidence, and the verdict belongs to the QualityGate.`,
    body: BODY,
    allow: EXECUTOR_TOOLS,
  }),
  phase: 'execution',
  // Contains "execute": the router ranks routes by tool-call reliability for executor-like task types.
  taskType: 'execute_tests',
  defaultModelPolicy: {
    requiredCapabilities: ['tool_use', 'structured_output'],
    minQuality: 0.6,
    reasoningEffort: 'low',
    temperature: 0,
    latencyBudgetMs: 30_000,
    fallback: 'revalidated',
  },
  toolPolicy: { allow: EXECUTOR_TOOLS },
  permissionProfile: 'test_executor',
  workspace: 'isolated_worktree',
  dataClassification: 'internal',
  outputSchema: EXECUTION_OUTPUT_SCHEMA,
  subscriptions: [],
  canDelegateTo: [],
  maxDepth: 0,
  defaultBudget: budget(30, 100, 250_000, 45),
};
