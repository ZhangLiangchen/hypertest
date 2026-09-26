import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isHypertestError, sleep } from '@hypertest/core';
import { createOperationLedger, operationExperimentId } from '@hypertest/operation';
import {
  DEFAULT_MAX_INLINE_BYTES, builtinTools, evidenceExperimentId, meteredSandbox,
  type ProcessResult, type SandboxRunner, type ToolSpec, type WorkspaceHandle,
} from '../src/index.ts';
import { FakeLoadAdapter, gatewayFor, openToolEnv, request, runtimeFor, snapshot, type ToolEnv } from './helpers.ts';

/**
 * Unit B2: per-call resource metering (conformance-5: sandbox wall time and artifact bytes, artifact budget enforced
 * before a put) and experiment plumbing (conformance-6: evidence provenance + operations carry the experimentId).
 */

let env: ToolEnv;
let ws: WorkspaceHandle;
before(async () => {
  env = await openToolEnv();
  ws = await env.workspaces.scratch({ runId: 'run_tools', workItemId: 'wi_1' });
});
after(async () => {
  await env.dispose();
});

/** A fake sandbox: every process "runs" for a fixed wall time (reported in ProcessResult.durationMs). */
function fakeSandbox(durationMs: number, realDelayMs = 0): SandboxRunner & { runs: number } {
  const s = {
    kind: 'local' as const,
    runs: 0,
    async run(): Promise<ProcessResult> {
      s.runs++;
      if (realDelayMs > 0) await sleep(realDelayMs);
      return { exitCode: 0, signal: null, stdout: 'ok', stderr: '', durationMs, timedOut: false, stdoutTruncated: false, stderrTruncated: false };
    },
  };
  return s;
}

const obj = (props: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties: props });

function specs(sandbox: SandboxRunner): ToolSpec[] {
  const metered = meteredSandbox(sandbox);
  return [
    {
      id: 't.procs',
      title: 't.procs',
      description: 'runs n sandbox processes',
      inputSchema: obj({ n: { type: 'integer' } }),
      effect: 'execute',
      riskClass: 'low',
      timeoutMs: 5000,
      resources: (_i, ctx) => [ctx.workspace.resourcePrefix],
      async execute(input: { n?: number }, ctx) {
        for (let i = 0; i < (input.n ?? 1); i++) await metered.run(ctx.workspace, ['true'], { timeoutMs: 1000, signal: ctx.signal });
        return { status: 'success', structured: { ran: input.n ?? 1 } };
      },
    },
    {
      id: 't.store',
      title: 't.store',
      description: 'stores artifacts and evidence',
      inputSchema: obj({ bytes: { type: 'integer' }, twice: { type: 'boolean' }, spoof: { type: 'string' } }),
      effect: 'read',
      riskClass: 'low',
      timeoutMs: 5000,
      resources: (_i, ctx) => [ctx.workspace.resourcePrefix],
      async execute(input: { bytes?: number; twice?: boolean; spoof?: string }, ctx) {
        const data = 'a'.repeat(input.bytes ?? 100);
        await ctx.artifacts.put(data, { mimeType: 'text/plain' });
        if (input.twice) await ctx.artifacts.put(data, { mimeType: 'text/plain' }); // same object: counted once
        const provenance = input.spoof !== undefined ? ({ experimentId: input.spoof } as Record<string, string>) : undefined;
        const ev = await ctx.recordEvidence({ evidenceType: 'log', data: 'evidence!', mimeType: 'text/plain', summary: 'log', ...(provenance ? { provenance } : {}) });
        return { status: 'success', structured: { evidenceId: ev.evidenceId, experimentId: ctx.experimentId ?? null } };
      },
    },
    {
      id: 't.big',
      title: 't.big',
      description: 'large output (offloaded)',
      inputSchema: obj({}),
      effect: 'read',
      riskClass: 'low',
      timeoutMs: 5000,
      resources: (_i, ctx) => [ctx.workspace.resourcePrefix],
      async execute() {
        return { status: 'success', text: 'x'.repeat(DEFAULT_MAX_INLINE_BYTES * 3) };
      },
    },
    {
      id: 't.job',
      title: 't.job',
      description: 'side effect',
      inputSchema: obj({ name: { type: 'string' } }),
      effect: 'external',
      riskClass: 'medium',
      timeoutMs: 5000,
      environmentClass: () => 'local',
      resources: () => ['loadgen/job'],
      sideEffect: { adapterId: 'fake.load', operationType: 'load.start', target: () => ({ resourceKey: 'loadgen/job', kind: 'load_job' }) },
      execute: async () => ({ status: 'failed' }),
    },
  ];
}

test('conformance-5: computeMs is the wall time of the sandbox processes a call ran; concurrent calls never mix', async () => {
  const rt = runtimeFor(env, specs(fakeSandbox(125, 5)));
  const [a, b] = await Promise.all([rt.execute(request('t.procs', { n: 3 }, ws)), rt.execute(request('t.procs', { n: 1 }, ws))]);
  assert.equal(a.status, 'success');
  assert.deepEqual([a.usage?.computeMs, b.usage?.computeMs], [375, 125]);
  // a call that never executed consumed nothing
  const denied = await rt.execute(request('t.nope', {}, ws));
  assert.deepEqual(denied.usage, { computeMs: 0, artifactBytes: 0 });
});

test('conformance-5: the built-in tools run on a metered sandbox (wrapping is idempotent: never counted twice)', async () => {
  const fake = fakeSandbox(40);
  const once = meteredSandbox(fake);
  assert.equal(meteredSandbox(once), once);
  const tools = builtinTools({ sandbox: fake, workspaces: env.workspaces });
  const rt = runtimeFor(env, tools);
  const r = await rt.execute(request('shell.exec', { command: ['ls'] }, ws));
  assert.equal(r.status, 'success', r.modelText);
  assert.equal(fake.runs, 1);
  assert.equal(r.usage?.computeMs, 40);
});

test('conformance-5: artifactBytes counts the distinct objects a call stored (tool puts, evidence, offload)', async () => {
  const rt = runtimeFor(env, specs(fakeSandbox(1)));
  const r = await rt.execute(request('t.store', { bytes: 1000, twice: true }, ws));
  assert.equal(r.status, 'success');
  assert.equal(r.usage?.artifactBytes, 1000 + Buffer.byteLength('evidence!'));
  const big = await rt.execute(request('t.big', {}, ws));
  assert.equal(big.status, 'success');
  assert.ok((big.usage?.artifactBytes ?? 0) >= DEFAULT_MAX_INLINE_BYTES * 3, 'the offloaded output is charged');
});

test('conformance-5: limits.maxArtifactBytes refuses a put BEFORE storing (typed budget_exhausted); an offload over budget truncates without storing', async () => {
  const rt = runtimeFor(env, specs(fakeSandbox(1)));
  const before = env.artifacts.size;
  const refused = await rt.execute(request('t.store', { bytes: 5000 }, ws, { limits: { maxArtifactBytes: 4000 } }));
  assert.equal(refused.status, 'failed');
  assert.equal(refused.error?.code, 'budget_exhausted');
  assert.match(refused.error?.message ?? '', /artifact budget exhausted/);
  assert.equal(refused.usage?.artifactBytes, 0, 'nothing was stored');
  assert.equal(env.artifacts.size, before);
  const fits = await rt.execute(request('t.store', { bytes: 100 }, ws, { limits: { maxArtifactBytes: 4000 } }));
  assert.equal(fits.status, 'success');
  const trunc = await rt.execute(request('t.big', {}, ws, { limits: { maxArtifactBytes: 10 } }));
  assert.equal(trunc.status, 'success');
  assert.match(trunc.modelText, /offload failed: artifact budget exhausted/);
  assert.equal(trunc.usage?.artifactBytes, 0);
  await assert.rejects(rt.execute(request('t.store', {}, ws, { limits: { maxArtifactBytes: -1 } })), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});

test('conformance-6: a call made for an experiment records the experimentId in every evidence provenance (hash-chained) and in tool.called; a tool cannot claim one itself', async () => {
  const rt = runtimeFor(env, specs(fakeSandbox(1)));
  const r = await rt.execute(request('t.store', { spoof: 'exp_spoofed' }, ws, { experimentId: 'exp_real' }));
  assert.equal(r.status, 'success');
  const evidenceId = (r.structured as { evidenceId: string }).evidenceId;
  assert.equal((r.structured as { experimentId: string }).experimentId, 'exp_real', 'the tool sees ToolContext.experimentId');
  const rec = await env.evidence.get(evidenceId);
  assert.equal(evidenceExperimentId(rec!), 'exp_real', 'runtime-set, never the tool\'s say');
  assert.equal((await env.evidence.verify('run_tools')).ok, true, 'the experiment id is inside the verified chain');
  const called = env.events.events.filter((e) => e.eventType === 'tool.called' && (e.payload as Record<string, unknown>)['invocationId'] === r.invocationId);
  assert.equal((called[0]?.payload as Record<string, unknown>)['experimentId'], 'exp_real');
  // without an experiment, a spoofed provenance.experimentId is dropped
  const plain = await rt.execute(request('t.store', { spoof: 'exp_spoofed' }, ws));
  assert.equal(evidenceExperimentId((await env.evidence.get((plain.structured as { evidenceId: string }).evidenceId))!), undefined);
  await assert.rejects(rt.execute(request('t.store', {}, ws, { experimentId: '' })), (e: unknown) => isHypertestError(e, 'invalid_argument'));
});

test('conformance-6: the operation of a side-effect call made for an experiment carries the experimentId', async () => {
  const adapter = new FakeLoadAdapter();
  const rt = runtimeFor(env, specs(fakeSandbox(1)), { sideEffects: gatewayFor(env, [adapter]) });
  const r = await rt.execute(request('t.job', { name: 'job' }, ws, { experimentId: 'exp_load', snapshot: snapshot() }));
  assert.equal(r.status, 'success', r.modelText);
  assert.ok(r.operationId);
  const op = await createOperationLedger({ ...env.deps, db: env.db }).get(r.operationId!);
  assert.equal(operationExperimentId(op!), 'exp_load');
});
