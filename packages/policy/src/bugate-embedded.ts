import { deepFreeze } from '@hypertest/core';

/**
 * Embedded BUGate protocol material used when no BUGate checkout is configured.
 *
 * PREPARED_PROTOCOL_CONTEXT_SCHEMA is an exact copy of BUGate
 * `protocol/v2/schemas/prepared_protocol_context.schema.json` (a test asserts equality with a checkout).
 */

export const EMBEDDED_PROTOCOL_VERSION = 'embedded-2.0.0-dev';

export const PREPARED_PROTOCOL_CONTEXT_SCHEMA: Readonly<Record<string, unknown>> = deepFreeze<Record<string, unknown>>({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://bugate.io/v2/schemas/prepared_protocol_context.schema.json',
  title: 'BUGate PreparedProtocolContext',
  type: 'object',
  additionalProperties: false,
  required: ['apiVersion', 'kind', 'protocol', 'workspace', 'quality_posture', 'active_concerns', 'render'],
  properties: {
    apiVersion: { const: 'bugate.io/v2' },
    kind: { const: 'PreparedProtocolContext' },
    protocol: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'digest'],
      properties: {
        id: { const: 'bugate' },
        version: { type: 'string', minLength: 1 },
        digest: { type: 'string', minLength: 1 },
      },
    },
    workspace: {
      type: 'object',
      additionalProperties: false,
      required: ['task_id'],
      properties: {
        task_id: { type: 'string', minLength: 1 },
        workspace_digest: { type: ['string', 'null'] },
      },
    },
    quality_posture: {
      type: 'object',
      additionalProperties: {
        enum: ['unclaimed', 'draft', 'candidate', 'satisfactory', 'needs_improvement', 'incomplete', 'uncertain'],
      },
    },
    active_concerns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code'],
        properties: {
          code: { type: 'string', minLength: 1 },
          subject: { type: ['string', 'null'] },
          severity: { type: ['string', 'null'] },
          message: { type: ['string', 'null'] },
        },
      },
    },
    render: {
      type: 'object',
      additionalProperties: false,
      required: ['media_type', 'bytes', 'content'],
      properties: {
        media_type: { enum: ['text/markdown', 'text/plain'] },
        bytes: { type: 'integer', minimum: 0 },
        content: { type: 'string' },
      },
    },
  },
});

/**
 * Built-in SUT-neutral methodology principles (BUGate method distilled). Keys are stable topic names;
 * checkout-derived METHOD.md sections are added next to them under `method:<heading>`.
 */
export const EMBEDDED_PRINCIPLES: Readonly<Record<string, string>> = Object.freeze({
  business_understanding: [
    'Understand the business before writing test code.',
    '- Turn goals, stories and acceptance criteria into explicit propositions: what must hold, for whom, under which conditions.',
    '- Every proposition cites its source (requirement, contract, source code, observed behaviour); an uncited proposition is an assumption and is labelled as one.',
    '- Record gaps and open questions instead of filling them with guesses.',
  ].join('\n'),
  oracle_discipline: [
    'Derive oracles, boundaries and states before implementation.',
    '- Map each proposition to a business oracle (the expected outcome and how it is observed), its boundaries (limits, empty/min/max, invalid classes) and the states/transitions it touches (including illegal transitions).',
    '- Oracles are governed: never adapt an assertion, expected value or threshold to observed defective behaviour to make a test pass. Propose an oracle change with evidence instead; the proposer never approves it.',
    '- Keep every case traceable: test → proposition/oracle → source.',
  ].join('\n'),
  evidence_discipline: [
    'Evidence first.',
    '- Read sources, contracts, live responses or probe output before encoding an expectation.',
    '- Never invent identifiers, addresses, secrets, account handles, record ids or test data; bind them to a declared evidence source or fixture.',
    '- Every claim in a report cites the evidence that supports it; numbers without evidence are not claims.',
  ].join('\n'),
  assertion_precision: [
    'Assert precisely.',
    '- Assert the exact expected outcome (status, error code, value) with evidence; avoid "any of these exceptions" and "not the success code" assertions.',
    '- Distinguish a validation-layer rejection (auth, signature, schema, precondition) from a business-layer rejection: a request stopped before the target layer has not exercised the intended behaviour.',
  ].join('\n'),
  outcome_signals: [
    'Keep outcome signals distinct.',
    '- PASS, FAIL, XFAIL, SKIP and a fake-green run are different signals; never collapse them.',
    '- A run where nothing executed, everything was skipped or assertions never ran is not a pass.',
    '- Known read-only defects: xfail (a later fix surfaces as an unexpected pass). Known write-side defects that would pollute an environment: skip with a defect id and an explicit restore condition.',
  ].join('\n'),
  diagnosis_discipline: [
    'Diagnose with hypotheses.',
    '- A root cause that is not evidenced is a hypothesis and is labelled as one; state what evidence would confirm or refute it.',
    '- Distinguish test-infrastructure defects (harness, fixture, environment) from defects in the system under test before asking developers to act.',
    '- Record defects durably with the evidence that reproduces them.',
  ].join('\n'),
  traceability: [
    'Write readable, traceable cases.',
    '- Each case states its intent, preconditions, steps, the exact expected outcome and the oracle it checks.',
    '- Do not reuse an identifier for a different requirement.',
  ].join('\n'),
  adversarial_review: [
    'Review adversarially.',
    '- Reviewers judge the evidence, never the executor narrative: re-derive the verdict from the recorded evidence.',
    '- Actively search for missing boundaries, illegal state transitions, weakened assertions, deleted or skipped tests and unverified claims.',
    '- A reviewer must be independent of the producer (different agent and model provider).',
  ].join('\n'),
  gate_discipline: [
    'Respect the gate.',
    '- Only the deterministic quality gate decides pass/fail; evidence gaps yield inconclusive, never pass.',
    '- P0/P1 criteria are never satisfied by an LLM-only judgement.',
    '- Placeholders, deferred probes and assertion stubs are not pass conditions.',
  ].join('\n'),
  risk_analysis: [
    'Analyse risk explicitly.',
    '- Identify what changed, what depends on it and what failed before; rank risks by likelihood and impact.',
    '- Every high risk needs a planned check with an oracle, or an explicit accepted-risk decision.',
  ].join('\n'),
});

/** Phase → ordered principle topics (most emphasised first). */
export const PHASE_EMPHASIS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  analysis: ['business_understanding', 'risk_analysis', 'evidence_discipline'],
  design: ['oracle_discipline', 'business_understanding', 'traceability', 'assertion_precision'],
  implementation: ['assertion_precision', 'evidence_discipline', 'oracle_discipline', 'traceability'],
  execution: ['evidence_discipline', 'outcome_signals', 'assertion_precision'],
  diagnosis: ['diagnosis_discipline', 'evidence_discipline', 'outcome_signals'],
  review: ['adversarial_review', 'oracle_discipline', 'outcome_signals', 'evidence_discipline'],
  acceptance: ['gate_discipline', 'outcome_signals', 'evidence_discipline'],
});

export const PHASE_FOCUS: Readonly<Record<string, string>> = Object.freeze({
  analysis: 'Understand the business and the change; identify and rank risks. Produce propositions and risks with sources, not test code.',
  design: 'Design oracles, boundaries and state transitions for each proposition; every case traces to an oracle.',
  implementation: 'Implement only accepted designs; encode exact expected outcomes bound to evidence; never weaken an oracle.',
  execution: 'Execute and record evidence faithfully; keep PASS/FAIL/XFAIL/SKIP/fake-green distinct; a failing test is a result, not an error.',
  diagnosis: 'Form hypotheses with confirming/refuting checks; separate test-infrastructure defects from product defects.',
  review: 'Challenge the work adversarially against the recorded evidence; look for weakened assertions, skipped tests and unverified claims.',
  acceptance: 'Let the deterministic gate decide; missing evidence means inconclusive; never claim a pass the evidence does not support.',
});

/** Role-specific reminders for the built-in Hypertest roles. */
export const ROLE_HINTS: Readonly<Record<string, string>> = Object.freeze({
  lead: 'You plan and replan; you never decide the verdict.',
  code_change_analyst: 'Ground every risk in the actual diff and its dependents.',
  architecture_analyst: 'Ground every risk in real component boundaries and data flows.',
  historical_bug_analyst: 'Cite past defects and regressions as evidence, not anecdotes.',
  test_designer: 'Design against oracles and boundaries; a generated test must demonstrate it can fail (known-bad) before it counts.',
  executor: 'Report outcomes exactly as observed; never rerun or edit until green.',
  rca: 'Hypotheses are not conclusions until evidence confirms them.',
  fixer: 'Change product code only when authorized; a fix requires a new build and a fresh experiment.',
  reviewer: 'Judge evidence, not narratives; you must be independent of the producer.',
  metrics_analyst: 'Cite metric evidence with its query and window; insufficient data is inconclusive.',
  environment: 'Environment changes are side effects: use stable operation ids and verify the resulting state.',
  condenser: 'Preserve evidence references and open questions verbatim when summarising.',
});
