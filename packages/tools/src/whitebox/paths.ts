import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, posix, resolve, sep, win32 } from 'node:path';
import { HypertestError } from '@hypertest/core';
import type { WorkspaceHandle } from '../contracts.ts';

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

/**
 * Resolves `relPath` inside `root`. Rejects (permission_denied) absolute paths, NUL bytes, lexical `..`
 * escapes and symlinks whose resolution leaves the root: the deepest EXISTING ancestor of the target
 * (the target itself when it exists) is realpath'ed and must stay inside realpath(root). Returns the
 * absolute path under the real root (so later operations do not re-traverse a symlinked root).
 */
export async function confineExisting(root: string, relPath: string): Promise<string> {
  if (typeof relPath !== 'string') throw new HypertestError('invalid_argument', 'path must be a string');
  if (relPath.includes('\0')) throw new HypertestError('permission_denied', 'path contains NUL');
  if (isAbsolute(relPath) || win32.isAbsolute(relPath) || relPath.startsWith('~')) {
    throw new HypertestError('permission_denied', `absolute paths are not allowed: ${relPath}`);
  }
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (e) {
    throw new HypertestError('not_found', `workspace root ${root} does not exist`, { cause: e });
  }
  const target = resolve(realRoot, relPath === '' ? '.' : relPath);
  if (!inside(realRoot, target)) throw new HypertestError('permission_denied', `path escapes the workspace: ${relPath}`);
  let probe = target;
  while (!(await exists(probe))) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real: string;
  try {
    real = await realpath(probe);
  } catch (e) {
    // a dangling or looping symlink: its target cannot be checked, so it is never followed (a write through a
    // dangling link would create the file wherever the link points)
    throw new HypertestError('permission_denied', `path cannot be resolved inside the workspace (dangling or looping symlink): ${relPath}`, { details: { code: (e as NodeJS.ErrnoException).code } });
  }
  if (!inside(realRoot, real)) throw new HypertestError('permission_denied', `path resolves outside the workspace through a symlink: ${relPath}`);
  return target;
}

/** Workspace-relative POSIX form of a path (for resource keys and model output): no leading `./`. */
export function normalizeRel(relPath: string): string {
  const n = posix.normalize(String(relPath).replaceAll('\\', '/'));
  if (n === '.' || n === './') return '';
  return n.replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Resource key for a workspace path: `<resourcePrefix>/<normalized path>` (the prefix itself for the root).
 * Traversal and absolute paths yield non-canonical keys (`..`/empty segments) that capability checks deny.
 */
export function workspaceResource(ws: Pick<WorkspaceHandle, 'resourcePrefix'>, relPath: string | undefined): string {
  const rel = normalizeRel(relPath ?? '.');
  return rel === '' ? ws.resourcePrefix : `${ws.resourcePrefix}/${rel}`;
}

/** Relative path of an absolute path under root, POSIX separators. */
export function relFromRoot(root: string, abs: string): string {
  const r = abs.startsWith(root) ? abs.slice(root.length).replace(/^[/\\]+/, '') : abs;
  return r.split(sep).join('/');
}

