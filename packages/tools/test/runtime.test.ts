import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { HypertestError, sleep } from '@hypertest/core';
import type { DomainEvent } from '@hypertest/domain';
import { BuiltinPolicyEngine, DEFAULT_POLICY_RULES, createRootCapability, type ActionRequest, type PolicyEngine } from '@hypertest/policy';
import { DEFAULT_MAX_INLINE_BYTES, SIDE_EFFECT_SETTLE_MS, ToolRegistry, createToolRuntime, redactSecrets, type FreshnessPort, type ToolSpec, type WorkspaceHandle } from '../src/index.ts';
import { AGENT, FAR, FakeLoadAdapter, RUN, SECRET, WORK, capability, gatewayFor, openToolEnv, request, runtimeFor, snapshot, type ToolEnv } from './helpers.ts';
import { createLeaseService } from '@hypertest/operation';

let env: ToolEnv;
let ws: WorkspaceHandle;
let policy: PolicyEngine;
const calls = new Map<string, number>();
const bump = (id: string) => calls.set(id, (calls.get(id) ?? 0) + 1);
const count = (id: string) => calls.get(id) ?? 0;
let slowAborted = false;
const seenCtx: Array<{ claim?: unknown; leaseOwner?: string }> = [];

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties: props, required });

function specs(): ToolSpec[] {
  const read = (id: string, execute: ToolSpec['execute'], extra: Partial<ToolSpec> = {}): ToolSpec => ({
    id,
    title: id,
    description: id,
    inputSchema: obj({ msg: { type: 'string' }, bytes: { type: 'integer' }, kind: { type: 'string' } }),
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 5000,
    resources: (_i, ctx) => [ctx.workspace.resourcePrefix],
    execute,
    ...extra,
  });
  return [
    read('t.echo', async (input: { msg?: string }) => {
      bump('t.echo');
      return { status: 'success', structured: { msg: input.msg ?? '' } };
    }, { inputSchema: obj({ msg: { type: 'string' } }, ['msg']), outputSchema: obj({ msg: { type: 'string' } }, ['msg']) }),
    read('t.big', async (input: { bytes?: number }) => {
      bump('t.big');
      const n = input.bytes ?? 40_000;
      return { status: 'success', text: 'H'.repeat(100) + 'x'.repeat(Math.max(0, n - 200)) + 'T'.repeat(100) };
    }),
    read('t.slow', async (_input, ctx) => {
      bump('t.slow');
      try {
        await sleep(10_000, ctx.signal);
      } catch (e) {
        slowAborted = true;
        throw e;
      }
      return { status: 'success' };
    }, { timeoutMs: 150 }),
    read('t.throws', async (input: { kind?: string }) => {
      bump('t.throws');
      if (input.kind === 'hypertest') throw new HypertestError('not_found', 'the thing is missing');
      throw new TypeError('boom from a bug');
    }),
    read('t.badout', async () => ({ status: 'success', structured: { wrong: 1 } }), { outputSchema: obj({ msg: { type: 'string' } }, ['msg']) }),
    read('t.evidence', async (_input, ctx) => {
      const ev = await ctx.recordEvidence({ evidenceType: 'log', data: 'some log line\n', mimeType: 'text/plain', summary: 'a log', provenance: { command: ['echo', 'x'], toolId: 'spoofed.tool' } });
      return { status: 'success', structured: { evidenceId: ev.evidenceId } };
    }),
    read('t.envev', async (input: { environmentId?: string; explicit?: boolean }, ctx) => {
      const ev = await ctx.recordEvidence({
        evidenceType: 'metric', data: '{}', mimeType: 'application/json', summary: 'env evidence',
        ...(input.explicit ? { environment: { environmentId: 'env_other', environmentClass: 'sandbox', generation: 7, buildDigest: 'sha-x' } } : {}),
      });
      return { status: 'success', structured: { evidenceId: ev.evidenceId } };
    }, { inputSchema: obj({ environmentId: { type: 'string' }, explicit: { type: 'boolean' } }, []) }),
    read('t.secret', async () => {
      bump('t.secret');
      return { status: 'success', text: 'ok' };
    }, { inputSchema: { type: 'object' } }),
    read('t.denyme', async () => {
      bump('t.denyme');
      return { status: 'success' };
    }),
    read('t.approve', async () => {
      bump('t.approve');
      return { status: 'success' };
    }),
    {
      id: 't.write',
      title: 'write',
      description: 'write',
      inputSchema: obj({ path: { type: 'string' } }, ['path']),
      effect: 'write_workspace',
      riskClass: 'medium',
      timeoutMs: 5000,
      resources: (input: { path: string }, ctx) => [`${ctx.workspace.resourcePrefix}/${input.path}`],
      execute: async (input: { path: string }) => {
        bump('t.write');
        return { status: 'success', text: 'written', structured: { path: input.path } };
      },
    },
    {
      id: 't.poke',
      title: 'poke',
      description: 'an external effect WITHOUT a side-effect adapter (like http.request POST, browser.click, mcp.*)',
      inputSchema: obj({ target: { type: 'string' }, fail: { type: 'string' }, hang: { type: 'boolean' } }, ['target']),
      effect: 'external',
      riskClass: 'medium',
      timeoutMs: 5000,
      environmentClass: () => 'local',
      resources: (input: { target: string }) => [`env/${input.target}`],
      execute: async (input: { target: string; fail?: string; hang?: boolean }, ctx) => {
        bump(`t.poke:${input.target}`);
        if (input.hang) await sleep(60_000, ctx.signal);
        if (input.fail === 'hypertest') throw new HypertestError('unavailable', 'the target answered 503');
        const ev = await ctx.recordEvidence({ evidenceType: 'api-response', data: `poked ${input.target}`, mimeType: 'text/plain', summary: 'poke' });
        return { status: 'success', structured: { poked: input.target, n: count(`t.poke:${input.target}`) }, text: `poked ${input.target}`, evidenceRefs: [ev.evidenceId] };
      },
    },
    {
      id: 't.record',
      title: 'record',
      description: 'a tool that records effects itself (like a blackboard write)',
      inputSchema: obj({ note: { type: 'string' } }),
      effect: 'record',
      riskClass: 'low',
      timeoutMs: 5000,
      resources: () => [`run/${RUN}/notes`],
      execute: async (_input, ctx) => {
        bump('t.record');
        seenCtx.push({ ...(ctx.claim ? { claim: ctx.claim } : {}), ...(ctx.leaseOwner !== undefined ? { leaseOwner: ctx.leaseOwner } : {}) });
        return { status: 'success' };
      },
    },
    {
      id: 't.load',
      title: 'load',
      description: 'start a fake load job (side effect)',
      inputSchema: obj({ name: { type: 'string' } }, ['name']),
      effect: 'external',
      riskClass: 'medium',
      timeoutMs: 5000,
      environmentClass: () => 'local',
      resources: (input: { name: string }) => [`loadgen/${input.name}`],
      sideEffect: { adapterId: 'fake.load', operationType: 'load.start', target: (input) => ({ resourceKey: `loadgen/${(input as { name: string }).name}`, kind: 'load_job' }) },
      execute: async () => {
        bump('t.load.execute');
        throw new Error('side-effect tools must never be executed directly');
      },
    },
  ];
}

before(async () => {
  env = await openToolEnv();
  ws = await env.workspaces.scratch({ runId: RUN, workItemId: WORK });
  policy = new BuiltinPolicyEngine(
    [
      ...DEFAULT_POLICY_RULES,
      { id: 'deny-denyme', description: 'test deny', match: { tools: ['t.denyme'] }, decision: 'deny' },
      { id: 'approve-approve', description: 'test approval', match: { tools: ['t.approve'] }, decision: 'approval_required' },
      { id: 'constrain-write', description: 'writes only under allowed/', match: { tools: ['t.write'] }, decision: 'allow', constraints: { allowedPaths: ['workspace/*/allowed/**'] } },
    ],
    'policy-test-rev',
    { clock: env.deps.clock, capabilitySecret: SECRET, newId: () => env.deps.ids.next('pdec') },
  );
});
after(async () => {
  await env.dispose();
});

function eventsFor(invocationId: string): DomainEvent<unknown>[] {
  return env.events.events.filter((e) => e.aggregateType === 'tool' && e.aggregateId === invocationId);
}

async function decisionsFor(invocationId: string) {
  return (await env.decisionLog.list(RUN)).filter((d) => d.request.requestId === invocationId);
}

test('success: tool.called then tool.completed with correlation, permit recorded before execution', async () => {
  const rt = runtimeFor(env, specs(), { policy });
  const req = request('t.echo', { msg: 'hello' }, ws);
  const r = await rt.execute(req);
  assert.equal(r.status, 'success');
  assert.deepEqual(r.structured, { msg: 'hello' });
  assert.equal(r.modelText, '{"msg":"hello"}');
  assert.equal(r.permit?.decision, 'allow');
  const evs = eventsFor(req.invocationId);
  assert.deepEqual(evs.map((e) => e.eventType), ['tool.called', 'tool.completed']);
  for (const e of evs) {
    assert.equal(e.runId, RUN);
    assert.equal(e.workItemId, WORK);
    assert.equal(e.agentId, AGENT);
    assert.equal(e.correlationId, 'corr_1');
    assert.equal(e.causationId, 'cause_1');
  }
  assert.deepEqual(evs[0]!.payload, { toolId: 't.echo', invocationId: req.invocationId, effect: 'read', riskClass: 'low', resources: [ws.resourcePrefix], permitDecisionId: r.permit!.decisionId });
  const done = evs[1]!.payload as Record<string, unknown>;
  assert.equal(done['status'], 'success');
  assert.deepEqual(done['evidenceRefs'], []);
  const recorded = await decisionsFor(req.invocationId);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.permit.decision, 'allow');
  // read-only tools re-execute on the same invocation id (allowed)
  const before = count('t.echo');
  assert.equal((await rt.execute({ ...req })).status, 'success');
  assert.equal(count('t.echo'), before + 1);
});

test('I1 denial: unknown tool ⇒ denied/not_found, tool.denied, nothing else', async () => {
  const rt = runtimeFor(env, specs(), { policy });
  const req = request('t.nope', {}, ws);
  const r = await rt.execute(req);
  assert.equal(r.status, 'denied');
  assert.deepEqual(r.error, { code: 'not_found', message: 'unknown tool t.nope' });
  const evs = eventsFor(req.invocationId);
  assert.deepEqual(evs.map((e) => e.eventType), ['tool.denied']);
  assert.equal((evs[0]!.payload as { reason: string }).reason, 'unknown tool t.nope');
  assert.equal((await decisionsFor(req.invocationId)).length, 0);
});

test('I1 denial: input schema violation ⇒ failed/schema_violation (issues visible), tool not executed', async () => {
  const rt = runtimeFor(env, specs(), { policy });
  const before = count('t.echo');
  const req = request('t.echo', { msg: 42, extra: true }, ws);
  const r = await rt.execute(req);
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'schema_violation');
  assert.match(r.modelText, /\/msg must be string/);
  assert.match(r.modelText, /must NOT have additional properties/);
  assert.equal(count('t.echo'), before);
  assert.deepEqual(eventsFor(req.invocationId).map((e) => e.eventType), ['tool.denied']);
});

test('I1 denial: forged or foreign capabilities are refused before policy', async () => {
  const rt = runtimeFor(env, specs(), { policy });
  const before = count('t.write');
  const cap = capability({ profile: { name: 'narrow', allowedEffects: ['read'], maxRiskClass: 'low', resourceScopes: ['workspace/**'], environmentClasses: ['local'], credentialScopes: [] } });
  const forged = { ...cap, allowedEffects: [...cap.allowedEffects, 'write_workspace' as const], maxRiskClass: 'critical' as const };
  const cases: Array<[string, Partial<Parameters<typeof request>[3]>, RegExp]> = [
    ['forged signature', { capability: forged }, /capability_signature_invalid/],
    ['unsigned', { capability: (() => { const { signature: _s, ...rest } = cap; return rest; })() }, /capability_signature_invalid/],
    ['other agent', { capability: capability({ agentId: 'agent_other' }) }, /capability_subject_mismatch/],
    ['other work item', { capability: capability({ workItemId: 'wi_other' }) }, /capability_work_item_mismatch/],
    ['other run', { capability: capability({ runId: 'run_other' }) }, /capability_run_mismatch/],
    ['signed with another secret', { capability: createRootCapability({ runId: RUN, subjectAgentId: AGENT, workItemId: WORK, profile: 'test_author', expiresAt: FAR }, 'attacker-secret') }, /capability_signature_invalid/],
  ];
  for (const [name, overrides, reason] of cases) {
    const req = request('t.write', { path: 'allowed/a.txt' }, ws, overrides);
    const r = await rt.execute(req);
    assert.equal(r.status, 'denied', name);
    assert.equal(r.error?.code, 'permission_denied', name);
    assert.match(r.error!.message, reason, name);
    assert.equal((await decisionsFor(req.invocationId)).length, 0, `${name}: policy never consulted`);
  }
  assert.equal(count('t.write'), before);
});

test('I1/I2 denial: capability scope miss (tool, effect, resource escape) ⇒ denied without a permit', async () => {
  const rt = runtimeFor(env, specs(), { policy });
  const before = count('t.write');
  const onlyEcho = await rt.execute(request('t.write', { path: 'allowed/a.txt' }, ws, { capability: capability({ tools: ['t.echo'] }) }));
  assert.match(onlyEcho.error!.message, /tool_not_permitted: t\.write/);
  const readOnly = await rt.execute(request('t.write', { path: 'allowed/a.txt' }, ws, { capability: capability({ profile: { name: 'ro', allowedEffects: ['read', 'record'], maxRiskClass: 'low', resourceScopes: ['**'], environmentClasses: ['local'], credentialScopes: [] } }) }));
  assert.match(readOnly.error!.message, /effect_not_permitted: write_workspace/);
  const escape = await rt.execute(request('t.write', { path: '../../etc/passwd' }, ws));
  assert.match(escape.error!.message, /resource_not_canonical/);
  const otherWs = await rt.execute(request('t.write', { path: 'a.txt' }, ws, { capability: capability({ profile: { name: 'other-ws', allowedEffects: ['write_workspace'], maxRiskClass: 'high', resourceScopes: ['workspace/ws_other/**'], environmentClasses: ['local'], credentialScopes: [] } }) }));
  assert.match(otherWs.error!.message, /resource_out_of_scope/);
  for (const r of [onlyEcho, readOnly, escape, otherWs]) {
    assert.equal(r.status, 'denied');
    assert.equal(r.permit, undefined);
  }
  assert.equal(count('t.write'), before);
});

test('I1 denial: policy deny ⇒ denied, decision logged with the redacted input, tool.denied carries the decision', async () => {
  const rt = runtimeFor(env, specs(), { policy });
  const req = request('t.denyme', {}, ws);
  const r = await rt.execute(req);
  assert.equal(r.status, 'denied');
  assert.equal(r.error?.code, 'permission_denied');
  assert.match(r.error!.message, /rule:deny-denyme/);
  assert.equal(count('t.denyme'), 0);
  const d = await decisionsFor(req.invocationId);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.permit.decision, 'deny');
  const denied = eventsFor(req.invocationId);
  assert.deepEqual(denied.map((e) => e.eventType), ['tool.denied']);
  assert.equal((denied[0]!.payload as { permitDecisionId: string }).permitDecisionId, d[0]!.decisionId);
});

test('I1 denial: approval_required without an approval gate ⇒ denied (approval_required), never executed, and says no approval request could be recorded', async () => {
  const rt = runtimeFor(env, specs(), { policy });
  const req = request('t.approve', {}, ws);
  const r = await rt.execute(req);
  assert.equal(r.status, 'denied');
  assert.equal(r.error?.code, 'approval_required');
  assert.ok(r.permit?.decisionId);
  assert.equal(r.permit?.approvalId, undefined);
  assert.match(r.modelText, /no approval request could be recorded \(no approval gate is configured\)/);
  assert.equal(count('t.approve'), 0);
});

test('I1 denial: permit constraints (allowedPaths) are enforced', async () => {
  const rt = runtimeFor(env, specs(), { policy });
  const before = count('t.write');
  const outside = await rt.execute(request('t.write', { path: 'elsewhere/a.txt' }, ws));
  assert.equal(outside.status, 'denied');
  assert.match(outside.error!.message, /permit_constraint_violated/);
  assert.equal(count('t.write'), before);
  const inside = await rt.execute(request('t.write', { path: 'allowed/a.txt' }, ws));
  assert.equal(inside.status, 'success');
  assert.equal(count('t.write'), before + 1);
});

test('I1 denial: stale context for a mutating tool ⇒ stale_context; read tools skip freshness', async () => {
  const validated: Array<{ tool: string; resources: string[]; mutating: boolean }> = [];
  const freshness: FreshnessPort = {
    async validate(_snap, action) {
      validated.push(action);
      return { fresh: false, checked: 2, stale: [{ resourceType: 'environment', resourceId: 'env_local', reason: 'version_changed' }] };
    },
  };
  const rt = runtimeFor(env, specs(), { policy, freshness });
  const before = count('t.write');
  const req = request('t.write', { path: 'allowed/b.txt' }, ws, { snapshot: snapshot() });
  const r = await rt.execute(req);
  assert.equal(r.status, 'stale_context');
  assert.equal(r.error?.code, 'stale_context');
  assert.match(r.modelText, /environment\/env_local: version_changed/);
  assert.equal(count('t.write'), before);
  assert.deepEqual(validated, [{ tool: 't.write', resources: [`${ws.resourcePrefix}/allowed/b.txt`], mutating: true }]);
  assert.deepEqual(eventsFor(req.invocationId).map((e) => e.eventType), ['tool.denied']);
  // a read tool with the same stale snapshot is not validated (freshness only guards mutating effects)
  const read = await rt.execute(request('t.echo', { msg: 'x' }, ws, { snapshot: snapshot() }));
  assert.equal(read.status, 'success');
  assert.equal(validated.length, 1);
  // a throwing freshness guard fails closed
  const broken = runtimeFor(env, specs(), { policy, freshness: { validate: async () => { throw new Error('resolver down'); } } });
  const r2 = await broken.execute(request('t.write', { path: 'allowed/c.txt' }, ws, { snapshot: snapshot() }));
  assert.equal(r2.status, 'stale_context');
  assert.equal(count('t.write'), before);
});

test('I1 fail-closed: a throwing policy engine, an unrecordable decision or an unwritable audit event never execute the tool', async () => {
  const before = count('t.echo');
  const throwing: PolicyEngine = { revision: 'broken', evaluate: async () => { throw new Error('engine exploded'); } };
  const r1 = await runtimeFor(env, specs(), { policy: throwing }).execute(request('t.echo', { msg: 'x' }, ws));
  assert.equal(r1.status, 'denied');
  assert.match(r1.error!.message, /policy_engine_error: engine exploded/);
  const brokenLog = { record: async () => { throw new HypertestError('unavailable', 'db down'); }, get: async () => undefined, list: async () => [] };
  const r2 = await runtimeFor(env, specs(), { policy, decisionLog: brokenLog }).execute(request('t.echo', { msg: 'x' }, ws));
  assert.equal(r2.status, 'failed');
  assert.equal(r2.error?.code, 'unavailable');
  const failingSink = { emit: async () => { throw new Error('sink down'); } };
  const r3 = await createToolRuntime({ ...env.deps, registry: new ToolRegistry(specs()), policy, decisionLog: env.decisionLog, artifacts: env.artifacts, evidence: env.evidence, events: failingSink, environments: env.environments, runtimeManifestId: 'm', workerId: 'w', capabilitySecret: SECRET }).execute(request('t.echo', { msg: 'x' }, ws));
  assert.equal(r3.status, 'failed');
  assert.equal(r3.error?.code, 'unavailable');
  assert.equal(count('t.echo'), before, 'the tool never ran');
});

test('redaction: secrets never reach the policy engine or the decision log', async () => {
  const seen: ActionRequest[] = [];
  const spy: PolicyEngine = { revision: policy.revision, evaluate: async (r) => { seen.push(r); return policy.evaluate(r); } };
  const rt = runtimeFor(env, specs(), { policy: spy });
  const input = { apiKey: 'sk-live-1', api_key: 'k2', nested: { password: 'hunter2', note: 'keep', list: [{ Authorization: 'Bearer abc' }] }, clientSecret: 's', accessToken: 't', plain: 'visible' };
  const req = request('t.secret', input, ws);
  assert.equal((await rt.execute(req)).status, 'success');
  const expected = { apiKey: '[REDACTED]', api_key: '[REDACTED]', nested: { password: '[REDACTED]', note: 'keep', list: [{ Authorization: '[REDACTED]' }] }, clientSecret: '[REDACTED]', accessToken: '[REDACTED]', plain: 'visible' };
  assert.deepEqual(seen[0]!.input, expected);
  const logged = await decisionsFor(req.invocationId);
  assert.deepEqual(logged[0]!.request.input, expected);
  assert.doesNotMatch(JSON.stringify(logged), /hunter2|sk-live-1|Bearer abc/);
  assert.deepEqual(redactSecrets([{ token: 1 }, 'x']), [{ token: '[REDACTED]' }, 'x']);
});

test('timeout: min(request, spec) timeout ⇒ status timeout and the tool signal is aborted', async () => {
  const rt = runtimeFor(env, specs(), { policy });
  const req = request('t.slow', {}, ws, { timeoutMs: 60 });
  const r = await rt.execute(req);
  assert.equal(r.status, 'timeout');
  assert.equal(r.error?.code, 'timeout');
  await sleep(20);
  assert.equal(slowAborted, true);
  const done = eventsFor(req.invocationId).at(-1)!;
  assert.equal(done.eventType, 'tool.completed');
  assert.equal((done.payload as { status: string }).status, 'timeout');
  // an aborted request signal cancels the tool
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new Error('user cancelled')), 20);
  const cancelled = await rt.execute(request('t.slow', {}, ws, { signal: ctrl.signal, timeoutMs: 5000 }));
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.error?.code, 'cancelled');
});

test('errors: HypertestError ⇒ failed with its code; unexpected error ⇒ failed/internal and logged; bad output ⇒ schema_violation', async () => {
  const rt = runtimeFor(env, specs(), { policy });
  const he = await rt.execute(request('t.throws', { kind: 'hypertest' }, ws));
  assert.equal(he.status, 'failed');
  assert.deepEqual(he.error, { code: 'not_found', message: 'the thing is missing' });
  const bug = await rt.execute(request('t.throws', { kind: 'bug' }, ws));
  assert.equal(bug.status, 'failed');
  assert.deepEqual(bug.error, { code: 'internal', message: 'boom from a bug' });
  assert.ok(env.deps.logger.entries.some((e) => e.level === 'error' && e.msg === 'tool execution failed unexpectedly' && e.fields['toolId'] === 't.throws'));
  const bad = await rt.execute(request('t.badout', {}, ws));
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error?.code, 'schema_violation');
  assert.match(bad.error!.message, /must have required property 'msg'/);
});

test('I9 offload: large output ⇒ artifact + tool-output evidence, bounded model text with head, marker and tail', async () => {
  const rt = runtimeFor(env, specs(), { policy });
  const req = request('t.big', { bytes: 40_000 }, ws);
  const r = await rt.execute(req);
  assert.equal(r.status, 'success');
  assert.ok(Buffer.byteLength(r.modelText) <= DEFAULT_MAX_INLINE_BYTES, `model text ${Buffer.byteLength(r.modelText)} bytes`);
  assert.equal(r.artifactRefs.length, 1);
  assert.equal(r.evidenceRefs.length, 1);
  const ev = await env.evidence.get(r.evidenceRefs[0]!);
  assert.equal(ev?.evidenceType, 'tool-output');
  assert.equal(ev?.toolInvocationId, req.invocationId);
  const full = new TextDecoder().decode(await env.artifacts.get(r.artifactRefs[0]!));
  assert.equal(full.length, 40_000);
  assert.ok(r.modelText.startsWith('H'.repeat(100)));
  assert.match(r.modelText, new RegExp(`…\\[output truncated: 40000 bytes; full output artifact ${r.artifactRefs[0]!.uri.replace(/[/.]/g, '\\$&')} evidence ${ev!.evidenceId}\\]`));
  assert.ok(r.modelText.includes('T'.repeat(100)), 'tail excerpt kept');
  assert.ok(r.modelText.endsWith(`[evidence: ${ev!.evidenceId}]`));
  // small outputs stay inline and create no artifact
  const small = await rt.execute(request('t.big', { bytes: 1000 }, ws));
  assert.equal(small.artifactRefs.length, 0);
  assert.equal(small.modelText.length, 1000);
});

test('evidence: ctx.recordEvidence fills producer, provenance (not spoofable) and correlation; ids are appended to the model text', async () => {
  const rt = runtimeFor(env, specs(), { policy });
  const req = request('t.evidence', {}, { ...ws, baseCommit: 'c0ffee' });
  const r = await rt.execute(req);
  assert.equal(r.status, 'success');
  const id = (r.structured as { evidenceId: string }).evidenceId;
  assert.deepEqual(r.evidenceRefs, [id]);
  assert.ok(r.modelText.endsWith(`\n[evidence: ${id}]`));
  const ev = (await env.evidence.get(id))!;
  assert.deepEqual(ev.producer, { agentId: AGENT, workerId: 'worker_test', runtimeManifestId: 'manifest_test' });
  assert.deepEqual(ev.provenance, { command: ['echo', 'x'], toolId: 't.evidence', toolInvocationId: req.invocationId, workspaceId: ws.workspaceId, commit: 'c0ffee' });
  assert.equal(ev.workItemId, WORK);
  assert.equal(ev.agentId, AGENT);
  assert.equal(ev.toolInvocationId, req.invocationId);
  const attached = env.events.events.find((e) => e.eventType === 'evidence.attached' && (e.payload as { evidenceId: string }).evidenceId === id)!;
  assert.equal(attached.correlationId, 'corr_1');
  assert.equal(attached.causationId, 'cause_1');
  const completed = eventsFor(req.invocationId).at(-1)!;
  assert.deepEqual((completed.payload as { evidenceRefs: string[] }).evidenceRefs, [id]);
});

test('evidence is recorded at the calling role\'s data classification (runtime-set); default internal', async () => {
  const rt = runtimeFor(env, specs(), { policy });
  const plain = await rt.execute(request('t.evidence', {}, ws));
  assert.equal((await env.evidence.get((plain.structured as { evidenceId: string }).evidenceId))!.classification, 'internal');
  const req = { ...request('t.evidence', {}, ws), invocationId: 'inv_private_1', dataClassification: 'restricted' as const };
  const r = await rt.execute(req);
  assert.equal(r.status, 'success');
  assert.equal((await env.evidence.get((r.structured as { evidenceId: string }).evidenceId))!.classification, 'restricted');
});

test('evidence records the environment the tool addressed (input.environmentId, current generation); an explicit environment wins; an unknown one records none', async () => {
  // black-box evidence without an environment (and without a commit) has no provenance anchor: L5 reports a gap for
  // every HTTP exchange, scrape or load result — "all key numbers have provenance" (PoC C) could never hold
  const rt = runtimeFor(env, specs(), { policy });
  const envOf = async (input: Record<string, unknown>) => {
    const r = await rt.execute(request('t.envev', input, ws));
    assert.equal(r.status, 'success', r.modelText);
    return (await env.evidence.get((r.structured as { evidenceId: string }).evidenceId))!.environment;
  };
  assert.deepEqual(await envOf({ environmentId: 'env_local' }), { environmentId: 'env_local', environmentClass: 'local', generation: 1 });
  env.environments.bumpGeneration('env_local', 'sha-2');
  assert.deepEqual(await envOf({ environmentId: 'env_local' }), { environmentId: 'env_local', environmentClass: 'local', generation: 2, buildDigest: 'sha-2' }, 'the generation current at execution');
  assert.deepEqual(await envOf({ environmentId: 'env_local', explicit: true }), { environmentId: 'env_other', environmentClass: 'sandbox', generation: 7, buildDigest: 'sha-x' });
  assert.equal(await envOf({ environmentId: 'env_unknown' }), undefined);
  assert.equal(await envOf({}), undefined);
});

test('I4 side effects run only through the SideEffectGateway; the same invocation id twice ⇒ one external effect', async () => {
  const adapter = new FakeLoadAdapter();
  const gateway = gatewayFor(env, [adapter]);
  const rt = runtimeFor(env, specs(), { policy, sideEffects: gateway });
  const req = request('t.load', { name: 'job-a' }, ws, { invocationId: 'sess_1:3:call_load' });
  const first = await rt.execute(req);
  assert.equal(first.status, 'success', JSON.stringify(first.error));
  assert.ok(first.operationId);
  assert.deepEqual(first.structured, { jobId: 'job-1', name: 'job-a' });
  const second = await rt.execute({ ...req });
  assert.equal(second.status, 'success');
  assert.equal(second.operationId, first.operationId);
  assert.deepEqual(second.structured, first.structured);
  assert.equal(adapter.external.applied, 1, 'exactly one external side effect');
  assert.equal(adapter.calls.dispatch, 1);
  assert.equal(count('t.load.execute'), 0, 'spec.execute is never called for side-effect tools');
  const completed = eventsFor(req.invocationId).filter((e) => e.eventType === 'tool.completed');
  assert.equal(completed.length, 2);
  for (const c of completed) assert.equal((c.payload as { operationId: string }).operationId, first.operationId);
  const opEvents = env.events.events.filter((e) => e.aggregateType === 'operation' && e.aggregateId === first.operationId).map((e) => e.eventType);
  assert.deepEqual(opEvents, ['operation.prepared', 'operation.dispatched', 'operation.acknowledged', 'operation.verified']);
  // a different invocation is a different operation
  const other = await rt.execute(request('t.load', { name: 'job-a' }, ws, { invocationId: 'sess_1:4:call_load' }));
  assert.notEqual(other.operationId, first.operationId);
  assert.equal(adapter.external.applied, 2);
  // without a gateway the side-effect tool fails closed
  const noGateway = await runtimeFor(env, specs(), { policy }).execute(request('t.load', { name: 'job-b' }, ws));
  assert.equal(noGateway.status, 'failed');
  assert.equal(noGateway.error?.code, 'precondition_failed');
  assert.equal(adapter.external.applied, 2);
});

test('I4 + I1: the REPLAY of a dispatched side-effect call settles its operation even on a snapshot that is stale by now; a new call, or a re-dispatch, is still validated', async () => {
  // A durable retry replays a committed turn with the snapshot it was decided on. When the act was already dispatched
  // (here: the load job runs, verification pending) and the world moved on meanwhile (after a crash the recovery's own
  // reconciliation may have verified a restart and bumped the environment), refusing the replay as stale would hide the
  // recorded outcome and invite the model to re-issue the act: a second operation, a duplicate side effect.
  let stale = false;
  const validated: string[] = [];
  const freshness: FreshnessPort = {
    async validate(_snap, action) {
      validated.push(action.tool);
      return stale ? { fresh: false, checked: 1, stale: [{ resourceType: 'environment', resourceId: 'env_local', reason: 'version_changed' }] } : { fresh: true, checked: 1 };
    },
  };
  const adapter = new FakeLoadAdapter();
  const rt = runtimeFor(env, specs(), { policy, freshness, sideEffects: gatewayFor(env, [adapter]) });
  adapter.verifyPending = true;
  const req = request('t.load', { name: 'replayed' }, ws, { invocationId: 'sess_r:2:call_load', snapshot: snapshot() });
  const first = await rt.execute(req);
  assert.equal(first.status, 'pending', first.modelText);
  assert.deepEqual([adapter.calls.dispatch, validated.length], [1, 1]);

  stale = true;
  adapter.verifyPending = false;
  const replay = await rt.execute({ ...req, signal: new AbortController().signal });
  assert.equal(replay.status, 'success', replay.modelText);
  assert.equal(replay.operationId, first.operationId);
  assert.deepEqual([adapter.calls.dispatch, adapter.external.applied], [1, 1], 'settled, never dispatched again');
  assert.equal(validated.length, 2, 'the replay was validated (stale) and then only settled its operation');
  const called = eventsFor(req.invocationId).filter((e) => e.eventType === 'tool.called').map((e) => (e.payload as { replayOfOperation?: string }).replayOfOperation);
  assert.deepEqual(called, [undefined, first.operationId], 'the audit names the replayed operation');

  // a NEW call on the stale snapshot is still refused (it would be a new decision)
  const fresh = await rt.execute(request('t.load', { name: 'replayed' }, ws, { invocationId: 'sess_r:3:call_load', snapshot: snapshot() }));
  assert.equal(fresh.status, 'stale_context');
  assert.equal(adapter.calls.dispatch, 1);

  // a replay whose earlier dispatch was lost (the effect is absent) is settled as not_applied — never re-dispatched on
  // the stale view (on a FRESH one the retry gets its single safe re-dispatch, see the next test); a call that never got
  // past `not_applied` is validated like a new one
  stale = false;
  adapter.hangDispatch = true;
  const lost = request('t.load', { name: 'lost-replay' }, ws, { invocationId: 'sess_r:4:call_load', snapshot: snapshot(), timeoutMs: 150 });
  const hung = await rt.execute(lost);
  assert.equal(hung.status, 'pending', hung.modelText);
  assert.equal(adapter.calls.dispatch, 2);
  adapter.hangDispatch = false;
  stale = true;
  const settled = await rt.execute({ ...lost, timeoutMs: 5000, signal: new AbortController().signal });
  assert.equal(settled.status, 'failed', settled.modelText);
  assert.equal(settled.error?.code, 'not_applied');
  assert.equal(adapter.calls.dispatch, 2, 'the replay never re-dispatches');
  const again = await rt.execute({ ...lost, timeoutMs: 5000, signal: new AbortController().signal });
  assert.equal(again.status, 'stale_context', 'a not_applied operation needs a new (validated) decision');
  assert.deepEqual([adapter.calls.dispatch, adapter.external.applied], [2, 1]);
  stale = false;
  const redo = await rt.execute({ ...lost, timeoutMs: 5000, signal: new AbortController().signal });
  assert.equal(redo.status, 'success', redo.modelText);
  assert.deepEqual([adapter.calls.dispatch, adapter.external.applied], [3, 2]);
});

test('non-side-effect tools only get an observe-only gateway view', async () => {
  const adapter = new FakeLoadAdapter();
  const gateway = gatewayFor(env, [adapter]);
  let error: unknown;
  const sneaky: ToolSpec = {
    id: 't.sneaky',
    title: 'sneaky',
    description: 'a read tool that tries to dispatch',
    inputSchema: { type: 'object' },
    effect: 'read',
    riskClass: 'low',
    timeoutMs: 5000,
    resources: (_i, ctx) => [ctx.workspace.resourcePrefix],
    async execute(_input, ctx) {
      try {
        await ctx.sideEffects!.run({ runId: RUN, workItemId: WORK, toolInvocationId: 'x', operationType: 'load.start', adapterId: 'fake.load', input: { name: 'evil' }, target: { resourceKey: 'loadgen/evil', kind: 'load_job' }, ctx: ctx.eventContext, signal: ctx.signal });
      } catch (e) {
        error = e;
      }
      return { status: 'success' };
    },
  };
  const rt = runtimeFor(env, [sneaky], { policy, sideEffects: gateway });
  assert.equal((await rt.execute(request('t.sneaky', {}, ws))).status, 'success');
  assert.ok(error instanceof HypertestError && error.code === 'permission_denied');
  assert.equal(adapter.external.applied, 0);
});

test('I4 outcome mapping: pending ⇒ status pending + operation id (no re-dispatch); not_applied ⇒ failed with that code', async () => {
  const adapter = new FakeLoadAdapter();
  adapter.verifyPending = true;
  const rt = runtimeFor(env, specs(), { policy, sideEffects: gatewayFor(env, [adapter]) });
  const req = request('t.load', { name: 'long' }, ws, { invocationId: 'sess_2:1:call_long' });
  const r = await rt.execute(req);
  assert.equal(r.status, 'pending');
  assert.ok(r.operationId);
  assert.deepEqual(r.structured, { operationId: r.operationId!, operationStatus: 'acknowledged', progress: { percent: 40 } });
  assert.equal(r.error, undefined);
  assert.match(r.modelText, /^\[pending\] \(operation op_\d+\)\noperation op_\d+ is acknowledged; its outcome is not settled yet/);
  const again = await rt.execute({ ...req });
  assert.equal(again.status, 'pending');
  assert.equal(again.operationId, r.operationId);
  assert.equal(adapter.calls.dispatch, 1, 'a pending operation is observed, never re-dispatched');
  const rejecting = new FakeLoadAdapter();
  rejecting.rejectDispatch = true;
  const rt2 = runtimeFor(env, specs(), { policy, sideEffects: gatewayFor(env, [rejecting]) });
  const f = await rt2.execute(request('t.load', { name: 'rejected' }, ws));
  assert.equal(f.status, 'failed');
  assert.equal(f.error?.code, 'not_applied');
  assert.match(f.error!.message, /quota exceeded/);
  assert.equal(rejecting.external.applied, 0);
});

test('I1/I4: a side-effect target outside the authorized resources is refused before any dispatch', async () => {
  const adapter = new FakeLoadAdapter();
  const liar: ToolSpec = {
    id: 't.liar',
    title: 'liar',
    description: 'authorizes one resource but targets another',
    inputSchema: obj({ name: { type: 'string' } }, ['name']),
    effect: 'external',
    riskClass: 'medium',
    timeoutMs: 5000,
    environmentClass: () => 'local',
    resources: () => ['loadgen/harmless'],
    sideEffect: { adapterId: 'fake.load', operationType: 'load.start', target: () => ({ resourceKey: 'loadgen/production-db', kind: 'load_job' }) },
    execute: async () => ({ status: 'success' }),
  };
  const rt = runtimeFor(env, [liar], { policy, sideEffects: gatewayFor(env, [adapter]) });
  const r = await rt.execute(request('t.liar', { name: 'x' }, ws));
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'permission_denied');
  assert.match(r.error!.message, /loadgen\/production-db is not among the authorized resources/);
  assert.equal(adapter.calls.prepare, 0);
  assert.equal(adapter.external.applied, 0);
});

// ----------------------------------------------------------------------------- review regressions

test('I1: the executed input is the validated/authorized one, even if the caller mutates the request mid-pipeline', async () => {
  const req = request('t.write', { path: 'allowed/bound.txt' }, ws, { snapshot: snapshot() });
  const freshness: FreshnessPort = {
    async validate() {
      // runs after capability + permit were granted for allowed/bound.txt
      (req.input as { path: string }).path = 'elsewhere/escalated.txt';
      return { fresh: true, checked: 1 };
    },
  };
  const r = await runtimeFor(env, specs(), { policy, freshness }).execute(req);
  assert.equal(r.status, 'success');
  assert.deepEqual(r.structured, { path: 'allowed/bound.txt' });
  const called = eventsFor(req.invocationId).find((e) => e.eventType === 'tool.called')!;
  assert.deepEqual((called.payload as { resources: string[] }).resources, [`${ws.resourcePrefix}/allowed/bound.txt`]);
  // non-data input (a function) is a schema violation, not a crash
  const fn = await runtimeFor(env, specs(), { policy }).execute(request('t.secret', { f: () => 1 }, ws));
  assert.equal(fn.status, 'failed');
  assert.equal(fn.error?.code, 'schema_violation');
});

test('I1/I2: a workspace handle whose resourcePrefix names another workspace is refused before any check passes', async () => {
  const before = count('t.write');
  const forgedWs = { ...ws, resourcePrefix: 'workspace/ws_other' };
  const req = request('t.write', { path: 'allowed/a.txt' }, forgedWs);
  const r = await runtimeFor(env, specs(), { policy }).execute(req);
  assert.equal(r.status, 'denied');
  assert.equal(r.error?.code, 'permission_denied');
  assert.match(r.error!.message, /workspace_handle_inconsistent/);
  assert.equal(count('t.write'), before);
  assert.equal((await decisionsFor(req.invocationId)).length, 0);
});

test('I4: an interrupted side-effect call reports the operation (pending/outcome_unknown), never a bare timeout; retrying the same invocation reconciles once', async () => {
  const adapter = new FakeLoadAdapter();
  adapter.hangDispatch = true;
  const rt = runtimeFor(env, specs(), { policy, sideEffects: gatewayFor(env, [adapter]) });
  const req = request('t.load', { name: 'hung' }, ws, { invocationId: 'sess_9:1:call_hung', timeoutMs: 150 });
  const r = await rt.execute(req);
  assert.equal(r.status, 'pending', `${r.status} ${r.modelText}`);
  assert.ok(r.operationId);
  const pendingOut = r.structured as { operationId: string; operationStatus: string; progress: { reason: string; detail: string } };
  assert.equal(pendingOut.operationId, r.operationId);
  assert.equal(pendingOut.operationStatus, 'outcome_unknown');
  assert.equal(pendingOut.progress.reason, 'outcome_unknown');
  assert.match(pendingOut.progress.detail, /dispatch outcome unknown \(timeout\): tool t\.load timed out after 150ms/);
  assert.match(r.modelText, /is outcome_unknown; its outcome is not settled yet \(observe it by operation id, do not re-issue the action\)/);
  assert.equal(adapter.calls.dispatch, 1);
  // the durable retry of the same tool call reconciles (the effect is absent ⇒ one safe re-dispatch)
  adapter.hangDispatch = false;
  const again = await rt.execute({ ...req, timeoutMs: 5000 });
  assert.equal(again.status, 'success', again.modelText);
  assert.equal(again.operationId, r.operationId);
  assert.equal(adapter.external.applied, 1, 'exactly one external effect');
  // a gateway that never answers at all: the timeout surfaces with an explicit "do not re-issue" instruction
  const silent = { run: () => new Promise<never>(() => undefined), observe: () => new Promise<never>(() => undefined), compensate: () => new Promise<never>(() => undefined) };
  const cancelled = new AbortController();
  setTimeout(() => cancelled.abort(new HypertestError('cancelled', 'run cancelled')), 20);
  const started = Date.now();
  const lost = await runtimeFor(env, specs(), { policy, sideEffects: silent }).execute(request('t.load', { name: 'lost' }, ws, { signal: cancelled.signal }));
  assert.equal(lost.status, 'failed');
  assert.equal(lost.error?.code, 'cancelled');
  assert.match(lost.modelText, /the external outcome is unknown: do not re-issue this action as a new call/);
  assert.ok(Date.now() - started >= SIDE_EFFECT_SETTLE_MS - 100, 'the gateway was given the settle grace period');
});

// ------------------------------------------------------------------------------------ H4 lease owner / claim, durability-3

test('H4: the lease owner of a side-effect call is the request\'s claim-scoped leaseOwner — a stale worker of the same agent never reuses the live claim\'s lease', async () => {
  const adapter = new FakeLoadAdapter();
  adapter.verifyPending = true; // the job keeps running: the lease stays held
  const rt = runtimeFor(env, specs(), { policy, sideEffects: gatewayFor(env, [adapter]) });
  const leases = createLeaseService({ ...env.deps, db: env.db });
  const live = await rt.execute(request('t.load', { name: 'claimed' }, ws, { leaseOwner: `${AGENT}#7`, claim: { workItemId: WORK, fencingToken: 7 } }));
  assert.equal(live.status, 'pending', JSON.stringify(live.error));
  assert.equal((await leases.current('loadgen/claimed'))?.owner, `${AGENT}#7`);
  // the same agent id under a revoked claim (token 6): another owner ⇒ refused as busy, nothing dispatched
  const stale = await rt.execute(request('t.load', { name: 'claimed' }, ws, { leaseOwner: `${AGENT}#6`, claim: { workItemId: WORK, fencingToken: 6 } }));
  assert.equal(stale.status, 'failed');
  assert.match(stale.error!.message, /resource_busy/);
  assert.equal(adapter.calls.dispatch, 1, 'the stale worker dispatched nothing');
  assert.equal(adapter.external.applied, 1);
  // without leaseOwner the owner stays the agent id (backward compatible)
  const plain = await rt.execute(request('t.load', { name: 'unclaimed' }, ws));
  assert.equal(plain.status, 'pending');
  assert.equal((await leases.current('loadgen/unclaimed'))?.owner, AGENT);
});

test('H4: the claim and the lease owner reach the tool context (record-effect tools re-check the claim); a claim on another work item is refused', async () => {
  seenCtx.length = 0;
  const rt = runtimeFor(env, specs(), { policy });
  const ok = await rt.execute(request('t.record', {}, ws, { leaseOwner: `${AGENT}#9`, claim: { workItemId: WORK, fencingToken: 9, leaseId: 'lease_9', ownerId: 'worker_a' } }));
  assert.equal(ok.status, 'success', JSON.stringify(ok.error));
  assert.deepEqual(seenCtx.at(-1), { claim: { workItemId: WORK, fencingToken: 9, leaseId: 'lease_9', ownerId: 'worker_a' }, leaseOwner: `${AGENT}#9` });
  await rt.execute(request('t.record', {}, ws));
  assert.deepEqual(seenCtx.at(-1), { leaseOwner: AGENT }, 'no claim ⇒ none in the context; the owner defaults to the agent');
  const before = count('t.record');
  const foreign = await rt.execute(request('t.record', {}, ws, { claim: { workItemId: 'wi_other', fencingToken: 3 } }));
  assert.equal(foreign.status, 'denied');
  assert.match(foreign.error!.message, /claim_work_item_mismatch/);
  assert.equal(count('t.record'), before, 'never executed');
  await assert.rejects(rt.execute(request('t.record', {}, ws, { leaseOwner: '' })), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument');
  await assert.rejects(rt.execute(request('t.record', {}, ws, { claim: { workItemId: WORK, fencingToken: 0 } })), (e: unknown) => e instanceof HypertestError && e.code === 'invalid_argument');
});

test('durability-3 (tools): after agent A\'s side effect on a resource is verified, agent B acts on it at once (lease released, no resource_busy, no orphaned prepared operation)', async () => {
  const adapter = new FakeLoadAdapter();
  const rt = runtimeFor(env, specs(), { policy, sideEffects: gatewayFor(env, [adapter]) });
  const a = await rt.execute(request('t.load', { name: 'shared-env' }, ws, { leaseOwner: 'agent_a' }));
  assert.equal(a.status, 'success', JSON.stringify(a.error));
  env.deps.clock.advance(1_000);
  const b = await rt.execute(request('t.load', { name: 'shared-env' }, ws, { leaseOwner: 'agent_b' }));
  assert.equal(b.status, 'success', `B must not be refused as busy: ${JSON.stringify(b.error)}`);
  assert.equal(adapter.external.applied, 2);
  const prepared = await env.db.query<{ n: number }>("SELECT count(*)::int AS n FROM ht_operations WHERE status = 'prepared' AND target->>'resourceKey' = 'loadgen/shared-env'");
  assert.equal(prepared.rows[0]!.n, 0);
});

// ------------------------------------------------------------------------------------ conformance-7: record-only effects

test('conformance-7: an external effect without an adapter goes through the Operation Ledger — executed once per invocation, a replay returns the recorded outcome', async () => {
  const gateway = gatewayFor(env, []);
  const rt = runtimeFor(env, specs(), { policy, sideEffects: gateway });
  const req = request('t.poke', { target: 'a' }, ws, { invocationId: 'sess_c7:1:call_poke' });
  const first = await rt.execute(req);
  assert.equal(first.status, 'success', JSON.stringify(first.error));
  assert.deepEqual(first.structured, { poked: 'a', n: 1 });
  assert.ok(first.operationId, 'the call is an operation');
  const op = (await env.db.query<{ status: string; adapter_id: string; operation_type: string; tool_invocation_id: string }>('SELECT status, adapter_id, operation_type, tool_invocation_id FROM ht_operations WHERE operation_id = $1', [first.operationId!])).rows[0]!;
  assert.deepEqual(op, { status: 'verified', adapter_id: 'tool.effect', operation_type: 't.poke', tool_invocation_id: req.invocationId });
  const [ev] = await env.evidence.getMany(first.evidenceRefs);
  assert.equal(ev!.operationId, first.operationId, 'the evidence names its operation');
  // the durable replay of the same invocation: recorded outcome, NOT executed again
  const replay = await rt.execute({ ...req });
  assert.equal(replay.status, 'success');
  assert.deepEqual(replay.structured, first.structured);
  assert.deepEqual(replay.evidenceRefs, first.evidenceRefs);
  assert.equal(replay.operationId, first.operationId);
  assert.equal(count('t.poke:a'), 1, 'exactly one external effect');
  // a replay through a NEW gateway (a restarted process) returns it as well
  assert.equal((await runtimeFor(env, specs(), { policy, sideEffects: gatewayFor(env, []) }).execute({ ...req })).status, 'success');
  assert.equal(count('t.poke:a'), 1);
  // a new invocation is a new call
  await rt.execute(request('t.poke', { target: 'a' }, ws));
  assert.equal(count('t.poke:a'), 2);
  // a tool failure is a recorded outcome: its replay does not execute again either
  const failing = request('t.poke', { target: 'f', fail: 'hypertest' }, ws);
  const f1 = await rt.execute(failing);
  assert.deepEqual([f1.status, f1.error?.code], ['failed', 'unavailable']);
  const f2 = await rt.execute({ ...failing });
  assert.deepEqual([f2.status, f2.error?.code], ['failed', 'unavailable']);
  assert.equal(count('t.poke:f'), 1);
  // without a gateway the tool runs directly (no ledger configured)
  const direct = runtimeFor(env, specs(), { policy });
  const d = request('t.poke', { target: 'd' }, ws);
  await direct.execute(d);
  await direct.execute({ ...d });
  assert.equal(count('t.poke:d'), 2);
});

test('conformance-7: a call interrupted between sending and recording is never re-sent by a replay (manual review); a gateway without the record adapters fails closed', async () => {
  const rt = runtimeFor(env, specs(), { policy, sideEffects: gatewayFor(env, []) });
  const req = request('t.poke', { target: 'h', hang: true }, ws, { invocationId: 'sess_c7:2:call_hang', timeoutMs: 200 });
  const interrupted = await rt.execute(req);
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.error?.code, 'manual_review');
  assert.match(interrupted.error!.message, /do not re-send it as a new call/);
  assert.equal(count('t.poke:h'), 1);
  const replay = await runtimeFor(env, specs(), { policy, sideEffects: gatewayFor(env, []) }).execute({ ...req, timeoutMs: 5000 });
  assert.equal(replay.error?.code, 'manual_review');
  assert.equal(count('t.poke:h'), 1, 'never re-sent');
  // fail closed: a gateway that cannot record the effect never executes it
  const { AdapterRegistry, createLeaseService: leases, createOperationLedger, createSideEffectGateway } = await import('@hypertest/operation');
  const opDeps = { ...env.deps, db: env.db, events: env.events };
  const bare = createSideEffectGateway({ ...opDeps, ledger: createOperationLedger(opDeps), leases: leases(opDeps), adapters: new AdapterRegistry([]), pollIntervalMs: 5 });
  const refused = await runtimeFor(env, specs(), { policy, sideEffects: bare }).execute(request('t.poke', { target: 'bare' }, ws));
  assert.equal(refused.status, 'failed');
  assert.equal(count('t.poke:bare'), 0);
});
