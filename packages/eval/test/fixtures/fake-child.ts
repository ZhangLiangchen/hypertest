/**
 * A fake trial child for the kill/restart helper tests: it speaks the progress protocol without composing Hypertest.
 * Script (job.brainsArgs): { dispatches, ids, intervalMs, onStart: 'hang' | 'exit', exitCode, ops?, resumeOps? }. A `start`
 * child writes `started` and `dispatches` operation.dispatched lines (operation ids op_1…, or exactly `ids` in order —
 * repeat an id to model a re-dispatch of the same operation), or the operation state lines `ops` ({operationId,
 * operationType, to}), then hangs (until killed) or exits; a `resume` child writes `started`, then the lines of
 * `resumeOps[attempt]` and hangs, or (none for its attempt) `completed` and exits with `exitCode`.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import type { TrialChildJob } from '../../src/index.ts';

type OpLine = { operationId: string; operationType?: string; to: string };
const job = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as TrialChildJob;
const script = (job.brainsArgs ?? {}) as {
  dispatches?: number; ids?: string[]; intervalMs?: number; onStart?: 'hang' | 'exit'; exitCode?: number; ops?: OpLine[]; resumeOps?: Record<string, OpLine[]>;
};
const runId = job.input.runId!;
const write = (e: Record<string, unknown>): void => appendFileSync(job.progressFile, `${JSON.stringify({ ...e, pid: process.pid, at: new Date().toISOString() })}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let seq = 1000 * ((job.attempt ?? 1) - 1);
const writeOp = (o: OpLine): void =>
  write({ type: 'operation', runId, seq: (seq += 10), eventType: o.to === 'dispatching' ? 'operation.dispatched' : `operation.${o.to}`, operationId: o.operationId, ...(o.operationType ? { operationType: o.operationType } : {}), from: null, to: o.to });

write({ type: 'started', mode: job.mode, attempt: job.attempt ?? 1, runId, manifestId: 'rm_fake' });
const resumeOps = job.mode === 'resume' ? script.resumeOps?.[String(job.attempt ?? 1)] : undefined;
if (resumeOps) {
  for (const o of resumeOps) {
    await sleep(script.intervalMs ?? 30);
    writeOp(o);
  }
  setInterval(() => undefined, 1000); // hang until killed
} else if (job.mode === 'resume') {
  write({ type: 'completed', runId, status: 'completed', verdict: 'pass', exitCode: script.exitCode ?? 0 });
  process.exitCode = script.exitCode ?? 0;
} else {
  const ids = script.ids ?? Array.from({ length: script.dispatches ?? 0 }, (_, i) => `op_${i + 1}`);
  for (const [i, operationId] of ids.entries()) {
    await sleep(script.intervalMs ?? 30);
    write({ type: 'operation', runId, seq: (i + 1) * 10, eventType: 'operation.dispatched', operationId, from: 'prepared', to: 'dispatching' });
  }
  for (const o of script.ops ?? []) {
    await sleep(script.intervalMs ?? 30);
    writeOp(o);
  }
  if (script.onStart === 'exit') process.exitCode = script.exitCode ?? 0;
  else setInterval(() => undefined, 1000); // hang until killed
}
