// TEMPORARY debug script (removed before finishing).
import { runTrial, type EvalTask, type Grader } from '../src/index.ts';
import { scriptedMultiLlmArm, scriptedSingleArm } from '../src/arms.ts';
import { pocATask } from '../src/suites/poc-a.ts';
import { pocBTask } from '../src/suites/poc-b.ts';
import { pocCInsufficientTask, pocCTask, recoveryChaosTask } from '../src/suites/poc-c.ts';
import { oracleRobustnessTask } from '../src/suites/robustness.ts';

const which = process.argv[2] ?? 'a';
const full = process.env['FULL'] === '1';
const armName = process.argv[3] ?? 'multi';
const mode = (process.argv[4] ?? 'in-process') as 'in-process' | 'child-process';
const tasks: Record<string, () => EvalTask> = {
  a: () => pocATask({ graders: ['verdict', 'defectDetected', 'planDynamics', 'dump'] }),
  b: () => pocBTask({ graders: ['verdict', 'defectDetected', 'noDuplicateSideEffects', 'dump'] }),
  c: () => pocCTask({ graders: ['verdict', 'noDuplicateSideEffects', 'dump'] }),
  cnokill: () => pocCTask({ graders: ['verdict', 'noDuplicateSideEffects', 'dump'], chaos: { largeOutputBytes: 2_000_000 } }),
  ci: () => pocCInsufficientTask({ graders: ['verdict', 'noDuplicateSideEffects', 'dump'] }),
  r: () => recoveryChaosTask({ graders: ['verdict', 'noDuplicateSideEffects', 'dump'] }),
  o: () => oracleRobustnessTask({ graders: ['verdict', 'dump'] }),
};
const fullGraders: Record<string, string[]> = { a: pocATask().graders, b: pocBTask().graders, c: pocCTask().graders, cnokill: pocCTask().graders.filter((g) => g !== 'loadJobReattached'), ci: pocCInsufficientTask().graders, r: recoveryChaosTask().graders, o: oracleRobustnessTask().graders };
const dump: Grader = async (ctx) => {
  const d = ctx.data;
  console.log('STATUS', d.status, 'VERDICT', d.decision?.verdict);
  for (const w of d.workItems) console.log('WI', w.workItemId, w.kind, w.role, w.state, w.failure ? JSON.stringify(w.failure) : '', w.result?.summary?.slice(0, 150) ?? '');
  for (const e of d.events.filter((e) => e.eventType === 'policy.decided' || e.eventType === 'tool.denied' || (e.eventType === 'tool.completed' && (e.payload as { status: string }).status !== 'success'))) console.log('TOOL', e.eventType, JSON.stringify(e.payload).slice(0, 400));
  for (const r of d.decision?.reasons ?? []) console.log('REASON', r);
  for (const e of d.events.filter((e) => e.eventType === 'model.fallback' || (e.eventType === 'model.routed' && (e.payload as { ok: boolean }).ok === false))) console.log('MODEL', e.eventType, JSON.stringify(e.payload).slice(0, 300));
  return { graderId: 'dump', pass: true, score: 1, detail: '' };
};
const base = tasks[which]!();
const task = full ? { ...base, graders: [...fullGraders[which]!, 'dump'] } : base;
const t = await runTrial(task, armName === 'multi' ? scriptedMultiLlmArm : scriptedSingleArm, {
  workDir: '/tmp/claude-0/-home-user/4a2e55ac-69a5-5605-8a42-89ad431654e0/scratchpad/trials', trial: 0, seed: 'dbg', timeoutMs: 240_000, graders: { dump }, mode,
  keepWorkDir: process.env['KEEP'] === '1',
});
console.log(JSON.stringify({ result: t.result, verdict: t.verdict, error: t.error, graders: t.graders, traj: t.trajectoryMetrics, outcome: t.outcomeMetrics, ms: t.durationMs }, null, 1));
