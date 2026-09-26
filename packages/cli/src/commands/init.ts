import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { appendFile, link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { HypertestError } from '@hypertest/core';
import { flag, positionals, str } from '../args.ts';
import type { Command } from '../command.ts';
import { CONFIG_FILE_NAMES } from '../context.ts';
import { EXIT_CODES } from '../exit-codes.ts';
import { GITIGNORE_ENTRIES, TEMPLATE_KEY_VARIABLES, configTemplate } from '../template.ts';

/** A project name from a directory name: lowercase, `[a-z0-9._-]`, never empty. */
export function projectNameFrom(dir: string): string {
  const name = basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return name === '' ? 'hypertest-project' : name;
}

/** Appends the entries missing from `<dir>/.gitignore` (created when absent). */
export async function ensureGitignore(dir: string): Promise<{ path: string; status: 'created' | 'updated' | 'unchanged'; added: string[] }> {
  const path = join(dir, '.gitignore');
  const existing = existsSync(path) ? await readFile(path, 'utf8') : undefined;
  const lines = new Set((existing ?? '').split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => {
    const bare = entry.replace(/\/$/, '');
    return ![entry, bare, `/${entry}`, `/${bare}`].some((variant) => lines.has(variant));
  });
  if (missing.length === 0) return { path, status: 'unchanged', added: [] };
  const block = `# Hypertest data: database, evidence and private signing keys\n${missing.join('\n')}\n`;
  if (existing === undefined) {
    await writeFile(path, block);
    return { path, status: 'created', added: missing };
  }
  await appendFile(path, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${block}`);
  return { path, status: 'updated', added: missing };
}

/**
 * Writes the configuration completely or not at all: the text goes to a temporary file in the same directory, which is
 * then linked into place (exclusive: a configuration created meanwhile is never overwritten — `conflict`) or, with
 * `force`, renamed over it. A crash never leaves a truncated configuration behind.
 */
export async function writeConfigAtomically(file: string, text: string, force: boolean): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, text, { mode: 0o644, flag: 'wx' });
  try {
    if (force) {
      await rename(tmp, file);
      return;
    }
    try {
      await link(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new HypertestError('conflict', `${file} already exists (use --force to overwrite)`);
      throw e;
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

export const initCommand: Command = {
  name: 'init',
  summary: 'write a commented hypertest.config.yaml (+ .gitignore entries)',
  usage: ['init [--dir <path>] [--name <project>] [--force]'],
  optionHelp: [
    ['--dir <path>', 'directory of the configuration (default: the current directory; created when missing)'],
    ['--name <project>', 'project name (default: the directory name)'],
    ['--force', 'overwrite an existing hypertest.config.yaml'],
  ],
  notes: ['The template names API keys only through apiKeyEnv (DEEPSEEK_API_KEY, ANTHROPIC_API_KEY); it never contains a secret.'],
  options: { dir: { type: 'string' }, name: { type: 'string' }, force: { type: 'boolean' } },
  async run(ctx, values, args) {
    positionals('init', args, []);
    const dir = resolve(ctx.io.cwd, str(values, 'dir') ?? '.');
    const force = flag(values, 'force');
    const file = join(dir, CONFIG_FILE_NAMES[0]!);
    const existing = CONFIG_FILE_NAMES.map((n) => join(dir, n)).filter((p) => existsSync(p));
    if (existing.length > 0 && !(force && existing.every((p) => p === file))) {
      throw new HypertestError('conflict', `${existing.join(', ')} already exist${existing.length === 1 ? 's' : ''}${force ? ' (--force only overwrites hypertest.config.yaml)' : ' (use --force to overwrite)'}`);
    }
    const name = str(values, 'name')?.trim() || projectNameFrom(dir);
    await mkdir(dir, { recursive: true });
    await writeConfigAtomically(file, configTemplate(name), force);
    const gitignore = await ensureGitignore(dir);
    if (ctx.global.json) {
      ctx.json({ configPath: file, projectName: name, gitignore, keyVariables: TEMPLATE_KEY_VARIABLES });
      return EXIT_CODES.ok;
    }
    ctx.out(`wrote ${file}`);
    if (gitignore.status !== 'unchanged') ctx.out(`${gitignore.status} ${gitignore.path} (${gitignore.added.join(', ')})`);
    ctx.out('');
    ctx.out('next steps:');
    ctx.out(`  1. set the API key variables the providers name (values stay in your environment): ${TEMPLATE_KEY_VARIABLES.join(', ')}`);
    ctx.out('     (or edit models.providers / models.routes, e.g. enable the local model)');
    ctx.out('  2. hypertest doctor');
    ctx.out('  3. hypertest run "Is this change releasable?" --repo . --commit HEAD');
    return EXIT_CODES.ok;
  },
};
