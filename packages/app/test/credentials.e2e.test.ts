/**
 * e2e[3]: a model provider whose credential is missing fails CLOSED locally — the router never routes to it and no request
 * (system prompt, goal, target description) ever leaves the process. The audit saw `hypertest run` with the `init`
 * configuration and no keys send 14 unauthenticated requests to the hosted endpoint: reproduced here with a recording
 * fetch (global and injected), which must see ZERO requests.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { HypertestError, MemoryLogger } from '@hypertest/core';
import { tempDir } from '@hypertest/testkit';
import { createHypertest, defaultConfig, diagnose, type HypertestConfig } from '../src/index.ts';
import { FULL_ROUTE, SUM_ORACLE, roleRouter, scriptedConfig, sumRepo, testStore, tinyRunBrains } from './helpers.ts';

interface Recorder {
  calls: string[];
  fetch: typeof fetch;
}

function recorder(): Recorder {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'x-api-key header is required' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  };
}

/** The providers and routes of the `hypertest init` template (DeepSeek + Anthropic, keys named by apiKeyEnv). */
function templateModels(): HypertestConfig['models'] {
  const explicit = { contextWindow: 128_000, maxOutputTokens: 8192, maxDataClassification: 'confidential', maxActionRisk: 'high', reasoning: 'none', toolReliability: 0.8, typicalLatencyMs: 2000, enabled: true } as const;
  const caps = ['tool_use', 'parallel_tool_calls', 'structured_output', 'reasoning', 'long_context'] as const;
  return {
    providers: [
      { id: 'deepseek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', timeoutMs: 180_000 },
      { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    ],
    routes: [
      { routeId: 'deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', ...explicit, capabilities: [...caps], structuredOutput: 'native', quality: { default: 0.8 } },
      { routeId: 'claude-opus', provider: 'anthropic', model: 'claude-opus-5', ...explicit, capabilities: [...caps, 'vision'], structuredOutput: 'native', reasoning: 'opaque', quality: { default: 0.9 }, costPerMillionInputUsd: 5, costPerMillionOutputUsd: 25 },
    ],
  } as HypertestConfig['models'];
}

describe('e2e[3] a provider without its credential is unavailable: no request leaves the process', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let db: Awaited<ReturnType<typeof testStore>>;
  let rec: Recorder;
  let realFetch: typeof fetch;
  before(async () => {
    dir = await tempDir('ht-app-cred-');
    db = await testStore();
  });
  after(async () => {
    await db?.dispose();
    await dir?.cleanup();
  });
  beforeEach(() => {
    // the GLOBAL fetch records too: a provider that ignored the injected one could never reach the network from this test
    rec = recorder();
    realFetch = globalThis.fetch;
    globalThis.fetch = rec.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('the init configuration with no keys: the run is refused before it exists, with the exact reason, and zero requests are sent', async () => {
    const c = defaultConfig({ project: { name: 'cred', dataDir: join(dir.path, 'template') }, models: templateModels(), oracles: [SUM_ORACLE] } as never);
    const config = db.store ? { ...c, store: db.store } : c;
    const ht = await createHypertest(config, { env: {}, fetch: rec.fetch, logger: new MemoryLogger() });
    try {
      await assert.rejects(ht.start({ goal: 'Is this change releasable?', target: {} }), (e: unknown) => {
        assert.ok(e instanceof HypertestError, String(e));
        assert.equal(e.code, 'precondition_failed');
        assert.match(e.message, /^no configured route can serve the lead role \(/);
        assert.match(e.message, /deepseek-chat: capability — provider deepseek is unavailable: provider deepseek has no credential: environment variable DEEPSEEK_API_KEY is not set or empty/);
        assert.match(e.message, /claude-opus: capability — provider anthropic is unavailable: provider anthropic has no credential: environment variable ANTHROPIC_API_KEY is not set or empty/);
        return true;
      });
      assert.deepEqual(await ht.listRuns(), []);
      // the router itself, asked directly, refuses too — and a provider called directly refuses locally
      const p = ht.services.providers.get('anthropic');
      await assert.rejects(p.complete({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'secret goal' }] }), (e: unknown) => e instanceof HypertestError && e.code === 'precondition_failed');
    } finally {
      await ht.close();
    }
    assert.deepEqual(rec.calls, [], 'not a single request left the process');
  });

  test('a run whose keyed route is unavailable is served by the available route only (the keyed provider never sees a request)', async () => {
    const repo = await sumRepo();
    try {
      const base = scriptedConfig(join(dir.path, 'mixed'), { gate: { requireIndependentReview: false } });
      const models: HypertestConfig['models'] = {
        providers: [...base.models.providers, { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' }],
        routes: [
          ...base.models.routes,
          // better and preferred: it would serve every role if it were available
          { routeId: 'claude-best', provider: 'anthropic', model: 'claude-opus-5', ...FULL_ROUTE, capabilities: [...FULL_ROUTE.capabilities], quality: { default: 0.99 } },
        ],
      };
      const c: HypertestConfig = { ...base, models };
      const ht = await createHypertest(db.store ? { ...c, store: db.store } : c, { env: { ANTHROPIC_API_KEY: '' }, fetch: rec.fetch, scriptedBrains: { sim: roleRouter(tinyRunBrains()) }, logger: new MemoryLogger() });
      try {
        const outcome = await ht.run({ goal: 'Is the sum module releasable?', target: { repoPath: repo.path, commit: repo.head } }, { timeoutMs: 90_000 });
        // the run is driven to its gate on the available route (the verdict itself is the gate's business, not this test's)
        assert.equal(outcome.status, 'completed');
        assert.ok(outcome.decision, 'a QualityDecision was produced');
        const items = await ht.services.blackboard.listWorkItems({ runId: outcome.runId });
        assert.ok(items.every((w) => w.failure?.reason !== 'model_unavailable'), 'no work item failed for want of a model');
        const routed = await ht.events(outcome.runId, { types: ['model.routed'] });
        assert.ok(routed.length > 0);
        for (const e of routed) {
          const p = e.payload as { ok: boolean; routeId: string | null; rejected: Array<{ routeId: string; stage: string; reason: string }> };
          assert.equal(p.routeId, 'sim-large');
          const rej = p.rejected.find((r) => r.routeId === 'claude-best')!;
          assert.equal(rej.stage, 'capability');
          assert.equal(rej.reason, 'provider anthropic is unavailable: provider anthropic has no credential: environment variable ANTHROPIC_API_KEY is not set or empty (fail closed: no request is sent)');
        }
      } finally {
        await ht.close();
      }
    } finally {
      await repo.cleanup();
    }
    assert.deepEqual(rec.calls, []);
  });

  test('hypertest doctor reports the unavailable provider, its routes and the unroutable lead', async () => {
    const c = defaultConfig({ project: { name: 'cred', dataDir: join(dir.path, 'doctor') }, models: templateModels() } as never);
    const r = await diagnose(c, { env: { DEEPSEEK_API_KEY: 'sk-set' }, connect: false });
    const models = r.checks.filter((x) => x.name === 'models');
    assert.ok(models.some((m) => m.status === 'warn' && m.detail === 'provider anthropic has no credential: environment variable ANTHROPIC_API_KEY is not set or empty (fail closed: no request is sent): routes claude-opus are unavailable — never routed to, no request is sent'), JSON.stringify(models, null, 2));
    assert.ok(r.checks.some((x) => x.name === 'secrets' && x.status === 'error' && /ANTHROPIC_API_KEY is not set/.test(x.detail)));
    // with neither key, no route can serve the lead: an error
    const none = await diagnose(c, { env: {}, connect: false });
    assert.ok(none.checks.some((x) => x.name === 'models' && x.status === 'error' && /^no route can serve the lead role \(.*has no credential/.test(x.detail)), JSON.stringify(none.checks, null, 2));
    assert.equal(none.ok, false);
    assert.deepEqual(rec.calls, []);
  });
});
