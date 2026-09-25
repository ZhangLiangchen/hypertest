import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RISK_ORDER, type ActionCapability, type RiskClass, type ToolEffect } from '@hypertest/domain';
import {
  PERMISSION_PROFILES, PRODUCT_FIX_SCOPE, attenuateCapability, capabilityAllows, createRootCapability, holdsProductFix, signCapability,
  verifyCapability, type CapabilityCheckRequest, type CapabilityConstraints,
} from '../src/index.ts';
import { FAR_FUTURE, NOW, SECRET, cap, prng } from './helpers.ts';

const check = (c: ActionCapability, o: Partial<CapabilityCheckRequest> = {}) =>
  capabilityAllows(c, { tool: 'fs.read', effect: 'read', riskClass: 'low', resources: ['workspace/wt_1/a.ts'], now: NOW, ...o });

test('capabilityAllows: allowed action', () => {
  assert.deepEqual(check(cap()), { allowed: true });
});

test('capabilityAllows: precise reasons for each forbidden dimension', () => {
  assert.deepEqual(check(cap({ expiresAt: NOW })), { allowed: false, reason: `capability_expired: ${NOW} <= ${NOW}` });
  assert.deepEqual(check(cap({ expiresAt: 'not-a-date' })), { allowed: false, reason: 'capability_expired: invalid expiresAt not-a-date' });
  assert.deepEqual(check(cap({ tools: ['git.*'] })), { allowed: false, reason: 'tool_not_permitted: fs.read' });
  assert.deepEqual(check(cap({ allowedEffects: ['record'] })), { allowed: false, reason: 'effect_not_permitted: read' });
  assert.deepEqual(check(cap({ maxRiskClass: 'medium' }), { riskClass: 'high' }), { allowed: false, reason: 'risk_exceeds_capability: high > medium' });
  assert.deepEqual(check(cap({ resourceScopes: ['workspace/wt_2/**'] })), { allowed: false, reason: 'resource_out_of_scope: workspace/wt_1/a.ts' });
  assert.deepEqual(check(cap({ environmentClasses: ['local'] }), { environmentClass: 'staging' }), { allowed: false, reason: 'environment_not_permitted: staging' });
  assert.deepEqual(check(cap({ credentialScopes: ['db:read'] }), { credentialScopes: ['db:read', 'db:write'] }), { allowed: false, reason: 'credential_scope_not_permitted: db:write' });
});

test('capabilityAllows: environment class only checked when given; every resource must be in scope', () => {
  assert.deepEqual(check(cap({ environmentClasses: [] })), { allowed: true });
  assert.deepEqual(check(cap({ resourceScopes: ['workspace/wt_1/**'] }), { resources: ['workspace/wt_1/a.ts', 'env/staging'] }), { allowed: false, reason: 'resource_out_of_scope: env/staging' });
});

test('sign/verify: HMAC round trip; tampering, wrong secret or missing signature fail verification', () => {
  const signed = signCapability(cap(), SECRET);
  assert.match(signed.signature!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyCapability(signed, SECRET), true);
  assert.equal(verifyCapability(signed, 'other-secret'), false);
  assert.equal(verifyCapability({ ...signed, allowedEffects: [...signed.allowedEffects, 'destructive'] }, SECRET), false);
  assert.equal(verifyCapability({ ...signed, maxRiskClass: 'critical', tools: ['*', 'x'] }, SECRET), false);
  assert.equal(verifyCapability({ ...signed, signature: signed.signature!.slice(0, -1) }, SECRET), false);
  const { signature: _s, ...unsigned } = signed;
  assert.equal(verifyCapability(unsigned, SECRET), false);
  // key order does not matter (canonical JSON)
  const reordered = Object.fromEntries(Object.entries(signed).reverse()) as ActionCapability;
  assert.equal(verifyCapability(reordered, SECRET), true);
  assert.throws(() => signCapability(cap(), ''), { code: 'invalid_argument' });
});

test('permission profiles: effects per profile and no production in any built-in profile', () => {
  assert.deepEqual(PERMISSION_PROFILES.read_only.allowedEffects, ['read', 'record']);
  assert.deepEqual(PERMISSION_PROFILES.analyst.allowedEffects, ['read', 'record']);
  assert.deepEqual(PERMISSION_PROFILES.test_author.allowedEffects, ['read', 'record', 'write_workspace', 'execute']);
  assert.deepEqual(PERMISSION_PROFILES.test_author.resourceScopes, ['workspace/**', 'run/**']);
  assert.deepEqual(PERMISSION_PROFILES.test_executor.allowedEffects, ['read', 'record', 'execute', 'external']);
  assert.deepEqual(PERMISSION_PROFILES.test_executor.environmentClasses, ['local', 'sandbox']);
  assert.deepEqual(PERMISSION_PROFILES.environment_operator.allowedEffects, ['read', 'record', 'execute', 'external', 'destructive']);
  assert.equal(PERMISSION_PROFILES.environment_operator.maxRiskClass, 'high');
  assert.deepEqual(PERMISSION_PROFILES.environment_operator.environmentClasses, ['local', 'sandbox', 'staging']);
  assert.deepEqual(PERMISSION_PROFILES.product_fixer.credentialScopes, [PRODUCT_FIX_SCOPE]);
  for (const p of Object.values(PERMISSION_PROFILES)) assert.equal(p.environmentClasses.includes('production'), false, p.name);
  assert.equal(PERMISSION_PROFILES.test_author.allowedEffects.includes('external'), false);
});

test('createRootCapability builds a signed capability from a profile', () => {
  const c = createRootCapability({ runId: 'run_1', subjectAgentId: 'ag_1', workItemId: 'wi_1', profile: 'test_author', expiresAt: FAR_FUTURE, capabilityId: 'cap_x' }, SECRET);
  assert.equal(c.capabilityId, 'cap_x');
  assert.deepEqual(c.tools, ['*']);
  assert.deepEqual(c.allowedEffects, ['read', 'record', 'write_workspace', 'execute']);
  assert.equal(c.maxRiskClass, 'medium');
  assert.equal(verifyCapability(c, SECRET), true);
  assert.equal(holdsProductFix(c), false);
  assert.deepEqual(capabilityAllows(c, { tool: 'fs.write', effect: 'write_workspace', riskClass: 'medium', resources: ['workspace/wt_1/test/a.test.ts'], now: NOW }), { allowed: true });
  assert.deepEqual(capabilityAllows(c, { tool: 'env.restart', effect: 'destructive', riskClass: 'high', resources: ['env/sbx'], environmentClass: 'sandbox', now: NOW }), {
    allowed: false,
    reason: 'effect_not_permitted: destructive',
  });
  const fixer = createRootCapability({ runId: 'run_1', subjectAgentId: 'ag_2', workItemId: 'wi_2', profile: 'product_fixer', expiresAt: FAR_FUTURE }, SECRET);
  assert.match(fixer.capabilityId, /^cap_/);
  assert.equal(holdsProductFix(fixer), true);
  assert.throws(() => createRootCapability({ runId: 'r', subjectAgentId: 'a', workItemId: 'w', profile: 'root' as never, expiresAt: FAR_FUTURE }, SECRET), { code: 'invalid_argument' });
  assert.throws(() => createRootCapability({ runId: 'r', subjectAgentId: 'a', workItemId: 'w', profile: 'analyst', expiresAt: 'soon' }, SECRET), { code: 'invalid_argument' });
});

test('attenuateCapability: intersection per field, min risk/expiry, parent link, unsigned result', () => {
  const parent = signCapability(cap({ tools: ['fs.*', 'git.*', 'test.run'], resourceScopes: ['workspace/wt_1/**'], credentialScopes: ['a', 'b'], maxRiskClass: 'high', environmentClasses: ['local', 'sandbox'], expiresAt: '2030-01-01T00:00:00.000Z' }), SECRET);
  const child = attenuateCapability(
    parent,
    { tools: ['fs.read', 'git.*', 'shell.exec', '*'], resourceScopes: ['workspace/wt_1/src/**', 'env/**'], allowedEffects: ['read', 'destructive'], credentialScopes: ['b', 'c'], maxRiskClass: 'critical', environmentClasses: ['sandbox', 'staging'], expiresAt: '2031-01-01T00:00:00.000Z' },
    { subjectAgentId: 'agent_child', workItemId: 'wi_child', capabilityId: 'cap_child' },
  );
  assert.deepEqual(child.tools, ['fs.*', 'fs.read', 'git.*', 'test.run']);
  assert.deepEqual(child.resourceScopes, ['workspace/wt_1/src/**']);
  assert.deepEqual(child.allowedEffects, ['read', 'destructive']);
  assert.deepEqual(child.credentialScopes, ['b']);
  assert.equal(child.maxRiskClass, 'high');
  assert.deepEqual(child.environmentClasses, ['sandbox']);
  assert.equal(child.expiresAt, '2030-01-01T00:00:00.000Z');
  assert.equal(child.parentCapabilityId, parent.capabilityId);
  assert.equal(child.capabilityId, 'cap_child');
  assert.equal(child.subjectAgentId, 'agent_child');
  assert.equal(child.runId, parent.runId);
  assert.equal(child.signature, undefined);
  assert.equal(verifyCapability(signCapability(child, SECRET), SECRET), true);
});

test('attenuateCapability: omitted constraint fields inherit the parent; arrays apply role ∩ work item ∩ environment', () => {
  const parent = cap({ tools: ['fs.*'], maxRiskClass: 'medium' });
  const inherit = attenuateCapability(parent, {}, { subjectAgentId: 'c', workItemId: 'w' });
  assert.deepEqual(inherit.tools, ['fs.*']);
  assert.deepEqual(inherit.allowedEffects, parent.allowedEffects);
  const chained = attenuateCapability(parent, [{ allowedEffects: ['read', 'record', 'execute'] }, { allowedEffects: ['read', 'execute'], environmentClasses: ['local'] }, { maxRiskClass: 'low' }], { subjectAgentId: 'c', workItemId: 'w' });
  assert.deepEqual(chained.allowedEffects, ['read', 'execute']);
  assert.deepEqual(chained.environmentClasses, ['local']);
  assert.equal(chained.maxRiskClass, 'low');
});

test('I2 failure path: a child asking for more than the parent gets nothing more (amplification attempt)', () => {
  const parent = cap({ tools: ['fs.read'], resourceScopes: ['workspace/wt_1/**'], allowedEffects: ['read'], maxRiskClass: 'low', environmentClasses: ['local'], credentialScopes: [] });
  const greedy = attenuateCapability(
    parent,
    { tools: ['*'], resourceScopes: ['**'], allowedEffects: ['read', 'destructive'], maxRiskClass: 'critical', environmentClasses: ['production'], credentialScopes: ['root'], expiresAt: '2199-01-01T00:00:00.000Z' },
    { subjectAgentId: 'c', workItemId: 'w' },
  );
  assert.deepEqual(greedy.tools, ['fs.read']);
  assert.deepEqual(greedy.resourceScopes, ['workspace/wt_1/**']);
  assert.deepEqual(greedy.allowedEffects, ['read']);
  assert.equal(greedy.maxRiskClass, 'low');
  assert.deepEqual(greedy.environmentClasses, []);
  assert.deepEqual(greedy.credentialScopes, []);
  assert.equal(greedy.expiresAt, parent.expiresAt);
  assert.equal(check(greedy, { tool: 'env.restart', effect: 'destructive', riskClass: 'critical' }).allowed, false);
});

// ----------------------------------------------------------------------------- randomized property (I2)

const TOOLS = ['fs.read', 'fs.write', 'git.diff', 'git.log', 'test.run', 'env.restart', 'http.request'];
const TOOL_PATTERNS = ['*', 'fs.*', 'git.*', 'fs.read', 'fs.write', 'git.diff', 'test.run', 'env.*', 'http.request', 'f*'];
const RESOURCE_PATTERNS = ['**', 'workspace/**', 'workspace/*/src/**', 'workspace/wt_1/**', 'workspace/wt_2/**', 'env/*', 'env/staging', 'run/**', 'workspace/*', 'workspace/wt_1/src/*'];
const RESOURCES = ['workspace/wt_1/src/a.ts', 'workspace/wt_1/test/a.test.ts', 'workspace/wt_2/src/b.ts', 'workspace/wt_1', 'env/staging', 'env/production', 'run/run_1/rec', 'other/x'];
const EFFECTS: ToolEffect[] = ['read', 'record', 'write_workspace', 'execute', 'external', 'destructive'];
const RISKS: RiskClass[] = ['low', 'medium', 'high', 'critical'];
const ENVS = ['local', 'sandbox', 'staging', 'production'];
const CREDS = ['db:read', 'db:write', 'k8s', PRODUCT_FIX_SCOPE];
const DATES = ['2026-01-01T00:00:10.000Z', '2026-06-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', FAR_FUTURE, '2025-12-31T00:00:00.000Z'];

test('property (I2): an attenuated child never allows an action its parent denies', () => {
  const rnd = prng(20260925);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const subset = <T>(xs: readonly T[], p = 0.5) => xs.filter(() => rnd() < p);
  const randomCap = (): ActionCapability =>
    cap({ tools: subset(TOOL_PATTERNS, 0.3), resourceScopes: subset(RESOURCE_PATTERNS, 0.3), allowedEffects: subset(EFFECTS), credentialScopes: subset(CREDS), maxRiskClass: pick(RISKS), environmentClasses: subset(ENVS), expiresAt: pick(DATES) });
  const randomConstraints = (): CapabilityConstraints => {
    const c: CapabilityConstraints = {};
    if (rnd() < 0.7) c.tools = subset(TOOL_PATTERNS, 0.4);
    if (rnd() < 0.7) c.resourceScopes = subset(RESOURCE_PATTERNS, 0.4);
    if (rnd() < 0.7) c.allowedEffects = subset(EFFECTS, 0.6);
    if (rnd() < 0.5) c.credentialScopes = subset(CREDS, 0.6);
    if (rnd() < 0.6) c.maxRiskClass = pick(RISKS);
    if (rnd() < 0.6) c.environmentClasses = subset(ENVS, 0.6);
    if (rnd() < 0.5) c.expiresAt = pick(DATES);
    return c;
  };
  let parentDenied = 0;
  let childAllowed = 0;
  for (let i = 0; i < 400; i++) {
    const parent = randomCap();
    const constraints = rnd() < 0.3 ? [randomConstraints(), randomConstraints()] : randomConstraints();
    const child = attenuateCapability(parent, constraints, { subjectAgentId: 'child', workItemId: 'wi_c' });
    assert.ok(RISK_ORDER[child.maxRiskClass] <= RISK_ORDER[parent.maxRiskClass]);
    assert.ok(Date.parse(child.expiresAt) <= Date.parse(parent.expiresAt));
    for (let j = 0; j < 50; j++) {
      const req: CapabilityCheckRequest = {
        tool: pick(TOOLS),
        effect: pick(EFFECTS),
        riskClass: pick(RISKS),
        resources: subset(RESOURCES, 0.25),
        ...(rnd() < 0.7 ? { environmentClass: pick(ENVS) } : {}),
        credentialScopes: subset(CREDS, 0.2),
        now: pick(['2026-01-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z']),
      };
      const p = capabilityAllows(parent, req);
      const c = capabilityAllows(child, req);
      if (!p.allowed) {
        parentDenied++;
        assert.equal(c.allowed, false, `child allowed what parent denied (${p.reason}): ${JSON.stringify({ parent, constraints, child, req })}`);
      }
      if (c.allowed) childAllowed++;
    }
  }
  assert.ok(parentDenied > 5000, `denials exercised: ${parentDenied}`);
  assert.ok(childAllowed > 50, `child permits exercised: ${childAllowed}`);
});

test('capabilityAllows: non-canonical resource keys never match a scope, even **', () => {
  for (const r of ['workspace/wt_1/../../etc/passwd', 'workspace/./a', 'workspace//a', '/etc/passwd', '', 'workspace\\wt_1\\a']) {
    const c = check(cap({ resourceScopes: ['**'] }), { resources: [r] });
    assert.equal(c.allowed, false, r);
    assert.match((c as { reason: string }).reason, /^resource_not_canonical: /, r);
  }
  assert.deepEqual(check(cap({ resourceScopes: ['workspace/**'] }), { resources: ['workspace/wt_1/src/a.ts'] }), { allowed: true });
});

test('I2 failure path: attenuating a tampered parent with the secret is refused; a valid parent yields a signed child', () => {
  const parent = createRootCapability({ runId: 'run_1', subjectAgentId: 'lead', workItemId: 'wi_1', profile: 'analyst', expiresAt: FAR_FUTURE }, SECRET);
  const forged = { ...parent, allowedEffects: [...parent.allowedEffects, 'destructive' as const], maxRiskClass: 'critical' as const };
  assert.throws(() => attenuateCapability(forged, { allowedEffects: ['destructive'] }, { subjectAgentId: 'c', workItemId: 'w' }, { secret: SECRET }), { code: 'permission_denied' });
  // without the secret the laundering would have produced a destructive child the caller then signs
  assert.deepEqual(attenuateCapability(forged, { allowedEffects: ['destructive'] }, { subjectAgentId: 'c', workItemId: 'w' }).allowedEffects, ['destructive']);
  const child = attenuateCapability(parent, { allowedEffects: ['read'] }, { subjectAgentId: 'c', workItemId: 'w' }, { secret: SECRET });
  assert.equal(verifyCapability(child, SECRET), true);
  assert.deepEqual(child.allowedEffects, ['read']);
  assert.equal(child.parentCapabilityId, parent.capabilityId);
});
