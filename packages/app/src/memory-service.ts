import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HypertestError, UlidIdGenerator, jsonLogger, noopLogger, systemClock, type Logger } from '@hypertest/core';
import { collabMigrations, createEventStore } from '@hypertest/collab';
import { contextMigrations, createExperienceStore, listenMemoryService } from '@hypertest/context';
import { migrate, openDatabase } from '@hypertest/store';
import { isLoopbackHost } from './api.ts';
import { acquireDirectoryLock, lockFileFor } from './lock.ts';

/**
 * (B[4]) The L4 durable memory as a SEPARATE service: its own process, its own storage, an HTTP API (the one
 * PowerContextClient speaks — see @hypertest/context createMemoryServiceHandler).
 *  - serveMemory(): opens the service's own store (an embedded PGlite directory, held exclusively), migrates it (event store +
 *    experience store) and listens. `hypertest memory serve` runs it in the foreground; `memory.kind: powercontext` points a
 *    deployment at it (or at any service speaking the same API).
 *  - startMemoryServiceProcess(): `memory.kind: service` — Hypertest starts this module as a child process, waits for it to
 *    listen, talks to it over HTTP with a per-start random bearer token, and stops it on close().
 * Run as a program, this module reads HT_MEMORY_DATA_DIR, HT_MEMORY_HOST, HT_MEMORY_PORT and HT_MEMORY_API_KEY, prints one
 * JSON line `{"url": …}` on stdout once it listens, and stops on SIGTERM / SIGINT or when its stdin closes (its parent is gone).
 */
export interface MemoryServiceConfig {
  /** The service's own PGlite data directory. */
  dataDir: string;
  host?: string;
  port?: number;
  /** Bearer token clients must present (required on a non-loopback host). */
  apiKey?: string;
  logger?: Logger;
}

export interface RunningMemoryService {
  readonly url: string;
  close(): Promise<void>;
}

/** Opens the memory service's own store and serves its API until close(). */
export async function serveMemory(options: MemoryServiceConfig): Promise<RunningMemoryService> {
  const logger = options.logger ?? noopLogger;
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host) && !options.apiKey) throw new HypertestError('invalid_argument', `refusing to serve the memory service on non-loopback host ${host} without an API key`);
  if (options.apiKey !== undefined && options.apiKey.length < 16) throw new HypertestError('invalid_argument', 'the memory service API key must be at least 16 characters');
  const dataDir = resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = await acquireDirectoryLock(lockFileFor(dataDir), `memory service data directory ${dataDir}`, logger);
  const closers: Array<() => Promise<void>> = [() => lock.release()];
  const closeAll = async () => {
    for (const c of closers.splice(0).reverse()) await c().catch((e: unknown) => logger.warn('memory service: close step failed', { error: (e as Error).message }));
  };
  try {
    const db = await openDatabase({ kind: 'pglite', dataDir });
    closers.push(() => db.close());
    await migrate(db, [...collabMigrations, ...contextMigrations]);
    const base = { ids: new UlidIdGenerator(), clock: systemClock, logger };
    const events = createEventStore({ ...base, db });
    const memory = createExperienceStore({ ...base, db, events });
    const server = await listenMemoryService({ memory, host, ...(options.port !== undefined ? { port: options.port } : {}), ...(options.apiKey ? { apiKey: options.apiKey } : {}), logger });
    closers.push(() => server.close());
    logger.info('memory service listening', { url: server.url, dataDir });
    return { url: server.url, close: closeAll };
  } catch (e) {
    await closeAll();
    throw e;
  }
}

export interface MemoryServiceProcess extends RunningMemoryService {
  /** The bearer token of this start (random unless one was given). */
  readonly apiKey: string;
  readonly pid: number;
}

const MODULE_PATH = fileURLToPath(import.meta.url);

/**
 * Starts the memory service as a child process (this module run by the current node binary) and waits until it listens.
 * The child gets only the variables it needs (no model credentials). close() sends SIGTERM and waits for the exit
 * (SIGKILL after `stopTimeoutMs`).
 */
export async function startMemoryServiceProcess(options: { dataDir: string; apiKey?: string; logger?: Logger; startTimeoutMs?: number; stopTimeoutMs?: number }): Promise<MemoryServiceProcess> {
  const logger = options.logger ?? noopLogger;
  const apiKey = options.apiKey ?? randomBytes(24).toString('base64url');
  const env: Record<string, string> = { HT_MEMORY_DATA_DIR: resolve(options.dataDir), HT_MEMORY_HOST: '127.0.0.1', HT_MEMORY_PORT: '0', HT_MEMORY_API_KEY: apiKey };
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT']) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  const child = spawn(process.execPath, [MODULE_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr = (stderr + d).slice(-4000);
  });
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  let url: string;
  try {
    url = await new Promise<string>((done, fail) => {
      let out = '';
      const timer = setTimeout(() => fail(new HypertestError('unavailable', `the memory service did not start within ${options.startTimeoutMs ?? 30_000}ms: ${stderr.trim().slice(-500)}`)), options.startTimeoutMs ?? 30_000);
      const onData = (d: string) => {
        out += d;
        const nl = out.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        try {
          const ready = JSON.parse(out.slice(0, nl)) as { url?: unknown };
          if (typeof ready.url !== 'string') throw new Error('no url');
          done(ready.url);
        } catch {
          fail(new HypertestError('unavailable', `the memory service printed an unexpected ready line: ${out.slice(0, nl).slice(0, 200)}`));
        }
      };
      child.stdout.setEncoding('utf8').on('data', onData);
      child.once('error', (e) => {
        clearTimeout(timer);
        fail(new HypertestError('unavailable', `the memory service could not be started: ${e.message}`, { cause: e }));
      });
      void exited.then((code) => {
        clearTimeout(timer);
        fail(new HypertestError('unavailable', `the memory service exited (code ${String(code)}) before it listened: ${stderr.trim().slice(-500)}`));
      });
    });
  } catch (e) {
    child.kill('SIGKILL');
    await exited;
    throw e;
  }
  // later output is drained (never blocks the child on a full pipe)
  child.stdout.resume();
  logger.info('memory service process started', { url, pid: child.pid });
  let closing: Promise<void> | undefined;
  return {
    url,
    apiKey,
    pid: child.pid!,
    close: () =>
      (closing ??= (async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), options.stopTimeoutMs ?? 10_000);
        await exited;
        clearTimeout(timer);
        child.stdin.destroy();
        logger.info('memory service process stopped', { pid: child.pid });
      })()),
  };
}

function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== 'string' || argv1 === '') return false;
  try {
    return realpathSync(argv1) === realpathSync(MODULE_PATH);
  } catch {
    return false;
  }
}

/** The program: serve until SIGTERM / SIGINT or the end of stdin. */
async function main(): Promise<void> {
  const dataDir = process.env['HT_MEMORY_DATA_DIR'];
  if (!dataDir) throw new HypertestError('invalid_argument', 'HT_MEMORY_DATA_DIR is required');
  const port = Number(process.env['HT_MEMORY_PORT'] ?? '0');
  const logger = jsonLogger({ level: 'warn', fields: { component: 'memory-service' }, stream: process.stderr });
  const service = await serveMemory({
    dataDir, port, logger,
    ...(process.env['HT_MEMORY_HOST'] ? { host: process.env['HT_MEMORY_HOST'] } : {}),
    ...(process.env['HT_MEMORY_API_KEY'] ? { apiKey: process.env['HT_MEMORY_API_KEY'] } : {}),
  });
  process.stdout.write(`${JSON.stringify({ url: service.url })}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void service.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stdin.on('end', stop).on('close', stop).resume();
}

if (isEntry()) {
  main().catch((e: unknown) => {
    process.stderr.write(`memory service failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
