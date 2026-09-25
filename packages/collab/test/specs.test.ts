import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { eventCtx } from '@hypertest/testkit';
import { count, experiment, openEnv, oracle, proposal, rejectsWith, systemModel, testArtifact, types, type Env } from './helpers.ts';

let env: Env;
before(async () => {
  env = await openEnv();
});
after(async () => {
  await env.dispose();
});

test('system models are append-only revisions: save of an existing id creates revision+1 superseding the previous', async () => {
  const runId = 'sp-1';
  const ctx = eventCtx(runId);
  const r1 = await env.specs.saveSystemModel(systemModel(runId), ctx);
  const r2 = await env.specs.saveSystemModel(systemModel(runId, { changedComponents: ['checkout', 'cart'] }), ctx);
  assert.deepEqual([r1.revision, r1.supersedes, r2.revision, r2.supersedes], [1, undefined, 2, 1]);
  assert.deepEqual(await env.specs.latestSystemModel(runId), r2);
  assert.equal(await count(env.db, 'SELECT count(*) AS n FROM ht_system_models WHERE system_model_id = $1', [r1.systemModelId]), 2);
  assert.equal(await env.specs.latestSystemModel('sp-none'), undefined);
  const evs = await env.events.read(runId);
  assert.deepEqual(types(evs), ['system_model.recorded', 'system_model.recorded']);
  assert.deepEqual(evs[1]!.payload, { systemModelId: r1.systemModelId, revision: 2, supersedes: 1, components: 1, changedComponents: ['checkout', 'cart'], riskTags: ['payments'] });
});

test('oracle revisions: explicit revision is honoured only when it is the next one; older revisions stay readable', async () => {
  const runId = 'sp-2';
  const ctx = eventCtx(runId);
  const o1 = await env.specs.saveOracle(oracle('or-sp2'), ctx);
  assert.deepEqual([o1.revision, o1.supersedes], [1, undefined]);
  const o2 = await env.specs.saveOracle(oracle('or-sp2', { revision: 2, status: 'approved', assertions: [] }), ctx);
  assert.deepEqual([o2.revision, o2.supersedes], [2, 1]);
  // A concurrent approval based on revision 1 (would-be revision 2) must not overwrite revision 2.
  const err = await rejectsWith(env.specs.saveOracle(oracle('or-sp2', { revision: 2 }), ctx), 'conflict');
  assert.deepEqual([err.details['requested'], err.details['expected']], [2, 3]);
  assert.deepEqual(await env.specs.getOracle('or-sp2'), o2);
  assert.deepEqual(await env.specs.getOracle('or-sp2', 1), o1);
  assert.equal(await env.specs.getOracle('or-sp2', 7), undefined);
  assert.deepEqual(types(await env.events.read(runId)), ['oracle.revised', 'oracle.revised']);
});

test('listOracles returns the latest revision of each oracle, filtered on that revision status', async () => {
  const ctx = eventCtx('sp-3');
  await env.specs.saveOracle(oracle('or-sp3-a', { status: 'approved' }), ctx);
  await env.specs.saveOracle(oracle('or-sp3-a', { status: 'invalid' }), ctx);
  await env.specs.saveOracle(oracle('or-sp3-b', { status: 'approved' }), ctx);
  const latest = (await env.specs.listOracles()).filter((o) => o.oracleId.startsWith('or-sp3'));
  assert.deepEqual(latest.map((o) => `${o.oracleId}@${o.revision}:${o.status}`), ['or-sp3-a@2:invalid', 'or-sp3-b@1:approved']);
  const approved = (await env.specs.listOracles({ status: ['approved'] })).filter((o) => o.oracleId.startsWith('or-sp3'));
  assert.deepEqual(approved.map((o) => o.oracleId), ['or-sp3-b'], 'a superseded approved revision is not reported as current');
});

test('oracle change proposals: created pending, decided exactly once, content immutable', async () => {
  const runId = 'sp-4';
  const ctx = eventCtx(runId);
  const p = await env.specs.saveOracleProposal(proposal(runId), ctx);
  assert.equal(p.status, 'pending');
  assert.deepEqual(await env.specs.saveOracleProposal(proposal(runId), ctx), p, 'identical re-save is idempotent');
  await rejectsWith(env.specs.saveOracleProposal(proposal(runId, { rationale: 'rewritten after the fact' }), ctx), 'conflict');
  await rejectsWith(env.specs.saveOracleProposal(proposal(runId, { decisionRationale: 'x' }), ctx), 'invalid_argument');
  const decided = await env.specs.saveOracleProposal(
    proposal(runId, { status: 'approved', decidedBy: { kind: 'human', id: 'alice' }, decisionRationale: 'spec changed', decidedAt: '2026-01-01T00:05:00.000Z' }),
    ctx,
  );
  assert.equal(decided.status, 'approved');
  const err = await rejectsWith(env.specs.saveOracleProposal(proposal(runId, { status: 'rejected', decidedBy: { kind: 'human', id: 'bob' } }), ctx), 'precondition_failed');
  assert.equal(err.details['status'], 'approved');
  assert.deepEqual(await env.specs.getOracleProposal(p.proposalId), decided);
  await rejectsWith(env.specs.saveOracleProposal(proposal(runId, { proposalId: 'prop-preapproved', status: 'approved' }), ctx), 'invalid_argument');
  const evs = await env.events.read(runId);
  assert.deepEqual(types(evs), ['oracle.change_proposed', 'oracle.change_approved']);
  assert.equal((evs[0]!.payload as Record<string, unknown>)['proposedBy'], 'agent-exec');
  assert.equal((evs[1]!.payload as Record<string, unknown>)['decidedBy'], 'alice');
});

test('listOracleProposals filters by run and status; rejection emits oracle.change_rejected', async () => {
  const ctx = eventCtx('sp-5');
  await env.specs.saveOracleProposal(proposal('sp-5', { proposalId: 'p5a' }), ctx);
  await env.specs.saveOracleProposal(proposal('sp-5', { proposalId: 'p5b' }), ctx);
  await env.specs.saveOracleProposal(proposal('sp-5', { proposalId: 'p5b', status: 'rejected', decidedBy: { kind: 'agent', id: 'reviewer', modelProvider: 'anthropic' } }), ctx);
  assert.deepEqual((await env.specs.listOracleProposals({ runId: 'sp-5' })).map((p) => p.proposalId), ['p5a', 'p5b']);
  assert.deepEqual((await env.specs.listOracleProposals({ runId: 'sp-5', status: ['pending'] })).map((p) => p.proposalId), ['p5a']);
  assert.ok((await env.specs.listOracleProposals({ status: ['rejected'] })).some((p) => p.proposalId === 'p5b'));
  assert.deepEqual(types(await env.events.read('sp-5')), ['oracle.change_proposed', 'oracle.change_proposed', 'oracle.change_rejected']);
});

test('experiments: revisions per id, list returns the latest revision of each experiment of the run', async () => {
  const runId = 'sp-6';
  const ctx = eventCtx(runId);
  const e1 = await env.specs.saveExperiment(experiment(runId), ctx);
  const e2 = await env.specs.saveExperiment(experiment(runId, { hypothesis: 'refined' }), ctx);
  const other = await env.specs.saveExperiment(experiment(runId, { experimentId: 'exp-sp6-b' }), ctx);
  assert.deepEqual([e1.revision, e2.revision, e2.supersedes, other.revision], [1, 2, 1, 1]);
  assert.deepEqual(await env.specs.getExperiment(e1.experimentId), e2);
  assert.deepEqual(await env.specs.getExperiment(e1.experimentId, 1), e1);
  assert.deepEqual((await env.specs.listExperiments(runId)).map((e) => `${e.experimentId}@${e.revision}`), [`${e1.experimentId}@2`, 'exp-sp6-b@1']);
  assert.deepEqual(types(await env.events.read(runId)), ['experiment.defined', 'experiment.defined', 'experiment.defined']);
});

test('test artifacts: registered vs validated events, optimistic revision and supersedes checks', async () => {
  const runId = 'sp-7';
  const ctx = eventCtx(runId);
  const a1 = await env.specs.saveTestArtifact(testArtifact(runId), ctx);
  const a2 = await env.specs.saveTestArtifact(
    testArtifact(runId, { revision: 2, supersedes: 1, approvalState: 'validated', validations: { knownBad: { status: 'passed', evidenceRefs: ['ev_9'] } } }),
    ctx,
  );
  assert.deepEqual([a1.revision, a2.revision, a2.supersedes], [1, 2, 1]);
  await rejectsWith(env.specs.saveTestArtifact(testArtifact(runId, { revision: 5 }), ctx), 'conflict');
  await rejectsWith(env.specs.saveTestArtifact(testArtifact(runId, { supersedes: 1 }), ctx), 'conflict');
  assert.deepEqual(await env.specs.getTestArtifact(a1.artifactId), a2);
  assert.deepEqual(await env.specs.getTestArtifact(a1.artifactId, 1), a1);
  assert.deepEqual((await env.specs.listTestArtifacts(runId)).map((a) => a.revision), [2]);
  const evs = await env.events.read(runId);
  assert.deepEqual(types(evs), ['test_artifact.registered', 'test_artifact.validated']);
  assert.equal((evs[1]!.payload as Record<string, unknown>)['approvalState'], 'validated');
});

test('an oracle change proposal can never be approved by its own proposer (I8 defence in depth)', async () => {
  const runId = 'sp-8';
  const ctx = eventCtx(runId);
  const p = await env.specs.saveOracleProposal(proposal(runId), ctx);
  const seq = await env.events.lastSeq(runId);
  const err = await rejectsWith(
    env.specs.saveOracleProposal({ ...p, status: 'approved', decidedBy: { ...p.proposedBy }, decisionRationale: 'looks right to me', decidedAt: '2026-01-01T00:05:00.000Z' }, ctx),
    'permission_denied',
  );
  assert.deepEqual([err.details['proposedBy'], err.details['decidedBy']], ['agent-exec', 'agent-exec']);
  await rejectsWith(env.specs.saveOracleProposal({ ...p, status: 'approved', decisionRationale: 'anonymous' }, ctx), 'invalid_argument');
  assert.deepEqual(await env.specs.getOracleProposal(p.proposalId), p);
  assert.equal(await env.events.lastSeq(runId), seq);
  // The proposer may still withdraw (reject) its own proposal; an independent approver is not needed for that.
  const withdrawn = await env.specs.saveOracleProposal({ ...p, status: 'rejected', decidedBy: { ...p.proposedBy }, decisionRationale: 'withdrawn' }, ctx);
  assert.equal(withdrawn.status, 'rejected');
});

test('revisions of one spec id written from several run contexts are serialized, not lost or conflicting', async () => {
  const saved = await Promise.all(
    Array.from({ length: 5 }, (_, i) => env.specs.saveOracle(oracle('or-shared', { scope: { components: ['checkout'], description: `from run ${i}` } }), eventCtx(`sp-9-${i}`))),
  );
  assert.deepEqual(saved.map((o) => o.revision).sort(), [1, 2, 3, 4, 5]);
  assert.equal((await env.specs.getOracle('or-shared'))!.revision, 5);
  assert.equal(await count(env.db, "SELECT count(*) AS n FROM ht_oracles WHERE oracle_id = 'or-shared'"), 5);
});
