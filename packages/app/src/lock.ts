import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { HypertestError, type Logger } from '@hypertest/core';

/**
 * Exclusive ownership of an embedded (PGlite) data directory by ONE process. PGlite has no locking of its own: two
 * processes that open the same directory silently lose each other's writes, and both would act as the same worker
 * (`worker:<hostname>`), which defeats lease fencing. The lock is a file `<dir>.lock` created with O_EXCL holding
 * `{ pid, hostname, nonce, acquiredAt }`. A lock whose process is gone (same host, pid not alive, or our own pid
 * but not held by this process — a restarted container) is stale and taken over atomically (rename, then verify).
 */

export interface DirectoryLock {
  readonly path: string;
  release(): Promise<void>;
}

interface LockInfo {
  pid: number;
  hostname: string;
  nonce: string;
  acquiredAt: string;
}

/** Lock files held by this process (a second open of the same directory in-process is refused as well). */
const HELD = new Map<string, string>();
/** A lock file younger than this whose content cannot be parsed is being written by its creator. */
const UNPARSEABLE_GRACE_MS = 10_000;
const MAX_ATTEMPTS = 8;

/** `<dir>.lock` for a data directory (normalized: a trailing slash never puts the lock inside the directory). */
export function lockFileFor(dir: string): string {
  return `${resolve(dir)}.lock`;
}

function parse(raw: string): LockInfo | undefined {
  try {
    const v = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof v.pid === 'number' && Number.isSafeInteger(v.pid) && typeof v.hostname === 'string' && typeof v.nonce === 'string') return v as LockInfo;
  } catch {
    // unparseable
  }
  return undefined;
}

/** Whether a process with this pid exists on this host (EPERM: it exists but belongs to someone else). */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** The current holder of a lock file (for `hypertest doctor`), or undefined when unlocked. */
export async function lockHolder(path: string): Promise<{ pid?: number; hostname?: string; alive: boolean | undefined; heldHere: boolean } | undefined> {
  const raw = await readIfExists(path);
  if (raw === undefined) return undefined;
  const info = parse(raw);
  if (!info) return { alive: undefined, heldHere: false };
  const sameHost = info.hostname === hostname();
  const heldHere = HELD.get(path) === info.nonce;
  return { pid: info.pid, hostname: info.hostname, alive: sameHost ? heldHere || (info.pid !== process.pid && processAlive(info.pid)) : undefined, heldHere };
}

function inUse(path: string, what: string, detail: string, details: Record<string, unknown>): HypertestError {
  return new HypertestError('precondition_failed', `${what} is in use: ${detail} (lock file ${path}). One process per embedded data directory: stop the other process, or use a postgres store for several workers.`, {
    details: { lockFile: path, ...details },
  });
}

/**
 * Acquires `path` exclusively for this process. Throws `precondition_failed` when another live process (or this one)
 * holds it, or when a lock of another host cannot be checked (remove the file once that host is gone).
 */
export async function acquireDirectoryLock(path: string, what: string, logger: Logger): Promise<DirectoryLock> {
  const me: LockInfo = { pid: process.pid, hostname: hostname(), nonce: randomBytes(12).toString('hex'), acquiredAt: new Date().toISOString() };
  const content = `${JSON.stringify(me)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (HELD.has(path)) throw inUse(path, what, 'it is already open in this process', { pid: process.pid });
    let fh;
    try {
      fh = await open(path, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (fh) {
      try {
        await fh.writeFile(content);
        await fh.sync();
      } finally {
        await fh.close();
      }
      HELD.set(path, me.nonce);
      return { path, release: once(() => release(path, me.nonce, logger)) };
    }
    // someone holds (or held) it
    const raw = await readIfExists(path);
    if (raw === undefined) continue; // released meanwhile
    const info = parse(raw);
    if (!info) {
      const age = Date.now() - (await stat(path).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      if (age < UNPARSEABLE_GRACE_MS) {
        await new Promise((r) => setTimeout(r, 50 * attempt));
        continue;
      }
    } else if ([...HELD.values()].includes(info.nonce)) {
      // held by this process under another spelling of the path (e.g. through a symlink)
      throw inUse(path, what, 'it is already open in this process', { pid: process.pid });
    } else if (info.hostname !== me.hostname) {
      throw inUse(path, what, `held by process ${info.pid} on host ${info.hostname}, which cannot be checked from here`, { pid: info.pid, hostname: info.hostname });
    } else if (info.pid !== process.pid && processAlive(info.pid)) {
      throw inUse(path, what, `held by live process ${info.pid}`, { pid: info.pid });
    }
    // stale: take it over atomically — move it aside, and put it back if it changed after we read it
    const aside = `${path}.stale-${randomBytes(6).toString('hex')}`;
    try {
      await rename(path, aside);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    const moved = await readIfExists(aside);
    if (moved !== raw) {
      // a racing process re-created the lock between our read and the rename: restore it (unless yet another exists)
      await link(aside, path).catch(() => undefined);
      await unlink(aside).catch(() => undefined);
      continue;
    }
    await unlink(aside).catch(() => undefined);
    logger.warn('took over a stale data directory lock (its process is gone)', { lockFile: path, previousPid: info?.pid ?? null });
  }
  throw new HypertestError('unavailable', `${what}: could not acquire lock file ${path} after ${MAX_ATTEMPTS} attempts`, { retryable: true, details: { lockFile: path } });
}

function once(fn: () => Promise<void>): () => Promise<void> {
  let p: Promise<void> | undefined;
  return () => (p ??= fn());
}

async function release(path: string, nonce: string, logger: Logger): Promise<void> {
  if (HELD.get(path) !== nonce) return;
  HELD.delete(path);
  const raw = await readIfExists(path);
  if (raw === undefined || parse(raw)?.nonce !== nonce) {
    logger.warn('the data directory lock was replaced behind this process; leaving it', { lockFile: path });
    return;
  }
  await unlink(path).catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  });
}
