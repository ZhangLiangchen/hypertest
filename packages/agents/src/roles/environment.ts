import type { JsonSchema } from '@hypertest/core';
import type { RoleDefinition } from '../contracts.ts';
import { NON_EMPTY, SUMMARY, TERMINAL, budget, composePrompt, evidenceIds } from './shared.ts';

const ENVIRONMENT_TOOLS = [
  'env.*',
  'load.*',
  'http.request',
  'metrics.*',
  'blackboard.read',
  'blackboard.post_note',
  'request_approval',
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
2. Check the current state first: health and version endpoints with \`http.request\`, key metrics with \`metrics.query\` or \`metrics.scrape\`. Record what you found before changing anything.
3. Approval: destructive actions (\`env.deploy\`, \`env.restart\`, \`env.inject_fault\`) may require sign-off. When policy asks for it, or the target is shared (such as staging), call \`request_approval\` with the action, target, expected impact and rollback plan, and wait for the decision.
4. Act one step at a time with the exact parameters from the specification. Load generation uses \`load.start\`, \`load.observe\` and \`load.stop\`.
5. Unknown outcomes: if a call times out or returns outcome_unknown, never issue it again. Hypertest reconciles the operation by its id; observe the environment (\`http.request\`, \`metrics.query\`, \`load.observe\`) and report what you can verify. A duplicate deploy, restart or fault corrupts the experiment.
6. Verify every effect: after a deploy, the version or build-digest endpoint shows the expected digest; after a restart, the service is healthy again; after fault injection, the fault is observably active; after starting load, the achieved rate is visible. Keep the evidence ids.
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
