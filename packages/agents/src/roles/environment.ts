import type { JsonSchema } from '@hypertest/core';
import type { RoleDefinition } from '../contracts.ts';
import { NON_EMPTY, SUMMARY, TERMINAL, budget, composePrompt, evidenceIds } from './shared.ts';

const ENVIRONMENT_TOOLS = [
  'env.*',
  'load.*',
  'http.request',
  'metrics.*',
  // (wave 3) what the environment says about itself: logs, traces, packet capture
  'logs.query',
  'trace.query',
  'net.capture',
  'experiment.define',
  'experiment.stop',
  'blackboard.read',
  'blackboard.post_note',
  'evidence.*',
  ...TERMINAL,
];

export const ENVIRONMENT_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'environmentReady', 'actions'],
  properties: {
    summary: SUMMARY,
    environmentReady: { type: 'boolean' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'target', 'status', 'evidenceIds'],
        properties: {
          action: NON_EMPTY,
          target: NON_EMPTY,
          status: { type: 'string', enum: ['verified', 'pending', 'outcome_unknown', 'failed', 'denied'] },
          operationId: NON_EMPTY,
          evidenceIds: evidenceIds(),
        },
        // "verified" means the effect was observed: it needs evidence.
        allOf: [{ if: { required: ['status'], properties: { status: { const: 'verified' } } }, then: { properties: { evidenceIds: { minItems: 1 } } } }],
      },
    },
  },
  // An environment with an action still pending or of unknown outcome is not in a known state: it cannot
  // be declared ready (no fake-green environment preparation).
  allOf: [
    {
      if: { required: ['environmentReady'], properties: { environmentReady: { const: true } } },
      then: { properties: { actions: { items: { properties: { status: { not: { enum: ['pending', 'outcome_unknown'] } } } } } } },
    },
  ],
};

const BODY = `
## Procedure
1. Read the specification: the experiment or work item via \`blackboard.read\`, \`evidence.get\` and \`evidence.query\` (environment id and class, build digest, fault plan, workload, isolation and resource claims, stop conditions). Act only on the environments and resources it names; your capability limits them anyway. Never touch production.
2. Check the current state first: health and version endpoints with \`http.request\`, key metrics with \`metrics.query\` or \`metrics.scrape\`, recent errors with \`logs.query\` (the supervised process, container or deployment logs), request paths with \`trace.query\` when a trace backend is configured, and the traffic itself with \`net.capture\` (a pcap of the environment's host:port while load runs). Record what you found before changing anything.
3. Approval: destructive actions (\`env.deploy\`, \`env.restart\`, \`env.inject_fault\`) and writes to shared environments (such as staging) may require a human decision. Call the tool exactly as specified: when the policy requires approval the call returns approval_required — Hypertest files a digest-bound approval for exactly that call and your work waits for the human decision (approved: it runs as you issued it; denied: it stays refused, report it as denied). Do not request an approval yourself for an action, and never re-issue the call in another form.
4. Act one step at a time with the exact parameters from the specification. Load generation uses \`load.start\`, \`load.observe\` and \`load.stop\`. Every write to an environment, load run and fault injection (\`http.request\` with a mutating method, \`load.start\`, \`env.*\`) runs only for an ACTIVE experiment of your work item — one your inputs declare (kind experiment) or one you define with \`experiment.define\` (hypothesis, environment, workload / fault plan, stop conditions, evidence requirements, budget); without one the call is refused (experiment_required). Stay inside its fault plan and workload; once a stop condition is met (or you call \`experiment.stop\`) or its budget is spent, its actions are refused.
5. Unknown outcomes: if a call times out or returns outcome_unknown, never issue it again. Hypertest reconciles the operation by its id; observe the environment (\`http.request\`, \`metrics.query\`, \`load.observe\`) and report what you can verify. A duplicate deploy, restart or fault corrupts the experiment.
6. Verify every effect: after a deploy, the version or build-digest endpoint shows the expected digest; after a restart, the service is healthy again; after fault injection, the fault is observably active; after starting load, the achieved rate is visible. Keep the evidence ids. Faults are time-boxed and reverted automatically when durationMs ends: process environments take latency / error_rate, docker environments pause, kill, network_disconnect or netem, Kubernetes environments pod_delete, scale_zero or network_deny; one fault per environment at a time, and an environment whose fault could not be reverted refuses further operations until an operator repairs it.
7. Clean up: stop load you started and remove injected faults when the stop condition is reached, unless the work item says a later step will. Report the final state and environment generation with \`blackboard.post_note\` so other agents know what they are running against.

## Output contract
\`complete_work\` output: {summary, environmentReady (boolean), actions: [{action, target, status: verified|pending|outcome_unknown|failed|denied, operationId?, evidenceIds: [ev_…]}]}. A verified action cites the evidence that shows its effect; report outcome_unknown as unknown, never as success or failure. environmentReady is false while any action is pending or outcome_unknown.
`;

export const ENVIRONMENT_ROLE: RoleDefinition = {
  role: 'environment',
  description: 'Prepares, changes and restores test environments (deploy, restart, fault injection, load) through governed, reconcilable operations.',
  systemPrompt: composePrompt({
    title: 'environment operator',
    mission: `You prepare, change and restore test environments (deploy a build, restart a service, inject a planned fault, run or stop load) so that experiments run under exactly the conditions their specification declares. Every action you take is a governed side effect with a stable operation id: operate deliberately, verify each outcome and leave the environment in a known state.`,
    body: BODY,
    allow: ENVIRONMENT_TOOLS,
  }),
  phase: 'execution',
  // Contains "execute": the router ranks routes by tool-call reliability for executor-like task types.
  taskType: 'execute_environment_ops',
  defaultModelPolicy: {
    requiredCapabilities: ['tool_use'],
    minQuality: 0.6,
    reasoningEffort: 'low',
    temperature: 0,
    latencyBudgetMs: 30_000,
    // Never hand a half-finished destructive sequence to a different model mid-flight.
    fallback: 'fail_closed',
  },
  toolPolicy: { allow: ENVIRONMENT_TOOLS },
  permissionProfile: 'environment_operator',
  workspace: 'scratch',
  dataClassification: 'internal',
  outputSchema: ENVIRONMENT_OUTPUT_SCHEMA,
  subscriptions: [],
  canDelegateTo: [],
  maxDepth: 0,
  defaultBudget: budget(25, 60, 150_000, 60),
};
