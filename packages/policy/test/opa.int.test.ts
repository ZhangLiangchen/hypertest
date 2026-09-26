import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { FixedClock } from '@hypertest/core';
import { skipUnless } from '@hypertest/testkit';
import { BuiltinPolicyEngine, CompositePolicyEngine, DEFAULT_POLICY_RULES, OpaPolicyEngine } from '../src/index.ts';
import { NOW, request } from './helpers.ts';

/** HYPERTEST_TEST_OPA_URL from the environment or .infra/env (testkit's infraEnv has no OPA field). */
function opaUrl(): string | undefined {
  if (process.env['HYPERTEST_TEST_OPA_URL']) return process.env['HYPERTEST_TEST_OPA_URL'];
  let d = resolve(dirname(new URL(import.meta.url).pathname));
  while (d !== '/' && !existsSync(join(d, 'scripts', 'check-boundaries.mjs'))) d = dirname(d);
  const f = join(d, '.infra', 'env');
  if (!existsSync(f)) return undefined;
  return /^HYPERTEST_TEST_OPA_URL=(.*)$/m.exec(readFileSync(f, 'utf8'))?.[1]?.trim();
}

const url = opaUrl();
const skip = skipUnless(!!url, 'HYPERTEST_TEST_OPA_URL is not set (no local OPA; run npm run infra:up)');
const suffix = randomBytes(4).toString('hex');
const uploaded: string[] = [];

async function putPolicy(id: string, rego: string): Promise<void> {
  const res = await fetch(`${url}/v1/policies/${id}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: rego });
  assert.equal(res.status, 200, `OPA rejected policy ${id}: ${await res.text()}`);
  uploaded.push(id);
}

after(async () => {
  for (const id of uploaded) await fetch(`${url}/v1/policies/${id}`, { method: 'DELETE' }).catch(() => undefined);
});

const rego = (pkg: string) => `package ${pkg}

default allow := false

default approval_required := false

allow if {
  input.effect in {"read", "record"}
}

allow if {
  input.effect == "external"
  input.environmentClass in {"local", "sandbox"}
}

approval_required if {
  input.effect == "external"
  input.environmentClass == "staging"
}

reasons contains "read or record" if input.effect in {"read", "record"}

reasons contains "external on staging needs approval" if {
  input.effect == "external"
  input.environmentClass == "staging"
}

reasons contains sprintf("denied: %s on %v", [input.effect, object.get(input, "environmentClass", "none")]) if {
  not allow
  not approval_required
}

constraints := {"maxDurationMs": 30000} if input.effect == "external"
`;

test('OPA (package hypertest.authz, default path): allow / deny / approval_required against a real server', skip, async () => {
  await putPolicy(`hypertest-authz-${suffix}`, rego('hypertest.authz'));
  const opa = new OpaPolicyEngine({ url: url!, revision: `opa@${suffix}`, timeoutMs: 3000, clock: new FixedClock(NOW) });
  const read = await opa.evaluate(request({ effect: 'read' }));
  assert.equal(read.decision, 'allow');
  assert.deepEqual(read.reasons, ['read or record']);
  const ext = await opa.evaluate(request({ tool: 'load.start', effect: 'external', riskClass: 'high', environmentClass: 'sandbox', resources: ['env/sbx'] }));
  assert.equal(ext.decision, 'allow');
  assert.deepEqual(ext.constraints, { maxDurationMs: 30000 });
  const staging = await opa.evaluate(request({ tool: 'load.start', effect: 'external', riskClass: 'high', environmentClass: 'staging', resources: ['env/stg'] }));
  assert.equal(staging.decision, 'approval_required');
  assert.deepEqual(staging.reasons, ['external on staging needs approval']);
  const destructive = await opa.evaluate(request({ tool: 'env.restart', effect: 'destructive', riskClass: 'high', environmentClass: 'production', resources: ['env/prod'] }));
  assert.equal(destructive.decision, 'deny');
  assert.deepEqual(destructive.reasons, ['denied: destructive on production']);
});

test('OPA: an undefined decision path is fail-closed', skip, async () => {
  const opa = new OpaPolicyEngine({ url: url!, path: `hypertest/nonexistent_${suffix}`, revision: 'opa@x', timeoutMs: 3000, clock: new FixedClock(NOW) });
  const p = await opa.evaluate(request());
  assert.equal(p.decision, 'deny');
  assert.deepEqual(p.reasons, ['opa_unavailable', 'undefined decision document']);
});

test('OPA: a dead URL denies (fail closed)', skip, async () => {
  const opa = new OpaPolicyEngine({ url: 'http://127.0.0.1:9', revision: 'opa@dead', timeoutMs: 1000, clock: new FixedClock(NOW) });
  const p = await opa.evaluate(request());
  assert.equal(p.decision, 'deny');
  assert.equal(p.reasons[0], 'opa_unavailable');
});

test('OPA composed with the built-in rules: deny wins across engines', skip, async () => {
  const pkg = `hypertest.authz_c${suffix}`;
  await putPolicy(`hypertest-authz-c-${suffix}`, rego(pkg));
  const opa = new OpaPolicyEngine({ url: url!, path: pkg, revision: `opa@${suffix}`, timeoutMs: 3000, clock: new FixedClock(NOW) });
  const builtin = new BuiltinPolicyEngine(DEFAULT_POLICY_RULES, 'builtin@1', { clock: new FixedClock(NOW) });
  const composite = new CompositePolicyEngine([builtin, opa]);
  // OPA allows external on sandbox; builtin allows too
  assert.equal((await composite.evaluate(request({ effect: 'external', riskClass: 'medium', environmentClass: 'sandbox', resources: ['env/sbx'] }))).decision, 'allow');
  // builtin allows workspace execution; OPA's policy has no rule for execute ⇒ deny wins
  const exec = await composite.evaluate(request({ tool: 'test.run', effect: 'execute', riskClass: 'medium', resources: ['workspace/wt_1'] }));
  assert.equal(exec.decision, 'deny');
  assert.equal(exec.policyRevision, `builtin@1+opa@${suffix}`);
  assert.ok(exec.reasons.includes(`[opa@${suffix}] denied: execute on none`), exec.reasons.join(' | '));
});

test('BUGate phases against a real OPA: a phase-aware Rego package judges after_action, transitions and acceptance; deny wins in the composite', skip, async () => {
  const pkg = `hypertest.phases_${suffix}`;
  await putPolicy(
    `hypertest-phases-${suffix}`,
    `package ${pkg}

default allow := false

default approval_required := false

allow if input.phase == "before_action"

allow if {
  input.phase == "after_action"
  count(input.outcome.undeclaredEvidenceTypes) == 0
}

allow if {
  input.phase == "before_transition"
  not blocked_plan
}

blocked_plan if {
  input.transition.subject == "plan"
  input.transition.details.readyForGate == true
  input.transition.details.openObjectives > 0
}

allow if {
  input.phase == "before_acceptance"
  input.acceptance.evidence.byType["api-response"] > 0
}

reasons contains sprintf("phase %s", [input.phase])

reasons contains "ready for the gate with open objectives" if blocked_plan
`,
  );
  const opa = new OpaPolicyEngine({ url: url!, path: pkg, revision: `opa-phases@${suffix}`, timeoutMs: 3000, clock: new FixedClock(NOW) });
  const composite = new CompositePolicyEngine([new BuiltinPolicyEngine(DEFAULT_POLICY_RULES, 'builtin@1', { clock: new FixedClock(NOW) }), opa]);
  const record = { tool: 'transition.plan', effect: 'record' as const, riskClass: 'low' as const, resources: ['run/run_1/plan'] };
  // before_action: OPA sees the defaulted phase
  assert.deepEqual((await opa.evaluate(request())).reasons, ['phase before_action']);
  // after_action: evidence the tool does not declare is refused by OPA (and flagged by the built-in rules)
  const outcome = { status: 'success', evidenceTypes: ['test-result'], evidenceIds: ['ev_1'], declaredEvidenceTypes: ['stdout', 'tool-output'], undeclaredEvidenceTypes: ['test-result'] };
  const flagged = await composite.evaluate(request({ tool: 'shell.exec', effect: 'execute', riskClass: 'medium', resources: ['workspace/wt_1'], phase: 'after_action', outcome }));
  assert.equal(flagged.decision, 'deny');
  assert.ok(flagged.reasons.some((r) => r.startsWith('[builtin@1] rule:flag-undeclared-evidence')), flagged.reasons.join(' | '));
  assert.equal((await opa.evaluate(request({ phase: 'after_action', outcome: { ...outcome, evidenceTypes: [], undeclaredEvidenceTypes: [] } }))).decision, 'allow');
  // before_transition: an operator rule the built-in defaults do not have — OPA's deny wins in the composite
  const transition = { subject: 'plan' as const, subjectId: 'plan_1', from: 'proposed', to: 'accepted', flaggedActions: 0, details: { readyForGate: true, openObjectives: 2 } };
  const plan = await composite.evaluate(request({ ...record, phase: 'before_transition', transition }));
  assert.equal(plan.decision, 'deny');
  assert.ok(plan.reasons.includes(`[opa-phases@${suffix}] ready for the gate with open objectives`), plan.reasons.join(' | '));
  assert.equal((await composite.evaluate(request({ ...record, phase: 'before_transition', transition: { ...transition, details: { readyForGate: true, openObjectives: 0 } } }))).decision, 'allow');
  // before_acceptance: the gate input digest reaches OPA (a black-box release needs api-response evidence)
  const acceptance = {
    gateId: 'g', gateOverrides: [], verdict: 'pass' as const, requiresHumanReview: false, satisfiedCriteria: [], violatedCriteria: [], unknownCriteria: [], evidence: { count: 1, rootHash: 'r', byType: { 'test-result': 1 } },
    findings: { total: 0, unresolved: [] }, risks: { total: 0, unresolved: [] }, reviews: [], oracleRevisions: {}, workItems: {}, claims: { total: 0, critical: 0 }, exceptions: [], flaggedActions: 0,
  };
  assert.equal((await composite.evaluate(request({ ...record, tool: 'gate.accept', phase: 'before_acceptance', acceptance }))).decision, 'deny');
  const withApi = await composite.evaluate(request({ ...record, tool: 'gate.accept', phase: 'before_acceptance', acceptance: { ...acceptance, evidence: { count: 2, rootHash: 'r', byType: { 'api-response': 1, 'test-result': 1 } } } }));
  assert.equal(withApi.decision, 'allow', withApi.reasons.join(' | '));
});
