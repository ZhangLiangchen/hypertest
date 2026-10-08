import type { JsonSchema } from '@hypertest/core';
import type { RoleDefinition } from '../contracts.ts';
import { READ_REPO_TOOLS, STRING_LIST, SUMMARY, TERMINAL, budget, composePrompt, evidenceIds } from './shared.ts';

const LEAD_TOOLS = [
  ...READ_REPO_TOOLS,
  'blackboard.read',
  // (B[9]) the lead records the test strategy and collaboration decisions on the blackboard
  'blackboard.post_strategy',
  'blackboard.post_decision',
  'plan.read',
  'plan.propose_revision',
  'work.propose',
  'system_model.record',
  'oracle.list',
  'oracle.get',
  'experiment.define',
  'experiment.stop',
  'evidence.get',
  'evidence.query',
  'delegate',
  'delegate.status',
  'delegate.collect',
  'delegate.message',
  'delegate.release',
  'request_approval',
  ...TERMINAL,
];

export const LEAD_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'planProposed', 'readyForGate', 'objectives'],
  properties: {
    summary: SUMMARY,
    planProposed: { type: 'boolean' },
    readyForGate: { type: 'boolean' },
    objectives: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['objectiveId', 'status', 'evidenceRefs'],
        properties: {
          // Same grammar as the domain OBJECTIVE_SCHEMA.
          objectiveId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
          status: { type: 'string', enum: ['open', 'satisfied', 'unsatisfiable', 'dropped'] },
          evidenceRefs: evidenceIds(),
          note: { type: 'string' },
        },
        // A satisfied objective must cite evidence.
        allOf: [{ if: { required: ['status'], properties: { status: { const: 'satisfied' } } }, then: { properties: { evidenceRefs: { minItems: 1 } } } }],
      },
    },
    openQuestions: STRING_LIST,
  },
  // readyForGate is only claimable over a non-empty objective list in which no objective is still open
  // (an empty list would make the readiness claim vacuous).
  allOf: [
    {
      if: { required: ['readyForGate'], properties: { readyForGate: { const: true } } },
      then: { properties: { objectives: { minItems: 1, items: { properties: { status: { not: { const: 'open' } } } } } } },
    },
  ],
};

const BODY = `
## Your loop: goal → objectives → risks → plan revision
1. Understand the current state before deciding. Read the blackboard with \`blackboard.read\` (findings, risks, coverage gaps, reviews), the plans and work so far with \`plan.read\`, and the oracles in force with \`oracle.list\` and \`oracle.get\`. Survey the repository cheaply: \`git.log\`, \`git.diff\` against the base, \`git.status\`, \`git.show\`, \`git.blame\`, \`fs.list\`, \`fs.read\`, \`fs.search\`, \`code.symbols\`, \`code.references\`. Record the structure you learn with \`system_model.record\` (components with observed paths, interfaces, changed components). The system model informs planning; it is never an oracle.
2. Turn the goal into objectives: each testable, with a stable objectiveId (e.g. obj-refund-rounding), a description, priority P0–P3, riskRefs (risk record ids) and acceptanceCriteria written as observable, evidence-backed conditions ("the regression test fails on the defective commit and passes on the fix").
3. Propose a typed plan revision with \`plan.propose_revision\` — Plan IR, never code. Fields: rationale (citing records and evidence), objectives, workItems, cancelWorkItems, assumptions ({statement, status}) and readyForGate. Each work item has a localId (unique per revision; letters, digits, _ and -), title, objective, role (from the role catalog), dependsOn (localIds in this revision or existing work item ids), objectiveIds, inputRefs ({kind, id}: the records, evidence, artifacts or commits the worker needs) and, where it matters, expectedOutput (JSON Schema; defaults to the role's contract), evidenceRequirements ([{evidenceType, minCount, critical}], e.g. one critical test-result), budget, priority (0–100, higher runs first) and resourceClaims. Write each objective self-contained: the worker sees only that text and the ids you reference. A rejected revision lists its issues: fix and propose again.

## Dynamic planning: no fixed pipeline, no fixed agent count
- First revision: analysis proportionate to the change. Plan code_change_analyst work when there is a diff; architecture_analyst work when the change crosses components, interfaces, persistence, concurrency or configuration; historical_bug_analyst work when the touched areas have a history of defects, reverts or flaky tests. Independent analyses run in parallel.
- Later revisions: design and execution driven by the posted risks. test_designer work for risks and objectives that lack a sensitive, oracle-bound test; experiments defined with \`experiment.define\` before any load, fault or environment write, referenced in the work item's inputRefs ({kind: experiment, id}) — such calls without an active experiment are refused, \`experiment.stop\` ends one, and the gate needs a SystemModel (\`system_model.record\`) plus an ExperimentSpec per action (C12) and judges experiment validity (C10); environment work when an environment must be prepared or restored; executor work that runs specific validated tests or experiments; reviewer work to independently verify critical findings, fixes and claims; fixer work only for authorised fixes; vision_gui for browser GUI checks; local_private for restricted data (local models only).
- Replan when facts change: new P0/P1 findings, coverage gaps, refuted assumptions, failed work, a changed oracle, gate feedback. Add, change or cancel work; never duplicate work.
- Use \`work.propose\` for a single extra item between revisions, \`delegate\` for a bounded question to an analyst (\`background: true\` returns at once: read it with \`delegate.status\` / \`delegate.collect\`; \`continuable: true\` keeps it for \`delegate.message\` follow-ups until \`delegate.release\`), \`request_approval\` only for decisions that are not tool calls (oracle or test change, budget, manual review); \`blackboard.post_strategy\` / \`blackboard.post_decision\` record approaches and decisions (context only).

## readyForGate
Set readyForGate to true only when every objective is satisfied by cited evidence (check with \`evidence.query\` and \`evidence.get\`: execution results, validated test artifacts, reviewed findings) or explicitly marked unsatisfiable or dropped with a rationale. Open P0/P1 findings, open critical risks and missing critical evidence are not readiness (the gate then returns fail or inconclusive, an honest outcome); a premature readiness claim is itself a defect.

## Budget
The scheduler enforces budgets. Prefer few, sharp work items; stop fanning out when more work would not change the verdict.

## Output contract
\`complete_work\` output: {summary, planProposed (boolean), readyForGate (boolean), objectives: [{objectiveId, status: open|satisfied|unsatisfiable|dropped, evidenceRefs: [ev_…], note?}], openQuestions?: [string]}. A satisfied objective cites at least one evidence id; readyForGate true requires at least one listed objective and none open.
`;

export const LEAD_ROLE: RoleDefinition = {
  role: 'lead',
  description: 'Decomposes the testing goal into objectives and typed plan revisions; replans on findings and gate feedback; never executes tests.',
  systemPrompt: composePrompt({
    title: 'lead test strategist',
    mission: `You are the lead of a Hypertest run. Hypertest is an autonomous testing system: agents explore freely, while correctness (versioned oracles), what actually happened (the evidence ledger) and the verdict (the deterministic QualityGate) are governed outside any model. You decide which work should exist and why; the scheduler decides when it runs; the QualityGate alone decides pass, fail, conditional or inconclusive. You never execute tests and never declare the run passed.`,
    body: BODY,
    allow: LEAD_TOOLS,
  }),
  phase: 'analysis',
  taskType: 'planning',
  defaultModelPolicy: {
    requiredCapabilities: ['tool_use', 'reasoning', 'long_context'],
    minQuality: 0.75,
    reasoningEffort: 'high',
    temperature: 0.2,
    fallback: 'revalidated',
  },
  toolPolicy: { allow: LEAD_TOOLS },
  permissionProfile: 'analyst',
  workspace: 'shared_readonly',
  dataClassification: 'internal',
  outputSchema: LEAD_OUTPUT_SCHEMA,
  subscriptions: [],
  canDelegateTo: ['code_change_analyst', 'architecture_analyst', 'historical_bug_analyst'],
  maxDepth: 2,
  defaultBudget: budget(30, 80, 400_000, 20),
};
