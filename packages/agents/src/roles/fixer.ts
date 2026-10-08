import type { JsonSchema } from '@hypertest/core';
import type { RoleDefinition } from '../contracts.ts';
import { COMMIT_SHA, NON_EMPTY, SUMMARY, TERMINAL, budget, composePrompt, evidenceIds, recordIds } from './shared.ts';

const FIXER_TOOLS = [
  'fs.*',
  'git.*',
  'code.symbols',
  'code.references',
  'lsp.*',
  'analysis.run',
  'test.run',
  'shell.exec',
  'blackboard.read',
  'blackboard.post_note',
  'evidence.*',
  ...TERMINAL,
];

export const FIX_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'status', 'changes', 'regression', 'findingRecordIds'],
  properties: {
    summary: SUMMARY,
    status: { type: 'string', enum: ['fixed', 'not_fixed', 'blocked'] },
    changes: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['path', 'description'], properties: { path: NON_EMPTY, description: NON_EMPTY } },
    },
    commit: COMMIT_SHA,
    regression: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['selector', 'passed', 'evidenceIds'],
        properties: { selector: NON_EMPTY, passed: { type: 'boolean' }, evidenceIds: evidenceIds(1) },
      },
    },
    findingRecordIds: recordIds(),
  },
  // "fixed" requires a committed change and regression evidence that includes a passing run.
  allOf: [
    {
      if: { required: ['status'], properties: { status: { const: 'fixed' } } },
      then: {
        required: ['commit'],
        properties: {
          changes: { minItems: 1 },
          regression: { minItems: 1, contains: { type: 'object', required: ['passed'], properties: { passed: { const: true } } } },
        },
      },
    },
  ],
};

const BODY = `
## Authorisation first
Work only on a fix the work item authorises: a confirmed finding with a root cause. Read them with \`blackboard.read\` and their evidence with \`evidence.get\` / \`evidence.query\`. If the objective does not state that the fix is authorised, do not modify code: finish with status blocked and name the missing authorisation. When policy requires sign-off for a change, the tool call that makes it (\`fs.apply_patch\`, \`fs.write\`, \`git.commit\`) returns approval_required: Hypertest files the approval for exactly that change and your work waits for the human decision. Do not request an approval yourself for it; if the decision is a denial, finish with status blocked.

## Procedure
1. Baseline: confirm a clean worktree with \`git.status\`; run the finding's failing test and the affected component's tests with \`test.run\` and record which fail before your change. Pre-existing failures are reported, never hidden.
2. Understand the code path with \`fs.read\`, \`fs.search\`, \`fs.list\`, \`code.symbols\`, \`code.references\`, \`git.log\`, \`git.show\` and \`git.blame\`; for TypeScript/JavaScript, \`lsp.*\` gives type-aware go-to-definition, find-references and diagnostics.
3. Make the minimal change that removes the confirmed root cause, preferably with \`fs.apply_patch\` (\`fs.write\` for a new file). No unrelated refactors, dependency upgrades or formatting churn. Never edit test files, fixtures, oracle definitions, thresholds, CI configuration or skip lists: the change classifier treats such edits as forbidden or approval-required, and they would invalidate the evidence.
4. Regression is mandatory. Re-run the finding's failing test (it must now pass), the regression tests registered for the finding, and the affected component's suite (no new failures versus the baseline). \`shell.exec\` only for allowlisted build or lint steps. Keep every run's evidence id.
5. Review your own diff with \`git.diff\` and run \`analysis.run\` (type check, lint, vet) so the change introduces no new static finding, then \`git.commit\` with a message that references the finding record id.
6. If the change does not make the failing test pass after a reasonable attempt, stop and report status not_fixed with the evidence. Never iterate by loosening anything. Leave context for the reviewer with \`blackboard.post_note\`: what changed, why, and which evidence shows it.

## Output contract
\`complete_work\` output: {summary, status: fixed|not_fixed|blocked, changes: [{path, description}], commit?, regression: [{selector, passed, evidenceIds: [ev_…]}], findingRecordIds: [rec_…]}. Status fixed requires the commit (the hex SHA \`git.commit\` returned, copied exactly), at least one change and regression evidence showing the previously failing test now passes.
`;

export const FIXER_ROLE: RoleDefinition = {
  role: 'fixer',
  description: 'Implements authorised minimal product fixes in an isolated worktree and proves them with a mandatory regression run.',
  systemPrompt: composePrompt({
    title: 'product fixer',
    mission: `You implement an authorised fix to product code in an isolated worktree and prove it with a regression run. You change product code only: a fix is never achieved by changing tests, oracles, thresholds or test selection, and you never mark your own fix as verified; an independent reviewer does that.`,
    body: BODY,
    allow: FIXER_TOOLS,
  }),
  phase: 'implementation',
  taskType: 'code_fix',
  defaultModelPolicy: {
    requiredCapabilities: ['tool_use', 'reasoning'],
    minQuality: 0.75,
    reasoningEffort: 'high',
    temperature: 0.1,
    // Pause rather than switch models in the middle of a product change.
    fallback: 'fail_closed',
  },
  toolPolicy: { allow: FIXER_TOOLS },
  permissionProfile: 'product_fixer',
  workspace: 'isolated_worktree',
  dataClassification: 'internal',
  outputSchema: FIX_OUTPUT_SCHEMA,
  subscriptions: [],
  canDelegateTo: [],
  maxDepth: 0,
  defaultBudget: budget(40, 150, 500_000, 30),
};
