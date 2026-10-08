/**
 * E[4] / coverage[8]: a brokered credential a call uses is a capability scope — the engine's capability check covers it
 * (before: the request's credential scopes never reached capabilityAllows, so the check could not fire).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixedClock } from '@hypertest/core';
import { BuiltinPolicyEngine, DEFAULT_POLICY_RULES, capabilityAllows, signCapability } from '../src/index.ts';
import { NOW, SECRET, cap, request } from './helpers.ts';

test('a credential scope the capability does not grant ⇒ deny (capability_denied: credential_scope_not_permitted); a granted one passes', async () => {
  const clock = new FixedClock(NOW);
  const { signature: _s, ...unsigned } = cap({ credentialScopes: ['credential:shop/orders'] });
  const capability = signCapability(unsigned, SECRET);
  const req = (credentialScopes: string[]) => request({ capability, tool: 'http.request', effect: 'read', riskClass: 'low', resources: ['env/shop'], environmentClass: 'local', credentialScopes });
  assert.deepEqual(capabilityAllows(capability, { tool: 'http.request', effect: 'read', riskClass: 'low', resources: ['env/shop'], credentialScopes: ['credential:shop/admin'], now: NOW }), { allowed: false, reason: 'credential_scope_not_permitted: credential:shop/admin' });
  const engine = new BuiltinPolicyEngine(DEFAULT_POLICY_RULES, 'builtin@cred', { clock, capabilitySecret: SECRET });
  const denied = await engine.evaluate(req(['credential:shop/admin']));
  assert.equal(denied.decision, 'deny');
  assert.ok(denied.reasons.some((r) => r.includes('credential_scope_not_permitted: credential:shop/admin')));
  assert.equal((await engine.evaluate(req(['credential:shop/orders']))).decision, 'allow');
});
