/**
 * Hermetic tests of the command line itself: argument splitting and strict parsing, usage errors (exit 2), help and
 * version, the verdict → exit code mapping, configuration discovery and the --scripted-brains module contract.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HYPERTEST_VERSION, defaultConfig } from '@hypertest/app';
import { tempDir } from '@hypertest/testkit';
import { COMMANDS, EXIT_CODES, SANDBOX_ENV, UsageError, clientOnlyConfig, findConfig, loadBrainsModule, parseCommand, splitCommand, verdictExitCode } from '../src/index.ts';
import { cli } from './helpers.ts';

describe('argument parsing', () => {
  test('splitCommand finds the command after global options and keeps the rest in order', () => {
    assert.deepEqual(splitCommand(['run', 'goal', '--repo', 'x']), { command: 'run', rest: ['goal', '--repo', 'x'] });
    assert.deepEqual(splitCommand(['--config', 'run', 'status', 'r1']), { command: 'status', rest: ['--config', 'run', 'r1'] });
    assert.deepEqual(splitCommand(['-c', 'f.yaml', '--json', 'report', 'r1']), { command: 'report', rest: ['-c', 'f.yaml', '--json', 'r1'] });
    assert.deepEqual(splitCommand(['--config=f.yaml', 'doctor']), { command: 'doctor', rest: ['--config=f.yaml'] });
    assert.deepEqual(splitCommand(['--json']), { command: undefined, rest: ['--json'] });
    assert.deepEqual(splitCommand([]), { command: undefined, rest: [] });
  });

  test('parseCommand: global + command options, positionals, negation', () => {
    const r = parseCommand('run', ['goal', '--repo', 'r', '--json', '--log-level', 'debug', '--scripted-brains', 'b.ts', '-c', 'x.yaml'], { repo: { type: 'string' } });
    assert.deepEqual(r.positionals, ['goal']);
    assert.equal(r.values['repo'], 'r');
    assert.deepEqual(r.global, { json: true, help: false, logLevel: 'debug', scriptedBrains: 'b.ts', config: 'x.yaml' });
    const d = parseCommand('doctor', ['--no-connect'], { connect: { type: 'boolean', default: true } });
    assert.equal(d.values['connect'], false);
  });

  test('parseCommand: unknown options, missing values and bad log levels are usage errors', () => {
    assert.throws(() => parseCommand('run', ['--nope'], {}), (e: unknown) => e instanceof UsageError && e.command === 'run' && /--nope/.test(e.message));
    assert.throws(() => parseCommand('run', ['--repo'], { repo: { type: 'string' } }), (e: unknown) => e instanceof UsageError && /--repo/.test(e.message));
    assert.throws(() => parseCommand('run', ['--log-level', 'loud'], {}), (e: unknown) => e instanceof UsageError && /--log-level must be one of debug, info, warn, error/.test(e.message));
  });

  test('verdictExitCode: pass 0, fail 3, conditional 4, inconclusive 5, no verdict 1', () => {
    assert.equal(verdictExitCode('pass'), 0);
    assert.equal(verdictExitCode('fail'), 3);
    assert.equal(verdictExitCode('conditional'), 4);
    assert.equal(verdictExitCode('inconclusive'), 5);
    assert.equal(verdictExitCode(undefined), 1);
    assert.deepEqual({ ...EXIT_CODES }, { ok: 0, failure: 1, usage: 2, verdictFail: 3, verdictConditional: 4, verdictInconclusive: 5, interrupted: 130 });
  });
});

describe('dispatch, help and usage errors', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => {
    dir = await tempDir('ht-cli-unit-');
  });
  after(async () => {
    await dir.cleanup();
  });

  test('no arguments: general help on stderr, exit 2; --help: stdout, exit 0; version', async () => {
    const none = await cli([], { cwd: dir.path });
    assert.equal(none.code, 2);
    assert.equal(none.stdout, '');
    assert.match(none.stderr, /^hypertest \S+ — evidence-driven/);
    const help = await cli(['--help'], { cwd: dir.path });
    assert.equal(help.code, 0);
    for (const c of COMMANDS) assert.match(help.stdout, new RegExp(`\\n  ${c.name}\\s`), c.name);
    assert.match(help.stdout, /exit codes: 0 ok, 1 failure, 2 usage error; `run`: pass 0, fail 3, conditional 4, inconclusive 5; 130 interrupted/);
    for (const argv of [['--version'], ['-v'], ['version']]) {
      const v = await cli(argv, { cwd: dir.path });
      assert.deepEqual([v.code, v.stdout], [0, `${HYPERTEST_VERSION}\n`], argv.join(' '));
    }
  });

  test('command help: `hypertest <cmd> --help` and `hypertest help <cmd>`', async () => {
    const a = await cli(['run', '--help'], { cwd: dir.path });
    assert.equal(a.code, 0);
    assert.match(a.stdout, /^usage:\n {2}hypertest run "<goal>"/);
    assert.match(a.stdout, /--scripted-brains <module>/);
    assert.match(a.stdout, /Exit code: pass 0, fail 3, conditional 4, inconclusive 5/);
    const b = await cli(['help', 'run'], { cwd: dir.path });
    assert.deepEqual([b.code, b.stdout], [0, a.stdout]);
    const c = await cli(['help', 'nope'], { cwd: dir.path });
    assert.deepEqual([c.code, c.stderr], [2, 'hypertest help: unknown command "nope"\n']);
  });

  test('unknown command: exit 2 with a suggestion', async () => {
    const r = await cli(['stauts'], { cwd: dir.path });
    assert.equal(r.code, 2);
    assert.equal(r.stderr, 'hypertest: unknown command "stauts" (did you mean `status`?); run `hypertest --help`\n');
  });

  test('usage errors exit 2 before anything is opened (unknown option, missing positional, bad numbers, missing --by)', async () => {
    const cases: Array<[string[], RegExp]> = [
      [['status', '--bogus'], /^hypertest status: Unknown option '--bogus'/],
      [['report'], /^hypertest report: missing <runId>\n/],
      [['report', 'a', 'b'], /^hypertest report: unexpected argument: b\n/],
      [['run'], /^hypertest run: missing <goal>\n/],
      [['run', '   ', '--repo', '.'], /^hypertest run: the goal must not be empty\n/],
      [['run', 'goal'], /^hypertest run: a target is required: --repo <path>, --url <sutUrl> and\/or --environment <id>\n/],
      [['run', 'goal', '--url', 'x'], /^hypertest run: --url must be an absolute http\(s\) URL \(got "x"\)\n/],
      [['run', 'goal', '--url', 'ftp://h/x'], /^hypertest run: --url must be an http\(s\) URL \(got "ftp:\/\/h\/x"\)\n/],
      [['run', 'goal', '--commit', 'HEAD', '--url', 'http://h'], /^hypertest run: --commit\/--base need --repo\n/],
      [['run', 'goal', '--repo', 'does-not-exist'], /^hypertest run: --repo \S+does-not-exist is not a directory\n/],
      [['run', 'goal', '--url', 'http://h', '--label', 'novalue'], /^hypertest run: --label must be key=value \(got "novalue"\)\n/],
      [['run', 'goal', '--url', 'http://h', '--label', ' =v'], /^hypertest run: --label must be key=value \(got " =v"\)\n/],
      [['run', 'goal', '--repo', '.', '--commit=--output=/tmp/x'], /^hypertest run: --commit must be a commit-ish \(got "--output=\/tmp\/x"\)\n/],
      [['run', 'goal', '--url', 'http://h', '--timeout-ms', '0'], /^hypertest run: --timeout-ms must be an integer ≥ 1 \(got "0"\)\n/],
      [['status', '--limit', 'ten'], /^hypertest status: --limit must be an integer between 1 and 10000 \(got "ten"\)\n/],
      [['status', '--status', 'running,bogus'], /^hypertest status: --status: unknown run status "bogus"/],
      [['approve', 'appr_1', '--reason', 'ok'], /^hypertest approve: --by is required\n/],
      [['approve', 'appr_1', '--by', 'alice'], /^hypertest approve: --reason is required\n/],
      [['approve', 'appr_1', '--by', '   ', '--reason', 'r'], /^hypertest approve: --by is required\n/],
      [['approve', 'appr_1', '--by', 'al;ce', '--reason', 'r'], /^hypertest approve: --by must be a person's name or handle/],
      [['approvals', '--status', 'pending', '--all'], /^hypertest approvals: --status and --all are mutually exclusive\n/],
      [['oracle'], /^hypertest oracle: missing sub-command/],
      [['oracle', 'nope'], /^hypertest oracle: unknown sub-command oracle nope\n/],
      [['oracle', 'decide'], /^hypertest oracle: missing <proposalId>\n/],
      [['oracle', 'establish'], /^hypertest oracle: missing <file>\n/],
      [['oracle', 'establish', 'o.yaml'], /^hypertest oracle: --by is required\n/],
      [['waive', 'run_1', 'C1', '--by', 'alice', '--reason', 'r'], /^hypertest waive: C1 evidence_integrity is not waivable\n/],
      [['waive', 'run_1', 'review', '--by', 'alice', '--reason', 'r'], /^hypertest waive: <criterionId> must be a gate criterion id C0\.\.C9 \(got "review"\)\n/],
      [['waive', 'run_1', 'C6', '--by', 'alice'], /^hypertest waive: --reason is required\n/],
      [['waive', 'run_1', 'C6', '--by', 'alice', '--reason', 'r', '--expires', 'soon'], /^hypertest waive: --expires must be an ISO-8601 time \(got "soon"\)\n/],
      [['experience'], /^hypertest experience: missing sub-command \(experience list \| experience review <experienceId>\)\n/],
      [['experience', 'nope'], /^hypertest experience: unknown sub-command experience nope\n/],
      [['experience', 'list', '--status', 'bogus'], /^hypertest experience: --status: unknown experience status "bogus"/],
      [['experience', 'review', 'exp_1', '--by', 'alice'], /^hypertest experience: --decision is required\n/],
      [['experience', 'review', 'exp_1', '--decision', 'bless', '--by', 'alice'], /^hypertest experience: --decision must be one of review, approve, publish, reject, quarantine \(got "bless"\)\n/],
      [['evidence', 'check', 'r1'], /^hypertest evidence: unknown sub-command evidence check/],
      [['eval'], /^hypertest eval: missing sub-command \(eval run <suite>\)\n/],
      [['eval', 'run', 'x', '--trials', '0'], /^hypertest eval: --trials must be an integer between 1 and 10000 \(got "0"\)\n/],
      [['cancel', 'r1'], /^hypertest cancel: --reason is required\n/],
      [['serve', '--port', '70000'], /^hypertest serve: --port must be an integer between 0 and 65535 \(got "70000"\)\n/],
      [['serve', '--token-env', 'not a var'], /^hypertest serve: --token-env must name an environment variable/],
      [['init', 'extra'], /^hypertest init: unexpected argument: extra\n/],
      [['doctor', '--timeout-ms=-5'], /^hypertest doctor: --timeout-ms must be an integer between 1 and 600000/],
    ];
    for (const [argv, re] of cases) {
      const r = await cli(argv, { cwd: dir.path, env: { HYPERTEST_CONFIG: undefined } });
      assert.equal(r.code, 2, `${argv.join(' ')} → ${r.code}\n${r.stderr}`);
      assert.match(r.stderr, re, argv.join(' '));
      assert.match(r.stderr, new RegExp(`run \`hypertest ${argv[0]} --help\` for usage\\n$`), argv.join(' '));
      assert.equal(r.stdout, '', argv.join(' '));
    }
  });

  test('a command needing a configuration fails (exit 1) with guidance when none exists; nothing is created', async () => {
    const r = await cli(['status'], { cwd: dir.path, env: { HYPERTEST_CONFIG: undefined } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^hypertest status: no hypertest\.config\.yaml found in \S+ or its parent directories; run `hypertest init` or pass --config <file> \[not_found\]\n$/);
    const j = await cli(['status', '--json'], { cwd: dir.path, env: { HYPERTEST_CONFIG: undefined } });
    assert.equal(j.code, 1);
    assert.equal((JSON.parse(j.stdout) as { error: { code: string } }).error.code, 'not_found');
    const explicit = await cli(['status', '--config', 'missing.yaml'], { cwd: dir.path });
    assert.equal(explicit.code, 1);
    assert.match(explicit.stderr, /configuration file \S+missing\.yaml not found \[not_found\]/);
  });
});

describe('configuration discovery', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => {
    dir = await tempDir('ht-cli-find-');
    await mkdir(join(dir.path, 'a', 'b'), { recursive: true });
    await writeFile(join(dir.path, 'hypertest.config.yaml'), 'version: 1\n');
    await writeFile(join(dir.path, 'a', 'hypertest.config.json'), '{"version":1}\n');
  });
  after(async () => {
    await dir.cleanup();
  });

  test('--config beats $HYPERTEST_CONFIG beats the nearest file in cwd or an ancestor', () => {
    const cwd = join(dir.path, 'a', 'b');
    assert.equal(findConfig({ cwd, env: {} }), join(dir.path, 'a', 'hypertest.config.json'));
    assert.equal(findConfig({ cwd: dir.path, env: {} }), join(dir.path, 'hypertest.config.yaml'));
    assert.equal(findConfig({ cwd, env: { HYPERTEST_CONFIG: '../../hypertest.config.yaml' } }), join(dir.path, 'hypertest.config.yaml'));
    assert.equal(findConfig({ cwd, env: { HYPERTEST_CONFIG: 'x.yaml' } }, 'y.yaml'), join(cwd, 'y.yaml'));
  });
});

describe('--scripted-brains module contract', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => {
    dir = await tempDir('ht-cli-brains-');
    await writeFile(join(dir.path, 'map.mjs'), 'export const brains = { sim: () => ({ text: "hi" }) };\n');
    await writeFile(join(dir.path, 'default.mjs'), 'export default (ctx) => ({ sim: () => ({ text: ctx.command }) });\n');
    await writeFile(join(dir.path, 'number.mjs'), 'export const brains = 42;\n');
    await writeFile(join(dir.path, 'empty.mjs'), 'export const other = 1;\n');
    await writeFile(join(dir.path, 'broken.mjs'), 'export const brains = {;\n');
    await writeFile(join(dir.path, 'evalonly.mjs'), 'export function evalBrains() { return {}; }\n');
    await writeFile(join(dir.path, 'badeval.mjs'), 'export const evalBrains = {};\n');
  });
  after(async () => {
    await dir.cleanup();
  });

  test('accepts a brains map, a default factory, or evalBrains alone', async () => {
    const ctx = { io: { cwd: dir.path, env: {} } as never, command: 'run' };
    assert.equal(typeof (await loadBrainsModule(ctx, 'map.mjs')).brains, 'object');
    assert.equal(typeof (await loadBrainsModule(ctx, 'default.mjs')).brains, 'function');
    const e = await loadBrainsModule(ctx, 'evalonly.mjs');
    assert.deepEqual([e.brains, typeof e.evalBrains], [undefined, 'function']);
  });

  test('refuses missing modules, load errors and wrong shapes as usage errors', async () => {
    const ctx = { io: { cwd: dir.path, env: {} } as never, command: 'run' };
    const cases: Array<[string, RegExp]> = [
      ['nope.mjs', /--scripted-brains: module \S+nope\.mjs does not exist/],
      ['broken.mjs', /--scripted-brains: module \S+broken\.mjs could not be loaded/],
      ['number.mjs', /must export `brains` \(or a default export\) as a map of provider id → brain, or a factory returning one/],
      ['empty.mjs', /exports neither `brains`, a default export nor `evalBrains`/],
      ['badeval.mjs', /`evalBrains` must be a function/],
    ];
    for (const [file, re] of cases) {
      await assert.rejects(loadBrainsModule(ctx, file), (err: unknown) => err instanceof UsageError && re.test(err.message), file);
    }
  });
});

describe('processes that execute no agent turn', () => {
  test('clientOnlyConfig: a Temporal runtime connects as a client (no embedded worker); other runtimes and external mode are unchanged', () => {
    const embedded = defaultConfig({ project: { name: 'x', dataDir: '/tmp/x' }, durable: { kind: 'temporal', address: '127.0.0.1:7233', taskQueue: 'q' } });
    const client = clientOnlyConfig(embedded);
    assert.deepEqual(client.durable, { kind: 'temporal', address: '127.0.0.1:7233', taskQueue: 'q', workerMode: 'external' });
    assert.deepEqual(embedded.durable, { kind: 'temporal', address: '127.0.0.1:7233', taskQueue: 'q' }, 'the input is not mutated');
    assert.deepEqual({ ...client, durable: embedded.durable }, embedded, 'nothing else changes');
    const explicitEmbedded = defaultConfig({ project: { name: 'x', dataDir: '/tmp/x' }, durable: { kind: 'temporal', address: 'h:1', workerMode: 'embedded' } });
    assert.deepEqual(clientOnlyConfig(explicitEmbedded).durable, { kind: 'temporal', address: 'h:1', workerMode: 'external' });
    const external = defaultConfig({ project: { name: 'x', dataDir: '/tmp/x' }, durable: { kind: 'temporal', address: 'h:1', workerMode: 'external' } });
    assert.equal(clientOnlyConfig(external), external);
    const local = defaultConfig({ project: { name: 'x', dataDir: '/tmp/x' } });
    assert.equal(clientOnlyConfig(local), local);
  });

  test('human decisions are refused inside a Hypertest sandbox ($HYPERTEST_SANDBOX), before any store is opened', async () => {
    const dir = await tempDir('ht-cli-sandbox-');
    try {
      assert.equal(SANDBOX_ENV, 'HYPERTEST_SANDBOX');
      const env = { [SANDBOX_ENV]: '1', HYPERTEST_CONFIG: undefined };
      const a = await cli(['approve', 'appr_1', '--by', 'alice', '--reason', 'looks fine'], { cwd: dir.path, env });
      assert.deepEqual([a.code, a.stdout], [1, '']);
      assert.equal(a.stderr, 'hypertest approve: approve is a human decision and cannot be taken from inside a Hypertest sandbox (HYPERTEST_SANDBOX is set): an agent never decides its own approval or oracle change [permission_denied]\n');
      const o = await cli(['oracle', 'decide', 'ocp_1', '--by', 'alice', '--reason', 'fine', '--json'], { cwd: dir.path, env });
      assert.equal(o.code, 1);
      assert.equal(parseJsonError(o.stdout), 'permission_denied');
      // conformance-11: waiving a gate criterion is a human decision
      const w = await cli(['waive', 'run_1', 'C6', '--by', 'alice', '--reason', 'no reviewer route today'], { cwd: dir.path, env });
      assert.equal(w.code, 1);
      assert.match(w.stderr, /^hypertest waive: waive is a human decision and cannot be taken from inside a Hypertest sandbox .*\[permission_denied\]\n$/);
      // conformance-13: reviewing what later runs learn from is a human decision too
      const exp = await cli(['experience', 'review', 'exp_1', '--decision', 'approve', '--by', 'alice'], { cwd: dir.path, env });
      assert.equal(exp.code, 1);
      assert.match(exp.stderr, /^hypertest experience: experience review is a human decision and cannot be taken from inside a Hypertest sandbox .*\[permission_denied\]\n$/);
      // conformance-1: establishing an oracle (the correctness criterion itself) is a human decision too
      const est = await cli(['oracle', 'establish', 'oracle.yaml', '--by', 'alice'], { cwd: dir.path, env });
      assert.deepEqual([est.code, est.stdout], [1, '']);
      assert.match(est.stderr, /^hypertest oracle: oracle establish is a human decision and cannot be taken from inside a Hypertest sandbox .*\[permission_denied\]\n$/);
      // an empty marker is not a sandbox: the command proceeds (and here fails for want of a configuration)
      const unset = await cli(['approve', 'appr_1', '--by', 'alice', '--reason', 'r'], { cwd: dir.path, env: { [SANDBOX_ENV]: '', HYPERTEST_CONFIG: undefined } });
      assert.equal(unset.code, 1);
      assert.match(unset.stderr, /no hypertest\.config\.yaml found .* \[not_found\]\n$/);
    } finally {
      await dir.cleanup();
    }
  });
});

function parseJsonError(stdout: string): string {
  return (JSON.parse(stdout) as { error: { code: string } }).error.code;
}
