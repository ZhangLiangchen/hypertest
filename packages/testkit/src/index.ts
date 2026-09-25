import { execFile } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { FixedClock, MemoryLogger, SequentialIdGenerator, type Migration, type SqlDatabase } from '@hypertest/core';
import type { EventContext } from '@hypertest/domain';
import { createTestDatabase } from '@hypertest/store';

export * from './contracts.ts';

const exec = promisify(execFile);

export function testDeps(start = '2026-01-01T00:00:00.000Z'): { ids: SequentialIdGenerator; clock: FixedClock; logger: MemoryLogger } {
  return { ids: new SequentialIdGenerator(), clock: new FixedClock(start), logger: new MemoryLogger() };
}

export async function withTestDatabase<T>(migrations: readonly Migration[], fn: (db: SqlDatabase) => Promise<T>): Promise<T> {
  const { db, dispose } = await createTestDatabase({ migrations });
  try {
    return await fn(db);
  } finally {
    await dispose();
  }
}

export async function tempDir(prefix = 'ht-test-'): Promise<{ path: string; cleanup(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Hypertest Test', GIT_AUTHOR_EMAIL: 'test@hypertest.invalid', GIT_COMMITTER_NAME: 'Hypertest Test', GIT_COMMITTER_EMAIL: 'test@hypertest.invalid', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return stdout.trim();
}

async function writeFiles(root: string, files: Record<string, string | null>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    if (content === null) {
      await rm(p, { force: true });
      continue;
    }
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }
}

/** Creates a git repository with an initial commit and optional follow-up commits (null deletes a file). */
export async function createGitRepo(
  files: Record<string, string>,
  commits: Array<{ message: string; files: Record<string, string | null> }> = [],
): Promise<{ path: string; commits: string[]; cleanup(): Promise<void> }> {
  const dir = await tempDir('ht-repo-');
  await git(dir.path, ['init', '-q', '-b', 'main']);
  await git(dir.path, ['config', 'commit.gpgsign', 'false']);
  await writeFiles(dir.path, files);
  await git(dir.path, ['add', '-A']);
  await git(dir.path, ['commit', '-q', '-m', 'initial']);
  const shas = [await git(dir.path, ['rev-parse', 'HEAD'])];
  for (const c of commits) {
    await writeFiles(dir.path, c.files);
    await git(dir.path, ['add', '-A']);
    await git(dir.path, ['commit', '-q', '-m', c.message]);
    shas.push(await git(dir.path, ['rev-parse', 'HEAD']));
  }
  return { path: dir.path, commits: shas, cleanup: dir.cleanup };
}

function repoRoot(): string {
  let d = resolve(dirname(new URL(import.meta.url).pathname));
  while (d !== '/' && !existsSync(join(d, 'scripts', 'check-boundaries.mjs'))) d = dirname(d);
  return d;
}

/** Local infra connection info (env vars, else .infra/env written by `npm run infra:up`). */
export function infraEnv(): { pgUrl?: string; natsUrl?: string; temporalAddress?: string; infraBin?: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  const f = join(repoRoot(), '.infra', 'env');
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && env[m[1]!] === undefined) env[m[1]!] = m[2];
    }
  }
  const out: { pgUrl?: string; natsUrl?: string; temporalAddress?: string; infraBin?: string } = {};
  if (env['HYPERTEST_TEST_PG_URL']) out.pgUrl = env['HYPERTEST_TEST_PG_URL'];
  if (env['HYPERTEST_TEST_NATS_URL']) out.natsUrl = env['HYPERTEST_TEST_NATS_URL'];
  if (env['HYPERTEST_TEST_TEMPORAL_ADDRESS']) out.temporalAddress = env['HYPERTEST_TEST_TEMPORAL_ADDRESS'];
  if (env['HYPERTEST_INFRA_BIN']) out.infraBin = env['HYPERTEST_INFRA_BIN'];
  return out;
}

/** node:test option: `test('x', skipUnless(!!url, 'why'), fn)`. A skip is reported explicitly, never a pass. */
export function skipUnless(condition: boolean, reason: string): { skip: string | false } {
  return { skip: condition ? false : reason };
}

export function eventCtx(runId: string, overrides: Partial<EventContext> = {}): EventContext {
  return { runId, correlationId: overrides.correlationId ?? runId, actorId: overrides.actorId ?? 'system:test', ...overrides };
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
