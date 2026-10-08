/**
 * (B[6]) createHypertest wires L3 retrieval end to end: `retrieval.embedder` routes the workspace vector corpus through an
 * OpenAI-compatible /embeddings provider (a fake fetch here: nothing leaves the process), and the agent code tools answer
 * from the syntax-tree symbol graph — the lead's code.references shows classified usages with their enclosing
 * definitions.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MemoryLogger } from '@hypertest/core';
import { HashEmbedder } from '@hypertest/context';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, loadConfig, type HypertestInstance } from '../src/index.ts';
import { call, roleRouter, scriptedConfig, sumRepo, testStore, tinyRunBrains, type BrainView } from './helpers.ts';

let dir: Awaited<ReturnType<typeof tempDir>>;
let repo: Awaited<ReturnType<typeof sumRepo>>;
let db: Awaited<ReturnType<typeof testStore>>;
let ht: HypertestInstance | undefined;

before(async () => {
  dir = await tempDir('ht-app-retrieval-');
  repo = await sumRepo();
  db = await testStore();
});
after(async () => {
  await ht?.close();
  await db?.dispose();
  await repo?.cleanup();
  await dir?.cleanup();
});

test('retrieval.embedder embeds through the provider route; code.references answers from the symbol graph', async () => {
  const requests: Array<{ url: string; model: string; inputs: number; auth: string | undefined }> = [];
  const hashing = new HashEmbedder({ dims: 48 });
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url !== 'http://embeddings.test/v1/embeddings') return new Response('unexpected request', { status: 599 });
    const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
    requests.push({ url, model: body.model, inputs: body.input.length, auth: (init?.headers as Record<string, string>)['authorization'] });
    const data = (await hashing.embed(body.input)).map((embedding, index) => ({ index, embedding }));
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;

  // the lead surveys the repository with code.references first, then plans as usual
  const leadViews: BrainView[] = [];
  const brains = tinyRunBrains();
  const lead = brains['lead']!;
  brains['lead'] = (v) => {
    if (v.kind !== 'initial_plan') return lead(v);
    leadViews.push(v);
    if (v.step === 0) return call('code.references', { symbol: 'sum' });
    return lead({ ...v, step: v.step - 1, toolResults: v.toolResults.slice(1) });
  };
  const config = scriptedConfig(join(dir.path, 'a'), {
    gate: { requireIndependentReview: false },
    models: {
      providers: [{ id: 'sim', kind: 'scripted' }, { id: 'emb', kind: 'openai-compatible', baseUrl: 'http://embeddings.test/v1', apiKeyEnv: 'HT_TEST_EMB_KEY' }],
      routes: scriptedConfig(dir.path).models.routes,
    },
    retrieval: { embedder: { provider: 'emb', model: 'code-embed-1', dimensions: 48 } },
  } as never);
  const logger = new MemoryLogger();
  ht = await createHypertest(db.store ? { ...config, store: db.store } : config, { scriptedBrains: { sim: roleRouter(brains) }, logger, fetch: fakeFetch, env: { ...process.env, HT_TEST_EMB_KEY: 'k-emb' } });
  const r = await ht.run({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 90_000 });
  assert.equal(r.status, 'completed');
  // the workspace corpus was embedded through the provider route, with its key, and nothing else was requested
  assert.ok(requests.length > 0, 'the /embeddings route was used');
  assert.ok(requests.every((q) => q.model === 'code-embed-1' && q.auth === 'Bearer k-emb'), JSON.stringify(requests));
  // the lead's code.references came from the symbol graph: the definition, then classified usages in their definitions
  const refs = leadViews.find((v) => v.step === 1)!.toolResults[0]!;
  assert.equal(refs.name, 'code__references');
  assert.match(refs.content, /src\/sum\.js:1: ⟦definition function sum⟧ export function sum\(a, b\) \{/);
  assert.match(refs.content, /test\/sum\.test\.js:6: ⟦call⟧ assert\.equal\(sum\(2, 3\), 5\);/);
  assert.match(refs.content, /test\/sum\.test\.js:3: ⟦import⟧ import \{ sum \} from '\.\.\/src\/sum\.js';/);
  await ht.close();
  ht = undefined;
});

test('retrieval.embedder: a missing credential sends nothing (hashing embedder, logged); a non-openai-compatible provider is a config error', async () => {
  const requests: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  const config = scriptedConfig(join(dir.path, 'b'), {
    gate: { requireIndependentReview: false },
    models: { providers: [{ id: 'sim', kind: 'scripted' }, { id: 'emb', kind: 'openai-compatible', baseUrl: 'http://embeddings.test/v1', apiKeyEnv: 'HT_TEST_EMB_KEY_MISSING' }], routes: scriptedConfig(dir.path).models.routes },
    retrieval: { embedder: { provider: 'emb', model: 'code-embed-1', dimensions: 48 } },
  } as never);
  const logger = new MemoryLogger();
  const env = { ...process.env };
  delete env['HT_TEST_EMB_KEY_MISSING'];
  ht = await createHypertest(db.store ? { ...config, store: db.store } : config, { scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger, fetch: fakeFetch, env });
  const r = await ht.run({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 90_000 });
  assert.equal(r.status, 'completed');
  assert.deepEqual(requests, []);
  assert.ok(logger.entries.some((e) => e.level === 'warn' && /retrieval\.embedder: the provider credential is missing/.test(e.msg)));
  await ht.close();
  ht = undefined;

  const cfgPath = join(dir.path, 'bad.yaml');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(cfgPath, [
    'version: 1', 'project: { name: x, dataDir: ./d }',
    'models:', '  providers:', '    - { id: sim, kind: scripted }', '  routes: []',
    'retrieval:', '  embedder: { provider: sim, model: m, dimensions: 8 }', '',
  ].join('\n'));
  await assert.rejects(loadConfig(cfgPath, { env: {} }), /retrieval\.embedder\.provider "sim" must be an openai-compatible provider with a baseUrl/);
  await writeFile(cfgPath, [
    'version: 1', 'project: { name: x, dataDir: ./d }',
    'models:', '  providers:', '    - { id: sim, kind: scripted }', '  routes: []',
    'retrieval:', '  embedder: { provider: nope, model: m, dimensions: 8 }', '',
  ].join('\n'));
  await assert.rejects(loadConfig(cfgPath, { env: {} }), /retrieval\.embedder\.provider "nope" is not a configured models\.providers\[\]\.id/);
});
