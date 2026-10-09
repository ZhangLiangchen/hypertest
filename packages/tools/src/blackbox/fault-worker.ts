/**
 * Fault reverter (standalone process). Usage: `node fault-worker.ts <jobDir>`.
 *
 * A container/cluster fault (env.inject_fault on a docker or kubectl environment) is applied by its adapter; this detached
 * process holds its time box: it reads `<jobDir>/spec.json`, writes `<jobDir>/pid`, waits until `expiresAt` (or a
 * `stop.json` marker — an early end), runs every `revert` command (argv, no shell; each with `timeoutMs`) and writes
 * `<jobDir>/state.json` = `{ state: 'reverted' | 'revert_failed', revertedAt, results }` atomically. It outlives the
 * Hypertest process that started it (a crash never leaves a fault in place past its time box); an adapter that finds
 * an overdue fault whose reverter is gone reverts it itself (the revert commands are idempotent).
 * (review) The adapter starts this process BEFORE it applies the fault: a Hypertest process that dies while (or right
 * after) the apply command runs leaves a job without an apply outcome (`applied.json` / `not-applied.json`) — the fault
 * may be in place, so at expiry it is reverted all the same (after waiting for an apply outcome until `settleBy`, the
 * bound of the apply command). Only a definitive refusal (`not-applied.json`) ends the job without a revert.
 *
 * Deliberately depends on node: built-ins only.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FaultRevertCommand {
  argv: string[];
  timeoutMs?: number;
}

export interface FaultJobSpec {
  operationId: string;
  environmentId: string;
  kind: string;
  appliedAt: string;
  expiresAt: string;
  revert: FaultRevertCommand[];
  /**
   * (review) By when the apply command has finished or was abandoned (its timeout): a job still without an apply outcome
   * then is treated as applied (it may be in place) and reverted. Absent: `expiresAt`.
   */
  settleBy?: string;
}

/** (review) When a job without an apply outcome is treated as applied (the later of its expiry and `settleBy`). */
export function settleDeadline(spec: Pick<FaultJobSpec, 'expiresAt' | 'settleBy'>): number {
  const expires = Date.parse(spec.expiresAt);
  const settle = spec.settleBy !== undefined ? Date.parse(spec.settleBy) : Number.NaN;
  return Number.isFinite(settle) ? Math.max(expires, settle) : expires;
}

export interface FaultJobState {
  state: 'reverted' | 'revert_failed';
  revertedAt: string;
  results: Array<{ argv: string[]; exitCode: number | null; stderr: string }>;
  /** Who reverted: the reverter process, or the adapter that found the fault overdue. */
  by: 'reverter' | 'adapter';
}

function writeAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

/** Runs the revert commands in order (all of them, even after a failure) and records the outcome. */
export async function runRevert(jobDir: string, spec: FaultJobSpec, by: FaultJobState['by']): Promise<FaultJobState> {
  const results: FaultJobState['results'] = [];
  for (const c of spec.revert) {
    const r = await new Promise<{ exitCode: number | null; stderr: string }>((resolve) => {
      execFile(c.argv[0]!, c.argv.slice(1), { timeout: c.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, _stdout, stderr) => {
        const e = error as (NodeJS.ErrnoException & { code?: string | number }) | null;
        resolve({ exitCode: e ? (typeof e.code === 'number' ? e.code : 127) : 0, stderr: String(stderr ?? '').slice(0, 2000) || (e?.message ?? '') });
      });
    });
    results.push({ argv: c.argv, ...r });
  }
  const state: FaultJobState = { state: results.every((r) => r.exitCode === 0) ? 'reverted' : 'revert_failed', revertedAt: new Date().toISOString(), results, by };
  // a concurrent reverter (process + adapter) never overwrites a recorded outcome
  if (!existsSync(join(jobDir, 'state.json'))) writeAtomic(join(jobDir, 'state.json'), state);
  return JSON.parse(readFileSync(join(jobDir, 'state.json'), 'utf8')) as FaultJobState;
}

async function main(jobDir: string): Promise<void> {
  const spec = JSON.parse(readFileSync(join(jobDir, 'spec.json'), 'utf8')) as FaultJobSpec;
  writeFileSync(join(jobDir, 'pid'), String(process.pid));
  const until = Date.parse(spec.expiresAt);
  // wake up at the expiry, or early on a stop marker (checked every 250 ms)
  const waitUntil = (deadline: number, done: () => boolean) =>
    new Promise<void>((resolve) => {
      const tick = () => {
        if (Date.now() >= deadline || done()) return resolve();
        setTimeout(tick, Math.min(250, Math.max(10, deadline - Date.now())));
      };
      tick();
    });
  const has = (name: string) => existsSync(join(jobDir, name));
  await waitUntil(until, () => has('stop.json') || has('state.json') || has('not-applied.json'));
  // (review) a definitive refusal: nothing was applied, nothing to revert
  if (has('state.json') || has('not-applied.json')) return;
  // no apply outcome yet: the apply may still be running — wait for it until settleBy, then revert all the same (a fault
  // whose applier died may be in place)
  // (`abandoned.json`: the applier gave up on the apply — a timeout or abort — so its outcome will not be known any better)
  if (!has('applied.json')) await waitUntil(settleDeadline(spec), () => has('applied.json') || has('abandoned.json') || has('not-applied.json') || has('state.json'));
  if (has('state.json') || has('not-applied.json')) return;
  await runRevert(jobDir, spec, 'reverter');
}

if (process.argv[1] && process.argv[1].endsWith('fault-worker.ts') && process.argv[2]) {
  main(process.argv[2]).then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
