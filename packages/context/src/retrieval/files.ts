import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HypertestError, throwIfAborted } from '@hypertest/core';
import type { RetrievalKind } from '../contracts.ts';

/** Directories never searched (in addition to hidden entries, which are skipped like ripgrep does). */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'dist', '.hypertest']);
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/** posix-style relative path */
export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/**
 * Validates a caller-supplied relative path (query.root, path globs): absolute paths and `..` segments are
 * refused so a query can never leave the configured root.
 */
export function assertRelativeInside(p: string, what: string): void {
  if (typeof p !== 'string') throw new HypertestError('invalid_argument', `${what} must be a string`);
  if (isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.split(/[\\/]/).includes('..')) {
    throw new HypertestError('invalid_argument', `${what} must be a relative path inside the search root: ${p}`);
  }
}

/** Resolves the directory to search: root, or root/sub for query.root; symlink escapes are refused. */
export async function resolveSearchDir(root: string, sub: string | undefined): Promise<{ absRoot: string; dir: string; relDir: string }> {
  const absRoot = await realpath(resolve(root));
  if (sub === undefined || sub === '' || sub === '.') return { absRoot, dir: absRoot, relDir: '' };
  assertRelativeInside(sub, 'query.root');
  let dir: string;
  try {
    dir = await realpath(resolve(absRoot, sub));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HypertestError('not_found', `query.root ${sub} does not exist`);
    throw e;
  }
  const rel = relative(absRoot, dir);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new HypertestError('permission_denied', `query.root ${sub} resolves outside the search root`);
  return { absRoot, dir, relDir: toPosix(rel) };
}

/**
 * Simple glob → RegExp: `**` any depth, `*` within a segment, `?` one char, `[...]` classes. A glob that does not
 * compile (e.g. the class `[z-a]`) is invalid_argument, never a raw SyntaxError.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close < 0) re += '\\[';
      else {
        let cls = glob.slice(i + 1, close);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else {
      re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  try {
    return new RegExp(`^${re}$`);
  } catch (e) {
    throw new HypertestError('invalid_argument', `invalid glob ${JSON.stringify(glob)}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** A glob without '/' matches the basename at any depth; otherwise the whole relative path. */
export function compileGlobs(globs: readonly string[] | undefined): ((relPath: string) => boolean) | undefined {
  if (!globs || globs.length === 0) return undefined;
  const matchers = globs.map((g) => {
    assertRelativeInside(g.replace(/^!/, ''), 'pathGlobs entry');
    const negate = g.startsWith('!');
    const body = negate ? g.slice(1) : g;
    const anchored = body.replace(/^\//, '');
    const re = globToRegExp(anchored);
    const baseOnly = !anchored.includes('/');
    return { negate, test: (p: string) => re.test(baseOnly ? p.slice(p.lastIndexOf('/') + 1) : p) };
  });
  const positives = matchers.filter((m) => !m.negate);
  const negatives = matchers.filter((m) => m.negate);
  return (p) => (positives.length === 0 || positives.some((m) => m.test(p))) && !negatives.some((m) => m.test(p));
}

interface IgnoreRule {
  base: string;
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
  baseOnly: boolean;
}

function parseGitignore(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    line = line.replace(/\s+$/, '');
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
    line = line.replace(/^\//, '');
    if (!line) continue;
    let re: RegExp;
    try {
      re = globToRegExp(line);
    } catch {
      // Like ripgrep: an invalid pattern is skipped on its own; the other rules of the file still apply.
      continue;
    }
    rules.push({ base, re, negate, dirOnly, baseOnly: !anchored });
  }
  return rules;
}

function ignoredBy(rules: readonly IgnoreRule[], relPath: string, isDir: boolean): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.base && !(relPath === r.base || relPath.startsWith(r.base + '/'))) continue;
    const local = r.base ? relPath.slice(r.base.length + 1) : relPath;
    const subject = r.baseOnly ? local.slice(local.lastIndexOf('/') + 1) : local;
    if (r.re.test(subject)) ignored = !r.negate;
  }
  return ignored;
}

export interface WalkedFile {
  /** Path relative to the search root (posix). */
  relPath: string;
  absPath: string;
  size: number;
}

/**
 * Walks `dir` (inside `absRoot`) depth-first in sorted order: skips hidden entries, SKIP_DIRS, symlinks (never
 * followed, like ripgrep), files larger than maxFileBytes and paths ignored by .gitignore files (root and nested,
 * basic syntax incl. negation; an invalid pattern line is skipped on its own).
 *
 * The walk has ripgrep's "search from the root, then filter" semantics: when `dir` (or one of its ancestors below
 * the root) is itself hidden, a SKIP_DIRS entry, a symlink or git-ignored, nothing is yielded; when `dir` is a
 * file, that single file is yielded if it passes the same filters. ExactSearch's ripgrep path always searches
 * the root and filters, so both paths return the same hits.
 */
export async function* walkFiles(absRoot: string, dir: string, options: { maxFileBytes?: number; signal?: AbortSignal } = {}): AsyncGenerator<WalkedFile> {
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const relStart = toPosix(relative(absRoot, dir));

  async function readIgnore(abs: string, base: string): Promise<IgnoreRule[]> {
    let text: string;
    try {
      text = await readFile(join(abs, '.gitignore'), 'utf8');
    } catch {
      return [];
    }
    return parseGitignore(text, base);
  }

  // Rules of the root and of every ancestor of `dir`; each path segment below the root must pass the filters.
  let rules: IgnoreRule[] = [];
  const segs = relStart ? relStart.split('/') : [];
  let parentAbs = absRoot;
  let parentRel = '';
  for (let i = 0; i < segs.length; i++) {
    throwIfAborted(options.signal);
    rules = [...rules, ...(await readIgnore(parentAbs, parentRel))];
    const name = segs[i]!;
    const rel = parentRel ? `${parentRel}/${name}` : name;
    const abs = join(absRoot, rel);
    let st;
    try {
      st = await lstat(abs);
    } catch {
      return;
    }
    if (name.startsWith('.') || SKIP_DIRS.has(name) || st.isSymbolicLink()) return;
    if (st.isFile()) {
      if (i === segs.length - 1 && st.size <= maxBytes && !ignoredBy(rules, rel, false)) yield { relPath: rel, absPath: abs, size: st.size };
      return;
    }
    if (!st.isDirectory() || ignoredBy(rules, rel, true)) return;
    parentAbs = abs;
    parentRel = rel;
  }

  async function* visit(abs: string, rel: string, inherited: IgnoreRule[]): AsyncGenerator<WalkedFile> {
    throwIfAborted(options.signal);
    const local = [...inherited, ...(await readIgnore(abs, rel))];
    let names: string[];
    try {
      names = (await readdir(abs)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = await lstat(childAbs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (ignoredBy(local, childRel, true)) continue;
        yield* visit(childAbs, childRel, local);
      } else if (st.isFile()) {
        if (st.size > maxBytes || ignoredBy(local, childRel, false)) continue;
        yield { relPath: childRel, absPath: childAbs, size: st.size };
      }
    }
  }

  yield* visit(dir, relStart, rules);
}

/**
 * Reads a text file; undefined for binary content: a file with a NUL byte anywhere is binary and never searched
 * (ripgrep stops at a NUL byte; ExactSearch drops such files on its ripgrep path too, so both agree).
 */
export async function readTextFile(absPath: string): Promise<string | undefined> {
  const buf = await readFile(absPath);
  if (buf.includes(0)) return undefined;
  return buf.toString('utf8');
}

/** True when the file contains a NUL byte (see readTextFile). */
export async function isBinaryFile(absPath: string): Promise<boolean> {
  return (await readFile(absPath)).includes(0);
}

const TEST_RE = /(^|\/)(test|tests|__tests__|spec|specs|testdata)\/|[._-](test|spec)\.[A-Za-z0-9]+$|_test\.go$|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/;
const DOC_RE = /\.(md|mdx|markdown|rst|txt|adoc)$|(^|\/)docs?\//i;

/** Retrieval kind of a file path: test, doc or code. */
export function classifyPath(relPath: string): RetrievalKind {
  if (TEST_RE.test(relPath)) return 'test';
  if (DOC_RE.test(relPath)) return 'doc';
  return 'code';
}

/** True when the file kind passes query.kinds (undefined/empty ⇒ everything). */
export function kindAllowed(relPath: string, kinds: readonly RetrievalKind[] | undefined): boolean {
  if (!kinds || kinds.length === 0) return true;
  return kinds.includes(classifyPath(relPath));
}
