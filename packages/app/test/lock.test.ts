import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HypertestError, MemoryLogger } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { acquireDirectoryLock, lockFileFor, lockHolder, processAlive } from '../src/index.ts';

/** The pid of a process that has exited (a stale lock's owner). */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise((resolve) => child.on('exit', resolve));
  return pid;
}

const lockJson = (o: Record<string, unknown>) => `${JSON.stringify({ nonce: 'n-other', acquiredAt: '2026-01-01T00:00:00.000Z', ...o })}\n`;

describe('embedded data directory lock (one process per PGlite directory)', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  before(async () => (dir = await tempDir('ht-app-lock-')));
  after(async () => dir.cleanup());

  test('lockFileFor puts the lock beside the directory, never inside (trailing slash normalized)', () => {
    assert.equal(lockFileFor('/srv/ht/db/'), '/srv/ht/db.lock');
    assert.equal(lockFileFor('/srv/ht/db'), '/srv/ht/db.lock');
  });

  test('exclusive in-process: a second acquire is refused until the first is released (0600 file, removed on release)', async () => {
    const path = join(dir.path, 'a.lock');
    const logger = new MemoryLogger();
    const first = await acquireDirectoryLock(path, 'dir a', logger);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const content = JSON.parse(await readFile(path, 'utf8')) as { pid: number; hostname: string };
    assert.deepEqual([content.pid, content.hostname], [process.pid, hostname()]);
    await assert.rejects(acquireDirectoryLock(path, 'dir a', logger), (e: unknown) => {
      assert.ok(e instanceof HypertestError && e.code === 'precondition_failed');
      assert.match(e.message, /^dir a is in use: it is already open in this process \(lock file .*a\.lock\)/);
      return true;
    });
    assert.deepEqual(await lockHolder(path), { pid: process.pid, hostname: hostname(), alive: true, heldHere: true });
    await first.release();
    await first.release(); // idempotent
    assert.equal(existsSync(path), false);
    assert.equal(await lockHolder(path), undefined);
    const again = await acquireDirectoryLock(path, 'dir a', logger);
    await again.release();
  });

  test('the same directory through a symlink is recognized as already open in this process (never taken over as stale)', async () => {
    const real = join(dir.path, 'real');
    await mkdir(real, { recursive: true });
    const alias = join(dir.path, 'alias');
    await symlink(real, alias);
    const lock = await acquireDirectoryLock(lockFileFor(join(real, 'db')), 'dir', new MemoryLogger());
    try {
      await assert.rejects(acquireDirectoryLock(lockFileFor(join(alias, 'db')), 'dir', new MemoryLogger()), (e: unknown) => e instanceof HypertestError && e.code === 'precondition_failed' && /already open in this process/.test(e.message));
    } finally {
      await lock.release();
    }
    assert.equal(existsSync(lockFileFor(join(real, 'db'))), false);
  });

  test('a lock held by another live process on this host is refused with its pid', async () => {
    const path = join(dir.path, 'b.lock');
    const live = process.ppid;
    assert.equal(processAlive(live), true);
    await writeFile(path, lockJson({ pid: live, hostname: hostname() }));
    await assert.rejects(acquireDirectoryLock(path, 'dir b', new MemoryLogger()), (e: unknown) => {
      assert.ok(e instanceof HypertestError && e.code === 'precondition_failed');
      assert.match(e.message, new RegExp(`held by live process ${live}`));
      assert.equal((e.details as { pid: number }).pid, live);
      return true;
    });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, live, 'the live lock is untouched');
  });

  test('a lock of another host cannot be checked: refused (never silently broken)', async () => {
    const path = join(dir.path, 'c.lock');
    await writeFile(path, lockJson({ pid: 1, hostname: 'some-other-host.invalid' }));
    await assert.rejects(acquireDirectoryLock(path, 'dir c', new MemoryLogger()), (e: unknown) => e instanceof HypertestError && e.code === 'precondition_failed' && /on host some-other-host\.invalid/.test(e.message));
  });

  test('a stale lock (dead pid, or this pid but not held here: a restarted container) is taken over with a warning', async () => {
    for (const [name, pid] of [['d.lock', await deadPid()], ['e.lock', process.pid]] as const) {
      const path = join(dir.path, name);
      await writeFile(path, lockJson({ pid, hostname: hostname() }));
      assert.equal((await lockHolder(path))!.alive, false);
      const logger = new MemoryLogger();
      const lock = await acquireDirectoryLock(path, 'dir', logger);
      assert.deepEqual(logger.entries.filter((e) => e.level === 'warn').map((e) => [e.msg, e.fields?.['previousPid']]), [['took over a stale data directory lock (its process is gone)', pid]]);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, process.pid);
      await lock.release();
    }
  });

  test('release never deletes a lock that was replaced behind the process', async () => {
    const path = join(dir.path, 'f.lock');
    const logger = new MemoryLogger();
    const lock = await acquireDirectoryLock(path, 'dir f', logger);
    await writeFile(path, lockJson({ pid: process.ppid, hostname: hostname(), nonce: 'someone-else' }));
    await lock.release();
    assert.equal(JSON.parse(await readFile(path, 'utf8')).nonce, 'someone-else');
    assert.ok(logger.entries.some((e) => e.msg === 'the data directory lock was replaced behind this process; leaving it'));
  });
});
