import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { HypertestError, throwIfAborted } from '@hypertest/core';
import type { ExactSearchOptions, RetrievalHit, RetrievalQuery, Retriever } from '../contracts.ts';
import { cmpStr, resolveLimit } from '../util.ts';
import { compileGlobs, DEFAULT_MAX_FILE_BYTES, isBinaryFile, kindAllowed, readTextFile, resolveSearchDir, toPosix, walkFiles } from './files.ts';

interface LineMatch {
  path: string;
  line: number;
  text: string;
  matches: number;
  column: number;
}

let rgOnPath: Promise<string | undefined> | undefined;

/** Absolute path of `rg` on PATH (cached per process), or undefined. */
export function findRipgrep(): Promise<string | undefined> {
  rgOnPath ??= (async () => {
    for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg');
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
    return undefined;
  })();
  return rgOnPath;
}

function smartCaseSensitive(text: string): boolean {
  return text !== text.toLowerCase();
}

/** Non-overlapping occurrences of `needle` in `line` and the column of the first one. */
function countMatches(line: string, needle: string, caseSensitive: boolean): { matches: number; column: number } {
  const hay = caseSensitive ? line : line.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  let matches = 0;
  let column = -1;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(n, from);
    if (i < 0) break;
    if (column < 0) column = i;
    matches++;
    from = i + n.length;
  }
  return { matches, column };
}

/**
 * Score from match count (line and file) and position: more matches and an earlier column rank higher.
 * Identical for the ripgrep and the JS path, so both return the same ranking.
 */
function score(m: LineMatch, fileMatches: number): number {
  return 0.5 * (m.matches / (m.matches + 1)) + 0.3 * (fileMatches / (fileMatches + 2)) + 0.2 / (1 + m.column / 40);
}

function snippet(text: string): string {
  const t = text.replace(/\r?\n$/, '').trim();
  return t.length > 240 ? t.slice(0, 239) + '…' : t;
}

/**
 * L3 exact (literal, smart-case) search. Uses `rg --json -n -S -F -m <limit>` when ripgrep is on PATH (execFile,
 * no shell), else a JS walker with the same rules: hidden entries, .git, node_modules, dist, .hypertest,
 * binary files (a NUL byte anywhere) and files > 1 MiB skipped, .gitignore files under the root respected (also
 * outside git repositories; .git/info/exclude and global excludes are not). query.root is a filter over a walk
 * from the root, so a hidden, vendored or ignored query.root yields nothing on both paths. Hits are
 * `{kind:'file', id: relPath}` refs relative to the root; a query can never leave the root.
 */
export class ExactSearch implements Retriever {
  readonly name = 'exact';
  readonly #options: Required<ExactSearchOptions>;
  /** Which implementation served the last search (for diagnostics/tests). */
  lastEngine: 'ripgrep' | 'js' | undefined;

  constructor(options: ExactSearchOptions) {
    if (!options || typeof options.root !== 'string' || options.root.length === 0) throw new HypertestError('invalid_argument', 'ExactSearch needs a root');
    this.#options = {
      root: options.root,
      ripgrep: options.ripgrep ?? 'auto',
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      defaultLimit: resolveLimit(options.defaultLimit, 20, 'defaultLimit'),
    };
  }

  async search(query: RetrievalQuery, signal?: AbortSignal): Promise<RetrievalHit[]> {
    throwIfAborted(signal);
    const text = (query.text && query.text.length > 0 ? query.text : query.symbol) ?? '';
    if (text.length === 0) return [];
    if (text.includes('\n')) throw new HypertestError('invalid_argument', 'exact search text must be a single line');
    const limit = resolveLimit(query.limit, this.#options.defaultLimit, 'query.limit');
    const globFilter = compileGlobs(query.pathGlobs);
    const { absRoot, relDir } = await resolveSearchDir(this.#options.root, query.root);
    const inScope = (p: string) => (!relDir || p === relDir || p.startsWith(relDir + '/')) && (!globFilter || globFilter(p)) && kindAllowed(p, query.kinds);

    let rg: string | undefined;
    if (this.#options.ripgrep !== false) {
      rg = await findRipgrep();
      if (!rg && this.#options.ripgrep === true) throw new HypertestError('unsupported', 'ripgrep (rg) is not on PATH');
    }
    const matches = rg ? await this.#ripgrep(rg, absRoot, text, limit, signal) : await this.#walk(absRoot, relDir, text, limit, signal);
    this.lastEngine = rg ? 'ripgrep' : 'js';

    let scoped = matches.filter((m) => inScope(m.path));
    if (rg) scoped = await this.#dropBinary(absRoot, scoped);
    const perFile = new Map<string, number>();
    for (const m of scoped) perFile.set(m.path, (perFile.get(m.path) ?? 0) + 1);
    return scoped
      .map((m): RetrievalHit => ({ source: 'exact', ref: { kind: 'file', id: m.path }, path: m.path, line: m.line, snippet: snippet(m.text), score: score(m, perFile.get(m.path)!) }))
      .sort((a, b) => b.score - a.score || cmpStr(a.path!, b.path!) || a.line! - b.line!)
      .slice(0, limit);
  }

  async #ripgrep(rg: string, absRoot: string, text: string, limit: number, signal?: AbortSignal): Promise<LineMatch[]> {
    // Positive -g globs would override .gitignore in ripgrep, so scoping (query.root, pathGlobs, kinds) is
    // applied to the parsed results instead; only exclusions are passed.
    const args = [
      '--json', '-n', '-S', '-F', '-m', String(limit),
      // Only .gitignore files under the root apply (like the JS walker): no parent, global, .ignore/.rgignore or
      // .git/info/exclude rules.
      '--no-config', '--no-require-git', '--no-ignore-parent', '--no-ignore-global', '--no-ignore-dot', '--no-ignore-exclude',
      '--max-filesize', String(this.#options.maxFileBytes),
      '-g', '!node_modules', '-g', '!dist', '-g', '!.hypertest',
      '--', text, '.',
    ];
    const stdout = await new Promise<string>((resolvePromise, reject) => {
      execFile(rg, args, { cwd: absRoot, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', ...(signal ? { signal } : {}) }, (error, out, stderr) => {
        if (error) {
          const code = (error as { code?: unknown }).code;
          if (code === 1) return resolvePromise(''); // no match
          if (error.name === 'AbortError') return reject(new HypertestError('cancelled', 'exact search aborted', { cause: error }));
          // exit 2 = some files could not be searched; results so far are still valid when present.
          if (code === 2 && out) return resolvePromise(out);
          return reject(new HypertestError('internal', `ripgrep failed: ${stderr || error.message}`, { cause: error }));
        }
        resolvePromise(out);
      });
    });
    const caseSensitive = smartCaseSensitive(text);
    const out: LineMatch[] = [];
    // ripgrep reports a non-UTF-8 path or line as {bytes: base64}; decode it lossily like the JS walker does.
    const decode = (v: { text?: string; bytes?: string } | undefined): string | undefined =>
      v === undefined ? undefined : typeof v.text === 'string' ? v.text : typeof v.bytes === 'string' ? Buffer.from(v.bytes, 'base64').toString('utf8') : undefined;
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{"type":"match"')) continue;
      let msg: { data?: { path?: { text?: string; bytes?: string }; lines?: { text?: string; bytes?: string }; line_number?: number; submatches?: Array<{ start: number }> } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }
      const d = msg.data;
      const p = decode(d?.path);
      const lineText = decode(d?.lines);
      if (!p || lineText === undefined || typeof d?.line_number !== 'number') continue;
      const rel = toPosix(p.replace(/^\.[\\/]/, ''));
      const clean = lineText.replace(/\r?\n$/, '');
      // Recount on the decoded line so columns are UTF-16 offsets exactly like the JS path.
      const { matches, column } = countMatches(clean, text, caseSensitive);
      out.push({ path: rel, line: d.line_number, text: clean, matches: matches || d.submatches?.length || 1, column: Math.max(0, column) });
    }
    return out;
  }

  /**
   * ripgrep only stops at a NUL byte (matches before it are reported when the NUL lies beyond its first buffer);
   * a file with a NUL anywhere is binary for both engines, so such files are dropped from ripgrep's matches.
   */
  async #dropBinary(absRoot: string, matches: LineMatch[]): Promise<LineMatch[]> {
    const flags = new Map<string, Promise<boolean>>();
    for (const m of matches) if (!flags.has(m.path)) flags.set(m.path, isBinaryFile(join(absRoot, m.path)).catch(() => true));
    const binary = await Promise.all(matches.map((m) => flags.get(m.path)!));
    return matches.filter((_, i) => !binary[i]);
  }

  async #walk(absRoot: string, relDir: string, text: string, limit: number, signal?: AbortSignal): Promise<LineMatch[]> {
    const caseSensitive = smartCaseSensitive(text);
    const dir = relDir ? join(absRoot, relDir) : absRoot;
    const out: LineMatch[] = [];
    for await (const f of walkFiles(absRoot, dir, { maxFileBytes: this.#options.maxFileBytes, ...(signal ? { signal } : {}) })) {
      let content: string | undefined;
      try {
        content = await readTextFile(f.absPath);
      } catch {
        continue;
      }
      if (content === undefined) continue;
      const lines = content.split('\n');
      let inFile = 0;
      for (let i = 0; i < lines.length && inFile < limit; i++) {
        const l = lines[i]!.replace(/\r$/, '');
        const { matches, column } = countMatches(l, text, caseSensitive);
        if (matches === 0) continue;
        inFile++;
        out.push({ path: f.relPath, line: i + 1, text: l, matches, column });
      }
    }
    return out;
  }
}
