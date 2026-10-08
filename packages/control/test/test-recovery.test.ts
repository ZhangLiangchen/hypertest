import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eventFrom, type DomainEvent } from '@hypertest/domain';
import { testRecoveredEventId, TEST_RECOVERY_CONSUMER } from '../src/index.ts';
import { createHarness, type Harness } from './harness.ts';

/**
 * (CONFORMANCE row "Typical event catalog emitted … test.failed/recovered"): test.recovered is emitted when a test that FAILED
 * earlier in the run passes on later evidence — once per recovery (deterministic id + inbox), never for a known-good check on
 * the base revision, never twice on redelivery.
 */
describe('test.recovered', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => h.dispose());

  async function outcome(runId: string, type: 'test.failed' | 'test.passed', selector: string, invocationId: string, codeRevision?: Record<string, unknown>): Promise<DomainEvent<unknown>> {
    const run = (await h.deps.runs.get(runId))!;
    const artifact = await h.deps.artifacts.put(Buffer.from(invocationId), { mimeType: 'text/plain' });
    const ev = await h.deps.evidence.append({
      runId, evidenceType: 'test-result', artifact, summary: `${type} ${selector}`, structured: { passed: type === 'test.passed', ...(codeRevision ? { codeRevision } : {}) } as never,
      producer: { workerId: 'seed', runtimeManifestId: run.runtimeManifestId }, provenance: {},
    });
    const payload = { selector, framework: 'node_test', passed: type === 'test.passed' ? 2 : 1, failed: type === 'test.failed' ? 1 : 0, errors: 0, total: 2, evidenceIds: [ev.evidenceId], toolInvocationId: invocationId };
    const [e] = await h.deps.events.append([eventFrom({ runId, correlationId: runId, actorId: 'agent-x', workItemId: 'wi_x', agentId: 'agent-x' }, type, 'tool', invocationId, payload)]);
    return e!;
  }

  const recovered = async (runId: string) => h.deps.events.read(runId, { types: ['test.recovered'] });

  test('fail → pass of the same test ⇒ one test.recovered citing both; redelivery and later passes add nothing; a new failure can recover again', async () => {
    const run = await h.control.startRun({ goal: 'recovery', target: {} });
    const failed = await outcome(run.runId, 'test.failed', 'test/pricing.test.js', 'inv-f1');
    await h.control.reactors.catchUp(run.runId);
    assert.deepEqual(await recovered(run.runId), [], 'a failure alone recovers nothing');
    const other = await outcome(run.runId, 'test.passed', 'test/other.test.js', 'inv-o1');
    const passed = await outcome(run.runId, 'test.passed', 'test/pricing.test.js', 'inv-p1');
    await h.control.reactors.catchUp(run.runId);
    const [rec, ...more] = await recovered(run.runId);
    assert.equal(more.length, 0, 'exactly one recovery');
    assert.equal(rec!.eventId, testRecoveredEventId(passed.eventId));
    assert.equal(rec!.causationId, passed.eventId);
    const p = rec!.payload as Record<string, unknown>;
    assert.equal(p['selector'], 'test/pricing.test.js');
    assert.equal(p['failedEventId'], failed.eventId);
    assert.equal(p['passedEventId'], passed.eventId);
    assert.deepEqual(p['failedEvidenceIds'], (failed.payload as Record<string, unknown>)['evidenceIds']);
    assert.notEqual(other.eventId, passed.eventId);
    // duplicate delivery (bus) and a re-run catch-up: nothing new (I5)
    await h.control.reactors.handleDelivered({ eventId: passed.eventId, subject: 'ht.x', data: passed, redelivered: true } as never);
    await h.control.reactors.catchUp(run.runId);
    assert.equal((await recovered(run.runId)).length, 1);
    assert.equal(await h.deps.inbox.consumed(TEST_RECOVERY_CONSUMER, passed.eventId), true);
    // a second pass is no recovery (the test was already passing); fail → pass again is
    await outcome(run.runId, 'test.passed', 'test/pricing.test.js', 'inv-p2');
    await h.control.reactors.catchUp(run.runId);
    assert.equal((await recovered(run.runId)).length, 1);
    await outcome(run.runId, 'test.failed', 'test/pricing.test.js', 'inv-f2');
    const again = await outcome(run.runId, 'test.passed', 'test/pricing.test.js', 'inv-p3');
    await h.control.reactors.catchUp(run.runId);
    const all = await recovered(run.runId);
    assert.equal(all.length, 2);
    assert.equal(all[1]!.eventId, testRecoveredEventId(again.eventId));
  });

  test('a known-good pass on the BASE revision after a candidate failure is no recovery', async () => {
    const run = await h.control.startRun({ goal: 'base check', target: {} });
    await outcome(run.runId, 'test.failed', 'test/pricing.test.js', 'inv-bf');
    await outcome(run.runId, 'test.passed', 'test/pricing.test.js', 'inv-bp', { kind: 'base', baseCommit: 'abc1234' });
    await h.control.reactors.catchUp(run.runId);
    assert.deepEqual(await recovered(run.runId), []);
  });
});
