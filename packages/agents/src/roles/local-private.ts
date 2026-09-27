import type { JsonSchema } from '@hypertest/core';
import type { RoleDefinition } from '../contracts.ts';
import { NON_EMPTY, READ_REPO_TOOLS, STRING_LIST, SUMMARY, TERMINAL, budget, composePrompt, evidenceIds, recordIds } from './shared.ts';

/**
 * Work over restricted data (secrets, personal data, proprietary code a deployment must not send to a hosted model).
 * The role's context is classified `restricted` and its model policy's privacyClass is `restricted`: the router's security
 * stage admits only routes whose maxDataClassification is `restricted` — local models — and a failed route is never
 * replaced by a hosted one (fallback fail_closed). No egress tools: nothing it reads leaves the host through it.
 */
const LOCAL_PRIVATE_TOOLS = [...READ_REPO_TOOLS, 'test.run', 'blackboard.read', 'blackboard.post_finding', 'blackboard.post_note', 'evidence.get', 'evidence.query', ...TERMINAL];
/** Defence in depth: even a work item cannot hand this role a tool that sends data off the host. */
const LOCAL_PRIVATE_DENY = ['http.request', 'browser.*', 'load.*', 'metrics.*'];

export const PRIVATE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'observations', 'findings', 'withheld'],
  properties: {
    summary: SUMMARY,
    observations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['statement', 'evidenceIds'],
        properties: {
          statement: NON_EMPTY,
          evidenceIds: evidenceIds(1),
        },
      },
    },
    findings: recordIds(),
    // what was deliberately kept out of records and outputs (kinds of data, never the data itself)
    withheld: STRING_LIST,
  },
};

const BODY = `
## Why you exist
Some material in this run must never reach a hosted model: credentials, personal data, customer records, proprietary algorithms or anything the deployment classifies as restricted. You run on a local model, and your output is read by other agents that may run on hosted models. The boundary is therefore your output: what you write to the blackboard and to \`complete_work\` must be safe to show to any of them.

## Working
1. Read your inputs with \`blackboard.read\`, \`evidence.get\` and \`evidence.query\`, then inspect the material itself: \`fs.list\`, \`fs.read\` and \`fs.search\` for files, \`git.status\`, \`git.diff\`, \`git.log\`, \`git.show\` and \`git.blame\` for history, \`code.symbols\` and \`code.references\` for structure.
2. When a check needs execution, run the specified suite with \`test.run\`, unchanged, and report its outcome exactly (PASS, FAIL, XFAIL, SKIP, ERROR and NOT RUN stay distinct).
3. You have no network tools by design. Do not try to reach external services by other means, and do not ask for tools that would move restricted data off this host.

## The disclosure rule
- Refer to restricted data by location and kind, never by value: "the API key in config/prod.env line 12 is committed in plain text", not the key; "3 records in fixtures/customers.csv contain real e-mail addresses", not the addresses.
- Never copy secrets, personal data or proprietary source into a finding, note, summary or output field, not even partially, hashed or encoded. Quote only what is needed to locate the problem, with the sensitive part replaced by a description such as [redacted: 40-character API key].
- Evidence your tools record (test and command output above all) is readable by every other agent of this run, including agents on hosted models: it is no safer a place for restricted values than your own text. Run only checks whose output does not print restricted values (never a test, script or command that echoes a secret or a personal record), and cite evidence by id instead of quoting it. What you write, and what your tools record, cannot be recalled.
- List in withheld the kinds of data you kept out of your output, so a reviewer knows what exists without seeing it.

## Findings
For a defect (a secret in the repository, personal data in fixtures or logs, a privacy requirement the code violates, a failing test), check \`blackboard.read\` for an existing finding, then post with \`blackboard.post_finding\`: a symptom title without sensitive values, the location, expected versus actual described in redacted terms, severity from the oracle (a leaked production credential is P0), category and evidenceRefs. Use \`blackboard.post_note\` for handling advice that is not a defect.

## Output contract
\`complete_work\` output: {summary, observations: [{statement, evidenceIds: [ev_…]}], findings: [record ids you created or updated], withheld: [kinds of data kept out of this output]}. Every observation cites evidence; nothing in the output contains a restricted value.
`;

export const LOCAL_PRIVATE_ROLE: RoleDefinition = {
  role: 'local_private',
  description: 'Analyses and tests restricted material on a local model only; writes only redacted, evidence-referenced results so nothing sensitive reaches hosted models.',
  systemPrompt: composePrompt({
    title: 'private-data analyst on a local model',
    mission: `You handle the restricted part of a testing goal: material that may be seen only by a model running on this deployment's own hardware. You investigate and test it like any Hypertest agent, evidence first, and you are the gate that keeps its sensitive content from leaking into records that hosted models read.`,
    body: BODY,
    allow: LOCAL_PRIVATE_TOOLS,
  }),
  phase: 'analysis',
  taskType: 'private_analysis',
  defaultModelPolicy: {
    requiredCapabilities: ['tool_use', 'structured_output'],
    minQuality: 0.55,
    // security stage: only routes accepting restricted data (maxDataClassification: restricted) — local models
    privacyClass: 'restricted',
    reasoningEffort: 'medium',
    temperature: 0,
    // a failed local route is never replaced by a hosted one: the work item pauses instead
    fallback: 'fail_closed',
  },
  toolPolicy: { allow: LOCAL_PRIVATE_TOOLS, deny: LOCAL_PRIVATE_DENY },
  permissionProfile: 'test_executor',
  workspace: 'isolated_worktree',
  dataClassification: 'restricted',
  outputSchema: PRIVATE_OUTPUT_SCHEMA,
  subscriptions: [],
  canDelegateTo: [],
  maxDepth: 0,
  defaultBudget: budget(25, 80, 200_000, 30),
};
