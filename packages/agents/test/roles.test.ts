import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, isValidSchema, validateJson } from '@hypertest/core';
import { EVENT_TYPES, type ToolEffect } from '@hypertest/domain';
import {
  BUILTIN_ROLES,
  EVIDENCE_PRODUCER_ROLES,
  KNOWN_TOOL_IDS,
  RoleCatalog,
  SPECIALIST_ROLES,
  TERMINAL_TOOLS,
  WORKSPACE_WRITE_TOOL_IDS,
  isKnownToolPattern,
  matchesToolPattern,
  templateVariables,
  toolPermitted,
  validateRoleDefinition,
  type KnownToolId,
  type RoleDefinition,
} from '../src/index.ts';

const EXPECTED_ROLES = [
  'lead', 'code_change_analyst', 'architecture_analyst', 'historical_bug_analyst', 'test_designer', 'executor', 'rca', 'fixer',
  'reviewer', 'metrics_analyst', 'environment', 'condenser', 'vision_gui', 'local_private',
];

/**
 * Maximum effect of each tool as declared by its owner (tools contracts header: effect/risk per built-in;
 * control domain tools: reads vs blackboard/evidence records). test_artifact.validate may run the test.
 */
const TOOL_MAX_EFFECT: Record<KnownToolId, ToolEffect> = {
  'fs.read': 'read', 'fs.list': 'read', 'fs.search': 'read', 'fs.write': 'write_workspace', 'fs.apply_patch': 'write_workspace',
  'git.status': 'read', 'git.diff': 'read', 'git.log': 'read', 'git.show': 'read', 'git.blame': 'read', 'git.commit': 'write_workspace',
  'shell.exec': 'execute', 'test.run': 'execute', 'coverage.collect': 'execute', 'mutation.run': 'execute',
  'code.symbols': 'read', 'code.references': 'read',
  'http.request': 'external', 'metrics.query': 'read', 'metrics.scrape': 'read',
  'load.start': 'external', 'load.observe': 'read', 'load.stop': 'external',
  'env.restart': 'destructive', 'env.inject_fault': 'destructive', 'env.deploy': 'destructive',
  'browser.navigate': 'external', 'browser.click': 'external', 'browser.fill': 'external', 'browser.screenshot': 'external', 'browser.text': 'external',
  'blackboard.read': 'read', 'blackboard.post_finding': 'record', 'blackboard.post_hypothesis': 'record', 'blackboard.report_coverage_gap': 'record',
  'blackboard.post_risk': 'record', 'blackboard.post_review': 'record', 'blackboard.post_note': 'record',
  'blackboard.post_strategy': 'record', 'blackboard.post_decision': 'record',
  'plan.propose_revision': 'record', 'plan.read': 'read', 'work.propose': 'record', 'system_model.record': 'record',
  'oracle.get': 'read', 'oracle.list': 'read', 'oracle.propose_change': 'record', 'experiment.define': 'record', 'experiment.stop': 'record',
  'test_artifact.register': 'record', 'test_artifact.validate': 'execute',
  'evidence.get': 'read', 'evidence.query': 'read', 'evidence.claim': 'record',
  delegate: 'record', 'delegate.status': 'read', 'delegate.collect': 'read', 'delegate.message': 'record', 'delegate.release': 'record',
  request_approval: 'record', complete_work: 'record', fail_work: 'record',
};

/** Allowed effects of the policy package's PERMISSION_PROFILES (the capability layer enforces them). */
const PROFILE_EFFECTS: Record<RoleDefinition['permissionProfile'], ToolEffect[]> = {
  read_only: ['read', 'record'],
  analyst: ['read', 'record'],
  test_author: ['read', 'record', 'write_workspace', 'execute'],
  test_executor: ['read', 'record', 'execute', 'external'],
  environment_operator: ['read', 'record', 'execute', 'external', 'destructive'],
  product_fixer: ['read', 'record', 'write_workspace', 'execute'],
};

function role(name: string): RoleDefinition {
  const r = BUILTIN_ROLES.find((x) => x.role === name);
  assert.ok(r, `role ${name} exists`);
  return r;
}

function permittedTools(r: RoleDefinition): KnownToolId[] {
  return KNOWN_TOOL_IDS.filter((t) => toolPermitted(r.toolPolicy, t));
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Backticked tokens in a prompt that name known tools (exact ids or globs over known tools). */
function mentionedTools(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const token = m[1]!;
    if ((KNOWN_TOOL_IDS as readonly string[]).includes(token) || (token.endsWith('*') && isKnownToolPattern(token))) out.push(token);
  }
  return out;
}

test('BUILTIN_ROLES contains exactly the fourteen built-in roles, in order', () => {
  assert.deepEqual(BUILTIN_ROLES.map((r) => r.role), EXPECTED_ROLES);
});

test('every built-in role passes validateRoleDefinition and the catalog accepts them', () => {
  for (const r of BUILTIN_ROLES) assert.deepEqual(validateRoleDefinition(r, { knownRoles: EXPECTED_ROLES }), [], r.role);
  assert.doesNotThrow(() => new RoleCatalog(BUILTIN_ROLES));
});

test('every output schema compiles with core isValidSchema', () => {
  for (const r of BUILTIN_ROLES) {
    assert.ok(r.outputSchema, `${r.role} declares an output contract`);
    assert.equal(isValidSchema(r.outputSchema), true, r.role);
    for (const s of r.subscriptions) if (s.work.expectedOutput) assert.equal(isValidSchema(s.work.expectedOutput), true, s.ruleId);
  }
});

test('tool allowlists only use known tool ids or namespaced globs, and permit both terminal tools', () => {
  for (const r of BUILTIN_ROLES) {
    for (const p of [...r.toolPolicy.allow, ...(r.toolPolicy.deny ?? [])]) {
      assert.equal(isKnownToolPattern(p), true, `${r.role}: ${p}`);
      assert.ok(KNOWN_TOOL_IDS.some((id) => matchesToolPattern(p, id)), `${r.role}: ${p} names at least one known tool`);
    }
    for (const t of TERMINAL_TOOLS) assert.equal(toolPermitted(r.toolPolicy, t), true, `${r.role} can ${t}`);
  }
});

test('least privilege: no role holds a tool whose effect its permission profile can never permit', () => {
  for (const r of BUILTIN_ROLES) {
    const allowed = PROFILE_EFFECTS[r.permissionProfile];
    for (const t of permittedTools(r)) assert.ok(allowed.includes(TOOL_MAX_EFFECT[t]), `${r.role} (${r.permissionProfile}) must not hold ${t} (${TOOL_MAX_EFFECT[t]})`);
  }
});

test('roles that can write files work in an isolated worktree', () => {
  for (const r of BUILTIN_ROLES) {
    if (permittedTools(r).some((t) => TOOL_MAX_EFFECT[t] === 'write_workspace')) assert.equal(r.workspace, 'isolated_worktree', r.role);
  }
});

test('I8 structurally: only the test designer and the fixer can write; executor, reviewer, rca and analysts cannot', () => {
  assert.deepEqual(KNOWN_TOOL_IDS.filter((t) => TOOL_MAX_EFFECT[t] === 'write_workspace'), [...WORKSPACE_WRITE_TOOL_IDS], 'effect table agrees with the exported list');
  const writers = BUILTIN_ROLES.filter((r) => permittedTools(r).some((t) => TOOL_MAX_EFFECT[t] === 'write_workspace')).map((r) => r.role);
  assert.deepEqual(writers, ['test_designer', 'fixer']);
  for (const name of ['executor', 'reviewer', 'rca']) {
    for (const t of ['fs.write', 'fs.apply_patch', 'git.commit'] as const) assert.equal(toolPermitted(role(name).toolPolicy, t), false, `${name} ${t}`);
  }
});

test('governance tools are narrowly held: plans (lead), oracle proposals and test registration (test designer), reviews (reviewer)', () => {
  const holders = (tool: KnownToolId) => BUILTIN_ROLES.filter((r) => toolPermitted(r.toolPolicy, tool)).map((r) => r.role);
  assert.deepEqual(holders('plan.propose_revision'), ['lead']);
  assert.deepEqual(holders('work.propose'), ['lead']);
  assert.deepEqual(holders('delegate'), ['lead']);
  // the subagent handles (status, collect, follow-up messages, release) go with delegation, to the delegating role only
  for (const t of ['delegate.status', 'delegate.collect', 'delegate.message', 'delegate.release'] as const) assert.deepEqual(holders(t), ['lead'], t);
  assert.deepEqual(holders('oracle.propose_change'), ['test_designer']);
  assert.deepEqual(holders('test_artifact.register'), ['test_designer']);
  assert.deepEqual(holders('blackboard.post_review'), ['reviewer']);
  assert.deepEqual(holders('blackboard.post_hypothesis'), ['rca']);
  assert.deepEqual(holders('env.deploy'), ['environment']);
  assert.deepEqual(holders('system_model.record'), ['lead', 'architecture_analyst']);
});

test('lead: plans and delegates to analysts but never executes tests', () => {
  const lead = role('lead');
  assert.equal(lead.phase, 'analysis');
  assert.equal(lead.taskType, 'planning');
  assert.deepEqual(lead.canDelegateTo, ['code_change_analyst', 'architecture_analyst', 'historical_bug_analyst']);
  assert.equal(lead.maxDepth, 2);
  for (const t of ['test.run', 'shell.exec', 'http.request', 'load.start', 'env.deploy', 'mutation.run', 'coverage.collect'] as const) {
    assert.equal(toolPermitted(lead.toolPolicy, t), false, t);
  }
  assert.deepEqual(lead.defaultModelPolicy.requiredCapabilities, ['tool_use', 'reasoning', 'long_context']);
  assert.equal(lead.defaultModelPolicy.minQuality, 0.75);
  assert.equal(lead.defaultModelPolicy.fallback, 'revalidated');
  for (const r of BUILTIN_ROLES.filter((x) => x.role !== 'lead')) {
    assert.deepEqual(r.canDelegateTo, [], `${r.role} does not delegate`);
    assert.equal(r.maxDepth, 0, r.role);
  }
});

test('reviewer: independent from producers, structured reasoning, evidence tools, no production tools', () => {
  const reviewer = role('reviewer');
  assert.deepEqual(reviewer.defaultModelPolicy.independentFromRoles, ['executor', 'test_designer', 'rca', 'fixer', 'metrics_analyst', 'environment', 'vision_gui', 'local_private']);
  for (const c of ['structured_output', 'reasoning'] as const) assert.ok(reviewer.defaultModelPolicy.requiredCapabilities?.includes(c), c);
  for (const t of ['evidence.get', 'evidence.query', 'blackboard.post_review', 'oracle.get', 'test.run'] as const) assert.equal(toolPermitted(reviewer.toolPolicy, t), true, t);
  for (const t of ['blackboard.post_finding', 'oracle.propose_change', 'test_artifact.validate', 'shell.exec'] as const) assert.equal(toolPermitted(reviewer.toolPolicy, t), false, t);
});

test('H10: the reviewer is independent from EVERY role that produces evidence, findings, test artifacts or fixes', () => {
  // A producing role missing from independentFromRoles lets the reviewer route to that role's provider: the gate then
  // discards the review as dependent (C6) — or, with a gate counting fewer producers, accepts a self-review.
  const producing = ['test.run', 'shell.exec', 'mutation.run', 'coverage.collect', 'http.request', 'metrics.query', 'metrics.scrape', 'load.start', 'env.restart', 'env.deploy', 'env.inject_fault',
    'blackboard.post_finding', 'blackboard.post_hypothesis', 'test_artifact.register', 'fs.write', 'fs.apply_patch', 'git.commit'] as const;
  const reviewer = role('reviewer');
  const independent = new Set(reviewer.defaultModelPolicy.independentFromRoles ?? []);
  assert.deepEqual([...independent].sort(), [...EVIDENCE_PRODUCER_ROLES].sort());
  for (const r of BUILTIN_ROLES) {
    if (r.role === 'reviewer') continue;
    const produces = producing.filter((t) => toolPermitted(r.toolPolicy, t));
    if (produces.length > 0) assert.ok(independent.has(r.role), `${r.role} produces (${produces.join(', ')}) but the reviewer is not independent from it`);
  }
  assert.ok(Object.isFrozen(EVIDENCE_PRODUCER_ROLES));
});

test('model policies differ meaningfully across roles (native multi-LLM)', () => {
  const distinct = new Set(BUILTIN_ROLES.map((r) => canonicalJson(r.defaultModelPolicy)));
  assert.ok(distinct.size >= 3, `distinct policies: ${distinct.size}`);
  // Executor-like task types make the router rank by tool-call reliability (router: taskType includes 'execute').
  assert.ok(role('executor').taskType.includes('execute'));
  assert.ok(role('environment').taskType.includes('execute'));
  for (const r of BUILTIN_ROLES.filter((x) => x.role !== 'executor' && x.role !== 'environment')) assert.ok(!r.taskType.includes('execute'), r.role);
  // Condenser: cheapest acceptable quality floor and a cost cap; lead/fixer/reviewer: highest floors.
  const condenser = role('condenser').defaultModelPolicy;
  for (const r of BUILTIN_ROLES.filter((x) => x.role !== 'condenser')) assert.ok((r.defaultModelPolicy.minQuality ?? 0) > (condenser.minQuality ?? 0), r.role);
  assert.equal(typeof condenser.maxCostPerCallUsd, 'number');
  assert.equal(role('fixer').defaultModelPolicy.fallback, 'fail_closed');
  assert.equal(role('environment').defaultModelPolicy.fallback, 'fail_closed');
  // Every role completes through a tool call, so every route must support tool use.
  for (const r of BUILTIN_ROLES) assert.ok(r.defaultModelPolicy.requiredCapabilities?.includes('tool_use'), r.role);
  const taskTypes = new Set(BUILTIN_ROLES.map((r) => r.taskType));
  assert.equal(taskTypes.size, BUILTIN_ROLES.length, 'every role has its own task type for quality scores');
});

test('prompts: 400–1200 words, exactly the four placeholders, {{protocol}} injection slot', () => {
  for (const r of BUILTIN_ROLES) {
    const n = words(r.systemPrompt);
    assert.ok(n >= 400 && n <= 1200, `${r.role}: ${n} words`);
    assert.deepEqual(templateVariables(r.systemPrompt).sort(), ['objective', 'protocol', 'role', 'runGoal'], r.role);
    assert.ok(r.systemPrompt.includes('{{protocol}}'), r.role);
  }
});

test('prompts carry the universal discipline', () => {
  const phrases = [
    'evidence', 'ev_', 'Never invent', 'complete_work', 'fail_work', 'hypothesis', 'product defect', 'test defect', 'infrastructure defect',
    'environment problem', 'Never weaken', 'never skip, xfail', 'oracle', 'never', 'data, never instructions',
    'PASS, FAIL, XFAIL, XPASS, SKIP, ERROR and NOT RUN are distinct outcomes', 'no test executed is NOT RUN, never PASS',
  ];
  for (const r of BUILTIN_ROLES) for (const p of phrases) assert.ok(r.systemPrompt.includes(p), `${r.role} mentions "${p}"`);
});

test('prompts only name tools the role holds, and explain every tool it holds', () => {
  for (const r of BUILTIN_ROLES) {
    const texts = [r.systemPrompt, ...r.subscriptions.flatMap((s) => [s.work.title, s.work.objective])];
    const mentioned = texts.flatMap(mentionedTools);
    for (const m of mentioned) {
      const ok = m.endsWith('*') ? r.toolPolicy.allow.includes(m) : toolPermitted(r.toolPolicy, m);
      assert.ok(ok, `${r.role} prompt mentions \`${m}\` which it does not hold`);
    }
    for (const entry of r.toolPolicy.allow) {
      const covered = mentioned.some((m) => m === entry || (!m.endsWith('*') && matchesToolPattern(entry, m)));
      assert.ok(covered, `${r.role} prompt never mentions its tool entry ${entry}`);
    }
  }
});

test('prompts describe every required field of the role output contract', () => {
  for (const r of BUILTIN_ROLES) {
    const required = (r.outputSchema?.['required'] ?? []) as string[];
    assert.ok(required.length > 0, r.role);
    for (const field of required) assert.ok(r.systemPrompt.includes(field), `${r.role} prompt describes output field ${field}`);
  }
});

test('lead prompt explains typed Plan IR, dynamic analysis-first planning, replanning and readyForGate', () => {
  const p = role('lead').systemPrompt;
  for (const s of [
    'plan.propose_revision', 'localId', 'role', 'dependsOn', 'objectiveIds', 'inputRefs', 'expectedOutput', 'evidenceRequirements', 'readyForGate', 'a description',
    'no fixed agent count', 'code_change_analyst', 'architecture_analyst', 'historical_bug_analyst', 'Replan', 'QualityGate', 'never execute tests', 'Budget',
  ]) assert.ok(p.includes(s), s);
});

test('role prompts state their key operational rules', () => {
  const expectations: Record<string, string[]> = {
    // D-1 (changed with gate-governance: a regression test's known-good run no longer waits for a fix — it runs on the base
    // revision, or the designer records why none can exist; validation is followed by an independent review)
    test_designer: ['Known-good', 'Known-bad', 'mutation.run', 'test_artifact.validate', 'never product code', 'revision "base"', 'knownGoodUnavailableReason', 'testSelector naming ONLY your test file', 'oracle consistency review'],
    executor: ['exactly as specified', 'No execution evidence, no finding', 'never as a product defect', 'load.stop', 'xpass', 'is not_run, never passed', 'restating every required field'],
    rca: ['Reproduce before theorising', '`confirmed`', '`hypothesis`', '`unknown`', 'blackboard.post_hypothesis', 'restating title, description, severity'],
    fixer: ['request_approval', 'Regression is mandatory', 'Never edit test files'],
    reviewer: ['never the producer\'s narrative', 'needs_more_evidence', 'unknown', 'Never approve on narrative alone', 'Record every verdict', 'subjectRef ({kind, id}'],
    metrics_analyst: ['dataSufficient', 'never a pass', 'metrics.query'],
    environment: ['never issue it again', 'request_approval', 'Never touch production', 'environmentReady is false while any action is pending or outcome_unknown'],
    condenser: ['verbatim', 'Never add facts', 'fail_work'],
    vision_gui: ['DOM first, API second, pixels last', 'Never guess coordinates', 'computer-use tool', 'weaker evidence', 'not_run'],
    local_private: ['never by value', 'Never copy secrets', 'local model', 'withheld', 'no network tools', 'readable by every other agent of this run, including agents on hosted models', 'never a test, script or command that echoes a secret'],
  };
  for (const [name, needles] of Object.entries(expectations)) for (const n of needles) assert.ok(role(name).systemPrompt.includes(n), `${name}: ${n}`);
});

test('subscriptions use EVENT_TYPES values and the specified triggers', () => {
  const known = new Set<string>(Object.values(EVENT_TYPES));
  for (const r of BUILTIN_ROLES) for (const s of r.subscriptions) for (const t of s.eventTypes) assert.ok(known.has(t), `${s.ruleId}: ${t}`);

  const td = role('test_designer').subscriptions;
  assert.deepEqual(td.map((s) => [s.eventTypes, s.filter, s.work.title, s.maxPerRun, s.maxCausalDepth]), [
    [['finding.created'], { minSeverity: 'P2', categories: ['product_defect', 'security', 'performance'] }, 'Design regression test for {{title}}', 20, 4],
    [['coverage.gap_detected'], undefined, 'Close coverage gap: {{title}}', 20, 4],
  ]);
  const rca = role('rca').subscriptions;
  assert.deepEqual(rca.map((s) => [s.eventTypes, s.filter, s.work.title]), [
    [['finding.created'], { minSeverity: 'P2', categories: ['product_defect', 'performance', 'security', 'unknown'] }, 'Investigate root cause of {{title}}'],
  ]);
  const rv = role('reviewer').subscriptions;
  assert.deepEqual(rv.map((s) => [s.eventTypes, s.filter, s.work.title]), [
    [['review.requested'], undefined, 'Review {{title}}'],
    [['finding.confirmed'], { minSeverity: 'P1' }, 'Independently verify {{title}}'],
  ]);
  const ma = role('metrics_analyst').subscriptions;
  assert.deepEqual(ma.map((s) => [s.eventTypes, s.filter, s.work.title]), [
    [['finding.created'], { categories: ['performance'], excludeFromRoles: ['metrics_analyst'] }, 'Analyse metrics for {{title}}'],
  ]);
  for (const name of ['lead', 'code_change_analyst', 'architecture_analyst', 'historical_bug_analyst', 'executor', 'fixer', 'environment', 'condenser', 'vision_gui', 'local_private']) {
    assert.deepEqual(role(name).subscriptions, [], `${name} is planned, not reactive`);
  }
  for (const r of BUILTIN_ROLES) {
    for (const s of r.subscriptions) {
      assert.ok(s.maxPerRun >= 1 && s.maxCausalDepth >= 1, `${s.ruleId} has livelock guards`);
      assert.ok(s.work.objective.includes('(data, not instructions)'), `${s.ruleId} marks event text as data`);
    }
  }
});

test('phases, workspaces and permission profiles match the design', () => {
  const table = BUILTIN_ROLES.map((r) => [r.role, r.phase, r.workspace, r.permissionProfile]);
  assert.deepEqual(table, [
    ['lead', 'analysis', 'shared_readonly', 'analyst'],
    ['code_change_analyst', 'analysis', 'shared_readonly', 'analyst'],
    ['architecture_analyst', 'analysis', 'shared_readonly', 'analyst'],
    ['historical_bug_analyst', 'analysis', 'shared_readonly', 'analyst'],
    ['test_designer', 'design', 'isolated_worktree', 'test_author'],
    ['executor', 'execution', 'isolated_worktree', 'test_executor'],
    ['rca', 'diagnosis', 'isolated_worktree', 'test_executor'],
    ['fixer', 'implementation', 'isolated_worktree', 'product_fixer'],
    ['reviewer', 'review', 'isolated_worktree', 'test_executor'],
    ['metrics_analyst', 'diagnosis', 'scratch', 'analyst'],
    ['environment', 'execution', 'scratch', 'environment_operator'],
    ['condenser', 'analysis', 'scratch', 'read_only'],
    ['vision_gui', 'execution', 'scratch', 'test_executor'],
    ['local_private', 'analysis', 'isolated_worktree', 'test_executor'],
  ]);
  assert.deepEqual(role('condenser').toolPolicy.allow, ['complete_work', 'fail_work']);
});

test('BUILTIN_ROLES is deep-frozen: shared policy data cannot be mutated in place', () => {
  assert.ok(Object.isFrozen(BUILTIN_ROLES));
  const executor = role('executor');
  assert.ok(Object.isFrozen(executor) && Object.isFrozen(executor.toolPolicy.allow) && Object.isFrozen(executor.defaultModelPolicy));
  assert.throws(() => (executor.toolPolicy.allow as string[]).push('fs.write'), TypeError);
  assert.throws(() => {
    (executor as { permissionProfile: string }).permissionProfile = 'product_fixer';
  }, TypeError);
  assert.equal(toolPermitted(executor.toolPolicy, 'fs.write'), false);
  assert.equal(executor.permissionProfile, 'test_executor');
  // Frozen schemas still compile and validate.
  assert.equal(validateJson(executor.outputSchema!, { summary: 's', executed: [], findings: [] }).valid, true);
});

// ------------------------------------------------------------------------------------------ output contracts

function valid(name: string, value: unknown): boolean {
  return validateJson(role(name).outputSchema!, value).valid;
}

test('analyst output contract: risks with a RiskClass level; test ideas', () => {
  const ok = { summary: 's', risks: [{ title: 't', level: 'high', rationale: 'r', components: ['c'], recordId: 'rec_000001', evidenceRefs: ['ev_000001'] }], testIdeas: ['i'] };
  for (const name of ['code_change_analyst', 'architecture_analyst', 'historical_bug_analyst']) {
    assert.equal(valid(name, ok), true, name);
    assert.equal(valid(name, { ...ok, risks: [{ ...ok.risks[0], level: 'severe' }] }), false, `${name} rejects unknown level`);
    assert.equal(valid(name, { summary: 's', risks: [] }), false, `${name} requires testIdeas`);
    assert.equal(valid(name, { ...ok, risks: [{ ...ok.risks[0], recordId: 'risk-1' }] }), false, `${name} rejects invented record id format`);
  }
});

test('lead output contract: satisfied objectives cite evidence; readyForGate forbids open objectives', () => {
  const ok = { summary: 's', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'o1', status: 'open', evidenceRefs: [] }] };
  assert.equal(valid('lead', ok), true);
  assert.equal(valid('lead', { ...ok, objectives: [{ objectiveId: 'o1', status: 'satisfied', evidenceRefs: [] }] }), false);
  assert.equal(valid('lead', { ...ok, objectives: [{ objectiveId: 'o1', status: 'satisfied', evidenceRefs: ['ev_1'] }] }), true);
  assert.equal(valid('lead', { ...ok, readyForGate: true }), false, 'ready with an open objective');
  assert.equal(valid('lead', { ...ok, readyForGate: true, objectives: [] }), false, 'ready over an empty objective list is vacuous');
  assert.equal(valid('lead', { ...ok, readyForGate: false, objectives: [] }), true, 'not ready: an empty list is allowed');
  assert.equal(valid('lead', { ...ok, objectives: [{ objectiveId: 'obj 1!', status: 'open', evidenceRefs: [] }] }), false, 'domain objectiveId grammar');
  assert.equal(
    valid('lead', { ...ok, readyForGate: true, objectives: [{ objectiveId: 'o1', status: 'satisfied', evidenceRefs: ['ev_1'] }, { objectiveId: 'o2', status: 'dropped', evidenceRefs: [] }] }),
    true,
  );
});

test('test designer output contract: validated artifacts need known-good and known-bad evidence', () => {
  const art = { artifactId: 'ta_1', path: 'test/a.test.ts', covers: ['obj-1'] };
  assert.equal(valid('test_designer', { summary: 's', testArtifacts: [art] }), true);
  assert.equal(valid('test_designer', { summary: 's', testArtifacts: [{ ...art, covers: [] }] }), false, 'covers something');
  assert.equal(valid('test_designer', { summary: 's', testArtifacts: [{ ...art, validated: true, evidenceRefs: ['ev_1'] }] }), false);
  assert.equal(valid('test_designer', { summary: 's', testArtifacts: [{ ...art, validated: true }] }), false);
  assert.equal(valid('test_designer', { summary: 's', testArtifacts: [{ ...art, validated: true, evidenceRefs: ['ev_1', 'ev_2'] }] }), true);
  // Fault: one run cited twice is not a known-good AND a known-bad run.
  assert.equal(valid('test_designer', { summary: 's', testArtifacts: [{ ...art, validated: true, evidenceRefs: ['ev_1', 'ev_1'] }] }), false, 'duplicated evidence id');
});

test('executor output contract: every execution cites evidence and passed agrees with outcome', () => {
  const run = { selector: 'test/a.test.ts', passed: false, outcome: 'failed', evidenceIds: ['ev_000001'] };
  assert.equal(valid('executor', { summary: 's', executed: [run], findings: ['rec_000001'] }), true);
  assert.equal(valid('executor', { summary: 's', executed: [{ ...run, evidenceIds: [] }], findings: [] }), false, 'no evidence');
  assert.equal(valid('executor', { summary: 's', executed: [{ ...run, evidenceIds: ['result-1'] }], findings: [] }), false, 'invented id');
  assert.equal(valid('executor', { summary: 's', executed: [{ ...run, passed: true }], findings: [] }), false, 'failed but passed');
  for (const outcome of ['skipped', 'xfailed', 'xpassed', 'error', 'not_run']) {
    assert.equal(valid('executor', { summary: 's', executed: [{ ...run, outcome, passed: true }], findings: [] }), false, `${outcome} is not a pass`);
  }
  assert.equal(valid('executor', { summary: 's', executed: [{ ...run, outcome: 'passed', passed: false }], findings: [] }), false);
  // An unexpected pass of an xfail-marked test is reportable as its own outcome (never folded into passed).
  assert.equal(valid('executor', { summary: 's', executed: [{ ...run, outcome: 'xpassed', passed: false }], findings: [] }), true);
  assert.equal(valid('executor', { summary: 's', executed: [{ ...run, evidenceIds: ['ev_1', 'ev_1'] }], findings: [] }), false, 'duplicated evidence id');
  assert.equal(valid('executor', { summary: 's', executed: [run], findings: ['rec_1', 'rec_1'] }), false, 'duplicated record id');
});

test('rca output contract: a confirmed root cause must cite evidence; hypotheses need not', () => {
  const base = { summary: 's', hypotheses: ['rec_1'] };
  assert.equal(valid('rca', { ...base, rootCause: { status: 'confirmed', statement: 'x' } }), false);
  assert.equal(valid('rca', { ...base, rootCause: { status: 'confirmed', statement: 'x', evidenceRefs: [] } }), false);
  assert.equal(valid('rca', { ...base, rootCause: { status: 'confirmed', statement: 'x', evidenceRefs: ['ev_9'] } }), true);
  assert.equal(valid('rca', { ...base, rootCause: { status: 'hypothesis', statement: 'x' } }), true);
  assert.equal(valid('rca', { ...base, rootCause: { status: 'probable', statement: 'x' } }), false);
});

test('rca output contract: a stated root cause is traceable to at least one posted hypothesis record', () => {
  const none = { summary: 's', hypotheses: [] };
  assert.equal(valid('rca', { ...none, rootCause: { status: 'hypothesis', statement: 'x' } }), false, 'hypothesis without a record');
  assert.equal(valid('rca', { ...none, rootCause: { status: 'confirmed', statement: 'x', evidenceRefs: ['ev_9'] } }), false, 'confirmed without a record');
  assert.equal(valid('rca', { ...none, rootCause: { status: 'unknown', statement: 'no discriminating evidence' } }), true, 'unknown needs no record');
  assert.equal(valid('rca', { summary: 's', hypotheses: ['rec_1', 'rec_1'], rootCause: { status: 'unknown', statement: 'x' } }), false, 'duplicated record id');
});

test('fixer output contract: "fixed" requires a commit, a change and a passing regression run with evidence', () => {
  const base = { summary: 's', changes: [{ path: 'src/a.ts', description: 'd' }], findingRecordIds: ['rec_1'] };
  const passing = { selector: 't', passed: true, evidenceIds: ['ev_1'] };
  const sha = '3f2a9c1';
  assert.equal(valid('fixer', { ...base, status: 'fixed', commit: sha, regression: [passing] }), true);
  assert.equal(valid('fixer', { ...base, status: 'fixed', commit: 'a'.repeat(40), regression: [passing] }), true, 'full SHA-1');
  assert.equal(valid('fixer', { ...base, status: 'fixed', regression: [passing] }), false, 'no commit');
  for (const commit of ['HEAD', 'abc', 'committed', '3F2A9C1', 'main']) {
    assert.equal(valid('fixer', { ...base, status: 'fixed', commit, regression: [passing] }), false, `commit ${commit} is not a SHA`);
  }
  assert.equal(valid('fixer', { ...base, status: 'fixed', commit: sha, regression: [] }), false, 'no regression');
  assert.equal(valid('fixer', { ...base, status: 'fixed', commit: sha, regression: [{ ...passing, passed: false }] }), false, 'regression still failing');
  assert.equal(valid('fixer', { ...base, status: 'fixed', commit: sha, changes: [], regression: [passing] }), false, 'no change');
  assert.equal(valid('fixer', { summary: 's', status: 'not_fixed', changes: [], regression: [], findingRecordIds: [] }), true);
});

test('reviewer output contract: every verdict is posted; approve/reject also require inspected evidence', () => {
  assert.equal(valid('reviewer', { summary: 's', verdict: 'approve', reviews: ['rec_1'], checkedEvidenceIds: [] }), false);
  assert.equal(valid('reviewer', { summary: 's', verdict: 'reject', reviews: [], checkedEvidenceIds: ['ev_1'] }), false);
  assert.equal(valid('reviewer', { summary: 's', verdict: 'approve', reviews: ['rec_1'], checkedEvidenceIds: ['ev_1'] }), true);
  assert.equal(valid('reviewer', { summary: 's', verdict: 'unknown', reviews: ['rec_1'], checkedEvidenceIds: [] }), true, 'unknown needs no evidence');
  assert.equal(valid('reviewer', { summary: 's', verdict: 'needs_more_evidence', reviews: ['rec_1'], checkedEvidenceIds: [] }), true);
  // Fault: a verdict that was never posted is invisible to the lead and the QualityGate.
  for (const verdict of ['unknown', 'needs_more_evidence']) {
    assert.equal(valid('reviewer', { summary: 's', verdict, reviews: [], checkedEvidenceIds: [] }), false, `${verdict} without a posted review`);
  }
  assert.equal(valid('reviewer', { summary: 's', verdict: 'approve', reviews: ['rec_1'], checkedEvidenceIds: ['ev_1', 'ev_1'] }), false, 'duplicated evidence id');
  assert.equal(valid('reviewer', { summary: 's', verdict: 'pass', reviews: ['rec_1'], checkedEvidenceIds: [] }), false);
});

test('metrics, environment and condenser output contracts', () => {
  const obs = { metric: 'http_p95', statement: 'p95 = 412 ms', evidenceIds: ['ev_1'] };
  assert.equal(valid('metrics_analyst', { summary: 's', dataSufficient: true, observations: [obs], findings: [] }), true);
  assert.equal(valid('metrics_analyst', { summary: 's', dataSufficient: true, observations: [{ ...obs, evidenceIds: [] }], findings: [] }), false);
  assert.equal(valid('metrics_analyst', { summary: 's', observations: [obs], findings: [] }), false, 'dataSufficient required');

  const act = { action: 'deploy', target: 'svc', status: 'verified', evidenceIds: ['ev_1'] };
  assert.equal(valid('environment', { summary: 's', environmentReady: true, actions: [act] }), true);
  assert.equal(valid('environment', { summary: 's', environmentReady: true, actions: [{ ...act, evidenceIds: [] }] }), false, 'verified needs evidence');
  assert.equal(valid('environment', { summary: 's', environmentReady: false, actions: [{ ...act, status: 'outcome_unknown', evidenceIds: [] }] }), true);
  // Fault: readiness claimed while an operation's outcome is unknown or still pending (fake-green environment).
  for (const status of ['outcome_unknown', 'pending']) {
    assert.equal(valid('environment', { summary: 's', environmentReady: true, actions: [act, { ...act, action: 'restart', status, evidenceIds: [] }] }), false, `ready with ${status}`);
  }
  assert.equal(
    valid('environment', { summary: 's', environmentReady: true, actions: [{ ...act, action: 'restart', status: 'failed', evidenceIds: ['ev_2'] }, { ...act, action: 'restart', evidenceIds: ['ev_3'] }] }),
    true,
    'a failed attempt followed by a verified one may still end ready',
  );

  const cond = { summary: 's', evidenceRefs: ['ev_1'], recordRefs: ['rec_1'], decisions: [], openQuestions: [] };
  assert.equal(valid('condenser', cond), true);
  assert.equal(valid('condenser', { ...cond, evidenceRefs: ['1'] }), false, 'evidence ids are kept verbatim');
  const { decisions: _d, ...missing } = cond;
  assert.equal(valid('condenser', missing), false);
});

test('vision_gui: browser + API + screenshot evidence, a vision route, no workspace, shell or environment control', () => {
  const gui = role('vision_gui');
  assert.deepEqual(gui.defaultModelPolicy.requiredCapabilities, ['tool_use', 'structured_output', 'vision']);
  assert.equal(gui.taskType.includes('execute'), false, 'GUI routes are ranked by quality, not tool reliability alone');
  for (const t of ['browser.navigate', 'browser.click', 'browser.fill', 'browser.text', 'browser.screenshot', 'http.request', 'evidence.get', 'blackboard.post_finding'] as const) {
    assert.equal(toolPermitted(gui.toolPolicy, t), true, t);
  }
  for (const t of ['fs.write', 'fs.read', 'shell.exec', 'test.run', 'env.deploy', 'env.restart', 'load.start', 'oracle.propose_change', 'git.commit'] as const) {
    assert.equal(toolPermitted(gui.toolPolicy, t), false, t);
  }
  assert.ok(gui.systemPrompt.indexOf('`browser.text`') < gui.systemPrompt.indexOf('`http.request`'), 'DOM is described before the API');
  assert.ok(gui.systemPrompt.indexOf('`http.request`') < gui.systemPrompt.indexOf('Computer use is a last resort'), 'computer use comes last');
});

test('vision_gui output contract: every check cites evidence with a known method and a distinct outcome', () => {
  const check = { check: 'checkout button submits the order', method: 'dom', outcome: 'passed', expected: 'Order #', actual: 'Order #1042 placed', evidenceIds: ['ev_1'] };
  assert.equal(valid('vision_gui', { summary: 's', checks: [check], findings: [], screenshots: ['ev_2'] }), true);
  assert.equal(valid('vision_gui', { summary: 's', checks: [{ ...check, evidenceIds: [] }], findings: [], screenshots: [] }), false, 'no evidence, no check');
  assert.equal(valid('vision_gui', { summary: 's', checks: [{ ...check, method: 'gut_feeling' }], findings: [], screenshots: [] }), false);
  assert.equal(valid('vision_gui', { summary: 's', checks: [{ ...check, outcome: 'looks_ok' }], findings: [], screenshots: [] }), false);
  assert.equal(valid('vision_gui', { summary: 's', checks: [{ ...check, outcome: 'not_run', method: 'visual' }], findings: [], screenshots: ['ev_2'] }), true, 'NOT RUN is reportable');
  assert.equal(valid('vision_gui', { summary: 's', checks: [check], findings: [] }), false, 'screenshots are listed (possibly empty)');
  assert.equal(valid('vision_gui', { summary: 's', checks: [check], findings: [], screenshots: ['shot.png'] }), false, 'screenshot evidence ids, not file names');
});

test('local_private: restricted data routed only to restricted (local) routes, fail-closed fallback, no egress tool even by override', () => {
  const lp = role('local_private');
  assert.equal(lp.dataClassification, 'restricted');
  assert.equal(lp.defaultModelPolicy.privacyClass, 'restricted');
  assert.equal(lp.defaultModelPolicy.fallback, 'fail_closed');
  for (const t of ['http.request', 'browser.navigate', 'browser.screenshot', 'load.start', 'metrics.query', 'metrics.scrape', 'env.deploy', 'shell.exec', 'fs.write', 'delegate'] as const) {
    assert.equal(toolPermitted(lp.toolPolicy, t), false, t);
  }
  for (const t of ['fs.read', 'git.diff', 'code.symbols', 'test.run', 'blackboard.post_finding', 'evidence.query'] as const) assert.equal(toolPermitted(lp.toolPolicy, t), true, t);
  // an operator widening the allowlist still cannot hand it an egress tool: the role's deny list wins
  const widened = new RoleCatalog(BUILTIN_ROLES, { roles: { local_private: { toolPolicy: { allow: [...lp.toolPolicy.allow, 'http.request', 'browser.*'] } } } }).require('local_private');
  for (const t of ['http.request', 'browser.navigate'] as const) assert.equal(toolPermitted(widened.toolPolicy, t), false, `${t} stays denied`);
  // every other role's context may be shown to hosted models: only local_private carries restricted data
  for (const r of BUILTIN_ROLES.filter((x) => x.role !== 'local_private')) {
    assert.notEqual(r.dataClassification, 'restricted', r.role);
    assert.notEqual(r.defaultModelPolicy.privacyClass, 'restricted', r.role);
  }
});

test('local_private output contract: observations cite evidence; the withheld kinds are listed', () => {
  const ok = { summary: 's', observations: [{ statement: 'an API key is committed in config/prod.env line 12', evidenceIds: ['ev_1'] }], findings: ['rec_1'], withheld: ['API key value'] };
  assert.equal(valid('local_private', ok), true);
  assert.equal(valid('local_private', { ...ok, observations: [{ statement: 'x', evidenceIds: [] }] }), false);
  const { withheld: _w, ...noWithheld } = ok;
  assert.equal(valid('local_private', noWithheld), false, 'withheld is required (possibly empty)');
  assert.equal(valid('local_private', { ...ok, withheld: [] }), true);
});

test('SPECIALIST_ROLES names exactly the roles only a special route can serve', () => {
  assert.deepEqual([...SPECIALIST_ROLES], ['vision_gui', 'local_private']);
  assert.ok(Object.isFrozen(SPECIALIST_ROLES));
  assert.ok(role('vision_gui').defaultModelPolicy.requiredCapabilities?.includes('vision'));
  assert.equal(role('local_private').defaultModelPolicy.privacyClass, 'restricted');
});
