import { HypertestError, type JsonValue } from '@hypertest/core';
import type { BuiltinToolOptions, ToolSpec } from '../../contracts.ts';
import { normalizeRel } from '../paths.ts';
import { assertRev, bytes, ensureWritable, pathResource, PATH_SCHEMA, REV_SCHEMA, rootResource, sandboxGit } from './common.ts';

const AGENT_NAME = 'Hypertest Agent';
const AGENT_EMAIL = 'agent@hypertest.invalid';

async function confinedPaths(options: BuiltinToolOptions, ws: Parameters<BuiltinToolOptions['workspaces']['resolvePath']>[0], paths: readonly string[] | undefined): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths ?? []) {
    await options.workspaces.resolvePath(ws, p);
    const rel = normalizeRel(p);
    out.push(rel === '' ? '.' : rel);
  }
  return out;
}

// ----------------------------------------------------------------------------- git.status

export function gitStatusTool(options: BuiltinToolOptions): ToolSpec<Record<string, never>> {
  return {
    id: 'git.status',
    title: 'Git status',
    description: 'Show the working tree status of the workspace (branch, staged/unstaged/untracked files).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 60_000,
    resources: (_input, ctx) => [rootResource(ctx)],
    async execute(_input, ctx) {
      const r = await sandboxGit(options.sandbox, ctx, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
      const parts = r.stdout.split('\0');
      let branch: string | undefined;
      const entries: Array<{ path: string; index: string; worktree: string; origPath?: string }> = [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]!;
        if (p === '') continue;
        if (p.startsWith('## ')) {
          branch = p.slice(3);
          continue;
        }
        const e: { path: string; index: string; worktree: string; origPath?: string } = { index: p[0]!, worktree: p[1]!, path: p.slice(3) };
        if (p[0] === 'R' || p[0] === 'C') e.origPath = parts[++i] ?? '';
        entries.push(e);
      }
      const text = [`## ${branch ?? '(unknown)'}`, ...entries.map((e) => `${e.index}${e.worktree} ${e.path}${e.origPath ? ` <- ${e.origPath}` : ''}`)].join('\n');
      return { status: 'success', structured: { branch: branch ?? null, clean: entries.length === 0, entries: entries as unknown as JsonValue }, text };
    },
  };
}

// ----------------------------------------------------------------------------- git.diff

interface DiffInput {
  base?: string;
  head?: string;
  paths?: string[];
  staged?: boolean;
  stat?: boolean;
}

export function gitDiffTool(options: BuiltinToolOptions): ToolSpec<DiffInput> {
  return {
    id: 'git.diff',
    title: 'Git diff',
    description: 'Unified diff of the workspace: working tree vs index (default), --staged, vs a base revision, or between base and head. Non-empty diffs are recorded as git-diff evidence.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        base: REV_SCHEMA,
        head: REV_SCHEMA,
        paths: { type: 'array', items: PATH_SCHEMA, maxItems: 200 },
        staged: { type: 'boolean', default: false },
        stat: { type: 'boolean', default: false },
      },
    },
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 60_000,
    resources: (input, ctx) => (input.paths && input.paths.length > 0 ? input.paths.map((p) => pathResource(ctx, p)) : [rootResource(ctx)]),
    async execute(input, ctx) {
      if (input.head !== undefined && input.base === undefined) throw new HypertestError('invalid_argument', 'head requires base');
      if (input.base !== undefined) assertRev(input.base, 'base');
      if (input.head !== undefined) assertRev(input.head, 'head');
      const paths = await confinedPaths(options, ctx.workspace, input.paths);
      const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
      if (input.stat) args.push('--stat');
      if (input.staged) args.push('--cached');
      if (input.base !== undefined) args.push(input.base);
      if (input.head !== undefined) args.push(input.head);
      args.push('--', ...paths);
      const r = await sandboxGit(options.sandbox, ctx, args, { maxOutputBytes: 64 * 1024 * 1024 });
      const files = [...r.stdout.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((m) => m[2]!);
      const structured: Record<string, JsonValue> = { bytes: bytes(r.stdout), files, truncated: r.stdoutTruncated };
      const evidenceRefs: string[] = [];
      if (r.stdout.length > 0 && !input.stat) {
        const ev = await ctx.recordEvidence({
          evidenceType: 'git-diff',
          data: r.stdout,
          mimeType: 'text/x-diff',
          summary: `git diff${input.staged ? ' --staged' : ''}${input.base ? ` ${input.base}` : ''}${input.head ? `..${input.head}` : ''} (${files.length} files)`,
          structured: { base: input.base ?? null, head: input.head ?? null, staged: input.staged === true, files },
          provenance: { command: ['git', ...args] },
        });
        evidenceRefs.push(ev.evidenceId);
      }
      return { status: 'success', structured, text: r.stdout || '(no differences)', evidenceRefs };
    },
  };
}

// ----------------------------------------------------------------------------- git.log

interface LogInput {
  maxCount?: number;
  path?: string;
  since?: string;
  rev?: string;
}

export function gitLogTool(options: BuiltinToolOptions): ToolSpec<LogInput> {
  return {
    id: 'git.log',
    title: 'Git log',
    description: 'Commit history (newest first), optionally for one path, since a date ("2024-01-01", "2 weeks ago") or from a revision.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxCount: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
        path: PATH_SCHEMA,
        since: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9 .:+-]*$' },
        rev: REV_SCHEMA,
      },
    },
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 60_000,
    resources: (input, ctx) => [input.path ? pathResource(ctx, input.path) : rootResource(ctx)],
    async execute(input, ctx) {
      const args = ['log', `--max-count=${input.maxCount ?? 20}`, '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e'];
      if (input.since) args.push(`--since=${input.since}`);
      if (input.rev) {
        assertRev(input.rev, 'rev');
        args.push(input.rev);
      }
      args.push('--');
      if (input.path) args.push(...(await confinedPaths(options, ctx.workspace, [input.path])));
      const r = await sandboxGit(options.sandbox, ctx, args);
      const commits = r.stdout
        .split('\x1e')
        .map((s) => s.replace(/^\n/, ''))
        .filter((s) => s.trim() !== '')
        .map((rec) => {
          const [sha, author, email, date, subject] = rec.split('\x1f');
          return { sha: sha ?? '', author: author ?? '', email: email ?? '', date: date ?? '', subject: (subject ?? '').trimEnd() };
        });
      return { status: 'success', structured: { commits }, text: commits.map((c) => `${c.sha.slice(0, 12)} ${c.date} ${c.author}: ${c.subject}`).join('\n') || '(no commits)' };
    },
  };
}

// ----------------------------------------------------------------------------- git.show

interface ShowInput {
  rev: string;
  path?: string;
}

export function gitShowTool(options: BuiltinToolOptions): ToolSpec<ShowInput> {
  return {
    id: 'git.show',
    title: 'Git show',
    description: 'Show a commit (metadata, stat and patch) or, with path, the content of a file at that revision.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['rev'], properties: { rev: REV_SCHEMA, path: PATH_SCHEMA } },
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 60_000,
    resources: (input, ctx) => [input.path ? pathResource(ctx, input.path) : rootResource(ctx)],
    async execute(input, ctx) {
      assertRev(input.rev, 'rev');
      if (input.rev.includes(':')) throw new HypertestError('invalid_argument', 'rev must not contain ":"; pass the file as path');
      if (input.path !== undefined) {
        const [rel] = await confinedPaths(options, ctx.workspace, [input.path]);
        const r = await sandboxGit(options.sandbox, ctx, ['show', '--no-textconv', `${input.rev}:${rel}`], { maxOutputBytes: 32 * 1024 * 1024 });
        return { status: 'success', structured: { rev: input.rev, path: rel!, bytes: bytes(r.stdout) }, text: r.stdout };
      }
      const r = await sandboxGit(options.sandbox, ctx, ['show', '--no-color', '--no-ext-diff', '--no-textconv', '--stat', '--patch', '--format=fuller', input.rev, '--'], { maxOutputBytes: 32 * 1024 * 1024 });
      const sha = /^commit ([0-9a-f]{40,64})/m.exec(r.stdout)?.[1] ?? null;
      return { status: 'success', structured: { rev: input.rev, commit: sha, bytes: bytes(r.stdout) }, text: r.stdout };
    },
  };
}

// ----------------------------------------------------------------------------- git.blame

interface BlameInput {
  path: string;
  startLine: number;
  endLine: number;
  rev?: string;
}

export function gitBlameTool(options: BuiltinToolOptions): ToolSpec<BlameInput> {
  return {
    id: 'git.blame',
    title: 'Git blame',
    description: 'Line-by-line authorship (commit, author, date, summary) for a 1-based inclusive line range of a file.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'startLine', 'endLine'],
      properties: { path: PATH_SCHEMA, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, rev: REV_SCHEMA },
    },
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 60_000,
    resources: (input, ctx) => [pathResource(ctx, input.path)],
    async execute(input, ctx) {
      if (input.endLine < input.startLine) throw new HypertestError('invalid_argument', 'endLine must be >= startLine');
      if (input.endLine - input.startLine > 5000) throw new HypertestError('invalid_argument', 'at most 5000 lines per blame');
      const [rel] = await confinedPaths(options, ctx.workspace, [input.path]);
      const args = ['blame', '--line-porcelain', '-L', `${input.startLine},${input.endLine}`];
      if (input.rev) {
        assertRev(input.rev, 'rev');
        args.push(input.rev);
      }
      args.push('--', rel!);
      const r = await sandboxGit(options.sandbox, ctx, args);
      const lines: Array<{ line: number; commit: string; author: string; date: string; summary: string; content: string }> = [];
      let cur: { line: number; commit: string; author: string; date: string; summary: string } | undefined;
      for (const l of r.stdout.split('\n')) {
        const head = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(l);
        if (head) {
          cur = { commit: head[1]!, line: Number(head[2]), author: '', date: '', summary: '' };
          continue;
        }
        if (!cur) continue;
        if (l.startsWith('author ')) cur.author = l.slice(7);
        else if (l.startsWith('author-time ')) cur.date = new Date(Number(l.slice(12)) * 1000).toISOString();
        else if (l.startsWith('summary ')) cur.summary = l.slice(8);
        else if (l.startsWith('\t')) {
          lines.push({ ...cur, content: l.slice(1) });
          cur = undefined;
        }
      }
      return { status: 'success', structured: { path: rel!, lines }, text: lines.map((b) => `${b.commit.slice(0, 10)} ${b.date.slice(0, 10)} ${b.author.padEnd(16).slice(0, 16)} ${String(b.line).padStart(5)}| ${b.content}`).join('\n') };
    },
  };
}

// ----------------------------------------------------------------------------- git.commit

interface CommitInput {
  message: string;
  paths?: string[];
}

export function gitCommitTool(options: BuiltinToolOptions): ToolSpec<CommitInput> {
  return {
    id: 'git.commit',
    title: 'Git commit',
    description: `Stage (all changes, or the given paths) and commit in the isolated worktree as "${AGENT_NAME}". Hooks are not run. Only isolated worktrees can be committed to.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: { message: { type: 'string', minLength: 1, maxLength: 5000 }, paths: { type: 'array', items: PATH_SCHEMA, maxItems: 500 } },
    },
    outputSchema: { type: 'object', required: ['commit', 'files'], properties: { commit: { type: 'string' }, branch: { type: ['string', 'null'] }, files: { type: 'array', items: { type: 'string' } } } },
    effect: 'write_workspace',
    riskClass: 'medium',
    timeoutMs: 60_000,
    resources: (input, ctx) => (input.paths && input.paths.length > 0 ? input.paths.map((p) => pathResource(ctx, p)) : [rootResource(ctx)]),
    async execute(input, ctx) {
      ensureWritable(ctx.workspace, 'git.commit');
      if (ctx.workspace.kind !== 'isolated_worktree') throw new HypertestError('permission_denied', `git.commit: only isolated worktrees can be committed to (workspace is ${ctx.workspace.kind})`);
      const branch = ctx.workspace.branch;
      if (!branch) throw new HypertestError('precondition_failed', `git.commit: workspace ${ctx.workspace.workspaceId} has no work branch`);
      // commits land only on the workspace's own work branch (never on a branch or repository HEAD was moved to)
      const head = await sandboxGit(options.sandbox, ctx, ['symbolic-ref', '--quiet', 'HEAD'], { allowCodes: [0, 1] });
      const current = head.stdout.trim();
      if (current !== `refs/heads/${branch}`) {
        throw new HypertestError('permission_denied', `git.commit: HEAD is ${current || '(detached)'}, not the work branch refs/heads/${branch}; refusing to commit`);
      }
      const paths = await confinedPaths(options, ctx.workspace, input.paths);
      const pathspec = paths.length > 0 ? paths : ['.'];
      await sandboxGit(options.sandbox, ctx, ['add', '-A', '--', ...pathspec]);
      // only the requested paths are committed (`commit -- <paths>`), whatever else was staged before
      const staged = await sandboxGit(options.sandbox, ctx, ['diff', '--cached', '--name-only', '-z', '--', ...pathspec]);
      if (staged.stdout.split('\0').every((f) => f === '')) return { status: 'failed', error: { code: 'precondition_failed', message: 'nothing to commit' }, structured: { commit: '', branch, files: [] } };
      const identity = { GIT_AUTHOR_NAME: AGENT_NAME, GIT_AUTHOR_EMAIL: AGENT_EMAIL, GIT_COMMITTER_NAME: AGENT_NAME, GIT_COMMITTER_EMAIL: AGENT_EMAIL };
      const commitArgs = ['-c', `user.name=${AGENT_NAME}`, '-c', `user.email=${AGENT_EMAIL}`, 'commit', '--no-verify', '--quiet', '--file=-'];
      if (paths.length > 0) commitArgs.push('--only', '--', ...paths);
      await sandboxGit(options.sandbox, ctx, commitArgs, { stdin: input.message, env: identity });
      const sha = (await sandboxGit(options.sandbox, ctx, ['rev-parse', 'HEAD'])).stdout.trim();
      const committed = await sandboxGit(options.sandbox, ctx, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', 'HEAD']);
      const files = committed.stdout.split('\0').filter((f) => f !== '').sort();
      return { status: 'success', structured: { commit: sha, branch, files }, text: `committed ${sha.slice(0, 12)} on ${branch} (${files.length} files)` };
    },
  };
}
