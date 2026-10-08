/**
 * Context engine wiring of createHypertest (conformance: "L3 hybrid retrieval … vectors (pgvector)", "P0 revision 2 …
 * ReadSet"): an analysis-phase agent's "Relevant code" comes from the hybrid retriever over its workspace — symbol graph +
 * exact search + the lazily populated vector corpus (in memory: the test store has no pgvector) — and the agents' tool
 * observations are recorded for their next snapshots. Runs on PGlite, and on PostgreSQL with HYPERTEST_TEST_DB=postgres.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { createGitRepo, tempDir } from '@hypertest/testkit';
import { createHypertest, type HypertestInstance } from '../src/index.ts';
import { call, roleRouter, scriptedConfig, testStore, type BrainView, type RoleBrain } from './helpers.ts';

const README = [
  '# Calc',
  '',
  'A tiny calculator library.',
  '',
  '## Rounding policy',
  '',
  'Monetary totals are rounded half to even at the cent after every addition.',
  '',
].join('\n');

let dir: Awaited<ReturnType<typeof tempDir>>;
let repo: Awaited<ReturnType<typeof createGitRepo>>;
let db: Awaited<ReturnType<typeof testStore>>;
let ht: HypertestInstance;
const analystViews: BrainView[] = [];
const logger = new MemoryLogger();

before(async () => {
  dir = await tempDir('ht-app-ctx-');
  db = await testStore();
  repo = await createGitRepo({
    'package.json': '{ "name": "calc", "type": "module", "private": true }\n',
    'src/sum.js': 'export function sum(a, b) {\n  return a + b;\n}\n',
    'README.md': README,
  });
  const lead: RoleBrain = (v) => {
    if (v.kind === 'initial_plan') {
      if (v.step === 0) {
        return call('plan.propose_revision', {
          rationale: 'Understand the documented behaviour first.',
          objectives: [{ objectiveId: 'obj-doc', description: 'Know the documented money handling.', priority: 'P2' }],
          workItems: [{ localId: 'a1', title: 'Money handling', role: 'code_change_analyst', dependsOn: [], objectiveIds: ['obj-doc'], objective: 'Explain how monetary totals are rounded at the cent before this change is released.' }],
        });
      }
      return call('complete_work', { summary: 'planned', output: { summary: 'planned', planProposed: true, readyForGate: false, objectives: [{ objectiveId: 'obj-doc', status: 'open', evidenceRefs: [] }] } });
    }
    if (v.step === 0) return call('plan.propose_revision', { rationale: 'analysed; hand over', objectives: [{ objectiveId: 'obj-doc', description: 'Know the documented money handling.', priority: 'P2', status: 'satisfied' }], workItems: [], readyForGate: true });
    return call('complete_work', { summary: 'ready', output: { summary: 'ready', planProposed: true, readyForGate: true, objectives: [{ objectiveId: 'obj-doc', status: 'satisfied', evidenceRefs: [] }] } });
  };
  const analyst: RoleBrain = (v) => {
    analystViews.push(v);
    if (v.step === 0) return call('fs.read', { path: 'README.md' });
    return call('complete_work', { summary: 'rounding is documented', output: { summary: 'rounding is documented', risks: [], testIdeas: ['totals round half to even'] } });
  };
  const config = scriptedConfig(dir.path, { gate: { requireIndependentReview: false } });
  ht = await createHypertest(db.store ? { ...config, store: db.store } : config, { scriptedBrains: { sim: roleRouter({ lead, code_change_analyst: analyst }) }, logger });
});
after(async () => {
  await ht?.close();
  await db?.dispose();
  await repo?.cleanup();
  await dir?.cleanup();
});

test('an analyst\'s "Relevant code" includes the document section only the vector retriever finds; its reads are observed and pinned', async () => {
  const outcome = await ht.run({ goal: 'Is the rounding documented?', target: { repoPath: repo.path, commit: repo.commits[0]! } }, { timeoutMs: 90_000 });
  assert.equal(outcome.status, 'completed');
  const first = analystViews.find((v) => v.step === 0);
  assert.ok(first, 'the analyst ran');
  // (B[5]) the section heading names its sources: `## Relevant code (retrieval: symbols, exact search, vectors)`
  const section = /## Relevant code \(retrieval: symbols, exact search, vectors\)\n([\s\S]*?)(?:\n## |$)/.exec(first.userText)?.[1] ?? '';
  // the objective names no identifier and no literal line of the README: semantic retrieval found its section
  assert.match(section, /^- README\.md:5 — /m, first.userText);
  // the fs.read of turn 1 is recorded and pinned by the analyst's next snapshot
  const runId = outcome.runId;
  const observed = await ht.services.db.query<{ resource_id: string; kind: string }>("SELECT resource_id, kind FROM ht_context_observations WHERE run_id = $1 AND tool_id = 'fs.read'", [runId]);
  assert.equal(observed.rows.length, 1);
  assert.match(observed.rows[0]!.resource_id, /^workspace\/ws_\w+\/README\.md$/);
  const pinned = await ht.services.db.query<{ n: unknown }>(
    `SELECT count(*) AS n FROM ht_context_snapshots WHERE run_id = $1 AND content->'readSet' @> $2::jsonb`,
    [runId, JSON.stringify([{ resourceType: 'file', resourceId: observed.rows[0]!.resource_id }])],
  );
  assert.ok(Number(pinned.rows[0]!.n) >= 1, 'the next turn pins the file the analyst read');
  assert.ok(logger.entries.some((e) => e.msg === 'L3 vectors: pgvector unavailable; workspace corpora are kept in memory'), 'pgvector was feature-detected and the in-memory fallback used');
});
