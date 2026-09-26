import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, posix, resolve, sep } from 'node:path';
import type { WorkspaceHandle } from '../contracts.ts';

/**
 * Argument confinement for agent-supplied argv (shell.exec, test.run `framework: 'command'`) — security-H1a.
 *
 * The local sandbox confines the child's cwd and environment, but a program resolves its ARGUMENTS itself: `cat
 * /abs/secret`, `sed -n 'w ../other-worktree/x'`, `node -e "fs.readFileSync('/etc/…')"` would read or write outside the
 * workspace. Every path-like token of every argument (argv[1..]; tokens are split at whitespace, quotes and the usual
 * separators of flags, lists and scripts, so paths embedded in sed/awk/-e scripts and `--flag=/path` are found too; a
 * `file://` URL counts as its path, other URLs are skipped) is resolved against the cwd and refused when it
 *   - climbs out of the workspace with `..` (whether the target exists or not),
 *   - is absolute and names an existing path outside the workspace, or a path under an existing directory outside it
 *     (a write target), or
 *   - resolves inside the workspace but leaves it through a symlink.
 * Allowed outside the workspace: the workspace's private temp dir (sandbox HOME/TMPDIR) and /dev/null, /dev/stdin,
 * /dev/stdout, /dev/stderr. An absolute token whose top-level directory does not exist (a regex `/^#/d`, an API path
 * `/api/v1`) is not a filesystem path on this host and passes.
 *
 * This is DEFENCE IN DEPTH, not a security boundary: an interpreter (node, python3, awk, make, npm scripts, git
 * aliases) can compute a path at run time (`'/' + 'etc'`). Untrusted execution needs the OCI sandbox (or another
 * OS-level jail); keep secret material outside any directory the sandboxed process can reach.
 */

const ALLOWED_DEVICES: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr']);
/** Separators between path tokens inside one argument (whitespace, quotes, flag/list/script punctuation). */
const TOKEN_SPLIT = /[\s'"`=,;()[\]{}<>|&*!?]+/;
const URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
const MAX_TOKEN_CHARS = 4096;
const MAX_TOKENS = 20_000;

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Deepest existing ancestor of `p` (p itself when it exists). */
async function deepestExisting(p: string): Promise<string> {
  let probe = p;
  while (!(await exists(probe))) {
    const parent = dirname(probe);
    if (parent === probe) return probe;
    probe = parent;
  }
  return probe;
}

interface Candidate {
  token: string;
  absolute: boolean;
}

/** Path-like tokens of one argument. */
export function argumentPathTokens(arg: string): Candidate[] {
  const out: Candidate[] = [];
  for (const raw of arg.split(TOKEN_SPLIT)) {
    if (raw === '' || raw.length > MAX_TOKEN_CHARS) continue;
    const url = URL_RE.exec(raw);
    if (url) {
      if (url[1]!.toLowerCase() !== 'file') continue; // network URLs are egress (capability/policy), not paths
      const rest = raw.slice(url[0].length);
      const path = rest.startsWith('/') ? rest : rest.slice(Math.max(0, rest.indexOf('/'))); // file://host/path
      if (path.startsWith('/')) out.push({ token: decodeURIComponentSafe(path), absolute: true });
      continue;
    }
    // PATH-like lists (`a:/b`, `--x:/tmp`): every element is a candidate
    for (const t of raw.split(':')) {
      if (t === '' || t.startsWith('~')) continue; // no shell: `~` is never expanded
      // a bare `/` inside a larger argument is a regex/script delimiter (`s/a;b/c/`), not the root directory; an
      // argument that IS `/` (e.g. `grep -r secret /`) still names the root
      if (/^\/+$/.test(t) && arg.trim() !== t) continue;
      out.push({ token: t, absolute: t.startsWith('/') });
    }
  }
  return out;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function realRoots(ws: WorkspaceHandle): Promise<string[]> {
  const roots = [resolve(ws.root)];
  if (ws.tempDir) roots.push(resolve(ws.tempDir));
  const real = await Promise.all(roots.map((r) => realpath(r).catch(() => r)));
  return [...new Set([...roots, ...real])];
}

/** Why a single candidate is refused (undefined when it is acceptable). */
async function candidateDenial(c: Candidate, cwd: string, roots: readonly string[]): Promise<string | undefined> {
  const abs = c.absolute ? posix.normalize(c.token) : resolve(cwd, c.token);
  if (ALLOWED_DEVICES.has(abs)) return undefined;
  if (roots.some((r) => inside(r, abs))) {
    // inside lexically: the deepest existing part must also resolve inside (no symlink escape)
    const probe = await deepestExisting(abs);
    let real: string;
    try {
      real = await realpath(probe);
    } catch {
      return `${c.token} cannot be resolved inside the workspace (dangling or looping symlink)`;
    }
    return roots.some((r) => inside(r, real)) ? undefined : `${c.token} leaves the workspace through a symlink`;
  }
  if (!c.absolute) return `${c.token} climbs out of the workspace (..)`;
  const probe = await deepestExisting(abs);
  if (probe === abs) return `${c.token} names an existing path outside the workspace`;
  if (probe !== '/' && probe !== abs) return `${c.token} is a path under ${probe}, outside the workspace`;
  return undefined;
}

/**
 * Why agent-supplied argv is refused (undefined when every argument stays inside the workspace). `cwd` is the absolute
 * working directory the command will run in (inside the root). argv[0] is the program (checked by the allowlist).
 */
export async function argumentPathDenial(ws: WorkspaceHandle, cwd: string, argv: readonly string[]): Promise<string | undefined> {
  const roots = await realRoots(ws);
  const base = isAbsolute(cwd) ? cwd : resolve(ws.root, cwd);
  let seen = 0;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    for (const c of argumentPathTokens(arg)) {
      if (++seen > MAX_TOKENS) return `argument list too large to confine (more than ${MAX_TOKENS} path-like tokens)`;
      const why = await candidateDenial(c, base, roots);
      if (why) return `argument ${i} (${JSON.stringify(arg.length > 120 ? `${arg.slice(0, 117)}...` : arg)}): ${why}; arguments may only name paths inside the workspace`;
    }
  }
  return undefined;
}
