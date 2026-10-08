/**
 * `hypertest init` (template content, validity, secrets hygiene, .gitignore, overwrite protection) and
 * `hypertest doctor` over temporary configurations (--no-connect: hermetic; infrastructure probes live in
 * doctor.int.test.ts).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '@hypertest/app';
import { tempDir } from '@hypertest/testkit';
import { GITIGNORE_ENTRIES, MIN_NODE_VERSION, TEMPLATE_KEY_VARIABLES, configTemplate, nodeVersionCheck, projectNameFrom, writeConfigAtomically, type DoctorReport } from '../src/index.ts';
import { cli, parseJson } from './helpers.ts';

/** Uncomments the `# `-prefixed block starting at the line containing `marker` (up to the first line that is not a comment). */
function uncommentBlock(text: string, marker: string): string {
  const lines = text.split('\n');
  let i = lines.findIndex((l) => l.includes(marker));
  assert.ok(i >= 0, `marker ${marker} not found`);
  for (; i < lines.length && /^\s*# /.test(lines[i]!); i++) lines[i] = lines[i]!.replace(/^(\s*)# /, '$1');
  return lines.join('\n');
}

const NO_KEYS = { DEEPSEEK_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, HYPERTEST_CONFIG: undefined };
const SENTINELS = { DEEPSEEK_API_KEY: 'sk-SENTINEL-deepseek-0123456789', ANTHROPIC_API_KEY: 'sk-ant-SENTINEL-0123456789' };

describe('hypertest init', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => {
    dir = await tempDir('ht-cli-init-');
  });
  after(async () => {
    await dir.cleanup();
  });

  test('writes a template that loads and validates, names keys only through apiKeyEnv, and ignores the data directory', async () => {
    const project = join(dir.path, 'shop');
    await mkdir(project);
    const r = await cli(['init'], { cwd: project, env: NO_KEYS });
    assert.equal(r.code, 0, r.stderr);
    const file = join(project, 'hypertest.config.yaml');
    assert.match(r.stdout, new RegExp(`^wrote ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\ncreated `));
    const text = await readFile(file, 'utf8');
    assert.equal(text, configTemplate('shop'));
    const config = await loadConfig(file, { env: {} });
    assert.equal(config.project.name, 'shop');
    assert.equal(config.project.dataDir, join(project, '.hypertest'));
    // providers: DeepSeek (openai-compatible), Anthropic; the local model is a commented example
    assert.deepEqual(config.models.providers.map((p) => [p.id, p.kind, p.apiKeyEnv ?? null]), [['deepseek', 'openai-compatible', 'DEEPSEEK_API_KEY'], ['anthropic', 'anthropic', 'ANTHROPIC_API_KEY']]);
    assert.equal(config.models.providers[0]!.baseUrl, 'https://api.deepseek.com/v1');
    assert.deepEqual(config.models.routes.map((x) => `${x.routeId}:${x.provider}:${x.model}`), ['deepseek-chat:deepseek:deepseek-chat', 'claude-opus:anthropic:claude-opus-5', 'claude-sonnet:anthropic:claude-sonnet-5']);
    assert.match(text, /^ {4}# - id: local\n {4}# {3}kind: openai-compatible\n {4}# {3}baseUrl: "\$\{LOCAL_LLM_URL:-http:\/\/127\.0\.0\.1:11434\/v1\}"$/m);
    // per-role model policies
    assert.deepEqual(Object.keys(config.roles ?? {}).sort(), ['condenser', 'executor', 'lead', 'rca', 'reviewer', 'test_designer']);
    // H10: the generated reviewer override keeps EVERY evidence producer (an array replaces the catalog default)
    assert.deepEqual(config.roles!['reviewer']!.defaultModelPolicy, {
      preferredRoutes: ['claude-sonnet', 'claude-opus'], independentFromRoles: ['executor', 'test_designer', 'rca', 'fixer', 'metrics_analyst', 'environment', 'vision_gui', 'local_private'], fallback: 'fail_closed',
    });
    assert.deepEqual(config.roles!['lead']!.defaultModelPolicy, { preferredRoutes: ['claude-opus', 'deepseek-chat'], minQuality: 0.8 });
    // secrets hygiene: no inline credential field, no key-looking value
    assert.doesNotMatch(text, /^\s*(apiKey|api_key|token|secret|password|accessKeyId|secretAccessKey)\s*:/m);
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]/);
    assert.deepEqual([...TEMPLATE_KEY_VARIABLES], ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY']);
    // .gitignore: the data directory holds the private signing keys
    assert.equal(await readFile(join(project, '.gitignore'), 'utf8'), '# Hypertest data: database, evidence and private signing keys\n.hypertest/\n');
    assert.deepEqual([...GITIGNORE_ENTRIES], ['.hypertest/']);
  });

  test('the commented local-model example is valid once uncommented', async () => {
    const project = join(dir.path, 'local');
    await mkdir(project);
    let text = configTemplate('local');
    text = uncommentBlock(text, '# - id: local');
    text = uncommentBlock(text, '# - routeId: local-coder');
    await writeFile(join(project, 'hypertest.config.yaml'), text);
    const config = await loadConfig(join(project, 'hypertest.config.yaml'), { env: { LOCAL_LLM_URL: 'http://127.0.0.1:8000/v1' } });
    const local = config.models.providers.find((p) => p.id === 'local')!;
    assert.deepEqual([local.kind, local.baseUrl, local.apiKeyEnv], ['openai-compatible', 'http://127.0.0.1:8000/v1', undefined]);
    const route = config.models.routes.find((x) => x.routeId === 'local-coder')!;
    assert.deepEqual([route.provider, route.model, route.maxDataClassification, route.structuredOutput], ['local', 'qwen2.5-coder:32b', 'restricted', 'prompted']);
    // the interpolation default applies without the variable
    const fallback = await loadConfig(join(project, 'hypertest.config.yaml'), { env: {} });
    assert.equal(fallback.models.providers.find((p) => p.id === 'local')!.baseUrl, 'http://127.0.0.1:11434/v1');
  });

  test('conformance-1: the commented oracle example is valid once uncommented and names its human authority', async () => {
    const project = join(dir.path, 'oracle');
    await mkdir(project);
    const text = uncommentBlock(configTemplate('oracle'), '# oracles:');
    await writeFile(join(project, 'hypertest.config.yaml'), text);
    const config = await loadConfig(join(project, 'hypertest.config.yaml'), { env: {} });
    assert.equal(config.oracles?.length, 1);
    assert.deepEqual([config.oracles![0]!.oracleId, config.oracles![0]!.establishedBy, config.oracles![0]!.assertions[0]!.severity], ['checkout-contract', 'alice', 'P1']);
    assert.match(configTemplate('x'), /^ {2}# requireOracle: false /m);
  });

  test('never overwrites without --force (exit 1, file untouched); --force rewrites it and leaves .gitignore alone', async () => {
    const project = join(dir.path, 'again');
    assert.equal((await cli(['init', '--dir', project], { cwd: dir.path })).code, 0);
    const file = join(project, 'hypertest.config.yaml');
    await writeFile(file, 'version: 1 # edited by hand\n');
    const refused = await cli(['init', '--dir', project], { cwd: dir.path });
    assert.equal(refused.code, 1);
    assert.equal(refused.stderr, `hypertest init: ${file} already exists (use --force to overwrite) [conflict]\n`);
    assert.equal(await readFile(file, 'utf8'), 'version: 1 # edited by hand\n');
    const forced = await cli(['init', '--dir', project, '--force', '--json'], { cwd: dir.path });
    assert.equal(forced.code, 0);
    assert.deepEqual(parseJson(forced)['gitignore'], { path: join(project, '.gitignore'), status: 'unchanged', added: [] });
    assert.equal(await readFile(file, 'utf8'), configTemplate('again'));
    assert.equal(await readFile(join(project, '.gitignore'), 'utf8'), '# Hypertest data: database, evidence and private signing keys\n.hypertest/\n');
  });

  test('another configuration format in the directory is never shadowed, even with --force', async () => {
    const project = join(dir.path, 'json');
    await mkdir(project);
    await writeFile(join(project, 'hypertest.config.json'), '{"version":1}\n');
    const r = await cli(['init', '--force'], { cwd: project });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /hypertest\.config\.json already exists \(--force only overwrites hypertest\.config\.yaml\) \[conflict\]/);
    assert.equal(existsSync(join(project, 'hypertest.config.yaml')), false);
  });

  test('.gitignore: appended after content without a trailing newline; an existing entry variant is kept as is', async () => {
    const a = join(dir.path, 'gi-a');
    await mkdir(a);
    await writeFile(join(a, '.gitignore'), 'node_modules');
    const ra = await cli(['init', '--json', '--name', 'Gi A'], { cwd: a });
    assert.equal(ra.code, 0);
    assert.deepEqual(parseJson(ra)['gitignore'], { path: join(a, '.gitignore'), status: 'updated', added: ['.hypertest/'] });
    assert.equal(parseJson(ra)['projectName'], 'Gi A');
    assert.equal(await readFile(join(a, '.gitignore'), 'utf8'), 'node_modules\n# Hypertest data: database, evidence and private signing keys\n.hypertest/\n');
    const b = join(dir.path, 'gi-b');
    await mkdir(b);
    await writeFile(join(b, '.gitignore'), 'dist/\n/.hypertest\n');
    const rb = await cli(['init', '--json'], { cwd: b });
    assert.equal(parseJson(rb)['gitignore'] && (parseJson(rb)['gitignore'] as { status: string }).status, 'unchanged');
    assert.equal(await readFile(join(b, '.gitignore'), 'utf8'), 'dist/\n/.hypertest\n');
  });

  test('the configuration is written atomically: an existing file is never overwritten without force; no temporary file is left', async () => {
    const d = join(dir.path, 'atomic');
    await mkdir(d);
    const file = join(d, 'hypertest.config.yaml');
    await writeConfigAtomically(file, 'version: 1 # first\n', false);
    assert.equal(await readFile(file, 'utf8'), 'version: 1 # first\n');
    // a configuration that appeared meanwhile (after init's existence check) is kept: conflict
    await assert.rejects(writeConfigAtomically(file, 'version: 1 # second\n', false), (e: unknown) => (e as { code?: string }).code === 'conflict' && /already exists \(use --force to overwrite\)$/.test((e as Error).message));
    assert.equal(await readFile(file, 'utf8'), 'version: 1 # first\n');
    await writeConfigAtomically(file, 'version: 1 # forced\n', true);
    assert.equal(await readFile(file, 'utf8'), 'version: 1 # forced\n');
    assert.deepEqual(await readdir(d), ['hypertest.config.yaml']);
  });

  test('project names derive from the directory', () => {
    assert.equal(projectNameFrom('/x/My Shop!'), 'my-shop');
    assert.equal(projectNameFrom('/x/...'), 'hypertest-project');
  });
});

describe('hypertest doctor', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let project: string;
  before(async () => {
    dir = await tempDir('ht-cli-doctor-');
    project = join(dir.path, 'p');
    await mkdir(project);
    assert.equal((await cli(['init'], { cwd: project })).code, 0);
  });
  after(async () => {
    await dir.cleanup();
  });

  test('the init template with its key variables set passes (exit 0); secret values are never printed', async () => {
    const r = await cli(['doctor', '--no-connect'], { cwd: project, env: { ...SENTINELS, HYPERTEST_CONFIG: undefined } });
    assert.equal(r.code, 0, r.stdout);
    const lines = r.stdout.split('\n');
    assert.match(lines[0]!, /^\[ok {3}\] node {7}Node\.js \d+\.\d+\.\d+$/);
    assert.ok(lines.includes('[ok   ] secrets    provider deepseek (apiKeyEnv): DEEPSEEK_API_KEY is set'), r.stdout);
    assert.ok(lines.includes('[ok   ] secrets    provider anthropic (apiKeyEnv): ANTHROPIC_API_KEY is set'), r.stdout);
    assert.ok(lines.includes('[ok   ] models     3 route(s); every core role can be routed'), r.stdout);
    // specialist roles: the Claude routes see images; no route of the template takes restricted data (the local route
    // is commented out), so local_private work would fail closed — a warning, never a silent hosted fallback
    assert.ok(lines.includes('[ok   ] models     vision_gui: routed to claude-opus (vision); computer-use fallback unavailable (no route with computer_use): DOM, API and screenshot checks only'), r.stdout);
    assert.ok(lines.some((l) => /^\[WARN \] models {5}local_private: no route can take restricted data \(.*request carries restricted.*\): restricted work fails closed at routing/.test(l)), r.stdout);
    assert.ok(lines.some((l) => /^\[ok {3}\] protocol {3}BUGate \S+ \((embedded|checkout .+)\), digest [0-9a-f]{16}$/.test(l)), r.stdout);
    assert.ok(lines.some((l) => /^\[(ok {3}|WARN )\] git /.test(l)), r.stdout);
    assert.ok(lines.some((l) => /^\[info \] docker /.test(l)), r.stdout);
    assert.match(r.stdout, /\n\nok( \(\d+ warnings?\))?\n$/);
    for (const v of Object.values(SENTINELS)) assert.equal(r.stdout.includes(v) || r.stderr.includes(v), false, 'a secret value was printed');
  });

  test('missing key variables are errors naming the variables (exit 1); --json reports every check', async () => {
    const r = await cli(['doctor', '--no-connect', '--json'], { cwd: project, env: NO_KEYS });
    assert.equal(r.code, 1);
    const report = parseJson<DoctorReport>(r);
    assert.equal(report.ok, false);
    assert.equal(report.configPath, join(project, 'hypertest.config.yaml'));
    const errors = report.checks.filter((c) => c.status === 'error');
    assert.deepEqual(errors.slice(0, 2), [
      { name: 'secrets', status: 'error', detail: 'provider deepseek (apiKeyEnv): environment variable DEEPSEEK_API_KEY is not set' },
      { name: 'secrets', status: 'error', detail: 'provider anthropic (apiKeyEnv): environment variable ANTHROPIC_API_KEY is not set' },
    ]);
    // e2e[3]: a provider without its credential is unavailable (fail closed), so no route can serve the lead either
    assert.equal(errors.length, 3);
    assert.equal(errors[2]!.name, 'models');
    assert.match(errors[2]!.detail, /^no route can serve the lead role \(deepseek-chat: provider deepseek is unavailable: provider deepseek has no credential: environment variable DEEPSEEK_API_KEY is not set or empty \(fail closed: no request is sent\); claude-opus: provider anthropic is unavailable: provider anthropic has no credential: environment variable ANTHROPIC_API_KEY is not set or empty/);
    const names = report.checks.map((c) => c.name);
    assert.deepEqual(names.slice(0, 4), ['node', 'config', 'secrets', 'secrets']);
    assert.deepEqual(names.slice(-7), ['protocol', 'engines', 'sandbox', 'store', 'artifacts', 'git', 'docker']);
    assert.ok(names.slice(4, -7).every((n) => n === 'models'), names.join(','));
    // the doctor names each provider whose missing credential makes its routes unavailable (never routed to)
    assert.ok(report.checks.some((c) => c.name === 'models' && c.status === 'warn' && /^provider deepseek has no credential: .*: routes deepseek-chat are unavailable — never routed to, no request is sent/.test(c.detail)));
    const human = await cli(['doctor', '--no-connect'], { cwd: project, env: NO_KEYS });
    assert.equal(human.code, 1);
    assert.match(human.stdout, /\[ERROR\] secrets {4}provider deepseek \(apiKeyEnv\): environment variable DEEPSEEK_API_KEY is not set\n/);
    assert.match(human.stdout, /\n\n3 errors, \d+ warnings?\n$/);
  });

  test('an invalid configuration lists every problem (exit 1) without echoing inline secrets', async () => {
    const bad = join(dir.path, 'bad');
    await mkdir(bad);
    await writeFile(join(bad, 'hypertest.config.yaml'), [
      'version: 1',
      'models:',
      '  providers:',
      '    - { id: p, kind: anthropic, apiKey: sk-ant-INLINE-SECRET-42 }',
      '  routes:',
      '    - { routeId: r, provider: nope, model: m }',
      '',
    ].join('\n'));
    const r = await cli(['doctor', '--no-connect', '--json'], { cwd: bad, env: NO_KEYS });
    assert.equal(r.code, 1);
    const report = parseJson<DoctorReport>(r);
    const config = report.checks.filter((c) => c.name === 'config');
    assert.ok(config.length >= 2, JSON.stringify(config));
    assert.ok(config.every((c) => c.status === 'error' && c.detail.startsWith(`${join(bad, 'hypertest.config.yaml')}: `)));
    assert.ok(config.some((c) => /apiKey/.test(c.detail)), JSON.stringify(config));
    assert.ok(config.some((c) => /nope/.test(c.detail)), JSON.stringify(config));
    assert.equal(r.stdout.includes('INLINE-SECRET'), false, 'an inline secret was echoed');
    // the host checks still ran
    assert.deepEqual(report.checks.filter((c) => c.name !== 'config').map((c) => c.name), ['node', 'git', 'docker']);
  });

  test('no configuration: an error with the init hint (exit 1)', async () => {
    const empty = join(dir.path, 'empty');
    await mkdir(empty);
    const r = await cli(['doctor', '--json'], { cwd: empty, env: NO_KEYS });
    assert.equal(r.code, 1);
    const report = parseJson<DoctorReport>(r);
    assert.equal(report.configPath, undefined);
    assert.deepEqual(report.checks.find((c) => c.name === 'config'), {
      name: 'config', status: 'error', detail: `no hypertest.config.yaml found in ${empty} or its parent directories (run \`hypertest init\` or pass --config)`,
    });
  });

  test('scripted providers need no key; a missing BUGate checkout is a warning', async () => {
    const p = join(dir.path, 'scripted');
    await mkdir(p);
    await writeFile(join(p, 'hypertest.config.yaml'), JSON.stringify({
      version: 1,
      models: { providers: [{ id: 'sim', kind: 'scripted' }], routes: [{ routeId: 'sim', provider: 'sim', model: 's', capabilities: ['tool_use', 'structured_output', 'reasoning', 'long_context'], quality: { default: 0.9 }, maxActionRisk: 'critical', maxDataClassification: 'confidential', structuredOutput: 'native', costPerMillionInputUsd: 0, costPerMillionOutputUsd: 0 }] },
      bugate: { path: './no-bugate-here' },
    }));
    const r = await cli(['doctor', '--no-connect', '--json'], { cwd: p, env: NO_KEYS });
    const report = parseJson<DoctorReport>(r);
    assert.equal(report.checks.some((c) => c.name === 'secrets'), false);
    const protocol = report.checks.find((c) => c.name === 'protocol')!;
    assert.equal(protocol.status, 'warn');
    assert.match(protocol.detail, /^no BUGate checkout at \S+no-bugate-here \(protocol\/v2\/manifest\.yaml missing\); using the embedded protocol /);
  });

  test('nodeVersionCheck: the minimum is 22.18.0', () => {
    assert.deepEqual([...MIN_NODE_VERSION], [22, 18, 0]);
    assert.equal(nodeVersionCheck('22.18.0').status, 'ok');
    assert.equal(nodeVersionCheck('24.1.0').status, 'ok');
    assert.equal(nodeVersionCheck('22.17.9').status, 'error');
    assert.deepEqual(nodeVersionCheck('20.19.1'), { name: 'node', status: 'error', detail: 'Node.js 20.19.1 is too old: Hypertest needs ≥ 22.18.0 (native TypeScript type stripping)' });
  });
});
