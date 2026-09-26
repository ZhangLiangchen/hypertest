/**
 * Test helpers for @hypertest/cli: an in-memory CLI invocation (captured stdout/stderr, injected env/cwd/signal), a
 * scripted configuration file over a temporary directory (PGlite, or a fresh PostgreSQL schema with
 * HYPERTEST_TEST_DB=postgres) and git repositories with a passing or failing node:test suite.
 */
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase } from '@hypertest/store';
import { createGitRepo, infraEnv } from '@hypertest/testkit';
import { main, type CliIo } from '../src/index.ts';

export const BRAINS = join(import.meta.dirname, 'fixtures', 'brains.ts');
export const GOAL = 'Is the sum module releasable?';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function collector(onWrite?: (text: string) => void): { write(chunk: string): boolean; text(): string } {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
      onWrite?.(chunks.join(''));
      return true;
    },
    text: () => chunks.join(''),
  };
}

/** Runs `hypertest <argv>` in-process. */
export async function cli(argv: string[], options: { cwd: string; env?: Record<string, string | undefined>; signal?: AbortSignal; loadEval?: CliIo['loadEval']; onStderr?: (text: string) => void; onStdout?: (text: string) => void }): Promise<CliResult> {
  const stdout = collector(options.onStdout);
  const stderr = collector(options.onStderr);
  const io: Partial<CliIo> = { stdout, stderr, cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) } };
  if (options.signal) io.signal = options.signal;
  if (options.loadEval) io.loadEval = options.loadEval;
  const code = await main(argv, io);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

export function parseJson<T = Record<string, unknown>>(r: CliResult): T {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`stdout is not JSON (exit ${r.code}):\n${r.stdout}\nstderr:\n${r.stderr}`);
  }
}

/** Every capability, high quality: one scripted route every built-in role can use. */
export const SIM_ROUTE = {
  routeId: 'sim-large',
  provider: 'sim',
  model: 'sim-1',
  capabilities: ['tool_use', 'parallel_tool_calls', 'structured_output', 'reasoning', 'long_context'],
  quality: { default: 0.9 },
  maxActionRisk: 'critical',
};

/**
 * The sum module's correctness criterion (conformance-1: the gate needs an oracle in force), established by a named
 * human through the configuration and pinned by every run that names no oracles.
 */
export const SUM_ORACLE = {
  oracleId: 'sum-contract',
  scope: { components: ['sum'], description: 'the sum module adds numbers' },
  assertions: [{ assertionId: 'suite-passes', description: 'every case of the sum suite passes', kind: 'requirement', severity: 'P1', check: { type: 'test_outcome', testSelector: '*', expected: 'pass' } }],
  establishedBy: 'alice',
};

export interface TestProject {
  dir: string;
  configPath: string;
  env: Record<string, string>;
  dispose(): Promise<void>;
}

/**
 * Writes `<dir>/hypertest.config.yaml` (JSON is YAML) with the scripted provider `sim`; the store is PGlite under
 * `<dir>/.hypertest`, or with HYPERTEST_TEST_DB=postgres a fresh schema on HYPERTEST_TEST_PG_URL named through
 * `urlEnv` (dropped by dispose()).
 */
export async function writeProject(dir: string, extra: Record<string, unknown> = {}): Promise<TestProject> {
  const env: Record<string, string> = {};
  let store: Record<string, unknown> = { kind: 'pglite' };
  let dispose = async () => undefined;
  if (process.env['HYPERTEST_TEST_DB'] === 'postgres') {
    const url = infraEnv().pgUrl;
    if (!url) throw new Error('HYPERTEST_TEST_DB=postgres needs HYPERTEST_TEST_PG_URL');
    const schema = `ht_cli_${randomBytes(5).toString('hex')}`;
    env['HT_CLI_TEST_PG_URL'] = url;
    store = { kind: 'postgres', urlEnv: 'HT_CLI_TEST_PG_URL', schema };
    dispose = async () => {
      const db = await openDatabase({ kind: 'postgres', url });
      try {
        await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await db.close();
      }
    };
  }
  const config = {
    version: 1,
    project: { name: 'cli-test', dataDir: '.hypertest' },
    store,
    models: { providers: [{ id: 'sim', kind: 'scripted' }], routes: [SIM_ROUTE] },
    gate: { requireIndependentReview: false },
    observability: { logLevel: 'warn' },
    oracles: [SUM_ORACLE],
    ...extra,
  };
  const configPath = join(dir, 'hypertest.config.yaml');
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { dir, configPath, env, dispose };
}

export const SUM_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from '../src/sum.js';

test('adds two numbers', () => {
  assert.equal(sum(2, 3), 5);
});
`;

/** A git repository with a node:test suite that passes (or fails: `sum` subtracts). */
export async function sumRepo(passing = true): Promise<{ path: string; head: string; cleanup(): Promise<void> }> {
  const repo = await createGitRepo({
    'package.json': '{ "name": "calc", "type": "module", "private": true }\n',
    'src/sum.js': `export function sum(a, b) {\n  return a ${passing ? '+' : '-'} b;\n}\n`,
    'test/sum.test.js': SUM_TEST,
  });
  return { path: repo.path, head: repo.commits[0]!, cleanup: repo.cleanup };
}
