// scratch driver (removed before the end): node packages/eval/test/fixtures/run-one.ts <taskFactory> [mode]
import { join } from 'node:path';
import { tempDir } from '@hypertest/testkit';
import * as ev from '../../src/index.ts';
const [factory, mode] = process.argv.slice(2);
const base = (ev as unknown as Record<string, () => ev.EvalTask>)[factory!]!();
let dump: unknown;
const dbg: ev.Grader = async (ctx) => {
  const d = ctx.data;
  dump = {
    status: d.status,
    reasons: d.decision?.reasons,
    items: d.workItems.map((w) => `${w.role}/${w.origin.kind}:${w.state}${w.failure ? ` [${w.failure.reason}: ${w.failure.message.slice(0, 300)}]` : ''} ${w.result?.summary?.slice(0, 200) ?? ''}`),
    denied: d.events.filter((e) => e.eventType === 'tool.denied' || e.eventType === 'admission.refused' || e.eventType === 'budget.exhausted').map((e) => JSON.stringify(e.payload).slice(0, 400)),
    ops: d.operations.map((o) => `${o.operationType}:${o.status} ${o.lastError?.slice(0, 200) ?? ''}`),
    probes: Object.keys(d.probes),
    artifacts: (await ctx.ht.services.specs.listTestArtifacts(d.runId!)).map((a) => `${a.artifactId} r${a.revision} ${a.path} by ${a.generatedBy?.agentId ?? '-'} ${a.approvalState}`),
    testResults: d.evidence.filter((e) => e.evidenceType === 'test-result').map((e) => `${e.evidenceId} ta=${String((e.structured as { testArtifactId?: unknown }).testArtifactId)} passed=${String((e.structured as { passed?: unknown }).passed)} agent=${e.agentId ?? '-'}`),
    findings: d.findings.map((f) => `${f.recordId} lin=${f.lineageId} ${f.payload.status} ta=${f.payload.testArtifactId ?? '-'}`),
  };
  return { graderId: 'dbg', pass: true, score: 1, detail: 'dump' };
};
const task = { ...base, graders: [...base.graders, 'dbg'] };
const root = await tempDir('ht-run-one-');
const t0 = Date.now();
const armId = process.env['ARM'];
const arm = armId ? ev.builtinArms().find((a) => a.armId === armId)! : ev.scriptedMultiLlmArm;
const trial = await ev.runTrial(task, arm, { workDir: join(root.path, 't'), trial: 0, seed: 's', timeoutMs: 240_000, mode: (mode as 'in-process' | 'child-process') ?? 'in-process', graders: { dbg }, keepWorkDir: process.env['KEEP'] === '1' });
console.log(JSON.stringify({ task: task.taskId, arm: arm.armId, features: trial.harnessFeatures, manifest: trial.runtimeManifestId, ms: Date.now() - t0, result: trial.result, verdict: trial.verdict, error: trial.error, failed: trial.graders.filter((g) => !g.pass).map((g) => `${g.graderId}: ${g.detail}`), dump }, null, 1));
if (process.env['KEEP'] !== '1') await root.cleanup(); else console.log(root.path);
