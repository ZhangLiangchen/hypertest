import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HypertestError, canonicalJson, isHypertestError, jsonClone, sha256Hex } from '@hypertest/core';
import { BUILTIN_ROLES, RoleCatalog, ROLE_DEFINITION_SCHEMA, validateRoleDefinition, type RoleDefinition, type RoleOverrides } from '../src/index.ts';

function builtin(name: string): RoleDefinition {
  return BUILTIN_ROLES.find((r) => r.role === name)!;
}

/** A minimal valid custom role (mutable copy). */
function customRole(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    role: 'security_auditor',
    description: 'Audits authentication and authorisation paths.',
    systemPrompt: 'You are {{role}}. Goal: {{runGoal}}. Objective: {{objective}}.\n{{protocol}}\nCite evidence ids; finish with complete_work or fail_work.',
    phase: 'analysis',
    taskType: 'security_audit',
    defaultModelPolicy: { requiredCapabilities: ['tool_use', 'reasoning'], minQuality: 0.7, independentFromRoles: ['executor'] },
    toolPolicy: { allow: ['fs.read', 'fs.search', 'blackboard.post_risk', 'complete_work', 'fail_work'] },
    permissionProfile: 'analyst',
    workspace: 'shared_readonly',
    dataClassification: 'confidential',
    subscriptions: [],
    canDelegateTo: [],
    maxDepth: 0,
    defaultBudget: { maxTurns: 10 },
    ...overrides,
  };
}

/** Asserts construction fails with invalid_argument and returns the error (message + details). */
function rejects(fn: () => unknown, ...needles: string[]): HypertestError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(isHypertestError(caught, 'invalid_argument'), `expected invalid_argument, got ${String(caught)}`);
  const text = caught.message + ' ' + JSON.stringify(caught.details);
  for (const n of needles) assert.ok(text.includes(n), `error mentions "${n}": ${caught.message}`);
  return caught;
}

test('get / require / list over the built-in catalog', () => {
  const catalog = new RoleCatalog(BUILTIN_ROLES);
  assert.equal(catalog.list().length, 12);
  assert.deepEqual(catalog.list().map((r) => r.role), BUILTIN_ROLES.map((r) => r.role));
  assert.deepEqual(catalog.get('lead'), builtin('lead'));
  assert.equal(catalog.require('reviewer').role, 'reviewer');
  assert.equal(catalog.get('nope'), undefined);
  for (const inherited of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(catalog.get(inherited), undefined, inherited);
});

test('require(unknown) throws HypertestError not_found listing the known roles', () => {
  const catalog = new RoleCatalog(BUILTIN_ROLES);
  assert.throws(
    () => catalog.require('qa_wizard'),
    (e: unknown) => isHypertestError(e, 'not_found') && e.details['role'] === 'qa_wizard' && (e.details['known'] as string[]).includes('lead'),
  );
});

test('subscriptions() flattens every role subscription with its role, in catalog order', () => {
  const subs = new RoleCatalog(BUILTIN_ROLES).subscriptions();
  assert.deepEqual(subs.map((s) => [s.role, s.ruleId]), [
    ['test_designer', 'test_designer.regression_for_finding'],
    ['test_designer', 'test_designer.close_coverage_gap'],
    ['rca', 'rca.investigate_finding'],
    ['reviewer', 'reviewer.review_requested'],
    ['reviewer', 'reviewer.verify_confirmed_finding'],
    ['metrics_analyst', 'metrics_analyst.quantify_performance_finding'],
  ]);
  const rca = subs.find((s) => s.role === 'rca')!;
  const { role: _role, ...rest } = rca;
  assert.deepEqual(rest, builtin('rca').subscriptions[0]);
});

test('revision() is the SHA-256 of the canonical effective roles and is deterministic', () => {
  const a = new RoleCatalog(BUILTIN_ROLES);
  const b = new RoleCatalog(jsonClone(BUILTIN_ROLES));
  assert.match(a.revision(), /^[0-9a-f]{64}$/);
  assert.equal(a.revision(), b.revision());
  assert.equal(a.revision(), sha256Hex(canonicalJson({ catalogVersion: 1, roles: BUILTIN_ROLES })));
  assert.equal(new RoleCatalog(BUILTIN_ROLES, { roles: { lead: {} } }).revision(), a.revision(), 'an empty override changes nothing');
  assert.equal(new RoleCatalog(BUILTIN_ROLES, { roles: { lead: { maxDepth: 2 } } }).revision(), a.revision(), 'an identical value changes nothing');
});

test('revision() changes with overrides and custom roles', () => {
  const base = new RoleCatalog(BUILTIN_ROLES).revision();
  const policy = new RoleCatalog(BUILTIN_ROLES, { roles: { executor: { defaultModelPolicy: { preferredRoutes: ['local-qwen'] } } } }).revision();
  const custom = new RoleCatalog(BUILTIN_ROLES, { custom: [customRole()] }).revision();
  assert.notEqual(policy, base);
  assert.notEqual(custom, base);
  assert.notEqual(custom, policy);
});

test('overrides deep-merge objects: untouched model-policy fields survive', () => {
  const catalog = new RoleCatalog(BUILTIN_ROLES, { roles: { lead: { defaultModelPolicy: { minQuality: 0.9, preferredRoutes: ['claude-opus'] } } } });
  const policy = catalog.require('lead').defaultModelPolicy;
  assert.equal(policy.minQuality, 0.9);
  assert.deepEqual(policy.preferredRoutes, ['claude-opus']);
  assert.deepEqual(policy.requiredCapabilities, ['tool_use', 'reasoning', 'long_context']);
  assert.equal(policy.fallback, 'revalidated');
  assert.equal(catalog.require('lead').systemPrompt, builtin('lead').systemPrompt);
});

test('overrides replace arrays wholesale (allowlists, capabilities, subscriptions)', () => {
  const catalog = new RoleCatalog(BUILTIN_ROLES, {
    roles: {
      executor: { toolPolicy: { allow: ['test.run', 'complete_work', 'fail_work'] }, defaultModelPolicy: { requiredCapabilities: ['tool_use'] } },
      rca: { subscriptions: [] },
    },
  });
  assert.deepEqual(catalog.require('executor').toolPolicy.allow, ['test.run', 'complete_work', 'fail_work']);
  assert.deepEqual(catalog.require('executor').defaultModelPolicy.requiredCapabilities, ['tool_use']);
  assert.equal(catalog.require('executor').defaultModelPolicy.minQuality, 0.6);
  assert.ok(!catalog.subscriptions().some((s) => s.role === 'rca'));
});

test('overrides replace outputSchema wholesale (no partially merged JSON Schema)', () => {
  const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };
  const catalog = new RoleCatalog(BUILTIN_ROLES, { roles: { condenser: { outputSchema: schema } } });
  assert.deepEqual(catalog.require('condenser').outputSchema, schema);
});

test('overrides merge defaultBudget per field', () => {
  const catalog = new RoleCatalog(BUILTIN_ROLES, { roles: { executor: { defaultBudget: { maxTurns: 5 } } } });
  assert.deepEqual(catalog.require('executor').defaultBudget, { ...builtin('executor').defaultBudget, maxTurns: 5 });
});

test('construction never mutates or freezes its inputs', () => {
  const overrides: RoleOverrides = { roles: { lead: { defaultModelPolicy: { minQuality: 0.8 } } }, custom: [customRole()] };
  const snapshot = jsonClone(overrides);
  const builtinSnapshot = jsonClone(BUILTIN_ROLES);
  new RoleCatalog(BUILTIN_ROLES, overrides);
  assert.deepEqual(overrides, snapshot);
  assert.ok(!Object.isFrozen(overrides.custom![0]), 'caller objects stay mutable');
  assert.deepEqual(jsonClone(BUILTIN_ROLES), builtinSnapshot);
  assert.equal(builtin('lead').defaultModelPolicy.minQuality, 0.75);
});

test('custom roles are appended, retrievable, validated and may reference built-in roles', () => {
  const extra = customRole({
    subscriptions: [
      {
        ruleId: 'security_auditor.on_security_finding',
        eventTypes: ['finding.created'],
        filter: { categories: ['security'] },
        work: { title: 'Audit {{title}}', objective: 'Audit finding {{recordId}}: {{summary}}', priority: 65 },
        maxPerRun: 5,
        maxCausalDepth: 2,
      },
    ],
  });
  const catalog = new RoleCatalog(BUILTIN_ROLES, { custom: [extra] });
  assert.equal(catalog.list().at(-1)!.role, 'security_auditor');
  assert.equal(catalog.require('security_auditor').dataClassification, 'confidential');
  assert.deepEqual(catalog.subscriptions().at(-1)!.role, 'security_auditor');
});

test('overrides may target custom roles and let the lead delegate to them', () => {
  const catalog = new RoleCatalog(BUILTIN_ROLES, {
    custom: [customRole()],
    roles: {
      lead: { canDelegateTo: ['code_change_analyst', 'security_auditor'] },
      security_auditor: { defaultModelPolicy: { minQuality: 0.95 } },
    },
  });
  assert.deepEqual(catalog.require('lead').canDelegateTo, ['code_change_analyst', 'security_auditor']);
  assert.equal(catalog.require('security_auditor').defaultModelPolicy.minQuality, 0.95);
});

test('effective roles are deep-frozen; mutation attempts throw and never change the revision', () => {
  const catalog = new RoleCatalog(BUILTIN_ROLES, { custom: [customRole()] });
  const before = catalog.revision();
  const auditor = catalog.require('security_auditor');
  assert.ok(Object.isFrozen(auditor) && Object.isFrozen(auditor.toolPolicy.allow));
  assert.throws(() => (auditor.toolPolicy.allow as string[]).push('env.deploy'), TypeError);
  assert.throws(() => {
    (auditor.defaultModelPolicy as { minQuality?: number }).minQuality = 0;
  }, TypeError);
  const listed = catalog.list();
  listed.pop();
  assert.equal(catalog.list().length, 13, 'list() returns a copy');
  const subs = catalog.subscriptions();
  subs.length = 0;
  assert.equal(catalog.subscriptions().length, 6);
  assert.ok(Object.isFrozen(catalog.subscriptions()[0]));
  assert.equal(catalog.revision(), before);
});

// ------------------------------------------------------------------------------------------ fault injection

test('rejects overrides for unknown roles (typo protection)', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { exectuor: { maxDepth: 0 } } }), 'exectuor');
});

test('rejects an override that tries to rename a role', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { executor: { role: 'lead' } as never } }), 'executor', 'rename');
});

test('rejects unknown top-level and nested override keys', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { lead: { systemPromt: 'x' } as never } }), "unknown key 'systemPromt'");
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { lead: { defaultModelPolicy: { minQualty: 0.9 } as never } } }), 'lead', 'additional properties');
});

test('rejects prototype-pollution keys in overrides and leaves Object.prototype untouched', () => {
  const nested = JSON.parse('{"lead": {"defaultModelPolicy": {"__proto__": {"polluted": true}}}}') as RoleOverrides['roles'];
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: nested! }), '__proto__');
  const top = JSON.parse('{"lead": {"__proto__": {"polluted": true}}}') as RoleOverrides['roles'];
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: top! }), '__proto__');
  const inArray = JSON.parse('{"lead": {"defaultBudget": {"constructor": {"prototype": {"polluted": true}}}}}') as RoleOverrides['roles'];
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: inArray! }), 'constructor');
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('rejects malformed override containers', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: [] as never }), 'overrides.roles');
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: {} as never }), 'overrides.custom');
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { lead: null as never } }), "role override for 'lead' must be an object");
  rejects(() => new RoleCatalog(BUILTIN_ROLES, null as never), 'overrides must be an object');
  rejects(() => new RoleCatalog({} as never), 'roles must be an array');
});

test('rejects duplicate role ids (custom may not shadow a built-in)', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ role: 'reviewer' })] }), 'duplicate role ids: reviewer');
  rejects(() => new RoleCatalog([...BUILTIN_ROLES, builtin('lead')]), 'duplicate role ids: lead');
});

test('rejects a subscription ruleId reused by another role', () => {
  const clash = customRole({
    subscriptions: [{ ...builtin('rca').subscriptions[0]!, work: { ...builtin('rca').subscriptions[0]!.work } }],
  });
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [clash] }), "'rca.investigate_finding' is already used by role 'rca'");
});

test('rejects unknown tool ids in allow and deny lists (a typo would silently grant or deny nothing)', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ toolPolicy: { allow: ['fs.reads', 'complete_work', 'fail_work'] } })] }), "'fs.reads'");
  rejects(
    () => new RoleCatalog(BUILTIN_ROLES, { roles: { executor: { toolPolicy: { allow: builtin('executor').toolPolicy.allow, deny: ['shell.exce'] } } } }),
    "deny entry 'shell.exce'",
  );
});

test('rejects bare and un-namespaced wildcards in allowlists', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ toolPolicy: { allow: ['*'] } })] }), "'*'");
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ toolPolicy: { allow: ['f*', 'complete_work', 'fail_work'] } })] }), "'f*'");
});

test('accepts extra tool ids and the MCP namespace when declared', () => {
  const tools = { allow: ['custom.lint', 'mcp.github.search_code', 'complete_work', 'fail_work'] };
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ toolPolicy: tools })] }), "'custom.lint'");
  const catalog = new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ toolPolicy: tools })] }, { extraToolIds: ['custom.lint'] });
  assert.deepEqual(catalog.require('security_auditor').toolPolicy.allow, tools.allow);
});

test('rejects roles that cannot terminate explicitly', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { executor: { toolPolicy: { allow: ['test.run', 'fail_work'] } } } }), "terminal tool 'complete_work'");
  rejects(
    () => new RoleCatalog(BUILTIN_ROLES, { roles: { executor: { toolPolicy: { allow: builtin('executor').toolPolicy.allow, deny: ['fail_work'] } } } }),
    "terminal tool 'fail_work'",
  );
});

test('rejects prompts without the {{protocol}} slot or with unknown placeholders', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { reviewer: { systemPrompt: 'Review {{objective}}.' } } }), '{{protocol}} injection slot');
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { reviewer: { systemPrompt: '{{protocol}} {{goal}}' } } }), 'unknown placeholder {{goal}}');
});

test('rejects subscriptions with unknown event types unless declared, and unknown template variables', () => {
  const sub = (eventTypes: string[], title = 'Audit {{title}}') => ({
    ruleId: 'security_auditor.x',
    eventTypes,
    work: { title, objective: 'Look at {{recordId}}', priority: 10 },
    maxPerRun: 3,
    maxCausalDepth: 2,
  });
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ subscriptions: [sub(['finding.create'])] })] }), "unknown event type 'finding.create'");
  const ok = new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ subscriptions: [sub(['audit.requested'])] })] }, { extraEventTypes: ['audit.requested'] });
  assert.equal(ok.subscriptions().at(-1)!.eventTypes[0], 'audit.requested');
  rejects(
    () => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ subscriptions: [sub(['finding.created'], 'Audit {{severityLevel}}')] })] }),
    'unknown placeholder {{severityLevel}}',
  );
  rejects(
    () => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ subscriptions: [{ ...sub(['finding.created']), filter: { categories: [] } }] })] }),
    'filter/categories',
  );
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ subscriptions: [{ ...sub(['finding.created']), maxPerRun: 0 }] })] }), 'maxPerRun');
});

test('rejects output schemas that do not compile', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { condenser: { outputSchema: { type: 'nonsense' } } } }), 'outputSchema does not compile');
});

test('rejects inconsistent delegation settings and dangling role references', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { lead: { canDelegateTo: ['ghost_analyst'] } } }), "unknown role 'ghost_analyst'");
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { lead: { maxDepth: 0 } } }), 'maxDepth >= 1');
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { rca: { canDelegateTo: ['executor'] } } }), "'delegate' tool is not permitted");
  rejects(
    () => new RoleCatalog(BUILTIN_ROLES, { roles: { lead: { canDelegateTo: [] } } }),
    "'delegate' tool is permitted but canDelegateTo is empty",
  );
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { reviewer: { defaultModelPolicy: { independentFromRoles: ['exec'] } } } }), "independentFromRoles references unknown role 'exec'");
  const sub = { ...builtin('rca').subscriptions[0]!, filter: { fromRoles: ['exekutor'] } };
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { rca: { subscriptions: [sub] } } }), "filter.fromRoles references unknown role 'exekutor'");
});

test('ROLE_DEFINITION_SCHEMA is frozen: validation cannot be weakened at runtime', () => {
  assert.ok(Object.isFrozen(ROLE_DEFINITION_SCHEMA));
  assert.throws(() => {
    (ROLE_DEFINITION_SCHEMA as Record<string, unknown>)['additionalProperties'] = true;
  }, TypeError);
  assert.ok(validateRoleDefinition({ ...customRole(), extra: 1 }).length > 0);
});

test('rejects out-of-range model policy values', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { lead: { defaultModelPolicy: { minQuality: 1.5 } } } }), 'minQuality');
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { lead: { defaultModelPolicy: { requiredCapabilities: ['telepathy'] as never } } } }), 'requiredCapabilities');
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { lead: { defaultModelPolicy: { fallback: 'cheapest' as never } } } }), 'fallback');
});

test('reports every issue at once in details.issues', () => {
  const err = rejects(
    () =>
      new RoleCatalog(BUILTIN_ROLES, {
        custom: [customRole({ systemPrompt: 'no slot', toolPolicy: { allow: ['fs.reads', 'complete_work', 'fail_work'] } })],
      }),
  );
  const issues = err.details['issues'] as string[];
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.startsWith('security_auditor: ')));
});

test('validateRoleDefinition returns schema issues for garbage input instead of throwing', () => {
  assert.ok(validateRoleDefinition(null).length > 0);
  assert.ok(validateRoleDefinition({}).length > 0);
  assert.ok(validateRoleDefinition({ ...customRole(), extra: 1 }).some((i) => i.includes('additional properties')));
  assert.deepEqual(validateRoleDefinition(customRole()), []);
  assert.equal((ROLE_DEFINITION_SCHEMA['required'] as string[]).includes('outputSchema'), false, 'outputSchema is optional');
});

test('rejects a subscription ruleId repeated within one role', () => {
  const sub = { ruleId: 'security_auditor.x', eventTypes: ['finding.created'], work: { title: 'Audit {{title}}', objective: 'Audit {{recordId}}', priority: 10 }, maxPerRun: 3, maxCausalDepth: 2 };
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ subscriptions: [sub, { ...sub, eventTypes: ['finding.confirmed'] }] })] }), "duplicate subscription ruleId 'security_auditor.x'");
});

test('rejects role ids and rule ids that name Object.prototype members (unsafe as plain-object keys downstream)', () => {
  for (const role of ['constructor', 'prototype']) rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ role })] }), '/role');
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { lead: { canDelegateTo: ['constructor'] } } }), 'canDelegateTo');
  const sub = { ruleId: 'constructor', eventTypes: ['finding.created'], work: { title: 'T', objective: 'O', priority: 1 }, maxPerRun: 1, maxCausalDepth: 1 };
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ subscriptions: [sub] })] }), 'ruleId');
  assert.doesNotThrow(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ role: 'constructor_auditor' })] }), 'only the exact names are reserved');
});

test('rejects workspace-writing tools outside an isolated worktree (built-in, override and custom)', () => {
  const writer = { allow: ['fs.read', 'fs.apply_patch', 'complete_work', 'fail_work'] };
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ toolPolicy: writer })] }), "holds workspace-writing tools (fs.apply_patch) but workspace is 'shared_readonly'");
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ toolPolicy: writer, workspace: 'scratch' })] }), "workspace is 'scratch'");
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { test_designer: { workspace: 'shared_readonly' } } }), 'fs.write, fs.apply_patch, git.commit');
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { lead: { toolPolicy: { allow: [...builtin('lead').toolPolicy.allow, 'git.*'] } } } }), 'git.commit');
  // Allowed: an isolated worktree, or a glob whose writing members are denied.
  assert.doesNotThrow(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ toolPolicy: writer, workspace: 'isolated_worktree' })] }));
  const readGit = { allow: ['git.*', 'complete_work', 'fail_work'], deny: ['git.commit'] };
  assert.doesNotThrow(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ toolPolicy: readGit })] }));
});

test('rejects malformed placeholders that would survive rendering verbatim', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { reviewer: { systemPrompt: '{{protocol}} Goal: {{run goal}}' } } }), 'malformed placeholder {{run goal}}');
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { roles: { reviewer: { systemPrompt: '{{protocol}} {{}}' } } }), 'malformed placeholder {{}}');
  const sub = { ruleId: 'security_auditor.x', eventTypes: ['finding.created'], work: { title: 'Audit {{ record id }}', objective: 'O', priority: 1 }, maxPerRun: 1, maxCausalDepth: 1 };
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ subscriptions: [sub] })] }), "work.title contains malformed placeholder {{ record id }}");
  assert.deepEqual(validateRoleDefinition(customRole({ systemPrompt: '{{ protocol }} JSON like {"a": {"b": 1}} is fine' })), []);
});

test('rejects malformed catalog options with invalid_argument (not a TypeError)', () => {
  rejects(() => new RoleCatalog(BUILTIN_ROLES, {}, null as never), 'options must be an object');
  rejects(() => new RoleCatalog(BUILTIN_ROLES, {}, { extraToolIds: 'custom.lint' as never }), 'options.extraToolIds');
  rejects(() => new RoleCatalog(BUILTIN_ROLES, {}, { extraEventTypes: [''] }), 'options.extraEventTypes');
});

test('rejects contradictory or dangling actor-role filters', () => {
  const sub = (filter: object) => ({ ruleId: 'security_auditor.x', eventTypes: ['finding.created'], filter, work: { title: 'T', objective: 'O', priority: 1 }, maxPerRun: 1, maxCausalDepth: 1 });
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ subscriptions: [sub({ fromRoles: ['executor', 'rca'], excludeFromRoles: ['rca'] })] })] }), 'both requires and excludes actor roles: rca');
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ subscriptions: [sub({ excludeFromRoles: ['metrics_analist'] })] })] }), "filter.excludeFromRoles references unknown role 'metrics_analist'");
  rejects(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ subscriptions: [sub({ excludeFromRoles: [] })] })] }), 'excludeFromRoles');
  assert.doesNotThrow(() => new RoleCatalog(BUILTIN_ROLES, { custom: [customRole({ subscriptions: [sub({ excludeFromRoles: ['security_auditor'] })] })] }), 'a role may exclude itself');
});
