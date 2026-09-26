import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HypertestError } from '@hypertest/core';
import { DEFAULT_POLICY_RULES } from '@hypertest/policy';
import { DEFAULT_SHELL_ALLOWLIST } from '@hypertest/tools';
import { tempDir } from '@hypertest/testkit';
import {
  ROUTE_DEFAULTS, completeRoute, defaultConfig, interpolateConfig, loadConfig, mergeConfig, providerCompatibilityClass, validateConfig, validateRunOverrides, type HypertestConfig,
} from '../src/index.ts';
import { atLeastAsSevere } from '@hypertest/domain';

function withModels(models: unknown, extra: Record<string, unknown> = {}): HypertestConfig {
  return { ...defaultConfig(), models, ...extra } as HypertestConfig;
}

describe('defaultConfig', () => {
  test('defaults: pglite at <dataDir>/db, in-process bus, local durable (4 turns), fs artifacts, no models, native engine, loopback sandbox', () => {
    const c = defaultConfig();
    assert.deepEqual(c.project, { name: 'hypertest', dataDir: '.hypertest' });
    assert.deepEqual(c.store, { kind: 'pglite', dataDir: join('.hypertest', 'db') });
    assert.deepEqual(c.bus, { kind: 'inprocess' });
    assert.deepEqual(c.durable, { kind: 'local', maxConcurrentTurns: 4 });
    assert.deepEqual(c.artifacts, { kind: 'fs', root: join('.hypertest', 'artifacts') });
    assert.deepEqual(c.models, { providers: [], routes: [] });
    assert.deepEqual(c.engines, { default: 'native' });
    assert.deepEqual(c.sandbox, { kind: 'local', network: 'loopback', envAllowlist: ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'] });
    assert.equal(c.sandbox!.envAllowlist!.includes('NODE_OPTIONS'), false);
    assert.deepEqual(c.tools, { shellAllowlist: [...DEFAULT_SHELL_ALLOWLIST], httpAllowlist: [], enableBrowser: false });
    assert.deepEqual(c.memory, { kind: 'sql' });
    assert.deepEqual(validateConfig(c), []);
  });

  test('overrides deep-merge; derived paths follow project.dataDir; arrays replace', () => {
    const c = defaultConfig({ project: { dataDir: '/srv/ht' }, tools: { shellAllowlist: ['node'] }, durable: { maxConcurrentTurns: 2 } });
    assert.equal(c.project.name, 'hypertest');
    assert.deepEqual(c.store, { kind: 'pglite', dataDir: '/srv/ht/db' });
    assert.deepEqual(c.artifacts, { kind: 'fs', root: '/srv/ht/artifacts' });
    assert.deepEqual(c.tools!.shellAllowlist, ['node']);
    assert.equal(c.tools!.enableBrowser, false);
    assert.deepEqual(c.durable, { kind: 'local', maxConcurrentTurns: 2 });
  });

  test('a section whose kind changes is replaced, never merged (no pglite dataDir under postgres)', () => {
    const c = defaultConfig({ store: { kind: 'postgres', urlEnv: 'HT_PG_URL' }, durable: { kind: 'temporal', address: '127.0.0.1:7233' } });
    assert.deepEqual(c.store, { kind: 'postgres', urlEnv: 'HT_PG_URL' });
    assert.deepEqual(c.durable, { kind: 'temporal', address: '127.0.0.1:7233' });
    assert.deepEqual(validateConfig(c), []);
  });

  test('prototype-polluting keys are refused', () => {
    const patch = JSON.parse('{"project":{"__proto__":{"polluted":true}}}') as unknown;
    assert.throws(() => mergeConfig(defaultConfig(), patch), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument' && /forbidden key '__proto__'/.test(e.message));
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });
});

describe('interpolation: ${VAR} for non-secret fields only', () => {
  const env = { HT_BASE: 'http://127.0.0.1:9000/v1', HT_NAME: 'shop', OPENAI_KEY: 'sk-live-SECRET', HT_TOKEN: 'tok-SECRET' };

  test('non-secret values are interpolated; defaults and $${ escapes work; keys and *Env names stay literal', () => {
    const out = interpolateConfig(
      { project: { name: 'p-${HT_NAME}', dataDir: '${HT_MISSING:-/tmp/ht}' }, note: 'literal $${HT_NAME}', models: { providers: [{ id: 'o', kind: 'openai-compatible', baseUrl: '${HT_BASE}', apiKeyEnv: 'OPENAI_KEY' }] } },
      env,
    ) as Record<string, any>;
    assert.equal(out['project'].name, 'p-shop');
    assert.equal(out['project'].dataDir, '/tmp/ht');
    assert.equal(out['note'], 'literal ${HT_NAME}');
    assert.equal(out['models'].providers[0].baseUrl, 'http://127.0.0.1:9000/v1');
    assert.equal(out['models'].providers[0].apiKeyEnv, 'OPENAI_KEY', 'the *Env field names the variable; its value is never substituted');
    assert.equal(JSON.stringify(out).includes('SECRET'), false);
  });

  test('a variable named by a *Env field is a secret: interpolating it anywhere is refused and its value never appears', () => {
    const input = { models: { providers: [{ id: 'o', kind: 'openai-compatible', baseUrl: 'http://x/${OPENAI_KEY}', apiKeyEnv: 'OPENAI_KEY' }] } };
    assert.throws(
      () => interpolateConfig(input, env),
      (e: unknown) => e instanceof HypertestError && /\$\.models\.providers\[0\]\.baseUrl: 'OPENAI_KEY' holds a secret/.test(e.message) && !e.message.includes('sk-live'),
    );
  });

  test('credential-looking variables are refused even when no *Env field names them', () => {
    assert.throws(() => interpolateConfig({ project: { name: '${HT_TOKEN}' } }, env), (e: unknown) => e instanceof HypertestError && /'HT_TOKEN' looks like a credential/.test(e.message) && !e.message.includes('tok-SECRET'));
  });

  test('*Env fields are never interpolated; missing variables and malformed references are reported together', () => {
    assert.throws(
      () => interpolateConfig({ a: { apiKeyEnv: '${HT_NAME}' }, b: '${HT_NOPE}', c: '${1BAD}' }, env),
      (e: unknown) =>
        e instanceof HypertestError &&
        /\$\.a\.apiKeyEnv: \*Env fields name an environment variable and are never interpolated/.test(e.message) &&
        /\$\.b: environment variable 'HT_NOPE' is not set/.test(e.message) &&
        /\$\.c: invalid variable reference/.test(e.message),
    );
  });
});

describe('loadConfig', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => {
    dir = await tempDir('ht-app-config-');
    await mkdir(join(dir.path, 'conf'), { recursive: true });
  });
  after(async () => dir.cleanup());

  test('YAML: interpolation, merge over defaults, relative paths resolved against the config directory', async () => {
    const file = join(dir.path, 'conf', 'hypertest.config.yaml');
    await writeFile(
      file,
      [
        'version: 1',
        'project: { name: "${HT_PROJECT}" }',
        'bugate: { path: ../bugate }',
        'signing: { keyFile: keys/sign.pem }',
        'models:',
        '  providers:',
        '    - { id: local, kind: openai-compatible, baseUrl: "${HT_BASE:-http://127.0.0.1:11434/v1}", apiKeyEnv: LOCAL_API_KEY }',
        '  routes:',
        '    - { routeId: local-small, provider: local, model: qwen }',
        'gate: { requireIndependentReview: false }',
      ].join('\n'),
    );
    const c = await loadConfig(file, { env: { HT_PROJECT: 'shop', LOCAL_API_KEY: 'never-read-at-load' } });
    const confDir = join(dir.path, 'conf');
    assert.equal(c.project.name, 'shop');
    assert.equal(c.project.dataDir, join(confDir, '.hypertest'), 'the default data directory lives next to the configuration');
    assert.deepEqual(c.store, { kind: 'pglite', dataDir: join(confDir, '.hypertest', 'db') });
    assert.deepEqual(c.artifacts, { kind: 'fs', root: join(confDir, '.hypertest', 'artifacts') });
    assert.equal(c.bugate!.path, join(dir.path, 'bugate'));
    assert.equal(c.signing!.keyFile, join(confDir, 'keys', 'sign.pem'));
    assert.deepEqual(c.models.providers, [{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'LOCAL_API_KEY' }]);
    assert.equal(JSON.stringify(c).includes('never-read-at-load'), false);
    assert.deepEqual(c.gate, { requireIndependentReview: false });
    assert.deepEqual(c.durable, { kind: 'local', maxConcurrentTurns: 4 });
  });

  test('JSON files are accepted; a missing apiKeyEnv variable is not a load error (doctor reports it)', async () => {
    const file = join(dir.path, 'conf', 'ht.json');
    await writeFile(file, JSON.stringify({ project: { name: 'j', dataDir: '/var/ht' }, models: { providers: [{ id: 'a', kind: 'anthropic', apiKeyEnv: 'HT_UNSET_ANTHROPIC_KEY' }], routes: [{ routeId: 'claude', provider: 'a', model: 'claude-x' }] } }));
    const c = await loadConfig(file, { env: {} });
    assert.equal(c.project.dataDir, '/var/ht');
    assert.deepEqual(c.store, { kind: 'pglite', dataDir: '/var/ht/db' });
    assert.equal(c.models.routes[0]!.routeId, 'claude');
  });

  test('failures: missing file, invalid YAML, non-mapping document, invalid configuration (all problems listed)', async () => {
    await assert.rejects(loadConfig(join(dir.path, 'nope.yaml')), (e: unknown) => e instanceof HypertestError && e.code === 'not_found');
    const bad = join(dir.path, 'bad.yaml');
    await writeFile(bad, 'project: [unclosed');
    await assert.rejects(loadConfig(bad), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument' && /is not valid YAML/.test(e.message));
    const list = join(dir.path, 'list.yaml');
    await writeFile(list, '- a\n- b\n');
    await assert.rejects(loadConfig(list), (e: unknown) => e instanceof HypertestError && /must contain a mapping at the top level/.test(e.message));
    const invalid = join(dir.path, 'invalid.yaml');
    await writeFile(invalid, 'modelz: {}\nmodels:\n  providers: [{ id: o, kind: openai }]\n  routes: [{ routeId: r, provider: ghost, model: m }]\n');
    await assert.rejects(loadConfig(invalid, { env: {} }), (e: unknown) => {
      assert.ok(e instanceof HypertestError && e.code === 'invalid_argument');
      assert.match(e.message, /unknown configuration key 'modelz'/);
      assert.match(e.message, /models\.providers\[0\] \(o\)\.kind: unknown provider kind "openai" \(expected one of openai-compatible, anthropic, pi-ai, scripted\)/);
      assert.match(e.message, /models\.routes\[0\] \(r\)\.provider: provider 'ghost' is not declared in models\.providers/);
      assert.deepEqual((e.details as { errors: string[] }).errors.length, 3);
      return true;
    });
  });

  test('secrets in the file are refused: inline apiKey, credential headers, interpolated secret variables', async () => {
    const file = join(dir.path, 'secret.yaml');
    await writeFile(file, 'models:\n  providers:\n    - { id: o, kind: openai-compatible, baseUrl: "http://h/v1", apiKey: sk-inline, headers: { Authorization: "Bearer x" } }\n  routes: []\n');
    await assert.rejects(loadConfig(file, { env: {} }), (e: unknown) => {
      assert.ok(e instanceof HypertestError);
      assert.match(e.message, /models\.providers\[0\] \(o\)\.apiKey: inline secrets are not allowed; set a \*Env field/);
      assert.match(e.message, /headers\.Authorization: credential headers are not allowed in the configuration; set apiKeyEnv/);
      return true;
    });
    const interp = join(dir.path, 'interp.yaml');
    await writeFile(interp, 'models:\n  providers:\n    - { id: o, kind: openai-compatible, baseUrl: "http://h/${MY_SECRET_KEY}", apiKeyEnv: MY_SECRET_KEY }\n  routes: []\n');
    await assert.rejects(loadConfig(interp, { env: { MY_SECRET_KEY: 'sk-123' } }), (e: unknown) => e instanceof HypertestError && /holds a secret/.test(e.message) && !e.message.includes('sk-123'));
  });
});

describe('validateConfig', () => {
  const provider = { id: 'o', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' };

  test('a complete valid configuration has no problems', () => {
    const c = withModels({ providers: [provider, { id: 'c', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' }, { id: 'p', kind: 'pi-ai', piProvider: 'openai' }], routes: [{ routeId: 'r1', provider: 'o', model: 'm' }] });
    assert.deepEqual(validateConfig(c), []);
  });

  test('model problems: duplicate/reserved provider ids, missing baseUrl/piProvider, bad env names, invalid route fields, pinned anthropic tag', () => {
    const errors = validateConfig(
      withModels({
        providers: [provider, { ...provider }, { id: 'engine:x', kind: 'scripted' }, { id: 'n', kind: 'openai-compatible', apiKeyEnv: 'bad-name' }, { id: 'pi', kind: 'pi-ai' }, { id: 'a', kind: 'anthropic' }],
        routes: [
          { routeId: 'r', provider: 'o', model: 'm', quality: { default: 1.5 }, capabilities: ['telepathy'] },
          { routeId: 'r', provider: 'a', model: 'claude', continuationCompatibilityClass: 'other' },
          { routeId: 'x', provider: 'o', model: 'm', bogus: true },
        ],
      }),
    );
    assert.ok(errors.includes("models.providers[1] (o).id: duplicate provider id 'o'"), errors.join('\n'));
    assert.ok(errors.includes("models.providers[2] (engine:x).id: the 'engine:' prefix is reserved for engine adapters in runtime manifests"));
    assert.ok(errors.includes('models.providers[3] (n).baseUrl is required'));
    assert.ok(errors.includes('models.providers[3] (n).apiKeyEnv must name an environment variable ([A-Za-z_][A-Za-z0-9_]*), got "bad-name"'));
    assert.ok(errors.includes('models.providers[4] (pi).piProvider is required'));
    assert.ok(errors.some((e) => /^models\.routes\[0\] \(r\)\.quality\.default: must be <= 1$/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /^models\.routes\[0\] \(r\)\.capabilities\.0: must be equal to one of the allowed values$/.test(e)), errors.join('\n'));
    assert.ok(errors.includes('models.routes[1] (r).routeId: duplicate route id'));
    assert.ok(errors.includes("models.routes[1] (r).continuationCompatibilityClass must equal the provider's tag 'anthropic:claude'"));
    assert.ok(errors.some((e) => e.startsWith("models.routes[2] (x): unknown key 'bogus'")));
  });

  test('infrastructure problems: postgres password in url, unknown engine, invalid rules, secret env allowlist, environments', () => {
    const errors = validateConfig({
      ...defaultConfig(),
      store: { kind: 'postgres', url: 'postgres://u:hunter2@db/ht' },
      bus: { kind: 'nats', servers: [] },
      durable: { kind: 'temporal' },
      engines: { default: 'dsh' },
      policy: { rules: [{ id: 'bad' }, { id: 'ok-1', description: 'x', match: {}, decision: 'allow' }, { id: 'ok-1', description: 'y', match: {}, decision: 'deny' }] },
      sandbox: { kind: 'oci', envAllowlist: ['PATH', 'GITHUB_TOKEN'] },
      environments: [{ environmentId: 'e', environmentClass: 'local' }, { environmentId: 'e', environmentClass: 'local', generation: 0, control: { kind: 'ssh', target: 't' } }],
      roles: { lead: { nonsense: true } },
    } as unknown as HypertestConfig);
    const expected = [
      'store.url must not contain a password; put the URL in an environment variable and set store.urlEnv',
      'bus.servers must be a server URL or a non-empty list of them',
      'durable.address is required',
      'engines.default: "dsh" is not a registered engine (native, pi)',
      "policy.rules[2] (ok-1).id: duplicate rule id 'ok-1'",
      'sandbox.image is required',
      "sandbox.envAllowlist: 'GITHUB_TOKEN' looks like a credential; secrets are never passed to sandboxed processes",
      'environments[0].generation is required (an integer ≥ 0)',
      "environments[1].environmentId: duplicate environment 'e'",
      'environments[1].control.kind must be one of process, docker, kubectl, got "ssh"',
    ];
    for (const e of expected) assert.ok(errors.includes(e), `missing: ${e}\n${errors.join('\n')}`);
    assert.ok(errors.some((e) => e.startsWith('policy.rules[0] (bad): must have required property')), errors.join('\n'));
    assert.ok(errors.some((e) => e.startsWith("roles: role override for 'lead': unknown key 'nonsense'")), errors.join('\n'));
  });

  test('models.defaultPolicy is validated as applied to every role', () => {
    const errors = validateConfig({ ...defaultConfig(), models: { providers: [], routes: [], defaultPolicy: { minQuality: 7 } } } as unknown as HypertestConfig);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /^models\.defaultPolicy: invalid role catalog: lead: \/defaultModelPolicy\/minQuality must be <= 1; /);
    assert.deepEqual(validateConfig({ ...defaultConfig(), models: { providers: [], routes: [], defaultPolicy: 'x' } } as unknown as HypertestConfig), ['models.defaultPolicy must be a mapping']);
  });

  test('a policy rule may not reuse a built-in rule id', () => {
    const builtinId = DEFAULT_POLICY_RULES[0]!.id;
    const errors = validateConfig({ ...defaultConfig(), policy: { rules: [{ id: builtinId, description: 'x', match: { effects: ['read'] }, decision: 'allow' }] } } as HypertestConfig);
    assert.deepEqual(errors, [`policy.rules[0] (${builtinId}).id: '${builtinId}' is a built-in rule id; choose another id`]);
    const fresh = validateConfig({ ...defaultConfig(), policy: { rules: [{ id: 'site.allow-reads', description: 'x', match: { effects: ['read'] }, decision: 'allow' }] } } as HypertestConfig);
    assert.deepEqual(fresh, []);
  });

  test('secrets hidden in other places are refused: credential-named headers, credential query parameters, NATS userinfo, inline control tokens', () => {
    const errors = validateConfig({
      ...defaultConfig(),
      store: { kind: 'postgres', url: 'postgres://ht@db/ht?sslmode=require&password=hunter2' },
      bus: { kind: 'nats', servers: ['nats://127.0.0.1:4222', 'nats://s3cr3t-token@nats.internal:4222'] },
      models: { providers: [{ ...provider, headers: { 'X-Auth-Token': 't', 'x-access-token': 't', 'OpenAI-Organization': 'org-1' } }], routes: [] },
      environments: [
        { environmentId: 'svc', environmentClass: 'local', generation: 0, control: { kind: 'process', target: 'http://127.0.0.1:9100/__hypertest#token=abc' } },
        { environmentId: 'k8s', environmentClass: 'staging', generation: 0, control: { kind: 'kubectl', target: 'deploy/shop', tokenEnv: 'K8S_TOKEN' } },
        { environmentId: 'bad', environmentClass: 'local', generation: 0, control: { kind: 'process', target: 'http://127.0.0.1:9101/__hypertest', tokenEnv: 'not-a-name' } },
      ],
    } as unknown as HypertestConfig);
    assert.deepEqual(errors, [
      "store.url must not carry credentials (query parameter 'password'); put the URL in an environment variable and set store.urlEnv",
      'bus.servers must not embed credentials (user, password or token)',
      'models.providers[0] (o).headers.X-Auth-Token: credential headers are not allowed in the configuration; set apiKeyEnv',
      'models.providers[0] (o).headers.x-access-token: credential headers are not allowed in the configuration; set apiKeyEnv',
      'environments[0].control.target: inline control tokens are not allowed; set control.tokenEnv to the NAME of the variable holding the token',
      'environments[1].control.tokenEnv is only valid for kind process (the process supervisor\'s control token)',
      'environments[2].control.tokenEnv must name an environment variable ([A-Za-z_][A-Za-z0-9_]*), got "not-a-name"',
    ]);
    const ok = validateConfig({
      ...defaultConfig(),
      store: { kind: 'postgres', url: 'postgres://ht@db/ht?sslmode=verify-full&sslkey=/etc/ht/client.key' },
      environments: [{ environmentId: 'svc', environmentClass: 'local', generation: 0, control: { kind: 'process', target: 'http://127.0.0.1:9100/__hypertest', tokenEnv: 'SVC_SUPERVISOR' } }],
    } as unknown as HypertestConfig);
    assert.deepEqual(ok, [], 'sslkey is a file path; tokenEnv names a variable');
  });

  test('budget caps the control plane requires as integers are validated at load (not at the first start)', () => {
    const errors = validateConfig({ ...defaultConfig(), budget: { maxWorkItems: 0, maxAgentDepth: 1.5, maxWallClockMs: 60_000, maxModelCostUsd: 2.5, maxToolCalls: -1 } } as unknown as HypertestConfig);
    assert.deepEqual(errors, ['budget.maxWorkItems must be an integer ≥ 1', 'budget.maxAgentDepth must be an integer ≥ 0', 'budget.maxToolCalls must be an integer ≥ 1']);
    assert.deepEqual(validateConfig({ ...defaultConfig(), budget: { maxAgentDepth: 0, maxModelCostUsd: 0.5 } } as unknown as HypertestConfig), []);
  });

  test("a run's own gate/budget overrides get the configuration's rules (an unknown severity would silently disable C2)", () => {
    // why: the gate compares severities by order; an unknown threshold makes no finding "at least as severe"
    assert.equal(atLeastAsSevere('P0', 'P9' as never), false);
    assert.deepEqual(
      validateRunOverrides({
        gate: { failOnUnresolvedSeverity: 'p1', requiredEvidence: [{ evidenceType: 'test-result', minCount: 0 }, { minCount: 1 }, 'x'], minCoverage: { lines: 180 }, sneaky: true },
        budget: { maxToolCalls: 0.5 },
      }),
      [
        'budget.maxToolCalls must be an integer ≥ 1',
        "gate: unknown key 'sneaky' (expected one of gateId, description, failOnUnresolvedSeverity, conditionalOnRiskLevel, requiredEvidence, requireDeterministicForCritical, requireIndependentReview, minCoverage)",
        'gate.failOnUnresolvedSeverity must be one of P0, P1, P2, P3, P4, got "p1"',
        'gate.requiredEvidence[0].minCount must be an integer ≥ 1, got 0',
        'gate.requiredEvidence[1].evidenceType is required',
        'gate.requiredEvidence[2] must be a mapping',
        'gate.minCoverage.lines must be a number in [0, 100] (a ratio ≤ 1 or a percentage)',
      ],
    );
    assert.deepEqual(validateRunOverrides({ gate: { failOnUnresolvedSeverity: 'P2', requiredEvidence: [{ evidenceType: 'metric', minCount: 2, critical: true }], minCoverage: { lines: 0.8 } }, budget: { maxAgentDepth: 0 } }), []);
    assert.deepEqual(validateRunOverrides({}), []);
    // the configuration's gate follows the same rules
    assert.deepEqual(validateConfig({ ...defaultConfig(), gate: { failOnUnresolvedSeverity: 'P9' } } as unknown as HypertestConfig), ['gate.failOnUnresolvedSeverity must be one of P0, P1, P2, P3, P4, got "P9"']);
  });

  test('validation never reads the environment (missing API key variables are not load errors)', () => {
    const c = withModels({ providers: [{ ...provider, apiKeyEnv: 'HT_SURELY_UNSET_VARIABLE_1234' }], routes: [] });
    assert.deepEqual(validateConfig(c), []);
  });
});

describe('route completion', () => {
  test('ROUTE_DEFAULTS fill every absent field; the provider tag is the continuation class', () => {
    const p = completeRoute({ routeId: 'r', provider: 'o', model: 'm' }, 'o:m');
    assert.deepEqual(p, {
      ...ROUTE_DEFAULTS, capabilities: ['tool_use', 'structured_output'], quality: { default: 0.7 }, routeId: 'r', provider: 'o', model: 'm', continuationCompatibilityClass: 'o:m',
    });
    assert.equal(p.contextWindow, 128_000);
    assert.equal(p.maxDataClassification, 'confidential');
    assert.equal(p.maxActionRisk, 'high');
    const custom = completeRoute({ routeId: 'r', provider: 'o', model: 'm', quality: { default: 0.9, lead: 0.95 }, enabled: false }, 'o:m');
    assert.deepEqual(custom.quality, { default: 0.9, lead: 0.95 });
    assert.equal(custom.enabled, false);
  });

  test('provider tags: anthropic:<model>, <providerId>:<model> for openai-compatible/scripted, pi-ai resolved later', () => {
    assert.equal(providerCompatibilityClass({ id: 'claude', kind: 'anthropic' }, 'claude-x'), 'anthropic:claude-x');
    assert.equal(providerCompatibilityClass({ id: 'local', kind: 'openai-compatible', baseUrl: 'http://h' }, 'qwen'), 'local:qwen');
    assert.equal(providerCompatibilityClass({ id: 'sim', kind: 'scripted' }, 'sim-1'), 'sim:sim-1');
    assert.equal(providerCompatibilityClass({ id: 'pi', kind: 'pi-ai', piProvider: 'openai' }, 'gpt'), undefined);
  });
});
