/**
 * Review of the context-learning unit, through the PRODUCTION composition (createHypertest), not hand-built deps:
 *  - (B[1]/B[2]) a record-effect tool call of a real agent is refused `stale_context` when a finding the agent saw ONLY in its
 *    prompt was withdrawn meanwhile; the next prompt tells it, and the call then goes through. A listed finding that is merely
 *    updated (confirmed) does not block the agent (liveness);
 *  - (B[1]) every record-effect tool of the composed catalog carries the FreshnessGuard wrapper;
 *  - (B[6], security) the Go `go/ast` helper — run by the Hypertest process, outside every sandbox — is built under the state
 *    directory the local sandbox hides from agent commands, never at a shared temp path;
 *  - (B[6], privacy) a restricted context's retrieval never reaches an off-host embedding route.
 * Runs on PGlite, and on PostgreSQL with HYPERTEST_TEST_DB=postgres.
 */
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import type { Finding } from '@hypertest/domain';
import { HashEmbedder, type Embedder } from '@hypertest/context';
import { isFreshnessChecked } from '@hypertest/control';
import { createGitRepo, tempDir } from '@hypertest/testkit';
import { cachedRetrievers, createHypertest, sandboxHiddenPaths, type HypertestInstance } from '../src/index.ts';
import { call, evidenceIds, roleRouter, scriptedConfig, SUM_TEST, testStore, tinyRunBrains, type BrainView } from './helpers.ts';

let dir: Awaited<ReturnType<typeof tempDir>>;
let repo: Awaited<ReturnType<typeof createGitRepo>>;
let db: Awaited<ReturnType<typeof testStore>>;
let ht: HypertestInstance | undefined;

before(async () => {
  dir = await tempDir('ht-app-ctx-review-');
  db = await testStore();
  repo = await createGitRepo({
    'package.json': '{ "name": "calc", "type": "module", "private": true }\n',
    'src/sum.js': 'export function sum(a, b) {\n  return a + b;\n}\n',
    'test/sum.test.js': SUM_TEST,
    'tools/ledger.go': 'package tools\n\ntype Ledger struct {\n\tVersion int\n}\n\nfunc (l *Ledger) Bump() {\n\tl.Version++\n}\n',
  });
});
after(async () => {
  await ht?.close();
  await db?.dispose();
  await repo?.cleanup();
  await dir?.cleanup();
});

const FINDING = (title: string, status: Finding['status']): Finding => ({ title, description: 'd', severity: 'P2', category: 'product_defect', status, fingerprint: `fp-${title}` });

test('createHypertest: a withdrawn prompt-only finding refuses the agent\'s record call until it is told; a confirmed one does not block; the Go helper lives in the hidden state directory', async () => {
  const logger = new MemoryLogger();
  const lineages: { withdrawn?: string; confirmed?: string } = {};
  const executorViews: BrainView[] = [];
  const leadViews: BrainView[] = [];
  const brains = tinyRunBrains();
  const lead = brains['lead']!;
  const executor = brains['executor']!;
  brains['lead'] = async (v) => {
    if (v.kind !== 'initial_plan') return lead(v);
    leadViews.push(v);
    if (v.step === 0) {
      // two findings other agents posted: they reach the executor only through the Blackboard section of its prompt
      const bb = ht!.services.blackboard;
      lineages.withdrawn = (await bb.postRecord({ runId: v.runId, recordType: 'finding', createdBy: 'agent-other', payload: FINDING('sum overflows', 'open') }, { runId: v.runId, correlationId: 'test', actorId: 'agent-other' })).lineageId;
      lineages.confirmed = (await bb.postRecord({ runId: v.runId, recordType: 'finding', createdBy: 'agent-other', payload: FINDING('sum drops floats', 'open') }, { runId: v.runId, correlationId: 'test', actorId: 'agent-other' })).lineageId;
      // the lead surveys the Go code with the code tools (symbol graph over go/ast)
      return call('code.symbols', { query: 'Bump' });
    }
    return lead({ ...v, step: v.step - 1, toolResults: v.toolResults.slice(1) });
  };
  brains['executor'] = async (v) => {
    executorViews.push(v);
    const bb = ht!.services.blackboard;
    const ctx = { runId: v.runId, correlationId: 'test', actorId: 'agent-reviewer' };
    switch (v.step) {
      case 0: {
        assert.match(v.userText, new RegExp(`finding rec_\\w+: \\[P2, product_defect, open\\] sum overflows`));
        // while the executor decides: one listed finding is withdrawn (rejected), the other is merely confirmed
        await bb.postRecord({ runId: v.runId, recordType: 'finding', createdBy: 'agent-reviewer', supersedes: (await bb.head(lineages.withdrawn!))!.recordId, payload: FINDING('sum overflows', 'rejected') }, ctx);
        await bb.postRecord({ runId: v.runId, recordType: 'finding', createdBy: 'agent-reviewer', supersedes: (await bb.head(lineages.confirmed!))!.recordId, payload: FINDING('sum drops floats', 'confirmed') }, ctx);
        return call('blackboard.post_note', { text: 'starting the suite' });
      }
      case 1:
        return call('blackboard.post_note', { text: 'starting the suite' });
      default: {
        // the tiny executor, shifted past the two note calls
        const rest = v.toolResults.slice(2);
        if (rest.length === 0) return executor({ ...v, step: 0, toolResults: [] });
        const ids = evidenceIds(rest[0]!.content);
        return call('complete_work', {
          summary: 'The sum suite passes on the candidate.', evidenceRefs: ids,
          output: { summary: 'suite passed', executed: [{ selector: 'test/sum.test.js', passed: true, outcome: 'passed', evidenceIds: ids }], findings: [] },
        });
      }
    }
  };
  const dataDir = join(dir.path, 'a');
  const config = scriptedConfig(dataDir, { gate: { requireIndependentReview: false } });
  ht = await createHypertest(db.store ? { ...config, store: db.store } : config, { scriptedBrains: { sim: roleRouter(brains) }, logger });

  // (B[1]) the composed catalog: every record-effect tool is freshness-checked
  const unchecked = ht.services.tools.list().filter((t) => t.effect === 'record' && !isFreshnessChecked(t)).map((t) => t.id);
  assert.deepEqual(unchecked, [], 'every record tool of the production catalog passes the FreshnessGuard');

  const r = await ht.run({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.commits[0]! } }, { timeoutMs: 120_000 });
  assert.equal(r.status, 'completed');

  // the executor's first note: refused for the withdrawn finding only (exact reason, refresh hint), nothing written
  const refused = executorViews.find((v) => v.step === 1)!.toolResults[0]!;
  assert.equal(refused.isError, true);
  assert.match(refused.content, new RegExp(`^\\[stale_context\\] stale_context: stale context \\(snapshot cs_\\w+\\): finding_withdrawal/${lineages.withdrawn}: version_changed \\(now withdrawn:rejected\\)`));
  assert.doesNotMatch(refused.content, new RegExp(lineages.confirmed!), 'the merely confirmed finding does not block');
  assert.match(refused.content, /re-read the changed records with blackboard\.read/);
  // the next prompt tells it; the same note then goes through
  assert.match(executorViews.find((v) => v.step === 1)!.userText, /CHANGED since you saw rec_\w+ — WITHDRAWN \(rejected\)/);
  const accepted = executorViews.find((v) => v.step === 2)!.toolResults[1]!;
  assert.equal(accepted.isError, false, accepted.content);
  const notes = await ht.services.blackboard.query({ runId: r.runId, recordType: 'note' });
  assert.equal(notes.length, 1, 'only the accepted note was written');
  assert.ok((await ht.services.events.read(r.runId, { types: ['context.stale_rejected'] })).length >= 1);

  // (B[6]) code.symbols answered from go/ast; the helper that parsed it lives in the state directory the sandbox hides
  const symbols = leadViews.find((v) => v.step === 1)!.toolResults[0]!;
  assert.match(symbols.content, /tools\/ledger\.go:7 ⟦definition method Ledger\.Bump⟧ func \(l \*Ledger\) Bump\(\) \{/);
  const stateDir = join(dataDir, 'state');
  const helpers = await readdir(join(stateDir, 'parsers'));
  assert.ok(helpers.some((f) => /^goast-[0-9a-f]{16}$/.test(f)), `the go/ast helper is under ${stateDir}/parsers (${helpers.join(', ')})`);
  assert.ok(sandboxHiddenPaths(config, dataDir, stateDir).includes(stateDir), 'the state directory is hidden from every sandboxed command');
  await ht.close();
  ht = undefined;
});

test('(B[6] privacy) cachedRetrievers: a restricted root never reaches the configured (off-host) embedder; other roots do', async () => {
  const calls: Array<{ inputs: number }> = [];
  const hashing = new HashEmbedder({ dims: 32 });
  const remote: Embedder = {
    dims: 32,
    modelId: 'remote-test-32',
    async embed(texts: string[]) {
      calls.push({ inputs: texts.length });
      return hashing.embed(texts);
    },
  };
  const helperDir = join(dir.path, 'state-r', 'parsers');
  const factory = cachedRetrievers(new MemoryLogger(), { embedder: remote, sharedIndex: async () => undefined, restrictedEmbedder: new HashEmbedder({ dims: 32 }) }, helperDir);
  await factory(repo.path, { restricted: true }).search({ text: 'how are two numbers added', limit: 5 });
  assert.equal(calls.length, 0, 'the restricted workspace was embedded locally only');
  await factory(repo.path).search({ text: 'how are two numbers added', limit: 5 });
  assert.ok(calls.length > 0, 'an unrestricted workspace uses the configured route');
  // without a restricted embedder (the configured route is local, or none is configured) restricted roots use the default
  const local = cachedRetrievers(new MemoryLogger(), { embedder: remote, sharedIndex: async () => undefined }, helperDir);
  const before = calls.length;
  await local(join(repo.path), { restricted: true }).search({ text: 'how are two numbers added', limit: 5 });
  assert.ok(calls.length > before);
});
