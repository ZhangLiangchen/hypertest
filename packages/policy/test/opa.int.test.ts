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
