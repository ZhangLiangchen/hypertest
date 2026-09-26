import { lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HypertestError, sha256Hex, type JsonValue } from '@hypertest/core';
import { matchesGlob } from '@hypertest/policy';
import type { BuiltinToolOptions, ToolSpec } from '../../contracts.ts';
import { normalizeRel, workspaceResource } from '../paths.ts';
import { assertNotGitMetadata, bytes, ensureWritable, pathResource, PATH_SCHEMA, rootResource, sandboxGit } from './common.ts';

const MAX_READ_FILE = 32 * 1024 * 1024;
const DEFAULT_READ_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

function globMatches(glob: string, rel: string): boolean {
  if (!glob.includes('/')) {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    return matchesGlob(glob, base);
  }
  return matchesGlob(glob, rel);
}

// ----------------------------------------------------------------------------- fs.read

interface ReadInput {
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
}

export function fsReadTool(options: BuiltinToolOptions): ToolSpec<ReadInput> {
  return {
    id: 'fs.read',
    title: 'Read file',
    description: 'Read a text file from the workspace (optionally a 1-based inclusive line range). Paths are relative to the workspace root.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: PATH_SCHEMA,
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        maxBytes: { type: 'integer', minimum: 1, maximum: 8 * 1024 * 1024 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['path', 'sizeBytes', 'sha256', 'totalLines', 'startLine', 'endLine', 'truncated', 'binary'],
      properties: {
        path: { type: 'string' },
        sizeBytes: { type: 'integer' },
        sha256: { type: 'string' },
        totalLines: { type: 'integer' },
        startLine: { type: 'integer' },
        endLine: { type: 'integer' },
        truncated: { type: 'boolean' },
        binary: { type: 'boolean' },
      },
    },
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 30_000,
    resources: (input, ctx) => [pathResource(ctx, input.path)],
    async execute(input, ctx) {
      assertNotGitMetadata(input.path, 'fs.read');
      const abs = await options.workspaces.resolvePath(ctx.workspace, input.path);
      const st = await stat(abs).catch(() => undefined);
      if (!st) throw new HypertestError('not_found', `no such file: ${input.path}`);
      if (!st.isFile()) throw new HypertestError('invalid_argument', `${input.path} is not a regular file`);
      if (st.size > MAX_READ_FILE) throw new HypertestError('invalid_argument', `${input.path} is ${st.size} bytes; use fs.search or a line range on a smaller file`);
      const buf = await readFile(abs);
      const sha256 = sha256Hex(buf);
      const path = normalizeRel(input.path);
      if (buf.subarray(0, 8000).includes(0)) {
        return {
          status: 'success',
          structured: { path, sizeBytes: buf.byteLength, sha256, totalLines: 0, startLine: 0, endLine: 0, truncated: false, binary: true },
          text: `[binary file ${path}: ${buf.byteLength} bytes, sha256 ${sha256}]`,
        };
      }
      const content = buf.toString('utf8');
      const lines = content.split('\n');
      const totalLines = content.endsWith('\n') ? lines.length - 1 : lines.length;
      const startLine = input.startLine ?? 1;
      const endLine = Math.min(input.endLine ?? totalLines, totalLines);
      if (input.endLine !== undefined && input.endLine < startLine) throw new HypertestError('invalid_argument', `endLine ${input.endLine} < startLine ${startLine}`);
      if (totalLines > 0 && startLine > totalLines) throw new HypertestError('invalid_argument', `startLine ${startLine} is beyond the end of ${path} (${totalLines} lines)`);
      let text = totalLines === 0 ? '' : lines.slice(startLine - 1, endLine).join('\n');
      const limit = input.maxBytes ?? DEFAULT_READ_BYTES;
      let truncated = false;
      if (bytes(text) > limit) {
        const b = Buffer.from(text, 'utf8');
        let n = limit;
        while (n > 0 && (b[n]! & 0xc0) === 0x80) n--;
        text = b.subarray(0, n).toString('utf8');
        truncated = true;
      }
      return { status: 'success', structured: { path, sizeBytes: buf.byteLength, sha256, totalLines, startLine: totalLines === 0 ? 0 : startLine, endLine: totalLines === 0 ? 0 : endLine, truncated, binary: false }, text };
    },
  };
}

// ----------------------------------------------------------------------------- fs.list

interface ListInput {
  path?: string;
  depth?: number;
  glob?: string;
  includeHidden?: boolean;
  maxEntries?: number;
}

interface ListEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size?: number;
}

export function fsListTool(options: BuiltinToolOptions): ToolSpec<ListInput> {
  return {
    id: 'fs.list',
    title: 'List directory',
    description: 'List files and directories under a workspace path (depth 1-5; optional glob filter on files; .git and node_modules are skipped; symlinks are reported, not followed).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096, default: '.' },
        depth: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
        glob: { type: 'string', minLength: 1, maxLength: 512 },
        includeHidden: { type: 'boolean', default: false },
        maxEntries: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 },
      },
    },
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 30_000,
    resources: (input, ctx) => [pathResource(ctx, input.path ?? '.')],
    async execute(input, ctx) {
      const base = input.path ?? '.';
      assertNotGitMetadata(base, 'fs.list');
      const abs = await options.workspaces.resolvePath(ctx.workspace, base);
      const st = await stat(abs).catch(() => undefined);
      if (!st) throw new HypertestError('not_found', `no such directory: ${base}`);
      if (!st.isDirectory()) throw new HypertestError('invalid_argument', `${base} is not a directory`);
      const depth = input.depth ?? 2;
      const max = input.maxEntries ?? 1000;
      const entries: ListEntry[] = [];
      let truncated = false;
      const baseRel = normalizeRel(base);
      const walk = async (dir: string, rel: string, level: number): Promise<void> => {
        const names = (await readdir(dir)).sort();
        for (const name of names) {
          if (entries.length >= max) {
            truncated = true;
            return;
          }
          if (!input.includeHidden && name.startsWith('.')) continue;
          if (SKIP_DIRS.has(name)) continue;
          const p = join(dir, name);
          const r = rel === '' ? name : `${rel}/${name}`;
          const ls = await lstat(p).catch(() => undefined);
          if (!ls) continue;
          if (ls.isSymbolicLink()) {
            if (!input.glob || globMatches(input.glob, r)) entries.push({ path: r, type: 'symlink' });
          } else if (ls.isDirectory()) {
            if (!input.glob) entries.push({ path: r, type: 'dir' });
            if (level < depth) await walk(p, r, level + 1);
          } else if (ls.isFile()) {
            if (!input.glob || globMatches(input.glob, r)) entries.push({ path: r, type: 'file', size: ls.size });
          } else if (!input.glob) entries.push({ path: r, type: 'other' });
        }
      };
      await walk(abs, baseRel, 1);
      const text = entries.map((e) => (e.type === 'dir' ? `${e.path}/` : e.type === 'symlink' ? `${e.path} -> (symlink)` : e.type === 'file' ? `${e.path} (${e.size} B)` : `${e.path} (other)`)).join('\n') + (truncated ? `\n…[listing truncated at ${max} entries]` : '');
      return { status: 'success', structured: { path: baseRel === '' ? '.' : baseRel, entries: entries as unknown as JsonValue, truncated }, text };
    },
  };
}

// ----------------------------------------------------------------------------- fs.search

interface SearchInput {
  pattern: string;
  isRegex?: boolean;
  glob?: string;
  path?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

interface Match {
  path: string;
  line: number;
  text: string;
}

async function jsSearch(root: string, start: string, input: SearchInput, max: number): Promise<{ matches: Match[]; truncated: boolean }> {
  let re: RegExp;
  try {
    const src = input.isRegex ? input.pattern : input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(src, input.caseSensitive === false ? 'i' : '');
  } catch (e) {
    throw new HypertestError('invalid_argument', `invalid regular expression: ${(e as Error).message}`);
  }
  const matches: Match[] = [];
  let truncated = false;
  const rootPrefix = root.endsWith('/') ? root : root + '/';
  const walk = async (dir: string): Promise<void> => {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      if (truncated) return;
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      const ls = await lstat(p).catch(() => undefined);
      if (!ls || ls.isSymbolicLink()) continue;
      if (ls.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!ls.isFile() || ls.size > 4 * 1024 * 1024) continue;
      const rel = p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : name;
      if (input.glob && !globMatches(input.glob, rel)) continue;
      const buf = await readFile(p);
      if (buf.subarray(0, 8000).includes(0)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.length > 4096 ? lines[i]!.slice(0, 4096) : lines[i]!;
        if (re.test(line)) {
          if (matches.length >= max) {
            truncated = true;
            return;
          }
          matches.push({ path: rel, line: i + 1, text: line.slice(0, 500) });
        }
      }
    }
  };
  const st = await stat(start);
  if (st.isDirectory()) await walk(start);
  else {
    const rel = start.startsWith(rootPrefix) ? start.slice(rootPrefix.length) : start;
    const lines = (await readFile(start, 'utf8')).split('\n');
    lines.forEach((l, i) => {
      if (matches.length < max && re.test(l)) matches.push({ path: rel, line: i + 1, text: l.slice(0, 500) });
    });
  }
  return { matches, truncated };
}

export function fsSearchTool(options: BuiltinToolOptions): ToolSpec<SearchInput> {
  return {
    id: 'fs.search',
    title: 'Search files',
    description: 'Search file contents in the workspace (ripgrep when available, else a built-in scan). Fixed string by default; isRegex for a regular expression; glob filters files (e.g. "*.ts", "src/**/*.py").',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', minLength: 1, maxLength: 1000 },
        isRegex: { type: 'boolean', default: false },
        glob: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[^-]' },
        path: { type: 'string', minLength: 1, maxLength: 4096 },
        caseSensitive: { type: 'boolean', default: true },
        maxResults: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
      },
    },
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 60_000,
    resources: (input, ctx) => [pathResource(ctx, input.path ?? '.')],
    async execute(input, ctx) {
      const max = input.maxResults ?? 100;
      assertNotGitMetadata(input.path ?? '.', 'fs.search');
      const start = await options.workspaces.resolvePath(ctx.workspace, input.path ?? '.');
      const rel = normalizeRel(input.path ?? '.') || '.';
      const argv = ['rg', '--json', '--no-config', '--max-columns', '500', '--max-filesize', '4M'];
      argv.push(input.isRegex ? '--regexp' : '--fixed-strings', ...(input.isRegex ? [input.pattern] : ['--regexp', input.pattern]));
      if (input.caseSensitive === false) argv.push('--ignore-case');
      if (input.glob) argv.push('--glob', input.glob);
      argv.push('--', rel);
      const r = await options.sandbox.run(ctx.workspace, argv, { timeoutMs: 55_000, signal: ctx.signal, maxOutputBytes: 32 * 1024 * 1024 });
      let matches: Match[] = [];
      let truncated = false;
      let engine: 'ripgrep' | 'js' = 'ripgrep';
      if (r.spawnError) {
        engine = 'js';
        ({ matches, truncated } = await jsSearch(ctx.workspace.root, start, input, max));
      } else {
        if (r.exitCode === 2 || (r.exitCode !== 0 && r.exitCode !== 1)) throw new HypertestError('invalid_argument', `search failed: ${r.stderr.trim().slice(0, 1000)}`);
        for (const line of r.stdout.split('\n')) {
          if (!line.startsWith('{')) continue;
          let ev: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
          try {
            ev = JSON.parse(line) as typeof ev;
          } catch {
            continue;
          }
          if (ev.type !== 'match' || !ev.data) continue;
          if (matches.length >= max) {
            truncated = true;
            break;
          }
          const p = (ev.data.path?.text ?? '').replace(/^\.\//, '');
          matches.push({ path: p, line: ev.data.line_number ?? 0, text: (ev.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 500) });
        }
        if (r.stdoutTruncated) truncated = true;
      }
      const text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n') + (truncated ? `\n…[results truncated at ${max}]` : '') || 'no matches';
      return { status: 'success', structured: { matches: matches as unknown as JsonValue, truncated, engine, count: matches.length }, text };
    },
  };
}

// ----------------------------------------------------------------------------- fs.write

interface WriteInput {
  path: string;
  content: string;
  createDirs?: boolean;
}

export function fsWriteTool(options: BuiltinToolOptions): ToolSpec<WriteInput> {
  return {
    id: 'fs.write',
    title: 'Write file',
    description: 'Create or overwrite a text file in a writable (isolated worktree or scratch) workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: { path: PATH_SCHEMA, content: { type: 'string', maxLength: 8 * 1024 * 1024 }, createDirs: { type: 'boolean', default: true } },
    },
    outputSchema: { type: 'object', required: ['path', 'bytes', 'sha256', 'created'], properties: { path: { type: 'string' }, bytes: { type: 'integer' }, sha256: { type: 'string' }, created: { type: 'boolean' } } },
    effect: 'write_workspace',
    riskClass: 'medium',
    timeoutMs: 30_000,
    resources: (input, ctx) => [pathResource(ctx, input.path)],
    async execute(input, ctx) {
      ensureWritable(ctx.workspace, 'fs.write');
      assertNotGitMetadata(input.path, 'fs.write');
      const abs = await options.workspaces.resolvePath(ctx.workspace, input.path);
      const existing = await lstat(abs).catch(() => undefined);
      if (existing?.isDirectory()) throw new HypertestError('invalid_argument', `${input.path} is a directory`);
      if (input.createDirs !== false) await mkdir(dirname(abs), { recursive: true });
      // re-check after creating parents (a racing symlink cannot redirect the write outside the root)
      const confirmed = await options.workspaces.resolvePath(ctx.workspace, input.path);
      await writeFile(confirmed, input.content);
      const path = normalizeRel(input.path);
      const b = bytes(input.content);
      return { status: 'success', structured: { path, bytes: b, sha256: sha256Hex(input.content), created: existing === undefined }, text: `${existing ? 'updated' : 'created'} ${path} (${b} bytes)` };
    },
  };
}

// ----------------------------------------------------------------------------- fs.apply_patch

/** Unquotes a git C-style quoted path (`"a/sp ace\\t"`). */
function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  const inner = p.slice(1, p.endsWith('"') ? -1 : undefined);
  return inner.replace(/\\(["\\abfnrtv]|[0-7]{3})/g, (_m, e: string) => {
    const map: Record<string, string> = { '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
    return map[e] ?? String.fromCharCode(parseInt(e, 8));
  });
}

/**
 * Paths a unified diff touches (as git apply will name them) and the strip level to use. Header names
 * (`diff --git`, `---`, `+++`) are stripped only when EVERY one carries an `a/`/`b/` prefix (`-p1`);
 * otherwise `-p0` keeps them verbatim — a no-prefix git patch (`diff --git src/x src/x`) applied with `-p1`
 * would silently land on `x`, outside the declared resource. `rename/copy from|to` names are never
 * stripped (git does not strip them at -p0/-p1). Hunk bodies are skipped by their line counts, so content
 * lines that look like headers (`--- a comment`) never influence the result. The execute step still
 * verifies git's own view of the touched paths (`git apply --numstat`) against this declaration.
 */
export function patchPaths(patch: string): { paths: string[]; strip: 0 | 1 } {
  const headerNames: string[] = [];
  const renameNames: string[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === ' ' || line === '') {
        oldLeft--;
        newLeft--;
        continue;
      }
      if (c === '-') {
        oldLeft--;
        continue;
      }
      if (c === '+') {
        newLeft--;
        continue;
      }
      if (c === '\\') continue; // "\ No newline at end of file"
      oldLeft = newLeft = 0; // malformed hunk: git apply --check rejects it; parse the rest as headers
    }
    let m: RegExpExecArray | null;
    if ((m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line))) {
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLeft = m[2] === undefined ? 1 : Number(m[2]);
    } else if ((m = /^diff --git (\S+|"(?:[^"\\]|\\.)*") (\S+|"(?:[^"\\]|\\.)*")\s*$/.exec(line))) {
      headerNames.push(unquote(m[1]!), unquote(m[2]!));
    } else if ((m = /^(?:---|\+\+\+) (.+)$/.exec(line))) {
      const p = unquote(m[1]!.split('\t')[0]!.trim());
      if (p !== '/dev/null') headerNames.push(p);
    } else if ((m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line))) {
      renameNames.push(unquote(m[1]!.trim()));
    }
  }
  const strip: 0 | 1 = headerNames.length > 0 && headerNames.every((p) => p.startsWith('a/') || p.startsWith('b/')) ? 1 : 0;
  const stripped = headerNames.map((p) => (strip === 1 ? p.slice(2) : p));
  const paths = [...new Set([...stripped, ...renameNames])].filter((p) => p !== '' && p !== '/dev/null' && p !== 'dev/null').sort();
  return { paths, strip };
}

/** Paths from `git apply --numstat -z` (renames/copies contribute both names). */
export function parseNumstatPaths(out: string): string[] {
  const tokens = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]*)$/.exec(tokens[i]!);
    if (!m) continue;
    if (m[1] !== '') paths.push(m[1]!);
    else {
      if (tokens[i + 1]) paths.push(tokens[i + 1]!);
      if (tokens[i + 2]) paths.push(tokens[i + 2]!);
      i += 2;
    }
  }
  return [...new Set(paths)].sort();
}

interface PatchInput {
  patch: string;
  check?: boolean;
}

export function fsApplyPatchTool(options: BuiltinToolOptions): ToolSpec<PatchInput> {
  return {
    id: 'fs.apply_patch',
    title: 'Apply patch',
    description: 'Apply a unified diff (git-style a/ b/ prefixes or plain paths) to a writable workspace. The patch is checked first (git apply --check); nothing is changed when it does not apply. check=true only validates.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['patch'],
      properties: { patch: { type: 'string', minLength: 1, maxLength: 8 * 1024 * 1024 }, check: { type: 'boolean', default: false } },
    },
    outputSchema: { type: 'object', required: ['files', 'applied'], properties: { files: { type: 'array', items: { type: 'string' } }, applied: { type: 'boolean' }, additions: { type: 'integer' }, deletions: { type: 'integer' } } },
    effect: 'write_workspace',
    riskClass: 'medium',
    timeoutMs: 60_000,
    resources: (input, ctx) => {
      const { paths } = patchPaths(input.patch);
      return paths.length > 0 ? paths.map((p) => workspaceResource(ctx.workspace, p)) : [rootResource(ctx)];
    },
    async execute(input, ctx) {
      ensureWritable(ctx.workspace, 'fs.apply_patch');
      const { paths, strip } = patchPaths(input.patch);
      if (paths.length === 0) throw new HypertestError('invalid_argument', 'the patch names no files (expected a unified diff with ---/+++ headers)');
      for (const p of paths) {
        assertNotGitMetadata(p, 'fs.apply_patch');
        await options.workspaces.resolvePath(ctx.workspace, p); // throws permission_denied on escape
      }
      const patch = input.patch.endsWith('\n') ? input.patch : input.patch + '\n';
      const args = ['apply', `-p${strip}`, '--whitespace=nowarn'];
      const check = await sandboxGit(options.sandbox, ctx, [...args, '--check', '--verbose', '-'], { stdin: patch, allowCodes: [0, 1, 128] });
      if (check.exitCode !== 0) {
        return { status: 'failed', error: { code: 'precondition_failed', message: `patch does not apply: ${(check.stderr || check.stdout).trim().slice(0, 4000)}` }, structured: { files: paths, applied: false } };
      }
      // git's own reading of the patch must stay within the declared (authorized) paths
      const numstat = await sandboxGit(options.sandbox, ctx, [...args, '--numstat', '-z', '-'], { stdin: patch });
      const declared = new Set(paths);
      const undeclared = parseNumstatPaths(numstat.stdout).filter((p) => !declared.has(p));
      if (undeclared.length > 0) throw new HypertestError('permission_denied', `fs.apply_patch: git would touch undeclared paths ${undeclared.join(', ')} (declared: ${paths.join(', ')})`);
      let additions = 0;
      let deletions = 0;
      for (const line of patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++;
        else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
      }
      if (input.check) return { status: 'success', structured: { files: paths, applied: false, additions, deletions }, text: `patch applies cleanly to ${paths.join(', ')} (not applied: check only)` };
      await sandboxGit(options.sandbox, ctx, [...args, '-'], { stdin: patch });
      return { status: 'success', structured: { files: paths, applied: true, additions, deletions }, text: `applied patch to ${paths.join(', ')} (+${additions} -${deletions})` };
    },
  };
}
