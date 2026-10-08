import { spawn } from 'node:child_process';
import { HypertestError, abortReason } from '@hypertest/core';
import type { ProcessResult, SandboxSession } from '../contracts.ts';

export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_KILL_GRACE_MS = 2000;

export interface SpawnRequest {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number;
  killGraceMs?: number;
  /** Extra termination step (e.g. `docker kill <name>`), run once on timeout/abort. */
  onTerminate?: () => void;
}

/** Bounded capture of one output stream (keeps draining after the limit so the child never blocks). */
class Capture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  truncated = false;
  readonly #limit: number;
  constructor(limit: number) {
    this.#limit = limit;
  }
  push(chunk: Buffer): void {
    const remaining = this.#limit - this.#bytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.byteLength > remaining) {
      // cut on a UTF-8 code point boundary
      let cut = remaining;
      while (cut > 0 && (chunk[cut]! & 0xc0) === 0x80) cut--;
      this.#chunks.push(chunk.subarray(0, cut));
      this.#bytes = this.#limit;
      this.truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
  }
  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, sig);
  } catch {
    // group already gone
  }
}

/**
 * Process groups of commands still running. Children are detached (own session), so they would outlive
 * this process if it exits mid-run (shutdown, a test runner timing out); the exit hook kills them.
 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  liveGroups.add(pid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const g of liveGroups) killGroup(g, 'SIGKILL');
    });
  }
}

/**
 * Spawns argv[0] WITHOUT a shell in its own process group (detached). Timeout ⇒ SIGTERM to the group,
 * SIGKILL after `killGraceMs`, result `timedOut: true`. Abort ⇒ same termination, then rejects with the
 * abort reason. When the main process exits, leftover members of its group (background children) are
 * killed so nothing outlives the call. A program that cannot be started yields exitCode 127 + spawnError.
 */
export function spawnProcess(req: SpawnRequest): Promise<ProcessResult> {
  if (!Array.isArray(req.argv) || req.argv.length === 0 || req.argv.some((a) => typeof a !== 'string')) {
    return Promise.reject(new HypertestError('invalid_argument', 'command must be a non-empty array of strings'));
  }
  if (req.argv.some((a) => a.includes('\0'))) return Promise.reject(new HypertestError('invalid_argument', 'command arguments must not contain NUL'));
  if (!Number.isFinite(req.timeoutMs) || req.timeoutMs <= 0) return Promise.reject(new HypertestError('invalid_argument', 'timeoutMs must be a positive number'));
  if (req.signal.aborted) return Promise.reject(abortReason(req.signal));
  const limit = req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const grace = req.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const started = Date.now();

  return new Promise<ProcessResult>((resolve, reject) => {
    const out = new Capture(limit);
    const err = new Capture(limit);
    let timedOut = false;
    let aborted = false;
    let terminated = false;
    let exited = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(req.argv[0]!, req.argv.slice(1), {
      cwd: req.cwd,
      env: req.env,
      detached: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    trackGroup(child.pid);

    const terminate = () => {
      if (terminated) return;
      terminated = true;
      try {
        req.onTerminate?.();
      } catch {
        // best effort
      }
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), grace);
      killTimer.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, req.timeoutMs);
    timer.unref();

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      req.signal.removeEventListener('abort', onAbort);
      if (child.pid !== undefined) liveGroups.delete(child.pid);
    };

    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.stdin.on('error', () => undefined); // EPIPE when the child does not read stdin

    child.once('error', (e: NodeJS.ErrnoException) => {
      cleanup();
      if (exited) return;
      exited = true;
      if (aborted) return reject(abortReason(req.signal));
      resolve({
        exitCode: 127,
        signal: null,
        stdout: '',
        stderr: `failed to start ${req.argv[0]}: ${e.message}`,
        durationMs: Date.now() - started,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        spawnError: e.code ?? e.message,
      });
    });

    child.once('exit', () => {
      // reap background members of the group; their inherited pipes would otherwise keep 'close' pending
      killGroup(child.pid, 'SIGKILL');
    });

    child.once('close', (code, signal) => {
      cleanup();
      if (exited) return;
      exited = true;
      if (aborted && !timedOut) return reject(abortReason(req.signal));
      resolve({
        exitCode: code,
        signal: signal ?? null,
        stdout: out.text(),
        stderr: err.text(),
        durationMs: Date.now() - started,
        timedOut,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
      });
    });

    if (req.stdin !== undefined) child.stdin.end(req.stdin);
    else child.stdin.end();
  });
}

/**
 * (additive, wave 3) An interactive process in its own process group (detached, no shell, piped stdio) for
 * SandboxRunner.session: `kill()`, the caller's `signal` or `timeoutMs` terminate the group (SIGTERM, SIGKILL after
 * `killGraceMs`); `onClose` runs once after the process exited (sandbox resources released). A process that cannot be
 * started rejects `exited`'s waiters through a closed session (exitCode 127).
 */
export function spawnSession(req: { argv: string[]; cwd: string; env: Record<string, string>; signal: AbortSignal; timeoutMs?: number; killGraceMs?: number; onClose?: () => Promise<void> }): SandboxSession {
  if (!Array.isArray(req.argv) || req.argv.length === 0 || req.argv.some((a) => typeof a !== 'string' || a.includes('\0'))) throw new HypertestError('invalid_argument', 'command must be a non-empty array of strings without NUL');
  if (req.signal.aborted) throw abortReason(req.signal);
  const grace = req.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const child = spawn(req.argv[0]!, req.argv.slice(1), { cwd: req.cwd, env: req.env, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  trackGroup(child.pid);
  let terminated = false;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    if (terminated) return;
    terminated = true;
    killGroup(child.pid, 'SIGTERM');
    killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), grace);
    killTimer.unref();
  };
  const onAbort = () => terminate();
  req.signal.addEventListener('abort', onAbort, { once: true });
  const timer = req.timeoutMs !== undefined ? setTimeout(() => {
    timedOut = true;
    terminate();
  }, req.timeoutMs) : undefined;
  timer?.unref();
  child.stdin.on('error', () => undefined);
  const exited = new Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }>((resolve) => {
    let done = false;
    const finish = (exitCode: number | null, signal: string | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      req.signal.removeEventListener('abort', onAbort);
      if (child.pid !== undefined) liveGroups.delete(child.pid);
      void (req.onClose ? req.onClose().catch(() => undefined) : Promise.resolve()).then(() => resolve({ exitCode, signal, timedOut }));
    };
    child.once('error', () => finish(127, null));
    child.once('exit', () => killGroup(child.pid, 'SIGKILL'));
    child.once('close', (code, signal) => finish(code, signal ?? null));
  });
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    async kill() {
      terminate();
      await exited;
    },
  };
}
