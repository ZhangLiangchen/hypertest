import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixedClock } from '@hypertest/core';
import {
  BuiltinPolicyEngine, CompositePolicyEngine, DEFAULT_POLICY_RULES, createRootCapability, intersectConstraints, signCapability,
  type ActionPermit, type ActionRequest, type PolicyEngine, type PolicyRule,
} from '../src/index.ts';
import { FAR_FUTURE, NOW, SECRET, cap, request } from './helpers.ts';

let n = 0;
const options = () => ({ newId: () => `pdec_${++n}`, clock: new FixedClock(NOW) });
const engine = () => new BuiltinPolicyEngine(DEFAULT_POLICY_RULES, 'builtin@1', options());
const decide = (o: Partial<ActionRequest>) => engine().evaluate(request(o));

test('default rules: read and record are allowed everywhere', async () => {
  const p = await decide({ tool: 'fs.read', effect: 'read' });
  assert.equal(p.decision, 'allow');
  assert.deepEqual(p.reasons, ['rule:allow-read-record: reads and blackboard/evidence records are allowed everywhere']);
  assert.equal(p.policyRevision, 'builtin@1');
  assert.match(p.decisionId, /^pdec_\d+$/);
  assert.equal((await decide({ tool: 'blackboard.post', effect: 'record', resources: [] })).decision, 'allow');
  assert.equal((await decide({ tool: 'metrics.query', effect: 'read', environmentClass: 'production', resources: ['env/prod'] })).decision, 'allow');
});

test('default rules: write_workspace/execute only inside workspace/**', async () => {
  assert.equal((await decide({ tool: 'fs.write', effect: 'write_workspace', riskClass: 'medium', resources: ['workspace/wt_1/src/a.ts'] })).decision, 'allow');
  assert.equal((await decide({ tool: 'test.run', effect: 'execute', riskClass: 'medium', resources: ['workspace/wt_1'] })).decision, 'allow');
  const outside = await decide({ tool: 'fs.write', effect: 'write_workspace', riskClass: 'medium', resources: ['workspace/wt_1/a.ts', 'etc/passwd'] });
  assert.equal(outside.decision, 'deny');
  assert.match(outside.reasons[0]!, /^no_matching_rule: fs\.write/);
  const none = await decide({ tool: 'shell.exec', effect: 'execute', riskClass: 'medium', resources: [] });
  assert.equal(none.decision, 'deny', 'an allow rule with resource patterns never matches an empty resource list');
});

test('default rules: external allowed on local/sandbox, approval on staging, denied elsewhere', async () => {
  const ext = (environmentClass: string) => decide({ tool: 'load.start', effect: 'external', riskClass: 'high', resources: [`env/${environmentClass}`], environmentClass });
  assert.equal((await ext('local')).decision, 'allow');
  assert.equal((await ext('sandbox')).decision, 'allow');
  const staging = await ext('staging');
  assert.equal(staging.decision, 'approval_required');
  assert.deepEqual(staging.reasons, ['rule:approve-external-staging: external effects on staging require approval']);
  assert.equal((await ext('production')).decision, 'deny');
  assert.equal((await ext('qa-lab')).decision, 'deny');
  assert.equal((await decide({ tool: 'http.request', effect: 'external', riskClass: 'medium', resources: [] })).decision, 'deny', 'external without an environment class is not matched ⇒ fail closed');
});

test('default rules: destructive', async () => {
  const d = (environmentClass: string, riskClass: 'medium' | 'high' | 'critical') => decide({ tool: 'env.restart', effect: 'destructive', riskClass, resources: [`env/${environmentClass}`], environmentClass });
  assert.equal((await d('local', 'high')).decision, 'allow');
  assert.equal((await d('sandbox', 'medium')).decision, 'allow');
  assert.equal((await d('sandbox', 'high')).decision, 'approval_required');
  assert.equal((await d('staging', 'medium')).decision, 'approval_required');
  assert.equal((await d('staging', 'high')).decision, 'approval_required');
  assert.equal((await d('local', 'critical')).decision, 'approval_required');
  const prod = await d('production', 'medium');
  assert.equal(prod.decision, 'deny');
  assert.deepEqual(prod.reasons.map((r) => r.split(':')[1]), ['deny-destructive-production', 'deny-mutation-production']);
});

test('default rules: any effect beyond read on production is denied', async () => {
  for (const effect of ['record', 'write_workspace', 'execute', 'external'] as const) {
    const p = await decide({ tool: 'x.y', effect, riskClass: 'low', environmentClass: 'production', resources: ['workspace/wt_1/a'] });
    assert.equal(p.decision, 'deny', effect);
    assert.ok(p.reasons.some((r) => r.startsWith('rule:deny-mutation-production')), effect);
  }
});

test('default rules: governance tools are denied even with an all-powerful capability (defense in depth)', async () => {
  for (const tool of ['oracle.approve', 'oracle.approve_change', 'approval.decide', 'oracle.decide_proposal']) {
    const p = await decide({ tool, effect: 'record', resources: [] });
    assert.equal(p.decision, 'deny', tool);
    assert.deepEqual(p.reasons, ['rule:deny-governance-tools: oracle approval and approval decisions are never agent tools (defense in depth)']);
  }
});

test('I1: the capability is checked before any rule (deny when the capability forbids the action)', async () => {
  const narrow = cap({ tools: ['fs.read'], allowedEffects: ['read'] });
  const p = await decide({ tool: 'blackboard.post', effect: 'record', resources: [], capability: narrow });
  assert.equal(p.decision, 'deny');
  assert.deepEqual(p.reasons, ['capability_denied: tool_not_permitted: blackboard.post']);
  const expired = await decide({ capability: cap({ expiresAt: '2025-01-01T00:00:00.000Z' }) });
  assert.equal(expired.decision, 'deny');
  assert.match(expired.reasons[0]!, /^capability_denied: capability_expired/);
  const otherRun = await decide({ capability: cap({ runId: 'run_other' }) });
  assert.deepEqual(otherRun.reasons, ['capability_run_mismatch: run_other != run_1']);
});

test('I1: with a capability secret, unsigned or tampered capabilities are denied', async () => {
  const e = new BuiltinPolicyEngine(DEFAULT_POLICY_RULES, 'builtin@1', { ...options(), capabilitySecret: SECRET });
  const good = createRootCapability({ runId: 'run_1', subjectAgentId: 'agent_1', workItemId: 'wi_1', profile: 'analyst', expiresAt: FAR_FUTURE }, SECRET);
  assert.equal((await e.evaluate(request({ capability: good }))).decision, 'allow');
  const tampered = { ...good, allowedEffects: [...good.allowedEffects, 'destructive' as const] };
  assert.deepEqual((await e.evaluate(request({ capability: tampered }))).reasons, ['capability_signature_invalid']);
  const unsigned = { ...good };
  delete unsigned.signature;
  assert.equal((await e.evaluate(request({ capability: unsigned }))).decision, 'deny');
  const foreignKey = signCapability(good, 'someone-else');
  assert.equal((await e.evaluate(request({ capability: foreignKey }))).decision, 'deny');
});

test('fail closed: an empty rule set denies everything', async () => {
  const e = new BuiltinPolicyEngine([], 'empty@1', options());
  const p = await e.evaluate(request());
  assert.equal(p.decision, 'deny');
  assert.match(p.reasons[0]!, /^no_matching_rule/);
});

test('most restrictive wins regardless of rule order; constraints of allow/approval rules are intersected', async () => {
  const rules: PolicyRule[] = [
    { id: 'allow-all', description: 'allow', match: {}, decision: 'allow', constraints: { allowedHosts: ['a.test', 'b.test'], maxDurationMs: 60_000, allowedPaths: ['workspace/**'] } },
    { id: 'allow-http', description: 'allow http', match: { tools: ['http.*'] }, decision: 'allow', constraints: { allowedHosts: ['b.test', 'c.test'], maxDurationMs: 5_000, allowedPaths: ['workspace/wt_1/**'] } },
    { id: 'approve-exec', description: 'approve', match: { effects: ['execute'] }, decision: 'approval_required' },
    { id: 'deny-role', description: 'deny intruder', match: { roles: ['intruder'] }, decision: 'deny', constraints: { allowedHosts: [] } },
  ];
  const e = new BuiltinPolicyEngine(rules, 'r@1', options());
  const http = await e.evaluate(request({ tool: 'http.request' }));
  assert.equal(http.decision, 'allow');
  assert.deepEqual(http.constraints, { allowedHosts: ['b.test'], maxDurationMs: 5_000, allowedPaths: ['workspace/wt_1/**'] });
  assert.deepEqual(http.reasons, ['rule:allow-all: allow', 'rule:allow-http: allow http']);
  const exec = await e.evaluate(request({ tool: 'test.run', effect: 'execute' }));
  assert.equal(exec.decision, 'approval_required');
  assert.deepEqual(exec.reasons, ['rule:approve-exec: approve']);
  assert.deepEqual(exec.constraints, { allowedHosts: ['a.test', 'b.test'], maxDurationMs: 60_000, allowedPaths: ['workspace/**'] });
  const reversed = new BuiltinPolicyEngine([...rules].reverse(), 'r@1', options());
  assert.equal((await reversed.evaluate(request({ tool: 'test.run', effect: 'execute' }))).decision, 'approval_required');
  const intruder = await reversed.evaluate(request({ role: 'intruder', tool: 'http.request' }));
  assert.equal(intruder.decision, 'deny');
  assert.equal(intruder.constraints, undefined);
  // a role rule never matches a request without a role
  const { role: _r, ...noRole } = request({ tool: 'http.request' });
  assert.equal((await reversed.evaluate(noRole as ActionRequest)).decision, 'allow');
});

test('resource semantics: deny rules match when any resource matches', async () => {
  const rules: PolicyRule[] = [
    { id: 'allow-all', description: 'allow', match: {}, decision: 'allow' },
    { id: 'deny-secrets', description: 'no secrets', match: { resources: ['**/secrets/**'] }, decision: 'deny' },
  ];
  const e = new BuiltinPolicyEngine(rules, 'r@1', options());
  assert.equal((await e.evaluate(request({ resources: ['workspace/wt_1/a.ts'] }))).decision, 'allow');
  assert.equal((await e.evaluate(request({ resources: ['workspace/wt_1/a.ts', 'workspace/wt_1/secrets/key'] }))).decision, 'deny');
});

test('minRisk matches at or above the given risk', async () => {
  const e = new BuiltinPolicyEngine([{ id: 'a', description: 'a', match: {}, decision: 'allow' }, { id: 'b', description: 'b', match: { minRisk: 'high' }, decision: 'approval_required' }], 'r@1', options());
  assert.equal((await e.evaluate(request({ riskClass: 'medium' }))).decision, 'allow');
  assert.equal((await e.evaluate(request({ riskClass: 'high' }))).decision, 'approval_required');
  assert.equal((await e.evaluate(request({ riskClass: 'critical' }))).decision, 'approval_required');
});

test('invalid rule sets are rejected at construction', () => {
  assert.throws(() => new BuiltinPolicyEngine([{ id: 'x', description: 'x', match: { effects: ['teleport' as never] }, decision: 'allow' }], 'r', options()), { code: 'invalid_argument' });
  assert.throws(() => new BuiltinPolicyEngine([{ id: 'x', description: 'x', match: {}, decision: 'maybe' as never }], 'r', options()), { code: 'invalid_argument' });
  assert.throws(() => new BuiltinPolicyEngine([{ id: 'x', description: 'x', match: {}, decision: 'allow' }, { id: 'x', description: 'y', match: {}, decision: 'deny' }], 'r', options()), { code: 'invalid_argument' });
  assert.throws(() => new BuiltinPolicyEngine([], '', options()), { code: 'invalid_argument' });
});

test('intersectConstraints: undefined is unconstrained; lists intersect; durations take the minimum', () => {
  assert.equal(intersectConstraints(undefined, undefined), undefined);
  assert.deepEqual(intersectConstraints({ allowedCommands: ['npm', 'node'] }, undefined), { allowedCommands: ['npm', 'node'] });
  assert.deepEqual(intersectConstraints({ allowedCommands: ['npm', 'node'], credentialScope: ['x'] }, { allowedCommands: ['node', 'go'], maxDurationMs: 10 }), { allowedCommands: ['node'], credentialScope: ['x'], maxDurationMs: 10 });
});

class StubEngine implements PolicyEngine {
  readonly revision: string;
  readonly #permit: Omit<ActionPermit, 'decisionId' | 'policyRevision'> | Error;
  constructor(revision: string, permit: Omit<ActionPermit, 'decisionId' | 'policyRevision'> | Error) {
    this.revision = revision;
    this.#permit = permit;
  }
  async evaluate(): Promise<ActionPermit> {
    if (this.#permit instanceof Error) throw this.#permit;
    return { ...this.#permit, decisionId: 'x', policyRevision: this.revision };
  }
}

test('composite: deny wins, approval beats allow, reasons concatenated, revisions joined, constraints intersected', async () => {
  const allowA = new StubEngine('a@1', { decision: 'allow', reasons: ['a ok'], constraints: { allowedHosts: ['x', 'y'] } });
  const allowB = new StubEngine('b@2', { decision: 'allow', reasons: ['b ok'], constraints: { allowedHosts: ['y', 'z'], maxDurationMs: 7 } });
  const approve = new StubEngine('c@3', { decision: 'approval_required', reasons: ['c wants a human'] });
  const deny = new StubEngine('d@4', { decision: 'deny', reasons: ['d says no'] });
  const ids = { newId: () => 'pdec_composite' };
  const both = await new CompositePolicyEngine([allowA, allowB], ids).evaluate(request());
  assert.deepEqual(both, { decision: 'allow', decisionId: 'pdec_composite', reasons: ['[a@1] a ok', '[b@2] b ok'], policyRevision: 'a@1+b@2', constraints: { allowedHosts: ['y'], maxDurationMs: 7 } });
  const withApproval = await new CompositePolicyEngine([allowA, approve], ids).evaluate(request());
  assert.equal(withApproval.decision, 'approval_required');
  assert.deepEqual(withApproval.reasons, ['[a@1] a ok', '[c@3] c wants a human']);
  const withDeny = await new CompositePolicyEngine([allowA, approve, deny], ids).evaluate(request());
  assert.equal(withDeny.decision, 'deny');
  assert.equal(withDeny.policyRevision, 'a@1+c@3+d@4');
  assert.equal(withDeny.constraints, undefined);
});

test('composite fail closed: a throwing engine denies; no engines denies', async () => {
  const allow = new StubEngine('a@1', { decision: 'allow', reasons: ['ok'] });
  const broken = new StubEngine('opa@1', new Error('boom'));
  const p = await new CompositePolicyEngine([allow, broken]).evaluate(request());
  assert.equal(p.decision, 'deny');
  assert.deepEqual(p.reasons, ['[a@1] ok', '[opa@1] engine_error: boom']);
  const empty = await new CompositePolicyEngine([]).evaluate(request());
  assert.equal(empty.decision, 'deny');
  assert.deepEqual(empty.reasons, ['no_policy_engines']);
});

test('composite over builtin: the builtin capability denial dominates', async () => {
  const allowAll = new StubEngine('permissive@1', { decision: 'allow', reasons: ['anything goes'] });
  const p = await new CompositePolicyEngine([allowAll, engine()]).evaluate(request({ tool: 'env.restart', effect: 'destructive', environmentClass: 'production', resources: ['env/prod'] }));
  assert.equal(p.decision, 'deny');
});

test('governance defaults are immutable', () => {
  assert.throws(() => (DEFAULT_POLICY_RULES as PolicyRule[]).push({ id: 'allow-everything', description: 'x', match: {}, decision: 'allow' }), TypeError);
  assert.throws(() => {
    (DEFAULT_POLICY_RULES[0]!.match.effects as string[]).push('destructive');
  }, TypeError);
});

// ----------------------------------------------------------------------------- adversarial review regressions

test('I1/I2: a capability only authorizes its own subject agent and work item (no confused deputy)', async () => {
  const foreignAgent = await decide({ agentId: 'agent_2' });
  assert.equal(foreignAgent.decision, 'deny');
  assert.deepEqual(foreignAgent.reasons, ['capability_subject_mismatch: agent_1 != agent_2']);
  const foreignWork = await decide({ workItemId: 'wi_2' });
  assert.equal(foreignWork.decision, 'deny');
  assert.deepEqual(foreignWork.reasons, ['capability_work_item_mismatch: wi_1 != wi_2']);
  // requests that do not name an agent/work item are still bound by run + capability checks
  const { agentId: _a, workItemId: _w, ...anonymous } = request();
  assert.equal((await engine().evaluate(anonymous as ActionRequest)).decision, 'allow');
});

test('fail closed: malformed requests and capabilities are denied, never thrown', async () => {
  const cases: Array<[Partial<ActionRequest>, string]> = [
    [{ resources: undefined as never }, 'malformed_request: resources'],
    [{ resources: [1 as never] }, 'malformed_request: resources'],
    [{ riskClass: 'toString' as never }, 'malformed_request: riskClass toString'],
    [{ effect: 'teleport' as never }, 'malformed_request: effect teleport'],
    [{ tool: '' }, 'malformed_request: tool'],
    [{ capability: undefined as never }, 'capability_missing'],
    [{ capability: { ...cap(), tools: undefined as never } }, 'capability_malformed: tools'],
    [{ capability: { ...cap(), expiresAt: 5 as never } }, 'capability_malformed: expiresAt'],
  ];
  for (const [o, reason] of cases) {
    const p = await decide(o);
    assert.equal(p.decision, 'deny', reason);
    assert.deepEqual(p.reasons, [reason]);
  }
  const composite = await new CompositePolicyEngine([engine()]).evaluate(request({ resources: undefined as never }));
  assert.equal(composite.decision, 'deny');
});

test('I2: non-canonical resource keys (.., ., empty segments) are denied before any rule', async () => {
  for (const r of ['workspace/wt_1/../../etc/passwd', 'workspace/./wt_1/a.ts', 'workspace//wt_1/a.ts', '/etc/passwd', '']) {
    const p = await decide({ tool: 'fs.write', effect: 'write_workspace', riskClass: 'medium', resources: [r] });
    assert.equal(p.decision, 'deny', r);
    assert.match(p.reasons[0]!, /^capability_denied: resource_not_canonical: /, r);
  }
});

test('composite fail closed: a malformed permit from an engine counts as deny', async () => {
  const bogus: PolicyEngine = { revision: 'bogus@1', evaluate: async () => ({ decision: 'allow', decisionId: 'x', policyRevision: 'bogus@1' }) as unknown as ActionPermit };
  const weird: PolicyEngine = { revision: 'weird@1', evaluate: async () => ({ decision: 'maybe', decisionId: 'x', reasons: [], policyRevision: 'weird@1' }) as unknown as ActionPermit };
  const allow = new StubEngine('a@1', { decision: 'allow', reasons: ['ok'] });
  for (const e of [bogus, weird]) {
    const p = await new CompositePolicyEngine([allow, e], { newId: () => 'pdec_c' }).evaluate(request());
    assert.equal(p.decision, 'deny');
    assert.deepEqual(p.reasons, ['[a@1] ok', `[${e.revision}] engine_error: malformed permit`]);
  }
});

test('an engine keeps a private immutable copy of its rules (neither the input array nor the getter can change evaluation)', async () => {
  const rules: PolicyRule[] = [{ id: 'deny-all', description: 'd', match: {}, decision: 'deny' }];
  const e = new BuiltinPolicyEngine(rules, 'r@1', options());
  rules[0]!.decision = 'allow';
  assert.throws(() => (e.rules as PolicyRule[]).splice(0, 1, { id: 'allow', description: 'a', match: {}, decision: 'allow' }), TypeError);
  assert.throws(() => {
    (e.rules[0] as PolicyRule).decision = 'allow';
  }, TypeError);
  assert.equal((await e.evaluate(request())).decision, 'deny');
});

test('(review E[2]) a relayed write of a sandboxed command: the capability bounds the CALL (tool, its own effect, risk, environment class); the rules judge the external effect', async () => {
  const author = signCapability(cap({ tools: ['test.run'], allowedEffects: ['read', 'record', 'write_workspace', 'execute'], resourceScopes: ['workspace/**', 'run/**'], environmentClasses: ['local', 'sandbox'], maxRiskClass: 'medium' }), SECRET);
  const operator = signCapability(cap({ tools: ['shell.exec'], allowedEffects: ['read', 'record', 'execute', 'external', 'destructive'], resourceScopes: ['workspace/**', 'env/**'], environmentClasses: ['local', 'sandbox', 'staging'], maxRiskClass: 'critical' }), SECRET);
  const relayed = (o: Partial<ActionRequest>): ActionRequest => request({ tool: 'test.run', effect: 'external', riskClass: 'medium', resources: ['env/bank'], environmentClass: 'local', capability: author, relayedWrite: { callEffect: 'execute' }, ...o });
  const gated = () => new BuiltinPolicyEngine(DEFAULT_POLICY_RULES, 'builtin@1', { ...options(), capabilitySecret: SECRET });
  // a test author's regression run may exercise a local SUT (rule allow-external-local-sandbox)
  const local = await gated().evaluate(relayed({}));
  assert.equal(local.decision, 'allow', local.reasons.join('; '));
  // the same request NOT marked as relayed is an external effect the author's capability does not grant
  const direct = await gated().evaluate(relayed({ relayedWrite: undefined as never }));
  assert.equal(direct.decision, 'deny');
  assert.match(direct.reasons.join('; '), /capability_denied: effect_not_permitted: external/);
  // the capability still bounds WHICH environments: staging is not the author's class
  const staging = await gated().evaluate(relayed({ environmentClass: 'staging', resources: ['env/stg'] }));
  assert.equal(staging.decision, 'deny');
  assert.match(staging.reasons.join('; '), /capability_denied: environment_not_permitted: staging/);
  // the operator may act on staging, where the rules require a human approval; production is denied by the rules
  const opStaging = await gated().evaluate(relayed({ tool: 'shell.exec', capability: operator, environmentClass: 'staging', resources: ['env/stg'] }));
  assert.equal(opStaging.decision, 'approval_required');
  assert.ok(opStaging.reasons.some((r) => r.startsWith('rule:approve-external-staging')));
  // the call's own grant: another tool, a risk above the ceiling, an unknown class, a malformed marker — refused
  assert.match((await gated().evaluate(relayed({ tool: 'shell.exec' }))).reasons.join('; '), /capability_denied: tool_not_permitted: shell\.exec/);
  assert.match((await gated().evaluate(relayed({ riskClass: 'high' }))).reasons.join('; '), /capability_denied: risk_exceeds_capability/);
  assert.match((await gated().evaluate(relayed({ environmentClass: undefined as never }))).reasons.join('; '), /a relayed write needs the environment class of its target/);
  assert.match((await gated().evaluate(relayed({ relayedWrite: { callEffect: 'teleport' as never } }))).reasons.join('; '), /relayedWrite\.callEffect must be a tool effect/);
});
